import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
} from 'discord.js';
import { getVoiceConnection } from '@discordjs/voice';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

/** @type {Map<string, import('./bridge.js').DiscordGeminiVoiceBridge>} */
const sessions = new Map();

let config;
let DiscordGeminiVoiceBridge;
let shuttingDown = false;

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

async function safeChannelSend(message, content) {
  if (!message?.channel?.isTextBased?.()) return false;

  try {
    await message.channel.send(content);
    return true;
  } catch (fallbackError) {
    console.warn('[reply] channel.send fallback failed', {
      guildId: message.guild?.id,
      channelId: message.channel?.id,
      messageId: message.id,
      errorCode: fallbackError?.code,
      status: fallbackError?.status,
    });
    return false;
  }
}

async function safeReply(message, content) {
  try {
    await message.reply(content);
    return true;
  } catch (error) {
    console.warn('[reply] message.reply failed', {
      guildId: message.guild?.id,
      channelId: message.channel?.id,
      messageId: message.id,
      errorCode: error?.code,
      status: error?.status,
    });

    const fallbackSent = await safeChannelSend(message, content);
    if (!fallbackSent) {
      console.error('[reply] primary and fallback send failed', {
        guildId: message.guild?.id,
        channelId: message.channel?.id,
        messageId: message.id,
      });
    }

    return fallbackSent;
  }
}

async function gracefulShutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  const timestamp = new Date().toISOString();
  console.log(`[shutdown] starting reason=${reason} ts=${timestamp}`);

  const hardTimeout = setTimeout(() => {
    console.error(`[shutdown] hard timeout reached reason=${reason} ts=${new Date().toISOString()}`);
    process.exit(1);
  }, 10_000);

  try {
    for (const [guildId, bridge] of sessions) {
      sessions.delete(guildId);
      try {
        await bridge.stop();
      } catch (error) {
        console.error(`[shutdown] bridge stop failed guild=${guildId}`, error);
      }
    }

    try {
      client.destroy();
    } catch (error) {
      console.error('[shutdown] client destroy failed', error);
    }
  } finally {
    clearTimeout(hardTimeout);
    process.exit(exitCode);
  }
}

function registerProcessHandlers() {
  process.on('SIGINT', async () => {
    await gracefulShutdown('SIGINT', 0);
  });

  process.on('SIGTERM', async () => {
    await gracefulShutdown('SIGTERM', 0);
  });

  process.on('unhandledRejection', async (reason) => {
    logFatal(reason instanceof Error ? reason : new Error(String(reason)), {
      event: 'unhandledRejection',
    });
    await gracefulShutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', async (error) => {
    logFatal(error, { event: 'uncaughtException' });
    await gracefulShutdown('uncaughtException', 1);
  });
}

function getJoinPreflightFailure(message, channel) {
  const botMember = message.guild?.members?.me;
  if (!botMember) {
    return 'I cannot resolve my guild membership state yet. Please try again in a few seconds.';
  }

  const permissions = channel.permissionsFor(botMember);
  const requiredPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
  ];

  if (PermissionFlagsBits.UseVAD) {
    requiredPermissions.push(PermissionFlagsBits.UseVAD);
  }

  if (channel.type === ChannelType.StageVoice) {
    requiredPermissions.push(PermissionFlagsBits.RequestToSpeak);
  }

  const missing = permissions
    ? requiredPermissions.filter((permission) => !permissions.has(permission))
    : requiredPermissions;

  console.log('[join:preflight]', {
    guildId: message.guild.id,
    channelId: channel.id,
    channelType: channel.type,
    full: channel.full,
    joinable: channel.joinable,
    permissionsBitfield: permissions?.bitfield?.toString?.() ?? 'none',
    requiredPermissions: requiredPermissions.map((value) => value.toString()),
    missingPermissions: missing.map((value) => value.toString()),
    memberCount: channel.members?.size,
    userLimit: channel.userLimit,
  });

  if (!channel.joinable) {
    return 'I cannot join that voice channel right now. Check channel permissions and voice region availability.';
  }

  if (channel.full) {
    return 'That voice channel is full right now. Please free up a slot and try again.';
  }

  if (missing.length > 0) {
    return 'I am missing required permissions to join/speak in that channel.';
  }

  if (channel.type === ChannelType.StageVoice && !permissions?.has(PermissionFlagsBits.RequestToSpeak)) {
    return 'I need permission to request to speak in that stage channel.';
  }

  return null;
}

async function handleJoinCommand(message) {
  try {
    const channel = message.member?.voice?.channel;
    if (!channel) {
      await safeReply(message, 'Join a voice channel first.');
      return;
    }

    if (sessions.has(message.guild.id)) {
      await safeReply(
        message,
        `I am already connected in this server. Use ${config.botPrefix}reset or ${config.botPrefix}leave first.`,
      );
      return;
    }

    const preflightFailure = getJoinPreflightFailure(message, channel);
    if (preflightFailure) {
      await safeReply(message, preflightFailure);
      return;
    }

    let bridge;
    try {
      bridge = new DiscordGeminiVoiceBridge(channel, client);
      sessions.set(message.guild.id, bridge);
      await bridge.start();
      await safeReply(message, `Connected to **${channel.name}** and bridged to Gemini Live.`);
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
      await safeReply(message, 'Failed to join the voice channel or initialize Gemini Live. Check logs.');
    }
  } catch (error) {
    console.error(`[bot:${message.guild.id}] Unhandled join command error`, error);
    await safeReply(message, 'Join command failed unexpectedly. Check logs.');
  }
}

async function handleLeaveCommand(message) {
  try {
    const bridge = sessions.get(message.guild.id);
    if (!bridge) {
      try {
        getVoiceConnection(message.guild.id)?.destroy();
      } catch {
        // Ignore cleanup errors.
      }
      await safeReply(message, 'I am not currently connected in this server.');
      return;
    }

    sessions.delete(message.guild.id);
    await bridge.stop();
    await safeReply(message, 'Disconnected.');
  } catch (error) {
    console.error(`[bot:${message.guild.id}] Leave failed`, error);
    await safeReply(message, 'Leave command failed. Check logs.');
  }
}

async function handleResetCommand(message) {
  try {
    const bridge = sessions.get(message.guild.id);
    if (!bridge) {
      await safeReply(message, 'Nothing to reset.');
      return;
    }

    bridge.shouldResumeOnReconnect = false;
    bridge.resumeHandle = null;
    await bridge.reconnectGemini({ manual: true });
    await safeReply(message, 'Gemini Live session reset.');
  } catch (error) {
    console.error(`[bot:${message.guild.id}] Reset failed`, error);
    await safeReply(message, 'Reset failed. Check logs.');
  }
}

async function main() {
  registerProcessHandlers();

  ({ config } = await import('./config.js'));
  ({ DiscordGeminiVoiceBridge } = await import('./bridge.js'));

  client.once('clientReady', () => {
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`Commands: ${config.botPrefix}join, ${config.botPrefix}leave, ${config.botPrefix}reset`);
    if (config.systemPromptFilePath) {
      console.log(`[config] Using Gemini system prompt from ${config.systemPromptFilePath}`);
    } else {
      console.log(`[config] Using Gemini system prompt from ${config.systemPromptSource}`);
    }
  });

  client.on('messageCreate', async (message) => {
    try {
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
    } catch (error) {
      console.error('[discord] messageCreate handler error', error);
    }
  });

  client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
      const bridge = sessions.get(oldState.guild.id);
      if (!bridge || !client.user) return;

      const botLeftVoice = oldState.id === client.user.id && oldState.channelId && !newState.channelId;
      if (!botLeftVoice) return;

      sessions.delete(oldState.guild.id);
      await bridge.stop();
    } catch (error) {
      console.error('[discord] voiceStateUpdate handler error', error);
    }
  });

  client.on('error', (error) => {
    console.error('[discord] Client error', error);
  });

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
