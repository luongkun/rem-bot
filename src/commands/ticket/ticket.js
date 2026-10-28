const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ModalBuilder,
  TextInputBuilder,
  ApplicationCommandOptionType,
  ChannelType,
  ButtonStyle,
  TextInputStyle,
  ComponentType,
} = require("discord.js");
const { EMBED_COLORS } = require("@root/config.js");
const { isTicketChannel, closeTicket, closeAllTickets, getCloseStatusMessage } = require("@handlers/ticket");
const { canArchiveTo, NO_MENTIONS } = require("@helpers/ticketTranscript");

/**
 * @type {import("@structures/Command")}
 */
module.exports = {
  name: "ticket",
  description: "various ticketing commands",
  category: "TICKET",
  userPermissions: ["ManageGuild"],
  command: {
    enabled: true,
    minArgsCount: 1,
    subcommands: [
      {
        trigger: "setup <#channel>",
        description: "start an interactive ticket setup",
      },
      {
        trigger: "log <#channel>",
        description: "setup log channel for tickets",
      },
      {
        trigger: "limit <number>",
        description: "set maximum number of concurrent open tickets",
      },
      {
        trigger: "close",
        description: "close the ticket",
      },
      {
        trigger: "closeall",
        description: "close all open tickets",
      },
      {
        trigger: "add <userId|roleId>",
        description: "add user/role to the ticket",
      },
      {
        trigger: "remove <userId|roleId>",
        description: "remove user/role from the ticket",
      },
    ],
  },
  slashCommand: {
    enabled: true,
    ephemeral: true,
    options: [
      {
        name: "setup",
        description: "setup a new ticket message",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "channel",
            description: "the channel where ticket creation message must be sent",
            type: ApplicationCommandOptionType.Channel,
            channelTypes: [ChannelType.GuildText],
            required: true,
          },
        ],
      },
      {
        name: "log",
        description: "setup log channel for tickets",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "channel",
            description: "channel where ticket logs must be sent",
            type: ApplicationCommandOptionType.Channel,
            channelTypes: [ChannelType.GuildText],
            required: true,
          },
        ],
      },
      {
        name: "limit",
        description: "set maximum number of concurrent open tickets",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "amount",
            description: "max number of tickets",
            type: ApplicationCommandOptionType.Integer,
            required: true,
          },
        ],
      },
      {
        name: "close",
        description: "closes the ticket [used in ticket channel only]",
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: "closeall",
        description: "closes all open tickets",
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: "add",
        description: "add user to the current ticket channel [used in ticket channel only]",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "user_id",
            description: "the id of the user to add",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      {
        name: "remove",
        description: "remove user from the ticket channel [used in ticket channel only]",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "user",
            description: "the user to remove",
            type: ApplicationCommandOptionType.User,
            required: true,
          },
        ],
      },
    ],
  },

  async messageRun(message, args, data) {
    const input = args[0].toLowerCase();
    const reply = (content) => message.safeReply({
      ...(typeof content === "string" ? { content } : content), allowedMentions: NO_MENTIONS,
    });
    let response;

    // Setup
    if (input === "setup") {
      if (!message.guild.members.me.permissions.has("ManageChannels")) {
        return reply("I am missing `Manage Channels` to create ticket channels");
      }
      const targetChannel = message.guild.findMatchingChannels(args[1])[0];
      if (!targetChannel) {
        return reply("I could not find channel with that name");
      }
      return ticketModalSetup(message, targetChannel);
    }

    // log ticket
    else if (input === "log") {
      if (args.length < 2) return reply("Please provide a channel where ticket logs must be sent");
      const target = message.guild.findMatchingChannels(args[1]);
      if (target.length === 0) return reply("Could not find any matching channel");
      response = await setupLogChannel(target[0], message.guild, data.settings);
    }

    // Set limit
    else if (input === "limit") {
      if (args.length < 2) return reply("Please provide a number");
      const limit = args[1];
      if (isNaN(limit)) return reply("Please provide a number input");
      response = await setupLimit(limit, data.settings);
    }

    // Close ticket
    else if (input === "close") {
      response = await close(message, message.author);
      if (!response) return;
    }

    // Close all tickets
    else if (input === "closeall") {
      const sent = await reply("Closing tickets ...");
      response = await closeAll(message, message.author);
      const payload = { content: response, allowedMentions: NO_MENTIONS };
      if (sent?.editable) {
        const edited = await sent.edit(payload).catch(() => null);
        if (edited) return edited;
      }
      return message.author.send(payload).catch(() => {});
    }

    // Add user to ticket
    else if (input === "add") {
      if (args.length < 2) return reply("Please provide a user or role to add to the ticket");
      let inputId;
      if (message.mentions.users.size > 0) inputId = message.mentions.users.first().id;
      else if (message.mentions.roles.size > 0) inputId = message.mentions.roles.first().id;
      else inputId = args[1];
      response = await addToTicket(message, inputId);
    }

    // Remove user from ticket
    else if (input === "remove") {
      if (args.length < 2) return reply("Please provide a user or role to remove");
      let inputId;
      if (message.mentions.users.size > 0) inputId = message.mentions.users.first().id;
      else if (message.mentions.roles.size > 0) inputId = message.mentions.roles.first().id;
      else inputId = args[1];
      response = await removeFromTicket(message, inputId);
    }

    // Invalid input
    else {
      return reply("Incorrect command usage");
    }

    if (response) await reply(response);
  },

  async interactionRun(interaction, data) {
    const sub = interaction.options.getSubcommand();
    let response;

    // setup
    if (sub === "setup") {
      const channel = interaction.options.getChannel("channel");

      if (!interaction.guild.members.me.permissions.has("ManageChannels")) {
        return interaction.editReply({ content: "I am missing `Manage Channels` to create ticket channels", allowedMentions: NO_MENTIONS });
      }

      return ticketModalSetup(interaction, channel);
    }

    // Log channel
    else if (sub === "log") {
      const channel = interaction.options.getChannel("channel");
      response = await setupLogChannel(channel, interaction.guild, data.settings);
    }

    // Limit
    else if (sub === "limit") {
      const limit = interaction.options.getInteger("amount");
      response = await setupLimit(limit, data.settings);
    }

    // Close
    else if (sub === "close") {
      response = (await close(interaction, interaction.user)) || getCloseStatusMessage("SUCCESS");
    }

    // Close all
    else if (sub === "closeall") {
      response = await closeAll(interaction, interaction.user);
    }

    // Add to ticket
    else if (sub === "add") {
      const inputId = interaction.options.getString("user_id");
      response = await addToTicket(interaction, inputId);
    }

    // Remove from ticket
    else if (sub === "remove") {
      const user = interaction.options.getUser("user");
      response = await removeFromTicket(interaction, user.id);
    }

    if (response) await interaction.editReply({ content: response, allowedMentions: NO_MENTIONS });
  },
};

function canSetupIn(target, guild) {
  return target?.guild?.id === guild.id && target.type === ChannelType.GuildText &&
    target.permissionsFor(guild.members.me)?.has(["ViewChannel", "SendMessages", "EmbedLinks"]);
}

async function ticketModalSetup(context, targetChannel) {
  const { guild, channel } = context;
  const user = context.user || context.author;
  const respond = (payload) => context.editReply
    ? context.editReply({ ...payload, allowedMentions: NO_MENTIONS })
    : context.safeReply({ ...payload, allowedMentions: NO_MENTIONS });
  if (!canSetupIn(targetChannel, guild)) {
    return respond({ content: "Choose a text channel in this server where I can view, send messages, and embed links." });
  }
  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_btnSetup").setLabel("Setup Message").setStyle(ButtonStyle.Primary)
  );
  const sentMsg = await respond({ content: "Please click the button below to setup ticket message", components: [buttonRow] });
  if (!sentMsg) return;
  const finish = (content) => context.editReply
    ? respond({ content, components: [] })
    : sentMsg.edit({ content, components: [], allowedMentions: NO_MENTIONS });

  const btnInteraction = await sentMsg.awaitMessageComponent({
    componentType: ComponentType.Button,
    filter: (i) => i.customId === "ticket_btnSetup" && i.user.id === user.id && i.message.id === sentMsg.id &&
      i.guildId === guild.id && i.channelId === channel.id,
    time: 20000,
  }).catch(() => null);
  if (!btnInteraction) return finish("No response received, cancelling setup");

  const modalId = `ticket-modalSetup-${sentMsg.id}`;
  await btnInteraction.showModal(new ModalBuilder({
    customId: modalId,
    title: "Ticket Setup",
    components: [
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId("title").setLabel("Embed Title").setStyle(TextInputStyle.Short).setMaxLength(256).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId("description").setLabel("Embed Description").setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId("footer").setLabel("Embed Footer").setStyle(TextInputStyle.Short).setMaxLength(2048).setRequired(false)),
    ],
  }));

  const modal = await btnInteraction.awaitModalSubmit({
    time: 60 * 1000,
    filter: (m) => m.customId === modalId && m.user.id === user.id && m.guildId === guild.id &&
      m.channelId === channel.id && (!m.message || m.message.id === sentMsg.id),
  }).catch(() => null);
  if (!modal) return finish("No response received, cancelling setup");

  await modal.deferReply({ ephemeral: true });
  await finish("Setup form received.");
  const reply = (content) => modal.editReply({ content, allowedMentions: NO_MENTIONS });
  const title = modal.fields.getTextInputValue("title") || "Support Ticket";
  const description = modal.fields.getTextInputValue("description") || "Please use the button below to create a ticket";
  const footer = modal.fields.getTextInputValue("footer") || "You can only have 1 open ticket at a time!";
  if (title.length > 256 || description.length > 4000 || footer.length > 2048 || title.length + description.length + footer.length > 6000) {
    return reply("The message is too long. Use at most 256 title, 4000 description, 2048 footer, and 6000 total characters.");
  }
  if (!canSetupIn(targetChannel, guild)) return reply("The target channel is no longer writable. Please run setup again.");

  try {
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLORS.BOT_EMBED)
      .setAuthor({ name: title })
      .setDescription(description)
      .setFooter({ text: footer });
    const tktBtnRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("Open a ticket").setCustomId("TICKET_CREATE").setStyle(ButtonStyle.Success)
    );
    await targetChannel.send({ embeds: [embed], components: [tktBtnRow], allowedMentions: NO_MENTIONS });
    return reply("Done! Ticket Message Created");
  } catch (ex) {
    return reply("Could not send the ticket message. Check my permissions and try again.");
  }
}

async function setupLogChannel(target, guild, settings) {
  if (!(await canArchiveTo(target, guild, settings))) {
    return "Choose a private text channel visible only to me, configured ticket staff, and members with Manage Server or Administrator. Configure staff categories first. I need View Channel, Send Messages, Embed Links, and Attach Files. Ticket channels cannot be used as logs.";
  }
  settings.ticket.log_channel = target.id;
  await settings.save();
  return `Configuration saved! Ticket logs will be sent to <#${target.id}>`;
}

async function setupLimit(limit, settings) {
  limit = Number(limit);
  if (!Number.isSafeInteger(limit) || limit < 5) return "Ticket limit must be a whole number of at least 5";
  settings.ticket.limit = limit;
  await settings.save();
  return `Configuration saved. You can now have a maximum of \`${limit}\` open tickets`;
}

async function close({ channel }, author) {
  const status = await closeTicket(channel, author, "Closed by command");
  return status === "SUCCESS" ? null : getCloseStatusMessage(status);
}

async function closeAll({ guild }, user) {
  const stats = await closeAllTickets(guild, user);
  return `Completed! Success: \`${stats[0]}\` Failed: \`${stats[1]}\``;
}

async function addToTicket({ channel }, inputId) {
  if (!isTicketChannel(channel)) return "This command can only be used in ticket channel";
  if (!inputId || isNaN(inputId)) return "Oops! You need to input a valid userId/roleId";

  try {
    await channel.permissionOverwrites.create(inputId, {
      ViewChannel: true,
      SendMessages: true,
    });

    return "Done";
  } catch (ex) {
    return "Failed to add user/role. Did you provide a valid ID?";
  }
}

async function removeFromTicket({ channel }, inputId) {
  if (!isTicketChannel(channel)) return "This command can only be used in ticket channel";
  if (!inputId || isNaN(inputId)) return "Oops! You need to input a valid userId/roleId";

  try {
    await channel.permissionOverwrites.create(inputId, {
      ViewChannel: false,
      SendMessages: false,
    });
    return "Done";
  } catch (ex) {
    return "Failed to remove user/role. Did you provide a valid ID?";
  }
}
