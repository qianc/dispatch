// Starts a fresh server + fake-runner worker for the e2e run. (Playwright's webServer first probes the
// port, which hangs for minutes on hosts where connecting to a closed port times out instead of failing.)
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

/** A folder the e2e source file 'lives' in, with linked docs. */
export const E2E_SRC = '/tmp/dispatch-e2e-src';

export const PORT = 3199;

/**
 * Only the basics from this shell: inside a Dispatch session it holds the live worker's settings
 * (GitHub tokens, repo dirs, server URL, releases), which would point the e2e server and worker at
 * real GitHub and real folders.
 */
const PASS_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TERM', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && (PASS_ENV.includes(k) || k.startsWith('LC_'))) env[k] = v;
  return env;
}

export default async function setup() {
  rmSync('/tmp/dispatch-e2e', { recursive: true, force: true });
  rmSync(E2E_SRC, { recursive: true, force: true });
  mkdirSync(`${E2E_SRC}/docs`, { recursive: true });
  writeFileSync(`${E2E_SRC}/docs/triage.md`, '# Triage notes\n\nSee [the pic](pic.png).\n\n![diagram](pic.png)\n');
  // a 1x1 png
  writeFileSync(`${E2E_SRC}/docs/pic.png`, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const common = { ...baseEnv(), WORKER_TOKEN: 'e2e' };
  const procs: ChildProcess[] = [
    // E2E_WEB_DIST: test a build kept apart from the one a live server is serving
    spawn(process.execPath, ['src/server/main.ts'], { env: { ...common, DATA_DIR: '/tmp/dispatch-e2e', APP_PASSWORD: 'e2e-pass', PORT: String(PORT), WEB_DIST: process.env.E2E_WEB_DIST ?? './dist/web' }, stdio: 'inherit' }),
  ];
  const end = Date.now() + 15_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/me`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > end) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  procs.push(spawn(process.execPath, ['src/worker/main.ts'], {
    env: { ...common, SERVER_WS_URL: `ws://127.0.0.1:${PORT}/worker`, RUNNER: 'fake', FAKE_DELAY_MS: '150', WINDOWS_PATH: 'off', ASSISTANT_READ_DIRS: E2E_SRC,
      CLAUDE_ACCOUNTS: 'private,work', CLAUDE_ACCOUNT_PRIVATE_OAUTH_TOKEN: 'e2e', CLAUDE_ACCOUNT_WORK_CONFIG_DIR: '/tmp/dispatch-e2e-work', CLAUDE_ACCOUNT_WORK_LABEL: 'Work',
      RELEASES: JSON.stringify([{ repo: 'me/e2e-rel', label_prefix: 'rel:', command: './release.sh {version} --yes' }]) },
    stdio: 'inherit',
  }));
  return () => procs.forEach((p) => p.kill());
}
