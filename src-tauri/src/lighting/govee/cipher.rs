//! Govee's two BLE encryption generations (PROTOCOL.md §3-5, §10 of Fredde87/ha-govee-led-ble, MIT), through
//! Windows CNG (no new crates):
//!
//! - **v1** ("Safe"): each whole 16-byte block through AES-128-ECB, the trailing bytes XORed with an RC4 keystream
//!   under the same key, re-keyed for every frame. The `E7 01` / `E7 02` handshake runs under K_COMM; the session
//!   key is the first reply's plaintext[2..18]. Proven live on the developer's H6076 lamps (2026-10-15).
//! - **v2**: AES-GCM. The `E7 11` handshake under K_HS swaps two 8-byte ivKeys; the data key is
//!   AES-ECB(SKU ‖ MAC, K_DEV). Built to the reference, not yet live-verified (no v2 lamp here).

use windows::Win32::Security::Cryptography::{
    BCryptDecrypt, BCryptEncrypt, BCryptGenerateSymmetricKey, BCryptOpenAlgorithmProvider, BCryptSetProperty, BCRYPT_AES_ALGORITHM, BCRYPT_ALG_HANDLE,
    BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO, BCRYPT_CHAINING_MODE, BCRYPT_FLAGS, BCRYPT_HANDLE, BCRYPT_KEY_HANDLE, BCRYPT_OPEN_ALGORITHM_PROVIDER_FLAGS,
};

/// K_COMM, "MakingLifeSmarte": protects the v1 handshake.
pub const K_COMM: [u8; 16] = *b"MakingLifeSmarte";
/// K_HS: protects the v2 `E7 11` handshake.
pub const K_HS: [u8; 16] = [0xfc, 0x03, 0x78, 0x3c, 0x7c, 0x42, 0xcb, 0x83, 0xe2, 0x02, 0xa1, 0x64, 0x36, 0x48, 0xaf, 0xf6];
/// K_DEV: derives the v2 per-device key.
pub const K_DEV: [u8; 16] = [0xae, 0x02, 0x8b, 0x63, 0x0b, 0xae, 0x6e, 0xcc, 0x4b, 0xff, 0x1b, 0x24, 0x9e, 0x22, 0xf9, 0x55];

fn utf16z(s: &str) -> Vec<u8> {
    s.encode_utf16().chain(std::iter::once(0)).flat_map(|c| c.to_le_bytes()).collect()
}

/// An AES provider in one chaining mode, opened once.
struct Provider(BCRYPT_ALG_HANDLE);
// The handle is only used through CNG calls, which are thread safe for a provider handle.
unsafe impl Send for Provider {}
unsafe impl Sync for Provider {}

fn provider(mode: &'static str) -> Result<BCRYPT_ALG_HANDLE, String> {
    static ECB: std::sync::OnceLock<Result<Provider, String>> = std::sync::OnceLock::new();
    static GCM: std::sync::OnceLock<Result<Provider, String>> = std::sync::OnceLock::new();
    let cell = if mode == "ChainingModeECB" { &ECB } else { &GCM };
    let p = cell.get_or_init(|| unsafe {
        let mut alg = BCRYPT_ALG_HANDLE::default();
        BCryptOpenAlgorithmProvider(&mut alg, BCRYPT_AES_ALGORITHM, None, BCRYPT_OPEN_ALGORITHM_PROVIDER_FLAGS(0)).ok().map_err(|e| format!("AES provider: {e}"))?;
        BCryptSetProperty(BCRYPT_HANDLE(alg.0), BCRYPT_CHAINING_MODE, &utf16z(mode), 0).ok().map_err(|e| format!("{mode}: {e}"))?;
        Ok(Provider(alg))
    });
    p.as_ref().map(|p| p.0).map_err(Clone::clone)
}

fn key(mode: &'static str, k: &[u8; 16]) -> Result<BCRYPT_KEY_HANDLE, String> {
    let mut h = BCRYPT_KEY_HANDLE::default();
    unsafe { BCryptGenerateSymmetricKey(provider(mode)?, &mut h, None, k, 0).ok().map_err(|e| format!("AES key: {e}"))? };
    Ok(h)
}

/// One AES-128-ECB block.
pub fn aes_ecb(k: &[u8; 16], block: &[u8], decrypt: bool) -> Result<[u8; 16], String> {
    if block.len() != 16 {
        return Err("AES blocks are 16 bytes".into());
    }
    let h = key("ChainingModeECB", k)?;
    let mut out = [0u8; 16];
    let mut n = 0u32;
    let r = unsafe {
        if decrypt {
            BCryptDecrypt(h, Some(block), None, None, Some(&mut out), &mut n, BCRYPT_FLAGS(0))
        } else {
            BCryptEncrypt(h, Some(block), None, None, Some(&mut out), &mut n, BCRYPT_FLAGS(0))
        }
    };
    unsafe { windows::Win32::Security::Cryptography::BCryptDestroyKey(h).ok().ok() };
    r.ok().map_err(|e| format!("AES-ECB: {e}"))?;
    Ok(out)
}

/// RC4 keystream (KSA + PRGA), `n` bytes.
pub fn rc4(k: &[u8], n: usize) -> Vec<u8> {
    let mut s: Vec<u8> = (0..=255).collect();
    let mut j = 0u8;
    for i in 0..256 {
        j = j.wrapping_add(s[i]).wrapping_add(k[i % k.len()]);
        s.swap(i, usize::from(j));
    }
    let (mut i, mut j) = (0u8, 0u8);
    (0..n)
        .map(|_| {
            i = i.wrapping_add(1);
            j = j.wrapping_add(s[usize::from(i)]);
            s.swap(usize::from(i), usize::from(j));
            s[usize::from(s[usize::from(i)].wrapping_add(s[usize::from(j)]))]
        })
        .collect()
}

/// v1: whole 16-byte blocks through AES-ECB, the tail XORed with RC4 under the same key (length-preserving).
pub fn safe(k: &[u8; 16], data: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    let whole = data.len() / 16 * 16;
    let mut out = Vec::with_capacity(data.len());
    for b in data[..whole].chunks(16) {
        out.extend_from_slice(&aes_ecb(k, b, decrypt)?);
    }
    out.extend(data[whole..].iter().zip(rc4(k, data.len() - whole)).map(|(a, b)| a ^ b));
    Ok(out)
}

/// AES-GCM seal: the ciphertext and a 16-byte tag.
pub fn gcm_seal(k: &[u8; 16], nonce: &[u8; 12], aad: &[u8], plaintext: &[u8]) -> Result<(Vec<u8>, [u8; 16]), String> {
    let h = key("ChainingModeGCM", k)?;
    let mut tag = [0u8; 16];
    let mut nonce_buf = *nonce;
    let mut aad_buf = aad.to_vec();
    let info = BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO {
        cbSize: std::mem::size_of::<BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO>() as u32,
        dwInfoVersion: 1,
        pbNonce: nonce_buf.as_mut_ptr(),
        cbNonce: 12,
        pbAuthData: if aad_buf.is_empty() { std::ptr::null_mut() } else { aad_buf.as_mut_ptr() },
        cbAuthData: aad_buf.len() as u32,
        pbTag: tag.as_mut_ptr(),
        cbTag: 16,
        ..Default::default()
    };
    let mut out = vec![0u8; plaintext.len()];
    let mut n = 0u32;
    let r = unsafe { BCryptEncrypt(h, Some(plaintext), Some(&info as *const _ as *const core::ffi::c_void), None, Some(&mut out), &mut n, BCRYPT_FLAGS(0)) };
    unsafe { windows::Win32::Security::Cryptography::BCryptDestroyKey(h).ok().ok() };
    r.ok().map_err(|e| format!("AES-GCM: {e}"))?;
    Ok((out, tag))
}

/// AES-GCM open: the plaintext, or None when the tag doesn't check out.
pub fn gcm_open(k: &[u8; 16], nonce: &[u8; 12], aad: &[u8], ciphertext: &[u8], tag: &[u8]) -> Option<Vec<u8>> {
    if tag.len() != 16 {
        return None;
    }
    let h = key("ChainingModeGCM", k).ok()?;
    let mut tag_buf = [0u8; 16];
    tag_buf.copy_from_slice(tag);
    let mut nonce_buf = *nonce;
    let mut aad_buf = aad.to_vec();
    let info = BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO {
        cbSize: std::mem::size_of::<BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO>() as u32,
        dwInfoVersion: 1,
        pbNonce: nonce_buf.as_mut_ptr(),
        cbNonce: 12,
        pbAuthData: if aad_buf.is_empty() { std::ptr::null_mut() } else { aad_buf.as_mut_ptr() },
        cbAuthData: aad_buf.len() as u32,
        pbTag: tag_buf.as_mut_ptr(),
        cbTag: 16,
        ..Default::default()
    };
    let mut out = vec![0u8; ciphertext.len()];
    let mut n = 0u32;
    let r = unsafe { BCryptDecrypt(h, Some(ciphertext), Some(&info as *const _ as *const core::ffi::c_void), None, Some(&mut out), &mut n, BCRYPT_FLAGS(0)) };
    unsafe { windows::Win32::Security::Cryptography::BCryptDestroyKey(h).ok().ok() };
    r.ok().ok().map(|_| out)
}

/// v2: the per-device data key, AES-ECB(SKU (5) ‖ MAC (6, as the handshake carries it) ‖ zeros, K_DEV).
pub fn device_key(sku: &[u8; 5], mac_wire: &[u8; 6]) -> Result<[u8; 16], String> {
    let mut block = [0u8; 16];
    block[..5].copy_from_slice(sku);
    block[5..11].copy_from_slice(mac_wire);
    aes_ecb(&K_DEV, &block, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn aes_and_rc4_match_their_published_vectors() {
        // FIPS-197 appendix C.1.
        let k: [u8; 16] = hex("000102030405060708090a0b0c0d0e0f").try_into().unwrap();
        assert_eq!(aes_ecb(&k, &hex("00112233445566778899aabbccddeeff"), false).unwrap().to_vec(), hex("69c4e0d86a7b0430d8cdb78070b4c55a"));
        assert_eq!(aes_ecb(&k, &hex("69c4e0d86a7b0430d8cdb78070b4c55a"), true).unwrap().to_vec(), hex("00112233445566778899aabbccddeeff"));
        // RC4 with key "Key": keystream EB9F7781B734CA72A719.
        assert_eq!(rc4(b"Key", 10), hex("eb9f7781b734ca72a719"));
        // GCM (McGrew & Viega test cases 2 and 4).
        let (c, t) = gcm_seal(&[0; 16], &[0; 12], &[], &[0; 16]).unwrap();
        assert_eq!((c, t.to_vec()), (hex("0388dace60b6a392f328c2b971b2fe78"), hex("ab6e47d42cec13bdf53a67b21257bddf")));
        let k: [u8; 16] = hex("feffe9928665731c6d6a8f9467308308").try_into().unwrap();
        let iv: [u8; 12] = hex("cafebabefacedbaddecaf888").try_into().unwrap();
        let p = hex("d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39");
        let a = hex("feedfacedeadbeeffeedfacedeadbeefabaddad2");
        let (c, t) = gcm_seal(&k, &iv, &a, &p).unwrap();
        assert_eq!(c, hex("42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091"));
        assert_eq!(t.to_vec(), hex("5bc94fbc3221a5db94fae95ae7121a47"));
        assert_eq!(gcm_open(&k, &iv, &a, &c, &t).unwrap(), p);
        let mut bad = t;
        bad[0] ^= 1;
        assert!(gcm_open(&k, &iv, &a, &c, &bad).is_none(), "a wrong tag never decrypts");
    }

    /// The developer's H6076, 2026-10-15: the v1 handshake reply and confirm, as captured, decrypt under K_COMM.
    #[test]
    fn the_captured_v1_handshake_decrypts() {
        let reply = safe(&K_COMM, &hex("9833f1e38a735dfb5b9e1072c5c6e6d807784011"), true).unwrap();
        assert_eq!(reply.len(), 20);
        assert_eq!(reply[..4], hex("e701c2ed")[..]);
        assert_eq!(reply[18..], hex("004e")[..]);
        assert_eq!(reply[..19].iter().fold(0, |a, b| a ^ b), reply[19], "a valid checksum");
        let confirm = safe(&K_COMM, &hex("6886110cddfaa754f8a29134721719148f4072d0"), true).unwrap();
        assert_eq!(confirm[..4], hex("e702fac5")[..]);
        assert_eq!(confirm[18..], hex("328f")[..]);
        assert_eq!(confirm[..19].iter().fold(0, |a, b| a ^ b), confirm[19]);
        // And back: the transform is length-preserving and its own inverse.
        assert_eq!(safe(&K_COMM, &reply, false).unwrap(), hex("9833f1e38a735dfb5b9e1072c5c6e6d807784011"));
    }

    fn hx(b: &[u8]) -> String {
        if b.is_empty() {
            return "-".into();
        }
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// The answers these ciphers give for inputs a fixed generator makes: AES blocks, RC4 streams, the v1 transform at
    /// every length from 0 to 40 bytes, GCM with and without associated data, and v2 device keys. One per line:
    /// `aes <key> <block> <sealed>`, `rc4 <key> <stream>`, `safe <key> <plain> <sealed>`,
    /// `gcm <key> <nonce> <aad> <plain> <sealed> <tag>` and `devkey <sku> <mac> <key>` ("-" for no bytes).
    fn vectors() -> String {
        let mut x = 0x2545_f491_4f6c_dd1du64;
        let mut bytes = |n: usize| -> Vec<u8> {
            (0..n)
                .map(|_| {
                    x ^= x << 13;
                    x ^= x >> 7;
                    x ^= x << 17;
                    (x >> 32) as u8
                })
                .collect()
        };
        let mut out = Vec::new();
        for i in 0..8 {
            let k: [u8; 16] = if i == 0 { K_COMM } else { bytes(16).try_into().unwrap() };
            let b = bytes(16);
            out.push(format!("aes {} {} {}", hx(&k), hx(&b), hx(&aes_ecb(&k, &b, false).unwrap())));
        }
        for n in [1, 3, 5, 16, 32] {
            let k = bytes(n);
            out.push(format!("rc4 {} {}", hx(&k), hx(&rc4(&k, 40))));
        }
        for n in 0..=40 {
            let k: [u8; 16] = if n % 3 == 0 { K_COMM } else { bytes(16).try_into().unwrap() };
            let p = bytes(n);
            out.push(format!("safe {} {} {}", hx(&k), hx(&p), hx(&safe(&k, &p, false).unwrap())));
        }
        for (aad, n) in [(0, 8), (4, 20), (15, 19), (16, 8), (16, 20), (20, 16), (4, 40)] {
            let k: [u8; 16] = if aad == 15 || aad == 16 { K_HS } else { bytes(16).try_into().unwrap() };
            let (nonce, a, p): ([u8; 12], Vec<u8>, Vec<u8>) = (bytes(12).try_into().unwrap(), bytes(aad), bytes(n));
            let (c, tag) = gcm_seal(&k, &nonce, &a, &p).unwrap();
            assert_eq!(gcm_open(&k, &nonce, &a, &c, &tag).unwrap(), p);
            out.push(format!("gcm {} {} {} {} {} {}", hx(&k), hx(&nonce), hx(&a), hx(&p), hx(&c), hx(&tag)));
        }
        let mut skus: Vec<[u8; 5]> = vec![*b"H6076", *b"H6199", *b"H7020"];
        skus.push(bytes(5).try_into().unwrap());
        for sku in skus {
            let mac: [u8; 6] = bytes(6).try_into().unwrap();
            out.push(format!("devkey {} {} {}", hx(&sku), hx(&mac), hx(&device_key(&sku, &mac).unwrap())));
        }
        out.join("\n") + "\n"
    }

    /// The website's copy of these ciphers (src/lib/lighting/web/cipher.ts, through @noble/ciphers) is held to the
    /// answers in cipher-vectors.txt by scripts/web-govee.test.ts; this holds the bridge to the same file. After a
    /// deliberate change, rewrite it with `GOVEE_VECTORS=write cargo test --lib website_cipher` and run both.
    #[test]
    fn the_website_cipher_vectors_are_the_bridges() {
        let text = vectors();
        if std::env::var("GOVEE_VECTORS").as_deref() == Ok("write") {
            std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lighting/govee/cipher-vectors.txt"), &text).unwrap();
            return;
        }
        // Read next to this file, so the helper (which builds this file from its own folder) checks the same one.
        let kept = include_str!("cipher-vectors.txt").replace("\r\n", "\n");
        assert!(kept == text, "cipher-vectors.txt is out of date: GOVEE_VECTORS=write cargo test --lib website_cipher");
    }
}
