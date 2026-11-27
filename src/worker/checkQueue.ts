// DISP-264: a worker runs at most MAX_CONCURRENT_CHECKS turn or merge checks at once, over all its
// servers; the others wait in turn. The agents' own work (and their own test runs) is not limited.

/** How many checks run at once: MAX_CONCURRENT_CHECKS on the worker, 1 by default. */
export function maxChecks() {
  const n = Number(process.env.MAX_CONCURRENT_CHECKS);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

export class CheckQueue {
  private running = 0;
  private waiting: (() => void)[] = [];
  private max: () => number;

  constructor(max: () => number = maxChecks) {
    this.max = max;
  }

  /**
   * Run `fn` when a place is free, `onWait` first when it has to wait. Stopped while it waits, `fn`
   * runs at once without a place: it sees the aborted signal and ends without running the check.
   */
  async run<T>(fn: () => Promise<T>, onWait?: () => void, signal?: AbortSignal): Promise<T> {
    if (this.running < this.max()) this.running++;
    else {
      onWait?.();
      const got = await new Promise<boolean>((resolve) => {
        if (signal?.aborted) return resolve(false);
        const next = () => {
          signal?.removeEventListener('abort', stop);
          resolve(true);
        };
        const stop = () => {
          this.waiting = this.waiting.filter((w) => w !== next);
          resolve(false);
        };
        signal?.addEventListener('abort', stop, { once: true });
        this.waiting.push(next);
      });
      if (!got) return fn();
    }
    try {
      return await fn();
    } finally {
      // the place goes straight to the next in line
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}

/** The worker's one queue: its links share it. */
export const checkQueue = new CheckQueue();
