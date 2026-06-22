// The room domain: who is allowed into which room, and how membership is
// tracked. This module knows nothing about sockets; it only manages slots and
// the set of subscribers a room fans its messages out to. A subscriber is any
// sink for `ServerMsg` (the server hands each connection one that writes to its
// socket), which keeps this layer transport-agnostic the way the wire seam is.

import type { ClientInit, ClientMsg, ServerMsg } from "./protocol.ts";

const MIN_NAME_LEN = 4;
const MAX_NAME_LEN = 10;
const MIN_CAPACITY = 1;
const MAX_CAPACITY = 8;

export type Subscriber = (msg: ServerMsg) => void;

export class Room {
  private slots: boolean[];
  private subscribers = new Set<Subscriber>();

  constructor(capacity: number) {
    this.slots = Array(capacity).fill(false);
  }

  get capacity(): number {
    return this.slots.length;
  }

  // The lowest free slot, claimed; its index is the client's id and its box on
  // screen. `null` when the room is full.
  enter(): number | null {
    const id = this.slots.indexOf(false);
    if (id === -1) return null;
    this.slots[id] = true;
    return id;
  }

  // Frees a slot and returns whether the room is now empty, so the caller can
  // drop it. Wipes the leaver's box on everyone else's screen: the slot may be
  // reused by the next joiner, who should start from a blank line rather than
  // inherit the previous occupant's text.
  leave(id: number): boolean {
    this.slots[id] = false;
    this.broadcast({ type: "TaggedClear", client_id: id });
    return this.slots.every((taken) => !taken);
  }

  subscribe(sub: Subscriber): void {
    this.subscribers.add(sub);
  }

  unsubscribe(sub: Subscriber): void {
    this.subscribers.delete(sub);
  }

  // Fans a message out to everyone in the room, including the sender, so all of
  // them apply the same updates the same way.
  broadcast(msg: ServerMsg): void {
    for (const sub of this.subscribers) sub(msg);
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

export function join(registry: Registry, init: ClientInit): JoinResult {
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

  const id = room.enter();
  if (id === null) return { ok: false, msg: "Room is full!" };
  return { ok: true, room, id };
}

export function tag(id: number, msg: ClientMsg): ServerMsg {
  return msg.type === "Codepoint"
    ? { type: "TaggedCodepoint", client_id: id, codepoint: msg.codepoint }
    : { type: "TaggedClear", client_id: id };
}
