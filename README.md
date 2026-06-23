# asyoutype

A small web app for sharing a line of text live. Everyone in a room gets a box;
as you type, your characters stream into your box on everyone's screen, one
codepoint at a time. Escape clears your line.

## Running

Needs [Deno](https://deno.com/). The one dependency,
[`@deno/emit`](https://jsr.io/@deno/emit), transpiles the browser client at
startup, so there's no build step.

```sh
deno task start          # http://localhost:8000
deno task start 4000     # or pick a port
```

Open the URL, choose create or join, enter a room name (4-10 chars) and, for
create, a capacity (1-8). Type to stream, escape to clear. Open the URL in
another tab or machine to join.

## Layout

The split follows the wire protocol.

- **`protocol.ts`**: the messages.
- **`server.ts`**: the rooms and the socket wiring. A `Room` is slot bookkeeping
  that fans messages out to its subscribers; the surrounding code wires
  WebSockets to rooms and serves the page. At startup it bundles the client into
  one JS file with the wire types inlined, so the browser never receives
  TypeScript.
- **`public/`**: the client. `main.ts` renders and reports keystrokes,
  `index.html` is the markup, `styles.css` the look. It imports the wire types
  from `protocol.ts` so both ends agree on the messages.

### The wire

JSON, one message per frame. Two phases:

1. **Handshake.** The client sends one `ClientInit` (create or join). The server
   replies `ValidRoom` (with the assigned id and capacity) or `InvalidRoom`
   (with a reason, then closes).
2. **Streaming.** The client sends `ClientMsg` (a codepoint or a clear); the
   server echoes back `ServerMsg` stamped with the sender's `clientId` so every
   client knows which box to update.

### Rooms and identity

A room is a fixed set of slots, sized at creation. Joining takes the lowest free
slot; that index is your client id and your box. Leaving frees the slot for the
next joiner.

Membership tracks the WebSocket: when a connection closes for any reason the
slot frees, and the room is dropped if it just emptied. Broadcasts go to every
subscriber including the sender.

## Deploying it

[Deno Deploy](https://deno.com/deploy): point a project at this directory with
`server.ts` as the entrypoint. It serves over HTTPS, so the client picks
`wss://` automatically, and the runtime assigns the port (pass no port arg). The
same `server.ts` runs unchanged anywhere Deno is installed.

## Development

```sh
deno task check   # type-check
deno task lint
deno task fmt
```
