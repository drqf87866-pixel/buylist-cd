-- Buylist: Ernährungsziel (z. B. proteinreich) neben der Diätform,
-- kombinierbar – fließt in Vorschläge und Rezept-Generierung ein.

ALTER TABLE user_preferences ADD COLUMN ziel TEXT NOT NULL DEFAULT 'keine';
