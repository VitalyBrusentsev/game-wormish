import { COLORS } from "../definitions";

export type BackgroundCamera = {
  x: number;
  y: number;
  zoom: number;
};

type BackgroundLayerName =
  | "distant-light-mountains"
  | "darker-mountains"
  | "tree-line"
  | "main-ground-plane";

type BackgroundLayer = {
  name: BackgroundLayerName;
  parallaxX: number;
  parallaxY: number;
};

export const BACKGROUND_LAYERS = {
  distantLightMountains: {
    name: "distant-light-mountains",
    parallaxX: 0,
    parallaxY: 0,
  },
  darkerMountains: {
    name: "darker-mountains",
    parallaxX: 0.12,
    parallaxY: 0.04,
  },
  treeLine: {
    name: "tree-line",
    parallaxX: 0.28,
    parallaxY: 0.08,
  },
  mainGroundPlane: {
    name: "main-ground-plane",
    parallaxX: 1,
    parallaxY: 1,
  },
} as const satisfies Record<string, BackgroundLayer>;

type LayerFrame = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
};

const DEFAULT_BACKGROUND_CAMERA: BackgroundCamera = {
  x: 0,
  y: 0,
  zoom: 1,
};

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

export function getBackgroundLayerOffset(layer: BackgroundLayer, camera: BackgroundCamera) {
  return {
    x: -camera.x * camera.zoom * layer.parallaxX,
    y: -camera.y * camera.zoom * layer.parallaxY,
  };
}

function getLayerFrame(config: {
  width: number;
  height: number;
  padding: number;
  camera: BackgroundCamera;
  layer: BackgroundLayer;
}): LayerFrame {
  const { width, height, padding, camera, layer } = config;
  const baseLeft = -padding;
  const baseTop = -padding;
  const baseWidth = width + padding * 2;
  const baseHeight = height + padding * 2;
  const offset = getBackgroundLayerOffset(layer, camera);
  const repeatWidth = Math.max(320, baseWidth);
  const wrappedOffsetX = positiveModulo(offset.x, repeatWidth);
  const left = baseLeft + wrappedOffsetX - repeatWidth;
  const drawWidth = baseWidth + repeatWidth * 2;
  const top = baseTop + offset.y;

  return {
    left,
    right: left + drawWidth,
    top,
    bottom: top + baseHeight,
    width: drawWidth,
    height: baseHeight,
    offsetX: offset.x,
    offsetY: offset.y,
  };
}

function drawCloud(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  alpha: number
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "rgba(255,255,255,0.84)";
  ctx.beginPath();
  ctx.ellipse(x - 42 * scale, y + 8 * scale, 44 * scale, 24 * scale, 0, 0, Math.PI * 2);
  ctx.ellipse(x - 8 * scale, y - 6 * scale, 50 * scale, 34 * scale, 0, 0, Math.PI * 2);
  ctx.ellipse(x + 34 * scale, y + 5 * scale, 46 * scale, 27 * scale, 0, 0, Math.PI * 2);
  ctx.ellipse(x + 76 * scale, y + 12 * scale, 30 * scale, 18 * scale, 0, 0, Math.PI * 2);
  ctx.fill();

  const shade = ctx.createLinearGradient(0, y - 20 * scale, 0, y + 34 * scale);
  shade.addColorStop(0, "rgba(255,255,255,0)");
  shade.addColorStop(1, "rgba(120,170,215,0.18)");
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.ellipse(x - 14 * scale, y + 10 * scale, 94 * scale, 26 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function ridgeY(x: number, seed: number, baseY: number, amplitude: number) {
  const waveA = Math.sin(x * 0.006 + seed) * amplitude;
  const waveB = Math.sin(x * 0.013 + seed * 1.7) * amplitude * 0.48;
  const waveC = Math.sin(x * 0.025 + seed * 0.6) * amplitude * 0.22;
  return baseY + waveA + waveB + waveC;
}

function drawMountainLayer(config: {
  ctx: CanvasRenderingContext2D;
  left: number;
  bottom: number;
  width: number;
  baseY: number;
  amplitude: number;
  ridgeOffsetX: number;
  colorTop: string;
  colorBottom: string;
  alpha: number;
  seed: number;
}) {
  const {
    ctx,
    left,
    bottom,
    width,
    baseY,
    amplitude,
    ridgeOffsetX,
    colorTop,
    colorBottom,
    alpha,
    seed,
  } = config;
  const right = left + width;
  const ridgeAt = (x: number) => ridgeY(x - ridgeOffsetX, seed, baseY, amplitude);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.moveTo(left, bottom);
  ctx.lineTo(left, ridgeAt(left));
  for (let x = left; x <= right; x += 38) {
    ctx.lineTo(x, ridgeAt(x));
  }
  ctx.lineTo(right, ridgeAt(right));
  ctx.lineTo(right, bottom);
  ctx.closePath();

  const grad = ctx.createLinearGradient(0, baseY - amplitude * 1.7, 0, bottom);
  grad.addColorStop(0, colorTop);
  grad.addColorStop(1, colorBottom);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.globalAlpha = alpha * 0.35;
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = left; x <= right; x += 95) {
    const peakY = ridgeAt(x);
    ctx.moveTo(x, peakY + 8);
    ctx.lineTo(x + 34, peakY + amplitude * 0.9);
  }
  ctx.stroke();
  ctx.restore();
}

function drawTree(ctx: CanvasRenderingContext2D, x: number, baseY: number, scale: number, color: string) {
  const trunkH = 20 * scale;
  const treeH = 82 * scale;
  const treeW = 46 * scale;

  ctx.save();
  ctx.fillStyle = "rgba(58,72,50,0.42)";
  ctx.fillRect(x - 3 * scale, baseY - trunkH, 6 * scale, trunkH);
  ctx.fillStyle = color;
  for (let i = 0; i < 4; i++) {
    const y = baseY - treeH + i * 18 * scale;
    const halfW = treeW * (0.45 + i * 0.14);
    ctx.beginPath();
    ctx.moveTo(x, y - 18 * scale);
    ctx.lineTo(x + halfW, y + 34 * scale);
    ctx.lineTo(x - halfW, y + 34 * scale);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawForestLayer(
  ctx: CanvasRenderingContext2D,
  left: number,
  right: number,
  baseY: number,
  spacing: number,
  scale: number,
  color: string,
  offsetX: number
) {
  ctx.save();
  const firstTreeX = Math.floor((left - offsetX - spacing) / spacing) * spacing;
  for (let treeX = firstTreeX; treeX <= right - offsetX + spacing; treeX += spacing) {
    const jitter = Math.sin(treeX * 0.037) * spacing * 0.24;
    const heightJitter = Math.sin(treeX * 0.021 + 3.1) * 16;
    drawTree(ctx, treeX + offsetX + jitter, baseY + heightJitter, scale, color);
  }
  ctx.restore();
}

export function renderBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  padding = 0,
  drawWater = true,
  camera: BackgroundCamera = DEFAULT_BACKGROUND_CAMERA
) {
  const left = -padding;
  const top = -padding;
  const drawWidth = width + padding * 2;
  const drawHeight = height + padding * 2;
  const bottom = top + drawHeight;

  const sky = ctx.createLinearGradient(0, top, 0, bottom);
  sky.addColorStop(0, "#2f78cf");
  sky.addColorStop(0.36, COLORS.bgSkyTop);
  sky.addColorStop(1, COLORS.bgSkyBottom);
  ctx.fillStyle = sky;
  ctx.fillRect(left, top, drawWidth, drawHeight);

  const haze = ctx.createRadialGradient(width * 0.5, height * 0.18, 0, width * 0.5, height * 0.22, width * 0.62);
  haze.addColorStop(0, "rgba(255,255,255,0.32)");
  haze.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = haze;
  ctx.fillRect(left, top, drawWidth, drawHeight * 0.58);

  drawCloud(ctx, width * 0.21, top + height * 0.2, 1.16, 0.54);
  drawCloud(ctx, width * 0.58, top + height * 0.26, 0.9, 0.45);
  drawCloud(ctx, width * 0.84, top + height * 0.31, 1.25, 0.42);

  const distantMountains = getLayerFrame({
    width,
    height,
    padding,
    camera,
    layer: BACKGROUND_LAYERS.distantLightMountains,
  });
  drawMountainLayer({
    ctx,
    left: distantMountains.left,
    bottom: distantMountains.bottom,
    width: distantMountains.width,
    baseY: distantMountains.top + height * 0.47,
    amplitude: height * 0.075,
    ridgeOffsetX: distantMountains.offsetX,
    colorTop: "#8fb4d8",
    colorBottom: "#c7dded",
    alpha: 0.52,
    seed: 2.8,
  });

  const darkerMountains = getLayerFrame({
    width,
    height,
    padding,
    camera,
    layer: BACKGROUND_LAYERS.darkerMountains,
  });
  drawMountainLayer({
    ctx,
    left: darkerMountains.left,
    bottom: darkerMountains.bottom,
    width: darkerMountains.width,
    baseY: darkerMountains.top + height * 0.55,
    amplitude: height * 0.062,
    ridgeOffsetX: darkerMountains.offsetX,
    colorTop: "#5f8bad",
    colorBottom: "#9fc4da",
    alpha: 1,
    seed: 5.2,
  });

  const treeLine = getLayerFrame({
    width,
    height,
    padding,
    camera,
    layer: BACKGROUND_LAYERS.treeLine,
  });
  drawForestLayer(
    ctx,
    treeLine.left,
    treeLine.right,
    treeLine.top + height * 0.72,
    58,
    0.82,
    "rgba(51,105,91,0.28)",
    treeLine.offsetX
  );
  drawForestLayer(
    ctx,
    treeLine.left,
    treeLine.right,
    treeLine.top + height * 0.79,
    48,
    0.96,
    "rgba(38,88,78,0.32)",
    treeLine.offsetX
  );

  const groundHaze = ctx.createLinearGradient(0, top + height * 0.45, 0, bottom);
  groundHaze.addColorStop(0, "rgba(255,255,255,0)");
  groundHaze.addColorStop(0.62, "rgba(210,236,245,0.24)");
  groundHaze.addColorStop(1, "rgba(210,236,245,0)");
  ctx.fillStyle = groundHaze;
  ctx.fillRect(left, top, drawWidth, drawHeight);

  if (drawWater) {
    ctx.fillStyle = COLORS.water;
    const waterH = 30;
    ctx.fillRect(left, height - waterH, drawWidth, waterH + padding);
  }
}
