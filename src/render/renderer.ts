/**
 * Isometric canvas renderer. Draws terrain back-to-front, then entities
 * depth-sorted by world (x+y), then fog, selection UI, and effects.
 * Positions are interpolated between sim ticks for smooth 60fps motion.
 */
import { buildingDef, unitDef } from '../sim/data';
import { Entity, GameState, T_DIRT, T_WATER } from '../sim/state';
import { ATTACK_FRAMES, FRAME_IDLE, GameAssets, WALK_FRAMES } from './assets';
import { Camera, TILE_H, TILE_W } from './camera';
import { Fog } from './fog';
import { SpriteAtlas } from './sprites';

/** How long the attack animation plays after a swing, ms. */
const STRIKE_FRAME_MS = 360;
/** Walk cycle frame duration, ms (4-frame cycle → ~9 fps). */
const WALK_FRAME_MS = 110;

export interface FloatingText {
  x: number; y: number;
  text: string;
  color: string;
  age: number; // seconds
}

export interface Effect {
  x: number; y: number;
  kind: 'slash' | 'arrow' | 'death' | 'collapse';
  age: number;
  /** for arrows: target position */
  tx?: number; ty?: number;
}

export class Renderer {
  ctx: CanvasRenderingContext2D;
  floatingTexts: FloatingText[] = [];
  effects: Effect[] = [];
  placingGhost: { type: string; tx: number; ty: number; valid: boolean } | null = null;

  /** entity id -> performance.now() of last observed attack swing */
  private strikeAt = new Map<number, number>();

  constructor(
    public canvas: HTMLCanvasElement,
    public atlas: SpriteAtlas,
    public camera: Camera,
    public assets: GameAssets = { statics: new Map(), sheets: new Map() },
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  addFloatingText(x: number, y: number, text: string, color: string): void {
    this.floatingTexts.push({ x, y, text, color, age: 0 });
  }

  addEffect(e: Effect): void {
    this.effects.push(e);
  }

  /**
   * @param alpha interpolation factor between previous and current tick [0,1]
   */
  draw(
    state: GameState, fog: Fog, localPlayer: number,
    selection: Set<number>, alpha: number, dt: number,
    dragRect: { x0: number; y0: number; x1: number; y1: number } | null,
  ): void {
    const { ctx, camera, atlas } = this;
    const W = camera.screenW, H = camera.screenH;
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, W, H);

    const map = state.map;

    // visible tile bounds (loose)
    const corners = [
      camera.screenToWorld(0, 0), camera.screenToWorld(W, 0),
      camera.screenToWorld(0, H), camera.screenToWorld(W, H),
    ];
    const minX = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.x))) - 2);
    const maxX = Math.min(map.width - 1, Math.ceil(Math.max(...corners.map((c) => c.x))) + 2);
    const minY = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.y))) - 2);
    const maxY = Math.min(map.height - 1, Math.ceil(Math.max(...corners.map((c) => c.y))) + 4);

    const tw = TILE_W * camera.zoom;
    const th = TILE_H * camera.zoom;

    // --- terrain ---
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const f = fog.grid[y * map.width + x];
        if (f === 0) continue;
        const t = map.terrain[y * map.width + x];
        const variants = t === T_WATER ? atlas.tiles.water : t === T_DIRT ? atlas.tiles.dirt : atlas.tiles.grass;
        const img = variants[(x * 7 + y * 13) % variants.length];
        const s = camera.worldToScreen(x, y);
        ctx.drawImage(img, s.x - tw / 2, s.y - th / 2 + th / 2, tw, th);
      }
    }

    // --- depth-sorted drawables: trees + entities ---
    interface Drawable {
      depth: number;
      draw: () => void;
    }
    const drawables: Drawable[] = [];

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const i = y * map.width + x;
        if (map.trees[i] === 0) continue;
        const f = fog.grid[i];
        if (f === 0) continue;
        const aiTree = this.assets.statics.get('tree');
        const img = aiTree ?? atlas.trees[(x * 11 + y * 17) % atlas.trees.length];
        const s = camera.worldToScreen(x + 0.5, y + 0.5);
        // subtle deterministic size variation so AI forests don't look stamped
        const vary = aiTree ? 0.88 + ((x * 31 + y * 7) % 5) * 0.06 : 1;
        drawables.push({
          depth: x + y,
          draw: () => {
            ctx.globalAlpha = f === 1 ? 0.7 : 1;
            const w = tw * 1.1 * vary, h = (img.height / img.width) * w;
            ctx.drawImage(img, s.x - w / 2, s.y - h + th / 2, w, h);
            ctx.globalAlpha = 1;
          },
        });
      }
    }

    for (const e of state.entities.values()) {
      if (e.insideMine > 0) continue;
      const ex = e.px + (e.x - e.px) * alpha;
      const ey = e.py + (e.y - e.py) * alpha;
      const fv = fog.at(e.x, e.y);
      if (fv === 0) continue;
      if (fv === 1 && !e.isBuilding) continue; // units invisible in explored-but-dark

      const s = camera.worldToScreen(ex, ey);
      if (s.x < -150 || s.x > W + 150 || s.y < -200 || s.y > H + 150) continue;

      drawables.push({
        depth: ex + ey + (e.isBuilding ? e.size / 2 - 0.01 : 0),
        draw: () => this.drawEntity(state, e, s, fv, selection.has(e.id), localPlayer, alpha),
      });
    }

    drawables.sort((a, b) => a.depth - b.depth);
    for (const d of drawables) d.draw();

    // prune stale strike timestamps (dead/old entities)
    if (this.strikeAt.size > 256) {
      const cutoff = performance.now() - 2000;
      for (const [id, t] of this.strikeAt) {
        if (t < cutoff) this.strikeAt.delete(id);
      }
    }

    // --- effects ---
    this.drawEffects(dt);

    // --- fog dimming over explored tiles ---
    ctx.fillStyle = 'rgba(8, 8, 20, 0.45)';
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (fog.grid[y * map.width + x] !== 1) continue;
        const s = camera.worldToScreen(x, y);
        this.diamond(s.x, s.y + th / 2, tw, th);
        ctx.fill();
      }
    }

    // --- building placement ghost ---
    if (this.placingGhost) {
      const g = this.placingGhost;
      const def = buildingDef(g.type);
      ctx.globalAlpha = 0.55;
      for (let dy = 0; dy < def.size; dy++) {
        for (let dx = 0; dx < def.size; dx++) {
          const s = camera.worldToScreen(g.tx + dx, g.ty + dy);
          ctx.fillStyle = g.valid ? 'rgba(80, 220, 100, 0.6)' : 'rgba(220, 60, 60, 0.6)';
          this.diamond(s.x, s.y + th / 2, tw, th);
          ctx.fill();
        }
      }
      const sprite = this.assets.statics.get(g.type) ?? this.atlas.buildings[g.type]?.levels[0];
      if (sprite && g.valid) {
        const s = camera.worldToScreen(g.tx + def.size / 2, g.ty + def.size / 2);
        const w = tw * def.size;
        const h = (sprite.height / sprite.width) * w;
        ctx.drawImage(sprite, s.x - w / 2, s.y - h + (th * def.size) / 2, w, h);
      }
      ctx.globalAlpha = 1;
    }

    // --- floating texts ---
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(13 * camera.zoom)}px 'Segoe UI', sans-serif`;
    this.floatingTexts = this.floatingTexts.filter((t) => (t.age += dt) < 1.4);
    for (const t of this.floatingTexts) {
      const s = camera.worldToScreen(t.x, t.y);
      ctx.globalAlpha = Math.max(0, 1 - t.age / 1.4);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, s.x, s.y - 30 - t.age * 28);
    }
    ctx.globalAlpha = 1;

    // --- drag-select rectangle ---
    if (dragRect) {
      ctx.strokeStyle = 'rgba(120, 255, 140, 0.9)';
      ctx.fillStyle = 'rgba(120, 255, 140, 0.08)';
      ctx.lineWidth = 1.5;
      const x = Math.min(dragRect.x0, dragRect.x1);
      const y = Math.min(dragRect.y0, dragRect.y1);
      const w = Math.abs(dragRect.x1 - dragRect.x0);
      const h = Math.abs(dragRect.y1 - dragRect.y0);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }
  }

  private diamond(cx: number, cy: number, w: number, h: number): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(cx, cy - h / 2);
    ctx.lineTo(cx + w / 2, cy);
    ctx.lineTo(cx, cy + h / 2);
    ctx.lineTo(cx - w / 2, cy);
    ctx.closePath();
  }

  private drawEntity(
    state: GameState, e: Entity, s: { x: number; y: number },
    fogVal: number, selected: boolean, localPlayer: number, alpha: number,
  ): void {
    const { ctx, camera, atlas } = this;
    const tw = TILE_W * camera.zoom;
    const th = TILE_H * camera.zoom;
    const player = state.players[e.owner];

    ctx.globalAlpha = fogVal === 1 ? 0.6 : 1;

    if (selected) {
      ctx.strokeStyle = e.owner === localPlayer ? 'rgba(110, 255, 130, 0.95)' : 'rgba(255, 220, 80, 0.95)';
      ctx.lineWidth = 2;
      const r = e.isBuilding ? (e.size * tw) / 2.4 : tw * 0.3;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + (e.isBuilding ? (e.size * th) / 2.6 : th * 0.22), r, r / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (e.type === 'goldmine') {
      const ai = this.assets.statics.get('goldmine');
      const img = ai ?? (e.goldLeft > 2000 ? atlas.goldmine : atlas.goldmineDepletedSoon);
      if (ai && e.goldLeft <= 2000) ctx.filter = 'grayscale(0.7) brightness(0.85)';
      const w = tw * e.size;
      const h = (img.height / img.width) * w;
      ctx.drawImage(img, s.x - w / 2, s.y - h + (th * e.size) / 2, w, h);
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
      return;
    }

    if (e.isBuilding) {
      const set = atlas.buildings[e.type];
      if (!set) return;
      if (e.buildRemaining > 0) {
        const w = tw * e.size;
        const cimg = set.construction;
        const h = (cimg.height / cimg.width) * w;
        ctx.drawImage(cimg, s.x - w / 2, s.y - h + (th * e.size) / 2, w, h);
        // progress bar
        const progress = 1 - e.buildRemaining / e.buildTotal;
        this.bar(s.x, s.y - h * 0.7, tw * e.size * 0.6, progress, '#58c4ff');
      } else {
        const ai = this.assets.statics.get(e.type);
        const img = ai ?? set.levels[Math.min(e.level, set.levels.length) - 1];
        const w = tw * e.size;
        const h = (img.height / img.width) * w;
        ctx.drawImage(img, s.x - w / 2, s.y - h + (th * e.size) / 2, w, h);
        // AI sprites are one image for all levels: show upgrade level as pips
        if (ai && e.level >= 2) {
          ctx.fillStyle = '#ffd84d';
          ctx.strokeStyle = '#5a4300';
          ctx.lineWidth = 1.5;
          for (let i = 0; i < e.level - 1; i++) {
            ctx.beginPath();
            ctx.arc(s.x - 10 + i * 14, s.y - h + (th * e.size) / 2 - 8, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
        if (e.upgradeRemaining > 0) {
          const progress = 1 - e.upgradeRemaining / e.upgradeTotal;
          this.bar(s.x, s.y - h * 0.85, tw * e.size * 0.6, progress, '#ffd84d');
        } else if (e.trainQueue.length > 0) {
          const item = e.trainQueue[0];
          this.bar(s.x, s.y - h * 0.85, tw * e.size * 0.6, 1 - item.remaining / item.total, '#a0e0a0');
        }
      }
      if (e.hp < e.maxHp) {
        this.bar(s.x, s.y - (th * e.size) * 1.6, tw * e.size * 0.6, e.hp / e.maxHp, hpColor(e.hp / e.maxHp));
      }
      ctx.globalAlpha = 1;
      return;
    }

    // unit
    const def = unitDef(e.type);
    const colorIdx = Math.max(0, e.owner);
    const moving = Math.abs(e.x - e.px) + Math.abs(e.y - e.py) > 0.001;
    const now = performance.now();

    // remember swings so the attack frame lingers long enough to read
    if (e.striking) this.strikeAt.set(e.id, now);

    const sheet = this.assets.sheets.get(e.type);
    let img: HTMLCanvasElement;
    if (sheet) {
      let frame = FRAME_IDLE;
      const struck = this.strikeAt.get(e.id);
      if (struck !== undefined && now - struck < STRIKE_FRAME_MS) {
        // play windup → strike → follow-through across the strike window
        const p = (now - struck) / STRIKE_FRAME_MS;
        frame = ATTACK_FRAMES[Math.min(ATTACK_FRAMES.length - 1, Math.floor(p * ATTACK_FRAMES.length))];
      } else if (moving) {
        // offset by entity id so a group doesn't march in lockstep
        frame = WALK_FRAMES[(Math.floor(now / WALK_FRAME_MS) + e.id) % WALK_FRAMES.length];
      }
      img = sheet[frame];
    } else {
      const frames = atlas.units[e.type]?.[colorIdx];
      if (!frames) return;
      let frame = 0;
      if (e.carryType === 'gold') frame = 2;
      else if (e.carryType === 'wood') frame = 3;
      else if (moving) frame = Math.floor(now / 160) % 2;
      img = frames[frame];
    }
    const aiImg = sheet ? img : null;

    const size = tw * 0.62 * def.scale;
    const h = (img.height / img.width) * size;
    // strike lunge (walk motion comes from the real cycle frames now)
    let ox = 0, oy = 0;
    if (e.striking) {
      ox = Math.cos(e.facing) * 4 * camera.zoom;
      oy = Math.sin(e.facing) * 2 * camera.zoom;
    }

    // team-color ring under AI sprites (painted art can't be tinted per player)
    if (aiImg && player) {
      ctx.fillStyle = player.color;
      ctx.globalAlpha *= 0.5;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + th * 0.26, size * 0.34, size * 0.15, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = fogVal === 1 ? 0.6 : 1;
    }

    // Mirror to match movement direction. Painted sheets are drawn facing
    // LEFT, procedural sprites face RIGHT — flip on opposite sides.
    const facingRight = Math.cos(e.facing) > 0.1;
    const facingLeft = Math.cos(e.facing) < -0.1;
    const flip = sheet ? facingRight : facingLeft;
    ctx.save();
    ctx.translate(s.x + ox, s.y + oy + th * 0.3);
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(img, -size / 2, -h, size, h);
    ctx.restore();

    // carry badge for AI sprites (no dedicated carry frames)
    if (aiImg && e.carryType) {
      ctx.fillStyle = e.carryType === 'gold' ? '#ffd84d' : '#8a6a3c';
      ctx.strokeStyle = '#241a10';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(s.x + size * 0.32, s.y + oy - h * 0.55 + th * 0.3, 4.5 * camera.zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (e.hp < e.maxHp) {
      this.bar(s.x, s.y - h - 6, tw * 0.5, e.hp / e.maxHp, hpColor(e.hp / e.maxHp));
    }
    ctx.globalAlpha = 1;

    void alpha;
  }

  private bar(cx: number, cy: number, w: number, ratio: number, color: string): void {
    const { ctx } = this;
    const h = 4;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(cx - w / 2 - 1, cy - 1, w + 2, h + 2);
    ctx.fillStyle = color;
    ctx.fillRect(cx - w / 2, cy, w * Math.max(0, Math.min(1, ratio)), h);
  }

  private drawEffects(dt: number): void {
    const { ctx, camera } = this;
    this.effects = this.effects.filter((fx) => (fx.age += dt) < (fx.kind === 'collapse' ? 0.8 : 0.45));
    for (const fx of this.effects) {
      const s = camera.worldToScreen(fx.x, fx.y);
      const t = fx.age;
      switch (fx.kind) {
        case 'slash': {
          ctx.strokeStyle = `rgba(255, 255, 220, ${1 - t / 0.45})`;
          ctx.lineWidth = 2.5 * camera.zoom;
          ctx.beginPath();
          ctx.arc(s.x, s.y - 14 * camera.zoom, (8 + t * 30) * camera.zoom, -0.6, 0.9);
          ctx.stroke();
          break;
        }
        case 'arrow': {
          if (fx.tx === undefined) break;
          const e2 = camera.worldToScreen(fx.tx, fx.ty!);
          const p = Math.min(1, t / 0.3);
          const x = s.x + (e2.x - s.x) * p;
          const y = s.y + (e2.y - s.y) * p - Math.sin(p * Math.PI) * 24 * camera.zoom;
          ctx.fillStyle = '#e8e0c8';
          ctx.fillRect(x - 2, y - 14 * camera.zoom, 4, 4);
          break;
        }
        case 'death': {
          ctx.fillStyle = `rgba(180, 30, 30, ${1 - t / 0.45})`;
          for (let i = 0; i < 5; i++) {
            const a = (i / 5) * Math.PI * 2;
            const r = t * 40 * camera.zoom;
            ctx.fillRect(s.x + Math.cos(a) * r, s.y - 10 + Math.sin(a) * r * 0.5, 3, 3);
          }
          break;
        }
        case 'collapse': {
          ctx.fillStyle = `rgba(140, 120, 90, ${1 - t / 0.8})`;
          for (let i = 0; i < 9; i++) {
            const a = (i / 9) * Math.PI * 2 + t;
            const r = t * 60 * camera.zoom;
            ctx.fillRect(s.x + Math.cos(a) * r, s.y - 20 + Math.sin(a) * r * 0.5 - t * 10, 5, 5);
          }
          break;
        }
      }
    }
  }
}

function hpColor(ratio: number): string {
  if (ratio > 0.66) return '#5ad05a';
  if (ratio > 0.33) return '#e0c040';
  return '#e05040';
}
