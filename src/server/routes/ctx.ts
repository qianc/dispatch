import type { Attachments } from '../attachments.ts';
import type { Janitor } from '../janitor.ts';
import type { Access } from '../access.ts';
import type { Devices } from '../devices.ts';
import type { Auth } from '../auth.ts';
import type { Bus } from '../bus.ts';
import type { Config } from '../config.ts';
import type { GitHub } from '../github.ts';
import type { Notifier } from '../notify.ts';
import type { Sessions } from '../sessions.ts';
import type { Store } from '../store.ts';
import type { WorkerHub } from '../workerHub.ts';
import type { Workers } from '../workers.ts';
import type { Users } from '../users.ts';
import type { Identities } from '../identities.ts';
import type { HostedGit } from '../hosted.ts';
import type { Scheduler } from '../scheduler.ts';
import type { Orchestrator } from '../orchestrator.ts';

export interface Ctx {
  cfg: Config;
  store: Store;
  auth: Auth;
  access: Access;
  devices: Devices;
  users: Users;
  /** each person's own GitHub connection */
  identities: Identities;
  /** the key file Dispatch generated for secrets in the database, or null (DISPATCH_SECRET_KEY, or in memory) */
  secretKeyFile: string | null;
  bus: Bus;
  hub: WorkerHub;
  workers: Workers;
  hosted: HostedGit;
  sessions: Sessions;
  github: GitHub;
  notifier: Notifier;
  attachments: Attachments;
  janitor: Janitor;
  scheduler: Scheduler;
  orchestrator: Orchestrator;
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
