/**
 * Simulation event bus. The sim emits gameplay events each tick; presentation
 * layers (audio, voices, UI toasts, screen shake) subscribe. The sim never
 * talks to the DOM or audio directly — that separation keeps it headless for
 * tests and future networking.
 */
import type { EntityId, PlayerId } from '../sim/state';

export type SimEvent =
  | { kind: 'buildComplete'; player: PlayerId; entity: EntityId; type: string }
  | { kind: 'trainComplete'; player: PlayerId; entity: EntityId; type: string }
  | { kind: 'upgradeComplete'; player: PlayerId; entity: EntityId; type: string; level: number }
  | { kind: 'underAttack'; player: PlayerId; x: number; y: number }
  | { kind: 'entityDied'; player: PlayerId; entity: EntityId; type: string; isBuilding: boolean; x: number; y: number }
  | { kind: 'attackSwing'; attacker: EntityId; ranged: boolean; x: number; y: number }
  | { kind: 'resourceDelivered'; player: PlayerId; resource: 'gold' | 'wood'; amount: number }
  | { kind: 'mineDepleted'; x: number; y: number }
  | { kind: 'playerDefeated'; player: PlayerId }
  | { kind: 'victory'; player: PlayerId };

export class EventBus {
  private queue: SimEvent[] = [];

  emit(e: SimEvent): void {
    this.queue.push(e);
  }

  /** Drain all events accumulated since last call. */
  drain(): SimEvent[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }
}
