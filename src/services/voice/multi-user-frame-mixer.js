import { EndBehaviorType } from '@discordjs/voice';

import {
  GEMINI_MONO_FRAME_BYTES,
  discordPcm48StereoToGemini16Mono,
  mixMonoPcmFrames,
} from '../audio/pcm.js';

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
   *   queueCapFrames?: number,
   *   shouldAcceptUser: (userId: string) => boolean,
   *   log: (scope: string, ...args: any[]) => void,
   *   guildId: string,
   * }} options
   */
  constructor({
    receiver,
    inputCodec,
    speechEndMs,
    queueCapFrames = 50,
    shouldAcceptUser,
    log,
    guildId,
  }) {
    this.receiver = receiver;
    this.inputCodec = inputCodec;
    this.speechEndMs = speechEndMs;
    this.queueCapFrames = queueCapFrames;
    this.shouldAcceptUser = shouldAcceptUser;
    this.log = log;
    this.guildId = guildId;

    /** @type {Map<string, import('node:stream').Readable>} */
    this.speakerStreams = new Map();
    /** @type {Map<string, Buffer[]>} */
    this.speakerQueues = new Map();
    /** @type {Map<string, number>} */
    this.droppedFrameCounts = new Map();

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
      } catch (error) {
        this.log('voice', 'Failed to destroy speaker stream during mixer stop', error);
      }
    }

    this.speakerStreams.clear();
    this.speakerQueues.clear();
    this.droppedFrameCounts.clear();
  }

  reset() {
    this.stop();
    this.start();
  }

  onSpeakingStart(userId) {
    if (!this.receiver?.speaking) {
      this.log('voice', `Receiver not ready; dropping speaking event for ${userId}`);
      return;
    }

    if (!this.shouldAcceptUser(userId)) return;
    this.log('voice', `Detected speech from ${userId}`);
    this.ensureSpeakerSubscription(userId);
  }

  ensureSpeakerSubscription(userId) {
    if (this.speakerStreams.has(userId)) return;

    let opusStream;
    try {
      opusStream = this.receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: this.speechEndMs,
        },
      });
    } catch (error) {
      this.log('voice', `Failed subscribe for speaker=${userId} guild=${this.guildId}`, error);
      this.cleanupSpeaker(userId);
      return;
    }

    this.speakerStreams.set(userId, opusStream);
    this.ensureSpeakerQueue(userId);

    opusStream.on('data', (opusPacket) => {
      if (!Buffer.isBuffer(opusPacket)) {
        this.log('voice', `Dropped non-buffer opus payload from ${userId}`, typeof opusPacket);
        return;
      }
      if (opusPacket.length < 2) {
        this.log('voice', `Dropped malformed opus packet from ${userId} (len=${opusPacket.length})`);
        return;
      }
      this.handleIncomingOpusPacket(userId, opusPacket);
    });

    const cleanup = () => {
      this.cleanupSpeaker(userId, opusStream);
    };

    opusStream.once('end', cleanup);
    opusStream.once('close', cleanup);
    opusStream.once('error', (error) => {
      this.log('voice', `Speaker stream error from ${userId}`, error);
      cleanup();
    });
  }

  cleanupSpeaker(userId, opusStream = null) {
    const current = this.speakerStreams.get(userId);
    if (!opusStream || current === opusStream) {
      this.speakerStreams.delete(userId);
    }
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
    if (queue.length > this.queueCapFrames) {
      const dropped = queue.length - this.queueCapFrames;
      queue.splice(0, dropped);
      const droppedTotal = (this.droppedFrameCounts.get(userId) || 0) + dropped;
      this.droppedFrameCounts.set(userId, droppedTotal);
      this.log(
        'voice',
        `Dropped ${dropped} frames for ${userId} due to queue cap=${this.queueCapFrames} (total=${droppedTotal})`,
      );
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
      if (queue.length === 0) {
        if (!this.speakerStreams.has(userId)) {
          this.speakerQueues.delete(userId);
          this.droppedFrameCounts.delete(userId);
        }
        continue;
      }
      
      const chunk = queue.shift();
      if (!chunk) continue;

      frames.push(chunk);
      speakerIds.push(userId);
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
