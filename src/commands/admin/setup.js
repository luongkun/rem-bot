const { EmbedBuilder } = require("discord.js");
const { EMBED_COLORS } = require("@root/config");

module.exports = {
  name: "setup",
  description: "Show setup steps and the current server configuration",
  category: "ADMIN",
  userPermissions: ["ManageGuild"],
  command: { enabled: false },
  slashCommand: { enabled: true, ephemeral: true },
  async interactionRun(interaction, { settings }) {
    const verification = settings.verification;
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLORS.BOT_EMBED)
      .setTitle("Server setup")
      .setDescription("This command only shows configuration. It does not change roles, channels or permissions.")
      .addFields(
        {
          name: "1. Welcome",
          value: `${settings.welcome.enabled ? "Enabled" : "Disabled"}\n/welcome channel channel:#welcome\n/welcome status status:ON\n/welcome preview`,
        },
        {
          name: "2. Verification and join roles",
          value: `${verification?.enabled ? "Enabled" : "Disabled"}\n/verify setup channel:#verify role:@Member unverified_role:@Unverified\n` +
            "Keep #verify readable to new members. Restrict member channels to the verified role. Existing channel permissions are not changed automatically.\n" +
            "With verification enabled, only the unverified role is assigned on join. Without verification, use /autorole add.",
        },
        {
          name: "3. Tickets",
          value: `${settings.ticket.log_channel ? `Logs: <#${settings.ticket.log_channel}>` : "Log channel not configured"}\n` +
            "/ticketcat add category:Support staff_roles:@Support\n/ticket log channel:#ticket-logs\n/ticket setup channel:#support\n" +
            "Restrict logs to configured staff, server managers and this bot. The bot needs Attach Files and Manage Roles to archive and freeze tickets; closing is blocked if archiving fails.",
        },
        {
          name: "Other tools",
          value: "Use /help for moderation, automod, reaction roles, invite tracking, leveling and suggestions. " +
            "Music, giveaways and the web dashboard are disabled in this build pending further review.",
        },
        {
          name: "Permissions",
          value: "Enable Server Members and Message Content intents in the Developer Portal. " +
            "Place the bot role above Member and Unverified. Grant only the permissions required for enabled features; Administrator is not required.",
        }
      );
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};
