# Discord ↔ Gemini Live voice bot

A Node.js Discord bot that joins a voice channel, streams user speech to Gemini Live, and plays Gemini's streaming audio replies back into the same channel.

## Features

- `!join`, `!leave`, `!reset` message commands
- per-guild bridge session management
- one active speaker at a time
- Discord Opus receive → PCM decode → Gemini Live audio streaming
- Gemini Live PCM audio → Opus encode → Discord playback
- tunable low-latency server-side VAD
- local barge-in gating so tiny background noises do not interrupt playback
- pre-roll buffering so the start of a real interruption is preserved
- bounded reconnect behavior on recoverable Gemini socket closes

## Project layout

```text
src/
  audio.js    audio conversion and RMS helpers
  bridge.js   Discord ↔ Gemini bridge logic
  config.js   environment parsing and defaults
  index.js    Discord client and command handling
```

## Setup

```bash
cp .env.example .env
npm install
npm run start
```

## Required environment variables

- `DISCORD_TOKEN`
- `GEMINI_API_KEY`

## Commands

- `!join` — join the author's current voice channel
- `!leave` — disconnect from the current guild's voice channel
- `!reset` — reconnect the Gemini Live session for the current guild

## Notes

- This build keeps the requested `@discordjs/opus` import style:
  - `import opusPkg from '@discordjs/opus';`
  - `const { OpusEncoder } = opusPkg;`
- `@discordjs/voice` is pinned to `0.19.2`.
- The resampling path is intentionally simple and lightweight. It is good for a starter bot, not a studio-grade DSP chain.
- The bot forwards only one active speaker at a time.

## Latency tuning

These settings reduce fixed reply delay:

- `DISCORD_SPEECH_END_MS`
- `GEMINI_VAD_PREFIX_PADDING_MS`
- `GEMINI_VAD_SILENCE_DURATION_MS`
- `GEMINI_VAD_START_SENSITIVITY`
- `GEMINI_VAD_END_SENSITIVITY`

## Barge-in tuning

These settings control how easily Gemini can be interrupted while speaking:

- `LOCAL_BARGE_IN_RMS_THRESHOLD`
- `LOCAL_BARGE_IN_CONSECUTIVE_FRAMES`
- `LOCAL_BARGE_IN_PREROLL_MS`
- `LOCAL_BARGE_IN_MIN_FORWARD_MS`
- `SERVER_INTERRUPT_FALLBACK_MS`

If interruption is still too easy, raise `LOCAL_BARGE_IN_RMS_THRESHOLD`.
If the first word of the interruption still gets clipped, raise `LOCAL_BARGE_IN_PREROLL_MS`.
