"use strict";

require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert").strict;
const Module = require("node:module");
const { Collection, PermissionsBitField, EmbedBuilder } = require("discord.js");

const fixtures = new WeakMap();
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
    fixture.calls.settings++;
    return fixture.settings;
  },
});
boundary("@root/config", { EMBED_COLORS: { BOT_EMBED: "#5865f2" } });
const greeting = require("@handlers/greeting");
// Load the real greeting and verification handlers, not the broad handler index/bot runtime.
boundary("@src/handlers", {
  greetingHandler: greeting,
  inviteHandler: {
    async trackJoinedMember(member) {
      const f = fixtures.get(member.guild);
      assert.ok(f);
      f.calls.invites.push(member);
      f.calls.timeline.push("invite:track");
      if (f.state.inviteError) throw f.state.inviteError;
      return f.state.inviterData || {};
    },
  },
});
const guildMemberAdd = require("@src/events/member/guildMemberAdd");
const guildMemberUpdate = require("@src/events/member/guildMemberUpdate");

let sequence = 200000000000000000n;
const nextId = () => String(sequence++);
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const calls = { sends: [], users: [], errors: [], add: [], invites: [], timeline: [], settings: 0, saves: 0 };
  const state = {};
  const inviter = { id: nextId(), username: "Inviter", tag: "Inviter#1234" };
  const client = {
    user: { id: nextId(), bot: true },
    logger: { error: (...args) => calls.errors.push(args) },
    counterUpdateQueue: [],
    users: {
      async fetch(id) {
        calls.users.push(id);
        assert.equal(id, inviter.id, "User fetch must stay inside the fake fixture");
        if (state.userError) throw state.userError;
        return inviter;
      },
    },
  };
  const guild = { id: nextId(), name: "Test Server", memberCount: 42, client };
  function role(position, id = nextId()) {
    return {
      id, guild, position, managed: false, permissions: new PermissionsBitField(),
      comparePositionTo(other) { return this.position - other.position; },
    };
  }
  const roles = { everyone: role(0, guild.id), unverified: role(2), verified: role(3), generic: role(4), bot: role(10) };
  guild.roles = {
    cache: new Collection(Object.values(roles).map((item) => [item.id, item])),
    everyone: roles.everyone,
    async fetch(id) { return this.cache.get(id) || null; },
  };
  guild.members = {
    me: { permissions: new PermissionsBitField(["ManageRoles"]), roles: { highest: roles.bot } },
  };
  const avatar = "https://cdn.example.test/guild-avatar.png";
  const userAvatar = "https://cdn.example.test/user-avatar.png";
  const member = {
    id: nextId(), guild, client, pending: false, displayName: "Member Nick",
    displayAvatarURL: () => avatar,
    toString() { return `<@${this.id}>`; },
  };
  member.user = {
    id: member.id, bot: false, username: "Member", discriminator: "0420", tag: "Member#0420",
    displayAvatarURL: () => userAvatar,
  };
  member.roles = {
    cache: new Collection([[roles.everyone.id, roles.everyone]]),
    async add(selected, reason) {
      calls.add.push({ role: selected, reason });
      calls.timeline.push("role:add");
      if (state.beforeAdd) await state.beforeAdd();
      if (state.addError) throw state.addError;
      this.cache.set(selected.id, selected);
      return member;
    },
  };
  const sentMessage = { id: nextId() };
  const channel = {
    id: nextId(), guild,
    async safeSend(payload) {
      calls.sends.push(payload);
      calls.timeline.push("greeting:send");
      if (state.sendEntered) state.sendEntered.resolve();
      if (state.sendError) throw state.sendError;
      if (state.sendGate) return state.sendGate.promise;
      return sentMessage;
    },
  };
  guild.channels = { cache: new Collection([[channel.id, channel]]) };
  const config = () => ({ enabled: true, channel: channel.id, content: undefined, embed: {} });
  const settings = {
    welcome: config(), farewell: config(),
    verification: { enabled: true, role_id: roles.verified.id, unverified_role_id: roles.unverified.id },
    autorole: roles.generic.id,
    invite: { tracking: false, ranks: [] },
    counters: [], data: { bots: 0 },
    async save() { calls.saves++; return this; },
  };
  const f = { state, calls, inviter, member, client, guild, channel, roles, settings, avatar, userAvatar, sentMessage };
  fixtures.set(guild, f);
  return f;
}
function restrictedMentions(payload, member) {
  assert.deepEqual(payload.allowedMentions, { parse: [], users: [member.id] });
}

for (const type of ["WELCOME", "FAREWELL"]) {
  test(`${type} defaults do not send an empty embed`, async () => {
    const f = fixture();
    const config = f.settings[type === "WELCOME" ? "welcome" : "farewell"];
    const response = await greeting.buildGreeting(f.member, type, config);
    assert.equal(response.content, type === "WELCOME"
      ? `Welcome to the server, ${f.member.displayName} \u{1f389}`
      : `${f.member.user.username} has left the server \u{1f44b}`);
    assert.ok(!response.embeds || response.embeds.length === 0);
    restrictedMentions(response, f.member);
  });

  test(`${type} content-only configuration does not serialize an empty embed`, async () => {
    const f = fixture();
    const response = await greeting.buildGreeting(f.member, type, {
      content: "Hello {member:name}", embed: { color: "#123456" },
    });
    assert.equal(response.content, "Hello Member");
    assert.deepEqual(response.embeds, []);
    restrictedMentions(response, f.member);
  });
}

test("absent greeting configuration produces no message", async () => {
  const f = fixture();
  assert.equal(await greeting.buildGreeting(f.member, "WELCOME", undefined), undefined);
});

test("all content templates, repeated tokens, escaped newlines, and invite totals are replaced", async () => {
  const f = fixture();
  const template = "{server}|{count}|{member:nick}|{member:name}|{member:dis}|{member:tag}|" +
    "{member:mention}|{member:avatar}|{inviter:name}|{inviter:tag}|{invites}\\n{server}|{member:name}";
  const inviterData = { member_id: f.inviter.id, invite_data: { tracked: 12, added: 2, fake: 3, left: 1 } };
  const response = await greeting.buildGreeting(f.member, "WELCOME", { content: template, embed: {} }, inviterData);
  assert.equal(response.content,
    `Test Server|42|Member Nick|Member|0420|Member#0420|<@${f.member.id}>|${f.avatar}|` +
    "Inviter|Inviter#1234|10\nTest Server|Member");
  assert.deepEqual(f.calls.users, [f.inviter.id]);
  assert.deepEqual(response.embeds, []);
});

test("embed description, footer, image, color, and thumbnail use real Discord builders", async () => {
  const f = fixture();
  const response = await greeting.buildGreeting(f.member, "WELCOME", {
    content: "Welcome {member:mention}",
    embed: {
      description: "{member:nick} joined {server}; invited by {inviter:name} ({invites})",
      footer: "{member:tag} | {count} members | {inviter:tag}",
      color: "#123456", thumbnail: true, image: "{member:avatar}",
    },
  }, { member_id: f.inviter.id, invite_data: { tracked: 4, added: 1, fake: 0, left: 2 } });
  assert.equal(response.content, `Welcome <@${f.member.id}>`);
  assert.equal(response.embeds.length, 1);
  assert.ok(response.embeds[0] instanceof EmbedBuilder);
  assert.deepEqual(response.embeds[0].toJSON(), {
    description: "Member Nick joined Test Server; invited by Inviter (3)",
    footer: { text: "Member#0420 | 42 members | Inviter#1234", icon_url: undefined },
    color: 0x123456,
    thumbnail: { url: f.userAvatar },
    image: { url: f.avatar },
  });
  restrictedMentions(response, f.member);
});

for (const field of ["description", "footer"]) {
  test(`a ${field}-only greeting retains its nonempty embed`, async () => {
    const f = fixture();
    const response = await greeting.buildGreeting(f.member, "WELCOME", { embed: { [field]: "Hello {member:name}" } });
    assert.equal(response.content, undefined);
    assert.equal(response.embeds.length, 1);
    const embed = response.embeds[0].toJSON();
    assert.equal(field === "footer" ? embed.footer.text : embed.description, "Hello Member");
  });
}

for (const [name, inviterData, bot, expected] of [
  ["unknown inviter", {}, false, "NA|NA|0"],
  ["vanity invite", { member_id: "VANITY" }, false, "VANITY|VANITY|0"],
  ["bot OAuth invite", {}, true, "OAuth|OAuth|0"],
]) {
  test(`templates handle ${name} without a user fetch`, async () => {
    const f = fixture();
    f.member.user.bot = bot;
    const response = await greeting.buildGreeting(f.member, "WELCOME", {
      content: "{inviter:name}|{inviter:tag}|{invites}", embed: {},
    }, inviterData);
    assert.equal(response.content, expected);
    assert.equal(f.calls.users.length, 0);
  });
}

test("inviter fetch failure logs the error and falls back to NA", async () => {
  const f = fixture();
  f.state.userError = new Error("unknown user");
  const response = await greeting.buildGreeting(f.member, "WELCOME", {
    content: "{inviter:name}|{inviter:tag}|{invites}", embed: {},
  }, { member_id: f.inviter.id });
  assert.equal(response.content, "NA|NA|0");
  assert.equal(f.calls.errors[0][1], f.state.userError);
});

test("templates without inviter tokens do not fetch the inviter", async () => {
  const f = fixture();
  const response = await greeting.buildGreeting(f.member, "WELCOME", {
    content: "{member:name}: {invites}", embed: {},
  }, { member_id: f.inviter.id, invite_data: { tracked: 8, added: 0, fake: 1, left: 2 } });
  assert.equal(response.content, "Member: 5");
  assert.equal(f.calls.users.length, 0);
});

test("untrusted names and templates cannot enable everyone, role, or unrelated user mentions", async () => {
  const f = fixture();
  const otherId = nextId();
  f.member.displayName = `@everyone <@&${f.roles.generic.id}> <@${otherId}>`;
  f.guild.name = "@here";
  const response = await greeting.buildGreeting(f.member, "WELCOME", {
    content: "{member:nick} {server} {member:mention}",
    embed: { description: "{member:nick}", footer: "{server}" },
  });
  assert.equal(response.content, `${f.member.displayName} @here <@${f.member.id}>`);
  restrictedMentions(response, f.member);
  const defaultResponse = await greeting.buildGreeting(f.member, "WELCOME", { embed: {} });
  restrictedMentions(defaultResponse, f.member);
});

for (const [name, send, key] of [
  ["welcome", greeting.sendWelcome, "welcome"],
  ["farewell", greeting.sendFarewell, "farewell"],
]) {
  test(`${name} sends the configured message to the cached channel`, async () => {
    const f = fixture();
    f.settings[key].content = "{member:name} from {inviter:name}";
    const result = await send(f.member, { member_id: f.inviter.id });
    assert.equal(result, f.sentMessage);
    assert.equal(f.calls.sends.length, 1);
    assert.equal(f.calls.sends[0].content, "Member from Inviter");
    assert.deepEqual(f.calls.sends[0].embeds, []);
    restrictedMentions(f.calls.sends[0], f.member);
  });

  for (const reason of ["disabled", "missing config", "missing channel", "missing settings"]) {
    test(`${name} skips ${reason}`, async () => {
      const f = fixture();
      if (reason === "disabled") f.settings[key].enabled = false;
      if (reason === "missing config") delete f.settings[key];
      if (reason === "missing channel") f.guild.channels.cache.clear();
      if (reason === "missing settings") f.settings = undefined;
      assert.equal(await send(f.member), undefined);
      assert.equal(f.calls.sends.length, 0);
    });
  }

  test(`${name} stays pending until safeSend completes and returns its result`, async () => {
    const f = fixture();
    f.state.sendGate = deferred();
    f.state.sendEntered = deferred();
    let settled = false;
    const pending = send(f.member).then((value) => { settled = true; return value; });
    await f.state.sendEntered.promise;
    try {
      await new Promise(setImmediate);
      assert.equal(settled, false, "Caller must be able to await the actual send");
    } finally {
      f.state.sendGate.resolve(f.sentMessage);
    }
    assert.equal(await pending, f.sentMessage);
  });

  test(`${name} propagates an asynchronous send rejection to its caller`, async () => {
    const f = fixture();
    f.state.sendGate = deferred();
    f.state.sendEntered = deferred();
    const error = new Error("send rejected");
    const rejected = assert.rejects(send(f.member), (actual) => actual === error);
    await f.state.sendEntered.promise;
    f.state.sendGate.reject(error);
    await rejected;
  });
}

// Join-event integration uses the real applyJoinRoles and sendWelcome implementations.
test("join awaits unverified-role assignment before invite tracking and greeting", async () => {
  const f = fixture();
  f.settings.invite.tracking = true;
  f.settings.welcome.content = "Hello {member:name}; invited by {inviter:name}";
  f.state.inviterData = { member_id: f.inviter.id };
  const entered = deferred();
  const release = deferred();
  f.state.beforeAdd = async () => { entered.resolve(); await release.promise; };
  const joined = guildMemberAdd(f.client, f.member);
  await entered.promise;
  try {
    assert.equal(f.calls.invites.length, 0);
    assert.equal(f.calls.sends.length, 0);
  } finally {
    release.resolve();
  }
  await joined;
  assert.deepEqual(f.calls.timeline, ["role:add", "invite:track", "greeting:send"]);
  assert.deepEqual(f.calls.add.map(({ role }) => role.id), [f.roles.unverified.id]);
  assert.equal(f.member.roles.cache.has(f.roles.verified.id), false);
  assert.equal(f.member.roles.cache.has(f.roles.generic.id), false);
  assert.equal(f.calls.sends[0].content, "Hello Member; invited by Inviter");
  restrictedMentions(f.calls.sends[0], f.member);
});

test("join awaits the welcome send and does not track disabled invites", async () => {
  const f = fixture();
  f.state.sendGate = deferred();
  f.state.sendEntered = deferred();
  let settled = false;
  const joined = guildMemberAdd(f.client, f.member).then(() => { settled = true; });
  await f.state.sendEntered.promise;
  try {
    await new Promise(setImmediate);
    assert.equal(settled, false);
    assert.equal(f.calls.invites.length, 0);
  } finally {
    f.state.sendGate.resolve(f.sentMessage);
  }
  await joined;
  assert.equal(settled, true);
});

test("join still welcomes when role assignment fails", async () => {
  const f = fixture();
  f.state.addError = new Error("role unavailable");
  await guildMemberAdd(f.client, f.member);
  assert.equal(f.calls.sends.length, 1);
  assert.deepEqual(f.calls.errors, [["Join role assignment failed", f.state.addError]]);
  assert.equal(f.member.roles.cache.has(f.roles.verified.id), false);
});

test("join still welcomes with fallback inviter data when invite tracking fails", async () => {
  const f = fixture();
  f.settings.invite.tracking = true;
  f.settings.welcome.content = "Invited by {inviter:name} ({invites})";
  f.state.inviteError = new Error("invites unavailable");
  await guildMemberAdd(f.client, f.member);
  assert.equal(f.calls.sends[0].content, "Invited by NA (0)");
  assert.deepEqual(f.calls.errors, [["Invite tracking failed", f.state.inviteError]]);
});

test("join handles and logs welcome rejection", async () => {
  const f = fixture();
  f.state.sendError = new Error("welcome channel denied");
  await assert.doesNotReject(guildMemberAdd(f.client, f.member));
  assert.deepEqual(f.calls.errors, [["Welcome failed", f.state.sendError]]);
});

test("pending join receives no role until the screening-completion event", async () => {
  const f = fixture();
  f.member.pending = true;
  await guildMemberAdd(f.client, f.member);
  assert.equal(f.calls.add.length, 0);
  assert.equal(f.calls.sends.length, 1);
  await guildMemberUpdate(f.client, { pending: true }, f.member);
  assert.equal(f.calls.add.length, 0);
  f.member.pending = false;
  await guildMemberUpdate(f.client, { pending: true }, f.member);
  assert.deepEqual(f.calls.add.map(({ role }) => role.id), [f.roles.unverified.id]);
  assert.equal(f.member.roles.cache.has(f.roles.generic.id), false);
  await guildMemberUpdate(f.client, { pending: false }, f.member);
  assert.equal(f.calls.add.length, 1);
  assert.equal(f.calls.sends.length, 1, "Screening completion should not repeat the welcome");
});

test("nonverification join grants generic autorole through the event", async () => {
  const f = fixture();
  f.settings.verification.enabled = false;
  await guildMemberAdd(f.client, f.member);
  assert.deepEqual(f.calls.add.map(({ role }) => role.id), [f.roles.generic.id]);
  assert.equal(f.calls.sends.length, 1);
});

test("bot joins skip roles, update configured counters, and are skipped after screening", async () => {
  const f = fixture();
  f.member.user.bot = true;
  f.settings.counters = [{ counter_type: "BOTS" }];
  f.client.counterUpdateQueue.push(f.guild.id);
  await guildMemberAdd(f.client, f.member);
  assert.equal(f.calls.add.length, 0);
  assert.equal(f.settings.data.bots, 1);
  assert.equal(f.calls.saves, 1);
  assert.deepEqual(f.client.counterUpdateQueue, [f.guild.id]);
  await guildMemberUpdate(f.client, { pending: true }, f.member);
  assert.equal(f.calls.add.length, 0);
});

test("screening-completion role failures are caught and logged", async () => {
  const f = fixture();
  f.state.addError = new Error("post-screening add denied");
  await assert.doesNotReject(guildMemberUpdate(f.client, { pending: true }, f.member));
  assert.deepEqual(f.calls.errors, [["Post-screening role assignment failed", f.state.addError]]);
});

test("join ignores missing members and missing guilds", async () => {
  const f = fixture();
  await guildMemberAdd(f.client, null);
  await guildMemberAdd(f.client, {});
  assert.equal(f.calls.settings, 0);
  assert.equal(f.calls.add.length, 0);
  assert.equal(f.calls.sends.length, 0);
});
