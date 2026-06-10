/**
 * Isometric camera: world tiles → screen pixels, panning, zoom.
 * Tile diamond is TILE_W × TILE_H pixels at zoom 1.
 */
export const TILE_W = 64;
export const TILE_H = 32;

export class Camera {
  /** world coords (in tiles) at the center of the screen */
  x = 0;
  y = 0;
  zoom = 1;
  screenW = 0;
  screenH = 0;

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    const ix = (wx - wy) * (TILE_W / 2);
    const iy = (wx + wy) * (TILE_H / 2);
    const cx = (this.x - this.y) * (TILE_W / 2);
    const cy = (this.x + this.y) * (TILE_H / 2);
    return {
      x: (ix - cx) * this.zoom + this.screenW / 2,
      y: (iy - cy) * this.zoom + this.screenH / 2,
    };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const cx = (this.x - this.y) * (TILE_W / 2);
    const cy = (this.x + this.y) * (TILE_H / 2);
    const ix = (sx - this.screenW / 2) / this.zoom + cx;
    const iy = (sy - this.screenH / 2) / this.zoom + cy;
    const wx = ix / TILE_W + iy / TILE_H;
    const wy = iy / TILE_H - ix / TILE_W;
    return { x: wx, y: wy };
  }

  pan(dxPixels: number, dyPixels: number): void {
    const dix = dxPixels / this.zoom;
    const diy = dyPixels / this.zoom;
    this.x += dix / TILE_W + diy / TILE_H;
    this.y += diy / TILE_H - dix / TILE_W;
  }

  clampTo(mapW: number, mapH: number): void {
    this.x = Math.max(0, Math.min(mapW, this.x));
    this.y = Math.max(0, Math.min(mapH, this.y));
    this.zoom = Math.max(0.5, Math.min(2.5, this.zoom));
  }
}
