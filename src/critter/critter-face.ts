import { clamp } from "../definitions";
import type { Vec2 } from "./critter-geometry";

export function renderCritterFace(config: {
  ctx: CanvasRenderingContext2D;
  center: Vec2;
  headRadius: number;
  lookAngle: number;
  highlight: boolean;
  activePulse01: number;
  activeLineScale: number;
  age: number;
}) {
  const { ctx, center, headRadius, lookAngle, highlight, activePulse01, activeLineScale, age } =
    config;

  const lookDx = Math.cos(lookAngle);
  const lookDy = Math.sin(lookAngle);

  ctx.save();
  ctx.translate(center.x, center.y);

  const eyeR = Math.max(2.2, headRadius * 0.26);
  const eyeDx = headRadius * 0.42;
  const eyeY = -headRadius * 0.12;

  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(-eyeDx, eyeY, eyeR, 0, Math.PI * 2);
  ctx.arc(eyeDx, eyeY, eyeR, 0, Math.PI * 2);
  ctx.fill();

  const pupilR = eyeR * 0.5;
  const pupilMaxX = eyeR * 0.42;
  const pupilMaxY = eyeR * 0.33;
  const pupilOffsetX = clamp(lookDx, -1, 1) * pupilMaxX;
  const pupilOffsetY = clamp(lookDy, -1, 1) * pupilMaxY;

  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.arc(-eyeDx + pupilOffsetX, eyeY + pupilOffsetY, pupilR, 0, Math.PI * 2);
  ctx.arc(eyeDx + pupilOffsetX, eyeY + pupilOffsetY, pupilR, 0, Math.PI * 2);
  ctx.fill();

  const mouthY = headRadius * 0.55;
  const mouthW = headRadius * 0.55 * 0.8;
  const mouthSmile = 0.35 + 0.25 * Math.sin(age * 2.0);
  ctx.strokeStyle = `rgba(0,0,0,${(highlight ? 0.42 + 0.14 * activePulse01 : 0.45).toFixed(3)})`;
  ctx.lineWidth = 1 * activeLineScale;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-mouthW, mouthY);
  ctx.quadraticCurveTo(0, mouthY + headRadius * mouthSmile, mouthW, mouthY);
  ctx.stroke();

  ctx.restore();
}
