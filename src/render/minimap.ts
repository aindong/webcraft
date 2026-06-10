/**
 * Minimap: terrain + fog + entity dots, click/drag to move the camera.
 */
import { GameState, T_WATER } from '../sim/state';
import { Camera } from './camera';
import { Fog } from './fog';

export class Minimap {
  ctx: CanvasRenderingContext2D;
  size: number;

  constructor(public canvas: HTMLCanvasElement, size: number) {
    this.size = size;
    canvas.width = size;
    canvas.height = size;
    this.ctx = canvas.getContext('2d')!;
  }

  draw(state: GameState, fog: Fog, camera: Camera, localPlayer: number): void {
    const { ctx, size } = this;
    const map = state.map;
    const scale = size / map.width;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);

    // terrain (coarse: 1px per tile via scaling)
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const i = y * map.width + x;
        const f = fog.grid[i];
        if (f === 0) continue;
        let color: string;
        if (map.terrain[i] === T_WATER) color = '#1f4a72';
        else if (map.trees[i] > 0) color = '#1d4d24';
        else color = '#3d6830';
        ctx.fillStyle = color;
        ctx.globalAlpha = f === 1 ? 0.55 : 1;
        ctx.fillRect(x * scale, y * scale, scale + 0.5, scale + 0.5);
      }
    }
    ctx.globalAlpha = 1;

    // entities
    for (const e of state.entities.values()) {
      if (e.insideMine > 0) continue;
      const f = fog.at(e.x, e.y);
      if (f === 0) continue;
      if (f === 1 && !e.isBuilding) continue;
      let color: string;
      if (e.type === 'goldmine') color = '#ffd84d';
      else color = state.players[e.owner]?.color ?? '#fff';
      ctx.fillStyle = color;
      const r = e.isBuilding ? Math.max(2, e.size * scale) : Math.max(1.5, scale);
      ctx.fillRect(e.x * scale - r / 2, e.y * scale - r / 2, r, r);
    }

    // camera viewport diamond (approximate as rect of visible world bounds)
    const c0 = camera.screenToWorld(0, 0);
    const c1 = camera.screenToWorld(camera.screenW, 0);
    const c2 = camera.screenToWorld(camera.screenW, camera.screenH);
    const c3 = camera.screenToWorld(0, camera.screenH);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(c0.x * scale, c0.y * scale);
    ctx.lineTo(c1.x * scale, c1.y * scale);
    ctx.lineTo(c2.x * scale, c2.y * scale);
    ctx.lineTo(c3.x * scale, c3.y * scale);
    ctx.closePath();
    ctx.stroke();

    void localPlayer;
  }

  /** Convert a click on the minimap to world coords. */
  toWorld(px: number, py: number, mapW: number): { x: number; y: number } {
    const scale = this.size / mapW;
    return { x: px / scale, y: py / scale };
  }
}
