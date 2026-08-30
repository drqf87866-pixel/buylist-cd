import { withAuth } from "./session";
import { json, readJson } from "./util";
import type { Env } from "./types";

/**
 * Web Push (RFC 8030 + RFC 8291) nativ mit Web Crypto: VAPID-JWT (ES256)
 * + aes128gcm-Payload-Verschlüsselung. Keine externen Abhängigkeiten.
 *
 * VAPID-Schlüssel: `wrangler secret put VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`
 * (Base64url des 65-Byte-Uncompressed-Points bzw. des 32-Byte-Private-Scalars,
 * wie `npx web-push generate-vapid-keys` sie ausgibt) + `VAPID_SUBJECT`
 * (mailto:). Ohne Keys ist Push deaktiviert und die UI blendet den Toggle aus.
 */

function base64UrlToBytes(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/** Kopie als eigenständiger ArrayBuffer (für Web-Crypto-Parameter). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(salt), info: toArrayBuffer(info) },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

/** VAPID-JWT (ES256) für den Authorization-Header erzeugen. */
async function vapidJwt(env: Env, audience: string): Promise<string> {
  const pub = env.VAPID_PUBLIC_KEY;
  const priv = env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) throw new Error("VAPID nicht konfiguriert.");

  const pubBytes = base64UrlToBytes(pub);
  const privBytes = base64UrlToBytes(priv);
  const x = bytesToBase64Url(pubBytes.subarray(1, 33));
  const y = bytesToBase64Url(pubBytes.subarray(33, 65));
  const d = bytesToBase64Url(privBytes);

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x, y, d, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const header = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", typ: "JWT" })));
  const now = Math.floor(Date.now() / 1000);
  const payload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ aud: audience, exp: now + 12 * 60 * 60, sub: env.VAPID_SUBJECT ?? "mailto:buylist@localhost" }))
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/** Verschlüsselt den Payload per aes128gcm und liefert Body + Headers für fetch. */
async function encryptPayload(
  env: Env,
  endpoint: string,
  p256dh: string,
  auth: string,
  payload: Uint8Array
): Promise<{ body: Uint8Array; headers: Record<string, string> }> {
  const audience = new URL(endpoint).origin;
  const jwt = await vapidJwt(env, audience);

  // Ephemerer ECDH-Key des Servers
  const serverKeys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const serverPub = new Uint8Array(
    (await crypto.subtle.exportKey("raw", serverKeys.publicKey)) as ArrayBuffer
  );

  const clientPub = base64UrlToBytes(p256dh);
  const authSecret = base64UrlToBytes(auth);

  const clientKey = await crypto.subtle.importKey("raw", toArrayBuffer(clientPub), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey } as SubtleCryptoDeriveKeyAlgorithm, serverKeys.privateKey, 256)
  );

  // RFC 8291: IKM aus auth-Secret + ECDH-Shared-Secret
  const AUTH_INFO = new TextEncoder().encode("Content-Encoding: auth\0");
  const ikm = await hkdf(shared, authSecret, AUTH_INFO, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const KEY_INFO_PREFIX = new TextEncoder().encode("WebPush: info\0");
  const keyInfo = concat(KEY_INFO_PREFIX, clientPub, serverPub);

  const CEK_INFO = new TextEncoder().encode("Content-Encoding: aes128gcm\0key");
  const NONCE_INFO = new TextEncoder().encode("Content-Encoding: aes128gcm\0nonce");
  const cek = await hkdf(ikm, salt, concat(keyInfo, CEK_INFO), 16);
  const nonce = await hkdf(ikm, salt, concat(keyInfo, NONCE_INFO), 12);

  // Header: salt(16) || rs(4) || idlen(1) || server_pub(65); rs = 4096
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const header = concat(salt, rs, new Uint8Array([serverPub.length]), serverPub);

  const key = await crypto.subtle.importKey("raw", toArrayBuffer(cek), { name: "AES-GCM" }, false, ["encrypt"]);
  // RFC 8188: 2-Byte-Padding-Präambel (0x0000) vor dem eigentlichen Payload
  const record = concat(new Uint8Array([0, 0]), payload);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(header), tagLength: 128 },
      key,
      toArrayBuffer(record)
    )
  );

  const body = concat(header, ciphertext);
  return {
    body,
    headers: {
      "content-type": "application/octet-stream",
      "content-encoding": "aes128gcm",
      ttl: "604800",
      authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
  };
}

interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Sendet einen Push an alle Subscriptions eines Nutzers. */
export async function sendPushToUser(env: Env, userId: string, title: string, body: string, url = "/"): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;
  const { results } = await env.DB.prepare(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?"
  )
    .bind(userId)
    .all<PushSubscriptionRow>();
  if (!results?.length) return;

  const payload = new TextEncoder().encode(JSON.stringify({ title, body, url }));
  await Promise.allSettled(
    results.map(async (sub) => {
      try {
        const { body: encrypted, headers } = await encryptPayload(env, sub.endpoint, sub.p256dh, sub.auth, payload);
        const res = await fetch(sub.endpoint, {
          method: "POST",
          headers,
          body: toArrayBuffer(encrypted),
        });
        // 404/410 = Subscription verfallen → aufräumen
        if (res.status === 404 || res.status === 410) {
          await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(sub.endpoint).run();
        } else if (!res.ok) {
          console.error("Push-Versand fehlgeschlagen:", res.status, await res.text().catch(() => ""));
        }
      } catch (err) {
        console.error("Push-Fehler:", err);
      }
    })
  );
}

interface SubscribeBody {
  endpoint?: unknown;
  keys?: unknown;
}

/** POST /api/push/subscribe – Web-Push-Subscription des Browsers speichern. */
export async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!env.VAPID_PUBLIC_KEY) return json({ error: "Push ist nicht konfiguriert." }, 503);

    const body = await readJson<SubscribeBody>(request);
    const endpoint = typeof body?.endpoint === "string" && body.endpoint.startsWith("https://") ? body.endpoint : "";
    const keys = (typeof body?.keys === "object" && body.keys !== null ? body.keys : {}) as Record<string, unknown>;
    const p256dh = typeof keys.p256dh === "string" && keys.p256dh ? keys.p256dh.slice(0, 200) : "";
    const auth = typeof keys.auth === "string" && keys.auth ? keys.auth.slice(0, 100) : "";
    if (!endpoint || !p256dh || !auth) return json({ error: "Ungültige Subscription." }, 400);

    await env.DB.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
    )
      .bind(user.id, endpoint, p256dh, auth, Date.now())
      .run();
    return json({ ok: true });
  });
}

interface UnsubscribeBody {
  endpoint?: unknown;
}

/** POST /api/push/unsubscribe – Subscription entfernen. */
export async function handleUnsubscribe(request: Request, env: Env): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    const body = await readJson<UnsubscribeBody>(request);
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
    if (!endpoint) return json({ error: "Endpunkt fehlt." }, 400);

    await env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?")
      .bind(user.id, endpoint)
      .run();
    return json({ ok: true });
  });
}

/** GET /api/push/vapid-key – öffentlicher VAPID-Key für den Browser (oder konfiguriert: false). */
export async function handleVapidKey(request: Request, env: Env): Promise<Response> {
  if (!env.VAPID_PUBLIC_KEY) return json({ configured: false });
  return json({ configured: true, publicKey: env.VAPID_PUBLIC_KEY });
}
