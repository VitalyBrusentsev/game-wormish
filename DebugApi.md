# Debug API (window.Game)

The dev build exposes a lightweight debug API on `window.Game` to help with Browser MCP testing and manual debugging. The API wraps live game state and provides convenience actions for selecting worms, repositioning them, and firing weapons.

## Availability

- Created at runtime in `src/main.ts` after the `Game` instance is constructed.
- Intended for local dev only (e.g. `npm run dev`).

## Quick start (DevTools console)

```js
// List worms by team
const red = Game.getTeam("red");
const blue = Game.getTeam("blue");

// Move a worm and fire
red[0].move(80);              // dx (pixels), optional dy
red[0].useWeapon("bazooka");
red[0].shoot(Math.PI / 6, 1); // angle in radians, power 0..1

// Set personality and let AI play the active turn
red[0].setPersonality("Marksman");
red.playTurnWithGameAI({ minThinkTimeMs: 1000 });
```

## Top-level API

### `Game.getTeam(teamId)`
Returns an array of `DebugWorm` wrappers for the given team, with extra team helpers attached.

- `teamId`: `"Red" | "Blue" | "red" | "blue"`
- Returns: `DebugWorm[]` (empty array if the team is not found)

### `Game.getTeams()`
Returns an object with both teams (arrays with team helpers attached).

- Returns: `{ Red: DebugWorm[]; Blue: DebugWorm[] }`

### `Game.getActiveWorm()`
Returns a wrapper for the currently active worm, or `null` if unavailable.

- Returns: `DebugWorm | null`

### `Game.selectWorm(teamId, index)`
Selects the active worm by team and index, and returns its wrapper.

- `teamId`: `"Red" | "Blue" | "red" | "blue"`
- `index`: `number`
- Returns: `DebugWorm | null`

## `DebugWorm` wrapper

Each `DebugWorm` exposes live state (via getters) and debug actions that manipulate the underlying worm.

### State accessors

- `name`, `team`, `x`, `y`, `vx`, `vy`, `health`, `alive`, `facing`, `onGround`, `age`

These accessors read directly from the simulation state, so values update as the game runs.

### Actions

#### `select()`
Makes this worm the active worm for its team.

#### `move(dx, dy = 0)`
Offsets the worm position by `dx`, `dy` (pixels), then resolves collisions against terrain.

#### `walk(direction, durationMs, jump = false)`
Moves the worm using in-game movement commands (no teleporting).

- `direction`: `-1 | 0 | 1` (left, idle, right)
- `durationMs`: number of milliseconds to apply movement for
- `jump`: optional jump flag for the start of the move

#### `kill()`
Applies fatal damage to the worm.

#### `useWeapon(weapon)`
Sets the active weapon for the selected worm.

- `weapon`: `"bazooka" | "hand grenade" | "rifle" | "uzi"` (case-insensitive) or a `WeaponType` value.

#### `shoot(angle, power = 1)`
Fires the current weapon using the supplied aim angle and power.

- `angle`: radians
- `power`: 0..1 (clamped)

#### `personality`
Returns the assigned AI personality for this worm (defaults to `Generalist`).

#### `setPersonality(value)`
Sets the AI personality for this worm.

- `value`: `"Generalist" | "Marksman" | "Demolisher" | "Commando"` (case-insensitive)

## Team helpers

`Game.getTeam()` returns an array of worms and also exposes team-level helpers.

### `team.playTurnWithGameAI({ settings })`
Invokes Game AI for the currently active worm on this team.

- `settings.minThinkTimeMs`: minimum delay before firing (default 1000ms)
- `settings.cinematic.chance`: chance to enable cinematic scoring bias
- `settings.precision.mode`: `"perfect" | "noisy"`
- `settings.debug.enabled`: when true, the returned plan includes a `debug` object with scoring breakdowns
- `settings.debug.topN`: number of top candidates to include in `plan.debug` (default 6)
- `settings.movement.enabled`: when true (default), AI may walk/jump and then re-plan before firing

## Notes & limitations

- The API mutates live simulation state. Use it only in local dev or controlled test environments.
- `move()` and `shoot()` implicitly select the worm first.
- `shoot()` uses a fixed target distance internally to compute aim target coordinates; the angle is authoritative.
