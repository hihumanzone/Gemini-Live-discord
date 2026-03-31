# Discord ↔ Gemini Live voice bot

A Node.js Discord bot that joins a voice channel, streams user speech to Gemini Live, and plays Gemini's streaming audio replies back into the same channel.

## Features

- `!join`, `!leave`, `!reset` message commands
- Per-guild bridge session management (one bridge per server)
- Multi-user mixing so several people can talk to the bot at the same time
- Discord Opus receive → PCM decode → Gemini Live audio streaming
- Gemini Live PCM audio → Opus encode → Discord playback
- Tunable low-latency server-side VAD
- Local barge-in gating so tiny background noises do not interrupt playback
- Pre-roll buffering so the start of a real interruption is preserved
- Root-level `gem_sp.md` support for the Gemini system prompt
- Bounded reconnect behavior on recoverable Gemini socket closes

## Project layout

```text
src/
  audio.js    audio conversion, frame sizing, RMS, and PCM mixing helpers
  bridge.js   Discord ↔ Gemini bridge orchestration and reconnect logic
  config.js   environment parsing and defaults
  index.js    Discord client and command handling
  mixer.js    multi-user Discord receive subscriptions and frame mixing
```

## Setup

```bash
cp .env.example .env
npm install
npm run start
```

## System prompt loading

If a file named `gem_sp.md` exists next to `package.json`, its contents are used as the Gemini system prompt. If not, the bot falls back to `GEMINI_SYSTEM_PROMPT`, then the built-in default prompt.

At startup the bot prints which prompt source it is using.

## Environment variables (`.env`)

This project reads config from environment variables in `src/config.js`.

### Required

- `DISCORD_TOKEN` — Discord bot token used for `client.login(...)`.
- `GEMINI_API_KEY` — API key for `@google/genai`.
  - `GOOGLE_API_KEY` is also accepted as a fallback name.

### Optional

| Variable | Default | What it controls |
|---|---:|---|
| `BOT_PREFIX` | `!` | Prefix used for `join`, `leave`, and `reset`. |
| `GEMINI_MODEL` | `gemini-3.1-flash-live-preview` | Gemini Live model passed to `ai.live.connect(...)`. |
| `GEMINI_VOICE_NAME` | `Kore` | Voice used for Gemini speech output. |
| `GEMINI_SYSTEM_PROMPT` | built-in prompt | Fallback system prompt when `gem_sp.md` is absent. |
| `ENABLE_SESSION_RESUMPTION` | `false` | Enables Gemini session resumption handles across reconnects. |
| `DISCORD_SPEECH_END_MS` | `350` | Silence timeout for Discord receive streams. Lower is faster; higher is more tolerant of pauses. |
| `GEMINI_VAD_PREFIX_PADDING_MS` | `120` | Server VAD pre-roll retained before detected speech starts. |
| `GEMINI_VAD_SILENCE_DURATION_MS` | `350` | Server VAD silence duration before Gemini ends speech input. |
| `GEMINI_VAD_START_SENSITIVITY` | `START_SENSITIVITY_HIGH` | Gemini start-of-speech sensitivity. |
| `GEMINI_VAD_END_SENSITIVITY` | `END_SENSITIVITY_HIGH` | Gemini end-of-speech sensitivity. |
| `LOCAL_BARGE_IN_RMS_THRESHOLD` | `1700` | Loudness threshold used before mixed live audio may interrupt Gemini. |
| `LOCAL_BARGE_IN_CONSECUTIVE_FRAMES` | `3` | Consecutive 20 ms frames required before interruption is accepted. |
| `LOCAL_BARGE_IN_PREROLL_MS` | `240` | Buffered live audio kept before a qualified interruption. |
| `LOCAL_BARGE_IN_MIN_FORWARD_MS` | `450` | Minimum live-audio forward window after interruption starts. |
| `SERVER_INTERRUPT_FALLBACK_MS` | `1200` | Releases the local interruption gate if Gemini's interruption acknowledgement is delayed. |

## Commands

- `!join` — join the author's current voice channel
- `!leave` — disconnect from the current guild's voice channel
- `!reset` — reconnect the Gemini Live session for the current guild

`!` is the default prefix; update `BOT_PREFIX` to change it.

## Notes

- This build uses `opusscript` instead of `@discordjs/opus` to avoid the deprecated native install toolchain warnings that come from `@discordjs/opus` transitive dependencies.
- The resampling and mixing path is intentionally simple and lightweight. It is suitable for a starter bot, not a studio-grade DSP chain.
- Gemini receives one mixed audio stream, not isolated speaker tracks, so speaker attribution in transcription is best-effort rather than guaranteed.
