/**
 * Reine, browser-/node-taugliche Helfer der App (kein DOM, kein fetch).
 * app.js bezieht sie über den globalen `window.BC`; Tests importieren sie
 * direkt als ESM. `classify`/`categoryLabel`/`categoryOrder` bekommen das
 * Kategorie-Wörterbuch als Parameter, damit sie ohne Global-State testbar sind.
 */

export const SONSTIGES = "sonstiges";

/** Vorschläge für den Markt-Picker; Freitext bleibt trotzdem erlaubt. */
export const SUPERMAERKTE = ["Aldi", "Edeka", "Rewe", "Lidl", "Budni"];

/** Duplikat-Schlüssel wie im Durable Object: „  Milch “ == „milch“ */
export function normKey(name) {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Kochschritte: neuer Stand {text, timerSekunden?}, alter Stand reiner String */
export function parseSteps(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (entry.trim()) out.push({ text: entry.trim() });
    } else if (entry && typeof entry === "object" && typeof entry.text === "string" && entry.text.trim()) {
      const step = { text: entry.text.trim() };
      if (typeof entry.timerSekunden === "number" && entry.timerSekunden > 0) {
        step.timerSekunden = Math.min(7200, Math.round(entry.timerSekunden));
      }
      out.push(step);
    }
  }
  return out;
}

/** Führende Zahl einer Freitext-Menge hochrechnen ("500 g" → "750 g") */
export function scaleMenge(menge, factor) {
  if (!menge || factor === 1 || !Number.isFinite(factor) || factor <= 0) return menge;
  const match = menge.match(/^(\d+(?:[.,]\d+)?)(.*)$/);
  if (!match) return menge;
  const scaled = Number.parseFloat(match[1].replace(",", ".")) * factor;
  if (!Number.isFinite(scaled)) return menge;
  return `${Math.round(scaled * 100) / 100}`.replace(".", ",") + match[2];
}

/** Kurzlabel für Schritte, z. B. "⏱ 8 min" bzw. "⏱ 1 h 15 min". */
export function fmtTimer(sekunden) {
  const min = Math.round(sekunden / 60);
  if (min < 60) return `⏱ ${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return `⏱ ${h} h${rest ? ` ${rest} min` : ""}`;
}

/** Restzeit als mm:ss (Koch-Timer). */
export function formatTimer(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
}

/** Deutsche Relativzeit, z. B. "vor 5 Tagen", "gestern". */
export function relTime(ts) {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} Min.`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `vor ${hours} ${hours === 1 ? "Stunde" : "Stunden"}`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "gestern";
  if (days < 7) return `vor ${days} Tagen`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return "vor 1 Woche";
  if (weeks < 5) return `vor ${weeks} Wochen`;
  const months = Math.floor(days / 30);
  return months <= 1 ? "vor einem Monat" : `vor ${months} Monaten`;
}

/** Längster Stichwort-Treffer gewinnt („kokosmilch“ → Vorrat, „milch“ → Molkerei). */
export function classify(name, categoryData) {
  const n = normKey(name);
  let best = null;
  let bestLen = 0;
  for (const cat of categoryData) {
    for (const kw of cat.keywords) {
      if (kw.length > bestLen && n.includes(kw)) {
        best = cat.id;
        bestLen = kw.length;
      }
    }
  }
  return best;
}

export function categoryLabel(id, categoryData) {
  const cat = categoryData.find((c) => c.id === id);
  return cat ? cat.label : "Sonstiges";
}

/** Feste Markt-Reihenfolge aller Kategorien plus Auffangkategorie. */
export function categoryOrder(categoryData) {
  return [...categoryData.map((c) => c.id), SONSTIGES];
}

/**
 * Ob der Add-Bar-Text wie ein Sprach-Dump / eine Mini-Liste wirkt
 * (Kommas, Semikolon, Zeilenumbruch, „und“) – dann zerlegen statt
 * einen Artikel anzulegen. Dezimal-Kommas („3,5 %“) zählen nicht.
 */
export function looksLikeDump(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/[\n;]/.test(t)) return true;
  if (t.replace(/\d,\d/g, "").includes(",")) return true;
  if (/\p{L}.*\s+und\s+.*\p{L}/u.test(t)) return true;
  return false;
}

const EINHEIT_LABELS = {
  l: "Liter",
  liter: "Liter",
  ml: "Milliliter",
  milliliter: "Milliliter",
  g: "Gramm",
  gramm: "Gramm",
  kg: "Kilogramm",
  kilogramm: "Kilogramm",
  stk: "Stück",
  stück: "Stück",
  stueck: "Stück",
  x: "Stück",
  "×": "Stück",
};

/** Kurzform → lesbare Einheit (z. B. „l“ → „Liter“). */
function normalizeEinheit(raw) {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase().replace("ü", "ue");
  return EINHEIT_LABELS[key];
}

/** Freitext-Menge in Wert + Einheit zerlegen (z. B. „2 Liter“ → { wert: „2“, einheit: „Liter“ }). */
export function parseMengeParts(menge) {
  const t = String(menge ?? "").trim();
  if (!t) return {};
  const structured = t.match(/^(\d+(?:[.,]\d+)?)\s+(.+)$/);
  if (structured) {
    const wert = structured[1];
    const einheit = normalizeEinheit(structured[2]);
    if (einheit) return { wert, einheit };
    return { wert: t };
  }
  const compact = t.match(/^(\d+(?:[.,]\d+)?)(kg|g|l|ml|stk|stück|stueck|x|×)$/i);
  if (compact) {
    const einheit = normalizeEinheit(compact[2]);
    if (einheit) return { wert: compact[1], einheit };
  }
  if (/^\d+(?:[.,]\d+)?$/.test(t)) return { wert: t };
  return { wert: t };
}

/** Wert + Einheit zu Speicher-String (z. B. „2“ + „Liter“ → „2 Liter“). */
export function composeMenge(wert, einheit) {
  if (!wert) return undefined;
  return einheit ? `${wert} ${einheit}` : String(wert);
}

/** Anzeige „2 · Liter“; ohne Einheit nur der Wert bzw. der Rohtext. */
export function formatItemMenge(menge) {
  const t = String(menge ?? "").trim();
  if (!t) return "";
  const { wert, einheit } = parseMengeParts(t);
  if (einheit) return `${wert} · ${einheit}`;
  return wert ?? t;
}

/** Menge „2l“ / „500 g“ in „2 Liter“ / „500 Gramm“ vereinheitlichen. */
function formatMenge(raw) {
  const t = String(raw ?? "").trim().replace(/\s+/g, " ");
  const m = t.match(/^(\d+(?:[.,]\d+)?)\s*(kg|g|l|ml|stk|stück|stueck|x|×)?$/i);
  if (m) {
    const einheit = normalizeEinheit(m[2]);
    return composeMenge(m[1], einheit) ?? m[1];
  }
  return t;
}

/**
 * Grobe lokale Zerlegung (Fallback ohne KI): an Komma/Semikolon/Zeile/„und“
 * splitten und eine führende oder nachgestellte Menge ablösen.
 */
export function splitDumpLocal(text) {
  const t = String(text ?? "").trim();
  if (!t) return [];
  const parts = [];
  for (const chunk of t.split(/[\n;]+|\s+und\s+/i)) {
    // Dezimal-Kommas („3,5“) maskieren, dann an Listen-Kommas splitten.
    const masked = chunk.replace(/(\d),(\d)/g, "$1\u0000$2");
    for (const bit of masked.split(",")) {
      const s = bit.replace(/\u0000/g, ",").trim();
      if (s) parts.push(s);
    }
  }

  const out = [];
  const seen = new Set();
  for (const part of parts.slice(0, 30)) {
    const parsed = peelMenge(part);
    const key = normKey(parsed.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

const MENGE_EINHEIT = "(?:kg|g|l|ml|stk|stück|x|×)";

function peelMenge(part) {
  const leading = part.match(new RegExp(`^(\\d+(?:[.,]\\d+)?\\s*${MENGE_EINHEIT}?)\\s+(.+)$`, "i"));
  if (leading && leading[2].trim().length >= 2) {
    return { name: leading[2].trim(), menge: formatMenge(leading[1]) };
  }
  const trailing = part.match(new RegExp(`^(.+?)\\s+(\\d+(?:[.,]\\d+)?\\s*${MENGE_EINHEIT}?)$`, "i"));
  if (trailing && trailing[1].trim().length >= 2) {
    return { name: trailing[1].trim(), menge: formatMenge(trailing[2]) };
  }
  return { name: part };
}

/**
 * Kurzform eines Gerichttitel für automatisch angelegte Einkaufslisten:
 * „Spaghetti Carbonara mit extra Parmesan – klassisch“ → „Spaghetti Carbonara“.
 * Schneidet Anhängsel ab „mit …“, ab Gedankenstrich/Bindestrich mit Leerzeichen
 * und trailing Klammern ab, kürzt an der Wortgrenze auf ~40 Zeichen.
 */
export function rezeptListenKurzform(titel) {
  const original = String(titel ?? "").trim().replace(/\s+/g, " ");
  if (!original) return "Neues Gericht";
  let t = original.split(/\s+[–—-]\s+/)[0].trim();
  t = t.replace(/\s*\([^)]*\)\s*$/, "").trim();
  t = t.replace(/\s+mit\s+.+$/i, "").trim();
  if (!t) t = original;
  const MAX = 40;
  if (t.length <= MAX) return t;
  const slice = t.slice(0, MAX);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace >= 15) return slice.slice(0, lastSpace).trim();
  return slice.trim();
}

/**
 * Sammelansicht für den Einkaufsmodus: fasst die Items mehrerer scharfer
 * Listen zu Markt-Gruppen mit Kategorie-Untergruppen zusammen. Jedes Item
 * trägt danach seine Herkunft (listId/listName), damit Abhaken/Löschen an
 * die richtige Herkunfts-Liste zurückgeschrieben werden kann.
 * marktFilter: null = „Alle“, "" = „Ohne Markt“, sonst normKey des Marktes.
 * offen/erledigt/gesamt zählen bewusst über ALLE Beiträge (stabiler
 * Fortschritt, auch bei aktivem Filter); gruppen spiegeln die Filter wider.
 */
export function mergeEinkaufListen(beitraege, opts = {}) {
  const { nurOffene = false, marktFilter = null, categoryData = [] } = opts;
  const order = categoryOrder(categoryData);
  const listen = Array.isArray(beitraege) ? beitraege : [];

  const maerkte = new Map(); // normKey -> erste Schreibweise
  let hatOhneMarkt = false;
  let offen = 0;
  let erledigt = 0;
  for (const b of listen) {
    for (const it of b.items ?? []) {
      if (it.erledigt) erledigt++;
      else offen++;
      const m = it.supermarkt?.trim();
      if (m) {
        if (!maerkte.has(normKey(m))) maerkte.set(normKey(m), m);
      } else {
        hatOhneMarkt = true;
      }
    }
  }

  const marktReihe = [...maerkte.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], "de"))
    .map(([key, label]) => ({ key, label }));
  if (hatOhneMarkt) marktReihe.push({ key: "", label: "Ohne Markt" });

  const gruppen = [];
  for (const { key, label } of marktReihe) {
    if (marktFilter !== null && marktFilter !== key) continue;
    const katGruppen = new Map();
    for (const b of listen) {
      for (const it of b.items ?? []) {
        if (normKey(it.supermarkt ?? "") !== key) continue;
        if (nurOffene && it.erledigt) continue;
        const katId = it.kategorie && order.includes(it.kategorie) ? it.kategorie : SONSTIGES;
        if (!katGruppen.has(katId)) katGruppen.set(katId, []);
        katGruppen.get(katId).push({ ...it, listId: b.id, listName: b.name });
      }
    }
    if (!katGruppen.size) continue;
    const kategorien = order
      .filter((id) => katGruppen.has(id))
      .map((id) => ({ id, items: katGruppen.get(id) }));
    gruppen.push({ markt: label, kategorien });
  }

  return {
    gruppen,
    offen,
    erledigt,
    gesamt: offen + erledigt,
    maerkte: marktReihe,
  };
}

/**
 * Listentitel für den Koch-Assistenten im Zutaten-Modus: aus den eingetippten
 * Zutaten abgeleitet (z. B. „Reste: Paprika, Reis, Hähnchen“), auf 80 Zeichen
 * gekappt (Listen-Limit des Backends). Fallback, falls nichts übrig bleibt.
 */
export function listeNameFuerZutaten(zutaten) {
  const namen = (Array.isArray(zutaten) ? zutaten : [])
    .filter((z) => typeof z === "string")
    .map((z) => z.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  if (!namen.length) return "Reste-Rezept";
  return `Reste: ${namen.join(", ")}`.slice(0, 80).trim() || "Reste-Rezept";
}

/** Food-Emoji pro Kategorie-Id für den Cover-Fallback. */
const COVER_EMOJI = {
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

/** Einfacher deterministischer String-Hash (djb2). */
function hashStr(s) {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) & 0xffffffff;
  }
  return Math.abs(hash);
}

/**
 * Deterministischer Cover-Ersatz für Rezepte ohne KI-Bild:
 * - Gradient aus dem Titel-Hash
 * - Food-Emoji aus der dominanten Zutaten-Kategorie
 * Gibt ein Objekt { gradient, emoji } zurück.
 */
export function coverFor(recipe) {
  const h = hashStr(recipe.titel ?? "");
  const hue = h % 360;
  const sat = 30 + (h % 30);
  const light = 70 + (h % 15);
  const hue2 = (hue + 40 + (h % 60)) % 360;
  const gradient = `linear-gradient(135deg, hsl(${hue}, ${sat}%, ${light}%), hsl(${hue2}, ${sat + 10}%, ${light - 10}%))`;

  // Dominante Kategorie aus den Zutaten ermitteln
  const zutaten = recipe.zutaten ?? [];
  const counts = {};
  for (const z of zutaten) {
    const k = z.kategorie ?? "sonstiges";
    counts[k] = (counts[k] ?? 0) + 1;
  }
  let best = "sonstiges";
  let bestCount = 0;
  for (const [k, c] of Object.entries(counts)) {
    if (c > bestCount) { bestCount = c; best = k; }
  }
  return { gradient, emoji: COVER_EMOJI[best] ?? "🍽️" };
}

// Global für das klassische app.js (Module laufen vor defer-Scripts aus).
if (typeof window !== "undefined") {
  window.BC = {
    SONSTIGES,
    SUPERMAERKTE,
    normKey,
    parseSteps,
    scaleMenge,
    fmtTimer,
    formatTimer,
    relTime,
    classify,
    categoryLabel,
    categoryOrder,
    looksLikeDump,
    splitDumpLocal,
    parseMengeParts,
    composeMenge,
    formatItemMenge,
    coverFor,
    rezeptListenKurzform,
    listeNameFuerZutaten,
    mergeEinkaufListen,
  };
}
