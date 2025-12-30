# Camera System

## Design principles
- The ground width is fixed at 2500px and independent of browser size.
- The viewport is a window into the fixed world; extra screen width shows only water, not extra ground.
- The camera has inertia: it eases toward a target X while camera shake remains a separate, additive offset.
- Turn changes auto-focus the active worm once, but mouse edge scrolling is free to roam afterward.
- Horizontal scrolling is bounded so at least half of the real ground stays visible.

## Key implementation details
- World size: `WORLD.groundWidth` drives `GameSession` width; terrain generation uses this fixed width.
- Rendering split:
  - Background and HUD are rendered in screen space.
  - World entities are rendered with `ctx.translate(-cameraX + cameraOffsetX, cameraOffsetY)`.
- Camera dynamics:
  - `cameraX` is the inertial position; `cameraTargetX` is the desired position.
  - Spring behavior uses velocity, stiffness, and damping each frame.
  - Camera shake only affects `cameraOffsetX/Y` and does not touch `cameraX`.
- Turn focus:
  - A new turn is detected via `GameState.turnStartMs`.
  - `focusCameraOnActiveWorm()` nudges `cameraTargetX` only if the worm is outside a safe margin.
- Edge scrolling:
  - When the pointer nears the left/right edge and there is ground remaining, the camera target pans.
  - Pointer presence is tracked in `Input.mouseInside` to avoid accidental scrolling off-canvas.
- Limits:
  - Camera bounds ensure at least half of the ground remains visible (`getCameraBounds()`).
- Resizing:
  - `Game.resize()` updates canvas size and re-centers the camera without rebuilding the session.
