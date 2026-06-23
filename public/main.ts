/// <reference no-default-lib="true" />
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference lib="esnext" />

import {
  type ClientInit,
  type ClientMsg,
  decodeServerInit,
  decodeServerMsg,
  type ServerInit,
  type ServerMsg,
} from "../protocol.ts";

const PALETTE = [
  "243,139,168",
  "203,166,247",
  "250,179,135",
  "137,180,250",
  "249,226,175",
  "148,226,213",
  "166,227,161",
  "245,194,231",
];

// the box clips overflow visually; this just caps what it holds in memory
const MAX_CHARS = 256;

const HELP = "type to stream  •  esc: clear line";

type Props = Partial<Omit<HTMLElement, "style">> & {
  style?: Partial<CSSStyleDeclaration>;
};

function el(
  tag: string,
  { style, ...props }: Props = {},
  ...children: (Node | string)[]
): HTMLElement {
  const node = Object.assign(document.createElement(tag), props);
  if (style) Object.assign(node.style, style);
  node.append(...children);
  return node;
}

class Box {
  readonly el: HTMLElement;
  private line: HTMLElement;
  private codepoints: string[] = [];

  constructor(index: number, isMe: boolean) {
    const color = `rgb(${PALETTE[index % PALETTE.length]})`;
    this.line = el("div", { className: "line" });
    this.el = el(
      "div",
      { className: "box", style: { borderColor: color, color } },
      el("span", {
        className: "tag",
        textContent: isMe ? `${index + 1} [you]` : `${index + 1}`,
      }),
      this.line,
    );
  }

  private render(): void {
    this.line.textContent = this.codepoints.join("");
  }

  push(codepoint: string): void {
    this.codepoints.push(codepoint);
    if (this.codepoints.length > MAX_CHARS) this.codepoints.shift();
    this.render();
  }

  clear(): void {
    this.codepoints.length = 0;
    this.render();
  }
}

const isCodepoint = (s: string): boolean => [...s].length === 1 && s >= " ";

class Session {
  private ended = new AbortController();

  constructor(
    private socket: WebSocket,
    readonly clientId: number,
    readonly capacity: number,
  ) {
    socket.addEventListener("close", () => this.ended.abort(), { once: true });
  }

  get signal(): AbortSignal {
    return this.ended.signal;
  }

  private write(msg: ClientMsg): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  send(text: string): void {
    for (const codepoint of text) {
      if (isCodepoint(codepoint)) this.write({ type: "Codepoint", codepoint });
    }
  }

  clear(): void {
    this.write({ type: "Clear" });
  }

  onMessage(handler: (msg: ServerMsg) => void): void {
    this.socket.addEventListener(
      "message",
      (event) => {
        const msg = decodeServerMsg(event.data);
        if (msg) handler(msg);
      },
      { signal: this.signal },
    );
  }

  onClose(handler: () => void): void {
    this.signal.addEventListener("abort", handler, { once: true });
  }
}

class RoomView {
  readonly el: HTMLElement;
  private boxes: Box[];

  constructor(session: Session, readonly name: string) {
    this.boxes = Array.from(
      { length: session.capacity },
      (_, i) => new Box(i, i === session.clientId),
    );
    this.el = el(
      "div",
      { className: "room-body" },
      el("div", { className: "room-name", textContent: name }),
      ...this.boxes.map((box) => box.el),
      el("div", { className: "help", textContent: HELP }),
    );
  }

  apply(msg: ServerMsg): void {
    const box = this.boxes[msg.clientId];
    if (msg.type === "TaggedCodepoint") box.push(msg.codepoint);
    else box.clear();
  }
}

const form = document.getElementById("join") as HTMLFormElement;
const errorEl = document.getElementById("error") as HTMLElement;
const room = document.getElementById("room") as HTMLElement;
const baseTitle = document.title;

const nameField = form.elements.namedItem("name") as HTMLInputElement;
const capacityField = form.elements.namedItem("capacity") as HTMLInputElement;
const modeField = form.elements.namedItem("mode") as RadioNodeList;

type Connection =
  | { ok: true; session: Session }
  | { ok: false; error: string };

async function enter(init: ClientInit) {
  const result = await connect(init);
  if (!result.ok) {
    errorEl.textContent = result.error;
    return;
  }
  const { session } = result;
  const view = new RoomView(session, init.name);
  showRoom(view);
  session.onMessage((msg) => view.apply(msg));
  session.onClose(() => showRoom(null));
  streamInput(session);
}

async function connect(init: ClientInit): Promise<Connection> {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/ws`);
  socket.addEventListener(
    "open",
    () => socket.send(JSON.stringify(init)),
    { once: true },
  );

  const reply = await handshake(socket);
  if (reply === null) return { ok: false, error: "connection closed" };
  if (reply.type === "InvalidRoom") {
    socket.close();
    return { ok: false, error: reply.msg };
  }
  return {
    ok: true,
    session: new Session(socket, reply.clientId, reply.capacity),
  };
}

function handshake(socket: WebSocket): Promise<ServerInit | null> {
  return new Promise((resolve) => {
    socket.addEventListener(
      "message",
      (event) => resolve(decodeServerInit(event.data)),
      { once: true },
    );
    socket.addEventListener("close", () => resolve(null), { once: true });
  });
}

function showRoom(view: RoomView | null) {
  const hash = view ? "#" + encodeURIComponent(view.name) : "";
  document.title = view ? view.name : baseTitle;
  history.replaceState(null, "", location.pathname + location.search + hash);
  room.replaceChildren(...(view ? [view.el] : []));
  form.hidden = view !== null;
  room.hidden = view === null;
}

function streamInput(session: Session) {
  const onKey = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === "Escape") session.clear();
    else if (isCodepoint(event.key)) session.send(event.key);
    else return;
    event.preventDefault();
  };
  const onPaste = (event: ClipboardEvent) => {
    session.send(event.clipboardData?.getData("text") ?? "");
    event.preventDefault();
  };
  addEventListener("keydown", onKey, { signal: session.signal });
  addEventListener("paste", onPaste, { signal: session.signal });
}

function readHash(): string {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return "";
  }
}

function readForm(): ClientInit {
  const name = nameField.value;
  return modeField.value === "create"
    ? { type: "CreateRoom", name, capacity: Number(capacityField.value) }
    : { type: "JoinRoom", name };
}

function main() {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    errorEl.textContent = "";
    enter(readForm());
  });

  const deeplinked = readHash();
  if (deeplinked) {
    modeField.value = "join";
    nameField.value = deeplinked;
    form.requestSubmit();
  }
}

main();
