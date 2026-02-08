import { nowMs } from "../definitions";
import { WeaponType } from "../definitions";
import { drawWeaponSprite } from "../weapons/weapon-sprites";
import { type CloseReason, CommandDialog } from "./dialog";

type HelpWeapon = "bazooka" | "grenade" | "rifle" | "uzi";

type WeaponCanvasBinding = {
  weapon: HelpWeapon;
  canvas: HTMLCanvasElement;
  phase: number;
  smokeOffset: number;
};

export type HelpOverlayCallbacks = {
  onClose?: (pausedMs: number, reason: CloseReason) => void;
};

export class HelpOverlay {
  private readonly dialog: CommandDialog;
  private readonly callbacks: HelpOverlayCallbacks;
  private openedAtMs: number | null = null;
  private lastPausedMs = 0;
  private animationFrameId: number | null = null;
  private animationStartedAtMs = 0;
  private weaponCanvases: WeaponCanvasBinding[] = [];
  private crosshairCanvas: HTMLCanvasElement | null = null;
  private windCanvas: HTMLCanvasElement | null = null;

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
      closeable: true,
      zIndex: 28,
      onClose: (reason) => this.handleClose(reason),
      content: this.buildContent(),
    });
    this.startAnimations();

    return true;
  }

  hide(reason: CloseReason = "manual"): number {
    if (!this.dialog.isVisible()) return 0;
    this.dialog.requestClose(reason);
    return this.lastPausedMs;
  }

  dispose() {
    this.stopAnimations();
    this.dialog.destroy();
  }

  isVisible() {
    return this.dialog.isVisible();
  }

  private handleClose(reason: CloseReason) {
    this.stopAnimations();
    const now = nowMs();
    const pausedFor = this.openedAtMs ? Math.max(0, now - this.openedAtMs) : 0;
    this.lastPausedMs = pausedFor;
    this.openedAtMs = null;
    this.weaponCanvases = [];
    this.crosshairCanvas = null;
    this.windCanvas = null;
    this.callbacks.onClose?.(pausedFor, reason);
  }

  private buildContent() {
    this.weaponCanvases = [];
    this.crosshairCanvas = null;
    this.windCanvas = null;

    const container = document.createElement("div");
    container.className = "help-dialog";

    const list = document.createElement("ul");
    list.className = "help-topics";

    list.appendChild(this.buildMoveTile());
    list.appendChild(this.buildAimTile());
    list.appendChild(this.buildSwapToysTile());
    list.appendChild(this.buildWindTile());

    container.appendChild(list);
    return container;
  }

  private buildMoveTile(): HTMLLIElement {
    const item = this.buildTileShell("Move", true);

    const moveRow = document.createElement("div");
    moveRow.className = "help-move-line";
    moveRow.append(
      this.createKeycap("A"),
      this.createKeycap("D"),
      this.createKeycap("←"),
      this.createKeycap("→"),
      this.createText("move left / right", "help-line-text")
    );

    const jumpRow = document.createElement("div");
    jumpRow.className = "help-move-line";
    jumpRow.append(this.createKeycap("W"), this.createKeycap("Space", true), this.createText("jump", "help-line-text"));

    item.append(moveRow, jumpRow);
    return item;
  }

  private buildAimTile(): HTMLLIElement {
    const item = this.buildTileShell("Aim, Charge and Fire", true);

    const row = document.createElement("div");
    row.className = "help-aim-row";

    const crosshairCanvas = document.createElement("canvas");
    crosshairCanvas.className = "help-crosshair-canvas";
    crosshairCanvas.width = 64;
    crosshairCanvas.height = 64;
    this.crosshairCanvas = crosshairCanvas;

    const copy = document.createElement("div");
    copy.className = "help-aim-copy";
    const line1 = this.createText("Aim at your enemies", "help-line-text");
    const line2 = this.createText("Press the mouse button to charge, release when ready", "help-line-text");
    copy.append(line1, line2);

    row.append(crosshairCanvas, copy);
    item.appendChild(row);
    return item;
  }

  private buildSwapToysTile(): HTMLLIElement {
    const item = this.buildTileShell("Swap Toys", false, true);

    const grid = document.createElement("div");
    grid.className = "help-weapon-grid";

    grid.append(
      this.buildWeaponCell("1", "bazooka", 0),
      this.buildWeaponCell("2", "grenade", 1),
      this.buildWeaponCell("3", "rifle", 2),
      this.buildWeaponCell("4", "uzi", 3)
    );

    item.appendChild(grid);
    return item;
  }

  private buildWindTile(): HTMLLIElement {
    const item = this.buildTileShell("Wind Watch", true);

    const row = document.createElement("div");
    row.className = "help-wind-row";

    const windCanvas = document.createElement("canvas");
    windCanvas.className = "help-windsock-canvas";
    windCanvas.width = 136;
    windCanvas.height = 82;
    this.windCanvas = windCanvas;

    row.append(windCanvas, this.createText("Mind the gusts! It's windy out there", "help-line-text"));
    item.appendChild(row);
    return item;
  }

  private buildTileShell(titleText: string, centered = false, titleCentered = false): HTMLLIElement {
    const item = document.createElement("li");
    item.className = "help-topics__item";
    if (centered) item.classList.add("help-topics__item--centered");
    if (titleCentered) item.classList.add("help-topics__item--title-centered");

    const title = document.createElement("h3");
    title.className = "help-topics__title";
    title.textContent = titleText;
    item.appendChild(title);

    return item;
  }

  private createKeycap(label: string, wide = false): HTMLElement {
    const cap = document.createElement("span");
    cap.className = wide ? "help-keycap help-keycap--wide" : "help-keycap";
    cap.textContent = label;
    return cap;
  }

  private createText(text: string, className: string): HTMLParagraphElement {
    const p = document.createElement("p");
    p.className = className;
    p.textContent = text;
    return p;
  }

  private buildWeaponCell(
    shortcut: "1" | "2" | "3" | "4",
    weapon: HelpWeapon,
    index: number
  ): HTMLElement {
    const cell = document.createElement("div");
    cell.className = "help-weapon-cell";

    const key = document.createElement("span");
    key.className = "help-weapon-shortcut";
    key.textContent = `${shortcut} -`;

    const canvas = document.createElement("canvas");
    canvas.className = "help-weapon-canvas";
    canvas.width = 90;
    canvas.height = 56;
    canvas.setAttribute("aria-label", `${weapon} icon`);
    this.weaponCanvases.push({
      weapon,
      canvas,
      phase: index * 0.6,
      smokeOffset: index * 0.17,
    });

    cell.append(key, canvas);
    return cell;
  }

  private startAnimations() {
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return;
    this.stopAnimations();
    this.animationStartedAtMs = nowMs();

    const tick = () => {
      this.drawAnimatedTiles();
      this.animationFrameId = window.requestAnimationFrame(tick);
    };

    this.drawAnimatedTiles();
    this.animationFrameId = window.requestAnimationFrame(tick);
  }

  private stopAnimations() {
    if (this.animationFrameId !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.animationFrameId);
    }
    this.animationFrameId = null;
  }

  private drawAnimatedTiles() {
    const elapsed = (nowMs() - this.animationStartedAtMs) * 0.001;
    for (const binding of this.weaponCanvases) {
      this.drawWeaponCanvas(binding, elapsed);
    }
    if (this.crosshairCanvas) this.drawCrosshair(this.crosshairCanvas, elapsed);
    if (this.windCanvas) this.drawWindsock(this.windCanvas, elapsed);
  }

  private drawWeaponCanvas(binding: WeaponCanvasBinding, elapsed: number) {
    const ctx = binding.canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = binding.canvas;
    ctx.clearRect(0, 0, width, height);

    const centerX = width * 0.52;
    const centerY = height * 0.56;
    const sway = Math.sin(elapsed * 1.6 + binding.phase) * 0.08;
    const aimAngle = -0.32 + sway;

    ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
    ctx.beginPath();
    ctx.ellipse(centerX + 2, height - 9, 20, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    const weaponType = this.toSpriteWeapon(binding.weapon);
    if (weaponType) {
      const rendered = drawWeaponSprite({
        ctx,
        weapon: weaponType,
        rotationPoint: { x: centerX, y: centerY },
        aimAngle,
      });
      if (rendered) return;
    }

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(binding.weapon === "grenade" ? sway : aimAngle);
    if (binding.weapon === "bazooka") this.drawBazookaShape(ctx);
    else if (binding.weapon === "grenade") {
      this.drawGrenadeShape(ctx);
      this.drawGrenadeSmoke(ctx, elapsed, binding.smokeOffset);
    } else if (binding.weapon === "rifle") this.drawRifleShape(ctx);
    else this.drawUziShape(ctx);

    ctx.restore();
  }

  private toSpriteWeapon(weapon: HelpWeapon): WeaponType | null {
    switch (weapon) {
      case "bazooka":
        return WeaponType.Bazooka;
      case "rifle":
        return WeaponType.Rifle;
      case "uzi":
        return WeaponType.Uzi;
      case "grenade":
      default:
        return null;
    }
  }

  private drawBazookaShape(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = "#5d6f89";
    ctx.fillRect(-24, -5, 44, 10);
    ctx.fillStyle = "#8ea4c2";
    ctx.fillRect(-10, -6, 18, 12);
    ctx.fillStyle = "#c7d5e8";
    ctx.fillRect(20, -4, 10, 8);
    ctx.fillStyle = "#314156";
    ctx.fillRect(-8, 5, 8, 7);
  }

  private drawRifleShape(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = "#4e5c76";
    ctx.fillRect(-26, -3, 50, 6);
    ctx.fillStyle = "#94a9c6";
    ctx.fillRect(-7, -5, 18, 10);
    ctx.fillStyle = "#314156";
    ctx.fillRect(-14, 3, 7, 10);
    ctx.fillStyle = "#1b2232";
    ctx.fillRect(24, -2, 6, 4);
  }

  private drawUziShape(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = "#5f6a80";
    ctx.fillRect(-20, -4, 36, 8);
    ctx.fillStyle = "#9fb2ca";
    ctx.fillRect(-6, -5, 14, 10);
    ctx.fillStyle = "#2c3648";
    ctx.fillRect(-4, 4, 8, 10);
    ctx.fillStyle = "#1a1f2e";
    ctx.fillRect(16, -2, 6, 4);
  }

  private drawGrenadeShape(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = "#2b2b2b";
    ctx.beginPath();
    ctx.arc(0, 0, 9.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#0a0a0a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 9.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(-2.5, -2.5, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private drawGrenadeSmoke(ctx: CanvasRenderingContext2D, elapsed: number, smokeOffset: number) {
    for (let i = 0; i < 4; i += 1) {
      const trail = (elapsed * 0.35 + smokeOffset + i * 0.19) % 1;
      const x = Math.sin(elapsed * 2.1 + i * 0.8) * (1.2 + i * 0.3);
      const y = -15 - trail * 18;
      const radius = 1.8 + trail * 2.1;
      ctx.globalAlpha = (1 - trail) * 0.24;
      ctx.fillStyle = "#d7dde8";
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawCrosshair(canvas: HTMLCanvasElement, elapsed: number) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = canvas;
    const cx = width / 2;
    const cy = height / 2;
    const pulse = Math.sin(elapsed * 2.2) * 1.2;

    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(224, 236, 255, 0.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 16 + pulse, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = "rgba(168, 210, 255, 0.8)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 24, cy);
    ctx.lineTo(cx - 10, cy);
    ctx.moveTo(cx + 10, cy);
    ctx.lineTo(cx + 24, cy);
    ctx.moveTo(cx, cy - 24);
    ctx.lineTo(cx, cy - 10);
    ctx.moveTo(cx, cy + 10);
    ctx.lineTo(cx, cy + 24);
    ctx.stroke();

    ctx.fillStyle = "rgba(226, 244, 255, 0.95)";
    ctx.beginPath();
    ctx.arc(cx, cy, 2.1, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawWindsock(canvas: HTMLCanvasElement, elapsed: number) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    const poleX = 18;
    ctx.strokeStyle = "#7f8fab";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(poleX, 8);
    ctx.lineTo(poleX, height - 8);
    ctx.stroke();

    const scale = 1 + Math.sin(elapsed * 0.9) * 0.08;
    const sway = Math.sin(elapsed * 0.6) * 0.05;
    const length = 74 * scale;
    const mouth = 11 * scale;
    const segments = 5;
    const segmentLen = length / segments;

    ctx.save();
    ctx.translate(poleX + 2, height * 0.42);
    ctx.rotate(sway);

    ctx.strokeStyle = "#8ea4c2";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, mouth, 0, Math.PI * 2);
    ctx.stroke();

    for (let i = 0; i < segments; i += 1) {
      const x0 = i * segmentLen;
      const x1 = x0 + segmentLen;
      const t0 = i / segments;
      const t1 = (i + 1) / segments;
      const w0 = mouth * (1 - t0 * 0.72);
      const w1 = mouth * (1 - t1 * 0.72);
      const wave0 = Math.sin(elapsed * 2 + i * 0.6) * 1.3;
      const wave1 = Math.sin(elapsed * 2 + (i + 1) * 0.6) * 1.3;
      ctx.fillStyle = i % 2 === 0 ? "#d54f45" : "#ecf2ff";
      ctx.beginPath();
      ctx.moveTo(x0, -w0 + wave0);
      ctx.lineTo(x1, -w1 + wave1);
      ctx.lineTo(x1, w1 + wave1);
      ctx.lineTo(x0, w0 + wave0);
      ctx.closePath();
      ctx.fill();
    }

    ctx.strokeStyle = "rgba(38, 50, 72, 0.65)";
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (let i = 0; i <= segments; i += 1) {
      const x = i * segmentLen;
      const t = i / segments;
      const w = mouth * (1 - t * 0.72);
      const wave = Math.sin(elapsed * 2 + i * 0.6) * 1.3;
      if (i === 0) ctx.moveTo(x, -w + wave);
      else ctx.lineTo(x, -w + wave);
    }
    for (let i = segments; i >= 0; i -= 1) {
      const x = i * segmentLen;
      const t = i / segments;
      const w = mouth * (1 - t * 0.72);
      const wave = Math.sin(elapsed * 2 + i * 0.6) * 1.3;
      ctx.lineTo(x, w + wave);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
}
