import { withAuth } from "./session";
import { callGeminiJson, GeminiError } from "./recipes";
import { getPreferences, preferencesPrompt } from "./preferences";
import { json, normKey } from "./util";
import type { DishSuggestion, Env } from "./types";

/** Anzahl der Vorschläge pro Tag – ein einziger Gemini-Call liefert sie alle. */
const ANZAHL_VORSCHLAEGE = 5;
/** Wie viele vergangene Tage als „schon vorgeschlagen“ in den Prompt fließen. */
const EXCLUDE_TAGE = 7;

interface SuggestionRow {
  user_id: string;
  datum: string;
  vorschlaege: string;
  created_at: number;
}

/** Heutiges Datum als YYYY-MM-DD in Europa/Berlin – der Tag entspricht dem, was der Nutzer erlebt. */
export function heutigesDatum(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function safeParseVorschlaege(text: string): DishSuggestion[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as DishSuggestion[]) : [];
  } catch {
    return [];
  }
}

function sanitizeVorschlaege(raw: unknown): DishSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const out: DishSuggestion[] = [];
  for (const entry of raw.slice(0, ANZAHL_VORSCHLAEGE)) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const titel = typeof obj.titel === "string" ? obj.titel.trim().slice(0, 120) : "";
    if (!titel) continue;
    const beschreibung = typeof obj.beschreibung === "string" ? obj.beschreibung.trim().slice(0, 200) : "";
    if (!beschreibung) continue;
    const zeit = typeof obj.zeit === "string" && obj.zeit.trim() ? obj.zeit.trim().slice(0, 40) : undefined;
    out.push({ titel, beschreibung, ...(zeit ? { zeit } : {}) });
  }
  return out;
}

// ---------- Gemini ----------

const SYSTEM_ANWEISUNG = `Du bist ein Kochassistent für eine Einkaufslisten-App und schlägst täglich neue Gerichte vor.
Regeln:
- Antworte auf Deutsch.
- Schlage genau ${ANZAHL_VORSCHLAEGE} Gerichte vor – überraschend, aber alltagstauglich mit handelsüblichen Zutaten.
- Vielfalt ist Pflicht: mindestens 3 verschiedene Küchen/Regionen (z. B. mediterran, asiatisch, orientalisch, deutsch, mexikanisch), höchstens 1 Gericht pro Protein-Hauptquelle (Huhn, Rind, Schwein, Fisch, vegetarisch mit Hülsenfrüchten usw.) und höchstens 1 Gericht pro Sättigungsbasis (Nudeln, Reis, Kartoffeln, Brot).
- Mische die Zubereitungsarten (Pfanne, Ofen, Topf, roh/Salat) und die Zeiten (mindestens 1 Gericht unter 20 Minuten).
- "beschreibung" ist EIN einladender Satz (max. ca. 15 Wörter), der das Gericht verkauft.
- "zeit" ist die ungefähre Zubereitungszeit (z. B. "ca. 30 Minuten").
- Steht eine Ausschlussliste, darf KEIN Gericht davon enthalten sein (auch nicht in Abwandlungen wie "Spaghetti Napoli" statt "Pasta mit Tomatensauce").
- Steht eine Variationsliste (heute bereits gezeigt), weiche bewusst deutlich davon ab: keine Wiederholungen und keine bloßen Varianten derselben Gerichte – wähle andere Küchen, Proteinquellen und Zubereitungsarten.
- Die Vorgaben des Nutzers (Diätform/Ziel/Allergene) haben immer Vorrang vor den Vielfaltsregeln und sind zwingend.`;

/**
 * Generiert die Tagesvorschläge in EINEM Gemini-Request (Array-Response-Schema)
 * und berücksichtigt Präferenzen sowie die Vorschläge der letzten Tage.
 * `weicheAusschluesse` (nur beim Refresh: die gerade angezeigten Gerichte)
 * wird bewusst nur als Variationsliste formuliert – kein hartes Verbot, damit
 * auch enge Essens-Profile noch erfüllbar bleiben.
 */
async function generateSuggestions(
  env: Env,
  userId: string,
  weicheAusschluesse: string[] = []
): Promise<DishSuggestion[]> {
  const heute = heutigesDatum();
  const { results } = await env.DB.prepare(
    `SELECT vorschlaege FROM daily_suggestions WHERE user_id = ? AND datum < ? ORDER BY datum DESC LIMIT ${EXCLUDE_TAGE}`
  )
    .bind(userId, heute)
    .all<{ vorschlaege: string }>();

  const excluiert = new Set<string>();
  for (const row of results ?? []) {
    for (const v of safeParseVorschlaege(row.vorschlaege)) {
      const titel = v.titel?.trim();
      if (titel) excluiert.add(normKey(titel));
    }
  }

  const praeferenzen = preferencesPrompt(await getPreferences(env.DB, userId));
  const parts: string[] = [`Schlage für heute (${heute}) ${ANZAHL_VORSCHLAEGE} Gerichte vor.`];
  if (excluiert.size) {
    parts.push(`Ausschlussliste – diese Gerichte wurden in den letzten Tagen bereits vorgeschlagen: ${[...excluiert].join("; ")}`);
  }
  const variation = [...new Set(weicheAusschluesse.map((t) => t.trim()).filter(Boolean))];
  if (variation.length) {
    parts.push(`Variationsliste – heute bereits gezeigt, weiche bewusst deutlich davon ab: ${variation.join("; ")}`);
  }
  if (praeferenzen) parts.push(praeferenzen);

  const raw = await callGeminiJson(env, {
    systemInstruction: SYSTEM_ANWEISUNG,
    userContent: parts.join("\n"),
    temperature: 1,
    responseSchema: {
      type: "ARRAY",
      minItems: ANZAHL_VORSCHLAEGE,
      maxItems: ANZAHL_VORSCHLAEGE,
      items: {
        type: "OBJECT",
        properties: {
          titel: { type: "STRING" },
          beschreibung: { type: "STRING" },
          zeit: { type: "STRING" },
        },
        required: ["titel", "beschreibung"],
      },
    },
    kontext: "Vorschlags-Generierung",
  });

  const vorschlaege = sanitizeVorschlaege(raw);
  if (vorschlaege.length !== ANZAHL_VORSCHLAEGE) {
    throw new GeminiError(502, "Die Antwort des KI-Dienstes konnte nicht verarbeitet werden.");
  }
  return vorschlaege;
}

// ---------- Rate-Limit ----------

/**
 * Freikontingent-Check über den globalen RateLimiter-DO (12/min, Puffer unter
 * den 15/min des Free-Tiers) – derselbe Zähler wie im Koch-Assistenten.
 */
async function pruefeRateLimit(env: Env): Promise<Response | null> {
  const limiter = env.RATE_LIMITER_DO.get(env.RATE_LIMITER_DO.idFromName("gemini"));
  const limitRes = await limiter.fetch("https://rate-limiter/check", { method: "POST" });
  const limit = (await limitRes.json()) as { ok?: boolean; retryAfterSec?: number };
  if (!limitRes.ok || !limit.ok) {
    const wait = limit.retryAfterSec ?? 60;
    return json(
      { error: `Die KI macht gerade eine Pause (Free-Tier-Limit). Bitte in ${wait} Sekunden nochmal versuchen.` },
      429,
      { "retry-after": String(wait) }
    );
  }
  return null;
}

// ---------- HTTP-Handler ----------

async function leseHeute(env: Env, userId: string): Promise<DishSuggestion[] | null> {
  const heute = heutigesDatum();
  const row = await env.DB.prepare("SELECT vorschlaege FROM daily_suggestions WHERE user_id = ? AND datum = ?")
    .bind(userId, heute)
    .first<{ vorschlaege: string }>();
  return row ? safeParseVorschlaege(row.vorschlaege) : null;
}

async function speichereHeute(env: Env, userId: string, vorschlaege: DishSuggestion[]): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO daily_suggestions (user_id, datum, vorschlaege, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, datum) DO UPDATE SET vorschlaege = excluded.vorschlaege, created_at = excluded.created_at`
  )
    .bind(userId, heutigesDatum(), JSON.stringify(vorschlaege), Date.now())
    .run();
}

/**
 * GET /api/suggestions – heutige Vorschläge; fehlen sie (neuer Tag, neuer
 * Nutzer, ausgefallener Cron), werden sie on demand generiert.
 */
export async function handleGetSuggestions(request: Request, env: Env): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    const vorhandene = await leseHeute(env, user.id);
    if (vorhandene?.length) return json({ datum: heutigesDatum(), vorschlaege: vorhandene });

    const limitBlock = await pruefeRateLimit(env);
    if (limitBlock) return limitBlock;

    try {
      const vorschlaege = await generateSuggestions(env, user.id);
      await speichereHeute(env, user.id, vorschlaege);
      return json({ datum: heutigesDatum(), vorschlaege });
    } catch (err) {
      if (err instanceof GeminiError) return json({ error: err.message }, err.status);
      throw err;
    }
  });
}

/** POST /api/suggestions/refresh – überschreibt die heutigen Vorschläge mit einer neuen Generierung. */
export async function handleRefreshSuggestions(request: Request, env: Env): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    const limitBlock = await pruefeRateLimit(env);
    if (limitBlock) return limitBlock;

    try {
      // Die gerade angezeigten Gerichte nur als weiche Variationsliste
      // mitgeben (kein hartes Verbot) – so würfelt der Refresh bewusst anders,
      // bleibt aber auch bei engen Essens-Profilen erfüllbar.
      const bisherige = await leseHeute(env, user.id);
      const variation = (bisherige ?? []).map((v) => v.titel).filter((t) => typeof t === "string" && t.trim());
      const vorschlaege = await generateSuggestions(env, user.id, variation);
      await speichereHeute(env, user.id, vorschlaege);
      return json({ datum: heutigesDatum(), vorschlaege });
    } catch (err) {
      if (err instanceof GeminiError) return json({ error: err.message }, err.status);
      throw err;
    }
  });
}

// ---------- Cron ----------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Hartes Budget pro Cron-Lauf; wer danach dran ist, bekommt seine Vorschläge lazy beim App-Öffnen. */
const CRON_BUDGET_MS = 8 * 60_000;

/**
 * Täglicher Vorlauf: generiert für jeden Nutzer ohne heutige Zeile die 5
 * Vorschläge (1 Gemini-Request pro Nutzer). Der globale Rate-Limiter zählt
 * mit – ist das Fenster voll, wartet der Lauf, statt Requests zu verlieren.
 */
export async function runSuggestionsCron(env: Env): Promise<{ generiert: number }> {
  const start = Date.now();
  const heute = heutigesDatum();
  const { results } = await env.DB.prepare(
    `SELECT u.id AS user_id FROM users u
     LEFT JOIN daily_suggestions d ON d.user_id = u.id AND d.datum = ?
     WHERE d.user_id IS NULL`
  )
    .bind(heute)
    .all<{ user_id: string }>();

  let generiert = 0;
  for (const { user_id } of results ?? []) {
    if (Date.now() - start > CRON_BUDGET_MS) break;

    const limiter = env.RATE_LIMITER_DO.get(env.RATE_LIMITER_DO.idFromName("gemini"));
    for (;;) {
      if (Date.now() - start > CRON_BUDGET_MS) return { generiert };
      const limitRes = await limiter.fetch("https://rate-limiter/check", { method: "POST" });
      const limit = (await limitRes.json()) as { ok?: boolean; retryAfterSec?: number };
      if (limitRes.ok && limit.ok) break;
      await sleep(((limit.retryAfterSec ?? 30) + 1) * 1000);
    }

    try {
      const vorschlaege = await generateSuggestions(env, user_id);
      await speichereHeute(env, user_id, vorschlaege);
      generiert++;
    } catch (err) {
      // Einzelner Nutzer scheitert → weiter zum nächsten; er bekommt seine
      // Vorschläge dann lazy per GET /api/suggestions.
      console.error("Cron: Vorschläge fehlgeschlagen für", user_id, err);
    }
  }

  return { generiert };
}
