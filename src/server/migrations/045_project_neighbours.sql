-- DISP-126: the projects this project's sessions may file items into (its neighbours), set by the
-- owner. One way: a row lets project_id's sessions write to neighbour_id, not the other way round.
CREATE TABLE project_neighbours (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  neighbour_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, neighbour_id)
);
