// Server side of the worker WebSockets: one link per worker; a new connection of the same worker
// replaces its old one, different workers live side by side.
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { ClaudeAccountInfo } from '../shared/accounts.ts';
import type { RpcMethod, ServerToWorker, WorkerCommand, WorkerToServer } from '../shared/protocol.ts';
import type { WorkerFacts } from '../shared/types.ts';

export type WorkerEvent = Exclude<WorkerToServer, { t: 'hello' } | { t: 'rpc' } | { t: 'cmd_result' } | { t: 'slots' } | { t: 'refused' }>;

export interface HubHandlers {
  onHello(workerId: number, live: number[], facts: WorkerFacts | null): void;
  onMessage(workerId: number, msg: WorkerEvent): void;
  onRpc(workerId: number, sessionId: number, method: RpcMethod, params: unknown): Promise<unknown>;
  /** the worker refused a start (full, or not allowed) */
  onRefused(workerId: number, sessionId: number, reason: string): void;
  /** the worker's free slots changed */
  onSlots(workerId: number, free: number): void;
  onDisconnect(workerId: number): void;
}

export class WorkerLink {
  readonly workerId: number;
  readonly name: string;
  private ws: WebSocket;
  /** the worker said hello on this connection: it has told us which sessions it runs */
  ready = false;
  facts: WorkerFacts | null = null;
  pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(workerId: number, name: string, ws: WebSocket) {
    this.workerId = workerId;
    this.name = name;
    this.ws = ws;
  }

  /**
   * Open and past its hello. Before the hello, a session started here would also look "lost" when
   * the hello arrives (it lists only what the worker ran before), and be started a second time.
   */
  get connected() {
    return this.ready && this.ws.readyState === 1;
  }

  send(msg: ServerToWorker): boolean {
    if (this.ws.readyState !== 1 /* OPEN */) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Run a git/workspace command on the worker and wait for its result. */
  cmd<T = unknown>(cmd: WorkerCommand, timeoutMs = 10 * 60_000): Promise<T> {
    const req_id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      if (!this.send({ t: 'cmd', req_id, cmd })) return reject(new Error(`Worker ${this.name} is not connected`));
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error(`worker command ${cmd.c} timed out`));
      }, timeoutMs);
      this.pending.set(req_id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }

  close(code: number, reason: string) {
    this.ws.close(code, reason);
  }

  /** Drop the socket without waiting for the other side's close frame. */
  terminate() {
    this.ws.terminate();
  }

  failPending() {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('worker disconnected'));
      this.pending.delete(id);
    }
  }
}

export class WorkerHub {
  private links = new Map<number, WorkerLink>();
  handlers!: HubHandlers;

  attach(ws: WebSocket, worker: { id: number; name: string }) {
    this.links.get(worker.id)?.close(4000, 'replaced by a new worker connection');
    const link = new WorkerLink(worker.id, worker.name, ws);
    this.links.set(worker.id, link);
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
      if (this.links.get(worker.id) !== link) return; // a replaced connection's late messages
      this.handle(link, msg).catch((e) => console.error('worker message failed', msg.t, e));
    });
    ws.on('close', () => {
      link.failPending();
      if (this.links.get(worker.id) !== link) return;
      this.links.delete(worker.id);
      this.handlers.onDisconnect(worker.id);
    });
  }

  link(workerId: number | null | undefined): WorkerLink | undefined {
    const l = workerId == null ? undefined : this.links.get(workerId);
    return l?.connected ? l : undefined;
  }

  isConnected(workerId: number | null | undefined) {
    return !!this.link(workerId);
  }

  /** Any worker connected (the old app's single "worker online" dot). */
  get connected() {
    return this.connectedIds().length > 0;
  }

  connectedIds(): number[] {
    return [...this.links.values()].filter((l) => l.connected).map((l) => l.workerId);
  }

  send(workerId: number | null | undefined, msg: ServerToWorker): boolean {
    return this.link(workerId)?.send(msg) ?? false;
  }

  cmd<T = unknown>(workerId: number | null | undefined, cmd: WorkerCommand, timeoutMs?: number): Promise<T> {
    const l = this.link(workerId);
    if (!l) return Promise.reject(new Error('Worker is not connected'));
    return l.cmd<T>(cmd, timeoutMs);
  }

  facts(workerId: number | null | undefined): WorkerFacts | null {
    return this.link(workerId)?.facts ?? null;
  }

  /** Claude accounts of one worker, or of all connected workers (by name, first one wins). */
  claudeAccounts(workerId?: number | null): ClaudeAccountInfo[] {
    if (workerId !== undefined) return this.facts(workerId)?.claude_accounts ?? [];
    const seen = new Map<string, ClaudeAccountInfo>();
    for (const id of this.connectedIds()) for (const a of this.facts(id)?.claude_accounts ?? []) if (!seen.has(a.name)) seen.set(a.name, a);
    return [...seen.values()];
  }

  /** Cut a worker off now (revoked): forget the link at once, so nothing it sends counts any more. */
  drop(workerId: number, reason: string) {
    const link = this.links.get(workerId);
    if (!link) return;
    this.links.delete(workerId);
    link.failPending();
    link.close(4001, reason);
    link.terminate();
    this.handlers.onDisconnect(workerId);
  }

  private async handle(link: WorkerLink, msg: WorkerToServer) {
    switch (msg.t) {
      case 'hello':
        // older workers send only their Claude accounts
        link.facts = msg.facts ?? (msg.claude_accounts ? { os: '', hostname: '', slots: 0, free_slots: -1, claude_accounts: msg.claude_accounts, github_accounts: [], local_repo_dirs: [], releases: [] } : null);
        link.ready = true;
        return this.handlers.onHello(link.workerId, msg.live, link.facts);
      case 'cmd_result': {
        const p = link.pending.get(msg.req_id);
        if (!p) return;
        clearTimeout(p.timer);
        link.pending.delete(msg.req_id);
        return msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error ?? 'worker command failed'));
      }
      case 'rpc':
        try {
          const data = await this.handlers.onRpc(link.workerId, msg.session_id, msg.method, msg.params);
          link.send({ t: 'rpc_result', req_id: msg.req_id, ok: true, data });
        } catch (e) {
          link.send({ t: 'rpc_result', req_id: msg.req_id, ok: false, error: (e as Error).message });
        }
        return;
      case 'slots':
        if (link.facts) link.facts = { ...link.facts, free_slots: msg.free };
        return this.handlers.onSlots(link.workerId, msg.free);
      case 'refused':
        return this.handlers.onRefused(link.workerId, msg.session_id, msg.reason);
      default:
        return this.handlers.onMessage(link.workerId, msg);
    }
  }
}
