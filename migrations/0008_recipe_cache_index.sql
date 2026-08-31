-- Buylist: Index für die tägliche recipe_cache-Bereinigung
-- (runRecipeCacheCleanup löscht per created_at; ohne Index wäre das ein
-- Volltabellen-Scan auf der unbegrenzt wachsenden Cache-Tabelle).

CREATE INDEX idx_recipe_cache_created_at ON recipe_cache(created_at);
