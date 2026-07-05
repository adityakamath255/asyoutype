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

const HELP = matchMedia("(pointer: coarse)").matches
  ? "tap to type"
  : "type to stream";

// virtual keyboards only report backspace by deleting something, so the
// capture input always holds one zero-width char for them to delete.
const SENTINEL = "​";

type Tag = keyof HTMLElementTagNameMap;

type Props<K extends Tag> = Partial<Omit<HTMLElementTagNameMap[K], "style">> & {
  style?: Partial<CSSStyleDeclaration>;
};

function el<K extends Tag>(
  tag: K,
  { style, ...props }: Props<K> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
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

  pop(): void {
    this.codepoints.pop();
    this.render();
  }

  clear(): void {
    this.codepoints.length = 0;
    this.render();
  }
}

const isCodepoint = (s: string): boolean =>
  [...s].length === 1 && s >= " " && s !== SENTINEL;

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

  backspace(): void {
    this.write({ type: "Backspace" });
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
  private input: HTMLInputElement;

  constructor(private session: Session, readonly name: string) {
    this.boxes = Array.from(
      { length: session.capacity },
      (_, i) => new Box(i, i === session.clientId),
    );

    this.input = el("input", {
      className: "capture",
      type: "text",
      value: SENTINEL,
      autocomplete: "off",
      autocapitalize: "off",
      autocorrect: false,
      spellcheck: false,
      ariaLabel: HELP,
    });

    const clearButton = el("button", {
      className: "clear",
      textContent: "clear",
      onclick: () => session.clear(),
    });

    this.el = el(
      "div",
      { className: "room-body" },
      el("div", { className: "room-name", textContent: name }),
      ...this.boxes.map((box) => box.el),
      el("div", { className: "help", textContent: HELP }, clearButton),
      this.input,
    );
    this.el.addEventListener("click", () => this.focus(), {
      signal: session.signal,
    });
    this.wireCapture();
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  apply(msg: ServerMsg): void {
    const box = this.boxes[msg.clientId];
    switch (msg.type) {
      case "TaggedCodepoint":
        box.push(msg.codepoint);
        break;
      case "TaggedBackspace":
        box.pop();
        break;
      case "TaggedClear":
        box.clear();
        break;
    }
  }

  private wireCapture(): void {
    const { input, session } = this;
    const flush = () => {
      const { value } = input;
      if (value.startsWith(SENTINEL)) {
        session.send(value.slice(SENTINEL.length));
      } else {
        session.backspace();
        session.send(value);
      }
      input.value = SENTINEL;
    };
    const signal = session.signal;
    input.addEventListener(
      "input",
      (event) => {
        if (!(event as InputEvent).isComposing) flush();
      },
      { signal },
    );
    input.addEventListener("compositionend", flush, { signal });
    input.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          input.value = SENTINEL;
          session.clear();
        }
      },
      { signal },
    );
  }
}

type Connection =
  | { ok: true; session: Session }
  | { ok: false; error: string };

class App {
  private readonly form = document.getElementById("join") as HTMLFormElement;
  private readonly errorEl = document.getElementById("error") as HTMLElement;
  private readonly room = document.getElementById("room") as HTMLElement;
  private readonly baseTitle = document.title;

  private readonly nameField = this.field("name") as HTMLInputElement;
  private readonly capacityField = this.field("capacity") as HTMLInputElement;
  private readonly modeField = this.field("mode") as RadioNodeList;

  private field(name: string) {
    return this.form.elements.namedItem(name);
  }

  start(): void {
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.errorEl.textContent = "";
      this.enter(this.readForm());
    });

    const deeplinked = readHash();
    if (deeplinked) {
      this.modeField.value = "join";
      this.nameField.value = deeplinked;
      this.form.requestSubmit();
    }
  }

  private readForm(): ClientInit {
    const name = this.nameField.value;
    return this.modeField.value === "create"
      ? { type: "CreateRoom", name, capacity: Number(this.capacityField.value) }
      : { type: "JoinRoom", name };
  }

  private async enter(init: ClientInit): Promise<void> {
    const result = await connect(init);
    if (!result.ok) {
      this.errorEl.textContent = result.error;
      return;
    }
    const { session } = result;
    const view = new RoomView(session, init.name);
    this.show(view);
    session.onMessage((msg) => view.apply(msg));
    session.onClose(() => this.show(null));
    view.focus();
  }

  private show(view: RoomView | null): void {
    const hash = view ? "#" + encodeURIComponent(view.name) : "";
    document.title = view ? view.name : this.baseTitle;
    history.replaceState(null, "", location.pathname + location.search + hash);
    this.room.replaceChildren(...(view ? [view.el] : []));
    this.form.hidden = view !== null;
    this.room.hidden = view === null;
  }
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

function readHash(): string {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return "";
  }
}

new App().start();
