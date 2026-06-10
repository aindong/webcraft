/**
 * AI-painted sprite assets, loaded from public/assets/sprites/.
 *
 * Two kinds:
 *  - statics:  `<type>.png` — buildings, tree, goldmine (single image)
 *  - sheets:   `<type>_sheet.png` — units, a 2x2 grid of poses:
 *              [top-left]=idle  [top-right]=walk A
 *              [bottom-left]=walk B  [bottom-right]=attack
 *
 * Sheets are sliced into 4 frames at load. All frames of a sheet are cropped
 * with ONE shared bounding box (union of the four), so the character doesn't
 * jitter when frames swap during animation.
 *
 * Anything missing falls back to the procedurally drawn sprites — the game
 * must always run with an empty assets directory.
 */

export const STATIC_SPRITE_NAMES = [
  'townhall', 'house', 'barracks', 'tower',
  'greathall', 'hut', 'warcamp', 'spiketower',
  'tree', 'goldmine',
] as const;

export const UNIT_SHEET_NAMES = [
  'peasant', 'footman', 'archer', 'knight',
  'peon', 'grunt', 'spearthrower', 'raider',
] as const;

/** Frame indices within a unit sheet. */
export const FRAME_IDLE = 0;
export const FRAME_WALK_A = 1;
export const FRAME_WALK_B = 2;
export const FRAME_ATTACK = 3;

export interface GameAssets {
  statics: Map<string, HTMLCanvasElement>;
  /** unit type -> [idle, walkA, walkB, attack] */
  sheets: Map<string, HTMLCanvasElement[]>;
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function alphaBounds(data: Uint8ClampedArray, w: number, h: number, x0: number, y0: number, x1: number, y1: number): Box | null {
  let minX = x1, minY = y1, maxX = -1, maxY = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (data[(y * w + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

function readPixels(img: HTMLImageElement): { data: Uint8ClampedArray; w: number; h: number } | null {
  const w = img.naturalWidth, h = img.naturalHeight;
  const scratch = document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  try {
    return { data: ctx.getImageData(0, 0, w, h).data, w, h };
  } catch {
    return null; // tainted canvas etc.
  }
}

/** Crop a static image to its opaque bounding box. */
function trimToContent(img: HTMLImageElement): HTMLCanvasElement | null {
  const px = readPixels(img);
  if (!px) return null;
  const box = alphaBounds(px.data, px.w, px.h, 0, 0, px.w, px.h);
  const out = document.createElement('canvas');
  if (!box) {
    out.width = px.w;
    out.height = px.h;
    out.getContext('2d')!.drawImage(img, 0, 0);
    return out;
  }
  out.width = box.maxX - box.minX + 1;
  out.height = box.maxY - box.minY + 1;
  out.getContext('2d')!.drawImage(img, box.minX, box.minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/**
 * Slice a 2x2 sheet into 4 aligned frames. Each cell's bounds are computed
 * relative to its own cell, then unioned, so every frame is cropped
 * identically and the feet stay planted across frames.
 */
function sliceSheet(img: HTMLImageElement): HTMLCanvasElement[] | null {
  const px = readPixels(img);
  if (!px) return null;
  const cw = Math.floor(px.w / 2), ch = Math.floor(px.h / 2);
  const cells = [
    { x: 0, y: 0 }, { x: cw, y: 0 },
    { x: 0, y: ch }, { x: cw, y: ch },
  ];

  // union of per-cell bounds, in cell-relative coords
  let u: Box | null = null;
  for (const c of cells) {
    const b = alphaBounds(px.data, px.w, px.h, c.x, c.y, c.x + cw, c.y + ch);
    if (!b) continue;
    const rel = { minX: b.minX - c.x, minY: b.minY - c.y, maxX: b.maxX - c.x, maxY: b.maxY - c.y };
    if (!u) u = { ...rel };
    else {
      u.minX = Math.min(u.minX, rel.minX);
      u.minY = Math.min(u.minY, rel.minY);
      u.maxX = Math.max(u.maxX, rel.maxX);
      u.maxY = Math.max(u.maxY, rel.maxY);
    }
  }
  if (!u) return null;

  const fw = u.maxX - u.minX + 1;
  const fh = u.maxY - u.minY + 1;
  return cells.map((c) => {
    const frame = document.createElement('canvas');
    frame.width = fw;
    frame.height = fh;
    frame.getContext('2d')!.drawImage(img, c.x + u!.minX, c.y + u!.minY, fw, fh, 0, 0, fw, fh);
    return frame;
  });
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export async function loadGameAssets(): Promise<GameAssets> {
  const base = `${import.meta.env.BASE_URL}assets/sprites/`;
  const statics = new Map<string, HTMLCanvasElement>();
  const sheets = new Map<string, HTMLCanvasElement[]>();

  await Promise.all([
    ...STATIC_SPRITE_NAMES.map(async (name) => {
      const img = await loadImage(`${base}${name}.png`);
      if (!img) return;
      const trimmed = trimToContent(img);
      if (trimmed) statics.set(name, trimmed);
    }),
    ...UNIT_SHEET_NAMES.map(async (name) => {
      const img = await loadImage(`${base}${name}_sheet.png`);
      if (img) {
        const frames = sliceSheet(img);
        if (frames) {
          sheets.set(name, frames);
          return;
        }
      }
      // fallback: a single static image for this unit (pre-sheet asset sets)
      const single = await loadImage(`${base}${name}.png`);
      if (single) {
        const trimmed = trimToContent(single);
        if (trimmed) sheets.set(name, [trimmed, trimmed, trimmed, trimmed]);
      }
    }),
  ]);

  return { statics, sheets };
}
