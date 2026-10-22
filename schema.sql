-- Play statistics (item 149). One row per cleaned play log line. Nothing identifies the sender.
CREATE TABLE IF NOT EXISTS lines (
  batch    TEXT    NOT NULL,   -- random per batch; a retried batch is not stored twice
  n        INTEGER NOT NULL,   -- the line's place in the batch
  received TEXT    NOT NULL,   -- when it arrived, cut to the hour
  line     TEXT    NOT NULL,   -- the cleaned play log line (JSON)
  PRIMARY KEY (batch, n)
);
CREATE INDEX IF NOT EXISTS lines_received ON lines (received);

-- The Realm's Call (item 173).
CREATE TABLE IF NOT EXISTS calls (
  id           TEXT PRIMARY KEY,
  title        TEXT    NOT NULL,
  story        TEXT    NOT NULL DEFAULT '',
  family       TEXT    NOT NULL DEFAULT '',   -- the monster family that counts ('' = every monster)
  goal         INTEGER NOT NULL,
  total        INTEGER NOT NULL DEFAULT 0,
  starts       TEXT    NOT NULL,              -- 2026-11-01T00:00:00Z
  ends         TEXT    NOT NULL,
  reward_gold  INTEGER NOT NULL DEFAULT 0,
  reward_title TEXT    NOT NULL DEFAULT '',
  min_kills    INTEGER NOT NULL DEFAULT 25,
  daily_cap    INTEGER NOT NULL DEFAULT 200
);
CREATE TABLE IF NOT EXISTS call_days (          -- one row per player per call per day (UTC); player is a hash of the phone's random key
  call   TEXT    NOT NULL,
  player TEXT    NOT NULL,
  day    TEXT    NOT NULL,
  kills  INTEGER NOT NULL,
  PRIMARY KEY (call, player, day)
);
CREATE TABLE IF NOT EXISTS call_claims (
  call   TEXT NOT NULL,
  player TEXT NOT NULL,
  PRIMARY KEY (call, player)
);
