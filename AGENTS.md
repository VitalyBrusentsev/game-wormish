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