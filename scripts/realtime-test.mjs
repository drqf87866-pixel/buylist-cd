/**
 * Realtime-Smoke-Test gegen einen laufenden `wrangler dev` (Default: http://127.0.0.1:8787).
 *
 * Ablauf: zwei User registrieren/einloggen, Liste anlegen, User B tritt per
 * Invite-Token bei, dann WebSocket-Checks:
 *   1. beide Clients bekommen initiales sync
 *   2. add von A  -> sync bei A und B
 *   3. toggle von B -> sync bei A und B
 *   4. delete von A -> sync bei A und B, Liste leer
 *   5. Negativ: WS von User C (kein Mitglied) wird abgelehnt
 *
 * Ausführen: node scripts/realtime-test.mjs   (env: BASE_URL)
 */
import WebSocket from "ws";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const WS_BASE = BASE.replace(/^http/, "ws");

let failures = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ok: ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL: ${msg}`);
  }
}

async function registerAndLogin(email) {
  const password = "test-passwort-123";
  let res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, displayName: email.split("@")[0] }),
  });
  if (res.status !== 409) {
    assert(res.ok, `Registrierung ${email}`);
  }
  res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert(res.ok, `Login ${email}`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert(cookie.includes("bl_session="), `Session-Cookie gesetzt für ${email}`);
  return cookie;
}

async function api(cookie, path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { ...(opts.headers ?? {}), cookie },
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // ignore
  }
  return { status: res.status, data };
}

function connect(cookie, listId, label = "?") {
  const ws = new WebSocket(`${WS_BASE}/api/list/${listId}/ws`, { headers: { cookie } });
  // Nachrichten ab Connect an queued, damit nichts verloren geht, bevor ein
  // Listener registriert ist (das ws-Package droppt listenerlose Events).
  const queue = [];
  const waiters = [];
  ws.on("message", (data) => {
    const waiter = waiters.shift();
    if (waiter) waiter(JSON.parse(String(data)));
    else queue.push(JSON.parse(String(data)));
  });
  ws.on("close", (code) => console.log(`  [diag] ${label} ws geschlossen: code=${code}`));
  ws.on("error", (err) => console.log(`  [diag] ${label} ws error: ${err.message}`));
  return { ws, queue, waiters };
}

function waitFor(ws, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off(eventName, onEvent);
      reject(new Error(`Timeout beim Warten auf ${eventName}`));
    }, timeoutMs);
    function onEvent(arg) {
      clearTimeout(timer);
      ws.off(eventName, onEvent);
      resolve(arg);
    }
    ws.once(eventName, onEvent);
  });
}

/** Nächste sync-Nachricht aus der Queue des Clients (oder wartend darauf). */
async function nextSync(client, timeoutMs = 5000) {
  const { queue, waiters } = client;
  while (true) {
    const queued = queue.findIndex((m) => m.type === "sync");
    if (queued !== -1) return queue.splice(queued, 1)[0].list;
    const msg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout beim Warten auf sync")), timeoutMs);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
    if (msg.type === "sync") return msg.list;
  }
}

/** Nächste Nachricht aus der Queue des Clients, die `predicate` erfüllt. */
async function nextMessage(client, predicate, timeoutMs = 5000) {
  const { queue, waiters } = client;
  while (true) {
    const idx = queue.findIndex(predicate);
    if (idx !== -1) return queue.splice(idx, 1)[0];
    const msg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout beim Warten auf Nachricht")), timeoutMs);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
    if (predicate(msg)) return msg;
  }
}

const stamp = Date.now();
const emailA = `alice+${stamp}@example.com`;
const emailB = `bob+${stamp}@example.com`;
const emailC = `eve+${stamp}@example.com`;

console.log("== Setup: User, Liste, Beitritt ==");

const cookieA = await registerAndLogin(emailA);
const cookieB = await registerAndLogin(emailB);
const cookieC = await registerAndLogin(emailC);

const created = await api(cookieA, "/api/lists", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Testliste WG" }),
});
assert(created.status === 201, "Liste angelegt (201)");
const listId = created.data.list.id;

const invite = await api(cookieA, `/api/list/${listId}/invite`);
assert(invite.status === 200 && invite.data.url.includes("/join/"), "Invite-Link geholt");
const token = invite.data.url.split("/join/")[1];

const join = await api(cookieB, "/api/join", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token }),
});
assert(join.status === 200, "User B per Invite-Token beigetreten");

const listsB = await api(cookieB, "/api/lists");
assert(listsB.data.lists.some((l) => l.id === listId), "Liste erscheint in Übersicht von B");

console.log("== Negativ-Checks (REST) ==");

assert((await api(null, "/api/lists")).status === 401, "GET /api/lists ohne Session -> 401");
assert((await api(cookieC, `/api/list/${listId}/snapshot`)).status === 404, "Snapshot fremder Liste (Nicht-Mitglied) -> 404");
assert((await api(cookieA, "/api/join", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: "gibtsnicht" }),
})).status === 404, "Join mit ungültigem Token -> 404");

console.log("== WebSocket-Realtime ==");

const clientA = connect(cookieA, listId, "A");
const clientB = connect(cookieB, listId, "B");
const wsA = clientA.ws;
const wsB = clientB.ws;

const openA = waitFor(wsA, "open");
const openB = waitFor(wsB, "open");
await Promise.all([openA, openB]);
assert(true, "WS von A und B verbunden");

const initA = await nextSync(clientA);
const initB = await nextSync(clientB);
assert(initA.items.length === 0 && initB.items.length === 0, "Beide bekommen initiales sync (leere Liste)");

wsA.send(JSON.stringify({ type: "add", name: "Milch", menge: "2× 500g" }));
const syncA1 = await nextSync(clientA);
const syncB1 = await nextSync(clientB);
assert(syncA1.items.length === 1 && syncA1.items[0].name === "Milch", "add: sync bei A");
  assert(syncB1.items.length === 1 && syncB1.items[0].menge === "2× 500g", "add: sync bei B (inkl. Menge)");
  assert(
    syncB1.items[0].hinzugefuegtVon.startsWith("alice"),
    `add: hinzugefuegtVon = displayName von A (${syncB1.items[0].hinzugefuegtVon})`
  );

const itemId = syncA1.items[0].id;
wsB.send(JSON.stringify({ type: "toggle", itemId, erledigt: true }));
const syncA2 = await nextSync(clientA);
const syncB2 = await nextSync(clientB);
assert(syncA2.items[0].erledigt === true, "toggle: sync bei A");
assert(syncB2.items[0].erledigt === true, "toggle: sync bei B");

wsA.send(JSON.stringify({ type: "delete", itemId }));
const syncA3 = await nextSync(clientA);
const syncB3 = await nextSync(clientB);
assert(syncA3.items.length === 0, "delete: sync bei A (Liste leer)");
assert(syncB3.items.length === 0, "delete: sync bei B (Liste leer)");

// State bleibt erhalten: weiterer Artikel über dieselbe Verbindung ...
wsA.send(JSON.stringify({ type: "add", name: "Kaffee" }));
const persisted = await nextSync(clientA);
assert(persisted.items.length === 1 && persisted.items[0].name === "Kaffee", "Item vor Persistenz-Check hinzugefügt");
await new Promise((r) => setTimeout(r, 300));
wsA.close();
wsB.close();

const clientA2 = connect(cookieA, listId, "A2");
await waitFor(clientA2.ws, "open");
const reconnected = await nextSync(clientA2);
assert(reconnected.items.length === 1 && reconnected.items[0].name === "Kaffee", "State nach Reconnect erhalten (DO-Storage)");
clientA2.ws.close();

// Nicht-Mitglied wird abgelehnt
const clientC = connect(cookieC, listId, "C");
const wsCResult = await Promise.race([
  waitFor(clientC.ws, "error").then(() => "rejected"),
  waitFor(clientC.ws, "open").then(() => "opened"),
]);
assert(wsCResult === "rejected", "WS von Nicht-Mitglied abgelehnt");
try {
  clientC.ws.close();
} catch {
  // ignore
}

console.log("== Neue Features: Mitglieder, Präferenzen, Zutaten-Generate, Push ==");

const members = await api(cookieA, `/api/list/${listId}/members`);
assert(
  members.status === 200 &&
    typeof members.data.ownerId === "string" &&
    members.data.members.some((m) => m.id === members.data.ownerId && m.role === "owner") &&
    members.data.members.length === 2,
  "Mitglieder auflisten (Owner A + B als Member, ownerId gesetzt)"
);

// Mitglied ohne Owner-Rechte kann nicht entfernen
const memberRemoveForbidden = await api(cookieB, `/api/list/${listId}/members`, {
  method: "DELETE",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ userId: emailC }),
});
assert(memberRemoveForbidden.status === 403, "Nicht-Owner kann kein Mitglied entfernen (403)");

// Owner kann kein Mitglied entfernen, das Owner ist (A entfernt A selbst)
const selfRemove = await api(cookieA, `/api/list/${listId}/members`, {
  method: "DELETE",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ userId: (await api(cookieA, "/api/auth/me")).data.user.id }),
});
assert(selfRemove.status === 400, "Owner kann sich nicht selbst entfernen (400)");

// Präferenzen speichern & lesen
const prefsSave = await api(cookieA, "/api/preferences", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ diaet: "vegan", allergene: ["Erdnüsse", "Gluten"] }),
});
assert(prefsSave.status === 200 && prefsSave.data.preferences.diaet === "vegan", "Präferenzen speichern");
const prefsGet = await api(cookieA, "/api/preferences");
assert(
  prefsGet.status === 200 &&
    prefsGet.data.preferences.allergene.includes("Gluten") &&
    prefsGet.data.preferences.diaet === "vegan",
  "Präferenzen lesen (Allergene + Diät)"
);

// Zutaten-Generierung: Route muss antworten. Mit konfiguriertem Key kommt 200
// (Gemini antwortet), ohne Key 500/502, bei Freelimit-Erschöpfung 429.
const generateIngredients = await api(cookieA, `/api/list/${listId}/generate`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ zutaten: ["Milch", "Eier", "Mehl"], portionen: 2 }),
});
assert(
  [200, 429, 500, 502].includes(generateIngredients.status),
  `Zutaten-Generate: Route antwortet (${generateIngredients.status})`
);

// Tagesvorschläge: ohne Session 401; mit Session antwortet die Route (200 mit
// 5 Gerichten bei konfiguriertem Key, sonst 429/500/502 je nach Key/Limit).
assert((await api(null, "/api/suggestions")).status === 401, "GET /api/suggestions ohne Session -> 401");
const suggestionsGet = await api(cookieA, "/api/suggestions");
assert(
  [200, 429, 500, 502].includes(suggestionsGet.status),
  `GET /api/suggestions: Route antwortet (${suggestionsGet.status})`
);
if (suggestionsGet.status === 200) {
  assert(
    Array.isArray(suggestionsGet.data.vorschlaege) && suggestionsGet.data.vorschlaege.length === 5,
    "Vorschläge: genau 5 Gerichte"
  );
}
const suggestionsRefresh = await api(cookieA, "/api/suggestions/refresh", { method: "POST" });
assert(
  [200, 429, 500, 502].includes(suggestionsRefresh.status),
  `POST /api/suggestions/refresh: Route antwortet (${suggestionsRefresh.status})`
);

// Push: Route liefert den Konfigurationsstand (je nach lokalem .dev.vars)
const vapid = await api(cookieA, "/api/push/vapid-key");
assert(
  vapid.status === 200 && typeof vapid.data.configured === "boolean",
  `VAPID-Key-Route antwortet (configured: ${vapid.data?.configured})`
);

// Owner-Übertragung: B wird Owner, A Member
const transfer = await api(cookieA, `/api/list/${listId}/owner`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ userId: (await api(cookieB, "/api/auth/me")).data.user.id }),
});
assert(transfer.status === 200, "Owner-Übertragung an B ok");
const membersAfter = await api(cookieB, `/api/list/${listId}/members`);
assert(
  membersAfter.data.members.some((m) => m.role === "owner" && m.email.includes("bob+")),
  "Nach Übertragung ist B Owner"
);

console.log("== Gerichte: Sammlung, Zuschalten, Abschalten ==");

const clientGA = connect(cookieA, listId, "A-Gerichte");
const clientGB = connect(cookieB, listId, "B-Gerichte");
await Promise.all([waitFor(clientGA.ws, "open"), waitFor(clientGB.ws, "open")]);
const gInit = await nextSync(clientGA);
await nextSync(clientGB); // Init-Sync von B abholen, damit die Sync-Folge aligned bleibt
assert(gInit.items.length === 1 && gInit.items[0].name === "Kaffee", "Gerichte-Setup: 1 offenes Item (Kaffee) aus vorherigem Abschnitt");

// Rezept speichern – landet nur in der Sammlung, nicht auf der Liste
const saveRes = await api(cookieA, `/api/list/${listId}/recipes`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    titel: "Spaghetti Carbonara",
    zeit: "ca. 25 Minuten",
    portionen: 4,
    zutaten: [
      { name: "Spaghetti", menge: "500 g" },
      { name: "Eier", menge: "4" },
      { name: "Parmesan", menge: "100 g" },
    ],
    schritte: [{ text: "Nudeln kochen", timerSekunden: 480 }, "Eier und Parmesan verrühren"],
  }),
});
assert(saveRes.status === 201 && typeof saveRes.data.rezept?.id === "string", "Rezept gespeichert (201, id)");
assert(saveRes.data.added === undefined, "Speichern pusht nicht mehr auf die Liste (kein added)");
const gerichtId = saveRes.data.rezept.id;

const sammlung = await api(cookieB, "/api/recipes");
assert(
  sammlung.status === 200 && sammlung.data.rezepte.some((r) => r.id === gerichtId),
  "Gericht erscheint in der Sammlung von B (alle eigenen Listen, unabhängig vom Ersteller)"
);

const snapAfterSave = await api(cookieA, `/api/list/${listId}/snapshot`);
assert(snapAfterSave.data.items.length === 1, "Speichern legt keine Artikel auf die Liste");

// Zuschalten durch B (nicht der Ersteller) mit Zutaten-Subset „habe ich schon“
const zuschaltenBody = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ gerichte: [{ id: gerichtId, nur: ["Spaghetti", "Eier"] }] }),
};
const zuschalten = await api(cookieB, `/api/list/${listId}/gerichte`, zuschaltenBody);
assert(zuschalten.status === 200 && zuschalten.data.added === 2, "Zuschalten: 2 Zutaten (Subset) als Artikel");

const syncGA1 = await nextSync(clientGA);
const syncGB1 = await nextSync(clientGB);
assert(
  syncGA1.aktiveGerichte?.length === 1 && syncGA1.aktiveGerichte[0].id === gerichtId,
  "Zuschalten: aktiveGerichte im Live-Sync bei A"
);
assert(syncGB1.aktiveGerichte?.length === 1, "Zuschalten: aktiveGerichte im Live-Sync bei B");
const quelleItems = syncGA1.items.filter((i) => i.quelle?.id === gerichtId);
assert(
  quelleItems.length === 2 && quelleItems.every((i) => !i.erledigt && i.quelle.typ === "gericht"),
  "Zuschalten: Zutaten tragen das quelle-Tag"
);

// Idempotenz: erneutes Zuschalten ändert nichts
const nochmal = await api(cookieB, `/api/list/${listId}/gerichte`, zuschaltenBody);
assert(nochmal.status === 200 && nochmal.data.added === 0, "Erneutes Zuschalten ist idempotent (added 0)");
const snapIdem = await api(cookieA, `/api/list/${listId}/snapshot`);
assert(
  snapIdem.data.items.filter((i) => i.quelle?.id === gerichtId).length === 2 &&
    snapIdem.data.aktiveGerichte?.length === 1,
  "Keine doppelten Zutaten/Zustände nach erneutem Zuschalten"
);

// Duplikat-Merge: „Kaffee“ (von Hand) + Gericht mit „Kaffee“-Zutat würde mergen –
// hier stattdessen: eine Gerichte-Zutat abhaken, dann abschalten.
const eggItem = snapIdem.data.items.find((i) => i.quelle?.id === gerichtId && i.name === "Eier");
clientGB.ws.send(JSON.stringify({ type: "toggle", itemId: eggItem.id, erledigt: true }));
await nextSync(clientGA);
await nextSync(clientGB);

const abschalten = await api(cookieA, `/api/list/${listId}/gerichte/${gerichtId}`, { method: "DELETE" });
assert(abschalten.status === 200 && abschalten.data.removed === 1, "Abschalten: nur offene Zutat entfernt (removed 1)");

const syncGA2 = await nextSync(clientGA);
const syncGB2 = await nextSync(clientGB);
assert(syncGA2.aktiveGerichte?.length === 0 && syncGB2.aktiveGerichte?.length === 0, "Abschalten: Zustand bei beiden geleert");
assert(
  syncGA2.items.some((i) => i.id === eggItem.id && i.erledigt),
  "Abschalten: abgehakte Zutat bleibt liegen (Verlauf/Aufräumen greifen)"
);
assert(!syncGA2.items.some((i) => i.quelle?.id === gerichtId && !i.erledigt), "Abschalten: keine offenen Gerichte-Items mehr");

// Negativ: Nicht-Mitglied C darf nicht zuschalten
const negativGericht = await api(cookieC, `/api/list/${listId}/gerichte`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ gerichte: [{ id: gerichtId }] }),
});
assert(negativGericht.status === 404, "Zuschalten durch Nicht-Mitglied -> 404");

// Undo-Re-Add: WS-Add mit quelle-Tag muss die Gericht-Herkunft übernehmen
// (Review-Fix: Undo nach Löschen verliert das quelle-Tag nicht mehr).
clientGB.ws.send(JSON.stringify({
  type: "add",
  name: "UndoKäse",
  menge: "200 g",
  quelle: { typ: "gericht", id: "r-undofix", titel: "Review-Fix" },
}));
const syncQ1 = await nextSync(clientGA);
await nextSync(clientGB);
const quelleItem = syncQ1.items.find((i) => i.name === "UndoKäse");
assert(
  quelleItem?.quelle?.typ === "gericht" && quelleItem?.quelle?.id === "r-undofix",
  "WS-Add übernimmt das quelle-Tag (Undo-Fix)"
);

clientGA.ws.close();
clientGB.ws.close();

console.log("== Liste löschen (nur Owner) ==");

// A ist jetzt Member und darf nicht löschen
const memberDelete = await api(cookieA, `/api/list/${listId}`, { method: "DELETE" });
assert(memberDelete.status === 403, "Nicht-Owner darf Liste nicht löschen (403)");

// Ein WS von B bleibt offen, um den deleted-Broadcast beim Löschen zu prüfen.
// Waiter vor dem Delete registrieren – Message und Close kommen während des Deletes.
const clientDel = connect(cookieB, listId, "B-del");
await waitFor(clientDel.ws, "open");
const deletedMsgPromise = nextMessage(clientDel, (m) => m.type === "deleted");

// B ist Owner und löscht die Liste
const ownerDelete = await api(cookieB, `/api/list/${listId}`, { method: "DELETE" });
assert(ownerDelete.status === 200 && ownerDelete.data.ok === true, "Owner löscht die Liste (200)");

const deletedMsg = await deletedMsgPromise;
assert(deletedMsg.type === "deleted", "Offenes Member-WS erhält deleted-Broadcast");

// Der Server initiiert den Close (der lokale Simulator schließt den
// Handshake nicht vollständig – Zustand CLOSING reicht als Beleg).
await new Promise((r) => setTimeout(r, 300));
assert(
  clientDel.ws.readyState === WebSocket.CLOSING || clientDel.ws.readyState === WebSocket.CLOSED,
  "Server hat das Member-WS nach dem deleted-Broadcast zum Schließen gebracht"
);
try {
  clientDel.ws.terminate();
} catch {
  // ignore
}

// Erneuter Verbindungsversuch nach dem Löschen wird abgelehnt (kein Reconnect-Loop)
const clientAfter = connect(cookieB, listId, "B-after");
const wsAfterResult = await Promise.race([
  waitFor(clientAfter.ws, "error").then(() => "rejected"),
  waitFor(clientAfter.ws, "open").then(() => "opened"),
]);
assert(wsAfterResult === "rejected", "WS-Verbindung nach dem Löschen wird abgelehnt");
try {
  clientAfter.ws.close();
} catch {
  // ignore
}

// Danach ist die Liste für alle Beteiligten weg (404), auch im DO/Persistenzpfad
assert((await api(cookieA, `/api/list/${listId}/snapshot`)).status === 404, "Snapshot nach Löschen -> 404 (A)");
assert((await api(cookieB, `/api/list/${listId}/snapshot`)).status === 404, "Snapshot nach Löschen -> 404 (B)");
assert((await api(cookieA, `/api/list/${listId}/members`)).status === 404, "Mitglieder nach Löschen -> 404");
const listsAafter = await api(cookieA, "/api/lists");
const listsBafter = await api(cookieB, "/api/lists");
assert(
  !listsAafter.data.lists.some((l) => l.id === listId) &&
    !listsBafter.data.lists.some((l) => l.id === listId),
  "Gelöschte Liste taucht in keiner Übersicht mehr auf"
);

console.log(failures === 0 ? "\nALLE TESTS OK ✅" : `\n${failures} TEST(S) FEHLGESCHLAGEN ❌`);
process.exit(failures === 0 ? 0 : 1);
