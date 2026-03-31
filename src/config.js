import 'dotenv/config';

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

function getInt(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function getBool(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  return /^true$/i.test(raw);
}

export const config = {
  discordToken: requireEnv('DISCORD_TOKEN'),
  geminiApiKey: requireEnv('GEMINI_API_KEY', ['GOOGLE_API_KEY']),
  botPrefix: getString('BOT_PREFIX', '!'),
  model: getString('GEMINI_MODEL', 'gemini-3.1-flash-live-preview'),
  voiceName: getString('GEMINI_VOICE_NAME', 'Kore'),
  systemPrompt: getString(
    'GEMINI_SYSTEM_PROMPT',
    [
      'You are a voice assistant participating in a Discord voice channel.',
      'Keep replies concise and conversational.',
      'When several users are present, answer the most recent active speaker.',
    ].join(' '),
  ),
  discordSpeechEndMs: getInt('DISCORD_SPEECH_END_MS', 350),
  geminiVadPrefixPaddingMs: getInt('GEMINI_VAD_PREFIX_PADDING_MS', 120),
  geminiVadSilenceDurationMs: getInt('GEMINI_VAD_SILENCE_DURATION_MS', 350),
  geminiVadStartSensitivity: getString(
    'GEMINI_VAD_START_SENSITIVITY',
    'START_SENSITIVITY_HIGH',
  ),
  geminiVadEndSensitivity: getString(
    'GEMINI_VAD_END_SENSITIVITY',
    'END_SENSITIVITY_HIGH',
  ),
  enableSessionResumption: getBool('ENABLE_SESSION_RESUMPTION', false),
  localBargeInRmsThreshold: getInt('LOCAL_BARGE_IN_RMS_THRESHOLD', 1700),
  localBargeInConsecutiveFrames: getInt('LOCAL_BARGE_IN_CONSECUTIVE_FRAMES', 3),
  localBargeInPreRollMs: getInt('LOCAL_BARGE_IN_PREROLL_MS', 240),
  localBargeInMinForwardMs: getInt('LOCAL_BARGE_IN_MIN_FORWARD_MS', 450),
  serverInterruptFallbackMs: getInt('SERVER_INTERRUPT_FALLBACK_MS', 1200),
};
