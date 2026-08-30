import { hashPassword, verifyPassword } from "./crypto";
import { createSession, deleteSessionByToken, sessionCookie, clearSessionCookie, SESSION_COOKIE, withAuth } from "./session";
import { getCookie, json, readJson } from "./util";
import type { Env, PublicUser } from "./types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface CredentialsBody {
  email?: string;
  password?: string;
  displayName?: string;
}

function secureFlag(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

async function issueSession(
  env: Env,
  user: PublicUser,
  request: Request
): Promise<Response> {
  const { token, expiresAt } = await createSession(env.DB, user.id);
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return json({ user }, 200, { "set-cookie": sessionCookie(token, maxAge, secureFlag(request)) });
}

export async function handleRegister(request: Request, env: Env): Promise<Response> {
  const body = await readJson<CredentialsBody>(request);
  const email = (body?.email ?? "").trim().toLowerCase();
  const password = body?.password ?? "";
  const displayName = (body?.displayName ?? "").trim();

  if (!EMAIL_RE.test(email)) return json({ error: "Bitte gib eine gültige E-Mail-Adresse ein." }, 400);
  if (password.length < 8) return json({ error: "Das Passwort muss mindestens 8 Zeichen lang sein." }, 400);
  if (displayName.length < 1 || displayName.length > 40) {
    return json({ error: "Der Anzeigename muss 1–40 Zeichen lang sein." }, 400);
  }

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return json({ error: "Diese E-Mail ist bereits registriert." }, 409);

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  try {
    await env.DB.prepare(
      "INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(id, email, passwordHash, displayName, Date.now())
      .run();
  } catch (err) {
    // Race mit Unique-Constraint abfangen
    if (String((err as Error)?.message).includes("UNIQUE")) {
      return json({ error: "Diese E-Mail ist bereits registriert." }, 409);
    }
    throw err;
  }

  return issueSession(env, { id, email, displayName }, request);
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = await readJson<CredentialsBody>(request);
  const email = (body?.email ?? "").trim().toLowerCase();
  const password = body?.password ?? "";

  const row = await env.DB
    .prepare("SELECT id, email, display_name, password_hash FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; email: string; display_name: string; password_hash: string }>();

  if (!row || !(await verifyPassword(password, row.password_hash))) {
    return json({ error: "E-Mail oder Passwort ist falsch." }, 401);
  }

  const user: PublicUser = { id: row.id, email: row.email, displayName: row.display_name };
  return issueSession(env, user, request);
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) await deleteSessionByToken(env.DB, token);
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(secureFlag(request)) });
}

export async function handleMe(request: Request, env: Env): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => json({ user }));
}
