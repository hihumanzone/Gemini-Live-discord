import { destroyVoiceConnection, safeReply } from '../utils/discord-messaging.js';

/**
 * @param {{
 *   sessions: Map<string, import('../services/bridge/discord-gemini-voice-bridge.js').DiscordGeminiVoiceBridge>,
 *   stopGuildSession: (guildId: string, reason: string) => Promise<void>,
 * }} deps
 */
export function createLeaveCommandHandler({ sessions, stopGuildSession }) {
  return async function handleLeaveCommand(interaction) {
    const guildId = interaction.guild.id;

    try {
      if (!sessions.has(guildId)) {
        destroyVoiceConnection(guildId, 'leave_without_session');
        await safeReply(interaction, 'I am not currently connected in this server.', { tone: 'warning' });
        return;
      }

      await interaction.deferReply();
      await stopGuildSession(guildId, 'command_leave');
      await safeReply(interaction, 'Disconnected.', { tone: 'success' });
    } catch (error) {
      console.error(`[bot:${guildId}] Leave failed`, error);
      await safeReply(interaction, 'Leave command failed. Check logs.', { tone: 'error' });
    }
  };
}
