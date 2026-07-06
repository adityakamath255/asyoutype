/// <reference no-default-lib="true" />
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference lib="esnext" />

import {
  type ClientInit,
  type ClientMsg,
  decodeServerInit,
  decodeServerMsg,
  PALETTE_SIZE,
  type ServerInit,
  type ServerMsg,
  type SlotInfo,
} from "../protocol.ts";

const PALETTE = [
  "245,224,220",
  "242,205,205",
  "245,194,231",
  "203,166,247",
  "243,139,168",
  "235,160,172",
  "250,179,135",
  "249,226,175",
  "166,227,161",
  "148,226,213",
  "137,220,235",
  "116,199,236",
  "137,180,250",
  "180,190,254",
];
if (PALETTE.length !== PALETTE_SIZE) throw new Error("palette size mismatch");

// the box clips overflow visually; this just caps what it holds in memory
const MAX_CHARS = 256;

const HELP = matchMedia("(pointer: coarse)").matches
  ? "tap to type"
  : "type to stream";

// virtual keyboards only report backspace by deleting something, so the
// capture input always holds one zero-width char for them to delete.
const SENTINEL = "​";

type Tag = keyof HTMLElementTagNameMap;

type Props<K extends Tag> = Partial<Omit<HTMLElementTagNameMap[K], "style">>;

function el<K extends Tag>(
  tag: K,
  props: Props<K> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

class Box {
  readonly el: HTMLElement;
  private line: HTMLElement;
  private tag: HTMLElement;
  private codepoints: string[] = [];

  constructor(private index: number, private isMe: boolean) {
    this.line = el("div", { className: "line" });
    this.tag = el("span", { className: "tag", textContent: `${index + 1}` });
    this.el = el("div", { className: "box" }, this.tag, this.line);
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

  setSlot(info: SlotInfo | null): void {
    if (!info) this.clear();
    this.el.classList.toggle("occupied", info !== null);
    this.tag.hidden = info === null;
    if (info) {
      this.tag.textContent = this.isMe ? `${info.nick} [you]` : info.nick;
      this.el.style.setProperty("--slot", `rgb(${PALETTE[info.color]})`);
    }
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

  send(msg: ClientMsg): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
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
}

class Capture {
  readonly el: HTMLInputElement;

  constructor(sink: (msg: ClientMsg) => void, signal: AbortSignal) {
    this.el = el("input", {
      className: "capture",
      type: "text",
      value: SENTINEL,
      autocomplete: "off",
      autocapitalize: "off",
      autocorrect: false,
      spellcheck: false,
      ariaLabel: HELP,
    });

    const reset = () => {
      this.el.value = SENTINEL;
    };
    const type = (text: string) => {
      for (const codepoint of text) {
        if (isCodepoint(codepoint)) sink({ type: "Codepoint", codepoint });
      }
    };
    const flush = () => {
      const { value } = this.el;
      if (value.startsWith(SENTINEL)) {
        type(value.slice(SENTINEL.length));
      } else {
        sink({ type: "Backspace" });
        type(value);
      }
      reset();
    };

    this.el.addEventListener(
      "input",
      (event) => {
        if (!(event as InputEvent).isComposing) flush();
      },
      { signal },
    );
    this.el.addEventListener("compositionend", flush, { signal });
    this.el.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          reset();
          sink({ type: "Clear" });
        }
      },
      { signal },
    );
  }

  focus(): void {
    this.el.focus({ preventScroll: true });
  }
}

function applyClient(box: Box, msg: ClientMsg): void {
  switch (msg.type) {
    case "Codepoint":
      box.push(msg.codepoint);
      break;
    case "Backspace":
      box.pop();
      break;
    case "Clear":
      box.clear();
      break;
  }
}

class RoomView {
  readonly el: HTMLElement;
  private boxes: Box[];
  private capture: Capture;

  constructor(session: Session, readonly name: string) {
    this.boxes = Array.from(
      { length: session.capacity },
      (_, i) => new Box(i, i === session.clientId),
    );
    const ownBox = this.boxes[session.clientId];
    const sink = (msg: ClientMsg) => {
      session.send(msg);
      applyClient(ownBox, msg);
    };
    this.capture = new Capture(sink, session.signal);

    const clearButton = el("button", {
      className: "clear",
      textContent: "clear",
      onclick: () => sink({ type: "Clear" }),
    });

    this.el = el(
      "div",
      { className: "room-body" },
      el("div", { className: "room-name", textContent: name }),
      ...this.boxes.map((box) => box.el),
      el("div", { className: "help", textContent: HELP }, clearButton),
      this.capture.el,
    );
    const { signal } = session;
    globalThis.addEventListener("click", () => this.focus(), { signal });
    globalThis.addEventListener("focus", () => this.focus(), { signal });
  }

  focus(): void {
    this.capture.focus();
  }

  apply(msg: ServerMsg): void {
    switch (msg.type) {
      case "TaggedCodepoint":
        this.boxes[msg.clientId].push(msg.codepoint);
        break;
      case "TaggedBackspace":
        this.boxes[msg.clientId].pop();
        break;
      case "TaggedClear":
        this.boxes[msg.clientId].clear();
        break;
      case "Occupancy":
        this.boxes.forEach((box, i) => box.setSlot(msg.slots[i]));
        break;
    }
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
  private readonly nickField = this.field("nick") as HTMLInputElement;
  private readonly capacityField = this.field("capacity") as HTMLInputElement;
  private readonly modeField = this.field("mode") as RadioNodeList;

  private field(name: string) {
    return this.form.elements.namedItem(name);
  }

  start(): void {
    this.buildColors();
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.errorEl.textContent = "";
      this.enter(this.readForm());
    });

    const deeplinked = readHash();
    if (deeplinked) {
      this.modeField.value = "join";
      this.nameField.value = deeplinked;
      this.nickField.focus();
    }
  }

  private buildColors(): void {
    const container = document.getElementById("colors") as HTMLElement;
    container.append(...PALETTE.map((rgb, i) => {
      const dot = el("span", { className: "dot" });
      dot.style.background = `rgb(${rgb})`;
      return el(
        "label",
        { className: "swatch" },
        el("input", {
          type: "radio",
          name: "color",
          value: String(i),
          checked: i === 0,
        }),
        dot,
      );
    }));
  }

  private readForm(): ClientInit {
    const name = this.nameField.value;
    const info: SlotInfo = {
      nick: this.nickField.value,
      color: Number((this.field("color") as RadioNodeList).value),
    };
    return this.modeField.value === "create"
      ? {
        type: "CreateRoom",
        name,
        capacity: Number(this.capacityField.value),
        ...info,
      }
      : { type: "JoinRoom", name, ...info };
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
    session.onMessage((msg) => {
      view.apply(msg);
      if (msg.type === "Occupancy") {
        const n = msg.slots.filter(Boolean).length;
        document.title = `${view.name} [${n}/${session.capacity}]`;
      }
    });
    session.signal.addEventListener("abort", () => this.show(null), {
      once: true,
    });
    view.focus();
  }

  private show(view: RoomView | null): void {
    const hash = view ? "#" + encodeURIComponent(view.name) : "";
    if (!view) document.title = this.baseTitle;
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
