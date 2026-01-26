# Critters (Wormish) — Rendering, Weapons, IK, Collision

This document captures the current “critter” (worm) graphics model and the key design decisions behind it.

## Scalable Rendering Model

- The critter is rendered from a sprite sheet (`src/assets/critters.png`) composed from a single base size `r` (the worm radius, `WORLD.wormRadius`).
- Base geometry (arms, weapons, collision shapes) is derived from `r` via `CRITTER` constants in `src/definitions.ts`.
- The critter is composed of:
  - **Torso**: sprite centered on the rig body (with optional belt/collar overlays).
  - **Head**: sprite centered on the rig head.
  - **Face**: procedural overlay (eyes/pupils + smile) drawn between head and helmet.
  - **Helmet**: sprite overlay drawn last.
  - **Tail**: two segments forming a worm-like curve opposite the facing direction.
- Facing is a simple `-1 | 1` flip (left/right) and drives pose mirroring and tail curvature.

Implementation entry points:
- Geometry is computed via `computeCritterRig()` in `src/critter/critter-geometry.ts`.
- Rendering is done in `Worm.render()` in `src/entities/worm.ts`, using the rig + sprite composition (arms remain lines for now).
- Sprite offsets can be tweaked live via `window.spriteOffsets` (keys: `"tail2" | "tail1" | "torso" | "belt1" | "collar" | "head" | "helmet" | "face"`).

## Weapon Implementation Model (Temporary Line Weapons)

- Weapons are currently rendered as a **single line segment** from a computed root to a computed muzzle.
- Each weapon has a **visual spec** (length + grip positions) in `resolveWeaponVisualSpec()`:
  - Uzi: one-handed grip (single grip target).
  - Rifle/Bazooka: two-handed grips (main + support).
  - Hand grenade: special-case “baseball lob” pose (see below).
- The weapon root is intentionally **offset forward** but stays collinear with the aim axis.
- These lines are intended as placeholders and will be replaced by sprites later without changing the pose model.

Implementation entry points:
- Weapon line rig via `computeWeaponRig()` in `src/critter/critter-geometry.ts`.
- Active worm renders the weapon not only in `aim`, but also `projectile` and `post` phases (`src/game.ts`).

## Limbs and IK (Arms)

- Each arm is a 2-segment chain (upper + lower) solved using simple analytic 2-bone IK every frame.
- Targets:
  - Most weapons use grip points along the weapon line.
  - Uzi uses one hand on the weapon and keeps the off-hand in an “idle” pose.
- Elbow bend direction is kept consistent (stable silhouette) via a preferred elbow direction vector.
- Draw order is interleaved with the sprite body for readability: far arm → body up to torso/belt → weapon → near arm → collar/head/helmet.

Implementation entry point:
- Arm segment positions are produced by `computeCritterRig()` in `src/critter/critter-geometry.ts` and rendered in `src/entities/worm.ts`.

## Hand Grenade Pose

- Hand grenade uses a distinct pose:
  - Grenade hold point is fixed relative to facing (a constant “back + up” position).
  - The grenade is always held/thrown by the near arm.
- Projectile spawn and trajectory prediction originate from the grenade hold point (not from the weapon muzzle).

Implementation entry points:
- Grenade pose + hold position is exposed as `rig.grenade` from `computeCritterRig()`.
- Spawn/prediction uses `rig.grenade.center` in `src/game/weapon-system.ts`.

## Collision Model (Projectile ↔ Critter)

Projectile collision uses a small set of simple shapes derived from the same rig used for rendering:

- **Torso**: 1 axis-aligned rectangle (AABB), scaled/shifted to better match the sprite silhouette.
- **Head + tail**: circles (head circle + 2 tail segment circles), with sprite offsets applied.
- **Arms**: intentionally excluded (negligible for gameplay readability and performance).

Implementation entry point:
- Hit test function `critterHitTestCircle()` in `src/game/critter-hit-test.ts`.
- Covered by unit tests in `src/__tests__/critter-hit-test.test.ts`.
