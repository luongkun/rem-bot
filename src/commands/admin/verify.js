const { ApplicationCommandOptionType, ChannelType } = require("discord.js");
const { setupVerification, disableVerification } = require("@handlers/verification");

module.exports = {
  name: "verify",
  description: "Configure member verification",
  category: "ADMIN",
  userPermissions: ["ManageGuild", "ManageRoles"],
  command: { enabled: false },
  slashCommand: {
    enabled: true,
    ephemeral: true,
    options: [
      {
        name: "setup",
        description: "Publish a verification button and save its roles",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "channel",
            description: "Text channel visible to new members",
            type: ApplicationCommandOptionType.Channel,
            channelTypes: [ChannelType.GuildText],
            required: true,
          },
          {
            name: "role",
            description: "Member role granted after verification",
            type: ApplicationCommandOptionType.Role,
            required: true,
          },
          {
            name: "unverified_role",
            description: "Optional restricted role given on join and removed after verification",
            type: ApplicationCommandOptionType.Role,
            required: false,
          },
        ],
      },
      { name: "status", description: "Show the current verification setup", type: ApplicationCommandOptionType.Subcommand },
      { name: "disable", description: "Disable verification without changing existing member roles", type: ApplicationCommandOptionType.Subcommand },
    ],
  },
  async interactionRun(interaction, { settings }) {
    const subcommand = interaction.options.getSubcommand();
    let response;
    if (subcommand === "setup") {
      response = await setupVerification(
        interaction,
        settings,
        interaction.options.getChannel("channel"),
        interaction.options.getRole("role"),
        interaction.options.getRole("unverified_role")
      );
    } else if (subcommand === "disable") {
      response = await disableVerification(interaction, settings);
    } else {
      const verification = settings.verification;
      response = verification?.enabled
        ? `Verification is enabled in <#${verification.channel_id}>.\nVerified role: <@&${verification.role_id}>\n` +
          `Join role: ${verification.unverified_role_id ? `<@&${verification.unverified_role_id}>` : "None"}\n` +
          "This is button verification, not a CAPTCHA. Member-channel access must be restricted with Discord permissions."
        : "Verification is disabled. Use /verify setup to configure it.";
    }
    await interaction.followUp({ content: response, allowedMentions: { parse: [] } });
  },
};
