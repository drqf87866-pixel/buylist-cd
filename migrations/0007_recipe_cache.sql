-- Globaler Cache generierter "Gericht"-Rezepte (nicht für den
-- Resteverwertungs-/Zutaten-Modus). Key = SHA-256 aus Gericht + Portionen +
-- Diät + Allergene + CACHE_VERSION (src/recipes.ts) – kein TTL, Invalidierung
-- nur durch Hochzählen von CACHE_VERSION bei inhaltlichen Prompt-Änderungen.
CREATE TABLE recipe_cache (
  cache_key TEXT PRIMARY KEY,
  rezept TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
