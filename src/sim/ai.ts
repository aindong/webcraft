/**
 * AI opponent. Architecturally it is just another player controller: it reads
 * the public game state and emits Commands into the same queue the human UI
 * uses. Nothing in the sim knows or cares that a player is AI-driven, which
 * is exactly what lockstep multiplayer needs.
 */
import { Command, canPlaceBuilding, foodCap, foodUsed } from './commands';
import { buildingDef, raceDef, unitDef, UNITS } from './data';
import { Entity, GameState, PlayerId, distance, isWalkable } from './state';

interface AiMemory {
  /** sim tick of last attack wave */
  lastWave: number;
  /** escalating army size required before attacking */
  waveSize: number;
}

const memories = new Map<PlayerId, AiMemory>();

interface Difficulty {
  thinkPeriod: number;   // ticks between decisions
  targetWorkers: number;
  maxBarracks: number;
  firstWave: number;     // army size for first attack
  waveGrowth: number;
  upgrades: boolean;
  /** passive resource trickle per think (hard AI cheats a little, like the classics) */
  trickle: number;
}

const DIFFICULTY: Record<string, Difficulty> = {
  easy: { thinkPeriod: 24, targetWorkers: 8, maxBarracks: 1, firstWave: 6, waveGrowth: 2, upgrades: false, trickle: 0 },
  normal: { thinkPeriod: 12, targetWorkers: 12, maxBarracks: 2, firstWave: 8, waveGrowth: 3, upgrades: true, trickle: 0 },
  hard: { thinkPeriod: 8, targetWorkers: 16, maxBarracks: 3, firstWave: 10, waveGrowth: 4, upgrades: true, trickle: 4 },
};

export function resetAiMemory(): void {
  memories.clear();
}

export function aiThink(state: GameState, playerId: PlayerId): Command[] {
  const player = state.players[playerId];
  if (!player || player.defeated || state.winner !== null) return [];
  const diff = DIFFICULTY[player.aiDifficulty];
  if (state.tick % diff.thinkPeriod !== playerId % diff.thinkPeriod) return [];

  let mem = memories.get(playerId);
  if (!mem) {
    mem = { lastWave: 0, waveSize: diff.firstWave };
    memories.set(playerId, mem);
  }

  if (diff.trickle > 0) {
    player.gold += diff.trickle;
    player.wood += Math.ceil(diff.trickle / 2);
  }

  const race = raceDef(player.race);
  const cmds: Command[] = [];

  // --- census ---
  const mine: Entity[] = [];
  const workers: Entity[] = [];
  const army: Entity[] = [];
  const halls: Entity[] = [];
  const barracks: Entity[] = [];
  const housesType = race.buildings[1];
  const barracksType = race.buildings[2];
  let houses = 0;
  let underConstruction: Entity | null = null;

  for (const e of state.entities.values()) {
    if (e.owner !== playerId) continue;
    mine.push(e);
    if (e.isBuilding) {
      if (e.buildRemaining > 0) underConstruction = e;
      else if (buildingDef(e.type).isTownHall) halls.push(e);
      else if (e.type === barracksType) barracks.push(e);
      if (e.type === housesType) houses++;
    } else if (unitDef(e.type).isWorker) {
      workers.push(e);
    } else {
      army.push(e);
    }
  }

  if (halls.length === 0 && underConstruction === null) {
    // hall destroyed: try to rebuild if rich, else all-in attack
    if (player.gold >= 400 && player.wood >= 250 && workers.length > 0) {
      const spot = findBuildSpot(state, workers[0], race.townHall);
      if (spot) {
        cmds.push({ kind: 'build', player: playerId, workers: workers.map((w) => w.id), building: race.townHall, tx: spot.x, ty: spot.y });
        return cmds;
      }
    }
  }

  const hall = halls[0];

  // --- economy: assign idle workers ---
  const idleWorkers = workers.filter((w) => w.order.kind === 'idle');
  if (idleWorkers.length > 0 && hall) {
    const goldWorkers = workers.filter((w) => isOnGold(state, w)).length;
    const mineEnt = nearestMine(state, hall);
    for (const w of idleWorkers) {
      if (mineEnt && goldWorkers + 1 <= Math.ceil(workers.length * 0.6)) {
        cmds.push({ kind: 'harvest', player: playerId, units: [w.id], target: mineEnt.id });
      } else {
        const tree = nearestTreeTo(state, w);
        if (tree) cmds.push({ kind: 'harvest', player: playerId, units: [w.id], tx: tree.x, ty: tree.y });
        else if (mineEnt) cmds.push({ kind: 'harvest', player: playerId, units: [w.id], target: mineEnt.id });
      }
    }
  }

  // --- supply ---
  const used = foodUsed(state, playerId);
  const cap = foodCap(state, playerId);
  const houseDef = buildingDef(housesType);
  if (cap - used <= 2 && cap < 100 && underConstruction === null &&
      player.gold >= houseDef.cost.gold && player.wood >= houseDef.cost.wood && workers.length > 0) {
    const builder = idleWorkers[0] ?? workers[0];
    const spot = findBuildSpot(state, hall ?? builder, housesType);
    if (spot) {
      cmds.push({ kind: 'build', player: playerId, workers: [builder.id], building: housesType, tx: spot.x, ty: spot.y });
    }
  }

  // --- train workers ---
  if (hall && workers.length < diff.targetWorkers && hall.trainQueue.length < 2) {
    cmds.push({ kind: 'train', player: playerId, building: hall.id, unit: race.worker });
  }

  // --- barracks ---
  const bDef = buildingDef(barracksType);
  if (barracks.length < diff.maxBarracks && underConstruction === null && workers.length >= 6 &&
      player.gold >= bDef.cost.gold + 100 && player.wood >= bDef.cost.wood) {
    const builder = idleWorkers[0] ?? workers[workers.length - 1];
    const spot = findBuildSpot(state, hall ?? builder, barracksType);
    if (spot) {
      cmds.push({ kind: 'build', player: playerId, workers: [builder.id], building: barracksType, tx: spot.x, ty: spot.y });
    }
  }

  // --- upgrades ---
  if (diff.upgrades) {
    for (const b of barracks) {
      const next = buildingDef(b.type).levels[b.level];
      if (next && b.upgradeRemaining === 0 && army.length >= 4 &&
          player.gold >= next.cost.gold + 200 && player.wood >= next.cost.wood + 50) {
        cmds.push({ kind: 'upgrade', player: playerId, building: b.id });
        break;
      }
    }
    if (hall) {
      const next = buildingDef(hall.type).levels[hall.level];
      if (next && hall.upgradeRemaining === 0 && workers.length >= diff.targetWorkers - 2 &&
          player.gold >= next.cost.gold + 300 && player.wood >= next.cost.wood + 100) {
        cmds.push({ kind: 'upgrade', player: playerId, building: hall.id });
      }
    }
  }

  // --- train army ---
  for (const b of barracks) {
    if (b.trainQueue.length >= 2 || b.upgradeRemaining > 0) continue;
    const options = buildingDef(b.type).trains.filter((u) => UNITS[u].requiresLevel <= b.level);
    if (options.length === 0) continue;
    // mix: prefer the strongest affordable, fall back to basic
    for (let i = options.length - 1; i >= 0; i--) {
      const u = UNITS[options[i]];
      if (player.gold >= u.cost.gold && player.wood >= u.cost.wood) {
        cmds.push({ kind: 'train', player: playerId, building: b.id, unit: u.id });
        break;
      }
    }
  }

  // --- defense: if our base is hit, rally everyone home ---
  const threat = enemyNear(state, playerId, hall);
  if (threat && army.length > 0) {
    cmds.push({ kind: 'attack', player: playerId, units: army.map((a) => a.id), target: threat.id });
    return cmds;
  }

  // --- attack waves ---
  const idleArmy = army.filter((a) => a.order.kind === 'idle');
  if (idleArmy.length >= mem.waveSize) {
    const target = pickAttackTarget(state, playerId);
    if (target) {
      cmds.push({ kind: 'attackMove', player: playerId, units: idleArmy.map((a) => a.id), x: target.x, y: target.y });
      mem.lastWave = state.tick;
      mem.waveSize += diff.waveGrowth;
    }
  }

  return cmds;
}

function isOnGold(state: GameState, w: Entity): boolean {
  if (w.insideMine > 0) return true;
  if (w.order.kind === 'harvest' && w.order.target !== undefined) return true;
  if (w.order.kind === 'deliver' && w.carryType === 'gold') return true;
  return false;
}

function nearestMine(state: GameState, from: Entity): Entity | null {
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const e of state.entities.values()) {
    if (e.type !== 'goldmine' || e.goldLeft <= 0) continue;
    const d = distance(e, from);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

function nearestTreeTo(state: GameState, from: Entity): { x: number; y: number } | null {
  const map = state.map;
  const fx = Math.floor(from.x), fy = Math.floor(from.y);
  for (let r = 1; r < 24; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = fx + dx, y = fy + dy;
        if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
        if (map.trees[y * map.width + x] > 0) return { x, y };
      }
    }
  }
  return null;
}

function findBuildSpot(state: GameState, near: Entity, type: string): { x: number; y: number } | null {
  const size = buildingDef(type).size;
  const cx = Math.floor(near.x), cy = Math.floor(near.y);
  for (let r = 3; r < 14; r++) {
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx, y = cy + dy;
        // leave a 1-tile walking gap around everything
        if (canPlaceWithMargin(state, type, x, y, size)) return { x, y };
      }
    }
  }
  return null;
}

function canPlaceWithMargin(state: GameState, type: string, tx: number, ty: number, size: number): boolean {
  if (!canPlaceBuilding(state, type, tx, ty)) return false;
  for (let dy = -1; dy <= size; dy++) {
    for (let dx = -1; dx <= size; dx++) {
      if (!isWalkable(state.map, tx + dx, ty + dy)) {
        // margin tiles only need to be non-occupied by buildings; trees are ok on margin
        const i = (ty + dy) * state.map.width + (tx + dx);
        if (i >= 0 && i < state.map.occupied.length && state.map.occupied[i] !== 0) return false;
      }
    }
  }
  return true;
}

function enemyNear(state: GameState, playerId: PlayerId, hall: Entity | undefined): Entity | null {
  if (!hall) return null;
  for (const e of state.entities.values()) {
    if (e.owner === playerId || e.owner === -1) continue;
    if (state.players[e.owner]?.defeated) continue;
    if (e.isBuilding) continue;
    if (distance(e, hall) < 14) return e;
  }
  return null;
}

function pickAttackTarget(state: GameState, playerId: PlayerId): Entity | null {
  // nearest enemy building to our hall; prefer non-tower production
  let myHall: Entity | null = null;
  for (const e of state.entities.values()) {
    if (e.owner === playerId && e.isBuilding && buildingDef(e.type)?.isTownHall) {
      myHall = e;
      break;
    }
  }
  const from = myHall ?? { x: state.map.width / 2, y: state.map.height / 2 };
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const e of state.entities.values()) {
    if (e.owner === playerId || e.owner === -1 || !e.isBuilding) continue;
    if (state.players[e.owner]?.defeated) continue;
    const d = distance(e, from);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}
