# Buylist – geteilte Einkaufslisten in Echtzeit

Gemeinsame Einkaufs-/Haushaltslisten für WG und Familie. Artikel hinzufügen,
abhaken, löschen – Änderungen erscheinen ohne Neuladen auf allen verbundenen
Geräten. Komplett auf Cloudflare, ein einziges Worker-Deployment, keine
externen Dienste.

## Features (MVP)

1. **Registrierung & Login** (E-Mail + Passwort), Session-Cookie, geschützte
   Routen (ohne Session zeigt die SPA die Login-Ansicht)
2. **Listen verwalten**: Übersicht aller eigenen Listen, anlegen per Klick
3. **Mitglieder einladen** per Invite-Link (`/join/<token>`)
4. **Artikel hinzufügen / abhaken / löschen** mit Echtzeit-Sync über
   WebSocket (Durable Object als Broadcast-Hub, nur Mitglieder dürfen sich
   verbinden)
5. **State bleibt erhalten**: Das Durable Object persistiert die Liste in
   DO-Storage, auch wenn alle Clients offline sind
6. **Mobile-first UI**: große Tap-Ziele, sticky Add-Bar, Live-Statusanzeige

## Weitere Features

- **Rezepte & Koch-Assistent**: Gemini-generierte Rezepte (Gericht **oder**
  „aus meinen Zutaten“ = Resteverwertung), Zutaten-Auswahl vor dem
  Übertragen, Kochmodus mit Timer & Portions-Skalierung – alles im
  eigenständigen Rezepte-Tab
- **Essens-Profil**: Diätform + Allergene pro Nutzer, fließt in den
  Gemini-Prompt ein
- **Mitgliederverwaltung**: Mitgliederliste, Entfernen, Owner-Übertragung,
  Liste verlassen (Rollen `owner`/`member`); geht der Owner, überträgt er die
  Rolle automatisch an das früheste verbleibende Mitglied – als letztes
  Mitglied löscht das Verlassen die Liste; der Owner kann sie jederzeit löschen
- **PWA + Offline**: installierbar (Manifest), App-Shell wird gecacht
- **Web Push**: Benachrichtigungen bei Listen-Änderungen (VAPID, siehe Setup)

## Architektur

```
Browser (SPA: Vanilla HTML/CSS/JS, public/)
  │  REST: /api/auth/*, /api/lists, /api/list/:id/snapshot
  │  WebSocket: /api/list/:id/ws
  ▼
Worker (src/index.ts) ── statische Assets über ASSETS-Binding (SPA-Fallback)
  │  Session-Check (D1) + Membership-Check vor jedem API-Call & Upgrade
  ▼
Durable Object ShoppingListDO (pro Liste, idFromName(listId))
  │  WebSocket Hibernation API (acceptWebSocket, Auto-Ping/Pong)
  │  State: JSON unter einem Key im SQLite-backed DO-Storage
  │  Broadcast: {type:"sync", list} an alle verbundenen Clients
  ▼
D1 (SQLite): users, lists, list_memberships, sessions
```

Wichtige Design-Entscheidungen:

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
npm run db:migrate:local   # D1-Schema lokal anwenden (.wrangler/state)
npm run dev                # http://127.0.0.1:8787
```

### Tests

```bash
node scripts/realtime-test.mjs
```

Erwartet einen laufenden `wrangler dev` auf Port 8787 (umbenennbar über
`BASE_URL`). Testet: Registrierung/Login für 3 User, Liste anlegen, Join per
Invite-Token, Negativ-Fälle (401/404), WebSocket-Realtime (add/toggle/delete
an zwei Clients), Persistenz nach Reconnect, die Ablehnung von
Nicht-Mitgliedern sowie Mitglieder-Verwaltung, Präferenzen, Zutaten-Generate
und den VAPID-Status.

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
`node scripts/make-icons.mjs` neu erzeugen.

## Deployment

```bash
# 1. D1-Datenbank anlegen
npx wrangler d1 create buylist-db

# 2. Die ausgegebene database_id in wrangler.jsonc eintragen
#    (ersetzt REPLACE_WITH_YOUR_D1_DATABASE_ID)

# 3. Schema auf der Remote-DB anwenden
npm run db:migrate:remote

# 4. Deployen
npm run deploy
```

Beim ersten `wrangler deploy` wird die Durable-Object-Migration `v1`
(`new_sqlite_classes`) automatisch mit ausgerollt.

## Projektstruktur

```
├── wrangler.jsonc          # Assets, D1, DO-Binding, Migration (new_sqlite_classes)
├── migrations/0001_init.sql# D1-Schema
├── src/
│   ├── index.ts            # Router: /api/* + ASSETS-Fallback, WS-Upgrade
│   ├── types.ts            # Env, Datenmodell, WS-Message-Typen
│   ├── util.ts             # JSON-Responses, Cookie-Parsing, Body-Limit
│   ├── crypto.ts           # PBKDF2, SHA-256, timing-safe Compare
│   ├── session.ts          # Sessions, sliding renewal, withAuth
│   ├── auth.ts             # register / login / logout / me
│   ├── lists.ts            # Listen CRUD, Join, Invite, Snapshot
│   └── do/shopping-list.ts # ShoppingListDO (Hibernation, Storage, Broadcast)
├── public/                 # SPA (kein Build-Step): index.html, app.js, style.css
└── scripts/realtime-test.mjs
```

## API-Überblick

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| POST | `/api/auth/register` | `{email, password, displayName}` → Session-Cookie |
| POST | `/api/auth/login` | `{email, password}` → Session-Cookie |
| POST | `/api/auth/logout` | Session löschen, Cookie entfernen |
| GET | `/api/auth/me` | Aktueller User (Session-Check) |
| GET/POST | `/api/lists` | Eigene Listen / neue Liste anlegen |
| POST | `/api/join` | `{token}` aus Invite-Link → Liste beitreten |
| GET | `/api/list/:id/snapshot` | Aktueller Listenstand (REST, initiales Laden) |
| GET | `/api/list/:id/invite` | Invite-Link der Liste |
| GET | `/api/list/:id/ws` | WebSocket-Upgrade (nur Mitglieder) |
| GET | `/api/list/:id/members` | Mitglieder auflisten |
| DELETE | `/api/list/:id/members` | Mitglied entfernen (nur Owner) `{userId}` |
| POST | `/api/list/:id/owner` | Owner-Rolle übertragen `{userId}` |
| POST | `/api/list/:id/leave` | Liste verlassen (Owner-Rolle geht automatisch über; als letztes Mitglied wird die Liste gelöscht) |
| DELETE | `/api/list/:id` | Liste löschen (nur Owner) |
| GET/PUT | `/api/preferences` | Essens-Profil: `{diaet, allergene[]}` |
| POST | `/api/list/:id/generate` | Rezept generieren `{gericht}` oder `{zutaten[]}` |
| POST | `/api/list/:id/recipes` | Rezept speichern + Zutaten auf die Liste (optional `aufListe`) |
| POST | `/api/push/subscribe` | Web-Push-Subscription speichern `{endpoint, keys}` |
| POST | `/api/push/unsubscribe` | Web-Push-Subscription entfernen `{endpoint}` |
| GET | `/api/push/vapid-key` | Öffentlicher VAPID-Key (oder `configured: false`) |

## Später (nice-to-have, nicht im MVP)

- Magic-Link-Login per E-Mail (z. B. über Resend; braucht Account + API-Key –
  deshalb bewusst nicht im MVP, das reine Cloudflare-Deployment bleibt so
  abhängigkeitsfrei)
- Kategorien/Sortierung, Auto-Cleanup erledigter Items (DO Alarm API)
- PWA-Manifest + Service Worker, Web Push bei neuen Items
- Profilbilder via R2, OAuth-Login (z. B. Google)
 
 