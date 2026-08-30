import { randomToken } from "./crypto";
import { withAuth } from "./session";
import { json, readJson } from "./util";
import type { Env, PublicUser } from "./types";

interface ListRow {
  id: string;
  name: string;
  owner_id: string;
  invite_token: string;
  created_at: number;
}

export async function isMember(db: D1Database, listId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS x FROM list_memberships WHERE list_id = ? AND user_id = ?")
    .bind(listId, userId)
    .first();
  return row !== null;
}

export async function getRole(db: D1Database, listId: string, userId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT role FROM list_memberships WHERE list_id = ? AND user_id = ?")
    .bind(listId, userId)
    .first<{ role: string }>();
  return row?.role ?? null;
}

export async function getListMeta(db: D1Database, listId: string): Promise<ListRow | null> {
  return db
    .prepare("SELECT id, name, owner_id, invite_token, created_at FROM lists WHERE id = ?")
    .bind(listId)
    .first<ListRow>();
}

/** 404 statt 403, damit die Existenz fremder Listen nicht aufscheint. */
function notFound(): Response {
  return json({ error: "Liste nicht gefunden." }, 404);
}

export async function handleGetLists(request: Request, env: Env): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    const { results } = await env.DB.prepare(
      `SELECT l.id, l.name, l.owner_id AS ownerId, u.display_name AS ownerName,
              l.created_at AS createdAt,
              (SELECT COUNT(*) FROM list_memberships m2 WHERE m2.list_id = l.id) AS memberCount
       FROM lists l
       JOIN list_memberships m ON m.list_id = l.id AND m.user_id = ?
       JOIN users u ON u.id = l.owner_id
       ORDER BY l.created_at DESC`
    )
      .bind(user.id)
      .all();
    return json({ lists: results });
  });
}

export async function handleCreateList(request: Request, env: Env): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    const body = await readJson<{ name?: string }>(request);
    const name = (body?.name ?? "").trim().slice(0, 80);
    if (!name) return json({ error: "Bitte gib der Liste einen Namen." }, 400);

    const id = crypto.randomUUID();
    const inviteToken = randomToken(16);
    const now = Date.now();

    await env.DB.batch([
      env.DB.prepare("INSERT INTO lists (id, name, owner_id, invite_token, created_at) VALUES (?, ?, ?, ?, ?)").bind(
        id,
        name,
        user.id,
        inviteToken,
        now
      ),
      env.DB.prepare("INSERT INTO list_memberships (list_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").bind(
        id,
        user.id,
        now
      ),
    ]);

    // Zugehöriges Durable Object initialisieren (State bleibt dort persistent)
    const stub = env.SHOPPING_LIST_DO.get(env.SHOPPING_LIST_DO.idFromName(id));
    await stub.fetch("https://do/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listId: id, name }),
    });

    return json({ list: { id, name, ownerId: user.id, createdAt: now } }, 201);
  });
}

export async function handleSnapshot(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    const meta = await getListMeta(env.DB, listId);
    if (!meta || !(await isMember(env.DB, listId, user.id))) return notFound();

    const stub = env.SHOPPING_LIST_DO.get(env.SHOPPING_LIST_DO.idFromName(listId));
    return stub.fetch(`https://do/snapshot?id=${encodeURIComponent(listId)}&name=${encodeURIComponent(meta.name)}`);
  });
}

export async function handleInvite(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    const meta = await getListMeta(env.DB, listId);
    if (!meta || !(await isMember(env.DB, listId, user.id))) return notFound();

    const origin = new URL(request.url).origin;
    return json({ url: `${origin}/join/${meta.invite_token}` });
  });
}

export async function handleJoin(request: Request, env: Env): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }: { user: PublicUser }) => {
    const body = await readJson<{ token?: string }>(request);
    const token = (body?.token ?? "").trim();
    if (!token) return json({ error: "Dieser Einladungslink ist ungültig." }, 400);

    const list = await env.DB
      .prepare("SELECT id, name FROM lists WHERE invite_token = ?")
      .bind(token)
      .first<{ id: string; name: string }>();
    if (!list) return json({ error: "Dieser Einladungslink ist ungültig." }, 404);

    await env.DB
      .prepare("INSERT OR IGNORE INTO list_memberships (list_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)")
      .bind(list.id, user.id, Date.now())
      .run();

    return json({ list });
  });
}

/**
 * Wirft den Durable-Object-State einer Liste best-effort weg (inkl.
 * deleted-Broadcast an offene Clients). Fehler nur loggen – ein verwaister
 * DO-State ist nach dem D1-Delete für die API nicht mehr erreichbar.
 */
export async function destroyListDoState(env: Env, listId: string): Promise<void> {
  try {
    const stub = env.SHOPPING_LIST_DO.get(env.SHOPPING_LIST_DO.idFromName(listId));
    await stub.fetch("https://do/destroy", { method: "POST" });
  } catch (err) {
    console.error("DO-destroy fehlgeschlagen:", err);
  }
}

/**
 * Löscht die D1-Zeile der Liste (CASCADE räumt list_memberships, recipes und
 * recurring_items). Gibt false zurück, wenn die Liste nicht existierte; echte
 * DB-Fehler werden weitergeworfen und führen zu 500, nicht zu 404.
 */
export async function deleteListRow(env: Env, listId: string): Promise<boolean> {
  const del = await env.DB.prepare("DELETE FROM lists WHERE id = ?").bind(listId).run();
  return del.meta.changes > 0;
}

/**
 * Löscht eine Liste samt Daten (CASCADE) und dem DO-Storage. Gibt false
 * zurück, wenn die Liste nicht existiert.
 */
export async function deleteListCompletely(env: Env, listId: string): Promise<boolean> {
  const deleted = await deleteListRow(env, listId);
  if (deleted) await destroyListDoState(env, listId);
  return deleted;
}

/**
 * DELETE /api/list/:id – löscht die Liste samt Daten (CASCADE) und dem
 * DO-Storage. Nur der Owner; funktioniert auch, wenn er das einzige Mitglied ist.
 */
export async function handleDeleteList(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    const meta = await getListMeta(env.DB, listId);
    if (!meta || !(await isMember(env.DB, listId, user.id))) return notFound();
    const role = await getRole(env.DB, listId, user.id);
    if (role !== "owner" && meta.owner_id !== user.id) {
      return json({ error: "Nur der Owner kann die Liste löschen.", role: role ?? null }, 403);
    }

    const deleted = await deleteListCompletely(env, listId);
    if (!deleted) return json({ error: "Liste nicht gefunden." }, 404);

    return json({ ok: true });
  });
}
