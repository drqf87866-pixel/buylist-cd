import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeParsedItems, groqMaxRequests } from "./parse";

test("sanitizeParsedItems: Name, Menge, Kategorie; Duplikate raus", () => {
  const items = sanitizeParsedItems([
    { name: " Milch ", menge: " 2 l ", kategorie: "molkerei" },
    { name: "milch", menge: "1 l", kategorie: "molkerei" },
    { name: "Brot", kategorie: "brot-backwaren" },
    { name: "", menge: "1" },
    { name: "Eier", kategorie: "keine-kategorie" },
  ]);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { name: "Milch", menge: "2 l", kategorie: "molkerei" });
  assert.deepEqual(items[1], { name: "Brot", kategorie: "brot-backwaren" });
  assert.deepEqual(items[2], { name: "Eier" });
});

test("sanitizeParsedItems: ungültige Eingaben liefern []", () => {
  assert.deepEqual(sanitizeParsedItems(null), []);
  assert.deepEqual(sanitizeParsedItems("Milch"), []);
  assert.deepEqual(sanitizeParsedItems([{ menge: "1 l" }]), []);
});

test("sanitizeParsedItems: begrenzt auf 30 Artikel", () => {
  const raw = Array.from({ length: 40 }, (_, i) => ({ name: `Artikel ${i}` }));
  assert.equal(sanitizeParsedItems(raw).length, 30);
});

test("groqMaxRequests: Default 27, Cap 120", () => {
  assert.equal(groqMaxRequests(undefined), 27);
  assert.equal(groqMaxRequests(""), 27);
  assert.equal(groqMaxRequests("60"), 60);
  assert.equal(groqMaxRequests("999"), 120);
  assert.equal(groqMaxRequests("-1"), 27);
});
