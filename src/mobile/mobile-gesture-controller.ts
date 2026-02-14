type WorldPoint = { x: number; y: number };

export type MobileGestureCallbacks = {
  isEnabled: () => boolean;
  canStartAimGesture: (canvasX: number, canvasY: number) => boolean;
  screenToWorld: (screenX: number, screenY: number) => WorldPoint;
  canStartWormInteraction: (worldX: number, worldY: number) => boolean;
  onTap: (worldX: number, worldY: number) => void;
  onPan: (deltaScreenX: number, deltaScreenY: number) => void;
  onMovementDragStart: (worldX: number, worldY: number) => void;
  onMovementDrag: (worldX: number, worldY: number) => void;
  onMovementDragEnd: (worldX: number, worldY: number) => void;
  onAimGesture: (worldX: number, worldY: number) => void;
};

type PointerMode = "none" | "pan" | "worm-pending" | "move-drag" | "aim";

const DRAG_START_THRESHOLD_PX = 10;
const TAP_DISTANCE_THRESHOLD_PX = 8;
const TAP_TIME_THRESHOLD_MS = 280;

export class MobileGestureController {
  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: MobileGestureCallbacks;
  private activePointerId: number | null = null;
  private mode: PointerMode = "none";
  private downAtMs = 0;
  private startX = 0;
  private startY = 0;
  private lastCanvasX = 0;
  private lastCanvasY = 0;
  private startWorldX = 0;
  private startWorldY = 0;

  private readonly handlePointerDown = (event: PointerEvent) => {
    if (!this.callbacks.isEnabled()) return;
    if (this.activePointerId !== null) return;
    if (!event.isPrimary) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;

    this.activePointerId = event.pointerId;
    this.downAtMs = performance.now();
    this.startX = event.clientX;
    this.startY = event.clientY;
    const startCanvas = this.toCanvasPoint(event.clientX, event.clientY);
    this.lastCanvasX = startCanvas.x;
    this.lastCanvasY = startCanvas.y;
    const startWorld = this.callbacks.screenToWorld(startCanvas.x, startCanvas.y);
    this.startWorldX = startWorld.x;
    this.startWorldY = startWorld.y;

    if (this.callbacks.canStartAimGesture(startCanvas.x, startCanvas.y)) {
      this.mode = "aim";
      this.callbacks.onAimGesture(startWorld.x, startWorld.y);
    } else if (this.callbacks.canStartWormInteraction(startWorld.x, startWorld.y)) {
      this.mode = "worm-pending";
    } else {
      this.mode = "pan";
    }

    this.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  private readonly handlePointerMove = (event: PointerEvent) => {
    if (!this.callbacks.isEnabled()) return;
    if (event.pointerId !== this.activePointerId) return;

    const canvasPoint = this.toCanvasPoint(event.clientX, event.clientY);
    const dx = canvasPoint.x - this.lastCanvasX;
    const dy = canvasPoint.y - this.lastCanvasY;
    this.lastCanvasX = canvasPoint.x;
    this.lastCanvasY = canvasPoint.y;
    const world = this.callbacks.screenToWorld(canvasPoint.x, canvasPoint.y);

    if (this.mode === "aim") {
      this.callbacks.onAimGesture(world.x, world.y);
      event.preventDefault();
      return;
    }

    if (this.mode === "worm-pending") {
      const moveDist = Math.hypot(event.clientX - this.startX, event.clientY - this.startY);
      if (moveDist >= DRAG_START_THRESHOLD_PX) {
        this.mode = "move-drag";
        this.callbacks.onMovementDragStart(this.startWorldX, this.startWorldY);
        this.callbacks.onMovementDrag(world.x, world.y);
      }
      event.preventDefault();
      return;
    }

    if (this.mode === "move-drag") {
      this.callbacks.onMovementDrag(world.x, world.y);
      event.preventDefault();
      return;
    }

    if (this.mode === "pan") {
      this.callbacks.onPan(dx, dy);
      event.preventDefault();
    }
  };

  private readonly handlePointerUp = (event: PointerEvent) => {
    if (!this.callbacks.isEnabled()) return;
    if (event.pointerId !== this.activePointerId) return;
    const canvasPoint = this.toCanvasPoint(event.clientX, event.clientY);
    const world = this.callbacks.screenToWorld(canvasPoint.x, canvasPoint.y);
    const moveDist = Math.hypot(event.clientX - this.startX, event.clientY - this.startY);
    const elapsedMs = performance.now() - this.downAtMs;

    if (this.mode === "move-drag") {
      this.callbacks.onMovementDragEnd(world.x, world.y);
    } else if (
      (this.mode === "pan" || this.mode === "worm-pending") &&
      moveDist <= TAP_DISTANCE_THRESHOLD_PX &&
      elapsedMs <= TAP_TIME_THRESHOLD_MS
    ) {
      this.callbacks.onTap(world.x, world.y);
    }

    this.cleanupPointer(event.pointerId);
    event.preventDefault();
  };

  private readonly handlePointerCancel = (event: PointerEvent) => {
    if (event.pointerId !== this.activePointerId) return;
    if (this.mode === "move-drag") {
      this.callbacks.onMovementDragEnd(this.startWorldX, this.startWorldY);
    }
    this.cleanupPointer(event.pointerId);
  };

  constructor(canvas: HTMLCanvasElement, callbacks: MobileGestureCallbacks) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.canvas.addEventListener("pointerdown", this.handlePointerDown, { passive: false });
    this.canvas.addEventListener("pointermove", this.handlePointerMove, { passive: false });
    this.canvas.addEventListener("pointerup", this.handlePointerUp, { passive: false });
    this.canvas.addEventListener("pointercancel", this.handlePointerCancel, { passive: false });
  }

  dispose() {
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerCancel);
    if (this.activePointerId !== null) {
      this.cleanupPointer(this.activePointerId);
    }
  }

  private toCanvasPoint(clientX: number, clientY: number): WorldPoint {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return { x: clientX, y: clientY };
    }
    return {
      x: (clientX - rect.left) * (this.canvas.width / rect.width),
      y: (clientY - rect.top) * (this.canvas.height / rect.height),
    };
  }

  private cleanupPointer(pointerId: number) {
    this.mode = "none";
    this.activePointerId = null;
    if (this.canvas.hasPointerCapture(pointerId)) {
      this.canvas.releasePointerCapture(pointerId);
    }
  }
}
