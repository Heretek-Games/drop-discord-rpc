import type {
  ClientPlugin,
  ClientPluginContext,
  LaunchContext,
} from "@droposs/plugin-sdk";

export interface Presence {
  details: string;
  state: string;
  startTimestamp?: number;
}

export function buildPresence(context: LaunchContext): Presence {
  return {
    details: context.gameTitle,
    state: "Playing on Drop",
    startTimestamp: Math.floor(Date.now() / 1000),
  };
}

export default class DiscordRpcPlugin implements ClientPlugin {
  metadata = {
    id: "drop-discord-rpc",
    name: "Discord Rich Presence",
    version: "0.1.0",
  };

  async init(ctx: ClientPluginContext): Promise<void> {
    ctx.registerLaunchHook({
      stage: "launch",
      execute: async (context) => {
        const presence = buildPresence(context);
        await ctx.serverWs.send("discord:presence", presence);
        ctx.logger.debug(`Discord presence set for ${context.gameTitle}`);
      },
    });

    ctx.registerLaunchHook({
      stage: "post-exit:cleanup",
      execute: async () => {
        await ctx.serverWs.send("discord:presence", null);
      },
    });

    ctx.logger.info("Discord Rich Presence plugin initialized");
  }
}
