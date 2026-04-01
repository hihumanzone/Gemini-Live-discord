import { safeReply } from '../../utils/discord-messaging.js';

/**
 * @param {{
 *   client: import('discord.js').Client,
 *   config: import('../../config/index.js').config,
 *   sessions: Map<string, import('../../services/bridge/discord-gemini-voice-bridge.js').DiscordGeminiVoiceBridge>,
 *   routeCommand: (interaction: import('discord.js').ChatInputCommandInteraction) => Promise<void>,
 *   stopGuildSession: (guildId: string, reason: string) => Promise<void>,
 * }} deps
 */
export function registerDiscordEvents({
  client,
  config,
  sessions,
  routeCommand,
  stopGuildSession,
}) {
  client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`Commands: /join, /leave, /reset`);
    if (config.systemPromptFilePath) {
      console.log(`[config] Using Gemini system prompt from ${config.systemPromptFilePath}`);
    } else {
      console.log(`[config] Using Gemini system prompt from ${config.systemPromptSource}`);
    }

    try {
      const { deployCommandsIfChanged } = await import('../deploy/commands.js');
      await deployCommandsIfChanged(client.user.id);
    } catch (err) {
      console.error('[deploy] Failed to lazy-load deploy command', err);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      await routeCommand(interaction);
    } catch (error) {
      console.error('[discord] interactionCreate handler error', error);
      await safeReply(interaction, 'An unexpected error occurred.', {
        ephemeral: true,
        tone: 'error',
      });
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
}
