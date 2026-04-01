import { InteractionContextType, SlashCommandBuilder } from 'discord.js';

export const COMMANDS = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Connect the bot to your current voice channel')
    .setContexts(InteractionContextType.Guild),
  
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Disconnect the bot from the voice channel')
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Reset the current Gemini session or conversation state')
    .setContexts(InteractionContextType.Guild)
].map(command => command.toJSON());
