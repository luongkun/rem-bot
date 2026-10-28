const { getSettings } = require("@schemas/Guild");
const { applyJoinRoles } = require("@handlers/verification");

module.exports = async (client, previous, member) => {
  if (!previous.pending || member.pending || member.user.bot) return;
  try {
    await applyJoinRoles(member, await getSettings(member.guild));
  } catch (error) {
    client.logger.error("Post-screening role assignment failed", error);
  }
};
