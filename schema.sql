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

-- Friends (item 174). The player is a SHA-256 hash of a random per-install key (a different salt from the Realm's Call).
CREATE TABLE IF NOT EXISTS friend_profiles (    -- what friends may see: the hero's display name, class, race, level and season score
  player  TEXT PRIMARY KEY,
  code    TEXT NOT NULL UNIQUE,                 -- the friend code (8 letters and digits, no I, O, 0 or 1)
  name    TEXT NOT NULL,
  cls     TEXT NOT NULL,
  race    TEXT NOT NULL,
  level   INTEGER NOT NULL,
  score   INTEGER NOT NULL,
  updated TEXT NOT NULL                         -- the day (UTC)
);
CREATE TABLE IF NOT EXISTS friendships (        -- one row per pair: who asked, who was asked, pending or accepted
  requester TEXT NOT NULL,
  target    TEXT NOT NULL,
  status    TEXT NOT NULL,
  created   TEXT NOT NULL,
  PRIMARY KEY (requester, target)
);
CREATE TABLE IF NOT EXISTS friend_blocks (
  blocker TEXT NOT NULL,
  blocked TEXT NOT NULL,
  PRIMARY KEY (blocker, blocked)
);
CREATE TABLE IF NOT EXISTS friend_reports (     -- reports of a name or a player, for the owner to look at
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter TEXT NOT NULL,
  reported TEXT NOT NULL,
  code     TEXT NOT NULL,
  name     TEXT NOT NULL,
  reason   TEXT NOT NULL,
  created  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS friend_limits (      -- per player per day counters (adds, reports)
  player TEXT NOT NULL,
  day    TEXT NOT NULL,
  kind   TEXT NOT NULL,
  n      INTEGER NOT NULL,
  PRIMARY KEY (player, day, kind)
);
