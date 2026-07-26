import { isPaletteIndex } from "./palette.ts";

type Field<T = unknown> = (x: unknown) => x is T;
type Fields = Record<string, Field>;
type Schema = Record<string, Fields>;

type InferFields<F extends Fields> = {
  [K in keyof F]: F[K] extends Field<infer T> ? T : never;
};

type InferSchema<S extends Schema> = {
  [T in keyof S]: { type: T } & InferFields<S[T]>;
}[keyof S];

const str = (x: unknown): x is string => typeof x === "string";
const int = (x: unknown): x is number => Number.isInteger(x);
export const isCodepoint = (x: unknown): x is string =>
  str(x) && [...x].length === 1 && x >= " ";
const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

function record<F extends Fields>(fields: F) {
  return (x: unknown): x is InferFields<F> =>
    isRecord(x) &&
    Object.entries(fields).every(([key, check]) => check(x[key]));
}

const slotFields = { nick: str, color: isPaletteIndex };
export type SlotInfo = InferFields<typeof slotFields>;
const slot = record(slotFields);

const slots = (x: unknown): x is (SlotInfo | null)[] =>
  Array.isArray(x) && x.every((value) => value === null || slot(value));

function withClientId<S extends Schema>(schema: S) {
  return Object.fromEntries(
    Object.entries(schema).map(([type, fields]) => [
      type,
      { ...fields, clientId: int },
    ]),
  ) as { [T in keyof S]: S[T] & { clientId: typeof int } };
}

function decoder<S extends Schema>(
  schema: S,
): (data: string) => InferSchema<S> | null {
  return (data) => {
    let value: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data);
      if (!isRecord(parsed)) return null;
      value = parsed;
    } catch {
      return null;
    }
    const fields = typeof value.type === "string"
      ? schema[value.type]
      : undefined;
    if (!fields) return null;
    const out: Record<string, unknown> = { type: value.type };
    for (const [key, check] of Object.entries(fields)) {
      if (!check(value[key])) return null;
      out[key] = value[key];
    }
    return out as InferSchema<S>;
  };
}

const clientInitSchema = {
  CreateRoom: { name: str, capacity: int, ...slotFields },
  JoinRoom: { name: str, ...slotFields },
};
export type ClientInit = InferSchema<typeof clientInitSchema>;
export const decodeClientInit = decoder(clientInitSchema);

const clientMsgSchema = {
  Codepoint: { codepoint: isCodepoint },
  Backspace: {},
  Clear: {},
};
export type ClientMsg = InferSchema<typeof clientMsgSchema>;
export const decodeClientMsg = decoder(clientMsgSchema);

const serverInitSchema = {
  ValidRoom: { clientId: int, capacity: int },
  InvalidRoom: { msg: str },
};
export type ServerInit = InferSchema<typeof serverInitSchema>;
export const decodeServerInit = decoder(serverInitSchema);

const serverMsgSchema = {
  ...withClientId(clientMsgSchema),
  Occupancy: { slots },
};
export type ServerMsg = InferSchema<typeof serverMsgSchema>;
export const decodeServerMsg = decoder(serverMsgSchema);
