/**
 * Effect descriptors (pure data) interpreted by a thin runtime adapter.
 * No side effects here; only structured requests.
 */

import type { Vec2, Rect, Color } from "./entities";
import type { CursorKind } from "./state";
import type { Msg } from "./msg";

/* Visual-only particle spec for the renderer (not part of model Particles) */
export type VisualParticleSpec = {
  position: Vec2;
  velocity: Vec2;
  color: Color;
  size: number;
  ttlMs: number;
  gravityScale?: number;
};

/* Simple sound identifiers (extend as needed) */
export type SoundId = "explosion" | "fire" | "jump" | "victory" | "tick";

/* Effect descriptor union */
export type EffectDescriptor =
  | { type: "ScheduleTimer"; atMs: number; msg: Msg; timerId?: string }
  | { type: "PlaySound"; sound: SoundId; volume: number; pos?: Vec2 }
  | { type: "ScreenShake"; intensity: number; durationMs: number }
  | { type: "CursorSet"; cursor: CursorKind }
  | { type: "TerrainRedraw"; region?: Rect }
  | { type: "SpawnVisualParticles"; particles: VisualParticleSpec[] }
  | { type: "Dispatch"; msg: Msg };