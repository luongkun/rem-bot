const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ChannelType } = require("discord.js");
const { getSettings, saveVerification } = require("@schemas/Guild");
const { publicRoleError } = require("@helpers/RoleUtils");
const { EMBED_COLORS } = require("@root/config");

const BUTTON_ID = "VERIFY_MEMBER";
const activeVerifications = new Set();
const configuring = new Set();
const channelPermissions = ["ViewChannel", "SendMessages", "EmbedLinks", "ReadMessageHistory"];

function snapshot(settings) {
  const value = settings.verification;
  return value?.toObject ? value.toObject() : { ...value };
}

async function setupVerification(interaction, settings, channel, role, unverifiedRole) {
  const { guild } = interaction;
  if (configuring.has(guild.id) || [...activeVerifications].some((key) => key.startsWith(`${guild.id}:`))) {
    return "Verification is already in progress. Try changing the setup again shortly.";
  }
  configuring.add(guild.id);
  let panel;
  try {
    const actor = await guild.members.fetch({ user: interaction.user.id, force: true });
    if (!actor.permissions.has(["ManageGuild", "ManageRoles"])) return "You need Manage Server and Manage Roles.";
    await guild.roles.fetch();
    await guild.members.fetchMe({ force: true });
    role = guild.roles.cache.get(role.id);
    if (unverifiedRole) {
      unverifiedRole = guild.roles.cache.get(unverifiedRole.id);
      if (!unverifiedRole) return "The unverified role no longer exists in this server.";
    }
    const roleError = publicRoleError(guild, role, actor);
    if (roleError) return roleError;
    if (unverifiedRole) {
      const error = publicRoleError(guild, unverifiedRole, actor);
      if (error) return error;
      if (role.id === unverifiedRole.id) return "Verified and unverified roles must be different.";
    }
    if (settings.autorole && settings.autorole !== unverifiedRole?.id) {
      return "Disable autorole first with /autorole remove, or use its role as the unverified role.";
    }
    if (settings.invite.ranks.some((reward) => [role.id, unverifiedRole?.id].includes(reward._id))) {
      return "Remove these roles from invite rewards before using them for verification.";
    }
    if (channel.guild.id !== guild.id || channel.type !== ChannelType.GuildText) return "Choose a text channel in this server.";
    channel = await guild.channels.fetch(channel.id, { force: true });
    if (!channel || !channel.permissionsFor(guild.members.me)?.has(channelPermissions)) {
      return "The bot needs View Channel, Send Messages, Embed Links and Read Message History in the verify channel.";
    }
    if (!channel.permissionsFor(guild.roles.everyone)?.has(["ViewChannel", "ReadMessageHistory"])) {
      return "Allow @everyone to view the verify channel and read its message history.";
    }
    if (unverifiedRole && !channel.permissionsFor(unverifiedRole)?.has(["ViewChannel", "ReadMessageHistory"])) {
      return "The unverified role must be able to view the verify channel and read its message history.";
    }
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLORS.BOT_EMBED)
      .setTitle("Welcome to the server")
      .setDescription("Read the server rules, then press Verify to receive your member role. This is a button check, not a CAPTCHA.");
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(BUTTON_ID).setLabel("Verify").setStyle(ButtonStyle.Success)
    );
    panel = await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
    await saveVerification(settings, {
      enabled: true,
      channel_id: channel.id,
      message_id: panel.id,
      role_id: role.id,
      unverified_role_id: unverifiedRole?.id || null,
    });
    return "Verification panel saved. New members receive only the unverified role, if configured. " +
      "To protect member channels, deny View Channel to @everyone and allow it for the verified role. " +
      "Check other role/member overrides too. Existing channel permissions and member roles were not changed.";
  } catch (error) {
    if (panel) await panel.delete().catch(() => {});
    interaction.client.logger.error("Verification setup failed", error);
    return "Verification setup failed. Check the bot permissions and database connection, then try again.";
  } finally {
    configuring.delete(guild.id);
  }
}

async function disableVerification(interaction, settings) {
  const { guild } = interaction;
  if (configuring.has(guild.id) || [...activeVerifications].some((key) => key.startsWith(`${guild.id}:`))) {
    return "Verification is already in progress. Try changing the setup again shortly.";
  }
  configuring.add(guild.id);
  try {
    const actor = await guild.members.fetch({ user: interaction.user.id, force: true });
    if (!actor.permissions.has(["ManageGuild", "ManageRoles"])) return "You need Manage Server and Manage Roles.";
    await saveVerification(settings, { ...snapshot(settings), enabled: false });
    return "Verification disabled. Old panels no longer grant roles. Existing roles and channel permissions were not changed.";
  } catch (error) {
    interaction.client.logger.error("Disabling verification failed", error);
    return "Could not save the change. Verification has not been disabled.";
  } finally {
    configuring.delete(guild.id);
  }
}

async function handleVerify(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const { guild, user } = interaction;
  const key = `${guild.id}:${user.id}`;
  if (activeVerifications.has(key)) return interaction.editReply("Your verification is already being processed.");
  activeVerifications.add(key);
  try {
    const settings = await getSettings(guild);
    const verification = snapshot(settings);
    if (!verification.enabled || configuring.has(guild.id) ||
        verification.channel_id !== interaction.channelId || verification.message_id !== interaction.message.id ||
        interaction.message.author.id !== interaction.client.user.id) {
      return interaction.editReply("This verification panel is inactive. Use the current panel or contact staff.");
    }
    if (user.bot) return interaction.editReply("Bots cannot use member verification.");
    await guild.roles.fetch();
    await guild.members.fetchMe({ force: true });
    const member = await guild.members.fetch({ user: user.id, force: true });
    if (member.pending) return interaction.editReply("Complete Discord's server rules screening first, then verify again.");
    const role = guild.roles.cache.get(verification.role_id);
    const roleError = publicRoleError(guild, role);
    if (roleError) return interaction.editReply(`${roleError} Please contact staff.`);
    const unverifiedRole = verification.unverified_role_id ? guild.roles.cache.get(verification.unverified_role_id) : null;
    if (verification.unverified_role_id) {
      const error = publicRoleError(guild, unverifiedRole);
      if (error) return interaction.editReply(`${error} Please contact staff.`);
    }
    if (configuring.has(guild.id) || !settings.verification.enabled ||
        settings.verification.message_id !== verification.message_id) {
      return interaction.editReply("Verification settings changed. Use the current panel and try again.");
    }
    const alreadyVerified = member.roles.cache.has(role.id);
    if (!alreadyVerified) await member.roles.add(role, "Member completed button verification");
    if (unverifiedRole && member.roles.cache.has(unverifiedRole.id)) {
      try {
        await member.roles.remove(unverifiedRole, "Member completed button verification");
      } catch (error) {
        interaction.client.logger.error("Removing unverified role failed", error);
        return interaction.editReply("Your verified role was assigned, but the unverified role could not be removed. Contact staff or press Verify again.");
      }
    }
    return interaction.editReply(alreadyVerified ? "You are already verified." : "You are verified. Welcome!");
  } catch (error) {
    interaction.client.logger.error("Member verification failed", error);
    return interaction.editReply("Verification failed. Ask staff to check the bot permissions and role hierarchy, then try again.");
  } finally {
    activeVerifications.delete(key);
  }
}

async function applyJoinRoles(member, settings) {
  if (member.user.bot || member.pending) return;
  const roleId = settings.verification?.enabled ? settings.verification.unverified_role_id : settings.autorole;
  if (!roleId || member.roles.cache.has(roleId)) return;
  if (settings.verification?.enabled && member.roles.cache.has(settings.verification.role_id)) return;
  const role = await member.guild.roles.fetch(roleId);
  const error = publicRoleError(member.guild, role);
  if (error) {
    member.client.logger.error(`Join role skipped: ${error}`);
    return;
  }
  await member.roles.add(role, "Server join role");
}

module.exports = { BUTTON_ID, setupVerification, disableVerification, handleVerify, applyJoinRoles };
