# asyoutype

A small web app for sharing a line of text as it is typed. Each person in a room gets a box, and edits to that box appear on every member's screen over a WebSocket.

Rooms hold between one and eight people and disappear when the last person leaves. The server runs on Deno, and the browser client uses TypeScript and the DOM without a frontend framework.

## Running locally

Install [Deno](https://deno.com/), then run:

```sh
deno task start
```

The app will be available at <http://localhost:8000>. To choose another port, pass it after the task name:

```sh
deno task start 4000
```

The server uses [`@deno/emit`](https://jsr.io/@deno/emit) to bundle the browser client in memory during startup. There is no separate build step or generated JavaScript in the repository.

## Using it

Create a room with a name, capacity, nickname, and colour. After entering, copy the URL to share the room name with someone else. Nickname and colour are saved in local storage for the next visit.

Typing appends Unicode codepoints to your box. Backspace removes the last codepoint, and Escape or the clear button empties the box. Each client keeps the most recent 256 codepoints for every box.

## Implementation

Each edit follows two paths:

```text
                    +--> local box
input -> ClientMsg -+
                    +--> WebSocket -> Room -> other clients
```

The client applies its own edit immediately, then sends the same message to the server. The room adds the sender's client ID and relays the edit to every other member. Local echo keeps typing independent of network round-trip time.

A room owns a fixed array of slots. A new member receives the lowest free slot, and that index identifies both the member and their box. Whenever someone enters or leaves, the room broadcasts the complete occupancy map. Closing a socket frees its slot; empty rooms are removed from the lobby.

The wire protocol uses one JSON object per WebSocket frame and has two phases. The first client message creates or joins a room, and the server either rejects it or returns the assigned client ID and room capacity. Later messages contain a codepoint, backspace, or clear operation.

[`protocol.ts`](protocol.ts) defines each message as a runtime schema. TypeScript types are inferred from those schemas, and both the server and browser use the resulting decoders. This keeps the accepted wire format and the static message types in one place. [`palette.ts`](palette.ts) exports the shared colours and a type guard for valid palette indices.

The browser captures text through a hidden input. A sentinel distinguishes backspace from inserted text, while composition events delay input from an IME until the composition is complete. Iterating over the resulting string sends one Unicode codepoint per message.

At startup, [`server.ts`](server.ts) reads the HTML and CSS, bundles [`public/main.ts`](public/main.ts), and serves all three from memory. The same process owns the lobby and handles WebSocket connections.

## Checks

Type-check the server, browser client, and their transitive imports with:

```sh
deno check server.ts public/main.ts
```

The repository does not currently include an automated test suite.

## Deployment

Use `server.ts` as the entry point on a Deno host. The deployment must include the `public` directory and allow network, file, and environment access. When the page is served over HTTPS, the browser selects `wss://` for the WebSocket connection.

## Limitations

- Rooms and membership live in one server process. Restarting it removes every room, and multiple instances do not share a lobby.
- The server stores occupancy but not the text in each box. A late joiner starts with empty boxes, and a reconnecting client cannot recover earlier text.
- There is no authentication. Anyone who knows a room name can join while a slot is free.
- The server relays up to 256 frames per socket in each one-second window. Later frames are dropped rather than queued, so the sender and other clients can diverge.

## License

[MIT](LICENSE)
