import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';

const cfg = loadConfig();
const { app, ctx } = await buildApp(cfg, { logger: false });
ctx.github.startPolling(cfg.pollSeconds);
await app.listen({ port: cfg.port, host: '0.0.0.0' });
console.log(`dispatch server on :${cfg.port} (sign-in: ${cfg.authMode === 'off' ? 'DISABLED' : cfg.authMode}${cfg.authMode === 'proxy' ? `, proxy ${cfg.trustedProxies.join(', ')}` : ''})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.close().finally(() => process.exit(0));
  });
}
