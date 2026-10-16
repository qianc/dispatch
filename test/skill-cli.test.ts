import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

  it('says plainly what is wrong', async () => {
    expect(await fails('add', '--title', 'x', '--effort', 'XXL')).toContain('effort "XXL" is not on the project\'s scale: XS, S, M, L, XL');
    expect(await fails('show', 'CLI-99')).toContain('Item not found');
    const noProject = await run(process.execPath, [SCRIPT, 'list'], { cwd: tmpdir(), env: { ...process.env, DISPATCH_URL: s.base, HOME: repo, DISPATCH_PROJECT: '' } }).then(() => '', (e) => String(e.stderr));
    expect(noProject).toContain('no project');
  });
});
