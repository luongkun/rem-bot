const PRIVILEGED_PERMISSIONS = [
  "Administrator",
  "ManageGuild",
  "ManageRoles",
  "ManageChannels",
  "ManageWebhooks",
  "KickMembers",
  "BanMembers",
  "ModerateMembers",
  "ManageMessages",
  "ManageThreads",
  "ManageNicknames",
  "ManageEvents",
  "ManageGuildExpressions",
  "ViewAuditLog",
  "MuteMembers",
  "DeafenMembers",
  "MoveMembers",
  "MentionEveryone",
];

function publicRoleError(guild, role, actor) {
  if (!role || role.guild.id !== guild.id) return "The role no longer exists in this server.";
  if (role.id === guild.id || role.managed) return "Use a regular role, not @everyone or an integration role.";
  if (role.permissions.any(PRIVILEGED_PERMISSIONS)) return "Public roles must not grant moderation or management permissions.";
  const bot = guild.members.me;
  if (!bot?.permissions.has("ManageRoles") || bot.roles.highest.comparePositionTo(role) <= 0) {
    return "The bot needs Manage Roles and a role above the selected role.";
  }
  if (actor && actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(role) <= 0) {
    return "Choose a role below your highest role.";
  }
  return null;
}

function isVerificationRole(settings, roleId) {
  const verification = settings.verification;
  return verification?.enabled && [verification.role_id, verification.unverified_role_id].includes(roleId);
}

function canUseRoleRewards(member, settings, role) {
  if (member.user.bot || member.pending || publicRoleError(member.guild, role)) return false;
  if (!settings.verification?.enabled) return true;
  return !isVerificationRole(settings, role.id) && member.roles.cache.has(settings.verification.role_id);
}

module.exports = { publicRoleError, isVerificationRole, canUseRoleRewards };
