/// <reference no-default-lib="true" />
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference lib="esnext" />

// Draws the boxes the server describes and reports keystrokes. All room
// admission logic lives server-side.

import type {
  ClientInit,
  ClientMsg,
  ServerInit,
  ServerMsg,
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
// The box clips overflow visually; this just caps what it holds in memory.
const MAX_CHARS = 256;

const form = document.getElementById("join") as HTMLFormElement;
const errorEl = document.getElementById("error") as HTMLElement;
const room = document.getElementById("room") as HTMLElement;
const baseTitle = document.title;
const capacityField = form.elements.namedItem("capacity") as HTMLInputElement;
const nameField = form.elements.namedItem("name") as HTMLInputElement;
const modeField = form.elements.namedItem("mode") as RadioNodeList;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  errorEl.textContent = "";
  const name = nameField.value;
  const init: ClientInit = modeField.value === "create"
    ? { type: "CreateRoom", name, capacity: Number(capacityField.value) }
    : { type: "JoinRoom", name };
  connect(init);
});

function readHash(): string {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return "";
  }
}

const deeplinked = readHash();
if (deeplinked) {
  modeField.value = "join";
  nameField.value = deeplinked;
  form.requestSubmit();
}

function connect(init: ClientInit) {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/ws`);
  const send = (msg: ClientInit | ClientMsg) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  };
  let boxes: HTMLElement[] | null = null;

  socket.addEventListener("open", () => send(init));

  socket.addEventListener("message", (event) => {
    const msg: ServerInit | ServerMsg = JSON.parse(event.data);
    if (boxes === null) {
      if (msg.type === "ValidRoom") {
        boxes = enterRoom(msg.capacity, msg.clientId, init.name);
        streamInput(socket, send);
      } else if (msg.type === "InvalidRoom") {
        errorEl.textContent = msg.msg;
        socket.close();
      }
      return;
    }
    if (msg.type === "TaggedCodepoint") {
      const box = boxes[msg.clientId];
      box.textContent = [...(box.textContent + msg.codepoint)]
        .slice(-MAX_CHARS).join("");
    } else if (msg.type === "TaggedClear") {
      boxes[msg.clientId].textContent = "";
    }
  });

  socket.addEventListener("close", showForm);
}

function enterRoom(capacity: number, me: number, name: string): HTMLElement[] {
  document.title = name;
  history.replaceState(null, "", "#" + encodeURIComponent(name));
  form.hidden = true;
  room.hidden = false;
  room.replaceChildren();

  const title = document.createElement("div");
  title.className = "room-name";
  title.textContent = name;
  room.append(title);

  const boxes: HTMLElement[] = [];
  for (let i = 0; i < capacity; i++) {
    const color = `rgb(${PALETTE[i % PALETTE.length]})`;
    const box = document.createElement("div");
    box.className = "box";
    box.style.borderColor = color;
    box.style.color = color;

    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = i === me ? `${i + 1} ← you` : `${i + 1}`;

    const line = document.createElement("div");
    line.className = "line";

    box.append(tag, line);
    room.append(box);
    boxes.push(line);
  }
  const help = document.createElement("div");
  help.className = "help";
  help.textContent = "type to stream  •  esc: clear line";
  room.append(help);
  return boxes;
}

function streamInput(socket: WebSocket, send: (msg: ClientMsg) => void) {
  const onKey = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === "Escape") {
      send({ type: "Clear" });
      event.preventDefault();
    } else if ([...event.key].length === 1) {
      send({ type: "Codepoint", codepoint: event.key });
      event.preventDefault();
    }
  };
  const onPaste = (event: ClipboardEvent) => {
    for (const codepoint of event.clipboardData?.getData("text") ?? "") {
      if (codepoint >= " ") send({ type: "Codepoint", codepoint });
    }
    event.preventDefault();
  };
  addEventListener("keydown", onKey);
  addEventListener("paste", onPaste);
  socket.addEventListener("close", () => {
    removeEventListener("keydown", onKey);
    removeEventListener("paste", onPaste);
  });
}

function showForm() {
  document.title = baseTitle;
  history.replaceState(null, "", location.pathname + location.search);
  room.hidden = true;
  room.replaceChildren();
  form.hidden = false;
}
