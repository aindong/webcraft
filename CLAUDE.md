# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Vite dev server (default port 5173)
npm test             # headless sim test suite (vitest)
npx vitest run -t "determinism"   # run tests matching a name
npm run build        # tsc --noEmit + vite build → dist/
```

There is no lint setup; `tsc --noEmit` (strict, noUnusedLocals) is the gate.

## What this is

A Warcraft-style isometric RTS playable in the browser. Single-player vs AI today, but the core is deliberately structured for lockstep multiplayer later. No runtime npm dependencies — rendering is raw Canvas 2D, SFX are Web Audio synth patches, unit voices are the Web Speech API, and background music is a generative Web Audio loop (`audio/music.ts`). Browsers gate audio behind a user gesture: `game.ts` unlocks the AudioContext and starts music on the first pointerdown/keydown — don't remove that handler.

## Architecture: the determinism contract

The single most important invariant: **`src/sim/` is a deterministic, headless, fixed-timestep simulation** (12 ticks/s, `TICKS_PER_SECOND` in `state.ts`). Given the same seed and command stream, every machine must compute bit-identical state — `hashState()` in `state.ts` hashes float bits and the map to verify this, and `tests/sim.test.ts` enforces it. This is the lockstep-multiplayer contract; breaking it silently is the worst regression possible here.

Rules inside `src/sim/`:
- Never use `Math.random()` — only `state.rng` (seeded mulberry32 in `core/rng.ts`).
- Never use `Date.now()`/`performance.now()` — sim time is `state.tick`.
- Iterate entities in deterministic order (`orderedEntities()`); pairwise effects like unit separation break ties by entity id.
- No DOM, no audio, no imports from `render/`, `ui/`, or `audio/`.
- Avoid transcendental functions in sim math (`Math.sin/cos` are implementation-dependent); `sqrt`/`atan2` only feed the render-hint `facing` field, which is not part of the hash.

**All mutation flows through `Command` objects** (`sim/commands.ts`). The human UI (`game.ts`) and the AI (`sim/ai.ts`) both just push serializable commands into the same per-tick queue consumed by `step()` in `sim/sim.ts`. The AI is "just another player controller" — nothing in the sim knows a player is AI. Online MP later means shipping commands over a socket, not changing the sim. (Known impurity: hard-AI's resource trickle mutates state in `aiThink`, but it runs inside the tick loop so determinism holds — the AI determinism test covers it.)

The sim communicates outward via `EventBus` (`core/events.ts`): `step()` emits `SimEvent`s (buildComplete, attackSwing, underAttack…), and `game.ts` drains them each tick to drive SFX, voices, floating text, and effects. Presentation never reaches into the sim mid-tick.

## Tick loop vs render loop

`game.ts` owns the loop: accumulate real time → run whole sim ticks → render with interpolation alpha. Entities carry `px/py` (previous tick position); the renderer lerps for 60fps motion. Fog of war (`render/fog.ts`) is computed render-side from the local player's units — the sim is fog-agnostic and the AI doesn't respect fog (classic cheating AI).

## Content is data

Races, units, buildings (costs, HP, train lists, upgrade levels, voice lines) all live in `sim/data.ts`. Adding a race/unit is a data change plus art; gameplay code reads defs by id. Building level gates (`requiresLevel`) drive what a barracks can train per upgrade level.

## Art pipeline (two layers, fallback required)

`render/sprites.ts` procedurally bakes every sprite to offscreen canvases — this is the guaranteed fallback. `render/assets.ts` loads AI-painted PNGs from `public/assets/sprites/`:

- **Statics** (`<type>.png`): buildings, tree, goldmine — auto-cropped to opaque bounds at load.
- **Unit sheets** (`<type>_sheet.png`): a 4-column × 2-row grid — row 1 is a 4-frame walk cycle, row 2 is idle + attack windup/strike/follow-through. `sliceSheet()` cuts the cells and crops all eight with one *union* bounding box so frames don't jitter. The renderer cycles walk frames while moving (`WALK_FRAME_MS`, offset by entity id so groups don't march in lockstep) and plays the 3-frame attack across `STRIKE_FRAME_MS` after a swing (tracked render-side in `Renderer.strikeAt`, since `e.striking` is only true on the swing tick). **Painted sheets face LEFT, procedural sprites face RIGHT** — the mirror logic in `drawEntity` flips on opposite conditions; getting this wrong makes units moonwalk.

**Any new entity type must work with the procedural path alone** — the game must run with `public/assets/sprites/` deleted.

Art style is **cute chibi** (big heads, rounded shapes, thick outlines, bright colors — "cozy mobile strategy game"). Assets were generated with gpt-image-2 via the user's Higgsfield MCP connection: prompt on a *solid white background* (the model fakes "transparent" with a baked checkerboard — don't request transparency), then Higgsfield `remove_background`, then resize to 512px. For unit sheets, prompt "the EXACT SAME character drawn 4 times in a precise 2x2 grid … no grid lines, no cell borders" — gpt-image-2 respects the grid layout reliably. Use jimp (`npm i --no-save jimp`) for resizing — sharp segfaults under WSL2. Painted sprites can't be team-tinted, so the renderer draws a player-color ellipse under units and badges for carried resources.

## Testing pattern

Tests run the sim headlessly: build a match with `createMatch()`, feed commands at specific ticks, `step()` in a loop, assert on state/events. No DOM mocking needed for sim work — keep it that way by keeping sim pure. UI/renderer have no test coverage; verify visually (`window.__game` is exposed in dev for browser-automation poking, e.g. `__game.pendingCommands.push({kind:'harvest', ...})`).

## Voice/copyright note

All voice lines are original, written in the spirit of the classics ("Work complete!", "Yes, milord?"). Do not copy actual Blizzard lines or assets.
