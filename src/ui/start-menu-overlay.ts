import { CommandDialog } from "./dialog";

type MenuMode = "start" | "pause";

type MenuItem = {
  id: "help" | "start" | "friends";
  label: string;
  description: string;
  enabled: boolean;
  action: "help" | "start" | "restart" | null;
};

export type MenuAction = "help" | "start" | "restart" | null;

export type StartMenuCallbacks = {
  onHelp: () => void;
  onStart: () => void;
  onRestart: () => void;
  onClose: () => void;
};

export class StartMenuOverlay {
  private readonly dialog: CommandDialog;
  private readonly callbacks: StartMenuCallbacks;
  private mode: MenuMode = "start";
  private closeable = true;

  constructor(callbacks: StartMenuCallbacks) {
    this.callbacks = callbacks;
    this.dialog = new CommandDialog();
  }

  show(mode: MenuMode = this.mode, closeable = true) {
    this.mode = mode;
    this.closeable = closeable;
    this.dialog.show({
      title: "Worm Command Center",
      subtitle:
        mode === "start"
          ? "Select your briefing"
          : "Plans change mid-mischief? Choose wisely.",
      closeable,
      zIndex: 24,
      onClose: () => this.callbacks.onClose(),
      content: this.buildContent(),
    });
  }

  hide() {
    this.dialog.hide();
  }

  dispose() {
    this.dialog.destroy();
  }

  requestClose() {
    if (!this.closeable) return;
    this.dialog.requestClose();
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

    const blurb = document.createElement("p");
    blurb.className = "menu-dialog__blurb";
    blurb.textContent =
      this.mode === "start"
        ? "Tune your gadgets, rally your worms, and leap into the fray."
        : "Storm clouds ahead! Swap gear, call for help, or reboot the chaos.";
    container.appendChild(blurb);

    const list = document.createElement("div");
    list.className = "menu-options";

    for (const item of this.getItems()) {
      const button = document.createElement("button");
      button.className = "menu-button";
      button.disabled = !item.enabled;
      button.type = "button";

      const label = document.createElement("span");
      label.className = "menu-button__label";
      label.textContent = item.label;

      const desc = document.createElement("span");
      desc.className = "menu-button__description";
      desc.textContent = item.description;

      button.appendChild(label);
      button.appendChild(desc);

      button.addEventListener("click", () => this.triggerAction(item.action));

      list.appendChild(button);
    }

    container.appendChild(list);

    const footer = document.createElement("p");
    footer.className = "menu-dialog__footer";
    footer.textContent = this.closeable
      ? "Esc also slips you back into the battlefield."
      : "Press Start to deploy—no backing out of this briefing.";
    container.appendChild(footer);

    return container;
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
  }

  private getItems(): MenuItem[] {
    const startLabel = this.mode === "start" ? "Start" : "Restart Mission";
    const startDescription =
      this.mode === "start"
        ? "Deploy your crew and make a heroic splash."
        : "Spin the world back to turn one and try a new gambit.";

    return [
      {
        id: "help",
        label: "Help",
        description: "Controls, wind wisdom, and other battle tips.",
        enabled: true,
        action: "help",
      },
      {
        id: "start",
        label: startLabel,
        description: startDescription,
        enabled: true,
        action: this.mode === "start" ? "start" : "restart",
      },
      {
        id: "friends",
        label: "Play With Friends",
        description: "Co-op chaos coming soon—hold onto your helmets!",
        enabled: false,
        action: null,
      },
    ];
  }
}
