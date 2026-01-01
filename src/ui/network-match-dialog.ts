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
  | {
      kind: "hosting";
      phase: HostPhase;
      roomCode: string;
      joinCode: string | null;
      hostName: string;
      guestName: string;
      expiresAt: number | null;
    }
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
  const guestName = snapshot.registry.guestUserName || (current.kind === "hosting" ? current.guestName : "") || "";
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
      guestName,
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
  private statusMessages: string[] = [];
  private isProcessing = false;
  private contentContainer: HTMLElement | null = null;

  constructor(callbacks: NetworkMatchCallbacks) {
    this.callbacks = callbacks;
    this.dialog = new CommandDialog();
    this.playerName = this.readStoredPlayerName();
  }

  show(initialRole: NetworkRole = "host") {
    this.statusMessages = [];
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
    this.statusMessages = this.collectStatusMessages(snapshot, this.state);

    this.refreshContent();
  }

  private buildContent(): HTMLElement {
    const container = document.createElement("div");
    container.className = "network-dialog";
    this.contentContainer = container;

    container.appendChild(this.buildNameField());
    container.appendChild(this.buildBody());

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
    const statusBlock = this.buildStatusBlock();
    if (statusBlock) {
      section.appendChild(statusBlock);
    }
    section.appendChild(this.buildCancelRow());

    return section;
  }

  private buildHostContent(): HTMLElement {
    const section = document.createElement("div");
    section.className = "network-section";

    const statusBlock = this.buildStatusBlock(true);
    if (statusBlock) {
      section.appendChild(statusBlock);
    }
    section.appendChild(this.buildCancelRow(false));

    return section;
  }

  private buildGuestContent(): HTMLElement {
    const guestState = this.getGuestState();
    const section = document.createElement("div");
    section.className = "network-section";

    if (guestState.phase === "enter-room") {
      section.appendChild(this.buildRoomCodeControls(guestState));
      section.appendChild(this.buildFindActions());
    } else if (guestState.phase === "found-room") {
      section.appendChild(this.buildJoinCodeControls(guestState));
      section.appendChild(this.buildJoinActions());
    } else {
      if (guestState.phase === "joining-room" || guestState.phase === "connecting") {
        section.appendChild(this.buildJoinCodeControls(guestState, true));
      }
      const statusBlock = this.buildStatusBlock(true);
      if (statusBlock) {
        section.appendChild(statusBlock);
      }
      section.appendChild(this.buildCancelRow(false));
      return section;
    }

    const statusBlock = this.buildStatusBlock();
    if (statusBlock) {
      section.appendChild(statusBlock);
    }
    section.appendChild(this.buildCancelRow(false));
    return section;
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

  private buildStatusBlock(forceShow = false): HTMLElement | null {
    const message = this.deriveStatusMessage();
    const details = this.collectStatusDetails();

    if (!forceShow && !message && details.length === 0) {
      return null;
    }

    const panel = document.createElement("div");
    panel.className = "network-status";

    const title = document.createElement("div");
    title.className = "network-status-title";
    title.textContent = this.state.kind === "hosting" ? "Hosting" : this.state.kind === "joining" ? "Joining" : "Status";
    panel.appendChild(title);

    if (message) {
      const line = document.createElement("div");
      const tone = this.isStatusError(message) ? " network-status-message--error" : "";
      line.className = `network-status-message${tone}`;
      line.textContent = message;
      panel.appendChild(line);
    }

    if (details.length > 0) {
      const list = document.createElement("div");
      list.className = "network-status-details";

      for (const item of details) {
        const row = document.createElement("div");
        row.className = "network-info-item";

        const label = document.createElement("span");
        label.textContent = `${item.label}:`;

        const value = document.createElement("strong");
        value.textContent = item.value;

        row.appendChild(label);
        row.appendChild(value);
        list.appendChild(row);
      }

      panel.appendChild(list);
    }

    return panel;
  }

  private isStatusError(message: string) {
    return (
      message.startsWith("Error:") ||
      message.startsWith("Failed") ||
      message.startsWith("Please ")
    );
  }

  private deriveStatusMessage(): string | null {
    if (this.statusMessages.length > 0) {
      return this.statusMessages[0] ?? null;
    }

    if (this.isProcessing) {
      if (this.state.kind === "hosting") return "Creating room...";
      if (this.state.kind === "joining") {
        if (this.state.phase === "enter-room") return "Finding room...";
        if (this.state.phase === "found-room") return "Joining room...";
      }
    }

    if (this.state.kind === "hosting") {
      if (this.state.phase === "creating") return "Creating room...";
      if (this.state.phase === "room-ready") return "Waiting for the guest to join...";
      if (this.state.phase === "connecting") {
        return this.state.guestName
          ? "Guest joined. Establishing connection..."
          : "Waiting for the guest to join...";
      }
      if (this.state.phase === "connected") return "Connected. Starting match...";
    }

    if (this.state.kind === "joining") {
      if (this.state.phase === "found-room") {
        return this.state.hostName
          ? `Found host ${this.state.hostName}. Enter the join code to connect.`
          : "Room found. Enter the join code to connect.";
      }
      if (this.state.phase === "joining-room") return "Joining room...";
      if (this.state.phase === "connecting") return "Establishing connection...";
      if (this.state.phase === "connected") return "Connected. Starting match...";
    }

    return null;
  }

  private collectStatusDetails(): Array<{ label: string; value: string }> {
    const details: Array<{ label: string; value: string }> = [];

    if (this.state.roomCode) {
      details.push({ label: "Room Code", value: this.state.roomCode });
    }

    if (this.state.kind === "hosting") {
      if (this.state.joinCode) {
        details.push({ label: "Join Code", value: this.state.joinCode });
      }
      if (this.state.guestName) {
        details.push({ label: "Guest", value: this.state.guestName });
      }
      return details;
    }

    if (this.state.kind === "joining" && this.state.hostName) {
      details.push({ label: "Host", value: this.state.hostName });
    }

    return details;
  }

  private collectStatusMessages(snapshot: NetworkSessionStateSnapshot, state: DialogState): string[] {
    if (snapshot.connection.lastError) {
      return [`Error: ${snapshot.connection.lastError}`];
    }

    if (state.kind === "hosting") {
      const lifecycle = snapshot.connection.lifecycle;
      if (lifecycle === ConnectionState.CREATING || state.phase === "creating") return ["Creating room..."];
      if (lifecycle === ConnectionState.CONNECTING) {
        const guestPresent = snapshot.registry.status === "joined" || snapshot.registry.status === "paired" || !!snapshot.registry.guestUserName;
        return [guestPresent ? "Guest joined. Establishing connection..." : "Waiting for the guest to join..."];
      }
      if (lifecycle === ConnectionState.CONNECTED) return ["Connected. Starting match..."];
      if (lifecycle === ConnectionState.CREATED || state.phase === "room-ready") {
        return ["Waiting for the guest to join..."];
      }
    }

    if (state.kind === "joining") {
      const lifecycle = snapshot.connection.lifecycle;
      if (lifecycle === ConnectionState.JOINING || state.phase === "joining-room") return ["Joining room..."];
      if (lifecycle === ConnectionState.JOINED || lifecycle === ConnectionState.CONNECTING || state.phase === "connecting") {
        return ["Establishing connection..."];
      }
      if (lifecycle === ConnectionState.CONNECTED || state.phase === "connected") return ["Connected. Starting match..."];
      if (state.phase === "found-room") {
        return [
          state.hostName
            ? `Found host ${state.hostName}. Enter the join code to connect.`
            : "Room found. Enter the join code to connect.",
        ];
      }
    }

    return [];
  }

  private getGuestState(): Extract<DialogState, { kind: "joining" }> {
    if (this.state.kind !== "joining") {
      throw new Error("Guest state requested outside joining flow");
    }

    return this.state;
  }

  private moveToGuestEntry() {
    this.state = { kind: "joining", phase: "enter-room", roomCode: "", joinCode: "", hostName: "", expiresAt: null };
    this.statusMessages = [];
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
      this.statusMessages = ["Please enter your name"];
      this.refreshContent();
      return;
    }

    this.state = { kind: "hosting", phase: "creating", roomCode: "", joinCode: null, hostName: this.playerName.trim(), guestName: "", expiresAt: null };
    this.statusMessages = ["Creating room..."];
    this.isProcessing = true;
    this.refreshContent();

    try {
      await this.callbacks.onCreateRoom(this.playerName.trim());
    } catch (error) {
      this.statusMessages = [`Failed to create room: ${error instanceof Error ? error.message : String(error)}`];
      this.state = createLandingState();
    } finally {
      this.isProcessing = false;
      this.refreshContent();
    }
  }

  private async handleFindRoom() {
    if (this.isProcessing) return;

    if (!this.playerName.trim()) {
      this.statusMessages = ["Please enter your name"];
      this.refreshContent();
      return;
    }

    if (!this.state.roomCode.trim()) {
      this.statusMessages = ["Please enter the room code"];
      this.refreshContent();
      return;
    }

    this.isProcessing = true;
    this.statusMessages = ["Finding room..."];
    this.refreshContent();

    try {
      await this.callbacks.onLookupRoom(this.state.roomCode.trim());
      this.state = { ...this.state, phase: "found-room" } as DialogState;
      this.statusMessages = [];
    } catch (error) {
      this.statusMessages = [`Failed to find room: ${error instanceof Error ? error.message : String(error)}`];
    } finally {
      this.isProcessing = false;
      this.refreshContent();
    }
  }

  private async handleJoinRoom() {
    if (this.isProcessing || this.state.kind !== "joining") return;

    if (!this.playerName.trim()) {
      this.statusMessages = ["Please enter your name"];
      this.refreshContent();
      return;
    }

    if (!this.state.joinCode.trim()) {
      this.statusMessages = ["Please enter the join code"];
      this.refreshContent();
      return;
    }

    this.isProcessing = true;
    this.statusMessages = ["Joining room..."];
    this.refreshContent();

    try {
      await this.callbacks.onJoinRoom(this.state.roomCode.trim(), this.state.joinCode.trim(), this.playerName.trim());
      this.state = { ...this.state, phase: "joining-room" } as DialogState;
      this.statusMessages = [];
    } catch (error) {
      this.statusMessages = [`Failed to join room: ${error instanceof Error ? error.message : String(error)}`];
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
    this.statusMessages = [];
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
