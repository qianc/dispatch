-- Push subscriptions belong to a person (DISP-65): a session's notices go to its starter. Rows from
-- before are the install owner's: their name is on record once Users.claim has run (installs from
-- before users have no record yet; claim gives those rows to the owner as it does the other tables).
ALTER TABLE push_subscriptions ADD COLUMN user TEXT;
UPDATE push_subscriptions SET user = (SELECT value FROM settings WHERE key = 'install_owner');
CREATE INDEX push_subscriptions_user ON push_subscriptions(user);
