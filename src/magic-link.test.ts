import { test } from "node:test";
import assert from "node:assert/strict";
import { emailVerifyAktion } from "./magic-link";

test("emailVerifyAktion: (null, pbkdf2:…) -> discardPassword + wipeSessions", () => {
  const result = emailVerifyAktion(null, "pbkdf2:100000:salt:hash");
  assert.deepEqual(result, { setVerified: true, discardPassword: true, wipeSessions: true });
});

test("emailVerifyAktion: (null, magic) -> setVerified, kein discard", () => {
  const result = emailVerifyAktion(null, "magic");
  assert.deepEqual(result, { setVerified: true, discardPassword: false, wipeSessions: false });
});

test("emailVerifyAktion: (123, pbkdf2:…) -> nichts zu tun (bereits verifiziert)", () => {
  const result = emailVerifyAktion(123, "pbkdf2:100000:salt:hash");
  assert.deepEqual(result, { setVerified: false, discardPassword: false, wipeSessions: false });
});

test("emailVerifyAktion: (123, magic) -> nichts zu tun (bereits verifiziert)", () => {
  const result = emailVerifyAktion(123, "magic");
  assert.deepEqual(result, { setVerified: false, discardPassword: false, wipeSessions: false });
});

test("emailVerifyAktion: (null, garbage) -> setVerified, kein discard (unbekanntes Format)", () => {
  const result = emailVerifyAktion(null, "garbage");
  assert.deepEqual(result, { setVerified: true, discardPassword: false, wipeSessions: false });
});
