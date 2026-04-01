/**
 * @param {{
 *   speakerIds: string[],
 *   voiceChannel: import('discord.js').BaseGuildVoiceChannel,
 *   client: import('discord.js').Client,
 * }} options
 */
export function formatSpeakerLabels({ speakerIds, voiceChannel, client }) {
  const uniqueSpeakerIds = [...new Set(speakerIds)].filter(Boolean);
  if (uniqueSpeakerIds.length === 0) return 'unknown';

  const labels = uniqueSpeakerIds.map((userId) => {
    const member = voiceChannel.guild.members.cache.get(userId);
    if (member?.displayName) return member.displayName;
    const user = client.users.cache.get(userId);
    return user?.username ?? userId;
  });

  if (labels.length <= 2) return labels.join(' + ');
  return `${labels.slice(0, 2).join(' + ')} + ${labels.length - 2} more`;
}
