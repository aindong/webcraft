/**
 * Fog of war, computed for the local player's perspective. Presentation-side
 * only — the sim itself is fog-agnostic (units auto-acquire by range, and the
 * classic-style AI does not respect fog).
 */
import { GameState } from '../sim/state';
import { buildingDef, unitDef } from '../sim/data';

export class Fog {
  width: number;
  height: number;
  /** 0 = unexplored, 1 = explored (dim), 2 = currently visible */
  grid: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.grid = new Uint8Array(width * height);
  }

  update(state: GameState, player: number): void {
    // downgrade visible -> explored
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i] === 2) this.grid[i] = 1;
    }
    for (const e of state.entities.values()) {
      if (e.owner !== player || e.insideMine > 0) continue;
      const sight = e.isBuilding
        ? buildingDef(e.type)?.sight ?? 6
        : unitDef(e.type)?.sight ?? 5;
      this.reveal(e.x, e.y, sight);
    }
  }

  private reveal(cx: number, cy: number, r: number): void {
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) this.grid[y * this.width + x] = 2;
      }
    }
  }

  at(x: number, y: number): number {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return 0;
    return this.grid[yi * this.width + xi];
  }

  revealAll(): void {
    this.grid.fill(2);
  }
}
