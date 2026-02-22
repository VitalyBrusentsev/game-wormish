# Sound system (Wormish)

## Decisions

- **Web Audio + hybrid sources**: SFX are synthesized with oscillators/noise, and background music is streamed from `src/assets/track1.mp3` into the music bus.
- **Single `AudioContext`, created on user gesture**: The audio context is only created/resumed via a user gesture (pointer/touch/keydown) to satisfy mobile autoplay policies.
- **Mixing via buses**: `sfx` and `music` buses feed a shared mix bus with a light compressor/limiter to keep multiple concurrent effects from clipping.
- **Stereo panning, camera-relative**: Each sound is spatialized in **1D (X only)** using `StereoPannerNode` and distance attenuation based on the camera center, updated every frame while the sound is alive.
- **No HRTF (for now)**: Web Audio also supports 3D/HRTF spatialization via `PannerNode` (HRTF = Head-Related Transfer Function). For a 2D side-view game, `StereoPannerNode` is simpler and cheaper and still reads well.
- **Network gameplay**: SFX are driven by simulation events that occur on both peers (turn commands are streamed; both sides execute the turn and emit the same combat events). No dedicated “sound packets” are required.

## Current event → SFX mapping

- `combat.projectile.spawned` → launch/shot sound (Rifle/Uzi/Bazooka/Grenade).
- `combat.projectile.exploded` → impact (Rifle/Uzi) or explosion (Bazooka/Grenade).
- `worm.killed` → short high-pitched comical “uh-oh” voice cue, spatialized to the worm X position.
- Background loop starts after the first user gesture unlock and plays through the `music` bus.

## Extension points

- Add UI later by calling `Game.setSoundEnabled(...)` / `Game.setSoundLevels(...)` and reading `Game.getSoundSnapshot()`.
- Add voices later by playing `AudioBufferSourceNode` (samples) into the same `music`/`sfx` bus graph.
