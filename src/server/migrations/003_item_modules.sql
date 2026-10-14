-- Items get modules (areas of the code/product) next to tags (stored in `labels`).
ALTER TABLE items ADD COLUMN modules TEXT NOT NULL DEFAULT '[]';
