// Server side of the internal worker WebSocket: one worker connection at a time.
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { RpcMethod, ServerToWorker, WorkerCommand, WorkerToServer } from '../shared/protocol.ts';

export interface HubHandlers {
  onHello(live: number[]): void;
  onMessage(msg: Exclude<WorkerToServer, { t: 'hello' } | { t: 'rpc' } | { t: 'cmd_result' }>): void;
  onRpc(sessionId: number, method: RpcMethod, params: unknown): Promise<unknown>;
  onDisconnect(): void;
}

export class WorkerHub {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  handlers!: HubHandlers;

  get connected() {
    return this.ws?.readyState === 1;
  }

  attach(ws: WebSocket) {
    this.ws?.close(4000, 'replaced by a new worker connection');
    this.ws = ws;
    let alive = true;
    ws.on('pong', () => (alive = true));
    const beat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 20_000);
    ws.on('close', () => clearInterval(beat));
    ws.on('message', (data) => {
      let msg: WorkerToServer;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      this.handle(msg).catch((e) => console.error('worker message failed', msg.t, e));
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('worker disconnected'));
        this.pending.delete(id);
      }
      this.handlers.onDisconnect();
    });
  }

  send(msg: ServerToWorker): boolean {
    if (this.ws?.readyState !== 1 /* OPEN */) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Run a git/workspace command on the worker and wait for its result. */
  cmd<T = unknown>(cmd: WorkerCommand, timeoutMs = 10 * 60_000): Promise<T> {
    const req_id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      if (!this.send({ t: 'cmd', req_id, cmd })) return reject(new Error('Worker is not connected'));
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error(`worker command ${cmd.c} timed out`));
      }, timeoutMs);
      this.pending.set(req_id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }

  private async handle(msg: WorkerToServer) {
    switch (msg.t) {
      case 'hello':
        return this.handlers.onHello(msg.live);
      case 'cmd_result': {
        const p = this.pending.get(msg.req_id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.req_id);
        return msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error ?? 'worker command failed'));
      }
      case 'rpc':
        try {
          const data = await this.handlers.onRpc(msg.session_id, msg.method, msg.params);
          this.send({ t: 'rpc_result', req_id: msg.req_id, ok: true, data });
        } catch (e) {
          this.send({ t: 'rpc_result', req_id: msg.req_id, ok: false, error: (e as Error).message });
        }
        return;
      default:
        return this.handlers.onMessage(msg);
    }
  }
}
