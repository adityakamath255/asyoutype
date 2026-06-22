// The wire format shared by the server and the in-browser client.
//
// Messages are JSON, one per WebSocket text frame. A connection has two phases:
// a one-shot handshake (`ClientInit` -> `ServerInit`), then a stream of
// `ClientMsg` in and `ServerMsg` out. The only structural difference between the
// two streaming unions is the `client_id` the server stamps onto every message,
// so each client knows whose box to update.

export type ClientInit =
  | { type: "CreateRoom"; name: string; capacity: number }
  | { type: "JoinRoom"; name: string };

export type ServerInit =
  | { type: "ValidRoom"; client_id: number; capacity: number }
  | { type: "InvalidRoom"; msg: string };

export type ClientMsg =
  | { type: "Codepoint"; codepoint: string }
  | { type: "Clear" };

export type ServerMsg =
  | { type: "TaggedCodepoint"; client_id: number; codepoint: string }
  | { type: "TaggedClear"; client_id: number };
