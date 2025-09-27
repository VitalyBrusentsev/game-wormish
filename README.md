# Wormish

Turn-based, physics-flavored artillery game inspired by the classic Worms. Built for the web with a deterministic, testable core.

## Tech stack
- HTML/CSS for UI scaffold ([index.html](index.html), [src/styles/index.css](src/styles/index.css))
- TypeScript + Vite for dev/build ([vite.config.js](vite.config.js), [tsconfig.json](tsconfig.json), [package.json](package.json))
- Vitest for unit tests (see `npm run test`)

## Game design and architecture
The game is orchestrated by an imperative loop with lightweight classes for domain concepts:
- The main entry point constructs a [Game](src/game.ts) instance that owns the canvas and runs the frame loop.
- Turn/weapon flow is encapsulated by [GameState](src/game-state.ts), keeping timing and charge logic together.
- Gameplay objects live under [src/entities/](src/entities/), covering terrain, worms, projectiles, and particles.
- Rendering helpers in [src/rendering/](src/rendering/) take a canvas context and draw HUD, terrain, and UI overlays.
- User input is handled by [Input](src/utils.ts) and UI overlays under [src/ui/](src/ui/).

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
- Keep frame-step logic deterministic where possible so turn timing and wind behave consistently.
- Consider encapsulating related behavior in small classes (e.g., `GameState`, entities, overlays) instead of spreading logic across the loop.
- Add or update unit tests when adding new mechanics or regressions worth guarding with Vitest.

## License
Licensed under the Apache License, Version 2.0. See [NOTICE](NOTICE) for details.