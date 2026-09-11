import { test } from "node:test";
import assert from "node:assert/strict";
import { GEMINI_MAX_REQUESTS, GEMINI_WINDOW_MS, limiterMaxFromUrl, limiterWindowFromUrl } from "./rate-limiter";

test("limiterMaxFromUrl: ohne max bleibt Gemini-Default 12", () => {
  assert.equal(limiterMaxFromUrl("https://rate-limiter/check"), GEMINI_MAX_REQUESTS);
});

test("limiterMaxFromUrl: gültiges max, Cap 120, ungültig fällt zurück", () => {
  assert.equal(limiterMaxFromUrl("https://rate-limiter/check?max=27"), 27);
  assert.equal(limiterMaxFromUrl("https://rate-limiter/check?max=999"), 120);
  assert.equal(limiterMaxFromUrl("https://rate-limiter/check?max=0"), GEMINI_MAX_REQUESTS);
  assert.equal(limiterMaxFromUrl("https://rate-limiter/check?max=abc"), GEMINI_MAX_REQUESTS);
});

test("limiterWindowFromUrl: Default 60000", () => {
  assert.equal(limiterWindowFromUrl("https://rate-limiter/check"), GEMINI_WINDOW_MS);
});

test("limiterWindowFromUrl: gültiges window, Cap 30 Min, ungültig fällt zurück", () => {
  assert.equal(limiterWindowFromUrl("https://rate-limiter/check?window=5000"), 5000);
  assert.equal(limiterWindowFromUrl("https://rate-limiter/check?window=2000000"), 1_800_000);
  assert.equal(limiterWindowFromUrl("https://rate-limiter/check?window=0"), GEMINI_WINDOW_MS);
  assert.equal(limiterWindowFromUrl("https://rate-limiter/check?window=abc"), GEMINI_WINDOW_MS);
  assert.equal(limiterWindowFromUrl("https://rate-limiter/check?window=-1"), GEMINI_WINDOW_MS);
});
