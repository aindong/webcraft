# ⚔️ Webcraft — Realm of War

**Play it: https://webcraft-sage.vercel.app**

A classic-style god-game / RTS city builder playable in the browser, in the
spirit of the genre's golden age: gather gold and lumber, raise a town,
train an army, and raze your enemy's base — complete with chirpy unit
voice acknowledgements ("Work complete!").

**Zero runtime dependencies.** Sound effects are synthesized with Web Audio
and unit voices use the browser's built-in speech synthesis. Entity art is
AI-painted in a cute chibi style (generated with gpt-image-2 via Higgsfield,
backgrounds removed, served from `public/assets/sprites/`). Units are
**animated from 2×2 spritesheets** — idle, two walk strides, and an attack
pose, sliced and frame-aligned at load. Terrain and UI remain procedurally
drawn. **Every sprite has a procedural canvas-drawn fallback** — delete the
assets directory and the game still runs with the original programmer art.

## Play

```bash
npm install
npm run dev      # → http://localhost:5173
```

```bash
npm test         # headless simulation test suite
npm run build    # production build to dist/
```

## Features

- **Two races** — Humans of the Vale and Orcs of the Ashfang Horde, each with
  their own buildings, units, and vocal personality (orcs are low and gruff,
  humans bright and brisk). Races are data-defined in `src/sim/data.ts`;
  adding a third is a data change, not a code change.
- **Economy** — peasants/peons mine gold from mines (they walk inside and
  emerge carrying a sack) and chop trees tile-by-tile until the forest
  recedes. Resources are delivered to your town hall. Lumberjacks find the
  next tree on their own — even when a whole grove runs out — and builders
  walk to your next unfinished blueprint when theirs completes.
- **Building & upgrading** — houses raise your food cap (House → Manor),
  barracks unlock stronger units as they level (Barracks II unlocks Archers,
  III unlocks Knights), town halls upgrade to Keep → Castle, and watch
  towers shoot at attackers.
- **Training** — production queues with progress bars, cancel-refunds, and
  rally points (right-click with a building selected). Every command-card
  button shows a tooltip with full stats, costs, and what an upgrade unlocks.
- **Combat** — attack-move (A + click), auto-aggro, worker retaliation,
  ranged and melee units, "under attack!" alerts.
- **Fog of war** — unexplored darkness, explored-but-dim memory, live vision.
- **AI opponents** — 1–3 of them, easy/normal/hard, with real build orders:
  they expand their economy, build supply ahead of demand, upgrade
  production, and attack in escalating waves. Hard AI cheats a little, as
  is tradition.
- **Voices** — every command is acknowledged ("Yes, milord?", "Me go.") via
  the Web Speech API with per-race pitch and rate. M mutes SFX, V mutes voices.

## Controls

| Input | Action |
| --- | --- |
| Left-click / drag | Select unit / box-select |
| Right-click | Smart command: move, harvest, attack, set rally |
| A + click | Attack-move |
| S | Stop |
| Ctrl+1–9 / 1–9 | Set / recall control group |
| WASD-arrows / screen edge | Pan camera |
| Mouse wheel | Zoom |
| H | Help overlay |
| Esc | Cancel placement / deselect |

## Architecture (multiplayer-ready by design)

The simulation (`src/sim/`) is a **deterministic fixed-timestep lockstep
core**: given the same seed and the same command stream, every machine
computes the identical match, tick for tick (verified by hash in the test
suite). All mutation flows through serializable `Command` objects — the
human UI and the AI controllers use the exact same queue. This is the
architecture lockstep multiplayer needs: to play online, ship each tick's
commands over a websocket instead of applying them locally. Nothing in the
sim knows whether a player is a human, an AI, or a remote peer.

```
src/
  sim/        deterministic game logic — no DOM, no audio, fully headless
    data.ts        races / units / buildings (all content lives here)
    state.ts       GameState, entities, map, state hashing
    commands.ts    the only mutation pathway (move/build/train/upgrade/…)
    sim.ts         the tick: production, construction, movement, combat
    pathfinding.ts A* with corner-cut prevention, deterministic tie-breaks
    mapgen.ts      procedural maps: forests, ponds, mines, start towns
    ai.ts          AI controller — emits Commands like any other player
  render/     isometric canvas renderer, sprite atlas (AI images + procedural
              fallback in assets.ts/sprites.ts), fog, minimap
  audio/      Web Audio synth SFX + speech-synthesis unit voices
  ui/         DOM HUD (command card, selection, alerts) + menus
  game.ts     fixed-timestep loop, input, sim-event → presentation wiring
tests/        headless sim suite: determinism, economy, combat, AI, victory
```

The renderer interpolates entity positions between sim ticks, so the game
animates at display refresh rate while the sim runs at 12 ticks/second.
