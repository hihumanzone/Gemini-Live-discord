import { joinVoiceChannel } from '@discordjs/voice';
import opusPkg from '@discordjs/opus';
const { OpusEncoder } = opusPkg;

import { config } from '../../config/index.js';
import { logImportantEvent, logRoutineAction } from '../../utils/logging.js';
import {
  DISCORD_CHANNELS,
  DISCORD_FRAME_MS,
  DISCORD_INPUT_SAMPLE_RATE,
  GEMINI_INPUT_SAMPLE_RATE,
} from '../audio/pcm.js';
import { GeminiLiveSessionManager } from '../gemini/live-session-manager.js';
import { MultiUserFrameMixer } from '../voice/multi-user-frame-mixer.js';
import { waitForVoiceReady } from '../voice/connection-ready.js';
import { DiscordOpusPlaybackQueue } from '../voice/opus-playback-queue.js';
import { attachVoiceConnectionLifecycle } from '../voice/connection-lifecycle.js';
import { LocalBargeInController } from './local-barge-in-controller.js';
import { ModelAudioGate } from './model-audio-gate.js';
import { formatSpeakerLabels } from './speaker-labels.js';
import { TurnState } from './turn-state.js';

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
    this.detachConnectionLifecycle = null;
    this.voiceReady = false;
    this.destroyed = false;

    this.turnState = new TurnState();
    this.bargeInController = new LocalBargeInController({
      rmsThreshold: config.localBargeInRmsThreshold,
      consecutiveFrames: config.localBargeInConsecutiveFrames,
      preRollMs: config.localBargeInPreRollMs,
      log: (scope, ...args) => this.log(scope, ...args),
    });
    this.modelAudioGate = new ModelAudioGate();

    this.turnFinishTimer = null;

    this.inputCodec = new OpusEncoder(DISCORD_INPUT_SAMPLE_RATE, DISCORD_CHANNELS);
    this.outputCodec = new OpusEncoder(DISCORD_INPUT_SAMPLE_RATE, DISCORD_CHANNELS);

    this.mixer = null;
    this.playback = null;
    this.geminiSession = null;
    this.mixerTicker = null;
    this.ttsBuffer = '';
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
    this.detachConnectionLifecycle = attachVoiceConnectionLifecycle({
      connection: this.connection,
      isDestroyed: () => this.destroyed,
      onVoiceReadyChanged: (ready) => {
        this.voiceReady = ready;
      },
      onUnrecoverableDisconnect: async () => {
        await this.stop();
      },
      log: (scope, ...args) => this.log(scope, ...args),
    });
  }

  attachDiscordReceiver() {
    this.mixer = new MultiUserFrameMixer({
      receiver: this.connection.receiver,
      inputCodec: this.inputCodec,
      speechEndMs: config.discordSpeechEndMs,
      queueCapFrames: config.mixerSpeakerQueueCapFrames,
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
      maxPacketQueueFrames: config.playbackPacketQueueMaxFrames,
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

    const shouldDropModelAudio = this.modelAudioGate.shouldDropModelAudio();

    if (serverContent.outputTranscription?.text && !shouldDropModelAudio) {
      this.appendTtsBuffer(serverContent.outputTranscription.text);
    }

    if (serverContent.interrupted) {
      this.flushTtsBuffer({ interrupted: true });
      this.clearServerBargeInWait();
      this.interruptPlayback();
    }

    if (serverContent.turnComplete) {
      this.flushTtsBuffer();
      this.clearServerBargeInWait();
    }

    this.maybeReleaseStaleModelAudioGate();

    if (serverContent.inputTranscription?.text) {
      this.clearServerBargeInWait();
      this.turnState.setTranscriptionContextFromCurrentTurn();
      this.log('stt', `${this.getSpeakerLabel()}: ${serverContent.inputTranscription.text}`);
    }

    if (shouldDropModelAudio) return;

    const parts = serverContent.modelTurn?.parts ?? [];
    for (const part of parts) {
      const inlineData = part.inlineData;
      if (!inlineData?.data) continue;
      if (inlineData.mimeType && !inlineData.mimeType.startsWith('audio/')) continue;
      this.pushGeminiAudioChunk(Buffer.from(inlineData.data, 'base64'));
    }
  }

  appendTtsBuffer(text) {
    this.ttsBuffer += text;
  }

  flushTtsBuffer({ interrupted = false } = {}) {
    if (!this.ttsBuffer) return;

    const suffix = interrupted ? ' [interrupted]' : '';
    this.log('tts', `${this.ttsBuffer}${suffix}`);
    this.ttsBuffer = '';
  }

  startMixerLoop() {
    if (this.mixerTicker) return;

    // Use a self-correcting timer or event-based loop via AudioPlayer clock bounds
    // to eliminate basic interval drift. However, since the AudioPlayer runs independently,
    // we use a more resilient timeout loop.
    const loop = () => {
      if (this.destroyed) return;
      if (this.voiceReady && this.geminiSession?.ready && this.mixer) {
        this.flushMixedUserAudioFrame();
      }
      this.mixerTicker = setTimeout(loop, DISCORD_FRAME_MS);
    };
    
    this.mixerTicker = setTimeout(loop, DISCORD_FRAME_MS);
  }

  flushMixedUserAudioFrame() {
    const mixedFrame = this.mixer.collectMixedFrame();
    if (!mixedFrame) {
      this.maybeScheduleTurnFinish();
      return;
    }

    const { pcm16Mono, speakerIds } = mixedFrame;
    const playbackActive = this.playback?.isActive() ?? false;

    this.bargeInController.armIfPlaybackStartedBeforeTurn(
      playbackActive,
      this.turnState.turnSentAudio,
    );

    if (playbackActive && this.bargeInController.bargeInMode) {
      const decision = this.bargeInController.evaluateFrame(pcm16Mono, speakerIds);
      if (decision.action === 'hold') {
        return;
      }

      if (decision.action === 'barge_in') {
        this.modelAudioGate.beginAwaitingServerAck();
        this.turnState.extendMinForward(config.localBargeInMinForwardMs);

        this.interruptPlayback();

        for (const chunk of decision.preRollChunks || []) {
          this.sendAudioChunkToGemini(chunk.pcm16Mono, chunk.speakerIds);
        }
        return;
      }
    }

    this.sendAudioChunkToGemini(pcm16Mono, speakerIds);
  }

  maybeScheduleTurnFinish() {
    if (!this.turnState.turnSentAudio || !this.mixer) return;
    if (this.turnFinishTimer) return;
    if (this.mixer.hasBufferedAudio()) return;
    if (this.mixer.hasActiveStreams()) return;

    const finalizeTurn = () => {
      this.turnFinishTimer = null;
      if (!this.turnState.turnSentAudio || !this.mixer) return;
      if (this.mixer.hasBufferedAudio()) return;
      if (this.mixer.hasActiveStreams()) return;

      if (this.geminiSession?.ready) {
        this.sendRealtime({ audioStreamEnd: true });
      }

      this.completeCurrentTurn();
    };

    const waitMs = Math.max(0, this.turnState.turnMinForwardUntil - Date.now());
    if (waitMs === 0) {
      finalizeTurn();
      return;
    }

    this.turnFinishTimer = setTimeout(finalizeTurn, waitMs);
  }

  sendAudioChunkToGemini(pcm16Mono, speakerIds = []) {
    if (!this.geminiSession?.ready) return;

    this.turnState.markAudioSent(speakerIds);

    if (this.modelAudioGate.isAwaitingServerAck()) {
      this.turnState.extendMinForward(config.localBargeInMinForwardMs);
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
    this.modelAudioGate.clear();
  }

  maybeReleaseStaleModelAudioGate() {
    this.modelAudioGate.maybeReleaseStaleModelAudioGate(config.serverInterruptFallbackMs);
  }

  getSpeakerLabel() {
    return formatSpeakerLabels({
      speakerIds: this.turnState.getSpeakerIdsForLabel(),
      voiceChannel: this.voiceChannel,
      client: this.client,
    });
  }

  completeCurrentTurn() {
    this.turnState.completeCurrentTurn();
    this.bargeInController.reset();
  }

  resetTurnState() {
    if (this.turnFinishTimer) {
      clearTimeout(this.turnFinishTimer);
      this.turnFinishTimer = null;
    }

    this.turnState.reset();
    this.bargeInController.reset();

    this.mixer?.reset();
  }

  async resetForGeminiReconnect() {
    this.flushTtsBuffer({ interrupted: true });
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
      clearTimeout(this.mixerTicker);
      this.mixerTicker = null;
    }

    if (this.detachConnectionLifecycle) {
      this.detachConnectionLifecycle();
      this.detachConnectionLifecycle = null;
    }

    this.clearServerBargeInWait();
    this.flushTtsBuffer({ interrupted: true });
    this.interruptPlayback();
    this.resetTurnState();
    this.mixer?.stop();
    this.playback?.stop();

    await this.geminiSession?.stop();

    this.voiceReady = false;

    try {
      this.connection?.destroy();
    } catch (error) {
      this.log('voice', 'Failed to destroy voice connection', error);
    }

    try {
      this.inputCodec?.delete?.();
      this.outputCodec?.delete?.();
    } catch (error) {
      this.log('voice', 'Failed to cleanup opus codecs', error);
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

    if (isImportantBridgeEvent(scope, args)) {
      logImportantEvent(prefix, ...args);
      return;
    }

    logRoutineAction(prefix, ...args);
  }
}

const GEMINI_IMPORTANT_MESSAGE_SNIPPETS = [
  'Setup complete',
  'Live connection opened',
  'Live connection closed',
  'Received goAway; reconnecting',
  'Live API rejected',
  'Scheduling reconnect attempt',
  'Entering degraded state',
  'Manual reset requested',
];

const VOICE_IMPORTANT_MESSAGE_SNIPPETS = [
  'Voice connection did not recover after disconnect; destroying bridge',
];

function isImportantBridgeEvent(scope, args) {
  const message = getFirstStringArg(args);
  if (!message) return false;

  if (scope === 'gemini') {
    return GEMINI_IMPORTANT_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet));
  }

  if (scope === 'voice') {
    return VOICE_IMPORTANT_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet));
  }

  return false;
}

function getFirstStringArg(args) {
  for (const value of args) {
    if (typeof value === 'string') return value;
  }

  return '';
}
