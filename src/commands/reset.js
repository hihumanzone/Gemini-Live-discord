import { safeReply } from '../utils/discord-messaging.js';

/**
 * @param {{
 *   sessions: Map<string, import('../services/bridge/discord-gemini-voice-bridge.js').DiscordGeminiVoiceBridge>,
 * }} deps
 */
export function createResetCommandHandler({ sessions }) {
  return async function handleResetCommand(interaction) {
    const guildId = interaction.guild.id;

    try {
      const bridge = sessions.get(guildId);
      if (!bridge) {
        await safeReply(interaction, 'Nothing to reset.', { tone: 'warning' });
        return;
      }

      await interaction.deferReply();
      await bridge.resetGeminiSession();
      await safeReply(interaction, 'Gemini Live session reset.', { tone: 'success' });
    } catch (error) {
      console.error(`[bot:${guildId}] Reset failed`, error);
      await safeReply(interaction, 'Reset failed. Check logs.', { tone: 'error' });
    }
  };
}
