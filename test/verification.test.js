"use strict";

require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert").strict;
const Module = require("node:module");
const {
  Collection,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} = require("discord.js");

// Replace external boundaries before loading handlers; no client or database is started.
const fixtures = new WeakMap();
const reactionRows = new Map();
function boundary(name, exports) {
  const filename = require.resolve(name);
  const stub = new Module(filename);
  stub.filename = filename;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[filename] = stub;
}
boundary("@schemas/Guild", {
  async getSettings(guild) {
    const fixture = fixtures.get(guild);
    assert.ok(fixture, "Only registered fake guilds may access settings");
    if (fixture.state.settingsError) throw fixture.state.settingsError;
    return fixture.settings;
  },
  saveVerification(settings, next) {
    return settings.persistVerification(next);
  },
});
boundary("@schemas/Member", {
  getMember() {
    assert.fail("Reward tests must not access member persistence");
  },
});
boundary("@schemas/ReactionRoles", {
  getReactionRoles(guildId, channelId, messageId) {
    return reactionRows.get(`${guildId}:${channelId}:${messageId}`) || [];
  },
});
boundary("@root/config", { EMBED_COLORS: { BOT_EMBED: "#5865f2" } });

const verification = require("@handlers/verification");
const { publicRoleError, isVerificationRole, canUseRoleRewards } = require("@helpers/RoleUtils");
const reactionRoles = require("@handlers/reactionRoles");
const { checkInviteRewards } = require("@handlers/invite");

let sequence = 100000000000000000n;
const nextId = () => String(sequence++);
const permissions = (...names) => new PermissionsBitField(names);
const privilegedPermissions = [
  "Administrator", "ManageGuild", "ManageRoles", "ManageChannels", "ManageWebhooks",
  "KickMembers", "BanMembers", "ModerateMembers", "ManageMessages",
  "ManageThreads", "ManageNicknames", "ManageEvents", "ManageGuildExpressions",
  "ViewAuditLog", "MuteMembers", "DeafenMembers", "MoveMembers", "MentionEveryone",
];
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const state = {};
  const calls = {
    add: [], remove: [], rolesFetch: [], membersFetch: [], fetchMe: [], channelFetch: [],
    send: [], deleted: [], save: [], persisted: [], errors: [],
  };
  const client = {
    user: { id: nextId(), bot: true },
    logger: { error: (...args) => calls.errors.push(args) },
  };
  const guild = { id: nextId(), ownerId: nextId(), client };
  function makeRole(position, names = [], id = nextId()) {
    return {
      id, guild, position, managed: false, permissions: new PermissionsBitField(names),
      comparePositionTo(other) { return this.position - other.position; },
    };
  }
  const everyone = makeRole(0, [], guild.id);
  const unverified = makeRole(2);
  const verified = makeRole(3);
  const reward = makeRole(4);
  const generic = makeRole(5);
  const actorRole = makeRole(20);
  const botRole = makeRole(30);
  const roleCache = new Collection(
    [everyone, unverified, verified, reward, generic, actorRole, botRole].map((role) => [role.id, role])
  );
  guild.roles = {
    cache: roleCache,
    everyone,
    async fetch(id) {
      calls.rolesFetch.push(id);
      return id ? roleCache.get(id) || null : roleCache;
    },
  };
  const member = {
    id: nextId(), guild, client, pending: false,
    roles: {
      cache: new Collection([[everyone.id, everyone], [unverified.id, unverified]]),
      highest: unverified,
      async add(role, reason) {
        calls.add.push({ role, reason });
        if (state.beforeAdd) await state.beforeAdd(role);
        if (state.addError) throw state.addError;
        this.cache.set(role.id, role);
        return member;
      },
      async remove(role, reason) {
        calls.remove.push({ role, reason });
        if (state.removeError) throw state.removeError;
        this.cache.delete(typeof role === "string" ? role : role.id);
        return member;
      },
    },
  };
  member.user = { id: member.id, bot: false };
  const actor = {
    id: nextId(), permissions: permissions("ManageGuild", "ManageRoles"),
    roles: { highest: actorRole },
  };
  const bot = {
    id: client.user.id, permissions: permissions("ManageRoles"),
    roles: { highest: botRole },
  };
  guild.members = {
    me: bot,
    cache: new Collection([[member.id, member], [actor.id, actor], [bot.id, bot]]),
    async fetch(query) {
      calls.membersFetch.push(query);
      if (state.beforeMemberFetch) await state.beforeMemberFetch(query);
      const id = typeof query === "string" ? query : query.user;
      const found = this.cache.get(id);
      assert.ok(found, "Member fetch must stay inside the fake guild");
      return found;
    },
    async fetchMe(options) {
      calls.fetchMe.push(options);
      return this.me;
    },
  };
  const panel = { id: nextId(), async delete() { calls.deleted.push(this.id); } };
  const channel = {
    id: nextId(), guild, type: ChannelType.GuildText,
    botPermissions: permissions("ViewChannel", "SendMessages", "EmbedLinks", "ReadMessageHistory"),
    everyonePermissions: permissions("ViewChannel", "ReadMessageHistory"),
    unverifiedPermissions: permissions("ViewChannel", "ReadMessageHistory"),
    permissionsFor(subject) {
      if (subject === guild.members.me) return this.botPermissions;
      if (subject === everyone) return this.everyonePermissions;
      if (subject === unverified) return this.unverifiedPermissions;
      assert.fail("Unexpected channel permission subject");
    },
    async send(payload) {
      calls.send.push(payload);
      if (state.sendError) throw state.sendError;
      return panel;
    },
  };
  guild.channels = {
    cache: new Collection([[channel.id, channel]]),
    async fetch(id, options) {
      calls.channelFetch.push({ id, options });
      return this.cache.get(id) || null;
    },
  };
  const settings = {
    verification: {
      enabled: true, channel_id: channel.id, message_id: nextId(),
      role_id: verified.id, unverified_role_id: unverified.id,
    },
    autorole: null,
    invite: { tracking: false, ranks: [] },
    async persistVerification(next) {
      const saved = { ...next };
      calls.save.push(saved);
      if (state.beforeSave) await state.beforeSave();
      if (state.saveError) throw state.saveError;
      calls.persisted.push(saved);
      this.verification = saved;
    },
  };
  function interaction(user = member.user) {
    return {
      guild, client, user, channelId: channel.id,
      message: { id: settings.verification.message_id, author: { id: client.user.id } },
      calls: { deferred: [], replies: [] },
      async deferReply(options) { this.calls.deferred.push(options); },
      async editReply(content) { this.calls.replies.push(content); return { content }; },
    };
  }
  const value = {
    state, calls, client, guild, member, actor, bot, channel, panel, settings,
    roles: { everyone, unverified, verified, reward, generic, actorRole, botRole },
    interaction,
  };
  fixtures.set(guild, value);
  return value;
}

async function click(f, interaction = f.interaction()) {
  await verification.handleVerify(interaction);
  assert.deepEqual(interaction.calls.deferred, [{ ephemeral: true }]);
  assert.equal(interaction.calls.replies.length, 1);
  return interaction.calls.replies[0];
}
function noRoleChanges(f) {
  assert.equal(f.calls.add.length, 0);
  assert.equal(f.calls.remove.length, 0);
}
function setup(f, unverified = f.roles.unverified) {
  return verification.setupVerification(
    f.interaction({ id: f.actor.id }), f.settings, f.channel, f.roles.verified, unverified
  );
}
function reaction(f, role) {
  const messageId = nextId();
  reactionRows.set(`${f.guild.id}:${f.channel.id}:${messageId}`, [{ emote: "test", role_id: role.id }]);
  return {
    message: { guild: f.guild, guildId: f.guild.id, channel: f.channel, channelId: f.channel.id, id: messageId },
    emoji: { id: null, toString: () => "test" },
  };
}

// Verification panels must be current, bot-authored, and tied to their saved channel.
test("fresh verification grants verified role before removing unverified", async () => {
  const f = fixture();
  f.member.roles.remove = async (role, reason) => {
    assert.equal(f.member.roles.cache.has(f.roles.verified.id), true);
    f.calls.remove.push({ role, reason });
    f.member.roles.cache.delete(role.id);
    return f.member;
  };
  assert.match(await click(f), /^You are verified/);
  assert.deepEqual(f.calls.add.map(({ role }) => role.id), [f.roles.verified.id]);
  assert.deepEqual(f.calls.remove.map(({ role }) => role.id), [f.roles.unverified.id]);
  assert.equal(f.member.roles.cache.has(f.roles.verified.id), true);
  assert.equal(f.member.roles.cache.has(f.roles.unverified.id), false);
  assert.deepEqual(f.calls.membersFetch, [{ user: f.member.id, force: true }]);
  assert.deepEqual(f.calls.fetchMe, [{ force: true }]);
  assert.equal(f.calls.errors.length, 0);
});

for (const [name, change] of [
  ["stale message", (f, i) => { i.message.id = nextId(); }],
  ["wrong author", (f, i) => { i.message.author.id = f.member.id; }],
  ["wrong channel", (f, i) => { i.channelId = nextId(); }],
  ["disabled verification", (f) => { f.settings.verification.enabled = false; }],
]) {
  test(`verification rejects ${name}`, async () => {
    const f = fixture();
    const interaction = f.interaction();
    change(f, interaction);
    assert.match(await click(f, interaction), /panel is inactive/i);
    noRoleChanges(f);
    assert.equal(f.calls.membersFetch.length, 0);
  });
}

for (const [name, change, message] of [
  ["bots", (f) => { f.member.user.bot = true; }, /Bots cannot/],
  ["pending screening", (f) => { f.member.pending = true; }, /screening first/],
  ["missing verified role", (f) => { f.guild.roles.cache.delete(f.roles.verified.id); }, /no longer exists/],
  ["missing unverified role", (f) => { f.guild.roles.cache.delete(f.roles.unverified.id); }, /no longer exists/],
  ["missing bot permission", (f) => { f.bot.permissions = permissions(); }, /bot needs Manage Roles/],
  ["same bot role", (f) => { f.bot.roles.highest = f.roles.verified; }, /above the selected role/],
  ["role above bot", (f) => { f.roles.verified.position = 31; }, /above the selected role/],
  ["unverified role above bot", (f) => { f.roles.unverified.position = 31; }, /above the selected role/],
  ["managed verified role", (f) => { f.roles.verified.managed = true; }, /regular role/],
  ["managed unverified role", (f) => { f.roles.unverified.managed = true; }, /regular role/],
]) {
  test(`verification rejects ${name} without mutating roles`, async () => {
    const f = fixture();
    change(f);
    assert.match(await click(f), message);
    noRoleChanges(f);
  });
}

for (const permission of privilegedPermissions) {
  for (const selected of ["verified", "unverified"]) {
    test(`verification refuses ${permission} on the ${selected} role`, async () => {
      const f = fixture();
      f.roles[selected].permissions = permissions(permission);
      assert.match(await click(f), /must not grant moderation or management/);
      noRoleChanges(f);
    });
  }
}

test("already verified is idempotent and cleans up a lingering unverified role", async () => {
  const f = fixture();
  f.member.roles.cache.set(f.roles.verified.id, f.roles.verified);
  assert.match(await click(f), /already verified/);
  assert.equal(f.calls.add.length, 0);
  assert.equal(f.calls.remove.length, 1);
  assert.match(await click(f), /already verified/);
  assert.equal(f.calls.add.length, 0);
  assert.equal(f.calls.remove.length, 1);
});

test("failed verified-role add leaves unverified role intact and permits retry", async () => {
  const f = fixture();
  f.state.addError = new Error("add denied");
  assert.match(await click(f), /Verification failed/);
  assert.equal(f.calls.remove.length, 0);
  assert.equal(f.member.roles.cache.has(f.roles.unverified.id), true);
  assert.equal(f.member.roles.cache.has(f.roles.verified.id), false);
  assert.equal(f.calls.errors[0][1], f.state.addError);
  delete f.state.addError;
  assert.match(await click(f), /^You are verified/);
  assert.equal(f.calls.add.length, 2);
  assert.equal(f.calls.remove.length, 1);
});

test("failed removal reports partial success and retry only removes unverified", async () => {
  const f = fixture();
  f.state.removeError = new Error("remove denied");
  assert.match(await click(f), /verified role was assigned, but the unverified role could not be removed/);
  assert.equal(f.member.roles.cache.has(f.roles.verified.id), true);
  assert.equal(f.member.roles.cache.has(f.roles.unverified.id), true);
  assert.equal(f.calls.errors[0][1], f.state.removeError);
  delete f.state.removeError;
  assert.match(await click(f), /already verified/);
  assert.equal(f.calls.add.length, 1);
  assert.equal(f.calls.remove.length, 2);
  assert.equal(f.member.roles.cache.has(f.roles.unverified.id), false);
});

test("duplicate concurrent clicks make exactly one role add", async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  f.state.beforeAdd = async () => { entered.resolve(); await release.promise; };
  const first = click(f);
  await entered.promise;
  try {
    assert.match(await click(f), /already being processed/);
    assert.equal(f.calls.add.length, 1);
    assert.equal(f.calls.remove.length, 0);
  } finally {
    release.resolve();
  }
  assert.match(await first, /^You are verified/);
  assert.equal(f.calls.add.length, 1);
  assert.equal(f.calls.remove.length, 1);
  assert.match(await click(f), /already verified/);
});

test("settings changed during member fetch cannot grant a role", async () => {
  const f = fixture();
  f.state.beforeMemberFetch = () => { f.settings.verification.message_id = nextId(); };
  assert.match(await click(f), /settings changed/);
  noRoleChanges(f);
});

test("settings lookup failure is reported and releases the verification lock", async () => {
  const f = fixture();
  f.state.settingsError = new Error("database unavailable");
  assert.match(await click(f), /Verification failed/);
  noRoleChanges(f);
  delete f.state.settingsError;
  assert.match(await click(f), /^You are verified/);
});

test("setup sends real Discord builders and persists all verification fields", async () => {
  const f = fixture();
  f.settings.verification = { enabled: false };
  assert.match(await setup(f), /Verification panel saved/);
  const expected = {
    enabled: true, channel_id: f.channel.id, message_id: f.panel.id,
    role_id: f.roles.verified.id, unverified_role_id: f.roles.unverified.id,
  };
  assert.deepEqual(f.settings.verification, expected);
  assert.deepEqual(f.calls.persisted, [expected]);
  assert.deepEqual(f.calls.membersFetch, [{ user: f.actor.id, force: true }]);
  assert.deepEqual(f.calls.channelFetch, [{ id: f.channel.id, options: { force: true } }]);
  assert.equal(f.calls.send.length, 1);
  const payload = f.calls.send[0];
  assert.ok(payload.embeds[0] instanceof EmbedBuilder);
  assert.ok(payload.components[0] instanceof ActionRowBuilder);
  const button = payload.components[0].components[0];
  assert.ok(button instanceof ButtonBuilder);
  assert.equal(button.toJSON().custom_id, verification.BUTTON_ID);
  assert.equal(button.toJSON().style, ButtonStyle.Success);
  assert.equal(button.toJSON().label, "Verify");
  assert.match(payload.embeds[0].toJSON().description, /not a CAPTCHA/);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(f.calls.deleted.length, 0);
  noRoleChanges(f);
  assert.match(await click(f), /^You are verified/);
});

test("setup without unverified role persists null", async () => {
  const f = fixture();
  assert.match(await setup(f, null), /panel saved/);
  assert.equal(f.calls.persisted[0].unverified_role_id, null);
  assert.match(await click(f), /^You are verified/);
  assert.equal(f.calls.remove.length, 0);
});

for (const [name, change, message] of [
  ["missing ManageGuild", (f) => { f.actor.permissions = permissions("ManageRoles"); }, /Manage Server and Manage Roles/],
  ["missing ManageRoles", (f) => { f.actor.permissions = permissions("ManageGuild"); }, /Manage Server and Manage Roles/],
  ["actor's own highest role", (f) => { f.actor.roles.highest = f.roles.verified; }, /below your highest role/],
  ["role above actor", (f) => { f.roles.verified.position = 21; }, /below your highest role/],
  ["unverified role above actor", (f) => { f.roles.unverified.position = 21; }, /below your highest role/],
  ["bot's highest role", (f) => { f.bot.roles.highest = f.roles.verified; }, /above the selected role/],
  ["managed role", (f) => { f.roles.verified.managed = true; }, /regular role/],
  ["privileged role", (f) => { f.roles.verified.permissions = permissions("Administrator"); }, /must not grant/],
  ["missing role", (f) => { f.guild.roles.cache.delete(f.roles.verified.id); }, /no longer exists/],
  ["foreign guild role", (f) => { f.roles.verified.guild = { id: nextId() }; }, /no longer exists/],
  ["generic autorole conflict", (f) => { f.settings.autorole = f.roles.generic.id; }, /Disable autorole first/],
  ["verified autorole conflict", (f) => { f.settings.autorole = f.roles.verified.id; }, /Disable autorole first/],
  ["verified invite reward conflict", (f) => { f.settings.invite.ranks = [{ _id: f.roles.verified.id, invites: 1 }]; }, /Remove these roles from invite rewards/],
  ["unverified invite reward conflict", (f) => { f.settings.invite.ranks = [{ _id: f.roles.unverified.id, invites: 1 }]; }, /Remove these roles from invite rewards/],
  ["non-text channel", (f) => { f.channel.type = ChannelType.GuildVoice; }, /text channel in this server/],
  ["foreign channel", (f) => { f.channel.guild = { id: nextId() }; }, /text channel in this server/],
  ["invisible panel for everyone", (f) => { f.channel.everyonePermissions = permissions(); }, /Allow @everyone/],
  ["invisible panel for unverified", (f) => { f.channel.unverifiedPermissions = permissions(); }, /unverified role must be able/],
]) {
  test(`setup refuses ${name} before sending or persisting`, async () => {
    const f = fixture();
    change(f);
    const before = { ...f.settings.verification };
    assert.match(await setup(f), message);
    assert.deepEqual(f.settings.verification, before);
    assert.equal(f.calls.send.length, 0);
    assert.equal(f.calls.save.length, 0);
    noRoleChanges(f);
  });
}

test("setup refuses using the same role for verified and unverified", async () => {
  const f = fixture();
  assert.match(await setup(f, f.roles.verified), /must be different/);
  assert.equal(f.calls.send.length, 0);
  assert.equal(f.calls.save.length, 0);
});

test("setup allows autorole only when it is the unverified role", async () => {
  const f = fixture();
  f.settings.autorole = f.roles.unverified.id;
  assert.match(await setup(f), /panel saved/);
  assert.equal(f.settings.autorole, f.roles.unverified.id);
  assert.equal(f.calls.persisted.length, 1);
});

test("guild owner bypasses actor hierarchy but never bot hierarchy", async () => {
  const f = fixture();
  f.guild.ownerId = f.actor.id;
  f.actor.roles.highest = f.roles.everyone;
  assert.match(await setup(f), /panel saved/);
  f.bot.roles.highest = f.roles.verified;
  assert.match(await setup(f), /above the selected role/);
  assert.equal(f.calls.send.length, 1);
});

for (const missing of ["ViewChannel", "SendMessages", "EmbedLinks", "ReadMessageHistory"]) {
  test(`setup requires bot channel permission ${missing}`, async () => {
    const f = fixture();
    f.channel.botPermissions.remove(missing);
    assert.match(await setup(f), /bot needs View Channel/);
    assert.equal(f.calls.send.length, 0);
    assert.equal(f.calls.save.length, 0);
  });
}

test("setup save failure preserves a schema-like snapshot, deletes panel, and permits retry", async () => {
  const f = fixture();
  const previous = { ...f.settings.verification };
  f.settings.verification.toObject = () => ({ ...previous });
  const original = f.settings.verification;
  f.state.saveError = new Error("database write failed");
  assert.match(await setup(f), /Verification setup failed/);
  assert.equal(f.settings.verification, original);
  assert.deepEqual(f.settings.verification.toObject(), previous);
  assert.deepEqual(f.calls.deleted, [f.panel.id]);
  assert.equal(f.calls.persisted.length, 0);
  assert.equal(f.calls.errors[0][1], f.state.saveError);
  noRoleChanges(f);
  delete f.state.saveError;
  assert.match(await setup(f), /panel saved/);
  assert.equal(f.calls.persisted.length, 1);
});

test("setup send failure leaves existing verification unchanged", async () => {
  const f = fixture();
  const previous = { ...f.settings.verification };
  f.state.sendError = new Error("send denied");
  assert.match(await setup(f), /Verification setup failed/);
  assert.deepEqual(f.settings.verification, previous);
  assert.equal(f.calls.save.length, 0);
  assert.equal(f.calls.deleted.length, 0);
});

test("in-progress setup blocks concurrent setup, disable, and verification", async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  f.state.beforeSave = async () => { entered.resolve(); await release.promise; };
  const running = setup(f);
  await entered.promise;
  try {
    assert.match(await setup(f), /already in progress/);
    assert.match(await verification.disableVerification(f.interaction({ id: f.actor.id }), f.settings), /already in progress/);
    assert.match(await click(f), /panel is inactive/);
    noRoleChanges(f);
    assert.equal(f.calls.send.length, 1);
  } finally {
    release.resolve();
  }
  assert.match(await running, /panel saved/);
});

test("disable persists disabled state and makes the old panel inactive without role changes", async () => {
  const f = fixture();
  const previous = { ...f.settings.verification };
  const panelInteraction = f.interaction();
  assert.match(await verification.disableVerification(f.interaction({ id: f.actor.id }), f.settings), /Verification disabled/);
  assert.deepEqual(f.calls.persisted, [{ ...previous, enabled: false }]);
  assert.match(await click(f, panelInteraction), /panel is inactive/);
  noRoleChanges(f);
  assert.equal(f.calls.deleted.length, 0);
});

test("disable requires both staff permissions", async () => {
  for (const remaining of ["ManageGuild", "ManageRoles"]) {
    const f = fixture();
    f.actor.permissions = permissions(remaining);
    assert.match(await verification.disableVerification(f.interaction({ id: f.actor.id }), f.settings), /Manage Server and Manage Roles/);
    assert.equal(f.settings.verification.enabled, true);
    assert.equal(f.calls.save.length, 0);
  }
});

test("disable save failure restores verification and releases configuration lock", async () => {
  const f = fixture();
  const previous = { ...f.settings.verification };
  f.state.saveError = new Error("write failed");
  assert.match(await verification.disableVerification(f.interaction({ id: f.actor.id }), f.settings), /has not been disabled/);
  assert.deepEqual(f.settings.verification, previous);
  delete f.state.saveError;
  assert.match(await verification.disableVerification(f.interaction({ id: f.actor.id }), f.settings), /Verification disabled/);
});

test("failed in-flight disable never lets reaction roles bypass verification", async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  const previous = { ...f.settings.verification };
  f.state.saveError = new Error("database unavailable");
  f.state.beforeSave = async () => { entered.resolve(); await release.promise; };
  const running = verification.disableVerification(f.interaction({ id: f.actor.id }), f.settings);
  await entered.promise;
  try {
    assert.deepEqual(f.settings.verification, previous);
    await reactionRoles.handleReactionAdd(reaction(f, f.roles.verified), f.member.user);
    await reactionRoles.handleReactionAdd(reaction(f, f.roles.reward), f.member.user);
    assert.match(await click(f), /panel is inactive/);
    noRoleChanges(f);
  } finally {
    release.resolve();
  }
  assert.match(await running, /has not been disabled/);
  assert.deepEqual(f.settings.verification, previous);
  assert.equal(f.calls.persisted.length, 0);
  noRoleChanges(f);
});

test("join verification holds generic autorole and grants only unverified", async () => {
  const f = fixture();
  f.member.roles.cache.delete(f.roles.unverified.id);
  f.settings.autorole = f.roles.generic.id;
  await verification.applyJoinRoles(f.member, f.settings);
  assert.deepEqual(f.calls.add.map(({ role }) => role.id), [f.roles.unverified.id]);
  assert.equal(f.member.roles.cache.has(f.roles.generic.id), false);
  assert.equal(f.member.roles.cache.has(f.roles.verified.id), false);
  await verification.applyJoinRoles(f.member, f.settings);
  assert.equal(f.calls.add.length, 1);
});

test("join verification without an unverified role never falls back to autorole", async () => {
  const f = fixture();
  f.settings.verification.unverified_role_id = null;
  f.settings.autorole = f.roles.generic.id;
  await verification.applyJoinRoles(f.member, f.settings);
  noRoleChanges(f);
});

test("join does not downgrade an already verified member", async () => {
  const f = fixture();
  f.member.roles.cache.delete(f.roles.unverified.id);
  f.member.roles.cache.set(f.roles.verified.id, f.roles.verified);
  await verification.applyJoinRoles(f.member, f.settings);
  noRoleChanges(f);
});

test("join supports disabled and absent verification with generic autorole", async () => {
  for (const config of [{ enabled: false }, undefined]) {
    const f = fixture();
    f.settings.verification = config;
    f.settings.autorole = f.roles.generic.id;
    await verification.applyJoinRoles(f.member, f.settings);
    assert.deepEqual(f.calls.add.map(({ role }) => role.id), [f.roles.generic.id]);
  }
});

for (const mode of ["verification", "autorole"]) {
  for (const skip of ["bot", "pending"]) {
    test(`join ${mode} skips ${skip} members before fetching roles`, async () => {
      const f = fixture();
      f.member.roles.cache.delete(f.roles.unverified.id);
      f.settings.autorole = f.roles.generic.id;
      f.settings.verification.enabled = mode === "verification";
      if (skip === "bot") f.member.user.bot = true;
      else f.member.pending = true;
      await verification.applyJoinRoles(f.member, f.settings);
      noRoleChanges(f);
      assert.equal(f.calls.rolesFetch.length, 0);
    });
  }
}

for (const [name, change] of [
  ["missing", (f) => { f.guild.roles.cache.delete(f.roles.unverified.id); }],
  ["managed", (f) => { f.roles.unverified.managed = true; }],
  ["privileged", (f) => { f.roles.unverified.permissions = permissions("ManageRoles"); }],
  ["above bot", (f) => { f.roles.unverified.position = 31; }],
]) {
  test(`join refuses ${name} role`, async () => {
    const f = fixture();
    f.member.roles.cache.delete(f.roles.unverified.id);
    change(f);
    await verification.applyJoinRoles(f.member, f.settings);
    noRoleChanges(f);
    assert.match(f.calls.errors[0][0], /Join role skipped/);
  });
}

test("publicRoleError refuses everyone, foreign roles, and every privileged permission", () => {
  const f = fixture();
  assert.match(publicRoleError(f.guild, f.roles.everyone), /regular role/);
  assert.match(publicRoleError(f.guild, { ...f.roles.reward, guild: { id: nextId() } }), /no longer exists/);
  assert.equal(publicRoleError(f.guild, f.roles.reward), null);
  for (const permission of privilegedPermissions) {
    f.roles.reward.permissions = permissions(permission);
    assert.match(publicRoleError(f.guild, f.roles.reward), /must not grant/);
  }
});

test("public role rewards require verification and cannot grant reserved roles", () => {
  const f = fixture();
  assert.equal(canUseRoleRewards(f.member, f.settings, f.roles.reward), false);
  f.member.roles.cache.set(f.roles.verified.id, f.roles.verified);
  assert.equal(canUseRoleRewards(f.member, f.settings, f.roles.reward), true);
  for (const role of [f.roles.verified, f.roles.unverified]) {
    assert.equal(isVerificationRole(f.settings, role.id), true);
    assert.equal(canUseRoleRewards(f.member, f.settings, role), false);
  }
  f.settings.verification.enabled = false;
  f.member.roles.cache.delete(f.roles.verified.id);
  assert.equal(canUseRoleRewards(f.member, f.settings, f.roles.reward), true);
  assert.equal(isVerificationRole(f.settings, f.roles.verified.id), false);
});

for (const [name, change] of [
  ["bot", (f) => { f.member.user.bot = true; }],
  ["pending", (f) => { f.member.pending = true; }],
  ["privileged reward", (f) => { f.roles.reward.permissions = permissions("Administrator"); }],
  ["managed reward", (f) => { f.roles.reward.managed = true; }],
  ["unmanageable reward", (f) => { f.bot.roles.highest = f.roles.reward; }],
]) {
  test(`public role rewards reject ${name} even without verification`, () => {
    const f = fixture();
    f.settings.verification.enabled = false;
    change(f);
    assert.equal(canUseRoleRewards(f.member, f.settings, f.roles.reward), false);
  });
}

test("reaction role handler cannot bypass verification or mutate reserved roles", async () => {
  const f = fixture();
  await reactionRoles.handleReactionAdd(reaction(f, f.roles.reward), f.member.user);
  noRoleChanges(f);
  f.member.roles.cache.set(f.roles.verified.id, f.roles.verified);
  for (const role of [f.roles.verified, f.roles.unverified]) {
    const event = reaction(f, role);
    await reactionRoles.handleReactionAdd(event, f.member.user);
    await reactionRoles.handleReactionRemove(event, f.member.user);
  }
  noRoleChanges(f);
  await reactionRoles.handleReactionAdd(reaction(f, f.roles.reward), f.member.user);
  assert.deepEqual(f.calls.add.map(({ role }) => role.id), [f.roles.reward.id]);
});

test("invite reward handler cannot bypass verification or mutate reserved roles", async () => {
  const f = fixture();
  f.settings.invite.ranks = [f.roles.reward, f.roles.verified, f.roles.unverified]
    .map((role) => ({ _id: role.id, invites: 1 }));
  const inviter = { member_id: f.member.id, invite_data: { tracked: 5, added: 0, fake: 0, left: 0 } };
  await checkInviteRewards(f.guild, inviter, true);
  noRoleChanges(f);
  f.member.roles.cache.set(f.roles.verified.id, f.roles.verified);
  await checkInviteRewards(f.guild, inviter, true);
  assert.deepEqual(f.calls.add.map(({ role }) => role.id), [f.roles.reward.id]);
  inviter.invite_data.tracked = 0;
  await checkInviteRewards(f.guild, inviter, false);
  assert.deepEqual(f.calls.remove.map(({ role }) => typeof role === "string" ? role : role.id), [f.roles.reward.id]);
  assert.equal(f.member.roles.cache.has(f.roles.verified.id), true);
  assert.equal(f.member.roles.cache.has(f.roles.unverified.id), true);
});
