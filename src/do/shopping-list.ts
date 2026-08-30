import { json } from "../util";
import { sendPushToUser } from "../push";
import type { Env, HistoryEntry, ShoppingItem, ShoppingList } from "../types";

const STORAGE_KEY = "list";

// Auto-Aufräumen: erledigte Artikel verschwinden 24 h nach dem Abhaken
// (Kaufdatum ist bis dahin im Verlauf „Zuletzt gekauft“ verbucht).
const CLEANUP_AFTER_MS = 24 * 60 * 60 * 1000;
const HISTORY_MAX = 100;
const MENGE_MAX = 80;

/** Normalisierter Vergleichsschlüssel für Duplikate: „  Milch “ == „milch“. */
function normKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Freitext-Mengen anreichern statt überschreiben: „500 g“ + „1 l“ wird
 * „500 g · +1 l“. Gleiche Menge wird verworfen, das Feld bleibt klein.
 */
function mergeMenge(existing: string | undefined, incoming: string | undefined): string | undefined {
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (existing.toLowerCase() === incoming.toLowerCase()) return existing;
  const base = existing.split(" · ")[0];
  const additions = existing
    .split(" · ")
    .slice(1)
    .filter((p) => p.toLowerCase() !== `+${incoming.toLowerCase()}`);
  const next = [base, ...additions, `+${incoming}`].join(" · ");
  return next.length <= MENGE_MAX ? next : `${base} · +${incoming}`;
}

function upsertHistory(list: ShoppingList, item: ShoppingItem): void {
  const key = normKey(item.name);
  const history: HistoryEntry[] = (list.history ?? []).filter((h) => normKey(h.name) !== key);
  history.unshift({ name: item.name, menge: item.menge, gekauftAm: item.gekauftAm ?? Date.now() });
  list.history = history.slice(0, HISTORY_MAX);
}

function removeFromHistory(list: ShoppingList, item: ShoppingItem): void {
  // Eintrag nur wegnehmen, wenn nicht noch ein weiteres abgehaktes Item denselben Namen trägt.
  const key = normKey(item.name);
  const stillChecked = list.items.some(
    (i) => i.erledigt && i.id !== item.id && normKey(i.name) === key
  );
  if (stillChecked) return;
  list.history = (list.history ?? []).filter((h) => normKey(h.name) !== key);
}

interface WsMeta {
  userId: string;
  displayName: string;
}

interface InitBody {
  listId: string;
  name: string;
}

interface AddItemsBody {
  listId: string;
  displayName: string;
  items: { name?: unknown; menge?: unknown; kategorie?: unknown }[];
}

/** Freitext-Kategorie sichern; fehlt/leer = undefined (= „Sonstiges“). */
function sanitizeKategorie(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 40) : undefined;
}

/**
 * Ein Durable Object pro Einkaufsliste: hält den aktuellen Listenzustand im
 * Memory (und persistent im SQLite-backed DO-Storage) und broadcastet jede
 * Änderung an alle verbundenen WebSocket-Clients (Hibernation API – das DO
 * schläft bei Inaktivität, "ping" wird per Auto-Response beantwortet).
 */
export class ShoppingListDO {
  // undefined = noch nicht geladen, null = geladen und leer
  private cached: ShoppingList | null | undefined = undefined;

  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {
    // Heartbeat ohne Wake-up: "ping" vom Client beantwortet die Runtime direkt.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/init": {
        const body = (await request.json()) as InitBody;
        await this.ensureList(body.listId, body.name);
        return json({ ok: true });
      }
      case "/snapshot": {
        const list = await this.ensureList(
          url.searchParams.get("id") ?? crypto.randomUUID(),
          url.searchParams.get("name") ?? "Einkaufsliste"
        );
        return json(list);
      }
      case "/add-items": {
        return this.handleAddItems(request);
      }
      case "/destroy": {
        return this.handleDestroy();
      }
      case "/ws": {
        return this.handleWs(request, url);
      }
      default:
        return json({ error: "Not Found" }, 404);
    }
  }

  /**
   * Fügt mehrere Artikel auf einmal hinzu (z. B. Zutaten eines generierten
   * Rezepts) und broadcastet genau einmal, damit alle Clients synchron bleiben.
   */
  private async handleAddItems(request: Request): Promise<Response> {
    let body: AddItemsBody;
    try {
      body = (await request.json()) as AddItemsBody;
    } catch {
      return json({ error: "Ungültiger Body." }, 400);
    }

    const displayName = body.displayName || "Unbekannt";
    const incoming = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
    const list = await this.ensureList(
      body.listId ?? crypto.randomUUID(),
      "Einkaufsliste"
    );

    let changed = false;
    let added = 0;
    let newItemName: string | undefined;
    for (const raw of incoming) {
      const name = typeof raw?.name === "string" ? raw.name.trim().slice(0, 120) : "";
      if (!name) continue;
      const menge =
        typeof raw?.menge === "string" && raw.menge.trim() ? raw.menge.trim().slice(0, 40) : undefined;
      const kategorie = sanitizeKategorie(raw?.kategorie);
      if (this.mergeOrAdd(list, name, menge, kategorie, displayName)) added += 1;
      newItemName = name;
      changed = true;
    }

    if (!changed) return json({ error: "Keine gültigen Artikel." }, 400);

    this.cached = list;
    await this.state.storage.put(STORAGE_KEY, list);
    await this.ensureAlarm(list);
    this.broadcast(list);
    if (newItemName) {
      await this.notifyMembers(
        list.id,
        null,
        "Neuer Artikel",
        `„${newItemName}“ wurde auf die Liste gesetzt (${displayName}).`,
        `/list/${list.id}`
      );
    }
    return json({ ok: true, added });
  }

  /**
   * Duplikat-Zusammenführung: existiert der Artikel (normalisierter Name) noch
   * offen, wird nur die Menge angereichert, eine fehlende Kategorie ergänzt und
   * der Artikel nach hinten sortiert (timestamp = sichtbares Lebenszeichen).
   * Sonst landet er neu auf der Liste.
   */
  private mergeOrAdd(
    list: ShoppingList,
    name: string,
    menge: string | undefined,
    kategorie: string | undefined,
    displayName: string
  ): boolean {
    const key = normKey(name);
    const existing = list.items.find((i) => !i.erledigt && normKey(i.name) === key);
    if (existing) {
      existing.menge = mergeMenge(existing.menge, menge);
      if (!existing.kategorie && kategorie) existing.kategorie = kategorie;
      existing.timestamp = Date.now();
      return false;
    }
    list.items.push({
      id: crypto.randomUUID(),
      name,
      menge,
      kategorie,
      erledigt: false,
      hinzugefuegtVon: displayName,
      timestamp: Date.now(),
    });
    return true;
  }

  private async getList(): Promise<ShoppingList | null> {
    if (this.cached === undefined) {
      this.cached = (await this.state.storage.get<ShoppingList>(STORAGE_KEY)) ?? null;
    }
    return this.cached;
  }

  private async ensureList(id: string, name: string): Promise<ShoppingList> {
    const existing = await this.getList();
    if (existing) return existing;
    const list: ShoppingList = { id, name, items: [] };
    this.cached = list;
    await this.state.storage.put(STORAGE_KEY, list);
    return list;
  }

  /**
   * Löscht den gesamten DO-State (Listen-Items, Verlauf, Alarme) und trennt
   * alle verbundenen Clients mit einer "deleted"-Nachricht, damit sie die
   * Liste verlassen statt in eine Reconnect-Schleife zu laufen.
   */
  private async handleDestroy(): Promise<Response> {
    await this.state.storage.deleteAlarm();
    const payload = JSON.stringify({ type: "deleted" });
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // Tote Verbindungen räumt webSocketClose/-error auf.
      }
      try {
        socket.close(1000, "list deleted");
      } catch {
        // schon zu
      }
    }
    await this.state.storage.deleteAll();
    this.cached = null;
    return json({ ok: true });
  }

  private async handleWs(request: Request, url: URL): Promise<Response> {
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
      return json({ error: "WebSocket-Upgrade erwartet." }, 426);
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    this.state.acceptWebSocket(server);

    const meta: WsMeta = {
      // Der Worker setzt diese Header serverseitig nach Session- und
      // Membership-Prüfung; eingehende Client-Werte werden vorher entfernt.
      userId: request.headers.get("x-user-id") ?? "",
      displayName: request.headers.get("x-display-name") || "Unbekannt",
    };
    server.serializeAttachment(meta);

    const list = await this.ensureList(
      url.searchParams.get("id") ?? crypto.randomUUID(),
      url.searchParams.get("name") ?? "Einkaufsliste"
    );
    server.send(JSON.stringify({ type: "sync", list }));

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message === "ping") return;

    let msg: { type?: string; itemId?: string; name?: string; menge?: string; kategorie?: string; erledigt?: boolean };
    try {
      msg = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Ungültige Nachricht." }));
      return;
    }

    const list = await this.getList();
    if (!list) return;

    const meta = ws.deserializeAttachment() as WsMeta | null;
    const triggerUserId = meta?.userId ?? null;
    const triggerName = meta?.displayName ?? "Unbekannt";

    let changed = false;
    let notifyTitle: string | null = null;
    let notifyBody: string | null = null;

    if (msg.type === "add") {
      const name = typeof msg.name === "string" ? msg.name.trim().slice(0, 120) : "";
      if (!name) {
        ws.send(JSON.stringify({ type: "error", message: "Der Artikel braucht einen Namen." }));
        return;
      }
      const menge =
        typeof msg.menge === "string" && msg.menge.trim() ? msg.menge.trim().slice(0, 40) : undefined;
      this.mergeOrAdd(list, name, menge, sanitizeKategorie(msg.kategorie), triggerName);
      changed = true;
      notifyTitle = "Neuer Artikel";
      notifyBody = `„${name}“ wurde auf die Liste gesetzt (${triggerName}).`;
    } else if (msg.type === "toggle") {
      const item = list.items.find((i) => i.id === msg.itemId);
      if (item && typeof msg.erledigt === "boolean" && item.erledigt !== msg.erledigt) {
        item.erledigt = msg.erledigt;
        if (msg.erledigt) {
          // Abhaken = gekauft: Kaufzeitstempel merken (Auto-Aufräumen) und Verlauf füttern.
          item.gekauftAm = Date.now();
          upsertHistory(list, item);
          notifyTitle = "Erledigt";
          notifyBody = `„${item.name}“ wurde abgehakt (${triggerName}).`;
        } else {
          delete item.gekauftAm;
          removeFromHistory(list, item);
        }
        changed = true;
      }
    } else if (msg.type === "delete") {
      const before = list.items.length;
      list.items = list.items.filter((i) => i.id !== msg.itemId);
      changed = list.items.length !== before;
      // Der Verlauf bleibt beim Löschen bewusst erhalten – er ist Gedächtnis,
      // kein Spiegel der aktuellen Liste.
    }

    if (!changed) return;

    this.cached = list;
    await this.state.storage.put(STORAGE_KEY, list);
    await this.ensureAlarm(list);
    this.broadcast(list);
    if (notifyTitle && notifyBody) {
      await this.notifyMembers(list.id, triggerUserId, notifyTitle, notifyBody, `/list/${list.id}`);
    }
  }

  /**
   * Plant genau einen Alarm auf den Zeitpunkt, an dem der älteste erledigte
   * Artikel aufgeräumt werden darf; ohne erledigte Artikel wird der Alarm
   * entfernt.
   */
  private async ensureAlarm(list: ShoppingList): Promise<void> {
    const checked = list.items.filter((i) => i.erledigt);
    if (!checked.length) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const oldest = Math.min(...checked.map((i) => i.gekauftAm ?? i.timestamp));
    const due = Math.max(oldest + CLEANUP_AFTER_MS, Date.now() + 1000);
    const current = await this.state.storage.getAlarm();
    if (current === null || Math.abs(current - due) > 5000) {
      await this.state.storage.setAlarm(due);
    }
  }

  /** Auto-Aufräumen: erledigte Artikel nach 24 h aus der Liste nehmen. */
  async alarm(): Promise<void> {
    const list = await this.getList();
    if (!list) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const cutoff = Date.now() - CLEANUP_AFTER_MS;
    const before = list.items.length;
    list.items = list.items.filter((i) => !(i.erledigt && (i.gekauftAm ?? i.timestamp) <= cutoff));
    if (list.items.length !== before) {
      this.cached = list;
      await this.state.storage.put(STORAGE_KEY, list);
      this.broadcast(list);
    }
    await this.ensureAlarm(list);
  }

  async webSocketClose(_ws: WebSocket): Promise<void> {
    // Client getrennt – der Listenzustand liegt im Storage, nichts zu tun.
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error("ShoppingListDO: WebSocket-Fehler", error);
  }

  private broadcast(list: ShoppingList): void {
    const payload = JSON.stringify({ type: "sync", list });
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // Tote Verbindungen räumt webSocketClose/-error auf.
      }
    }
  }

  /**
   * Web-Push an die übrigen Mitglieder der Liste (ohne den Auslöser), damit
   * der Partner im Laden mitbekommt, wenn jemand etwas geändert hat. Ohne
   * VAPID-Key oder ohne Subscriptions ist es ein No-Op; Fehler werden isoliert
   * und blockieren den Sync nicht.
   */
  private async notifyMembers(
    listId: string,
    triggerUserId: string | null,
    title: string,
    body: string,
    url: string
  ): Promise<void> {
    if (!this.env.VAPID_PUBLIC_KEY || !this.env.VAPID_PRIVATE_KEY) return;
    try {
      const { results } = await this.env.DB.prepare(
        `SELECT user_id FROM list_memberships WHERE list_id = ? AND user_id != ?`
      )
        .bind(listId, triggerUserId ?? "")
        .all<{ user_id: string }>();
      if (!results?.length) return;
      // Nacheinander senden (jeder Nutzer hat wenige Subscriptions); Fehler isolieren.
      for (const row of results) {
        await sendPushToUser(this.env, row.user_id, title, body, url).catch((err) => {
          console.error("Push an Mitglied fehlgeschlagen:", err);
        });
      }
    } catch (err) {
      console.error("Push-Benachrichtigung fehlgeschlagen:", err);
    }
  }
}
