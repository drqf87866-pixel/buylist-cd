-- Buylist: Nutzer-Präferenzen (Diätform + Allergene) für personalisierte Rezept-Generierung

CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  diaet TEXT NOT NULL DEFAULT 'keine',
  allergene TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
