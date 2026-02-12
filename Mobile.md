# Mobile Portrait Redesign Plan (Pre-Implementation)

## 1) Goal
Enable full gameplay on mobile devices in portrait orientation while preserving the current desktop experience with zero behavior regressions.

## 2) Current-State Findings

1. Input is desktop-first.
- `Input` tracks keyboard + mouse, but touch only focuses canvas and does not drive aim/move/shoot.
- `GameSession.handleInput(...)` consumes keyboard (`A/D`, arrows, `Space`, `1-4`) and mouse press/hold/release for charge + fire.

2. Turn control is centralized and extensible.
- `LocalTurnController` delegates to `GameSession.handleInput(...)`.
- Network sync already works through command records (`aim`, `move`, `set-weapon`, `start-charge`, `cancel-charge`, `fire-charged-weapon`).

3. Camera scrolling is desktop-oriented.
- Horizontal edge scrolling depends on mouse position near canvas edges.
- No gesture-based camera pan currently exists.

4. HUD and minimap are canvas-rendered and non-interactive.
- Weapon is currently text in center HUD.
- Minimap is fixed top-right (`MAP_GADGET_WIDTH_PX = 240`).

5. AI movement has reusable stuck logic, but it is planning-oriented.
- `planMovement(...)` has crater/stuck detection and escape behavior.
- This logic is in AI planning code; it is not yet exposed as a reusable runtime movement-assist module.

6. Scale baseline.
- `WORLD.wormRadius = 14` => worm height ~28 CSS px.
- Visual critter size is not equal to physics radius alone; final on-screen footprint is driven by critter rig geometry and rendering.
- Mobile portrait sizing must be calibrated against rendered critter height (not just `wormRadius`).

## 3) Design Principles for Mobile Mode

1. Strict mode gating:
- Mobile controls only activate under a dedicated `mobile-portrait` control profile.
- Desktop control pipeline remains untouched.

2. Separation of concerns:
- Keep simulation commands in `GameSession`.
- Keep touch interpretation and UI state in `src/ui/` / dedicated mobile modules.
- Keep rendering helpers pure where possible.

3. Command compatibility:
- Reuse existing turn command schema for network determinism.
- Avoid introducing mobile-only network command types unless absolutely necessary.

4. Reuse AI movement heuristics:
- Extract reusable stuck/escape helpers into a shared module so mobile movement assist and AI use the same behavior core.

## 4) Proposed Architecture

1. `ControlProfile` layer (new)
- Detect and expose `desktop` vs `mobile-portrait`.
- Initial heuristic: coarse pointer + portrait orientation.
- Add explicit override hooks (for testing/debug).

2. Mobile UI overlay module (new, DOM)
- Renders touch controls over canvas:
  - Weapon button (top-left under HUD), opens weapon list.
  - Aim mode toggle.
  - Fire / charge-and-fire button depending on weapon.
  - Jump button shown during assisted movement.
- Mounted/unmounted by `Game`; hidden when dialogs are open.

3. Mobile gesture controller (new)
- Handles swipe/pan and touch interactions.
- Converts screen-space touch to world-space coordinates for aim and movement destination.
- Applies `touch-action` strategy and `preventDefault` handling to reduce browser gesture conflicts.

4. Session command facade (small refactor)
- Add explicit public action methods in `GameSession` for non-desktop inputs:
  - set weapon
  - update aim
  - begin/cancel/end charge
  - fire with current aim
  - movement step enqueue
- Keep existing keyboard/mouse path functional by calling same internals.

5. Mobile movement assist (new)
- Drag active worm => choose destination X (ghost marker + direction arrow).
- On release, start assisted walk (chunked movement commands).
- During movement, show jump button.
- Stop on reached destination, turn phase change, repeated stuck, or safety timeout.
- Reuse extracted stuck detection constants/logic from AI planning where possible.

6. Mobile HUD rendering updates
- Keep desktop HUD unchanged.
- For mobile mode, draw weapon icon anchor and optional compact HUD spacing.
- Keep minimap on right; adapt size if needed for narrow portrait widths.

## 5) Incremental Plan

### Phase 0: Decision Lock (no gameplay code yet)
1. Apply approved UX decisions from section 6.
2. Confirm control profile rules.
3. Apply a mobile portrait downscale by default and tune it to target rendered critter height.

### Phase 1: Control Profile + Plumbing
1. Add control profile detection + toggling in `Game`.
2. Add mobile module lifecycle (mount/dispose/update).
3. Keep desktop input path unchanged.

### Phase 2: Mobile Weapon UI
1. Implement top-left weapon button + picker list.
2. Wire to session weapon selection commands.
3. Ensure only active local turn can change weapon.

### Phase 3: Mobile Aiming + Firing
1. Add aim mode state machine with contextual activation:
- Tapping the active worm reveals an `Aim` button above it.
- Entering aim mode keeps weapon switching available.
2. Aim gesture sets angle/target each frame (gesture-driven, no desktop cursor assumptions).
3. Use interchangeable controls for all weapons:
- Aim mode actions: `Cancel`, `Fire / Charge`.
- Non-charging weapons (`Rifle`, `Uzi`) fire immediately from primary action.
- Charging weapons (`Bazooka`, `Hand Grenade`) enter charge mode from primary action.
4. Charge mode behavior:
- Keep pulsating charge arc and trajectory/bounce prediction visible.
- Provide `Cancel` (back to aim mode) and `Fire`.
5. Keep charge meter and trajectory rendering coherent in mobile mode.

### Phase 4: Mobile Camera Pan/Scroll
1. Add swipe-to-pan camera gesture.
2. Disable desktop edge-scroll when mobile mode is active.
3. Protect against accidental browser navigation as much as platform allows.

### Phase 5: Assisted Movement
1. Implement drag-to-destination ghost + confirmation-on-release behavior.
2. Execute assisted walking using existing movement command stream.
3. Integrate jump button while movement is active.
4. Stop on stuck detection by cancelling movement sequence (no panic-shot fallback).
5. Preserve ghost destination feedback during movement.

### Phase 6: Tests + Validation
1. Unit tests for control profile detection and mobile action state transitions.
2. Unit tests for extracted stuck/escape helper logic shared with AI.
3. Session-level tests for mobile action facade producing valid command sequences.
4. Regression checks that desktop keyboard/mouse flow remains unchanged.
5. Run:
- `npm run typecheck`
- `npm run test:run`

## 6) Locked Decisions

1. Scaling / zoom:
- Default mobile portrait view uses world downscale (zoom-out).
- Scale target is rendered critter height in the ~6-8mm range on typical phones.
- Final value is implementation-tuned using actual rig-rendered size, with optional extra temporary zoom during aim/charge if needed.

2. Camera panning and movement priority:
- One-finger swipe pans the world (world follows swipe).
- Priority rule: if touch starts in active-worm proximity, interpret as movement drag (not camera pan).

3. Aim mode activation:
- Start with contextual activation: tapping the active worm reveals an `Aim` button above the worm.
- Exact activation ergonomics are explicitly marked for iteration during implementation/playtesting.

4. Firing model and ergonomics:
- Controls are weapon-compatible and interchangeable in layout.
- Aim mode always has two actions: `Cancel`, `Fire / Charge`.
- In aim mode:
  - `Rifle`/`Uzi`: primary action fires.
  - `Bazooka`/`Hand Grenade`: primary action enters charge mode.
- In charge mode:
  - Show pulsating charge + full trajectory/bounce prediction.
  - Provide `Cancel` (returns to aim mode) and `Fire`.
- Weapon switching remains available throughout aiming phase.

5. Movement drag semantics:
- Drag-to-walk starts only when touch begins near the active worm.
- Generic swipes outside active-worm proximity remain camera pans.

6. Assisted movement stuck behavior:
- Mobile assisted movement cancels on stuck detection.
- Do not reuse AI panic-shot behavior for mobile movement cancellation.

7. Minimap sizing in portrait:
- Use a smaller mobile minimap so it stays in the right half of the screen.
- Constraint: minimap width must not exceed half of current viewport width.

8. iOS edge swipe:
- Accepted limitation: system edge back-swipe cannot be fully controlled at extreme edges.

## 7) Non-Blocking UX Experiments (Post-Lock)

1. Tune active-worm proximity radius for drag-vs-pan disambiguation.
2. Validate aim-angle gesture choice (drag arc vs free swipe while in aim mode).
3. Re-evaluate optional temporary zoom during aim/charge if precision is insufficient.

## 8) Definition of Done

1. Mobile portrait players can complete a full turn cycle: move, jump, pick weapon, aim, charge/fire, end turn.
2. Desktop controls and visuals remain unchanged in behavior.
3. Networked command synchronization remains deterministic with mobile inputs.
4. AI and mobile movement assist share tested stuck/escape behavior where practical.
