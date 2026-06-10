/**
 * Game orchestrator: owns the sim loop, input handling, selection, and wires
 * sim events to audio/visual feedback. The sim advances on a fixed timestep;
 * rendering interpolates between ticks at display refresh rate.
 */
import { sfx, setSfxMuted, isSfxMuted } from './audio/sfx';
import { initVoices, isVoiceMuted, setVoiceMuted, speak } from './audio/voice';
import { SimEvent } from './core/events';
import { aiThink, resetAiMemory } from './sim/ai';
import {
  Command, canAfford, canPlaceBuilding, foodCap, foodUsed, smartCommand,
} from './sim/commands';
import { buildingDef, raceDef, unitDef, UNITS } from './sim/data';
import { createMatch, MatchConfig } from './sim/mapgen';
import { step } from './sim/sim';
import { Entity, GameState, TICKS_PER_SECOND } from './sim/state';
import { GameAssets } from './render/assets';
import { Camera } from './render/camera';
import { Fog } from './render/fog';
import { Minimap } from './render/minimap';
import { Renderer } from './render/renderer';
import { bakeAtlas } from './render/sprites';
import { Hud } from './ui/hud';
import { showEndScreen } from './ui/menu';

const LOCAL_PLAYER = 0;

export class Game {
  state: GameState;
  events;
  canvas: HTMLCanvasElement;
  camera = new Camera();
  renderer: Renderer;
  fog: Fog;
  minimap: Minimap;
  hud: Hud;

  selection = new Set<number>();
  controlGroups = new Map<number, number[]>();
  pendingCommands: Command[] = [];

  /** UI interaction modes */
  placing: string | null = null;
  attackMoveArmed = false;

  private mouseX = 0;
  private mouseY = 0;
  /** edge-panning only engages once the mouse has actually moved in-window */
  private mouseSeen = false;
  private dragStart: { x: number; y: number } | null = null;
  private dragRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private keys = new Set<string>();
  private accumulator = 0;
  private lastFrame = 0;
  private running = true;
  private ended = false;
  private rafId = 0;
  private minimapDrag = false;
  private disposers: (() => void)[] = [];

  constructor(
    private root: HTMLElement, config: MatchConfig, private onRestart: () => void,
    assets: GameAssets = { statics: new Map(), sheets: new Map() },
  ) {
    resetAiMemory();
    const match = createMatch(config);
    this.state = match.state;
    this.events = match.events;

    this.canvas = document.createElement('canvas');
    this.root.appendChild(this.canvas);

    const atlas = bakeAtlas(this.state.players.map((p) => p.color));
    this.renderer = new Renderer(this.canvas, atlas, this.camera, assets);
    this.fog = new Fog(this.state.map.width, this.state.map.height);

    this.hud = new Hud(this.root, {
      onTrain: (b, u) => this.tryTrain(b, u),
      onUpgrade: (b) => this.tryUpgrade(b),
      onCancelTrain: (b, i) => this.enqueue({ kind: 'cancelTrain', player: LOCAL_PLAYER, building: b, index: i }),
      onStartPlacement: (t) => this.startPlacement(t),
      onStop: () => this.stopSelection(),
      onAttackMoveMode: () => { this.attackMoveArmed = true; },
      onToggleSfx: () => { setSfxMuted(!isSfxMuted()); return isSfxMuted(); },
      onToggleVoice: () => { setVoiceMuted(!isVoiceMuted()); return isVoiceMuted(); },
      onQuit: () => this.surrender(),
    });
    this.minimap = new Minimap(this.hud.minimapCanvas, 150);

    this.resize();

    // center camera on own town hall (biased up so the HUD doesn't cover it)
    for (const e of this.state.entities.values()) {
      if (e.owner === LOCAL_PLAYER && e.isBuilding) {
        this.camera.x = e.x;
        this.camera.y = e.y;
        this.camera.pan(0, 80);
        break;
      }
    }
    this.bindInput();
    initVoices();
    this.fog.update(this.state, LOCAL_PLAYER);

    this.lastFrame = performance.now();
    (window as unknown as { __game: Game }).__game = this;
    this.rafId = requestAnimationFrame((t) => this.frame(t));
  }

  destroy(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    for (const d of this.disposers) d();
    this.root.innerHTML = '';
  }

  private get localVoice() {
    return raceDef(this.state.players[LOCAL_PLAYER].race).voice;
  }

  // -------------------------------------------------------------------------
  // Command issuing with instant feedback
  // -------------------------------------------------------------------------

  private enqueue(cmd: Command): void {
    this.pendingCommands.push(cmd);
  }

  private tryTrain(buildingId: number, unit: string): void {
    const u = UNITS[unit];
    const err = canAfford(this.state, LOCAL_PLAYER, u.cost) ??
      (foodUsed(this.state, LOCAL_PLAYER) + u.food > foodCap(this.state, LOCAL_PLAYER) ? 'noFood' : null);
    if (err === 'noGold' || err === 'noWood' || err === 'noFood') {
      sfx.error();
      speak(this.localVoice, err);
      this.hud.showAlert(
        err === 'noGold' ? 'Not enough gold' : err === 'noWood' ? 'Not enough lumber' : 'Build more houses — not enough food',
      );
      return;
    }
    sfx.click();
    this.enqueue({ kind: 'train', player: LOCAL_PLAYER, building: buildingId, unit });
  }

  private tryUpgrade(buildingId: number): void {
    const b = this.state.entities.get(buildingId);
    if (!b) return;
    const next = buildingDef(b.type)?.levels[b.level];
    if (!next) return;
    const err = canAfford(this.state, LOCAL_PLAYER, next.cost);
    if (err) {
      sfx.error();
      speak(this.localVoice, err === 'noGold' ? 'noGold' : 'noWood');
      this.hud.showAlert(err === 'noGold' ? 'Not enough gold' : 'Not enough lumber');
      return;
    }
    sfx.click();
    this.enqueue({ kind: 'upgrade', player: LOCAL_PLAYER, building: buildingId });
  }

  private startPlacement(type: string): void {
    const def = buildingDef(type);
    const err = canAfford(this.state, LOCAL_PLAYER, def.cost);
    if (err) {
      sfx.error();
      speak(this.localVoice, err === 'noGold' ? 'noGold' : 'noWood');
      this.hud.showAlert(err === 'noGold' ? 'Not enough gold' : 'Not enough lumber');
      return;
    }
    sfx.click();
    this.placing = type;
  }

  private stopSelection(): void {
    const units = this.selectedOwnUnits();
    if (units.length > 0) {
      this.enqueue({ kind: 'stop', player: LOCAL_PLAYER, units });
    }
  }

  private surrender(): void {
    if (this.ended) return;
    this.ended = true;
    speak(this.localVoice, 'defeat');
    sfx.defeat();
    showEndScreen(this.root, false, () => {
      this.destroy();
      this.onRestart();
    });
  }

  private selectedOwnUnits(): number[] {
    const out: number[] = [];
    for (const id of this.selection) {
      const e = this.state.entities.get(id);
      if (e && e.owner === LOCAL_PLAYER && !e.isBuilding) out.push(id);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private on<K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void): void;
  private on<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void): void;
  private on(target: Window | HTMLElement, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.disposers.push(() => target.removeEventListener(type, fn));
  }

  private bindInput(): void {
    this.on(window, 'resize', () => this.resize());
    this.on(window, 'contextmenu', (e) => e.preventDefault());

    this.on(this.canvas, 'mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      this.mouseSeen = true;
      if (this.dragStart && (Math.abs(e.clientX - this.dragStart.x) > 4 || Math.abs(e.clientY - this.dragStart.y) > 4)) {
        this.dragRect = { x0: this.dragStart.x, y0: this.dragStart.y, x1: e.clientX, y1: e.clientY };
      }
    });

    this.on(this.canvas, 'mousedown', (e) => {
      if (e.button === 0) {
        if (this.placing) {
          this.placeBuilding();
          return;
        }
        if (this.attackMoveArmed) {
          this.issueAttackMove(e.clientX, e.clientY);
          this.attackMoveArmed = false;
          return;
        }
        this.dragStart = { x: e.clientX, y: e.clientY };
      } else if (e.button === 2) {
        if (this.placing) {
          this.placing = null;
          return;
        }
        this.attackMoveArmed = false;
        this.rightClick(e.clientX, e.clientY);
      }
    });

    this.on(window, 'mouseup', (e) => {
      if (e.button !== 0) return;
      if (this.dragRect) {
        this.boxSelect(this.dragRect, e.shiftKey);
      } else if (this.dragStart) {
        this.clickSelect(e.clientX, e.clientY, e.shiftKey);
      }
      this.dragStart = null;
      this.dragRect = null;
    });

    this.on(this.canvas, 'wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      this.camera.zoom *= factor;
      this.camera.clampTo(this.state.map.width, this.state.map.height);
    });

    this.on(window, 'keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.key.toLowerCase());
      switch (e.key.toLowerCase()) {
        case 'escape':
          if (this.placing) this.placing = null;
          else if (this.attackMoveArmed) this.attackMoveArmed = false;
          else this.selection.clear();
          break;
        case 'a':
          if (!e.ctrlKey && this.selectedOwnUnits().length > 0) this.attackMoveArmed = true;
          break;
        case 's':
          if (!e.ctrlKey) this.stopSelection();
          break;
        case 'h':
          this.hud.toggleHelp();
          break;
        case 'm':
          setSfxMuted(!isSfxMuted());
          break;
        case 'v':
          setVoiceMuted(!isVoiceMuted());
          break;
        default: {
          const num = parseInt(e.key, 10);
          if (num >= 1 && num <= 9) {
            if (e.ctrlKey) {
              this.controlGroups.set(num, [...this.selection]);
              e.preventDefault();
            } else {
              const group = this.controlGroups.get(num);
              if (group) {
                this.selection = new Set(group.filter((id) => this.state.entities.has(id)));
              }
            }
          }
        }
      }
    });
    this.on(window, 'keyup', (e) => this.keys.delete(e.key.toLowerCase()));

    // minimap navigation
    const mmWrap = this.hud.minimapCanvas.parentElement!;
    const mmMove = (e: MouseEvent) => {
      const r = this.hud.minimapCanvas.getBoundingClientRect();
      const w = this.minimap.toWorld(
        ((e.clientX - r.left) / r.width) * 150,
        ((e.clientY - r.top) / r.height) * 150,
        this.state.map.width,
      );
      this.camera.x = w.x;
      this.camera.y = w.y;
      this.camera.clampTo(this.state.map.width, this.state.map.height);
    };
    this.on(mmWrap, 'mousedown', (e) => {
      if ((e as MouseEvent).button === 2) {
        // right click on minimap: smart-command at that location
        const r = this.hud.minimapCanvas.getBoundingClientRect();
        const me = e as MouseEvent;
        const w = this.minimap.toWorld(
          ((me.clientX - r.left) / r.width) * 150,
          ((me.clientY - r.top) / r.height) * 150,
          this.state.map.width,
        );
        const units = this.selectedOwnUnits();
        if (units.length > 0) {
          this.enqueue({ kind: 'move', player: LOCAL_PLAYER, units, x: w.x, y: w.y });
          speak(this.localVoice, 'move');
        }
        return;
      }
      this.minimapDrag = true;
      mmMove(e as MouseEvent);
    });
    this.on(window, 'mousemove', (e) => {
      if (this.minimapDrag) mmMove(e);
    });
    this.on(window, 'mouseup', () => { this.minimapDrag = false; });
  }

  private resize(): void {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.camera.screenW = window.innerWidth;
    this.camera.screenH = window.innerHeight;
  }

  private worldAtMouse(sx: number, sy: number): { x: number; y: number } {
    return this.camera.screenToWorld(sx, sy);
  }

  private clickSelect(sx: number, sy: number, additive: boolean): void {
    const w = this.worldAtMouse(sx, sy);
    let best: Entity | null = null;
    let bestD = Infinity;
    for (const e of this.state.entities.values()) {
      if (e.insideMine > 0) continue;
      if (this.fog.at(e.x, e.y) === 0) continue;
      if (this.fog.at(e.x, e.y) === 1 && !e.isBuilding) continue;
      const half = e.isBuilding ? e.size / 2 + 0.2 : 0.55;
      // generous click box, biased upward since sprites stand above their tile
      if (Math.abs(w.x - e.x) <= half + 0.3 && Math.abs(w.y - e.y) <= half + 0.3) {
        const d = Math.abs(w.x - e.x) + Math.abs(w.y - e.y) + (e.isBuilding ? 1 : 0);
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
    }
    if (!additive) this.selection.clear();
    if (best) {
      this.selection.add(best.id);
      if (best.owner === LOCAL_PLAYER) {
        sfx.click();
        if (!best.isBuilding) speak(this.localVoice, 'select');
      }
    }
  }

  private boxSelect(rect: { x0: number; y0: number; x1: number; y1: number }, additive: boolean): void {
    const x0 = Math.min(rect.x0, rect.x1), x1 = Math.max(rect.x0, rect.x1);
    const y0 = Math.min(rect.y0, rect.y1), y1 = Math.max(rect.y0, rect.y1);
    const picked: number[] = [];
    for (const e of this.state.entities.values()) {
      if (e.isBuilding || e.owner !== LOCAL_PLAYER || e.insideMine > 0) continue;
      const s = this.camera.worldToScreen(e.x, e.y);
      if (s.x >= x0 && s.x <= x1 && s.y >= y0 - 20 && s.y <= y1 + 10) picked.push(e.id);
    }
    if (picked.length === 0) {
      if (!additive) this.selection.clear();
      return;
    }
    if (!additive) this.selection.clear();
    // prefer military: if box contains both military and workers, classic UX selects all anyway
    for (const id of picked) this.selection.add(id);
    speak(this.localVoice, 'select');
    sfx.click();
  }

  private rightClick(sx: number, sy: number): void {
    const w = this.worldAtMouse(sx, sy);

    // building selected → set rally
    const selected = [...this.selection].map((id) => this.state.entities.get(id)).filter(Boolean) as Entity[];
    const ownBuildings = selected.filter((e) => e.isBuilding && e.owner === LOCAL_PLAYER && e.buildRemaining === 0);
    const ownUnits = this.selectedOwnUnits();

    if (ownUnits.length === 0 && ownBuildings.length > 0) {
      for (const b of ownBuildings) {
        this.enqueue({ kind: 'setRally', player: LOCAL_PLAYER, building: b.id, x: w.x, y: w.y });
      }
      sfx.click();
      this.renderer.addFloatingText(w.x, w.y, '⚑ rally', '#9ad09a');
      return;
    }
    if (ownUnits.length === 0) return;

    const cmd = smartCommand(this.state, LOCAL_PLAYER, ownUnits, w.x, w.y);
    this.enqueue(cmd);

    // feedback
    switch (cmd.kind) {
      case 'harvest':
        speak(this.localVoice, 'build');
        this.renderer.addFloatingText(w.x, w.y, cmd.target !== undefined ? '⛏ mine' : '🪓 chop', '#ffd84d');
        break;
      case 'attack':
        speak(this.localVoice, 'attack');
        this.renderer.addFloatingText(w.x, w.y, '⚔', '#ff6a5a');
        break;
      case 'joinBuild':
        speak(this.localVoice, 'build');
        break;
      default:
        speak(this.localVoice, 'move');
        this.renderer.addFloatingText(w.x, w.y, '➤', '#9ad09a');
    }
  }

  private issueAttackMove(sx: number, sy: number): void {
    const w = this.worldAtMouse(sx, sy);
    const units = this.selectedOwnUnits();
    if (units.length === 0) return;
    this.enqueue({ kind: 'attackMove', player: LOCAL_PLAYER, units, x: w.x, y: w.y });
    speak(this.localVoice, 'attack');
    this.renderer.addFloatingText(w.x, w.y, '⚔ attack-move', '#ff6a5a');
  }

  private placeBuilding(): void {
    if (!this.placing) return;
    const g = this.renderer.placingGhost;
    if (!g || !g.valid) {
      sfx.error();
      return;
    }
    const workers = this.selectedOwnUnits().filter((id) => {
      const e = this.state.entities.get(id);
      return e && unitDef(e.type)?.isWorker;
    });
    if (workers.length === 0) {
      this.placing = null;
      return;
    }
    this.enqueue({ kind: 'build', player: LOCAL_PLAYER, workers, building: this.placing, tx: g.tx, ty: g.ty });
    sfx.placeBuilding();
    speak(this.localVoice, 'build');
    this.placing = null;
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  private frame(now: number): void {
    if (!this.running) return;
    try {
      this.frameInner(now);
    } catch (err) {
      console.error('frame error', err);
      throw err;
    }
  }

  private frameInner(now: number): void {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    this.handleCameraPan(dt);

    // fixed-timestep sim
    const tickDur = 1 / TICKS_PER_SECOND;
    this.accumulator += dt;
    let safety = 0;
    while (this.accumulator >= tickDur && safety++ < 8) {
      this.runTick();
      this.accumulator -= tickDur;
    }
    if (safety >= 8) this.accumulator = 0; // tab was backgrounded; drop time

    const alpha = this.accumulator / tickDur;

    // placement ghost follows mouse
    if (this.placing) {
      const def = buildingDef(this.placing);
      const w = this.camera.screenToWorld(this.mouseX, this.mouseY);
      const tx = Math.round(w.x - def.size / 2);
      const ty = Math.round(w.y - def.size / 2);
      this.renderer.placingGhost = {
        type: this.placing, tx, ty,
        valid: canPlaceBuilding(this.state, this.placing, tx, ty),
      };
    } else {
      this.renderer.placingGhost = null;
    }

    this.renderer.draw(this.state, this.fog, LOCAL_PLAYER, this.selection, alpha, dt, this.dragRect);
    this.minimap.draw(this.state, this.fog, this.camera, LOCAL_PLAYER);
    this.hud.update(this.state, LOCAL_PLAYER, this.selection);

    this.rafId = requestAnimationFrame((t) => this.frame(t));
  }

  private handleCameraPan(dt: number): void {
    const speed = 600 * dt;
    let dx = 0, dy = 0;
    if (this.keys.has('arrowleft')) dx -= speed;
    if (this.keys.has('arrowright')) dx += speed;
    if (this.keys.has('arrowup')) dy -= speed;
    if (this.keys.has('arrowdown')) dy += speed;
    // edge pan (only when not drag-selecting, and only once the mouse is live)
    if (!this.dragRect && this.mouseSeen) {
      const m = 8;
      if (this.mouseX < m) dx -= speed;
      if (this.mouseX > this.camera.screenW - m) dx += speed;
      if (this.mouseY < m) dy -= speed;
      if (this.mouseY > this.camera.screenH - m) dy += speed;
    }
    if (dx !== 0 || dy !== 0) {
      this.camera.pan(dx, dy);
      this.camera.clampTo(this.state.map.width, this.state.map.height);
    }
  }

  private runTick(): void {
    if (this.state.winner !== null) return;

    // AI controllers contribute commands through the same queue as the player
    const commands = this.pendingCommands;
    this.pendingCommands = [];
    for (const p of this.state.players) {
      if (p.isAI && !p.defeated) commands.push(...aiThink(this.state, p.id));
    }

    step(this.state, this.events, commands);
    this.fog.update(this.state, LOCAL_PLAYER);

    // prune dead from selection
    for (const id of [...this.selection]) {
      if (!this.state.entities.has(id)) this.selection.delete(id);
    }

    for (const ev of this.events.drain()) {
      this.handleEvent(ev);
    }
  }

  private handleEvent(ev: SimEvent): void {
    switch (ev.kind) {
      case 'buildComplete':
        if (ev.player === LOCAL_PLAYER) {
          sfx.buildingDone();
          speak(this.localVoice, 'workComplete');
          const b = this.state.entities.get(ev.entity);
          if (b) this.renderer.addFloatingText(b.x, b.y, '✓ complete', '#9ad09a');
        }
        break;
      case 'trainComplete':
        if (ev.player === LOCAL_PLAYER) {
          sfx.trainDone();
          speak(this.localVoice, 'trainReady');
        }
        break;
      case 'upgradeComplete':
        if (ev.player === LOCAL_PLAYER) {
          sfx.buildingDone();
          speak(this.localVoice, 'workComplete');
          const b = this.state.entities.get(ev.entity);
          if (b) {
            const name = buildingDef(b.type).levels[b.level - 1].name;
            this.hud.showAlert(`Upgraded to ${name}!`, true);
          }
        }
        break;
      case 'underAttack':
        if (ev.player === LOCAL_PLAYER) {
          sfx.underAttack();
          speak(this.localVoice, 'underAttack');
          this.hud.showAlert('⚔️ Your forces are under attack!');
        }
        break;
      case 'attackSwing': {
        if (this.fog.at(ev.x, ev.y) !== 2) break;
        const attacker = this.state.entities.get(ev.attacker);
        if (ev.ranged) {
          sfx.arrowShot();
          if (attacker) {
            // aim roughly at facing direction
            const tx = ev.x + Math.cos(attacker.facing) * 3;
            const ty = ev.y + Math.sin(attacker.facing) * 3;
            this.renderer.addEffect({ kind: 'arrow', x: ev.x, y: ev.y, tx, ty, age: 0 });
          }
        } else {
          sfx.swordHit();
          this.renderer.addEffect({ kind: 'slash', x: ev.x, y: ev.y, age: 0 });
        }
        break;
      }
      case 'entityDied':
        if (this.fog.at(ev.x, ev.y) === 2) {
          if (ev.isBuilding && ev.type !== 'goldmine') {
            sfx.buildingCollapse();
            this.renderer.addEffect({ kind: 'collapse', x: ev.x, y: ev.y, age: 0 });
          } else if (!ev.isBuilding) {
            sfx.unitDeath();
            this.renderer.addEffect({ kind: 'death', x: ev.x, y: ev.y, age: 0 });
          }
        }
        break;
      case 'resourceDelivered':
        if (ev.player === LOCAL_PLAYER && this.state.tick % 3 === 0) {
          if (ev.resource === 'gold') sfx.coin();
          else sfx.woodDrop();
        }
        break;
      case 'mineDepleted':
        if (this.fog.at(ev.x, ev.y) > 0) {
          this.hud.showAlert('A gold mine has collapsed — find another!');
        }
        break;
      case 'playerDefeated': {
        const p = this.state.players[ev.player];
        if (ev.player === LOCAL_PLAYER) {
          this.endGame(false);
        } else {
          this.hud.showAlert(`${p.name} has been defeated!`, true);
        }
        break;
      }
      case 'victory':
        if (ev.player === LOCAL_PLAYER) this.endGame(true);
        break;
    }
  }

  private endGame(victory: boolean): void {
    if (this.ended) return;
    this.ended = true;
    if (victory) {
      sfx.victory();
      speak(this.localVoice, 'victory');
    } else {
      sfx.defeat();
      speak(this.localVoice, 'defeat');
    }
    setTimeout(() => {
      showEndScreen(this.root, victory, () => {
        this.destroy();
        this.onRestart();
      });
    }, 900);
  }
}
