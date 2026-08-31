import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aes128gcmRecord,
  buildKeyInfo,
  buildRecordHeader,
  concat,
  decryptRecord,
  deriveContentKeys,
  deriveIkm,
  deriveSharedSecret,
  encryptPayloadBody,
  hkdf,
  toArrayBuffer,
} from "./push-crypto";

const textEncoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function ecdhPair(): Promise<{ keys: CryptoKeyPair; pub: Uint8Array }> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  return { keys, pub };
}

test("hkdf: RFC-5869-Testvektor 1 (SHA-256)", async () => {
  const ikm = new Uint8Array(22).fill(0x0b);
  const salt = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const info = Uint8Array.from([0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9]);
  const okm = await hkdf(ikm, salt, info, 42);
  assert.equal(
    bytesToHex(okm),
    "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
  );
});

test("deriveSharedSecret: serverseitige und clientseitige Ableitung identisch", async () => {
  const client = await ecdhPair();
  const server = await ecdhPair();

  const serverSide = await deriveSharedSecret(server.keys, client.pub);
  const clientKey = await crypto.subtle.importKey("raw", toArrayBuffer(server.pub), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const clientSide = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey } as SubtleCryptoDeriveKeyAlgorithm, client.keys.privateKey, 256)
  );
  assert.deepEqual(serverSide, clientSide);
});

test("encryptPayloadBody: Header-Layout salt‖rs‖idlen‖serverPub", async () => {
  const client = await ecdhPair();
  const server = await ecdhPair();
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const shared = await deriveSharedSecret(server.keys, client.pub);
  const ikm = await deriveIkm(shared, auth);
  const body = await encryptPayloadBody(ikm, salt, client.pub, server.pub, textEncoder.encode("hello"));

  const expectedHeader = buildRecordHeader(salt, server.pub);
  assert.equal(body.length, expectedHeader.length + 16 + 2 + 5);
  assert.deepEqual(body.slice(0, 16), salt);
  assert.equal(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false), 4096);
  assert.equal(body[20], 65);
  assert.deepEqual(body.slice(21, 86), server.pub);
});

test("encryptPayloadBody: Round-Trip-Entschlüsselung liefert 0x0000‖Payload", async () => {
  const client = await ecdhPair();
  const server = await ecdhPair();
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const payload = textEncoder.encode(JSON.stringify({ title: "Test", body: "Hallo", url: "/list/x" }));

  const shared = await deriveSharedSecret(server.keys, client.pub);
  const ikm = await deriveIkm(shared, auth);
  const body = await encryptPayloadBody(ikm, salt, client.pub, server.pub, payload);

  const header = body.slice(0, 86);
  const ciphertext = body.slice(86);
  const keyInfo = buildKeyInfo(client.pub, server.pub);
  const { cek, nonce } = await deriveContentKeys(ikm, salt, keyInfo);

  const plain = await decryptRecord(cek, nonce, header, ciphertext);
  assert.deepEqual(plain, aes128gcmRecord(payload));
  assert.equal(plain[0], 0);
  assert.equal(plain[1], 0);
  assert.deepEqual(plain.slice(2), payload);
});

test("encryptPayloadBody: deterministisch für gleiche Eingaben", async () => {
  const client = await ecdhPair();
  const server = await ecdhPair();
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const payload = textEncoder.encode("deterministisch");

  const shared = await deriveSharedSecret(server.keys, client.pub);
  const ikm = await deriveIkm(shared, auth);
  const body1 = await encryptPayloadBody(ikm, salt, client.pub, server.pub, payload);
  const body2 = await encryptPayloadBody(ikm, salt, client.pub, server.pub, payload);
  assert.deepEqual(body1, body2);
});

test("concat: hängt beliebig viele Arrays aneinander", () => {
  assert.deepEqual(concat(new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5, 6])), Uint8Array.from([1, 2, 3, 4, 5, 6]));
});
