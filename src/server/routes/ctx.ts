import type { Attachments } from '../attachments.ts';
import type { Janitor } from '../janitor.ts';
import type { Access } from '../access.ts';
import type { Auth } from '../auth.ts';
import type { Bus } from '../bus.ts';
import type { Config } from '../config.ts';
import type { GitHub } from '../github.ts';
import type { Notifier } from '../notify.ts';
import type { Sessions } from '../sessions.ts';
import type { Store } from '../store.ts';
import type { WorkerHub } from '../workerHub.ts';

export interface Ctx {
  cfg: Config;
  store: Store;
  auth: Auth;
  access: Access;
  bus: Bus;
  hub: WorkerHub;
  sessions: Sessions;
  github: GitHub;
  notifier: Notifier;
  attachments: Attachments;
  janitor: Janitor;
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);

export function intParam(v: unknown, what = 'id') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Bad ${what}`);
  return n;
}
