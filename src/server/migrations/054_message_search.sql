-- DISP-244: Activity search matched chat messages with LIKE over every event (a full scan that
-- blocked the server) and LIKE folds ASCII case only ('Åtgärd' did not match 'åtgärd'). The text of
-- the owner's and Claude's messages goes into a full-text index (rowid = session_events.id), filled
-- by Store.addEvent; session_id is indexed so one chat's matches are found without a scan.
-- unicode61 folds case for all letters; diacritics are kept so å, ä, ö stay apart.
CREATE VIRTUAL TABLE session_event_text USING fts5(text, session_id, tokenize = 'unicode61 remove_diacritics 0');
INSERT INTO session_event_text (rowid, text, session_id)
  SELECT id, json_extract(body, '$.text'), session_id FROM session_events
  WHERE json_extract(body, '$.kind') IN ('user', 'assistant') AND json_extract(body, '$.text') IS NOT NULL;
-- events go when their session does (cascades fire triggers too)
CREATE TRIGGER session_event_text_delete AFTER DELETE ON session_events BEGIN
  DELETE FROM session_event_text WHERE rowid = old.id;
END;
-- the search lists newest first
CREATE INDEX sessions_updated ON sessions(updated_at);
