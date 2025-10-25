import {
  ConnectionState,
  WebRTCRegistryClient,
  type DebugEvent,
} from "./network/webrtc/registry-client";
import type { RoomInfo } from "./network/webrtc/registry-client";

const registryUrlInput = document.getElementById("registry-url") as HTMLInputElement;
const iceServersInput = document.getElementById("ice-servers") as HTMLInputElement;
const roleRadios = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="role"]')
);
const hostInputs = document.querySelector(".host-inputs") as HTMLElement;
const guestInputs = document.querySelector(".guest-inputs") as HTMLElement;
const createRoomButton = document.getElementById("create-room") as HTMLButtonElement;
const joinRoomButton = document.getElementById("join-room") as HTMLButtonElement;
const startConnectionButton = document.getElementById("start-connection") as HTMLButtonElement;
const closeRoomButton = document.getElementById("close-room") as HTMLButtonElement;
const hostUserNameInput = document.getElementById("host-username") as HTMLInputElement;
const roomCodeInput = document.getElementById("room-code") as HTMLInputElement;
const joinCodeInput = document.getElementById("join-code") as HTMLInputElement;
const guestUserNameInput = document.getElementById("guest-username") as HTMLInputElement;
const stateDisplay = document.getElementById("connection-state") as HTMLElement;
const roomCodeDisplay = document.getElementById("display-room-code") as HTMLElement;
const joinCodeDisplay = document.getElementById("display-join-code") as HTMLElement;
const expiresDisplay = document.getElementById("display-expires") as HTMLElement;
const eventLog = document.getElementById("event-log") as HTMLElement;
const chatLog = document.getElementById("chat-log") as HTMLElement;
const chatInput = document.getElementById("chat-message") as HTMLInputElement;
const sendMessageButton = document.getElementById("send-message") as HTMLButtonElement;

let client: WebRTCRegistryClient | null = null;
let lastRoomInfo: RoomInfo | null = null;

roleRadios.forEach((radio) => {
  radio.addEventListener("change", () => {
    updateRoleVisibility(radio.value as "host" | "guest");
  });
});

createRoomButton.addEventListener("click", async () => {
  await handleCreateRoom();
});

joinRoomButton.addEventListener("click", async () => {
  await handleJoinRoom();
});

startConnectionButton.addEventListener("click", async () => {
  startConnectionButton.disabled = true;
  try {
    await getClient().startConnection();
    appendLog("Connection process started");
  } catch (error) {
    appendLog(`Failed to start connection: ${error instanceof Error ? error.message : String(error)}`);
    startConnectionButton.disabled = false;
  }
});

closeRoomButton.addEventListener("click", async () => {
  if (!client) {
    return;
  }
  closeRoomButton.disabled = true;
  try {
    await client.closeRoom();
    appendLog("Room closed");
    resetUiAfterClose();
  } catch (error) {
    appendLog(`Failed to close room: ${error instanceof Error ? error.message : String(error)}`);
  }
});

sendMessageButton.addEventListener("click", () => {
  if (!client) {
    return;
  }
  const message = chatInput.value.trim();
  if (!message) {
    return;
  }
  try {
    client.sendMessage({ text: message, sentAt: Date.now() });
    appendChatEntry("You", message);
    chatInput.value = "";
  } catch (error) {
    appendLog(`Failed to send message: ${error instanceof Error ? error.message : String(error)}`);
  }
});

function getClient(): WebRTCRegistryClient {
  if (!client) {
    client = createClient();
  }
  return client;
}

function createClient(): WebRTCRegistryClient {
  const registryUrl = registryUrlInput.value.trim();
  if (!registryUrl) {
    throw new Error("Registry URL is required");
  }

  const iceUrls = iceServersInput.value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const iceServers = iceUrls.map<RTCIceServer>((url) => ({ urls: url }));

  const newClient = new WebRTCRegistryClient({
    registryApiUrl: registryUrl,
    iceServers,
    pollIntervalMs: 1500,
  });

  newClient.onStateChange((state) => {
    stateDisplay.textContent = state;
    startConnectionButton.disabled =
      state === ConnectionState.CONNECTED ||
      state === ConnectionState.CONNECTING ||
      state === ConnectionState.ERROR ||
      state === ConnectionState.DISCONNECTED;
    closeRoomButton.disabled = state === ConnectionState.IDLE;
    sendMessageButton.disabled = state !== ConnectionState.CONNECTED;
  });

  newClient.onMessage((payload) => {
    const message = typeof payload === "string" ? payload : JSON.stringify(payload);
    appendChatEntry("Peer", message);
  });

  newClient.onError((error) => {
    appendLog(`Error: ${error.message}`);
    startConnectionButton.disabled = false;
  });

  newClient.onDebug((event) => {
    appendDebugLog(event);
  });

  return newClient;
}

async function handleCreateRoom(): Promise<void> {
  try {
    if (client) {
      await client.closeRoom().catch(() => {
        /* ignore */
      });
    }
    client = createClient();
  } catch (error) {
    appendLog(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const hostUserName = hostUserNameInput.value.trim();
  if (!hostUserName) {
    appendLog("Host username is required");
    return;
  }

  try {
    const code = await client.createRoom(hostUserName);
    lastRoomInfo = client.getRoomInfo();
    updateRoomInfoDisplay();
    appendLog(`Room created with code ${code}`);
    startConnectionButton.disabled = false;
    closeRoomButton.disabled = false;
  } catch (error) {
    appendLog(`Failed to create room: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleJoinRoom(): Promise<void> {
  try {
    if (client) {
      await client.closeRoom().catch(() => {
        /* ignore */
      });
    }
    client = createClient();
  } catch (error) {
    appendLog(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const roomCode = roomCodeInput.value.trim();
  const joinCode = joinCodeInput.value.trim();
  const guestUserName = guestUserNameInput.value.trim();

  if (!roomCode || !joinCode || !guestUserName) {
    appendLog("Room code, join code, and guest username are required");
    return;
  }

  try {
    await client.joinRoom(roomCode, joinCode, guestUserName);
    lastRoomInfo = client.getRoomInfo();
    updateRoomInfoDisplay();
    appendLog(`Joined room ${roomCode}`);
    startConnectionButton.disabled = false;
    closeRoomButton.disabled = false;
  } catch (error) {
    appendLog(`Failed to join room: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function updateRoleVisibility(role: "host" | "guest"): void {
  if (role === "host") {
    hostInputs.classList.remove("hidden");
    guestInputs.classList.add("hidden");
    createRoomButton.classList.remove("hidden");
    joinRoomButton.classList.add("hidden");
  } else {
    hostInputs.classList.add("hidden");
    guestInputs.classList.remove("hidden");
    createRoomButton.classList.add("hidden");
    joinRoomButton.classList.remove("hidden");
  }
  resetStatusDisplays();
}

function updateRoomInfoDisplay(): void {
  const info = client?.getRoomInfo() ?? lastRoomInfo;
  roomCodeDisplay.textContent = info?.code ?? "-";
  joinCodeDisplay.textContent = info?.joinCode ?? "-";
  expiresDisplay.textContent = info?.expiresAt
    ? new Date(info.expiresAt).toLocaleString()
    : "-";
}

function appendLog(message: string, details?: unknown): void {
  const timestamp = new Date().toLocaleTimeString();
  const logLines = [`[${timestamp}] ${message}`];
  if (details !== undefined) {
    const formattedDetails =
      typeof details === "string"
        ? details
        : JSON.stringify(details, null, 2);
    if (formattedDetails) {
      logLines.push(formattedDetails);
    }
  }
  eventLog.textContent = `${eventLog.textContent ?? ""}${logLines.join("\n")}\n`;
  eventLog.scrollTop = eventLog.scrollHeight;
}

function appendDebugLog(event: DebugEvent): void {
  const prefix = `[${event.type}] ${event.message}`;
  appendLog(prefix, event.details);
}

function appendChatEntry(sender: string, message: string): void {
  const entry = document.createElement("div");
  entry.classList.add("chat-entry");
  entry.textContent = `${sender}: ${message}`;
  chatLog.appendChild(entry);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function resetStatusDisplays(): void {
  stateDisplay.textContent = ConnectionState.IDLE;
  roomCodeDisplay.textContent = "-";
  joinCodeDisplay.textContent = "-";
  expiresDisplay.textContent = "-";
  startConnectionButton.disabled = true;
  closeRoomButton.disabled = true;
  sendMessageButton.disabled = true;
  chatLog.innerHTML = "";
  eventLog.textContent = "";
}

function resetUiAfterClose(): void {
  lastRoomInfo = null;
  client = null;
  resetStatusDisplays();
}

updateRoleVisibility("host");

