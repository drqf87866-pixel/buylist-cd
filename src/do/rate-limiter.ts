import { json } from "../util";

// Free-Tier-Limit der Gemini-API: 15 Anfragen/Minute. Mit Sicherheitspuffer
// zählt der Zähler ab der 13. Anfrage im rollierenden 60-s-Fenster blockiert.
export const GEMINI_MAX_REQUESTS = 12;
export const GEMINI_WINDOW_MS = 60_000;
/** Obergrenze, damit ein Tippfehler in ?max= nicht das Limit aushebelt. */
const LIMITER_MAX_CAP = 120;

/** Liest ?max= aus der Check-URL; ungültig → Gemini-Default 12. */
export function limiterMaxFromUrl(url: string): number {
  const raw = Number(new URL(url).searchParams.get("max"));
  if (!Number.isFinite(raw) || raw < 1) return GEMINI_MAX_REQUESTS;
  return Math.min(LIMITER_MAX_CAP, Math.round(raw));
}

/**
 * App-weiter Zähler für LLM-Anfragen: als globaler Singleton
 * (env.RATE_LIMITER_DO.idFromName("gemini") bzw. "groq") serialisiert das DO
 * alle Anfragen über alle Isolates. Getrennte IDs = getrennte Kontingente.
 * Das Limit kommt per ?max= (Gemini 12, Groq 27).
 */
export class RateLimiterDO {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/check") {
      return json({ error: "Not Found" }, 404);
    }

    const max = limiterMaxFromUrl(request.url);
    const now = Date.now();
    const hits = ((await this.state.storage.get<number[]>("hits")) ?? []).filter(
      (t) => now - t < GEMINI_WINDOW_MS
    );

    if (hits.length >= max) {
      // Blockiert: ohne Zählung ablehnen (sonst würde die Blockade sich
      // selbst verlängern); retryAfter = bis der älteste Treffer verfällt.
      await this.state.storage.put("hits", hits);
      const retryAfterSec = Math.max(1, Math.ceil((hits[0] + GEMINI_WINDOW_MS - now) / 1000));
      return json({ ok: false, retryAfterSec }, 429, { "retry-after": String(retryAfterSec) });
    }

    hits.push(now);
    await this.state.storage.put("hits", hits);
    return json({ ok: true });
  }
}
