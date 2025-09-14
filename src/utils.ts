
export class Input {
  private keysDown = new Set<string>();
  private keysPressed = new Set<string>();

  mouseX = 0;
  mouseY = 0;
  mouseDown = false;
  mouseJustPressed = false;
  mouseJustReleased = false;

  attach(canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", (e) => {
      if (!this.keysDown.has(e.code)) {
        this.keysPressed.add(e.code);
      }
      this.keysDown.add(e.code);
      // Prevent default behaviors that can steal focus or scroll the page
      if (
        [
          "Space",
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Tab",
        ].includes(e.code)
      ) {
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => {
      this.keysDown.delete(e.code);
    });
    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      this.mouseX = (e.clientX - rect.left) * (canvas.width / rect.width);
      this.mouseY = (e.clientY - rect.top) * (canvas.height / rect.height);
    });
    canvas.addEventListener("mousedown", (e) => {
      this.mouseDown = true;
      this.mouseJustPressed = true;
      // Ensure canvas keeps focus for keyboard controls
      canvas.focus();
      e.preventDefault();
    });
    // Also ensure focus on touch
    canvas.addEventListener("touchstart", () => {
      canvas.focus();
    });
    window.addEventListener("mouseup", () => {
      this.mouseDown = false;
      this.mouseJustReleased = true;
    });
    canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
    });
    window.addEventListener("blur", () => {
      this.keysDown.clear();
      this.mouseDown = false;
    });
  }

  update() {
    this.mouseJustPressed = false;
    this.mouseJustReleased = false;
    this.keysPressed.clear();
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