import {
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import opusPkg from '@discordjs/opus';
const { OpusEncoder } = opusPkg;
import { GoogleGenAI, Modality } from '@google/genai';

import { config } from './config.js';
import {
  DISCORD_CHANNELS,
  DISCORD_FRAME_MS,
  DISCORD_INPUT_SAMPLE_RATE,
  DISCORD_PLAYBACK_FRAME_BYTES,
  GEMINI_INPUT_SAMPLE_RATE,
  computeMonoPcmRms,
  gemini24MonoToDiscord48Stereo,
  monoPcmDurationMs,
  trimBufferArray,
} from './audio.js';
import { MultiUserFrameMixer } from './mixer.js';

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
    this.geminiDegraded = false;
    this.destroyed = false;

    this.geminiConnectCounter = 0;
    this.currentGeminiConnectId = 0;
    this.expectedCloseIds = new Set();
    this.reconnectInFlight = null;
    this.setupTimeout = null;

    this.resumeHandle = null;
    this.shouldResumeOnReconnect = false;
    this.reconnectTimer = null;

    this.lastProtocolErrorAt = 0;
    this.protocolErrorBurst = 0;

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

    this.retryPolicy = {
      baseDelayMs: config.geminiReconnectBaseDelayMs,
      maxDelayMs: Math.max(config.geminiReconnectBaseDelayMs, config.geminiReconnectMaxDelayMs),
      maxConsecutiveAttempts: config.geminiReconnectMaxAttempts,
      burstWindowMs: config.geminiReconnectBurstWindowMs,
      stableResetMs: config.geminiReconnectStableResetMs,
    };
    this.retryState = {
      consecutiveAttempts: 0,
      firstAttemptAt: 0,
      lastFailureAt: 0,
      stableSince: Date.now(),
      degradedSince: 0,
      lastErrorClass: 'unknown',
    };

    this.mixer = null;
    this.pendingGemini24 = Buffer.alloc(0);
    this.pendingDiscord48 = Buffer.alloc(0);
    this.outboundOpusPackets = [];
    this.playbackTicker = null;
    this.playbackActive = false;
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
    this.startPlaybackLoop();
    this.startMixerLoop();

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

  canAcceptSpeaker(userId) {
    if (this.destroyed || !this.voiceReady || !this.geminiReady || !userId) return false;
    if (userId === this.client.user?.id) return false;

    const user = this.client.users.cache.get(userId);
    if (user?.bot) return false;

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

  withTimeout(promise, timeoutMs, timeoutCode, message) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(message);
        error.code = timeoutCode;
        reject(error);
      }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  classifyGeminiError(error) {
    const code = error?.code;
    const text = String(error?.message || error || '').toLowerCase();

    if (code === 'CONNECT_TIMEOUT') return 'connect_timeout';
    if (code === 'SETUP_TIMEOUT') return 'setup_timeout';
    if (code === 401 || code === 403 || text.includes('auth') || text.includes('permission')) {
      return 'auth_failure';
    }
    if (code === 429 || text.includes('rate') || text.includes('quota')) return 'rate_limited';
    return 'connect_failure';
  }

  markGeminiFailure(classification, error) {
    this.geminiReady = false;
    this.geminiDegraded = false;
    this.log('gemini', `Connection failure (${classification})`, error);
  }

  clearSetupTimer() {
    if (this.setupTimeout) {
      clearTimeout(this.setupTimeout);
      this.setupTimeout = null;
    }
  }

  onGeminiSetupComplete() {
    this.clearSetupTimer();
    this.geminiReady = true;
    this.geminiDegraded = false;
    this.shouldResumeOnReconnect = config.enableSessionResumption;
    this.resetRetryStateOnStable();
    this.log('gemini', 'Setup complete');
  }

  resetRetryStateOnStable() {
    this.retryState.consecutiveAttempts = 0;
    this.retryState.firstAttemptAt = 0;
    this.retryState.stableSince = Date.now();
    this.retryState.degradedSince = 0;
    this.retryState.lastErrorClass = 'none';
  }

  scheduleSetupTimeout(connectId) {
    this.clearSetupTimer();
    this.setupTimeout = setTimeout(async () => {
      if (this.destroyed || connectId !== this.currentGeminiConnectId || this.geminiReady) return;

      const error = new Error(
        `Gemini setup did not complete within ${config.geminiSetupTimeoutMs}ms`,
      );
      error.code = 'SETUP_TIMEOUT';
      this.markGeminiFailure('setup_timeout', error);
      await this.closeCurrentGeminiSession('setup_timeout');
      this.scheduleReconnect(undefined, 'setup_timeout', error);
    }, config.geminiSetupTimeoutMs);
  }

  async connectGemini() {
    if (this.destroyed) return;

    this.geminiReady = false;

    const connectId = ++this.geminiConnectCounter;
    this.currentGeminiConnectId = connectId;

    let session;
    try {
      session = await this.withTimeout(
        ai.live.connect({
          model: config.model,
          config: this.buildLiveConfig(),
          callbacks: {
            onopen: () => {
              if (connectId !== this.currentGeminiConnectId) return;
              this.log('gemini', 'Live connection opened');
            },
            onmessage: (message) => {
              this.handleGeminiMessage(message, connectId);
            },
            onerror: (error) => {
              if (connectId !== this.currentGeminiConnectId) return;
              this.log('gemini', 'Live error', error);
            },
            onclose: (event) => {
              this.handleGeminiClose(event, connectId);
            },
          },
        }),
        config.geminiConnectTimeoutMs,
        'CONNECT_TIMEOUT',
        `Gemini connect timed out after ${config.geminiConnectTimeoutMs}ms`,
      );
    } catch (error) {
      const classification = this.classifyGeminiError(error);
      this.markGeminiFailure(classification, error);
      this.currentGeminiConnectId = 0;
      throw error;
    }

    if (this.destroyed || connectId !== this.currentGeminiConnectId) {
      try {
        await session.close();
      } catch {
        // Ignore stale session close errors.
      }
      return;
    }

    this.gemini = session;
    this.scheduleSetupTimeout(connectId);
  }

  handleGeminiMessage(message, connectId = this.currentGeminiConnectId) {
    if (connectId !== this.currentGeminiConnectId) return;

    if (message.setupComplete) {
      this.onGeminiSetupComplete();
      return;
    }

    const resumption = message.sessionResumptionUpdate;
    if (resumption?.resumable && resumption?.newHandle) {
      this.resumeHandle = resumption.newHandle;
    }

    if (message.goAway) {
      this.log('gemini', 'Received goAway; reconnecting');
      this.scheduleReconnect(undefined, 'go_away');
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

  handleGeminiClose(event, connectId = this.currentGeminiConnectId) {
    const code = event?.code;
    const reason = event?.reason;
    const wasExpected = this.expectedCloseIds.delete(connectId);
    const isCurrent = connectId === this.currentGeminiConnectId;

    if (isCurrent) {
      this.clearSetupTimer();
      this.geminiReady = false;
      this.gemini = null;
      this.currentGeminiConnectId = 0;
    }

    this.log('gemini', 'Live connection closed', code, reason);

    if (this.destroyed || wasExpected || !isCurrent) {
      return;
    }

    if (code === 1007) {
      this.handleProtocolRejection(reason);
      return;
    }

    this.scheduleReconnect(undefined, 'closed', new Error(reason || `close_${code}`));
  }

  handleProtocolRejection(reason) {
    const now = Date.now();
    this.protocolErrorBurst = now - this.lastProtocolErrorAt < 30_000
      ? this.protocolErrorBurst + 1
      : 1;
    this.lastProtocolErrorAt = now;

    this.shouldResumeOnReconnect = false;
    this.resumeHandle = null;
    this.resetTurnState();
    this.interruptPlayback();

    if (this.protocolErrorBurst > 3) {
      this.log(
        'gemini',
        `Live API rejected ${this.protocolErrorBurst} consecutive requests; not auto-reconnecting again. Use ${config.botPrefix}reset after checking logs.`,
      );
      this.enterDegradedState('protocol_rejection_burst', reason || 'invalid argument');
      return;
    }

    this.log(
      'gemini',
      `Live API rejected the session (1007: ${reason || 'invalid argument'}). Reconnecting with a fresh session.`,
    );
    this.scheduleReconnect(undefined, 'protocol_rejection', new Error(reason || 'invalid argument'));
  }

  startMixerLoop() {
    if (this.mixerTicker) return;

    this.mixerTicker = setInterval(() => {
      if (this.destroyed || !this.voiceReady || !this.geminiReady || !this.mixer) return;
      this.flushMixedUserAudioFrame();
    }, DISCORD_FRAME_MS);
  }

  flushMixedUserAudioFrame() {
    const mixed = this.mixer.collectMixedFrame();
    if (!mixed) {
      this.maybeScheduleTurnFinish();
      return;
    }

    const { pcm16Mono, speakerIds } = mixed;
    if (!this.turnSentAudio && this.playbackActive) {
      this.bargeInMode = true;
    }

    if (this.playbackActive && this.bargeInMode) {
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

    const finalize = () => {
      this.turnFinishTimer = null;
      if (!this.turnSentAudio || !this.mixer) return;
      if (this.mixer.hasBufferedAudio()) return;
      if (this.mixer.hasActiveStreams()) return;
      if (this.geminiReady) {
        this.sendRealtime({ audioStreamEnd: true });
      }
      this.completeCurrentTurn();
    };

    const waitMs = Math.max(0, this.turnMinForwardUntil - Date.now());
    if (waitMs === 0) {
      finalize();
      return;
    }

    this.turnFinishTimer = setTimeout(finalize, waitMs);
  }

  sendAudioChunkToGemini(pcm16Mono, speakerIds = []) {
    if (!this.gemini || !this.geminiReady) return;

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

      if (frame.length !== DISCORD_PLAYBACK_FRAME_BYTES) {
        this.log('voice', 'Skipping malformed PCM frame', frame.length);
        continue;
      }

      try {
        this.outboundOpusPackets.push(Buffer.from(this.outputCodec.encode(Buffer.from(frame))));
      } catch (error) {
        this.log('voice', 'Failed to encode PCM frame', error);
        this.pendingGemini24 = Buffer.alloc(0);
        this.pendingDiscord48 = Buffer.alloc(0);
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
    }, DISCORD_FRAME_MS);
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
    const ids = this.currentTranscriptionSpeakerIds.size
      ? [...this.currentTranscriptionSpeakerIds]
      : this.turnSpeakerIds.size
        ? [...this.turnSpeakerIds]
        : [...this.lastTurnSpeakerIds];

    return this.formatSpeakerIds(ids);
  }

  formatSpeakerIds(speakerIds) {
    const ids = [...new Set(speakerIds)].filter(Boolean);
    if (ids.length === 0) return 'unknown';

    const labels = ids.map((userId) => {
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

  nextBackoffDelay(attemptNumber) {
    const exp = Math.max(0, attemptNumber - 1);
    const jitter = 0.5 + Math.random();
    const raw = this.retryPolicy.baseDelayMs * (2 ** exp) * jitter;
    return Math.min(this.retryPolicy.maxDelayMs, Math.round(raw));
  }

  canAttemptReconnect() {
    const now = Date.now();

    if (
      this.retryState.stableSince
      && now - this.retryState.stableSince >= this.retryPolicy.stableResetMs
    ) {
      this.retryState.consecutiveAttempts = 0;
      this.retryState.firstAttemptAt = 0;
    }

    if (
      this.retryState.firstAttemptAt
      && now - this.retryState.firstAttemptAt > this.retryPolicy.burstWindowMs
    ) {
      this.retryState.consecutiveAttempts = 0;
      this.retryState.firstAttemptAt = 0;
    }

    if (!this.retryState.firstAttemptAt) {
      this.retryState.firstAttemptAt = now;
    }

    return this.retryState.consecutiveAttempts < this.retryPolicy.maxConsecutiveAttempts;
  }

  enterDegradedState(classification, reason) {
    this.geminiDegraded = true;
    this.geminiReady = false;
    this.retryState.degradedSince = this.retryState.degradedSince || Date.now();
    this.log(
      'gemini',
      `Entering degraded state (${classification}) after ${this.retryState.consecutiveAttempts} attempts. Manual ${config.botPrefix}reset required.`,
      reason,
    );
  }

  async closeCurrentGeminiSession(classification) {
    const session = this.gemini;
    const connectId = this.currentGeminiConnectId;

    if (connectId) {
      this.expectedCloseIds.add(connectId);
    }

    this.gemini = null;
    this.geminiReady = false;
    this.currentGeminiConnectId = 0;
    this.clearSetupTimer();

    try {
      await session?.close();
    } catch (closeError) {
      this.log('gemini', `Failed to close stale session during ${classification}`, closeError);
    }
  }

  scheduleReconnect(delayOverrideMs, classification = 'unknown', lastError = null) {
    if (this.destroyed || this.reconnectTimer || this.geminiDegraded) return;
    if (!this.canAttemptReconnect()) {
      this.enterDegradedState('retry_limit', this.retryState.lastErrorClass);
      return;
    }

    this.retryState.consecutiveAttempts += 1;
    this.retryState.lastFailureAt = Date.now();
    this.retryState.lastErrorClass = classification;

    const attempt = this.retryState.consecutiveAttempts;
    const delayMs = delayOverrideMs ?? this.nextBackoffDelay(attempt);

    this.log(
      'gemini',
      `Scheduling reconnect attempt ${attempt}/${this.retryPolicy.maxConsecutiveAttempts} in ${delayMs}ms (last_error=${classification})`,
      lastError || '',
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.reconnectGemini();
      } catch (error) {
        const errorClass = this.classifyGeminiError(error);
        await this.closeCurrentGeminiSession(errorClass);
        this.scheduleReconnect(undefined, errorClass, error);
      }
    }, delayMs);
  }

  async reconnectGemini(options = {}) {
    const manual = Boolean(options.manual);
    if (this.destroyed) return;

    if (manual && this.geminiDegraded) {
      this.log('gemini', 'Manual reset requested; leaving degraded mode and retrying connection.');
      this.geminiDegraded = false;
      this.retryState.consecutiveAttempts = 0;
      this.retryState.firstAttemptAt = 0;
      this.retryState.lastErrorClass = 'manual_reset';
    }

    if (this.geminiDegraded) return;
    if (this.reconnectInFlight) {
      await this.reconnectInFlight;
      return;
    }

    const run = async () => {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      await this.closeCurrentGeminiSession('reconnect');
      this.clearServerBargeInWait();
      this.interruptPlayback();
      this.resetTurnState();

      try {
        await this.connectGemini();
      } catch (error) {
        const classification = this.classifyGeminiError(error);
        this.retryState.lastErrorClass = classification;
        throw error;
      }
    };

    const promise = run();
    this.reconnectInFlight = promise;

    try {
      await promise;
    } finally {
      if (this.reconnectInFlight === promise) {
        this.reconnectInFlight = null;
      }
    }
  }

  async stop() {
    this.destroyed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.clearSetupTimer();

    if (this.playbackTicker) {
      clearInterval(this.playbackTicker);
      this.playbackTicker = null;
    }

    if (this.mixerTicker) {
      clearInterval(this.mixerTicker);
      this.mixerTicker = null;
    }

    this.clearServerBargeInWait();
    this.interruptPlayback();
    this.resetTurnState();
    this.mixer?.stop();

    await this.closeCurrentGeminiSession('stop');

    this.gemini = null;
    this.geminiReady = false;
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
