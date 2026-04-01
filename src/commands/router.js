/**
 * @param {{
 *   handleJoinCommand: (interaction: import('discord.js').ChatInputCommandInteraction) => Promise<void>,
 *   handleLeaveCommand: (interaction: import('discord.js').ChatInputCommandInteraction) => Promise<void>,
 *   handleResetCommand: (interaction: import('discord.js').ChatInputCommandInteraction) => Promise<void>,
 * }} deps
 */
export function createCommandRouter({
  handleJoinCommand,
  handleLeaveCommand,
  handleResetCommand,
}) {
  return async function routeCommand(interaction) {
    if (interaction.commandName === 'join') {
      await handleJoinCommand(interaction);
      return;
    }

    if (interaction.commandName === 'leave') {
      await handleLeaveCommand(interaction);
      return;
    }

    if (interaction.commandName === 'reset') {
      await handleResetCommand(interaction);
    }
  };
}
