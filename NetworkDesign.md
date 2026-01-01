# Networked Gameplay Design Summary

## Responsibilities
- `Game` ([game.ts](src/game.ts)) owns WebRTC wiring + the frame loop; it forwards local turn commands/resolutions onto the data channel and routes incoming messages to the correct turn controller.
- `GameSession` ([session.ts](src/game/session.ts)) owns deterministic simulation + turn bookkeeping; it exposes snapshots, accepts `TurnCommand`s, and can apply an authoritative `TurnResolution`.
- `TurnDriver`s ([turn-driver.ts](src/game/turn-driver.ts)) decide whether the active team is locally driven or remote-driven (spectator/passive) for the current turn.

## Message protocol (data channel)
- `match_init` carries a `MatchInitSnapshot` (terrain heightmap + tile selection, teams/worms, `turnIndex`, active indices, turn state) to bootstrap or fully resync a match.
- `turn_command` carries `{ turnIndex, teamId, command }` for live remote playback during the active team’s turn.
- `turn_resolution` is the authoritative end-of-turn sync: terrain carve operations + worm health changes + `result` (`NetworkTurnSnapshot`) describing the post-turn state.
- `match_restart_request` lets a guest request a reset; the host performs the restart and re-sends `match_init`.
- `player_hello` is metadata (names + host/guest role).

## Turn sync model
- Each turn is identified by a monotonically increasing `turnIndex` (included in snapshots, commands, and resolutions) and validated on receipt.
- The active peer streams `TurnCommand`s (aim/move/weapon/charge/fire). Aim/move are throttled (`src/game/network/aim-throttle.ts`, `src/game/network/move-throttle.ts`) to reduce message volume while keeping playback smooth.
- The passive peer applies streamed commands for animation/projectiles but suppresses irreversible sim effects while waiting for the authoritative resolution (`waitingForRemoteResolution` gates damage, terrain carve, deaths, auto-advance, victory).
- When the turn ends, the active peer sends `TurnResolution`. The receiver validates (turn/team/wind/bounds), applies terrain + health deltas, then loads the authoritative `result` snapshot which already represents the next turn and reconfigures turn drivers.

## Time model
- Commands use `atMs` relative to the local `turnStartMs` (not wall-clock synchronization).
- Receivers localize timing on snapshot/resolution load (`handleMatchInit`, `applyTurnResolution(..., { localizeTime: true })`) so UI timers and charge logic stay consistent across machines.

## Debugging & observability
- `NetworkSessionState` keeps a capped in-memory log of recent send/recv messages; toggle with `I` and render via `src/ui/network-log-hud.ts`.
- `TurnResolution` intentionally ships only counts for recorded commands/projectile events; authoritative state transfer is via `terrainOperations`, `wormHealth`, and the `result` snapshot.

## WebRTC connection behavior
- `RoomManager` debounces transient `disconnected` states before surfacing them, reducing UI flapping during brief network hiccups.
