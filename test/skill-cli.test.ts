import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './helpers.ts';

const run = promisify(execFile);
const SCRIPT = resolve('skills/dispatch-backlog/scripts/dispatch.mjs');

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
      expect(missing).toContain(`put the API token from its Settings page in ${file}`);
      await run('mkdir', ['-p', join(home, '.config/dispatch/tokens')]);
      writeFileSync(file, `${authed.ctx.auth.apiToken}\n`);
      writeFileSync(join(home, '.config/dispatch/tokens/localhost_3000'), 'wrong-server-token\n');
      expect((await run(process.execPath, [SCRIPT, 'projects'], { cwd: home, env })).stdout).toBe('');
      expect((await run(process.execPath, [SCRIPT, 'config'], { cwd: home, env })).stdout).toContain(`token:    ${file}`);
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

  it('says plainly what is wrong', async () => {
    expect(await fails('add', '--title', 'x', '--effort', 'XXL')).toContain('effort "XXL" is not on the project\'s scale: XS, S, M, L, XL');
    expect(await fails('show', 'CLI-99')).toContain('Item not found');
    const noProject = await run(process.execPath, [SCRIPT, 'list'], { cwd: tmpdir(), env: { ...process.env, DISPATCH_URL: s.base, HOME: repo, DISPATCH_PROJECT: '' } }).then(() => '', (e) => String(e.stderr));
    expect(noProject).toContain('no project');
  });
});
