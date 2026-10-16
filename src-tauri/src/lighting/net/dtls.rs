//! A small DTLS 1.2 client for one cipher suite, TLS_PSK_WITH_AES_128_GCM_SHA256 (RFC 6347, RFC 4279, RFC 5487): what
//! a Philips Hue Bridge takes for Entertainment streaming (screen sync, wave L5). The identity is the bridge's username
//! for SYNQ and the key its client key, both from pairing (net/mod.rs). Only the client side, only this suite, no
//! renegotiation or resumption; the handshake is retried on loss like DTLS asks (1 s, three tries).
//!
//! The record protection (AES-128-GCM) comes from the caller (`Aead`: Windows CNG in the app), and so does the network
//! (`Wire`: a UDP socket connected to the bridge), so the whole handshake is tested in memory against a server built
//! from the same pieces. Interop with a real bridge is UNVERIFIED until the developer tries it (LIGHTING.md §8).

#![cfg_attr(not(windows), allow(dead_code))]

use sha2::{Digest, Sha256};
use std::time::Duration;

pub const PSK_AES128_GCM_SHA256: u16 = 0x00a8;
const DTLS12: [u8; 2] = [0xfe, 0xfd];
const HANDSHAKE: u8 = 22;
const CHANGE_CIPHER_SPEC: u8 = 20;
const APPLICATION_DATA: u8 = 23;
const ALERT: u8 = 21;
const CLIENT_HELLO: u8 = 1;
const SERVER_HELLO: u8 = 2;
const HELLO_VERIFY_REQUEST: u8 = 3;
const SERVER_KEY_EXCHANGE: u8 = 12;
const SERVER_HELLO_DONE: u8 = 14;
const CLIENT_KEY_EXCHANGE: u8 = 16;
const FINISHED: u8 = 20;
const RETRY: Duration = Duration::from_millis(1000);
const TRIES: usize = 3;

/// AES-128-GCM: the sealed bytes are the ciphertext followed by the 16-byte tag.
pub trait Aead {
    fn seal(&self, key: &[u8; 16], nonce: &[u8; 12], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String>;
    fn open(&self, key: &[u8; 16], nonce: &[u8; 12], aad: &[u8], sealed: &[u8]) -> Option<Vec<u8>>;
}

/// One datagram out, and the next one in (None when nothing came in time).
pub trait Wire {
    fn send(&mut self, datagram: &[u8]) -> Result<(), String>;
    fn recv(&mut self, timeout: Duration) -> Option<Vec<u8>>;
}

pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let pad = |b: u8| k.iter().map(|x| x ^ b).collect::<Vec<u8>>();
    let inner = Sha256::new().chain_update(pad(0x36)).chain_update(data).finalize();
    Sha256::new().chain_update(pad(0x5c)).chain_update(inner).finalize().into()
}

/// TLS 1.2's PRF with SHA-256 (RFC 5246 §5): `len` bytes of P_SHA256(secret, label ‖ seed).
pub fn prf(secret: &[u8], label: &[u8], seed: &[u8], len: usize) -> Vec<u8> {
    let ls = [label, seed].concat();
    let mut a = hmac_sha256(secret, &ls).to_vec();
    let mut out = Vec::with_capacity(len + 32);
    while out.len() < len {
        out.extend_from_slice(&hmac_sha256(secret, &[a.as_slice(), &ls].concat()));
        a = hmac_sha256(secret, &a).to_vec();
    }
    out.truncate(len);
    out
}

/// The premaster secret of a plain PSK suite (RFC 4279 §2): N zero bytes and the key, each with its length.
pub fn psk_premaster(psk: &[u8]) -> Vec<u8> {
    let n = (psk.len() as u16).to_be_bytes();
    [&n[..], &vec![0u8; psk.len()], &n, psk].concat()
}

/// The session's keys (RFC 5246 §6.3, GCM: no MAC keys, 4-byte implicit IVs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Keys {
    pub client_key: [u8; 16],
    pub server_key: [u8; 16],
    pub client_iv: [u8; 4],
    pub server_iv: [u8; 4],
}

pub fn keys(master: &[u8], client_random: &[u8; 32], server_random: &[u8; 32]) -> Keys {
    let b = prf(master, b"key expansion", &[&server_random[..], client_random].concat(), 40);
    let k = |at: usize| -> [u8; 16] { b[at..at + 16].try_into().unwrap_or([0; 16]) };
    let iv = |at: usize| -> [u8; 4] { b[at..at + 4].try_into().unwrap_or([0; 4]) };
    Keys { client_key: k(0), server_key: k(16), client_iv: iv(32), server_iv: iv(36) }
}

pub fn master_secret(psk: &[u8], client_random: &[u8; 32], server_random: &[u8; 32]) -> Vec<u8> {
    prf(&psk_premaster(psk), b"master secret", &[&client_random[..], server_random].concat(), 48)
}

fn u24(n: usize) -> [u8; 3] {
    [(n >> 16) as u8, (n >> 8) as u8, n as u8]
}

/// A record: type, version, epoch, 48-bit sequence number, length, fragment.
pub fn record(ctype: u8, epoch: u16, seq: u64, fragment: &[u8]) -> Vec<u8> {
    let mut r = vec![ctype, DTLS12[0], DTLS12[1]];
    r.extend_from_slice(&epoch.to_be_bytes());
    r.extend_from_slice(&seq.to_be_bytes()[2..]);
    r.extend_from_slice(&(fragment.len() as u16).to_be_bytes());
    r.extend_from_slice(fragment);
    r
}

#[derive(Debug, Clone)]
pub struct Record {
    pub ctype: u8,
    pub epoch: u16,
    pub seq: u64,
    pub fragment: Vec<u8>,
}

/// The records in one datagram (a short or broken tail is dropped).
pub fn records(mut d: &[u8]) -> Vec<Record> {
    let mut out = Vec::new();
    while d.len() >= 13 {
        let len = usize::from(u16::from_be_bytes([d[11], d[12]]));
        if d.len() < 13 + len {
            break;
        }
        let mut seq = [0u8; 8];
        seq[2..].copy_from_slice(&d[5..11]);
        out.push(Record { ctype: d[0], epoch: u16::from_be_bytes([d[3], d[4]]), seq: u64::from_be_bytes(seq), fragment: d[13..13 + len].to_vec() });
        d = &d[13 + len..];
    }
    out
}

/// A handshake message, unfragmented, with its DTLS header (as it is also hashed for Finished).
pub fn handshake(msg_type: u8, msg_seq: u16, body: &[u8]) -> Vec<u8> {
    let mut m = vec![msg_type];
    m.extend_from_slice(&u24(body.len()));
    m.extend_from_slice(&msg_seq.to_be_bytes());
    m.extend_from_slice(&[0, 0, 0]);
    m.extend_from_slice(&u24(body.len()));
    m.extend_from_slice(body);
    m
}

/// The handshake messages in a record's fragment: (type, whole message with header, body). Fragmented messages are
/// not taken (the bridge's are small).
pub fn handshakes(mut f: &[u8]) -> Vec<(u8, Vec<u8>, Vec<u8>)> {
    let mut out = Vec::new();
    while f.len() >= 12 {
        let len = (usize::from(f[1]) << 16) | (usize::from(f[2]) << 8) | usize::from(f[3]);
        let frag_off = (usize::from(f[6]) << 16) | (usize::from(f[7]) << 8) | usize::from(f[8]);
        let frag_len = (usize::from(f[9]) << 16) | (usize::from(f[10]) << 8) | usize::from(f[11]);
        if f.len() < 12 + frag_len {
            break;
        }
        if frag_off == 0 && frag_len == len {
            out.push((f[0], f[..12 + len].to_vec(), f[12..12 + len].to_vec()));
        }
        f = &f[12 + frag_len..];
    }
    out
}

pub fn client_hello(random: &[u8; 32], cookie: &[u8]) -> Vec<u8> {
    let mut b = DTLS12.to_vec();
    b.extend_from_slice(random);
    b.push(0); // no session id
    b.push(cookie.len() as u8);
    b.extend_from_slice(cookie);
    b.extend_from_slice(&2u16.to_be_bytes());
    b.extend_from_slice(&PSK_AES128_GCM_SHA256.to_be_bytes());
    b.extend_from_slice(&[1, 0]); // compression: none
    b
}

/// The 8-byte sequence number that goes in a record's nonce and additional data: epoch ‖ 48-bit sequence.
fn seq_num(epoch: u16, seq: u64) -> [u8; 8] {
    let mut s = seq.to_be_bytes();
    s[..2].copy_from_slice(&epoch.to_be_bytes());
    s
}

fn aad(epoch: u16, seq: u64, ctype: u8, len: usize) -> Vec<u8> {
    [&seq_num(epoch, seq)[..], &[ctype, DTLS12[0], DTLS12[1]], &(len as u16).to_be_bytes()].concat()
}

/// A protected record: the 8-byte explicit nonce (the sequence number), then the sealed plaintext.
pub fn seal(aead: &dyn Aead, key: &[u8; 16], iv: &[u8; 4], ctype: u8, epoch: u16, seq: u64, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let explicit = seq_num(epoch, seq);
    let nonce: [u8; 12] = [&iv[..], &explicit].concat().try_into().map_err(|_| "nonce")?;
    let sealed = aead.seal(key, &nonce, &aad(epoch, seq, ctype, plaintext.len()), plaintext)?;
    Ok(record(ctype, epoch, seq, &[&explicit[..], &sealed].concat()))
}

pub fn open(aead: &dyn Aead, key: &[u8; 16], iv: &[u8; 4], r: &Record) -> Option<Vec<u8>> {
    if r.fragment.len() < 8 + 16 {
        return None;
    }
    let nonce: [u8; 12] = [&iv[..], &r.fragment[..8]].concat().try_into().ok()?;
    let sealed = &r.fragment[8..];
    aead.open(key, &nonce, &aad(r.epoch, r.seq, r.ctype, sealed.len() - 16), sealed)
}

pub fn finished(master: &[u8], label: &[u8], transcript: &[u8]) -> Vec<u8> {
    prf(master, label, &Sha256::digest(transcript), 12)
}

/// An open session: application data goes out protected under epoch 1.
pub struct Session<W: Wire, A: Aead> {
    wire: W,
    aead: A,
    keys: Keys,
    seq: u64,
}

impl<W: Wire, A: Aead> Session<W, A> {
    /// The handshake, as the client: hello (and again with the server's cookie), key exchange with the identity,
    /// Finished both ways. `random` is the client random (fresh for every session).
    pub fn connect(mut wire: W, aead: A, identity: &[u8], psk: &[u8], random: [u8; 32]) -> Result<Self, String> {
        // Flight 1 (and 3 with the cookie). The first hello and the cookie request are not part of the transcript.
        let mut seq = 0u64;
        let mut msg_seq = 0u16;
        let mut cookie = Vec::new();
        let mut transcript = Vec::new();
        let mut server: Vec<(u8, Vec<u8>, Vec<u8>)> = Vec::new();
        'hello: for _round in 0..2 {
            let hello = handshake(CLIENT_HELLO, msg_seq, &client_hello(&random, &cookie));
            for _try in 0..TRIES {
                wire.send(&record(HANDSHAKE, 0, seq, &hello))?;
                seq += 1;
                let mut got: Vec<(u8, Vec<u8>, Vec<u8>)> = Vec::new();
                while let Some(d) = wire.recv(RETRY) {
                    for r in records(&d) {
                        if r.ctype == ALERT {
                            return Err("The bridge turned the stream down (an alert in the handshake).".into());
                        }
                        if r.ctype == HANDSHAKE && r.epoch == 0 {
                            got.extend(handshakes(&r.fragment));
                        }
                    }
                    if let Some((_, _, body)) = got.iter().find(|m| m.0 == HELLO_VERIFY_REQUEST) {
                        // server_version (2), cookie length (1), cookie.
                        let n = usize::from(*body.get(2).ok_or("short cookie request")?);
                        cookie = body.get(3..3 + n).ok_or("short cookie request")?.to_vec();
                        msg_seq += 1;
                        continue 'hello;
                    }
                    if got.iter().any(|m| m.0 == SERVER_HELLO_DONE) {
                        transcript.extend_from_slice(&hello);
                        server = got;
                        break 'hello;
                    }
                }
            }
            return Err("The bridge didn't answer the stream's hello.".into());
        }
        if server.is_empty() {
            return Err("The bridge didn't finish its hello.".into());
        }
        let (_, sh_msg, sh) = server.iter().find(|m| m.0 == SERVER_HELLO).cloned().ok_or("no ServerHello")?;
        let server_random: [u8; 32] = sh.get(2..34).ok_or("short ServerHello")?.try_into().map_err(|_| "ServerHello random")?;
        let sid = usize::from(*sh.get(34).ok_or("short ServerHello")?);
        let suite = u16::from_be_bytes([*sh.get(35 + sid).ok_or("short ServerHello")?, *sh.get(36 + sid).ok_or("short ServerHello")?]);
        if suite != PSK_AES128_GCM_SHA256 {
            return Err(format!("The bridge chose cipher suite {suite:#06x}, not PSK AES-128-GCM."));
        }
        transcript.extend_from_slice(&sh_msg);
        for t in [SERVER_KEY_EXCHANGE, SERVER_HELLO_DONE] {
            if let Some((_, m, _)) = server.iter().find(|m| m.0 == t) {
                transcript.extend_from_slice(m);
            }
        }
        msg_seq += 1;
        // Flight 5: the identity, ChangeCipherSpec, Finished (protected).
        let cke = handshake(CLIENT_KEY_EXCHANGE, msg_seq, &[&(identity.len() as u16).to_be_bytes()[..], identity].concat());
        transcript.extend_from_slice(&cke);
        let master = master_secret(psk, &random, &server_random);
        let k = keys(&master, &random, &server_random);
        let fin = handshake(FINISHED, msg_seq + 1, &finished(&master, b"client finished", &transcript));
        transcript.extend_from_slice(&fin);
        let expected = finished(&master, b"server finished", &transcript);
        for attempt in 0..TRIES as u64 {
            let flight = [
                record(HANDSHAKE, 0, seq, &cke),
                record(CHANGE_CIPHER_SPEC, 0, seq + 1, &[1]),
                seal(&aead, &k.client_key, &k.client_iv, HANDSHAKE, 1, attempt, &fin)?,
            ]
            .concat();
            seq += 2;
            wire.send(&flight)?;
            while let Some(d) = wire.recv(RETRY) {
                for r in records(&d) {
                    if r.ctype == ALERT && r.epoch == 0 {
                        return Err("The bridge turned the stream down (wrong key?).".into());
                    }
                    if r.ctype != HANDSHAKE || r.epoch != 1 {
                        continue;
                    }
                    let plain = open(&aead, &k.server_key, &k.server_iv, &r).ok_or("The bridge's Finished didn't decrypt (wrong key?).")?;
                    let msgs = handshakes(&plain);
                    let (_, _, body) = msgs.iter().find(|m| m.0 == FINISHED).ok_or("no server Finished")?;
                    if body != &expected {
                        return Err("The bridge's Finished doesn't match: the handshake went wrong.".into());
                    }
                    return Ok(Self { wire, aead, keys: k, seq: attempt + 1 });
                }
            }
        }
        Err("The bridge didn't finish the handshake.".into())
    }

    /// One application datagram, protected.
    pub fn send(&mut self, data: &[u8]) -> Result<(), String> {
        let r = seal(&self.aead, &self.keys.client_key, &self.keys.client_iv, APPLICATION_DATA, 1, self.seq, data)?;
        self.seq += 1;
        self.wire.send(&r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn hmac_and_prf_known_answers() {
        // RFC 4231 test case 2.
        assert_eq!(hmac_sha256(b"Jefe", b"what do ya want for nothing?").to_vec(), hex("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"));
        // P_SHA256 checked against Python's hmac module (secret 16 x 0x0b, label "test label", seed "seed", 48 bytes).
        assert_eq!(prf(&[0x0b; 16], b"test label", b"seed", 48), hex(PRF_ANSWER));
        // The PSK premaster: length, zeros, length, key.
        assert_eq!(psk_premaster(&[7, 8]), vec![0, 2, 0, 0, 0, 2, 7, 8]);
    }

    const PRF_ANSWER: &str = "72c350bc08df2a9dfede75c55a1612281929c452d032b6905f95304b92684d1ba55aa8e50a59b129a9f8e278390bad59";

    #[test]
    fn records_and_handshakes_round_trip() {
        let m = handshake(CLIENT_HELLO, 3, &[1, 2, 3]);
        assert_eq!(&m[..12], &[1, 0, 0, 3, 0, 3, 0, 0, 0, 0, 0, 3]);
        let d = [record(HANDSHAKE, 0, 5, &m), record(CHANGE_CIPHER_SPEC, 0, 6, &[1])].concat();
        let rs = records(&d);
        assert_eq!(rs.len(), 2);
        assert_eq!((rs[0].ctype, rs[0].epoch, rs[0].seq), (HANDSHAKE, 0, 5));
        let hs = handshakes(&rs[0].fragment);
        assert_eq!(hs[0].0, CLIENT_HELLO);
        assert_eq!(hs[0].2, vec![1, 2, 3]);
        // A hello offers exactly the one suite and no compression.
        let h = client_hello(&[9; 32], &[0xaa, 0xbb]);
        assert_eq!(&h[..2], &DTLS12);
        assert_eq!(&h[34..38], &[0, 2, 0xaa, 0xbb]);
        assert_eq!(&h[38..], &[0, 2, 0x00, 0xa8, 1, 0]);
    }

    /// A toy AEAD for the in-memory handshake (not GCM): the tag binds key, nonce, additional data and plaintext, so a
    /// wrong key or a changed byte is refused just as GCM would refuse it. The real GCM is CNG's (govee/cipher.rs).
    struct Toy;
    impl Aead for Toy {
        fn seal(&self, key: &[u8; 16], nonce: &[u8; 12], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
            let pad = prf(key, b"pad", nonce, plaintext.len());
            let ct: Vec<u8> = plaintext.iter().zip(pad).map(|(a, b)| a ^ b).collect();
            let tag = hmac_sha256(key, &[&nonce[..], aad, &ct].concat());
            Ok([ct, tag[..16].to_vec()].concat())
        }
        fn open(&self, key: &[u8; 16], nonce: &[u8; 12], aad: &[u8], sealed: &[u8]) -> Option<Vec<u8>> {
            let (ct, tag) = sealed.split_at(sealed.len().checked_sub(16)?);
            (hmac_sha256(key, &[&nonce[..], aad, ct].concat())[..16] == *tag).then(|| ct.iter().zip(prf(key, b"pad", nonce, ct.len())).map(|(a, b)| a ^ b).collect())
        }
    }

    /// A bridge in memory: asks for a cookie, then answers as a PSK server would.
    struct Bridge {
        psk: Vec<u8>,
        out: std::collections::VecDeque<Vec<u8>>,
        transcript: Vec<u8>,
        client_random: [u8; 32],
        keys: Option<Keys>,
        master: Vec<u8>,
        pub app: Vec<Vec<u8>>,
        pub dropped_once: bool,
    }
    const SERVER_RANDOM: [u8; 32] = [0x5e; 32];
    impl Wire for &mut Bridge {
        fn send(&mut self, datagram: &[u8]) -> Result<(), String> {
            // The first copy of the key-exchange flight is lost: the client must send it again.
            let rs = records(datagram);
            if rs.iter().any(|r| r.ctype == CHANGE_CIPHER_SPEC) && !self.dropped_once {
                self.dropped_once = true;
                return Ok(());
            }
            for r in rs {
                match (r.ctype, r.epoch) {
                    (HANDSHAKE, 0) => {
                        for (t, m, body) in handshakes(&r.fragment) {
                            if t == CLIENT_HELLO {
                                let cookie_len = usize::from(body[35]);
                                if cookie_len == 0 {
                                    let hvr = handshake(HELLO_VERIFY_REQUEST, 0, &[0xfe, 0xfd, 4, 1, 2, 3, 4]);
                                    self.out.push_back(record(HANDSHAKE, 0, 0, &hvr));
                                } else {
                                    self.client_random.copy_from_slice(&body[2..34]);
                                    self.transcript = m.clone();
                                    let mut sh = DTLS12.to_vec();
                                    sh.extend_from_slice(&SERVER_RANDOM);
                                    sh.push(0);
                                    sh.extend_from_slice(&PSK_AES128_GCM_SHA256.to_be_bytes());
                                    sh.push(0);
                                    let sh = handshake(SERVER_HELLO, 1, &sh);
                                    let done = handshake(SERVER_HELLO_DONE, 2, &[]);
                                    self.transcript.extend_from_slice(&sh);
                                    self.transcript.extend_from_slice(&done);
                                    self.out.push_back([record(HANDSHAKE, 0, 1, &sh), record(HANDSHAKE, 0, 2, &done)].concat());
                                }
                            } else if t == CLIENT_KEY_EXCHANGE {
                                assert_eq!(&body[2..], b"onboard-user", "the identity is the bridge username");
                                self.transcript.extend_from_slice(&m);
                                self.master = master_secret(&self.psk, &self.client_random, &SERVER_RANDOM);
                                self.keys = Some(keys(&self.master, &self.client_random, &SERVER_RANDOM));
                            }
                        }
                    }
                    (HANDSHAKE, 1) => {
                        let k = self.keys.clone().unwrap();
                        let Some(plain) = open(&Toy, &k.client_key, &k.client_iv, &r) else {
                            // A wrong key: a real server answers with a fatal alert (bad_record_mac).
                            self.out.push_back(record(ALERT, 0, 4, &[2, 20]));
                            continue;
                        };
                        let (_, m, body) = handshakes(&plain).remove(0);
                        assert_eq!(body, finished(&self.master, b"client finished", &self.transcript));
                        self.transcript.extend_from_slice(&m);
                        let fin = handshake(FINISHED, 3, &finished(&self.master, b"server finished", &self.transcript));
                        let reply = [record(CHANGE_CIPHER_SPEC, 0, 3, &[1]), seal(&Toy, &k.server_key, &k.server_iv, HANDSHAKE, 1, 0, &fin).unwrap()].concat();
                        self.out.push_back(reply);
                    }
                    (APPLICATION_DATA, 1) => {
                        let k = self.keys.clone().unwrap();
                        self.app.push(open(&Toy, &k.client_key, &k.client_iv, &r).expect("stream data decrypts"));
                    }
                    _ => {}
                }
            }
            Ok(())
        }
        fn recv(&mut self, _timeout: Duration) -> Option<Vec<u8>> {
            self.out.pop_front()
        }
    }

    #[test]
    fn handshake_with_cookie_and_a_lost_flight_then_protected_data() {
        let mut bridge = Bridge { psk: vec![0x42; 16], out: Default::default(), transcript: Vec::new(), client_random: [0; 32], keys: None, master: Vec::new(), app: Vec::new(), dropped_once: false };
        {
            let mut s = Session::connect(&mut bridge, Toy, b"onboard-user", &[0x42; 16], [0x11; 32]).expect("the handshake completes");
            s.send(b"HueStream").unwrap();
            s.send(b"again").unwrap();
        }
        assert!(bridge.dropped_once, "the lost flight was sent again");
        assert_eq!(bridge.app, vec![b"HueStream".to_vec(), b"again".to_vec()]);
        // The wrong key: the bridge can't read the client's Finished and says so; the session never opens.
        let mut wrong = Bridge { psk: vec![0x43; 16], out: Default::default(), transcript: Vec::new(), client_random: [0; 32], keys: None, master: Vec::new(), app: Vec::new(), dropped_once: true };
        let e = Session::connect(&mut wrong, Toy, b"onboard-user", &[0x42; 16], [0x11; 32]).err().expect("a wrong key never completes");
        assert!(e.contains("wrong key"), "{e}");
    }
}
