// The server's and the worker's side of the launcher (src/launch.ts, DISP-112).
//
// Three messages, which stay as they are (a launcher keeps running across updates):
//   child → launcher  { t: 'ready', sha }                    it is up, on this commit
//   child → launcher  { t: 'update', req: { sha, from }, ctx } update the checkout to `sha`; `from`: the commit that runs
//   launcher → child  { t: 'result', result, ctx }           how an update ended, to the process that runs now
import type { ApplyResult } from './apply.ts';

export type ChildToLauncher = { t: 'ready'; sha: string | null } | { t: 'update'; req: { sha: string; from: string | null }; ctx?: unknown };
export type LauncherToChild = { t: 'result'; result: ApplyResult; ctx?: unknown };

export interface LauncherLink {
  /** this process can ask for an update of its own checkout */
  available: boolean;
  /** why not */
  why: string | null;
  /** ask; the answer comes to `onResult`, of this process or of the one that runs after */
  request(req: { sha: string; from: string | null }, ctx?: unknown): void;
  onResult(fn: (result: ApplyResult, ctx: unknown) => void): void;
  /** tell the launcher this process is up */
  ready(sha: string | null): void;
}

type Proc = Pick<NodeJS.Process, 'env' | 'on'> & { send?: (m: ChildToLauncher) => unknown; kill?: (pid: number, signal: NodeJS.Signals) => unknown; pid?: number };

export function launcherLink(proc: Proc = process as unknown as Proc): LauncherLink {
  const flag = proc.env.DISPATCH_LAUNCHER ?? '';
  const viaLauncher = typeof proc.send === 'function' && flag !== '';
  const why = !viaLauncher ? 'It was not started through the launcher (node src/launch.ts server|worker).' : flag === '1' ? null : flag.replace(/^no:\s*/, '');
  if (viaLauncher) {
    // without its launcher nothing would stop this process with the service: stop like a signal says
    proc.on('disconnect', () => {
      console.error('the launcher is gone: stopping');
      proc.kill?.(proc.pid!, 'SIGTERM');
    });
  }
  return {
    available: viaLauncher && !why,
    why,
    request(req, ctx) {
      proc.send?.({ t: 'update', req, ctx });
    },
    onResult(fn) {
      if (!viaLauncher) return;
      proc.on('message', (m: unknown) => {
        const msg = m as Partial<LauncherToChild> | null;
        if (msg && msg.t === 'result' && msg.result) fn(msg.result, msg.ctx);
      });
    },
    ready(sha) {
      if (viaLauncher) proc.send?.({ t: 'ready', sha });
    },
  };
}
