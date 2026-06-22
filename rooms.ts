// Room membership and slot tracking. No sockets here: a subscriber is just a
// sink for ServerMsg, so this layer doesn't care what's on the other end.

import type { ClientInit, ClientMsg, ServerMsg } from "./protocol.ts";

const MIN_NAME_LEN = 4;
const MAX_NAME_LEN = 10;
const MIN_CAPACITY = 1;
const MAX_CAPACITY = 8;

export type Subscriber = (msg: ServerMsg) => void;

export class Room {
  // A slot holds its member's sink, or null when free; the index is the client id.
  private slots: (Subscriber | null)[];

  constructor(capacity: number) {
    this.slots = Array(capacity).fill(null);
  }

  get capacity(): number {
    return this.slots.length;
  }

  enter(sub: Subscriber): number | null {
    const id = this.slots.indexOf(null);
    if (id === -1) return null;
    this.slots[id] = sub;
    return id;
  }

  // Returns true if the room is now empty. Clears the leaver's box so the next
  // joiner to reuse the slot doesn't inherit stale text.
  leave(id: number): boolean {
    this.slots[id] = null;
    this.broadcast({ type: "TaggedClear", clientId: id });
    return this.slots.every((slot) => slot === null);
  }

  broadcast(msg: ServerMsg): void {
    for (const slot of this.slots) slot?.(msg);
  }
}

export type Registry = Map<string, Room>;

export type JoinResult =
  | { ok: true; room: Room; id: number }
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

export function join(
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
  return { ok: true, room, id };
}

export function tag(id: number, msg: ClientMsg): ServerMsg | null {
  if (msg.type === "Codepoint") {
    return typeof msg.codepoint === "string" && [...msg.codepoint].length === 1
      ? { type: "TaggedCodepoint", clientId: id, codepoint: msg.codepoint }
      : null;
  }
  if (msg.type === "Clear") return { type: "TaggedClear", clientId: id };
  return null;
}
