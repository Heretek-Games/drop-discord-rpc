import type {
  ClientPlugin,
  ClientPluginContext,
  LaunchContext,
} from "@droposs/plugin-sdk";
import {
  type DiscordActivity,
  type DiscordTransport,
  DiscordIpcClient,
} from "./ipc.js";

export * from "./ipc.js";

export interface Presence {
  details: string;
  state: string;
  /** Epoch milliseconds. */
  startTimestamp?: number;
}

export interface DiscordRpcPluginOptions {
  transportFactory?: () => DiscordTransport;
  socketPaths?: string[];
  pid?: number;
  handshakeTimeoutMs?: number;
}

const CLIENT_ID_KEY = "discord_client_id";

export function buildPresence(context: LaunchContext): Presence {
  return {
    details: context.gameTitle,
    state: "Playing on Drop",
    startTimestamp: Date.now(),
  };
}

/** Maps a Drop presence to the Discord `SET_ACTIVITY` payload shape. */
export function presenceToActivity(presence: Presence): DiscordActivity {
  return {
    details: presence.details,
    state: presence.state,
    startTimestamp: presence.startTimestamp,
  };
}

export default class DiscordRpcPlugin implements ClientPlugin {
  metadata = {
    id: "drop-discord-rpc",
    name: "Discord Rich Presence",
    version: "0.1.0",
    apiVersion: 2,
    capabilities: ["game:launch-hook" as const],
  };

  private activeClient: DiscordIpcClient | null = null;

  constructor(private readonly options: DiscordRpcPluginOptions = {}) {}

  async init(ctx: ClientPluginContext): Promise<void> {
    ctx.registerLaunchHook({
      stage: "launch",
      execute: async (context) => {
        const client = await this.getClient(ctx);
        if (!client) return;
        try {
          await client.setActivity(
            presenceToActivity(buildPresence(context)),
          );
          ctx.logger.debug(`Discord presence set for ${context.gameTitle}`);
        } catch (error) {
          ctx.logger.warn(
            `Discord presence failed for ${context.gameTitle}: ${(error as Error).message}`,
          );
          client.disconnect();
          if (this.activeClient === client) this.activeClient = null;
        }
      },
    });

    ctx.registerLaunchHook({
      stage: "post-exit:cleanup",
      execute: async () => {
        const client = this.activeClient;
        this.activeClient = null;
        if (!client) return;
        try {
          await client.clearActivity();
        } catch (error) {
          ctx.logger.warn(
            `Discord presence cleanup failed: ${(error as Error).message}`,
          );
        } finally {
          client.disconnect();
        }
      },
    });

    ctx.logger.info("Discord Rich Presence plugin initialized");
  }

  private async getClient(
    ctx: ClientPluginContext,
  ): Promise<DiscordIpcClient | null> {
    if (this.activeClient) return this.activeClient;
    const clientId = await ctx.storage.get<string>(CLIENT_ID_KEY);
    if (!clientId) {
      ctx.logger.debug(
        `Discord Rich Presence has no "${CLIENT_ID_KEY}" configured; skipping IPC`,
      );
      return null;
    }
    this.activeClient = new DiscordIpcClient({ clientId, ...this.options });
    return this.activeClient;
  }
}
