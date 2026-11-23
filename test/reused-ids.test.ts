import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Db } from '../src/server/db.ts';
import { dbBeforeMigration, startServer } from './helpers.ts';

describe('deleted rows do not give their ids to new ones (DISP-238)', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    s = await startServer({ DATA_DIR: mkdtempSync(join(tmpdir(), 'dsp-ids-')) });
  });
  afterEach(() => s.app.close());

  const project = () => s.ctx.store.createProject({ key: 'ID', name: 'Ids', description: '', default_force_plan: false, importance_scale: ['a', 'b', 'c', 'd'], effort_scale: ['S'] });
  const newItem = (projectId: number, title: string) => s.ctx.store.createItem(projectId, { type: 'bug', title, body_md: '', status: 'backlog', importance: 2, effort: null, source_id: null, labels: [] });

  it('a repo, an item and an image made after deleting the newest one get new ids', () => {
    const p = project();
    const repo = s.ctx.store.addRepo(p.id, { github_owner: 'me', github_name: 'a', default_branch: 'main', check_command: null });
    s.ctx.store.deleteRepo(repo.id);
    expect(s.ctx.store.addRepo(p.id, { github_owner: 'me', github_name: 'b', default_branch: 'main', check_command: null }).id).toBeGreaterThan(repo.id);

    const item = newItem(p.id, 'old');
    const img = { item_id: item.id, comment_id: null, name: 'shot.png', file: 'x.png', mime: 'image/png', size: 1, author: 'me' };
    const image = s.ctx.store.addItemImage(img);
    s.ctx.store.deleteItemImage(image.id);
    expect(s.ctx.store.addItemImage(img).id).toBeGreaterThan(image.id);

    s.ctx.store.deleteItem(item.id);
    expect(newItem(p.id, 'new').id).toBeGreaterThan(item.id);
  });

  it("the Assistant's remove_repo retires a hosted repo, so the next hosted repo can be made", async () => {
    await s.call('POST', '/projects', { key: 'HA', name: 'Hosted' });
    const first = (await s.call('POST', '/projects/HA/repos', { hosted: { name: 'app' } })).data;
    expect(s.ctx.hosted.exists(first)).toBe(true);
    const chat = (await s.call('POST', '/assistant/messages', { text: 'remove the app repo' })).data;
    await s.ctx.sessions.assistantRpc!(s.ctx.store.session(chat.id)!, 'remove_repo', { project_key: 'HA', repo: `${first.github_owner}/${first.github_name}` });
    expect(s.ctx.store.repo(first.id)).toBeUndefined();
    expect(s.ctx.hosted.exists(first)).toBe(false);
    // the data stays on disk, renamed
    expect(readdirSync(s.ctx.hosted.root).some((f) => f.startsWith(`r${first.id}.deleted-`))).toBe(true);

    for (const name of ['app', 'other']) {
      const r = await s.call('POST', '/projects/HA/repos', { hosted: { name } });
      expect(r.status, name).toBe(200);
      expect(r.data.id).not.toBe(first.id);
      expect(existsSync(join(s.ctx.hosted.dir(r.data), 'hooks', 'pre-receive'))).toBe(true);
    }
  });
});

describe('053_autoincrement_ids on an existing database (DISP-238)', () => {
  it('keeps every row and its links, and stops handing out deleted ids', () => {
    const { file, raw } = dbBeforeMigration('053');
    raw.exec(`
      INSERT INTO projects (id, key, name, importance_scale, effort_scale) VALUES (1, 'OLD', 'Old', '["a"]', '["S"]');
      INSERT INTO repos (id, project_id, github_owner, github_name, kind) VALUES (7, 1, 'hosted', 'app', 'hosted');
      INSERT INTO items (id, project_id, number, type, title, status, modules) VALUES (3, 1, 1, 'bug', 'Kept', 'new', '["m"]');
      INSERT INTO item_images (id, item_id, name, file, mime, size, author) VALUES (5, 3, 'a.png', 'f.png', 'image/png', 1, 'me');
      INSERT INTO comments (id, item_id, author, body_md) VALUES (1, 3, 'me', 'hi');
    `);
    raw.close();
    const db = new Db(file);
    expect(db.get('SELECT github_name, kind FROM repos WHERE id = 7')).toEqual({ github_name: 'app', kind: 'hosted' });
    expect(db.get('SELECT title, modules FROM items WHERE id = 3')).toEqual({ title: 'Kept', modules: '["m"]' });
    expect(db.get('SELECT item_id, name FROM item_images WHERE id = 5')).toEqual({ item_id: 3, name: 'a.png' });
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    // the foreign keys still point at the rebuilt tables: deleting the item takes its comment and image
    db.run('DELETE FROM items WHERE id = 3');
    expect(db.get('SELECT count(*) AS n FROM comments')).toEqual({ n: 0 });
    expect(db.get('SELECT count(*) AS n FROM item_images')).toEqual({ n: 0 });
    db.run('DELETE FROM repos WHERE id = 7');
    expect(Number(db.run("INSERT INTO repos (project_id, github_owner, github_name) VALUES (1, 'me', 'b')").lastId)).toBe(8);
    expect(Number(db.run("INSERT INTO items (project_id, number, type, title, status) VALUES (1, 2, 'bug', 'New', 'new')").lastId)).toBe(4);
  });
});
