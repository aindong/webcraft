/**
 * A* pathfinding on the tile grid. 8-directional with corner-cut prevention.
 * Deterministic: ties broken by insertion order via a stable binary heap
 * keyed on (f, insertion counter).
 */
import { GameMap, inBounds, T_WATER } from './state';

interface Node {
  x: number;
  y: number;
  g: number;
  f: number;
  seq: number;
  parent: Node | null;
}

class Heap {
  private items: Node[] = [];

  get size(): number {
    return this.items.length;
  }

  push(n: Node): void {
    this.items.push(n);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(this.items[i], this.items[p])) {
        [this.items[i], this.items[p]] = [this.items[p], this.items[i]];
        i = p;
      } else break;
    }
  }

  pop(): Node {
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = i * 2 + 2;
        let m = i;
        if (l < this.items.length && this.less(this.items[l], this.items[m])) m = l;
        if (r < this.items.length && this.less(this.items[r], this.items[m])) m = r;
        if (m === i) break;
        [this.items[i], this.items[m]] = [this.items[m], this.items[i]];
        i = m;
      }
    }
    return top;
  }

  private less(a: Node, b: Node): boolean {
    return a.f !== b.f ? a.f < b.f : a.seq < b.seq;
  }
}

const DIRS = [
  { dx: 1, dy: 0, cost: 1 }, { dx: -1, dy: 0, cost: 1 },
  { dx: 0, dy: 1, cost: 1 }, { dx: 0, dy: -1, cost: 1 },
  { dx: 1, dy: 1, cost: Math.SQRT2 }, { dx: 1, dy: -1, cost: Math.SQRT2 },
  { dx: -1, dy: 1, cost: Math.SQRT2 }, { dx: -1, dy: -1, cost: Math.SQRT2 },
];

const MAX_EXPANSIONS = 4000;

export type WalkFn = (x: number, y: number) => boolean;

/**
 * Find a path from (sx,sy) to (tx,ty) in tile coords. Returns waypoint tile
 * centers, or null when unreachable. If the goal itself is blocked, paths to
 * the nearest reachable tile encountered (best-h fallback) — that's what an
 * RTS wants for "move to that building/forest".
 */
export function findPath(
  map: GameMap, sx: number, sy: number, tx: number, ty: number, walkable: WalkFn,
): { x: number; y: number }[] | null {
  sx = clamp(Math.floor(sx), 0, map.width - 1);
  sy = clamp(Math.floor(sy), 0, map.height - 1);
  tx = clamp(Math.floor(tx), 0, map.width - 1);
  ty = clamp(Math.floor(ty), 0, map.height - 1);
  if (sx === tx && sy === ty) return [];

  const open = new Heap();
  const visited = new Map<number, number>(); // tile index -> best g
  let seq = 0;

  const h = (x: number, y: number) => {
    const dx = Math.abs(x - tx), dy = Math.abs(y - ty);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };

  const start: Node = { x: sx, y: sy, g: 0, f: h(sx, sy), seq: seq++, parent: null };
  open.push(start);
  visited.set(sy * map.width + sx, 0);

  let best: Node = start;
  let bestH = h(sx, sy);
  let expansions = 0;

  while (open.size > 0 && expansions < MAX_EXPANSIONS) {
    const cur = open.pop();
    expansions++;

    const curH = cur.f - cur.g;
    if (curH < bestH) {
      bestH = curH;
      best = cur;
    }
    if (cur.x === tx && cur.y === ty) return reconstruct(cur);

    for (const d of DIRS) {
      const nx = cur.x + d.dx, ny = cur.y + d.dy;
      if (!inBounds(map, nx, ny)) continue;
      if (!walkable(nx, ny)) continue;
      // no cutting corners diagonally past blocked tiles
      if (d.dx !== 0 && d.dy !== 0) {
        if (!walkable(cur.x + d.dx, cur.y) || !walkable(cur.x, cur.y + d.dy)) continue;
      }
      const g = cur.g + d.cost;
      const key = ny * map.width + nx;
      const prev = visited.get(key);
      if (prev !== undefined && prev <= g) continue;
      visited.set(key, g);
      open.push({ x: nx, y: ny, g, f: g + h(nx, ny), seq: seq++, parent: cur });
    }
  }

  // goal unreachable: head to the closest point we found, unless we never left start
  if (best.parent === null) return null;
  return reconstruct(best);
}

function reconstruct(node: Node): { x: number; y: number }[] {
  const path: { x: number; y: number }[] = [];
  let n: Node | null = node;
  while (n && n.parent) {
    path.push({ x: n.x + 0.5, y: n.y + 0.5 });
    n = n.parent;
  }
  path.reverse();
  return path;
}

/** Default walkable check used by unit movement. */
export function defaultWalkable(map: GameMap): WalkFn {
  return (x, y) => {
    const i = y * map.width + x;
    return map.terrain[i] !== T_WATER && map.trees[i] === 0 && map.occupied[i] === 0;
  };
}

/** Walkable but treating one entity's footprint as passable (path to a building). */
export function walkableIgnoring(map: GameMap, entityId: number): WalkFn {
  return (x, y) => {
    const i = y * map.width + x;
    if (map.terrain[i] === T_WATER || map.trees[i] !== 0) return false;
    return map.occupied[i] === 0 || map.occupied[i] === entityId;
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
