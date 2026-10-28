const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  StringSelectMenuBuilder,
  ComponentType,
  OverwriteType,
  PermissionsBitField,
} = require("discord.js");
const { TICKET } = require("@root/config.js");
const { getSettings } = require("@schemas/Guild");
const { error } = require("@helpers/Logger");
const { buildTicketTranscript, canArchiveTo, NO_MENTIONS } = require("@helpers/ticketTranscript");

const OPEN_PERMS = ["ManageChannels"];
const CLOSE_PERMS = ["ViewChannel", "ManageChannels", "ManageRoles", "ReadMessageHistory"];
const WRITE_PERMS = ["SendMessages", "CreatePublicThreads", "CreatePrivateThreads", "SendMessagesInThreads"];
const pendingOpens = new Map();
const pendingCloses = new Set();

function isTicketChannel(channel) {
  return Boolean(
    channel?.type === ChannelType.GuildText &&
      channel.name?.startsWith("tіcket-") &&
      /^tіcket\|\d{17,20}(?:\|[^|]*)?$/.test(channel.topic || "")
  );
}

function getTicketChannels(guild) {
  return guild.channels.cache.filter((ch) => isTicketChannel(ch));
}

function getExistingTicketChannel(guild, userId) {
  return getTicketChannels(guild).find((ch) => ch.topic.split("|")[1] === userId);
}

async function canCloseTicket(channel, closedBy, settings) {
  if (!closedBy?.id) return false;
  const [, ownerId, category = "Default"] = channel.topic.split("|");
  if (closedBy.id === ownerId) return true;
  const member = await channel.guild.members.fetch(closedBy.id).catch(() => null);
  if (!member) return false;
  if (member.permissions.has("ManageGuild")) return true;
  const staffRoles = settings.ticket.categories.find((cat) => cat.name === category)?.staff_roles || [];
  return staffRoles.some((id) => {
    const role = channel.guild.roles.cache.get(id);
    return id !== channel.guild.id && role && !role.managed && member.roles.cache.has(id);
  });
}

async function closeTicket(channel, closedBy, reason) {
  if (!isTicketChannel(channel)) return "NOT_TICKET";
  if (pendingCloses.has(channel.id)) return "ALREADY_CLOSING";
  pendingCloses.add(channel.id);
  let overwriteSnapshot;
  let needsRestore = false;
  const keepTicket = async (status) => {
    if (!needsRestore) return status;
    try {
      const restored = await channel.permissionOverwrites.set(overwriteSnapshot, "Restore ticket permissions after failed close");
      if (!restored) throw new Error("Discord did not acknowledge permission restoration");
      needsRestore = false;
      return status;
    } catch (ex) {
      error("restoreTicketPermissions", ex);
      return `${status}_RESTORE_FAILED`;
    }
  };

  try {
    const settings = await getSettings(channel.guild);
    if (!(await canCloseTicket(channel, closedBy, settings))) return "UNAUTHORIZED";
    if (!channel.deletable || !channel.permissionsFor(channel.guild.members.me)?.has(CLOSE_PERMS)) {
      return "MISSING_PERMISSIONS";
    }

    const logId = settings.ticket.log_channel;
    const logChannel = logId ? await channel.guild.channels.fetch(logId).catch(() => null) : null;
    if (!(await canArchiveTo(logChannel, channel.guild, settings)) || logChannel.id === channel.id) return "LOG_UNAVAILABLE";

    try {
      overwriteSnapshot = channel.permissionOverwrites.cache.map(({ id, type, allow, deny }) => {
        if (!id || ![OverwriteType.Role, OverwriteType.Member].includes(type) ||
          typeof allow?.bitfield !== "bigint" || typeof deny?.bitfield !== "bigint") {
          throw new Error("Ticket permission overwrite information is unavailable");
        }
        return { id, type, allow: allow.bitfield, deny: deny.bitfield };
      });
      const frozen = overwriteSnapshot.map((overwrite) => overwrite.id === channel.guild.members.me.id &&
        overwrite.type === OverwriteType.Member ? { ...overwrite } : {
          ...overwrite,
          allow: new PermissionsBitField(overwrite.allow).remove(WRITE_PERMS).bitfield,
          deny: new PermissionsBitField(overwrite.deny).add(WRITE_PERMS).bitfield,
        });
      if (!frozen.some((overwrite) => overwrite.id === channel.guild.id && overwrite.type === OverwriteType.Role)) {
        frozen.push({ id: channel.guild.id, type: OverwriteType.Role, allow: 0n, deny: new PermissionsBitField(WRITE_PERMS).bitfield });
      }
      // Even a failed request can have reached Discord, so attempt restoration on failure.
      needsRestore = true;
      const acknowledged = await channel.permissionOverwrites.set(frozen, "Freeze ticket writers before archiving");
      if (!acknowledged) throw new Error("Discord did not acknowledge the ticket permission freeze");
    } catch (ex) {
      error("freezeTicket", ex);
      return await keepTicket("FREEZE_FAILED");
    }

    const [, ownerId, catName = "Default"] = channel.topic.split("|");
    const embed = new EmbedBuilder()
      .setAuthor({ name: "Ticket Archive" })
      .setColor(TICKET.CLOSE_EMBED)
      .setDescription(`Ticket: ${channel.name}\nCategory: ${catName}`.slice(0, 4096))
      .addFields(
        { name: "Opened By", value: ownerId, inline: true },
        { name: "Closed By", value: `${closedBy.username || "Unknown"} (${closedBy.id})`, inline: true }
      );
    if (reason) embed.addFields({ name: "Reason", value: String(reason).slice(0, 1024) });

    let transcript;
    let latestMessageId;
    try {
      ({ attachment: transcript, latestMessageId } = await buildTicketTranscript(channel));
      // Await Discord's archive acknowledgement before removing the only local history.
      const archived = await logChannel.send({ embeds: [embed], files: [transcript], allowedMentions: NO_MENTIONS });
      if (!archived) throw new Error("Discord did not acknowledge the ticket archive");
    } catch (ex) {
      error("archiveTicket", ex);
      return await keepTicket(ex.code === "TRANSCRIPT_TOO_LARGE" ? "TRANSCRIPT_TOO_LARGE" : "ARCHIVE_FAILED");
    }

    try {
      // Administrators bypass channel denies; never delete if their new messages were missed.
      const latest = await channel.messages.fetch({ limit: 1, cache: false });
      if ((latest.first()?.id ?? null) !== latestMessageId) return await keepTicket("SNAPSHOT_CHANGED");
    } catch (ex) {
      error("verifyTicketSnapshot", ex);
      return await keepTicket("SNAPSHOT_CHECK_FAILED");
    }

    try {
      await channel.delete();
      needsRestore = false;
    } catch (ex) {
      error("deleteTicket", ex);
      return await keepTicket("DELETE_FAILED");
    }

    try {
      const owner = await channel.client.users.fetch(ownerId);
      await owner.send({ embeds: [embed], files: [transcript], allowedMentions: NO_MENTIONS });
    } catch (ex) {
      return "SUCCESS";
    }
    return "SUCCESS";
  } catch (ex) {
    error("closeTicket", ex);
    return await keepTicket("ERROR");
  } finally {
    pendingCloses.delete(channel.id);
  }
}

function getCloseStatusMessage(status) {
  const messages = {
    SUCCESS: "Ticket archived and closed.",
    NOT_TICKET: "This action can only be used in a ticket channel.",
    UNAUTHORIZED: "Only the ticket owner, category staff, or a member with Manage Server can close this ticket.",
    ALREADY_CLOSING: "This ticket is already being closed.",
    MISSING_PERMISSIONS: "I cannot close this ticket: I need View Channel, Manage Channels, Manage Roles, and Read Message History. The channel was kept.",
    LOG_UNAVAILABLE: "The ticket was kept. Configure a private, writable text log channel visible only to the bot, configured ticket staff, and server managers, with Attach Files and Embed Links permissions first.",
    FREEZE_FAILED: "I could not make the ticket read-only. The channel was kept and no archive was attempted.",
    ARCHIVE_FAILED: "The transcript could not be archived to Discord. The ticket channel was kept; please try again.",
    TRANSCRIPT_TOO_LARGE: "The transcript exceeds the safe attachment size. The ticket channel was kept; archive it manually before closing.",
    SNAPSHOT_CHANGED: "The latest message changed after the transcript snapshot. The ticket channel was kept; please try closing again.",
    SNAPSHOT_CHECK_FAILED: "The transcript was archived, but the latest ticket message could not be verified. The ticket channel was kept.",
    DELETE_FAILED: "The transcript was archived, but the ticket channel could not be deleted.",
    ERROR: "An error occurred while closing the ticket. The channel was kept.",
  };
  if (status?.endsWith("_RESTORE_FAILED")) {
    return `${messages[status.slice(0, -"_RESTORE_FAILED".length)] || messages.ERROR} Original ticket permissions could not be restored; a server manager must restore them manually.`;
  }
  return messages[status] || messages.ERROR;
}

async function closeAllTickets(guild, author) {
  const channels = getTicketChannels(guild);
  let success = 0;
  let failed = 0;
  for (const channel of channels.values()) {
    const status = await closeTicket(channel, author, "Force close all open tickets");
    if (status === "SUCCESS") success += 1;
    else failed += 1;
  }
  return [success, failed];
}

async function handleTicketOpen(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const { guild, user } = interaction;
  const reply = (content) => interaction.editReply({ content, components: [], allowedMentions: NO_MENTIONS });
  if (!guild?.members.me?.permissions.has(OPEN_PERMS)) {
    return reply("Cannot create a ticket: I need Manage Channels. Contact a server manager for help.");
  }
  let pending = pendingOpens.get(guild.id);
  if (!pending) {
    pending = new Map();
    pendingOpens.set(guild.id, pending);
  }
  if (pending.has(user.id)) return reply("Your ticket is already being opened. Finish the existing request first.");
  const reservation = { reserved: false, channelId: null };
  pending.set(user.id, reservation);
  let createdChannel;

  try {
    if (getExistingTicketChannel(guild, user.id)) return await reply("You already have an open ticket.");
    const settings = await getSettings(guild);
    const existing = getTicketChannels(guild);
    const reserved = [...pending.values()].filter((entry) => entry.reserved && !existing.has(entry.channelId)).length;
    if (!Number.isInteger(settings.ticket.limit) || settings.ticket.limit < 1) {
      return await reply("The ticket limit is invalid. Contact a server manager.");
    }
    if (existing.size + reserved >= settings.ticket.limit) {
      return await reply("There are too many open or pending tickets. Try again later.");
    }
    reservation.reserved = true;

    let catName = null;
    let catPerms = [];
    const categories = settings.ticket.categories;
    if (categories.length > 25 || categories.some((cat) => !cat.name?.trim() || cat.name.length > 100 || cat.name.includes("|"))) {
      return await reply("The ticket categories are invalid. Ask a server manager to update them.");
    }
    if (categories.length > 0) {
      const names = categories.map((cat) => cat.name);
      const menuRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("ticket-menu")
          .setPlaceholder("Choose the ticket category")
          .addOptions(names.map((name) => ({ label: name, value: name })))
      );
      const prompt = await interaction.editReply({
        content: "Please choose a ticket category",
        components: [menuRow],
        allowedMentions: NO_MENTIONS,
      });
      const choice = await prompt.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        filter: (i) => i.customId === "ticket-menu" && i.user.id === user.id && i.message.id === prompt.id &&
          i.guildId === guild.id && i.channelId === interaction.channelId,
        time: 60 * 1000,
      }).catch((ex) => {
        if (ex.code === "InteractionCollectorError") return null;
        throw ex;
      });
      if (!choice) return await reply("Timed out. Try again.");
      await choice.deferUpdate();
      const current = await getSettings(guild);
      catName = choice.values[0];
      const category = current.ticket.categories.find((cat) => cat.name === catName);
      if (choice.values.length !== 1 || !names.includes(catName) || !category) {
        return await reply("That category is no longer available. Please open a new ticket request.");
      }
      catPerms = category.staff_roles || [];
      await reply("Processing your ticket...");
    }

    if (catPerms.some((id) => id === guild.id || !guild.roles.cache.get(id) || guild.roles.cache.get(id).managed)) {
      return await reply("This category has invalid staff roles. Ask a server manager to update it.");
    }
    const ticketNumber = (getTicketChannels(guild).size + 1).toString();
    const permissionOverwrites = [
      { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: ["ViewChannel"] },
      { id: user.id, type: OverwriteType.Member, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] },
      { id: guild.members.me.id, type: OverwriteType.Member, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "EmbedLinks", "AttachFiles"] },
      ...catPerms.map((id) => ({ id, type: OverwriteType.Role, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] })),
    ];
    createdChannel = await guild.channels.create({
      name: `tіcket-${ticketNumber}`,
      type: ChannelType.GuildText,
      topic: `tіcket|${user.id}|${catName || "Default"}`,
      permissionOverwrites,
    });
    reservation.channelId = createdChannel.id;

    const embed = new EmbedBuilder()
      .setColor(TICKET.CREATE_EMBED)
      .setAuthor({ name: `Ticket #${ticketNumber}` })
      .setDescription(`Hello ${user.toString()}\nSupport will be with you shortly.${catName ? `\n**Category:** ${catName}` : ""}`)
      .setFooter({ text: "You may close your ticket anytime by clicking the button below" });
    const buttonsRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("Close Ticket").setCustomId("TICKET_CLOSE").setStyle(ButtonStyle.Primary)
    );
    await createdChannel.send({ embeds: [embed], components: [buttonsRow], allowedMentions: NO_MENTIONS });
    return await reply(`Ticket created: <#${createdChannel.id}>`);
  } catch (ex) {
    error("handleTicketOpen", ex);
    return await reply(createdChannel
      ? `Ticket created: <#${createdChannel.id}>, but its welcome message could not be completed. The channel was kept; contact a server manager.`
      : "Failed to create the ticket channel. Please try again.");
  } finally {
    pending.delete(user.id);
    if (!pending.size) pendingOpens.delete(guild.id);
  }
}

async function handleTicketClose(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const status = await closeTicket(interaction.channel, interaction.user);
  return interaction.editReply({ content: getCloseStatusMessage(status), allowedMentions: NO_MENTIONS });
}

module.exports = {
  getTicketChannels,
  getExistingTicketChannel,
  isTicketChannel,
  closeTicket,
  closeAllTickets,
  handleTicketOpen,
  handleTicketClose,
  getCloseStatusMessage,
};
