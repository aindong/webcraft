/**
 * Generative background music — a soft, cozy chiptune-ish loop synthesized
 * with Web Audio (no audio files). A pentatonic music box melody wanders over
 * a slow bass progression with a gentle hat tick. Presentation-only, so plain
 * Math.random is fine here.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
let started = false;
let nextBarTime = 0;
let bar = 0;
let schedulerId: number | null = null;

const TEMPO = 84;
const BEATS_PER_BAR = 4;
const BAR_SEC = (60 / TEMPO) * BEATS_PER_BAR;
const VOLUME = 0.16;

// C major pentatonic, two octaves (music box range)
const SCALE = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51];
// I – vi – IV – V roots
const BASS = [130.81, 110.0, 87.31, 98.0];

export function isMusicMuted(): boolean {
  return muted;
}

export function setMusicMuted(m: boolean): void {
  muted = m;
  if (master) {
    master.gain.setTargetAtTime(m ? 0 : VOLUME, ctx!.currentTime, 0.3);
  }
}

/** Begin playback. Must be called from within a user gesture handler. */
export function startMusic(): void {
  if (started) {
    if (ctx && ctx.state === 'suspended') void ctx.resume();
    return;
  }
  try {
    ctx = new AudioContext();
  } catch {
    return;
  }
  started = true;
  master = ctx.createGain();
  master.gain.value = muted ? 0 : VOLUME;
  master.connect(ctx.destination);
  nextBarTime = ctx.currentTime + 0.1;
  bar = 0;
  schedulerId = window.setInterval(schedule, 250);
}

export function stopMusic(): void {
  if (schedulerId !== null) {
    clearInterval(schedulerId);
    schedulerId = null;
  }
  if (ctx) void ctx.close();
  ctx = null;
  master = null;
  started = false;
}

function schedule(): void {
  if (!ctx || !master) return;
  // keep one bar scheduled ahead
  while (nextBarTime < ctx.currentTime + BAR_SEC) {
    scheduleBar(nextBarTime, bar);
    nextBarTime += BAR_SEC;
    bar++;
  }
}

let lastDegree = 4;

function scheduleBar(t0: number, barNo: number): void {
  if (!ctx || !master) return;
  const beat = BAR_SEC / BEATS_PER_BAR;

  // bass: root on 1, fifth-ish echo on 3
  const root = BASS[barNo % BASS.length];
  pluck(root, t0, beat * 1.8, 'sine', 0.5);
  pluck(root * 1.5, t0 + beat * 2, beat * 1.4, 'sine', 0.3);

  // melody: gentle random walk on the pentatonic, eighth notes with rests
  for (let i = 0; i < 8; i++) {
    if (Math.random() < 0.4) continue; // breathe
    const step = Math.floor(Math.random() * 5) - 2; // -2..+2
    lastDegree = Math.max(0, Math.min(SCALE.length - 1, lastDegree + step));
    pluck(SCALE[lastDegree], t0 + i * (beat / 2), 0.5, 'triangle', 0.5);
  }

  // soft hat tick on offbeats
  for (let i = 0; i < 4; i++) {
    hat(t0 + i * beat + beat / 2);
  }
}

function pluck(freq: number, t: number, dur: number, type: OscillatorType, vol: number): void {
  if (!ctx || !master) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(vol, t + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(gain).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function hat(t: number): void {
  if (!ctx || !master) return;
  const len = Math.floor(ctx.sampleRate * 0.03);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 7000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.06, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
  src.connect(filter).connect(gain).connect(master);
  src.start(t);
}
