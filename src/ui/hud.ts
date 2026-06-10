/**
 * DOM-based HUD: resource bar, selection panel, command card, minimap dock,
 * and transient alerts. The HUD never mutates the sim — it calls back into
 * the Game which enqueues commands.
 */
import { buildingDef, raceDef, unitDef, UNITS } from '../sim/data';
import { foodCap, foodUsed } from '../sim/commands';
import { Entity, GameState } from '../sim/state';

export interface HudCallbacks {
  onTrain(buildingId: number, unit: string): void;
  onUpgrade(buildingId: number): void;
  onCancelTrain(buildingId: number, index: number): void;
  onStartPlacement(buildingType: string): void;
  onStop(): void;
  onAttackMoveMode(): void;
  onToggleSfx(): boolean;
  onToggleVoice(): boolean;
  onToggleMusic(): boolean;
  onQuit(): void;
}

const CSS = `
#hud { position: absolute; inset: 0; pointer-events: none; color: #e8e2d0; }
#hud * { box-sizing: border-box; }
.hud-top {
  position: absolute; top: 0; left: 0; right: 0; height: 38px;
  display: flex; align-items: center; gap: 18px; padding: 0 14px;
  background: linear-gradient(#1c1a14ee, #14120ecc);
  border-bottom: 2px solid #3a3424; font-size: 15px; pointer-events: auto;
}
.hud-res { display: flex; align-items: center; gap: 6px; min-width: 90px; font-weight: 600; }
.hud-res .ico { font-size: 16px; }
.hud-top .spacer { flex: 1; }
.hud-btn {
  background: #2c2618; border: 1px solid #5a4f33; color: #e8e2d0;
  padding: 3px 10px; cursor: pointer; font-size: 13px; border-radius: 3px;
}
.hud-btn:hover { background: #3d3422; }
.hud-bottom {
  position: absolute; bottom: 0; left: 0; right: 0; height: 168px;
  display: flex; gap: 10px; padding: 8px 10px;
  background: linear-gradient(#14120ecc, #1c1a14ee);
  border-top: 2px solid #3a3424; pointer-events: auto;
}
#minimap-wrap {
  width: 150px; height: 150px; border: 2px solid #5a4f33; position: relative;
  background: #000; flex: none; cursor: crosshair;
}
#minimap-wrap canvas { width: 100%; height: 100%; display: block; }
#sel-panel {
  flex: 1; display: flex; gap: 8px; align-items: stretch; overflow: hidden;
  padding: 4px; border: 1px solid #3a3424; border-radius: 4px; background: #100e0a88;
}
.sel-card { display: flex; flex-direction: column; justify-content: center; gap: 4px; min-width: 180px; }
.sel-name { font-size: 17px; font-weight: 700; color: #ffd84d; }
.sel-sub { font-size: 12px; color: #b0a888; }
.sel-hpbar { height: 8px; background: #222; border: 1px solid #000; width: 170px; }
.sel-hpbar > div { height: 100%; }
.sel-multi { display: flex; flex-wrap: wrap; gap: 3px; align-content: flex-start; padding: 4px; }
.sel-multi .chip {
  width: 34px; height: 34px; border: 1px solid #5a4f33; background: #2c2618;
  display: flex; align-items: center; justify-content: center; font-size: 17px; cursor: default;
  position: relative;
}
.sel-multi .chip .hp { position: absolute; bottom: 1px; left: 2px; right: 2px; height: 3px; background: #5ad05a; }
#cmd-card {
  width: 252px; flex: none; display: grid;
  grid-template-columns: repeat(4, 56px); grid-auto-rows: 56px; gap: 6px;
  align-content: start; padding: 4px;
}
.cmd-btn {
  border: 1px solid #5a4f33; background: #2c2618; color: #e8e2d0; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  font-size: 20px; border-radius: 4px; padding: 2px; position: relative;
}
.cmd-btn:hover:not(:disabled) { background: #4a3f28; border-color: #ffd84d; }
.cmd-btn:disabled { opacity: 0.35; cursor: default; }
.cmd-btn .lbl { font-size: 9px; line-height: 1; margin-top: 2px; color: #cfc4a8; }
.cmd-btn .cost { font-size: 8px; color: #ffd84d; line-height: 1; }
.cmd-btn .badge {
  position: absolute; top: 1px; right: 3px; font-size: 9px; color: #9ad09a; font-weight: 700;
}
#alerts {
  position: absolute; top: 52px; left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 4px; pointer-events: none;
}
.alert-msg {
  background: #200c0cdd; border: 1px solid #803030; color: #ff9a8a;
  padding: 4px 16px; border-radius: 4px; font-size: 14px; animation: alertfade 4s forwards;
}
.alert-msg.info { background: #10200cdd; border-color: #4a8030; color: #c0e8a0; }
@keyframes alertfade { 0% {opacity:0} 8% {opacity:1} 80% {opacity:1} 100% {opacity:0} }
#help-overlay {
  position: absolute; top: 60px; right: 12px; width: 290px; padding: 12px 16px;
  background: #14120eee; border: 1px solid #5a4f33; border-radius: 6px;
  font-size: 12.5px; line-height: 1.55; pointer-events: auto; display: none;
}
#help-overlay h3 { margin: 0 0 6px; color: #ffd84d; font-size: 14px; }
#help-overlay kbd {
  background: #2c2618; border: 1px solid #5a4f33; padding: 0 5px; border-radius: 3px; font-size: 11px;
}
`;

const UNIT_ICONS: Record<string, string> = {
  peasant: '🧑‍🌾', footman: '🛡️', archer: '🏹', knight: '🐴',
  peon: '🪓', grunt: '👹', spearthrower: '🔱', raider: '🐺',
};
const BUILDING_ICONS: Record<string, string> = {
  townhall: '🏰', house: '🏠', barracks: '⚔️', tower: '🗼',
  greathall: '🛖', hut: '⛺', warcamp: '🪖', spiketower: '💀',
};

export class Hud {
  root: HTMLElement;
  minimapCanvas: HTMLCanvasElement;
  private resGold!: HTMLElement;
  private resWood!: HTMLElement;
  private resFood!: HTMLElement;
  private selPanel!: HTMLElement;
  private cmdCard!: HTMLElement;
  private alerts!: HTMLElement;
  private helpOverlay!: HTMLElement;
  private sfxBtn!: HTMLButtonElement;
  private voiceBtn!: HTMLButtonElement;
  /** signature of last rendered selection panel, to avoid DOM churn */
  private lastPanelSig = '';

  constructor(parent: HTMLElement, private cb: HudCallbacks) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div class="hud-top">
        <div class="hud-res"><span class="ico">🪙</span><span id="res-gold">0</span></div>
        <div class="hud-res"><span class="ico">🪵</span><span id="res-wood">0</span></div>
        <div class="hud-res"><span class="ico">🍖</span><span id="res-food">0/0</span></div>
        <div class="spacer"></div>
        <button class="hud-btn" id="btn-help">Help (H)</button>
        <button class="hud-btn" id="btn-sfx">🔊 SFX</button>
        <button class="hud-btn" id="btn-voice">🗣️ Voice</button>
        <button class="hud-btn" id="btn-music">🎵 Music</button>
        <button class="hud-btn" id="btn-quit">Surrender</button>
      </div>
      <div id="alerts"></div>
      <div id="help-overlay">
        <h3>Commands</h3>
        <div><kbd>Left-click</kbd> / drag — select units</div>
        <div><kbd>Right-click</kbd> — move / harvest / attack (smart)</div>
        <div><kbd>A</kbd> + click — attack-move</div>
        <div><kbd>S</kbd> — stop &nbsp; <kbd>Esc</kbd> — cancel</div>
        <div><kbd>Ctrl</kbd>+<kbd>1-9</kbd> — set group, <kbd>1-9</kbd> — recall</div>
        <div><kbd>WASD</kbd> / edges — pan, <kbd>wheel</kbd> — zoom</div>
        <div>Right-click with a building selected sets its rally point.</div>
        <div><kbd>M</kbd> — mute SFX &nbsp; <kbd>V</kbd> — mute voices</div>
      </div>
      <div class="hud-bottom">
        <div id="minimap-wrap"><canvas></canvas></div>
        <div id="sel-panel"></div>
        <div id="cmd-card"></div>
      </div>
    `;
    parent.appendChild(this.root);

    this.resGold = this.root.querySelector('#res-gold')!;
    this.resWood = this.root.querySelector('#res-wood')!;
    this.resFood = this.root.querySelector('#res-food')!;
    this.selPanel = this.root.querySelector('#sel-panel')!;
    this.cmdCard = this.root.querySelector('#cmd-card')!;
    this.alerts = this.root.querySelector('#alerts')!;
    this.helpOverlay = this.root.querySelector('#help-overlay')!;
    this.minimapCanvas = this.root.querySelector('#minimap-wrap canvas')!;
    this.sfxBtn = this.root.querySelector('#btn-sfx')!;
    this.voiceBtn = this.root.querySelector('#btn-voice')!;

    this.root.querySelector('#btn-help')!.addEventListener('click', () => this.toggleHelp());
    this.root.querySelector('#btn-quit')!.addEventListener('click', () => cb.onQuit());
    this.sfxBtn.addEventListener('click', () => {
      const m = cb.onToggleSfx();
      this.sfxBtn.textContent = m ? '🔇 SFX' : '🔊 SFX';
    });
    this.voiceBtn.addEventListener('click', () => {
      const m = cb.onToggleVoice();
      this.voiceBtn.textContent = m ? '🔇 Voice' : '🗣️ Voice';
    });
    const musicBtn = this.root.querySelector<HTMLButtonElement>('#btn-music')!;
    musicBtn.addEventListener('click', () => {
      const m = cb.onToggleMusic();
      musicBtn.textContent = m ? '🔇 Music' : '🎵 Music';
    });
  }

  toggleHelp(): void {
    const el = this.helpOverlay;
    el.style.display = el.style.display === 'block' ? 'none' : 'block';
  }

  showAlert(text: string, info = false): void {
    const div = document.createElement('div');
    div.className = 'alert-msg' + (info ? ' info' : '');
    div.textContent = text;
    this.alerts.appendChild(div);
    setTimeout(() => div.remove(), 4100);
    while (this.alerts.children.length > 4) this.alerts.firstChild!.remove();
  }

  update(state: GameState, localPlayer: number, selection: Set<number>): void {
    const p = state.players[localPlayer];
    this.resGold.textContent = String(p.gold);
    this.resWood.textContent = String(p.wood);
    const used = foodUsed(state, localPlayer);
    const cap = foodCap(state, localPlayer);
    this.resFood.textContent = `${used}/${cap}`;
    (this.resFood.parentElement as HTMLElement).style.color = used >= cap ? '#ff8a7a' : '';

    this.updateSelectionPanel(state, localPlayer, selection);
  }

  private panelSignature(state: GameState, selection: Set<number>): string {
    const parts: string[] = [];
    for (const id of selection) {
      const e = state.entities.get(id);
      if (!e) continue;
      parts.push(`${id}:${e.hp}:${e.level}:${e.buildRemaining}:${e.trainQueue.length}:${e.upgradeRemaining > 0 ? 1 : 0}:${e.trainQueue[0]?.remaining ?? ''}`);
    }
    const p = state.players;
    return parts.join('|') + `$${p.map((x) => `${x.gold},${x.wood}`).join(';')}`;
  }

  private updateSelectionPanel(state: GameState, localPlayer: number, selection: Set<number>): void {
    const sig = this.panelSignature(state, selection);
    if (sig === this.lastPanelSig) return;
    this.lastPanelSig = sig;

    const entities: Entity[] = [];
    for (const id of selection) {
      const e = state.entities.get(id);
      if (e) entities.push(e);
    }

    this.selPanel.innerHTML = '';
    this.cmdCard.innerHTML = '';

    if (entities.length === 0) return;

    if (entities.length === 1) {
      this.renderSingle(state, localPlayer, entities[0]);
    } else {
      this.renderMulti(state, localPlayer, entities);
    }
  }

  private renderSingle(state: GameState, localPlayer: number, e: Entity): void {
    const card = document.createElement('div');
    card.className = 'sel-card';
    let name: string, sub = '';
    let icon: string;
    if (e.type === 'goldmine') {
      name = 'Gold Mine';
      icon = '⛏️';
      sub = `Gold remaining: ${e.goldLeft}`;
    } else if (e.isBuilding) {
      const def = buildingDef(e.type);
      name = def.levels[e.level - 1].name;
      icon = BUILDING_ICONS[e.type] ?? '🏠';
      if (e.buildRemaining > 0) {
        sub = `Under construction — ${Math.round((1 - e.buildRemaining / e.buildTotal) * 100)}%`;
      } else if (e.upgradeRemaining > 0) {
        sub = `Upgrading — ${Math.round((1 - e.upgradeRemaining / e.upgradeTotal) * 100)}%`;
      } else if (def.levels[e.level - 1].providesFood > 0) {
        sub = `Provides ${def.levels[e.level - 1].providesFood} food`;
      }
    } else {
      const def = unitDef(e.type);
      name = def.name;
      icon = UNIT_ICONS[e.type] ?? '🧍';
      sub = def.isWorker
        ? (e.carryAmount > 0 ? `Carrying ${e.carryAmount} ${e.carryType}` : 'Worker')
        : `⚔ ${def.damage}  ·  range ${def.range >= 2 ? def.range : 'melee'}`;
    }
    const ratio = e.hp / e.maxHp;
    const hpColor = ratio > 0.66 ? '#5ad05a' : ratio > 0.33 ? '#e0c040' : '#e05040';
    card.innerHTML = `
      <div class="sel-name">${icon} ${name}</div>
      <div class="sel-sub">${sub}</div>
      <div class="sel-hpbar"><div style="width:${Math.round(ratio * 100)}%;background:${hpColor}"></div></div>
      <div class="sel-sub">${e.hp} / ${e.maxHp} HP</div>
    `;
    this.selPanel.appendChild(card);

    if (e.owner !== localPlayer) return;
    if (e.isBuilding) this.renderBuildingCommands(state, localPlayer, e);
    else this.renderUnitCommands(state, localPlayer, [e]);
  }

  private renderMulti(state: GameState, localPlayer: number, entities: Entity[]): void {
    const wrap = document.createElement('div');
    wrap.className = 'sel-multi';
    for (const e of entities.slice(0, 24)) {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.textContent = UNIT_ICONS[e.type] ?? BUILDING_ICONS[e.type] ?? '?';
      chip.title = unitDef(e.type)?.name ?? e.type;
      const hp = document.createElement('div');
      hp.className = 'hp';
      hp.style.width = `${Math.round((e.hp / e.maxHp) * 100)}%`;
      const ratio = e.hp / e.maxHp;
      hp.style.background = ratio > 0.66 ? '#5ad05a' : ratio > 0.33 ? '#e0c040' : '#e05040';
      chip.appendChild(hp);
      wrap.appendChild(chip);
    }
    if (entities.length > 24) {
      const more = document.createElement('div');
      more.className = 'chip';
      more.textContent = `+${entities.length - 24}`;
      wrap.appendChild(more);
    }
    this.selPanel.appendChild(wrap);

    const own = entities.filter((e) => e.owner === localPlayer && !e.isBuilding);
    if (own.length > 0) this.renderUnitCommands(state, localPlayer, own);
  }

  private cmdButton(
    icon: string, label: string, cost: { gold: number; wood: number } | null,
    enabled: boolean, onClick: () => void, badge = '',
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'cmd-btn';
    btn.disabled = !enabled;
    btn.innerHTML = `
      ${badge ? `<span class="badge">${badge}</span>` : ''}
      <span>${icon}</span>
      <span class="lbl">${label}</span>
      ${cost && (cost.gold || cost.wood) ? `<span class="cost">${cost.gold ? `🪙${cost.gold}` : ''} ${cost.wood ? `🪵${cost.wood}` : ''}</span>` : ''}
    `;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onClick();
    });
    this.cmdCard.appendChild(btn);
    return btn;
  }

  private renderUnitCommands(state: GameState, localPlayer: number, units: Entity[]): void {
    const p = state.players[localPlayer];
    const workers = units.filter((u) => unitDef(u.type)?.isWorker);
    if (workers.length > 0) {
      const race = raceDef(p.race);
      for (const bId of race.buildings) {
        const def = buildingDef(bId);
        const afford = p.gold >= def.cost.gold && p.wood >= def.cost.wood;
        this.cmdButton(BUILDING_ICONS[bId] ?? '🏠', def.name, def.cost, afford, () => this.cb.onStartPlacement(bId));
      }
    }
    const military = units.some((u) => !unitDef(u.type)?.isWorker);
    if (military) {
      this.cmdButton('🎯', 'Attack (A)', null, true, () => this.cb.onAttackMoveMode());
    }
    this.cmdButton('✋', 'Stop (S)', null, true, () => this.cb.onStop());
  }

  private renderBuildingCommands(state: GameState, localPlayer: number, b: Entity): void {
    if (b.buildRemaining > 0) return;
    const p = state.players[localPlayer];
    const def = buildingDef(b.type);

    if (b.upgradeRemaining === 0) {
      for (const uId of def.trains) {
        const u = UNITS[uId];
        const locked = b.level < u.requiresLevel;
        const afford = p.gold >= u.cost.gold && p.wood >= u.cost.wood;
        this.cmdButton(
          UNIT_ICONS[uId] ?? '🧍',
          locked ? `${u.name} (lv${u.requiresLevel})` : u.name,
          u.cost, !locked && afford,
          () => this.cb.onTrain(b.id, uId),
        );
      }
      const next = def.levels[b.level];
      if (next) {
        const afford = p.gold >= next.cost.gold && p.wood >= next.cost.wood;
        this.cmdButton('⬆️', `${next.name}`, next.cost, afford, () => this.cb.onUpgrade(b.id));
      }
    }

    // train queue chips with cancel
    b.trainQueue.forEach((item, i) => {
      const u = UNITS[item.unit];
      const pct = i === 0 ? `${Math.round((1 - item.remaining / item.total) * 100)}%` : '…';
      this.cmdButton(UNIT_ICONS[item.unit] ?? '🧍', `${u.name} ${pct}`, null, true,
        () => this.cb.onCancelTrain(b.id, i), '✕');
    });
  }
}
