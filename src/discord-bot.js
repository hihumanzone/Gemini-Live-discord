
import {
  destroyVoiceConnection,
  getJoinPreflightFailure,
  safeReply,
} from './discord-utils.js';

/**
 * Registers Discord command/event handlers and owns per-guild bridge sessions.
 *
 * @param {{
 *   client: import('discord.js').Client,
 *   config: import('./config.js').config,
 *   BridgeClass: typeof import('./bridge.js').DiscordGeminiVoiceBridge,
 *   logFatal: (error: Error, context?: Record<string, unknown>) => void,
 * }} options
 */
export function registerDiscordBotHandlers({ client, config, BridgeClass, logFatal }) {
  /** @type {Map<string, import('./bridge.js').DiscordGeminiVoiceBridge>} */
  const sessions = new Map();
  let shuttingDown = false;

  async function stopGuildSession(guildId, reason) {
    const bridge = sessions.get(guildId);
    sessions.delete(guildId);

    if (!bridge) {
      destroyVoiceConnection(guildId, reason);
      return;
    }

    try {
      await bridge.stop();
    } catch (error) {
      console.error(`[bot:${guildId}] Failed to stop bridge during ${reason}`, error);
    } finally {
      destroyVoiceConnection(guildId, reason);
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
      for (const guildId of [...sessions.keys()]) {
        await stopGuildSession(guildId, `shutdown:${reason}`);
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

  async function handleJoinCommand(message) {
    const guildId = message.guild.id;

    try {
      const channel = message.member?.voice?.channel;
      if (!channel) {
        await safeReply(message, 'Join a voice channel first.');
        return;
      }

      if (sessions.has(guildId)) {
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

      const bridge = new BridgeClass(channel, client);
      sessions.set(guildId, bridge);

      try {
        await bridge.start();
        await safeReply(message, `Connected to **${channel.name}** and bridged to Gemini Live.`);
      } catch (error) {
        console.error(`[bot:${guildId}] Failed to join`, error);
        await stopGuildSession(guildId, 'join_failure');
        await safeReply(message, 'Failed to join the voice channel or initialize Gemini Live. Check logs.');
      }
    } catch (error) {
      console.error(`[bot:${guildId}] Unhandled join command error`, error);
      await stopGuildSession(guildId, 'join_unhandled_failure');
      await safeReply(message, 'Join command failed unexpectedly. Check logs.');
    }
  }

  async function handleLeaveCommand(message) {
    const guildId = message.guild.id;

    try {
      if (!sessions.has(guildId)) {
        destroyVoiceConnection(guildId, 'leave_without_session');
        await safeReply(message, 'I am not currently connected in this server.');
        return;
      }

      await stopGuildSession(guildId, 'command_leave');
      await safeReply(message, 'Disconnected.');
    } catch (error) {
      console.error(`[bot:${guildId}] Leave failed`, error);
      await safeReply(message, 'Leave command failed. Check logs.');
    }
  }

  async function handleResetCommand(message) {
    const guildId = message.guild.id;

    try {
      const bridge = sessions.get(guildId);
      if (!bridge) {
        await safeReply(message, 'Nothing to reset.');
        return;
      }

      await bridge.resetGeminiSession();
      await safeReply(message, 'Gemini Live session reset.');
    } catch (error) {
      console.error(`[bot:${guildId}] Reset failed`, error);
      await safeReply(message, 'Reset failed. Check logs.');
    }
  }

  async function routeCommand(message) {
    if (message.author.bot || !message.guild) return;
    if (!message.content.startsWith(config.botPrefix)) return;

    const [rawCommand] = message.content.slice(config.botPrefix.length).trim().split(/\s+/);
    const command = rawCommand?.toLowerCase();
    if (!command) return;

    if (command === 'join') {
      await handleJoinCommand(message);
      return;
    }

    if (command === 'leave') {
      await handleLeaveCommand(message);
      return;
    }

    if (command === 'reset') {
      await handleResetCommand(message);
    }
  }

  registerProcessHandlers();

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
      await routeCommand(message);
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

      await stopGuildSession(oldState.guild.id, 'voice_state_disconnect');
    } catch (error) {
      console.error('[discord] voiceStateUpdate handler error', error);
    }
  });

  client.on('channelDelete', async (channel) => {
    try {
      if (!channel.isVoiceBased?.()) return;

      const bridge = sessions.get(channel.guild.id);
      if (!bridge || bridge.channelId !== channel.id) return;

      await stopGuildSession(channel.guild.id, 'channel_deleted');
    } catch (error) {
      console.error('[discord] channelDelete handler error', error);
    }
  });

  client.on('guildDelete', async (guild) => {
    try {
      await stopGuildSession(guild.id, 'guild_removed');
    } catch (error) {
      console.error('[discord] guildDelete handler error', error);
    }
  });

  client.on('error', (error) => {
    console.error('[discord] Client error', error);
  });

  return {
    gracefulShutdown,
    sessions,
  };
}
