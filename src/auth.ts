import { hashPassword, verifyPassword } from "./crypto";
import { createSession, deleteSessionByToken, sessionCookie, clearSessionCookie, SESSION_COOKIE, withAuth } from "./session";
import { getCookie, json, readJson } from "./util";
import { checkLimit } from "./do/rate-limiter";
import type { Env, PublicUser } from "./types";

// Dummy gegen Timing-Orakel: bei unbekannter E-Mail wird gegen diesen Hash
// verifiziert, sodass die Antwortzeit unabhängig davon ist, ob der Nutzer
// existiert. Erzeugt mit hashPassword("dummy-timing-oracle").
const DUMMY_PASSWORD_HASH = "pbkdf2:100000:697d9XDWIK3GOxE-GonqVw:G5cpmRyuJ85Fwua_MSm7V1hA_8xTaCkNW6-gtFIa2MM";

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

  // Kein Verifizierungszwang: Passwort-Konten ohne E-Mail-Bestätigung sind
  // zulässig. Der E-Mail-Inhaber kann die Adresse jederzeit per Magic Link
  // nachträglich übernehmen – das verifiziert die Adresse und entzieht dem
  // nie bestätigten Passwort die Gültigkeit (Account-Übernahme-Schutz H5).
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

  // Timing-Orakel schließen: IMMER ein verifyPassword ausführen, bei
  // unbekanntem Nutzer gegen den Dummy-Hash.
  const passwordHash = row?.password_hash ?? DUMMY_PASSWORD_HASH;
  const passwordOk = await verifyPassword(password, passwordHash);

  if (!row || !passwordOk) {
    // Fehlversuch zählen – nur nach fehlgeschlagener Prüfung, damit
    // erfolgreiche Logins kein Kontingent verbrennen.
    const ip = request.headers.get("cf-connecting-ip") ?? "unbekannt";
    const emailLimit = await checkLimit(env, `login:${email}`, 10, 5 * 60 * 1000);
    const ipLimit = await checkLimit(env, `login-ip:${ip}`, 30, 5 * 60 * 1000);
    if (!emailLimit.ok || !ipLimit.ok) {
      const retryAfter = Math.max(emailLimit.retryAfterSec, ipLimit.retryAfterSec);
      return json(
        { error: "Zu viele Anmeldeversuche. Bitte in " + Math.ceil(retryAfter / 60) + " Minuten nochmal versuchen." },
        429,
        { "retry-after": String(retryAfter) }
      );
    }
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
