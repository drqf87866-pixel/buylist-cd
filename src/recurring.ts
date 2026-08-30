import { withAuth } from "./session";
import { isMember } from "./lists";
import { json, readJson } from "./util";
import type { Env } from "./types";

const MIN_INTERVALL_TAGE = 1;
const MAX_INTERVALL_TAGE = 365;

export interface RecurringItem {
  id: string;
  listId: string;
  name: string;
  menge: string | null;
  intervallTage: number;
  zuletztHinzugefuegt: number;
}

interface RecurringRow {
  id: string;
  list_id: string;
  name: string;
  menge: string | null;
  intervall_tage: number;
  zuletzt_hinzugefuegt: number;
}

function rowToRecurring(row: RecurringRow): RecurringItem {
  return {
    id: row.id,
    listId: row.list_id,
    name: row.name,
    menge: row.menge,
    intervallTage: row.intervall_tage,
    zuletztHinzugefuegt: row.zuletzt_hinzugefuegt,
  };
}

/** 404 statt 403, damit die Existenz fremder Listen nicht aufscheint. */
function notFound(): Response {
  return json({ error: "Liste nicht gefunden." }, 404);
}

async function checkListAccess(env: Env, listId: string, userId: string): Promise<boolean> {
  const member = await isMember(env.DB, listId, userId);
  if (!member) return false;
  const meta = await env.DB.prepare("SELECT 1 AS x FROM lists WHERE id = ?").bind(listId).first();
  return meta !== null;
}

/** GET /api/list/:id/recurring – alle Regeln einer Liste. */
export async function handleGetRecurring(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await checkListAccess(env, listId, user.id))) return notFound();

    const { results } = await env.DB.prepare(
      "SELECT id, list_id, name, menge, intervall_tage, zuletzt_hinzugefuegt FROM recurring_items WHERE list_id = ? ORDER BY created_at"
    )
      .bind(listId)
      .all<RecurringRow>();

    return json({ recurring: (results ?? []).map(rowToRecurring) });
  });
}

interface RecurringBody {
  name?: unknown;
  menge?: unknown;
  intervallTage?: unknown;
}

/** POST /api/list/:id/recurring – neue Regel anlegen. */
export async function handleCreateRecurring(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await checkListAccess(env, listId, user.id))) return notFound();

    const body = await readJson<RecurringBody>(request);
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
    if (!name) return json({ error: "Bitte gib einen Artikel an." }, 400);

    const menge =
      typeof body?.menge === "string" && body.menge.trim() ? body.menge.trim().slice(0, 40) : null;

    const intervallRaw = typeof body?.intervallTage === "number" ? Math.round(body.intervallTage) : NaN;
    if (!Number.isFinite(intervallRaw) || intervallRaw < MIN_INTERVALL_TAGE || intervallRaw > MAX_INTERVALL_TAGE) {
      return json({ error: `Das Intervall muss zwischen ${MIN_INTERVALL_TAGE} und ${MAX_INTERVALL_TAGE} Tagen liegen.` }, 400);
    }

    const now = Date.now();
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO recurring_items (id, list_id, name, menge, intervall_tage, zuletzt_hinzugefuegt, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(id, listId, name, menge, intervallRaw, now, user.id)
      .run();

    return json({
      recurring: { id, listId, name, menge, intervallTage: intervallRaw, zuletztHinzugefuegt: now } satisfies RecurringItem,
    });
  });
}

/** DELETE /api/list/:id/recurring/:ruleId – Regel löschen. */
export async function handleDeleteRecurring(request: Request, env: Env, listId: string, ruleId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await checkListAccess(env, listId, user.id))) return notFound();

    const result = await env.DB.prepare("DELETE FROM recurring_items WHERE id = ? AND list_id = ?")
      .bind(ruleId, listId)
      .run();
    if (!result.meta.changes) return notFound();

    return json({ ok: true });
  });
}

const TAG_MS = 86_400_000;

/**
 * Täglicher Cron-Lauf: findet fällige Regeln und fügt die Items über den
 * bestehenden DO-add-items-Pfad ein (Duplikat-Merge und Realtime-Sync greifen
 * automatisch). Danach wird zuletzt_hinzugefuegt aktualisiert.
 */
export async function runRecurringCron(env: Env): Promise<{ added: number }> {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    "SELECT id, list_id, name, menge, intervall_tage, zuletzt_hinzugefuegt FROM recurring_items WHERE zuletzt_hinzugefuegt + intervall_tage * ? <= ?"
  )
    .bind(TAG_MS, now)
    .all<RecurringRow>();

  const due = results ?? [];
  let added = 0;

  // Pro Liste ein add-items-Call statt pro Regel – der DO behandelt den Batch atomar.
  const byList = new Map<string, RecurringRow[]>();
  for (const row of due) {
    const bucket = byList.get(row.list_id);
    if (bucket) bucket.push(row);
    else byList.set(row.list_id, [row]);
  }

  const updatedIds: string[] = [];
  for (const [listId, rows] of byList) {
    const items = rows.map((r) => ({ name: r.name, ...(r.menge ? { menge: r.menge } : {}) }));
    try {
      const stub = env.SHOPPING_LIST_DO.get(env.SHOPPING_LIST_DO.idFromName(listId));
      const res = await stub.fetch("https://do/add-items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listId, displayName: "Wiederkehrend", items }),
      });
      if (!res.ok) {
        console.error("Cron: add-items fehlgeschlagen für Liste", listId, res.status);
        continue; // zuletzt_hinzugefuegt nicht anfassen → nächster Lauf versucht erneut
      }
      const data = (await res.json()) as { added?: number };
      added += data.added ?? 0;
    } catch (err) {
      console.error("Cron: DO-Fehler für Liste", listId, err);
      continue;
    }
    updatedIds.push(...rows.map((r) => r.id));
  }

  if (updatedIds.length) {
    await env.DB.prepare(
      `UPDATE recurring_items SET zuletzt_hinzugefuegt = ? WHERE id IN (${updatedIds.map(() => "?").join(",")})`
    )
      .bind(now, ...updatedIds)
      .run();
  }

  return { added };
}
