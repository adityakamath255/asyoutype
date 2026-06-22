// Wire format shared by server and client. One JSON message per frame.
// A connection handshakes (ClientInit -> ServerInit) then streams ClientMsg in,
// ServerMsg out. ServerMsg is just ClientMsg plus the clientId the server
// stamps on, so each client knows whose box to update.

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
