# Wormish

Turn-based, physics-flavored artillery game inspired by the classic Worms. Built for the web with a deterministic, testable core.

## Tech stack
- HTML/CSS for UI scaffold ([index.html](index.html), [src/styles/index.css](src/styles/index.css))
- TypeScript + Vite for dev/build ([vite.config.js](vite.config.js), [tsconfig.json](tsconfig.json), [package.json](package.json))
- Vitest for unit tests ([src/elm/__tests__/](src/elm/__tests__/))

## Game design and architecture
Elm-style state management with a single immutable model and explicit messages/effects:
- Single source of truth: [src/elm/state.ts](src/elm/state.ts)
- Messages (discriminated union): [src/elm/msg.ts](src/elm/msg.ts)
- Pure reducer (copy-on-write): [src/elm/update.ts](src/elm/update.ts)
- Effects described as data: [src/elm/effects.ts](src/elm/effects.ts) interpreted by [src/elm/runtime.ts](src/elm/runtime.ts)
- Pure selectors/derivations: [src/elm/selectors.ts](src/elm/selectors.ts)
- Terrain visuals decoupled from terrain model: [src/elm/terrain-model.ts](src/elm/terrain-model.ts)
- Legacy loop integration: [src/game.ts](src/game.ts) dispatches TickAdvanced each frame while systems migrate to the reducer
- Deterministic time/RNG: time flows via messages; RNG lives in AppState for reproducibility

## Development
Prerequisites: Node.js LTS.

Common tasks (Windows PowerShell syntax):

- Install deps: `npm install`
- Run dev server: `npm run dev`
- Type-check without emitting: `tsc -p tsconfig.json --noEmit`
- Run tests in watch mode: `npm run test`
- Run tests once (CI): `npm run test:run`

## Project layout (selected)
- App entry: [src/main.ts](src/main.ts), game loop: [src/game.ts](src/game.ts)
- Domain entities: [src/entities/](src/entities/)
- Styles: [src/styles/index.css](src/styles/index.css)
- CI/Pages workflow (if enabled): [.github/workflows/pages.yml](.github/workflows/pages.yml)

## Contributing notes
- Keep reducers pure and exhaustive over Msg; express side effects as EffectDescriptor data only.
- Prefer immutable updates and selectors for derived data.
- Add or update unit tests alongside new Msg or state changes under [src/elm/__tests__/](src/elm/__tests__/).

## License
Licensed under the Apache License, Version 2.0. See [NOTICE](NOTICE) for details.