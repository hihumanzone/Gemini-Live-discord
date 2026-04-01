import {
  GEMINI_INPUT_SAMPLE_RATE,
  computeMonoPcmRms,
  monoPcmDurationMs,
} from '../audio/pcm.js';

export class LocalBargeInController {
  constructor({ rmsThreshold, consecutiveFrames, preRollMs, log }) {
    this.rmsThreshold = rmsThreshold;
    this.consecutiveFrames = consecutiveFrames;
    this.preRollMs = preRollMs;
    this.log = log;

    this.bargeInMode = false;
    this.aboveThresholdFrames = 0;
    this.preRollChunks = [];
    this.headIndex = 0;
  }

  reset() {
    this.bargeInMode = false;
    this.aboveThresholdFrames = 0;
    this.preRollChunks = [];
    this.headIndex = 0;
  }

  armIfPlaybackStartedBeforeTurn(playbackActive, turnSentAudio) {
    if (!turnSentAudio && playbackActive) {
      this.bargeInMode = true;
    }
  }

  clearDetectionWindow() {
    this.bargeInMode = false;
    this.aboveThresholdFrames = 0;
    this.preRollChunks = [];
    this.headIndex = 0;
  }

  evaluateFrame(pcm16Mono, speakerIds) {
    if (!this.bargeInMode) {
      return { action: 'pass' };
    }

    const chunkDurationMs = monoPcmDurationMs(pcm16Mono, GEMINI_INPUT_SAMPLE_RATE);
    const maxPreRollChunks = Math.max(1, Math.ceil(this.preRollMs / chunkDurationMs));

    // Circular buffer logic instead of array.shift()
    if (this.preRollChunks.length < maxPreRollChunks) {
      this.preRollChunks.push({ pcm16Mono, speakerIds });
    } else {
      this.preRollChunks[this.headIndex] = { pcm16Mono, speakerIds };
      this.headIndex = (this.headIndex + 1) % maxPreRollChunks;
    }

    const rms = computeMonoPcmRms(pcm16Mono);
    this.aboveThresholdFrames =
      rms >= this.rmsThreshold
        ? this.aboveThresholdFrames + 1
        : 0;

    if (this.aboveThresholdFrames < this.consecutiveFrames) {
      return { action: 'hold' };
    }

    // Unroll circular buffer sequentially
    const sequentialChunks = [];
    for (let i = 0; i < this.preRollChunks.length; i++) {
      sequentialChunks.push(this.preRollChunks[(this.headIndex + i) % this.preRollChunks.length]);
    }

    const frames = this.aboveThresholdFrames;
    this.clearDetectionWindow();

    this.log(
      'voice',
      `Qualified barge-in from ${formatSpeakerIds(speakerIds)} (rms=${Math.round(rms)}, frames=${frames})`,
    );

    return {
      action: 'barge_in',
      preRollChunks: sequentialChunks,
      rms,
      frames,
    };
  }
}

function formatSpeakerIds(speakerIds) {
  const uniqueSpeakerIds = [...new Set(speakerIds)].filter(Boolean);
  if (uniqueSpeakerIds.length === 0) return 'unknown';
  return uniqueSpeakerIds.join(' + ');
}
