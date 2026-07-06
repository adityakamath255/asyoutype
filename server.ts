import { bundle } from "@deno/emit";
import {
  type ClientInit,
  type ClientMsg,
  decodeClientInit,
  decodeClientMsg,
  PALETTE_SIZE,
  type ServerInit,
  type ServerMsg,
  type SlotInfo,
} from "./protocol.ts";

const MIN_NAME_LEN = 4;
const MAX_NAME_LEN = 10;
const MIN_CAPACITY = 1;
const MAX_CAPACITY = 8;
const MIN_NICK_LEN = 1;
const MAX_NICK_LEN = 16;

const MAX_FRAME = 1024;
const RATE_LIMIT = 256;
const RATE_WINDOW_MS = 1000;

type Subscriber = (msg: ServerMsg) => void;

function tag(id: number, msg: ClientMsg): ServerMsg {
  switch (msg.type) {
    case "Codepoint":
      return {
        type: "TaggedCodepoint",
        clientId: id,
        codepoint: msg.codepoint,
      };
    case "Backspace":
      return { type: "TaggedBackspace", clientId: id };
    case "Clear":
      return { type: "TaggedClear", clientId: id };
  }
}

type Occupant = { sub: Subscriber } & SlotInfo;

class Room {
  private slots: (Occupant | null)[];

  constructor(capacity: number, private readonly onEmpty: () => void) {
    this.slots = Array(capacity).fill(null);
  }

  get capacity(): number {
    return this.slots.length;
  }

  enter(occupant: Occupant): number | null {
    const id = this.slots.indexOf(null);
    if (id === -1) return null;
    this.slots[id] = occupant;
    return id;
  }

  leave(id: number): void {
    this.slots[id] = null;
    if (this.slots.every((slot) => slot === null)) this.onEmpty();
    else this.announce();
  }

  announce(): void {
    this.broadcast({
      type: "Occupancy",
      slots: this.slots.map((o) => o && { nick: o.nick, color: o.color }),
    });
  }

  broadcast(msg: ServerMsg): void {
    for (const slot of this.slots) slot?.sub(msg);
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

function validateIdentity(id: SlotInfo): string | null {
  const length = [...id.nick].length;
  if (length < MIN_NICK_LEN || length > MAX_NICK_LEN) {
    return `Name must be between ${MIN_NICK_LEN} and ${MAX_NICK_LEN} chars`;
  }
  if (id.color < 0 || id.color >= PALETTE_SIZE) return "Invalid colour";
  return null;
}

class Lobby {
  private readonly rooms = new Map<string, Room>();

  join(init: ClientInit, sub: Subscriber): JoinResult {
    const badIdentity = validateIdentity(init);
    if (badIdentity) return { ok: false, msg: badIdentity };

    let room: Room;
    if (init.type === "CreateRoom") {
      const invalid = validateName(init.name) ??
        validateCapacity(init.capacity);
      if (invalid) return { ok: false, msg: invalid };
      if (this.rooms.has(init.name)) {
        return { ok: false, msg: "Room name has been taken!" };
      }
      room = new Room(init.capacity, () => this.rooms.delete(init.name));
      this.rooms.set(init.name, room);
    } else {
      const existing = this.rooms.get(init.name);
      if (!existing) return { ok: false, msg: "Room does not exist!" };
      room = existing;
    }

    const id = room.enter({ sub, nick: init.nick, color: init.color });
    if (id === null) return { ok: false, msg: "Room is full!" };
    return { ok: true, membership: new Membership(room, id) };
  }
}

class Membership {
  constructor(
    private readonly room: Room,
    readonly clientId: number,
  ) {}

  welcome(send: (msg: ServerInit) => void): void {
    send({
      type: "ValidRoom",
      clientId: this.clientId,
      capacity: this.room.capacity,
    });
    this.room.announce();
  }

  feed(msg: ClientMsg): void {
    this.room.broadcast(tag(this.clientId, msg));
  }

  leave(): void {
    this.room.leave(this.clientId);
  }
}

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

function accept(
  lobby: Lobby,
  socket: WebSocket,
  init: ClientInit,
): Membership | null {
  const send = (msg: ServerInit | ServerMsg) =>
    socket.send(JSON.stringify(msg));

  const result = lobby.join(init, send);
  if (!result.ok) {
    send({ type: "InvalidRoom", msg: result.msg });
    socket.close();
    return null;
  }

  result.membership.welcome(send);
  return result.membership;
}

function handleSocket(lobby: Lobby, socket: WebSocket) {
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
      if (init) member = accept(lobby, socket, init);
    }
  };

  socket.onclose = () => member?.leave();
}

const options = Deno.args[0] ? { port: Number(Deno.args[0]) } : {};
const lobby = new Lobby();

Deno.serve(options, (req) => {
  const { pathname } = new URL(req.url);

  if (pathname === "/ws") {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 400 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleSocket(lobby, socket);
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
