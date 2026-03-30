import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import opusPkg from '@discordjs/opus';
const { OpusEncoder } = opusPkg;
import { GoogleGenAI, Modality } from '@google/genai';

import { config } from './config.js';
import {
  DISCORD_INPUT_SAMPLE_RATE,
  DISCORD_CHANNELS,
  DISCORD_PLAYBACK_FRAME_BYTES,
  GEMINI_INPUT_SAMPLE_RATE,
  computeMonoPcmRms,
  discordPcm48StereoToGemini16Mono,
  gemini24MonoToDiscord48Stereo,
  monoPcmDurationMs,
  trimBufferArray,
} from './audio.js';

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

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

    this.gemini = null;
    this.geminiReady = false;
    this.expectedClose = false;
    this.destroyed = false;

    this.resumeHandle = null;
    this.shouldResumeOnReconnect = false;
    this.reconnectTimer = null;

    this.lastProtocolErrorAt = 0;
    this.protocolErrorBurst = 0;

    this.activeSpeakerId = null;
    this.activeSpeakerStream = null;
    this.activeSpeakerFinishTimer = null;
    this.activeSpeakerSentAudio = false;
    this.activeSpeakerBargeInMode = false;
    this.activeSpeakerAboveThresholdFrames = 0;
    this.activeSpeakerPreRollChunks = [];
    this.activeSpeakerMinForwardUntil = 0;

    this.awaitingServerBargeIn = false;
    this.awaitingServerBargeInSince = 0;
    this.dropModelAudioUntilBargeInAck = false;

    this.inputCodec = new OpusEncoder(DISCORD_INPUT_SAMPLE_RATE, DISCORD_CHANNELS);
    this.outputCodec = new OpusEncoder(DISCORD_INPUT_SAMPLE_RATE, DISCORD_CHANNELS);

    this.pendingGemini24 = Buffer.alloc(0);
    this.pendingDiscord48 = Buffer.alloc(0);
    this.outboundOpusPackets = [];
    this.playbackTicker = null;
    this.playbackActive = false;
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
    this.startPlaybackLoop();

    await waitForVoiceReady(this.connection, this.guildId);
    this.voiceReady = true;
    await this.connectGemini();
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
    const receiver = this.connection.receiver;

    receiver.speaking.on('start', (userId) => {
      if (!this.canAcceptSpeaker(userId)) return;
      this.log('voice', `Detected speech from ${userId}`);
      this.beginUserTurn(userId);
    });
  }

  canAcceptSpeaker(userId) {
    if (this.destroyed || !this.voiceReady || !this.geminiReady || !userId) return false;
    if (userId === this.client.user?.id) return false;

    const user = this.client.users.cache.get(userId);
    if (user?.bot) return false;

    if (this.activeSpeakerId && this.activeSpeakerId !== userId) return false;
    if (this.activeSpeakerStream && this.activeSpeakerId === userId) return false;

    return true;
  }

  buildLiveConfig() {
    /** @type {Record<string, any>} */
    const liveConfig = {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: config.voiceName,
          },
        },
      },
      systemInstruction: {
        parts: [{ text: config.systemPrompt }],
      },
      thinkingConfig: {
        thinkingLevel: 'minimal',
      },
      realtimeInputConfig: {
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: config.geminiVadStartSensitivity,
          endOfSpeechSensitivity: config.geminiVadEndSensitivity,
          prefixPaddingMs: config.geminiVadPrefixPaddingMs,
          silenceDurationMs: config.geminiVadSilenceDurationMs,
        },
        turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
    };

    if (config.enableSessionResumption) {
      liveConfig.sessionResumption =
        this.shouldResumeOnReconnect && this.resumeHandle
          ? { handle: this.resumeHandle }
          : {};
    }

    return liveConfig;
  }

  async connectGemini() {
    if (this.destroyed) return;

    this.geminiReady = false;
    this.expectedClose = false;

    this.gemini = await ai.live.connect({
      model: config.model,
      config: this.buildLiveConfig(),
      callbacks: {
        onopen: () => {
          this.log('gemini', 'Live connection opened');
        },
        onmessage: (message) => {
          this.handleGeminiMessage(message);
        },
        onerror: (error) => {
          this.log('gemini', 'Live error', error);
        },
        onclose: (event) => {
          this.handleGeminiClose(event);
        },
      },
    });
  }

  handleGeminiMessage(message) {
    if (message.setupComplete) {
      this.geminiReady = true;
      this.shouldResumeOnReconnect = config.enableSessionResumption;
      this.log('gemini', 'Setup complete');
      return;
    }

    const resumption = message.sessionResumptionUpdate;
    if (resumption?.resumable && resumption?.newHandle) {
      this.resumeHandle = resumption.newHandle;
    }

    if (message.goAway) {
      this.log('gemini', 'Received goAway; reconnecting');
      this.scheduleReconnect(1_000);
      return;
    }

    const serverContent = message.serverContent;
    if (!serverContent) return;

    if (serverContent.interrupted) {
      this.clearServerBargeInWait();
      this.interruptPlayback();
    }

    if (serverContent.turnComplete) {
      this.clearServerBargeInWait();
      if (!this.activeSpeakerStream) {
        this.activeSpeakerId = null;
      }
    }

    this.maybeReleaseStaleModelAudioGate();

    if (serverContent.inputTranscription?.text) {
      this.clearServerBargeInWait();
      const speaker = this.getSpeakerLabel();
      this.log('stt', `${speaker}: ${serverContent.inputTranscription.text}`);
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

  handleGeminiClose(event) {
    const code = event?.code;
    const reason = event?.reason;
    this.log('gemini', 'Live connection closed', code, reason);

    this.geminiReady = false;
    this.gemini = null;

    if (this.destroyed || this.expectedClose) {
      this.expectedClose = false;
      return;
    }

    if (code === 1007) {
      this.handleProtocolRejection(reason);
      return;
    }

    this.scheduleReconnect();
  }

  handleProtocolRejection(reason) {
    const now = Date.now();
    this.protocolErrorBurst = now - this.lastProtocolErrorAt < 30_000
      ? this.protocolErrorBurst + 1
      : 1;
    this.lastProtocolErrorAt = now;

    this.shouldResumeOnReconnect = false;
    this.resumeHandle = null;
    this.finishUserTurn();
    this.interruptPlayback();

    if (this.protocolErrorBurst > 3) {
      this.log(
        'gemini',
        `Live API rejected ${this.protocolErrorBurst} consecutive requests; not auto-reconnecting again. Use ${config.botPrefix}reset after checking logs.`,
      );
      return;
    }

    this.log(
      'gemini',
      `Live API rejected the session (1007: ${reason || 'invalid argument'}). Reconnecting with a fresh session.`,
    );
    this.scheduleReconnect(1_000);
  }

  beginUserTurn(userId) {
    this.activeSpeakerId = userId;
    this.activeSpeakerBargeInMode = this.playbackActive;
    this.activeSpeakerSentAudio = false;
    this.activeSpeakerAboveThresholdFrames = 0;
    this.activeSpeakerPreRollChunks = [];
    this.activeSpeakerMinForwardUntil = 0;

    if (this.activeSpeakerFinishTimer) {
      clearTimeout(this.activeSpeakerFinishTimer);
      this.activeSpeakerFinishTimer = null;
    }

    const opusStream = this.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: config.discordSpeechEndMs,
      },
    });

    this.activeSpeakerStream = opusStream;

    opusStream.on('data', (opusPacket) => {
      this.handleIncomingOpusPacket(userId, opusPacket);
    });

    opusStream.once('end', () => {
      if (this.activeSpeakerStream === opusStream) {
        this.activeSpeakerStream = null;
      }
      if (this.activeSpeakerId === userId) {
        this.deferFinishUserTurn(opusStream, userId);
      }
    });

    opusStream.once('error', (error) => {
      this.log('voice', 'Speaker stream error', error);
      if (this.activeSpeakerId === userId) {
        this.deferFinishUserTurn(opusStream, userId);
      }
    });
  }

  handleIncomingOpusPacket(userId, opusPacket) {
    if (this.destroyed || !this.voiceReady || !this.geminiReady) return;
    if (this.activeSpeakerId !== userId) return;

    let pcm48Stereo;
    try {
      pcm48Stereo = this.inputCodec.decode(opusPacket);
    } catch (error) {
      this.log('voice', 'Failed to decode Opus packet', error);
      return;
    }

    const pcm16Mono = discordPcm48StereoToGemini16Mono(pcm48Stereo);
    if (pcm16Mono.length === 0) return;

    if (this.activeSpeakerBargeInMode && this.playbackActive) {
      this.handlePotentialBargeIn(userId, pcm16Mono);
      return;
    }

    this.sendAudioChunkToGemini(pcm16Mono);
  }

  handlePotentialBargeIn(userId, pcm16Mono) {
    const chunkDurationMs = monoPcmDurationMs(pcm16Mono, GEMINI_INPUT_SAMPLE_RATE);
    const maxPreRollChunks = Math.max(
      1,
      Math.ceil(config.localBargeInPreRollMs / chunkDurationMs),
    );

    this.activeSpeakerPreRollChunks.push(pcm16Mono);
    trimBufferArray(this.activeSpeakerPreRollChunks, maxPreRollChunks);

    const rms = computeMonoPcmRms(pcm16Mono);
    this.activeSpeakerAboveThresholdFrames =
      rms >= config.localBargeInRmsThreshold
        ? this.activeSpeakerAboveThresholdFrames + 1
        : 0;

    if (this.activeSpeakerAboveThresholdFrames < config.localBargeInConsecutiveFrames) {
      return;
    }

    this.log(
      'voice',
      `Qualified barge-in from ${userId} (rms=${Math.round(rms)}, frames=${this.activeSpeakerAboveThresholdFrames})`,
    );

    this.awaitingServerBargeIn = true;
    this.awaitingServerBargeInSince = Date.now();
    this.dropModelAudioUntilBargeInAck = true;
    this.activeSpeakerMinForwardUntil = Date.now() + config.localBargeInMinForwardMs;

    this.interruptPlayback();
    this.activeSpeakerBargeInMode = false;
    this.activeSpeakerAboveThresholdFrames = 0;

    const preRollChunks = this.activeSpeakerPreRollChunks;
    this.activeSpeakerPreRollChunks = [];
    for (const chunk of preRollChunks) {
      this.sendAudioChunkToGemini(chunk);
    }
  }

  deferFinishUserTurn(stream = null, userId = this.activeSpeakerId) {
    const finalize = () => {
      this.activeSpeakerFinishTimer = null;

      if (userId && this.activeSpeakerId && userId !== this.activeSpeakerId) return;
      if (this.geminiReady && this.activeSpeakerSentAudio) {
        this.sendRealtime({ audioStreamEnd: true });
      }
      this.finishUserTurn(stream, userId);
    };

    if (this.activeSpeakerFinishTimer) {
      clearTimeout(this.activeSpeakerFinishTimer);
      this.activeSpeakerFinishTimer = null;
    }

    const waitMs = Math.max(0, this.activeSpeakerMinForwardUntil - Date.now());
    if (waitMs === 0) {
      finalize();
      return;
    }

    this.activeSpeakerFinishTimer = setTimeout(finalize, waitMs);
  }

  sendAudioChunkToGemini(pcm16Mono) {
    if (!this.gemini || !this.geminiReady) return;

    this.activeSpeakerSentAudio = true;
    if (this.awaitingServerBargeIn) {
      this.activeSpeakerMinForwardUntil = Math.max(
        this.activeSpeakerMinForwardUntil,
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
    if (!this.gemini || !this.geminiReady) return;

    try {
      this.gemini.sendRealtimeInput(payload);
    } catch (error) {
      this.log('gemini', 'Failed to send realtime input', error);
    }
  }

  pushGeminiAudioChunk(pcm24Mono) {
    this.pendingGemini24 = Buffer.concat([this.pendingGemini24, pcm24Mono]);

    const evenByteLength = this.pendingGemini24.length - (this.pendingGemini24.length % 2);
    if (evenByteLength === 0) return;

    const ready24Mono = this.pendingGemini24.subarray(0, evenByteLength);
    this.pendingGemini24 = this.pendingGemini24.subarray(evenByteLength);

    this.pendingDiscord48 = Buffer.concat([
      this.pendingDiscord48,
      gemini24MonoToDiscord48Stereo(ready24Mono),
    ]);

    while (this.pendingDiscord48.length >= DISCORD_PLAYBACK_FRAME_BYTES) {
      const frame = this.pendingDiscord48.subarray(0, DISCORD_PLAYBACK_FRAME_BYTES);
      this.pendingDiscord48 = this.pendingDiscord48.subarray(DISCORD_PLAYBACK_FRAME_BYTES);

      try {
        this.outboundOpusPackets.push(this.outputCodec.encode(frame));
      } catch (error) {
        this.log('voice', 'Failed to encode PCM frame', error);
      }
    }
  }

  startPlaybackLoop() {
    if (this.playbackTicker) return;

    this.playbackTicker = setInterval(() => {
      if (this.destroyed || !this.connection || !this.voiceReady) return;

      const packet = this.outboundOpusPackets.shift();
      if (!packet) {
        this.setSpeaking(false);
        this.playbackActive = false;
        return;
      }

      try {
        if (!this.playbackActive) {
          this.setSpeaking(true);
          this.playbackActive = true;
        }
        this.connection.playOpusPacket(packet);
      } catch (error) {
        this.log('voice', 'Failed to play Opus packet', error);
      }
    }, 20);
  }

  interruptPlayback() {
    this.outboundOpusPackets.length = 0;
    this.pendingGemini24 = Buffer.alloc(0);
    this.pendingDiscord48 = Buffer.alloc(0);
    this.setSpeaking(false);
    this.playbackActive = false;
  }

  setSpeaking(value) {
    if (!this.connection) return;
    try {
      this.connection.setSpeaking(value);
    } catch {
      // Best effort only.
    }
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
    const user = this.activeSpeakerId ? this.client.users.cache.get(this.activeSpeakerId) : null;
    return user ? user.username : this.activeSpeakerId ?? 'unknown';
  }

  finishUserTurn(stream = null, userId = this.activeSpeakerId) {
    if (stream && this.activeSpeakerStream && stream !== this.activeSpeakerStream) return;
    if (userId && this.activeSpeakerId && userId !== this.activeSpeakerId) return;

    if (this.activeSpeakerFinishTimer) {
      clearTimeout(this.activeSpeakerFinishTimer);
      this.activeSpeakerFinishTimer = null;
    }

    this.activeSpeakerId = null;
    this.activeSpeakerStream = null;
    this.activeSpeakerSentAudio = false;
    this.activeSpeakerBargeInMode = false;
    this.activeSpeakerAboveThresholdFrames = 0;
    this.activeSpeakerPreRollChunks = [];
    this.activeSpeakerMinForwardUntil = 0;
  }

  scheduleReconnect(delayMs = 2_000) {
    if (this.destroyed || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.reconnectGemini();
      } catch (error) {
        this.log('gemini', 'Reconnect failed', error);
        this.scheduleReconnect(5_000);
      }
    }, delayMs);
  }

  async reconnectGemini() {
    if (this.destroyed) return;

    this.expectedClose = true;
    try {
      await this.gemini?.close();
    } catch {
      // Ignore close errors.
    } finally {
      this.gemini = null;
      this.geminiReady = false;
    }

    this.clearServerBargeInWait();
    this.interruptPlayback();
    this.finishUserTurn();

    await this.connectGemini();
  }

  async stop() {
    this.destroyed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.playbackTicker) {
      clearInterval(this.playbackTicker);
      this.playbackTicker = null;
    }

    this.clearServerBargeInWait();
    this.interruptPlayback();
    this.finishUserTurn();

    this.expectedClose = true;
    try {
      await this.gemini?.close();
    } catch {
      // Ignore close errors.
    }

    this.gemini = null;
    this.geminiReady = false;
    this.voiceReady = false;

    try {
      this.connection?.destroy();
    } catch {
      // Ignore destroy errors.
    }

    this.connection = null;
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

async function waitForVoiceReady(connection, guildId, timeoutMs = 20_000, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (connection.state.status === VoiceConnectionStatus.Ready) return;

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, timeoutMs);
      return;
    } catch (error) {
      const status = connection.state.status;
      console.warn(
        `[voice:${guildId}] Ready wait attempt ${attempt}/${maxAttempts} failed while in state ${status}`,
        error,
      );

      if (attempt >= maxAttempts) {
        throw error;
      }

      try {
        connection.rejoin();
      } catch (rejoinError) {
        console.warn(`[voice:${guildId}] Rejoin attempt failed`, rejoinError);
      }
    }
  }
}
