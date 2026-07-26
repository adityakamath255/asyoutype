/// <reference no-default-lib="true" />
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference lib="esnext" />

import {
  type ClientInit,
  type ClientMsg,
  decodeServerInit,
  decodeServerMsg,
  isCodepoint,
  type ServerInit,
  type ServerMsg,
  type SlotInfo,
} from "../protocol.ts";
import { isPaletteIndex, PALETTE } from "../palette.ts";

const MAX_BUFFERED_CODEPOINTS = 256;
const HELP = matchMedia("(pointer: coarse)").matches
  ? "tap to type"
  : "type to stream";

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

function query<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
}

class Box {
  readonly el: HTMLElement;
  private line: HTMLElement;
  private tag: HTMLElement;
  private codepoints: string[] = [];

  constructor() {
    this.line = el("div", { className: "line" });
    this.tag = el("span", { className: "tag" });
    this.el = el("div", { className: "box" }, this.tag, this.line);
  }

  private render(): void {
    this.line.textContent = this.codepoints.join("");
  }

  push(codepoint: string): void {
    this.codepoints.push(codepoint);
    if (this.codepoints.length > MAX_BUFFERED_CODEPOINTS) {
      this.codepoints.shift();
    }
    this.render();
  }

  pop(): void {
    this.codepoints.pop();
    this.render();
  }

  clear(): void {
    this.codepoints = [];
    this.render();
  }

  setSlot(info: SlotInfo | null, isMe: boolean): void {
    this.el.classList.toggle("occupied", info !== null);
    if (info) {
      this.tag.textContent = isMe ? `${info.nick} [you]` : info.nick;
      this.el.style.setProperty("--slot", PALETTE[info.color]);
    } else {
      this.clear();
    }
  }
}

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
      autocomplete: "off",
      autocapitalize: "off",
      autocorrect: false,
      spellcheck: false,
      ariaLabel: "text stream input",
    });

    const sentinel = "\u200b";
    const reset = () => {
      this.el.value = sentinel;
    };
    const type = (text: string) => {
      for (const codepoint of text) {
        if (isCodepoint(codepoint)) sink({ type: "Codepoint", codepoint });
      }
    };
    const flush = () => {
      const { value } = this.el;
      if (value.startsWith(sentinel)) {
        type(value.slice(sentinel.length));
      } else {
        sink({ type: "Backspace" });
        type(value);
      }
      reset();
    };

    reset();

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

function applyEdit(box: Box, msg: ClientMsg): void {
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

  constructor(private readonly session: Session, readonly name: string) {
    this.boxes = Array.from(
      { length: session.capacity },
      () => new Box(),
    );
    const ownBox = this.boxes[session.clientId];
    const sink = (msg: ClientMsg) => {
      session.send(msg);
      applyEdit(ownBox, msg);
    };
    const { signal } = session;
    this.capture = new Capture(sink, signal);
    const clear = el("button", {
      className: "clear",
      type: "button",
      textContent: "clear",
    });
    clear.addEventListener(
      "click",
      () => sink({ type: "Clear" }),
      { signal },
    );
    this.el = el(
      "div",
      { className: "room-body" },
      el("div", { className: "room-name", textContent: name }),
      ...this.boxes.map((box) => box.el),
      el("div", { className: "help" }, HELP, clear),
      this.capture.el,
    );
    globalThis.addEventListener("click", () => this.focus(), { signal });
    globalThis.addEventListener("focus", () => this.focus(), { signal });
  }

  focus(): void {
    this.capture.focus();
  }

  apply(msg: ServerMsg): void {
    if (msg.type !== "Occupancy") {
      applyEdit(this.boxes[msg.clientId], msg);
      return;
    }

    const { slots } = msg;
    this.boxes.forEach(
      (box, i) => box.setSlot(slots[i], i === this.session.clientId),
    );
    const n = slots.filter(Boolean).length;
    document.title = `${this.name} [${n}/${this.session.capacity}]`;
  }
}

type Connection =
  | { ok: true; session: Session }
  | { ok: false; error: string };

class App {
  private readonly form = query<HTMLFormElement>("#join");
  private readonly errorEl = query<HTMLElement>("#error");
  private readonly colors = query<HTMLElement>("#colors");
  private readonly room = query<HTMLElement>("#room");
  private readonly baseTitle = document.title;

  private readonly nameField = this.field("name") as HTMLInputElement;
  private readonly nickField = this.field("nick") as HTMLInputElement;
  private readonly capacityField = this.field("capacity") as HTMLInputElement;
  private readonly modeField = this.field("mode") as RadioNodeList;

  private field(name: string) {
    const field = this.form.elements.namedItem(name);
    if (!field) throw new Error(`Missing form field ${name}`);
    return field;
  }

  start(): void {
    const identity = loadIdentity();
    this.buildColors(identity?.color ?? 0);
    if (identity) this.nickField.value = identity.nick;
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

  private buildColors(selected: number): void {
    this.colors.replaceChildren(...PALETTE.map((color, i) => {
      const input = el("input", {
        type: "radio",
        name: "color",
        value: String(i),
        checked: i === selected,
      });
      const dot = el("span", { className: "dot" });
      dot.style.background = color;
      return el(
        "label",
        { className: "swatch" },
        input,
        dot,
      );
    }));
  }

  private readForm(): ClientInit {
    const color = Number(
      (this.field("color") as RadioNodeList).value,
    );
    if (!isPaletteIndex(color)) throw new Error("Invalid colour selection");
    const info: SlotInfo = {
      nick: this.nickField.value.trim(),
      color,
    };
    const name = this.nameField.value.trim();
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
    saveIdentity({ nick: init.nick, color: init.color });
    const { session } = result;
    const view = new RoomView(session, init.name);
    this.show(view);
    session.onMessage((msg) => view.apply(msg));
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
  if (reply === null) {
    return { ok: false, error: "connection closed" };
  }
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

const IDENTITY_KEY = "asyoutype:identity";

function loadIdentity(): SlotInfo | null {
  try {
    const v = JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? "null");
    if (
      typeof v?.nick === "string" &&
      isPaletteIndex(v?.color)
    ) {
      return { nick: v.nick, color: v.color };
    }
  } catch { /* absent, malformed, or storage unavailable */ }
  return null;
}

function saveIdentity(info: SlotInfo): void {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(info));
  } catch { /* storage unavailable */ }
}

new App().start();
