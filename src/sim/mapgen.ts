/**
 * Procedural map generation: a grassy field ringed with forests, gold mines
 * near each start location plus contested center mines, and a starting town
 * hall + workers per player.
 */
import { Rng } from '../core/rng';
import {
  GameMap, GameState, Player, T_DIRT, T_GRASS, T_WATER,
  TICKS_PER_SECOND, spawnBuilding, spawnGoldMine, spawnUnit,
} from './state';
import { raceDef } from './data';
import { EventBus } from '../core/events';

export interface PlayerSetup {
  name: string;
  race: string;
  color: string;
  isAI: boolean;
  aiDifficulty?: 'easy' | 'normal' | 'hard';
}

export interface MatchConfig {
  seed: number;
  mapSize: number;
  players: PlayerSetup[];
}

const START_GOLD = 600;
const START_WOOD = 350;
const MINE_GOLD = 12000;

function blankMap(size: number): GameMap {
  return {
    width: size,
    height: size,
    terrain: new Uint8Array(size * size),
    trees: new Uint16Array(size * size),
    occupied: new Int32Array(size * size),
  };
}

/** Start corners for up to 4 players, in tile coords (top-left of hall). */
function startSpots(size: number, count: number): { x: number; y: number }[] {
  const m = Math.floor(size * 0.14);
  const spots = [
    { x: m, y: m },
    { x: size - m - 3, y: size - m - 3 },
    { x: size - m - 3, y: m },
    { x: m, y: size - m - 3 },
  ];
  return spots.slice(0, count);
}

export function generateMap(state: GameState, config: MatchConfig): void {
  const { map, rng } = state;
  const size = map.width;

  // --- terrain: grass with dirt patches and a few ponds ---
  for (let i = 0; i < size * size; i++) map.terrain[i] = T_GRASS;

  const dirtPatches = Math.floor(size / 8);
  for (let p = 0; p < dirtPatches; p++) {
    const cx = rng.int(4, size - 5), cy = rng.int(4, size - 5);
    const r = rng.int(2, 4);
    stamp(map, cx, cy, r, (i) => { map.terrain[i] = T_DIRT; });
  }

  const ponds = Math.floor(size / 20);
  const spots = startSpots(size, config.players.length);
  for (let p = 0; p < ponds; p++) {
    const cx = rng.int(8, size - 9), cy = rng.int(8, size - 9);
    // keep ponds away from start areas
    if (spots.some((s) => Math.hypot(s.x + 1.5 - cx, s.y + 1.5 - cy) < 16)) continue;
    const r = rng.int(2, 3);
    stamp(map, cx, cy, r, (i) => { map.terrain[i] = T_WATER; });
  }

  // --- forests: border ring + interior clusters ---
  const woodPerTree = 100;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
      if (edge < 2 || (edge < 4 && rng.next() < 0.6)) {
        const i = y * size + x;
        if (map.terrain[i] !== T_WATER) map.trees[i] = woodPerTree;
      }
    }
  }
  const clusters = Math.floor(size / 4);
  for (let c = 0; c < clusters; c++) {
    const cx = rng.int(6, size - 7), cy = rng.int(6, size - 7);
    if (spots.some((s) => Math.hypot(s.x + 1.5 - cx, s.y + 1.5 - cy) < 10)) continue;
    const r = rng.int(1, 3);
    stamp(map, cx, cy, r, (i) => {
      if (map.terrain[i] !== T_WATER && rng.next() < 0.8) map.trees[i] = woodPerTree;
    });
  }

  // --- players, halls, mines, workers ---
  config.players.forEach((setup, idx) => {
    const player: Player = {
      id: idx,
      name: setup.name,
      race: setup.race,
      color: setup.color,
      gold: START_GOLD,
      wood: START_WOOD,
      isAI: setup.isAI,
      aiDifficulty: setup.aiDifficulty ?? 'normal',
      defeated: false,
      lastAttackAlert: -9999,
    };
    state.players.push(player);

    const spot = spots[idx];
    clearArea(map, spot.x - 4, spot.y - 4, spot.x + 8, spot.y + 8);

    const race = raceDef(setup.race);
    spawnBuilding(state, idx, race.townHall, spot.x, spot.y, { complete: true });

    // mine offset toward map center so it's never inside the border forest
    const cx = size / 2;
    const mx = spot.x + (spot.x < cx ? 7 : -7);
    const my = spot.y + (spot.y < cx ? 6 : -6);
    clearArea(map, mx - 1, my - 1, mx + 4, my + 4);
    spawnGoldMine(state, mx, my, MINE_GOLD);

    // starting workers below the hall
    for (let w = 0; w < 4; w++) {
      spawnUnit(state, idx, race.worker, spot.x + w, spot.y + 4.5);
    }
  });

  // contested center mine
  const c = Math.floor(size / 2) - 1;
  clearArea(map, c - 2, c - 2, c + 5, c + 5);
  spawnGoldMine(state, c, c, MINE_GOLD * 1.5);
}

function stamp(map: GameMap, cx: number, cy: number, r: number, fn: (i: number) => void): void {
  for (let y = Math.max(0, cy - r); y <= Math.min(map.height - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(map.width - 1, cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) fn(y * map.width + x);
    }
  }
}

function clearArea(map: GameMap, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = Math.max(0, y0); y < Math.min(map.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(map.width, x1); x++) {
      const i = y * map.width + x;
      map.trees[i] = 0;
      if (map.terrain[i] === T_WATER) map.terrain[i] = T_GRASS;
    }
  }
}

export function createMatch(config: MatchConfig): { state: GameState; events: EventBus } {
  const state: GameState = {
    tick: 0,
    tps: TICKS_PER_SECOND,
    seed: config.seed,
    rng: new Rng(config.seed),
    map: blankMap(config.mapSize),
    players: [],
    entities: new Map(),
    nextEntityId: 1,
    winner: null,
  };
  generateMap(state, config);
  return { state, events: new EventBus() };
}
