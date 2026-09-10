import { getSessionUser, withAuth } from "./session";
import { checkListAccess } from "./lists";
import { getPreferences, preferencesPrompt } from "./preferences";
import { json, listNotFound, missingSecretMessage, readJson, normKey } from "./util";
import { sha256Base64Url } from "./crypto";
import type { Env, Recipe, RecipeIngredient, RecipeStep, UserPreferences } from "./types";
import categoriesJson from "../public/data/categories.json";

/** Kategorie-Ids aus dem Wörterbuch + „sonstiges“ als Auffangkategorie. */
const CATEGORY_IDS: string[] = [...categoriesJson.map((c) => c.id), "sonstiges"];

const GEMINI_MODEL_DEFAULT = "gemini-3.5-flash-lite";
const OPENROUTER_IMAGE_MODEL_DEFAULT = "google/gemini-3.1-flash-lite-image";
const OPENROUTER_IMAGE_URL = "https://openrouter.ai/api/v1/images";
const GEMINI_URL_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Obergrenzen gegen missbräuchlich große Bodies bzw. entgleiste LLM-Antworten
const MAX_ZUTATEN = 50;
const MAX_SCHRITTE = 30;
const GEMINI_TIMEOUT_MS = 45_000;

// Cache-Version hochzählen, wenn SYSTEM_ANWEISUNG oder responseSchema in
// generateRecipe() sich inhaltlich ändern – alte Cache-Einträge werden dann
// beim nächsten Treffer stillschweigend durch neue ersetzt (kein TTL sonst).
const CACHE_VERSION = 1;

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
  /** Zusätzliche Vorgaben für den Prompt (z. B. Diätform/Ziel/Allergene). */
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

interface GeminiCallOptions {
  systemInstruction: string;
  userContent: string;
  responseSchema: unknown;
  /** Für Fehlermeldungen, z. B. „Rezept-Erstellung“ oder „Vorschlag-Generierung“. */
  kontext: string;
  /**
   * Optionaler Sampling-Parameter (nur setzen, wo Abwechslung gewünscht ist,
   * z. B. Tagesvorschläge). Fehlt er, gilt der Gemini-Default – der
   * Rezept-Pfad bleibt damit bewusst deterministisch.
   */
  temperature?: number;
}

/**
 * Generischer Gemini-Aufruf mit JSON-Zwangsantwort (responseMimeType +
 * responseSchema); liefert den geparsten Antwort-Body. Wirft GeminiError mit
 * deutscher Nutzermeldung.
 */
export async function callGeminiJson(env: Env, options: GeminiCallOptions): Promise<unknown> {
  if (!env.GEMINI_API_KEY) {
    // Gleicher Text wie missingSecret() in util.ts (eine Quelle für die Formulierung).
    throw new GeminiError(500, missingSecretMessage("GEMINI_API_KEY"));
  }

  // Modellname per Env-Var überschreibbar (z. B. fürs Nachziehen neuer
  // Modelle); Default ist ein aktueller Stable-Modellname (gemini-3.5-flash-lite).
  const model = env.GEMINI_MODEL ?? GEMINI_MODEL_DEFAULT;
  const url = `${GEMINI_URL_BASE}/${model}:generateContent`;

  const body = {
    systemInstruction: { parts: [{ text: options.systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: options.userContent }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: options.responseSchema,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    },
  };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), GEMINI_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      throw new GeminiError(504, `Die ${options.kontext} hat zu lange gedauert. Bitte versuch es nochmal.`);
    }
    throw new GeminiError(502, "Der KI-Dienst ist gerade nicht erreichbar. Bitte versuch es gleich nochmal.");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    console.error("Gemini-Fehler:", res.status, await res.text().catch(() => ""));
    throw new GeminiError(502, `Die ${options.kontext} ist fehlgeschlagen. Bitte versuch es nochmal.`);
  }

  let data: GeminiResponse;
  try {
    data = (await res.json()) as GeminiResponse;
  } catch {
    throw new GeminiError(502, "Die Antwort des KI-Dienstes konnte nicht verarbeitet werden.");
  }

  if (data.promptFeedback?.blockReason) {
    throw new GeminiError(400, "Diese Anfrage kann die KI leider nicht umsetzen.");
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new GeminiError(502, "Die Antwort des KI-Dienstes konnte nicht verarbeitet werden.");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiError(502, "Die Antwort des KI-Dienstes konnte nicht verarbeitet werden.");
  }
}

async function generateRecipe(env: Env, options: GenerateRecipeOptions): Promise<Recipe> {
  const raw = await callGeminiJson(env, {
    systemInstruction: SYSTEM_ANWEISUNG,
    userContent: buildUserContent(options),
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
    kontext: "Rezept-Erstellung",
  });

  const recipe = sanitizeRecipe(raw, options.portionen);
  if (!recipe) {
    throw new GeminiError(502, "Die Antwort des KI-Dienstes konnte nicht verarbeitet werden.");
  }
  return recipe;
}

// ---------- Rezept-Bild (OpenRouter Images API, asynchron) ----------

const OPENROUTER_IMAGE_TIMEOUT_MS = 60_000;

/** Kategorie → Food-Emoji-Mapping für den Bild-Prompt. */
const KATEGORIE_EMOJI: Record<string, string> = {
  "obst-gemuese": "🥗",
  "brot-backwaren": "🥖",
  molkerei: "🧀",
  "fleisch-fisch": "🥩",
  trockenware: "🥫",
  "suesses-snacks": "🍰",
  getraenke: "🍹",
  tiefkuehl: "❄️",
  haushalt: "🧴",
  tier: "🦴",
  sonstiges: "🍽️",
};

/** Dominante Kategorie aus den Zutaten ermitteln. */
function dominanteKategorie(zutaten: RecipeIngredient[]): string {
  const counts: Record<string, number> = {};
  for (const z of zutaten) {
    const k = z.kategorie ?? "sonstiges";
    counts[k] = (counts[k] ?? 0) + 1;
  }
  let best = "sonstiges";
  let bestCount = 0;
  for (const [k, c] of Object.entries(counts)) {
    if (c > bestCount) {
      bestCount = c;
      best = k;
    }
  }
  return best;
}

function buildImagePrompt(recipe: Recipe): string {
  const kategorie = dominanteKategorie(recipe.zutaten);
  const emoji = KATEGORIE_EMOJI[kategorie] ?? "🍽️";
  const zutatenText = recipe.zutaten.slice(0, 6).map((z) => z.name).join(", ");
  return (
    `Ein professionelles Food-Foto von „${recipe.titel}“ (${emoji}) ` +
    `auf einem schönen Teller angerichtet, appetitlich und hochwertig beleuchtet. ` +
    `Hauptzutaten: ${zutatenText}. ` +
    `Keine Menschen, keine Hände, keine Text-Overlays, kein Wasserzeichen. ` +
    `Stil: Studio-Food-Fotografie, warme Farben, leichte Schärfentiefe, Draufsicht oder leichter Winkel.`
  );
}

interface OpenRouterImageData {
  b64_json?: string;
  media_type?: string;
}

interface OpenRouterImageResponse {
  data?: OpenRouterImageData[];
  usage?: { cost?: number };
}

/**
 * Ruft ein OpenRouter-Bildmodell auf und liefert base64 + media_type.
 * Gibt null zurück, wenn der Key fehlt, das Freelimit erschöpft ist
 * oder der Dienst nicht antwortet – nie ein throw.
 */
async function callOpenRouterImage(env: Env, prompt: string): Promise<{ base64: string; mediaType: string } | null> {
  if (!env.OPENROUTER_API_KEY) return null;

  const model = env.OPENROUTER_IMAGE_MODEL ?? OPENROUTER_IMAGE_MODEL_DEFAULT;

  // Freelimit getrennt vom Text-Generator zählen.
  const limiter = env.RATE_LIMITER_DO.get(env.RATE_LIMITER_DO.idFromName("openrouter-image"));
  try {
    const limitRes = await limiter.fetch("https://rate-limiter/check", { method: "POST" });
    const limit = (await limitRes.json()) as { ok?: boolean };
    if (!limitRes.ok || !limit.ok) return null;
  } catch {
    return null;
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), OPENROUTER_IMAGE_TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_IMAGE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "http-referer": "https://buylist.app",
        "x-title": "Buylist",
      },
      body: JSON.stringify({ model, prompt, aspect_ratio: "4:3" }),
      signal: abort.signal,
    });
    if (!res.ok) {
      console.error("OpenRouter-Image-Fehler:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const data = (await res.json()) as OpenRouterImageResponse;
    const entry = data?.data?.[0];
    if (!entry?.b64_json) return null;
    if (data.usage?.cost != null) {
      console.log(`OpenRouter-Image-Kosten: $${data.usage.cost.toFixed(6)} (Modell: ${model})`);
    }
    return { base64: entry.b64_json, mediaType: entry.media_type ?? "image/png" };
  } catch (err) {
    console.error("OpenRouter-Image-Netzwerkfehler:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** bild_key und bild_status in der Datenbank setzen. */
async function updateBildStatus(
  db: D1Database,
  recipeId: string,
  bildKey: string | null,
  bildStatus: string
): Promise<void> {
  try {
    await db
      .prepare("UPDATE recipes SET bild_key = ?, bild_status = ? WHERE id = ?")
      .bind(bildKey, bildStatus, recipeId)
      .run();
  } catch (err) {
    console.error("bild_status-Update fehlgeschlagen:", err);
  }
}

/**
 * Asynchrone Bild-Generierung, läuft in ctx.waitUntil.
 * Schlägt fehl (fehlender Key, API-Error, Limit) → bild_status='fehler'.
 * Rezept bleibt in jedem Fall gespeichert.
 */
async function generateRecipeImage(env: Env, recipeId: string, recipe: Recipe): Promise<void> {
  if (!env.OPENROUTER_API_KEY || !env.RECIPE_IMAGES) {
    await updateBildStatus(env.DB, recipeId, null, "fehler");
    return;
  }

  const prompt = buildImagePrompt(recipe);
  const result = await callOpenRouterImage(env, prompt);
  if (!result) {
    await updateBildStatus(env.DB, recipeId, null, "fehler");
    return;
  }

  const key = `rezepte/${recipeId}.png`;
  try {
    const binary = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0));
    await env.RECIPE_IMAGES.put(key, binary, { httpMetadata: { contentType: result.mediaType } });
    await updateBildStatus(env.DB, recipeId, key, "fertig");
  } catch (err) {
    console.error("R2-Upload fehlgeschlagen:", err);
    await updateBildStatus(env.DB, recipeId, null, "fehler");
  }
}

// ---------- Gericht-Cache (global, nur Gericht-Modus) ----------

/**
 * Cache-Key für den globalen Gericht-Cache: Gericht (normalisiert) +
 * Portionen (exakt, keine Skalierung – Mengen wie „1 Bund“ skalieren nicht
 * linear) + Diät + Ziel + sortierte Allergene + CACHE_VERSION, als SHA-256. Nutzt
 * die strukturierten Präferenz-Felder statt des gerenderten Prompt-Strings,
 * damit reine Formulierungsänderungen im Prompt den Cache nicht unnötig
 * invalidieren.
 */
async function recipeCacheKey(gericht: string, portionen: number, prefs: UserPreferences): Promise<string> {
  const allergeneNorm = prefs.allergene.map(normKey).sort();
  const raw = JSON.stringify({
    v: CACHE_VERSION,
    gericht: normKey(gericht),
    portionen,
    diaet: normKey(prefs.diaet),
    allergene: allergeneNorm,
    ...(prefs.ziel !== "keine" ? { ziel: normKey(prefs.ziel) } : {}),
  });
  return sha256Base64Url(raw);
}

async function readRecipeCache(env: Env, key: string): Promise<Recipe | null> {
  try {
    const row = await env.DB.prepare("SELECT rezept FROM recipe_cache WHERE cache_key = ?").bind(key).first<{ rezept: string }>();
    return row ? (JSON.parse(row.rezept) as Recipe) : null;
  } catch {
    return null; // Cache-Fehler dürfen die Generierung nie blockieren.
  }
}

/** Best-effort: ein fehlgeschlagener Cache-Write darf die Antwort nicht kippen. */
async function writeRecipeCache(env: Env, key: string, recipe: Recipe): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO recipe_cache (cache_key, rezept, created_at) VALUES (?, ?, ?)
       ON CONFLICT (cache_key) DO UPDATE SET rezept = excluded.rezept, created_at = excluded.created_at`
    )
      .bind(key, JSON.stringify(recipe), Date.now())
      .run();
  } catch (err) {
    console.error("recipe_cache-Schreibfehler:", err);
  }
}

/** Wie lange ein Cache-Eintrag höchstens liegen bleibt, bevor er im Cron gelöscht wird. */
const RECIPE_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Tägliche Bereinigung: löscht Cache-Einträge, die älter als 90 Tage sind,
 * damit die globale Tabelle nicht unbegrenzt wächst (jede Diät/Allergen/
 * Portionen-Kombination erzeugt eigene Zeilen).
 */
export async function runRecipeCacheCleanup(env: Env): Promise<number> {
  try {
    const res = await env.DB.prepare("DELETE FROM recipe_cache WHERE created_at < ?")
      .bind(Date.now() - RECIPE_CACHE_TTL_MS)
      .run();
    return res.meta.changes;
  } catch (err) {
    // Ein fehlgeschlagener Cleanup darf den restlichen Cron nicht kippen.
    console.error("recipe_cache-Bereinigung fehlgeschlagen:", err);
    return 0;
  }
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
    if (!(await checkListAccess(env, listId, user.id))) return listNotFound();

    const body = await readJson<GenerateBody>(request);
    const gericht = typeof body?.gericht === "string" ? body.gericht.trim().slice(0, 120) : "";
    const zutaten = sanitizeZutatenListe(body?.zutaten);
    if (!gericht && !zutaten.length) {
      return json({ error: "Bitte gib ein Gericht oder eine Zutatenliste an." }, 400);
    }

    const portionenRaw = typeof body?.portionen === "number" ? Math.round(body.portionen) : 2;
    const portionen = Math.min(12, Math.max(1, portionenRaw || 2));

    const prefs = await getPreferences(env.DB, user.id);
    const praeferenzen = preferencesPrompt(prefs) || undefined;

    // Cache nur im Gericht-Modus (expliziter Gerichtsname) – Resteverwertung
    // bleibt unverändert immer live generiert, da der Zutaten-Input praktisch
    // nie identisch zwischen zwei Anfragen ist.
    let cacheKey: string | null = null;
    if (gericht) {
      cacheKey = await recipeCacheKey(gericht, portionen, prefs);
      const cached = await readRecipeCache(env, cacheKey);
      if (cached) return json({ rezept: cached });
    }

    // Freelimit: erst nach allen Prüfungen (inkl. Cache-Miss) zählen, damit
    // Cache-Treffer und ungültige Requests kein Kontingent verbrauchen.
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
      if (cacheKey) await writeRecipeCache(env, cacheKey, rezept);
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
    if (!(await checkListAccess(env, listId, user.id))) return listNotFound();

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
  bild_key: string | null;
  bild_status: string | null;
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
    ...(row.bild_key ? { bildUrl: `/media/rezept/${row.id}` } : {}),
    ...(row.bild_status ? { bildStatus: row.bild_status as Recipe["bildStatus"] } : {}),
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
}

/**
 * POST /api/list/:id/recipes – speichert ein Rezept in der Gerichte-Sammlung.
 * Auf eine Einkaufsliste kommt es bewusst erst beim Zuschalten
 * (POST /api/list/:id/gerichte), nicht mehr automatisch beim Speichern.
 * Nach dem Speichern wird asynchron (ctx.waitUntil) ein KI-Bild generiert.
 */
export async function handleSaveRecipe(request: Request, env: Env, ctx: ExecutionContext, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await checkListAccess(env, listId, user.id))) return listNotFound();

    const body = await readJson<SaveBody>(request);
    const recipe = sanitizeRecipe(body, 2);
    if (!recipe) return json({ error: "Das Rezept ist unvollständig." }, 400);

    const id = crypto.randomUUID();
    const now = Date.now();
    const hatBildKey = env.OPENROUTER_API_KEY && env.RECIPE_IMAGES;
    await env.DB.prepare(
      `INSERT INTO recipes (id, list_id, titel, zeit, portionen, zutaten, schritte, created_by, created_at, bild_key, bild_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    )
      .bind(
        id, listId, recipe.titel, recipe.zeit ?? null, recipe.portionen,
        JSON.stringify(recipe.zutaten), JSON.stringify(recipe.schritte), user.id, now,
        hatBildKey ? "pending" : null
      )
      .run();

    const responseRecipe = { ...recipe, id, createdAt: now };
    if (hatBildKey) {
      responseRecipe.bildStatus = "pending";
      ctx.waitUntil(generateRecipeImage(env, id, recipe));
    }

    return json({ rezept: responseRecipe }, 201);
  });
}

interface ZuschaltenBody {
  gerichte?: unknown;
}

/**
 * POST /api/list/:id/gerichte – schaltet gespeicherte Gerichte auf die Liste.
 * Titel/Portionen/Zutaten kommen serverseitig aus D1; optional schränkt
 * `nur` (Namen) die Zutaten ein, z. B. „habe ich schon zu Hause“.
 */
export async function handleZuschalten(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await checkListAccess(env, listId, user.id))) return listNotFound();

    const body = await readJson<ZuschaltenBody>(request);
    const rawList = Array.isArray(body?.gerichte) ? body.gerichte.slice(0, 20) : [];
    const wuensche: { id: string; nur: Set<string> | null; supermarkt?: string }[] = [];
    for (const raw of rawList) {
      if (typeof raw !== "object" || raw === null) continue;
      const id = (raw as Record<string, unknown>).id;
      if (typeof id !== "string" || !id) continue;
      const nurRaw = (raw as Record<string, unknown>).nur;
      const nur = Array.isArray(nurRaw)
        ? new Set(nurRaw.filter((n): n is string => typeof n === "string").map(normKey))
        : null;
      const supermarktRaw = (raw as Record<string, unknown>).supermarkt;
      const supermarkt =
        typeof supermarktRaw === "string" && supermarktRaw.trim()
          ? supermarktRaw.trim().replace(/\s+/g, " ").slice(0, 40)
          : undefined;
      wuensche.push({ id, nur, ...(supermarkt ? { supermarkt } : {}) });
    }
    if (!wuensche.length) return json({ error: "Keine Gerichte übergeben." }, 400);

    // Rezepte nur aus Listen, in denen der Nutzer Mitglied ist – und die
    // Inhaltsstoffe (Titel, Portionen, Zutaten) kommen aus D1, nicht vom Client.
    const ids = wuensche.map((w) => w.id);
    const platzhalter = ids.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT r.id, r.titel, r.portionen, r.zutaten
       FROM recipes r
       JOIN list_memberships m ON m.list_id = r.list_id AND m.user_id = ?
       WHERE r.id IN (${platzhalter})`
    )
      .bind(user.id, ...ids)
      .all<{ id: string; titel: string; portionen: number; zutaten: string }>();

    const gefundene = new Map(results.map((row) => [row.id, row]));
    const gerichte: {
      id: string;
      titel: string;
      portionen: number;
      zutaten: RecipeIngredient[];
      supermarkt?: string;
    }[] = [];
    for (const wunsch of wuensche) {
      const row = gefundene.get(wunsch.id);
      if (!row) continue;
      const alle = safeParse<RecipeIngredient[]>(row.zutaten, []);
      const zutaten = wunsch.nur ? alle.filter((z) => wunsch.nur!.has(normKey(z.name))) : alle;
      gerichte.push({
        id: row.id,
        titel: row.titel,
        portionen: row.portionen,
        zutaten,
        ...(wunsch.supermarkt ? { supermarkt: wunsch.supermarkt } : {}),
      });
    }
    if (!gerichte.length) return json({ error: "Rezept nicht gefunden." }, 404);

    const stub = env.SHOPPING_LIST_DO.get(env.SHOPPING_LIST_DO.idFromName(listId));
    const doRes = await stub.fetch("https://do/add-gerichte", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listId, displayName: user.displayName, gerichte }),
    });
    if (!doRes.ok) return json({ error: "Die Gerichte konnten nicht zugeschaltet werden." }, 502);

    const data = (await doRes.json()) as { added?: number };
    return json({ added: data.added ?? 0 });
  });
}

/**
 * DELETE /api/list/:id/gerichte/:gerichtId – schaltet ein Gericht wieder ab:
 * der Zustandseintrag verschwindet, offene Zutaten fliegen von der Liste.
 */
export async function handleAbschalten(request: Request, env: Env, listId: string, gerichtId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await checkListAccess(env, listId, user.id))) return listNotFound();

    const stub = env.SHOPPING_LIST_DO.get(env.SHOPPING_LIST_DO.idFromName(listId));
    const doRes = await stub.fetch("https://do/remove-gericht", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listId, gerichtId }),
    });
    if (!doRes.ok) return json({ error: "Das Gericht konnte nicht ausgeschaltet werden." }, 502);

    const data = (await doRes.json()) as { removed?: number };
    return json({ ok: true, removed: data.removed ?? 0 });
  });
}

/** GET /api/recipes – alle Rezepte des Users über alle seine Listen, neueste zuerst. */
export async function handleGetAllRecipes(request: Request, env: Env): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    const { results } = await env.DB.prepare(
      `SELECT r.id, r.titel, r.zeit, r.portionen, r.zutaten, r.schritte, r.created_by, r.created_at,
              r.bild_key, r.bild_status,
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
    if (!(await checkListAccess(env, listId, user.id))) return listNotFound();

    const { results } = await env.DB.prepare(
      `SELECT id, titel, zeit, portionen, zutaten, schritte, created_by, created_at, bild_key, bild_status
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
    if (!(await checkListAccess(env, listId, user.id))) return listNotFound();

    // R2-Bild-Key vor dem Löschen merken
    let bildKey: string | null = null;
    try {
      const row = await env.DB.prepare("SELECT bild_key FROM recipes WHERE id = ? AND list_id = ?")
        .bind(recipeId, listId)
        .first<{ bild_key: string | null }>();
      bildKey = row?.bild_key ?? null;
    } catch {
      // ignorieren
    }

    const result = await env.DB.prepare("DELETE FROM recipes WHERE id = ? AND list_id = ?")
      .bind(recipeId, listId)
      .run();
    if (!result.meta.changes) return json({ error: "Rezept nicht gefunden." }, 404);

    // R2-Objekt asynchron löschen (fehlschlagen ist ok)
    if (bildKey && env.RECIPE_IMAGES) {
      env.RECIPE_IMAGES.delete(bildKey).catch(() => {});
    }

    return json({ ok: true });
  });
}

/**
 * GET /media/rezept/:id – liefert das asynchron generierte Rezept-Bild.
 * Auth und Listen-Zugriff werden hier geprüft (kein /api/-Prefix, daher kein
 * withAuth). Der SW cached stale-while-revalidate, damit Bilder offline sind.
 */
export async function handleGetRecipeImage(request: Request, env: Env, recipeId: string): Promise<Response> {
  const session = await getSessionUser(env.DB, request);
  if (!session) return new Response("Nicht eingeloggt.", { status: 401 });

  const row = await env.DB.prepare(
    "SELECT r.bild_key, r.list_id FROM recipes r WHERE r.id = ?"
  )
    .bind(recipeId)
    .first<{ bild_key: string | null; list_id: string }>();
  if (!row || !row.bild_key) return new Response("Nicht gefunden.", { status: 404 });

  if (!(await checkListAccess(env, row.list_id, session.user.id))) {
    return new Response("Nicht gefunden.", { status: 404 });
  }

  try {
    const obj = await env.RECIPE_IMAGES.get(row.bild_key);
    if (!obj) return new Response("Nicht gefunden.", { status: 404 });
    return new Response(obj.body, {
      headers: {
        "content-type": obj.httpMetadata?.contentType ?? "image/png",
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Nicht gefunden.", { status: 404 });
  }
}

/**
 * POST /api/list/:id/recipes/:recipeId/bild – wiederholt die Bild-Generierung
 * für ein Rezept, dessen vorheriger Versuch fehlgeschlagen ist (bild_status = 'fehler').
 */
export async function handleRetryRecipeImage(request: Request, env: Env, listId: string, recipeId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await checkListAccess(env, listId, user.id))) return listNotFound();

    const row = await env.DB.prepare(
      "SELECT bild_status FROM recipes WHERE id = ? AND list_id = ?"
    )
      .bind(recipeId, listId)
      .first<{ bild_status: string | null }>();
    if (!row) return json({ error: "Rezept nicht gefunden." }, 404);
    if (!env.OPENROUTER_API_KEY || !env.RECIPE_IMAGES) {
      return json({ error: "Bild-Generierung nicht konfiguriert." }, 400);
    }

    // Auf pending setzen, damit der Client das Skeleton sieht
    await updateBildStatus(env.DB, recipeId, null, "pending");

    // Rezept laden für den Prompt
    const recipeRow = await env.DB.prepare(
      "SELECT titel, zeit, portionen, zutaten, schritte FROM recipes WHERE id = ?"
    )
      .bind(recipeId)
      .first<{ titel: string; zeit: string | null; portionen: number; zutaten: string; schritte: string }>();
    if (!recipeRow) return json({ error: "Rezept nicht gefunden." }, 404);

    const recipe: Recipe = {
      titel: recipeRow.titel,
      zeit: recipeRow.zeit ?? undefined,
      portionen: recipeRow.portionen,
      zutaten: safeParse(recipeRow.zutaten, [] as RecipeIngredient[]),
      schritte: parseSteps(safeParse<unknown>(recipeRow.schritte, [])),
    };

    // Bild-Generierung feuern und auf Ergebnis warten (synchron für den Client)
    const prompt = buildImagePrompt(recipe);
    const result = await callOpenRouterImage(env, prompt);
    if (!result) {
      await updateBildStatus(env.DB, recipeId, null, "fehler");
      return json({ error: "Bild-Generierung fehlgeschlagen. Bitte später erneut versuchen." }, 502);
    }

    const key = `rezepte/${recipeId}.png`;
    try {
      const binary = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0));
      await env.RECIPE_IMAGES.put(key, binary, { httpMetadata: { contentType: result.mediaType } });
      await updateBildStatus(env.DB, recipeId, key, "fertig");
      return json({ ok: true, bildUrl: `/media/rezept/${recipeId}` });
    } catch (err) {
      console.error("R2-Upload fehlgeschlagen:", err);
      await updateBildStatus(env.DB, recipeId, null, "fehler");
      return json({ error: "Bild-Generierung fehlgeschlagen." }, 502);
    }
  });
}
