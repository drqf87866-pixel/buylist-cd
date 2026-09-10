# Buylist – geteilte Einkaufslisten in Echtzeit

Gemeinsame Einkaufs-/Haushaltslisten für WG und Familie. Artikel hinzufügen,
abhaken, löschen – Änderungen erscheinen ohne Neuladen auf allen verbundenen
Geräten. Komplett auf Cloudflare, ein einziges Worker-Deployment, keine
externen Dienste.

## Features (MVP)

1. **Registrierung & Login** (E-Mail + Passwort), Session-Cookie, geschützte
   Routen (ohne Session zeigt die SPA die Login-Ansicht)
2. **Magic-Link-Login** per E-Mail über Resend (optional, siehe Setup) – ohne
   Passwort, unbekannte E-Mails werden beim ersten Klick automatisch angelegt
3. **Listen verwalten**: Übersicht aller eigenen Listen, anlegen per Klick
4. **Mitglieder einladen** per Invite-Link (`/join/<token>`)
5. **Artikel hinzufügen / abhaken / löschen** mit Echtzeit-Sync über
   WebSocket (Durable Object als Broadcast-Hub, nur Mitglieder dürfen sich
   verbinden)
6. **State bleibt erhalten**: Das Durable Object persistiert die Liste in
   DO-Storage, auch wenn alle Clients offline sind
7. **Mobile-first UI**: große Tap-Ziele, sticky Add-Bar, Live-Statusanzeige

## Weitere Features

- **Kategorien & Supermarkt**: Artikel werden über ein Stichwort-Wörterbuch
  (`public/data/categories.json`) automatisch einsortiert und in fester
  Markt-Reihenfolge gruppiert; optional trägt jeder Artikel einen Supermarkt,
  nach dem sich die Liste filtern lässt
- **Sprach-Dump in der Add-Bar**: „Milch 2l, Brot, 6 Eier“ wird über Groq in
  einzelne Artikel zerlegt (mit lokalem Fallback ohne KI) und vor dem
  Übernehmen zur Auswahl gestellt
- **Verlauf & Auto-Aufräumen**: Abgehaktes wandert in „Zuletzt gekauft“
  (ein Tap = wieder auf der Liste) und verschwindet 24 h später von selbst
- **Wiederkehrende Artikel**: „Toilettenpapier alle 2 Wochen“ – ein täglicher
  Cron legt fällige Artikel automatisch auf die Liste
- **Rezepte & Koch-Assistent**: Gemini-generierte Rezepte (Gericht **oder**
  „aus meinen Zutaten“ = Resteverwertung), Zutaten-Auswahl vor dem
  Übertragen, Kochmodus mit Timer & Portions-Skalierung – alles im
  eigenständigen Rezepte-Tab. Der Assistent öffnet sich über einen FAB
  (Floating Action Button), die gespeicherten Rezepte erscheinen als
  **Bild-Kachelgrid** (2 Spalten, 3 ab 640px) mit Detail-Sheet
- **KI-Rezeptbilder**: Beim Speichern eines Rezepts generiert die OpenRouter
  Images API (Default: `google/gemini-3.1-flash-lite-image`) asynchron ein
  appetitliches Food-Foto und legt es in **R2** ab; bis das Bild fertig ist,
  zeigt die Kachel einen deterministischen Gradienten + Food-Emoji.
  Ohne OpenRouter-Key/R2 degradiert es sauber auf den Emoji-Fallback
  (Hinweis: Bildgenerierung ist **kostenpflichtig**, kein Free-Tier)
- **Gerichte zuschalten**: Ein gespeichertes Gericht auf die Liste schalten
  legt seine Zutaten mit Herkunfts-Tag an; Abschalten nimmt die offenen
  Zutaten wieder weg, Gekauftes bleibt
- **Tagesvorschläge**: 5 KI-Gerichte pro Nutzer und Tag, nachts vorgeneriert
  und jederzeit neu würfelbar
- **Essens-Profil**: Diätform, Ernährungsziel und Allergene pro Nutzer,
  fließen in jeden Gemini-Prompt ein
- **Mitgliederverwaltung**: Mitgliederliste, Entfernen, Owner-Übertragung,
  Liste verlassen (Rollen `owner`/`member`); geht der Owner, überträgt er die
  Rolle automatisch an das früheste verbleibende Mitglied – als letztes
  Mitglied löscht das Verlassen die Liste; der Owner kann sie jederzeit löschen
- **PWA + Offline**: installierbar (Manifest inkl. Shortcuts), App-Shell wird
  gecacht
- **Web Push**: Benachrichtigungen bei Listen-Änderungen (VAPID, siehe Setup)

## Architektur

```
Browser (SPA: Vanilla HTML/CSS/JS, public/)
  │  REST: /api/auth/*, /api/lists, /api/list/:id/*, /api/recipes, /api/suggestions
  │  WebSocket: /api/list/:id/ws
  ▼
Worker (src/index.ts) ── statische Assets über ASSETS-Binding (SPA-Fallback)
  │  fetch()     Session-Check (D1) + Membership-Check vor jedem API-Call & Upgrade
  │  scheduled() täglicher Cron (05:00 UTC): fällige wiederkehrende Artikel,
  │              Tagesvorschläge vorgenerieren, Rezept-Cache aufräumen
  │
  ├─► Durable Object ShoppingListDO (pro Liste, idFromName(listId))
  │     WebSocket Hibernation API (acceptWebSocket, Auto-Ping/Pong)
  │     State: JSON unter einem Key im SQLite-backed DO-Storage
  │     Broadcast: {type:"sync", list} an alle verbundenen Clients
  │     Alarm: erledigte Artikel 24 h nach dem Abhaken entfernen
  │
  ├─► Durable Object RateLimiterDO (globale Singletons "gemini", "groq", "openrouter-image")
  │     rollierendes 60-s-Fenster, Limit per ?max= (Gemini 12/min, Groq 27/min)
  │
  ├─► Gemini API: Rezepte (src/recipes.ts) + Tagesvorschläge (src/suggestions.ts)
  ├─► OpenRouter Images API: Rezept-Bilder (src/recipes.ts, asynchron via ctx.waitUntil)
  ├─► R2:         Rezept-Bilder unter /media/rezept/:id ausgeliefert
  ├─► Groq API:   Sprach-Dump der Add-Bar (src/parse.ts)
  └─► Resend API: Magic-Link-Mails (src/magic-link.ts, optional)
  ▼
D1 (SQLite): users, sessions, lists, list_memberships, recipes (inkl. bild_key,
              bild_status), recurring_items, user_preferences, push_subscriptions,
              daily_suggestions, recipe_cache, magic_links
R2:         rezepte/{recipeId}.png (Rezept-Bilder, über /media/rezept/:id)
```

Wichtige Design-Entscheidungen:

- **Autorisierung liegt vollständig im Worker.** Das Durable Object prüft keine
  Rechte – es vertraut dem Kontext, den der Worker nach Session- und
  Membership-Check übergibt. Jeder neue DO-Endpunkt braucht seinen Check also
  im Worker davor.
- **Der Listen-Blob wächst nur additiv**: neue Felder (`history?`,
  `aktiveGerichte?`, `quelle?`) sind optional, alte Blobs bleiben lesbar.
  Deshalb kamen Verlauf und zugeschaltete Gerichte ohne Migration aus.
- **Passwort-Hashing**: PBKDF2-SHA256 (100.000 Iterationen, 16-Byte-Salt,
  `timingSafeEqual`) über `crypto.subtle` – nativ in der Workers-Runtime, kein
  npm-Dependency. Hash-Format: `pbkdf2:<iter>:<salt-b64url>:<hash-b64url>`.
- **Sessions**: 32-Byte-Random-Token im `bl_session`-Cookie
  (`HttpOnly; Secure; SameSite=Lax`), in der D1 liegt nur der SHA-256-Hash des
  Tokens. Laufzeit 30 Tage, sliding renewal (Verlängerung ab Restlaufzeit
  < 15 Tage, inkl. neuem Set-Cookie).
- **Nicht-Mitglieder bekommen 404** (statt 403), damit die Existenz fremder
  Listen nicht aufscheint.
- **Vollstands-Sync**: Jede Änderung broadcastet `{type:"sync", list}` mit dem
  kompletten Listenstand – robust und ohne Client-Diffing. Der Browser-Client
  hält die Verbindung mit einem 25-s-`ping` am Leben, den die DO-Runtime per
  `setWebSocketAutoResponse` beantwortet, ohne das DO zu wecken.
- **User-Kontext beim WS-Upgrade**: Der Worker prüft Session + Mitgliedschaft
  und übergibt `x-user-id`/`x-display-name` serverseitig als Header
  (eingehende gleichnamige Header werden vorher entfernt – kein Spoofing).

## Setup (lokale Entwicklung)

```bash
npm install
copy .dev.vars.example .dev.vars   # Windows; macOS/Linux: cp .dev.vars.example .dev.vars
# Keys in .dev.vars eintragen (Gemini, Groq, optional VAPID und Resend)

# R2-Bucket für Rezept-Bilder anlegen (einmalig)
npx wrangler r2 bucket create buylist-recipe-images

# D1-Schema lokal anwenden (.wrangler/state)
npm run db:migrate:local

npm run dev                # http://127.0.0.1:8787
```

Wrangler liest lokale Secrets aus **`.dev.vars`**, nicht aus einer `.env`.
Vorlage: [`.dev.vars.example`](./.dev.vars.example).

### Tests

```bash
npm run typecheck   # tsc --noEmit
npm test            # Unit-Tests (Node-Test-Runner)
```

`npm test` deckt die reine Logik ohne Worker-Runtime ab: Merge-/Verlauf-Logik
des DO (`src/do/list-logic.test.ts`), Sprach-Dump-Sanitizing
(`src/parse.test.ts`), Web-Push-Krypto gegen feste Vektoren
(`src/push-crypto.test.ts`), das Rate-Limit-Fenster
(`src/do/rate-limiter.test.ts`) und die Frontend-Helfer aus `app-core.mjs`
(`test/frontend-core.test.mjs`).

```bash
node scripts/realtime-test.mjs
```

Erwartet einen laufenden `wrangler dev` auf Port 8787 (umbenennbar über
`BASE_URL`). Testet: Registrierung/Login für 3 User, Liste anlegen, Join per
Invite-Token, Negativ-Fälle (401/404), WebSocket-Realtime (add/toggle/delete
an zwei Clients), Persistenz nach Reconnect, die Ablehnung von
Nicht-Mitgliedern sowie Mitglieder-Verwaltung, Präferenzen, Zutaten-Generate
und den VAPID-Status.

Die CI (`.github/workflows/ci.yml`) fährt bei jedem Push und PR dieselbe Kette:
Typecheck → Unit-Tests → lokale D1-Migration → `wrangler dev` starten →
Realtime-Test.

## Web Push (optional)

Web Push braucht VAPID-Schlüssel. Ohne sie ist Push deaktiviert und der
Toggle im Profil wird ausgeblendet.

```bash
# Schlüssel erzeugen (npx web-push generate-vapid-keys) und als Secrets setzen:
npx web-push generate-vapid-keys
wrangler secret put VAPID_PUBLIC_KEY   # "Public Key" von oben
wrangler secret put VAPID_PRIVATE_KEY  # "Private Key" von oben
wrangler secret put VAPID_SUBJECT      # z. B. mailto:du@example.com

# Lokal: .dev.vars mit denselben Keys anlegen
```

Die PWA-Icons (`public/icon-192.png`, `public/icon-512.png`) lassen sich per
`node scripts/make-icons.mjs` neu erzeugen (erzeugt auch die
maskable-Varianten `icon-maskable-*.png`).

## Magic-Link-Login (optional)

Anmeldung ohne Passwort: Der Nutzer gibt seine E-Mail ein, bekommt per Resend
einen Link und ist nach dem Klick eingeloggt. Unbekannte E-Mails werden dabei
automatisch registriert. Ohne `RESEND_API_KEY` melden die Magic-Link-Routen
klar, dass das Secret fehlt (kein stiller Fehler).

```bash
wrangler secret put RESEND_API_KEY   # API-Key aus dem Resend-Dashboard
wrangler secret put RESEND_FROM      # z. B. "Buylist <noreply@deinedomain.de>"
wrangler secret put APP_URL          # optional, z. B. https://buylist.deinedomain.de

# Lokal: dieselben Keys in .dev.vars
```

`RESEND_FROM` muss auf einer bei Resend **verifizierten Domain** liegen.
`APP_URL` bestimmt die Basis des Links; fehlt sie, wird der Origin des
jeweiligen Requests verwendet (lokal also `http://127.0.0.1:8787`).

Ablauf: `POST /api/auth/magic/request` legt einen Token an (nur als SHA-256-Hash
in `magic_links`, 15 Min gültig, Einmal-Verwendung) und verschickt den Link.
Der Klick auf `/api/auth/magic/verify?token=…` prüft und entwertet den Token,
setzt das `bl_session`-Cookie und leitet per 302 in die App. Pro E-Mail sind
höchstens 3 Anfragen je 5 Minuten erlaubt.

### Gemini-Modell

Der Modellname für die Rezept-/Vorschlags-Generierung ist als Worker-Secret
`GEMINI_MODEL` überschreibbar (Default: `gemini-3.5-flash-lite`, ein aktueller
Stable-Modellname). So lassen sich neue Modelle ohne Code-Änderung nachziehen.

### Rezept-Bilder (OpenRouter Images API + R2)

Beim Speichern eines Rezepts generiert die OpenRouter Images API asynchron
ein Food-Foto und legt es in R2 ab. Ohne `OPENROUTER_API_KEY` oder R2-Bucket
wird das Bild übersprungen und die Kachel zeigt einen deterministischen
Gradienten + Emoji.

**Hinweis:** Bildgenerierung ist **kostenpflichtig** (kein Free-Tier). Die
Kosten variieren pro Modell – das Default-Modell
`google/gemini-3.1-flash-lite-image` kostet ca. $0,01–0,02 pro Bild.

```bash
# Einmalig: R2-Bucket anlegen
npx wrangler r2 bucket create buylist-recipe-images

# Lokal: der Bucket wird von wrangler dev automatisch simuliert
# Remote: API-Key setzen
wrangler secret put OPENROUTER_API_KEY
```

Der Modellname ist per `OPENROUTER_IMAGE_MODEL` überschreibbar
(Default: `google/gemini-3.1-flash-lite-image`). Die Bild-Generierung hat einen
eigenen Rate-Limiter (über `RATE_LIMITER_DO.idFromName("openrouter-image")`),
getrennt vom Text-Generator.

### Sprach-Dump (Groq)

Die Add-Bar zerlegt Mini-Listen (`Milch 2l, Brot, 6 Eier`) über Groq, nicht
über Gemini – höheres RPM, eigener Rate-Limiter (Default **27/min**).

```bash
wrangler secret put GROQ_API_KEY
# optional: GROQ_MODEL (Default: openai/gpt-oss-20b)
# optional: GROQ_RPM (Default: 27)

# Lokal: in .dev.vars
# GROQ_API_KEY=...
```

## Deployment

```bash
# 1. D1-Datenbank anlegen
npx wrangler d1 create buylist-cd-db

# 2. Die ausgegebene database_id in wrangler.jsonc eintragen
#    (Feld "database_id" im Block "d1_databases")

# 3. Schema auf der Remote-DB anwenden
npm run db:migrate:remote

# 4. Deployen
npm run deploy
```

Beim ersten `wrangler deploy` werden die Durable-Object-Migrationen `v1` und `v2`
(`new_sqlite_classes` für `ShoppingListDO` und `RateLimiterDO`) automatisch mit
ausgerollt.

## Projektstruktur

```
├── wrangler.jsonc              # Assets, R2, D1, DO-Bindings, Cron, DO-Migrationen
├── migrations/                 # D1-Schema (0001_init … 0011_recipe_images)
├── src/
│   ├── index.ts                # Router: /api/* + /media/* (Rezept-Bilder), WS-Upgrade, Cron
│   ├── types.ts                # Env, Datenmodell, WS-Message-Typen
│   ├── util.ts                 # JSON-Responses, 404-Helfer, Cookie, Body-Limit, normKey
│   ├── crypto.ts               # PBKDF2, SHA-256, base64url, Zufallstoken
│   ├── session.ts              # Sessions, sliding renewal, withAuth
│   ├── auth.ts                 # register / login / logout / me
│   ├── magic-link.ts           # Magic-Link-Anfrage/-Verify über Resend
│   ├── lists.ts                # Listen-CRUD, Join, Invite, Snapshot, Access-Helfer
│   ├── members.ts              # Mitglieder, Entfernen, Owner-Transfer, Verlassen
│   ├── preferences.ts          # Essens-Profil + Prompt-Baustein für alle LLM-Pfade
│   ├── recipes.ts              # Gemini-Aufruf, OpenRouter-Images, Rezept-CRUD, Cache, Gerichte zu-/abschalten
│   ├── suggestions.ts          # Tagesvorschläge (5/Nutzer/Tag) inkl. Cron-Vorlauf
│   ├── recurring.ts            # Wiederkehrende Artikel + täglicher Cron
│   ├── parse.ts                # Sprach-Dump der Add-Bar über Groq
│   ├── push.ts                 # Web Push: VAPID-JWT, Versand, Subscriptions
│   ├── push-crypto.ts          # Reine Push-Krypto (HKDF, ECDH, aes128gcm), testbar
│   └── do/
│       ├── shopping-list.ts    # ShoppingListDO (Hibernation, Storage, Broadcast, Alarm)
│       ├── list-logic.ts       # Merge-, Mengen- und Verlauf-Logik (rein, unit-getestet)
│       └── rate-limiter.ts     # RateLimiterDO (rollierendes 60-s-Fenster)
├── public/                     # SPA (kein Build-Step)
│   ├── index.html, style.css
│   ├── app.js                  # SPA: Router, Views, Sheets, WebSocket-Client
│   ├── app-core.mjs            # Reine Helfer (ESM, in Node testbar, als window.BC)
│   ├── sw.js                   # Service Worker: App-Shell-Cache, Push, Notification
│   ├── manifest.webmanifest    # PWA-Manifest inkl. Icons und Shortcuts
│   ├── data/categories.json    # Kategorie-Wörterbuch (Client-Sortierung + LLM-Enum)
│   └── vendor/qrcode.js        # QR-Code für den Invite-Link
├── test/frontend-core.test.mjs # Unit-Tests der Frontend-Helfer
├── scripts/                    # realtime-test.mjs, make-icons.mjs
└── .github/workflows/ci.yml    # Typecheck, Unit-Tests, Realtime-Test
```

## API-Überblick

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| POST | `/api/auth/register` | `{email, password, displayName}` → Session-Cookie |
| POST | `/api/auth/login` | `{email, password}` → Session-Cookie |
| POST | `/api/auth/logout` | Session löschen, Cookie entfernen |
| GET | `/api/auth/me` | Aktueller User (Session-Check) |
| POST | `/api/auth/magic/request` | `{email}` → Magic-Link-Mail senden (Resend) |
| GET | `/api/auth/magic/verify?token=` | Token einlösen → Session-Cookie + Redirect ins App |
| GET/POST | `/api/lists` | Eigene Listen / neue Liste anlegen |
| DELETE | `/api/list/:id` | Liste löschen (nur Owner) |
| POST | `/api/join` | `{token}` aus Invite-Link → Liste beitreten |
| GET | `/api/list/:id/snapshot` | Aktueller Listenstand (REST, initiales Laden) |
| GET | `/api/list/:id/invite` | Invite-Link der Liste |
| GET | `/api/list/:id/ws` | WebSocket-Upgrade (nur Mitglieder) |
| GET | `/api/list/:id/members` | Mitglieder auflisten |
| DELETE | `/api/list/:id/members` | Mitglied entfernen (nur Owner) `{userId}` |
| POST | `/api/list/:id/owner` | Owner-Rolle übertragen `{userId}` |
| POST | `/api/list/:id/leave` | Liste verlassen (Owner-Rolle geht automatisch über; als letztes Mitglied wird die Liste gelöscht) |
| POST | `/api/list/:id/items` | Mehrere Artikel auf die Liste legen `{items[]}` |
| GET/PUT | `/api/preferences` | Essens-Profil: `{diaet, ziel, allergene[]}` |
| POST | `/api/list/:id/generate` | Rezept generieren `{gericht}` oder `{zutaten[]}` (Gemini) |
| POST | `/api/list/:id/parse` | Sprach-Dump zerlegen `{text, vorhandene?}` → `{items}` (Groq) |
| GET | `/api/list/:id/recipes` | Gespeicherte Rezepte dieser Liste (inkl. bildUrl/bildStatus) |
| POST | `/api/list/:id/recipes` | Rezept speichern; startet asynchrone KI-Bild-Generierung (ctx.waitUntil) |
| DELETE | `/api/list/:id/recipes/:recipeId` | Rezept löschen |
| POST | `/api/list/:id/recipes/:recipeId/bild` | Bild-Generierung wiederholen (bei fehler) |
| GET | `/media/rezept/:id` | Rezept-Bild aus R2 (auth-geprüft, SW-cached, offline-fähig) |
| GET | `/api/recipes` | Alle Rezepte über alle eigenen Listen |
| POST | `/api/list/:id/gerichte` | Gerichte zuschalten `{gerichte:[{id, nur?, supermarkt?}]}` |
| DELETE | `/api/list/:id/gerichte/:gerichtId` | Gericht abschalten (offene Zutaten fliegen von der Liste) |
| GET/POST | `/api/list/:id/recurring` | Wiederkehrende Artikel lesen / anlegen |
| DELETE | `/api/list/:id/recurring/:ruleId` | Regel löschen |
| GET | `/api/suggestions` | Heutige Gerichte-Vorschläge (bei Bedarf on demand generiert) |
| POST | `/api/suggestions/refresh` | Vorschläge neu würfeln |
| POST | `/api/push/subscribe` | Web-Push-Subscription speichern `{endpoint, keys}` |
| POST | `/api/push/unsubscribe` | Web-Push-Subscription entfernen `{endpoint}` |
| GET | `/api/push/vapid-key` | Öffentlicher VAPID-Key (oder `configured: false`) |

## Später (nice-to-have)

- Wochen-Essensplan (baut auf der Gerichte-Sammlung und dem Zuschalten auf)
- Grobe Ausgaben-Erfassung, Dark Mode
- Profilbilder via R2, OAuth-Login (z. B. Google)
- Eigenes Rezept-Foto hochladen (optionales Bildfeld, additiv zum KI-Bild)

Ausführlicher in [`docs/feature-roadmap.md`](./docs/feature-roadmap.md) und
[`docs/optimierungen-und-features.md`](./docs/optimierungen-und-features.md).
