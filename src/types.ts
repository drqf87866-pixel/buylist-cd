export interface Env {
  DB: D1Database;
  SHOPPING_LIST_DO: DurableObjectNamespace;
  /** Globaler Singleton für das Gemini-Freelimit (12 Anfragen/min). */
  RATE_LIMITER_DO: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** Worker-Secret, siehe .dev.vars (lokal) bzw. `wrangler secret put` (Produktion). */
  GEMINI_API_KEY?: string;
  /** Web-Push-VAPID: Base64url des 65-Byte-Uncompressed-Points (npx web-push generate-vapid-keys). */
  VAPID_PUBLIC_KEY?: string;
  /** Web-Push-VAPID: Base64url des 32-Byte-Private-Scalars. */
  VAPID_PRIVATE_KEY?: string;
  /** Web-Push-VAPID: mailto-Adresse im JWT-Subject. */
  VAPID_SUBJECT?: string;
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
  erledigt: boolean;
  hinzugefuegtVon: string;
  timestamp: number;
  /** Zeitpunkt des Abhakens – Basis für „Zuletzt gekauft“ und das Auto-Aufräumen. */
  gekauftAm?: number;
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
}

/** Client -> Durable Object */
export type ClientMessage =
  | { type: "add"; name: string; menge?: string; kategorie?: string }
  | { type: "toggle"; itemId: string; erledigt: boolean }
  | { type: "delete"; itemId: string };

/** Durable Object -> Client */
export type ServerMessage =
  | { type: "sync"; list: ShoppingList }
  | { type: "error"; message: string };

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
}

/** Nutzer-Präferenzen für die Rezept-Generierung (Diätform + Allergene). */
export interface UserPreferences {
  diaet: string;
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
}
