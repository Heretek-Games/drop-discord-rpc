# Drop Discord RPC

Discord Rich Presence client plugin for Drop (#15).

## How it works

On game launch the plugin opens the local Discord IPC socket
(`$XDG_RUNTIME_DIR/discord-ipc-0` on Linux, `\\.\pipe\discord-ipc-0` on
Windows), performs the opcode-0 handshake, waits for the READY dispatch, and
sends `SET_ACTIVITY` (opcode 1). The post-exit hook clears the activity and
closes the socket.

The Discord application client id is read from client plugin storage under the
`discord_client_id` key. When unset the plugin logs and skips IPC.

The transport is abstracted (`DiscordTransport`); the default
`NodeSocketTransport` lazily imports `node:net`, so the plugin module can still
be loaded in webview bundles where raw sockets are unavailable. In that case
the desktop host needs to provide a transport implementation.

## Build

```sh
npm ci
npm run build
npm test
npm run typecheck
```
