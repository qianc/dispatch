// DISP-176: what a check, setup or deploy command leaves running in the background ends with it.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/worker/workspace.ts';
import { waitFor } from './helpers.ts';

// a reaped process is gone; one that nobody reaps yet is a zombie, which runs nothing either
function running(pid: number) {
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}

describe('runCheck and background processes', () => {
  it.each([
    ['holds the output open', 'sleep 30 & echo $! > pid; echo ok'],
    ['does not hold the output', 'sleep 30 >/dev/null 2>&1 & echo $! > pid; echo ok'],
  ])('a background child that %s is gone after the command ends', async (_, command) => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsp-bg-'));
    const res = await runCheck(command, cwd, 60_000);
    expect(res.code).toBe(0);
    expect(res.out).toBe('ok');
    const pid = Number(readFileSync(join(cwd, 'pid'), 'utf8'));
    expect(pid).toBeGreaterThan(0);
    await waitFor(() => !running(pid), 'the background child to end', 2000);
  });

  it('a signal aborted before it starts runs nothing (DISP-212)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsp-bg-'));
    const abort = new AbortController();
    abort.abort();
    const started = Date.now();
    const res = await runCheck('touch ran; sleep 30', cwd, 60_000, undefined, abort.signal);
    expect(res.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(existsSync(join(cwd, 'ran'))).toBe(false);
  });
});
