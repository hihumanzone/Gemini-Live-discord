import { GoogleGenAI, Modality } from '@google/genai';

import { config } from '../../config/index.js';

export class GeminiLiveSessionManager {
  /**
   * @param {{
   *   guildId: string,
   *   log: (scope: string, ...args: any[]) => void,
   *   onMessage?: (message: any) => void,
   *   onSessionReset?: (context: { reason: string }) => Promise<void> | void,
   *   ai?: GoogleGenAI,
   * }} options
   */
  constructor({ guildId, log, onMessage, onSessionReset, ai }) {
    this.guildId = guildId;
    this.log = log;
    this.onMessage = onMessage;
    this.onSessionReset = onSessionReset;
    this.ai = ai || new GoogleGenAI({ apiKey: config.geminiApiKey });

    this.session = null;
    this.ready = false;
    this.degraded = false;
    this.destroyed = false;

    this.connectCounter = 0;
    this.currentConnectId = 0;
    this.expectedCloseIds = new Set();
    this.reconnectInFlight = null;
    this.setupTimeout = null;

    this.resumeHandle = null;
    this.shouldResumeOnReconnect = false;
    this.reconnectTimer = null;

    this.lastProtocolErrorAt = 0;
    this.protocolErrorBurst = 0;

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
    let isSettled = false;

    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (isSettled) return;
        const error = new Error(message);
        error.code = timeoutCode;
        reject(error);
      }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      isSettled = true;
      if (timer) clearTimeout(timer);
    });
  }

  classifyError(error) {
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

  markFailure(classification, error) {
    this.ready = false;
    this.degraded = false;
    this.log('gemini', `Connection failure (${classification})`, error);
  }

  clearSetupTimer() {
    if (this.setupTimeout) {
      clearTimeout(this.setupTimeout);
      this.setupTimeout = null;
    }
  }

  onSetupComplete() {
    this.clearSetupTimer();
    this.ready = true;
    this.degraded = false;
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
      if (this.destroyed || connectId !== this.currentConnectId || this.ready) return;

      const error = new Error(
        `Gemini setup did not complete within ${config.geminiSetupTimeoutMs}ms`,
      );
      error.code = 'SETUP_TIMEOUT';
      this.markFailure('setup_timeout', error);
      await this.closeCurrentSession('setup_timeout');
      this.scheduleReconnect(undefined, 'setup_timeout', error);
    }, config.geminiSetupTimeoutMs);
  }

  async connect() {
    if (this.destroyed) return;

    this.ready = false;

    const connectId = ++this.connectCounter;
    this.currentConnectId = connectId;

    let session;
    try {
      session = await this.withTimeout(
        this.ai.live.connect({
          model: config.model,
          config: this.buildLiveConfig(),
          callbacks: {
            onopen: () => {
              if (connectId !== this.currentConnectId) return;
              this.log('gemini', 'Live connection opened');
            },
            onmessage: (message) => {
              this.handleMessage(message, connectId);
            },
            onerror: (error) => {
              if (connectId !== this.currentConnectId) return;
              this.log('gemini', 'Live error', error);
            },
            onclose: (event) => {
              void this.handleClose(event, connectId);
            },
          },
        }),
        config.geminiConnectTimeoutMs,
        'CONNECT_TIMEOUT',
        `Gemini connect timed out after ${config.geminiConnectTimeoutMs}ms`,
      );
    } catch (error) {
      const classification = this.classifyError(error);
      this.markFailure(classification, error);
      this.currentConnectId = 0;
      throw error;
    }

    if (this.destroyed || connectId !== this.currentConnectId) {
      try {
        await session.close();
      } catch {
        // Ignore stale session close errors.
      }
      return;
    }

    this.session = session;
    this.scheduleSetupTimeout(connectId);
  }

  handleMessage(message, connectId = this.currentConnectId) {
    if (connectId !== this.currentConnectId) return;

    if (message.setupComplete) {
      this.onSetupComplete();
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

    this.onMessage?.(message);
  }

  async handleClose(event, connectId = this.currentConnectId) {
    const code = event?.code;
    const reason = event?.reason;
    const wasExpected = this.expectedCloseIds.delete(connectId);
    const isCurrent = connectId === this.currentConnectId;

    if (isCurrent) {
      this.clearSetupTimer();
      this.ready = false;
      this.session = null;
      this.currentConnectId = 0;
    }

    this.log('gemini', 'Live connection closed', code, reason);

    if (this.destroyed || wasExpected || !isCurrent) {
      return;
    }

    if (code === 1007) {
      await this.handleProtocolRejection(reason);
      return;
    }

    this.scheduleReconnect(undefined, 'closed', new Error(reason || `close_${code}`));
  }

  async handleProtocolRejection(reason) {
    const now = Date.now();
    this.protocolErrorBurst = now - this.lastProtocolErrorAt < 30_000
      ? this.protocolErrorBurst + 1
      : 1;
    this.lastProtocolErrorAt = now;

    this.shouldResumeOnReconnect = false;
    this.resumeHandle = null;
    await this.resetSessionState('protocol_rejection');

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

  async resetSessionState(reason) {
    if (!this.onSessionReset) return;

    try {
      await this.onSessionReset({ reason });
    } catch (error) {
      this.log('gemini', `Failed local session reset during ${reason}`, error);
    }
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
    this.degraded = true;
    this.ready = false;
    this.retryState.degradedSince = this.retryState.degradedSince || Date.now();
    this.log(
      'gemini',
      `Entering degraded state (${classification}) after ${this.retryState.consecutiveAttempts} attempts. Manual ${config.botPrefix}reset required.`,
      reason,
    );
  }

  async closeCurrentSession(classification) {
    const session = this.session;
    const connectId = this.currentConnectId;

    if (connectId) {
      this.expectedCloseIds.add(connectId);
    }

    this.session = null;
    this.ready = false;
    this.currentConnectId = 0;
    this.clearSetupTimer();

    try {
      await session?.close();
    } catch (closeError) {
      this.log('gemini', `Failed to close stale session during ${classification}`, closeError);
    }
  }

  scheduleReconnect(delayOverrideMs, classification = 'unknown', lastError = null) {
    if (this.destroyed || this.reconnectTimer || this.degraded) return;
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
        await this.reconnect();
      } catch (error) {
        const errorClass = this.classifyError(error);
        await this.closeCurrentSession(errorClass);
        this.scheduleReconnect(undefined, errorClass, error);
      }
    }, delayMs);
  }

  async reconnect(options = {}) {
    const manual = Boolean(options.manual);
    if (this.destroyed) return;

    if (manual && this.degraded) {
      this.log('gemini', 'Manual reset requested; leaving degraded mode and retrying connection.');
      this.degraded = false;
      this.retryState.consecutiveAttempts = 0;
      this.retryState.firstAttemptAt = 0;
      this.retryState.lastErrorClass = 'manual_reset';
    }

    if (this.degraded) return;
    if (this.reconnectInFlight) {
      await this.reconnectInFlight;
      return;
    }

    const run = async () => {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      await this.closeCurrentSession('reconnect');
      await this.resetSessionState(manual ? 'manual_reset' : 'reconnect');

      try {
        await this.connect();
      } catch (error) {
        const classification = this.classifyError(error);
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

  resetResumptionState() {
    this.shouldResumeOnReconnect = false;
    this.resumeHandle = null;
  }

  sendRealtime(payload) {
    if (!this.session || !this.ready) return;

    try {
      this.session.sendRealtimeInput(payload);
    } catch (error) {
      this.log('gemini', 'Failed to send realtime input', error);
      const classification = this.classifyError(error);
      void this.closeCurrentSession(classification);
      this.scheduleReconnect(0, classification, error);
    }
  }

  async stop() {
    this.destroyed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.clearSetupTimer();
    await this.closeCurrentSession('stop');

    this.ready = false;
    this.session = null;
  }
}
