import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './helpers.ts';

const run = promisify(execFile);
const SCRIPT = resolve('skills/dispatch-backlog/scripts/dispatch.mjs');
const EXAMPLE = resolve('skills/dispatch-backlog/dispatch.example.md');

describe('dispatch-backlog skill script', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let repo: string;
  const cli = async (...args: string[]) => {
    const { stdout } = await run(process.execPath, [SCRIPT, ...args], { cwd: join(repo, 'src'), env: { ...process.env, DISPATCH_URL: s.base, DISPATCH_TOKEN: '', HOME: repo } });
    return stdout.trim();
  };
  const fails = (...args: string[]) =>
    run(process.execPath, [SCRIPT, ...args], { cwd: repo, env: { ...process.env, DISPATCH_URL: s.base, HOME: repo } }).then(() => '', (e) => String(e.stderr));

  beforeAll(async () => {
    s = await startServer();
    await s.call('POST', '/projects', { key: 'CLI', name: 'Cli', effort_scale: ['XS', 'S', 'M', 'L', 'XL'] });
    repo = mkdtempSync(join(tmpdir(), 'dsp-skill-'));
    // config at the repo root; the script runs from a subfolder
    writeFileSync(join(repo, '.dispatch.md'), '---\nproject: cli\nchangelog: CHANGELOG.md\nrelease_label_prefix: "rel:"\n---\n\nTitles are short.\n');
    await run('mkdir', ['-p', join(repo, 'src')]);
  });
  afterAll(() => s.app.close());

  it('reads the project and its conventions from .dispatch.md', async () => {
    const out = await cli('config');
    expect(out).toContain('project:  CLI');
    expect(out).toContain('changelog:CHANGELOG.md');
    expect(out).toContain('Titles are short.');
    expect(await cli('scales')).toContain('1=Low, 2=Medium, 3=High, 4=Critical');
  });

  it('adds, lists, updates, comments, parks and releases items', async () => {
    writeFileSync(join(repo, 'body.md'), 'Seen on **big** decks.\n');
    const key = await cli('add', '--type', 'bug', '--title', 'Legend overlaps the axis', '--importance', 'high', '--effort', 'S', '--tags', 'layout', '--modules', 'charts', '--body-file', join(repo, 'body.md'));
    expect(key).toBe('CLI-1');
    const item = (await s.call('GET', '/items/by-key/CLI-1')).data;
    expect(item).toMatchObject({ type: 'bug', importance: 3, effort: 1, labels: ['layout'], modules: ['charts'], body_md: 'Seen on **big** decks.\n' });

    await cli('add', '--title', 'Export as SVG', '--importance', '2');
    expect(await cli('list')).toMatch(/CLI-1 .*High S bug {2}Legend overlaps the axis {2}\[charts\] #layout/);
    expect(await cli('list', '--q', 'svg')).toContain('(1 item)');
    expect(await cli('list', '--tag', 'LAYOUT')).toContain('CLI-1');

    await cli('update', 'CLI-1', '--add-tags', 'regression', '--remove-tags', 'layout', '--importance', 'Critical');
    expect((await s.call('GET', '/items/by-key/CLI-1')).data).toMatchObject({ labels: ['regression'], importance: 4 });

    await cli('comment', 'CLI-1', 'Found', 'the', 'cause');
    expect(await cli('show', 'CLI-1')).toMatch(/— claude, .*\nFound the cause/);

    await cli('status', 'hold', 'CLI-2');
    expect(await cli('list')).not.toContain('CLI-2');
    expect(await cli('facets')).toContain('regression (1)');

    await cli('status', 'done', 'CLI-1', 'CLI-2');
    expect(await cli('unreleased')).toContain('(2 done items not in a release yet)');
    await cli('release', 'v1.0.0', '--unreleased');
    expect(await cli('unreleased')).toContain('(0 done items');
    expect(await cli('list', '--status', 'done', '--tag', 'rel:v1.0.0')).toContain('(2 items)');
  });

  it('keeps retros as sources with their items', async () => {
    writeFileSync(join(repo, 'retro.md'), '# Retro\n\n- fonts wrong\n');
    const id = await cli('source', 'add', '--kind', 'retro', '--title', 'Run retro', '--reporter', 'alex', '--version', 'v6.4.1', '--body-file', join(repo, 'retro.md'));
    await cli('add', '--source', id, '--title', 'Fonts wrong in Edge');
    const out = await cli('source', 'show', id);
    expect(out).toContain('source #1 retro: Run retro');
    expect(out).toContain('alex · v6.4.1');
    expect(out).toContain('Fonts wrong in Edge');
  });

  it('reads the token for this server from its own file', async () => {
    const authed = await startServer({ DISABLE_AUTH: '' , APP_PASSWORD: 'pw' });
    try {
      const home = mkdtempSync(join(tmpdir(), 'dsp-home-'));
      const env = { ...process.env, DISPATCH_URL: authed.base, DISPATCH_TOKEN: '', HOME: home };
      const missing = await run(process.execPath, [SCRIPT, 'projects'], { cwd: home, env }).then(() => '', (e) => String(e.stderr));
      const file = join(home, '.config/dispatch/tokens', `127.0.0.1_${authed.port}`);
      expect(missing).toContain(`make a token in Dispatch → Settings → Tokens (scope "tracker") and put it in ${file}`);
      await run('mkdir', ['-p', join(home, '.config/dispatch/tokens')]);
      writeFileSync(file, `${authed.ctx.access.createToken('skill', ['tracker', 'read'], null).secret}\n`);
      writeFileSync(join(home, '.config/dispatch/tokens/localhost_3000'), 'wrong-server-token\n');
      expect((await run(process.execPath, [SCRIPT, 'projects'], { cwd: home, env })).stdout).toBe('');
      expect((await run(process.execPath, [SCRIPT, 'config'], { cwd: home, env })).stdout).toContain(`token:    valid (${file})`);
      writeFileSync(file, 'not-a-token\n');
      expect((await run(process.execPath, [SCRIPT, 'config'], { cwd: home, env })).stdout).toContain(`token:    rejected (${file}): the server answered 401`);
      const none = mkdtempSync(join(tmpdir(), 'dsp-home-'));
      expect((await run(process.execPath, [SCRIPT, 'config'], { cwd: none, env: { ...env, HOME: none } })).stdout).toContain('token:    missing (expected in');
    } finally {
      await authed.app.close();
    }
  });

  it('attaches images to items and comments, and downloads them for reading', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    writeFileSync(join(repo, 'wrong.png'), png);
    writeFileSync(join(repo, 'after.png'), png);
    writeFileSync(join(repo, 'notes.txt'), 'not an image');
    const key = await cli('add', '--title', 'Legend in the wrong place', '--images', join(repo, 'wrong.png'));
    await cli('comment', key, 'Fixed', '--images', join(repo, 'after.png'));
    expect(await cli('attach', key, join(repo, 'wrong.png'))).toMatch(new RegExp(`^${key}: image \\d+ wrong.png$`));
    const shown = await cli('show', key);
    expect(shown).toMatch(/images \(download with: images CLI-\d+\):\n {2}\[image \d+\] wrong.png \(claude\)/);
    expect(shown).toMatch(/— claude, .*\nFixed\n {2}\[image \d+\] after.png \(claude\)/);

    const out = join(repo, 'downloaded');
    const paths = (await cli('images', key, '--save', out)).split('\n');
    expect(paths).toHaveLength(3);
    expect(paths[1]).toMatch(/after.png {2}\(on comment \d+\)$/);
    expect(readFileSync(paths[0])).toEqual(png);

    expect(await fails('attach', key, join(repo, 'notes.txt'))).toContain('notes.txt: Only PNG, JPEG, GIF and WebP images can be attached.');
    expect(await cli('config')).toContain('images:   when_possible (default)');
  });

  const runIn = (cwd: string, env: Record<string, string>, ...args: string[]) =>
    run(process.execPath, [SCRIPT, ...args], { cwd, env: { ...process.env, DISPATCH_TOKEN: '', ...env } }).then(
      (r) => ({ out: r.stdout, err: r.stderr, ok: true }),
      (e) => ({ out: String(e.stdout), err: String(e.stderr), ok: false }),
    );

  it('reads a copied example as meant, with # comments stripped from values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsp-example-'));
    copyFileSync(EXAMPLE, join(dir, '.dispatch.md'));
    const { out } = await runIn(dir, { DISPATCH_URL: s.base, HOME: dir }, 'config');
    expect(out).toContain('project:  HC\n');
    expect(out).toContain('changelog:CHANGELOG.md\n');
    expect(out).toContain('release_label_prefix:rel:\n');
    expect(out).toContain('images:   when_possible\n');

    writeFileSync(join(dir, '.dispatch.md'), '---\nproject: hc   # the key\nimages: off # for now\nrelease_label_prefix: "rel#" # quoted\nurl: http://x.test/a#b\n---\n');
    const { out: commented } = await runIn(dir, { DISPATCH_URL: s.base, HOME: dir }, 'config');
    expect(commented).toContain('project:  HC\n');
    expect(commented).toContain('images:   off\n');
    expect(commented).toContain('release_label_prefix:rel#\n');
    expect(commented).toContain('overrides url: http://x.test/a#b in .dispatch.md');
  });

  it('says when DISPATCH_URL overrides the url: in .dispatch.md', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsp-url-'));
    writeFileSync(join(dir, '.dispatch.md'), `---\nproject: cli\nurl: ${s.base}/\n---\n`);
    expect((await runIn(dir, { DISPATCH_URL: s.base, HOME: dir }, 'config')).out).toContain(`server:   ${s.base} (from DISPATCH_URL)\n`);
    expect((await runIn(dir, { DISPATCH_URL: '', HOME: dir }, 'config')).out).toContain(`server:   ${s.base} (from .dispatch.md)\n`);
    writeFileSync(join(dir, '.dispatch.md'), '---\nproject: cli\nurl: https://dispatch.example.test\n---\n');
    expect((await runIn(dir, { DISPATCH_URL: s.base, HOME: dir }, 'config')).out).toContain(
      `server:   ${s.base} (from DISPATCH_URL, overrides url: https://dispatch.example.test in .dispatch.md)`,
    );
  });

  it('names a login proxy when the API redirects', async () => {
    const proxy = createServer((_req, res) => res.writeHead(302, { location: 'https://auth.example.test/login?rd=x' }).end());
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    try {
      const dir = mkdtempSync(join(tmpdir(), 'dsp-proxy-'));
      const res = await runIn(dir, { DISPATCH_URL: base, HOME: dir }, 'projects');
      expect(res.ok).toBe(false);
      expect(res.err).toContain(`redirected to auth.example.test: a login proxy is in front of the API at ${base}. Is the token valid for this host?`);
      const cfgOut = (await runIn(dir, { DISPATCH_URL: base, HOME: dir, DISPATCH_TOKEN: 'lan-token' }, 'config')).out;
      expect(cfgOut).toContain('token:    rejected (from DISPATCH_TOKEN): redirected to auth.example.test');
    } finally {
      proxy.close();
    }
  });

  it('init lists the projects, suggests a match, and writes .dispatch.md once', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'dsp-init-')), 'cli');
    const sibling = join(root, '..', 'other');
    await run('mkdir', ['-p', root, sibling]);
    writeFileSync(join(sibling, '.dispatch.md'), '---\nproject: oth\n---\n');
    const env = { DISPATCH_URL: s.base, HOME: root };

    const ask = await runIn(root, env, 'init');
    expect(ask.ok).toBe(false);
    expect(ask.out).toMatch(/projects:\n {2}CLI +Cli/);
    expect(ask.err).toContain('project CLI matches the folder name "cli". If that is the one, run: dispatch init --project CLI');
    expect(existsSync(join(root, '.dispatch.md'))).toBe(false);

    const unknown = await runIn(root, env, 'init', '--project', 'NOPE');
    expect(unknown.err).toContain('there is no project NOPE');
    expect(unknown.err).toContain('This script cannot create projects');

    const done = await runIn(root, env, 'init', '--project', 'cli', '--url', s.base);
    expect(done.ok).toBe(true);
    expect(done.out).toContain(`wrote ${join(root, '.dispatch.md')} for CLI (Cli)`);
    expect(done.out).toContain('token: none for this server');
    expect(done.out).toContain('changelog: there is no CHANGELOG.md');
    expect(done.out).toContain(join(sibling, '.dispatch.md'));
    const written = readFileSync(join(root, '.dispatch.md'), 'utf8');
    expect(written).toMatch(/^---\nproject: CLI\nurl: http:\/\/127\.0\.0\.1:\d+\nchangelog: CHANGELOG.md\n/);
    const cfgOut = (await runIn(root, { ...env, DISPATCH_URL: '' }, 'config')).out;
    expect(cfgOut).toContain('project:  CLI\n');
    expect(cfgOut).toContain(`server:   ${s.base} (from .dispatch.md)`);

    const again = await runIn(root, env, 'init', '--project', 'CLI');
    expect(again.err).toContain('already exists');
    expect(readFileSync(join(root, '.dispatch.md'), 'utf8')).toBe(written);
  });

  it('says plainly what is wrong', async () => {
    expect(await fails('add', '--title', 'x', '--effort', 'XXL')).toContain('effort "XXL" is not on the project\'s scale: XS, S, M, L, XL');
    expect(await fails('show', 'CLI-99')).toContain('Item not found');
    const noProject = await run(process.execPath, [SCRIPT, 'list'], { cwd: tmpdir(), env: { ...process.env, DISPATCH_URL: s.base, HOME: repo, DISPATCH_PROJECT: '' } }).then(() => '', (e) => String(e.stderr));
    expect(noProject).toContain('no project');
  });
});
