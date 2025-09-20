# Project

This is a web-based game, "Wormish", inspired by a popular retro game, Worms.
It allows players to take turns and control squads of whimsical creatures, with the goal of eliminating other player's squad.

# Technology stack

HTML/CSS, TypeScript, Vite

## Compiling and testing

Use the following console command to verify the saved changes successfully pass the compilation:
```
tsc -p tsconfig.json --noEmit
```

If a `dev` task is running (most likely, can be confirmed by the user), all approved changes will already be reflected in the web app, available for the Browser tool to test. If it doesn't, you can start it by executing `npm run dev`.


## Command line

The syntax for command line is Windows Powershell, so pay attention to proper syntax. For example, use `;`, not `&&` for combining two commands in one line.

When relevant and approved, you can start the server by running the `npm run dev` command and use the browser to test the app.

# Coding Conventions

## Typescript

Use descriptive, but not too verbose variable names. Examples: `files` instead of `f`, `updatedRecords` instead of `updated`, but avoid having more than 2-3 words in an identifier. Exceptions could be `i`,`j` or `x`,`y` for some clear integer loops or math / coordinate calculations.

Try to keep files under 500 lines. Larger files usually are a code smell: maybe a class has too many responsibilities? Can this function be refactored into several more focused ones? Is something hardcoded, while the abstraction can be elevated, and a more elegant solution suggested.

Avoid using 'any' and similar type hacks. Always try to establish the reason behind compiler errors and look for the way to carefully alter the applications types to satisfy the requirements.

Comments should be kept to a minimum. Prefer code readability and clean structure instead. Never add a comment to an already descriptively named function or type. Avoid commenting on a tricky block of code: prefer extracting it into a descriptive function, method or a class.

## State Management (Elm-style)

- Single immutable source of truth: AppState lives in [src/elm/state.ts](src/elm/state.ts). The model is pure data only (no DOM/time/random or class instances), updated via pure functions.
- All changes go through a discriminated union of messages (Msg) defined in [src/elm/msg.ts](src/elm/msg.ts), handled by a single pure reducer in [src/elm/update.ts](src/elm/update.ts) that returns a new state (copy-on-write). The reducer must be exhaustive over Msg.
- Side effects are expressed as data (EffectDescriptor) in [src/elm/effects.ts](src/elm/effects.ts) and interpreted externally by a thin runtime adapter [src/elm/runtime.ts](src/elm/runtime.ts). No side effects are executed inside the reducer.
- Entities are stored by stable IDs in Record maps for safe immutable updates. Replace, remove, or add by creating new maps/arrays rather than mutating in place.
- Derived values and read-only helpers are implemented as pure selectors in [src/elm/selectors.ts](src/elm/selectors.ts). Rendering reads from the model; terrain visuals are decoupled from the terrain model in [src/elm/terrain-model.ts](src/elm/terrain-model.ts).
- Time and randomness are explicit inputs: model time advances via TickAdvanced messages; timers are scheduled via a ScheduleTimer effect; RNG should be deterministic (seed/state in AppState) and never called directly inside reducers.
- Incremental integration: the legacy loop is preserved; [src/game.ts](src/game.ts) dispatches TickAdvanced each frame to the Elm runtime while gameplay continues to run, enabling gradual migration of systems into the pure reducer.

## Unit tests

- Framework and commands: Vitest is configured. Run tests with:
  - Watch: `npm run test`
  - CI (single run): `npm run test:run`
  Tests live under [src/elm/__tests__/](src/elm/__tests__/), e.g. [src/elm/__tests__/update.core.test.ts](src/elm/__tests__/update.core.test.ts), [src/elm/__tests__/update.turns-ui.test.ts](src/elm/__tests__/update.turns-ui.test.ts).
- Pure isolation: Tests drive state changes exclusively via Msg and the reducer in [src/elm/update.ts](src/elm/update.ts). No DOM, timers, or randomness are invoked inside the reducer. Use explicit TickAdvanced/nowMs and effect assertions (as effects are added).
- Determinism: Construct states with [src/elm/init.ts](src/elm/init.ts) and fixed seeds to ensure reproducible results for the same message sequence. Prefer data factories/helpers for clarity.
- Exhaustiveness and coverage: Each Msg variant should have at least one positive test and one edge-case test (invalid IDs, boundary conditions, paused vs playing, etc.). Adding a new Msg should trigger test additions; reducer exhaustiveness is enforced by TypeScript and test coverage.
- Immutability assertions: When behavior changes, assert identity changes only where expected (e.g., state.session.turn changes on TickAdvanced). Use toBe vs not.toBe appropriately to detect accidental mutation.
- Side-effect boundaries: When effects are emitted, assert the returned EffectDescriptor[] content rather than performing I/O. The runtime interpreter [src/elm/runtime.ts](src/elm/runtime.ts) can be unit tested separately as needed.
- Property-style checks: Add light invariants where useful (e.g., health >= 0, exploded projectiles aren’t advanced further, terrain indices in-bounds). These keep reducers honest as complexity grows.
