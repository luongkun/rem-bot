const { AttachmentBuilder, ChannelType, OverwriteType } = require("discord.js");

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const NO_MENTIONS = { parse: [], users: [], roles: [], repliedUser: false };
const LOG_PERMS = ["ViewChannel", "SendMessages", "EmbedLinks", "AttachFiles"];

async function canArchiveTo(channel, guild, settings) {
  try {
    const bot = guild.members.me;
    const roles = guild.roles.cache;
    const overwrites = channel?.permissionOverwrites?.cache;
    if (!channel || channel.guild?.id !== guild.id || channel.type !== ChannelType.GuildText ||
      channel.topic?.startsWith("tіcket|") || !bot || !roles?.has(guild.id) || !overwrites ||
      !Array.isArray(settings?.ticket?.categories) || !channel.permissionsFor(bot)?.has(LOG_PERMS)) return false;

    const staffRoleIds = new Set(settings.ticket.categories.flatMap((category) => category.staff_roles || [])
      .filter((id) => id !== guild.id && roles.has(id) && !roles.get(id).managed));
    const isManager = (permissions) => permissions.has("Administrator") || permissions.has("ManageGuild");
    for (const role of roles.values()) {
      const effective = channel.permissionsFor(role);
      if (typeof effective?.has !== "function" || typeof role.permissions?.has !== "function") return false;
      if (!effective.has("ViewChannel")) continue;
      // A denied @everyone does not prevent a public Member role from seeing the log.
      if (role.id === guild.id) return false;
      if (!(role.managed && role.tags?.botId === bot.id) && !staffRoleIds.has(role.id) &&
        !isManager(role.permissions)) return false;
    }

    for (const overwrite of overwrites.values()) {
      if (typeof overwrite.allow?.has !== "function" || typeof overwrite.deny?.has !== "function") return false;
      if (overwrite.type === OverwriteType.Role) {
        if (!roles.has(overwrite.id)) return false;
      } else if (overwrite.type === OverwriteType.Member) {
        if (!overwrite.allow.has("ViewChannel", false) || overwrite.id === bot.id) continue;
        // Fetch only explicitly allowed members, never the guild's entire member list.
        const member = await guild.members.fetch(overwrite.id);
        if (typeof member?.permissions?.has !== "function" || (!isManager(member.permissions) &&
          ![...staffRoleIds].some((id) => member.roles.cache.has(id)))) return false;
      } else return false;
    }
    return true;
  } catch (ex) {
    // Unknown permissions or a departed/unfetchable member cannot establish privacy.
    return false;
  }
}

async function buildTicketTranscript(channel, maxBytes = MAX_TRANSCRIPT_BYTES) {
  const header = `Ticket: ${channel.name} (${channel.id})\nServer: ${channel.guild.name} (${channel.guild.id})\nTopic: ${channel.topic || ""}\n\n`;
  let bytes = Buffer.byteLength(header, "utf8");
  const pages = [];
  let before;
  let latestMessageId = null;

  const checkSize = () => {
    if (bytes > maxBytes) {
      const ex = new Error("Transcript exceeds the safe attachment size; keep the ticket channel");
      ex.code = "TRANSCRIPT_TOO_LARGE";
      throw ex;
    }
  };
  checkSize();

  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}), cache: false });
    if (!batch.size) break;
    const messages = Array.from(batch.values()).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    if (before && messages.some((message) => BigInt(message.id) >= BigInt(before))) {
      throw new Error("Transcript pagination did not advance");
    }
    if (!before) latestMessageId = messages[messages.length - 1].id;

    const entries = [];
    for (const message of messages) {
      let text = `[${new Date(message.createdTimestamp ?? message.createdAt).toISOString()}] ${message.author?.tag || message.author?.username || "Unknown"} (${message.author?.id || "Unknown"}) [message ${message.id}, type ${message.type ?? "unknown"}]\n`;
      if (message.editedTimestamp) text += `Edited: ${new Date(message.editedTimestamp).toISOString()}\n`;
      if (message.reference?.messageId) text += `Reply to: ${message.reference.messageId}\n`;
      if (message.content) text += `${message.content}\n`;
      for (const attachment of message.attachments?.values() || []) {
        text += `Attachment: ${attachment.name || "unnamed"} ${attachment.url || attachment.proxyURL}\n`;
      }
      for (const embed of message.embeds || []) {
        text += `Embed: ${JSON.stringify(typeof embed.toJSON === "function" ? embed.toJSON() : embed)}\n`;
      }
      for (const sticker of message.stickers?.values() || []) {
        text += `Sticker: ${sticker.name} (${sticker.id}) ${sticker.url || ""}\n`;
      }
      text += "\n";
      bytes += Buffer.byteLength(text, "utf8");
      checkSize();
      entries.push(text);
    }
    pages.push(entries.join(""));
    before = messages[0].id;
  }

  const attachment = Buffer.from(header + pages.reverse().join(""), "utf8");
  return { attachment: new AttachmentBuilder(attachment, { name: `ticket-${channel.id}.txt` }), latestMessageId };
}

module.exports = { buildTicketTranscript, canArchiveTo, NO_MENTIONS, MAX_TRANSCRIPT_BYTES };
