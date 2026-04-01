import { VoiceConnectionStatus, entersState } from '@discordjs/voice';

export async function waitForVoiceReady(connection, guildId, timeoutMs = 20_000, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (connection.state.status === VoiceConnectionStatus.Ready) return;

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, timeoutMs);
      return;
    } catch (error) {
      const status = connection.state.status;
      console.warn(
        `[voice:${guildId}] Ready wait attempt ${attempt}/${maxAttempts} failed while in state ${status}`,
        error,
      );

      if (attempt >= maxAttempts) {
        throw error;
      }

      try {
        connection.rejoin();
      } catch (rejoinError) {
        console.warn(`[voice:${guildId}] Rejoin attempt failed`, rejoinError);
      }
    }
  }
}
