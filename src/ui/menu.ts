/**
 * Start screen: race selection, opponent count & difficulty, map size.
 */
import { RACES } from '../sim/data';
import { PLAYER_COLORS } from '../render/sprites';
import { MatchConfig } from '../sim/mapgen';

const CSS = `
#menu {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at 50% 30%, #2a2438 0%, #0a0a12 70%);
  color: #e8e2d0; font-family: 'Segoe UI', 'Trebuchet MS', sans-serif;
}
#menu .panel {
  width: 660px; max-width: 94vw; padding: 36px 44px; text-align: center;
  background: #14120eee; border: 2px solid #5a4f33; border-radius: 10px;
  box-shadow: 0 0 60px #000a;
}
#menu h1 {
  font-size: 44px; margin: 0 0 2px; color: #ffd84d; letter-spacing: 3px;
  text-shadow: 0 3px 0 #5a3d00, 0 6px 18px #000;
}
#menu .tagline { color: #b0a888; margin-bottom: 26px; font-size: 14px; font-style: italic; }
#menu h2 { font-size: 15px; color: #cfc4a8; margin: 20px 0 8px; text-transform: uppercase; letter-spacing: 2px; }
.race-row { display: flex; gap: 14px; justify-content: center; }
.race-card {
  flex: 1; max-width: 260px; padding: 16px; cursor: pointer; text-align: left;
  background: #201c14; border: 2px solid #3a3424; border-radius: 8px; transition: all 0.15s;
}
.race-card:hover { border-color: #8a7a4a; }
.race-card.sel { border-color: #ffd84d; background: #2c2618; box-shadow: 0 0 14px #ffd84d33; }
.race-card .rname { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
.race-card .rdesc { font-size: 12px; color: #b0a888; line-height: 1.45; }
.opt-row { display: flex; gap: 8px; justify-content: center; }
.opt-btn {
  padding: 7px 18px; cursor: pointer; background: #201c14; color: #e8e2d0;
  border: 2px solid #3a3424; border-radius: 6px; font-size: 14px;
}
.opt-btn:hover { border-color: #8a7a4a; }
.opt-btn.sel { border-color: #ffd84d; background: #2c2618; color: #ffd84d; }
#start-btn {
  margin-top: 30px; padding: 13px 64px; font-size: 20px; font-weight: 700; cursor: pointer;
  background: linear-gradient(#7a5c1e, #5a430f); color: #ffe9a0;
  border: 2px solid #ffd84d; border-radius: 8px; letter-spacing: 2px;
  text-shadow: 0 2px 2px #0008;
}
#start-btn:hover { background: linear-gradient(#8a6c2e, #6a531f); }
#menu .hint { margin-top: 14px; font-size: 12px; color: #807a64; }
`;

export interface MenuResult {
  config: MatchConfig;
  localRace: string;
}

export function showMenu(parent: HTMLElement, onStart: (r: MenuResult) => void): void {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.id = 'menu';

  let race = 'human';
  let opponents = 1;
  let difficulty: 'easy' | 'normal' | 'hard' = 'normal';
  let mapSize = 64;

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <h1>⚔️ WEBCRAFT</h1>
    <div class="tagline">Realm of War — gather, build, conquer. "Work complete!"</div>
    <h2>Choose your race</h2>
    <div class="race-row" id="races"></div>
    <h2>Opponents</h2>
    <div class="opt-row" id="opps"></div>
    <h2>AI Difficulty</h2>
    <div class="opt-row" id="diffs"></div>
    <h2>Map size</h2>
    <div class="opt-row" id="sizes"></div>
    <button id="start-btn">TO BATTLE</button>
    <div class="hint">Right-click to command · drag to select · H in game for help</div>
  `;
  el.appendChild(panel);
  parent.appendChild(el);

  const raceRow = panel.querySelector('#races')!;
  for (const r of Object.values(RACES)) {
    const card = document.createElement('div');
    card.className = 'race-card' + (r.id === race ? ' sel' : '');
    const rn = document.createElement('div');
    rn.className = 'rname';
    rn.textContent = (r.id === 'human' ? '🏰 ' : '🪓 ') + r.name;
    const rd = document.createElement('div');
    rd.className = 'rdesc';
    rd.textContent = r.description;
    card.append(rn, rd);
    card.addEventListener('click', () => {
      race = r.id;
      raceRow.querySelectorAll('.race-card').forEach((c) => c.classList.remove('sel'));
      card.classList.add('sel');
    });
    raceRow.appendChild(card);
  }

  const mkOpts = <T extends string | number>(
    rootSel: string, options: { label: string; value: T }[], initial: T, set: (v: T) => void,
  ) => {
    const row = panel.querySelector(rootSel)!;
    for (const o of options) {
      const btn = document.createElement('button');
      btn.className = 'opt-btn' + (o.value === initial ? ' sel' : '');
      btn.textContent = o.label;
      btn.addEventListener('click', () => {
        set(o.value);
        row.querySelectorAll('.opt-btn').forEach((b) => b.classList.remove('sel'));
        btn.classList.add('sel');
      });
      row.appendChild(btn);
    }
  };

  mkOpts('#opps', [
    { label: '1 enemy', value: 1 }, { label: '2 enemies', value: 2 }, { label: '3 enemies', value: 3 },
  ], opponents, (v) => { opponents = v; });
  mkOpts('#diffs', [
    { label: 'Easy', value: 'easy' }, { label: 'Normal', value: 'normal' }, { label: 'Hard', value: 'hard' },
  ] as { label: string; value: 'easy' | 'normal' | 'hard' }[], difficulty, (v) => { difficulty = v; });
  mkOpts('#sizes', [
    { label: 'Small (56)', value: 56 }, { label: 'Medium (64)', value: 64 }, { label: 'Large (80)', value: 80 },
  ], mapSize, (v) => { mapSize = v; });

  panel.querySelector('#start-btn')!.addEventListener('click', () => {
    const aiRaces = ['orc', 'human'];
    const players = [
      { name: 'You', race, color: PLAYER_COLORS[0], isAI: false },
      ...Array.from({ length: opponents }, (_, i) => ({
        name: `AI ${i + 1}`,
        race: aiRaces[(i + (race === 'orc' ? 1 : 0)) % 2],
        color: PLAYER_COLORS[i + 1],
        isAI: true,
        aiDifficulty: difficulty,
      })),
    ];
    const config: MatchConfig = {
      seed: (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0,
      mapSize,
      players,
    };
    el.remove();
    onStart({ config, localRace: race });
  });
}

export function showEndScreen(parent: HTMLElement, victory: boolean, onRestart: () => void): void {
  const el = document.createElement('div');
  el.style.cssText = `
    position: absolute; inset: 0; display: flex; flex-direction: column; gap: 18px;
    align-items: center; justify-content: center; background: rgba(5,5,10,0.75); z-index: 50;
    color: ${victory ? '#ffd84d' : '#ff8a7a'}; font-family: 'Segoe UI', sans-serif;
  `;
  const h = document.createElement('div');
  h.textContent = victory ? '⚔️ VICTORY!' : '💀 DEFEAT';
  h.style.cssText = 'font-size: 64px; font-weight: 800; letter-spacing: 4px; text-shadow: 0 4px 20px #000;';
  const sub = document.createElement('div');
  sub.textContent = victory
    ? 'The enemy has been razed to the ground. The realm is yours.'
    : 'Your last building has fallen. The realm is lost.';
  sub.style.cssText = 'font-size: 17px; color: #cfc4a8;';
  const btn = document.createElement('button');
  btn.textContent = 'Play again';
  btn.style.cssText = `
    margin-top: 12px; padding: 12px 48px; font-size: 18px; cursor: pointer;
    background: #2c2618; color: #e8e2d0; border: 2px solid #5a4f33; border-radius: 8px;
  `;
  btn.addEventListener('click', () => {
    el.remove();
    onRestart();
  });
  el.append(h, sub, btn);
  parent.appendChild(el);
}
