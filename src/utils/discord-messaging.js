import { getVoiceConnection } from '@discordjs/voice';
import { EmbedBuilder } from 'discord.js';

function getReplyToneMeta(tone) {
  switch (tone) {
    case 'success':
      return { title: 'Success', color: 0x2ecc71 };
    case 'warning':
      return { title: 'Notice', color: 0xf1c40f };
    case 'error':
      return { title: 'Error', color: 0xe74c3c };
    default:
      return { title: 'Gemini Live', color: 0x3498db };
  }
}

function createReplyEmbed(content, tone = 'info', client = null) {
  const { title, color } = getReplyToneMeta(tone);
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(content)
    .setColor(color)
    .setTimestamp();

  if (client?.user) {
    embed.setFooter({
      text: client.user.username,
      iconURL: client.user.displayAvatarURL(),
    });
  }

  return embed;
}

async function sendInteractionReply(interaction, payload) {
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
    return;
  }

  await interaction.reply(payload);
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string} content
 * @param {{
 *   ephemeral?: boolean,
 *   tone?: 'info' | 'success' | 'warning' | 'error',
 * }} [options]
 */
export async function safeReply(interaction, content, options = {}) {
  const { ephemeral = false, tone = 'info' } = options;

  try {
    await sendInteractionReply(interaction, {
      embeds: [createReplyEmbed(content, tone, interaction.client)],
      ephemeral,
    });
    return true;
  } catch (error) {
    console.warn('[reply] Embed response failed, retrying as text', {
      guildId: interaction.guild?.id,
      channelId: interaction.channel?.id,
      interactionId: interaction.id,
      errorCode: error?.code,
      errorMessage: error?.message,
    });

    try {
      await sendInteractionReply(interaction, { content, ephemeral });
      return true;
    } catch (fallbackError) {
      console.warn('[reply] Text fallback failed', {
        guildId: interaction.guild?.id,
        channelId: interaction.channel?.id,
        interactionId: interaction.id,
        errorCode: fallbackError?.code,
        errorMessage: fallbackError?.message,
      });
      return false;
    }
  }
}

export function destroyVoiceConnection(guildId, logContext = 'voice_cleanup') {
  try {
    getVoiceConnection(guildId)?.destroy();
  } catch (error) {
    console.warn(`[discord] Failed to destroy voice connection during ${logContext}`, {
      guildId,
      errorCode: error?.code,
      message: error?.message,
    });
  }
}
