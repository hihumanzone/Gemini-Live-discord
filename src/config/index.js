import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function requireEnv(name, fallbackNames = []) {
  const candidates = [name, ...fallbackNames];
  for (const key of candidates) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }

  const suffix = fallbackNames.length ? ` (or ${fallbackNames.join(', ')})` : '';
  throw new Error(`Missing ${name}${suffix} in environment.`);
}

function getString(name, defaultValue) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : defaultValue;
}

function getBool(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  return /^true$/i.test(raw);
}

function parseInteger(name, raw) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    console.warn(`[config] Invalid integer for ${name}: "${raw}"`);
    return null;
  }
  return parsed;
}

function getIntInRange(name, defaultValue, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;

  const parsed = parseInteger(name, raw);
  if (parsed === null || parsed < min || parsed > max) {
    console.warn(
      `[config] Using default ${name}=${defaultValue} because value "${raw}" is outside [${min}, ${max}]`,
    );
    return defaultValue;
  }

  return parsed;
}

function getPositiveInt(name, defaultValue, max = Number.MAX_SAFE_INTEGER) {
  return getIntInRange(name, defaultValue, 1, max);
}

function getProjectRootDir() {
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), '..', '..');
}

function loadSystemPromptFromFile(projectRootDir) {
  const promptFilePath = path.join(projectRootDir, 'gem_sp.md');
  if (!fs.existsSync(promptFilePath)) {
    return null;
  }

  const text = fs.readFileSync(promptFilePath, 'utf8').trim();
  if (!text) {
    return null;
  }

  return {
    text,
    path: promptFilePath,
  };
}

const defaultSystemPrompt = [
  'You are a casual friend chatting naturally with one or more users in this Discord voice channel.',
  'Keep the conversation warm, expressive, and relaxed to maintain a natural social flow.',
].join(' ');

const projectRootDir = getProjectRootDir();
const fileSystemPrompt = loadSystemPromptFromFile(projectRootDir);

export const config = {
  discordToken: requireEnv('DISCORD_TOKEN'),
  geminiApiKey: requireEnv('GEMINI_API_KEY', ['GOOGLE_API_KEY']),
  botPrefix: getString('BOT_PREFIX', '!'),
  model: getString('GEMINI_MODEL', 'gemini-3.1-flash-live-preview'),
  voiceName: getString('GEMINI_VOICE_NAME', 'Pulcherrima'),
  systemPrompt: fileSystemPrompt?.text ?? getString('GEMINI_SYSTEM_PROMPT', defaultSystemPrompt),
  systemPromptSource: fileSystemPrompt ? `file:${fileSystemPrompt.path}` : 'env_or_default',
  // Accepted range: 100-5000 ms.
  discordSpeechEndMs: getIntInRange('DISCORD_SPEECH_END_MS', 350, 100, 5_000),
  // Accepted range: 0-2000 ms.
  geminiVadPrefixPaddingMs: getIntInRange('GEMINI_VAD_PREFIX_PADDING_MS', 120, 0, 2_000),
  // Accepted range: 100-8000 ms.
  geminiVadSilenceDurationMs: getIntInRange('GEMINI_VAD_SILENCE_DURATION_MS', 350, 100, 8_000),
  geminiVadStartSensitivity: getString(
    'GEMINI_VAD_START_SENSITIVITY',
    'START_SENSITIVITY_HIGH',
  ),
  geminiVadEndSensitivity: getString(
    'GEMINI_VAD_END_SENSITIVITY',
    'END_SENSITIVITY_HIGH',
  ),
  enableSessionResumption: getBool('ENABLE_SESSION_RESUMPTION', false),
  // Accepted range: 100-12000 RMS.
  localBargeInRmsThreshold: getIntInRange('LOCAL_BARGE_IN_RMS_THRESHOLD', 1700, 100, 12_000),
  // Accepted range: >=1 frame.
  localBargeInConsecutiveFrames: getPositiveInt('LOCAL_BARGE_IN_CONSECUTIVE_FRAMES', 3, 120),
  // Accepted range: 0-5000 ms.
  localBargeInPreRollMs: getIntInRange('LOCAL_BARGE_IN_PREROLL_MS', 240, 0, 5_000),
  // Accepted range: 0-10000 ms.
  localBargeInMinForwardMs: getIntInRange('LOCAL_BARGE_IN_MIN_FORWARD_MS', 450, 0, 10_000),
  // Accepted range: 100-15000 ms.
  serverInterruptFallbackMs: getIntInRange('SERVER_INTERRUPT_FALLBACK_MS', 1200, 100, 15_000),
  // Accepted range: 1000-30000 ms.
  geminiConnectTimeoutMs: getIntInRange('GEMINI_CONNECT_TIMEOUT_MS', 8_000, 1_000, 30_000),
  // Accepted range: 1000-45000 ms.
  geminiSetupTimeoutMs: getIntInRange('GEMINI_SETUP_TIMEOUT_MS', 12_000, 1_000, 45_000),
  // Accepted range: 1-20 attempts.
  geminiReconnectMaxAttempts: getPositiveInt('GEMINI_RECONNECT_MAX_ATTEMPTS', 6, 20),
  // Accepted range: 1000-900000 ms.
  geminiReconnectBurstWindowMs: getIntInRange(
    'GEMINI_RECONNECT_BURST_WINDOW_MS',
    120_000,
    1_000,
    900_000,
  ),
  // Accepted range: 1000-900000 ms.
  geminiReconnectStableResetMs: getIntInRange(
    'GEMINI_RECONNECT_STABLE_RESET_MS',
    120_000,
    1_000,
    900_000,
  ),
  // Accepted range: 100-10000 ms.
  geminiReconnectBaseDelayMs: getIntInRange('GEMINI_RECONNECT_BASE_DELAY_MS', 1_000, 100, 10_000),
  // Accepted range: 1000-120000 ms.
  geminiReconnectMaxDelayMs: getIntInRange('GEMINI_RECONNECT_MAX_DELAY_MS', 30_000, 1_000, 120_000),
  // Accepted range: 10-500 frames.
  mixerSpeakerQueueCapFrames: getIntInRange('MIXER_SPEAKER_QUEUE_CAP_FRAMES', 50, 10, 500),
  // Accepted range: 1-30 seconds worth of 20ms frames.
  playbackPacketQueueMaxFrames: getIntInRange('PLAYBACK_PACKET_QUEUE_MAX_FRAMES', 600, 50, 1_500),
  projectRootDir,
  systemPromptFilePath: fileSystemPrompt?.path ?? null,
};
