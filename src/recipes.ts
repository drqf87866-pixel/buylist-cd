import { withAuth } from "./session";
import { isMember } from "./lists";
import { getPreferences, preferencesPrompt } from "./preferences";
import { json, readJson } from "./util";
import type { Env, Recipe, RecipeIngredient, RecipeStep } from "./types";
import categoriesJson from "../public/data/categories.json";

/** Kategorie-Ids aus dem Wörterbuch + „sonstiges“ als Auffangkategorie. */
const CATEGORY_IDS: string[] = [...categoriesJson.map((c) => c.id), "sonstiges"];

const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Obergrenzen gegen missbräuchlich große Bodies bzw. entgleiste LLM-Antworten
const MAX_ZUTATEN = 50;
const MAX_SCHRITTE = 30;
const GEMINI_TIMEOUT_MS = 45_000;

/** 404 statt 403, damit die Existenz fremder Listen nicht aufscheint. */
function notFound(): Response {
  return json({ error: "Liste nicht gefunden." }, 404);
}

async function checkListAccess(env: Env, listId: string, userId: string): Promise<boolean> {
  const member = await isMember(env.DB, listId, userId);
  if (!member) return false;
  const meta = await env.DB.prepare("SELECT 1 AS x FROM lists WHERE id = ?").bind(listId).first();
  return meta !== null;
}

// ---------- Gemini ----------

const SYSTEM_ANWEISUNG = `Du bist ein Kochassistent für eine Einkaufslisten-App. Erstelle ein Rezept mit passender Einkaufsliste.
Regeln:
- Antworte auf Deutsch.
- Skaliere alle Zutatenmengen exakt auf die gewünschte Portionenzahl.
- Gib praktische Einkaufsmengen mit handelsüblichen Einheiten an (z. B. "500 g", "2 EL", "1 Bund", "2 Dosen").
- Ordne jede Zutat der passenden kategorie zu: "obst-gemuese", "brot-backwaren", "molkerei", "fleisch-fisch", "trockenware" (Vorrat, Öl, Gewürze, Konserven), "suesses-snacks", "getraenke", "tiefkuehl", "haushalt", "tier", "sonstiges" (nur wenn nichts anderes passt).
- "zeit" ist die ungefähre Zubereitungszeit (z. B. "ca. 30 Minuten").
- Die Schritte sind kurze, klare Anweisungen ohne Nummerierung im Text.
- Hat ein Schritt eine Koch-, Back- oder Wartezeit (z. B. "8 Minuten köcheln lassen"), setze timerSekunden auf diese Dauer in Sekunden; sonst lasse timerSekunden weg.
- Bekommt der Nutzer eine Zutatenliste ("Verfügbare Zutaten"), erstelle ein Gericht, das möglichst viele davon verwendet. Fehlende Zutaten ergänzt du höchstens minimal.`;

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

interface GenerateRecipeOptions {
  /** Entweder ein Gericht … */
  gericht?: string;
  /** … oder eine Liste verfügbarer Zutaten (Resteverwertung). */
  zutaten?: string[];
  portionen: number;
  /** Zusätzliche Vorgaben für den Prompt (z. B. Diätform/Allergene aus 4.1). */
  praeferenzen?: string;
}

function buildUserContent({ gericht, zutaten, portionen, praeferenzen }: GenerateRecipeOptions): string {
  const parts: string[] = [];
  if (gericht) {
    parts.push(`Gericht: "${gericht}"`);
  } else if (zutaten && zutaten.length) {
    parts.push(`Verfügbare Zutaten: ${zutaten.join(", ")}`);
    parts.push("Erstelle ein Rezept, das möglichst viele dieser Zutaten verwendet. Fehlende Zutaten nur minimal ergänzen.");
  } else {
    parts.push("Schlage ein beliebiges passendes Gericht vor.");
  }
  parts.push(`Portionen: ${portionen}`);
  if (praeferenzen) parts.push(praeferenzen);
  return parts.join("\n");
}

async function generateRecipe(env: Env, options: GenerateRecipeOptions): Promise<Recipe> {
  if (!env.GEMINI_API_KEY) {
    throw new GeminiError(500, "Der Server hat keinen Gemini-API-Key konfiguriert.");
  }

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_ANWEISUNG }] },
    contents: [{ role: "user", parts: [{ text: buildUserContent(options) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          titel: { type: "STRING" },
          zeit: { type: "STRING" },
          zutaten: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                name: { type: "STRING" },
                menge: { type: "STRING" },
                kategorie: { type: "STRING", enum: CATEGORY_IDS },
              },
              required: ["name"],
            },
          },
          schritte: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: { text: { type: "STRING" }, timerSekunden: { type: "INTEGER" } },
              required: ["text"],
            },
          },
        },
        required: ["titel", "zutaten", "schritte"],
      },
    },
  };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), GEMINI_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      throw new GeminiError(504, "Die Rezept-Erstellung hat zu lange gedauert. Bitte versuch es nochmal.");
    }
    throw new GeminiError(502, "Der KI-Dienst ist gerade nicht erreichbar. Bitte versuch es gleich nochmal.");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    console.error("Gemini-Fehler:", res.status, await res.text().catch(() => ""));
    throw new GeminiError(502, "Die Rezept-Erstellung ist fehlgeschlagen. Bitte versuch es nochmal.");
  }

  let data: GeminiResponse;
  try {
    data = (await res.json()) as GeminiResponse;
  } catch {
    throw new GeminiError(502, "Die Antwort des KI-Dienstes konnte nicht verarbeitet werden.");
  }

  if (data.promptFeedback?.blockReason) {
    throw new GeminiError(400, "Dieses Gericht kann ich leider nicht in ein Rezept umsetzen.");
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new GeminiError(502, "Die Antwort des KI-Dienstes konnte nicht verarbeitet werden.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GeminiError(502, "Die Antwort des KI-Dienstes konnte nicht verarbeitet werden.");
  }

  const recipe = sanitizeRecipe(raw, options.portionen);
  if (!recipe) {
    throw new GeminiError(502, "Die Antwort des KI-Dienstes konnte nicht verarbeitet werden.");
  }
  return recipe;
}

/** Fehler mit HTTP-Status und deutscher Nutzermeldung. */
export class GeminiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/** Kategorie-Id prüfen: nur Werte aus dem Wörterbuch durchlassen. */
function sanitizeKategorie(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return CATEGORY_IDS.includes(trimmed) ? trimmed : undefined;
}

/**
 * Prüft ein (vom LLM oder Client geliefertes) Rezept strikt und kürzt es auf
 * erlaubte Längen; null, wenn titel/zutaten/schritte nicht verwertbar sind.
 */
function sanitizeRecipe(raw: unknown, defaultPortionen: number): Recipe | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const titel = typeof obj.titel === "string" ? obj.titel.trim().slice(0, 120) : "";
  if (!titel) return null;

  const zeit = typeof obj.zeit === "string" && obj.zeit.trim() ? obj.zeit.trim().slice(0, 40) : undefined;

  const portionenRaw = typeof obj.portionen === "number" ? Math.round(obj.portionen) : defaultPortionen;
  const portionen = Math.min(12, Math.max(1, portionenRaw || defaultPortionen));

  if (!Array.isArray(obj.zutaten) || !Array.isArray(obj.schritte)) return null;

  const zutaten: RecipeIngredient[] = [];
  for (const entry of obj.zutaten.slice(0, MAX_ZUTATEN)) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = typeof (entry as Record<string, unknown>).name === "string"
      ? ((entry as Record<string, unknown>).name as string).trim().slice(0, 120)
      : "";
    if (!name) continue;
    const mengeRaw = (entry as Record<string, unknown>).menge;
    const menge = typeof mengeRaw === "string" && mengeRaw.trim() ? mengeRaw.trim().slice(0, 40) : undefined;
    const kategorie = sanitizeKategorie((entry as Record<string, unknown>).kategorie);
    zutaten.push({ name, ...(menge ? { menge } : {}), ...(kategorie ? { kategorie } : {}) });
  }
  if (!zutaten.length) return null;

  const schritte: RecipeStep[] = [];
  for (const entry of obj.schritte.slice(0, MAX_SCHRITTE)) {
    const step = parseStep(entry);
    if (step) schritte.push(step);
  }
  if (!schritte.length) return null;

  return { titel, zeit, portionen, zutaten, schritte };
}

/**
 * Ein Kochschritt: neuer Stand als Objekt {text, timerSekunden?}, alter Stand
 * als reiner String. Akzeptiert beides, damit gespeicherte Rezepte ohne
 * Migration weiter funktionieren. Timer werden auf 1 s–2 h begrenzt.
 */
export function parseStep(entry: unknown): RecipeStep | null {
  let text = "";
  let timer: number | undefined;
  if (typeof entry === "string") {
    text = entry;
  } else if (typeof entry === "object" && entry !== null) {
    const o = entry as Record<string, unknown>;
    if (typeof o.text !== "string") return null;
    text = o.text;
    if (typeof o.timerSekunden === "number" && Number.isFinite(o.timerSekunden) && o.timerSekunden > 0) {
      timer = Math.min(7200, Math.round(o.timerSekunden));
    }
  } else {
    return null;
  }
  text = text.trim().slice(0, 500);
  if (!text) return null;
  return timer ? { text, timerSekunden: timer } : { text };
}

function parseSteps(raw: unknown): RecipeStep[] {
  if (!Array.isArray(raw)) return [];
  const out: RecipeStep[] = [];
  for (const entry of raw.slice(0, MAX_SCHRITTE)) {
    const step = parseStep(entry);
    if (step) out.push(step);
  }
  return out;
}

// ---------- HTTP-Handler ----------

interface GenerateBody {
  gericht?: unknown;
  /** Alternative zu `gericht`: verfügbare Zutaten für die Resteverwertung. */
  zutaten?: unknown;
  portionen?: unknown;
}

/** Freitext-Zutatenliste sauber als string[] (max. 50, je 60 Zeichen). */
function sanitizeZutatenListe(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw.slice(0, 50)) {
    if (typeof entry !== "string") continue;
    const name = entry.trim().slice(0, 60);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** POST /api/list/:id/generate – ruft Gemini auf und liefert ein Rezept zur Vorschau (kein Speichern). */
export async function handleGenerate(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await checkListAccess(env, listId, user.id))) return notFound();

    const body = await readJson<GenerateBody>(request);
    const gericht = typeof body?.gericht === "string" ? body.gericht.trim().slice(0, 120) : "";
    const zutaten = sanitizeZutatenListe(body?.zutaten);
    if (!gericht && !zutaten.length) {
      return json({ error: "Bitte gib ein Gericht oder eine Zutatenliste an." }, 400);
    }

    const portionenRaw = typeof body?.portionen === "number" ? Math.round(body.portionen) : 2;
    const portionen = Math.min(12, Math.max(1, portionenRaw || 2));

    const praeferenzen = preferencesPrompt(await getPreferences(env.DB, user.id)) || undefined;

    // Freelimit: erst nach allen Prüfungen zählen, damit ungültige Requests
    // kein Kontingent verbrauchen.
    const limiter = env.RATE_LIMITER_DO.get(env.RATE_LIMITER_DO.idFromName("gemini"));
    const limitRes = await limiter.fetch("https://rate-limiter/check", { method: "POST" });
    const limit = (await limitRes.json()) as { ok?: boolean; retryAfterSec?: number };
    if (!limitRes.ok || !limit.ok) {
      const wait = limit.retryAfterSec ?? 60;
      return json(
        {
          error: `Die KI macht gerade eine Pause (Free-Tier-Limit). Bitte in ${wait} Sekunden nochmal versuchen.`,
        },
        429,
        { "retry-after": String(wait) }
      );
    }

    try {
      const rezept = await generateRecipe(env, { gericht, zutaten, portionen, praeferenzen });
      return json({ rezept });
    } catch (err) {
      if (err instanceof GeminiError) return json({ error: err.message }, err.status);
      throw err;
    }
  });
}

/**
 * Prüft eine Liste von Zutaten/Artikeln und kürzt sie auf erlaubte Längen.
 * Wird für gespeicherte Rezepte und direkte Batch-Additions genutzt.
 */
function sanitizeItems(raw: unknown): RecipeIngredient[] {
  if (!Array.isArray(raw)) return [];
  const out: RecipeIngredient[] = [];
  for (const entry of raw.slice(0, MAX_ZUTATEN)) {
    if (typeof entry !== "object" || entry === null) continue;
    const nameRaw = (entry as Record<string, unknown>).name;
    const name = typeof nameRaw === "string" ? nameRaw.trim().slice(0, 120) : "";
    if (!name) continue;
    const mengeRaw = (entry as Record<string, unknown>).menge;
    const menge = typeof mengeRaw === "string" && mengeRaw.trim() ? mengeRaw.trim().slice(0, 40) : undefined;
    const kategorie = sanitizeKategorie((entry as Record<string, unknown>).kategorie);
    out.push({ name, ...(menge ? { menge } : {}), ...(kategorie ? { kategorie } : {}) });
  }
  return out;
}

interface ItemsBody {
  items?: unknown;
}

/** POST /api/list/:id/items – legt mehrere Artikel auf die Liste (ohne Rezept zu speichern). */
export async function handleAddItems(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await checkListAccess(env, listId, user.id))) return notFound();

    const body = await readJson<ItemsBody>(request);
    const items = sanitizeItems(body?.items);
    if (!items.length) return json({ error: "Keine gültigen Artikel." }, 400);

    const stub = env.SHOPPING_LIST_DO.get(env.SHOPPING_LIST_DO.idFromName(listId));
    const doRes = await stub.fetch("https://do/add-items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listId, displayName: user.displayName, items }),
    });
    if (!doRes.ok) return json({ error: "Die Artikel konnten nicht hinzugefügt werden." }, 502);

    const data = (await doRes.json()) as { added?: number };
    return json({ added: data.added ?? 0 });
  });
}

interface RecipeRow {
  id: string;
  titel: string;
  zeit: string | null;
  portionen: number;
  zutaten: string;
  schritte: string;
  created_by: string;
  created_at: number;
}

function rowToRecipe(row: RecipeRow): Recipe {
  return {
    id: row.id,
    titel: row.titel,
    zeit: row.zeit ?? undefined,
    portionen: row.portionen,
    zutaten: safeParse(row.zutaten, [] as RecipeIngredient[]),
    schritte: parseSteps(safeParse<unknown>(row.schritte, [])),
    createdAt: row.created_at,
  };
}

function safeParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

interface SaveBody {
  titel?: unknown;
  zeit?: unknown;
  portionen?: unknown;
  zutaten?: unknown;
  schritte?: unknown;
  /** Nur diese Zutaten (statt aller) auf die Liste legen – z. B. „habe ich schon zu Hause“. */
  aufListe?: unknown;
}

/**
 * POST /api/list/:id/recipes – speichert ein Rezept dauerhaft und legt die
 * Zutaten auf die Einkaufsliste (ein Broadcast für alle verbundenen Clients).
 * Wird `aufListe` mitgegeben, landen nur diese Zutaten auf der Liste.
 */
export async function handleSaveRecipe(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await checkListAccess(env, listId, user.id))) return notFound();

    const body = await readJson<SaveBody>(request);
    const recipe = sanitizeRecipe(body, 2);
    if (!recipe) return json({ error: "Das Rezept ist unvollständig." }, 400);

    const aufListe = sanitizeItems(body?.aufListe);
    const items = aufListe.length ? aufListe : recipe.zutaten;

    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO recipes (id, list_id, titel, zeit, portionen, zutaten, schritte, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, listId, recipe.titel, recipe.zeit ?? null, recipe.portionen, JSON.stringify(recipe.zutaten), JSON.stringify(recipe.schritte), user.id, now)
      .run();

    let added = 0;
    try {
      const stub = env.SHOPPING_LIST_DO.get(env.SHOPPING_LIST_DO.idFromName(listId));
      const doRes = await stub.fetch("https://do/add-items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listId, displayName: user.displayName, items }),
      });
      if (doRes.ok) {
        const data = (await doRes.json()) as { added?: number };
        added = data.added ?? 0;
      }
    } catch (err) {
      console.error("Add-Items fehlgeschlagen:", err);
    }

    return json({ rezept: { ...recipe, id, createdAt: now }, added }, 201);
  });
}

/** GET /api/recipes – alle Rezepte des Users über alle seine Listen, neueste zuerst. */
export async function handleGetAllRecipes(request: Request, env: Env): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    const { results } = await env.DB.prepare(
      `SELECT r.id, r.titel, r.zeit, r.portionen, r.zutaten, r.schritte, r.created_by, r.created_at,
              r.list_id AS list_id, l.name AS list_name
       FROM recipes r
       JOIN list_memberships m ON m.list_id = r.list_id AND m.user_id = ?
       JOIN lists l ON l.id = r.list_id
       ORDER BY r.created_at DESC
       LIMIT 200`
    )
      .bind(user.id)
      .all<RecipeRow & { list_id: string; list_name: string }>();

    return json({
      rezepte: results.map((row) => ({ ...rowToRecipe(row), listId: row.list_id, listName: row.list_name })),
    });
  });
}

/** GET /api/list/:id/recipes – alle gespeicherten Rezepte der Liste. */
export async function handleGetRecipes(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await checkListAccess(env, listId, user.id))) return notFound();

    const { results } = await env.DB.prepare(
      `SELECT id, titel, zeit, portionen, zutaten, schritte, created_by, created_at
       FROM recipes WHERE list_id = ? ORDER BY created_at DESC`
    )
      .bind(listId)
      .all<RecipeRow>();

    return json({ rezepte: results.map(rowToRecipe) });
  });
}

/** DELETE /api/list/:id/recipes/:recipeId – löscht ein Rezept dieser Liste. */
export async function handleDeleteRecipe(request: Request, env: Env, listId: string, recipeId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await checkListAccess(env, listId, user.id))) return notFound();

    const result = await env.DB.prepare("DELETE FROM recipes WHERE id = ? AND list_id = ?")
      .bind(recipeId, listId)
      .run();
    if (!result.meta.changes) return json({ error: "Rezept nicht gefunden." }, 404);

    return json({ ok: true });
  });
}
