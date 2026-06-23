export type ClientInit =
  | { type: "CreateRoom"; name: string; capacity: number }
  | { type: "JoinRoom"; name: string };

export type ServerInit =
  | { type: "ValidRoom"; clientId: number; capacity: number }
  | { type: "InvalidRoom"; msg: string };

export type ClientMsg =
  | { type: "Codepoint"; codepoint: string }
  | { type: "Clear" };

export type ServerMsg =
  | { type: "TaggedCodepoint"; clientId: number; codepoint: string }
  | { type: "TaggedClear"; clientId: number };

const isStr = (x: unknown): x is string => typeof x === "string";
const isInt = (x: unknown): x is number => Number.isInteger(x);

// a single codepoint may span two UTF-16 units, so count by codepoint.
const isChar = (x: unknown): x is string => isStr(x) && [...x].length === 1;

function parseObject(data: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(data);
    return typeof v === "object" && v !== null ? v : null;
  } catch {
    return null;
  }
}

export function decodeClientInit(data: string): ClientInit | null {
  const v = parseObject(data);
  if (!v) return null;
  switch (v.type) {
    case "CreateRoom":
      return isStr(v.name) && isInt(v.capacity)
        ? { type: "CreateRoom", name: v.name, capacity: v.capacity }
        : null;
    case "JoinRoom":
      return isStr(v.name) ? { type: "JoinRoom", name: v.name } : null;
    default:
      return null;
  }
}

export function decodeClientMsg(data: string): ClientMsg | null {
  const v = parseObject(data);
  if (!v) return null;
  switch (v.type) {
    case "Codepoint":
      return isChar(v.codepoint)
        ? { type: "Codepoint", codepoint: v.codepoint }
        : null;
    case "Clear":
      return { type: "Clear" };
    default:
      return null;
  }
}

export function decodeServerInit(data: string): ServerInit | null {
  const v = parseObject(data);
  if (!v) return null;
  switch (v.type) {
    case "ValidRoom":
      return isInt(v.clientId) && isInt(v.capacity)
        ? { type: "ValidRoom", clientId: v.clientId, capacity: v.capacity }
        : null;
    case "InvalidRoom":
      return isStr(v.msg) ? { type: "InvalidRoom", msg: v.msg } : null;
    default:
      return null;
  }
}

export function decodeServerMsg(data: string): ServerMsg | null {
  const v = parseObject(data);
  if (!v) return null;
  switch (v.type) {
    case "TaggedCodepoint":
      return isInt(v.clientId) && isChar(v.codepoint)
        ? { type: "TaggedCodepoint", clientId: v.clientId, codepoint: v.codepoint }
        : null;
    case "TaggedClear":
      return isInt(v.clientId)
        ? { type: "TaggedClear", clientId: v.clientId }
        : null;
    default:
      return null;
  }
}
