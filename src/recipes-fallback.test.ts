import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiError, geminiFallbackModell, geminiPrimaerModell, isWiederholbarerGeminiFehler } from "./recipes";
import type { Env } from "./types";

const env = (patch: Partial<Env> = {}) => patch as Env;

test("geminiPrimaerModell: Default und Override per GEMINI_MODEL", () => {
  assert.equal(geminiPrimaerModell(env()), "gemini-3.5-flash-lite");
  assert.equal(geminiPrimaerModell(env({ GEMINI_MODEL: "  " })), "gemini-3.5-flash-lite");
  assert.equal(geminiPrimaerModell(env({ GEMINI_MODEL: "gemini-3.1-flash-lite" })), "gemini-3.1-flash-lite");
});

test("geminiFallbackModell: Default und Override per GEMINI_FALLBACK_MODEL", () => {
  assert.equal(geminiFallbackModell(env()), "gemini-3.1-flash-lite");
  assert.equal(geminiFallbackModell(env({ GEMINI_FALLBACK_MODEL: "  " })), "gemini-3.1-flash-lite");
  assert.equal(geminiFallbackModell(env({ GEMINI_FALLBACK_MODEL: "gemini-3.5-flash-lite" })), "gemini-3.5-flash-lite");
});

test("isWiederholbarerGeminiFehler: nur 429/502/504 lösen den Fallback aus", () => {
  assert.equal(isWiederholbarerGeminiFehler(new GeminiError(504, "timeout")), true);
  assert.equal(isWiederholbarerGeminiFehler(new GeminiError(429, "limit")), true);
  assert.equal(isWiederholbarerGeminiFehler(new GeminiError(502, "fehler")), true);
  assert.equal(isWiederholbarerGeminiFehler(new GeminiError(400, "block")), false);
  assert.equal(isWiederholbarerGeminiFehler(new GeminiError(500, "key fehlt")), false);
  assert.equal(isWiederholbarerGeminiFehler(new Error("netz")), false);
  assert.equal(isWiederholbarerGeminiFehler(null), false);
});
