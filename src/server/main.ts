import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';
import { launcherLink } from '../update/ipc.ts';

const cfg = loadConfig();
// the launcher (src/launch.ts) that started this server, when one did (DISP-112)
const launcher = launcherLink();
const { app, ctx } = await buildApp(cfg, { logger: false });
ctx.updates.launcher = launcher;
launcher.onResult((result, c) => ctx.updates.onLauncherResult(result, c));
// an update of this server that was running when it stopped
ctx.updates.reconcile();
ctx.github.startPolling(cfg.pollSeconds, cfg.prSyncSeconds);
await app.listen({ port: cfg.port, host: '0.0.0.0' });
// the launcher's health check: the server is up, on this commit
launcher.ready(ctx.version.sha);
console.log(`dispatch server on :${cfg.port} (sign-in: ${cfg.authMode === 'off' ? 'DISABLED' : cfg.authMode}${cfg.authMode === 'proxy' ? `, proxy ${cfg.trustedProxies.join(', ')}` : ''})`);

// a deploy sends SIGTERM and SIGKILLs 15 s later (stop_grace_period): close the database well before
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    console.log(`${sig}: shutting down`);
    setTimeout(() => {
      console.error('shutdown took over 10 s; exiting without a clean close');
      process.exit(1);
    }, 10_000).unref();
    app.close().then(
      () => process.exit(0),
      (e) => {
        console.error('shutdown failed:', (e as Error).message);
        process.exit(1);
      },
    );
  });
}
