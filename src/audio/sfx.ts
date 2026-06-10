/**
 * Procedural sound effects via Web Audio — tiny synth patches, no audio files.
 */
let ctx: AudioContext | null = null;
let muted = false;

function ac(): AudioContext | null {
  if (muted) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function setSfxMuted(m: boolean): void {
  muted = m;
}

export function isSfxMuted(): boolean {
  return muted;
}

function tone(
  freq: number, dur: number, type: OscillatorType, vol: number,
  slide = 0, delay = 0,
): void {
  const a = ac();
  if (!a) return;
  const t0 = a.currentTime + delay;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide !== 0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t0 + dur);
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(gain).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(dur: number, vol: number, freq = 1200, delay = 0): void {
  const a = ac();
  if (!a) return;
  const t0 = a.currentTime + delay;
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  const filter = a.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = freq;
  const gain = a.createGain();
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(filter).connect(gain).connect(a.destination);
  src.start(t0);
}

export const sfx = {
  click(): void {
    tone(900, 0.05, 'square', 0.05);
  },
  chop(): void {
    noise(0.08, 0.12, 800);
    tone(180, 0.07, 'triangle', 0.1, -60);
  },
  coin(): void {
    tone(1100, 0.07, 'sine', 0.08);
    tone(1500, 0.12, 'sine', 0.07, 0, 0.05);
  },
  woodDrop(): void {
    tone(220, 0.1, 'triangle', 0.1, -80);
    tone(170, 0.12, 'triangle', 0.08, -60, 0.06);
  },
  swordHit(): void {
    noise(0.06, 0.1, 3000);
    tone(320, 0.08, 'square', 0.06, -120);
  },
  arrowShot(): void {
    noise(0.12, 0.06, 5000);
    tone(800, 0.1, 'sine', 0.04, -500);
  },
  placeBuilding(): void {
    tone(140, 0.18, 'triangle', 0.14, -40);
    noise(0.15, 0.08, 500, 0.02);
  },
  buildingDone(): void {
    tone(440, 0.1, 'triangle', 0.1);
    tone(550, 0.1, 'triangle', 0.1, 0, 0.1);
    tone(660, 0.18, 'triangle', 0.12, 0, 0.2);
  },
  trainDone(): void {
    tone(520, 0.08, 'square', 0.05);
    tone(780, 0.12, 'square', 0.05, 0, 0.07);
  },
  unitDeath(): void {
    tone(220, 0.25, 'sawtooth', 0.08, -150);
  },
  buildingCollapse(): void {
    noise(0.5, 0.18, 400);
    tone(90, 0.5, 'triangle', 0.16, -50);
  },
  underAttack(): void {
    tone(660, 0.12, 'square', 0.08, -80);
    tone(660, 0.12, 'square', 0.08, -80, 0.18);
  },
  error(): void {
    tone(200, 0.12, 'square', 0.06, -40);
  },
  victory(): void {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, 'triangle', 0.12, 0, i * 0.16));
  },
  defeat(): void {
    [392, 330, 262, 196].forEach((f, i) => tone(f, 0.3, 'sawtooth', 0.08, -20, i * 0.2));
  },
};
