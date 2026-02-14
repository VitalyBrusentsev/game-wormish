import { type CloseReason, CommandDialog } from "./dialog";
import type { MenuIconId } from "./menu-icons";

type MenuMode = "start" | "pause";
type StartMenuIconId = Extract<MenuIconId, "help" | "start" | "online">;

type MenuItem = {
  id: "help" | "start" | "online";
  label: string;
  icon: StartMenuIconId;
  enabled: boolean;
  action: "help" | "start" | "restart" | "network" | null;
};

export type MenuAction = "help" | "start" | "restart" | "network" | null;

export type StartMenuCallbacks = {
  onHelp: () => void;
  onStart: () => void;
  onRestart: () => void;
  onNetworkMatch: () => void;
  getAudioToggles: () => { soundOn: boolean; musicOn: boolean };
  onToggleSound: (enabled: boolean) => void;
  onToggleMusic: (enabled: boolean) => void;
  onClose: (reason: CloseReason) => void;
};

export class StartMenuOverlay {
  private readonly dialog: CommandDialog;
  private readonly callbacks: StartMenuCallbacks;
  private mode: MenuMode = "start";
  private closeable = true;
  private audioToggles = { soundOn: true, musicOn: true };

  constructor(callbacks: StartMenuCallbacks) {
    this.callbacks = callbacks;
    this.dialog = new CommandDialog();
  }

  show(mode: MenuMode = this.mode, closeable = true) {
    this.mode = mode;
    this.closeable = closeable;
    this.audioToggles = this.callbacks.getAudioToggles();
    this.dialog.show({
      title: "Worm Command Center",
      subtitle: "Time to wreak havoc and have some fun!",
      extraClass: "dialog-shell--narrow",
      closeable,
      zIndex: 24,
      onClose: (reason) => this.callbacks.onClose(reason),
      content: this.buildContent(),
    });
  }

  hide() {
    this.dialog.hide();
  }

  dispose() {
    this.dialog.destroy();
  }

  requestClose(reason: CloseReason = "manual") {
    if (!this.closeable) return;
    this.dialog.requestClose(reason);
  }

  isVisible() {
    return this.dialog.isVisible();
  }

  getMode(): MenuMode {
    return this.mode;
  }

  private buildContent() {
    const container = document.createElement("div");
    container.className = "menu-dialog";

    const list = document.createElement("div");
    list.className = "menu-options";

    for (const item of this.getItems()) {
      const button = document.createElement("button");
      button.className = "menu-button";
      button.disabled = !item.enabled;
      button.type = "button";

      button.classList.add(`menu-button--${item.id}`);

      const label = document.createElement("span");
      label.className = "menu-button__label";
      label.textContent = item.label;

      const icon = document.createElement("div");
      icon.className = `menu-button__icon menu-button__icon--${item.icon}`;

      button.appendChild(label);
      button.appendChild(icon);
      button.addEventListener("click", () => this.triggerAction(item.action));

      list.appendChild(button);
    }

    container.appendChild(list);
    container.appendChild(this.buildAudioToggleRow());

    return container;
  }

  private buildAudioToggleRow() {
    const audioRow = document.createElement("div");
    audioRow.className = "menu-audio-row";

    const soundButton = document.createElement("button");
    soundButton.type = "button";
    soundButton.className = "menu-audio-toggle";

    const separator = document.createElement("span");
    separator.className = "menu-audio-separator";
    separator.textContent = "|";

    const musicButton = document.createElement("button");
    musicButton.type = "button";
    musicButton.className = "menu-audio-toggle";

    const refreshSound = () => {
      this.updateAudioToggleButton(soundButton, "Sound", this.audioToggles.soundOn);
    };
    const refreshMusic = () => {
      this.updateAudioToggleButton(musicButton, "Music", this.audioToggles.musicOn);
    };

    refreshSound();
    refreshMusic();

    soundButton.addEventListener("click", () => {
      this.audioToggles.soundOn = !this.audioToggles.soundOn;
      refreshSound();
      this.callbacks.onToggleSound(this.audioToggles.soundOn);
    });

    musicButton.addEventListener("click", () => {
      this.audioToggles.musicOn = !this.audioToggles.musicOn;
      refreshMusic();
      this.callbacks.onToggleMusic(this.audioToggles.musicOn);
    });

    audioRow.appendChild(soundButton);
    audioRow.appendChild(separator);
    audioRow.appendChild(musicButton);
    return audioRow;
  }

  private updateAudioToggleButton(button: HTMLButtonElement, label: string, enabled: boolean) {
    button.textContent = `${label}: ${enabled ? "On" : "Off"}`;
    button.classList.toggle("menu-audio-toggle--on", enabled);
    button.classList.toggle("menu-audio-toggle--off", !enabled);
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
  }

  private triggerAction(action: MenuAction) {
    if (action === "help") {
      this.callbacks.onHelp();
      return;
    }
    if (action === "start") {
      this.callbacks.onStart();
      this.dialog.hide();
      return;
    }
    if (action === "restart") {
      this.callbacks.onRestart();
      this.dialog.hide();
      return;
    }
    if (action === "network") {
      this.callbacks.onNetworkMatch();
      return;
    }
  }

  private getItems(): MenuItem[] {
    const startLabel = this.mode === "start" ? "Start" : "Restart Mission";
    return [
      {
        id: "help",
        label: "Help",
        icon: "help",
        enabled: true,
        action: "help",
      },
      {
        id: "start",
        label: startLabel,
        icon: "start",
        enabled: true,
        action: this.mode === "start" ? "start" : "restart",
      },
      {
        id: "online",
        label: "Play With Friends",
        icon: "online",
        enabled: true,
        action: "network",
      },
    ];
  }
}
