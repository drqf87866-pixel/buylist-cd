import { test } from "node:test";
import assert from "node:assert/strict";
import { GEMINI_MAX_REQUESTS, limiterMaxFromUrl } from "./rate-limiter";

test("limiterMaxFromUrl: ohne max bleibt Gemini-Default 12", () => {
  assert.equal(limiterMaxFromUrl("https://rate-limiter/check"), GEMINI_MAX_REQUESTS);
});

test("limiterMaxFromUrl: gültiges max, Cap 120, ungültig fällt zurück", () => {
  assert.equal(limiterMaxFromUrl("https://rate-limiter/check?max=27"), 27);
  assert.equal(limiterMaxFromUrl("https://rate-limiter/check?max=999"), 120);
  assert.equal(limiterMaxFromUrl("https://rate-limiter/check?max=0"), GEMINI_MAX_REQUESTS);
  assert.equal(limiterMaxFromUrl("https://rate-limiter/check?max=abc"), GEMINI_MAX_REQUESTS);
});
