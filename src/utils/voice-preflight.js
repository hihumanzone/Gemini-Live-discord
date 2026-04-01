import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { logRoutineAction } from './logging.js';

export function getJoinPreflightFailure(message, channel) {
  const botMember = message.guild?.members?.me;
  if (!botMember) {
    return 'I cannot resolve my guild membership state yet. Please try again in a few seconds.';
  }

  const permissions = channel.permissionsFor(botMember);
  const requiredPermissions = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
  ];

  if (PermissionFlagsBits.UseVAD) {
    requiredPermissions.push(PermissionFlagsBits.UseVAD);
  }

  if (channel.type === ChannelType.StageVoice) {
    requiredPermissions.push(PermissionFlagsBits.RequestToSpeak);
  }

  const missingPermissions = permissions
    ? requiredPermissions.filter((permission) => !permissions.has(permission))
    : requiredPermissions;

  logRoutineAction('[join:preflight]', {
    guildId: message.guild.id,
    channelId: channel.id,
    channelType: channel.type,
    full: channel.full,
    joinable: channel.joinable,
    permissionsBitfield: permissions?.bitfield?.toString?.() ?? 'none',
    requiredPermissions: requiredPermissions.map((value) => value.toString()),
    missingPermissions: missingPermissions.map((value) => value.toString()),
    memberCount: channel.members?.size,
    userLimit: channel.userLimit,
  });

  if (!channel.joinable) {
    return 'I cannot join that voice channel right now. Check channel permissions and voice region availability.';
  }

  if (channel.full) {
    return 'That voice channel is full right now. Please free up a slot and try again.';
  }

  if (missingPermissions.length > 0) {
    return 'I am missing required permissions to join/speak in that channel.';
  }

  if (channel.type === ChannelType.StageVoice && !permissions?.has(PermissionFlagsBits.RequestToSpeak)) {
    return 'I need permission to request to speak in that stage channel.';
  }

  return null;
}
