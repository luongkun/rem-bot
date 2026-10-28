const test = require("node:test");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { IntentsBitField } = require("discord.js");
const giveawayRequire = createRequire(require.resolve("discord-giveaways"));
const lavaRequire = createRequire(require.resolve("lavaclient"));

test("patched merge library preserves giveaway defaults and array replacement", () => {
  const { deepmerge, deepmergeCustom } = giveawayRequire("deepmerge-ts");
  const original = { lastChance: { enabled: false, threshold: 100 }, roles: ["one"] };
  const merged = deepmerge(original, { lastChance: { enabled: true } });
  assert.deepEqual(merged.lastChance, { enabled: true, threshold: 100 });
  assert.equal(original.lastChance.enabled, false);
  assert.deepEqual(deepmergeCustom({ mergeArrays: false })(original, { roles: ["two"] }).roles, ["two"]);
});

test("patched serializer retains giveaway BigInt and callback serialization", () => {
  const serialize = giveawayRequire("serialize-javascript");
  assert.equal(serialize(12n), 'BigInt("12")');
  assert.match(serialize((member) => member.user.bot), /member\.user\.bot/);
  assert.equal(serialize({ text: "</script>" }).includes("</script>"), false);
});

test("giveaway manager constructs with patched defaults without startup or storage", () => {
  const { GiveawaysManager, Giveaway } = require("discord-giveaways");
  const fakeClient = { options: { intents: [IntentsBitField.Flags.GuildMessageReactions] } };
  const manager = new GiveawaysManager(fakeClient, { default: { lastChance: { enabled: true } } }, false);
  assert.equal(manager.ready, false);
  assert.equal(manager.options.default.lastChance.enabled, true);
  const giveaway = new Giveaway(manager, { prize: "Example", winnerCount: 1, lastChance: { threshold: 5000 } });
  assert.equal(giveaway.lastChance.enabled, true);
  assert.equal(giveaway.lastChance.threshold, 5000);
});

test("Lavalink resolves the patched Pool API without a network connection", async () => {
  const { Pool } = lavaRequire("undici");
  const pool = new Pool("http://127.0.0.1:2333");
  assert.equal(typeof pool.request, "function");
  assert.equal(pool.stats.connected, 0);
  await pool.close();
});
