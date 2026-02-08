
export class Input {
  private keysDown = new Set<string>();
  private keysPressed = new Set<string>();

  private canvas: HTMLCanvasElement | null = null;

  mouseX = 0;
  mouseY = 0;
  mouseDown = false;
  mouseJustPressed = false;
  mouseJustReleased = false;
  mouseInside = false;

  private readonly keyDownHandler = (e: KeyboardEvent) => {
    if (!this.keysDown.has(e.code)) {
      this.keysPressed.add(e.code);
    }
    this.keysDown.add(e.code);
    if (
      [
        "Space",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Tab",
        "F1",
      ].includes(e.code)
    ) {
      e.preventDefault();
    }
  };

  private readonly keyUpHandler = (e: KeyboardEvent) => {
    this.keysDown.delete(e.code);
  };

  private readonly mouseMoveHandler = (e: MouseEvent) => {
    const canvas = this.canvas;
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      this.mouseX = (e.clientX - rect.left) * (canvas.width / rect.width);
      this.mouseY = (e.clientY - rect.top) * (canvas.height / rect.height);
      this.mouseInside = true;
    }
  };

  private readonly mouseEnterHandler = () => {
    this.mouseInside = true;
  };

  private readonly mouseLeaveHandler = () => {
    this.mouseInside = false;
  };

  private readonly mouseDownHandler = (e: MouseEvent) => {
    this.mouseDown = true;
    this.mouseJustPressed = true;
    this.canvas?.focus();
    e.preventDefault();
  };

  private readonly touchStartHandler = () => {
    this.canvas?.focus();
  };

  private readonly mouseUpHandler = () => {
    this.mouseDown = false;
    this.mouseJustReleased = true;
  };

  private readonly contextMenuHandler = (e: MouseEvent) => {
    e.preventDefault();
  };

  private readonly blurHandler = () => {
    this.keysDown.clear();
    this.mouseDown = false;
    this.mouseInside = false;
  };

  attach(canvas: HTMLCanvasElement) {
    if (this.canvas) {
      this.detach();
    }
    this.canvas = canvas;
    window.addEventListener("keydown", this.keyDownHandler);
    window.addEventListener("keyup", this.keyUpHandler);
    window.addEventListener("mouseup", this.mouseUpHandler);
    window.addEventListener("blur", this.blurHandler);
    canvas.addEventListener("mousemove", this.mouseMoveHandler);
    canvas.addEventListener("mouseenter", this.mouseEnterHandler);
    canvas.addEventListener("mouseleave", this.mouseLeaveHandler);
    canvas.addEventListener("mousedown", this.mouseDownHandler);
    canvas.addEventListener("touchstart", this.touchStartHandler);
    canvas.addEventListener("contextmenu", this.contextMenuHandler);
  }

  detach() {
    const canvas = this.canvas;
    window.removeEventListener("keydown", this.keyDownHandler);
    window.removeEventListener("keyup", this.keyUpHandler);
    window.removeEventListener("mouseup", this.mouseUpHandler);
    window.removeEventListener("blur", this.blurHandler);
    if (canvas) {
      canvas.removeEventListener("mousemove", this.mouseMoveHandler);
      canvas.removeEventListener("mouseenter", this.mouseEnterHandler);
      canvas.removeEventListener("mouseleave", this.mouseLeaveHandler);
      canvas.removeEventListener("mousedown", this.mouseDownHandler);
      canvas.removeEventListener("touchstart", this.touchStartHandler);
      canvas.removeEventListener("contextmenu", this.contextMenuHandler);
    }
    this.canvas = null;
    this.keysDown.clear();
    this.keysPressed.clear();
    this.mouseDown = false;
    this.mouseJustPressed = false;
    this.mouseJustReleased = false;
    this.mouseInside = false;
  }

  update() {
    this.mouseJustPressed = false;
    this.mouseJustReleased = false;
    this.keysPressed.clear();
  }

  consumeMousePress() {
    this.mouseJustPressed = false;
    this.mouseJustReleased = false;
  }

  consumeKey(code: string) {
    this.keysPressed.delete(code);
    this.keysDown.delete(code);
  }

  isDown(code: string) {
    return this.keysDown.has(code);
  }
  pressed(code: string) {
    return this.keysPressed.has(code);
  }
}

export function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function drawCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number
) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.closePath();
}

export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  size = 16,
  align: CanvasTextAlign = "left",
  baseline: CanvasTextBaseline = "top",
  shadow = true
) {
  ctx.font = `bold ${size}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (shadow) {
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillText(text, x + 2, y + 2);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

export function drawArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angleRad: number,
  length: number,
  color: string,
  width = 4
) {
  const headLen = Math.max(8, Math.min(16, length * 0.2));
  const x2 = x + Math.cos(angleRad) * length;
  const y2 = y + Math.sin(angleRad) * length;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.translate(x2, y2);
  ctx.rotate(angleRad);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-headLen, headLen * 0.6);
  ctx.lineTo(-headLen, -headLen * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function drawWindsock(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dir: -1 | 1,
  length: number,
  intensity01: number,
  color: string
) {
  const clothLen = Math.max(0, length);
  if (clothLen <= 0) return;
  const stripeWhite = "#ecf2ff";

  const stripes = 3;
  const baseW = Math.min(12, Math.max(4, clothLen * 0.9));
  const tipW = Math.max(2, baseW * 0.35);
  const wind01 = Math.max(0, Math.min(1, intensity01));
  const dirX = dir;
  const dirY = 0;
  const perpX = -dirY;
  const perpY = dirX;
  const activeStripes = Math.max(1, Math.ceil(wind01 * stripes));
  const stripeLen = clothLen / stripes;

  ctx.save();
  ctx.translate(x, y);

  if (clothLen >= 10 && stripeLen > 0) {
    for (let i = 0; i < stripes; i++) {
      const segAlpha = i < activeStripes ? 1 : 0.25;
      const t0 = stripeLen * i;
      const t1 = stripeLen * (i + 1);
      const p0 = t0 / Math.max(1, clothLen);
      const p1 = t1 / Math.max(1, clothLen);
      const w0 = baseW + (tipW - baseW) * p0;
      const w1 = baseW + (tipW - baseW) * p1;
      const c0x = dirX * t0;
      const c0y = dirY * t0;
      const c1x = dirX * t1;
      const c1y = dirY * t1;
      const p0lx = c0x + perpX * (w0 / 2);
      const p0ly = c0y + perpY * (w0 / 2);
      const p0rx = c0x - perpX * (w0 / 2);
      const p0ry = c0y - perpY * (w0 / 2);
      const p1lx = c1x + perpX * (w1 / 2);
      const p1ly = c1y + perpY * (w1 / 2);
      const p1rx = c1x - perpX * (w1 / 2);
      const p1ry = c1y - perpY * (w1 / 2);

      ctx.globalAlpha = segAlpha;
      ctx.fillStyle = i % 2 === 0 ? color : stripeWhite;
      ctx.beginPath();
      ctx.moveTo(p0lx, p0ly);
      ctx.lineTo(p1lx, p1ly);
      ctx.lineTo(p1rx, p1ry);
      ctx.lineTo(p0rx, p0ry);
      ctx.closePath();
      ctx.fill();
    }
  } else {
    const t0 = 0;
    const t1 = clothLen;
    const c0x = dirX * t0;
    const c0y = dirY * t0;
    const c1x = dirX * t1;
    const c1y = dirY * t1;
    const p0lx = c0x + perpX * (baseW / 2);
    const p0ly = c0y + perpY * (baseW / 2);
    const p0rx = c0x - perpX * (baseW / 2);
    const p0ry = c0y - perpY * (baseW / 2);
    const p1lx = c1x + perpX * (tipW / 2);
    const p1ly = c1y + perpY * (tipW / 2);
    const p1rx = c1x - perpX * (tipW / 2);
    const p1ry = c1y - perpY * (tipW / 2);

    ctx.globalAlpha = 0.25 + 0.75 * wind01;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(p0lx, p0ly);
    ctx.lineTo(p1lx, p1ly);
    ctx.lineTo(p1rx, p1ry);
    ctx.lineTo(p0rx, p0ry);
    ctx.closePath();
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.lineWidth = 1;
  const tBase = 0;
  const tTip = clothLen;
  const wBase = baseW;
  const wTip = tipW;
  const baseCx = dirX * tBase;
  const baseCy = dirY * tBase;
  const tipCx = dirX * tTip;
  const tipCy = dirY * tTip;
  const baseLx = baseCx + perpX * (wBase / 2);
  const baseLy = baseCy + perpY * (wBase / 2);
  const baseRx = baseCx - perpX * (wBase / 2);
  const baseRy = baseCy - perpY * (wBase / 2);
  const tipLx = tipCx + perpX * (wTip / 2);
  const tipLy = tipCy + perpY * (wTip / 2);
  const tipRx = tipCx - perpX * (wTip / 2);
  const tipRy = tipCy - perpY * (wTip / 2);
  ctx.beginPath();
  ctx.moveTo(baseLx, baseLy);
  ctx.lineTo(tipLx, tipLy);
  ctx.lineTo(tipRx, tipRy);
  ctx.lineTo(baseRx, baseRy);
  ctx.closePath();
  ctx.stroke();

  ctx.restore();
}



export function drawAimDots(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number; alpha: number }[],
  color: string
) {
  ctx.save();
  for (const p of pts) {
    ctx.globalAlpha = p.alpha;
    drawCircle(ctx, p.x, p.y, 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.restore();
}

export function drawHealthBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  t: number,
  colorFg: string,
  colorBg: string
) {
  drawRoundedRect(ctx, x - w / 2, y, w, h, h / 2);
  ctx.fillStyle = colorBg;
  ctx.fill();
  drawRoundedRect(ctx, x - w / 2, y, w * t, h, h / 2);
  ctx.fillStyle = colorFg;
  ctx.fill();
}


// Simple crosshair drawing
export function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  lineWidth = 2
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.moveTo(x - size, y);
  ctx.lineTo(x + size, y);
  ctx.moveTo(x, y - size);
  ctx.lineTo(x, y + size);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x, y, size * 0.4, 0, Math.PI * 2);
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}
