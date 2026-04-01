import { getJoinPreflightFailure } from '../utils/voice-preflight.js';
import { safeReply } from '../utils/discord-messaging.js';

/**
 * @param {{
 *   client: import('discord.js').Client,
 *   BridgeClass: typeof import('../services/bridge/discord-gemini-voice-bridge.js').DiscordGeminiVoiceBridge,
 *   sessions: Map<string, import('../services/bridge/discord-gemini-voice-bridge.js').DiscordGeminiVoiceBridge>,
 *   stopGuildSession: (guildId: string, reason: string) => Promise<void>,
 * }} deps
 */
export function createJoinCommandHandler({
  client,
  BridgeClass,
  sessions,
  stopGuildSession,
}) {
  return async function handleJoinCommand(interaction) {
    const guildId = interaction.guild.id;

    try {
      const member = interaction.guild.members.cache.get(interaction.user.id)
        ?? await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      const channel = member?.voice?.channel;
      if (!channel) {
        await safeReply(interaction, 'Join a voice channel first.', { tone: 'warning' });
        return;
      }

      if (sessions.has(guildId)) {
        await safeReply(
          interaction,
          `I am already connected in this server. Use \`/reset\` or \`/leave\` first.`,
          { tone: 'warning' },
        );
        return;
      }

      const preflightFailure = getJoinPreflightFailure(interaction, channel);
      if (preflightFailure) {
        await safeReply(interaction, preflightFailure, { tone: 'warning' });
        return;
      }

      await interaction.deferReply();

      // Fix setup vs disconnect race condition: track pending boot
      const bridge = new BridgeClass(channel, client);
      sessions.set(guildId, bridge);

      try {
        await bridge.start();
        await safeReply(interaction, `Connected to **${channel.name}** and bridged to Gemini Live.`, { tone: 'success' });
      } catch (error) {
        console.error(`[bot:${guildId}] Failed to join`, error);
        await stopGuildSession(guildId, 'join_failure');
        await safeReply(interaction, 'Failed to join the voice channel or initialize Gemini Live. Check logs.', { tone: 'error' });
      }
    } catch (error) {
      console.error(`[bot:${guildId}] Unhandled join command error`, error);
      await stopGuildSession(guildId, 'join_unhandled_failure');
      await safeReply(interaction, 'Join command failed unexpectedly. Check logs.', { tone: 'error' });
    }
  };
}
