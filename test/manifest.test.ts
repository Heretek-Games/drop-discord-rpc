import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { ClientCapability } from "@droposs/plugin-sdk";
import DiscordRpcPlugin from "../src/index.js";

// Drop validates `drop-plugin.json` against the SDK's shipped manifest schema,
// so that schema is the source of truth for capability names. The schema is
// published as `@droposs/plugin-sdk/schema/drop-plugin.schema.json`.
const schemaPath = createRequire(import.meta.url).resolve(
  "@droposs/plugin-sdk/schema.json",
);
const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as {
  properties: { capabilities: { items: { enum: string[] } } };
};
const KNOWN_CAPABILITIES = new Set(
  schema.properties.capabilities.items.enum,
);

// Drop's PluginManager / desktop client plugin loader resolves capabilities
// from the shipped manifest. If a capability the code requires is omitted,
// runtime access fails closed.
const manifest = JSON.parse(
  readFileSync(path.join(process.cwd(), "drop-plugin.json"), "utf-8"),
) as { capabilities: string[] };

// Capabilities this plugin's implementation actually requires. Typed against
// the SDK `ClientCapability` union so a renamed capability fails typecheck.
const REQUIRED_CAPABILITIES: ClientCapability[] = [
  "game:launch-hook",
  "client:storage",
];

function unknownCapabilities(capabilities: readonly string[]): string[] {
  return capabilities.filter((capability) => !KNOWN_CAPABILITIES.has(capability));
}

test("shipped manifest declares only capabilities known to the SDK schema", () => {
  const unknown = unknownCapabilities(manifest.capabilities);
  assert.deepEqual(
    unknown,
    [],
    `manifest declares unknown capabilities: ${unknown.join(", ")}`,
  );
});

test("shipped manifest grants every capability the plugin requires", () => {
  const declared = new Set(manifest.capabilities);
  const missing = REQUIRED_CAPABILITIES.filter(
    (capability) => !declared.has(capability),
  );
  assert.deepEqual(
    missing,
    [],
    `manifest is missing required capabilities: ${missing.join(", ")}`,
  );
});

test("shipped manifest declares no capabilities beyond the required contract", () => {
  const requiredSet = new Set<string>(REQUIRED_CAPABILITIES);
  const extra = manifest.capabilities.filter((cap) => !requiredSet.has(cap));
  assert.deepEqual(
    extra,
    [],
    `manifest declares unused capabilities: ${extra.join(", ")}`,
  );
});

test("the plugin's declared metadata matches the required capability contract", () => {
  const declared = new DiscordRpcPlugin().metadata.capabilities as string[];
  assert.deepEqual(
    [...declared].sort(),
    [...REQUIRED_CAPABILITIES].sort(),
  );
});

test("unknown capabilities fail the SDK schema check", () => {
  const typo = "game:launch-hooks";
  const unknown = unknownCapabilities([...manifest.capabilities, typo]);
  assert.deepEqual(
    unknown,
    [typo],
    `expected the schema check to flag ${typo}`,
  );
});
