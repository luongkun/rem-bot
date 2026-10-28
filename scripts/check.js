const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

process.chdir(path.join(__dirname, ".."));
for (const key of ["BOT_TOKEN", "MONGO_CONNECTION", "ERROR_LOGS", "JOIN_LEAVE_LOGS", "BOT_SECRET", "SESSION_PASSWORD"]) {
  delete process.env[key];
}
process.env.GUILD_ID = "100000000000000001";
require("module-alias/register");

const denyNetwork = () => { throw new Error("Network access is forbidden during offline checks"); };
require("node:net").Socket.prototype.connect = denyNetwork;
require("node:tls").connect = denyNetwork;
global.fetch = denyNetwork;

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? javascriptFiles(file) : file.endsWith(".js") ? [file] : [];
  });
}

const files = ["bot.js", "config.js", ...javascriptFiles("src")];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(result.status, 0, `Syntax error in ${file}: ${result.stderr}`);
}

const errors = [];
const noop = () => {};
const logger = { log: noop, debug: noop, warn: noop, success: noop, error: (...args) => errors.push(args.join(" ")) };
const loggerPath = require.resolve("@helpers/Logger");
require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: logger };

const { Collection } = require("discord.js");
const mongoose = require("mongoose");
mongoose.connect = denyNetwork;
const BotClient = require("@structures/BotClient");
const config = require("@root/config");
const eventFiles = javascriptFiles("src/events");
const intervalHandles = [];
const originalSetInterval = global.setInterval;
global.setInterval = (...args) => {
  const timer = originalSetInterval(...args);
  intervalHandles.push(timer);
  return timer;
};
try {
  for (const file of eventFiles) {
    assert.equal(typeof require(path.resolve(file)), "function", `Invalid event handler: ${file}`);
  }
} finally {
  global.setInterval = originalSetInterval;
  for (const timer of intervalHandles) clearInterval(timer);
}
const client = {
  commands: [],
  commandIndex: new Collection(),
  slashCommands: new Collection(),
  contextMenus: new Collection(),
  logger,
  config,
  loadCommand: BotClient.prototype.loadCommand,
};
BotClient.prototype.loadCommands.call(client, "src/commands");
assert.deepEqual(errors, [], `Command load failures: ${errors.join("; ")}`);
for (const command of ["setup", "verify", "welcome", "farewell", "autorole", "ticket", "ticketcat", "addrr"]) {
  assert.ok(client.slashCommands.has(command), `Missing slash command: ${command}`);
}
assert.equal(client.slashCommands.has("giveaway"), false);
assert.equal(config.MUSIC.ENABLED, false);
assert.equal(config.DASHBOARD.enabled, false);

let registered;
const fakeGuild = { commands: { set: async (commands) => { registered = commands; } } };
client.guilds = { cache: new Collection([[process.env.GUILD_ID, fakeGuild]]) };
(async () => {
  await BotClient.prototype.registerInteractions.call(client, process.env.GUILD_ID);
  assert.ok(registered.length <= 100);
  const verify = registered.find((command) => command.name === "verify");
  assert.ok(verify.defaultMemberPermissions > 0n);
  assert.equal(verify.dmPermission, false);

  require("@schemas/Guild");
  const Guild = mongoose.model("guild");
  const doc = new Guild({
    _id: process.env.GUILD_ID,
    verification: { enabled: true, role_id: "100000000000000002", unverified_role_id: "100000000000000003", channel_id: "100000000000000004", message_id: "100000000000000005" },
  });
  await doc.validate();
  const restored = Guild.hydrate(JSON.parse(JSON.stringify(doc.toObject())));
  assert.equal(restored.verification.message_id, doc.verification.message_id);
  assert.equal(restored.verification.role_id, doc.verification.role_id);
  assert.equal(restored.verification.enabled, true);
  assert.deepEqual(errors, []);
  console.log(`Offline checks passed: ${files.length} JavaScript files, ${registered.length} slash commands, verification schema round-trip. No Discord or database connection was made.`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
