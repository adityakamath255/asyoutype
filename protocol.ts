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

type Field = (x: unknown) => boolean;

const str: Field = (x) => typeof x === "string";
const int: Field = (x) => Number.isInteger(x);
// a single codepoint may span two UTF-16 units, so count by codepoint.
const char: Field = (x) => str(x) && [...x as string].length === 1;

// each variant of a union is a `type` tag mapped to the checks its fields must
// pass. a decoder validates the tag, then every field, and copies the verified
// shape through; anything off-schema becomes null.
type Schema = Record<string, Record<string, Field>>;

function decoder<T>(schema: Schema): (data: string) => T | null {
  return (data) => {
    let v: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data);
      if (typeof parsed !== "object" || parsed === null) return null;
      v = parsed;
    } catch {
      return null;
    }
    const fields = typeof v.type === "string" ? schema[v.type] : undefined;
    if (!fields) return null;
    const out: Record<string, unknown> = { type: v.type };
    for (const [key, check] of Object.entries(fields)) {
      if (!check(v[key])) return null;
      out[key] = v[key];
    }
    return out as T;
  };
}

export const decodeClientInit = decoder<ClientInit>({
  CreateRoom: { name: str, capacity: int },
  JoinRoom: { name: str },
});

export const decodeClientMsg = decoder<ClientMsg>({
  Codepoint: { codepoint: char },
  Clear: {},
});

export const decodeServerInit = decoder<ServerInit>({
  ValidRoom: { clientId: int, capacity: int },
  InvalidRoom: { msg: str },
});

export const decodeServerMsg = decoder<ServerMsg>({
  TaggedCodepoint: { clientId: int, codepoint: char },
  TaggedClear: { clientId: int },
});
