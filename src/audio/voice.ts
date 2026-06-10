/**
 * Unit voices via the Web Speech API. Each race has a vocal character
 * (orcs: low & slow, humans: bright & brisk). Lines are original, written
 * in the spirit of the classic god-game acknowledgements ("Work complete!").
 *
 * Throttling: at most one bark at a time; same-category barks are rate
 * limited so spam-clicking doesn't queue an endless chorus.
 */
import { VoiceProfile } from '../sim/data';

export type VoiceCategory = keyof Omit<VoiceProfile, 'pitch' | 'rate'>;

let muted = false;
let lastByCategory = new Map<string, number>();
let speaking = false;

const CATEGORY_COOLDOWN_MS: Record<string, number> = {
  select: 600,
  move: 800,
  attack: 1200,
  build: 1500,
  workComplete: 500,
  trainReady: 500,
  underAttack: 6000,
  noGold: 2500,
  noWood: 2500,
  noFood: 2500,
  victory: 0,
  defeat: 0,
};

export function setVoiceMuted(m: boolean): void {
  muted = m;
  if (m && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

export function isVoiceMuted(): boolean {
  return muted;
}

let cachedVoice: SpeechSynthesisVoice | null | undefined;

function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice !== undefined) return cachedVoice;
  if (!('speechSynthesis' in window)) {
    cachedVoice = null;
    return null;
  }
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null; // not loaded yet, retry next time
  cachedVoice =
    voices.find((v) => v.lang.startsWith('en') && v.localService) ??
    voices.find((v) => v.lang.startsWith('en')) ??
    voices[0] ?? null;
  return cachedVoice;
}

export function speak(profile: VoiceProfile, category: VoiceCategory, rng = Math.random): void {
  if (muted || !('speechSynthesis' in window)) return;

  const now = performance.now();
  const cooldown = CATEGORY_COOLDOWN_MS[category] ?? 1000;
  const last = lastByCategory.get(category) ?? -Infinity;
  if (now - last < cooldown) return;

  const important = category === 'underAttack' || category === 'victory' || category === 'defeat';
  if (speaking && !important) return;

  const lines = profile[category];
  if (!lines || lines.length === 0) return;
  const text = lines[Math.floor(rng() * lines.length)];

  lastByCategory.set(category, now);

  if (important) window.speechSynthesis.cancel();

  const u = new SpeechSynthesisUtterance(text);
  u.pitch = profile.pitch;
  u.rate = profile.rate;
  u.volume = 0.9;
  const v = pickVoice();
  if (v) u.voice = v;
  speaking = true;
  u.onend = () => { speaking = false; };
  u.onerror = () => { speaking = false; };
  window.speechSynthesis.speak(u);
}

/** Preload voices (Chrome populates the list asynchronously). */
export function initVoices(): void {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoice = undefined;
    pickVoice();
  };
}
