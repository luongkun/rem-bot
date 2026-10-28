const { inviteHandler, greetingHandler } = require("@src/handlers");
const { getSettings } = require("@schemas/Guild");
const { applyJoinRoles } = require("@handlers/verification");

/**
 * @param {import('@src/structures').BotClient} client
 * @param {import('discord.js').GuildMember} member
 */
module.exports = async (client, member) => {
  if (!member || !member.guild) return;

  const { guild } = member;
  const settings = await getSettings(guild);

  await applyJoinRoles(member, settings).catch((error) => client.logger.error("Join role assignment failed", error));

  // Check for counter channel
  if (settings.counters.find((doc) => ["MEMBERS", "BOTS", "USERS"].includes(doc.counter_type.toUpperCase()))) {
    if (member.user.bot) {
      settings.data.bots += 1;
      await settings.save();
    }
    if (!client.counterUpdateQueue.includes(guild.id)) client.counterUpdateQueue.push(guild.id);
  }

  // Check if invite tracking is enabled
  const inviterData = settings.invite.tracking
    ? await inviteHandler.trackJoinedMember(member).catch((error) => {
        client.logger.error("Invite tracking failed", error);
        return {};
      })
    : {};

  await greetingHandler.sendWelcome(member, inviterData).catch((error) => client.logger.error("Welcome failed", error));
};
