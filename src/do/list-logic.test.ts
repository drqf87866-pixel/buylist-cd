import { test } from "node:test";
import assert from "node:assert/strict";
import { HISTORY_MAX, mergeMenge, mergeOrAdd, removeFromHistory, upsertHistory } from "./list-logic";
import type { ShoppingItem, ShoppingList } from "../types";

function makeList(): ShoppingList {
  return { id: "l1", name: "Test", items: [] };
}

function makeItem(overrides: Partial<ShoppingItem> & { name: string }): ShoppingItem {
  return {
    id: `id-${overrides.name}-${Math.random().toString(36).slice(2, 6)}`,
    erledigt: false,
    hinzugefuegtVon: "tester",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------- mergeMenge ----------

test("mergeMenge: reichert an statt zu überschreiben", () => {
  assert.equal(mergeMenge("500 g", "1 l"), "500 g · +1 l");
  assert.equal(mergeMenge("500 g", "500 g"), "500 g");
  assert.equal(mergeMenge("500 g", "500 G"), "500 g");
  assert.equal(mergeMenge(undefined, "1 l"), "1 l");
  assert.equal(mergeMenge("500 g", undefined), "500 g");
  assert.equal(mergeMenge(undefined, undefined), undefined);
});

test("mergeMenge: Duplikat-Ergänzung wird nicht doppelt angehängt", () => {
  assert.equal(mergeMenge("500 g · +1 l", "1 l"), "500 g · +1 l");
  assert.equal(mergeMenge("500 g · +1 l", "2 l"), "500 g · +1 l · +2 l");
});

test("mergeMenge: bei Überlänge fällt es auf Basis + neueste Menge zurück", () => {
  const base = "x".repeat(60);
  const incoming = "y".repeat(60);
  const next = mergeMenge(`${base} · +1 l`, incoming);
  assert.equal(next, `${base} · +${incoming}`);
});

// ---------- mergeOrAdd ----------

test("mergeOrAdd: exakter normalisierter Treffer merged statt neu anzulegen", () => {
  const list = makeList();
  mergeOrAdd(list, "Milch", "500 g", "molkerei", "A");
  const added = mergeOrAdd(list, "milch", "1 l", undefined, "B");

  assert.equal(added, false);
  assert.equal(list.items.length, 1);
  const item = list.items[0];
  assert.equal(item.menge, "500 g · +1 l");
  assert.equal(item.kategorie, "molkerei");
  assert.equal(item.hinzugefuegtVon, "A");
});

test("mergeOrAdd: Leerraum und Großschreibung werden normalisiert", () => {
  const list = makeList();
  mergeOrAdd(list, "  Milch ", undefined, undefined, "A");
  assert.equal(mergeOrAdd(list, "MILCH", undefined, undefined, "B"), false);
  assert.equal(list.items.length, 1);
});

test("mergeOrAdd: erledigte Artikel werden nicht als Duplikat behandelt", () => {
  const list = makeList();
  const checked = makeItem({ name: "Milch", erledigt: true });
  list.items.push(checked);
  assert.equal(mergeOrAdd(list, "Milch", undefined, undefined, "B"), true);
  assert.equal(list.items.length, 2);
});

test("mergeOrAdd: neue Artikel werden angelegt und bekommen Herkunft", () => {
  const list = makeList();
  assert.equal(mergeOrAdd(list, "Kaffee", undefined, undefined, "A"), true);
  const item = list.items[0];
  assert.equal(item.name, "Kaffee");
  assert.equal(item.erledigt, false);
  assert.equal(item.hinzugefuegtVon, "A");

  const quelle = { typ: "gericht" as const, id: "r1", titel: "Carbonara" };
  mergeOrAdd(list, "Spaghetti", "500 g", undefined, "A", quelle);
  assert.deepEqual(list.items[1].quelle, quelle);
});

test("mergeOrAdd: Quelle wird nicht überschrieben, nur ergänzt", () => {
  const list = makeList();
  mergeOrAdd(list, "Spaghetti", undefined, undefined, "A", { typ: "gericht", id: "r1", titel: "A" });
  mergeOrAdd(list, "Spaghetti", undefined, undefined, "B", { typ: "gericht", id: "r2", titel: "B" });
  assert.equal(list.items[0].quelle?.id, "r1");
});

// ---------- upsertHistory / removeFromHistory ----------

test("upsertHistory: dedupliziert nach Name und sortiert neueste zuerst", () => {
  const list = makeList();
  upsertHistory(list, makeItem({ name: "Milch", menge: "1 l", gekauftAm: 100 }));
  upsertHistory(list, makeItem({ name: "Brot", gekauftAm: 200 }));
  upsertHistory(list, makeItem({ name: "milch", menge: "2 l", gekauftAm: 300 }));

  assert.equal(list.history!.length, 2);
  assert.equal(list.history![0].name, "milch");
  assert.equal(list.history![0].menge, "2 l");
  assert.equal(list.history![1].name, "Brot");
});

test("upsertHistory: begrenzt auf HISTORY_MAX", () => {
  const list = makeList();
  for (let i = 0; i < HISTORY_MAX + 20; i++) {
    upsertHistory(list, makeItem({ name: `Item ${i}`, gekauftAm: i }));
  }
  assert.equal(list.history!.length, HISTORY_MAX);
  assert.equal(list.history![0].name, `Item ${HISTORY_MAX + 19}`);
});

test("removeFromHistory: entfernt, wenn kein anderes abgehaktes Item gleichen Namens existiert", () => {
  const list = makeList();
  const item = makeItem({ name: "Milch", erledigt: true });
  list.items.push(item);
  upsertHistory(list, item);

  removeFromHistory(list, item);
  assert.equal(list.history!.length, 0);
});

test("removeFromHistory: behält, wenn ein zweites abgehaktes Item gleichen Namens existiert", () => {
  const list = makeList();
  const a = makeItem({ name: "Milch", erledigt: true });
  const b = makeItem({ name: "milch", erledigt: true });
  list.items.push(a, b);
  upsertHistory(list, a);

  removeFromHistory(list, a);
  assert.equal(list.history!.length, 1);
});
