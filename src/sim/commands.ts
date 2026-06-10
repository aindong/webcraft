/**
 * Commands are the ONLY way any player — human UI or AI controller — mutates
 * the simulation. They are plain serializable objects, so shipping them over
 * a websocket for lockstep multiplayer requires no sim changes.
 */
import { EventBus } from '../core/events';
import { buildingDef, raceDef, unitDef, UNITS } from './data';
import { findPath, walkableIgnoring } from './pathfinding';
import {
  Entity, EntityId, GameState, PlayerId, isWalkable, secondsToTicks,
  spawnBuilding,
} from './state';

export type Command =
  | { kind: 'move'; player: PlayerId; units: EntityId[]; x: number; y: number }
  | { kind: 'attackMove'; player: PlayerId; units: EntityId[]; x: number; y: number }
  | { kind: 'attack'; player: PlayerId; units: EntityId[]; target: EntityId }
  | { kind: 'harvest'; player: PlayerId; units: EntityId[]; target?: EntityId; tx?: number; ty?: number }
  | { kind: 'build'; player: PlayerId; workers: EntityId[]; building: string; tx: number; ty: number }
  | { kind: 'joinBuild'; player: PlayerId; workers: EntityId[]; target: EntityId }
  | { kind: 'train'; player: PlayerId; building: EntityId; unit: string }
  | { kind: 'cancelTrain'; player: PlayerId; building: EntityId; index: number }
  | { kind: 'upgrade'; player: PlayerId; building: EntityId }
  | { kind: 'setRally'; player: PlayerId; building: EntityId; x: number; y: number }
  | { kind: 'stop'; player: PlayerId; units: EntityId[] };

/** Result of attempting a command — used by the UI for "not enough gold" feedback. */
export type CommandError = 'noGold' | 'noWood' | 'noFood' | 'blocked' | 'invalid' | null;

export function foodUsed(state: GameState, player: PlayerId): number {
  let used = 0;
  for (const e of state.entities.values()) {
    if (e.owner !== player) continue;
    if (!e.isBuilding) used += unitDef(e.type)?.food ?? 0;
  }
  // queued units also reserve food
  for (const e of state.entities.values()) {
    if (e.owner !== player || !e.isBuilding) continue;
    for (const item of e.trainQueue) used += unitDef(item.unit).food;
  }
  return used;
}

export function foodCap(state: GameState, player: PlayerId): number {
  let cap = 0;
  for (const e of state.entities.values()) {
    if (e.owner !== player || !e.isBuilding || e.buildRemaining > 0) continue;
    const def = buildingDef(e.type);
    if (def) cap += def.levels[e.level - 1].providesFood;
  }
  return Math.min(cap, 100);
}

export function canAfford(state: GameState, player: PlayerId, cost: { gold: number; wood: number }): CommandError {
  const p = state.players[player];
  if (p.gold < cost.gold) return 'noGold';
  if (p.wood < cost.wood) return 'noWood';
  return null;
}

export function canPlaceBuilding(state: GameState, type: string, tx: number, ty: number): boolean {
  const def = buildingDef(type);
  if (!def) return false;
  for (let dy = 0; dy < def.size; dy++) {
    for (let dx = 0; dx < def.size; dx++) {
      if (!isWalkable(state.map, tx + dx, ty + dy)) return false;
    }
  }
  return true;
}

/**
 * Tree tiles within `radius` of (tx,ty), sorted nearest-first (deterministic).
 * Only trees on the edge of a forest (with a walkable neighbor) qualify —
 * fanning a worker onto an interior tile would strand it.
 */
function treesAround(state: GameState, tx: number, ty: number, radius: number): { x: number; y: number }[] {
  const map = state.map;
  const out: { x: number; y: number; d: number }[] = [];
  for (let y = Math.max(0, ty - radius); y <= Math.min(map.height - 1, ty + radius); y++) {
    for (let x = Math.max(0, tx - radius); x <= Math.min(map.width - 1, tx + radius); x++) {
      if (map.trees[y * map.width + x] > 0 && treeHasOpenNeighbor(state, x, y)) {
        out.push({ x, y, d: (x - tx) ** 2 + (y - ty) ** 2 });
      }
    }
  }
  out.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  return out.map(({ x, y }) => ({ x, y }));
}

function treeHasOpenNeighbor(state: GameState, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (isWalkable(state.map, x + dx, y + dy)) return true;
    }
  }
  return false;
}

function ownedUnits(state: GameState, player: PlayerId, ids: EntityId[]): Entity[] {
  const out: Entity[] = [];
  for (const id of ids) {
    const e = state.entities.get(id);
    if (e && e.owner === player && !e.isBuilding && e.insideMine <= 0) {
      // an explicit order supersedes any "return to work" memory
      e.resumeOrder = null;
      out.push(e);
    }
  }
  return out;
}

function setPathTo(state: GameState, e: Entity, x: number, y: number, ignoreEntity?: EntityId): void {
  const walk = ignoreEntity !== undefined
    ? walkableIgnoring(state.map, ignoreEntity)
    : walkableIgnoring(state.map, -999);
  e.path = findPath(state.map, e.x, e.y, x, y, walk);
  e.pathIndex = 0;
}

export function applyCommand(state: GameState, events: EventBus, cmd: Command): CommandError {
  const player = state.players[cmd.player];
  if (!player || player.defeated) return 'invalid';

  switch (cmd.kind) {
    case 'move': {
      for (const e of ownedUnits(state, cmd.player, cmd.units)) {
        e.order = { kind: 'move', x: cmd.x, y: cmd.y };
        setPathTo(state, e, cmd.x, cmd.y);
      }
      return null;
    }

    case 'attackMove': {
      for (const e of ownedUnits(state, cmd.player, cmd.units)) {
        e.order = { kind: 'attackMove', x: cmd.x, y: cmd.y };
        setPathTo(state, e, cmd.x, cmd.y);
      }
      return null;
    }

    case 'attack': {
      const target = state.entities.get(cmd.target);
      if (!target) return 'invalid';
      for (const e of ownedUnits(state, cmd.player, cmd.units)) {
        e.order = { kind: 'attack', target: cmd.target };
        setPathTo(state, e, target.x, target.y, target.id);
      }
      return null;
    }

    case 'harvest': {
      const workers = ownedUnits(state, cmd.player, cmd.units).filter((e) => unitDef(e.type)?.isWorker);
      if (workers.length === 0) return 'invalid';
      if (cmd.target !== undefined) {
        const mine = state.entities.get(cmd.target);
        if (!mine || mine.type !== 'goldmine') return 'invalid';
        for (const e of workers) {
          e.order = { kind: 'harvest', target: cmd.target, gatherTicks: 0 };
          setPathTo(state, e, mine.x, mine.y, mine.id);
        }
      } else if (cmd.tx !== undefined && cmd.ty !== undefined) {
        // fan workers out over nearby trees instead of stacking on one tile
        const spots = treesAround(state, cmd.tx, cmd.ty, 2);
        workers.forEach((e, i) => {
          const t = spots.length > 0 ? spots[i % spots.length] : { x: cmd.tx!, y: cmd.ty! };
          e.order = { kind: 'harvest', tx: t.x, ty: t.y, gatherTicks: 0 };
          setPathTo(state, e, t.x + 0.5, t.y + 0.5);
        });
      } else {
        return 'invalid';
      }
      return null;
    }

    case 'build': {
      const def = buildingDef(cmd.building);
      if (!def) return 'invalid';
      const race = raceDef(player.race);
      if (!race.buildings.includes(cmd.building)) return 'invalid';
      const workers = ownedUnits(state, cmd.player, cmd.workers).filter((e) => unitDef(e.type)?.isWorker);
      if (workers.length === 0) return 'invalid';
      if (!canPlaceBuilding(state, cmd.building, cmd.tx, cmd.ty)) return 'blocked';
      const afford = canAfford(state, cmd.player, def.cost);
      if (afford) return afford;

      player.gold -= def.cost.gold;
      player.wood -= def.cost.wood;
      const site = spawnBuilding(state, cmd.player, cmd.building, cmd.tx, cmd.ty);
      for (const w of workers) {
        w.order = { kind: 'build', target: site.id };
        setPathTo(state, w, site.x, site.y, site.id);
      }
      return null;
    }

    case 'joinBuild': {
      const site = state.entities.get(cmd.target);
      if (!site || site.owner !== cmd.player || !site.isBuilding || site.buildRemaining <= 0) return 'invalid';
      const workers = ownedUnits(state, cmd.player, cmd.workers).filter((e) => unitDef(e.type)?.isWorker);
      if (workers.length === 0) return 'invalid';
      for (const w of workers) {
        w.order = { kind: 'build', target: site.id };
        setPathTo(state, w, site.x, site.y, site.id);
      }
      return null;
    }

    case 'train': {
      const b = state.entities.get(cmd.building);
      if (!b || b.owner !== cmd.player || !b.isBuilding || b.buildRemaining > 0) return 'invalid';
      const bdef = buildingDef(b.type);
      const udef = UNITS[cmd.unit];
      if (!bdef || !udef || !bdef.trains.includes(cmd.unit)) return 'invalid';
      if (b.level < udef.requiresLevel) return 'invalid';
      if (b.trainQueue.length >= 5) return 'invalid';
      const afford = canAfford(state, cmd.player, udef.cost);
      if (afford) return afford;
      if (foodUsed(state, cmd.player) + udef.food > foodCap(state, cmd.player)) return 'noFood';

      player.gold -= udef.cost.gold;
      player.wood -= udef.cost.wood;
      const ticks = secondsToTicks(udef.trainTime);
      b.trainQueue.push({ unit: cmd.unit, remaining: ticks, total: ticks });
      return null;
    }

    case 'cancelTrain': {
      const b = state.entities.get(cmd.building);
      if (!b || b.owner !== cmd.player) return 'invalid';
      const item = b.trainQueue[cmd.index];
      if (!item) return 'invalid';
      const udef = UNITS[item.unit];
      player.gold += udef.cost.gold;
      player.wood += udef.cost.wood;
      b.trainQueue.splice(cmd.index, 1);
      return null;
    }

    case 'upgrade': {
      const b = state.entities.get(cmd.building);
      if (!b || b.owner !== cmd.player || !b.isBuilding) return 'invalid';
      if (b.buildRemaining > 0 || b.upgradeRemaining > 0) return 'invalid';
      const bdef = buildingDef(b.type);
      const next = bdef?.levels[b.level];
      if (!next) return 'invalid';
      const afford = canAfford(state, cmd.player, next.cost);
      if (afford) return afford;

      player.gold -= next.cost.gold;
      player.wood -= next.cost.wood;
      const ticks = secondsToTicks(next.upgradeTime);
      b.upgradeRemaining = ticks;
      b.upgradeTotal = ticks;
      return null;
    }

    case 'setRally': {
      const b = state.entities.get(cmd.building);
      if (!b || b.owner !== cmd.player || !b.isBuilding) return 'invalid';
      b.rallyX = cmd.x;
      b.rallyY = cmd.y;
      return null;
    }

    case 'stop': {
      for (const e of ownedUnits(state, cmd.player, cmd.units)) {
        e.order = { kind: 'idle' };
        e.path = null;
      }
      return null;
    }
  }
}

/** Smart right-click: choose order type from what's under the cursor. */
export function smartCommand(
  state: GameState, player: PlayerId, units: EntityId[], x: number, y: number,
): Command {
  const tx = Math.floor(x), ty = Math.floor(y);
  const map = state.map;

  // entity under cursor?
  let clicked: Entity | null = null;
  for (const e of state.entities.values()) {
    if (e.insideMine > 0) continue;
    const half = e.isBuilding ? e.size / 2 : 0.5;
    if (Math.abs(x - e.x) <= half && Math.abs(y - e.y) <= half) {
      clicked = e;
      if (!e.isBuilding) break; // prefer units over buildings
    }
  }

  const anyWorker = units.some((id) => {
    const e = state.entities.get(id);
    return e && unitDef(e.type)?.isWorker;
  });

  if (clicked) {
    if (clicked.type === 'goldmine' && anyWorker) {
      return { kind: 'harvest', player, units, target: clicked.id };
    }
    if (clicked.owner !== player && clicked.owner !== -1) {
      return { kind: 'attack', player, units, target: clicked.id };
    }
    if (clicked.owner === player && clicked.isBuilding && clicked.buildRemaining > 0 && anyWorker) {
      return { kind: 'joinBuild', player, workers: units, target: clicked.id };
    }
  }

  if (tx >= 0 && ty >= 0 && tx < map.width && ty < map.height && map.trees[ty * map.width + tx] > 0 && anyWorker) {
    return { kind: 'harvest', player, units, tx, ty };
  }

  return { kind: 'move', player, units, x, y };
}
