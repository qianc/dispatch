import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startServer } from './helpers.ts';

it('a closed server runs no grace timer of a worker that went away', async () => {
  const s = await startServer({ DATA_DIR: mkdtempSync(join(tmpdir(), 'dsp-stop-')) });
  const sessions = s.ctx.sessions;
  const dispatch = vi.spyOn(sessions, 'dispatch');
  vi.useFakeTimers();
  try {
    sessions.onWorkerDisconnect(1);
    dispatch.mockClear();
    await s.app.close();
    vi.advanceTimersByTime(10 * 60_000);
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
