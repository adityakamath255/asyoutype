import { bundle } from "@deno/emit";
import {
  type ClientInit,
  type ClientMsg,
  decodeClientInit,
  decodeClientMsg,
  type ServerInit,
  type ServerMsg,
} from "./protocol.ts";

const MIN_NAME_LEN = 4;
const MAX_NAME_LEN = 10;
const MIN_CAPACITY = 1;
const MAX_CAPACITY = 8;

const MAX_FRAME = 1024;
const RATE_LIMIT = 256;
const RATE_WINDOW_MS = 1000;

type Subscriber = (msg: ServerMsg) => void;

function tag(id: number, msg: ClientMsg): ServerMsg {
  return msg.type === "Codepoint"
    ? { type: "TaggedCodepoint", clientId: id, codepoint: msg.codepoint }
    : { type: "TaggedClear", clientId: id };
}

class Room {
  private slots: (Subscriber | null)[];

  constructor(capacity: number) {
    this.slots = Array(capacity).fill(null);
  }

  get capacity(): number {
    return this.slots.length;
  }

  get isEmpty(): boolean {
    return this.slots.every((slot) => slot === null);
  }

  enter(sub: Subscriber): number | null {
    const id = this.slots.indexOf(null);
    if (id === -1) return null;
    this.slots[id] = sub;
    return id;
  }

  leave(id: number): void {
    this.slots[id] = null;
    this.broadcast({ type: "TaggedClear", clientId: id });
  }

  broadcast(msg: ServerMsg): void {
    for (const slot of this.slots) slot?.(msg);
  }
}

type Registry = Map<string, Room>;

class Membership {
  constructor(
    private readonly registry: Registry,
    private readonly name: string,
    readonly room: Room,
    readonly clientId: number,
  ) {}

  feed(msg: ClientMsg): void {
    this.room.broadcast(tag(this.clientId, msg));
  }

  leave(): void {
    this.room.leave(this.clientId);
    if (this.room.isEmpty) this.registry.delete(this.name);
  }
}

type JoinResult =
  | { ok: true; membership: Membership }
  | { ok: false; msg: string };

function validateName(name: string): string | null {
  const length = [...name].length;
  return length >= MIN_NAME_LEN && length <= MAX_NAME_LEN
    ? null
    : `Room name must be between ${MIN_NAME_LEN} and ${MAX_NAME_LEN} chars`;
}

function validateCapacity(capacity: number): string | null {
  return capacity >= MIN_CAPACITY && capacity <= MAX_CAPACITY
    ? null
    : `Room capacity must be between ${MIN_CAPACITY} and ${MAX_CAPACITY} members`;
}

function join(
  registry: Registry,
  init: ClientInit,
  sub: Subscriber,
): JoinResult {
  let room: Room;
  if (init.type === "CreateRoom") {
    const invalid = validateName(init.name) ?? validateCapacity(init.capacity);
    if (invalid) return { ok: false, msg: invalid };
    if (registry.has(init.name)) {
      return { ok: false, msg: "Room name has been taken!" };
    }
    room = new Room(init.capacity);
    registry.set(init.name, room);
  } else {
    const existing = registry.get(init.name);
    if (!existing) return { ok: false, msg: "Room does not exist!" };
    room = existing;
  }

  const id = room.enter(sub);
  if (id === null) return { ok: false, msg: "Room is full!" };
  return { ok: true, membership: new Membership(registry, init.name, room, id) };
}

const registry: Registry = new Map();

function rateLimiter(limit: number, windowMs: number): () => boolean {
  let windowStart = 0;
  let count = 0;
  return () => {
    const now = Date.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      count = 0;
    }
    return count++ < limit;
  };
}

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
  "/main.js": {
    body: (await bundle(new URL("./public/main.ts", import.meta.url))).code,
    type: "text/javascript; charset=utf-8",
  },
};

function accept(socket: WebSocket, init: ClientInit): Membership | null {
  const send = (msg: ServerInit | ServerMsg) =>
    socket.send(JSON.stringify(msg));

  const result = join(registry, init, send);
  if (!result.ok) {
    send({ type: "InvalidRoom", msg: result.msg });
    socket.close();
    return null;
  }

  const { membership } = result;
  send({
    type: "ValidRoom",
    clientId: membership.clientId,
    capacity: membership.room.capacity,
  });
  return membership;
}

function handleSocket(socket: WebSocket) {
  let member: Membership | null = null;
  const allow = rateLimiter(RATE_LIMIT, RATE_WINDOW_MS);

  socket.onmessage = (event) => {
    if (typeof event.data !== "string" || event.data.length > MAX_FRAME) {
      socket.close();
      return;
    }
    if (!allow()) return;
    if (member) {
      const msg = decodeClientMsg(event.data);
      if (msg) member.feed(msg);
    } else {
      const init = decodeClientInit(event.data);
      if (init) member = accept(socket, init);
    }
  };

  socket.onclose = () => member?.leave();
}

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
