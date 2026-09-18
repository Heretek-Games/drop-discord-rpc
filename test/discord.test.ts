import test from "node:test";
import assert from "node:assert/strict";
import { MockClientPluginContext } from "@droposs/plugin-sdk";
import type { LaunchContext } from "@droposs/plugin-sdk";
import Plugin, {
  type DiscordFrame,
  type DiscordTransport,
  DiscordIpcClient,
  MAX_FRAME_BYTES,
  buildPresence,
  decodeFrames,
  discordSocketPaths,
  encodeFrame,
  presenceToActivity,
} from "../src/index.js";

const LAUNCH: LaunchContext = {
  gameId: "game-1",
  gameTitle: "Hollow Knight",
  gameDir: "/games/hk",
};

class FakeTransport implements DiscordTransport {
  connectedPath: string | null = null;
  connectError?: Error;
  closed = false;
  writes: Uint8Array[] = [];
  private dataListeners = new Set<(chunk: Uint8Array) => void>();
  private closeListeners = new Set<() => void>();

  async connect(path: string): Promise<void> {
    if (this.connectError) throw this.connectError;
    this.connectedPath = path;
  }

  write(data: Uint8Array): void {
    this.writes.push(data);
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.dataListeners.add(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  close(): void {
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }

  emitFrame(op: number, data: unknown): void {
    const frame = encodeFrame(op, data);
    for (const listener of this.dataListeners) listener(frame);
  }

  emitRaw(bytes: Uint8Array): void {
    for (const listener of this.dataListeners) listener(bytes);
  }

  frames(): DiscordFrame[] {
    const total = this.writes.reduce((size, write) => size + write.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const write of this.writes) {
      merged.set(write, offset);
      offset += write.length;
    }
    return decodeFrames(merged).frames;
  }
}

function clientFor(fake: FakeTransport, overrides = {}) {
  return new DiscordIpcClient({
    clientId: "1234567890",
    pid: 4242,
    socketPaths: ["/tmp/discord-ipc-0"],
    transportFactory: () => fake,
    handshakeTimeoutMs: 500,
    ...overrides,
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("drop-discord-rpc registers launch and cleanup hooks", async () => {
  const ctx = new MockClientPluginContext("drop-discord-rpc", [
    "game:launch-hook",
    "client:storage",
  ]);
  await new Plugin().init(ctx);
  assert.equal(ctx.launchHooks.length, 2);
  assert.deepEqual(
    ctx.launchHooks.map((hook) => hook.stage).sort(),
    ["launch", "post-exit:cleanup"],
  );
});

test("buildPresence and presenceToActivity map the launch context", () => {
  const presence = buildPresence(LAUNCH);
  assert.equal(presence.details, "Hollow Knight");
  assert.equal(presence.state, "Playing on Drop");
  assert.ok((presence.startTimestamp ?? 0) > 1_600_000_000_000);
  assert.deepEqual(presenceToActivity(presence), {
    details: "Hollow Knight",
    state: "Playing on Drop",
    startTimestamp: presence.startTimestamp,
  });
});

test("encodeFrame/decodeFrames round-trip including partial chunks", () => {
  const first = encodeFrame(1, { cmd: "SET_ACTIVITY" });
  const second = encodeFrame(3, { ping: true });
  const merged = new Uint8Array([...first, ...second]);

  const whole = decodeFrames(merged);
  assert.equal(whole.rest.length, 0);
  assert.deepEqual(whole.frames[0], { op: 1, data: { cmd: "SET_ACTIVITY" } });
  assert.deepEqual(whole.frames[1], { op: 3, data: { ping: true } });

  const partial = decodeFrames(merged.subarray(0, first.length + 4));
  assert.equal(partial.frames.length, 1);
  assert.equal(partial.rest.length, 4);
});

test("decodeFrames rejects oversized and negative frame lengths", () => {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setInt32(0, 1, true);

  view.setInt32(4, MAX_FRAME_BYTES + 1, true);
  assert.throws(() => decodeFrames(header), /exceeds maximum/);

  view.setInt32(4, -1, true);
  assert.throws(() => decodeFrames(header), /Invalid Discord IPC frame length/);

  // A custom cap is honored.
  view.setInt32(4, 10, true);
  assert.throws(() => decodeFrames(header, 8), /exceeds maximum 8/);
});

test("client drops the connection on an oversized frame header", async () => {
  const fake = new FakeTransport();
  const client = clientFor(fake);
  await client.connect();
  fake.emitFrame(1, { evt: "READY" });
  await tick();
  assert.equal(client.isReady, true);

  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setInt32(0, 1, true);
  view.setInt32(4, MAX_FRAME_BYTES + 1, true);
  fake.emitRaw(header);
  await tick();

  assert.equal(fake.closed, true);
  assert.equal(client.isReady, false);
});

test("discordSocketPaths follows the platform conventions", () => {
  const linux = discordSocketPaths("linux", {
    XDG_RUNTIME_DIR: "/run/user/1000",
  });
  assert.equal(linux[0], "/run/user/1000/discord-ipc-0");
  assert.ok(linux.includes("/run/user/1000/app/com.discordapp.Discord/discord-ipc-0"));
  assert.ok(linux.includes("/tmp/discord-ipc-0"));
  assert.equal(linux.at(-1), "/tmp/discord-ipc-9");

  const windows = discordSocketPaths("win32", {});
  assert.equal(windows[0], "\\\\.\\pipe\\discord-ipc-0");
  assert.equal(windows.at(-1), "\\\\.\\pipe\\discord-ipc-9");
});

test("DiscordIpcClient handshakes, sets activity, clears, and closes", async () => {
  const fake = new FakeTransport();
  const client = clientFor(fake);

  const activity = client.setActivity({ details: "Hollow Knight", startTimestamp: 123 });
  await tick();

  const handshake = fake.frames();
  assert.deepEqual(handshake, [
    { op: 0, data: { v: 1, client_id: "1234567890" } },
  ]);

  fake.emitFrame(1, { evt: "READY", cmd: "DISPATCH" });
  await activity;

  const withActivity = fake.frames();
  assert.equal(withActivity.length, 2);
  assert.equal(withActivity[1].op, 1);
  const payload = withActivity[1].data as {
    cmd: string;
    nonce: string;
    args: { pid: number; activity: unknown };
  };
  assert.equal(payload.cmd, "SET_ACTIVITY");
  assert.equal(payload.args.pid, 4242);
  assert.deepEqual(payload.args.activity, { details: "Hollow Knight", startTimestamp: 123 });
  assert.ok(payload.nonce.length > 0);

  await client.clearActivity();
  const cleared = fake.frames();
  assert.deepEqual(
    (cleared.at(-1)?.data as { args: { activity: null } }).args.activity,
    null,
  );

  client.disconnect();
  assert.ok(fake.closed);
  assert.deepEqual(fake.frames().at(-1), { op: 2, data: {} });
});

test("DiscordIpcClient answers pings and falls back across socket paths", async () => {
  const failing = new FakeTransport();
  failing.connectError = new Error("ENOENT");
  const working = new FakeTransport();
  let attempts = 0;
  const client = new DiscordIpcClient({
    clientId: "42",
    socketPaths: ["/tmp/missing", "/tmp/discord-ipc-1"],
    transportFactory: () => (attempts++ === 0 ? failing : working),
    handshakeTimeoutMs: 500,
  });

  await client.connect();
  assert.equal(working.connectedPath, "/tmp/discord-ipc-1");

  working.emitFrame(3, { nonce: "abc" });
  const frames = working.frames();
  assert.deepEqual(frames.at(-1), { op: 4, data: { nonce: "abc" } });
});

test("plugin runs the IPC client on launch and clears on post-exit", async () => {
  const fake = new FakeTransport();
  const ctx = new MockClientPluginContext("drop-discord-rpc", [
    "game:launch-hook",
    "client:storage",
  ]);
  await ctx.storage.set("discord_client_id", "999");
  await new Plugin({
    transportFactory: () => fake,
    socketPaths: ["/tmp/discord-ipc-0"],
    handshakeTimeoutMs: 500,
  }).init(ctx);

  const launch = ctx.launchHooks.find((hook) => hook.stage === "launch")!;
  const cleanup = ctx.launchHooks.find(
    (hook) => hook.stage === "post-exit:cleanup",
  )!;

  const running = launch.execute(LAUNCH);
  await tick();
  fake.emitFrame(1, { evt: "READY" });
  await running;

  const sent = fake.frames();
  assert.equal(sent[0].op, 0);
  const activity = (sent[1].data as { args: { activity: { details: string } } })
    .args.activity;
  assert.equal(activity.details, "Hollow Knight");

  await cleanup.execute(LAUNCH);
  assert.deepEqual(
    (fake.frames().at(-2)?.data as { args: { activity: null } }).args.activity,
    null,
  );
  assert.ok(fake.closed);
});

test("plugin skips IPC when no client id is configured", async () => {
  let created = 0;
  const ctx = new MockClientPluginContext("drop-discord-rpc", [
    "game:launch-hook",
    "client:storage",
  ]);
  await new Plugin({
    transportFactory: () => {
      created += 1;
      return new FakeTransport();
    },
    socketPaths: ["/tmp/discord-ipc-0"],
  }).init(ctx);

  const launch = ctx.launchHooks.find((hook) => hook.stage === "launch")!;
  await launch.execute(LAUNCH);
  await ctx.launchHooks.find((hook) => hook.stage === "post-exit:cleanup")!.execute(LAUNCH);
  assert.equal(created, 0);
});
