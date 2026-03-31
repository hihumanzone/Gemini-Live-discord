import { EndBehaviorType } from '@discordjs/voice';

import {
  GEMINI_MONO_FRAME_BYTES,
  discordPcm48StereoToGemini16Mono,
  mixMonoPcmFrames,
} from './audio.js';

/**
 * Multi-user Discord receive helper.
 * Maintains one receive stream per active speaker, decodes incoming Opus packets,
 * stores 20 ms Gemini-ready mono PCM frames, and exposes a mixed frame on demand.
 */
export class MultiUserFrameMixer {
  /**
   * @param {{
   *   receiver: import('@discordjs/voice').VoiceReceiver,
   *   inputCodec: any,
   *   speechEndMs: number,
   *   shouldAcceptUser: (userId: string) => boolean,
   *   log: (scope: string, ...args: any[]) => void,
   * }} options
   */
  constructor({ receiver, inputCodec, speechEndMs, shouldAcceptUser, log }) {
    this.receiver = receiver;
    this.inputCodec = inputCodec;
    this.speechEndMs = speechEndMs;
    this.shouldAcceptUser = shouldAcceptUser;
    this.log = log;

    /** @type {Map<string, import('node:stream').Readable>} */
    this.speakerStreams = new Map();
    /** @type {Map<string, Buffer[]>} */
    this.speakerQueues = new Map();

    this.started = false;
    this.onSpeakingStart = this.onSpeakingStart.bind(this);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.receiver.speaking.on('start', this.onSpeakingStart);
  }

  stop() {
    if (this.started) {
      this.receiver.speaking.off('start', this.onSpeakingStart);
      this.started = false;
    }

    for (const stream of this.speakerStreams.values()) {
      try {
        stream.destroy();
      } catch {
        // Best effort.
      }
    }

    this.speakerStreams.clear();
    this.speakerQueues.clear();
  }

  reset() {
    this.stop();
    this.start();
  }

  onSpeakingStart(userId) {
    if (!this.shouldAcceptUser(userId)) return;
    this.log('voice', `Detected speech from ${userId}`);
    this.ensureSpeakerSubscription(userId);
  }

  ensureSpeakerSubscription(userId) {
    if (this.speakerStreams.has(userId)) return;

    const opusStream = this.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: this.speechEndMs,
      },
    });

    this.speakerStreams.set(userId, opusStream);
    this.ensureSpeakerQueue(userId);

    opusStream.on('data', (opusPacket) => {
      this.handleIncomingOpusPacket(userId, opusPacket);
    });

    const cleanup = () => {
      if (this.speakerStreams.get(userId) === opusStream) {
        this.speakerStreams.delete(userId);
      }
    };

    opusStream.once('end', cleanup);
    opusStream.once('close', cleanup);
    opusStream.once('error', (error) => {
      this.log('voice', `Speaker stream error from ${userId}`, error);
      cleanup();
    });
  }

  ensureSpeakerQueue(userId) {
    let queue = this.speakerQueues.get(userId);
    if (!queue) {
      queue = [];
      this.speakerQueues.set(userId, queue);
    }
    return queue;
  }

  handleIncomingOpusPacket(userId, opusPacket) {
    let pcm48Stereo;
    try {
      pcm48Stereo = Buffer.from(this.inputCodec.decode(opusPacket));
    } catch (error) {
      this.log('voice', 'Failed to decode Opus packet', error);
      return;
    }

    if (pcm48Stereo.length === 0) return;

    const pcm16Mono = discordPcm48StereoToGemini16Mono(pcm48Stereo);
    if (pcm16Mono.length === 0) return;

    const queue = this.ensureSpeakerQueue(userId);
    const chunk = this.normalizeFrameLength(pcm16Mono);
    queue.push(chunk);
    if (queue.length > 50) {
      queue.splice(0, queue.length - 50);
    }
  }

  normalizeFrameLength(pcm16Mono) {
    if (pcm16Mono.length === GEMINI_MONO_FRAME_BYTES) {
      return pcm16Mono;
    }

    if (pcm16Mono.length > GEMINI_MONO_FRAME_BYTES) {
      return pcm16Mono.subarray(0, GEMINI_MONO_FRAME_BYTES);
    }

    const out = Buffer.alloc(GEMINI_MONO_FRAME_BYTES);
    pcm16Mono.copy(out, 0, 0, pcm16Mono.length);
    return out;
  }

  collectMixedFrame() {
    const frames = [];
    const speakerIds = [];

    for (const [userId, queue] of this.speakerQueues) {
      const chunk = queue.shift();
      if (!chunk) {
        if (!this.speakerStreams.has(userId)) {
          this.speakerQueues.delete(userId);
        }
        continue;
      }

      frames.push(chunk);
      speakerIds.push(userId);

      if (queue.length === 0 && !this.speakerStreams.has(userId)) {
        this.speakerQueues.delete(userId);
      }
    }

    if (frames.length === 0) return null;

    return {
      pcm16Mono: mixMonoPcmFrames(frames),
      speakerIds,
    };
  }

  hasBufferedAudio() {
    for (const queue of this.speakerQueues.values()) {
      if (queue.length > 0) return true;
    }
    return false;
  }

  hasActiveStreams() {
    return this.speakerStreams.size > 0;
  }
}
