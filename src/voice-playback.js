import {
  DISCORD_FRAME_MS,
  DISCORD_PLAYBACK_FRAME_BYTES,
  gemini24MonoToDiscord48Stereo,
} from './audio.js';

/**
 * Buffers Gemini PCM, converts it to Discord Opus packets, and plays them on a fixed 20 ms tick.
 */
export class DiscordOpusPlaybackQueue {
  /**
   * @param {{
   *   getConnection: () => import('@discordjs/voice').VoiceConnection | null,
   *   isVoiceReady: () => boolean,
   *   outputCodec: any,
   *   log: (scope: string, ...args: any[]) => void,
   * }} options
   */
  constructor({ getConnection, isVoiceReady, outputCodec, log }) {
    this.getConnection = getConnection;
    this.isVoiceReady = isVoiceReady;
    this.outputCodec = outputCodec;
    this.log = log;

    this.pendingGemini24 = Buffer.alloc(0);
    this.pendingDiscord48 = Buffer.alloc(0);
    this.outboundOpusPackets = [];
    this.playbackTicker = null;
    this.playbackActive = false;
  }

  start() {
    if (this.playbackTicker) return;

    this.playbackTicker = setInterval(() => {
      this.playNextFrame();
    }, DISCORD_FRAME_MS);
  }

  stop() {
    if (this.playbackTicker) {
      clearInterval(this.playbackTicker);
      this.playbackTicker = null;
    }

    this.interrupt();
  }

  isActive() {
    return this.playbackActive;
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
        const encodedPacket = this.outputCodec.encode(Buffer.from(frame));
        this.outboundOpusPackets.push(Buffer.from(encodedPacket));
      } catch (error) {
        this.log('voice', 'Failed to encode PCM frame', error);
        this.pendingGemini24 = Buffer.alloc(0);
        this.pendingDiscord48 = Buffer.alloc(0);
        this.outboundOpusPackets.length = 0;
        return;
      }
    }
  }

  playNextFrame() {
    const connection = this.getConnection();
    if (!connection || !this.isVoiceReady()) return;

    const packet = this.outboundOpusPackets.shift();
    if (!packet) {
      this.setSpeaking(connection, false);
      this.playbackActive = false;
      return;
    }

    try {
      if (!this.playbackActive) {
        this.setSpeaking(connection, true);
        this.playbackActive = true;
      }

      connection.playOpusPacket(packet);
    } catch (error) {
      this.log('voice', 'Failed to play Opus packet', error);
      this.setSpeaking(connection, false);
      this.playbackActive = false;
    }
  }

  interrupt() {
    this.outboundOpusPackets.length = 0;
    this.pendingGemini24 = Buffer.alloc(0);
    this.pendingDiscord48 = Buffer.alloc(0);

    const connection = this.getConnection();
    if (connection) {
      this.setSpeaking(connection, false);
    }

    this.playbackActive = false;
  }

  setSpeaking(connection, value) {
    try {
      connection.setSpeaking(value);
    } catch {
      // Best effort only.
    }
  }
}
