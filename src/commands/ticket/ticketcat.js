const { ApplicationCommandOptionType, EmbedBuilder } = require("discord.js");
const { NO_MENTIONS } = require("@helpers/ticketTranscript");

/**
 * @type {import("@structures/Command")}
 */
module.exports = {
  name: "ticketcat",
  description: "manage ticket categories",
  category: "TICKET",
  userPermissions: ["ManageGuild"],
  command: {
    enabled: true,
    minArgsCount: 1,
    subcommands: [
      {
        trigger: "list",
        description: "list all ticket categories",
      },
      {
        trigger: "add <category> | <staff_roles>",
        description: "add a ticket category",
      },
      {
        trigger: "remove <category>",
        description: "remove a ticket category",
      },
    ],
  },
  slashCommand: {
    enabled: true,
    ephemeral: true,
    options: [
      {
        name: "list",
        description: "list all ticket categories",
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: "add",
        description: "add a ticket category",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "category",
            description: "the category name",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: "staff_roles",
            description: "the staff roles",
            type: ApplicationCommandOptionType.String,
            required: false,
          },
        ],
      },
      {
        name: "remove",
        description: "remove a ticket category",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "category",
            description: "the category name",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
    ],
  },

  async messageRun(message, args, data) {
    const sub = args[0].toLowerCase();
    let response;

    // list
    if (sub === "list") {
      response = listCategories(data);
    }

    // add
    else if (sub === "add") {
      const split = args.slice(1).join(" ").split("|");
      const category = split[0].trim();
      const staff_roles = split[1]?.trim();
      response = split.length > 2 ? "Use only one | separator between the category and staff roles."
        : await addCategory(message.guild, data, category, staff_roles);
    }

    // remove
    else if (sub === "remove") {
      const category = args.slice(1).join(" ").trim();
      response = await removeCategory(data, category);
    }

    // invalid subcommand
    else {
      response = "Invalid subcommand.";
    }

    await message.safeReply({ ...(typeof response === "string" ? { content: response } : response), allowedMentions: NO_MENTIONS });
  },

  async interactionRun(interaction, data) {
    const sub = interaction.options.getSubcommand();
    let response;

    // list
    if (sub === "list") {
      response = listCategories(data);
    }

    // add
    else if (sub === "add") {
      const category = interaction.options.getString("category");
      const staff_roles = interaction.options.getString("staff_roles");
      response = await addCategory(interaction.guild, data, category, staff_roles);
    }

    // remove
    else if (sub === "remove") {
      const category = interaction.options.getString("category");
      response = await removeCategory(data, category);
    }

    //
    else response = "Invalid subcommand";
    await interaction.editReply({ ...(typeof response === "string" ? { content: response } : response), allowedMentions: NO_MENTIONS });
  },
};

function listCategories(data) {
  const categories = data.settings.ticket.categories;
  if (categories?.length === 0) return "No ticket categories found.";

  const fields = [];
  for (const category of categories) {
    const roleNames = category.staff_roles.map((r) => `<@&${r}>`).join(", ");
    fields.push({ name: category.name, value: `**Staff:** ${roleNames || "None"}` });
  }
  const embed = new EmbedBuilder().setAuthor({ name: "Ticket Categories" }).addFields(fields);
  return { embeds: [embed] };
}

async function addCategory(guild, data, category, staff_roles) {
  category = category?.trim();
  if (!category) return "Invalid usage! Missing category name.";
  if (category.length > 100 || category.includes("|")) return "Category names must be at most 100 characters and cannot contain |.";
  const categories = data.settings.ticket.categories;
  if (categories.find((c) => c.name === category)) return `Category \`${category}\` already exists.`;
  if (categories.length >= 25) return "You can configure at most 25 ticket categories.";

  const tokens = staff_roles?.trim() ? staff_roles.trim().split(/[\s,]+/).filter(Boolean) : [];
  if (staff_roles?.trim() && !tokens.length) return "Invalid staff role. Provide a role ID or mention, or leave the roles empty.";
  const staffRoles = [];
  for (const token of tokens) {
    const id = /^(?:<@&(\d{17,20})>|(\d{17,20}))$/.exec(token)?.slice(1).find(Boolean);
    const role = id && guild.roles.cache.get(id);
    if (token === "@everyone" || id === guild.id || id === guild.roles.everyone.id) return "The @everyone role cannot be ticket staff.";
    if (!role) return "Invalid staff role. Provide existing role IDs or role mentions, separated by commas or spaces.";
    if (role.managed) return "Managed roles cannot be ticket staff. Choose a regular server role.";
    if (!staffRoles.includes(id)) staffRoles.push(id);
  }
  categories.push({ name: category, staff_roles: staffRoles });
  await data.settings.save();
  return `Category \`${category}\` added.`;
}

async function removeCategory(data, category) {
  const categories = data.settings.ticket.categories;
  // check if category exists
  if (!categories.find((c) => c.name === category)) {
    return `Category \`${category}\` does not exist.`;
  }

  data.settings.ticket.categories = categories.filter((c) => c.name !== category);
  await data.settings.save();

  return `Category \`${category}\` removed.`;
}
