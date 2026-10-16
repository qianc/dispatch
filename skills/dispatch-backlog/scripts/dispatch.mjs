#!/usr/bin/env node
// Dispatch backlog CLI for Claude Code skills. No dependencies; Node 18+.
//
// Server: DISPATCH_URL, else `url:` in the repo's .dispatch.md, else http://localhost:3000.
// Token: DISPATCH_TOKEN, else ~/.config/dispatch/tokens/<host> (host with ':' as '_', e.g.
// localhost_3000), holding the API token from that server's Settings. Tokens never go in a repo.
// Project: --project KEY, else DISPATCH_PROJECT, else `project:` in the nearest .dispatch.md
// (searched from the current folder upwards). Run `dispatch.mjs help` for the commands.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const OPEN = ['triage', 'backlog', 'todo', 'in_progress', 'in_review'];
const STATUSES = [...OPEN, 'hold', 'done', 'canceled'];

const HELP = `dispatch.mjs <command> [args] [--project KEY]

Reading
  config                         where the settings come from, and the project's conventions
  projects                       all projects
  scales                         the project's importance and effort labels
  list [filters]                 open items (one line each). Filters: --status a,b | --all
                                 --type bug|backlog  --tag t  --module m  --q "words"  --json
  show KEY                       one item in full, with comments and sessions
  facets                         tags and modules in use, with counts
  unreleased                     done items without a release label (for the changelog)

Writing
  add --title T [--type bug|backlog] [--body TEXT | --body-file F] [--importance N|label]
      [--effort label] [--tags a,b] [--modules a,b] [--status S] [--source ID]
                                 prints the new key
  update KEY [same fields as add] [--add-tags a,b] [--remove-tags a,b]
                                 [--add-modules a,b] [--remove-modules a,b]
  status S KEY [KEY...]          S: ${STATUSES.join(', ')}
  comment KEY TEXT               (or --body-file F)
  release VERSION KEY [KEY...]   add the release label (prefix from .dispatch.md) to items
  release VERSION --unreleased   ...to every unreleased done item

Sources (retros, reports)
  source add --title T --kind retro|skill_run|user_report|manual [--body-file F]
             [--reporter R] [--version V] [--skill S]      prints the source id
  source show ID                 the source and its items`;

// ---------- args ----------
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[k] = true;
    else flags[k] = argv[++i];
  } else pos.push(a);
}
const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const die = (msg) => {
  console.error(`dispatch: ${msg}`);
  process.exit(1);
};

// ---------- config ----------
function findConfig(from) {
  let dir = resolve(from);
  for (;;) {
    const f = join(dir, '.dispatch.md');
    if (existsSync(f)) return f;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** .dispatch.md: `key: value` lines between --- fences, then free-text conventions. */
function readConfig(file) {
  if (!file) return { meta: {}, body: '' };
  const text = readFileSync(file, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*?)\s*$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2].trim() };
}

const cfgFile = findConfig(process.cwd());
const cfg = readConfig(cfgFile);
const URL_BASE = (process.env.DISPATCH_URL || cfg.meta.url || 'http://localhost:3000').replace(/\/$/, '');
// one token file per server, named after its host: ~/.config/dispatch/tokens/localhost_3000
const host = (() => {
  try {
    return new URL(URL_BASE).host.replace(/:/g, '_');
  } catch {
    return die(`"${URL_BASE}" is not a valid Dispatch URL`);
  }
})();
const tokenFile = join(homedir(), '.config', 'dispatch', 'tokens', host);
const TOKEN = process.env.DISPATCH_TOKEN || (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '');
const PROJECT = (flags.project || process.env.DISPATCH_PROJECT || cfg.meta.project || '').toUpperCase();
const RELEASE_PREFIX = cfg.meta.release_label_prefix || 'rel:';

// ---------- http ----------
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`${URL_BASE}/api${path}`, {
      method,
      headers: { ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    die(`cannot reach Dispatch at ${URL_BASE} (${e.cause?.code ?? e.message}). Is it running? Set DISPATCH_URL if it is elsewhere.`);
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401) die(`not signed in to ${URL_BASE}: put the API token from its Settings page in ${tokenFile} (chmod 600), or set DISPATCH_TOKEN.`);
  if (!res.ok) die(`${method} ${path}: ${data?.error ?? res.statusText}`);
  return data;
}

const needProject = () => PROJECT || die('no project: add `project: KEY` to .dispatch.md in the repo, or pass --project KEY.');
let projectCache;
const project = async () => (projectCache ??= await api('GET', `/projects/${needProject()}`));
/** An item in full (project, comments, sessions) by its key, e.g. HC-42. */
async function item(key) {
  const it = await api('GET', `/items/by-key/${encodeURIComponent(String(key).toUpperCase())}`);
  return api('GET', `/items/${it.id}`);
}

/** Importance: 1-4 or a label of the project's scale. Effort: a label (or index) of its scale. */
async function scaled(field, value) {
  if (value === undefined || value === true) return undefined;
  const p = await project();
  const scale = field === 'importance' ? p.importance_scale : p.effort_scale;
  if (field === 'effort' && ['-', 'none', ''].includes(String(value).toLowerCase())) return null;
  const byLabel = scale.findIndex((l) => l.toLowerCase() === String(value).toLowerCase());
  if (byLabel >= 0) return field === 'importance' ? byLabel + 1 : byLabel;
  const n = Number(value);
  if (field === 'importance' && Number.isInteger(n) && n >= 1 && n <= 4) return n;
  if (field === 'effort' && Number.isInteger(n) && n >= 0 && n < scale.length) return n;
  die(`${field} "${value}" is not on the project's scale: ${scale.join(', ')}`);
}

function bodyFrom() {
  if (typeof flags['body-file'] === 'string') return readFileSync(flags['body-file'], 'utf8');
  if (typeof flags.body === 'string') return flags.body;
  return undefined;
}

async function fields() {
  const out = {};
  if (typeof flags.title === 'string') out.title = flags.title;
  if (typeof flags.type === 'string') out.type = flags.type === 'bug' ? 'bug' : 'backlog';
  const body = bodyFrom();
  if (body !== undefined) out.body_md = body;
  const imp = await scaled('importance', flags.importance);
  if (imp !== undefined) out.importance = imp;
  const eff = await scaled('effort', flags.effort);
  if (eff !== undefined) out.effort = eff;
  if (typeof flags.tags === 'string') out.labels = list(flags.tags);
  if (typeof flags.modules === 'string') out.modules = list(flags.modules);
  if (typeof flags.status === 'string') {
    if (!STATUSES.includes(flags.status)) die(`status must be one of ${STATUSES.join(', ')}`);
    out.status = flags.status;
  }
  if (typeof flags.source === 'string') out.source_id = Number(flags.source);
  return out;
}

function line(it, p) {
  const eff = it.effort === null ? '' : ` ${p.effort_scale[it.effort] ?? it.effort}`;
  const meta = [...it.modules.map((m) => `[${m}]`), ...it.labels.map((t) => `#${t}`)].join(' ');
  return `${it.key.padEnd(8)} ${it.status.padEnd(11)} ${p.importance_scale[it.importance - 1]}${eff}${it.type === 'bug' ? ' bug' : ''}  ${it.title}${meta ? `  ${meta}` : ''}`;
}

// ---------- commands ----------
const [cmd, ...rest] = pos;
switch (cmd) {
  case undefined:
  case 'help':
    console.log(HELP);
    break;

  case 'config': {
    console.log(`server:   ${URL_BASE}`);
    console.log(`token:    ${process.env.DISPATCH_TOKEN ? 'from DISPATCH_TOKEN' : TOKEN ? tokenFile : `MISSING (expected in ${tokenFile})`}`);
    console.log(`config:   ${cfgFile ?? '(no .dispatch.md found)'}`);
    console.log(`project:  ${PROJECT || '(none)'}`);
    for (const [k, v] of Object.entries(cfg.meta)) if (!['project', 'url'].includes(k)) console.log(`${(k + ':').padEnd(10)}${v}`);
    if (cfg.body) console.log(`\n--- project conventions ---\n${cfg.body}`);
    break;
  }

  case 'projects':
    for (const p of await api('GET', '/projects')) console.log(`${p.key.padEnd(6)} ${p.name}  (${p.counts?.backlog ?? 0} backlog, ${p.counts?.bugs ?? 0} bugs)`);
    break;

  case 'scales': {
    const p = await project();
    console.log(`importance (1-4): ${p.importance_scale.map((l, i) => `${i + 1}=${l}`).join(', ')}`);
    console.log(`effort: ${p.effort_scale.join(', ')}`);
    console.log(`statuses: ${STATUSES.join(', ')}`);
    break;
  }

  case 'list': {
    const p = await project();
    const statuses = flags.all ? null : typeof flags.status === 'string' ? list(flags.status) : OPEN;
    const qs = new URLSearchParams();
    if (statuses) qs.set('status', statuses.join(','));
    if (typeof flags.type === 'string') qs.set('type', flags.type === 'bug' ? 'bug' : 'backlog');
    let items = await api('GET', `/projects/${p.key}/items?${qs}`);
    const low = (xs) => xs.map((x) => x.toLowerCase());
    if (typeof flags.tag === 'string') items = items.filter((i) => low(i.labels).includes(flags.tag.toLowerCase()));
    if (typeof flags.module === 'string') items = items.filter((i) => low(i.modules).includes(flags.module.toLowerCase()));
    if (typeof flags.q === 'string') {
      const words = flags.q.toLowerCase().split(/\s+/).filter(Boolean);
      items = items.filter((i) => words.every((w) => [i.key, i.title, i.body_md, ...i.labels, ...i.modules].join(' ').toLowerCase().includes(w)));
    }
    items.sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || b.importance - a.importance || a.number - b.number);
    if (flags.json) console.log(JSON.stringify(items, null, 2));
    else {
      for (const it of items) console.log(line(it, p));
      console.log(`(${items.length} item${items.length === 1 ? '' : 's'})`);
    }
    break;
  }

  case 'show': {
    const it = await item(rest[0] ?? die('show KEY'));
    const p = it.project;
    console.log(line(it, p));
    if (it.source) console.log(`source #${it.source.id}: ${it.source.title}${it.source.version_tag ? ` (${it.source.version_tag})` : ''}`);
    console.log(`\n${it.body_md || '(no description)'}`);
    for (const c of it.comments) console.log(`\n— ${c.author}, ${c.created_at}\n${c.body_md}`);
    for (const s of it.sessions) console.log(`\nsession #${s.id} ${s.status}: ${s.title}`);
    break;
  }

  case 'facets': {
    const p = await project();
    const f = await api('GET', `/projects/${p.key}/facets`);
    console.log(`modules: ${f.modules.map((m) => `${m.name} (${m.count})`).join(', ') || '-'}`);
    console.log(`tags:    ${f.tags.map((t) => `${t.name} (${t.count})`).join(', ') || '-'}`);
    break;
  }

  case 'unreleased': {
    const p = await project();
    const items = (await api('GET', `/projects/${p.key}/items?status=done`)).filter((i) => !i.labels.some((l) => l.startsWith(RELEASE_PREFIX)));
    if (flags.json) console.log(JSON.stringify(items, null, 2));
    else {
      for (const it of items) console.log(line(it, p));
      console.log(`(${items.length} done item${items.length === 1 ? '' : 's'} not in a release yet)`);
    }
    break;
  }

  case 'add': {
    const p = await project();
    const body = await fields();
    if (!body.title) die('add needs --title');
    const it = await api('POST', `/projects/${p.key}/items`, body);
    console.log(it.key);
    break;
  }

  case 'update': {
    const it = await item(rest[0] ?? die('update KEY ...'));
    projectCache = it.project;
    const patch = await fields();
    const edit = (cur, add, remove) => {
      const lower = list(remove).map((x) => x.toLowerCase());
      const kept = cur.filter((x) => !lower.includes(x.toLowerCase()));
      for (const a of list(add)) if (!kept.some((x) => x.toLowerCase() === a.toLowerCase())) kept.push(a);
      return kept;
    };
    if (flags['add-tags'] || flags['remove-tags']) patch.labels = edit(patch.labels ?? it.labels, flags['add-tags'], flags['remove-tags']);
    if (flags['add-modules'] || flags['remove-modules']) patch.modules = edit(patch.modules ?? it.modules, flags['add-modules'], flags['remove-modules']);
    if (!Object.keys(patch).length) die('nothing to update');
    const up = await api('PATCH', `/items/${it.id}`, patch);
    console.log(line(up, it.project));
    break;
  }

  case 'status': {
    const [s, ...keys] = rest;
    if (!STATUSES.includes(s) || !keys.length) die(`status S KEY [KEY...], S one of ${STATUSES.join(', ')}`);
    for (const k of keys) {
      const it = await item(k);
      const up = await api('PATCH', `/items/${it.id}`, { status: s });
      console.log(line(up, it.project));
    }
    break;
  }

  case 'comment': {
    const it = await item(rest[0] ?? die('comment KEY TEXT'));
    const text = bodyFrom() ?? rest.slice(1).join(' ');
    if (!text.trim()) die('comment needs text');
    await api('POST', `/items/${it.id}/comments`, { body_md: text, author: 'claude' });
    console.log(`commented on ${it.key}`);
    break;
  }

  case 'release': {
    const [version, ...keys] = rest;
    if (!version) die('release VERSION KEY... | --unreleased');
    const label = `${RELEASE_PREFIX}${version}`;
    let targets;
    if (flags.unreleased) {
      const p = await project();
      targets = (await api('GET', `/projects/${p.key}/items?status=done`)).filter((i) => !i.labels.some((l) => l.startsWith(RELEASE_PREFIX)));
    } else {
      if (!keys.length) die('release VERSION KEY... | --unreleased');
      targets = await Promise.all(keys.map(item));
    }
    for (const it of targets) {
      if (!it.labels.includes(label)) await api('PATCH', `/items/${it.id}`, { labels: [...it.labels, label] });
      console.log(`${it.key} → ${label}`);
    }
    if (!targets.length) console.log('nothing to release');
    break;
  }

  case 'source': {
    const [sub, id] = rest;
    if (sub === 'add') {
      const p = await project();
      if (typeof flags.title !== 'string') die('source add needs --title');
      const s = await api('POST', `/projects/${p.key}/sources`, {
        kind: typeof flags.kind === 'string' ? flags.kind : 'manual',
        title: flags.title,
        body_md: bodyFrom() ?? '',
        reporter: typeof flags.reporter === 'string' ? flags.reporter : null,
        version_tag: typeof flags.version === 'string' ? flags.version : null,
        skill_name: typeof flags.skill === 'string' ? flags.skill : null,
      });
      console.log(s.id);
    } else if (sub === 'show') {
      const s = await api('GET', `/sources/${id ?? die('source show ID')}`);
      console.log(`source #${s.id} ${s.kind}: ${s.title}`);
      console.log([s.reporter, s.version_tag, s.skill_name].filter(Boolean).join(' · '));
      for (const it of s.items) console.log(line(it, s.project));
    } else die('source add|show');
    break;
  }

  default:
    die(`unknown command "${cmd}". Run: dispatch.mjs help`);
}
