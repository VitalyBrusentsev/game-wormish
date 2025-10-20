# Networked Gameplay Design Summary

## Architecture separation
- `GameSession` ([session.ts](src/game/session.ts)) encapsulates the deterministic simulation (terrain, teams, turn flow, projectiles, particles, wind) while the browser-facing `Game` class delegates to it for input wiring, rendering, and DOM concerns. This keeps networking concerns focused on the session while preserving the existing hotseat loop.

## Snapshot and restoration workflow
- `GameSession` can serialize the full match via `toSnapshot`, capturing terrain data, team rosters, worm state, and turn metadata for sharing between peers.
- `loadSnapshot` validates dimensions, reinstates terrain masks, repaints the canvas to keep visuals aligned with collisions, and rebuilds teams before clearing transient projectiles/particles.
- Deterministic seeds and test doubles ensure snapshots remain stable; regression tests assert terrain rebuilds and serialized data round-trip correctly.

## Turn capture and authoritative resolutions
- Each turn initializes a fresh `TurnLog`, recording the acting team, wind baseline, fired weapon commands, projectile lifecycle events, terrain carve operations, and worm health changes.
- When the turn ends, `buildTurnResolution` packages a deep-cloned log plus the resulting snapshot to produce an authoritative payload. `finalizeTurn` exposes the payload locally, while remote peers ingest it through `applyTurnResolution`, which runs extensive validation (team/worm identities, terrain sizes, world bounds) before mutating state.
- Payload types live under `src/game/network/turn-payload.ts`, defining command/event schemas that can be streamed or sent in bulk after the turn completes.

## Turn control orchestration
- `GameSession` supports pluggable `TurnDriver`s (`src/game/turn-driver.ts`) per team, allowing local hotseat play, remote spectators, or future AI controllers to coexist. A `LocalTurnController` forwards input when the turn is local, while `RemoteTurnController` queues incoming resolutions and applies them once available.

## Known limitations / next steps
- `TurnLog` does not currently capture worm locomotion (walks, jumps) or passive deaths, so remote clients must rely on the final snapshot rather than replaying movement moment-to-moment. Consider extending the log if real-time remote playback is required.
- `startedAtMs` is derived from each client’s local clock, causing validation failures when ingesting remote payloads. Replacing it with a deterministic turn counter or relative timestamp would make resolutions portable across machines.
- Network streaming of turn events is not yet implemented; once payloads are authoritative, we can forward the same records incrementally to approximate real-time remote playback.
