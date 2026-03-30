# Discord ↔ Gemini Live voice bot

A Node.js Discord bot that joins a voice channel, streams user speech to Gemini Live, and plays Gemini's streaming audio replies back into the same channel.

## Features

- `!join`, `!leave`, `!reset` message commands
- Per-guild bridge session management (one bridge per server)
- One active speaker at a time
- Discord Opus receive → PCM decode → Gemini Live audio streaming
- Gemini Live PCM audio → Opus encode → Discord playback
- Tunable low-latency server-side VAD
- Local barge-in gating so tiny background noises do not interrupt playback
- Pre-roll buffering so the start of a real interruption is preserved
- Bounded reconnect behavior on recoverable Gemini socket closes

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

## Environment variables (`.env`)

This project reads config from environment variables in `src/config.js`.

If `~/instructions.md` exists (in the bot runtime user's home directory), its full contents are used as the Gemini system prompt for every new Live session.

### Required

- `DISCORD_TOKEN` — Discord bot token used for `client.login(...)`.
- `GEMINI_API_KEY` — API key for `@google/genai`.
  - `GOOGLE_API_KEY` is also accepted as a fallback name.

### Optional (all supported keys explained)

> Defaults below are the exact values used by `src/config.js` when a key is omitted.

| Variable | Default | Type | What it controls |
|---|---:|---|---|
| `BOT_PREFIX` | `!` | string | Prefix checked in `messageCreate` before parsing commands (`join`, `leave`, `reset`). |
| `GEMINI_MODEL` | `gemini-3.1-flash-live-preview` | string | Gemini Live model name passed to `ai.live.connect({ model })`. |
| `GEMINI_VOICE_NAME` | `Kore` | string | Voice used for Gemini speech output via `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`. |
| `GEMINI_SYSTEM_PROMPT` | `You are a voice assistant...` | string | Fallback system instruction sent at session setup when `instructions.md` is missing or empty. Keep it short because it is applied to every session. |
| `ENABLE_SESSION_RESUMPTION` | `false` | boolean (`true`/`false`) | Enables Gemini session resumption handles across reconnects. Only the case-insensitive string `true` enables it. |
| `DISCORD_SPEECH_END_MS` | `350` | integer (ms) | Silence timeout for Discord receive streams (`EndBehaviorType.AfterSilence`). Lower = faster turn end, higher = fewer clipped pauses. |
| `GEMINI_VAD_PREFIX_PADDING_MS` | `120` | integer (ms) | Server VAD pre-roll retained before detected speech starts. Helps preserve initial phonemes. |
| `GEMINI_VAD_SILENCE_DURATION_MS` | `350` | integer (ms) | Server VAD silence duration used to decide end-of-speech. Lower = quicker cut-off, higher = more tolerant pauses. |
| `GEMINI_VAD_START_SENSITIVITY` | `START_SENSITIVITY_HIGH` | string enum-like | Start-of-speech sensitivity passed directly to Gemini `automaticActivityDetection.startOfSpeechSensitivity`. |
| `GEMINI_VAD_END_SENSITIVITY` | `END_SENSITIVITY_HIGH` | string enum-like | End-of-speech sensitivity passed directly to Gemini `automaticActivityDetection.endOfSpeechSensitivity`. |
| `LOCAL_BARGE_IN_RMS_THRESHOLD` | `1700` | integer (RMS) | Local loudness threshold for qualifying interruption speech while Gemini is talking. Higher = harder to interrupt. |
| `LOCAL_BARGE_IN_CONSECUTIVE_FRAMES` | `3` | integer (frames) | Number of consecutive 20 ms frames above threshold required before triggering barge-in. |
| `LOCAL_BARGE_IN_PREROLL_MS` | `240` | integer (ms) | Amount of buffered user audio forwarded after barge-in qualifies, preserving the beginning of the interruption. |
| `LOCAL_BARGE_IN_MIN_FORWARD_MS` | `450` | integer (ms) | Minimum time to keep forwarding user audio after local barge-in begins, so turn fragments are not cut too early. |
| `SERVER_INTERRUPT_FALLBACK_MS` | `1200` | integer (ms) | If Gemini interruption ACK is delayed, release the local audio gate after this timeout. Prevents getting stuck muted. |

### Practical tuning guidance

- For **lower latency** replies, usually decrease:
  - `DISCORD_SPEECH_END_MS`
  - `GEMINI_VAD_SILENCE_DURATION_MS`
- To make **interruptions harder**, increase:
  - `LOCAL_BARGE_IN_RMS_THRESHOLD`
  - `LOCAL_BARGE_IN_CONSECUTIVE_FRAMES`
- If the **first syllable is clipped** during interruption, increase:
  - `LOCAL_BARGE_IN_PREROLL_MS`

## Prompt override file

- `~/instructions.md` (home directory, optional) — when present and non-empty, its full contents override `GEMINI_SYSTEM_PROMPT`.
- If the file is missing, empty, or unreadable, the bot falls back to `GEMINI_SYSTEM_PROMPT` (or built-in default text).

## Commands

- `!join` — join the author's current voice channel
- `!leave` — disconnect from the current guild's voice channel
- `!reset` — reconnect the Gemini Live session for the current guild

`!` is the default prefix; update `BOT_PREFIX` to change it.

## Notes

- This build keeps the requested `@discordjs/opus` import style:
  - `import opusPkg from '@discordjs/opus';`
  - `const { OpusEncoder } = opusPkg;`
- `@discordjs/voice` is pinned to `0.19.2`.
- The resampling path is intentionally simple and lightweight. It is good for a starter bot, not a studio-grade DSP chain.
- The bot forwards only one active speaker at a time.
