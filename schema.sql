-- Play statistics (item 149). One row per cleaned play log line. Nothing identifies the sender.
CREATE TABLE IF NOT EXISTS lines (
  batch    TEXT    NOT NULL,   -- random per batch; a retried batch is not stored twice
  n        INTEGER NOT NULL,   -- the line's place in the batch
  received TEXT    NOT NULL,   -- when it arrived, cut to the hour
  line     TEXT    NOT NULL,   -- the cleaned play log line (JSON)
  PRIMARY KEY (batch, n)
);
CREATE INDEX IF NOT EXISTS lines_received ON lines (received);
