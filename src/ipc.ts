import type { Socket } from "node:net";

/** Discord IPC opcodes. */
export const OP_HANDSHAKE = 0;
export const OP_FRAME = 1;
export const OP_CLOSE = 2;
export const OP_PING = 3;
export const OP_PONG = 4;

export interface DiscordFrame {
  op: number;
  data: unknown;
}

/** Encodes one Discord IPC frame: int32 opcode + int32 length + JSON body (LE). */
export function encodeFrame(op: number, payload: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(payload ?? {}));
  const frame = new Uint8Array(8 + body.length);
  const view = new DataView(frame.buffer);
  view.setInt32(0, op, true);
  view.setInt32(4, body.length, true);
  frame.set(body, 8);
  return frame;
}

/**
 * Decodes as many complete frames as possible, returning trailing bytes that
 * belong to an incomplete frame.
 */
export function decodeFrames(buffer: Uint8Array): {
  frames: DiscordFrame[];
  rest: Uint8Array;
} {
  const frames: DiscordFrame[] = [];
  let offset = 0;
  while (buffer.length - offset >= 8) {
    const view = new DataView(
      buffer.buffer,
      buffer.byteOffset + offset,
      buffer.length - offset,
    );
    const op = view.getInt32(0, true);
    const length = view.getInt32(4, true);
    if (length < 0 || buffer.length - offset - 8 < length) break;
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    frames.push({
      op,
      data: JSON.parse(new TextDecoder().decode(body)) as unknown,
    });
    offset += 8 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/** Byte-stream abstraction over the Discord IPC socket, injectable for tests. */
export interface DiscordTransport {
  connect(path: string): Promise<void>;
  write(data: Uint8Array): void;
  onData(listener: (chunk: Uint8Array) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

/** `node:net` transport, loaded lazily so webview bundles do not crash on import. */
export class NodeSocketTransport implements DiscordTransport {
  private socket: Socket | null = null;
  private readonly dataListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly closeListeners = new Set<() => void>();

  async connect(path: string): Promise<void> {
    const { createConnection } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(path);
      this.socket = socket;
      const onError = (error: Error) => {
        socket.off("connect", onConnect);
        socket.destroy();
        reject(error);
      };
      const onConnect = () => {
        socket.off("error", onError);
        socket.on("error", () => undefined);
        resolve();
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.on("data", (chunk: Buffer) => {
        const bytes = new Uint8Array(
          chunk.buffer,
          chunk.byteOffset,
          chunk.byteLength,
        );
        for (const listener of this.dataListeners) listener(bytes);
      });
      socket.on("close", () => {
        for (const listener of this.closeListeners) listener();
      });
    });
  }

  write(data: Uint8Array): void {
    this.socket?.write(data);
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.dataListeners.add(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

/** Candidate IPC socket paths for the platform, in Discord's search order. */
export function discordSocketPaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const indexes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  if (platform === "win32") {
    return indexes.map((index) => `\\\\.\\pipe\\discord-ipc-${index}`);
  }
  const bases = new Set<string>();
  if (env.XDG_RUNTIME_DIR) {
    bases.add(env.XDG_RUNTIME_DIR);
    bases.add(`${env.XDG_RUNTIME_DIR}/app/com.discordapp.Discord`);
  }
  bases.add(env.TMPDIR || "/tmp");
  return [...bases].flatMap((base) =>
    indexes.map((index) => `${base.replace(/\/+$/, "")}/discord-ipc-${index}`),
  );
}

export interface DiscordActivity {
  details?: string;
  state?: string;
  /** Epoch milliseconds. */
  startTimestamp?: number;
  largeImageKey?: string;
  largeImageText?: string;
  smallImageKey?: string;
  smallImageText?: string;
}

export interface DiscordIpcClientOptions {
  clientId: string;
  pid?: number;
  socketPaths?: string[];
  transportFactory?: () => DiscordTransport;
  handshakeTimeoutMs?: number;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function randomNonce(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `nonce-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Minimal Discord IPC client: connect, handshake (opcode 0), SET_ACTIVITY
 * (opcode 1), and clear on demand. Transport is injectable for tests.
 */
export class DiscordIpcClient {
  private transport: DiscordTransport | null = null;
  private buffer: Uint8Array = new Uint8Array(0);
  private ready = false;
  private closed = false;
  private waiters: ReadyWaiter[] = [];

  constructor(private readonly options: DiscordIpcClientOptions) {}

  get isReady(): boolean {
    return this.ready;
  }

  async connect(): Promise<void> {
    if (this.transport) return;
    const paths = this.options.socketPaths ?? discordSocketPaths();
    const factory =
      this.options.transportFactory ?? (() => new NodeSocketTransport());
    const errors: string[] = [];
    for (const path of paths) {
      const transport = factory();
      try {
        await transport.connect(path);
        this.transport = transport;
        transport.onData((chunk) => this.handleData(chunk));
        transport.onClose(() => this.handleClose());
        transport.write(
          encodeFrame(OP_HANDSHAKE, { v: 1, client_id: this.options.clientId }),
        );
        return;
      } catch (error) {
        transport.close();
        errors.push(`${path}: ${(error as Error).message}`);
      }
    }
    throw new Error(
      `Unable to connect to the Discord IPC socket (${errors.join("; ")})`,
    );
  }

  async setActivity(activity: DiscordActivity | null): Promise<void> {
    await this.connect();
    await this.waitForReady();
    const pid =
      this.options.pid ??
      (typeof process !== "undefined" ? process.pid : 0);
    this.send(OP_FRAME, {
      cmd: "SET_ACTIVITY",
      args: { pid, activity },
      nonce: randomNonce(),
    });
  }

  async clearActivity(): Promise<void> {
    await this.setActivity(null);
  }

  disconnect(): void {
    if (this.transport) {
      try {
        this.send(OP_CLOSE, {});
      } catch {
        // socket already gone
      }
      this.transport.close();
      this.transport = null;
    }
    this.handleClose();
  }

  private send(op: number, payload: unknown): void {
    if (!this.transport) {
      throw new Error("Discord IPC transport is not connected");
    }
    this.transport.write(encodeFrame(op, payload));
  }

  private waitForReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.closed) {
      return Promise.reject(
        new Error("Discord IPC connection closed before READY"),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error("Timed out waiting for Discord IPC READY"));
      }, this.options.handshakeTimeoutMs ?? 5_000);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  private handleData(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    const { frames, rest } = decodeFrames(merged);
    this.buffer = rest;
    for (const frame of frames) this.handleFrame(frame);
  }

  private handleFrame(frame: DiscordFrame): void {
    if (frame.op === OP_PING) {
      this.transport?.write(encodeFrame(OP_PONG, frame.data));
      return;
    }
    if (frame.op === OP_CLOSE) {
      this.disconnect();
      return;
    }
    if (frame.op === OP_FRAME) {
      const data = frame.data as { evt?: string } | null;
      if (data?.evt === "READY") {
        this.ready = true;
        const waiters = this.waiters;
        this.waiters = [];
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve();
        }
      }
    }
  }

  private handleClose(): void {
    this.closed = true;
    this.ready = false;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Discord IPC connection closed"));
    }
  }
}
