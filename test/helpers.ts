import { spawn, type ChildProcess } from 'node:child_process';
import { buildApp } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';

export async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 8000): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function startServer(env: Record<string, string> = {}) {
  const cfg = loadConfig({ WORKER_TOKEN: 'test-token', DISABLE_AUTH: '1', WEB_DIST: '/nonexistent', ...env });
  const { app, ctx } = await buildApp(cfg, { dbFile: ':memory:' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const call = async <T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T }> => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: (await res.json().catch(() => null)) as T };
  };
  return { app, ctx, port, base, call };
}

export function startWorker(port: number, env: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, ['src/worker/main.ts'], {
    // WINDOWS_PATH off: test workers need no Windows tools, and asking Windows for its PATH is slow
    // when many test workers start at once
    env: { ...process.env, SERVER_WS_URL: `ws://127.0.0.1:${port}/worker`, WORKER_TOKEN: 'test-token', RUNNER: 'fake', FAKE_DELAY_MS: '20', WINDOWS_PATH: 'off', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (d) => process.env.DEBUG_WORKER && process.stderr.write(d));
  return child;
}

export function stopWorker(child: ChildProcess) {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}
