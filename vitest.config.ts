import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// All temp folders of a run go into one root (DISP-120): tmpdir() reads TMPDIR, and the test
// workers, the processes they start and git inherit it. Set here, not in the global setup, so it
// is there before any worker starts; test/global-setup.ts removes the root at the end.
if (!process.env.DISPATCH_TEST_TMP) {
  process.env.DISPATCH_TEST_TMP = mkdtempSync(join(tmpdir(), 'dsp-test-run-'));
  process.env.TMPDIR = process.env.DISPATCH_TEST_TMP;
}

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 20_000, hookTimeout: 20_000, globalSetup: ['test/global-setup.ts'] },
});
