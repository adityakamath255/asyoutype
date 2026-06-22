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
const capacityField = form.elements.namedItem("capacity") as HTMLInputElement;
const mode = () => (form.elements.namedItem("mode") as RadioNodeList).value;

const updateMode = () => {
  capacityField.hidden = mode() !== "create";
};
form.addEventListener("change", updateMode);
updateMode();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  errorEl.textContent = "";
  const name = (form.elements.namedItem("name") as HTMLInputElement).value;
  const init: ClientInit = mode() === "create"
    ? { type: "CreateRoom", name, capacity: Number(capacityField.value) }
    : { type: "JoinRoom", name };
  connect(init);
});

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
        boxes = enterRoom(msg.capacity, msg.clientId);
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

function enterRoom(capacity: number, me: number): HTMLElement[] {
  form.hidden = true;
  room.hidden = false;
  room.replaceChildren();
  const boxes: HTMLElement[] = [];
  for (let i = 0; i < capacity; i++) {
    const color = `rgb(${PALETTE[i % PALETTE.length]})`;
    const slot = document.createElement("div");
    slot.className = "slot";

    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = i === me ? `${i + 1} ← you` : `${i + 1}`;
    tag.style.color = color;

    const box = document.createElement("div");
    box.className = "box";
    box.style.borderColor = color;
    box.style.color = color;

    slot.append(tag, box);
    room.append(slot);
    boxes.push(box);
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
  room.hidden = true;
  room.replaceChildren();
  form.hidden = false;
}
