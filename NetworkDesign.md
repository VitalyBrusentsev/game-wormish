# Networked Gameplay Design Summary

## Architecture separation
- `GameSession` encapsulates the deterministic simulation (terrain, teams, turn flow, projectiles, particles, wind) while the browser-facing `Game` class delegates to it for input wiring, rendering, and DOM concerns. This keeps networking concerns focused on the session while preserving the existing hotseat loop.【F:src/game/session.ts†L58-L235】【F:src/game.ts†L15-L200】

## Snapshot and restoration workflow
- `GameSession` can serialize the full match via `toSnapshot`, capturing terrain data, team rosters, worm state, and turn metadata for sharing between peers.【F:src/game/session.ts†L421-L458】
- `loadSnapshot` validates dimensions, reinstates terrain masks, repaints the canvas to keep visuals aligned with collisions, and rebuilds teams before clearing transient projectiles/particles.【F:src/game/session.ts†L461-L509】
- Deterministic seeds and test doubles ensure snapshots remain stable; regression tests assert terrain rebuilds and serialized data round-trip correctly.【F:src/__tests__/game-session.test.ts†L69-L188】

## Turn capture and authoritative resolutions
- Each turn initializes a fresh `TurnLog`, recording the acting team, wind baseline, fired weapon commands, projectile lifecycle events, terrain carve operations, and worm health changes.【F:src/game/session.ts†L205-L348】【F:src/game/session.ts†L632-L812】
- When the turn ends, `buildTurnResolution` packages a deep-cloned log plus the resulting snapshot to produce an authoritative payload. `finalizeTurn` exposes the payload locally, while remote peers ingest it through `applyTurnResolution`, which runs extensive validation (team/worm identities, terrain sizes, world bounds) before mutating state.【F:src/game/session.ts†L205-L233】【F:src/game/session.ts†L511-L629】【F:src/game/session.ts†L758-L812】
- Payload types live under `src/game/network/turn-payload.ts`, defining command/event schemas that can be streamed or sent in bulk after the turn completes.【F:src/game/network/turn-payload.ts†L1-L89】

## Turn control orchestration
- `GameSession` supports pluggable `TurnDriver`s per team, allowing local hotseat play, remote spectators, or future AI controllers to coexist. A `LocalTurnController` forwards input when the turn is local, while `RemoteTurnController` queues incoming resolutions and applies them once available.【F:src/game/session.ts†L124-L233】【F:src/game/session.ts†L654-L670】【F:src/game/turn-driver.ts†L6-L107】

## Known limitations / next steps
- `TurnLog` does not currently capture worm locomotion (walks, jumps) or passive deaths, so remote clients must rely on the final snapshot rather than replaying movement moment-to-moment.【F:src/game/session.ts†L235-L276】【F:src/game/session.ts†L632-L812】 Consider extending the log if real-time remote playback is required.
- `startedAtMs` is derived from each client’s local clock, causing validation failures when ingesting remote payloads. Replacing it with a deterministic turn counter or relative timestamp would make resolutions portable across machines.【F:src/game/session.ts†L205-L233】【F:src/game/session.ts†L523-L538】【F:src/game/session.ts†L758-L812】
- Network streaming of turn events is not yet implemented; once payloads are authoritative, we can forward the same records incrementally to approximate real-time remote playback.【F:src/game/session.ts†L758-L812】【F:src/game/network/turn-payload.ts†L1-L89】
