-- The cost and time view (DISP-16) adds up sessions per project and per item, and each session's
-- run time from its turn results. Indexes only: nothing new is recorded.
CREATE INDEX sessions_project ON sessions(project_id);
CREATE INDEX session_items_item ON session_items(item_id);
-- one row per turn result, so the run-time sum does not read every event of a session
CREATE INDEX session_events_result ON session_events(session_id) WHERE json_extract(body, '$.kind') = 'result';
