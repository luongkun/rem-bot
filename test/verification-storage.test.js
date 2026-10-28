"use strict";

require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { saveVerification } = require("@schemas/Guild");
const Model = mongoose.model("guild");

function fixture() {
  return Model.hydrate({
    _id: "100000000000000001",
    verification: {
      enabled: true,
      channel_id: "100000000000000002",
      message_id: "100000000000000003",
      role_id: "100000000000000004",
      unverified_role_id: "100000000000000005",
    },
  });
}

test("verification cache changes only after database acknowledgement", async (t) => {
  const settings = fixture();
  const previous = settings.verification.toObject();
  const next = { ...previous, enabled: false };
  settings.prefix = "?";
  let acknowledge;
  const pending = new Promise((resolve) => { acknowledge = resolve; });
  const update = t.mock.method(Model, "updateOne", () => pending);
  const saving = saveVerification(settings, next);
  assert.deepEqual(settings.verification.toObject(), previous);
  assert.deepEqual(update.mock.calls[0].arguments, [
    { _id: settings._id }, { $set: { verification: next } }, { runValidators: true },
  ]);
  acknowledge({ matchedCount: 1 });
  await saving;
  assert.deepEqual(settings.verification.toObject(), next);
  assert.equal(settings.isModified("verification"), false);
  assert.equal(settings.isModified("prefix"), true);
});

for (const failure of ["write rejection", "missing settings"]) {
  test(`verification cache remains unchanged after ${failure}`, async (t) => {
    const settings = fixture();
    const previous = settings.verification.toObject();
    t.mock.method(Model, "updateOne", async () => {
      if (failure === "write rejection") throw new Error("write rejected");
      return { matchedCount: 0 };
    });
    await assert.rejects(saveVerification(settings, { ...previous, enabled: false }),
      failure === "write rejection" ? /write rejected/ : /no longer exist/);
    assert.deepEqual(settings.verification.toObject(), previous);
    assert.equal(settings.isModified("verification"), false);
  });
}
