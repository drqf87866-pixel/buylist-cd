import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
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
  rezeptListenKurzform,
} from "../public/app-core.mjs";

const categories = JSON.parse(
  readFileSync(fileURLToPath(new URL("../public/data/categories.json", import.meta.url)), "utf8")
);

// ---------- classify ----------

test("classify: längster Stichwort-Treffer gewinnt (kokosmilch > milch)", () => {
  assert.equal(classify("Kokosmilch", categories), "trockenware");
  assert.equal(classify("Milch", categories), "molkerei");
});

test("classify: normalisiert Groß-/Kleinschreibung und Leerraum", () => {
  assert.equal(classify("  kokosMILCH ", categories), "trockenware");
  assert.equal(classify("BIO-Milch", categories), "molkerei");
});

test("classify: kein Treffer liefert null", () => {
  assert.equal(classify("Gänseblümchen-Spezial", categories), null);
});

// ---------- categoryLabel / categoryOrder ----------

test("categoryLabel: bekannte Id liefert Label, Unbekannte „Sonstiges“", () => {
  assert.equal(categoryLabel("molkerei", categories), "Molkerei & Käse");
  assert.equal(categoryLabel("gibtsnicht", categories), "Sonstiges");
});

test("categoryOrder: alle Kategorien in Marktreihenfolge, sonstiges am Ende", () => {
  const order = categoryOrder(categories);
  assert.equal(order[0], "obst-gemuese");
  assert.equal(order[order.length - 1], SONSTIGES);
  assert.equal(order.length, categories.length + 1);
});

// ---------- normKey ----------

test("normKey: „  Milch “ == „milch“", () => {
  assert.equal(normKey("  Milch  "), "milch");
  assert.equal(normKey("2×   Apfel"), "2× apfel");
});

// ---------- SUPERMAERKTE ----------

test("SUPERMAERKTE: gängige Märkte als Vorschläge vorhanden", () => {
  assert.ok(SUPERMAERKTE.includes("Rewe"));
  assert.ok(SUPERMAERKTE.includes("Lidl"));
  assert.ok(SUPERMAERKTE.length >= 5);
});

// ---------- parseSteps ----------

test("parseSteps: rückwärtskompatibel (String vs. Objekt)", () => {
  assert.deepEqual(parseSteps(["Nudeln kochen", { text: "Verrühren", timerSekunden: 480 }]), [
    { text: "Nudeln kochen" },
    { text: "Verrühren", timerSekunden: 480 },
  ]);
});

test("parseSteps: filtert Leeres und begrenzt Timer auf 2 h", () => {
  assert.deepEqual(parseSteps(["", "  ", { text: "  " }, { text: "Kochen", timerSekunden: 99999 }]), [
    { text: "Kochen", timerSekunden: 7200 },
  ]);
});

test("parseSteps: kein Array liefert []", () => {
  assert.deepEqual(parseSteps(null), []);
});

// ---------- scaleMenge ----------

test("scaleMenge: skaliert führende Zahl, Komma als Dezimaltrenner", () => {
  assert.equal(scaleMenge("500 g", 1.5), "750 g");
  assert.equal(scaleMenge("2 EL", 2), "4 EL");
  assert.equal(scaleMenge("1,5 l", 2), "3 l");
});

test("scaleMenge: ohne Zahl oder Faktor 1 bleibt unverändert", () => {
  assert.equal(scaleMenge("1 Bund", 1), "1 Bund");
  assert.equal(scaleMenge("etwas Pfeffer", 3), "etwas Pfeffer");
  assert.equal(scaleMenge(undefined, 2), undefined);
});

// ---------- fmtTimer / formatTimer ----------

test("fmtTimer: Minuten- und Stundenlabel", () => {
  assert.equal(fmtTimer(480), "⏱ 8 min");
  assert.equal(fmtTimer(4500), "⏱ 1 h 15 min");
});

test("formatTimer: mm:ss aus Millisekunden", () => {
  assert.equal(formatTimer(0), "0:00");
  assert.equal(formatTimer(65000), "1:05");
  assert.equal(formatTimer(600000), "10:00");
  assert.equal(formatTimer(-500), "0:00");
});

// ---------- relTime ----------

test("relTime: deutsche Relativzeit anhand fester Vergangenheits-Offsets", () => {
  const now = Date.now();
  assert.equal(relTime(now), "gerade eben");
  assert.equal(relTime(now - 5 * 60 * 1000), "vor 5 Min.");
  assert.equal(relTime(now - 2 * 3600 * 1000), "vor 2 Stunden");
  assert.equal(relTime(now - 1 * 3600 * 1000), "vor 1 Stunde");
  assert.equal(relTime(now - 24 * 3600 * 1000), "gestern");
  assert.equal(relTime(now - 3 * 24 * 3600 * 1000), "vor 3 Tagen");
  assert.equal(relTime(now - 7 * 24 * 3600 * 1000), "vor 1 Woche");
  assert.equal(relTime(now - 35 * 24 * 3600 * 1000), "vor einem Monat");
  assert.equal(relTime(now - 60 * 24 * 3600 * 1000), "vor 2 Monaten");
});

// ---------- looksLikeDump / splitDumpLocal ----------

test("looksLikeDump: einzelne Artikel und Dezimal-Kommas sind kein Dump", () => {
  assert.equal(looksLikeDump(""), false);
  assert.equal(looksLikeDump("Milch"), false);
  assert.equal(looksLikeDump("milch 2l"), false);
  assert.equal(looksLikeDump("Bio-Milch 3,5%"), false);
  assert.equal(looksLikeDump("Butter und"), false);
});

test("looksLikeDump: Komma, Semikolon, Zeile und „und“ zählen als Dump", () => {
  assert.equal(looksLikeDump("Milch, Brot"), true);
  assert.equal(looksLikeDump("Milch,Brot"), true);
  assert.equal(looksLikeDump("Milch; Brot"), true);
  assert.equal(looksLikeDump("Milch\nBrot"), true);
  assert.equal(looksLikeDump("Milch und Brot"), true);
});

test("splitDumpLocal: Kommas, Mengen und „und“", () => {
  assert.deepEqual(splitDumpLocal("milch 2l"), [{ name: "milch", menge: "2 Liter" }]);
  assert.deepEqual(splitDumpLocal("Milch 2l, Brot, 6 Eier"), [
    { name: "Milch", menge: "2 Liter" },
    { name: "Brot" },
    { name: "Eier", menge: "6" },
  ]);
  assert.deepEqual(splitDumpLocal("Milch und Brot"), [{ name: "Milch" }, { name: "Brot" }]);
  assert.deepEqual(splitDumpLocal("500g Hackfleisch, 2l Milch"), [
    { name: "Hackfleisch", menge: "500 Gramm" },
    { name: "Milch", menge: "2 Liter" },
  ]);
});

test("parseMengeParts / formatItemMenge: Wert und Einheit getrennt", () => {
  assert.deepEqual(parseMengeParts("2 Liter"), { wert: "2", einheit: "Liter" });
  assert.deepEqual(parseMengeParts("2 l"), { wert: "2", einheit: "Liter" });
  assert.deepEqual(parseMengeParts("500 Gramm"), { wert: "500", einheit: "Gramm" });
  assert.deepEqual(parseMengeParts("6"), { wert: "6" });
  assert.deepEqual(parseMengeParts("1 Bund"), { wert: "1 Bund" });
  assert.equal(formatItemMenge("2 Liter"), "2 · Liter");
  assert.equal(formatItemMenge("6"), "6");
  assert.equal(composeMenge("2", "Liter"), "2 Liter");
});

test("splitDumpLocal: Dezimal-Komma bleibt im Artikel, Duplikate fallen weg", () => {
  assert.deepEqual(splitDumpLocal("Bio Milch 3,5%"), [{ name: "Bio Milch 3,5%" }]);
  assert.deepEqual(splitDumpLocal("Milch, milch"), [{ name: "Milch" }]);
  assert.deepEqual(splitDumpLocal(""), []);
});

// ---------- rezeptListenKurzform ----------

test("rezeptListenKurzform: schneidet Anhängsel ab und kürzt an der Wortgrenze", () => {
  assert.equal(rezeptListenKurzform("Spaghetti Carbonara"), "Spaghetti Carbonara");
  assert.equal(
    rezeptListenKurzform("Spaghetti Carbonara mit extra Parmesan"),
    "Spaghetti Carbonara"
  );
  assert.equal(
    rezeptListenKurzform("Linsensuppe – klassisch wie bei Oma"),
    "Linsensuppe"
  );
  assert.equal(rezeptListenKurzform("Curry (vegan)"), "Curry");
  assert.equal(rezeptListenKurzform(""), "Neues Gericht");
  assert.equal(rezeptListenKurzform("   "), "Neues Gericht");
});

test("rezeptListenKurzform: lange Titel enden an der Wortgrenze bei ~40 Zeichen", () => {
  const kurz = rezeptListenKurzform("Überbackener Blumenkohlauflauf mit Kartoffeln und Käsekruste");
  assert.ok(kurz.length <= 40);
  assert.equal(kurz, "Überbackener Blumenkohlauflauf");
});

