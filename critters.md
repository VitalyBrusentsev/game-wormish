# Critters (Wormish) — Rendering, Weapons, IK, Collision

This document captures the current “critter” (worm) graphics model and the key design decisions behind it.

## Scalable Rendering Model

- The critter is rendered procedurally from a single base size `r` (the worm radius, `WORLD.wormRadius`).
- All proportions are derived from `r` via `CRITTER` constants in `src/definitions.ts`.
- The critter is composed of:
  - **Torso**: a rounded rectangle (parametric width/height).
  - **Head**: a circle above the torso (parametric radius).
  - **Tail**: three decreasing circles forming a worm-like “j / flipped-j” curve opposite the facing direction.
- Facing is a simple `-1 | 1` flip (left/right) and drives pose mirroring and tail curvature.

Implementation entry points:
- Geometry is computed via `computeCritterRig()` in `src/critter/critter-geometry.ts`.
- Rendering is done in `Worm.render()` in `src/entities/worm.ts`, using the rig (no per-entity sprite assets yet).

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

Implementation entry point:
- Arm segment positions are produced by `computeCritterRig()` in `src/critter/critter-geometry.ts` and rendered in `src/entities/worm.ts`.

## Hand Grenade “Baseball Lob” Pose

- Hand grenade uses a distinct pose:
  - Throw hand moves “back and up” (wind-up) relative to facing and aim angle.
  - A small grenade circle is rendered at the throw hand.
- Projectile spawn and trajectory prediction originate from the throw-hand release point (not from the weapon muzzle).

Implementation entry points:
- Grenade pose + hold position is exposed as `rig.grenade` from `computeCritterRig()`.
- Spawn/prediction uses the grenade hand in `src/game/weapon-system.ts`.

## Collision Model (Projectile ↔ Critter)

Projectile collision uses a small set of simple shapes derived from the same rig used for rendering:

- **Torso**: 1 axis-aligned rectangle (AABB).
- **Head + tail**: 4 circles (head circle + 3 tail segment circles).
- **Arms**: intentionally excluded (negligible for gameplay readability and performance).

Implementation entry point:
- Hit test function `critterHitTestCircle()` in `src/game/critter-hit-test.ts`.
- Covered by unit tests in `src/__tests__/critter-hit-test.test.ts`.

