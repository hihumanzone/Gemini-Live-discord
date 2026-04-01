import { createAudioPlayer, createAudioResource, StreamType } from '@discordjs/voice';
import { Readable } from 'node:stream';
import {
  DISCORD_FRAME_MS,
  DISCORD_PLAYBACK_FRAME_BYTES,
  gemini24MonoToDiscord48Stereo,
} from '../audio/pcm.js';

export class DiscordOpusPlaybackQueue {
  constructor({
    getConnection,
    isVoiceReady,
    outputCodec,
    maxPacketQueueFrames = 600,
    log,
  }) {
    this.getConnection = getConnection;
    this.isVoiceReady = isVoiceReady;
    this.outputCodec = outputCodec;
    this.maxPacketQueueFrames = maxPacketQueueFrames;
    this.log = log;

    this.pendingGemini24 = Buffer.alloc(0);
    this.pendingDiscord48 = Buffer.alloc(0);
    this.outboundOpusPackets = [];
    
    this.player = createAudioPlayer();
    this.currentStream = null;
    this.isConnected = false;
    
    // Manage stream logic
    this.player.on('error', error => {
      this.log('voice', 'AudioPlayer error:', error);
      this.interrupt();
    });

    this.playbackActive = false;
  }

  start() {
    const connection = this.getConnection();
    if (connection && !this.isConnected) {
      connection.subscribe(this.player);
      this.isConnected = true;
    }
    
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
    this.player.stop();
    this.isConnected = false;
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

    if (this.outboundOpusPackets.length > this.maxPacketQueueFrames) {
      const dropped = this.outboundOpusPackets.length - this.maxPacketQueueFrames;
      this.outboundOpusPackets.splice(0, dropped);
      this.log(
        'voice',
        `Playback queue overflow; dropped ${dropped} opus frames (cap=${this.maxPacketQueueFrames})`,
      );
    }
  }

  playNextFrame() {
    if (!this.isVoiceReady()) return;

    const packet = this.outboundOpusPackets.shift();
    if (!packet) {
      if (this.currentStream) {
        this.currentStream.push(null);
        this.currentStream = null;
      }
      this.playbackActive = false;
      return;
    }

    try {
      if (!this.playbackActive || !this.currentStream) {
        this.currentStream = new Readable({
          read() {}
        });
        const resource = createAudioResource(this.currentStream, { inputType: StreamType.Opus });
        this.player.play(resource);
        this.playbackActive = true;
      }

      this.currentStream.push(packet);
    } catch (error) {
      this.log('voice', 'Failed to push Opus packet to sequence', error);
      this.playbackActive = false;
      if (this.currentStream) {
        this.currentStream.push(null);
        this.currentStream = null;
      }
    }
  }

  interrupt() {
    this.outboundOpusPackets.length = 0;
    this.pendingGemini24 = Buffer.alloc(0);
    this.pendingDiscord48 = Buffer.alloc(0);
    
    this.player.stop();
    if (this.currentStream) {
      this.currentStream.push(null);
      this.currentStream = null;
    }
    
    this.playbackActive = false;
  }
}

