import { EventEmitter } from 'node:events';
import type { LiveEvent } from '../shared/types.ts';

/** In-process fan-out of live events to SSE clients. */
export class Bus {
  private ee = new EventEmitter().setMaxListeners(0);
  emit(e: LiveEvent) {
    this.ee.emit('e', e);
  }
  on(fn: (e: LiveEvent) => void) {
    this.ee.on('e', fn);
    return () => this.ee.off('e', fn);
  }
}
