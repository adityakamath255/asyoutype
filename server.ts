import { bundle } from "@deno/emit";
import type {
  ClientInit,
  ClientMsg,
  ServerInit,
  ServerMsg,
} from "./protocol.ts";
import { join, type Registry, tag } from "./rooms.ts";

const registry: Registry = new Map();

type Asset = { body: string; type: string };

const file = (path: string) =>
  Deno.readTextFile(new URL(path, import.meta.url));

const assets: Record<string, Asset> = {
  "/": {
    body: await file("./public/index.html"),
    type: "text/html; charset=utf-8",
  },
  "/styles.css": {
    body: await file("./public/styles.css"),
    type: "text/css; charset=utf-8",
  },
  // bundled, not just served: this inlines the shared wire types so the
  // browser gets plain JS and never sees the .ts imports.
  "/main.js": {
    body: (await bundle(new URL("./public/main.ts", import.meta.url))).code,
    type: "text/javascript; charset=utf-8",
  },
};

function parse(data: string): ClientInit | ClientMsg | null {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

type Membership = { feed: (msg: ClientMsg) => void; release: () => void };

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
  send({ type: "ValidRoom", clientId: id, capacity: room.capacity });

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

// No port arg lets the runtime decide (8000 locally, or whatever Deno Deploy
// hands us).
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

  const served = assets[pathname];
  if (served) {
    return new Response(served.body, {
      headers: { "content-type": served.type },
    });
  }

  return new Response("not found", { status: 404 });
});
