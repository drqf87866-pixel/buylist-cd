# Feature-Roadmap: Haushalts-Einkaufsliste (Buylist)

Stand: 2026-08-29 · Konzeptdokument — beschreibt die Weiterentwicklung, noch nicht deren Umsetzung.

---

## 1. Ausgangslage

**Technischer Bestand (in Benutzung):**

| Baustein | Einsatz |
|---|---|
| Cloudflare Worker + Static Assets | Ein Worker, SPA-Fallback, alle `/api/*`-Routen im Worker |
| D1 | `users`, `sessions`, `lists`, `list_memberships`, `recipes` |
| Durable Object `ShoppingListDO` | 1 DO pro Liste; **die gesamte Liste liegt als ein JSON-Blob** im DO-Speicher; WebSocket-Hibernation, Full-State-Sync (`{type:"sync"}`) |
| Worker Secret `GEMINI_API_KEY` | Rezept-Generierung über die Gemini-API (plain `fetch`) |

Nicht konfiguriert (also frei verfügbar): R2, KV, Queues, Cron Triggers, **DO Alarms**, Workers AI.

**Funktional bereits vorhanden** (Roadmap-Vorschläge dürfen diese nicht doppeln):

- Rezepte inkl. KI-Generierung, Portionen-Angabe und **„Auf die Liste“**-Flow (Zutaten landen als Items auf der Liste) — `src/recipes.ts`, Tabelle `recipes` mit `portionen`, `zutaten` (JSON: `{name, menge?}[]`), `schritte` (JSON)
- Batch-Add von Items mit Freitext-Menge (`{name, menge?}`), Abhaken, Swipe-Delete
- Einladen per Link, Rollen `owner`/`member` (ohne Rollen-Logik), Realtime-Sync mit optimistischen Updates

**UI-Bestand:** Vanilla-JS-SPA mit 5 Routen (Login/Registrierung, Listen-Übersicht, Listendetail, Join, 404) plus Bottom-Sheet-Overlay (Listen-Wechsler). Keine Tab-Leiste, kein Drawer. Die Listendetail-Ansicht ist bereits in fünf Zonen gestapelt (Topbar → Fortschrittszeile → Item-Liste → Rezept-Aufklapper → Add-Bar); **die Item-Zeile selbst ist voll** — dort kommt nichts mehr dazu. Die App hat aber etablierte „Entlastungs-Muster“, an die neue Features andocken können:

1. **Bottom-Sheet** für gelegentliche Funktionen (Listen-Wechsler, `openSheet()` in `public/app.js`)
2. **Eingeklapptes Panel mit Badge** für listenbezogene Werkzeuge (so lebt heute schon der Rezept-/Koch-Assistent unten in der Liste)
3. **Eigene Route** für fokussierte Tätigkeiten (Kochmodus, Kapitel 7)
4. **Unsichtbare Automatik** statt Optionen (zwei Bewertungen pro Aktion, Full-State-Sync ohne Konfliktdialoge)

---

## 2. Leitprinzip: UI darf nicht überladen wirken (harte Anforderung)

Jedes Feature in dieser Roadmap wird an zwei Tests gemessen:

**Erstnutzer-Test:** „Würde jemand, der nur schnell eine Einkaufsliste führen will, sich davon erschlagen fühlen?“
Falls ja → das Feature muss unsichtbar (Automatik), versteckt (Sheet/Panel) oder an einem anderen Ort (eigene Route) leben. Es darf nichts in die Standardansicht.

**Konkrete Regeln, abgeleitet aus dem bestehenden Design:**

1. Die Kerninteraktion bleibt: Zeile eintippen → [+], abhaken, zur Seite wischen. Kein Feature darf Buttons, Regler oder Optionen in die Item-Zeile oder die Add-Bar bringen.
2. Neue Funktionalität wandert bevorzugt in die vier Entlastungs-Orte oben (Sheet, Panel, Route, Automatik) — in dieser Reihenfolge der Präferenz für kleine Features.
3. **Progressive Disclosure:** Die Standardansicht zeigt nur, was man für „Liste führen“ braucht. Alles Weitere ist einen Tap entfernt und wird erst durch Nutzung sichtbar (Badges, Chips, eigene Screens).
4. Features, die ohne Nutzerentscheidung funktionieren können, werden als **Automatik** gebaut (z. B. Duplikate mergen, erledigte Items aufräumen) — kein Toggle, keine Einstellungs-Option im ersten Schritt.

---

## 3. Übersicht: Ausbaustufen

| Stufe | Feature | Alltagsnutzen (Kern) | Aufwand | UI-Ort |
|---|---|---|---|---|
| 1 — Nächste Version | Duplikate & Mengen zusammenführen | Zwei Personen adden „Milch“ → eine Zeile statt zwei | mittel | unsichtbar |
| 1 — Nächste Version | Verlauf / „Zuletzt gekauft“ | Wöchentliche Standardkäufe mit einem Tap wieder da | klein–mittel | Bottom-Sheet |
| 1 — Nächste Version | Erledigte Items automatisch aufräumen | Liste bleibt von selbst aufgeräumt | klein | unsichtbar |
| 2 — Mittelfristig | **Kochmodus** | Rezept fokussiert am Gerät abkochen, mit Timern | mittel–groß | eigene Route (Kap. 7) |
| 2 — Mittelfristig | Kategorien / Markt-Laufweg | Liste in Supermarkt-Reihenfolge, kein Hin-und-Her-Laufen | mittel–groß | Abschnitts-Header (rein lesend) |
| 2 — Mittelfristig | Wiederkehrende Items | „Toilettenpapier alle 2 Wochen“ erscheint von selbst | mittel–groß | eigener Bereich (Sheet) |
| 3 — Später/Ideen | Grobe Ausgaben-Erfassung | „Was geben wir monatlich aus?“ — grob, kein Budget-Tool | mittel | eigener Screen ab Übersicht |
| 3 — Später/Ideen | PWA + Web Push | Homescreen-Icon; „Liste geändert“-Stups für Partner | mittel–groß | unsichtbar + ein Toggle |
| 3 — Später/Ideen | Mitglieder-Verwaltung | Wer ist in der Liste? Jemanden entfernen können | klein–mittel | Bottom-Sheet hinter 👥 |
| 3 — Später/Ideen | Magic-Link / OAuth-Login | Familien-Onboarding ohne Passwort-Friction | mittel (+ externe Mail) | nur Login-Screen |
| 3 — Später/Ideen | Dark Mode | Abends nicht geblendet werden | klein | unsichtbar/automatisch |

---

## 4. Stufe 1 — Nächste Version

### 4.1 Duplikate & Mengen zusammenführen

- **Alltagsproblem:** In einem Haushalt adden zwei Personen unabhängig voneinander „Milch“ — aktuell entstehen zwei getrennte Items. Im Laden hakt man eine ab und übersieht die zweite, oder kauft doppelt.
- **Technische Einordnung:** Aufwand **mittel**. Rein im Durable Object: Beim `add`/`add-items` den Namen normalisieren (trim, Kleinschreibung) und bei Treffer das vorhandene Item behalten — Menge als Freitext anreichern (`„500 g · +1 l“`) bzw. `hinzugefuegtVon` ergänzen. Kein neuer Cloudflare-Baustein, keine Schema-Änderung. Der Full-State-Sync verteilt das Ergebnis automatisch an alle Geräte. Grenzfall, der bewusst einfach bleiben darf: exakte normalisierte Treffer genügen; unscharfe Ähnlichkeitserkennung („Semmel“ vs. „Brötchen“) ist nicht Stufe 1.
- **UI-Einordnung:** **Unsichtbar.** Das Ergebnis ist schlicht weniger Müll in der Liste. Besticht: der Erstnutzer-Test ist trivial erfüllt, weil es nichts zu sehen gibt.
- **Erstnutzer-Test:** bestanden — null neue Bedienelemente.

### 4.2 Verlauf / „Zuletzt gekauft“

- **Alltagsproblem:** Milch, Butter, Brot, Kaffee — dieselben Sachen jede Woche. Heute tippt man sie jedes Mal neu ein; Löschen ist endgültig, es gibt kein Gedächtnis der App.
- **Technische Einordnung:** Aufwand **klein–mittel**. Beim Abhaken (toggle auf `erledigt`) den Zeitpunkt im Item verbuchen (`gekauftAm`) und daraus eine Verlaufsliste im DO-Blob ableiten (normalisierter Name → letztes Kaufdatum, auf z. B. die letzten 100 Einträge begrenzt). Alles im bestehenden DO, kein D1, kein neuer Baustein; der Verlauf reist im bestehenden `sync`-Frame mit. Neue WebSocket-/REST-Aktion `re-add` ist trivial.
- **UI-Einordnung:** **Bottom-Sheet „Zuletzt gekauft“** mit Chips („Milch · vor 5 Tagen“), Tap = wieder auf die Liste. Einstieg über ein bereits vorhandenes, bisher totes Element: die Fortschrittszeile („x von y erledigt“) wird antippbar. Kein neuer Button, kein Icon in der Leiste.
- **Erstnutzer-Test:** bestanden — wer die Zeile nie antippt, sieht nichts Neues.

### 4.3 Erledigte Items automatisch aufräumen

- **Alltagsproblem:** Die „erledigt“-Sektion wächst unbegrenzt; der manuelle „Entfernen“-Button wird vergessen. Nach zwei Wochen wirkt die Liste unordentlich — genau das, was die App verhindern soll.
- **Technische Einordnung:** Aufwand **klein**. **DO Alarms**: Beim ersten abgehakten Item `setAlarm()` setzen; im Alarm alles entfernen, was länger als 24–48 h erledigt ist. Alarms sind bei SQLite-backed DOs (so wie hier angelegt) verfügbar und kosten nichts Extra. Wichtig: erst nach 4.2 liefern, damit abgehakte Items ihre Verlauf-Verbuchung bekommen haben, bevor sie verschwinden.
- **UI-Einordnung:** Unsichtbar. Optional später eine Zeile im Sheet („Aufräumen nach 24 h“) — im ersten Schritt keine Einstellung.
- **Erstnutzer-Test:** bestanden — die Liste wird von allein sauberer.

---

## 5. Stufe 2 — Mittelfristig

### 5.1 Kochmodus

Das ausgearbeitete Kernfeature dieser Roadmap — **siehe Kapitel 7**. Aufwand **mittel–groß**, überwiegend Frontend-Arbeit (ein neuer View + Route), weil Rezept-Datenmodell und „Auf die Liste“-Flow bereits existieren.

### 5.2 Kategorien / Sortierung nach Supermarkt-Layout

- **Alltagsproblem:** Die Liste ist nach Zeitstempel sortiert. Im Supermarkt läuft man dadurch hin und her: erst „Toilettenpapier“, dann hinten „Obst“, dann wieder vorn „Milch“.
- **Technische Einordnung:** Aufwand **mittel–groß**. Item-Shape im DO um ein optionales `kategorie?`-Feld erweitern (einmalige Normalisierung bestehender Items beim Laden = „Migration“ des Blobs). Feste Standard-Reihenfolge der Abteilungen (Obst/Gemüse → Backwaren → Kühlregal → …), pro Liste optional änderbar. Für die automatische Zuordnung liegt ein trümpfender Baustein bereit: der **existierende Gemini-Key** — Zutaten werden beim Add gebatcht klassifiziert, Fallback „Sonstiges“. Alternativ komplett regelbasiert (Wörterbuch) ohne LLM-Kosten; LLM nur als Korrekturschicht. Kein neuer Cloudflare-Baustein erforderlich.
- **UI-Einordnung:** Die Liste erhält **rein lesende Abschnitts-Header** — keine Buttons, keine Farbcodes, keine Sortier-Regler. Die automatische Sortierung ist einfach da. Manuelle Korrektur einer Fehlzuordnung (selten nötig): im Item-Kontext via Sheet, nicht in der Zeile. Wichtig für den Erstnutzer-Test: **kein Setup**, keine „Kategorien verwalten“-Option in der Standardansicht.
- **Erstnutzer-Test:** grenzwertig, aber bestanden — es ändert sich nichts Bedienbares, nur die Ordnung. Geh deshalb bewusst in Stufe 2, nicht 1: Die App sollte erst mit 4.x stabil laufen, bevor das gewohnte Listenbild umgebaut wird.

### 5.3 Wiederkehrende Items — **umgesetzt**

- **Alltagsproblem:** „Toilettenpapier alle 2 Wochen“, „Müllbeutel monatlich“, „Katzenfutter wöchentlich“ — vergisst man ständig und steht erst vor dem leeren Regal.
- **Technische Einordnung:** Aufwand **mittel–groß**. Neue D1-Tabelle `recurring_items` (`list_id`, `name`, `menge`, `intervall_tage`, `zuletzt_hinzugefuegt`) plus **Cron Trigger** (ein täglicher Worker-Run findet fällige Regeln und fügt die Items über den bestehenden DO-`add-items`-Pfad ein). Das ist einfacher zu durchschauen und zu überwachen als ein Alarm pro Listen-DO. Erste neue Cloudflare-Bausteine: Cron Trigger + eine D1-Migration. Erinnerungen *außerhalb* der App (Push „Toilettenpapier ist fällig“) gehören erst zu PWA/Push in Stufe 3.
- **UI-Einordnung:** **Bewusst getrennt.** Verwaltung der Regeln in einem eigenen Sheet/Screen (Zugang z. B. über das Listen-Sheet, nicht über die Hauptansicht); auf der Liste selbst tauchen die Items einfach rechtzeitig ganz normal auf — ohne Sondermarkierung, die den Kern-Flow stören würde. Kein Regler, kein Badge in der Standardansicht.
- **Erstnutzer-Test:** bestanden, solange die Verwaltung nicht in der Hauptliste lebt.

---

## 6. Stufe 3 — Später / Ideen

### 6.1 Grobe Ausgaben-Erfassung

- **Alltagsproblem:** „Was geben wir eigentlich monatlich für Lebensmittel aus?“ — Für WG/Familie reicht eine grobe Zahl, kein Haushaltsbuch.
- **Technische Einordnung:** Aufwand **mittel**. D1-Tabelle `einkaeufe` (`list_id`, `datum`, `betrag`, optionale Notiz). Erfassung als Einzelsumme nach dem Einkauf (im „erledigt“-Kontext optional), **keine Einzelpreise pro Item** — das würde den Abhak-Flow belasten und den Erstnutzer-Test verletzen. Keine neuen Bausteine.
- **UI-Einordnung:** Eigener „Ausgaben“-Screen, erreichbar ab der Listen-Übersicht — vollständig getrennt vom Einkaufsflow.

### 6.2 PWA + Web Push

- **Alltagsproblem:** (a) App soll wie eine App auf dem Homescreen liegen, ohne Browser-Leiste. (b) „Schatz, ich habe die Liste aktualisiert“ — der Partner soll den Stups aufs Handy bekommen, während er im Laden steht.
- **Technische Einordnung:** Aufwand **mittel–groß**. Manifest + Service Worker (Teil a, klein) und VAPID-Web-Push (Teil b): Push-Subscriptions in D1, Versand per `fetch` aus dem DO beim Sync-Ereignis. Für den heutigen Umfang **keine Queues nötig**; bei Wachstum können Queues dazukommen. Erstes/features-echtes Deploy-Thema: Service-Worker-Versionierung.
- **UI-Einordnung:** Install-Hinweis dezent einmalig; Push-Toggle ausschließlich im Listen-Sheet. Standardansicht bleibt unberührt.

### 6.3 Mitglieder-Verwaltung

- **Alltagsproblem:** Nach WG-Auszug oder Trennung bleibt die Person in der Liste; heute sieht man gar nicht, wer Mitglied ist, und niemand kann jemanden entfernen.
- **Technische Einordnung:** Aufwand **klein–mittel**. `list_memberships` mit Rollen existiert bereits; es fehlen die Routen (Mitglieder auflisten, entfernen) plus Owner-Schutzlogik (z. B. letzter Owner kann Liste verlassen/löschen). Kein neuer Baustein.
- **UI-Einordnung:** Erweiterung des bestehenden **👥-Sheets** (das heute nur den Invite-Link zeigt) um eine Mitgliederliste. Kein neuer Button — der Eintrittspunkt existiert schon.

### 6.4 Magic-Link / OAuth-Login

- **Alltagsproblem:** Familien-Onboarding scheitert an Passwort-Registrierung — Oma bekommt den Magic-Link und ist in 20 Sekunden dabei.
- **Technische Einordnung:** Aufwand **mittel** plus externe Abhängigkeit (Mailversand, z. B. Resend/MailChannels). Einmal-Tokens in **KV** (erster sinnvoller Einsatz für KV; alternativ D1-Tabelle). Laut README ohnehin als Idee vorgemerkt.

### 6.5 Dark Mode

- **Alltagsproblem:** Abends starkes weißes Blenden. Technisch **klein**, weil das CSS bereits durchgehend Custom-Property-Tokens nutzt — ein `prefers-color-scheme`-Block + Token-Spiegelung reicht. UI: unsichtbar/automatisch.

---

## 7. Kochmodus im Detail

### 7.1 Ausgangspunkt: die halbe Strecke ist schon gebaut

Rezepte existieren bereits vollständig: KI-Generierung per Gemini, Speichern in der `recipes`-Tabelle (`titel`, `zeit`, `portionen`, `zutaten` als `{name, menge?}[]`, `schritte` als `string[]`) und der Übertrag der Zutaten auf die Liste. Der Lebenszyklus eines Rezepts in der App lautet: **finden → Zutaten einkaufen → kochen.** Die ersten zwei Glieder sind gebaut, das letzte fehlt. Der Kochmodus ist also keine neue Feature-Insel, sondern die zweite Hälfte eines bestehenden Flows — das hält Aufwand und UI-Risiko klein.

### 7.2 Zusammenhang mit der Einkaufsliste

- **Bestehender Flow bleibt:** „Auf die Liste“ überträgt alle Zutaten als Items (`name` + `menge`) — genau das richtige Mapping, weil `RecipeIngredient` bereits bewusst an `ShoppingItem` angeglichen ist.
- **Verfeinerung 1 — Zutaten auswählbar:** Vor dem Übertragen jede Zutat an-/abwählbar („Habe ich schon zu Hause“). Standard: alle aktiv, ein Tap „X Zutaten auf die Liste“.
- **Verfeinerung 2 — Duplikate:** In Stufe 1 gebaute Zusammenführung greift automatisch: Rezept-Zutat „Milch“ + von Hand geaddete „Milch“ ergeben ein Item statt zweier. Der Kochmodus braucht dafür selbst nichts zu tun.
- **Verfeinerung 3 — Kochmodus als Listen-Check (später, optional):** Beim Betreten des Kochmodus anzeigen, welche Zutaten dieses Rezepts noch *offen* auf der Liste stehen — hilfreicher Hinweis „Du hast die Eier noch nicht geholt“, ohne dass der Kochmodus die Liste selbst anfasst.

Bewusst **nicht** geplant: Beim Abhaken einer Zutat im Kochmodus automatisch das Listen-Item abhaken. Das klingt smart, erzeugt aber verwirrende Cross-Modus-Nebeneffekte (Partner hakt im Laden ab, während gekocht wird). Die beiden Welten bleiben lesbar getrennt.

### 7.3 Eigener, klar abgegrenzter Bereich

- **Eigene Route** `/list/:id/kochen/:recipeId`, betreten über einen **„Kochen“-Button auf der gespeicherten Rezeptkarte** — genau dort, wo heute „Auf die Liste“ liegt. Kein zusätzlicher Button in der Hauptliste, keine Tab-Leiste, keine globale Navigationsänderung.
- Die Kochansicht ist ein **Vollbild-Modus** mit eigener Topbar („‹“ zurück): Sie verdeckt die Einkaufsliste vollständig. Man *betritt* den Modus bewusst und *verlässt* ihn sichtbar — die Haupt-Einkaufsliste bleibt unberührt und unverändert schlicht.
- Innerhalb des Modus gilt umgekehrt dieselbe Disziplin: nur was beim Kochen hilft (Schritt, Zutaten, Timer, Portionen). Kein Rezept-Editor, keine Listenverwaltung, keine Einstellungen im Kochmodus.
- Komfort-Details: **Wake Lock**, damit das Display beim Kochen nicht ausgeht (`navigator.wakeLock`, progressive Enhancement, ohne Fallback-Aufwand), extra große Touch-Ziele und Schrift, weil die Hände mehlig sind.

**UI-Skizze (Vollbild):**

```
┌────────────────────────────────────┐
│ ‹  Spaghetti Carbonara   Portionen │
│                           2  − / + │
├────────────────────────────────────┤
│ ZUTATEN                            │
│  ✓ 500 g Spaghetti                 │  ← abgehakt = durchgestrichen
│  ☐ 200 g Pancetta                  │
│  ☐ 4 Eier · 100 g Parmesan         │
├────────────────────────────────────┤
│ SCHRITT 2 VON 5            ●●○○○  │
│  Pancetta knusprig auslassen,      │  ← groß, gut ablesbar
│  in der Zwischenzeit Eier…         │
│                                    │
│  [ ⏱ 8 min ]      [ Schritt ✓ ]   │
└────────────────────────────────────┘
```

Portionen-Umschalter: skaliert die Zutatenmengen in der Ansicht (Freitext-Mengen werden soweit möglich numerisch skaliert, sonst unverändert übernommen) und übernimmt die skalierte Portionszahl auch in den „Auf die Liste“-Übertrag.

### 7.4 Datenmodell-Vorschlag

**Weiterverwenden (ändert sich nicht):** Tabelle `recipes` mit `id`, `list_id`, `titel`, `zeit`, `portionen`, `zutaten` (JSON), `schritte` (JSON), `created_by`, `created_at`.

**Optionale Erweiterung A — Schritt-Timer:** `schritte` von `string[]` zu Objekten `{ text: string; timerSekunden?: number }[]` migrieren, **rückwärtskompatibel parsen** (ein alter String wird zu `{text}`). Der Gemini-Prompt kann Timer-Hinweise künftig gleich miterzeugen („5 Minuten köcheln“ → `timerSekunden: 300`). Alternativ ohne Migration: Timer ad hoc im UI starten (Vorschläge 5/10/15 min, freie Eingabe). Empfehlung: Erweiterung A, weil sie billig ist und den Kochmodus erst wirklich bedienbar macht.

**Kein neues D1-Table, keine neuen Entities.** Der Sitzungsstatus des Kochmodus — aktueller Schritt, abgehakte Zutaten, Portionszahl, laufende Timer — ist **Sitzungsdaten, keine Geschäftsdaten**: Er lebt client-seitig (`localStorage` unter Schlüssel `(listId, recipeId)`). Vorteil: null Schema-Aufwand, null Sync-Overhead, und wer den Modus verlässt und wiederkommt, macht dort weiter, wo er war.

**Zutaten→Items-Zuordnung:** bewusst *locker* — beim „Auf die Liste“-Übertrag genügt die Stufe-1-Duplikat-Logik (normalisierter Name). Eine hart gepflegte Zuordnungstabelle `zutat ↔ itemId` wäre Wartungsaufwand ohne Alltagsnutzen, weil Items auf der Liste abgehakt und weggeräumt werden, während das Rezept bestehen bleibt.

### 7.5 Realtime-Sync: wo ja, wo nein

| Aspekt | Sync? | Begründung |
|---|---|---|
| Schritt-Fortschritt, abgehakte Zutaten, Portionen (Standard) | **Nein** | Einzelkoch-Fall. Client-seitiger Status reicht; DO-Sync wäre Aufweck-Overhead ohne Nutzen, und der Full-State-`sync`-Frame passt semantisch nicht auf Koch-Sitzungen. |
| Timer | **Nein** | Rein lokal (Interval + ggf. Notification API). Ein Timer muss nicht auf anderen Geräten klingeln. |
| „Gemeinsam kochen“ (Opt-in, später) | **Ja** | Paar/WG kocht dasselbe Rezept an zwei Geräten und will denselben Schritt, dieselbe Zutaten-Abhakliste, denselben geteilten Timer sehen. |
| Einkaufsliste während des Kochens | **bereits vorhanden** | Der bestehende Listen-Sync deckt das „Partner hakt im Laden ab“-Szenario vollständig ab. |

**Technische Skizze für „Gemeinsam kochen“:** Ephemerer Zustand im DO unter **separatem Storage-Key** `cooking:<recipeId>` (nicht im Listen-Blob — der bleibt schmal), Broadcast `{type:"cook-sync", …}` **ausschließlich an Sockets, deren Kochmodus offen ist**; Key wird nach einigen Stunden via DO-Alarm aufgeräumt. Aufwand **mittel**, klar abgegrenzt, und die Einkaufslisten-UI merkt nichts davon. Empfehlung: bewusst nicht in die erste Kochmodus-Version — erst Nutzungszahlen/Kundenfeedback abwarten, ob der Mehrspielerfall real vorkommt.

---

## 8. Fazit: die drei lohnendsten Features

1. **Duplikat-Zusammenführung + Auto-Aufräumen (Stufe 1):** Der beste Nutzen-im-Verhältnis-zum-Aufwand-Deal der ganzen Roadmap — zwei Alltagsreizpunkte (doppelte Items, wachsender „erledigt“-Berg) verschwinden, ohne dass ein einziges Bedienelement dazukommt. Erstnutzer-Test perfekt bestanden.
2. **Verlauf / „Zuletzt gekauft“ (Stufe 1):** Hebt den größten täglichen Reibungsverlust (ständiges Neu-Eintippen wöchentlicher Standardkäufe) bei fast null UI-Kosten — ein Sheet hinter einem Element, das schon da ist.
3. **Kochmodus (Stufe 2):** Das größte *sichtbare* Feature mit kalkulierbarem Risiko, weil es auf dem vorhandenen Rezept-Stack aufbaut (Datenmodell, KI-Generierung, „Auf die Liste“) und als eigene Route buchstäblich keinen Platz in der Hauptansicht kostet.

Damit gilt für die Roadmap insgesamt: Stufe 1 macht die App *besser, ohne sichtbar anders zu werden*; der Kochmodus ist der erste echte Zuwachs an Oberfläche — und er wächst genau dort, wo die App durch das bestehende Rezept-Feature ohnehin schon hingehört.

---

## 9. Umgesetzt (Stand 2026-08-30)

Die folgenden Vorschläge aus `docs/feature-roadmap.md` sowie dem Analyse-Papier
(`.kilo/plans/`) sind inzwischen umgesetzt und per `scripts/realtime-test.mjs` verifiziert:

- **Zutaten-Auswahl vor „Auf die Liste“** (Verfeinerung 7.2): Zutaten an-/abwählbar in der
  Rezept-Vorschau und in einem Sheet für gespeicherte Rezepte; nur Ausgewählte landen auf
  der Liste (`aufListe` im Save-Call).
- **Mitgliederverwaltung & Rollen** (Kapitel 6.3): Mitgliederliste im 👥-Sheet, Entfernen
  (nur Owner), Owner-Übertragung, Liste verlassen. Routen in `src/members.ts`.
- **Resteverwertung** (Analyse-Papier 2.1): `generate` akzeptiert `{zutaten: []}`; der
  Koch-Assistent hat einen Modus „Meine Zutaten“ mit Chips aus offenen Listeneinträgen.
- **Essens-Profil** (Analyse-Papier 4.1): Diätform + Allergene pro Nutzer
  (`user_preferences`, `src/preferences.ts`), fließen als Prompt-Vorgaben in Gemini ein.
- **PWA + Offline + Web Push** (Kapitel 6.2): Manifest, Icons, Service Worker mit
  App-Shell-Cache; Web Push nativ (VAPID + aes128gcm) mit Benachrichtigungen bei
  Listen-Änderungen (an die übrigen Mitglieder, ohne den Auslöser).

Noch offen aus der Roadmap: grobe Ausgaben-Erfassung (6.1), Magic-Link/OAuth (6.4),
Dark Mode (6.5), Aufgabenzuweisung, Meal-Planning, Vorratsverwaltung.

---

*Technische Nebenbaustelle am Rande (kein Feature): In `wrangler.jsonc` existiert eine unbenutzte Zweit-Bindung `buylist_db` auf dieselbe Datenbank — kann beim nächsten Anlass entfernt werden.*
