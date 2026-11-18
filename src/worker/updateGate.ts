// When this worker may update itself (DISP-112): only in wait mode, when nothing it does for any
// server would be cut off. A server asks (`self_update`); the worker decides, and answers at once.
// The commit must be one of this machine's own release branch: the server names only the commit.
import type { SelfUpdateAnswer } from '../shared/protocol.ts';
import type { WorkerVersion } from '../shared/types.ts';
import { Refusal, verifyTarget, type ApplyResult } from '../update/apply.ts';
import type { LauncherLink } from '../update/ipc.ts';
import { sameVersion } from '../update/version.ts';
import type { ServerLink, Slots } from './serverLink.ts';

export interface GateDeps {
  links: () => ServerLink[];
  slots: Slots;
  launcher: LauncherLink;
  version: WorkerVersion;
  /** the checkout and its release branch */
  dir: string;
  branch: string;
  /** the environment for git's fetch (the account that reads the Dispatch repo) */
  gitEnv?: NodeJS.ProcessEnv;
  verify?: typeof verifyTarget;
  /** ms between the answer and the stop, so the answer is out before the worker goes */
  delayMs?: number;
}

/** what the launcher gets with an update request, and gives back with its result */
interface Ctx { server: string; update_id: number }

export class UpdateGate {
  private d: GateDeps;
  /** an update was asked of the launcher and has not ended */
  private asked = false;

  constructor(deps: GateDeps) {
    this.d = deps;
    deps.launcher.onResult((result, ctx) => this.onResult(result, ctx));
  }

  /**
   * Why the worker is not in wait mode, as told to `asker`: its own sessions by number, the work
   * for other servers only as that (one server learns nothing of another's sessions).
   */
  busy(asker: ServerLink): string[] {
    const own = asker.busyReasons();
    const others = this.d.links().filter((l) => l !== asker && l.busyReasons().length).length;
    return [...own, ...(others ? [`it works for ${others === 1 ? 'another server' : `${others} other servers`}`] : [])];
  }

  /** A server asks for an update to `sha`. */
  async selfUpdate(asker: ServerLink, sha: string, updateId: number): Promise<SelfUpdateAnswer> {
    const { launcher, version, slots } = this.d;
    if (!launcher.available) return { state: 'refused', reason: launcher.why ?? 'This worker cannot update itself.' };
    if (this.asked) return { state: 'busy', reasons: ['it is updating already'] };
    if (sameVersion(version.sha, sha)) return { state: 'ahead' };
    let reasons = this.busy(asker);
    if (reasons.length) return { state: 'busy', reasons };
    // from here no new session starts: the check below needs the network, and takes a moment
    this.asked = true;
    slots.drain(true);
    const back = (a: SelfUpdateAnswer) => {
      this.asked = false;
      slots.drain(false);
      return a;
    };
    try {
      await (this.d.verify ?? verifyTarget)({ sha, branch: this.d.branch, role: 'worker', dir: this.d.dir, from: version.sha }, { fetch: true, env: this.d.gitEnv });
    } catch (e) {
      return back(e instanceof Refusal && e.kind === 'ahead' ? { state: 'ahead' } : { state: 'refused', reason: (e as Error).message });
    }
    // a chat or a reply may have come in meanwhile (they take no slot)
    reasons = this.busy(asker);
    if (reasons.length) return back({ state: 'busy', reasons });
    const ctx: Ctx = { server: asker.entry.name, update_id: updateId };
    setTimeout(() => launcher.request({ sha, from: version.sha }, ctx), this.d.delayMs ?? 300);
    return { state: 'started' };
  }

  /**
   * How an update ended, from the launcher: in the new version's process, in the old one's after a
   * rollback, or in this same process when the launcher refused before it stopped anything.
   */
  private onResult(result: ApplyResult, ctx: unknown) {
    this.asked = false;
    this.d.slots.drain(false);
    const c = ctx as Partial<Ctx> | null;
    const link = this.d.links().find((l) => l.entry.name === c?.server);
    if (!link || typeof c?.update_id !== 'number') return;
    link.send({
      t: 'update_result', update_id: c.update_id, target: 'worker', ok: result.ok, rolled_back: result.rolled_back, from: result.from, to: result.to,
      ...(result.error ? { error: result.error } : {}), ...(result.log_tail ? { log_tail: result.log_tail.slice(-4000) } : {}),
    });
  }
}
