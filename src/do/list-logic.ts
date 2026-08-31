import { normKey } from "../util";
import type { HistoryEntry, ItemQuelle, ShoppingItem, ShoppingList } from "../types";

export const HISTORY_MAX = 100;
export const MENGE_MAX = 80;

/**
 * Freitext-Mengen anreichern statt überschreiben: „500 g“ + „1 l“ wird
 * „500 g · +1 l“. Gleiche Menge wird verworfen, das Feld bleibt klein.
 */
export function mergeMenge(existing: string | undefined, incoming: string | undefined): string | undefined {
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (existing.toLowerCase() === incoming.toLowerCase()) return existing;
  const base = existing.split(" · ")[0];
  const additions = existing
    .split(" · ")
    .slice(1)
    .filter((p) => p.toLowerCase() !== `+${incoming.toLowerCase()}`);
  const next = [base, ...additions, `+${incoming}`].join(" · ");
  return next.length <= MENGE_MAX ? next : `${base} · +${incoming}`;
}

export function upsertHistory(list: ShoppingList, item: ShoppingItem): void {
  const key = normKey(item.name);
  const history: HistoryEntry[] = (list.history ?? []).filter((h) => normKey(h.name) !== key);
  history.unshift({ name: item.name, menge: item.menge, gekauftAm: item.gekauftAm ?? Date.now() });
  list.history = history.slice(0, HISTORY_MAX);
}

export function removeFromHistory(list: ShoppingList, item: ShoppingItem): void {
  // Eintrag nur wegnehmen, wenn nicht noch ein weiteres abgehaktes Item denselben Namen trägt.
  const key = normKey(item.name);
  const stillChecked = list.items.some(
    (i) => i.erledigt && i.id !== item.id && normKey(i.name) === key
  );
  if (stillChecked) return;
  list.history = (list.history ?? []).filter((h) => normKey(h.name) !== key);
}

/**
 * Duplikat-Zusammenführung: existiert der Artikel (normalisierter Name) noch
 * offen, wird nur die Menge angereichert, eine fehlende Kategorie ergänzt und
 * der Artikel nach hinten sortiert (timestamp = sichtbares Lebenszeichen).
 * Sonst landet er neu auf der Liste. Gibt true zurück, wenn ein neues Item
 * angelegt wurde.
 */
export function mergeOrAdd(
  list: ShoppingList,
  name: string,
  menge: string | undefined,
  kategorie: string | undefined,
  displayName: string,
  quelle?: ItemQuelle
): boolean {
  const key = normKey(name);
  const existing = list.items.find((i) => !i.erledigt && normKey(i.name) === key);
  if (existing) {
    existing.menge = mergeMenge(existing.menge, menge);
    if (!existing.kategorie && kategorie) existing.kategorie = kategorie;
    // Herkunft nur ergänzen, nicht umschreiben – das Item trägt weiter „seine“ Quelle.
    if (!existing.quelle && quelle) existing.quelle = quelle;
    existing.timestamp = Date.now();
    return false;
  }
  list.items.push({
    id: crypto.randomUUID(),
    name,
    menge,
    kategorie,
    erledigt: false,
    hinzugefuegtVon: displayName,
    timestamp: Date.now(),
    ...(quelle ? { quelle } : {}),
  });
  return true;
}
