-- DISP-131: the folder linked files of a source are read from. Only the Assistant's markdown import
-- sets it (the folder of the imported file); a source title is free text and is never trusted as one.
ALTER TABLE sources ADD COLUMN base_dir TEXT;

-- sources imported before this column: the folder of their absolute title (what the file route used)
UPDATE sources SET base_dir = CASE
    WHEN rtrim(title, replace(title, '/', '')) = '/' THEN '/'
    ELSE rtrim(rtrim(title, replace(title, '/', '')), '/')
  END
WHERE kind = 'manual' AND title LIKE '/%';
