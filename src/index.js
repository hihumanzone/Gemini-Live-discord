import {
  Client,
  GatewayIntentBits,
  Partials,
} from 'discord.js';

import { DiscordGeminiVoiceBridge } from './bridge.js';
import { config } from './config.js';
import { registerDiscordBotHandlers } from './discord-bot.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

function logFatal(error, context = {}) {
  const payload = {
    level: 'fatal',
    ts: new Date().toISOString(),
    error: {
      message: error?.message || String(error),
      code: error?.code,
      stack: error?.stack,
    },
    ...context,
  };
  console.error('[startup:fatal]', JSON.stringify(payload));
}

const { gracefulShutdown } = registerDiscordBotHandlers({
  client,
  config,
  BridgeClass: DiscordGeminiVoiceBridge,
  logFatal,
});

async function main() {
  try {
    await client.login(config.discordToken);
  } catch (error) {
    logFatal(error, {
      event: 'startup_login',
      context: 'discord login failed',
      tokenPresent: Boolean(config.discordToken),
    });
    throw error;
  }
}

main().catch(async (error) => {
  logFatal(error, { event: 'startup', context: 'startup failed' });
  await gracefulShutdown('startup_failure', 1);
});
