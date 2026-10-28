const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Collection, ChannelType, PermissionsBitField, OverwriteType } = require("discord.js");

const root = path.resolve(__dirname, "..");
require("module-alias").addAliases({
  "@root": root,
  "@handlers": path.join(root, "src/handlers"),
  "@helpers": path.join(root, "src/helpers"),
  "@schemas": path.join(root, "src/database/schemas"),
});
const stubs = {
  "config.js": { TICKET: { CREATE_EMBED: "#123456", CLOSE_EMBED: "#123456" }, EMBED_COLORS: { BOT_EMBED: "#123456" } },
  "src/database/schemas/Guild.js": { getSettings: async (guild) => {
    if (guild.settingsError) throw new Error("database unavailable");
    return guild.testSettings;
  } },
  "src/helpers/Logger.js": { error() {} },
};
const previous = new Map();
for (const [relative, exports] of Object.entries(stubs)) {
  const filename = path.join(root, relative);
  previous.set(filename, require.cache[filename]);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
const handler = require("../src/handlers/ticket");
const command = require("../src/commands/ticket/ticket");
const categoryCommand = require("../src/commands/ticket/ticketcat");
const { buildTicketTranscript, canArchiveTo, MAX_TRANSCRIPT_BYTES, NO_MENTIONS } = require("../src/helpers/ticketTranscript");
for (const [filename, cached] of previous) {
  if (cached) require.cache[filename] = cached;
  else delete require.cache[filename];
}

const OWNER = "100000000000000001";
const OTHER = "100000000000000002";
const STAFF = "100000000000000003";
const BOT = "100000000000000004";
const ROLE = "200000000000000001";
const MANAGED = "200000000000000002";
let sequence = 300000000000000000n;
const nextId = () => String(++sequence);
const permissions = (names = []) => new PermissionsBitField(names);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const user = (id) => ({ id, username: `user-${id}`, toString: () => `<@${id}>` });
const WRITE_PERMS = ["SendMessages", "CreatePublicThreads", "CreatePrivateThreads", "SendMessagesInThreads"];
const overwrite = (id, type, allow = [], deny = []) => ({
  id, type, allow: permissions(allow).freeze(), deny: permissions(deny).freeze(),
});
const snapshotOverwrites = (channel) => channel.permissionOverwrites.cache.map(({ id, type, allow, deny }) => ({
  id, type, allow: allow.bitfield, deny: deny.bitfield,
}));

function effectivePermissions(channel, subject) {
  const everyone = channel.guild.roles.everyone;
  const isRole = channel.guild.roles.cache.get(subject.id) === subject;
  const roles = isRole ? [subject] : [...subject.roles.cache.values()];
  const result = permissions(everyone.permissions);
  for (const role of roles) result.add(role.permissions);
  if (result.has("Administrator")) return permissions(PermissionsBitField.All);
  const overwrites = channel.permissionOverwrites.cache;
  const apply = (entry) => { if (entry) result.remove(entry.deny).add(entry.allow); };
  apply(overwrites.get(everyone.id));
  const roleOverwrites = roles.filter((role) => role.id !== everyone.id).map((role) => overwrites.get(role.id)).filter(Boolean);
  for (const entry of roleOverwrites) result.remove(entry.deny);
  for (const entry of roleOverwrites) result.add(entry.allow);
  if (!isRole) apply(overwrites.get(subject.id));
  return result;
}

function fixture(withTicket = true) {
  const events = [];
  const sentLogs = [];
  const created = [];
  const overwriteCalls = [];
  const memberFetches = [];
  const guild = { id: nextId(), name: "Private support", iconURL: () => null };
  const allBotPerms = permissions(["ViewChannel", "ManageChannels", "ManageRoles", "ReadMessageHistory", "EmbedLinks", "AttachFiles", ...WRITE_PERMS]);
  const everyone = { id: guild.id, managed: false, permissions: permissions(["ViewChannel", "ReadMessageHistory", ...WRITE_PERMS]) };
  const staffRole = { id: ROLE, managed: false, permissions: permissions() };
  const botRole = { id: MANAGED, managed: true, tags: { botId: BOT }, permissions: allBotPerms };
  guild.roles = { everyone, cache: new Collection([[guild.id, everyone], [ROLE, staffRole], [MANAGED, botRole]]) };
  const members = new Collection();
  for (const id of [OWNER, OTHER, STAFF]) {
    members.set(id, { id, permissions: permissions(), roles: { cache: new Collection() } });
  }
  members.get(STAFF).roles.cache.set(ROLE, staffRole);
  guild.members = {
    me: { id: BOT, permissions: allBotPerms, roles: { highest: botRole, cache: new Collection([[MANAGED, botRole]]) } },
    fetch: async (id) => {
      memberFetches.push(id);
      if (!members.has(id)) throw new Error("unknown member");
      return members.get(id);
    },
  };
  const logChannel = {
    id: nextId(), guild, type: ChannelType.GuildText, topic: null,
    permissionOverwrites: { cache: new Collection([
      [guild.id, overwrite(guild.id, OverwriteType.Role, [], ["ViewChannel"])],
      [ROLE, overwrite(ROLE, OverwriteType.Role, ["ViewChannel"])],
      [MANAGED, overwrite(MANAGED, OverwriteType.Role, ["ViewChannel"])],
      [BOT, overwrite(BOT, OverwriteType.Member, ["ViewChannel"])],
    ]) },
    permissionsFor: (subject) => effectivePermissions(logChannel, subject),
    send: async (payload) => {
      payload.embeds?.forEach((embed) => embed.toJSON());
      sentLogs.push(payload);
      events.push("archive");
      return { id: nextId() };
    },
  };
  const ticket = {
    id: nextId(), name: "tіcket-1", type: ChannelType.GuildText, topic: `tіcket|${OWNER}|Support`, guild,
    deletable: true, deleted: false, permissionsFor: (subject) => effectivePermissions(ticket, subject),
    permissionOverwrites: {
      cache: new Collection([
        [guild.id, overwrite(guild.id, OverwriteType.Role, [], ["ViewChannel"])],
        [OWNER, overwrite(OWNER, OverwriteType.Member, ["ViewChannel", "SendMessages", "ReadMessageHistory"])],
        [ROLE, overwrite(ROLE, OverwriteType.Role, ["ViewChannel", "SendMessages", "ReadMessageHistory"])],
        [BOT, overwrite(BOT, OverwriteType.Member, ["ViewChannel", "SendMessages", "ReadMessageHistory", "EmbedLinks", "AttachFiles"])],
      ]),
      set: async (entries) => {
        const cache = new Collection(entries.map((entry) => [entry.id, overwrite(entry.id, entry.type, entry.allow, entry.deny)]));
        overwriteCalls.push(cache.map(({ id, type, allow, deny }) => ({ id, type, allow: allow.bitfield, deny: deny.bitfield })));
        ticket.permissionOverwrites.cache = cache;
        return ticket;
      },
    },
    messages: { fetch: async () => new Collection() },
    client: { users: { fetch: async () => ({ send: async (payload) => { events.push("dm"); assert.deepEqual(payload.allowedMentions, NO_MENTIONS); } }) } },
    delete: async () => { events.push("delete"); ticket.deleted = true; guild.channels.cache.delete(ticket.id); },
  };
  guild.channels = {
    cache: new Collection([[logChannel.id, logChannel], ...(withTicket ? [[ticket.id, ticket]] : [])]),
    fetch: async (id) => guild.channels.cache.get(id) || null,
    create: async (options) => {
      const channel = {
        ...options, id: nextId(), guild, deleted: false,
        send: async (payload) => {
          payload.embeds?.forEach((embed) => embed.toJSON());
          payload.components?.forEach((component) => component.toJSON());
          assert.deepEqual(payload.allowedMentions, NO_MENTIONS);
          return { id: nextId() };
        },
        delete: async () => { channel.deleted = true; },
      };
      created.push(channel);
      guild.channels.cache.set(channel.id, channel);
      return channel;
    },
  };
  const settings = { ticket: { limit: 10, categories: [{ name: "Support", staff_roles: [ROLE] }], log_channel: logChannel.id }, save: async () => {} };
  guild.testSettings = settings;
  return { guild, ticket, logChannel, settings, members, events, sentLogs, created, allBotPerms, overwriteCalls, memberFetches };
}

function message(number, content = `message-${number}`) {
  return {
    id: String(400000000000000000n + BigInt(number)), createdTimestamp: 1700000000000 + number * 1000,
    author: { id: OWNER, username: "Support user", tag: "Support user" }, type: 0, content,
    attachments: new Collection(), embeds: [], stickers: new Collection(),
  };
}

function useMessages(channel, messages) {
  const calls = [];
  channel.messages.fetch = async (options) => {
    calls.push(options);
    const batch = messages.filter((entry) => !options.before || BigInt(entry.id) < BigInt(options.before))
      .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0, options.limit);
    return new Collection(batch.map((entry) => [entry.id, entry]));
  };
  return calls;
}

function opening(f, id = OWNER, choose) {
  const replies = [];
  const interaction = {
    guild: f.guild, guildId: f.guild.id, user: user(id), channelId: f.logChannel.id,
    channel: { awaitMessageComponent() { assert.fail("collector must be message scoped"); } },
    deferReply: async (options) => { assert.equal(options.ephemeral, true); },
    editReply: async (payload) => {
      replies.push(payload);
      payload.components?.forEach((row) => row.toJSON());
      assert.deepEqual(payload.allowedMentions, NO_MENTIONS);
      return prompt;
    },
  };
  const choice = {
    customId: "ticket-menu", user: interaction.user, guildId: f.guild.id, channelId: interaction.channelId,
    values: ["Support"], message: { id: nextId() }, acknowledged: false,
    deferUpdate: async () => { choice.acknowledged = true; },
  };
  const prompt = {
    id: choice.message.id,
    awaitMessageComponent: async (options) => choose ? choose(options, choice) : choice,
  };
  return { interaction, replies, choice, prompt };
}

function commandInteraction(f, sub, channel = f.logChannel, id = OWNER) {
  const replies = [];
  const interaction = {
    guild: f.guild, guildId: f.guild.id, channel: f.logChannel, user: user(id),
    options: { getSubcommand: () => sub, getChannel: () => channel, getInteger: () => 10 },
    editReply: async (payload) => { replies.push(payload); },
  };
  return { interaction, replies };
}

const lastContent = (replies) => replies.at(-1).content;

test("transcript paginates every message and preserves UTF-8, attachments, embeds and replies", async () => {
  const f = fixture();
  const messages = Array.from({ length: 251 }, (_, index) => message(index + 1));
  messages[0].content = "Tiếng Việt @everyone <@100000000000000001>";
  messages[0].attachments.set("file", { name: "private.txt", url: "https://cdn.discordapp.com/private.txt" });
  messages[0].embeds.push({ toJSON: () => ({ description: "embedded content" }) });
  messages[1].reference = { messageId: messages[0].id };
  const calls = useMessages(f.ticket, messages);
  const { attachment, latestMessageId } = await buildTicketTranscript(f.ticket);
  assert.equal(latestMessageId, messages[250].id);
  assert.equal(attachment.name, `ticket-${f.ticket.id}.txt`);
  const text = attachment.attachment.toString("utf8");
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.limit === 100 && call.cache === false));
  assert.equal(calls[1].before, messages[151].id);
  assert.equal((text.match(/\[message /g) || []).length, 251);
  assert.ok(text.indexOf(messages[0].content) < text.indexOf("message-251"));
  assert.match(text, /private\.txt/);
  assert.match(text, /embedded content/);
  assert.match(text, /Reply to:/);
});

test("transcript aborts on UTF-8 byte overflow and repeated pagination", async () => {
  const f = fixture();
  useMessages(f.ticket, [message(1, "é".repeat(100))]);
  await assert.rejects(buildTicketTranscript(f.ticket, 250), { code: "TRANSCRIPT_TOO_LARGE" });
  f.ticket.messages.fetch = async () => new Collection([["1", message(1)]]);
  await assert.rejects(buildTicketTranscript(f.ticket), /pagination did not advance/);
});

test("log privacy rejects a visible Member role, unrelated bot role, and explicit nonstaff member", async (t) => {
  for (const scenario of ["Member role", "unrelated bot role", "nonstaff member"]) {
    await t.test(scenario, async () => {
      const f = fixture();
      if (scenario === "nonstaff member") {
        f.logChannel.permissionOverwrites.cache.set(OWNER, overwrite(OWNER, OverwriteType.Member, ["ViewChannel"]));
      } else {
        const id = nextId();
        const role = { id, name: "Member", managed: scenario === "unrelated bot role", tags: { botId: OTHER }, permissions: permissions(["ViewChannel"]) };
        f.guild.roles.cache.set(id, role);
        f.logChannel.permissionOverwrites.cache.set(id, overwrite(id, OverwriteType.Role, ["ViewChannel"]));
        assert.equal(f.logChannel.permissionsFor(role).has("ViewChannel"), true);
      }
      assert.equal(f.logChannel.permissionsFor(f.guild.roles.everyone).has("ViewChannel"), false);
      assert.equal(await canArchiveTo(f.logChannel, f.guild, f.settings), false);
      assert.deepEqual(f.memberFetches, scenario === "nonstaff member" ? [OWNER] : []);
      assert.equal(await handler.closeTicket(f.ticket, user(OWNER)), "LOG_UNAVAILABLE");
      assert.deepEqual(f.overwriteCalls, []);
      assert.deepEqual(f.events, []);
      let saves = 0;
      f.settings.save = async () => { saves++; };
      const c = commandInteraction(f, "log");
      await command.interactionRun(c.interaction, { settings: f.settings });
      assert.equal(saves, 0);
      assert.match(lastContent(c.replies), /configured ticket staff/);
    });
  }
});

test("log privacy allows configured staff across categories, the bot, and server managers", async (t) => {
  for (const scenario of ["staff role in another category", "staff member", "bot", "Administrator role", "ManageGuild role", "Administrator member", "ManageGuild member"]) {
    await t.test(scenario, async () => {
      const f = fixture();
      if (scenario === "staff role in another category") {
        f.settings.ticket.categories = [{ name: "Support", staff_roles: [] }, { name: "Billing", staff_roles: [ROLE] }];
      } else if (scenario.endsWith("role")) {
        const id = nextId();
        f.guild.roles.cache.set(id, { id, managed: false, permissions: permissions([scenario.split(" ")[0]]) });
        f.logChannel.permissionOverwrites.cache.set(id, overwrite(id, OverwriteType.Role, ["ViewChannel"]));
      } else if (scenario.endsWith("member")) {
        const id = scenario === "staff member" ? STAFF : OTHER;
        if (id === OTHER) f.members.get(id).permissions = permissions([scenario.split(" ")[0]]);
        f.logChannel.permissionOverwrites.cache.set(id, overwrite(id, OverwriteType.Member, ["ViewChannel"]));
      }
      assert.equal(await canArchiveTo(f.logChannel, f.guild, f.settings), true);
      assert.deepEqual(f.memberFetches, scenario.endsWith("member") ? [scenario === "staff member" ? STAFF : OTHER] : []);
      // Both consumers must pass the staff configuration and await the privacy check.
      let saves = 0;
      f.settings.save = async () => { saves++; };
      await command.interactionRun(commandInteraction(f, "log").interaction, { settings: f.settings });
      assert.equal(saves, 1);
      assert.equal(await handler.closeTicket(f.ticket, user(OWNER)), "SUCCESS");
    });
  }
});

test("log permission uncertainty and member fetch failures fail closed", async (t) => {
  const cases = {
    "missing effective role permissions": (f) => {
      const resolve = f.logChannel.permissionsFor;
      f.logChannel.permissionsFor = (subject) => subject.id === ROLE ? null : resolve(subject);
    },
    "permission check throws": (f) => { f.logChannel.permissionsFor = () => { throw new Error("unavailable"); }; },
    "missing guild role permissions": (f) => { f.guild.roles.cache.get(ROLE).permissions = null; },
    "missing overwrite cache": (f) => { f.logChannel.permissionOverwrites.cache = null; },
    "missing overwrite permissions": (f) => { f.logChannel.permissionOverwrites.cache.get(BOT).allow = null; },
    "unknown role overwrite": (f) => {
      const id = nextId();
      f.logChannel.permissionOverwrites.cache.set(id, overwrite(id, OverwriteType.Role, ["ViewChannel"]));
    },
    "missing staff settings": (f) => { f.settings.ticket.categories = null; },
    "missing member permissions": (f) => { f.members.get(STAFF).permissions = null; },
    "missing member roles": (f) => { f.members.get(STAFF).roles = null; },
    "member fetch failure": (f) => { f.members.delete(STAFF); },
  };
  for (const [scenario, change] of Object.entries(cases)) {
    await t.test(scenario, async () => {
      const f = fixture();
      f.logChannel.permissionOverwrites.cache.set(STAFF, overwrite(STAFF, OverwriteType.Member, ["ViewChannel"]));
      change(f);
      assert.equal(await canArchiveTo(f.logChannel, f.guild, f.settings), false);
      assert.equal(await handler.closeTicket(f.ticket, user(OWNER)), "LOG_UNAVAILABLE");
      assert.deepEqual(f.overwriteCalls, []);
      assert.deepEqual(f.events, []);
    });
  }
});

test("closing freezes every writer and waits for Discord acknowledgement before fetching history", async () => {
  const f = fixture();
  f.ticket.permissionOverwrites.cache.set(OTHER, overwrite(OTHER, OverwriteType.Member, ["ViewChannel", ...WRITE_PERMS], ["AttachFiles"]));
  f.ticket.permissionOverwrites.cache.set(ROLE, overwrite(ROLE, OverwriteType.Role, ["ViewChannel", ...WRITE_PERMS], ["MentionEveryone"]));
  const original = snapshotOverwrites(f.ticket);
  const cached = f.ticket.permissionOverwrites.cache;
  const started = deferred();
  const allowFreeze = deferred();
  let acknowledged = false;
  const set = f.ticket.permissionOverwrites.set;
  f.ticket.permissionOverwrites.set = async (entries) => {
    started.resolve();
    await allowFreeze.promise;
    const result = await set(entries);
    acknowledged = true;
    return result;
  };
  const calls = useMessages(f.ticket, [message(1)]);
  const fetch = f.ticket.messages.fetch;
  f.ticket.messages.fetch = async (options) => {
    assert.equal(acknowledged, true);
    for (const entry of f.ticket.permissionOverwrites.cache.values()) {
      if (entry.id === BOT) continue;
      assert.equal(entry.allow.any(WRITE_PERMS, false), false);
      assert.equal(entry.deny.has(WRITE_PERMS, false), true);
    }
    for (const id of [OWNER, OTHER, STAFF]) assert.equal(f.ticket.permissionsFor(f.members.get(id)).any(WRITE_PERMS), false);
    assert.equal(f.ticket.permissionOverwrites.cache.get(OTHER).deny.has("AttachFiles"), true);
    assert.equal(f.ticket.permissionOverwrites.cache.get(ROLE).deny.has("MentionEveryone"), true);
    assert.equal(f.ticket.permissionsFor(f.guild.members.me).has("SendMessages"), true);
    return fetch(options);
  };
  const closing = handler.closeTicket(f.ticket, user(OWNER));
  await started.promise;
  assert.equal(calls.length, 0);
  assert.deepEqual(snapshotOverwrites(f.ticket), original);
  assert.equal(await handler.closeTicket(f.ticket, user(OWNER)), "ALREADY_CLOSING");
  allowFreeze.resolve();
  assert.equal(await closing, "SUCCESS");
  assert.equal(f.overwriteCalls.length, 1);
  assert.deepEqual(calls.at(-1), { limit: 1, cache: false });
  assert.deepEqual(cached.map(({ id, type, allow, deny }) => ({ id, type, allow: allow.bitfield, deny: deny.bitfield })), original);
});

test("closing awaits successful Discord archive before deleting, then DMs the same file", async () => {
  const f = fixture();
  useMessages(f.ticket, [message(1)]);
  const started = deferred();
  const allowArchive = deferred();
  const send = f.logChannel.send;
  f.logChannel.send = async (payload) => { started.resolve(); await allowArchive.promise; return send(payload); };
  const closing = handler.closeTicket(f.ticket, user(OWNER), "@everyone close");
  await started.promise;
  assert.equal(f.ticket.deleted, false);
  assert.deepEqual(f.events, []);
  allowArchive.resolve();
  assert.equal(await closing, "SUCCESS");
  assert.deepEqual(f.events, ["archive", "delete", "dm"]);
  assert.deepEqual(f.sentLogs[0].allowedMentions, NO_MENTIONS);
  assert.equal(f.sentLogs[0].files[0].name, `ticket-${f.ticket.id}.txt`);
});

test("missing, public, foreign, non-text and unwritable log channels preserve tickets", async (t) => {
  const cases = {
    missing: (f) => { f.settings.ticket.log_channel = null; },
    deleted: (f) => { f.guild.channels.cache.delete(f.logChannel.id); },
    public: (f) => { f.logChannel.permissionsFor = () => f.allBotPerms; },
    foreign: (f) => { f.logChannel.guild = { id: nextId() }; },
    voice: (f) => { f.logChannel.type = ChannelType.GuildVoice; },
    attachments: (f) => { f.logChannel.permissionsFor = () => permissions(["ViewChannel", "SendMessages", "EmbedLinks"]); },
    historyChannel: (f) => { f.settings.ticket.log_channel = f.ticket.id; },
  };
  for (const [name, change] of Object.entries(cases)) {
    await t.test(name, async () => {
      const f = fixture();
      change(f);
      assert.equal(await handler.closeTicket(f.ticket, user(OWNER)), "LOG_UNAVAILABLE");
      assert.equal(f.ticket.deleted, false);
      assert.deepEqual(f.events, []);
    });
  }
});

test("archive upload and partial history fetch failures never delete and release close lock", async (t) => {
  for (const failure of ["upload", "history"]) {
    await t.test(failure, async () => {
      const f = fixture();
      const original = snapshotOverwrites(f.ticket);
      if (failure === "upload") f.logChannel.send = async () => { throw new Error("upload failed"); };
      else {
        let pages = 0;
        f.ticket.messages.fetch = async () => {
          if (pages++) throw new Error("history unavailable");
          return new Collection([["1", message(1)]]);
        };
      }
      assert.equal(await handler.closeTicket(f.ticket, user(OWNER)), "ARCHIVE_FAILED");
      assert.equal(f.ticket.deleted, false);
      assert.deepEqual(f.events, []);
      assert.equal(f.overwriteCalls.length, 2);
      assert.deepEqual(f.overwriteCalls[1], original);
      assert.deepEqual(snapshotOverwrites(f.ticket), original);
      f.settings.ticket.log_channel = null;
      assert.equal(await handler.closeTicket(f.ticket, user(OWNER)), "LOG_UNAVAILABLE");
    });
  }
});

test("oversized transcript preserves the channel without sending a partial archive", async () => {
  const f = fixture();
  const original = snapshotOverwrites(f.ticket);
  useMessages(f.ticket, [message(1, "é".repeat(MAX_TRANSCRIPT_BYTES / 2 + 1))]);
  assert.equal(await handler.closeTicket(f.ticket, user(OWNER)), "TRANSCRIPT_TOO_LARGE");
  assert.equal(f.ticket.deleted, false);
  assert.deepEqual(f.events, []);
  assert.equal(f.overwriteCalls.length, 2);
  assert.deepEqual(snapshotOverwrites(f.ticket), original);
});

test("delete failure reports an existing archive and no owner DM", async () => {
  const f = fixture();
  const original = snapshotOverwrites(f.ticket);
  f.ticket.delete = async () => { throw new Error("no permission"); };
  assert.equal(await handler.closeTicket(f.ticket, user(OWNER)), "DELETE_FAILED");
  assert.deepEqual(f.events, ["archive"]);
  assert.equal(f.ticket.deleted, false);
  assert.equal(f.overwriteCalls.length, 2);
  assert.deepEqual(f.overwriteCalls[1], original);
  assert.deepEqual(snapshotOverwrites(f.ticket), original);
});

test("messages arriving during pagination or upload preserve the ticket and restore permissions", async (t) => {
  for (const phase of ["pagination", "upload", "empty upload"]) {
    await t.test(phase, async () => {
      const f = fixture();
      const original = snapshotOverwrites(f.ticket);
      const messages = phase === "empty upload" ? [] : Array.from({ length: 105 }, (_, index) => message(index + 1));
      const late = message(999, "late administrator message");
      const calls = useMessages(f.ticket, messages);
      const fetch = f.ticket.messages.fetch;
      let injected = false;
      f.ticket.messages.fetch = async (options) => {
        if (phase === "pagination" && options.before && !injected) {
          messages.push(late);
          injected = true;
        }
        return fetch(options);
      };
      const send = f.logChannel.send;
      f.logChannel.send = async (payload) => {
        assert.doesNotMatch(payload.files[0].attachment.toString("utf8"), /late administrator message/);
        if (phase !== "pagination") messages.push(late);
        return send(payload);
      };
      assert.equal(await handler.closeTicket(f.ticket, user(OWNER)), "SNAPSHOT_CHANGED");
      assert.deepEqual(calls.at(-1), { limit: 1, cache: false });
      assert.equal(f.ticket.deleted, false);
      assert.deepEqual(f.events, ["archive"]);
      assert.deepEqual(snapshotOverwrites(f.ticket), original);
      assert.equal(f.overwriteCalls.length, 2);
      assert.match(handler.getCloseStatusMessage("SNAPSHOT_CHANGED"), /channel was kept/);
    });
  }
});

test("failure to verify the latest message retains the archived channel and restores permissions", async () => {
  const f = fixture();
  const original = snapshotOverwrites(f.ticket);
  useMessages(f.ticket, [message(1)]);
  const fetch = f.ticket.messages.fetch;
  f.ticket.messages.fetch = async (options) => {
    if (options.limit === 1) throw new Error("latest message unavailable");
    return fetch(options);
  };
  assert.equal(await handler.closeTicket(f.ticket, user(OWNER)), "SNAPSHOT_CHECK_FAILED");
  assert.deepEqual(f.events, ["archive"]);
  assert.deepEqual(snapshotOverwrites(f.ticket), original);
  assert.equal(f.ticket.deleted, false);
});

test("missing ManageRoles leaves the ticket unchanged without fetching history", async () => {
  const f = fixture();
  const original = snapshotOverwrites(f.ticket);
  f.ticket.permissionsFor = () => permissions(f.allBotPerms).remove("ManageRoles");
  f.ticket.messages.fetch = async () => assert.fail("must not fetch history");
  assert.equal(await handler.closeTicket(f.ticket, user(OWNER)), "MISSING_PERMISSIONS");
  assert.match(handler.getCloseStatusMessage("MISSING_PERMISSIONS"), /Manage Roles/);
  assert.deepEqual(f.overwriteCalls, []);
  assert.deepEqual(snapshotOverwrites(f.ticket), original);
  assert.deepEqual(f.events, []);
  assert.equal(f.ticket.deleted, false);
});

test("failed or unacknowledged freeze never archives and restores the original overwrites", async (t) => {
  for (const failure of ["rejected", "unacknowledged"]) {
    await t.test(failure, async () => {
      const f = fixture();
      const original = snapshotOverwrites(f.ticket);
      const set = f.ticket.permissionOverwrites.set;
      let attempts = 0;
      f.ticket.permissionOverwrites.set = async (entries) => {
        const result = await set(entries);
        if (++attempts === 1) {
          if (failure === "rejected") throw new Error("request failed after reaching Discord");
          return null;
        }
        return result;
      };
      f.ticket.messages.fetch = async () => assert.fail("must not fetch before freeze acknowledgement");
      assert.equal(await handler.closeTicket(f.ticket, user(OWNER)), "FREEZE_FAILED");
      assert.deepEqual(snapshotOverwrites(f.ticket), original);
      assert.equal(attempts, 2);
      assert.deepEqual(f.events, []);
      assert.equal(f.ticket.deleted, false);
    });
  }
});

test("freeze adds a missing everyone overwrite and rollback removes it", async () => {
  const f = fixture();
  f.ticket.permissionOverwrites.cache.delete(f.guild.id);
  const original = snapshotOverwrites(f.ticket);
  f.logChannel.send = async () => {
    assert.equal(f.ticket.permissionOverwrites.cache.get(f.guild.id).deny.has(WRITE_PERMS), true);
    throw new Error("upload failed");
  };
  assert.equal(await handler.closeTicket(f.ticket, user(OWNER)), "ARCHIVE_FAILED");
  assert.deepEqual(snapshotOverwrites(f.ticket), original);
  assert.equal(f.ticket.deleted, false);
});

test("rollback failure reports the original failure and inability to restore permissions", async (t) => {
  for (const failure of ["archive", "delete", "snapshot"]) {
    await t.test(failure, async () => {
      const f = fixture();
      const set = f.ticket.permissionOverwrites.set;
      let attempts = 0;
      f.ticket.permissionOverwrites.set = async (entries) => {
        if (++attempts === 2) throw new Error("cannot restore permissions");
        return set(entries);
      };
      if (failure === "archive") f.logChannel.send = async () => { throw new Error("upload failed"); };
      if (failure === "delete") f.ticket.delete = async () => { throw new Error("delete failed"); };
      if (failure === "snapshot") {
        const messages = [message(1)];
        useMessages(f.ticket, messages);
        const send = f.logChannel.send;
        f.logChannel.send = async (payload) => { messages.push(message(2)); return send(payload); };
      }
      const expected = { archive: "ARCHIVE_FAILED", delete: "DELETE_FAILED", snapshot: "SNAPSHOT_CHANGED" }[failure];
      const status = await handler.closeTicket(f.ticket, user(OWNER));
      assert.equal(status, `${expected}_RESTORE_FAILED`);
      assert.match(handler.getCloseStatusMessage(status), /Original ticket permissions could not be restored/);
      assert.ok(handler.getCloseStatusMessage(status).startsWith(handler.getCloseStatusMessage(expected)));
      assert.equal(f.ticket.deleted, false);
      assert.deepEqual(f.events, failure === "archive" ? [] : ["archive"]);
      f.settings.ticket.log_channel = null;
      assert.equal(await handler.closeTicket(f.ticket, user(OWNER)), "LOG_UNAVAILABLE");
    });
  }
});

test("close lock remains held until permission restoration is acknowledged", async () => {
  const f = fixture();
  const original = snapshotOverwrites(f.ticket);
  const started = deferred();
  const allowRestore = deferred();
  const set = f.ticket.permissionOverwrites.set;
  let attempts = 0;
  f.ticket.permissionOverwrites.set = async (entries) => {
    if (++attempts === 2) { started.resolve(); await allowRestore.promise; }
    return set(entries);
  };
  f.logChannel.send = async () => { throw new Error("upload failed"); };
  const closing = handler.closeTicket(f.ticket, user(OWNER));
  await started.promise;
  assert.equal(await handler.closeTicket(f.ticket, user(OWNER)), "ALREADY_CLOSING");
  allowRestore.resolve();
  assert.equal(await closing, "ARCHIVE_FAILED");
  assert.deepEqual(snapshotOverwrites(f.ticket), original);
});

test("close authorization allows owner, category staff and ManageGuild only", async (t) => {
  for (const id of [OWNER, STAFF, OTHER]) {
    await t.test(`allowed ${id}`, async () => {
      const f = fixture();
      if (id === OTHER) f.members.get(id).permissions = permissions(["ManageGuild"]);
      assert.equal(await handler.closeTicket(f.ticket, user(id)), "SUCCESS");
    });
  }
  for (const scenario of ["outsider", "different category", "managed staff", "everyone staff", "departed member"]) {
    await t.test(scenario, async () => {
      const f = fixture();
      let id = OTHER;
      if (scenario === "different category") { id = STAFF; f.ticket.topic = `tіcket|${OWNER}|Other`; }
      if (scenario === "managed staff") { id = STAFF; f.guild.roles.cache.get(ROLE).managed = true; }
      if (scenario === "everyone staff") { f.settings.ticket.categories[0].staff_roles = [f.guild.id]; f.members.get(id).roles.cache.set(f.guild.id, f.guild.roles.everyone); }
      if (scenario === "departed member") f.members.delete(id);
      assert.equal(await handler.closeTicket(f.ticket, user(id)), "UNAUTHORIZED");
      assert.equal(f.ticket.deleted, false);
      assert.deepEqual(f.events, []);
    });
  }
});

test("non-ticket close and missing bot permissions are rejected centrally", async () => {
  const f = fixture();
  assert.equal(await handler.closeTicket(f.logChannel, user(OWNER)), "NOT_TICKET");
  assert.equal(handler.isTicketChannel({ ...f.ticket, topic: "tіcket|garbage|Support" }), false);
  f.ticket.permissionsFor = () => permissions(["ManageChannels"]);
  assert.equal(await handler.closeTicket(f.ticket, user(OWNER)), "MISSING_PERMISSIONS");
  assert.equal(f.ticket.deleted, false);
});

test("close button and slash command finish deferred replies for success and authorization errors", async () => {
  for (const id of [OWNER, OTHER]) {
    const f = fixture();
    const c = commandInteraction(f, "close", null, id);
    c.interaction.channel = f.ticket;
    c.interaction.deferReply = async ({ ephemeral }) => assert.equal(ephemeral, true);
    await handler.handleTicketClose(c.interaction);
    assert.match(lastContent(c.replies), id === OWNER ? /archived and closed/ : /Only the ticket owner/);
    assert.deepEqual(c.replies[0].allowedMentions, NO_MENTIONS);
  }
  for (const id of [OWNER, OTHER]) {
    const f = fixture();
    const c = commandInteraction(f, "close", null, id);
    c.interaction.channel = f.ticket;
    await command.interactionRun(c.interaction, { settings: f.settings });
    assert.match(lastContent(c.replies), id === OWNER ? /archived and closed/ : /Only the ticket owner/);
  }
  assert.equal(command.slashCommand.ephemeral, true);
});

test("category collector is prompt-, user-, customId-, guild- and channel-scoped and acknowledged", async () => {
  const f = fixture(false);
  const openingRequest = opening(f, OWNER, async (options, choice) => {
    assert.equal(options.filter(choice), true);
    for (const altered of [
      { user: user(OTHER) }, { customId: "other-menu" }, { message: { id: nextId() } },
      { guildId: nextId() }, { channelId: nextId() },
    ]) assert.equal(options.filter({ ...choice, ...altered }), false);
    return choice;
  });
  await handler.handleTicketOpen(openingRequest.interaction);
  assert.equal(openingRequest.choice.acknowledged, true);
  assert.equal(f.created.length, 1);
  const overwrites = f.created[0].permissionOverwrites;
  assert.deepEqual(overwrites.find((entry) => entry.id === f.guild.id).deny, ["ViewChannel"]);
  assert.equal(overwrites.find((entry) => entry.id === BOT).type, OverwriteType.Member);
  assert.equal(overwrites.find((entry) => entry.id === OWNER).type, OverwriteType.Member);
  assert.ok(overwrites.some((entry) => entry.id === ROLE));
  assert.ok(!overwrites.some((entry) => entry.id === MANAGED));
});

test("removed or forged category selections are acknowledged, rejected and release reservations", async (t) => {
  for (const scenario of ["removed", "forged", "invalid role"]) {
    await t.test(scenario, async () => {
      const f = fixture(false);
      f.settings.ticket.limit = 1;
      const request = opening(f, OWNER, async (options, choice) => {
        if (scenario === "removed") f.settings.ticket.categories = [];
        if (scenario === "forged") choice.values = ["Unknown"];
        if (scenario === "invalid role") f.settings.ticket.categories[0].staff_roles = [f.guild.id];
        return choice;
      });
      await handler.handleTicketOpen(request.interaction);
      assert.equal(request.choice.acknowledged, true);
      assert.equal(f.created.length, 0);
      assert.match(lastContent(request.replies), /no longer available|invalid staff/);
      assert.deepEqual(request.replies.at(-1).components, []);
      f.settings.ticket.categories = [];
      await handler.handleTicketOpen(opening(f).interaction);
      assert.equal(f.created.length, 1);
    });
  }
});

test("pending picker prevents duplicate opens and reserves guild limit across users", async () => {
  const f = fixture(false);
  f.settings.ticket.limit = 1;
  const started = deferred();
  const choose = deferred();
  const first = opening(f, OWNER, async (options, choice) => { started.resolve(); await choose.promise; return choice; });
  const openingFirst = handler.handleTicketOpen(first.interaction);
  await started.promise;
  const duplicate = opening(f);
  await handler.handleTicketOpen(duplicate.interaction);
  assert.match(lastContent(duplicate.replies), /already being opened/);
  const other = opening(f, OTHER);
  await handler.handleTicketOpen(other.interaction);
  assert.match(lastContent(other.replies), /too many/);
  assert.equal(f.created.length, 0);
  choose.resolve();
  await openingFirst;
  assert.equal(f.created.length, 1);
  const existing = opening(f);
  await handler.handleTicketOpen(existing.interaction);
  assert.match(lastContent(existing.replies), /already have/);
  const full = opening(f, OTHER);
  await handler.handleTicketOpen(full.interaction);
  assert.match(lastContent(full.replies), /too many/);
});

test("channel creation in flight counts toward the limit even before cache insertion", async () => {
  const f = fixture(false);
  f.settings.ticket.categories = [];
  f.settings.ticket.limit = 1;
  const started = deferred();
  const finish = deferred();
  const create = f.guild.channels.create;
  f.guild.channels.create = async (options) => { started.resolve(); await finish.promise; return create(options); };
  const first = handler.handleTicketOpen(opening(f).interaction);
  await started.promise;
  const second = opening(f, OTHER);
  await handler.handleTicketOpen(second.interaction);
  assert.match(lastContent(second.replies), /too many/);
  finish.resolve();
  await first;
  assert.equal(f.created.length, 1);
});

test("two users can independently choose categories without consuming each other's collector", async () => {
  const f = fixture(false);
  f.settings.ticket.limit = 2;
  f.settings.ticket.categories.push({ name: "Billing", staff_roles: [] });
  const both = deferred();
  const finish = deferred();
  let count = 0;
  const choices = [];
  const collect = async (options, choice) => {
    choices.push({ options, choice });
    if (++count === 2) both.resolve();
    await finish.promise;
    return choice;
  };
  const first = opening(f, OWNER, collect);
  const second = opening(f, OTHER, collect);
  second.choice.values = ["Billing"];
  const requests = [handler.handleTicketOpen(first.interaction), handler.handleTicketOpen(second.interaction)];
  await both.promise;
  assert.equal(choices[0].options.filter(choices[1].choice), false);
  assert.equal(choices[1].options.filter(choices[0].choice), false);
  finish.resolve();
  await Promise.all(requests);
  assert.equal(f.created.length, 2);
  assert.ok(f.created.some((channel) => channel.topic === `tіcket|${OWNER}|Support`));
  assert.ok(f.created.some((channel) => channel.topic === `tіcket|${OTHER}|Billing`));
});

test("timeout, database and create failures clear controls and release locks", async (t) => {
  for (const scenario of ["timeout", "database", "create"]) {
    await t.test(scenario, async () => {
      const f = fixture(false);
      f.settings.ticket.limit = 1;
      const create = f.guild.channels.create;
      let choose;
      if (scenario === "timeout") choose = async () => { throw Object.assign(new Error("time"), { code: "InteractionCollectorError" }); };
      if (scenario === "database") f.guild.settingsError = true;
      if (scenario === "create") {
        f.settings.ticket.categories = [];
        f.guild.channels.create = async () => { throw new Error("create failed"); };
      }
      const first = opening(f, OWNER, choose);
      await handler.handleTicketOpen(first.interaction);
      assert.equal(f.created.length, 0);
      assert.deepEqual(first.replies.at(-1).components, []);
      if (scenario === "timeout") assert.match(lastContent(first.replies), /Timed out/);
      f.guild.settingsError = false;
      f.guild.channels.create = create;
      f.settings.ticket.categories = [];
      await handler.handleTicketOpen(opening(f).interaction);
      assert.equal(f.created.length, 1);
    });
  }
});

test("welcome send failure keeps the created channel and future opens do not clean it up", async () => {
  const f = fixture(false);
  f.settings.ticket.categories = [];
  const create = f.guild.channels.create;
  f.guild.channels.create = async (options) => {
    const channel = await create(options);
    channel.send = async () => { throw new Error("send failed"); };
    return channel;
  };
  const first = opening(f);
  await handler.handleTicketOpen(first.interaction);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].deleted, false);
  assert.match(lastContent(first.replies), /channel was kept/);
  const second = opening(f);
  await handler.handleTicketOpen(second.interaction);
  assert.match(lastContent(second.replies), /already have/);
  assert.equal(f.created.length, 1);
});

async function addCategory(f, category, staffRoles) {
  const c = commandInteraction(f, "add");
  c.interaction.options.getString = (name) => name === "category" ? category : staffRoles;
  await categoryCommand.interactionRun(c.interaction, { settings: f.settings });
  return c.replies.at(-1);
}

test("category role parsing accepts IDs and mentions and rejects invalid, managed or everyone roles", async (t) => {
  const f = fixture(false);
  const reply = await addCategory(f, "  Billing  ", `${ROLE}, <@&${ROLE}>`);
  assert.match(reply.content, /added/);
  assert.deepEqual(f.settings.ticket.categories.at(-1), { name: "Billing", staff_roles: [ROLE] });
  assert.deepEqual(reply.allowedMentions, NO_MENTIONS);
  for (const role of ["@everyone", f.guild.id, `<@&${f.guild.id}>`, MANAGED, `<@&${MANAGED}>`, "999999999999999999", "not-a-role", `<@${ROLE}>`]) {
    await t.test(role, async () => {
      const current = fixture(false);
      const input = role === f.guild.id ? current.guild.id : role === `<@&${f.guild.id}>` ? `<@&${current.guild.id}>` : role;
      let saves = 0;
      current.settings.save = async () => { saves++; };
      const response = await addCategory(current, "Unsafe", `${ROLE}, ${input}`);
      assert.doesNotMatch(response.content, /added/);
      assert.equal(current.settings.ticket.categories.length, 1);
      assert.equal(saves, 0);
    });
  }
});

test("category names, 25-option limit, and prefix separators are validated", async () => {
  const f = fixture(false);
  for (const name of ["", "  ", "a".repeat(101), "bad|name"]) {
    const reply = await addCategory(f, name, null);
    assert.doesNotMatch(reply.content, /added/);
  }
  assert.match((await addCategory(f, "a".repeat(100), null)).content, /added/);
  f.settings.ticket.categories = Array.from({ length: 25 }, (_, i) => ({ name: `category ${i}`, staff_roles: [] }));
  assert.match((await addCategory(f, "extra", ROLE)).content, /at most 25/);
  const replies = [];
  await categoryCommand.messageRun({ guild: f.guild, safeReply: async (payload) => replies.push(payload) }, ["add", "name", "|", ROLE, "|", OTHER], { settings: f.settings });
  assert.match(lastContent(replies), /only one/);
  assert.deepEqual(replies[0].allowedMentions, NO_MENTIONS);
});

test("log setup validates channel guild, type, privacy and AttachFiles before saving", async () => {
  for (const scenario of ["valid", "public", "foreign", "voice", "no attachments", "ticket"]) {
    const f = fixture();
    let saves = 0;
    f.settings.save = async () => { saves++; };
    if (scenario === "public") f.logChannel.permissionsFor = () => f.allBotPerms;
    if (scenario === "foreign") f.logChannel.guild = { id: nextId() };
    if (scenario === "voice") f.logChannel.type = ChannelType.GuildVoice;
    if (scenario === "no attachments") f.logChannel.permissionsFor = (subject) => subject.id === f.guild.id ? permissions() : permissions(["ViewChannel", "SendMessages", "EmbedLinks"]);
    const c = commandInteraction(f, "log", scenario === "ticket" ? f.ticket : f.logChannel);
    await command.interactionRun(c.interaction, { settings: f.settings });
    assert.equal(saves, scenario === "valid" ? 1 : 0, scenario);
    assert.deepEqual(c.replies[0].allowedMentions, NO_MENTIONS);
  }
});

test("setup rejects foreign and non-text destinations without starting collectors", async () => {
  for (const scenario of ["foreign", "voice"]) {
    const f = fixture(false);
    const target = { ...f.logChannel };
    if (scenario === "foreign") target.guild = { id: nextId() };
    else target.type = ChannelType.GuildVoice;
    const c = commandInteraction(f, "setup", target);
    await command.interactionRun(c.interaction, { settings: f.settings });
    assert.match(lastContent(c.replies), /text channel in this server/);
  }
});

test("setup modal bounds fields, scopes interactions and handles oversized totals and send failures", async (t) => {
  for (const scenario of ["valid", "total too long", "title too long", "send fails"]) {
    await t.test(scenario, async () => {
      const f = fixture(false);
      const c = commandInteraction(f, "setup");
      const replies = [];
      let panelSent = false;
      const prompt = { id: nextId() };
      const modal = {
        user: c.interaction.user, guildId: f.guild.id, channelId: f.logChannel.id,
        message: { id: prompt.id },
        fields: { getTextInputValue: (name) => {
          if (scenario === "total too long") return "x".repeat({ title: 256, description: 4000, footer: 2048 }[name]);
          if (scenario === "title too long" && name === "title") return "x".repeat(257);
          return "";
        } },
        deferReply: async ({ ephemeral }) => assert.equal(ephemeral, true),
        editReply: async (payload) => replies.push(payload),
      };
      const button = {
        customId: "ticket_btnSetup", user: c.interaction.user, guildId: f.guild.id, channelId: f.logChannel.id,
        message: { id: prompt.id },
        showModal: async (builder) => {
          const json = builder.toJSON();
          modal.customId = json.custom_id;
          assert.deepEqual(json.components.map((row) => row.components[0].max_length), [256, 4000, 2048]);
        },
        awaitModalSubmit: async ({ filter }) => {
          assert.equal(filter(modal), true);
          for (const change of [{ user: user(OTHER) }, { guildId: nextId() }, { channelId: nextId() }, { customId: "ticket-modalSetup-other" }, { message: { id: nextId() } }]) {
            assert.equal(filter({ ...modal, ...change }), false);
          }
          return modal;
        },
      };
      prompt.awaitMessageComponent = async ({ filter }) => {
        assert.equal(filter(button), true);
        assert.equal(filter({ ...button, user: user(OTHER) }), false);
        return button;
      };
      c.interaction.editReply = async (payload) => { c.replies.push(payload); return prompt; };
      f.logChannel.send = async (payload) => {
        if (scenario === "send fails") throw new Error("cannot send");
        assert.deepEqual(payload.allowedMentions, NO_MENTIONS);
        payload.embeds[0].toJSON();
        panelSent = true;
      };
      await command.interactionRun(c.interaction, { settings: f.settings });
      assert.deepEqual(c.replies.at(-1).components, []);
      assert.equal(panelSent, scenario === "valid");
      assert.match(lastContent(replies), scenario === "valid" ? /Created/ : scenario === "send fails" ? /Could not send/ : /too long/);
    });
  }
});
