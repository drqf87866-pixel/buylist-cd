/**
 * Reine, browser-/node-taugliche Helfer der App (kein DOM, kein fetch).
 * app.js bezieht sie über den globalen `window.BC`; Tests importieren sie
 * direkt als ESM. `classify`/`categoryLabel`/`categoryOrder` bekommen das
 * Kategorie-Wörterbuch als Parameter, damit sie ohne Global-State testbar sind.
 */

export const SONSTIGES = "sonstiges";

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

// Global für das klassische app.js (Module laufen vor defer-Scripts aus).
if (typeof window !== "undefined") {
  window.BC = {
    SONSTIGES,
    normKey,
    parseSteps,
    scaleMenge,
    fmtTimer,
    formatTimer,
    relTime,
    classify,
    categoryLabel,
    categoryOrder,
  };
}
