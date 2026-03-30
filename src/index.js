import {
  Client,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import { getVoiceConnection } from '@discordjs/voice';

import { config } from './config.js';
import { DiscordGeminiVoiceBridge } from './bridge.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

/** @type {Map<string, DiscordGeminiVoiceBridge>} */
const sessions = new Map();

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Commands: ${config.botPrefix}join, ${config.botPrefix}leave, ${config.botPrefix}reset`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(config.botPrefix)) return;

  const [rawCommand] = message.content.slice(config.botPrefix.length).trim().split(/\s+/);
  const command = rawCommand?.toLowerCase();
  if (!command) return;

  switch (command) {
    case 'join':
      await handleJoinCommand(message);
      break;
    case 'leave':
      await handleLeaveCommand(message);
      break;
    case 'reset':
      await handleResetCommand(message);
      break;
    default:
      break;
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  const bridge = sessions.get(oldState.guild.id);
  if (!bridge || !client.user) return;

  const botLeftVoice = oldState.id === client.user.id && oldState.channelId && !newState.channelId;
  if (!botLeftVoice) return;

  sessions.delete(oldState.guild.id);
  await bridge.stop();
});

client.on('error', (error) => {
  console.error('[discord] Client error', error);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  for (const [guildId, bridge] of sessions) {
    sessions.delete(guildId);
    await bridge.stop();
  }
  client.destroy();
  process.exit(0);
});

await client.login(config.discordToken);

async function handleJoinCommand(message) {
  const channel = message.member?.voice?.channel;
  if (!channel) {
    await message.reply('Join a voice channel first.');
    return;
  }

  if (sessions.has(message.guild.id)) {
    await message.reply(
      `I am already connected in this server. Use ${config.botPrefix}reset or ${config.botPrefix}leave first.`,
    );
    return;
  }

  let bridge;
  try {
    bridge = new DiscordGeminiVoiceBridge(channel, client);
    sessions.set(message.guild.id, bridge);
    await bridge.start();
    await message.reply(`Connected to **${channel.name}** and bridged to Gemini Live.`);
  } catch (error) {
    sessions.delete(message.guild.id);

    try {
      await bridge?.stop();
    } catch {
      // Ignore cleanup errors.
    }

    try {
      getVoiceConnection(message.guild.id)?.destroy();
    } catch {
      // Ignore cleanup errors.
    }

    console.error(`[bot:${message.guild.id}] Failed to join`, error);
    await message.reply('Failed to join the voice channel or initialize Gemini Live. Check logs.');
  }
}

async function handleLeaveCommand(message) {
  const bridge = sessions.get(message.guild.id);
  if (!bridge) {
    try {
      getVoiceConnection(message.guild.id)?.destroy();
    } catch {
      // Ignore cleanup errors.
    }
    await message.reply('I am not currently connected in this server.');
    return;
  }

  sessions.delete(message.guild.id);
  await bridge.stop();
  await message.reply('Disconnected.');
}

async function handleResetCommand(message) {
  const bridge = sessions.get(message.guild.id);
  if (!bridge) {
    await message.reply('Nothing to reset.');
    return;
  }

  try {
    bridge.shouldResumeOnReconnect = false;
    bridge.resumeHandle = null;
    await bridge.reconnectGemini();
    await message.reply('Gemini Live session reset.');
  } catch (error) {
    console.error(`[bot:${message.guild.id}] Reset failed`, error);
    await message.reply('Reset failed. Check logs.');
  }
}
