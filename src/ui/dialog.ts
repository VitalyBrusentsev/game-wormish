export type DialogOptions = {
  title: string;
  subtitle?: string;
  content: HTMLElement;
  closeable?: boolean;
  zIndex?: number;
  onClose?: () => void;
};

export class CommandDialog {
  private readonly root: HTMLDivElement;
  private readonly backdrop: HTMLDivElement;
  private readonly shell: HTMLDivElement;
  private readonly header: HTMLDivElement;
  private readonly titleEl: HTMLHeadingElement;
  private readonly subtitleEl: HTMLParagraphElement;
  private readonly body: HTMLDivElement;
  private readonly closeButton: HTMLButtonElement;

  private currentOptions: DialogOptions | null = null;

  private readonly handleKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    this.requestClose();
  };

  private readonly handleBackdropClick = () => this.requestClose();
  private readonly handleCloseClick = () => this.requestClose();

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "dialog-layer";

    this.backdrop = document.createElement("div");
    this.backdrop.className = "dialog-backdrop";

    this.shell = document.createElement("div");
    this.shell.className = "dialog-shell";
    this.shell.setAttribute("role", "dialog");
    this.shell.setAttribute("aria-modal", "true");

    this.header = document.createElement("div");
    this.header.className = "dialog-header";

    this.titleEl = document.createElement("h2");
    this.titleEl.className = "dialog-title";

    this.subtitleEl = document.createElement("p");
    this.subtitleEl.className = "dialog-subtitle";

    this.closeButton = document.createElement("button");
    this.closeButton.type = "button";
    this.closeButton.className = "dialog-close";
    this.closeButton.setAttribute("aria-label", "Close dialog");
    this.closeButton.textContent = "✕";
    this.closeButton.addEventListener("click", this.handleCloseClick);

    this.body = document.createElement("div");
    this.body.className = "dialog-body";

    this.header.appendChild(this.titleEl);
    this.header.appendChild(this.subtitleEl);

    this.shell.appendChild(this.header);
    this.shell.appendChild(this.body);
    this.shell.appendChild(this.closeButton);

    this.root.appendChild(this.backdrop);
    this.root.appendChild(this.shell);

    this.backdrop.addEventListener("click", this.handleBackdropClick);

    document.body.appendChild(this.root);
  }

  show(options: DialogOptions) {
    this.currentOptions = options;

    this.root.style.zIndex = `${options.zIndex ?? 30}`;

    this.titleEl.textContent = options.title;
    this.subtitleEl.textContent = options.subtitle ?? "";
    this.subtitleEl.classList.toggle("dialog-subtitle--hidden", !options.subtitle);

    this.closeButton.classList.toggle("dialog-close--hidden", options.closeable === false);

    this.body.innerHTML = "";
    this.body.appendChild(options.content);

    this.root.classList.add("dialog-layer--visible");
    window.addEventListener("keydown", this.handleKeydown);
  }

  hide() {
    if (!this.isVisible()) return;
    this.root.classList.remove("dialog-layer--visible");
    window.removeEventListener("keydown", this.handleKeydown);
    this.currentOptions = null;
  }

  requestClose() {
    if (!this.currentOptions || this.currentOptions.closeable === false) return;
    this.currentOptions.onClose?.();
    this.hide();
  }

  isVisible() {
    return this.root.classList.contains("dialog-layer--visible");
  }

  destroy() {
    this.hide();
    this.backdrop.removeEventListener("click", this.handleBackdropClick);
    this.closeButton.removeEventListener("click", this.handleCloseClick);
    if (this.root.parentElement) {
      this.root.parentElement.removeChild(this.root);
    }
  }
}
