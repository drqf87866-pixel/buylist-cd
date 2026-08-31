import { withAuth } from "./session";
import { checkListAccess } from "./lists";
import { json, listNotFound, missingSecretMessage, readJson, normKey } from "./util";
import type { Env, RecipeIngredient } from "./types";
import categoriesJson from "../public/data/categories.json";

const CATEGORY_IDS: string[] = [...categoriesJson.map((c) => c.id), "sonstiges"];

const MAX_TEXT = 400;
const MAX_ITEMS = 30;
const MAX_VORHANDENE = 40;
const GROQ_TIMEOUT_MS = 20_000;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
/** Schnell, JSON-Schema strict; nach Llama-Abschaltung (2026-08) der Groq-Default. */
const GROQ_MODEL_DEFAULT = "openai/gpt-oss-20b";
/** 27/min, knapp unter Groq-Free-30-RPM; per GROQ_RPM anhebbar. */
export const GROQ_MAX_REQUESTS_DEFAULT = 27;

const SYSTEM_ANWEISUNG = `Du zerlegst einen gesprochenen oder getippten Einkaufszettel in einzelne Artikel für eine Einkaufslisten-App.
Regeln:
- Antworte auf Deutsch, nur als JSON gemäß Schema.
- Jeder Artikel hat "name" (kurz, einkaufstauglich, ohne Mengenangabe im Namen).
- "menge" ist eine handelsübliche Angabe (z. B. "2 l", "6 Stück", "500 g") oder ein leerer String, wenn keine Menge genannt wurde.
- "kategorie" ist genau einer der erlaubten Werte.
- Ein Artikel pro genannter Sache. Nicht zusammenfassen, was der Nutzer getrennt genannt hat.
- Erfinde keine Artikel, die im Text nicht angelegt sind.
- Ausnahme vage Sammelbegriffe ("was zum Grillen", "was zu trinken", "Snacks"): löse sie in 1–3 konkrete Alltagsartikel auf, nicht in ein ganzes Buffet.
- Steht eine Liste bekannter Artikel, verwende bei gleicher Sache denselben Namen (z. B. "Semmeln" → "Brötchen", wenn Brötchen bekannt ist). Füge die bekannten Artikel nicht extra hinzu.`;

function sanitizeKategorie(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return CATEGORY_IDS.includes(trimmed) ? trimmed : undefined;
}

function sanitizeVorhandene(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_VORHANDENE)) {
    if (typeof entry !== "string") continue;
    const name = entry.trim().slice(0, 120);
    const key = normKey(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** LLM- oder Client-Array zu gültigen Artikeln; Duplikate (normKey) fallen raus. */
export function sanitizeParsedItems(raw: unknown): RecipeIngredient[] {
  if (!Array.isArray(raw)) return [];
  const out: RecipeIngredient[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_ITEMS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim().slice(0, 120) : "";
    if (!name) continue;
    const key = normKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const mengeRaw = obj.menge;
    const menge = typeof mengeRaw === "string" && mengeRaw.trim() ? mengeRaw.trim().slice(0, 40) : undefined;
    const kategorie = sanitizeKategorie(obj.kategorie);
    out.push({ name, ...(menge ? { menge } : {}), ...(kategorie ? { kategorie } : {}) });
  }
  return out;
}

function unwrapItems(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object" && raw !== null && Array.isArray((raw as { items?: unknown }).items)) {
    return (raw as { items: unknown[] }).items;
  }
  return [];
}

export function groqMaxRequests(rpmRaw: string | undefined): number {
  const n = Number(rpmRaw);
  if (!Number.isFinite(n) || n < 1) return GROQ_MAX_REQUESTS_DEFAULT;
  return Math.min(120, Math.round(n));
}

class ParseError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

interface GroqChatResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

const PARSE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          menge: { type: "string" },
          kategorie: { type: "string", enum: CATEGORY_IDS },
        },
        required: ["name", "menge", "kategorie"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

async function parseDumpWithGroq(
  env: Env,
  text: string,
  vorhandene: string[]
): Promise<RecipeIngredient[]> {
  if (!env.GROQ_API_KEY) {
    throw new ParseError(500, missingSecretMessage("GROQ_API_KEY"));
  }

  const parts = [`Einkaufszettel: "${text}"`];
  if (vorhandene.length) {
    parts.push(
      `Bereits bekannte Artikel (bei gleicher Sache denselben Namen verwenden, nicht extra hinzufügen): ${vorhandene.join(", ")}`
    );
  }

  const model = env.GROQ_MODEL?.trim() || GROQ_MODEL_DEFAULT;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), GROQ_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_ANWEISUNG },
          { role: "user", content: parts.join("\n") },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "einkaufszettel",
            strict: true,
            schema: PARSE_SCHEMA,
          },
        },
      }),
      signal: abort.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      throw new ParseError(504, "Die Einkaufszettel-Erkennung hat zu lange gedauert. Bitte versuch es nochmal.");
    }
    throw new ParseError(502, "Der KI-Dienst ist gerade nicht erreichbar. Bitte versuch es gleich nochmal.");
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    throw new ParseError(429, "Die KI macht gerade eine Pause (Rate-Limit). Bitte gleich nochmal versuchen.");
  }
  if (!res.ok) {
    console.error("Groq-Fehler:", res.status, await res.text().catch(() => ""));
    throw new ParseError(502, "Die Einkaufszettel-Erkennung ist fehlgeschlagen. Bitte versuch es nochmal.");
  }

  let data: GroqChatResponse;
  try {
    data = (await res.json()) as GroqChatResponse;
  } catch {
    throw new ParseError(502, "Die Antwort des KI-Dienstes konnte nicht verarbeitet werden.");
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new ParseError(502, "Die Antwort des KI-Dienstes konnte nicht verarbeitet werden.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ParseError(502, "Die Antwort des KI-Dienstes konnte nicht verarbeitet werden.");
  }

  return sanitizeParsedItems(unwrapItems(parsed));
}

interface ParseBody {
  text?: unknown;
  vorhandene?: unknown;
}

/** POST /api/list/:id/parse – Freitext in Artikel zerlegen, ohne sie auf die Liste zu legen. */
export async function handleParseDump(request: Request, env: Env, listId: string): Promise<Response> {
  return withAuth(request, env.DB, async ({ user }) => {
    if (!(await checkListAccess(env, listId, user.id))) return listNotFound();

    const body = await readJson<ParseBody>(request);
    const text = typeof body?.text === "string" ? body.text.trim().slice(0, MAX_TEXT) : "";
    if (!text) return json({ error: "Bitte gib einen Einkaufszettel ein." }, 400);

    const vorhandene = sanitizeVorhandene(body?.vorhandene);
    const max = groqMaxRequests(env.GROQ_RPM);

    const limiter = env.RATE_LIMITER_DO.get(env.RATE_LIMITER_DO.idFromName("groq"));
    const limitRes = await limiter.fetch(`https://rate-limiter/check?max=${max}`, { method: "POST" });
    const limit = (await limitRes.json()) as { ok?: boolean; retryAfterSec?: number };
    if (!limitRes.ok || !limit.ok) {
      const wait = limit.retryAfterSec ?? 60;
      return json(
        {
          error: `Die KI macht gerade eine Pause (Rate-Limit). Bitte in ${wait} Sekunden nochmal versuchen.`,
        },
        429,
        { "retry-after": String(wait) }
      );
    }

    try {
      const items = await parseDumpWithGroq(env, text, vorhandene);
      if (!items.length) {
        return json({ error: "Daraus konnten keine Artikel erkannt werden." }, 400);
      }
      return json({ items });
    } catch (err) {
      if (err instanceof ParseError) return json({ error: err.message }, err.status);
      throw err;
    }
  });
}
