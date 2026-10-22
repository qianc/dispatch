#!/usr/bin/env node
// Dispatch backlog CLI for Claude Code skills. No dependencies; Node 18+.
//
// Server, first match wins: --url, else DISPATCH_URL (an override for one shell or one run), else
// `url:` in the repo's .dispatch.md, else ~/.config/dispatch/default-url (this machine's default),
// else http://localhost:3000. `config` says which one won, and names a url: it overrides.
// Token: DISPATCH_TOKEN, else ~/.config/dispatch/tokens/<host> (host with ':' as '_', e.g.
// localhost_3000), holding the API token from that server's Settings. Tokens never go in a repo.
// Project: --project KEY, else DISPATCH_PROJECT, else `project:` in the nearest .dispatch.md
// (searched from the current folder upwards). Run `dispatch.mjs help` for the commands.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OPEN = ['triage', 'backlog', 'todo', 'in_progress', 'in_review'];
const STATUSES = [...OPEN, 'hold', 'done', 'canceled'];

const HELP = `dispatch.mjs <command> [args] [--project KEY]

Setup
  init [--project KEY] [--url URL]
                                 check the server and token, list the projects, and write
                                 .dispatch.md at the repo root from the example (never overwrites)

Reading
  config                         where the settings come from, whether the server takes the
                                 token, and the project's conventions
  projects                       all projects
  scales                         the project's importance and effort labels
  list [filters]                 open items (one line each). Filters: --status a,b | --all
                                 --type bug|backlog  --tag t  --module m  --q "words"  --json
  show KEY                       one item in full, with comments, images and sessions
  facets                         tags and modules in use, with counts
  unreleased                     done items without a release label (for the changelog)

Writing
  add --title T [--type bug|backlog] [--body TEXT | --body-file F] [--importance N|label]
      [--effort label] [--tags a,b] [--modules a,b] [--status S] [--source ID]
      [--images a.png,b.png]     prints the new key
  update KEY [same fields as add] [--add-tags a,b] [--remove-tags a,b]
                                 [--add-modules a,b] [--remove-modules a,b]
  status S KEY [KEY...]          S: ${STATUSES.join(', ')}
  comment KEY TEXT               (or --body-file F) [--images a.png,b.png]
  attach KEY FILE [FILE...]      add images (PNG, JPEG, GIF, WebP) to an item
  images KEY [--save DIR]        download an item's images; prints the file paths to read
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
    if (kv) meta[kv[1]] = configValue(kv[2]);
  }
  return { meta, body: m[2].trim() };
}

/** A frontmatter value: quotes removed; an unquoted value loses a trailing ` # comment`. */
function configValue(raw) {
  const quoted = raw.match(/^(["'])(.*)\1(?:\s+#.*)?$/);
  if (quoted) return quoted[2];
  return raw.replace(/(^|\s+)#.*$/, '');
}

/** The git repo's top folder, else the current folder. */
function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return process.cwd();
  }
}

const cfgFile = findConfig(process.cwd());
const cfg = readConfig(cfgFile);
// this machine's default server, if it has one (~/.config/dispatch/default-url): no address in any repo
const machineDefault = (() => {
  const f = join(homedir(), '.config', 'dispatch', 'default-url');
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
})();
const trimUrl = (u) => u.replace(/\/+$/, '');
// the first of these that is set wins; DISPATCH_URL is an override for one shell or one run
const SERVER = [
  [flags.url, '--url'],
  [process.env.DISPATCH_URL, 'DISPATCH_URL'],
  [cfg.meta.url, '.dispatch.md'],
  [machineDefault, '~/.config/dispatch/default-url'],
  ['http://localhost:3000', 'default'],
].find(([u]) => typeof u === 'string' && u);
const URL_BASE = trimUrl(SERVER[0]);
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
// when Claude should attach example images: always | when_possible (default) | off
const IMAGES = ['always', 'when_possible', 'off'].includes(cfg.meta.images) ? cfg.meta.images : 'when_possible';

// ---------- http ----------
const auth = () => (TOKEN ? { authorization: `Bearer ${TOKEN}` } : {});

/**
 * fetch() against the server, without following redirects: Dispatch never redirects its API, so
 * a redirect means something in front of it (usually a sign-in proxy) answered instead.
 * Throws an Error with a plain message when the server cannot be reached or redirects.
 */
async function send(url, init = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, redirect: 'manual' });
  } catch (e) {
    throw new Error(`cannot reach Dispatch at ${URL_BASE} (${e.cause?.code ?? e.message}). Is it running? Set DISPATCH_URL if it is elsewhere.`);
  }
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get('location');
    const where = to ? new URL(to, url).host : 'another page';
    throw new Error(
      `redirected to ${where}: a login proxy is in front of the API at ${URL_BASE}. Is the token valid for this host? ` +
        `Tokens are per server; this one is read from ${process.env.DISPATCH_TOKEN ? 'DISPATCH_TOKEN' : tokenFile}.`,
    );
  }
  return res;
}

async function api(method, path, body) {
  let res;
  try {
    res = await send(`${URL_BASE}/api${path}`, {
      method,
      headers: { ...auth(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    die(e.message);
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401) die(`not signed in to ${URL_BASE}: make a token in Dispatch → Settings → Tokens (scope "tracker") and put it in ${tokenFile} (chmod 600), or set DISPATCH_TOKEN.`);
  if (res.status === 403 && data?.error) die(`${method} ${path}: ${data.error}`);
  if (!res.ok) die(`${method} ${path}: ${data?.error ?? res.statusText}`);
  return data;
}

/** One cheap call to see whether the server takes the token: valid, rejected (why) or missing. */
async function checkToken() {
  if (!TOKEN) return { state: 'missing' };
  try {
    const res = await send(`${URL_BASE}/api/projects`, { headers: auth(), signal: AbortSignal.timeout(8000) });
    if (res.ok) return { state: 'valid' };
    if (res.status === 401 || res.status === 403) return { state: 'rejected', why: `the server answered ${res.status}` };
    return { state: 'unknown', why: `the server answered ${res.status}` };
  } catch (e) {
    return e.message.startsWith('redirected') ? { state: 'rejected', why: e.message } : { state: 'unknown', why: e.message };
  }
}

/** Upload image files to an item (optionally to one of its comments), signed "claude". */
async function attach(itemId, files, commentId) {
  const out = [];
  for (const f of files) {
    if (!existsSync(f)) die(`no such file: ${f}`);
    const q = new URLSearchParams({ name: basename(f), author: 'claude' });
    if (commentId) q.set('comment_id', String(commentId));
    let res;
    try {
      res = await send(`${URL_BASE}/api/items/${itemId}/images?${q}`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/octet-stream' },
        body: readFileSync(f),
      });
    } catch (e) {
      die(e.message);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) die(`${basename(f)}: ${data?.error ?? res.statusText}`);
    out.push(data);
  }
  return out;
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
    const from = SERVER[1] === 'default' ? 'default' : `from ${SERVER[1]}`;
    // a repo's url: that loses to --url or DISPATCH_URL is easy to miss, so name it
    const repoUrl = cfg.meta.url ? trimUrl(cfg.meta.url) : '';
    const beaten = repoUrl && SERVER[1] !== '.dispatch.md' && repoUrl !== URL_BASE ? `, overrides url: ${repoUrl} in .dispatch.md` : '';
    console.log(`server:   ${URL_BASE} (${from}${beaten})`);
    const tokenFrom = process.env.DISPATCH_TOKEN ? 'from DISPATCH_TOKEN' : tokenFile;
    const t = await checkToken();
    if (t.state === 'missing') console.log(`token:    missing (expected in ${tokenFile})`);
    else console.log(`token:    ${t.state === 'unknown' ? 'not checked' : t.state} (${tokenFrom})${t.why ? `: ${t.why}` : ''}`);
    console.log(`config:   ${cfgFile ?? '(no .dispatch.md found)'}`);
    console.log(`project:  ${PROJECT || '(none)'}`);
    for (const [k, v] of Object.entries(cfg.meta)) if (!['project', 'url', 'images'].includes(k)) console.log(`${(k + ':').padEnd(10)}${v}`);
    console.log(`images:   ${IMAGES}${cfg.meta.images ? '' : ' (default)'}`);
    if (cfg.body) console.log(`\n--- project conventions ---\n${cfg.body}`);
    break;
  }

  case 'init': {
    const root = repoRoot();
    const target = join(root, '.dispatch.md');
    if (existsSync(target)) die(`${target} already exists; edit it instead (init never overwrites it).`);
    const projects = await api('GET', '/projects');
    console.log(`server:   ${URL_BASE}`);
    console.log(`projects:`);
    for (const p of projects) console.log(`  ${p.key.padEnd(6)} ${p.name}`);
    if (!projects.length) console.log('  (none)');
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const folder = basename(root);
    const match = projects.find((p) => norm(p.key) === norm(folder) || norm(p.name) === norm(folder));
    const create = 'This script cannot create projects: make one in the Dispatch app, then run init again.';
    if (typeof flags.project !== 'string') {
      die(match
        ? `project ${match.key} matches the folder name "${folder}". If that is the one, run: dispatch init --project ${match.key}`
        : `no project matches the folder name "${folder}". Pick one above and run: dispatch init --project KEY. ${create}`);
    }
    const chosen = projects.find((p) => p.key === PROJECT);
    if (!chosen) die(`there is no project ${PROJECT} on ${URL_BASE}. ${create}`);

    let text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'dispatch.example.md'), 'utf8');
    text = text.replace(/^project: .*$/m, `project: ${chosen.key}`);
    if (typeof flags.url === 'string') text = text.replace(/^# url: .*\n(?:#\s+#.*\n)*/m, `url: ${URL_BASE}\n`);
    writeFileSync(target, text);
    console.log(`\nwrote ${target} for ${chosen.key} (${chosen.name})`);

    const todo = [];
    const t = await checkToken();
    if (t.state === 'missing') todo.push(`token: none for this server. Make one in Dispatch → Settings → Tokens (scope "tracker") and save it in ${tokenFile} (chmod 600).`);
    if (t.state === 'rejected') todo.push(`token: rejected by ${URL_BASE} (${t.why}). Tokens are per server: make one on this server and save it in ${tokenFile}.`);
    if (!existsSync(join(root, 'CHANGELOG.md'))) todo.push('changelog: there is no CHANGELOG.md. Change or remove `changelog:` and the Changelog section (e.g. if releases use GitHub\'s generated notes).');
    todo.push('conventions: the text after the frontmatter is the example\'s (modules, tags, images, changelog). Rewrite it for this repo.');
    const siblings = (() => {
      try {
        return readdirSync(dirname(root)).map((d) => join(dirname(root), d, '.dispatch.md')).filter((f) => f !== target && existsSync(f));
      } catch {
        return [];
      }
    })();
    if (siblings.length) todo.push(`house style: sibling repos have their own files; read them first:\n    ${siblings.join('\n    ')}`);
    console.log(`\nstill to do:\n${todo.map((x) => `- ${x}`).join('\n')}`);
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
    const imgs = (cid) => it.images.filter((i) => i.comment_id === cid).map((i) => `  [image ${i.id}] ${i.name} (${i.author})`);
    if (imgs(null).length) console.log(`\nimages (download with: images ${it.key}):\n${imgs(null).join('\n')}`);
    for (const c of it.comments) console.log(`\n— ${c.author}, ${c.created_at}\n${c.body_md}${imgs(c.id).length ? `\n${imgs(c.id).join('\n')}` : ''}`);
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
    if (typeof flags.images === 'string') await attach(it.id, list(flags.images));
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
    const c = await api('POST', `/items/${it.id}/comments`, { body_md: text, author: 'claude' });
    if (typeof flags.images === 'string') await attach(it.id, list(flags.images), c.id);
    console.log(`commented on ${it.key}`);
    break;
  }

  case 'attach': {
    const [key, ...files] = rest;
    if (!key || !files.length) die('attach KEY FILE [FILE...]');
    const it = await item(key);
    for (const img of await attach(it.id, files)) console.log(`${it.key}: image ${img.id} ${img.name}`);
    break;
  }

  case 'images': {
    const it = await item(rest[0] ?? die('images KEY [--save DIR]'));
    if (!it.images.length) {
      console.log(`${it.key} has no images`);
      break;
    }
    const dir = typeof flags.save === 'string' ? flags.save : join(tmpdir(), 'dispatch-images', it.key);
    mkdirSync(dir, { recursive: true });
    for (const img of it.images) {
      const res = await send(`${URL_BASE}${img.url}`, { headers: auth() }).catch((e) => die(e.message));
      if (!res.ok) die(`image ${img.id}: ${res.statusText}`);
      const file = join(dir, `${img.id}-${img.name.replace(/[^\w.-]+/g, '_')}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      console.log(`${file}${img.comment_id ? `  (on comment ${img.comment_id})` : ''}`);
    }
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
