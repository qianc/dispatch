-- Images on items (screenshots, example output), optionally on one of the item's comments.
CREATE TABLE item_images (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX item_images_item ON item_images(item_id);
