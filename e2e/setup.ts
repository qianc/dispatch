// The folders every e2e server and worker share. Each spec file gets its own server and worker (fixtures.ts).
import { existsSync, mkdirSync, rmSync } from 'node:fs';

/** A folder the e2e worker may read for chats (ASSISTANT_READ_DIRS). */
export const E2E_SRC = '/tmp/dispatch-e2e-src';

/** The first server's port; each Playwright worker adds its index. */
export const PORT = 3199;

/** Local repos the e2e worker may use (LOCAL_REPO_DIRS). */
export const E2E_REPOS = '/tmp/dispatch-e2e-repos';

/**
 * Only the basics from this shell: inside a Dispatch session it holds the live worker's settings
 * (GitHub tokens, repo dirs, server URL, releases), which would point the e2e server and worker at
 * real GitHub and real folders.
 */
const PASS_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TERM', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
export function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && (PASS_ENV.includes(k) || k.startsWith('LC_'))) env[k] = v;
  return env;
}

export default function setup() {
  // the e2e server serves the built web app: without one, every sign-in only times out (DISP-171)
  const web = process.env.E2E_WEB_DIST ?? './dist/web';
  if (!existsSync(`${web}/index.html`)) throw new Error(`No web build in ${web}: run npm run build first (or set E2E_WEB_DIST).`);
  rmSync('/tmp/dispatch-e2e', { recursive: true, force: true });
  rmSync(E2E_SRC, { recursive: true, force: true });
  rmSync(E2E_REPOS, { recursive: true, force: true });
  rmSync('/tmp/dispatch-e2e-work', { recursive: true, force: true }); // the Work account starts signed out
  mkdirSync(E2E_REPOS, { recursive: true });
  mkdirSync(E2E_SRC, { recursive: true });
}
