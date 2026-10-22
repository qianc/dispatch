-- How far the owner has read a chat (assistant): the last session_events.seq seen. Newer replies
-- count as unread (the badge on the Assistant menu).
ALTER TABLE sessions ADD COLUMN read_seq INTEGER NOT NULL DEFAULT 0;
