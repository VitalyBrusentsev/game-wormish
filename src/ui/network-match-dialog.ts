import { CommandDialog, type CloseReason } from "./dialog";
import type { NetworkSessionState, NetworkSessionStateSnapshot } from "../network/session-state";
import { ConnectionState } from "../webrtc/types";

export type NetworkRole = "host" | "guest";

export interface NetworkMatchCallbacks {
  onCreateRoom: (playerName: string) => Promise<void>;
  onJoinRoom: (roomCode: string, joinCode: string, playerName: string) => Promise<void>;
  onLookupRoom: (roomCode: string) => Promise<void>;
  onCancel: () => void;
  onClose: (reason: CloseReason) => void;
}

export type HostPhase = "creating" | "room-ready" | "connecting" | "connected";
export type GuestPhase =
  | "enter-room"
  | "found-room"
  | "joining-room"
  | "connecting"
  | "connected";

export type DialogState =
  | { kind: "landing"; roomCode: string; joinCode: string; hostName: string }
  | { kind: "hosting"; phase: HostPhase; roomCode: string; joinCode: string | null; hostName: string; expiresAt: number | null }
  | {
      kind: "joining";
      phase: GuestPhase;
      roomCode: string;
      joinCode: string;
      hostName: string;
      expiresAt: number | null;
    };

const createLandingState = (): DialogState => ({
  kind: "landing",
  roomCode: "",
  joinCode: "",
  hostName: "",
});

export const deriveDialogStateFromSnapshot = (
  current: DialogState,
  snapshot: NetworkSessionStateSnapshot
): DialogState => {
  if (snapshot.mode === "local") {
    return createLandingState();
  }

  const roomCode = snapshot.registry.code || current.roomCode || "";
  const joinCode = snapshot.registry.joinCode ?? current.joinCode ?? "";
  const hostName = snapshot.registry.hostUserName || current.hostName || "";
  const expiresAt = snapshot.registry.expiresAt || null;

  if (snapshot.mode === "network-host") {
    let phase: HostPhase = "room-ready";
    const lifecycle = snapshot.connection.lifecycle;
    if (lifecycle === ConnectionState.CREATING || !roomCode) {
      phase = "creating";
    } else if (lifecycle === ConnectionState.CONNECTING) {
      phase = "connecting";
    } else if (lifecycle === ConnectionState.CONNECTED) {
      phase = "connected";
    }

    return {
      kind: "hosting",
      phase,
      roomCode,
      joinCode: joinCode || null,
      hostName,
      expiresAt,
    };
  }

  let guestPhase: GuestPhase = hostName ? "found-room" : "enter-room";
  const lifecycle = snapshot.connection.lifecycle;
  if (lifecycle === ConnectionState.JOINING) {
    guestPhase = "joining-room";
  } else if (lifecycle === ConnectionState.JOINED || lifecycle === ConnectionState.CONNECTING) {
    guestPhase = "connecting";
  } else if (lifecycle === ConnectionState.CONNECTED) {
    guestPhase = "connected";
  }

  return {
    kind: "joining",
    phase: guestPhase,
    roomCode,
    joinCode,
    hostName,
    expiresAt,
  };
};

const PLAYER_NAME_STORAGE_KEY = "wormish.network.playerName";

export class NetworkMatchDialog {
  private readonly dialog: CommandDialog;
  private readonly callbacks: NetworkMatchCallbacks;
  private playerName = "";
  private state: DialogState = createLandingState();
  private validationMessages: string[] = [];
  private isProcessing = false;
  private contentContainer: HTMLElement | null = null;

  constructor(callbacks: NetworkMatchCallbacks) {
    this.callbacks = callbacks;
    this.dialog = new CommandDialog();
    this.playerName = this.readStoredPlayerName();
  }

  show(initialRole: NetworkRole = "host") {
    this.validationMessages = [];
    this.isProcessing = false;
    if (!this.playerName) {
      this.playerName = this.readStoredPlayerName();
    }
    this.state = initialRole === "guest" ? { kind: "joining", phase: "enter-room", roomCode: "", joinCode: "", hostName: "", expiresAt: null } : createLandingState();

    this.dialog.show({
      title: "Network Match Setup",
      subtitle: "Connect with a friend for multiplayer action",
      closeable: true,
      zIndex: 25,
      onClose: (reason) => {
        this.callbacks.onClose(reason);
        this.callbacks.onCancel();
        this.resetState();
      },
      content: this.buildContent(),
    });
  }

  hide() {
    this.dialog.hide();
  }

  dispose() {
    this.dialog.destroy();
  }

  isVisible() {
    return this.dialog.isVisible();
  }

  updateFromNetworkState(networkState: NetworkSessionState) {
    const snapshot = networkState.getSnapshot();

    this.state = deriveDialogStateFromSnapshot(this.state, snapshot);
    this.validationMessages = this.collectValidationMessages(snapshot);

    this.refreshContent();
  }

  private buildContent(): HTMLElement {
    const container = document.createElement("div");
    container.className = "network-dialog";
    this.contentContainer = container;

    container.appendChild(this.buildNameField());
    container.appendChild(this.buildBody());

    const validationPanel = document.createElement("div");
    validationPanel.className = "network-validation";
    validationPanel.id = "network-validation-panel";
    this.renderValidationPanel(validationPanel);
    container.appendChild(validationPanel);

    if (this.state.kind !== "landing") {
      const infoPanel = document.createElement("div");
      infoPanel.className = "network-info";
      infoPanel.id = "network-info-panel";
      this.renderInfoPanel(infoPanel);
      container.appendChild(infoPanel);
    }

    return container;
  }

  private buildBody(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "network-content";

    if (this.state.kind === "landing") {
      wrapper.appendChild(this.buildLandingContent());
    } else if (this.state.kind === "hosting") {
      wrapper.appendChild(this.buildHostContent());
    } else {
      wrapper.appendChild(this.buildGuestContent());
    }

    return wrapper;
  }

  private buildNameField(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "network-section";

    const label = document.createElement("label");
    label.className = "network-label";
    label.textContent = "Your Name";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "network-input";
    input.placeholder = "Enter your display name";
    input.value = this.playerName;
    input.maxLength = 32;
    input.addEventListener("input", (e) => {
      this.playerName = (e.target as HTMLInputElement).value;
      this.persistPlayerName();
    });

    wrapper.appendChild(label);
    wrapper.appendChild(input);

    return wrapper;
  }

  private buildLandingContent(): HTMLElement {
    const section = document.createElement("div");
    section.className = "network-section";

    const intro = document.createElement("p");
    intro.textContent = "Choose how you want to connect.";
    section.appendChild(intro);

    const buttonGroup = document.createElement("div");
    buttonGroup.className = "network-button-group";

    const hostButton = document.createElement("button");
    hostButton.type = "button";
    hostButton.className = "network-button network-button--primary";
    hostButton.textContent = "Start a new Game";
    hostButton.addEventListener("click", () => this.handleStartHosting());

    const guestButton = document.createElement("button");
    guestButton.type = "button";
    guestButton.className = "network-button";
    guestButton.textContent = "Join a Game";
    guestButton.addEventListener("click", () => this.moveToGuestEntry());

    buttonGroup.appendChild(hostButton);
    buttonGroup.appendChild(guestButton);

    section.appendChild(buttonGroup);
    section.appendChild(this.buildCancelRow());

    return section;
  }

  private buildHostContent(): HTMLElement {
    const hostState = this.getHostState();
    const section = document.createElement("div");
    section.className = "network-section";

    const title = document.createElement("div");
    title.className = "network-info-title";
    title.textContent = "Hosting";
    section.appendChild(title);

    const description = document.createElement("p");
    description.textContent = hostState.phase === "creating"
      ? "Creating your room..."
      : "Share the room code and join code with your friend.";
    section.appendChild(description);

    if (hostState.phase === "connected" || hostState.phase === "connecting") {
      const progress = document.createElement("div");
      progress.className = "network-validation-message";
      progress.textContent = hostState.phase === "connected" ? "Connected. Starting match..." : "Waiting for guest to join...";
      section.appendChild(progress);
    }

    section.appendChild(this.buildCancelRow(false));

    return section;
  }

  private buildGuestContent(): HTMLElement {
    const guestState = this.getGuestState();
    const section = document.createElement("div");
    section.className = "network-section";

    const title = document.createElement("div");
    title.className = "network-info-title";
    title.textContent = "Join a friend";
    section.appendChild(title);

    if (guestState.phase === "enter-room") {
      section.appendChild(this.buildRoomCodeControls(guestState));
      section.appendChild(this.buildFindActions());
    } else if (guestState.phase === "found-room") {
      section.appendChild(this.buildFoundHostCallout(guestState.hostName));
      section.appendChild(this.buildJoinCodeControls(guestState));
      section.appendChild(this.buildJoinActions());
    } else {
      if (guestState.phase === "joining-room" || guestState.phase === "connecting") {
        section.appendChild(this.buildFoundHostCallout(guestState.hostName));
        section.appendChild(this.buildJoinCodeControls(guestState, true));
      }
      if (guestState.phase === "connected") {
        const status = document.createElement("div");
        status.className = "network-validation-message";
        status.textContent = "Connected. Starting match...";
        section.appendChild(status);
      }
      section.appendChild(this.buildCancelRow(false));
      return section;
    }

    section.appendChild(this.buildCancelRow(false));
    return section;
  }

  private buildFoundHostCallout(hostName: string): HTMLElement {
    const callout = document.createElement("div");
    callout.className = "network-info-title";
    callout.textContent = `Found: Host ${hostName}`;
    return callout;
  }

  private buildRoomCodeControls(guestState: Extract<DialogState, { kind: "joining" }>): HTMLElement {
    const wrapper = document.createElement("div");

    const roomCodeLabel = document.createElement("label");
    roomCodeLabel.className = "network-label";
    roomCodeLabel.textContent = "Room Code";

    const roomCodeInput = document.createElement("input");
    roomCodeInput.type = "text";
    roomCodeInput.className = "network-input";
    roomCodeInput.placeholder = "Enter room code from host";
    roomCodeInput.value = guestState.roomCode;
    roomCodeInput.maxLength = 16;
    roomCodeInput.addEventListener("input", (e) => {
      const nextCode = (e.target as HTMLInputElement).value.toUpperCase();
      this.state = { ...guestState, roomCode: nextCode };
      (e.target as HTMLInputElement).value = nextCode;
    });

    wrapper.appendChild(roomCodeLabel);
    wrapper.appendChild(roomCodeInput);
    return wrapper;
  }

  private buildJoinCodeControls(
    guestState: Extract<DialogState, { kind: "joining" }>,
    readonly = false
  ): HTMLElement {
    const wrapper = document.createElement("div");

    const joinCodeLabel = document.createElement("label");
    joinCodeLabel.className = "network-label";
    joinCodeLabel.textContent = "Join Code";

    const joinCodeInput = document.createElement("input");
    joinCodeInput.type = "text";
    joinCodeInput.className = "network-input";
    joinCodeInput.placeholder = "Enter join code from host";
    joinCodeInput.value = guestState.joinCode;
    joinCodeInput.maxLength = 16;
    joinCodeInput.readOnly = readonly;
    joinCodeInput.addEventListener("input", (e) => {
      this.state = { ...guestState, joinCode: (e.target as HTMLInputElement).value };
    });

    wrapper.appendChild(joinCodeLabel);
    wrapper.appendChild(joinCodeInput);
    return wrapper;
  }

  private buildFindActions(): HTMLElement {
    const buttonGroup = document.createElement("div");
    buttonGroup.className = "network-button-group";

    const findButton = document.createElement("button");
    findButton.type = "button";
    findButton.className = "network-button network-button--primary";
    findButton.textContent = "Find";
    findButton.disabled = this.isProcessing;
    findButton.addEventListener("click", () => this.handleFindRoom());

    buttonGroup.appendChild(findButton);
    return buttonGroup;
  }

  private buildJoinActions(): HTMLElement {
    const buttonGroup = document.createElement("div");
    buttonGroup.className = "network-button-group";

    const joinButton = document.createElement("button");
    joinButton.type = "button";
    joinButton.className = "network-button network-button--primary";
    joinButton.textContent = "Join";
    joinButton.disabled = this.isProcessing;
    joinButton.addEventListener("click", () => this.handleJoinRoom());

    buttonGroup.appendChild(joinButton);
    return buttonGroup;
  }

  private buildCancelRow(allowDismiss = true): HTMLElement {
    const row = document.createElement("div");
    row.className = "network-button-group";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "network-button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => this.handleCancel(allowDismiss));

    row.appendChild(cancelButton);
    return row;
  }

  private renderValidationPanel(panel: HTMLElement) {
    panel.innerHTML = "";
    if (this.validationMessages.length === 0) return;

    for (const msg of this.validationMessages) {
      const line = document.createElement("div");
      line.className = "network-validation-message";
      line.textContent = msg;
      panel.appendChild(line);
    }
  }

  private renderInfoPanel(panel: HTMLElement) {
    panel.innerHTML = "";
    const title = document.createElement("div");
    title.className = "network-info-title";
    title.textContent = this.state.kind === "hosting" ? "Room Information" : "Connection Details";
    panel.appendChild(title);

    if (this.state.roomCode) {
      const codeItem = document.createElement("div");
      codeItem.className = "network-info-item";
      codeItem.innerHTML = `<span>Room Code:</span> <strong>${this.state.roomCode}</strong>`;
      panel.appendChild(codeItem);
    }

    if (this.state.kind === "hosting" && this.state.joinCode) {
      const joinItem = document.createElement("div");
      joinItem.className = "network-info-item";
      joinItem.innerHTML = `<span>Join Code:</span> <strong>${this.state.joinCode}</strong>`;
      panel.appendChild(joinItem);
    }

    if (this.state.hostName) {
      const hostItem = document.createElement("div");
      hostItem.className = "network-info-item";
      hostItem.innerHTML = `<span>Host:</span> <strong>${this.state.hostName}</strong>`;
      panel.appendChild(hostItem);
    }
  }

  private collectValidationMessages(snapshot: NetworkSessionStateSnapshot): string[] {
    const messages: string[] = [];

    if (snapshot.connection.lastError) {
      messages.push(`Error: ${snapshot.connection.lastError}`);
    }

    const lifecycle = snapshot.connection.lifecycle;
    if (lifecycle === ConnectionState.CREATING) {
      messages.push("Creating room...");
    } else if (lifecycle === ConnectionState.CREATED) {
      messages.push("Room created. Waiting for your friend...");
    } else if (lifecycle === ConnectionState.JOINING) {
      messages.push("Joining room...");
    } else if (lifecycle === ConnectionState.JOINED) {
      messages.push("Joined room. Preparing connection...");
    } else if (lifecycle === ConnectionState.CONNECTING) {
      messages.push("Establishing connection...");
    } else if (lifecycle === ConnectionState.CONNECTED) {
      messages.push("Connected! Starting match...");
    }

    if (snapshot.registry.status === "joined" && snapshot.player.role === "host") {
      messages.push("Guest detected. Connecting...");
    }

    return messages;
  }

  private getHostState(): Extract<DialogState, { kind: "hosting" }> {
    if (this.state.kind !== "hosting") {
      throw new Error("Host state requested outside hosting flow");
    }

    return this.state;
  }

  private getGuestState(): Extract<DialogState, { kind: "joining" }> {
    if (this.state.kind !== "joining") {
      throw new Error("Guest state requested outside joining flow");
    }

    return this.state;
  }

  private moveToGuestEntry() {
    this.state = { kind: "joining", phase: "enter-room", roomCode: "", joinCode: "", hostName: "", expiresAt: null };
    this.validationMessages = [];
    this.refreshContent();
  }

  private refreshContent() {
    const currentContainer = this.contentContainer;
    if (!currentContainer || !currentContainer.parentElement) {
      return;
    }

    const parent = currentContainer.parentElement;
    const newContent = this.buildContent();

    parent.replaceChild(newContent, currentContainer);
  }

  private async handleStartHosting() {
    if (this.isProcessing) return;
    if (!this.playerName.trim()) {
      this.validationMessages = ["Please enter your name"];
      this.refreshContent();
      return;
    }

    this.state = { kind: "hosting", phase: "creating", roomCode: "", joinCode: null, hostName: this.playerName.trim(), expiresAt: null };
    this.isProcessing = true;
    this.refreshContent();

    try {
      await this.callbacks.onCreateRoom(this.playerName.trim());
    } catch (error) {
      this.validationMessages = [`Failed to create room: ${error instanceof Error ? error.message : String(error)}`];
      this.state = createLandingState();
    } finally {
      this.isProcessing = false;
      this.refreshContent();
    }
  }

  private async handleFindRoom() {
    if (this.isProcessing) return;

    if (!this.playerName.trim()) {
      this.validationMessages = ["Please enter your name"];
      this.refreshContent();
      return;
    }

    if (!this.state.roomCode.trim()) {
      this.validationMessages = ["Please enter the room code"];
      this.refreshContent();
      return;
    }

    this.isProcessing = true;
    this.refreshContent();

    try {
      await this.callbacks.onLookupRoom(this.state.roomCode.trim());
      this.state = { ...this.state, phase: "found-room" } as DialogState;
    } catch (error) {
      this.validationMessages = [`Failed to find room: ${error instanceof Error ? error.message : String(error)}`];
    } finally {
      this.isProcessing = false;
      this.refreshContent();
    }
  }

  private async handleJoinRoom() {
    if (this.isProcessing || this.state.kind !== "joining") return;

    if (!this.playerName.trim()) {
      this.validationMessages = ["Please enter your name"];
      this.refreshContent();
      return;
    }

    if (!this.state.joinCode.trim()) {
      this.validationMessages = ["Please enter the join code"];
      this.refreshContent();
      return;
    }

    this.isProcessing = true;
    this.refreshContent();

    try {
      await this.callbacks.onJoinRoom(this.state.roomCode.trim(), this.state.joinCode.trim(), this.playerName.trim());
      this.state = { ...this.state, phase: "joining-room" } as DialogState;
    } catch (error) {
      this.validationMessages = [`Failed to join room: ${error instanceof Error ? error.message : String(error)}`];
    } finally {
      this.isProcessing = false;
      this.refreshContent();
    }
  }

  private handleCancel(allowDismiss: boolean) {
    this.callbacks.onCancel();
    if (allowDismiss && this.state.kind === "landing") {
      this.hide();
      return;
    }

    this.resetState();
  }

  private resetState() {
    this.state = createLandingState();
    this.validationMessages = [];
    this.isProcessing = false;
    this.refreshContent();
  }

  private readStoredPlayerName(): string {
    try {
      const stored = window.localStorage.getItem(PLAYER_NAME_STORAGE_KEY);
      return stored ?? "";
    } catch {
      return "";
    }
  }

  private persistPlayerName() {
    try {
      if (this.playerName) {
        window.localStorage.setItem(PLAYER_NAME_STORAGE_KEY, this.playerName);
      } else {
        window.localStorage.removeItem(PLAYER_NAME_STORAGE_KEY);
      }
    } catch {
      // Ignore storage errors
    }
  }
}
