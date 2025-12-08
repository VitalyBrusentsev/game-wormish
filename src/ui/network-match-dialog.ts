import { CommandDialog, type CloseReason } from "./dialog";
import type { NetworkSessionState } from "../network/session-state";

export type NetworkRole = "host" | "guest";

export interface NetworkMatchCallbacks {
  onCreateRoom: (playerName: string) => Promise<void>;
  onJoinRoom: (roomCode: string, joinCode: string, playerName: string) => Promise<void>;
  onStartConnection: () => Promise<void>;
  onCancel: () => void;
  onClose: (reason: CloseReason) => void;
}

export class NetworkMatchDialog {
  private readonly dialog: CommandDialog;
  private readonly callbacks: NetworkMatchCallbacks;
  private role: NetworkRole = "host";
  private playerName = "";
  private roomCode = "";
  private joinCode = "";
  private hostName = "";
  private validationMessages: string[] = [];
  private isProcessing = false;
  private contentContainer: HTMLElement | null = null;

  constructor(callbacks: NetworkMatchCallbacks) {
    this.callbacks = callbacks;
    this.dialog = new CommandDialog();
  }

  show(initialRole: NetworkRole = "host") {
    this.role = initialRole;
    this.validationMessages = [];
    this.isProcessing = false;
    this.dialog.show({
      title: "Network Match Setup",
      subtitle: "Connect with a friend for multiplayer action",
      closeable: true,
      zIndex: 25,
      onClose: (reason) => {
        this.callbacks.onClose(reason);
        this.callbacks.onCancel();
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
    
    // Update validation messages based on connection state
    this.validationMessages = [];
    
    if (snapshot.connection.lastError) {
      this.validationMessages.push(`Error: ${snapshot.connection.lastError}`);
    }
    
    if (snapshot.connection.lifecycle === "creating") {
      this.validationMessages.push("Creating room...");
    } else if (snapshot.connection.lifecycle === "created") {
      this.validationMessages.push("Room created! Share the codes with your friend.");
    } else if (snapshot.connection.lifecycle === "joining") {
      this.validationMessages.push("Joining room...");
    } else if (snapshot.connection.lifecycle === "joined") {
      this.validationMessages.push(`Joined ${snapshot.registry.hostUserName}'s room. Ready to connect.`);
    } else if (snapshot.connection.lifecycle === "connecting") {
      this.validationMessages.push("Establishing connection...");
    } else if (snapshot.connection.lifecycle === "connected") {
      this.validationMessages.push("Connected! Starting match...");
    }
    
    // Update room info display
    if (snapshot.registry.code) {
      this.roomCode = snapshot.registry.code;
    }
    if (snapshot.registry.joinCode) {
      this.joinCode = snapshot.registry.joinCode;
    }
    if (snapshot.registry.hostUserName) {
      this.hostName = snapshot.registry.hostUserName;
    }
    
    this.refreshContent();
  }

  private buildContent(): HTMLElement {
    const container = document.createElement("div");
    container.className = "network-dialog";
    this.contentContainer = container;

    // Role tabs
    const tabs = document.createElement("div");
    tabs.className = "network-tabs";

    const hostTab = document.createElement("button");
    hostTab.type = "button";
    hostTab.className = `network-tab ${this.role === "host" ? "network-tab--active" : ""}`;
    hostTab.textContent = "Host";
    hostTab.addEventListener("click", () => this.switchRole("host"));

    const guestTab = document.createElement("button");
    guestTab.type = "button";
    guestTab.className = `network-tab ${this.role === "guest" ? "network-tab--active" : ""}`;
    guestTab.textContent = "Guest";
    guestTab.addEventListener("click", () => this.switchRole("guest"));

    tabs.appendChild(hostTab);
    tabs.appendChild(guestTab);
    container.appendChild(tabs);

    // Content area
    const content = document.createElement("div");
    content.className = "network-content";

    if (this.role === "host") {
      content.appendChild(this.buildHostContent());
    } else {
      content.appendChild(this.buildGuestContent());
    }

    container.appendChild(content);

    // Validation panel
    const validationPanel = document.createElement("div");
    validationPanel.className = "network-validation";
    validationPanel.id = "network-validation-panel";
    this.renderValidationPanel(validationPanel);
    container.appendChild(validationPanel);

    // Room info panel
    if (this.roomCode) {
      const infoPanel = document.createElement("div");
      infoPanel.className = "network-info";
      infoPanel.id = "network-info-panel";
      this.renderInfoPanel(infoPanel);
      container.appendChild(infoPanel);
    }

    return container;
  }

  private buildHostContent(): HTMLElement {
    const section = document.createElement("div");
    section.className = "network-section";

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
    });

    const button = document.createElement("button");
    button.type = "button";
    button.className = "network-button network-button--primary";
    button.textContent = this.roomCode ? "Start Connection" : "Create Room";
    button.disabled = this.isProcessing;
    button.addEventListener("click", () => this.handleHostAction());

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "network-button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => {
      this.callbacks.onCancel();
      this.hide();
    });

    const buttonGroup = document.createElement("div");
    buttonGroup.className = "network-button-group";
    buttonGroup.appendChild(button);
    buttonGroup.appendChild(cancelButton);

    section.appendChild(label);
    section.appendChild(input);
    section.appendChild(buttonGroup);

    return section;
  }

  private buildGuestContent(): HTMLElement {
    const section = document.createElement("div");
    section.className = "network-section";

    // Player name
    const nameLabel = document.createElement("label");
    nameLabel.className = "network-label";
    nameLabel.textContent = "Your Name";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "network-input";
    nameInput.placeholder = "Enter your display name";
    nameInput.value = this.playerName;
    nameInput.maxLength = 32;
    nameInput.addEventListener("input", (e) => {
      this.playerName = (e.target as HTMLInputElement).value;
    });

    // Room code
    const roomCodeLabel = document.createElement("label");
    roomCodeLabel.className = "network-label";
    roomCodeLabel.textContent = "Room Code";

    const roomCodeInput = document.createElement("input");
    roomCodeInput.type = "text";
    roomCodeInput.className = "network-input";
    roomCodeInput.placeholder = "Enter room code from host";
    roomCodeInput.value = this.roomCode;
    roomCodeInput.maxLength = 16;
    roomCodeInput.addEventListener("input", (e) => {
      this.roomCode = (e.target as HTMLInputElement).value.toUpperCase();
      (e.target as HTMLInputElement).value = this.roomCode;
    });

    // Join code
    const joinCodeLabel = document.createElement("label");
    joinCodeLabel.className = "network-label";
    joinCodeLabel.textContent = "Join Code";

    const joinCodeInput = document.createElement("input");
    joinCodeInput.type = "text";
    joinCodeInput.className = "network-input";
    joinCodeInput.placeholder = "Enter join code from host";
    joinCodeInput.value = this.joinCode;
    joinCodeInput.maxLength = 16;
    joinCodeInput.addEventListener("input", (e) => {
      this.joinCode = (e.target as HTMLInputElement).value;
    });

    const button = document.createElement("button");
    button.type = "button";
    button.className = "network-button network-button--primary";
    button.textContent = this.hostName ? "Start Connection" : "Join Room";
    button.disabled = this.isProcessing;
    button.addEventListener("click", () => this.handleGuestAction());

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "network-button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", () => {
      this.callbacks.onCancel();
      this.hide();
    });

    const buttonGroup = document.createElement("div");
    buttonGroup.className = "network-button-group";
    buttonGroup.appendChild(button);
    buttonGroup.appendChild(cancelButton);

    section.appendChild(nameLabel);
    section.appendChild(nameInput);
    section.appendChild(roomCodeLabel);
    section.appendChild(roomCodeInput);
    section.appendChild(joinCodeLabel);
    section.appendChild(joinCodeInput);
    section.appendChild(buttonGroup);

    return section;
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
    if (!this.roomCode) return;

    const title = document.createElement("div");
    title.className = "network-info-title";
    title.textContent = "Room Information";
    panel.appendChild(title);

    if (this.roomCode) {
      const codeItem = document.createElement("div");
      codeItem.className = "network-info-item";
      codeItem.innerHTML = `<span>Room Code:</span> <strong>${this.roomCode}</strong>`;
      panel.appendChild(codeItem);
    }

    if (this.joinCode) {
      const joinItem = document.createElement("div");
      joinItem.className = "network-info-item";
      joinItem.innerHTML = `<span>Join Code:</span> <strong>${this.joinCode}</strong>`;
      panel.appendChild(joinItem);
    }

    if (this.hostName) {
      const hostItem = document.createElement("div");
      hostItem.className = "network-info-item";
      hostItem.innerHTML = `<span>Host:</span> <strong>${this.hostName}</strong>`;
      panel.appendChild(hostItem);
    }
  }

  private switchRole(role: NetworkRole) {
    if (this.role === role || this.isProcessing) return;
    this.role = role;
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

  private async handleHostAction() {
    if (this.isProcessing) return;

    if (!this.roomCode) {
      // Create room
      if (!this.playerName.trim()) {
        this.validationMessages = ["Please enter your name"];
        this.refreshContent();
        return;
      }

      this.isProcessing = true;
      this.refreshContent();

      try {
        await this.callbacks.onCreateRoom(this.playerName.trim());
      } catch (error) {
        this.validationMessages = [`Failed to create room: ${error instanceof Error ? error.message : String(error)}`];
      } finally {
        this.isProcessing = false;
        this.refreshContent();
      }
    } else {
      // Start connection
      this.isProcessing = true;
      this.refreshContent();

      try {
        await this.callbacks.onStartConnection();
      } catch (error) {
        this.validationMessages = [`Failed to start connection: ${error instanceof Error ? error.message : String(error)}`];
        this.isProcessing = false;
        this.refreshContent();
      }
    }
  }

  private async handleGuestAction() {
    if (this.isProcessing) return;

    if (!this.hostName) {
      // Join room
      if (!this.playerName.trim()) {
        this.validationMessages = ["Please enter your name"];
        this.refreshContent();
        return;
      }
      if (!this.roomCode.trim()) {
        this.validationMessages = ["Please enter the room code"];
        this.refreshContent();
        return;
      }
      if (!this.joinCode.trim()) {
        this.validationMessages = ["Please enter the join code"];
        this.refreshContent();
        return;
      }

      this.isProcessing = true;
      this.refreshContent();

      try {
        await this.callbacks.onJoinRoom(
          this.roomCode.trim(),
          this.joinCode.trim(),
          this.playerName.trim()
        );
      } catch (error) {
        this.validationMessages = [`Failed to join room: ${error instanceof Error ? error.message : String(error)}`];
      } finally {
        this.isProcessing = false;
        this.refreshContent();
      }
    } else {
      // Start connection
      this.isProcessing = true;
      this.refreshContent();

      try {
        await this.callbacks.onStartConnection();
      } catch (error) {
        this.validationMessages = [`Failed to start connection: ${error instanceof Error ? error.message : String(error)}`];
        this.isProcessing = false;
        this.refreshContent();
      }
    }
  }
}