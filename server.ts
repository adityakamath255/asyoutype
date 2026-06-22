// The server: it owns the rooms and the HTTP/WebSocket front. It never renders
// anything; it routes messages and tracks who is in which room. Each browser
// connects over one WebSocket whose two phases mirror the wire protocol: one
// `ClientInit` in and one `ServerInit` out, then a stream of `ClientMsg` in and
// `ServerMsg` out.

import type {
  ClientInit,
  ClientMsg,
  ServerInit,
  ServerMsg,
} from "./protocol.ts";
import { join, type Registry, tag } from "./rooms.ts";

const registry: Registry = new Map();

const indexHtml = await Deno.readTextFile(
  new URL("./public/index.html", import.meta.url),
);

function parse(data: string): ClientInit | ClientMsg | null {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// An accepted connection's hold on its room: how to feed it the client's
// messages, and how to let go. `release` is the whole teardown path, run when
// the connection closes however it ends, so the slot frees and an emptied room
// is torn down with no separate cleanup to forget.
type Membership = { feed: (msg: ClientMsg) => void; release: () => void };

// Runs the handshake. On success the connection holds a room slot; on failure
// the client is told why and the socket is closed.
function accept(socket: WebSocket, init: ClientInit): Membership | null {
  const send = (msg: ServerInit | ServerMsg) =>
    socket.send(JSON.stringify(msg));

  const result = join(registry, init);
  if (!result.ok) {
    send({ type: "InvalidRoom", msg: result.msg });
    socket.close();
    return null;
  }

  const { room, id } = result;
  room.subscribe(send);
  send({ type: "ValidRoom", client_id: id, capacity: room.capacity });

  return {
    feed: (msg) => room.broadcast(tag(id, msg)),
    release: () => {
      room.unsubscribe(send);
      if (room.leave(id) && registry.get(init.name) === room) {
        registry.delete(init.name);
      }
    },
  };
}

function handleSocket(socket: WebSocket) {
  let member: Membership | null = null;

  socket.onmessage = (event) => {
    const msg = parse(event.data);
    if (!msg) return;
    if (member) member.feed(msg as ClientMsg);
    else member = accept(socket, msg as ClientInit);
  };

  socket.onclose = () => member?.release();
}

// A port given on the command line wins; otherwise let the runtime pick (a
// fixed local default, or whatever a host like Deno Deploy assigns).
const options = Deno.args[0] ? { port: Number(Deno.args[0]) } : {};

Deno.serve(options, (req) => {
  const { pathname } = new URL(req.url);

  if (pathname === "/ws") {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 400 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleSocket(socket);
    return response;
  }

  if (pathname === "/") {
    return new Response(indexHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return new Response("not found", { status: 404 });
});
