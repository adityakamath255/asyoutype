# text-stream

A small web app for sharing a line of text, live, with a few other people.
Everyone in a room gets a box. As you type, your characters stream into your box
on everyone's screen, one codepoint at a time. Press escape to wipe your line.

The goal of this project is the code itself: a small, clearly factored system
that is pleasant to read. The running app is the excuse, not the point. Terminal
versions in Python and Rust, built around the same design, live alongside it;
this one trades the terminal for a browser so anyone can join from a URL.

## Running it

The project runs on [Deno](https://deno.com/) with no dependencies and no build
step. Start the server:

```sh
deno task start          # serves on http://localhost:8000
deno task start 4000     # or pick a port
```

Open the URL in a browser. Choose create or join, enter a room name, and (for
create) a capacity, then type. Room names are 4 to 10 characters; capacity is 1
to 8. Once in a room, type to stream characters and press escape to clear your
line. Open the same URL in another tab or on another machine to join.

## How it is put together

The app is split along the one seam that matters: the messages on the wire.

- **`protocol.ts`** defines the messages and nothing else.
- **`rooms.ts`** owns the rooms. It never renders anything and knows nothing
  about sockets; it tracks who is in which room and fans messages out to a
  room's subscribers.
- **`server.ts`** wires WebSockets to rooms and serves the page. It owns no room
  logic of its own.
- **`public/index.html`** is the client: it draws the boxes the server describes
  and reports what the user types. It decides nothing about who is allowed in a
  room.

### The wire

Messages are JSON, one per WebSocket text frame. A connection has two phases:

1. **Handshake.** The client sends one `ClientInit` (create or join). The server
   replies with one `ServerInit`: either `ValidRoom` with the client's assigned
   id and the room capacity, or `InvalidRoom` with a reason, after which the
   connection closes.
2. **Streaming.** From then on the client sends `ClientMsg` values (a codepoint,
   or a clear) and receives `ServerMsg` values. The difference between the two
   is a `client_id`: the server stamps each message with the id of whoever sent
   it, so every client knows which box to put a character in.

### Rooms and identity

A room is a fixed set of slots, decided at creation. Joining takes the lowest
free slot, and that slot index _is_ your client id and your box on screen. When
you leave, your slot frees up and can be reused by the next person who joins.

Membership is tied to the WebSocket: when a connection closes, for any reason,
the slot frees and the room is removed if it just emptied. Inside a room, a sent
message reaches every subscriber, including the sender, so everyone applies the
same updates the same way.

## Deploying it

The least-effort path is [Deno Deploy](https://deno.com/deploy): point a project
at this directory with `server.ts` as the entrypoint and push. It serves over
HTTPS, so the client connects with `wss://` automatically, and the runtime
assigns the port (passing no port argument lets it). The single `server.ts` also
runs unchanged on any box with Deno installed.

## Development

```sh
deno task check   # type-check
deno task lint    # lints
deno task fmt     # formatting
```
