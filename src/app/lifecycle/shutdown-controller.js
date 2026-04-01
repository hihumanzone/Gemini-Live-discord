import { destroyVoiceConnection } from '../../utils/discord-messaging.js';
import { logImportantEvent } from '../../utils/logging.js';

/**
 * @param {{
 *   client: import('discord.js').Client,
 *   sessions: Map<string, import('../../services/bridge/discord-gemini-voice-bridge.js').DiscordGeminiVoiceBridge>,
 *   hardTimeoutMs?: number,
 * }} deps
 */
export function createShutdownController({ client, sessions, hardTimeoutMs = 10_000 }) {
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
    logImportantEvent(`[shutdown] starting reason=${reason} ts=${timestamp}`);

    const hardTimeout = setTimeout(() => {
      console.error(`[shutdown] hard timeout reached reason=${reason} ts=${new Date().toISOString()}`);
      process.exit(1);
    }, hardTimeoutMs);

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

  return {
    stopGuildSession,
    gracefulShutdown,
  };
}
