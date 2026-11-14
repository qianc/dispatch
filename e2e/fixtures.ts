// A fresh server + fake-runner worker for each Playwright worker, so for each spec file. With one
// server for all, the tests of one file reached into the others that ran beside it: their notices
// covered buttons and repeated text a test looked for, and a test that stops every open session
// stopped theirs (DISP-91). (Playwright's webServer first probes the port, which hangs for minutes
// on hosts where connecting to a closed port times out instead of failing.)
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { test as base } from '@playwright/test';
import { baseEnv, E2E_REPOS, E2E_SRC, PORT } from './setup.ts';

export { expect, type Page } from '@playwright/test';

export const test = base.extend<object, { server: string }>({
  server: [async ({}, use, info) => {
    const port = PORT + info.workerIndex;
    const common = { ...baseEnv(), WORKER_TOKEN: 'e2e' };
    const procs: ChildProcess[] = [
      // E2E_WEB_DIST: test a build kept apart from the one a live server is serving
      spawn(process.execPath, ['src/server/main.ts'], { env: { ...common, DATA_DIR: `/tmp/dispatch-e2e/${info.workerIndex}`, APP_PASSWORD: 'e2e-pass', PORT: String(port), WEB_DIST: process.env.E2E_WEB_DIST ?? './dist/web' }, stdio: 'inherit' }),
    ];
    try {
      const end = Date.now() + 15_000;
      for (;;) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/api/me`)).ok) break;
        } catch {
          // not up yet
        }
        if (Date.now() > end) throw new Error('server did not start');
        await new Promise((r) => setTimeout(r, 100));
      }
      procs.push(spawn(process.execPath, ['src/worker/main.ts'], {
        env: { ...common, SERVER_WS_URL: `ws://127.0.0.1:${port}/worker`, RUNNER: 'fake', FAKE_DELAY_MS: '150', WINDOWS_PATH: 'off', ASSISTANT_READ_DIRS: E2E_SRC, LOCAL_REPO_DIRS: E2E_REPOS,
          CLAUDE_ACCOUNTS: 'private,work', CLAUDE_ACCOUNT_PRIVATE_OAUTH_TOKEN: 'e2e', CLAUDE_ACCOUNT_WORK_CONFIG_DIR: '/tmp/dispatch-e2e-work', CLAUDE_ACCOUNT_WORK_LABEL: 'Work',
          RELEASES: JSON.stringify([{ repo: 'me/e2e-rel', label_prefix: 'rel:', command: './release.sh {version} --yes' }]) },
        stdio: 'inherit',
      }));
      await use(`http://127.0.0.1:${port}`);
    } finally {
      await Promise.all(procs.map((p) => (p.exitCode === null && p.signalCode === null && p.kill() ? once(p, 'exit') : null)));
    }
  }, { scope: 'worker', auto: true }],
  baseURL: async ({ server }, use) => {
    await use(server);
  },
});
