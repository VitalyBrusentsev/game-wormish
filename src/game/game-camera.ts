import { clamp } from "../definitions";

export type CameraBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

export type WorldPoint = {
  x: number;
  y: number;
};

export type GameCameraOptions = {
  viewportWidth: number;
  viewportHeight: number;
  worldWidth: number;
  worldHeight: number;
  padding?: number;
  random?: () => number;
};

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2;
const DEFAULT_PADDING = 48;
const EDGE_SCROLL_MAX_SPEED = 520;
const CAMERA_STIFFNESS = 18;
const CAMERA_DAMPING = 10;

export class GameCamera {
  readonly padding: number;

  x = 0;
  y = 0;
  targetX = 0;
  targetY = 0;
  velocityX = 0;
  velocityY = 0;
  offsetX = 0;
  offsetY = 0;
  zoom = 1;

  private viewportWidth: number;
  private viewportHeight: number;
  private worldWidth: number;
  private worldHeight: number;
  private shakeTime = 0;
  private shakeDuration = 0;
  private shakeMagnitude = 0;
  private readonly random: () => number;

  constructor(options: GameCameraOptions) {
    this.viewportWidth = options.viewportWidth;
    this.viewportHeight = options.viewportHeight;
    this.worldWidth = options.worldWidth;
    this.worldHeight = options.worldHeight;
    this.padding = options.padding ?? DEFAULT_PADDING;
    this.random = options.random ?? Math.random;
  }

  setViewportSize(width: number, height: number) {
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.clampPositionAndTarget();
  }

  setWorldSize(width: number, height: number) {
    this.worldWidth = width;
    this.worldHeight = height;
    this.clampPositionAndTarget();
  }

  getWorldViewportSize() {
    return {
      width: this.viewportWidth / this.zoom,
      height: this.viewportHeight / this.zoom,
    };
  }

  getBounds(): CameraBounds {
    const worldViewport = this.getWorldViewportSize();
    const maxX = Math.max(0, this.worldWidth - worldViewport.width);
    const maxY = Math.max(0, this.worldHeight - worldViewport.height);
    const minY = Math.min(0, this.worldHeight - worldViewport.height);
    return { minX: 0, maxX, minY, maxY };
  }

  clampX(x: number) {
    const { minX, maxX } = this.getBounds();
    return clamp(x, minX, maxX);
  }

  clampY(y: number) {
    const { minY, maxY } = this.getBounds();
    return clamp(y, minY, maxY);
  }

  centerOn(point: WorldPoint) {
    const worldViewport = this.getWorldViewportSize();
    this.x = this.clampX(point.x - worldViewport.width / 2);
    this.y = this.clampY(point.y - worldViewport.height / 2);
    this.targetX = this.x;
    this.targetY = this.y;
    this.velocityX = 0;
    this.velocityY = 0;
  }

  resizeKeepingCenter(width: number, height: number, yFocus: number, centerX?: number) {
    const worldViewport = this.getWorldViewportSize();
    const nextCenterX = centerX ?? this.x + worldViewport.width / 2;
    this.viewportWidth = width;
    this.viewportHeight = height;
    const nextViewport = this.getWorldViewportSize();
    this.x = this.clampX(nextCenterX - nextViewport.width / 2);
    this.targetX = this.x;
    this.y = this.clampY(yFocus - nextViewport.height / 2);
    this.targetY = this.y;
    this.velocityX = 0;
    this.velocityY = 0;
  }

  setZoom(nextZoomRaw: number) {
    const nextZoom = clamp(nextZoomRaw, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(nextZoom - this.zoom) < 1e-6) return;

    const prevViewport = this.getWorldViewportSize();
    const cameraCenterX = this.x + prevViewport.width / 2;
    const cameraCenterY = this.y + prevViewport.height / 2;
    const targetCenterX = this.targetX + prevViewport.width / 2;
    const targetCenterY = this.targetY + prevViewport.height / 2;

    this.zoom = nextZoom;
    const nextViewport = this.getWorldViewportSize();
    this.x = this.clampX(cameraCenterX - nextViewport.width / 2);
    this.y = this.clampY(cameraCenterY - nextViewport.height / 2);
    this.targetX = this.clampX(targetCenterX - nextViewport.width / 2);
    this.targetY = this.clampY(targetCenterY - nextViewport.height / 2);
    this.velocityX = 0;
    this.velocityY = 0;
  }

  screenToWorld(screenX: number, screenY: number): WorldPoint {
    return {
      x: (screenX - this.offsetX) / this.zoom + this.x,
      y: (screenY - this.offsetY) / this.zoom + this.y,
    };
  }

  worldToScreen(worldX: number, worldY: number): WorldPoint {
    return {
      x: (worldX - this.x) * this.zoom + this.offsetX,
      y: (worldY - this.y) * this.zoom + this.offsetY,
    };
  }

  panByScreenDelta(deltaScreenX: number, deltaScreenY: number) {
    this.targetX = this.clampX(this.targetX - deltaScreenX / this.zoom);
    this.targetY = this.clampY(this.targetY - deltaScreenY / this.zoom);
  }

  getMargin() {
    const viewWidth = this.getWorldViewportSize().width;
    const base = Math.min(240, Math.max(120, viewWidth * 0.2));
    return Math.min(base, viewWidth * 0.45);
  }

  focusOnPoint(point: WorldPoint) {
    const worldViewport = this.getWorldViewportSize();
    const margin = this.getMargin();
    const leftEdge = this.x + margin;
    const rightEdge = this.x + worldViewport.width - margin;
    const topEdge = this.y + margin;
    const bottomEdge = this.y + worldViewport.height - margin;
    let nextTargetX = this.targetX;
    let nextTargetY = this.targetY;

    if (point.x < leftEdge) {
      nextTargetX = point.x - margin;
    } else if (point.x > rightEdge) {
      nextTargetX = point.x - (worldViewport.width - margin);
    }

    if (point.y < topEdge) {
      nextTargetY = point.y - margin;
    } else if (point.y > bottomEdge) {
      nextTargetY = point.y - (worldViewport.height - margin);
    }

    this.targetX = this.clampX(nextTargetX);
    this.targetY = this.clampY(nextTargetY);
  }

  focusCenterOn(point: WorldPoint) {
    const worldViewport = this.getWorldViewportSize();
    this.targetX = this.clampX(point.x - worldViewport.width / 2);
    this.targetY = this.clampY(point.y - worldViewport.height / 2);
  }

  update(dt: number, edgeScroll?: { enabled: boolean; mouseInside: boolean; mouseX: number }) {
    let nextTargetX = this.targetX;
    let nextTargetY = this.targetY;

    if (edgeScroll?.enabled) {
      const edgeDelta = this.getEdgeScrollDelta(dt, edgeScroll.mouseInside, edgeScroll.mouseX);
      if (edgeDelta !== 0) nextTargetX += edgeDelta;
    }

    this.targetX = this.clampX(nextTargetX);
    this.targetY = this.clampY(nextTargetY);

    const deltaX = this.targetX - this.x;
    const deltaY = this.targetY - this.y;
    this.velocityX += deltaX * CAMERA_STIFFNESS * dt;
    this.velocityY += deltaY * CAMERA_STIFFNESS * dt;
    const decay = Math.exp(-CAMERA_DAMPING * dt);
    this.velocityX *= decay;
    this.velocityY *= decay;
    this.x += this.velocityX * dt;
    this.y += this.velocityY * dt;

    const clampedX = this.clampX(this.x);
    const clampedY = this.clampY(this.y);
    if (clampedX !== this.x) {
      this.x = clampedX;
      this.velocityX = 0;
    }
    if (clampedY !== this.y) {
      this.y = clampedY;
      this.velocityY = 0;
    }
  }

  resetShake() {
    this.shakeTime = 0;
    this.shakeDuration = 0;
    this.shakeMagnitude = 0;
    this.offsetX = 0;
    this.offsetY = 0;
  }

  triggerShake(magnitude: number, duration = 0.4) {
    const clamped = Math.min(Math.abs(magnitude), this.padding * 0.9);
    this.shakeMagnitude = Math.max(this.shakeMagnitude, clamped);
    this.shakeDuration = Math.max(this.shakeDuration, duration);
    this.shakeTime = Math.max(this.shakeTime, duration);
  }

  updateShake(dt: number) {
    if (this.shakeTime <= 0) {
      this.resetShake();
      return;
    }

    this.shakeTime = Math.max(0, this.shakeTime - dt);
    const denom = this.shakeDuration > 0 ? this.shakeDuration : 1;
    const progress = this.shakeTime / denom;
    const magnitude = this.shakeMagnitude * progress * progress;
    const angle = this.random() * Math.PI * 2;
    this.offsetX = Math.cos(angle) * magnitude;
    this.offsetY = Math.sin(angle) * magnitude;
  }

  getDriverCamera() {
    return {
      offsetX: this.offsetX - this.x * this.zoom,
      offsetY: this.offsetY - this.y * this.zoom,
      zoom: this.zoom,
    };
  }

  private getEdgeScrollDelta(dt: number, mouseInside: boolean, mouseX: number) {
    if (!mouseInside) return 0;
    const threshold = Math.min(160, Math.max(80, this.viewportWidth * 0.15));
    if (threshold <= 0) return 0;
    const bounds = this.getBounds();
    if (mouseX <= threshold && this.x > bounds.minX + 0.5) {
      const t = (threshold - mouseX) / threshold;
      return -EDGE_SCROLL_MAX_SPEED * t * dt;
    }
    if (mouseX >= this.viewportWidth - threshold && this.x < bounds.maxX - 0.5) {
      const t = (mouseX - (this.viewportWidth - threshold)) / threshold;
      return EDGE_SCROLL_MAX_SPEED * t * dt;
    }
    return 0;
  }

  private clampPositionAndTarget() {
    this.x = this.clampX(this.x);
    this.y = this.clampY(this.y);
    this.targetX = this.clampX(this.targetX);
    this.targetY = this.clampY(this.targetY);
  }
}
