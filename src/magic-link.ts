import { randomToken, sha256Base64Url } from "./crypto";
import { createSession, sessionCookie } from "./session";
import { json, missingSecret, readJson } from "./util";
import { checkLimit } from "./do/rate-limiter";
import type { Env, PublicUser } from "./types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Gültigkeit eines Magic-Link-Tokens. */
const MAGIC_TTL_MS = 15 * 60 * 1000;
/** Rate-Limit pro E-Mail: höchstens MAGIC_RATE_MAX Anfragen je Fenster. */
const MAGIC_RATE_WINDOW_MS = 5 * 60 * 1000;
const MAGIC_RATE_MAX = 3;
/**
 * Platzhalter im `password_hash`-Feld für Nutzer, die nur per Magic Link
 * angelegt wurden. `verifyPassword()` lehnt alles ohne `pbkdf2:`-Präfix ab,
 * ein Passwort-Login ist damit bewusst unmöglich.
 */
const MAGIC_SENTINEL = "magic";

/**
 * Reine Entscheidungslogik: was soll bei einem Magic-Verify mit dem Konto
 * passieren? Siehe emailVerifyAktion-Tabelle in der Aufgabenbeschreibung.
 */
export function emailVerifyAktion(emailVerifiedAt: number | null, passwordHash: string): {
  setVerified: boolean;
  discardPassword: boolean;
  wipeSessions: boolean;
} {
  if (emailVerifiedAt !== null) {
    return { setVerified: false, discardPassword: false, wipeSessions: false };
  }
  if (passwordHash.startsWith("pbkdf2:")) {
    return { setVerified: true, discardPassword: true, wipeSessions: true };
  }
  return { setVerified: true, discardPassword: false, wipeSessions: false };
}

/**
 * Setzt email_verified_at und verwirft ggf. das Passwort eines unverifizierten
 * Passwort-Kontos (Account-Übernahme-Schutz). Muss VOR createSession aufgerufen
 * werden, damit der Session-Wipe nicht die frische Session des Verifizierers löscht.
 */
async function verifyUserEmail(env: Env, userId: string): Promise<void> {
  const row = await env.DB
    .prepare("SELECT email_verified_at, password_hash FROM users WHERE id = ?")
    .bind(userId)
    .first<{ email_verified_at: number | null; password_hash: string }>();
  if (!row) return;

  const aktion = emailVerifyAktion(row.email_verified_at, row.password_hash);
  if (!aktion.setVerified) return;

  const now = Date.now();
  if (aktion.discardPassword) {
    // Verifizierung über den E-Mail-Beweis entzieht das nie bestätigte Passwort (H5).
    await env.DB
      .prepare("UPDATE users SET email_verified_at = ?, password_hash = ? WHERE id = ?")
      .bind(now, MAGIC_SENTINEL, userId)
      .run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
  } else {
    await env.DB
      .prepare("UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL")
      .bind(now, userId)
      .run();
  }
}

interface MagicRequestBody {
  email?: string;
}

interface MagicLinkRow {
  email: string;
  user_id: string | null;
  expires_at: number;
  used_at: number | null;
}

function secureFlag(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

function baseUrl(request: Request, env: Env): string {
  return (env.APP_URL ?? new URL(request.url).origin).replace(/\/+$/, "");
}

/** Anzeigename aus dem lokalen Teil der E-Mail ableiten, auf 40 Zeichen gekürzt. */
function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0]?.trim() ?? "";
  const name = local.slice(0, 40);
  return name.length >= 1 ? name : "Neu";
}

async function sendMagicLinkMail(env: Env, to: string, link: string): Promise<Response | null> {
  if (!env.RESEND_API_KEY) return missingSecret("RESEND_API_KEY");
  if (!env.RESEND_FROM) return missingSecret("RESEND_FROM");

  const text =
    `Hallo!\n\nTippe auf diesen Link, um dich bei Buylist anzumelden:\n${link}\n\n` +
    `Der Link ist 15 Minuten gültig und nur einmal verwendbar. ` +
    `Falls du ihn nicht angefordert hast, kannst du diese E-Mail ignorieren.`;
  const html =
    `<p>Hallo!</p><p>Tippe auf diesen Link, um dich bei Buylist anzumelden:</p>` +
    `<p><a href="${link}">Jetzt anmelden</a></p>` +
    `<p>Der Link ist <strong>15 Minuten</strong> gültig und nur einmal verwendbar. ` +
    `Falls du ihn nicht angefordert hast, kannst du diese E-Mail ignorieren.</p>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from: env.RESEND_FROM, to: [to], subject: "Dein Buylist-Login", text, html }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("Resend-Fehler:", res.status, detail);
    return json({ error: "Die E-Mail konnte nicht versendet werden. Bitte später nochmal versuchen." }, 502);
  }
  return null;
}

/** Fordert einen Magic Link per E-Mail an (öffentliche Route, kein Login nötig). */
export async function handleMagicRequest(request: Request, env: Env): Promise<Response> {
  if (!env.RESEND_API_KEY) return missingSecret("RESEND_API_KEY");
  if (!env.RESEND_FROM) return missingSecret("RESEND_FROM");

  const body = await readJson<MagicRequestBody>(request);
  const email = (body?.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return json({ error: "Bitte gib eine gültige E-Mail-Adresse ein." }, 400);
  }

  const now = Date.now();
  // Abgelaufene Tokens aller Nutzer räumen.
  await env.DB.prepare("DELETE FROM magic_links WHERE expires_at < ?").bind(now).run();

  // IP-basiertes Rate-Limit vor dem DB-Check, damit auch nicht in D1 geschrieben
  // wird, wenn die IP bereits blockiert ist.
  const ip = request.headers.get("cf-connecting-ip") ?? "unbekannt";
  const ipLimit = await checkLimit(env, `magic-ip:${ip}`, 6, 5 * 60 * 1000);
  if (!ipLimit.ok) {
    return json({ error: "Zu viele Anfragen. Bitte warte ein paar Minuten." }, 429, {
      "retry-after": String(ipLimit.retryAfterSec),
    });
  }

  const recent = await env.DB
    .prepare("SELECT COUNT(*) AS anzahl FROM magic_links WHERE email = ? AND created_at > ?")
    .bind(email, now - MAGIC_RATE_WINDOW_MS)
    .first<{ anzahl: number }>();
  if ((recent?.anzahl ?? 0) >= MAGIC_RATE_MAX) {
    return json({ error: "Zu viele Anfragen. Bitte warte ein paar Minuten." }, 429, {
      "retry-after": String(Math.ceil(MAGIC_RATE_WINDOW_MS / 1000)),
    });
  }

  // Frühere, noch offene Links dieser E-Mail entwerten statt löschen, damit
  // das COUNT-Fenster oben funktioniert: DELETE würde die Zeilen entfernen,
  // sodass der COUNT immer 0 sieht und das E-Mail-Limit nicht wirkt.
  await env.DB.prepare("UPDATE magic_links SET used_at = ? WHERE email = ? AND used_at IS NULL").bind(now, email).run();

  const token = randomToken(32);
  const tokenHash = await sha256Base64Url(token);
  await env.DB
    .prepare(
      "INSERT INTO magic_links (token_hash, email, user_id, expires_at, used_at, created_at) VALUES (?, ?, NULL, ?, NULL, ?)"
    )
    .bind(tokenHash, email, now + MAGIC_TTL_MS, now)
    .run();

  const link = `${baseUrl(request, env)}/api/auth/magic/verify?token=${encodeURIComponent(token)}`;
  const failure = await sendMagicLinkMail(env, email, link);
  if (failure) return failure;

  return json({ ok: true });
}

/**
 * Löst den Magic Link ein: Token prüfen und entwerten, Nutzer bei Bedarf
 * anlegen, Session setzen und per 302 in die App leiten. Fehler landen auf der
 * Login-Seite mit `?magic=<grund>`.
 */
export async function handleMagicVerify(request: Request, env: Env): Promise<Response> {
  const secure = secureFlag(request);
  const fail = (reason: string) => {
    const url = new URL("/login", baseUrl(request, env));
    url.searchParams.set("magic", reason);
    return new Response(null, { status: 302, headers: { location: url.toString() } });
  };

  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!token) return fail("ungueltig");

  const tokenHash = await sha256Base64Url(token);
  const now = Date.now();

  const row = await env.DB
    .prepare("SELECT email, user_id, expires_at, used_at FROM magic_links WHERE token_hash = ?")
    .bind(tokenHash)
    .first<MagicLinkRow>();
  if (!row) return fail("ungueltig");
  if (row.used_at !== null) return fail("verbraucht");
  if (row.expires_at <= now) return fail("abgelaufen");

  // Atomar entwerten: nur wenn noch unbenutzt und gültig, gewinnt genau ein Request.
  const claim = await env.DB
    .prepare("UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(now, tokenHash, now)
    .run();
  if (!claim.meta.changes) return fail("verbraucht");

  const user = await findOrCreateUser(env, row.email);
  await verifyUserEmail(env, user.id);
  const { token: sessionToken, expiresAt } = await createSession(env.DB, user.id);
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000));

  return new Response(null, {
    status: 302,
    headers: {
      location: `${baseUrl(request, env)}/`,
      "set-cookie": sessionCookie(sessionToken, maxAge, secure),
    },
  });
}

async function findOrCreateUser(env: Env, email: string): Promise<PublicUser> {
  const existing = await env.DB
    .prepare("SELECT id, email, display_name FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; email: string; display_name: string }>();
  if (existing) {
    return { id: existing.id, email: existing.email, displayName: existing.display_name };
  }

  const id = crypto.randomUUID();
  const displayName = displayNameFromEmail(email);
  try {
    await env.DB
      .prepare("INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, email, MAGIC_SENTINEL, displayName, Date.now())
      .run();
    return { id, email, displayName };
  } catch (err) {
    // Race mit Unique-Constraint (z. B. gleichzeitiger Magic Link) abfangen.
    if (String((err as Error)?.message).includes("UNIQUE")) {
      const row = await env.DB
        .prepare("SELECT id, email, display_name FROM users WHERE email = ?")
        .bind(email)
        .first<{ id: string; email: string; display_name: string }>();
      if (row) return { id: row.id, email: row.email, displayName: row.display_name };
    }
    throw err;
  }
}
