# Game AI Design (Wormish)

This document captures the agreed Game AI principles, strategies, and extension notes before coding.

## Goals

- Fun gameplay first; AI is one lever among many, and gameplay can evolve to support better AI-driven fun.
- All weapons are usable by AI.
- Explicit strategies for cinematic behavior and aim precision.
- Human-like timing and movement constraints.

## Core Turn Loop (High Level)

1) Gather state (worm, teams, terrain, weapon stats).
2) Decide target (personality-weighted heuristics).
3) Decide weapon (personality bias + situational scoring).
4) Evaluate candidate shots (ballistic sim + scoring).
5) Optional movement if no acceptable shot.
6) Execute with timing constraints and optional panic behavior.

## Scoring Function Overview

Each candidate action (weapon + angle + power + optional movement) is evaluated by a
scoring function. The AI simulates or estimates the outcome, extracts features
(damage, self-damage, water kill likelihood, splash proximity, etc), and combines
them into a single score. Personalities and strategies are weight presets that
change how those features are valued, allowing tuning without rewriting logic.

## Personalities (Per Worm)

Each worm has a personality; unassigned defaults to Generalist.

- Generalist: balanced weapon preferences, neutral risk.
- Marksman: favors finishing low HP, rifle and bazooka bias, lower risk.
- Demolisher: favors splash and multi-target damage, medium risk.
- Commando: favors close-range Uzi sprays, higher risk.

Notes:
- A per-worm personality is preferred over team-wide styles.
- Weapon preferences can be further tuned or tied to inventory later.

## Cinematic Strategy (Explicit Strategy Flag)

Cinematic behavior should be an explicit, named strategy that is easy to locate and tune.
It can be chosen by a small probability or triggered when no high-quality shot exists.

Measurable cinematic goals:
- Arc over cover: apex above the highest terrain point between shooter and target.
- Splash intent: impact within splash radius of target even if a direct hit is unlikely.
- Water kill attempts: if a knock-in is plausible.

The instadeath (water kill) check can be part of the cinematic bias.

## Aim Precision Strategy (Explicit Strategy Flag)

Aim precision is its own strategy that can be iterated independently.

- Baseline: exact ballistic sim over a fixed candidate set.
- Precision dial (internal): introduce noise or weighted randomness over top-K shots.
- Randomness approach: pick from top-K shots with a weighted roll, then add slight
  angle/power noise.

Hidden weapon stats (splash radius, Uzi cutoff, fuse time) are available to the AI.
If this makes AI too strong, offset with the precision dial.

## Timing and Movement Constraints

- Minimum pre-shot delay: 1.0s (tweakable).
- Human-like movement: avoid micro-taps; use discrete movement chunks (e.g. walk
  for 200-300 ms, optional jump).
- Panic behavior: if time is low and no good shot exists, fire a quick desperate shot.

## Movement Fallback + Re-Planning (Implemented)

When no viable shot can be found from the current position, the AI should not
immediately fire a "zero-score" shot (which often looks like shooting at its own feet).
Instead, it:

- Walks toward the selected target in 200-300ms chunks (with a simple "stuck => jump" heuristic).
- Re-evaluates shots after movement (same scoring + candidate generation).
- Stops once it finds a shot with a positive score, or once a movement budget is exhausted.

To avoid spending the entire turn walking, movement is capped by a fixed budget
(a few seconds) and also respects the remaining turn time.

If movement fails to create a viable shot, the AI falls back to a quick desperation
shot as comic relief. This shot is clamped to never aim downward.

## Trickster Check (Folded Into Cinematic)

No fall damage is in scope today (aside from water instadeath), so a full Trickster
personality is not viable. Instead, perform a per-turn check for instadeath or
cinematic opportunities.

## Debug API + World Generation Extensions (Proposed)

Extend DebugApi to support AI testing and E2E:

- Read and assign per-worm personality.
- New entry point:
  - team.playTurnWithGameAI({ settings })
  - Uses the currently active worm and its personality.

Extend world generation and debug helpers to create targeted E2E scenarios:

- Scenario hooks to force a high cinematic or instadeath bias for a test run.
- Generation knobs to place a worm on a ledge/chasm for water-kill validation.

E2E scenario examples:

- Instadeath bias: spawn a target worm on a narrow ledge near water, set cinematic\n  bias high, and verify AI prefers knock-in attempts.\n- No-shot fallback: spawn both teams separated by a tall ridge, confirm AI chooses\n  a movement action instead of firing.\n- Panic shot: shrink remaining turn time and verify a quick last-second bazooka\n  is attempted.

## Open Follow-ups

- Finalize weapon scoring function and candidate shot generation.
- Decide if Generalist uses a small cinematic chance by default.
- Define exact panic timing window and behavior.
