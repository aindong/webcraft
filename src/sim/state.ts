/**
 * The complete game state. Everything the simulation reads or writes lives
 * here — plain data, fully serializable, no DOM/audio references. A state
 * snapshot + the command log is sufficient to replay a match.
 */
import { Rng } from '../core/rng';
import { buildingDef, unitDef } from './data';

export type PlayerId = number;
export type EntityId = number;

export const NEUTRAL: PlayerId = -1;

// Terrain
export const T_GRASS = 0;
export const T_DIRT = 1;
export const T_WATER = 2;

export type OrderKind =
  | 'idle'
  | 'move'
  | 'attackMove'
  | 'attack'
  | 'harvest'
  | 'deliver'
  | 'build';

export interface Order {
  kind: OrderKind;
  /** destination for move/attackMove */
  x?: number;
  y?: number;
  /** target entity for attack/harvest(mine)/build */
  target?: EntityId;
  /** target tree tile for harvest(wood) */
  tx?: number;
  ty?: number;
  /** ticks spent gathering at the current node */
  gatherTicks?: number;
}

export interface TrainItem {
  unit: string;
  /** ticks remaining */
  remaining: number;
  total: number;
}

export interface Entity {
  id: EntityId;
  owner: PlayerId;
  /** unit or building def id, or 'goldmine' */
  type: string;
  isBuilding: boolean;
  /** world position in tile units (center) */
  x: number;
  y: number;
  /** previous tick position, for render interpolation */
  px: number;
  py: number;
  hp: number;
  maxHp: number;

  // --- units ---
  order: Order;
  /** job to return to after retaliating (workers interrupted mid-harvest) */
  resumeOrder: Order | null;
  path: { x: number; y: number }[] | null;
  pathIndex: number;
  /** attack cooldown in ticks */
  cooldown: number;
  carryType: 'gold' | 'wood' | null;
  carryAmount: number;
  /** render hint: radians of facing, derived from movement (not sim-critical) */
  facing: number;
  /** render hint: true while swinging */
  striking: boolean;
  /** ticks remaining hidden inside a gold mine */
  insideMine: number;

  // --- buildings ---
  level: number;
  size: number;
  /** ticks of construction remaining; 0 = complete */
  buildRemaining: number;
  buildTotal: number;
  trainQueue: TrainItem[];
  /** ticks remaining on level upgrade; 0 = not upgrading */
  upgradeRemaining: number;
  upgradeTotal: number;
  rallyX: number;
  rallyY: number;

  // --- gold mines ---
  goldLeft: number;
}

export interface Player {
  id: PlayerId;
  name: string;
  race: string;
  color: string;
  gold: number;
  wood: number;
  isAI: boolean;
  aiDifficulty: 'easy' | 'normal' | 'hard';
  defeated: boolean;
  /** throttle for "under attack" alerts (tick of last alert) */
  lastAttackAlert: number;
}

export interface GameMap {
  width: number;
  height: number;
  /** terrain type per tile */
  terrain: Uint8Array;
  /** wood remaining per tile; >0 means a tree blocks the tile */
  trees: Uint16Array;
  /** entity id occupying tile for pathing (buildings, mines), 0 = free */
  occupied: Int32Array;
}

export interface GameState {
  tick: number;
  /** sim ticks per second */
  tps: number;
  seed: number;
  rng: Rng;
  map: GameMap;
  players: Player[];
  entities: Map<EntityId, Entity>;
  nextEntityId: number;
  /** id of winning player once the game ends, else null */
  winner: PlayerId | null;
}

export const TICKS_PER_SECOND = 12;

export function secondsToTicks(s: number): number {
  return Math.max(1, Math.round(s * TICKS_PER_SECOND));
}

// ---------------------------------------------------------------------------
// Entity factory helpers
// ---------------------------------------------------------------------------

function baseEntity(state: GameState, owner: PlayerId, type: string, x: number, y: number): Entity {
  return {
    id: state.nextEntityId++,
    owner, type, isBuilding: false,
    x, y, px: x, py: y,
    hp: 1, maxHp: 1,
    order: { kind: 'idle' },
    resumeOrder: null,
    path: null, pathIndex: 0,
    cooldown: 0,
    carryType: null, carryAmount: 0,
    facing: 0, striking: false, insideMine: 0,
    level: 1, size: 1,
    buildRemaining: 0, buildTotal: 0,
    trainQueue: [],
    upgradeRemaining: 0, upgradeTotal: 0,
    rallyX: -1, rallyY: -1,
    goldLeft: 0,
  };
}

export function spawnUnit(state: GameState, owner: PlayerId, type: string, x: number, y: number): Entity {
  const def = unitDef(type);
  const e = baseEntity(state, owner, type, x, y);
  e.hp = def.hp;
  e.maxHp = def.hp;
  state.entities.set(e.id, e);
  return e;
}

export function spawnBuilding(
  state: GameState, owner: PlayerId, type: string, tx: number, ty: number,
  opts: { complete?: boolean } = {},
): Entity {
  const def = buildingDef(type);
  const e = baseEntity(state, owner, type, tx + def.size / 2, ty + def.size / 2);
  e.isBuilding = true;
  e.size = def.size;
  e.maxHp = def.levels[0].hp;
  e.buildTotal = secondsToTicks(def.buildTime);
  if (opts.complete) {
    e.hp = e.maxHp;
    e.buildRemaining = 0;
  } else {
    // buildings start at a sliver of HP and gain HP as construction advances
    e.hp = Math.max(1, Math.floor(e.maxHp * 0.1));
    e.buildRemaining = e.buildTotal;
  }
  e.rallyX = tx + def.size / 2;
  e.rallyY = ty + def.size + 0.5;
  state.entities.set(e.id, e);
  occupyFootprint(state.map, e, tx, ty);
  return e;
}

export function spawnGoldMine(state: GameState, tx: number, ty: number, gold: number): Entity {
  const e = baseEntity(state, NEUTRAL, 'goldmine', tx + 1.5, ty + 1.5);
  e.isBuilding = true;
  e.size = 3;
  e.hp = 25500;
  e.maxHp = 25500;
  e.goldLeft = gold;
  state.entities.set(e.id, e);
  occupyFootprint(state.map, e, tx, ty);
  return e;
}

export function occupyFootprint(map: GameMap, e: Entity, tx: number, ty: number): void {
  for (let dy = 0; dy < e.size; dy++) {
    for (let dx = 0; dx < e.size; dx++) {
      const x = tx + dx, y = ty + dy;
      if (x >= 0 && y >= 0 && x < map.width && y < map.height) {
        map.occupied[y * map.width + x] = e.id;
      }
    }
  }
}

export function clearFootprint(map: GameMap, e: Entity): void {
  const tx = Math.round(e.x - e.size / 2);
  const ty = Math.round(e.y - e.size / 2);
  for (let dy = 0; dy < e.size; dy++) {
    for (let dx = 0; dx < e.size; dx++) {
      const x = tx + dx, y = ty + dy;
      if (x >= 0 && y >= 0 && x < map.width && y < map.height) {
        if (map.occupied[y * map.width + x] === e.id) {
          map.occupied[y * map.width + x] = 0;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tile queries
// ---------------------------------------------------------------------------

export function inBounds(map: GameMap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

export function isWalkable(map: GameMap, x: number, y: number): boolean {
  if (!inBounds(map, x, y)) return false;
  const i = y * map.width + x;
  return map.terrain[i] !== T_WATER && map.trees[i] === 0 && map.occupied[i] === 0;
}

/** Walkable ignoring a specific entity's footprint (so workers can path "to" a building). */
export function isWalkableFor(map: GameMap, x: number, y: number, ignoreEntity: EntityId): boolean {
  if (!inBounds(map, x, y)) return false;
  const i = y * map.width + x;
  if (map.terrain[i] === T_WATER || map.trees[i] !== 0) return false;
  return map.occupied[i] === 0 || map.occupied[i] === ignoreEntity;
}

export function entitiesOf(state: GameState, player: PlayerId): Entity[] {
  const out: Entity[] = [];
  for (const e of state.entities.values()) {
    if (e.owner === player) out.push(e);
  }
  return out;
}

export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Distance from a point to the edge of an entity (buildings have footprints). */
export function distanceTo(e: Entity, from: { x: number; y: number }): number {
  if (!e.isBuilding) return distance(e, from);
  const half = e.size / 2;
  const dx = Math.max(Math.abs(from.x - e.x) - half, 0);
  const dy = Math.max(Math.abs(from.y - e.y) - half, 0);
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Deterministic iteration: entities sorted by id. Map preserves insertion
 * order which is already deterministic, but sorting makes intent explicit
 * and survives any future refactor of insertion order.
 */
export function orderedEntities(state: GameState): Entity[] {
  return [...state.entities.values()].sort((a, b) => a.id - b.id);
}

/** Cheap structural hash for determinism tests. */
export function hashState(state: GameState): number {
  let h = 2166136261 >>> 0;
  const mix = (n: number) => {
    // hash the float bits so tiny divergences are caught
    const buf = new DataView(new ArrayBuffer(8));
    buf.setFloat64(0, n);
    h = Math.imul(h ^ buf.getUint32(0), 16777619) >>> 0;
    h = Math.imul(h ^ buf.getUint32(4), 16777619) >>> 0;
  };
  mix(state.tick);
  // map matters: trees deplete during play, and terrain differs per seed
  for (let i = 0; i < state.map.trees.length; i++) {
    h = Math.imul(h ^ (state.map.trees[i] * 31 + state.map.terrain[i]), 16777619) >>> 0;
  }
  for (const p of state.players) {
    mix(p.gold); mix(p.wood); mix(p.defeated ? 1 : 0);
  }
  for (const e of orderedEntities(state)) {
    mix(e.id); mix(e.x); mix(e.y); mix(e.hp); mix(e.level);
    mix(e.carryAmount); mix(e.goldLeft); mix(e.trainQueue.length);
  }
  return h;
}
