const { getReactionRoles } = require("@schemas/ReactionRoles");
const { getSettings } = require("@schemas/Guild");
const { canUseRoleRewards, isVerificationRole } = require("@helpers/RoleUtils");

module.exports = {
  /**
   * @param {import('discord.js').MessageReaction} reaction
   * @param {import('discord.js').User} user
   */
  async handleReactionAdd(reaction, user) {
    const role = await getRole(reaction);
    if (!role) return;

    const member = await reaction.message.guild.members.fetch(user.id);
    if (!member) return;
    const settings = await getSettings(member.guild);
    if (!canUseRoleRewards(member, settings, role)) return;

    await member.roles.add(role).catch((error) => member.client.logger.error("Reaction role assignment failed", error));
  },

  /**
   * @param {import('discord.js').MessageReaction} reaction
   * @param {import('discord.js').User} user
   */
  async handleReactionRemove(reaction, user) {
    const role = await getRole(reaction);
    if (!role) return;

    const member = await reaction.message.guild.members.fetch(user.id);
    if (!member) return;
    const settings = await getSettings(member.guild);
    if (isVerificationRole(settings, role.id)) return;

    await member.roles.remove(role).catch((error) => member.client.logger.error("Reaction role removal failed", error));
  },
};

/**
 * @param {import('discord.js').MessageReaction} reaction
 */
async function getRole(reaction) {
  const { message, emoji } = reaction;
  if (!message || !message.channel) return;

  const rr = getReactionRoles(message.guildId, message.channelId, message.id);
  const emote = emoji.id ? emoji.id : emoji.toString();
  const found = rr.find((doc) => doc.emote === emote);

  const reactionRole = found ? await message.guild.roles.fetch(found.role_id) : null;
  return reactionRole;
}
