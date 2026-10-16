// Govee's two BLE encryption generations for the website, byte for byte what the desktop bridge does through Windows
// CNG (src-tauri/src/lighting/govee/cipher.rs; PROTOCOL.md §3-5, §10 of Fredde87/ha-govee-led-ble, MIT). WebCrypto has
// no AES-ECB, so the block cipher and GCM come from @noble/ciphers (audited, MIT); RC4 is the few lines below.
// cipher-vectors.txt next to cipher.rs holds both sides to the same answers (scripts/web-govee.test.ts). Pure.
//
// - v1 ("Safe"): each whole 16-byte block through AES-128-ECB, the trailing bytes XORed with an RC4 keystream under the
//   same key, re-keyed for every frame. Proven live on the developer's H6076 lamps through the desktop app.
// - v2: AES-GCM, with the data key AES-ECB(SKU ‖ MAC, K_DEV). Built to the reference, not yet live-verified.
import { ecb, gcm } from "@noble/ciphers/aes.js";

/** K_COMM, "MakingLifeSmarte": protects the v1 handshake. */
export const K_COMM = Uint8Array.from("MakingLifeSmarte", (c) => c.charCodeAt(0));
/** K_HS: protects the v2 `E7 11` handshake. */
export const K_HS = Uint8Array.from([0xfc, 0x03, 0x78, 0x3c, 0x7c, 0x42, 0xcb, 0x83, 0xe2, 0x02, 0xa1, 0x64, 0x36, 0x48, 0xaf, 0xf6]);
/** K_DEV: derives the v2 per-device key. */
export const K_DEV = Uint8Array.from([0xae, 0x02, 0x8b, 0x63, 0x0b, 0xae, 0x6e, 0xcc, 0x4b, 0xff, 0x1b, 0x24, 0x9e, 0x22, 0xf9, 0x55]);

/** One AES-128-ECB block. */
export function aesEcb(key: Uint8Array, block: Uint8Array, decrypt: boolean): Uint8Array {
  if (key.length !== 16 || block.length !== 16) throw new RangeError("AES-128 takes a 16-byte key and 16-byte blocks");
  const c = ecb(key, { disablePadding: true });
  return decrypt ? c.decrypt(block) : c.encrypt(block);
}

/** RC4 keystream (key schedule, then `n` bytes of output). */
export function rc4(key: Uint8Array, n: number): Uint8Array {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(n);
  let a = 0;
  let b = 0;
  for (let k = 0; k < n; k++) {
    a = (a + 1) & 0xff;
    b = (b + s[a]) & 0xff;
    [s[a], s[b]] = [s[b], s[a]];
    out[k] = s[(s[a] + s[b]) & 0xff];
  }
  return out;
}

/** v1: whole 16-byte blocks through AES-ECB, the tail XORed with RC4 under the same key (length-preserving). */
export function safe(key: Uint8Array, data: Uint8Array, decrypt: boolean): Uint8Array {
  const whole = Math.floor(data.length / 16) * 16;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < whole; i += 16) out.set(aesEcb(key, data.subarray(i, i + 16), decrypt), i);
  const stream = rc4(key, data.length - whole);
  for (let i = whole; i < data.length; i++) out[i] = data[i] ^ stream[i - whole];
  return out;
}

/** AES-GCM seal: the ciphertext and its 16-byte tag. */
export function gcmSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): { sealed: Uint8Array; tag: Uint8Array } {
  const out = gcm(key, nonce, aad).encrypt(plaintext);
  return { sealed: out.slice(0, out.length - 16), tag: out.slice(out.length - 16) };
}

/** AES-GCM open: the plaintext, or null when the tag doesn't check out. */
export function gcmOpen(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array, tag: Uint8Array): Uint8Array | null {
  if (tag.length !== 16) return null;
  const both = new Uint8Array(sealed.length + 16);
  both.set(sealed);
  both.set(tag, sealed.length);
  try {
    return gcm(key, nonce, aad).decrypt(both);
  } catch {
    return null;
  }
}

/** v2: the per-device data key, AES-ECB(SKU (5) ‖ MAC (6, as the handshake carries it) ‖ zeros, K_DEV). */
export function deviceKey(sku: Uint8Array, macWire: Uint8Array): Uint8Array {
  if (sku.length !== 5 || macWire.length !== 6) throw new RangeError("a v2 key takes a 5-byte SKU and a 6-byte address");
  const block = new Uint8Array(16);
  block.set(sku);
  block.set(macWire, 5);
  return aesEcb(K_DEV, block, false);
}
