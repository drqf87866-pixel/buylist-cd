import { json } from "../util";
import type { Env } from "../types";

// Free-Tier-Limit der Gemini-API: 15 Anfragen/Minute. Mit Sicherheitspuffer
// zählt der Zähler ab der 13. Anfrage im rollierenden 60-s-Fenster blockiert.
export const GEMINI_MAX_REQUESTS = 12;
export const GEMINI_WINDOW_MS = 60_000;
/** Obergrenze, damit ein Tippfehler in ?max= nicht das Limit aushebelt. */
const LIMITER_MAX_CAP = 120;
/** Obergrenze für ?window=: 30 Minuten. */
const LIMITER_WINDOW_CAP_MS = 1_800_000;

/** Liest ?max= aus der Check-URL; ungültig → Gemini-Default 12. */
export function limiterMaxFromUrl(url: string): number {
  const raw = Number(new URL(url).searchParams.get("max"));
  if (!Number.isFinite(raw) || raw < 1) return GEMINI_MAX_REQUESTS;
  return Math.min(LIMITER_MAX_CAP, Math.round(raw));
}

/** Liest ?window= aus der URL (ms); ungültig → Default 60000, Cap 30 Min. */
export function limiterWindowFromUrl(url: string): number {
  const raw = Number(new URL(url).searchParams.get("window"));
  if (!Number.isFinite(raw) || raw < 1) return GEMINI_WINDOW_MS;
  return Math.min(LIMITER_WINDOW_CAP_MS, Math.round(raw));
}

/** Liest ?key= aus der URL; fehlt → null (Abwärtskompatibilität). */
function keyFromUrl(url: string): string | null {
  return new URL(url).searchParams.get("key");
}

function storageKey(key: string | null): string {
  return key !== null ? `hits:${key}` : "hits";
}

/**
 * Helfer für Aufrufer, die den Singleton env.RATE_LIMITER_DO.idFromName("limits")
 * mit ?max=&window=&key= bedienen. Fail-open: bei DO-Fehler wird {ok:true}
 * zurückgegeben und der Fehler geloggt.
 */
export async function checkLimit(
  env: Env,
  key: string,
  max: number,
  windowMs?: number
): Promise<{ ok: boolean; retryAfterSec: number }> {
  const url = new URL("https://rate-limiter/check");
  url.searchParams.set("max", String(max));
  url.searchParams.set("key", key);
  if (windowMs !== undefined) {
    url.searchParams.set("window", String(windowMs));
  }
  try {
    const stub = env.RATE_LIMITER_DO.get(env.RATE_LIMITER_DO.idFromName("limits"));
    const res = await stub.fetch(url.toString());
    return await res.json<{ ok: boolean; retryAfterSec: number }>();
  } catch (err) {
    console.error("checkLimit-Fehler (fail-open):", err);
    return { ok: true, retryAfterSec: 0 };
  }
}

/**
 * App-weiter Zähler für LLM-Anfragen: als globaler Singleton
 * (env.RATE_LIMITER_DO.idFromName("gemini") bzw. "groq") serialisiert das DO
 * alle Anfragen über alle Isolates. Getrennte IDs = getrennte Kontingente.
 * Das Limit kommt per ?max= (Gemini 12, Groq 27).
 *
 * Mit ?key=<k> teilt sich eine DO-Instanz (z. B. idFromName("limits")) viele
 * unabhängige Zähler; der Storage-Key lautet dann hits:<k> statt hits.
 * ?window= legt das Zeitfenster fest (Default 60 s, Cap 30 Min).
 */
export class RateLimiterDO {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/check") {
      return json({ error: "Not Found" }, 404);
    }

    const max = limiterMaxFromUrl(request.url);
    const windowMs = limiterWindowFromUrl(request.url);
    const key = keyFromUrl(request.url);
    const skey = storageKey(key);
    const now = Date.now();
    const hits = ((await this.state.storage.get<number[]>(skey)) ?? []).filter(
      (t) => now - t < windowMs
    );

    if (hits.length >= max) {
      // Blockiert: ohne Zählung ablehnen (sonst würde die Blockade sich
      // selbst verlängern); retryAfter = bis der älteste Treffer verfällt.
      await this.state.storage.put(skey, hits);
      const retryAfterSec = Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000));
      return json({ ok: false, retryAfterSec }, 429, { "retry-after": String(retryAfterSec) });
    }

    hits.push(now);
    await this.state.storage.put(skey, hits);

    // Best-Effort-Aufräumen: nur wenn wir einen Key-Zähler verwendet haben,
    // verfallene "hits:"-Keys löschen (mindestens 10 Einträge, max. 20 pro
    // Aufruf, damit kein einzelner Request zu viel Aufwand verursacht).
    if (key !== null) {
      try {
        const entries = await this.state.storage.list<number[]>({
          prefix: "hits:",
          limit: 20,
        });
        for (const [k, timestamps] of entries) {
          // Nur löschen, wenn alle Hits des Keys verfallen sind
          if (timestamps.every((t) => now - t >= windowMs)) {
            await this.state.storage.delete(k);
          }
        }
      } catch {
        // Aufräumen ist best-effort
      }
    }

    return json({ ok: true });
  }
}
