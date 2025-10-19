# Project

This is a web-based game, "Wormish", inspired by a popular retro game, Worms.
It allows players to take turns and control squads of whimsical creatures, with the goal of eliminating other player's squad.

# Technology stack

HTML/CSS, TypeScript, Vite

## Compiling and testing

You can study `package.json` to determine the useful scripts available to you. The most important ones are: compilation, unit tests and local dev run.

Use the following console command to verify the changes compile successfully:
```
npx tsc -p tsconfig.json --noEmit
```
To validate the tests are still passing after making changes, use `npm run test:run`, which will run the test suite once, using vitest.

If the `npm run dev` script is launched, the changes will be reflected in the web app, available for the Browser tool to test and / or screenshot.


# Coding Conventions

## Typescript

Use descriptive, but not too verbose variable names. Examples: `files` instead of `f`, `updatedRecords` instead of `updated`, but avoid having more than 2-3 words in an identifier. Exceptions could be `i`,`j` or `x`,`y` for some clear integer loops or math / coordinate calculations.

Try to keep files under 500 lines. Larger files usually are a code smell: maybe a class has too many responsibilities? Can this function be refactored into several more focused ones? Is something hardcoded, while the abstraction can be elevated, and a more elegant solution suggested.

Avoid using 'any' and similar type hacks. Always try to establish the reason behind compiler errors and look for the way to carefully alter the applications types to satisfy the requirements.

Comments should be kept to a minimum. Prefer code readability and clean structure instead. Never add a comment to an already descriptively named function or type. Avoid commenting on a tricky block of code: prefer extracting it into a clearly named function, method or a class.

## Game architecture

- The frame loop lives in [src/game.ts](src/game.ts); it owns input handling, physics updates, and rendering.
- Turn state, charge timing, and weapon selection are encapsulated by [src/game-state.ts](src/game-state.ts). Extend it rather than scattering turn bookkeeping.
- Entities under [src/entities/](src/entities/) are mutable classes updated each frame. Prefer methods on those classes over sprawling helper functions.
- Rendering helpers in [src/rendering/](src/rendering/) should stay pure with respect to game state: pass everything needed as parameters and keep DOM interactions centralized in `Game`.
- Input glue and overlays live under [src/ui/](src/ui/); keep UI-specific state there.

## Unit tests

- Framework and commands: Vitest is configured. Run tests with:
  - Watch: `npm run test`
  - CI (single run): `npm run test:run`
- Tests can live under `src/__tests__/` or alongside the code they exercise. Favor deterministic setups so physics and timing assertions remain stable across runs.
