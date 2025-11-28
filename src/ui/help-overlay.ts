import { nowMs } from "../definitions";
import { CommandDialog } from "./dialog";

type HelpTopic = { title: string; text: string };

export type HelpOverlayCallbacks = {
  onClose?: (pausedMs: number) => void;
};

export class HelpOverlay {
  private readonly dialog: CommandDialog;
  private readonly callbacks: HelpOverlayCallbacks;
  private openedAtMs: number | null = null;
  private lastPausedMs = 0;

  constructor(callbacks: HelpOverlayCallbacks = {}) {
    this.callbacks = callbacks;
    this.dialog = new CommandDialog();
  }

  show(openedAt: number): boolean {
    if (this.dialog.isVisible()) return false;
    this.openedAtMs = openedAt;
    this.lastPausedMs = 0;

    this.dialog.show({
      title: "Worm Commander's Handy Guide",
      subtitle: "(Pause, sip cocoa, then plan your next shenanigan)",
      closeable: true,
      zIndex: 28,
      onClose: () => this.handleClose(),
      content: this.buildContent(),
    });

    return true;
  }

  hide(): number {
    if (!this.dialog.isVisible()) return 0;
    this.dialog.requestClose();
    return this.lastPausedMs;
  }

  dispose() {
    this.dialog.destroy();
  }

  isVisible() {
    return this.dialog.isVisible();
  }

  private handleClose() {
    const now = nowMs();
    const pausedFor = this.openedAtMs ? Math.max(0, now - this.openedAtMs) : 0;
    this.lastPausedMs = pausedFor;
    this.openedAtMs = null;
    this.callbacks.onClose?.(pausedFor);
  }

  private buildContent() {
    const container = document.createElement("div");
    container.className = "help-dialog";

    const intro = document.createElement("p");
    intro.className = "help-dialog__intro";
    intro.textContent =
      "A quick refresher for commanders who prefer style with their strategy:";
    container.appendChild(intro);

    const list = document.createElement("ul");
    list.className = "help-topics";

    for (const topic of this.getTopics()) {
      const item = document.createElement("li");
      item.className = "help-topics__item";

      const title = document.createElement("h3");
      title.className = "help-topics__title";
      title.textContent = topic.title;

      const text = document.createElement("p");
      text.className = "help-topics__text";
      text.textContent = topic.text;

      item.appendChild(title);
      item.appendChild(text);
      list.appendChild(item);
    }

    container.appendChild(list);

    const outro = document.createElement("p");
    outro.className = "help-dialog__footer";
    outro.textContent = "Remember to glance at the wind vane before you light the fuse.";
    container.appendChild(outro);

    return container;
  }

  private getTopics(): HelpTopic[] {
    return [
      { title: "Move", text: "A / D or ← → for a wiggly parade march." },
      { title: "Hop", text: "W or Space to vault over suspicious craters." },
      {
        title: "Aim",
        text: "Wiggle the mouse, keep your eyes on the crosshair.",
      },
      {
        title: "Charge & Fire",
        text: "Hold the mouse button, release to unleash mayhem.",
      },
      {
        title: "Swap Toys",
        text: "1 - Bazooka, 2 - Grenade, 3 - Rifle; Choose your chaos.",
      },
      {
        title: "Wind Watch",
        text: "Mind the gusts before you light the fuse!",
      },
    ];
  }
}
