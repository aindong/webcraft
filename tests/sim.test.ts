import { describe, expect, it } from 'vitest';
import { EventBus, SimEvent } from '../src/core/events';
import { resetAiMemory, aiThink } from '../src/sim/ai';
import { Command, canPlaceBuilding, foodCap, foodUsed } from '../src/sim/commands';
import { createMatch, MatchConfig } from '../src/sim/mapgen';
import { findPath } from '../src/sim/pathfinding';
import { step } from '../src/sim/sim';
import {
  Entity, GameState, hashState, spawnBuilding, spawnUnit, T_WATER, TICKS_PER_SECOND,
} from '../src/sim/state';

function testConfig(overrides: Partial<MatchConfig> = {}): MatchConfig {
  return {
    seed: 12345,
    mapSize: 56,
    players: [
      { name: 'P1', race: 'human', color: '#3b6fe0', isAI: false },
      { name: 'P2', race: 'orc', color: '#d03b3b', isAI: false },
    ],
    ...overrides,
  };
}

function run(state: GameState, events: EventBus, ticks: number, commandsAt: Map<number, Command[]> = new Map()): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    const cmds = commandsAt.get(state.tick) ?? [];
    step(state, events, cmds);
    all.push(...events.drain());
  }
  return all;
}

function findOwn(state: GameState, player: number, pred: (e: Entity) => boolean): Entity {
  for (const e of state.entities.values()) {
    if (e.owner === player && pred(e)) return e;
  }
  throw new Error('entity not found');
}

function workers(state: GameState, player: number): Entity[] {
  return [...state.entities.values()].filter(
    (e) => e.owner === player && !e.isBuilding && (e.type === 'peasant' || e.type === 'peon'),
  );
}

describe('map generation', () => {
  it('creates a hall, 4 workers, and a mine per player', () => {
    const { state } = createMatch(testConfig());
    expect(workers(state, 0)).toHaveLength(4);
    expect(workers(state, 1)).toHaveLength(4);
    expect(() => findOwn(state, 0, (e) => e.type === 'townhall')).not.toThrow();
    expect(() => findOwn(state, 1, (e) => e.type === 'greathall')).not.toThrow();
    const mines = [...state.entities.values()].filter((e) => e.type === 'goldmine');
    expect(mines.length).toBeGreaterThanOrEqual(3);
  });

  it('is deterministic for a given seed', () => {
    const a = createMatch(testConfig());
    const b = createMatch(testConfig());
    expect(hashState(a.state)).toBe(hashState(b.state));
    const c = createMatch(testConfig({ seed: 999 }));
    expect(hashState(c.state)).not.toBe(hashState(a.state));
  });
});

describe('determinism', () => {
  it('identical seeds + identical commands produce identical states', () => {
    const mkCommands = (state: GameState): Map<number, Command[]> => {
      const ws = workers(state, 0);
      const mine = [...state.entities.values()].find((e) => e.type === 'goldmine')!;
      const hall = findOwn(state, 0, (e) => e.type === 'townhall');
      const m = new Map<number, Command[]>();
      m.set(0, [
        { kind: 'harvest', player: 0, units: ws.map((w) => w.id), target: mine.id },
        { kind: 'train', player: 0, building: hall.id, unit: 'peasant' },
      ]);
      m.set(40, [{ kind: 'move', player: 1, units: workers(state, 1).map((w) => w.id), x: 28, y: 28 }]);
      return m;
    };

    const a = createMatch(testConfig());
    run(a.state, a.events, 600, mkCommands(a.state));

    const b = createMatch(testConfig());
    run(b.state, b.events, 600, mkCommands(b.state));

    expect(hashState(a.state)).toBe(hashState(b.state));
  });

  it('AI play is deterministic too', () => {
    const cfg = testConfig({
      players: [
        { name: 'A', race: 'human', color: '#3b6fe0', isAI: true, aiDifficulty: 'normal' },
        { name: 'B', race: 'orc', color: '#d03b3b', isAI: true, aiDifficulty: 'normal' },
      ],
    });
    const runAi = () => {
      resetAiMemory();
      const { state, events } = createMatch(cfg);
      for (let i = 0; i < 800; i++) {
        const cmds: Command[] = [];
        for (const p of state.players) {
          if (p.isAI && !p.defeated) cmds.push(...aiThink(state, p.id));
        }
        step(state, events, cmds);
        events.drain();
      }
      return hashState(state);
    };
    expect(runAi()).toBe(runAi());
  });
});

describe('pathfinding', () => {
  it('routes around water', () => {
    const { state } = createMatch(testConfig());
    const map = state.map;
    // clear a corridor, then carve a wall of water across it with one gap
    for (let y = 8; y < 22; y++) {
      for (let x = 20; x < 32; x++) {
        const i = y * map.width + x;
        map.terrain[i] = 0;
        map.trees[i] = 0;
        map.occupied[i] = 0;
      }
    }
    for (let y = 10; y < 20; y++) {
      map.terrain[y * map.width + 25] = T_WATER;
    }
    map.terrain[15 * map.width + 25] = 0; // gap
    const walk = (x: number, y: number) => {
      const i = y * map.width + x;
      return map.terrain[i] !== T_WATER && map.trees[i] === 0 && map.occupied[i] === 0;
    };
    const path = findPath(map, 22.5, 15.5, 28.5, 15.5, walk);
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
    const last = path![path!.length - 1];
    expect(Math.abs(last.x - 28.5)).toBeLessThan(1);
    // every step is walkable
    for (const wp of path!) {
      expect(walk(Math.floor(wp.x), Math.floor(wp.y))).toBe(true);
    }
  });

  it('returns a best-effort path toward unreachable goals', () => {
    const { state } = createMatch(testConfig());
    // goal inside the border forest (blocked)
    const path = findPath(state.map, 10.5, 10.5, 0.5, 0.5, (x, y) => {
      const i = y * state.map.width + x;
      return state.map.terrain[i] !== T_WATER && state.map.trees[i] === 0 && state.map.occupied[i] === 0;
    });
    expect(path).not.toBeNull(); // moves as close as it can
  });
});

describe('economy', () => {
  it('workers mine gold and deliver it to the hall', () => {
    const { state, events } = createMatch(testConfig());
    const hall = findOwn(state, 0, (e) => e.type === 'townhall');
    const mine = [...state.entities.values()]
      .filter((e) => e.type === 'goldmine')
      .sort((a, b) => Math.hypot(a.x - hall.x, a.y - hall.y) - Math.hypot(b.x - hall.x, b.y - hall.y))[0];
    const ws = workers(state, 0);
    const goldBefore = state.players[0].gold;
    const cmds = new Map<number, Command[]>([
      [0, [{ kind: 'harvest', player: 0, units: ws.map((w) => w.id), target: mine.id } as Command]],
    ]);
    const evs = run(state, events, TICKS_PER_SECOND * 60, cmds);
    expect(state.players[0].gold).toBeGreaterThan(goldBefore);
    expect(evs.some((e) => e.kind === 'resourceDelivered' && e.resource === 'gold')).toBe(true);
  });

  it('workers chop trees and deliver wood', () => {
    const { state, events } = createMatch(testConfig());
    const ws = workers(state, 0);
    // find a reachable tree near the worker
    const w0 = ws[0];
    let tree: { x: number; y: number } | null = null;
    const map = state.map;
    outer: for (let r = 1; r < 30; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = Math.floor(w0.x) + dx, y = Math.floor(w0.y) + dy;
          if (x < 1 || y < 1 || x >= map.width - 1 || y >= map.height - 1) continue;
          if (map.trees[y * map.width + x] > 0) {
            tree = { x, y };
            break outer;
          }
        }
      }
    }
    expect(tree).not.toBeNull();
    const woodBefore = state.players[0].wood;
    const cmds = new Map<number, Command[]>([
      [0, [{ kind: 'harvest', player: 0, units: ws.map((w) => w.id), tx: tree!.x, ty: tree!.y } as Command]],
    ]);
    run(state, events, TICKS_PER_SECOND * 60, cmds);
    expect(state.players[0].wood).toBeGreaterThan(woodBefore);
  });

  it('workers keep chopping distant trees after the local grove is gone', () => {
    const { state, events } = createMatch(testConfig());
    const map = state.map;
    const w0 = workers(state, 0)[0];
    const wx = Math.floor(w0.x), wy = Math.floor(w0.y);
    // strip every tree, then plant a tiny near tree and a rich far one
    map.trees.fill(0);
    const findClear = (cx: number, cy: number): { x: number; y: number } => {
      for (let r = 0; r < 10; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x < 1 || y < 1 || x >= map.width - 1 || y >= map.height - 1) continue;
            const i = y * map.width + x;
            if (map.terrain[i] !== T_WATER && map.occupied[i] === 0) return { x, y };
          }
        }
      }
      throw new Error('no clear tile');
    };
    const near = findClear(wx + 3, wy);
    const far = findClear(wx + 14, wy + 14);
    map.trees[near.y * map.width + near.x] = 2; // one chop and it's gone
    map.trees[far.y * map.width + far.x] = 100; // > 6 tiles away: outside the local search
    const cmds = new Map<number, Command[]>([
      [0, [{ kind: 'harvest', player: 0, units: [w0.id], tx: near.x, ty: near.y } as Command]],
    ]);
    run(state, events, TICKS_PER_SECOND * 90, cmds);
    // only by walking to the far tree can the worker bank a full 10-wood trip
    expect(state.players[0].wood).toBeGreaterThanOrEqual(10);
    expect(map.trees[far.y * map.width + far.x]).toBeLessThan(100);
  });
});

describe('training & construction', () => {
  it('trains a peasant: deducts gold, consumes food, spawns the unit', () => {
    const { state, events } = createMatch(testConfig());
    const hall = findOwn(state, 0, (e) => e.type === 'townhall');
    const goldBefore = state.players[0].gold;
    const countBefore = workers(state, 0).length;
    const cmds = new Map<number, Command[]>([
      [0, [{ kind: 'train', player: 0, building: hall.id, unit: 'peasant' } as Command]],
    ]);
    const evs = run(state, events, TICKS_PER_SECOND * 15, cmds);
    expect(state.players[0].gold).toBe(goldBefore - 75);
    expect(workers(state, 0).length).toBe(countBefore + 1);
    expect(evs.some((e) => e.kind === 'trainComplete')).toBe(true);
  });

  it('rejects training beyond the food cap', () => {
    const { state, events } = createMatch(testConfig());
    const hall = findOwn(state, 0, (e) => e.type === 'townhall');
    state.players[0].gold = 100000;
    const cap = foodCap(state, 0);
    const room = cap - foodUsed(state, 0);
    const cmds: Command[] = [];
    for (let i = 0; i < room + 3; i++) {
      cmds.push({ kind: 'train', player: 0, building: hall.id, unit: 'peasant' });
    }
    run(state, events, 1, new Map([[0, cmds]]));
    expect(hall.trainQueue.length).toBe(room); // extras rejected
  });

  it('workers construct a building which then provides food', () => {
    const { state, events } = createMatch(testConfig());
    const ws = workers(state, 0);
    const hall = findOwn(state, 0, (e) => e.type === 'townhall');
    const capBefore = foodCap(state, 0);
    // find a placeable spot near the hall
    let spot: { x: number; y: number } | null = null;
    outer: for (let r = 3; r < 12; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = Math.floor(hall.x) + dx, y = Math.floor(hall.y) + dy;
          if (canPlaceBuilding(state, 'house', x, y)) {
            spot = { x, y };
            break outer;
          }
        }
      }
    }
    expect(spot).not.toBeNull();
    const cmds = new Map<number, Command[]>([
      [0, [{ kind: 'build', player: 0, workers: ws.map((w) => w.id), building: 'house', tx: spot!.x, ty: spot!.y } as Command]],
    ]);
    const evs = run(state, events, TICKS_PER_SECOND * 60, cmds);
    expect(evs.some((e) => e.kind === 'buildComplete')).toBe(true);
    expect(foodCap(state, 0)).toBe(capBefore + 4);
  });

  it('builders move on to the next construction site automatically', () => {
    const { state, events } = createMatch(testConfig());
    const ws = workers(state, 0);
    const hall = findOwn(state, 0, (e) => e.type === 'townhall');
    state.players[0].gold = 10000;
    state.players[0].wood = 10000;
    const spots: { x: number; y: number }[] = [];
    outer: for (let r = 3; r < 14; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = Math.floor(hall.x) + dx, y = Math.floor(hall.y) + dy;
          if (!canPlaceBuilding(state, 'house', x, y)) continue;
          if (spots.some((s) => Math.abs(s.x - x) < 3 && Math.abs(s.y - y) < 3)) continue;
          spots.push({ x, y });
          if (spots.length === 2) break outer;
        }
      }
    }
    expect(spots).toHaveLength(2);
    // workers are ordered to site 1 only; site 2 is a bare blueprint
    const second = spawnBuilding(state, 0, 'house', spots[1].x, spots[1].y);
    const cmds = new Map<number, Command[]>([
      [0, [{ kind: 'build', player: 0, workers: ws.map((w) => w.id), building: 'house', tx: spots[0].x, ty: spots[0].y } as Command]],
    ]);
    const evs = run(state, events, TICKS_PER_SECOND * 120, cmds);
    const completes = evs.filter((e) => e.kind === 'buildComplete');
    expect(completes.length).toBe(2);
    expect(second.buildRemaining).toBe(0);
  });

  it('upgrades a building to the next level', () => {
    const { state, events } = createMatch(testConfig());
    const hall = findOwn(state, 0, (e) => e.type === 'townhall');
    state.players[0].gold = 10000;
    state.players[0].wood = 10000;
    const cmds = new Map<number, Command[]>([
      [0, [{ kind: 'upgrade', player: 0, building: hall.id } as Command]],
    ]);
    const evs = run(state, events, TICKS_PER_SECOND * 50, cmds);
    expect(hall.level).toBe(2);
    expect(evs.some((e) => e.kind === 'upgradeComplete')).toBe(true);
    expect(hall.maxHp).toBe(1600);
  });
});

describe('combat & victory', () => {
  it('a grunt defeats a lone peasant', () => {
    const { state, events } = createMatch(testConfig());
    const grunt = spawnUnit(state, 1, 'grunt', 30, 30);
    const peasant = spawnUnit(state, 0, 'peasant', 31, 30);
    const cmds = new Map<number, Command[]>([
      [0, [{ kind: 'attack', player: 1, units: [grunt.id], target: peasant.id } as Command]],
    ]);
    run(state, events, TICKS_PER_SECOND * 30, cmds);
    expect(state.entities.has(peasant.id)).toBe(false);
    expect(state.entities.has(grunt.id)).toBe(true);
  });

  it('destroying all buildings defeats the player and ends the game', () => {
    const { state, events } = createMatch(testConfig());
    // give P0 an army next to P1's hall and remove P1's ability to matter
    const hall1 = findOwn(state, 1, (e) => e.type === 'greathall');
    const army = Array.from({ length: 8 }, (_, i) =>
      spawnUnit(state, 0, 'knight', hall1.x - 4 + (i % 4), hall1.y - 4 + Math.floor(i / 4)),
    );
    // kill P1's workers so they can't fight back meaningfully
    for (const w of workers(state, 1)) state.entities.delete(w.id);

    const cmds = new Map<number, Command[]>([
      [0, [{ kind: 'attack', player: 0, units: army.map((a) => a.id), target: hall1.id } as Command]],
    ]);
    const evs = run(state, events, TICKS_PER_SECOND * 120, cmds);
    expect(evs.some((e) => e.kind === 'playerDefeated' && e.player === 1)).toBe(true);
    expect(evs.some((e) => e.kind === 'victory' && e.player === 0)).toBe(true);
    expect(state.winner).toBe(0);
  });
});

describe('AI', () => {
  it('builds an economy: trains workers and gathers resources', () => {
    resetAiMemory();
    const cfg = testConfig({
      players: [
        { name: 'AI', race: 'orc', color: '#d03b3b', isAI: true, aiDifficulty: 'normal' },
        { name: 'Dummy', race: 'human', color: '#3b6fe0', isAI: false },
      ],
    });
    const { state, events } = createMatch(cfg);
    const workersBefore = workers(state, 0).length;
    for (let i = 0; i < TICKS_PER_SECOND * 120; i++) {
      const cmds: Command[] = [];
      if (!state.players[0].defeated) cmds.push(...aiThink(state, 0));
      step(state, events, cmds);
      events.drain();
    }
    expect(workers(state, 0).length).toBeGreaterThan(workersBefore);
    // it should have spent and re-earned: gathered something
    const totalRes = state.players[0].gold + state.players[0].wood;
    expect(totalRes).toBeGreaterThan(0);
    // built at least one extra building (hut or war camp)
    const buildings = [...state.entities.values()].filter((e) => e.owner === 0 && e.isBuilding);
    expect(buildings.length).toBeGreaterThan(1);
  });
});
