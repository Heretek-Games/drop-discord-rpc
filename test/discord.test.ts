import test from "node:test";
import assert from "node:assert/strict";
import { MockClientPluginContext } from "@droposs/plugin-sdk";
import Plugin, { buildPresence } from "../src/index.js";

test("drop-discord-rpc registers launch hooks", async () => {
  const ctx = new MockClientPluginContext("drop-discord-rpc", ["ui:slot", "client:ws", "system:command", "game:launch-hook"]);
  await new Plugin().init(ctx);
  assert.equal(ctx.launchHooks.length, 2);
});

test("buildPresence includes the game title", () => {
  const presence = buildPresence({ gameId: "g", gameTitle: "Hollow Knight", gameDir: "/games/hk" });
  assert.equal(presence.details, "Hollow Knight");
});
