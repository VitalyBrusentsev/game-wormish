import { CommandDialog } from "./dialog";
import type { MenuIconId } from "./menu-icons";

type MatchResultItem = {
  id: "new-game" | "back";
  label: string;
  onClick: () => void;
  icon: Extract<MenuIconId, "start" | "back">;
};

export type MatchResultCallbacks = {
  onNewGame: () => void;
  onBack: () => void;
};

export type MatchResultState = {
  winnerLabel: string;
  wormsLeft: number;
};

const formatSubtitle = (wormsLeft: number) => {
  if (wormsLeft === 1) return "1 worm is still alive!";
  return `${wormsLeft} worms are still alive!`;
};

export class MatchResultOverlay {
  private readonly dialog: CommandDialog;
  private readonly callbacks: MatchResultCallbacks;

  constructor(callbacks: MatchResultCallbacks) {
    this.callbacks = callbacks;
    this.dialog = new CommandDialog();
  }

  show(state: MatchResultState) {
    this.dialog.show({
      title: `${state.winnerLabel} wins!`,
      subtitle: formatSubtitle(Math.max(0, Math.floor(state.wormsLeft))),
      extraClass: "dialog-shell--narrow",
      closeable: false,
      zIndex: 26,
      content: this.buildContent(),
    });
  }

  hide() {
    this.dialog.hide();
  }

  isVisible() {
    return this.dialog.isVisible();
  }

  dispose() {
    this.dialog.destroy();
  }

  private buildContent() {
    const container = document.createElement("div");
    container.className = "menu-dialog";

    const list = document.createElement("div");
    list.className = "menu-options";

    for (const item of this.getItems()) {
      const button = document.createElement("button");
      button.className = "menu-button";
      button.type = "button";
      button.classList.add(`menu-button--${item.id}`);

      const label = document.createElement("span");
      label.className = "menu-button__label";
      label.textContent = item.label;

      button.appendChild(label);
      const icon = document.createElement("div");
      icon.className = `menu-button__icon menu-button__icon--${item.icon}`;
      button.appendChild(icon);
      button.addEventListener("click", () => {
        this.dialog.hide();
        item.onClick();
      });
      list.appendChild(button);
    }

    container.appendChild(list);
    return container;
  }

  private getItems(): MatchResultItem[] {
    return [
      {
        id: "new-game",
        label: "New Game",
        icon: "start",
        onClick: () => this.callbacks.onNewGame(),
      },
      {
        id: "back",
        label: "Back",
        icon: "back",
        onClick: () => this.callbacks.onBack(),
      },
    ];
  }
}
