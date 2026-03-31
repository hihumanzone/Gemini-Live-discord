import {
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import opusPkg from '@discordjs/opus';
const { OpusEncoder } = opusPkg;

import { config } from './config.js';
import {
  DISCORD_CHANNELS,
  DISCORD_FRAME_MS,
  DISCORD_INPUT_SAMPLE_RATE,
  GEMINI_INPUT_SAMPLE_RATE,
  computeMonoPcmRms,
  monoPcmDurationMs,
  trimBufferArray,
} from './audio.js';
import { GeminiLiveSessionManager } from './gemini-session.js';
import { MultiUserFrameMixer } from './mixer.js';
import { waitForVoiceReady } from './voice-connection.js';
import { DiscordOpusPlaybackQueue } from './voice-playback.js';

export class DiscordGeminiVoiceBridge {
  /**
   * @param {import('discord.js').BaseGuildVoiceChannel} voiceChannel
   * @param {import('discord.js').Client} client
   */
  constructor(voiceChannel, client) {
    this.client = client;
    this.guildId = voiceChannel.guild.id;
    this.channelId = voiceChannel.id;
    this.voiceChannel = voiceChannel;

    this.connection = null;
    this.voiceReady = false;
    this.destroyed = false;

    this.turnSpeakerIds = new Set();
    this.lastTurnSpeakerIds = new Set();
    this.currentTranscriptionSpeakerIds = new Set();
    this.turnFinishTimer = null;
    this.turnSentAudio = false;

    this.bargeInMode = false;
    this.bargeInAboveThresholdFrames = 0;
    this.bargeInPreRollChunks = [];
    this.turnMinForwardUntil = 0;

    this.awaitingServerBargeIn = false;
    this.awaitingServerBargeInSince = 0;
    this.dropModelAudioUntilBargeInAck = false;

    this.inputCodec = new OpusEncoder(DISCORD_INPUT_SAMPLE_RATE, DISCORD_CHANNELS);
    this.outputCodec = new OpusEncoder(DISCORD_INPUT_SAMPLE_RATE, DISCORD_CHANNELS);

    this.mixer = null;
    this.playback = null;
    this.geminiSession = null;
    this.mixerTicker = null;
  }

  async start() {
    this.connection = joinVoiceChannel({
      channelId: this.channelId,
      guildId: this.guildId,
      adapterCreator: this.voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    this.attachVoiceConnectionHandlers();
    this.attachDiscordReceiver();
    this.attachPlaybackQueue();
    this.attachGeminiSession();
    this.startMixerLoop();
    this.playback.start();

    await waitForVoiceReady(this.connection, this.guildId);
    this.voiceReady = true;
    await this.geminiSession.connect();
  }

  attachVoiceConnectionHandlers() {
    this.connection.on('stateChange', (oldState, newState) => {
      if (oldState.status !== newState.status) {
        this.log('voice', `State ${oldState.status} -> ${newState.status}`);
      }

      this.voiceReady = newState.status === VoiceConnectionStatus.Ready;
    });

    this.connection.on('error', (error) => {
      this.log('voice', 'Voice connection error', error);
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.destroyed) return;

      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.log('voice', 'Voice connection did not recover after disconnect; destroying bridge');
        await this.stop();
      }
    });
  }

  attachDiscordReceiver() {
    this.mixer = new MultiUserFrameMixer({
      receiver: this.connection.receiver,
      inputCodec: this.inputCodec,
      speechEndMs: config.discordSpeechEndMs,
      shouldAcceptUser: (userId) => this.canAcceptSpeaker(userId),
      log: (scope, ...args) => this.log(scope, ...args),
      guildId: this.guildId,
    });
    this.mixer.start();
  }

  attachPlaybackQueue() {
    this.playback = new DiscordOpusPlaybackQueue({
      getConnection: () => this.connection,
      isVoiceReady: () => this.voiceReady,
      outputCodec: this.outputCodec,
      log: (scope, ...args) => this.log(scope, ...args),
    });
  }

  attachGeminiSession() {
    this.geminiSession = new GeminiLiveSessionManager({
      guildId: this.guildId,
      log: (scope, ...args) => this.log(scope, ...args),
      onMessage: (message) => this.handleGeminiServerMessage(message),
      onSessionReset: () => this.resetForGeminiReconnect(),
    });
  }

  canAcceptSpeaker(userId) {
    if (this.destroyed || !this.voiceReady || !this.geminiSession?.ready || !userId) return false;
    if (userId === this.client.user?.id) return false;

    const user = this.client.users.cache.get(userId);
    return !user?.bot;
  }

  handleGeminiServerMessage(message) {
    const serverContent = message.serverContent;
    if (!serverContent) return;

    if (serverContent.interrupted) {
      this.clearServerBargeInWait();
      this.interruptPlayback();
    }

    if (serverContent.turnComplete) {
      this.clearServerBargeInWait();
    }

    this.maybeReleaseStaleModelAudioGate();

    if (serverContent.inputTranscription?.text) {
      this.clearServerBargeInWait();
      this.currentTranscriptionSpeakerIds = new Set(
        this.turnSpeakerIds.size ? this.turnSpeakerIds : this.lastTurnSpeakerIds,
      );
      this.log('stt', `${this.getSpeakerLabel()}: ${serverContent.inputTranscription.text}`);
    }

    if (serverContent.outputTranscription?.text && !this.dropModelAudioUntilBargeInAck) {
      this.log('tts', serverContent.outputTranscription.text);
    }

    if (this.dropModelAudioUntilBargeInAck) return;

    const parts = serverContent.modelTurn?.parts ?? [];
    for (const part of parts) {
      const inlineData = part.inlineData;
      if (!inlineData?.data) continue;
      if (inlineData.mimeType && !inlineData.mimeType.startsWith('audio/')) continue;
      this.pushGeminiAudioChunk(Buffer.from(inlineData.data, 'base64'));
    }
  }

  startMixerLoop() {
    if (this.mixerTicker) return;

    this.mixerTicker = setInterval(() => {
      if (this.destroyed || !this.voiceReady || !this.geminiSession?.ready || !this.mixer) return;
      this.flushMixedUserAudioFrame();
    }, DISCORD_FRAME_MS);
  }

  flushMixedUserAudioFrame() {
    const mixedFrame = this.mixer.collectMixedFrame();
    if (!mixedFrame) {
      this.maybeScheduleTurnFinish();
      return;
    }

    const { pcm16Mono, speakerIds } = mixedFrame;
    if (!this.turnSentAudio && this.playback?.isActive()) {
      this.bargeInMode = true;
    }

    if (this.playback?.isActive() && this.bargeInMode) {
      this.handlePotentialBargeIn(pcm16Mono, speakerIds);
      return;
    }

    this.sendAudioChunkToGemini(pcm16Mono, speakerIds);
  }

  handlePotentialBargeIn(pcm16Mono, speakerIds) {
    const chunkDurationMs = monoPcmDurationMs(pcm16Mono, GEMINI_INPUT_SAMPLE_RATE);
    const maxPreRollChunks = Math.max(1, Math.ceil(config.localBargeInPreRollMs / chunkDurationMs));

    this.bargeInPreRollChunks.push({ pcm16Mono, speakerIds });
    trimBufferArray(this.bargeInPreRollChunks, maxPreRollChunks);

    const rms = computeMonoPcmRms(pcm16Mono);
    this.bargeInAboveThresholdFrames =
      rms >= config.localBargeInRmsThreshold
        ? this.bargeInAboveThresholdFrames + 1
        : 0;

    if (this.bargeInAboveThresholdFrames < config.localBargeInConsecutiveFrames) {
      return;
    }

    this.log(
      'voice',
      `Qualified barge-in from ${this.formatSpeakerIds(speakerIds)} (rms=${Math.round(rms)}, frames=${this.bargeInAboveThresholdFrames})`,
    );

    this.awaitingServerBargeIn = true;
    this.awaitingServerBargeInSince = Date.now();
    this.dropModelAudioUntilBargeInAck = true;
    this.turnMinForwardUntil = Date.now() + config.localBargeInMinForwardMs;

    this.interruptPlayback();
    this.bargeInMode = false;
    this.bargeInAboveThresholdFrames = 0;

    const preRollChunks = this.bargeInPreRollChunks;
    this.bargeInPreRollChunks = [];
    for (const chunk of preRollChunks) {
      this.sendAudioChunkToGemini(chunk.pcm16Mono, chunk.speakerIds);
    }
  }

  maybeScheduleTurnFinish() {
    if (!this.turnSentAudio || !this.mixer) return;
    if (this.turnFinishTimer) return;
    if (this.mixer.hasBufferedAudio()) return;
    if (this.mixer.hasActiveStreams()) return;

    const finalizeTurn = () => {
      this.turnFinishTimer = null;
      if (!this.turnSentAudio || !this.mixer) return;
      if (this.mixer.hasBufferedAudio()) return;
      if (this.mixer.hasActiveStreams()) return;

      if (this.geminiSession?.ready) {
        this.sendRealtime({ audioStreamEnd: true });
      }

      this.completeCurrentTurn();
    };

    const waitMs = Math.max(0, this.turnMinForwardUntil - Date.now());
    if (waitMs === 0) {
      finalizeTurn();
      return;
    }

    this.turnFinishTimer = setTimeout(finalizeTurn, waitMs);
  }

  sendAudioChunkToGemini(pcm16Mono, speakerIds = []) {
    if (!this.geminiSession?.ready) return;

    this.turnSentAudio = true;
    for (const speakerId of speakerIds) {
      this.turnSpeakerIds.add(speakerId);
    }

    if (this.awaitingServerBargeIn) {
      this.turnMinForwardUntil = Math.max(
        this.turnMinForwardUntil,
        Date.now() + config.localBargeInMinForwardMs,
      );
    }

    this.sendRealtime({
      audio: {
        data: pcm16Mono.toString('base64'),
        mimeType: `audio/pcm;rate=${GEMINI_INPUT_SAMPLE_RATE}`,
      },
    });
  }

  sendRealtime(payload) {
    this.geminiSession?.sendRealtime(payload);
  }

  pushGeminiAudioChunk(pcm24Mono) {
    this.playback?.pushGeminiAudioChunk(pcm24Mono);
  }

  interruptPlayback() {
    this.playback?.interrupt();
  }

  clearServerBargeInWait() {
    this.awaitingServerBargeIn = false;
    this.awaitingServerBargeInSince = 0;
    this.dropModelAudioUntilBargeInAck = false;
  }

  maybeReleaseStaleModelAudioGate() {
    if (!this.awaitingServerBargeIn || !this.awaitingServerBargeInSince) return;

    const elapsedMs = Date.now() - this.awaitingServerBargeInSince;
    if (elapsedMs >= config.serverInterruptFallbackMs) {
      this.clearServerBargeInWait();
    }
  }

  getSpeakerLabel() {
    const speakerIds = this.currentTranscriptionSpeakerIds.size
      ? [...this.currentTranscriptionSpeakerIds]
      : this.turnSpeakerIds.size
        ? [...this.turnSpeakerIds]
        : [...this.lastTurnSpeakerIds];

    return this.formatSpeakerIds(speakerIds);
  }

  formatSpeakerIds(speakerIds) {
    const uniqueSpeakerIds = [...new Set(speakerIds)].filter(Boolean);
    if (uniqueSpeakerIds.length === 0) return 'unknown';

    const labels = uniqueSpeakerIds.map((userId) => {
      const member = this.voiceChannel.guild.members.cache.get(userId);
      if (member?.displayName) return member.displayName;
      const user = this.client.users.cache.get(userId);
      return user?.username ?? userId;
    });

    if (labels.length <= 2) return labels.join(' + ');
    return `${labels.slice(0, 2).join(' + ')} + ${labels.length - 2} more`;
  }

  completeCurrentTurn() {
    this.lastTurnSpeakerIds = new Set(this.turnSpeakerIds);
    this.currentTranscriptionSpeakerIds = new Set(this.lastTurnSpeakerIds);
    this.turnSpeakerIds.clear();
    this.turnSentAudio = false;
    this.bargeInMode = false;
    this.bargeInAboveThresholdFrames = 0;
    this.bargeInPreRollChunks = [];
    this.turnMinForwardUntil = 0;
  }

  resetTurnState() {
    if (this.turnFinishTimer) {
      clearTimeout(this.turnFinishTimer);
      this.turnFinishTimer = null;
    }

    this.turnSpeakerIds.clear();
    this.lastTurnSpeakerIds.clear();
    this.currentTranscriptionSpeakerIds.clear();
    this.turnSentAudio = false;
    this.bargeInMode = false;
    this.bargeInAboveThresholdFrames = 0;
    this.bargeInPreRollChunks = [];
    this.turnMinForwardUntil = 0;

    this.mixer?.reset();
  }

  async resetForGeminiReconnect() {
    this.clearServerBargeInWait();
    this.interruptPlayback();
    this.resetTurnState();
  }

  async reconnectGemini(options = {}) {
    await this.geminiSession?.reconnect(options);
  }

  async resetGeminiSession() {
    this.geminiSession?.resetResumptionState();
    await this.reconnectGemini({ manual: true });
  }

  async stop() {
    this.destroyed = true;

    if (this.mixerTicker) {
      clearInterval(this.mixerTicker);
      this.mixerTicker = null;
    }

    this.clearServerBargeInWait();
    this.interruptPlayback();
    this.resetTurnState();
    this.mixer?.stop();
    this.playback?.stop();

    await this.geminiSession?.stop();

    this.voiceReady = false;

    try {
      this.connection?.destroy();
    } catch {
      // Ignore destroy errors.
    }

    try {
      this.inputCodec?.delete?.();
      this.outputCodec?.delete?.();
    } catch {
      // Ignore codec cleanup errors.
    }

    this.inputCodec = null;
    this.outputCodec = null;
    this.connection = null;
    this.mixer = null;
    this.playback = null;
    this.geminiSession = null;
  }

  log(scope, ...args) {
    const prefix = `[${scope}:${this.guildId}]`;
    if (scope === 'gemini' && args.some((value) => value instanceof Error)) {
      console.error(prefix, ...args);
      return;
    }

    if (scope === 'voice' && args.some((value) => value instanceof Error)) {
      console.warn(prefix, ...args);
      return;
    }

    console.log(prefix, ...args);
  }
}
