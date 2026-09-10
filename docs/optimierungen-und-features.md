# Optimierungen & neue Funktionen: Buylist

Stand: 2026-09-10 · Ergänzung zu [`docs/feature-roadmap.md`](./feature-roadmap.md) — dieses Dokument dupliziert dessen Inhalte nicht. Bereits geplante Punkte (Ausgaben-Erfassung, Magic-Link/OAuth, Dark Mode) stehen dort und werden hier nur referenziert. Fokus hier: (A) technische Optimierungen aus einer Code-Analyse und (B) neue Funktionsideen, die die Roadmap bisher nur als Stichwort führt (Aufgabenzuweisung, Meal-Planning, Vorratsverwaltung) oder noch gar nicht.

Es gilt weiterhin das Leitprinzip aus Kapitel 2 der Roadmap: **kein Feature darf die Item-Zeile oder Add-Bar verändern**, neue Funktionalität wandert in Bottom-Sheet, einklappbares Panel, eigene Route oder unsichtbare Automatik.

---

## 1. Technische Optimierungen

### 1.1 Backend

| Punkt | Problem | Empfehlung | Aufwand | Status |
|---|---|---|---|---|
| `recipe_cache` ohne Grenze | Globale Tabelle (`migrations/0007_recipe_cache.sql`) wächst unbegrenzt, jede Nutzer:in kann durch neue Diät/Allergen/Portionen-Kombinationen beliebig viele Zeilen erzeugen; kein TTL, keine Bereinigung | Aufräum-Job im bestehenden 05:00-Uhr-Cron (`scheduled` in `src/index.ts`) ergänzen: Einträge älter als z. B. 90 Tage löschen, optional Zeilenlimit | klein | **umgesetzt** (`runRecipeCacheCleanup`, TTL 90 Tage, Index `0008`) |
| Doppelter `notFound()`-Helper | Identischer Funktionskörper unabhängig in `src/lists.ts`, `src/members.ts`, `src/recipes.ts`, `src/recurring.ts` | In `src/util.ts` (oder `src/lists.ts`) einmal definieren und importieren | klein | **umgesetzt** (`listNotFound()` in `src/util.ts`) |
| Doppeltes `checkListAccess()` | Gleicher Code unabhängig in `src/recipes.ts` und `src/recurring.ts` (Member-Check + redundante Existenzprüfung auf `lists`) | In `src/lists.ts` bündeln, von beiden Modulen importieren | klein | **umgesetzt** (in `src/lists.ts`, genutzt von recipes/recurring/parse) |
| Uneinheitliche Token-Erzeugung | `src/session.ts` baut Session-Token aus zwei `crypto.randomUUID()` statt des vorhandenen `randomToken()`-Helpers in `src/crypto.ts` (der für Invite-Tokens genutzt wird) | Auf `randomToken()` vereinheitlichen — funktional unkritisch (UUIDv4 ist CSPRNG-basiert), aber ein Weg für „sicheren Zufallstoken“ statt zwei | klein | **umgesetzt** (`randomToken(32)` in `src/session.ts`) |
| Push-Krypto ohne Tests | `src/push.ts` implementiert VAPID + `aes128gcm` (RFC 8291/8188) komplett selbst — höchstes Korrektheitsrisiko im Projekt, aber keine automatisierten Tests dafür (nur `scripts/realtime-test.mjs`, backend-weit) | Gezielte Unit-Tests für HKDF/AES-GCM-Payload-Verschlüsselung ergänzen (z. B. gegen bekannte Testvektoren aus RFC 8188) | mittel | **umgesetzt** (`src/push-crypto.ts` + `src/push-crypto.test.ts`) |
| Sequentielles Push-Senden | `ShoppingListDO.notifyMembers()` sendet pro Mitglied nacheinander per `await` in einer Schleife, obwohl `sendPushToUser()` selbst intern schon `Promise.allSettled` für mehrere Subscriptions nutzt | Mitglieder-Schleife auf `Promise.allSettled` umstellen; bei Listen mit vielen Mitgliedern spürbar weniger Latenz im DO-Request | klein | **umgesetzt** (`Promise.allSettled` in `notifyMembers`) |
| Optionale Secrets ohne Startup-Check | `GEMINI_API_KEY`, `VAPID_*` sind `string \| undefined` in `Env` (`src/types.ts`); fehlende Werte fallen erst zur Laufzeit als Fehler/No-op auf | Kleine zentrale Validierungsfunktion, die beim ersten Aufruf der jeweiligen Route klar meldet, welches Secret fehlt (statt generischem 500) | klein | **umgesetzt** als `missingSecret()`/`missingSecretMessage()` – klare Meldung pro Route statt generischem 500 |
| Abhängigkeitsversionen prüfen | `typescript@^7.0.2` (frühe/major Vorabversion) und `GEMINI_MODEL = "gemini-3.5-flash-lite"` (`src/recipes.ts`) sollten bewusst gewählt sein, nicht Tippfehler | Kurzer Check, ob Version/Modellname aktuell und beabsichtigt sind; Modellname ggf. als Env-Var statt Konstante für einfaches Nachziehen neuer Modelle | klein | teilweise: Modellname ist per `GEMINI_MODEL` überschreibbar; `typescript@^7.0.2` weiterhin ungeprüft |
| Unbenutzte D1-Bindung | Bereits in der Roadmap als Nebenbaustelle notiert: `buylist_db` in `wrangler.jsonc` zeigt doppelt auf dieselbe DB | (nur Verweis, kein neuer Punkt) — bei Gelegenheit entfernen | klein | **umgesetzt** (Bindung existiert nicht mehr) |

### 1.2 Frontend

| Punkt | Problem | Empfehlung | Aufwand | Status |
|---|---|---|---|---|
| `renderList` zu groß | `public/app.js` — eine ~1240-Zeilen-Funktion für Topbar, Mitglieder-Sheet, Gerichte-Chips, Verlauf-Sheet, Wiederkehrend-Sheet, Item-Rendering, Add-Form und Socket-Handling in einem Block | In benannte Teilfunktionen/Module aufteilen (z. B. `renderTopbar`, `renderItemList`, `attachSocket`), größtes Wartbarkeitsrisiko im Projekt | mittel–groß | teilweise: `renderTopbar`, `createItemListController` und `openListSocket` sind herausgelöst; `renderList` umfasst weiter ~1.180 Zeilen |
| Doppeltes Rezeptkarten-Rendering | `recipeCard`-Komponente existiert, wird aber für Tagesvorschläge separat nachgebaut statt wiederverwendet | Gemeinsame Karten-Komponente für Rezepte und Vorschläge nutzen | klein | **umgesetzt** (`recipeCardBase` für Rezepte und Vorschläge) |
| Sheets ohne Fokus-Falle | `openSheet()` (`public/app.js`) setzt `role="dialog"`/`aria-modal`, fängt aber den Tab-Fokus nicht ein und setzt kein `aria-hidden` auf den Hintergrund | Einfache Fokus-Falle ergänzen (Fokus beim Öffnen auf erstes Element, `Tab`/`Shift+Tab` innerhalb halten, Hintergrund `aria-hidden` bei offenem Sheet) | klein | **umgesetzt** (`trapFocus` + `aria-hidden` auf dem Hintergrund) |
| Manifest unvollständig | `public/manifest.webmanifest` hat keine maskable Icon-Variante, keine `shortcuts`, keine `screenshots` | Maskable Icon-Variante ergänzen (Basis für App-Icons ist bereits `scripts/make-icons.mjs`), `shortcuts` für „Liste öffnen“/„Schnell hinzufügen“ | klein | teilweise: maskable Icons und `shortcuts` vorhanden, `screenshots` fehlen |
| Kein Bundling | `app.js` (3188 Zeilen) wird unminifiziert ausgeliefert, Cache-Busting läuft manuell über die Versionsnummer in `public/sw.js` | Leichter Build-Schritt (z. B. `esbuild`) für Minifizierung + automatischen Content-Hash statt manueller SW-Versionspflege — optional, da aktuell dependency-frei und bewusst einfach gehalten | mittel | offen |

### 1.3 Tests & Infrastruktur

| Punkt | Problem | Empfehlung | Aufwand | Status |
|---|---|---|---|---|
| Keine Unit-Tests | Einzige automatisierte Prüfung ist `scripts/realtime-test.mjs` (Integrationstest gegen laufenden `wrangler dev`) sowie `tsc --noEmit` | Gezielte Unit-Tests für reine Logik ohne Worker-Runtime: Merge/Dedupe-Logik (Stufe-1-Feature aus der Roadmap), `classify()` in `app.js` (Kategorie-Zuordnung), Zeit-/Timer-Formatierung | mittel | **umgesetzt** (`npm test`: list-logic, parse, push-crypto, rate-limiter, frontend-core) |
| Keine CI-Pipeline | Kein Hinweis auf automatisierte Prüfung bei Pushes/PRs | GitHub-Actions-Workflow, der `npm run typecheck` und `npm run test:realtime` (gegen `wrangler dev`) bei jedem Push ausführt | klein | **umgesetzt** (`.github/workflows/ci.yml`, inkl. Realtime-Test) |

---

## 2. Neue Funktionsideen

Format wie in der Roadmap: Alltagsnutzen, Aufwand, UI-Einordnung nach dem Anti-Clutter-Prinzip.

### 2.1 Listen-Vorlagen / Presets
- **Alltagsnutzen:** Wiederkehrende Einkaufsanlässe („Wocheneinkauf“, „Grillabend“, „Party“) mit einem Tap als Item-Set anlegen, statt jedes Mal neu zu tippen.
- **UI-Einordnung:** Bottom-Sheet beim „Neue Liste“-Flow bzw. als „Vorlage speichern“-Aktion im Listen-Sheet — kein neues Element in der Standardansicht.
- **Aufwand:** mittel (neue D1-Tabelle für Vorlagen, kein Eingriff in den Item-Sync).

### 2.2 Strukturierte Mengen-/Einheiten-Erfassung — **teilweise umgesetzt**
- **Alltagsnutzen:** `menge` ist aktuell Freitext; eine optionale Zahl+Einheit (`Stück`, `g`, `l`, …) verbessert die Zusammenführungs-Logik aus Roadmap 4.1 spürbar (aktuell nur exakte Namens-Treffer).
- **UI-Einordnung:** Add-Bar bleibt unverändert (Freitext weiter möglich); optionale Struktur wird beim Parsen im Hintergrund erkannt, keine neuen Pflichtfelder.
- **Aufwand:** mittel (Parser + Item-Shape-Erweiterung, rückwärtskompatibel wie bei den Rezept-Schritten in Kapitel 7.4 der Roadmap).
- **Stand: teilweise umgesetzt.** `parseMengeParts`/`composeMenge`/`formatItemMenge` (`public/app-core.mjs`) erkennen Wert und Einheit, das Mengen-Sheet bietet sie strukturiert an und die Anzeige trennt „2 · Liter“. Gespeichert wird weiterhin Freitext, die Merge-Logik vergleicht unverändert nur Name + Markt.

### 2.3 Aufgaben-/Artikel-Zuweisung an Mitglieder
*(In der Roadmap Kapitel 9 nur als offener Stichpunkt „Aufgabenzuweisung“ geführt — hier konkretisiert.)*
- **Alltagsnutzen:** „Kannst du die Getränke holen?“ — ein Item einer Person zuweisen, sichtbar als kleiner Avatar/Initiale.
- **UI-Einordnung:** Zuweisung über Long-Press/Kontextmenü am Item (nicht in der Zeile selbst dauerhaft sichtbar), Filter „Meine Artikel“ optional im Mitglieder-Sheet.
- **Aufwand:** mittel (Item-Feld `zugewiesenAn`, DO-Sync bereits vorhanden).

### 2.4 Wochen-Essensplan
*(Ausbau des Roadmap-Stichworts „Meal-Planning (Wochenplan)“, aufbauend auf der bereits umgesetzten Gerichte-Sammlung und den Tagesvorschlägen.)*
- **Alltagsnutzen:** Statt einzelner Gerichte tageweise zuschalten, einen ganzen Wochenplan (Mo–So) aus der bestehenden Rezeptsammlung/den Tagesvorschlägen zusammenstellen; „Alle Zutaten der Woche auf die Liste“ fasst das bestehende Zuschalten-Feature (Kapitel 9 der Roadmap) zusammen.
- **UI-Einordnung:** Eigene Route/eigener Tab (analog Kochmodus), keine Änderung an der Einkaufsliste selbst — nutzt die vorhandene Zuschalten-Logik als Baustein.
- **Aufwand:** mittel–groß (überwiegend Frontend, da Gerichte-Datenmodell und Zuschalten-Mechanik bereits existieren).

### 2.5 Einfache Vorratshaltung
*(Ausbau des Roadmap-Stichworts „Vorratsverwaltung“.)*
- **Alltagsnutzen:** Für wenige Basics (z. B. Klopapier, Waschmittel) „auf Lager“ markieren; kombiniert mit den bereits umgesetzten wiederkehrenden Artikeln (Roadmap 5.3) eine „bald leer“-Erinnerung statt starrem Intervall.
- **UI-Einordnung:** Erweiterung des bestehenden Wiederkehrend-Sheets um ein optionales „Bestand“-Feld, keine neue Ansicht.
- **Aufwand:** mittel (nur `recurring_items` erweitern, kein neuer Baustein).

### 2.6 Undo nach Löschen — **umgesetzt**
- **Alltagsnutzen:** Die Swipe-Delete-Geste (`attachSwipe`, `public/app.js`) ist schnell, aber ein Fehlwisch löscht ohne Rückfrage.
- **UI-Einordnung:** Bestehender Toast (`role="status"`) um eine „Rückgängig“-Aktion mit kurzem Zeitfenster erweitern — kein neues UI-Element, nur Erweiterung eines vorhandenen.
- **Aufwand:** klein.
- **Stand: umgesetzt.** `undoItemDelete` legt das gelöschte Item zurück auf die Liste; die Aktion hängt am bestehenden Toast.

### 2.7 Lesender Gast-Freigabelink
- **Alltagsnutzen:** Liste kurzfristig ohne Registrierung teilen (z. B. Babysitter, Besuch) — nur ansehen, nicht bearbeiten.
- **UI-Einordnung:** Zusätzliche Option im bestehenden Einladungs-Sheet („Nur-Lese-Link erzeugen“), eigener, klar getrennter Token-Typ.
- **Aufwand:** mittel (neue Rolle/Token-Art, Lese-Route ohne Account).

### 2.8 QR-Code für Einladungslink — **umgesetzt**
- **Alltagsnutzen:** Schnelleres Teilen in Präsenzsituationen (WG-Vorstellung, Familienfeier) als Copy-Paste des Links.
- **UI-Einordnung:** Zusätzliches Element im bestehenden Einladungs-Sheet neben dem Link/Share-Button.
- **Aufwand:** klein (reine Client-seitige QR-Generierung aus dem vorhandenen Invite-Link, keine neue API).
- **Stand: umgesetzt.** QR-Code im Mitglieder-Sheet (`showQr`), erzeugt clientseitig aus dem Invite-Link über `public/vendor/qrcode.js`.

### 2.9 Home-Screen-Shortcuts — **umgesetzt**
- **Alltagsnutzen:** Per Langdruck auf das installierte PWA-Icon direkt „Artikel hinzufügen“ oder eine bestimmte Liste öffnen.
- **UI-Einordnung:** Unsichtbar/rein systemseitig — reine Manifest-Erweiterung (`shortcuts`), kein neues In-App-Element.
- **Aufwand:** klein.
- **Stand: umgesetzt.** `shortcuts` im Manifest („Listen öffnen“, „Schnell hinzufügen“); `?add=1` springt in `render()` zur zuletzt geöffneten Liste und fokussiert die Add-Bar.

### 2.10 Liste als Text exportieren
- **Alltagsnutzen:** Liste außerhalb der App teilen (WhatsApp, Notiz-App) für Personen ohne Account/App.
- **UI-Einordnung:** Aktion im bestehenden Listen-Sheet („Als Text teilen“, nutzt die bereits vorhandene Web-Share-API-Integration analog zum Invite-Link).
- **Aufwand:** klein.

### 2.11 Feinere Push-Einstellungen
- **Alltagsnutzen:** Aktuell ist Push pro Nutzer:in an/aus (`renderPushToggle`); bei mehreren Listen kann das schnell zu viel werden.
- **UI-Einordnung:** Erweiterung des bestehenden Push-Toggles im Profil um Pro-Liste-Stummschaltung — bleibt im vorhandenen Profil-Bereich, keine neue Ansicht.
- **Aufwand:** klein–mittel.

### 2.12 Einkaufs-Insights
- **Alltagsnutzen:** „Was kaufen wir am häufigsten?“ — leichte Auswertung aus dem in Roadmap 4.2 vorgesehenen Verlauf, später kombinierbar mit der geplanten Ausgaben-Erfassung (Roadmap 6.1).
- **UI-Einordnung:** Eigener Screen ab der Listen-Übersicht (analog zum geplanten Ausgaben-Screen) — keine Auswertungs-Elemente in der Hauptliste.
- **Aufwand:** mittel, sinnvoll erst nach Roadmap 4.2 und 6.1.

---

## 3. Quick Wins — abgearbeitet

Alle sechs Quick Wins der letzten Iteration sind umgesetzt: doppelte Helper
zusammengeführt (`listNotFound()`, `checkListAccess()`), `recipe_cache`-Bereinigung
im Cron, Undo nach Löschen, QR-Code für den Einladungslink, Home-Screen-Shortcuts
und paralleles Push-Senden.

Als nächste kleine Schritte bleiben aus den Tabellen oben:

1. **`screenshots` im Manifest** ergänzen — der letzte offene Punkt am PWA-Manifest.
2. **`typescript@^7.0.2` prüfen** — bewusst gewählte Version oder Altlast?
3. **`renderList` weiter entflechten** — Mitglieder-, Verlauf-, Gerichte- und
   Wiederkehrend-Sheet ließen sich analog zu `createItemListController` herauslösen.

---

## 4. Bereits in der Roadmap geplant (hier nicht erneut ausgeführt)

Siehe [`docs/feature-roadmap.md`](./feature-roadmap.md) für Details. Offen sind dort
nur noch: grobe Ausgaben-Erfassung (6.1), Dark Mode (6.5) und OAuth-Login
(Magic-Link per Resend ist umgesetzt, siehe `src/magic-link.ts`). Umgesetzt und dort in Kapitel 9 dokumentiert: Duplikat-Zusammenführung (4.1),
Verlauf/„Zuletzt gekauft“ (4.2), automatisches Aufräumen erledigter Items (4.3),
Kategorien/Sortierung nach Supermarkt-Layout (5.2), wiederkehrende Artikel (5.3),
PWA + Web Push (6.2), Mitglieder-Verwaltung (6.3) und der Kochmodus (Kapitel 7).
