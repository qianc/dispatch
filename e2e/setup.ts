// Starts a fresh server + fake-runner worker for the e2e run. (Playwright's webServer first probes the
// port, which hangs for minutes on hosts where connecting to a closed port times out instead of failing.)
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';

export const PORT = 3199;

export default async function setup() {
  rmSync('/tmp/dispatch-e2e', { recursive: true, force: true });
  const common = { ...process.env, WORKER_TOKEN: 'e2e' };
  const procs: ChildProcess[] = [
    spawn(process.execPath, ['src/server/main.ts'], { env: { ...common, DATA_DIR: '/tmp/dispatch-e2e', APP_PASSWORD: 'e2e-pass', PORT: String(PORT) }, stdio: 'inherit' }),
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
    env: { ...common, SERVER_WS_URL: `ws://127.0.0.1:${PORT}/worker`, RUNNER: 'fake', FAKE_DELAY_MS: '150' },
    stdio: 'inherit',
  }));
  return () => procs.forEach((p) => p.kill());
}
