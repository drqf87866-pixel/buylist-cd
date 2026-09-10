-- Buylist: Einmal-Tokens für den Magic-Link-Login per E-Mail (Resend).
-- Gespeichert wird nur der SHA-256-Hash des Tokens, nicht der Klartext.
-- user_id ist NULL, solange sich die E-Mail noch nie registriert hat; beim
-- ersten erfolgreichen Verify wird der Nutzer angelegt und die Spalte gefüllt.

CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_magic_links_email ON magic_links(email);
CREATE INDEX idx_magic_links_expires ON magic_links(expires_at);
