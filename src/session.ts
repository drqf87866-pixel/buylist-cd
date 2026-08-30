import { sha256Base64Url } from "./crypto";
import { getCookie } from "./util";
import type { PublicUser } from "./types";

export const SESSION_COOKIE = "bl_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RENEW_THRESHOLD_MS = SESSION_TTL_MS / 2;

interface SessionRow {
  id: string;
  email: string;
  display_name: string;
  expires_at: number;
}

export interface AuthContext {
  user: PublicUser;
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export async function createSession(
  db: D1Database,
  userId: string
): Promise<{ token: string; expiresAt: number }> {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const tokenHash = await sha256Base64Url(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await db
    .prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, userId, expiresAt, now)
    .run();
  return { token, expiresAt };
}

export async function deleteSessionByToken(db: D1Database, token: string): Promise<void> {
  const tokenHash = await sha256Base64Url(token);
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}

/**
 * Löst das Session-Cookie zu einem User auf. Läuft die Session in weniger als
 * der Hälfte der TTL ab, wird sie verlängert (sliding renewal) und ein frisches
 * Set-Cookie zurückgegeben, das der Aufrufer an die Response hängt.
 */
export async function getSessionUser(
  db: D1Database,
  request: Request
): Promise<{ user: PublicUser; renewedCookie?: string } | null> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;

  const tokenHash = await sha256Base64Url(token);
  const row = await db
    .prepare(
      `SELECT s.expires_at, u.id, u.email, u.display_name
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .bind(tokenHash)
    .first<SessionRow>();
  if (!row) return null;

  const now = Date.now();
  if (row.expires_at <= now) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }

  const user: PublicUser = { id: row.id, email: row.email, displayName: row.display_name };

  if (row.expires_at - now < RENEW_THRESHOLD_MS) {
    const newExpiry = now + SESSION_TTL_MS;
    await db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").bind(newExpiry, tokenHash).run();
    const secure = new URL(request.url).protocol === "https:";
    return { user, renewedCookie: sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000), secure) };
  }

  return { user };
}

/**
 * Wrapper für geschützte API-Routen: 401 ohne gültige Session, ansonsten ruft
 * er den Handler auf und hängt bei Verlängerung das erneuerte Cookie an.
 */
export async function withAuth(
  request: Request,
  db: D1Database,
  handler: (ctx: AuthContext) => Promise<Response>
): Promise<Response> {
  const session = await getSessionUser(db, request);
  if (!session) return json401();
  const response = await handler({ user: session.user });
  if (session.renewedCookie) response.headers.append("set-cookie", session.renewedCookie);
  return response;
}

function json401(): Response {
  return new Response(JSON.stringify({ error: "Nicht eingeloggt." }), {
    status: 401,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
