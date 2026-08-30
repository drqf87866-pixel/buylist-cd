-- Buylist: Tagesvorschläge – pro Nutzer und Tag 5 KI-Gerichte (ein JSON-Array)

CREATE TABLE daily_suggestions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  datum TEXT NOT NULL,
  vorschlaege TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, datum)
);

CREATE INDEX idx_daily_suggestions_datum ON daily_suggestions(datum);
