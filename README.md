# Discord ↔ Gemini Live voice bot

A Node.js Discord bot that joins a voice channel, streams user speech to Gemini Live, and plays Gemini's streaming audio replies back into the same channel

## What It Does

- Slash commands `/join`, `/leave`, and `/reset`
- Per-guild bridge session management, with one bridge per server
- Multi-user mixing so several people can talk to the bot at the same time
- Discord Opus receive -> PCM decode -> Gemini Live audio streaming
- Gemini Live PCM audio -> Opus encode -> Discord playback
- Tunable low-latency server-side VAD
- Local barge-in gating so background noise does not interrupt playback
- Pre-roll buffering so the start of a real interruption is preserved
- Optional root-level `gem_sp.md` support for the Gemini system prompt
- Automatic slash-command deployment on startup when the command JSON changes
- Bounded reconnect behavior on recoverable Gemini socket closes

## Project Layout

```text
src/
  app/
    commands.js       slash command definitions
    deploy/           application command sync
    events/           Discord event registration
    lifecycle/        process signals and graceful shutdown
  commands/           join/leave/reset handlers and command router
  config/             environment parsing and defaults
  services/
    audio/            PCM conversion, frame sizing, RMS, and mixing helpers
    bridge/           Discord-Gemini bridge orchestration and turn state
    gemini/           Gemini Live session lifecycle and reconnect handling
    voice/            receive mixer, playback queue, and voice lifecycle
  utils/              Discord messaging and preflight checks
  index.js            startup/bootstrap
```

## Setup

```bash
cp .env.example .env
npm install
npm run start
```

On the first successful startup, the bot syncs `/join`, `/leave`, and `/reset` automatically.

## Discord Permissions

The bot needs `View Channel`, `Connect`, and `Speak` in any voice channel it joins. Stage channels also need `Request to Speak`.

## System Prompt Loading

If a file named `gem_sp.md` exists next to `package.json`, its contents are used as the Gemini system prompt. If not, the bot falls back to `GEMINI_SYSTEM_PROMPT`, then the built-in default prompt.

At startup the bot logs which prompt source it is using.

## Environment Variables (`.env`)

This project reads config from `src/config/index.js`.

### Required

- `DISCORD_TOKEN` - Discord bot token used for `client.login(...)`.
- `GEMINI_API_KEY` - API key for `@google/genai`.
- `GOOGLE_API_KEY` is also accepted as a fallback name.

### Optional

| Variable | Default | Notes |
|---|---:|---|
| `GEMINI_MODEL` | `gemini-3.1-flash-live-preview` | Gemini Live model passed to `ai.live.connect(...)`. |
| `GEMINI_VOICE_NAME` | `Pulcherrima` | Voice used for Gemini speech output. |
| `GEMINI_SYSTEM_PROMPT` | built-in prompt | Fallback system prompt when `gem_sp.md` is absent. |
| `ENABLE_SESSION_RESUMPTION` | `false` | Enables Gemini session resumption handles across reconnects. |
| `SUPPRESS_ROUTINE_ACTION_LOGS` | `false` | Suppresses routine action logs (for example STT/TTS chatter and preflight diagnostics) while keeping warnings, errors, and important lifecycle events. |
| `DISCORD_SPEECH_END_MS` | `350` | Silence timeout for Discord receive streams. Lower values end streams faster; higher values tolerate longer pauses. |
| `GEMINI_VAD_PREFIX_PADDING_MS` | `120` | Server VAD pre-roll retained before detected speech starts. |
| `GEMINI_VAD_SILENCE_DURATION_MS` | `350` | Server VAD silence duration before Gemini ends speech input. |
| `GEMINI_VAD_START_SENSITIVITY` | `START_SENSITIVITY_HIGH` | Gemini start-of-speech sensitivity. |
| `GEMINI_VAD_END_SENSITIVITY` | `END_SENSITIVITY_HIGH` | Gemini end-of-speech sensitivity. |
| `LOCAL_BARGE_IN_RMS_THRESHOLD` | `1700` | Loudness threshold used before mixed live audio may interrupt Gemini. |
| `LOCAL_BARGE_IN_CONSECUTIVE_FRAMES` | `3` | Consecutive 20 ms frames required before interruption is accepted. |
| `LOCAL_BARGE_IN_PREROLL_MS` | `240` | Buffered live audio kept before a qualified interruption. |
| `LOCAL_BARGE_IN_MIN_FORWARD_MS` | `450` | Minimum live-audio forward window after interruption starts. |
| `SERVER_INTERRUPT_FALLBACK_MS` | `1200` | Releases the local interruption gate if Gemini's interruption acknowledgement is delayed. |
| `GEMINI_CONNECT_TIMEOUT_MS` | `8000` | Maximum time allowed for the Gemini Live connection to open. |
| `GEMINI_SETUP_TIMEOUT_MS` | `12000` | Maximum time allowed for Gemini setup to complete after connect. |
| `GEMINI_RECONNECT_MAX_ATTEMPTS` | `6` | Maximum consecutive reconnect attempts before the session enters degraded mode. |
| `GEMINI_RECONNECT_BURST_WINDOW_MS` | `120000` | Time window used to count reconnect bursts. |
| `GEMINI_RECONNECT_STABLE_RESET_MS` | `120000` | Stable period required before reconnect counters reset. |
| `GEMINI_RECONNECT_BASE_DELAY_MS` | `1000` | Base delay used for reconnect backoff. |
| `GEMINI_RECONNECT_MAX_DELAY_MS` | `30000` | Maximum reconnect backoff delay. |
| `MIXER_SPEAKER_QUEUE_CAP_FRAMES` | `50` | Max buffered 20 ms input frames kept per active speaker in the mixer. |
| `PLAYBACK_PACKET_QUEUE_MAX_FRAMES` | `600` | Max buffered outbound Opus frames before oldest playback frames are dropped. |

## Commands

- `/join` - connect the bot to your current voice channel
- `/leave` - disconnect the bot from the current guild's voice channel
- `/reset` - reset the current Gemini Live session or conversation state

## Notes

- This build uses `@discordjs/opus` for Discord playback/input encoding instead of `opusscript`, which avoids the WebAssembly `memory access out of bounds` encoder failure seen in the playback path.
- The resampling and mixing path is intentionally simple and lightweight. It is suitable for a starter bot, not a studio-grade DSP chain.
- Gemini receives one mixed audio stream, not isolated speaker tracks, so speaker attribution in transcription is best-effort rather than guaranteed.
- The bot auto-syncs application commands on startup and caches the last deployed command hash in `.cache/discord-commands.sha256`.
