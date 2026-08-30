-- Wiederkehrende Items: "Toilettenpapier alle 2 Wochen"
-- Ein täglicher Cron-Run prüft zuletzt_hinzugefuegt + intervall_tage
-- und fügt fällige Items über den DO-add-items-Pfad ein.
CREATE TABLE recurring_items (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  menge TEXT,
  intervall_tage INTEGER NOT NULL,
  zuletzt_hinzugefuegt INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX idx_recurring_list ON recurring_items(list_id);
