/**
 * The fixed-timestep simulation. step() advances exactly one tick:
 *   apply queued commands → production → construction → unit orders &
 *   movement → combat → deaths → win check.
 * Fully deterministic given (seed, command stream) — the lockstep contract.
 */
import { EventBus } from '../core/events';
import { applyCommand, Command, smartCommand } from './commands';
import { buildingDef, unitDef } from './data';
import { findPath, walkableIgnoring } from './pathfinding';
import {
  clearFootprint, distance, distanceTo, Entity, EntityId, GameState,
  isWalkable, orderedEntities, secondsToTicks, spawnUnit,
} from './state';

const GOLD_PER_TRIP = 10;
const WOOD_PER_TRIP = 10;
const MINE_TICKS = secondsToTicks(1.2);
const CHOP_TICKS_PER_WOOD = secondsToTicks(0.45);
/** must exceed √2 so a tree can be chopped from a diagonal neighbor tile */
const CHOP_RANGE = 1.6;
const BUILD_RATE_PER_WORKER = 1; // construction ticks advanced per worker per tick
const SEPARATION_RADIUS = 0.6;
const SEPARATION_PUSH = 0.08;
const ATTACK_ALERT_COOLDOWN_TICKS = secondsToTicks(12);

export function step(state: GameState, events: EventBus, commands: Command[]): void {
  state.tick++;

  for (const cmd of commands) {
    applyCommand(state, events, cmd);
  }

  const entities = orderedEntities(state);

  // snapshot previous positions for render interpolation
  for (const e of entities) {
    e.px = e.x;
    e.py = e.y;
    e.striking = false;
    if (e.cooldown > 0) e.cooldown--;
  }

  for (const e of entities) {
    if (!state.entities.has(e.id)) continue; // died earlier this tick
    if (e.isBuilding) {
      stepBuilding(state, events, e);
    } else {
      stepUnit(state, events, e);
    }
  }

  separateUnits(state, entities);
  checkVictory(state, events);
}

// ---------------------------------------------------------------------------
// Buildings: construction handled by workers; here we run training & upgrades
// ---------------------------------------------------------------------------

function stepBuilding(state: GameState, events: EventBus, b: Entity): void {
  if (b.type === 'goldmine') return; // neutral, inert
  if (b.buildRemaining > 0) return; // construction advanced by workers

  // upgrade
  if (b.upgradeRemaining > 0) {
    b.upgradeRemaining--;
    if (b.upgradeRemaining === 0) {
      b.level++;
      const lvl = buildingDef(b.type).levels[b.level - 1];
      const hpRatio = b.hp / b.maxHp;
      b.maxHp = lvl.hp;
      b.hp = Math.round(lvl.hp * hpRatio);
      events.emit({ kind: 'upgradeComplete', player: b.owner, entity: b.id, type: b.type, level: b.level });
    }
    return; // upgrading pauses training
  }

  // training
  const item = b.trainQueue[0];
  if (item) {
    item.remaining--;
    if (item.remaining <= 0) {
      b.trainQueue.shift();
      const spot = findSpawnSpot(state, b);
      const u = spawnUnit(state, b.owner, item.unit, spot.x, spot.y);
      events.emit({ kind: 'trainComplete', player: b.owner, entity: u.id, type: item.unit });
      // send to rally point — smart, like a right-click: a rally on a mine
      // or tree puts workers straight to work, on a construction site they
      // help build, on an enemy the unit attacks; otherwise just move
      if (b.rallyX >= 0) {
        applyCommand(state, events, smartCommand(state, b.owner, [u.id], b.rallyX, b.rallyY));
      }
    }
  }

  // defensive towers attack
  const lvl = buildingDef(b.type).levels[b.level - 1];
  if (lvl.damage > 0 && b.cooldown <= 0) {
    const target = nearestEnemy(state, b, lvl.range);
    if (target) {
      dealDamage(state, events, b, target, lvl.damage);
      b.cooldown = secondsToTicks(lvl.attackPeriod);
      events.emit({ kind: 'attackSwing', attacker: b.id, ranged: true, x: b.x, y: b.y });
    }
  }
}

function findSpawnSpot(state: GameState, b: Entity): { x: number; y: number } {
  const tx = Math.round(b.x - b.size / 2);
  const ty = Math.round(b.y - b.size / 2);
  // ring search around the footprint
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= b.size - 1 + r; dy++) {
      for (let dx = -r; dx <= b.size - 1 + r; dx++) {
        const onRing = dx === -r || dy === -r || dx === b.size - 1 + r || dy === b.size - 1 + r;
        if (!onRing) continue;
        const x = tx + dx, y = ty + dy;
        if (isWalkable(state.map, x, y)) return { x: x + 0.5, y: y + 0.5 };
      }
    }
  }
  return { x: b.x, y: b.y + b.size };
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

function stepUnit(state: GameState, events: EventBus, e: Entity): void {
  if (e.insideMine > 0) {
    e.insideMine--;
    if (e.insideMine === 0) {
      // emerge carrying gold, head home
      e.carryType = 'gold';
      e.carryAmount = GOLD_PER_TRIP;
      e.order = { kind: 'deliver', target: e.order.target };
      goDeliver(state, e);
    }
    return;
  }

  const def = unitDef(e.type);
  switch (e.order.kind) {
    case 'idle':
      if (!def.isWorker && def.aggroRange > 0) {
        const target = nearestEnemy(state, e, def.aggroRange);
        if (target) e.order = { kind: 'attack', target: target.id };
      }
      break;

    case 'move':
      if (!advanceAlongPath(state, e, def.speed)) e.order = { kind: 'idle' };
      break;

    case 'attackMove': {
      const target = nearestEnemy(state, e, Math.max(def.aggroRange, 1));
      if (target) {
        attackTarget(state, events, e, target, /*resume*/ { kind: 'attackMove', x: e.order.x, y: e.order.y });
      } else if (!advanceAlongPath(state, e, def.speed)) {
        e.order = { kind: 'idle' };
      }
      break;
    }

    case 'attack': {
      const target = e.order.target !== undefined ? state.entities.get(e.order.target) : undefined;
      if (!target) {
        standDown(state, e);
        break;
      }
      attackTarget(state, events, e, target, null);
      break;
    }

    case 'harvest':
      stepHarvest(state, events, e);
      break;

    case 'deliver':
      stepDeliver(state, events, e);
      break;

    case 'build':
      stepBuild(state, events, e);
      break;
  }
}

/** Move along current path; returns false when path is finished/absent. */
function advanceAlongPath(state: GameState, e: Entity, speed: number): boolean {
  if (!e.path || e.pathIndex >= e.path.length) return false;
  let budget = speed / state.tps;
  while (budget > 0 && e.pathIndex < e.path.length) {
    const wp = e.path[e.pathIndex];
    const d = distance(e, wp);
    if (d <= budget) {
      e.x = wp.x;
      e.y = wp.y;
      budget -= d;
      e.pathIndex++;
    } else {
      e.x += ((wp.x - e.x) / d) * budget;
      e.y += ((wp.y - e.y) / d) * budget;
      budget = 0;
    }
  }
  if (e.x !== e.px || e.y !== e.py) {
    e.facing = Math.atan2(e.y - e.py, e.x - e.px);
  }
  return e.pathIndex < e.path.length;
}

function repath(state: GameState, e: Entity, x: number, y: number, ignore?: EntityId): void {
  e.path = findPath(state.map, e.x, e.y, x, y, walkableIgnoring(state.map, ignore ?? -999));
  e.pathIndex = 0;
}

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

function attackTarget(
  state: GameState, events: EventBus, e: Entity, target: Entity, resume: Entity['order'] | null,
): void {
  const def = unitDef(e.type);
  const d = distanceTo(target, e);

  if (d <= def.range) {
    e.path = null;
    e.facing = Math.atan2(target.y - e.y, target.x - e.x);
    if (e.cooldown <= 0) {
      dealDamage(state, events, e, target, def.damage);
      e.cooldown = secondsToTicks(def.attackPeriod);
      e.striking = true;
      events.emit({ kind: 'attackSwing', attacker: e.id, ranged: def.range > 2, x: e.x, y: e.y });
      if (!state.entities.has(target.id)) {
        // target died: resume attack-move, return to work, or go idle
        if (resume) {
          e.order = resume;
          if (resume.x !== undefined) repath(state, e, resume.x, resume.y!);
        } else {
          standDown(state, e);
        }
      }
    }
    if (state.entities.has(target.id) && e.order.kind !== 'attack' && resume === null) {
      e.order = { kind: 'attack', target: target.id };
    } else if (e.order.kind === 'attackMove') {
      // keep attackMove order but remember we're engaged — nothing to do
    }
    return;
  }

  // out of range: chase
  if (e.order.kind === 'attack' || resume !== null) {
    const needRepath = !e.path || e.pathIndex >= e.path.length ||
      distance(e.path[e.path.length - 1], target) > 1.5;
    if (needRepath && state.tick % 4 === e.id % 4) {
      repath(state, e, target.x, target.y, target.id);
    }
    advanceAlongPath(state, e, def.speed);
  }
}

function dealDamage(state: GameState, events: EventBus, attacker: Entity, target: Entity, dmg: number): void {
  target.hp -= dmg;

  // alert the defender (throttled)
  const owner = state.players[target.owner];
  if (owner && state.tick - owner.lastAttackAlert > ATTACK_ALERT_COOLDOWN_TICKS) {
    owner.lastAttackAlert = state.tick;
    events.emit({ kind: 'underAttack', player: target.owner, x: target.x, y: target.y });
  }

  // workers fight back; military auto-retaliates
  if (!target.isBuilding && target.order.kind === 'idle') {
    target.order = { kind: 'attack', target: attacker.id };
  }
  // idle harvesting workers flee? no — classic behavior: keep working unless directly hit
  if (!target.isBuilding && (target.order.kind === 'harvest' || target.order.kind === 'deliver')) {
    const tdef = unitDef(target.type);
    if (tdef.isWorker && !attacker.isBuilding) {
      // remember the job so the worker returns to it after the fight;
      // an interrupted delivery resumes as a fresh harvest (carry is dropped)
      const job = target.order;
      target.resumeOrder = job.kind === 'deliver'
        ? { kind: 'harvest', target: job.target, tx: job.tx, ty: job.ty, gatherTicks: 0 }
        : job;
      target.order = { kind: 'attack', target: attacker.id };
      target.carryType = null;
      target.carryAmount = 0;
    }
  }

  if (target.hp <= 0) {
    killEntity(state, events, target);
  }
}

/** Fight's over: return to the interrupted job if there was one, else idle. */
function standDown(state: GameState, e: Entity): void {
  const job = e.resumeOrder;
  e.resumeOrder = null;
  if (!job) {
    e.order = { kind: 'idle' };
    return;
  }
  e.order = job;
  if (job.kind === 'harvest') {
    if (job.target !== undefined) {
      const mine = state.entities.get(job.target);
      if (mine) repath(state, e, mine.x, mine.y, mine.id);
      else e.order = { kind: 'idle' };
    } else if (job.tx !== undefined && job.ty !== undefined) {
      // stepHarvest self-heals if the tree fell in the meantime
      repath(state, e, job.tx + 0.5, job.ty + 0.5);
    }
  }
}

function killEntity(state: GameState, events: EventBus, e: Entity): void {
  if (e.isBuilding) clearFootprint(state.map, e);
  state.entities.delete(e.id);
  events.emit({
    kind: 'entityDied', player: e.owner, entity: e.id, type: e.type,
    isBuilding: e.isBuilding, x: e.x, y: e.y,
  });
  // anyone attacking it will notice via the missing-entity check next tick
}

function nearestEnemy(state: GameState, from: Entity, range: number): Entity | null {
  let best: Entity | null = null;
  let bestD = range;
  for (const e of orderedEntities(state)) {
    if (e.owner === from.owner || e.owner === -1) continue;
    if (e.insideMine > 0) continue;
    if (state.players[e.owner]?.defeated) continue;
    const d = distanceTo(e, from);
    // prefer units over buildings at similar distance
    const bias = e.isBuilding ? 0.5 : 0;
    if (d + bias < bestD + (best && !best.isBuilding ? 0 : 0.001)) {
      if (d <= range) {
        best = e;
        bestD = d + bias;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Harvesting
// ---------------------------------------------------------------------------

function stepHarvest(state: GameState, events: EventBus, e: Entity): void {
  const def = unitDef(e.type);

  // gold mine
  if (e.order.target !== undefined) {
    const mine = state.entities.get(e.order.target);
    if (!mine || mine.goldLeft <= 0) {
      e.order = { kind: 'idle' };
      return;
    }
    if (distanceTo(mine, e) <= 0.8) {
      // enter the mine
      mine.goldLeft -= Math.min(GOLD_PER_TRIP, mine.goldLeft);
      e.insideMine = MINE_TICKS;
      e.path = null;
      if (mine.goldLeft <= 0) {
        events.emit({ kind: 'mineDepleted', x: mine.x, y: mine.y });
        killEntity(state, events, mine);
      }
      return;
    }
    if (!advanceAlongPath(state, e, def.speed)) {
      repath(state, e, mine.x, mine.y, mine.id);
      if (!e.path || e.path.length === 0) e.order = { kind: 'idle' };
    }
    return;
  }

  // trees
  if (e.order.tx === undefined || e.order.ty === undefined) {
    e.order = { kind: 'idle' };
    return;
  }
  let { tx, ty } = e.order as { tx: number; ty: number };
  const map = state.map;
  if (map.trees[ty * map.width + tx] === 0) {
    // tree gone: find another — nearby first, then anywhere on the map
    const next = findNextTree(state, e, tx, ty);
    if (!next) {
      e.order = { kind: 'idle' };
      return;
    }
    e.order = { kind: 'harvest', tx: next.x, ty: next.y, gatherTicks: 0 };
    repath(state, e, next.x + 0.5, next.y + 0.5);
    tx = next.x; ty = next.y;
  }

  const treeCenter = { x: tx + 0.5, y: ty + 0.5 };
  if (distance(e, treeCenter) <= CHOP_RANGE) {
    e.path = null;
    e.facing = Math.atan2(treeCenter.y - e.y, treeCenter.x - e.x);
    e.order.gatherTicks = (e.order.gatherTicks ?? 0) + 1;
    if (e.order.gatherTicks >= CHOP_TICKS_PER_WOOD) {
      e.order.gatherTicks = 0;
      e.striking = true;
      const i = ty * map.width + tx;
      const take = Math.min(2, map.trees[i]);
      map.trees[i] -= take;
      e.carryType = 'wood';
      e.carryAmount += take;
      if (e.carryAmount >= WOOD_PER_TRIP || map.trees[i] === 0) {
        e.order = { kind: 'deliver', tx, ty };
        goDeliver(state, e);
      }
    }
    return;
  }

  if (!advanceAlongPath(state, e, def.speed)) {
    repath(state, e, treeCenter.x, treeCenter.y);
    if (!e.path || e.path.length === 0) {
      // this tree is unreachable from here — pick a different one
      const next = findNextTree(state, e, tx, ty, tx, ty);
      if (next) {
        e.order = { kind: 'harvest', tx: next.x, ty: next.y, gatherTicks: 0 };
        repath(state, e, next.x + 0.5, next.y + 0.5);
      } else {
        e.order = { kind: 'idle' };
      }
    }
  }
}

/**
 * Next tree for a worker whose current tree is gone: prefer the grove around
 * the old tile, but fall back to the nearest tree anywhere on the map so
 * lumber lines keep running instead of going idle.
 */
function findNextTree(
  state: GameState, e: Entity, tx: number, ty: number, exX = -1, exY = -1,
): { x: number; y: number } | null {
  return nearestTree(state, tx, ty, 6, exX, exY)
    ?? nearestTree(state, Math.floor(e.x), Math.floor(e.y), Math.max(state.map.width, state.map.height), exX, exY);
}

function nearestTree(
  state: GameState, tx: number, ty: number, radius: number, exX = -1, exY = -1,
): { x: number; y: number } | null {
  const map = state.map;
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = Math.max(0, ty - radius); y <= Math.min(map.height - 1, ty + radius); y++) {
    for (let x = Math.max(0, tx - radius); x <= Math.min(map.width - 1, tx + radius); x++) {
      if (map.trees[y * map.width + x] === 0) continue;
      if (x === exX && y === exY) continue;
      // only target trees with a walkable neighbor (reachable edge of forest)
      if (!hasWalkableNeighbor(state, x, y)) continue;
      const d = (x - tx) ** 2 + (y - ty) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best;
}

function hasWalkableNeighbor(state: GameState, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (isWalkable(state.map, x + dx, y + dy)) return true;
    }
  }
  return false;
}

function goDeliver(state: GameState, e: Entity): void {
  const hall = nearestDropOff(state, e);
  if (!hall) {
    e.order = { kind: 'idle' };
    return;
  }
  repath(state, e, hall.x, hall.y, hall.id);
}

function nearestDropOff(state: GameState, e: Entity): Entity | null {
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const b of orderedEntities(state)) {
    if (b.owner !== e.owner || !b.isBuilding || b.buildRemaining > 0) continue;
    if (!buildingDef(b.type)?.isTownHall) continue;
    const d = distanceTo(b, e);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

function stepDeliver(state: GameState, events: EventBus, e: Entity): void {
  const def = unitDef(e.type);
  if (!e.carryType || e.carryAmount <= 0) {
    e.order = { kind: 'idle' };
    return;
  }
  const hall = nearestDropOff(state, e);
  if (!hall) {
    e.order = { kind: 'idle' };
    return;
  }
  if (distanceTo(hall, e) <= 0.8) {
    const player = state.players[e.owner];
    if (e.carryType === 'gold') player.gold += e.carryAmount;
    else player.wood += e.carryAmount;
    events.emit({ kind: 'resourceDelivered', player: e.owner, resource: e.carryType, amount: e.carryAmount });
    e.carryType = null;
    e.carryAmount = 0;

    // return to the source
    const prev = e.order;
    if (prev.target !== undefined && state.entities.has(prev.target)) {
      e.order = { kind: 'harvest', target: prev.target, gatherTicks: 0 };
      const mine = state.entities.get(prev.target)!;
      repath(state, e, mine.x, mine.y, mine.id);
    } else if (prev.tx !== undefined && prev.ty !== undefined) {
      const tree = findNextTree(state, e, prev.tx, prev.ty);
      if (tree) {
        e.order = { kind: 'harvest', tx: tree.x, ty: tree.y, gatherTicks: 0 };
        repath(state, e, tree.x + 0.5, tree.y + 0.5);
      } else {
        e.order = { kind: 'idle' };
      }
    } else {
      e.order = { kind: 'idle' };
    }
    return;
  }
  if (!advanceAlongPath(state, e, def.speed)) {
    repath(state, e, hall.x, hall.y, hall.id);
    if (!e.path || e.path.length === 0) e.order = { kind: 'idle' };
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function stepBuild(state: GameState, events: EventBus, e: Entity): void {
  const def = unitDef(e.type);
  const site = e.order.target !== undefined ? state.entities.get(e.order.target) : undefined;
  if (!site || site.buildRemaining <= 0) {
    continueBuilding(state, e);
    return;
  }
  if (distanceTo(site, e) <= 0.8) {
    e.path = null;
    e.facing = Math.atan2(site.y - e.y, site.x - e.x);
    site.buildRemaining -= BUILD_RATE_PER_WORKER;
    if (state.tick % 6 === 0) e.striking = true;
    // hp grows with progress
    const progress = 1 - site.buildRemaining / site.buildTotal;
    site.hp = Math.min(site.maxHp, Math.max(site.hp, Math.floor(site.maxHp * (0.1 + 0.9 * progress))));
    if (site.buildRemaining <= 0) {
      site.buildRemaining = 0;
      site.hp = site.maxHp;
      events.emit({ kind: 'buildComplete', player: site.owner, entity: site.id, type: site.type });
      continueBuilding(state, e);
    }
    return;
  }
  if (!advanceAlongPath(state, e, def.speed)) {
    repath(state, e, site.x, site.y, site.id);
    if (!e.path || e.path.length === 0) e.order = { kind: 'idle' };
  }
}

/**
 * A builder whose site is done heads to the nearest remaining construction
 * site instead of standing around — laid-out blueprints get finished without
 * re-ordering workers one building at a time.
 */
function continueBuilding(state: GameState, e: Entity): void {
  let best: Entity | null = null;
  let bestD = Infinity;
  for (const b of orderedEntities(state)) {
    if (b.owner !== e.owner || !b.isBuilding || b.buildRemaining <= 0) continue;
    const d = distanceTo(b, e);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  if (best) {
    e.order = { kind: 'build', target: best.id };
    repath(state, e, best.x, best.y, best.id);
  } else {
    e.order = { kind: 'idle' };
  }
}

// ---------------------------------------------------------------------------
// Soft unit separation — deterministic pairwise push
// ---------------------------------------------------------------------------

function separateUnits(state: GameState, entities: Entity[]): void {
  const units = entities.filter((e) => !e.isBuilding && state.entities.has(e.id) && e.insideMine <= 0);
  // spatial hash
  const cell = new Map<number, Entity[]>();
  const W = state.map.width;
  for (const u of units) {
    const k = Math.floor(u.y) * W + Math.floor(u.x);
    let arr = cell.get(k);
    if (!arr) cell.set(k, (arr = []));
    arr.push(u);
  }
  for (const u of units) {
    const cx = Math.floor(u.x), cy = Math.floor(u.y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = cell.get((cy + dy) * W + (cx + dx));
        if (!arr) continue;
        for (const v of arr) {
          if (v.id <= u.id) continue; // each pair once, deterministic order
          const ddx = v.x - u.x, ddy = v.y - u.y;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 >= SEPARATION_RADIUS * SEPARATION_RADIUS || d2 === 0) continue;
          const d = Math.sqrt(d2);
          const push = (SEPARATION_RADIUS - d) * SEPARATION_PUSH;
          const nx = ddx / d, ny = ddy / d;
          nudge(state, u, -nx * push, -ny * push);
          nudge(state, v, nx * push, ny * push);
        }
      }
    }
  }
}

function nudge(state: GameState, e: Entity, dx: number, dy: number): void {
  const nx = e.x + dx, ny = e.y + dy;
  const map = state.map;
  const txi = Math.floor(nx), tyi = Math.floor(ny);
  if (txi < 0 || tyi < 0 || txi >= map.width || tyi >= map.height) return;
  const i = tyi * map.width + txi;
  if (map.terrain[i] === 2 /* water */ || map.trees[i] > 0 || map.occupied[i] !== 0) return;
  e.x = nx;
  e.y = ny;
}

// ---------------------------------------------------------------------------
// Victory
// ---------------------------------------------------------------------------

function checkVictory(state: GameState, events: EventBus): void {
  if (state.winner !== null) return;
  for (const p of state.players) {
    if (p.defeated) continue;
    let hasBuilding = false;
    for (const e of state.entities.values()) {
      if (e.owner === p.id && e.isBuilding) {
        hasBuilding = true;
        break;
      }
    }
    if (!hasBuilding) {
      p.defeated = true;
      events.emit({ kind: 'playerDefeated', player: p.id });
    }
  }
  const alive = state.players.filter((p) => !p.defeated);
  if (alive.length === 1) {
    state.winner = alive[0].id;
    events.emit({ kind: 'victory', player: alive[0].id });
  }
}
