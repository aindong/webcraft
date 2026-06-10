/**
 * DOM-based HUD: resource bar, selection panel, command card, minimap dock,
 * and transient alerts. The HUD never mutates the sim — it calls back into
 * the Game which enqueues commands.
 */
import { BuildingDef, buildingDef, BUILDINGS, Cost, raceDef, UnitDef, unitDef, UNITS } from '../sim/data';
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
.cmd-btn:hover:not(.disabled) { background: #4a3f28; border-color: #ffd84d; }
.cmd-btn.disabled { opacity: 0.35; cursor: default; }
.cmd-btn .lbl { font-size: 9px; line-height: 1; margin-top: 2px; color: #cfc4a8; }
.cmd-btn .cost { font-size: 8px; color: #ffd84d; line-height: 1; }
.cmd-btn .badge {
  position: absolute; top: 1px; right: 3px; font-size: 9px; color: #9ad09a; font-weight: 700;
}
#cmd-tip {
  position: absolute; right: 10px; bottom: 178px; width: 300px;
  background: #14120ef2; border: 1px solid #5a4f33; border-radius: 6px;
  padding: 10px 12px; font-size: 12.5px; line-height: 1.5; pointer-events: none;
  display: none; box-shadow: 0 4px 16px #000a;
}
#cmd-tip h4 { margin: 0 0 4px; color: #ffd84d; font-size: 14px; }
#cmd-tip .tip-cost { color: #ffd84d; margin: 2px 0; }
#cmd-tip .tip-stats { display: flex; flex-wrap: wrap; gap: 2px 14px; margin: 4px 0; color: #cfc4a8; }
#cmd-tip .tip-desc { color: #b0a888; }
#cmd-tip .tip-lock { color: #ff9a8a; margin-top: 4px; }
#cmd-tip .tip-plus { color: #9ad09a; }
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

// --- tooltip content -------------------------------------------------------

function costText(c: Cost, food = 0): string {
  const parts: string[] = [];
  if (c.gold) parts.push(`🪙 ${c.gold}`);
  if (c.wood) parts.push(`🪵 ${c.wood}`);
  if (food) parts.push(`🍖 ${food} food`);
  return parts.length ? parts.join(' · ') : 'Free';
}

function unitTip(u: UnitDef, lockedAt?: string): string {
  return `
    <h4>${UNIT_ICONS[u.id] ?? '🧍'} ${u.name}</h4>
    <div class="tip-cost">${costText(u.cost, u.food)} · ⏱ ${u.trainTime}s</div>
    <div class="tip-stats">
      <span>❤️ ${u.hp} HP</span>
      <span>⚔️ ${u.damage} dmg</span>
      <span>${u.range >= 2 ? `🎯 range ${u.range}` : '🤜 melee'}</span>
      <span>👟 speed ${u.speed}</span>
    </div>
    <div class="tip-desc">${u.desc}</div>
    ${lockedAt ? `<div class="tip-lock">🔒 Requires ${lockedAt}</div>` : ''}
  `;
}

function buildingTip(def: BuildingDef): string {
  const lvl = def.levels[0];
  const stats: string[] = [`❤️ ${lvl.hp} HP`];
  if (lvl.providesFood > 0) stats.push(`🍖 +${lvl.providesFood} food`);
  if (lvl.damage > 0) stats.push(`⚔️ ${lvl.damage} dmg`, `🎯 range ${lvl.range}`);
  if (def.trains.length > 0) stats.push(`🎓 trains ${def.trains.map((t) => UNITS[t].name).join(', ')}`);
  return `
    <h4>${BUILDING_ICONS[def.id] ?? '🏠'} ${def.name}</h4>
    <div class="tip-cost">${costText(def.cost)} · ⏱ ${def.buildTime}s</div>
    <div class="tip-stats">${stats.map((s) => `<span>${s}</span>`).join('')}</div>
    <div class="tip-desc">${def.desc}</div>
  `;
}

function upgradeTip(def: BuildingDef, b: Entity): string {
  const cur = def.levels[b.level - 1];
  const next = def.levels[b.level];
  const gains: string[] = [`❤️ ${cur.hp} → ${next.hp} HP`];
  if (next.providesFood !== cur.providesFood) gains.push(`🍖 ${cur.providesFood} → ${next.providesFood} food`);
  if (next.damage !== cur.damage) gains.push(`⚔️ ${cur.damage} → ${next.damage} dmg`);
  const unlocks = def.trains
    .filter((t) => UNITS[t].requiresLevel === b.level + 1)
    .map((t) => `${UNIT_ICONS[t] ?? ''} ${UNITS[t].name}`);
  return `
    <h4>⬆️ Upgrade to ${next.name}</h4>
    <div class="tip-cost">${costText(next.cost)} · ⏱ ${next.upgradeTime}s</div>
    <div class="tip-stats">${gains.map((s) => `<span class="tip-plus">${s}</span>`).join('')}</div>
    ${unlocks.length ? `<div class="tip-desc">Unlocks training: <b>${unlocks.join(', ')}</b></div>` : ''}
    <div class="tip-desc">Training pauses while the upgrade is in progress.</div>
  `;
}

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
  private tip!: HTMLElement;
  /** key of the command button currently showing a tooltip ('' = none) */
  private tipKey = '';
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
      <div id="cmd-tip"></div>
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
    this.tip = this.root.querySelector('#cmd-tip')!;
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
    this.updateDynamics(state);
  }

  /**
   * Structural signature only: which buttons exist and whether they're
   * enabled. Deliberately excludes HP, progress ticks, and raw resource
   * counts — those change every tick and are patched in place by
   * updateDynamics(). Rebuilding the card mid-hover makes buttons flicker
   * and eats clicks.
   */
  private panelSignature(state: GameState, localPlayer: number, selection: Set<number>): string {
    const p = state.players[localPlayer];
    const parts: string[] = [];
    for (const id of selection) {
      const e = state.entities.get(id);
      if (!e) continue;
      let part = `${id}:${e.level}:${e.buildRemaining > 0 ? 1 : 0}:${e.upgradeRemaining > 0 ? 1 : 0}:${e.trainQueue.map((t) => t.unit).join(',')}`;
      if (e.isBuilding && e.owner === localPlayer) {
        const next = buildingDef(e.type)?.levels[e.level];
        part += `:${next ? (p.gold >= next.cost.gold && p.wood >= next.cost.wood ? 1 : 0) : '-'}`;
      }
      parts.push(part);
    }
    // afford bits flip enabled/disabled states on train & build buttons
    const afford = [
      ...Object.values(UNITS).map((u) => (p.gold >= u.cost.gold && p.wood >= u.cost.wood ? 1 : 0)),
      ...Object.values(BUILDINGS).map((b) => (p.gold >= b.cost.gold && p.wood >= b.cost.wood ? 1 : 0)),
    ].join('');
    return parts.join('|') + '$' + afford;
  }

  private updateSelectionPanel(state: GameState, localPlayer: number, selection: Set<number>): void {
    const sig = this.panelSignature(state, localPlayer, selection);
    if (sig === this.lastPanelSig) return;
    this.lastPanelSig = sig;

    const entities: Entity[] = [];
    for (const id of selection) {
      const e = state.entities.get(id);
      if (e) entities.push(e);
    }

    this.selPanel.innerHTML = '';
    this.cmdCard.innerHTML = '';

    if (entities.length === 1) {
      this.renderSingle(state, localPlayer, entities[0]);
    } else if (entities.length > 1) {
      this.renderMulti(state, localPlayer, entities);
    }
    this.refreshTip();
  }

  private showTip(key: string, html: string): void {
    this.tipKey = key;
    this.tip.innerHTML = html;
    this.tip.style.display = 'block';
  }

  private hideTip(key: string): void {
    if (this.tipKey !== key) return;
    this.tipKey = '';
    this.tip.style.display = 'none';
  }

  /**
   * The command card is rebuilt whenever its signature changes (every
   * resource tick, queue progress, …), which destroys the hovered button
   * without firing mouseleave. Re-attach the tooltip to the same logical
   * button if it still exists, otherwise hide it.
   */
  private refreshTip(): void {
    if (!this.tipKey) return;
    for (const btn of this.cmdCard.querySelectorAll<HTMLButtonElement>('.cmd-btn')) {
      if (btn.dataset.tipkey === this.tipKey && btn.dataset.tip) {
        this.tip.innerHTML = btn.dataset.tip;
        return;
      }
    }
    this.tipKey = '';
    this.tip.style.display = 'none';
  }

  /** The fast-changing one-liner under the entity name. */
  private entitySub(e: Entity): string {
    if (e.type === 'goldmine') return `Gold remaining: ${e.goldLeft}`;
    if (e.isBuilding) {
      const def = buildingDef(e.type);
      if (e.buildRemaining > 0) return `Under construction — ${Math.round((1 - e.buildRemaining / e.buildTotal) * 100)}%`;
      if (e.upgradeRemaining > 0) return `Upgrading — ${Math.round((1 - e.upgradeRemaining / e.upgradeTotal) * 100)}%`;
      const food = def.levels[e.level - 1].providesFood;
      return food > 0 ? `Provides ${food} food` : '';
    }
    const def = unitDef(e.type);
    return def.isWorker
      ? (e.carryAmount > 0 ? `Carrying ${e.carryAmount} ${e.carryType}` : 'Worker')
      : `⚔ ${def.damage}  ·  range ${def.range >= 2 ? def.range : 'melee'}`;
  }

  /**
   * Patch HP bars, progress text, and queue percentages in place every
   * frame — without rebuilding the DOM, so hover and clicks are stable.
   */
  private updateDynamics(state: GameState): void {
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-hp-for]')) {
      const e = state.entities.get(Number(el.dataset.hpFor));
      if (!e) continue;
      const ratio = Math.max(0, e.hp / e.maxHp);
      el.style.width = `${Math.round(ratio * 100)}%`;
      el.style.background = ratio > 0.66 ? '#5ad05a' : ratio > 0.33 ? '#e0c040' : '#e05040';
    }
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-hptext-for]')) {
      const e = state.entities.get(Number(el.dataset.hptextFor));
      if (e) el.textContent = `${e.hp} / ${e.maxHp} HP`;
    }
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-sub-for]')) {
      const e = state.entities.get(Number(el.dataset.subFor));
      if (!e) continue;
      const sub = this.entitySub(e);
      if (el.textContent !== sub) el.textContent = sub;
    }
    for (const btn of this.cmdCard.querySelectorAll<HTMLElement>('[data-queue-prog]')) {
      const [bid, idx] = btn.dataset.queueProg!.split(':').map(Number);
      const item = state.entities.get(bid)?.trainQueue[idx];
      if (!item) continue;
      const pct = idx === 0 ? `${Math.round((1 - item.remaining / item.total) * 100)}%` : '…';
      const lbl = btn.querySelector('.lbl');
      if (lbl) lbl.textContent = `${UNITS[item.unit].name} ${pct}`;
    }
  }

  private renderSingle(state: GameState, localPlayer: number, e: Entity): void {
    const card = document.createElement('div');
    card.className = 'sel-card';
    let name: string;
    let icon: string;
    if (e.type === 'goldmine') {
      name = 'Gold Mine';
      icon = '⛏️';
    } else if (e.isBuilding) {
      name = buildingDef(e.type).levels[e.level - 1].name;
      icon = BUILDING_ICONS[e.type] ?? '🏠';
    } else {
      name = unitDef(e.type).name;
      icon = UNIT_ICONS[e.type] ?? '🧍';
    }
    card.innerHTML = `
      <div class="sel-name">${icon} ${name}</div>
      <div class="sel-sub" data-sub-for="${e.id}">${this.entitySub(e)}</div>
      <div class="sel-hpbar"><div data-hp-for="${e.id}"></div></div>
      <div class="sel-sub" data-hptext-for="${e.id}"></div>
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
      hp.dataset.hpFor = String(e.id);
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
    tip: { key: string; html: string } | null = null,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    // a CSS class instead of the disabled attribute: disabled buttons swallow
    // mouse events, which would kill tooltips exactly where they matter most
    btn.className = enabled ? 'cmd-btn' : 'cmd-btn disabled';
    btn.innerHTML = `
      ${badge ? `<span class="badge">${badge}</span>` : ''}
      <span>${icon}</span>
      <span class="lbl">${label}</span>
      ${cost && (cost.gold || cost.wood) ? `<span class="cost">${cost.gold ? `🪙${cost.gold}` : ''} ${cost.wood ? `🪵${cost.wood}` : ''}</span>` : ''}
    `;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (enabled) onClick();
    });
    if (tip) {
      btn.dataset.tipkey = tip.key;
      btn.dataset.tip = tip.html;
      btn.addEventListener('mouseenter', () => this.showTip(tip.key, tip.html));
      btn.addEventListener('mouseleave', () => this.hideTip(tip.key));
    }
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
        this.cmdButton(BUILDING_ICONS[bId] ?? '🏠', def.name, def.cost, afford,
          () => this.cb.onStartPlacement(bId), '',
          { key: `build:${bId}`, html: buildingTip(def) });
      }
    }
    const military = units.some((u) => !unitDef(u.type)?.isWorker);
    if (military) {
      this.cmdButton('🎯', 'Attack (A)', null, true, () => this.cb.onAttackMoveMode(), '', {
        key: 'attackmove',
        html: '<h4>🎯 Attack-Move</h4><div class="tip-desc">Click a spot on the map: units march there and engage every enemy they meet on the way. Hotkey: <b>A</b> + click.</div>',
      });
    }
    this.cmdButton('✋', 'Stop (S)', null, true, () => this.cb.onStop(), '', {
      key: 'stop',
      html: '<h4>✋ Stop</h4><div class="tip-desc">Cancel the current order and hold position. Hotkey: <b>S</b>.</div>',
    });
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
          () => this.cb.onTrain(b.id, uId), '',
          { key: `train:${uId}`, html: unitTip(u, locked ? def.levels[u.requiresLevel - 1].name : undefined) },
        );
      }
      const next = def.levels[b.level];
      if (next) {
        const afford = p.gold >= next.cost.gold && p.wood >= next.cost.wood;
        this.cmdButton('⬆️', `${next.name}`, next.cost, afford, () => this.cb.onUpgrade(b.id), '',
          { key: 'upgrade', html: upgradeTip(def, b) });
      }
    }

    // train queue chips with cancel; progress text is patched per-frame
    b.trainQueue.forEach((item, i) => {
      const u = UNITS[item.unit];
      const btn = this.cmdButton(UNIT_ICONS[item.unit] ?? '🧍', u.name, null, true,
        () => this.cb.onCancelTrain(b.id, i), '✕', {
          key: `queue:${i}`,
          html: `<h4>${UNIT_ICONS[item.unit] ?? '🧍'} ${u.name} — in queue</h4><div class="tip-desc">Click to cancel and refund the full cost (${costText(u.cost)}).</div>`,
        });
      btn.dataset.queueProg = `${b.id}:${i}`;
    });
  }
}
