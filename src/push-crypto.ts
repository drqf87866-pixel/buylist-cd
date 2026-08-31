/**
 * Reine, testbare Web-Push-Krypto (RFC 8291 + RFC 8188): HKDF, ECDH,
 * aes128gcm-Record. Keine Abhängigkeit von Env/Request – Salt und
 * Key-Material sind injizierbar, damit bekannte Testvektoren prüfbar sind.
 *
 * Base64url-/ArrayBuffer-Helfer kommen aus ./crypto (eine Implementierung).
 */

import { base64UrlToBytes, bytesToBase64Url, toArrayBuffer } from "./crypto";

export { base64UrlToBytes, bytesToBase64Url, toArrayBuffer };

export function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(salt), info: toArrayBuffer(info) },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

const AUTH_INFO = new TextEncoder().encode("Content-Encoding: auth\0");
const KEY_INFO_PREFIX = new TextEncoder().encode("WebPush: info\0");
const CEK_INFO = new TextEncoder().encode("Content-Encoding: aes128gcm\0key");
const NONCE_INFO = new TextEncoder().encode("Content-Encoding: aes128gcm\0nonce");

/** RFC 8291: IKM aus ECDH-Shared-Secret + auth-Secret. */
export function deriveIkm(sharedSecret: Uint8Array, authSecret: Uint8Array): Promise<Uint8Array> {
  return hkdf(sharedSecret, authSecret, AUTH_INFO, 32);
}

/** keyInfo = "WebPush: info\0" || client_public || server_public (RFC 8291). */
export function buildKeyInfo(clientPub: Uint8Array, serverPub: Uint8Array): Uint8Array {
  return concat(KEY_INFO_PREFIX, clientPub, serverPub);
}

/** Leitet CEK (16 B) und Nonce (12 B) aus IKM + Salt + keyInfo ab. */
export async function deriveContentKeys(
  ikm: Uint8Array,
  salt: Uint8Array,
  keyInfo: Uint8Array
): Promise<{ cek: Uint8Array; nonce: Uint8Array }> {
  const cek = await hkdf(ikm, salt, concat(keyInfo, CEK_INFO), 16);
  const nonce = await hkdf(ikm, salt, concat(keyInfo, NONCE_INFO), 12);
  return { cek, nonce };
}

/**
 * Header: salt(16) || rs(4, big-endian, 4096) || idlen(1) || server_pub(65).
 */
export function buildRecordHeader(salt: Uint8Array, serverPub: Uint8Array): Uint8Array {
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return concat(salt, rs, new Uint8Array([serverPub.length]), serverPub);
}

/** RFC 8188: 2-Byte-Padding-Präambel (0x0000) vor dem eigentlichen Payload. */
export function aes128gcmRecord(payload: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0, 0]), payload);
}

/** Verschlüsselt den Record mit AES-GCM (128-bit-Tag, Header als AAD). */
export async function encryptRecord(
  cek: Uint8Array,
  nonce: Uint8Array,
  header: Uint8Array,
  record: Uint8Array
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(cek), { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(header), tagLength: 128 },
      key,
      toArrayBuffer(record)
    )
  );
  return ciphertext;
}

/** Entschlüsselt (nur für Tests/Verifikation): Header als AAD, 128-bit-Tag. */
export async function decryptRecord(
  cek: Uint8Array,
  nonce: Uint8Array,
  header: Uint8Array,
  ciphertext: Uint8Array
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(cek), { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(header), tagLength: 128 },
    key,
    toArrayBuffer(ciphertext)
  );
  return new Uint8Array(plain);
}

/**
 * Deterministischer Kern der Payload-Verschlüsselung: baut Header + Record
 * und liefert den kompletten aes128gcm-Body. Für gegebene Eingaben deterministisch
 * – dadurch gegen feste Testvektoren prüfbar.
 */
export async function encryptPayloadBody(
  ikm: Uint8Array,
  salt: Uint8Array,
  clientPub: Uint8Array,
  serverPub: Uint8Array,
  payload: Uint8Array
): Promise<Uint8Array> {
  const keyInfo = buildKeyInfo(clientPub, serverPub);
  const { cek, nonce } = await deriveContentKeys(ikm, salt, keyInfo);
  const header = buildRecordHeader(salt, serverPub);
  const record = aes128gcmRecord(payload);
  const ciphertext = await encryptRecord(cek, nonce, header, record);
  return concat(header, ciphertext);
}

/** ECDH-Shared-Secret (P-256) zwischen serverKeys (privat) und clientPub. */
export async function deriveSharedSecret(serverKeys: CryptoKeyPair, clientPub: Uint8Array): Promise<Uint8Array> {
  const clientKey = await crypto.subtle.importKey("raw", toArrayBuffer(clientPub), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey } as SubtleCryptoDeriveKeyAlgorithm, serverKeys.privateKey, 256)
  );
  return shared;
}
