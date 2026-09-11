# Code-Review buylist-cd (Stand `612d531`, main)

Stand: 2026-09-11 · Prüfumfang: gesamter Projektordner.

## Umfang

Gelesen wurden alle Backend-Module
(`src/**`, inkl. Durable Objects), alle Migrationen, `wrangler.jsonc`, CI, der Service
Worker, `app-core.mjs` und `app.js` vollständig, dazu die Tests. `npm run typecheck`
läuft sauber, `npm test` meldet 59/59 grün.

Unten stehen die Befunde nach Schwere, danach ein Vorschlag, in welchen Paketen man sie
umsetzt. Paket D braucht zuerst eine Produktentscheidung.

**Was gut ist:** Die Auth-Kette (`withAuth` → `checkListAccess` → 404 statt 403) ist
konsistent. Session- und Magic-Tokens liegen nur gehasht in der DB. Die Owner-Erbfolge
beim Verlassen läuft atomar per Subquery. Eingaben werden an der Kante gekürzt. Das
Frontend baut das DOM ohne `innerHTML`, dadurch gibt es praktisch keine XSS-Fläche. Die
Push-Krypto ist gegen Testvektoren geprüft.

---

## Hoch

**H1 – Rate-Limit für Magic Links wirkt nicht** · `src/magic-link.ts:91-111`
Der Zähler zählt Links der letzten 5 Minuten. Zeile 102 löscht aber vor jedem Insert alle
unbenutzten Links dieser Adresse, also liegt immer höchstens ein Treffer im Fenster.
→ Man kann einer beliebigen Adresse unbegrenzt Login-Mails schicken (Mail-Bombing,
Resend-Kontingent, Ruf der Absender-Domain). Eine Grenze pro IP gibt es gar nicht.
Fix: Alte Links entwerten statt löschen (`UPDATE … SET used_at = ? WHERE email = ? AND used_at IS NULL`),
dann bleiben sie zählbar. Zusätzlich `RATE_LIMITER_DO` mit dem Schlüssel `magic-ip:<CF-Connecting-IP>`.

**H2 – Entfernte oder ausgetretene Mitglieder behalten den Live-Zugriff** · `src/members.ts:69,136`, `src/do/shopping-list.ts`
`handleRemoveMember` und `handleLeaveList` fassen nur D1 an. Der offene WebSocket bleibt
bestehen (Hibernation und Ping-Auto-Response halten ihn am Leben), und das DO prüft
nichts. Die Person liest und schreibt also weiter. Zusätzlich lässt sich das
Invite-Token nicht rotieren: Mit dem alten Link tritt sie sofort wieder bei.
Fix: Neuer interner DO-Endpunkt `/kick {userId}`. Er schließt alle Sockets, deren
Attachment diese `userId` trägt, und schickt vorher `{type:"removed"}`. Der Worker ruft
ihn nach Remove und Leave auf (gleiches Muster wie `destroyListDoState`). Beim Entfernen
wird außerdem `invite_token` neu erzeugt.

**H3 – Bildgenerierung: Kostenmissbrauch und dauerhaft hängender Status** · `src/recipes.ts`
- Der Limiter (`:306-308`) läuft ohne `?max=` und damit auf dem Default 12/min. Jeder
  registrierte Nutzer (die Registrierung ist offen) kann per `POST /recipes` beliebige
  Rezepte anlegen und für jedes `…/bild` auslösen. Das sind bis zu ~12 bezahlte Bilder
  pro Minute.
- `:1008-1019` prüft erst und setzt dann, beides nicht atomar. Zwei Klicks erzeugen
  zwei bezahlte Bilder.
- Bricht die Ausführung zwischen `pending` und dem Abschluss ab (Client trennt die
  Verbindung, DB-Fehler), bleibt `pending` für immer stehen. Ein neuer Versuch gibt
  dann dauerhaft 409. Der Auto-Pfad läuft in `waitUntil` (Limit 30 s) mit einem
  60-s-Timeout (`:237`, `:777`) und bleibt so sogar planmäßig hängen.
Fix: Atomar per `UPDATE … SET bild_status='pending', bild_gestartet_am=? WHERE … AND (bild_status IS NULL OR 'fehler' OR pending älter als 3 min)`
setzen und `meta.changes` prüfen. Der Limiter bekommt `?max=3` plus einen Tagesdeckel
pro Nutzer (Limiter-Schlüssel `img:<userId>`, dafür bekommt der `RateLimiterDO` einen
`?window=`-Parameter). Der Auto-Pfad bekommt einen Timeout unter 30 s. Der Retry-Handler
nutzt `generateRecipeImage` wieder, statt den Upload-Block zu duplizieren.

**H4 – Veraltete asynchrone Renders: die Add-Bar kann in die falsche Liste schreiben** · `public/app.js:2709/3849-3884`, `3894-4198`, `4302-4315`
`renderList`, `renderEinkauf` und `renderCook` warten auf Requests und setzen danach
globale Variablen (`listConn`, `currentListId`, `einkaufConns`, `cookCleanup`) bzw.
tauschen `$app` aus. Das passiert auch dann, wenn inzwischen eine andere Route aktiv
ist. Szenario im Mobilnetz: Liste A öffnen, per Switcher zu B wechseln, A's Snapshot
kommt später an. Dann ist `listConn` der Socket von A, die Add-Bar in B schreibt nach A,
der Socket von B leckt samt Reconnect-Schleife, und Undo verweigert. `renderCook` kann
eine längst verlassene Kochansicht über die aktuelle Seite legen.
Zusätzlich plant `openListSocket` (`:4259-4268`) nach `close()` über den Snapshot-Zweig
trotzdem neu bzw. navigiert weg.
Fix: Einen Render-Token einführen (`let renderSeq = 0`; `render()` zählt hoch; jeder
async-Renderer prüft nach jedem `await`, ob er noch aktuell ist). In `onclose` vor
`scheduleReconnect` und `navigate` auf `closedByUs` prüfen.

**H5 – Account-Übernahme per Vorab-Registrierung** · `src/auth.ts:28-60` + `src/magic-link.ts:167-175`
Die Registrierung prüft die E-Mail-Adresse nicht. Ein Angreifer registriert die Adresse
des Opfers mit eigenem Passwort. Meldet sich das Opfer später per Magic Link an, landet
es in genau diesem Konto, und der Angreifer kommt per Passwort weiter hinein und liest
alle Listen mit.
Fix: Migration 0012 mit `users.email_verified_at`. Beim ersten Magic-Verify eines
unverifizierten Kontos mit Passwort-Hash wird das Passwort verworfen (Sentinel), alle
anderen Sessions werden gelöscht und `email_verified_at` gesetzt.

## Mittel

**M1 – Kein Schutz gegen Brute-Force beim Login** · `src/auth.ts:62-78`
Es gibt kein Limit. PBKDF2 läuft nur, wenn der Nutzer existiert, dadurch lassen sich
Konten über die Antwortzeit erkennen.
Fix: `RATE_LIMITER_DO` mit den Schlüsseln `login:<email>` und `login-ip:<ip>`; bei
unbekanntem Nutzer gegen einen Dummy-Hash prüfen.

**M2 – Offline-Änderungen gehen still verloren** · `app.js:2511,2575,2584,3517,3591,3997`
`send()` verwirft Nachrichten, solange der Socket nicht OPEN ist. Die UI zeigt den
optimistischen Zustand trotzdem an, und der nächste Sync nach dem Reconnect setzt ihn
zurück. Das trifft genau den Hauptfall „im Laden mit schlechtem Empfang“.
Fix: Eine Outbox in `openListSocket`, die bei `onopen` geleert wird. Das ist unkritisch,
weil toggle, delete, setMarkt und setMenge absolute bzw. idempotente Werte senden. Für
`add` bleibt die heutige Sperre.

**M3 – Magic Link per GET einlösen** · `src/magic-link.ts:125-165`
Link-Scanner in Mailprogrammen (Outlook Safe Links, Defender) rufen den Link vorab auf.
Dann ist der Token verbraucht, und das Opfer sieht „verbraucht“. Zusätzlich ist
Login-CSRF möglich.
Fix: Der GET-Aufruf liefert nur die SPA-Route `/magic/bestaetigen?token=…` mit einem
Button, erst der POST löst den Token ein.

**M4 – Push: Nutzer wird über eigene Aktionen benachrichtigt, Benachrichtigungsflut, Logout** · `do/shopping-list.ts:182,251,292`, `sw.js:96`, `app.js:2078`
- Die REST-Pfade (add-items, add-gerichte, remove-gericht) übergeben
  `triggerUserId = null`, also bekommt der Auslöser einen Push über seine eigene Aktion.
- Jeder einzelne Haken schickt allen anderen einen Push, beim Einkaufen also Dutzende.
- Logout meldet die Push-Subscription nicht ab. Auf geteilten Geräten kommen weiter die
  Listeninhalte des vorherigen Kontos an.
Fix: `userId` in den DO-Bodys mitgeben. `tag: "list-<id>"` plus `renotify: false` im SW,
damit sich Benachrichtigungen einer Liste zusammenfassen. Logout ruft vorher
`unsubscribe` auf.

**M5 – Ein einzelner Nutzer kann das KI-Kontingent aller aufbrauchen** · `recipes.ts:630`, `parse.ts:222`, `suggestions.ts:143,237`
Es gibt nur globale Limiter, und die Registrierung ist offen. Der Cron erzeugt außerdem
täglich Vorschläge für alle Nutzer, auch für inaktive.
Fix: Einen Limiter pro Nutzer (`gemini:<userId>`, `?max=4`) vor dem globalen prüfen. Der
Cron läuft nur für Nutzer mit einer Session in den letzten 14 Tagen.

**M6 – Verwaiste Auto-Listen und doppelte Rezepte** · `app.js:1849-1853`, `1062-1066`, `1879-1887`
Wird das Sheet geschlossen, während `POST /api/lists` noch läuft, kehrt der Code vor der
Zuweisung von `newListId` zurück. Die Liste wird nie gelöscht. Gelingt „Speichern“ und
scheitert danach das „Zuschalten“, legt ein erneuter Klick das Rezept doppelt an.
Fix: Erst die ID merken, dann prüfen, ob das Sheet noch offen ist, und aufräumen. Nach
erfolgreichem Speichern beim erneuten Versuch nur noch das Zuschalten wiederholen.

**M7 – Keine Security-Header** · `public/_headers`
Es fehlen CSP, `frame-ancestors`/X-Frame-Options (Clickjacking auf „Liste löschen“),
`X-Content-Type-Options` und `Referrer-Policy`. Weil die App keine Inline-Skripte hat,
ist `script-src 'self'` direkt möglich. Außerdem prüft der WebSocket-Upgrade den
`Origin`-Header nicht (`src/index.ts:171`); SameSite=Lax mildert das, als zusätzliche
Absicherung lohnt die Prüfung trotzdem.

## Niedrig

- **N1** `util.ts:24-32` `readJson` begrenzt nur über `content-length`; Bodys mit chunked encoding sind unbegrenzt → per `text()` mit Längenprüfung lesen.
- **N2** `do/shopping-list.ts:376-393` Die Nachricht `null` bzw. eine Zahl wirft einen TypeError. Es gibt kein Item-Limit pro Liste; ein Mitglied kann den Blob über das Wertelimit des DO-Storage fluten und die Liste damit unbrauchbar machen → Objekt prüfen, `MAX_ITEMS` z. B. 500.
- **N3** `src/index.ts:44-46` Cron-Schritte sind nicht voneinander isoliert: Ein Fehler in `runRecurringCron` verhindert Vorschläge und Cache-Cleanup → jeden Schritt in eigenes try/catch.
- **N4** Abgelaufene Sessions werden nie aufgeräumt (`session.ts`) → im Cron `DELETE FROM sessions WHERE expires_at < ?`.
- **N5** `app.js:3824-3828` `reconcilePending` nutzt `trim().toLowerCase()` statt `normKey` (verstößt gegen die AGENTS-Regel). Dadurch bleiben „Geister-Pending“-Einträge stehen.
- **N6** `app.js:1220,1397` `onConfirm` beim Löschen eines Rezepts hat kein try/catch → unbehandelte Rejection, kein Toast.
- **N7** `push.ts:151,158-160` Beliebige `https://`-Endpoints werden akzeptiert (der Worker POSTet dann an fremde Hosts), und `ON CONFLICT` hängt fremde Endpoints um → Allowlist bekannter Push-Dienste.
- **N8** `members.ts:21-38` Jedes Mitglied sieht die E-Mail-Adressen aller anderen → nur für den Owner ausliefern.
- **N9** `push.ts:27-58` Der VAPID-Key wird pro Subscription neu importiert und signiert → pro Aufruf cachen.
- **N10** Tote bzw. veraltete Stellen: `recipes.ts:27-29` und `0007` sprechen von „kein TTL“, es gibt aber einen 90-Tage-Cleanup; `0010` behauptet, `user_id` werde gefüllt, das passiert nie; `app.js:495` (`on` ungenutzt), `:1870` (redundanter Ternary), `:1428-1431` (ungenutzte Parameter, doppelter Toast); `label for="prefs-allergene"` hat kein passendes `id` (a11y, `:2184`).

## Aufräumen / Wiederverwendung

- Der Rate-Limit-Check samt 429-Antwort steht dreimal (`recipes.ts:630`, `parse.ts:222`, `suggestions.ts:143`) → ein Helper `checkLimit(env, key, max, window?)` in `src/do/rate-limiter.ts`. Der wird auch für H1, H3, M1 und M5 gebraucht.
- `sanitizeKategorie` gibt es identisch in `recipes.ts` und `parse.ts`; `secureFlag` und `EMAIL_RE` doppelt in `auth.ts` und `magic-link.ts`; die Allergen-Bereinigung doppelt in `preferences.ts`.
- `realtime-test.mjs:257` übergibt eine E-Mail als `userId`; der Test besteht nur, weil die 403 vorher greift. Nicht abgedeckt sind: Kick/Leave samt Socket, Nachfolger-Owner, Recurring und die Bild-Route.

---

## Vorschlag zur Umsetzung

**Paket A – Sicherheit Backend** (H1, H2, H3, H5, M1, M5)
- `migrations/0012_verify_und_bildstart.sql`: `users.email_verified_at`, `recipes.bild_gestartet_am`
- `src/do/rate-limiter.ts`: `?window=`-Parameter und Helper `checkLimit()`; die drei bestehenden Aufrufer umstellen
- `src/magic-link.ts`: entwerten statt löschen, IP-Limit, Verify-Logik aus H5
- `src/auth.ts`: Login-Limit, Dummy-Verify
- `src/do/shopping-list.ts`: `/kick`; `src/members.ts`: Aufruf nach Remove/Leave und Invite-Rotation
- `src/recipes.ts`: atomarer Claim, Limits, Retry über `generateRecipeImage`, Auto-Timeout unter 30 s
- `src/suggestions.ts`: Limit pro Nutzer, Cron nur für aktive Nutzer

**Paket B – Frontend-Robustheit** (H4, M2, M6, N5, N6, M4-Logout)
- `public/app.js`: Render-Token, `closedByUs`-Guard, Outbox, Aufräumen der Auto-Listen, `normKey`, Fehler-Toasts, Push-Abmeldung beim Logout; neue `removed`-Nachricht aus H2 behandeln

**Paket C – Hygiene** (M4-Rest, M7, N1–N4, N7–N10, Duplikate) – bei Bedarf danach.

**Paket D – Produktentscheidung nötig, nicht in A/B:**
- Rezepte hängen per `ON DELETE CASCADE` an Listen (`0002`). Weil der Koch-Assistent pro Rezept eine Auto-Liste anlegt, löscht das Aufräumen dieser (meist leeren) Listen die gespeicherten Rezepte gleich mit. Die Minimallösung ist ein Warnhinweis mit Rezeptanzahl im Löschen-Dialog; richtig wäre, Rezepte vom Nutzer statt von der Liste abhängen zu lassen.
- M3 (Bestätigungsseite für den Magic Link) ändert den Login-Ablauf.

README (API-Tabelle, Setup) wird im selben Durchgang angepasst, wie es AGENTS.md verlangt.

## Verifikation

1. `npm run typecheck` und `npm test`. Neue Unit-Tests für `limiterMaxFromUrl`/window und die Claim-Logik, die als reine Funktion herausgelöst wird.
2. `npm run db:migrate:local` und `npm run dev`, dann `node scripts/realtime-test.mjs` mit neuen Fällen: Mitglied C entfernen → C's Socket erhält `removed` und wird geschlossen; Beitritt mit altem Invite-Link → 404; Leave → Nachfolger ist Owner; zwei parallele `…/bild` → einmal 200/502, einmal 409; 6 Login-Fehlversuche → 429.
3. Browser: zwei Fenster auf derselben Liste (Realtime-Pfad). DevTools auf „Slow 3G“, Liste A öffnen und sofort zu B wechseln → Artikel landet in B, keine hängende Verbindung im Network-Tab. DevTools auf „Offline“ → abhaken → wieder online → der Haken bleibt stehen.
