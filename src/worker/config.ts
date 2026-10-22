// Which servers this worker serves, and what each may use. WORKER_CONFIG names a JSON file; without
// it, today's environment variables are a config with one server named "default" (RELEASES holds
// its releases list as JSON).
//
// {
//   "max_concurrent": 3,                       // agent sessions at once, over all servers
//   "servers": [
//     { "name": "home", "url": "wss://dispatch.example.com/worker", "token_file": "~/.config/dispatch/worker-home.token",
//       "local_repo_dirs": ["~/projects"], "read_dirs": ["~/projects"],
//       "claude_accounts": null, "github_accounts": null,       // null = every account this worker has
//       "releases": [                                           // releases this server may start here
//         { "repo": "me/app", "label_prefix": "rel:", "command": "./release.sh {version} --yes",
//           "notes": "The upload credential is on this machine." } ] }
//   ]
// }
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ReleaseCapability } from '../shared/types.ts';
import { expandDirs } from './runner.ts';

export interface ServerEntry {
  name: string;
  url: string;
  token: string;
  /** folders this server may attach as local repos */
  local_repo_dirs: string[];
  /** folders this server's assistant and imports may read */
  read_dirs: string[];
  /** account names this server may use; null = all */
  claude_accounts: string[] | null;
  github_accounts: string[] | null;
  /** releases this server may start on this worker */
  releases: ReleaseCapability[];
}

export interface WorkerConfig {
  max_concurrent: number;
  servers: ServerEntry[];
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

const releasesSchema = z.array(z.object({
  /** owner/name, a repo name, or a local path */
  repo: z.string().min(1),
  label_prefix: z.string().min(1).max(20).default('rel:'),
  command: z.string().min(1).optional(),
  notes: z.string().max(2000).optional(),
})).default([]);

/** A repo given as a path (~, /, .) is expanded so it compares with a local repo's path. */
function releases(list: z.infer<typeof releasesSchema>, home: string | undefined): ReleaseCapability[] {
  return list.map((r) => ({
    repo: /^[~/.]/.test(r.repo) ? resolve(r.repo.replace(/^~(?=\/|$)/, home ?? '~')).replace(/\/+$/, '') : r.repo,
    label_prefix: r.label_prefix,
    command: r.command ?? null,
    notes: r.notes ?? null,
  }));
}

const fileSchema = z.object({
  max_concurrent: z.number().int().min(1).optional(),
  servers: z.array(z.object({
    name: z.string(),
    url: z.string().min(1),
    token: z.string().optional(),
    token_file: z.string().optional(),
    local_repo_dirs: z.array(z.string()).default([]),
    read_dirs: z.array(z.string()).default([]),
    claude_accounts: z.array(z.string()).nullable().default(null),
    github_accounts: z.array(z.string()).nullable().default(null),
    releases: releasesSchema,
  })),
});

const dirs = (list: string[]) => expandDirs(list.join(':'));

export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const max = Number(env.MAX_CONCURRENT_SESSIONS ?? 3) || 3;
  if (!env.WORKER_CONFIG) {
    if (!env.WORKER_TOKEN) throw new Error('Set WORKER_TOKEN (or WORKER_CONFIG for several servers)');
    return {
      max_concurrent: max,
      servers: [{
        name: 'default',
        url: env.SERVER_WS_URL ?? 'ws://localhost:3000/worker',
        token: env.WORKER_TOKEN,
        local_repo_dirs: expandDirs(env.LOCAL_REPO_DIRS ?? ''),
        read_dirs: expandDirs(env.ASSISTANT_READ_DIRS ?? ''),
        claude_accounts: null,
        github_accounts: null,
        releases: releases(releasesSchema.parse(env.RELEASES ? JSON.parse(env.RELEASES) : []), env.HOME),
      }],
    };
  }
  const raw = fileSchema.parse(JSON.parse(readFileSync(env.WORKER_CONFIG.replace(/^~(?=\/)/, env.HOME ?? '~'), 'utf8')));
  if (!raw.servers.length) throw new Error('WORKER_CONFIG: list at least one server');
  const seen = new Set<string>();
  const servers = raw.servers.map((s): ServerEntry => {
    if (!NAME.test(s.name)) throw new Error(`WORKER_CONFIG: server name "${s.name}" must be lowercase letters, digits and dashes`);
    if (seen.has(s.name)) throw new Error(`WORKER_CONFIG: server "${s.name}" is listed twice`);
    seen.add(s.name);
    const token = s.token ?? (s.token_file ? readFileSync(s.token_file.replace(/^~(?=\/)/, env.HOME ?? '~'), 'utf8').trim() : '');
    if (!token) throw new Error(`WORKER_CONFIG: server "${s.name}" needs a token or token_file`);
    return {
      name: s.name, url: s.url, token,
      local_repo_dirs: dirs(s.local_repo_dirs), read_dirs: dirs(s.read_dirs),
      claude_accounts: s.claude_accounts, github_accounts: s.github_accounts,
      releases: releases(s.releases, env.HOME),
    };
  });
  return { max_concurrent: raw.max_concurrent ?? max, servers };
}
