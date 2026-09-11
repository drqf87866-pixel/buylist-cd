-- 0012: E-Mail-Verifizierungsfeld für Account-Übernahme-Schutz (H5)
-- NULL = nie per Magic Link bestätigt; der erste Magic-Verify eines
-- passwortgeschützten Kontos bestätigt die Adresse und entzieht gleichzeitig
-- einem etwaigen Angreifer-Passwort die Grundlage (siehe auth.ts handleLogin).
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
