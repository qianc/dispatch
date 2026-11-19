// Removes the run's temp root (see vitest.config.ts) when the run ends. DISPATCH_KEEP_TMP=1
// keeps it, to look at what a failed test left.
import { rmSync } from 'node:fs';

export default function setup() {
  return () => {
    const root = process.env.DISPATCH_TEST_TMP;
    if (!root) return;
    if (process.env.DISPATCH_KEEP_TMP === '1') return void console.log(`temp folders kept in ${root}`);
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  };
}
