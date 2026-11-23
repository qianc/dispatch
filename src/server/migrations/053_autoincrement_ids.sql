-- DISP-238: a deleted repo, item or image never gives its id to a new row. Without AUTOINCREMENT
-- SQLite hands out the id of a deleted newest row again: a new hosted repo found the old one's
-- state, a replaced image kept the old picture's cached URL, old batch cards started a new item.
-- Rebuilt as they are, with AUTOINCREMENT (the runner turns foreign keys off for this).

CREATE TABLE repos_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  github_owner TEXT NOT NULL,
  github_name TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  check_command TEXT, local_path TEXT, worktree_from TEXT, setup_command TEXT, read_dirs TEXT, kind TEXT NOT NULL DEFAULT 'github', worker_id INTEGER REFERENCES workers(id), upstream_owner TEXT, upstream_name TEXT, deploy_command TEXT, generate_command TEXT, generated_paths TEXT,
  UNIQUE (project_id, github_owner, github_name)
);
INSERT INTO repos_new (id, project_id, github_owner, github_name, default_branch, check_command, local_path, worktree_from, setup_command, read_dirs, kind, worker_id, upstream_owner, upstream_name, deploy_command, generate_command, generated_paths)
  SELECT id, project_id, github_owner, github_name, default_branch, check_command, local_path, worktree_from, setup_command, read_dirs, kind, worker_id, upstream_owner, upstream_name, deploy_command, generate_command, generated_paths FROM repos;
DROP TABLE repos;
ALTER TABLE repos_new RENAME TO repos;

CREATE TABLE items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 2,
  effort INTEGER,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  labels TEXT NOT NULL DEFAULT '[]',
  marked INTEGER NOT NULL DEFAULT 0,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), modules TEXT NOT NULL DEFAULT '[]', done_at TEXT,
  UNIQUE (project_id, number)
);
INSERT INTO items_new (id, project_id, number, type, title, body_md, status, importance, effort, source_id, labels, marked, sort_order, created_at, updated_at, modules, done_at)
  SELECT id, project_id, number, type, title, body_md, status, importance, effort, source_id, labels, marked, sort_order, created_at, updated_at, modules, done_at FROM items;
DROP TABLE items;
ALTER TABLE items_new RENAME TO items;
CREATE INDEX items_source ON items(source_id);

CREATE TABLE item_images_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO item_images_new (id, item_id, comment_id, name, file, mime, size, author, created_at)
  SELECT id, item_id, comment_id, name, file, mime, size, author, created_at FROM item_images;
DROP TABLE item_images;
ALTER TABLE item_images_new RENAME TO item_images;
CREATE INDEX item_images_item ON item_images(item_id);
