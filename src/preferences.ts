import { withAuth } from "./session";
import { json, readJson } from "./util";
import type { Env, UserPreferences } from "./types";

const DIAET_OPTIONEN = [
  "keine",
  "vegetarisch",
  "vegan",
  "pescetarisch",
  "glutenfrei",
  "laktosefrei",
] as const;

type Diaet = (typeof DIAET_OPTIONEN)[number];

const MAX_ALLERGENE = 20;
const ALLERGEN_MAX_LEN = 60;

interface PreferencesRow {
  diaet: string;
  allergene: string;
  updated_at: number;
}

function parseAllergene(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const entry of parsed.slice(0, MAX_ALLERGENE)) {
      if (typeof entry !== "string") continue;
      const v = entry.trim().slice(0, ALLERGEN_MAX_LEN);
      if (v && !out.includes(v)) out.push(v);
    }
    return out;
  } catch {
    return [];
  }
}

function rowToPreferences(row: PreferencesRow | null): UserPreferences {
  if (!row) return { diaet: "keine", allergene: [], updatedAt: 0 };
  const diaet = DIAET_OPTIONEN.includes(row.diaet as Diaet) ? (row.diaet as Diaet) : "keine";
  return { diaet, allergene: parseAllergene(row.allergene), updatedAt: row.updated_at };
}

/** Liest die Präferenzen eines Nutzers (Default bei fehlender Zeile). */
export async function getPreferences(db: D1Database, userId: string): Promise<UserPreferences> {
  const row = await db
    .prepare("SELECT diaet, allergene, updated_at FROM user_preferences WHERE user_id = ?")
    .bind(userId)
    .first<PreferencesRow>();
  return rowToPreferences(row ?? null);
}

/** Formatiert Präferenzen als Prompt-Zusatz für Gemini (leer = nichts angeben). */
export function preferencesPrompt(prefs: UserPreferences): string {
  const parts: string[] = [];
  if (prefs.diaet !== "keine") parts.push(`Diätform: ${prefs.diaet}`);
  if (prefs.allergene.length) parts.push(`Zutaten, die unbedingt vermieden werden müssen: ${prefs.allergene.join(", ")}`);
  if (!parts.length) return "";
  return `Achte auf die Nutzer-Vorgaben: ${parts.join(" · ")}`;
}

interface PreferencesBody {
  diaet?: unknown;
  allergene?: unknown;
}

/** GET /api/preferences – Präferenzen des eingeloggten Nutzers. */
export async function handleGetPreferences(request: Request, env: Env): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    const prefs = await getPreferences(env.DB, user.id);
    return json({ preferences: prefs });
  });
}

/** PUT /api/preferences – Diätform + Allergene speichern. */
export async function handleSavePreferences(request: Request, env: Env): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    const body = await readJson<PreferencesBody>(request);

    let diaet: Diaet = "keine";
    if (typeof body?.diaet === "string" && DIAET_OPTIONEN.includes(body.diaet as Diaet)) {
      diaet = body.diaet as Diaet;
    }

    let allergene: string[] = [];
    if (Array.isArray(body?.allergene)) {
      for (const entry of body.allergene.slice(0, MAX_ALLERGENE)) {
        if (typeof entry !== "string") continue;
        const v = entry.trim().slice(0, ALLERGEN_MAX_LEN);
        if (v && !allergene.includes(v)) allergene.push(v);
      }
    }

    const updatedAt = Date.now();
    await env.DB.prepare(
      `INSERT INTO user_preferences (user_id, diaet, allergene, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET diaet = excluded.diaet, allergene = excluded.allergene, updated_at = excluded.updated_at`
    )
      .bind(user.id, diaet, JSON.stringify(allergene), updatedAt)
      .run();

    return json({ preferences: { diaet, allergene, updatedAt } });
  });
}
