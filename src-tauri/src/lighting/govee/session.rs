//! A Govee lamp session over any link (the GATT link in ble.rs, or the simulated lamp in the tests): which
//! encryption the lamp wants (PROTOCOL.md §10.3: the `2b12` marker says 2 → v2; otherwise probe `E7 01`, v1 if it
//! answers; otherwise plaintext), the handshake, and every 20-byte frame sealed and opened under the session's keys.

use std::time::{Duration, Instant};

use super::cipher::{device_key, gcm_open, gcm_seal, safe, K_COMM, K_HS};
use super::guard::{frame, xor, FRAME_LEN};

/// What a session needs from its link: write a value to `2b11`, wait for the next `2b10` notification, and the
/// version byte of the `2b12` marker when the lamp has one.
pub trait Link: Send + Sync {
    fn write(&self, bytes: &[u8]) -> Result<(), String>;
    fn recv(&self, timeout: Duration) -> Option<Vec<u8>>;
    fn version_marker(&self) -> Option<u8>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scheme {
    Plain,
    V1,
    V2,
}

impl Scheme {
    pub fn name(self) -> &'static str {
        match self {
            Self::Plain => "plaintext",
            Self::V1 => "encryption v1",
            Self::V2 => "encryption v2",
        }
    }
}

enum Keys {
    Plain,
    V1 { key: [u8; 16] },
    V2 { key: [u8; 16], host_iv: [u8; 8], dev_iv: [u8; 8], host_ctr: u32 },
}

pub struct Session<L: Link> {
    pub link: L,
    keys: Keys,
    pub scheme: Scheme,
    /// v2 only: the SKU the lamp names in its handshake (checked by the tests; the bridge goes by the advertised name).
    #[cfg_attr(not(test), allow(dead_code))]
    pub sku: Option<String>,
}

/// How long a v1 lamp takes to answer `E7 01` (29 ms measured; the probe gives it far more).
const PROBE_MS: u64 = 700;

fn valid(p: &[u8]) -> bool {
    p.len() == FRAME_LEN && xor(&p[..FRAME_LEN - 1]) == p[FRAME_LEN - 1]
}

impl<L: Link> Session<L> {
    /// Detects the scheme (or takes a cached one) and runs its handshake. `random` fills padding and nonces.
    pub fn start(link: L, cached: Option<Scheme>, mut random: impl FnMut() -> u8) -> Result<Self, String> {
        let marker = link.version_marker();
        if marker == Some(2) || cached == Some(Scheme::V2) {
            let (keys, sku) = v2_handshake(&link, &mut random)?;
            return Ok(Self { link, keys, scheme: Scheme::V2, sku: Some(sku) });
        }
        if cached != Some(Scheme::Plain) {
            if let Some(key) = v1_handshake(&link, &mut random)? {
                return Ok(Self { link, keys: Keys::V1 { key }, scheme: Scheme::V1, sku: None });
            }
            if cached == Some(Scheme::V1) {
                return Err("The lamp didn't answer its handshake. It may be out of range or connected to another phone.".into());
            }
        }
        Ok(Self { link, keys: Keys::Plain, scheme: Scheme::Plain, sku: None })
    }

    /// Seals a plaintext frame and writes it.
    pub fn send(&mut self, plain: &[u8; FRAME_LEN]) -> Result<(), String> {
        let wire = match &mut self.keys {
            Keys::Plain => plain.to_vec(),
            Keys::V1 { key } => safe(key, plain, false)?,
            Keys::V2 { key, host_iv, host_ctr, .. } => {
                let ctr = host_ctr.to_be_bytes();
                let mut nonce = [0u8; 12];
                nonce[..8].copy_from_slice(host_iv);
                nonce[8..].copy_from_slice(&ctr);
                let (c, tag) = gcm_seal(key, &nonce, &ctr, plain)?;
                *host_ctr = host_ctr.wrapping_add(1);
                [ctr.to_vec(), c, tag.to_vec()].concat()
            }
        };
        self.link.write(&wire)
    }

    /// Opens a notification into its plaintext frame (None: not a valid frame under this session's keys).
    pub fn open(&self, wire: &[u8]) -> Option<[u8; FRAME_LEN]> {
        let plain = match &self.keys {
            Keys::Plain => wire.to_vec(),
            Keys::V1 { key } => safe(key, wire, true).ok()?,
            Keys::V2 { key, dev_iv, .. } => {
                if wire.len() != 4 + FRAME_LEN + 16 {
                    return None;
                }
                let mut nonce = [0u8; 12];
                nonce[..8].copy_from_slice(dev_iv);
                nonce[8..].copy_from_slice(&wire[..4]);
                gcm_open(key, &nonce, &wire[..4], &wire[4..4 + FRAME_LEN], &wire[4 + FRAME_LEN..])?
            }
        };
        valid(&plain).then(|| plain.try_into().ok()).flatten()
    }

    /// The next valid frame from the lamp within `timeout` (the tests' reader; the bridge reads in its own thread).
    #[cfg(test)]
    pub fn recv(&self, timeout: Duration) -> Option<[u8; FRAME_LEN]> {
        let end = Instant::now() + timeout;
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            let wire = self.link.recv(left)?;
            if let Some(p) = self.open(&wire) {
                return Some(p);
            }
        }
        None
    }
}

fn random_frame(head: &[u8], random: &mut impl FnMut() -> u8) -> [u8; FRAME_LEN] {
    let mut bytes = [0u8; FRAME_LEN - 1];
    for b in bytes.iter_mut() {
        *b = random();
    }
    bytes[..head.len()].copy_from_slice(head);
    frame(&bytes)
}

/// v1: `E7 01` under K_COMM; a v1 lamp answers `E7 01` with the session key in [2..18]; then the `E7 02` confirm.
/// Ok(None) when the lamp stays silent (not a v1 lamp).
fn v1_handshake<L: Link>(link: &L, random: &mut impl FnMut() -> u8) -> Result<Option<[u8; 16]>, String> {
    link.write(&safe(&K_COMM, &random_frame(&[0xe7, 0x01], random), false)?)?;
    let end = Instant::now() + Duration::from_millis(PROBE_MS);
    let mut key = None;
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        let Some(wire) = link.recv(left) else { break };
        let p = safe(&K_COMM, &wire, true)?;
        if valid(&p) && p[0] == 0xe7 && p[1] == 0x01 {
            let mut k = [0u8; 16];
            k.copy_from_slice(&p[2..18]);
            key = Some(k);
            break;
        }
    }
    let Some(key) = key else { return Ok(None) };
    // The confirm round: not load-bearing, but the app always sends it. Its answer is read and dropped.
    link.write(&safe(&K_COMM, &random_frame(&[0xe7, 0x02], random), false)?)?;
    let _ = link.recv(Duration::from_millis(400));
    Ok(Some(key))
}

/// v2: `E7 11 01 ‖ IV(12) ‖ tagLen` + GCM(K_HS, IV, aad = those 16 bytes, client ivKey(8)); the lamp answers
/// `E7 11 status ‖ IV(12)` + GCM(K_HS, IV, aad = those 15 bytes, device ivKey(8) ‖ SKU(5) ‖ MAC(6)).
fn v2_handshake<L: Link>(link: &L, random: &mut impl FnMut() -> u8) -> Result<(Keys, String), String> {
    let mut iv = [0u8; 12];
    iv.iter_mut().for_each(|b| *b = random());
    let mut host_iv = [0u8; 8];
    host_iv.iter_mut().for_each(|b| *b = random());
    let mut head = vec![0xe7, 0x11, 0x01];
    head.extend_from_slice(&iv);
    head.push(16);
    let (c, tag) = gcm_seal(&K_HS, &iv, &head, &host_iv)?;
    link.write(&[head, c, tag.to_vec()].concat())?;
    let end = Instant::now() + Duration::from_millis(1500);
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        let Some(r) = link.recv(left) else { break };
        if r.len() != 15 + 19 + 16 || r[0] != 0xe7 || r[1] != 0x11 {
            continue;
        }
        if r[2] != 0 {
            return Err(format!("The lamp refused the key exchange (status {}).", r[2]));
        }
        let rv: [u8; 12] = r[3..15].try_into().map_err(|_| "short reply")?;
        let p = gcm_open(&K_HS, &rv, &r[..15], &r[15..34], &r[34..]).ok_or("The lamp's key-exchange reply didn't check out.")?;
        let dev_iv: [u8; 8] = p[..8].try_into().map_err(|_| "short reply")?;
        let sku: [u8; 5] = p[8..13].try_into().map_err(|_| "short reply")?;
        let mac: [u8; 6] = p[13..19].try_into().map_err(|_| "short reply")?;
        let key = device_key(&sku, &mac)?;
        return Ok((Keys::V2 { key, host_iv, dev_iv, host_ctr: 2 }, String::from_utf8_lossy(&sku).to_string()));
    }
    Err("The lamp didn't answer its key exchange.".into())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::sync::Mutex;

    /// A simulated Govee lamp behind an in-memory link: it speaks plaintext, v1 or v2 as told, answers the
    /// handshakes, queries and commands like the real one, and records every plaintext frame it accepted.
    pub struct SimLamp {
        pub scheme: Scheme,
        pub accepted: Mutex<Vec<[u8; FRAME_LEN]>>,
        tx: Mutex<Sender<Vec<u8>>>,
        rx: Mutex<Receiver<Vec<u8>>>,
        keys: Mutex<Option<Keys>>,
        dev_ctr: Mutex<u32>,
        pub power: Mutex<bool>,
    }

    const SESSION: [u8; 16] = *b"0123456789abcdef";
    const SKU: [u8; 5] = *b"H6076";
    const MAC: [u8; 6] = [0x0c, 0x34, 0x46, 0x80, 0x50, 0xd6];
    const DEV_IV: [u8; 8] = [9, 8, 7, 6, 5, 4, 3, 2];

    impl SimLamp {
        pub fn new(scheme: Scheme) -> Self {
            let (tx, rx) = channel();
            Self { scheme, accepted: Mutex::default(), tx: Mutex::new(tx), rx: Mutex::new(rx), keys: Mutex::new(None), dev_ctr: Mutex::new(1), power: Mutex::new(true) }
        }
        fn notify(&self, plain: [u8; FRAME_LEN]) {
            let wire = match &*self.keys.lock().unwrap() {
                None | Some(Keys::Plain) => plain.to_vec(),
                Some(Keys::V1 { key }) => safe(key, &plain, false).unwrap(),
                Some(Keys::V2 { key, .. }) => {
                    let mut ctr = self.dev_ctr.lock().unwrap();
                    let c = ctr.to_be_bytes();
                    *ctr += 1;
                    let mut nonce = [0u8; 12];
                    nonce[..8].copy_from_slice(&DEV_IV);
                    nonce[8..].copy_from_slice(&c);
                    let (ct, tag) = gcm_seal(key, &nonce, &c, &plain).unwrap();
                    [c.to_vec(), ct, tag.to_vec()].concat()
                }
            };
            self.tx.lock().unwrap().send(wire).unwrap();
        }
        fn command(&self, p: [u8; FRAME_LEN]) {
            self.accepted.lock().unwrap().push(p);
            match (p[0], p[1]) {
                (0xaa, 0x01) => self.notify(frame(&[0xaa, 0x01, u8::from(*self.power.lock().unwrap())])),
                (0xaa, 0x06) => self.notify(frame(&[0xaa, 0x06, b'1', b'.', b'0', b'4', b'.', b'0', b'5'])),
                (0x33, 0x01) => {
                    *self.power.lock().unwrap() = p[2] == 1;
                    self.notify(frame(&[0x33, 0x01, 0x00]));
                    self.notify(frame(&[0xee, 0x30, 0x01, p[2]]));
                }
                (0x33, c) => self.notify(frame(&[0x33, c])),
                _ => {}
            }
        }
    }

    impl SimLamp {
        /// The plaintext of a written frame under the lamp's current keys (None: a handshake or an ignored frame).
        fn unseal(&self, wire: &[u8]) -> Result<Option<[u8; FRAME_LEN]>, String> {
            let keys = self.keys.lock().unwrap();
            let plain = match (self.scheme, &*keys) {
                (Scheme::Plain, _) => Some(wire.to_vec()),
                (Scheme::V1, Some(Keys::V1 { key })) => Some(safe(key, wire, true)?),
                (Scheme::V2, Some(Keys::V2 { key, host_iv, .. })) if wire.len() == 40 => {
                    let mut nonce = [0u8; 12];
                    nonce[..8].copy_from_slice(host_iv);
                    nonce[8..].copy_from_slice(&wire[..4]);
                    gcm_open(key, &nonce, &wire[..4], &wire[4..24], &wire[24..])
                }
                // Plaintext, or anything before the handshake: acknowledged and ignored, as the real lamp does.
                _ => None,
            };
            Ok(plain.and_then(|p| <[u8; FRAME_LEN]>::try_from(p.as_slice()).ok()).filter(|p| valid(p)))
        }

        /// Answers a handshake frame; true when `wire` was one.
        fn handshake(&self, wire: &[u8]) -> Result<bool, String> {
            if self.scheme == Scheme::V1 {
                let p = safe(&K_COMM, wire, true)?;
                if !(valid(&p) && p[0] == 0xe7) {
                    return Ok(false);
                }
                let reply = if p[1] == 0x01 {
                    let mut r = [0u8; 19];
                    r[..2].copy_from_slice(&[0xe7, 0x01]);
                    r[2..18].copy_from_slice(&SESSION);
                    frame(&r)
                } else {
                    *self.keys.lock().unwrap() = Some(Keys::V1 { key: SESSION });
                    frame(&[0xe7, 0x02])
                };
                self.tx.lock().unwrap().send(safe(&K_COMM, &reply, false)?).unwrap();
                return Ok(true);
            }
            if self.scheme == Scheme::V2 && wire.len() == 40 && wire[0] == 0xe7 && wire[1] == 0x11 {
                let iv: [u8; 12] = wire[3..15].try_into().unwrap();
                let host_iv = gcm_open(&K_HS, &iv, &wire[..16], &wire[16..24], &wire[24..]).ok_or("bad handshake")?;
                let key = device_key(&SKU, &MAC)?;
                let mut head = vec![0xe7, 0x11, 0x00];
                head.extend_from_slice(&iv);
                let (c, tag) = gcm_seal(&K_HS, &iv, &head, &[DEV_IV.to_vec(), SKU.to_vec(), MAC.to_vec()].concat())?;
                *self.keys.lock().unwrap() = Some(Keys::V2 { key, host_iv: host_iv.try_into().unwrap(), dev_iv: DEV_IV, host_ctr: 2 });
                self.tx.lock().unwrap().send([head, c, tag.to_vec()].concat()).unwrap();
                return Ok(true);
            }
            Ok(false)
        }
    }

    impl Link for SimLamp {
        fn write(&self, wire: &[u8]) -> Result<(), String> {
            if self.handshake(wire)? {
                return Ok(());
            }
            if let Some(p) = self.unseal(wire)? {
                self.command(p);
            }
            Ok(())
        }
        fn recv(&self, timeout: Duration) -> Option<Vec<u8>> {
            self.rx.lock().unwrap().recv_timeout(timeout).ok()
        }
        fn version_marker(&self) -> Option<u8> {
            (self.scheme == Scheme::V2).then_some(2)
        }
    }

    fn counter() -> impl FnMut() -> u8 {
        let mut n = 0u8;
        move || {
            n = n.wrapping_add(37);
            n
        }
    }

    #[test]
    fn each_scheme_is_detected_and_carries_commands() {
        for scheme in [Scheme::V1, Scheme::V2, Scheme::Plain] {
            let mut s = Session::start(SimLamp::new(scheme), None, counter()).unwrap();
            assert_eq!(s.scheme, scheme);
            s.send(&frame(&[0x33, 0x01, 0x00])).unwrap();
            let ack = s.recv(Duration::from_millis(200)).unwrap();
            assert_eq!(&ack[..3], &[0x33, 0x01, 0x00]);
            let event = s.recv(Duration::from_millis(200)).unwrap();
            assert_eq!(&event[..4], &[0xee, 0x30, 0x01, 0x00], "{scheme:?}");
            s.send(&frame(&[0xaa, 0x01])).unwrap();
            assert_eq!(s.recv(Duration::from_millis(200)).unwrap()[..3], [0xaa, 0x01, 0x00]);
            assert_eq!(*s.link.power.lock().unwrap(), false);
            if scheme == Scheme::V2 {
                assert_eq!(s.sku.as_deref(), Some("H6076"));
            }
        }
    }

    /// A link that notes every value written (`>`) and every notification read (`<`), in order.
    struct Recorded {
        lamp: SimLamp,
        log: Mutex<Vec<String>>,
    }

    impl Link for Recorded {
        fn write(&self, bytes: &[u8]) -> Result<(), String> {
            self.log.lock().unwrap().push(format!("> {}", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()));
            self.lamp.write(bytes)
        }
        fn recv(&self, timeout: Duration) -> Option<Vec<u8>> {
            let got = self.lamp.recv(timeout);
            if let Some(w) = &got {
                self.log.lock().unwrap().push(format!("< {}", w.iter().map(|b| format!("{b:02x}")).collect::<String>()));
            }
            got
        }
        fn version_marker(&self) -> Option<u8> {
            self.lamp.version_marker()
        }
    }

    /// Each scheme's whole conversation with the simulated lamp, as `<scheme> > <hex>` (written) and
    /// `<scheme> < <hex>` (heard) lines: the handshake (padding and nonces from `counter`), then power off, a power
    /// query, a brightness, a colour on every segment and power on.
    fn wire_text() -> String {
        let mut out = Vec::new();
        for (name, scheme) in [("v1", Scheme::V1), ("v2", Scheme::V2), ("plain", Scheme::Plain)] {
            let mut s = Session::start(Recorded { lamp: SimLamp::new(scheme), log: Mutex::default() }, None, counter()).unwrap();
            assert_eq!(s.scheme, scheme);
            let script: [(&[u8], usize); 5] = [
                (&[0x33, 0x01, 0x00], 2),
                (&[0xaa, 0x01], 1),
                (&[0x33, 0x04, 0x23], 1),
                (&[0x33, 0x05, 0x15, 0x01, 0xff, 0x00, 0x2a, 0, 0, 0, 0, 0, 0xff, 0x3f], 1),
                (&[0x33, 0x01, 0x01], 2),
            ];
            for (bytes, replies) in script {
                s.send(&frame(bytes)).unwrap();
                for _ in 0..replies {
                    s.recv(Duration::from_millis(200)).unwrap();
                }
            }
            out.extend(s.link.log.lock().unwrap().iter().map(|l| format!("{name} {l}")));
        }
        out.join("\n") + "\n"
    }

    /// The website's session (src/lib/lighting/web/session.ts) against its copy of this lamp must write and hear these
    /// bytes exactly (scripts/web-govee.test.ts reads session-wire.txt); this holds the bridge to the same file. After a
    /// deliberate change, rewrite it with `GOVEE_VECTORS=write cargo test --lib website_session` and run both.
    #[test]
    fn the_website_session_wire_is_the_bridges() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/lighting/govee/session-wire.txt");
        let text = wire_text();
        if std::env::var("GOVEE_VECTORS").as_deref() == Ok("write") {
            std::fs::write(path, &text).unwrap();
        }
        let kept = std::fs::read_to_string(path).unwrap_or_default().replace("\r\n", "\n");
        assert!(kept == text, "session-wire.txt is out of date: GOVEE_VECTORS=write cargo test --lib website_session");
    }

    #[test]
    fn a_cached_scheme_skips_the_probe_and_a_silent_v1_lamp_fails_plainly() {
        // Cached plaintext: no E7 probe goes out.
        let s = Session::start(SimLamp::new(Scheme::Plain), Some(Scheme::Plain), counter()).unwrap();
        assert_eq!(s.scheme, Scheme::Plain);
        assert!(s.link.accepted.lock().unwrap().is_empty());
        // A lamp cached as v1 that stays silent: an error, never a fall-back to plaintext it would ignore.
        let err = Session::start(SimLamp::new(Scheme::Plain), Some(Scheme::V1), counter()).err().unwrap();
        assert!(err.contains("handshake"));
    }
}
