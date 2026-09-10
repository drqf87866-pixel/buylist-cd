export interface Env {
  DB: D1Database;
  SHOPPING_LIST_DO: DurableObjectNamespace;
  /** Globaler Singleton für das Gemini-Freelimit (12 Anfragen/min). */
  RATE_LIMITER_DO: DurableObjectNamespace;
  ASSETS: Fetcher;
  RECIPE_IMAGES: R2Bucket;
  /** Worker-Secret, siehe .dev.vars (lokal) bzw. `wrangler secret put` (Produktion). */
  GEMINI_API_KEY?: string;
  /** Gemini-Modellname; Default in src/recipes.ts, überschreibbar per Secret/Env. */
  GEMINI_MODEL?: string;
  /** OpenRouter-Key für die Bildgenerierung (Rezept-Fotos); optional – ohne Key wird der Emoji-Fallback gezeigt. */
  OPENROUTER_API_KEY?: string;
  /** OpenRouter-Image-Modellname; Default in src/recipes.ts. */
  OPENROUTER_IMAGE_MODEL?: string;
  /** Groq-Key für den Sprach-Dump-Parser (Add-Bar). */
  GROQ_API_KEY?: string;
  /** Groq-Modellname; Default in src/parse.ts. */
  GROQ_MODEL?: string;
  /** App-weites Groq-RPM-Limit (Default 27). */
  GROQ_RPM?: string;
  /** Web-Push-VAPID: Base64url des 65-Byte-Uncompressed-Points (npx web-push generate-vapid-keys). */
  VAPID_PUBLIC_KEY?: string;
  /** Web-Push-VAPID: Base64url des 32-Byte-Private-Scalars. */
  VAPID_PRIVATE_KEY?: string;
  /** Web-Push-VAPID: mailto-Adresse im JWT-Subject. */
  VAPID_SUBJECT?: string;
  /** Resend-API-Key für den Magic-Link-Versand; ohne Key ist Magic-Link deaktiviert. */
  RESEND_API_KEY?: string;
  /** Absender des Magic-Link-Mails, z. B. "Buylist <noreply@deinedomain.de>" (Domain muss bei Resend verifiziert sein). */
  RESEND_FROM?: string;
  /** Basis-URL für den Magic-Link; fehlt sie, wird der Origin des Requests genutzt. */
  APP_URL?: string;
}

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  createdAt: number;
}

export interface ListMeta {
  id: string;
  name: string;
  ownerId: string;
  inviteToken: string;
  createdAt: number;
}

export interface ShoppingItem {
  id: string;
  name: string;
  menge?: string;
  /** Kategorie-Id laut public/data/categories.json; fehlt = „Sonstiges“. */
  kategorie?: string;
  /** Supermarkt (freie Bezeichnung, Vorschläge clientseitig); fehlt = kein Markt. */
  supermarkt?: string;
  erledigt: boolean;
  hinzugefuegtVon: string;
  timestamp: number;
  /** Zeitpunkt des Abhakens – Basis für „Zuletzt gekauft“ und das Auto-Aufräumen. */
  gekauftAm?: number;
  /** Herkunft: als Zutat eines zugeschalteten Gerichts auf die Liste gekommen. */
  quelle?: ItemQuelle;
}

/** Markiert Items, die beim Zuschalten eines Gerichts auf die Liste kamen. */
export interface ItemQuelle {
  typ: "gericht";
  /** Rezept-Id (D1), über die beim Abschalten alle offenen Zutaten gefunden werden. */
  id: string;
  titel: string;
}

/** Gericht, das aktuell auf einer Liste „zugeschaltet“ ist (Zustand im DO). */
export interface AktivesGericht {
  /** Rezept-Id (D1). */
  id: string;
  titel: string;
  portionen: number;
  hinzugefuegtAm: number;
  hinzugefuegtVon: string;
}

/** Verlaufseintrag „Zuletzt gekauft“: ein Kauf genügt, um ihn später mit einem Tap wiederzubestellen. */
export interface HistoryEntry {
  name: string;
  menge?: string;
  gekauftAm: number;
}

export interface ShoppingList {
  id: string;
  name: string;
  items: ShoppingItem[];
  /** Neueste Käufe zuerst, auf HISTORY_MAX Einträge begrenzt (im DO gepflegt). */
  history?: HistoryEntry[];
  /** Zugeschaltete Gerichte; fehlt in alten Blobs (= keine). */
  aktiveGerichte?: AktivesGericht[];
}

/** Client -> Durable Object */
export type ClientMessage =
  | { type: "add"; name: string; menge?: string; kategorie?: string; supermarkt?: string; quelle?: ItemQuelle }
  | { type: "toggle"; itemId: string; erledigt: boolean }
  | { type: "delete"; itemId: string }
  /** Markt eines Artikels setzen/leeren ("" = kein Markt). */
  | { type: "setMarkt"; itemId: string; supermarkt?: string }
  /** Menge eines Artikels direkt ersetzen ("" = Menge löschen). */
  | { type: "setMenge"; itemId: string; menge?: string };

/** Durable Object -> Client */
export type ServerMessage =
  | { type: "sync"; list: ShoppingList }
  | { type: "error"; message: string };

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
}

/** Nutzer-Präferenzen für die Rezept-Generierung (Diätform + Ziel + Allergene). */
export interface UserPreferences {
  diaet: string;
  ziel: string;
  allergene: string[];
  updatedAt: number;
}

/** Zutat eines Rezepts – deckt sich mit {name, menge} der ShoppingItems. */
export interface RecipeIngredient {
  name: string;
  menge?: string;
  kategorie?: string;
}

/** Kochschritt; timerSekunden ermöglicht den Timer-Chip im Kochmodus. */
export interface RecipeStep {
  text: string;
  timerSekunden?: number;
}

/** Vom LLM generiertes bzw. gespeichertes Rezept. */
export interface Recipe {
  id?: string;
  titel: string;
  zeit?: string;
  portionen: number;
  zutaten: RecipeIngredient[];
  schritte: RecipeStep[];
  createdAt?: number;
  /** Öffentliche URL zum Rezept-Bild (generiert aus bild_key). */
  bildUrl?: string;
  /** Status des asynchron generierten Rezept-Bilds. */
  bildStatus?: "pending" | "fertig" | "fehler";
}

/**
 * Ein Tagesvorschlag: leichtgewichtige Gerichts-Idee ohne Rezept. Das volle
 * Rezept entsteht bei Bedarf über den Koch-Assistenten (POST /api/list/:id/generate).
 */
export interface DishSuggestion {
  titel: string;
  beschreibung: string;
  zeit?: string;
}
