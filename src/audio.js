export const DISCORD_INPUT_SAMPLE_RATE = 48_000;
export const DISCORD_CHANNELS = 2;
export const GEMINI_INPUT_SAMPLE_RATE = 16_000;
export const GEMINI_OUTPUT_SAMPLE_RATE = 24_000;
export const PCM_BYTES_PER_SAMPLE = 2;
export const DISCORD_FRAME_MS = 20;
export const DISCORD_PLAYBACK_FRAME_BYTES = 960 * DISCORD_CHANNELS * PCM_BYTES_PER_SAMPLE;
export const GEMINI_MONO_FRAME_BYTES = (GEMINI_INPUT_SAMPLE_RATE / 1000) * DISCORD_FRAME_MS * PCM_BYTES_PER_SAMPLE;

/**
 * Downmix Discord PCM (48 kHz, stereo, 16-bit LE) to Gemini PCM (16 kHz, mono, 16-bit LE).
 * This performs simple 3:1 decimation and averaging. It is intentionally lightweight.
 *
 * @param {Buffer} pcm48Stereo
 * @returns {Buffer}
 */
export function discordPcm48StereoToGemini16Mono(pcm48Stereo) {
  const bytesPerFrame = DISCORD_CHANNELS * PCM_BYTES_PER_SAMPLE;
  const inputFrames = Math.floor(pcm48Stereo.length / bytesPerFrame);
  const outputFrames = Math.floor(inputFrames / 3);
  const out = Buffer.allocUnsafe(outputFrames * PCM_BYTES_PER_SAMPLE);

  let outOffset = 0;
  for (let i = 0; i < outputFrames; i += 1) {
    const baseFrame = i * 3;
    let acc = 0;

    for (let j = 0; j < 3; j += 1) {
      const byteOffset = (baseFrame + j) * bytesPerFrame;
      const left = pcm48Stereo.readInt16LE(byteOffset);
      const right = pcm48Stereo.readInt16LE(byteOffset + PCM_BYTES_PER_SAMPLE);
      acc += Math.round((left + right) / 2);
    }

    const mono = clamp16Bit(Math.round(acc / 3));
    out.writeInt16LE(mono, outOffset);
    outOffset += PCM_BYTES_PER_SAMPLE;
  }

  return out;
}

/**
 * Convert Gemini PCM (24 kHz, mono, 16-bit LE) to Discord PCM (48 kHz, stereo, 16-bit LE).
 * This duplicates each time sample 2x and writes the same sample to both channels.
 *
 * @param {Buffer} pcm24Mono
 * @returns {Buffer}
 */
export function gemini24MonoToDiscord48Stereo(pcm24Mono) {
  const inputSamples = Math.floor(pcm24Mono.length / PCM_BYTES_PER_SAMPLE);
  const out = Buffer.allocUnsafe(inputSamples * 8);

  let outOffset = 0;
  for (let i = 0; i < inputSamples; i += 1) {
    const sample = pcm24Mono.readInt16LE(i * PCM_BYTES_PER_SAMPLE);

    out.writeInt16LE(sample, outOffset);
    out.writeInt16LE(sample, outOffset + 2);
    out.writeInt16LE(sample, outOffset + 4);
    out.writeInt16LE(sample, outOffset + 6);
    outOffset += 8;
  }

  return out;
}

/**
 * Mix multiple mono PCM frames of equal length into one frame.
 *
 * @param {Buffer[]} frames
 * @returns {Buffer}
 */
export function mixMonoPcmFrames(frames) {
  if (frames.length === 0) return Buffer.alloc(0);
  if (frames.length === 1) return frames[0];

  const maxLength = Math.max(...frames.map((frame) => frame.length));
  const out = Buffer.allocUnsafe(maxLength);

  for (let offset = 0; offset < maxLength; offset += PCM_BYTES_PER_SAMPLE) {
    let sum = 0;
    let contributors = 0;

    for (const frame of frames) {
      if (offset + PCM_BYTES_PER_SAMPLE > frame.length) continue;
      sum += frame.readInt16LE(offset);
      contributors += 1;
    }

    const mixedSample = contributors > 0
      ? clamp16Bit(Math.round(sum / Math.max(1, Math.sqrt(contributors))))
      : 0;
    out.writeInt16LE(mixedSample, offset);
  }

  return out;
}

/**
 * Compute RMS for 16-bit little-endian mono PCM.
 *
 * @param {Buffer} pcm16Mono
 * @returns {number}
 */
export function computeMonoPcmRms(pcm16Mono) {
  const sampleCount = Math.floor(pcm16Mono.length / PCM_BYTES_PER_SAMPLE);
  if (sampleCount === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = pcm16Mono.readInt16LE(i * PCM_BYTES_PER_SAMPLE);
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / sampleCount);
}

/**
 * Keep the newest N chunks in place.
 *
 * @param {Array<unknown>} chunks
 * @param {number} maxChunks
 */
export function trimBufferArray(chunks, maxChunks) {
  while (chunks.length > maxChunks) {
    chunks.shift();
  }
}

/**
 * Approximate duration of mono PCM in milliseconds.
 *
 * @param {Buffer} pcm16Mono
 * @param {number} sampleRate
 * @returns {number}
 */
export function monoPcmDurationMs(pcm16Mono, sampleRate) {
  const samples = Math.floor(pcm16Mono.length / PCM_BYTES_PER_SAMPLE);
  return Math.max(1, Math.round((samples / sampleRate) * 1000));
}

export function clamp16Bit(value) {
  return Math.max(-32768, Math.min(32767, value));
}
