import { json } from "../util";

// Free-Tier-Limit der Gemini-API: 15 Anfragen/Minute. Mit Sicherheitspuffer
// zählt der Zähler ab der 13. Anfrage im rollierenden 60-s-Fenster blockiert.
export const GEMINI_MAX_REQUESTS = 12;
export const GEMINI_WINDOW_MS = 60_000;

/**
 * App-weiter Zähler für Gemini-Anfragen: als globaler Singleton
 * (env.RATE_LIMITER_DO.idFromName("gemini")) serialisiert das DO alle
 * Anfragen über alle Isolates und Nutzer hinweg – der Zähler ist damit
 * garantiert global, nicht pro Instanz.
 */
export class RateLimiterDO {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/check") {
      return json({ error: "Not Found" }, 404);
    }

    const now = Date.now();
    const hits = ((await this.state.storage.get<number[]>("hits")) ?? []).filter(
      (t) => now - t < GEMINI_WINDOW_MS
    );

    if (hits.length >= GEMINI_MAX_REQUESTS) {
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
