-- Buylist: Dauerhaft gespeicherte Rezepte pro Liste

CREATE TABLE recipes (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  titel TEXT NOT NULL,
  zeit TEXT,
  portionen INTEGER NOT NULL DEFAULT 2,
  zutaten TEXT NOT NULL,
  schritte TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_recipes_list ON recipes(list_id);
