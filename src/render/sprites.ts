/**
 * Procedural sprite atlas. All art is drawn with canvas primitives at load
 * time and baked into offscreen canvases — zero asset files, instant load,
 * and a coherent chunky pixel-art look (drawn at low res, scaled up).
 */
import { TILE_H, TILE_W } from './camera';

export interface SpriteAtlas {
  tiles: Record<string, HTMLCanvasElement[]>;
  trees: HTMLCanvasElement[];
  goldmine: HTMLCanvasElement;
  goldmineDepletedSoon: HTMLCanvasElement;
  /** buildings[type][level-1] and a construction sprite per type */
  buildings: Record<string, { levels: HTMLCanvasElement[]; construction: HTMLCanvasElement }>;
  /** units[type][colorIndex][frame] — frame 0/1 walk, 2 = carry gold, 3 = carry wood */
  units: Record<string, HTMLCanvasElement[][]>;
}

export const PLAYER_COLORS = ['#3b6fe0', '#d03b3b', '#2fa84f', '#c8a020'];

function make(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

function diamondPath(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w, h / 2);
  ctx.lineTo(w / 2, h);
  ctx.lineTo(0, h / 2);
  ctx.closePath();
}

// simple deterministic hash noise for texture speckles
function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, colors: string[], count: number, seed: number): void {
  let s = seed;
  const rnd = () => {
    s = (Math.imul(s, 1597334677) + 12345) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const x = rnd() * w, y = rnd() * h;
    // keep speckles inside the diamond
    const nx = Math.abs(x - w / 2) / (w / 2), ny = Math.abs(y - h / 2) / (h / 2);
    if (nx + ny > 0.9) continue;
    ctx.fillStyle = colors[Math.floor(rnd() * colors.length)];
    ctx.fillRect(Math.floor(x), Math.floor(y), 2, 1);
  }
}

function bakeTile(base: string, light: string, dark: string, seed: number): HTMLCanvasElement {
  const [c, ctx] = make(TILE_W, TILE_H);
  diamondPath(ctx, TILE_W, TILE_H);
  ctx.fillStyle = base;
  ctx.fill();
  ctx.save();
  diamondPath(ctx, TILE_W, TILE_H);
  ctx.clip();
  speckle(ctx, TILE_W, TILE_H, [light, dark], 26, seed);
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 1;
  diamondPath(ctx, TILE_W, TILE_H);
  ctx.stroke();
  return c;
}

function bakeTree(variant: number): HTMLCanvasElement {
  const [c, ctx] = make(TILE_W, TILE_H * 2.5);
  const cx = TILE_W / 2;
  const baseY = TILE_H * 2.5 - TILE_H / 2;
  // trunk
  ctx.fillStyle = '#5a3d22';
  ctx.fillRect(cx - 3, baseY - 16, 6, 16);
  // canopy: stacked dark-to-light triangles (pine-ish)
  const greens = ['#1d4d24', '#266330', '#2f7a3c'];
  const spread = 18 + variant * 3;
  for (let i = 0; i < 3; i++) {
    const y = baseY - 12 - i * 13;
    const half = spread - i * 5;
    ctx.fillStyle = greens[i];
    ctx.beginPath();
    ctx.moveTo(cx, y - 18);
    ctx.lineTo(cx + half, y);
    ctx.lineTo(cx - half, y);
    ctx.closePath();
    ctx.fill();
  }
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.ellipse(cx, baseY, 16, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

function bakeGoldMine(depleted: boolean): HTMLCanvasElement {
  const W = TILE_W * 3, H = TILE_H * 3.2;
  const [c, ctx] = make(W, H);
  const cx = W / 2;
  const baseY = H - TILE_H * 1.5;
  // mound
  ctx.fillStyle = depleted ? '#6b6353' : '#8a7a55';
  ctx.beginPath();
  ctx.moveTo(cx - 70, baseY + 18);
  ctx.quadraticCurveTo(cx - 40, baseY - 50, cx, baseY - 56);
  ctx.quadraticCurveTo(cx + 40, baseY - 50, cx + 70, baseY + 18);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = depleted ? '#7d7464' : '#9c8c66';
  ctx.beginPath();
  ctx.moveTo(cx - 50, baseY + 8);
  ctx.quadraticCurveTo(cx - 25, baseY - 40, cx, baseY - 44);
  ctx.quadraticCurveTo(cx + 25, baseY - 40, cx + 50, baseY + 8);
  ctx.closePath();
  ctx.fill();
  // entrance
  ctx.fillStyle = '#1c1410';
  ctx.beginPath();
  ctx.moveTo(cx - 16, baseY + 14);
  ctx.quadraticCurveTo(cx, baseY - 22, cx + 16, baseY + 14);
  ctx.closePath();
  ctx.fill();
  // timber frame
  ctx.strokeStyle = '#4a3318';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx - 18, baseY + 14);
  ctx.quadraticCurveTo(cx, baseY - 26, cx + 18, baseY + 14);
  ctx.stroke();
  // gold glints
  if (!depleted) {
    ctx.fillStyle = '#ffd84d';
    [[-30, -14], [24, -22], [-8, -38], [34, -4]].forEach(([dx, dy]) => {
      ctx.fillRect(cx + dx, baseY + dy, 4, 3);
    });
  }
  return c;
}

// ---------------------------------------------------------------------------
// Buildings — stylized per-race silhouettes
// ---------------------------------------------------------------------------

interface BuildingStyle {
  wall: string;
  wallDark: string;
  roof: string;
  roofDark: string;
  accent: string;
}

const HUMAN_STYLE: BuildingStyle = { wall: '#cfc4a8', wallDark: '#a89a7a', roof: '#7a4a2a', roofDark: '#5e3820', accent: '#3b6fe0' };
const ORC_STYLE: BuildingStyle = { wall: '#7a6248', wallDark: '#5c4936', roof: '#4d3a28', roofDark: '#382a1d', accent: '#a8281e' };

function bakeBuilding(type: string, level: number, sizeTiles: number): HTMLCanvasElement {
  const W = TILE_W * sizeTiles;
  const H = TILE_H * sizeTiles + TILE_H * 2.8; // headroom for roofs, banners, pennants
  const [c, ctx] = make(W, H);
  const isOrc = ['greathall', 'hut', 'warcamp', 'spiketower'].includes(type);
  const st = { ...(isOrc ? ORC_STYLE : HUMAN_STYLE) };
  // military buildings read as "war" at a glance: deep red roofs
  if (type === 'barracks') { st.roof = '#8a3a28'; st.roofDark = '#682a1e'; }
  if (type === 'warcamp') { st.roof = '#5e241c'; st.roofDark = '#451a14'; }
  const groundY = H - (TILE_H * sizeTiles) / 2;
  const cx = W / 2;
  const footW = W * 0.42;
  const wallH = 26 + level * 7 + sizeTiles * 8;

  // ground shadow diamond
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(cx, groundY, footW * 1.05, footW * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();

  const isTower = type === 'tower' || type === 'spiketower';
  const towerScale = isTower ? 0.55 : 1;
  const fw = footW * towerScale;
  const wh = isTower ? wallH * 1.9 : wallH;

  // two visible walls of an iso box
  // left wall
  ctx.fillStyle = st.wallDark;
  ctx.beginPath();
  ctx.moveTo(cx - fw, groundY - fw * 0.5);
  ctx.lineTo(cx, groundY);
  ctx.lineTo(cx, groundY - wh);
  ctx.lineTo(cx - fw, groundY - fw * 0.5 - wh);
  ctx.closePath();
  ctx.fill();
  // right wall
  ctx.fillStyle = st.wall;
  ctx.beginPath();
  ctx.moveTo(cx + fw, groundY - fw * 0.5);
  ctx.lineTo(cx, groundY);
  ctx.lineTo(cx, groundY - wh);
  ctx.lineTo(cx + fw, groundY - fw * 0.5 - wh);
  ctx.closePath();
  ctx.fill();

  // roof
  const roofPeak = groundY - wh - fw * 0.55 - (level - 1) * 6;
  if (isOrc) {
    // jagged hide roof
    ctx.fillStyle = st.roof;
    ctx.beginPath();
    ctx.moveTo(cx - fw, groundY - fw * 0.5 - wh);
    ctx.lineTo(cx, roofPeak);
    ctx.lineTo(cx + fw, groundY - fw * 0.5 - wh);
    ctx.lineTo(cx, groundY - wh);
    ctx.closePath();
    ctx.fill();
    // spikes
    ctx.strokeStyle = '#d9cfb8';
    ctx.lineWidth = 3;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(cx + i * fw * 0.5, roofPeak + Math.abs(i) * 10 + 6);
      ctx.lineTo(cx + i * fw * 0.5 + i * 6, roofPeak + Math.abs(i) * 10 - 12);
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = st.roofDark;
    ctx.beginPath();
    ctx.moveTo(cx - fw, groundY - fw * 0.5 - wh);
    ctx.lineTo(cx, roofPeak);
    ctx.lineTo(cx, groundY - wh);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = st.roof;
    ctx.beginPath();
    ctx.moveTo(cx + fw, groundY - fw * 0.5 - wh);
    ctx.lineTo(cx, roofPeak);
    ctx.lineTo(cx, groundY - wh);
    ctx.closePath();
    ctx.fill();
  }

  // door
  ctx.fillStyle = '#241a10';
  ctx.fillRect(cx + fw * 0.25 - 6, groundY - fw * 0.25 - 18, 12, 18);

  // per-type identity marks
  const isHall = type === 'townhall' || type === 'greathall';
  const isBarracks = type === 'barracks' || type === 'warcamp';
  if (isHall) {
    // tall banner pole with race-colored standard
    ctx.strokeStyle = '#777';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, roofPeak);
    ctx.lineTo(cx, roofPeak - 26);
    ctx.stroke();
    ctx.fillStyle = '#ffd84d';
    ctx.beginPath();
    ctx.moveTo(cx, roofPeak - 26);
    ctx.lineTo(cx + 18, roofPeak - 20);
    ctx.lineTo(cx, roofPeak - 14);
    ctx.closePath();
    ctx.fill();
    // gilded trim above the door
    ctx.fillStyle = '#ffd84d';
    ctx.fillRect(cx + fw * 0.25 - 8, groundY - fw * 0.25 - 22, 16, 3);
  } else if (isBarracks) {
    // crossed weapons emblem on the right wall + red standard
    const ex = cx + fw * 0.55, ey = groundY - fw * 0.35 - wh * 0.55;
    ctx.strokeStyle = '#d8d8e2';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(ex - 8, ey - 8);
    ctx.lineTo(ex + 8, ey + 8);
    ctx.moveTo(ex + 8, ey - 8);
    ctx.lineTo(ex - 8, ey + 8);
    ctx.stroke();
    ctx.fillStyle = '#a8281e';
    ctx.fillRect(cx - fw * 0.8, groundY - fw * 0.4 - wh - 4, 10, 14);
  }

  // level pennant
  if (level >= 2) {
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, roofPeak);
    ctx.lineTo(cx, roofPeak - 18);
    ctx.stroke();
    ctx.fillStyle = level >= 3 ? '#ffd84d' : st.accent;
    ctx.beginPath();
    ctx.moveTo(cx, roofPeak - 18);
    ctx.lineTo(cx + 14, roofPeak - 13);
    ctx.lineTo(cx, roofPeak - 8);
    ctx.closePath();
    ctx.fill();
  }

  // windows for big buildings
  if (sizeTiles >= 3) {
    ctx.fillStyle = '#ffe9a0';
    ctx.fillRect(cx - fw * 0.55, groundY - fw * 0.3 - wh * 0.6, 7, 9);
    ctx.fillRect(cx + fw * 0.5, groundY - fw * 0.3 - wh * 0.55, 7, 9);
  }

  return c;
}

function bakeConstruction(sizeTiles: number): HTMLCanvasElement {
  const W = TILE_W * sizeTiles;
  const H = TILE_H * sizeTiles + TILE_H;
  const [c, ctx] = make(W, H);
  const groundY = H - (TILE_H * sizeTiles) / 2;
  const cx = W / 2;
  const fw = W * 0.4;
  // dirt patch
  ctx.fillStyle = '#6b5639';
  ctx.beginPath();
  ctx.ellipse(cx, groundY, fw, fw * 0.48, 0, 0, Math.PI * 2);
  ctx.fill();
  // scaffold frame
  ctx.strokeStyle = '#9c7c4c';
  ctx.lineWidth = 4;
  ctx.strokeRect(cx - fw * 0.6, groundY - 34, fw * 1.2, 30);
  ctx.beginPath();
  ctx.moveTo(cx - fw * 0.6, groundY - 34);
  ctx.lineTo(cx + fw * 0.6, groundY - 4);
  ctx.moveTo(cx + fw * 0.6, groundY - 34);
  ctx.lineTo(cx - fw * 0.6, groundY - 4);
  ctx.stroke();
  // lumber pile
  ctx.fillStyle = '#8a6a3c';
  ctx.fillRect(cx - fw * 0.5, groundY - 2, 26, 6);
  ctx.fillRect(cx - fw * 0.5 + 4, groundY - 8, 26, 6);
  return c;
}

// ---------------------------------------------------------------------------
// Units — tiny chunky humanoids, baked per (type, playerColor, frame)
// ---------------------------------------------------------------------------

const UNIT_FRAMES = 4; // 0,1 = walk bob; 2 = carrying gold; 3 = carrying wood

function bakeUnit(type: string, color: string, frame: number): HTMLCanvasElement {
  const S = 48;
  const [c, ctx] = make(S, S);
  const cx = S / 2;
  const isOrc = ['peon', 'grunt', 'spearthrower', 'raider'].includes(type);
  const skin = isOrc ? '#5d8a4a' : '#e8b88a';
  const bob = frame === 1 ? 1.5 : 0;
  const baseY = S - 8;

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(cx, baseY, 10, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  const bodyTop = baseY - 22 + bob;

  // legs
  ctx.fillStyle = '#3a2e22';
  const legSpread = frame === 1 ? 4 : 2.5;
  ctx.fillRect(cx - legSpread - 2, baseY - 9, 4, 9);
  ctx.fillRect(cx + legSpread - 2, baseY - 9, 4, 9);

  // torso (player color tunic)
  ctx.fillStyle = color;
  ctx.fillRect(cx - 6, bodyTop, 12, 14);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(cx - 6, bodyTop + 10, 12, 4);

  // head
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.arc(cx, bodyTop - 5, 5.5, 0, Math.PI * 2);
  ctx.fill();
  if (isOrc) {
    // tusks + ears
    ctx.fillStyle = '#e8e0c8';
    ctx.fillRect(cx - 4, bodyTop - 3, 2, 4);
    ctx.fillRect(cx + 2, bodyTop - 3, 2, 4);
  } else {
    // hair
    ctx.fillStyle = '#5a3d22';
    ctx.fillRect(cx - 5, bodyTop - 11, 10, 4);
  }

  // role gear
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 2.5;
  const armY = bodyTop + 4;
  switch (type) {
    case 'peasant':
    case 'peon': {
      if (frame === 2) {
        // gold sack
        ctx.fillStyle = '#ffd84d';
        ctx.beginPath();
        ctx.arc(cx + 9, armY, 5, 0, Math.PI * 2);
        ctx.fill();
      } else if (frame === 3) {
        // log bundle
        ctx.fillStyle = '#8a6a3c';
        ctx.fillRect(cx + 4, armY - 3, 12, 5);
      } else {
        // pickaxe
        ctx.strokeStyle = '#7a5c34';
        ctx.beginPath();
        ctx.moveTo(cx + 7, armY + 6);
        ctx.lineTo(cx + 12, armY - 8);
        ctx.stroke();
        ctx.strokeStyle = '#999';
        ctx.beginPath();
        ctx.moveTo(cx + 8, armY - 7);
        ctx.lineTo(cx + 16, armY - 5);
        ctx.stroke();
      }
      break;
    }
    case 'footman': {
      // sword + shield
      ctx.strokeStyle = '#c8c8d4';
      ctx.beginPath();
      ctx.moveTo(cx + 8, armY + 4);
      ctx.lineTo(cx + 14, armY - 10);
      ctx.stroke();
      ctx.fillStyle = '#d4d4dd';
      ctx.beginPath();
      ctx.arc(cx - 9, armY + 2, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx - 9, armY + 2, 2.5, 0, Math.PI * 2);
      ctx.fill();
      // helmet
      ctx.fillStyle = '#aab';
      ctx.fillRect(cx - 5.5, bodyTop - 12, 11, 5);
      break;
    }
    case 'archer': {
      ctx.strokeStyle = '#7a5c34';
      ctx.beginPath();
      ctx.arc(cx + 10, armY - 2, 8, -Math.PI / 2.4, Math.PI / 2.4);
      ctx.stroke();
      ctx.strokeStyle = '#ccc';
      ctx.beginPath();
      ctx.moveTo(cx + 10, armY - 9);
      ctx.lineTo(cx + 10, armY + 5);
      ctx.stroke();
      // hood
      ctx.fillStyle = '#2f5a32';
      ctx.fillRect(cx - 5.5, bodyTop - 12, 11, 5);
      break;
    }
    case 'knight': {
      ctx.strokeStyle = '#dde';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(cx + 8, armY + 6);
      ctx.lineTo(cx + 15, armY - 12);
      ctx.stroke();
      ctx.fillStyle = '#ccd';
      ctx.fillRect(cx - 7, bodyTop - 1, 14, 15);
      ctx.fillStyle = color;
      ctx.fillRect(cx - 7, bodyTop + 5, 14, 4);
      // plumed helm
      ctx.fillStyle = '#aab';
      ctx.fillRect(cx - 5.5, bodyTop - 13, 11, 6);
      ctx.fillStyle = '#d03b3b';
      ctx.fillRect(cx - 1, bodyTop - 17, 3, 5);
      break;
    }
    case 'grunt': {
      // big axe
      ctx.strokeStyle = '#7a5c34';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx + 7, armY + 7);
      ctx.lineTo(cx + 13, armY - 11);
      ctx.stroke();
      ctx.fillStyle = '#b8b8c2';
      ctx.beginPath();
      ctx.moveTo(cx + 13, armY - 11);
      ctx.lineTo(cx + 20, armY - 7);
      ctx.lineTo(cx + 12, armY - 4);
      ctx.closePath();
      ctx.fill();
      // shoulder spike
      ctx.fillStyle = '#3a3a3a';
      ctx.fillRect(cx - 9, bodyTop - 2, 6, 6);
      break;
    }
    case 'spearthrower': {
      ctx.strokeStyle = '#7a5c34';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx + 4, armY + 8);
      ctx.lineTo(cx + 16, armY - 12);
      ctx.stroke();
      ctx.fillStyle = '#ccc';
      ctx.beginPath();
      ctx.moveTo(cx + 16, armY - 12);
      ctx.lineTo(cx + 19, armY - 16);
      ctx.lineTo(cx + 18, armY - 10);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'raider': {
      // mounted: wolf body
      ctx.fillStyle = '#4a4640';
      ctx.beginPath();
      ctx.ellipse(cx, baseY - 7, 13, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx + 13, baseY - 10, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#7a5c34';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx - 2, armY);
      ctx.lineTo(cx + 10, armY - 14);
      ctx.stroke();
      break;
    }
  }

  return c;
}

export function bakeAtlas(matchColors: string[]): SpriteAtlas {
  const tiles: Record<string, HTMLCanvasElement[]> = {
    grass: [bakeTile('#4a7c3a', '#5d9148', '#3d6830', 1), bakeTile('#4e8040', '#629a4e', '#406c34', 7), bakeTile('#477938', '#578a44', '#3a642e', 13)],
    dirt: [bakeTile('#8a7350', '#9c8662', '#75603f', 3), bakeTile('#85704e', '#97825f', '#705c3d', 9)],
    water: [bakeTile('#2a5d8a', '#3a76a8', '#1f4a72', 5), bakeTile('#2d628f', '#3d7bad', '#224d75', 11)],
  };

  const buildings: SpriteAtlas['buildings'] = {};
  const defs: [string, number, number][] = [
    ['townhall', 3, 3], ['house', 2, 2], ['barracks', 3, 3], ['tower', 2, 2],
    ['greathall', 3, 3], ['hut', 2, 2], ['warcamp', 3, 3], ['spiketower', 2, 2],
  ];
  for (const [type, size, maxLevels] of defs) {
    const levels: HTMLCanvasElement[] = [];
    for (let l = 1; l <= maxLevels; l++) levels.push(bakeBuilding(type, l, size));
    buildings[type] = { levels, construction: bakeConstruction(size) };
  }

  const units: SpriteAtlas['units'] = {};
  for (const type of ['peasant', 'footman', 'archer', 'knight', 'peon', 'grunt', 'spearthrower', 'raider']) {
    units[type] = matchColors.map((color) => {
      const frames: HTMLCanvasElement[] = [];
      for (let f = 0; f < UNIT_FRAMES; f++) frames.push(bakeUnit(type, color, f));
      return frames;
    });
  }

  return {
    tiles,
    trees: [bakeTree(0), bakeTree(1), bakeTree(2)],
    goldmine: bakeGoldMine(false),
    goldmineDepletedSoon: bakeGoldMine(true),
    buildings,
    units,
  };
}
