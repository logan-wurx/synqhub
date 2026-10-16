//! Govee lamps over Bluetooth LE (wave L1), with no Govee app, account or cloud: discovery from advertisements, a
//! connection only while the lamp's page is open (closed on blur, with the bridge's own backstop) or while the person's
//! screen sync runs, the encryption the lamp wants, a keep-alive while connected (an idle link drops in under 15 s),
//! and only the frames `guard` allows. docs/devices/LIGHTING.md has the protocol facts, the sources and what still
//! needs the developer.

// The guard and the scene tables are used by the Windows bridge; elsewhere only their tests (the fixture parity) build.
#[cfg(any(windows, test))]
pub mod guard;
#[cfg(any(windows, test))]
pub mod catalogue;
#[cfg(any(windows, test))]
pub mod stream;

#[cfg(windows)]
mod ble;
#[cfg(windows)]
pub(crate) mod cipher;
#[cfg(windows)]
mod session;

use serde::Serialize;

/// A lamp the scan heard.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lamp {
    /// The Bluetooth address, 12 hex digits.
    pub id: String,
    /// The advertised name (`Govee_H6076_7A21`).
    pub name: String,
    /// The model from the name (`H6076`).
    pub sku: String,
    pub rssi: i16,
    /// Milliseconds since it was last heard.
    pub heard_ms: u64,
    /// Screen sync is running on it (the Devices home shows it, with a way to stop it).
    pub sync: Option<SyncInfo>,
}

/// A running screen sync.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncInfo {
    pub edge: crate::lighting::screen::Edge,
    pub vivid: bool,
    /// The monitor read (its id from `screen::monitors`); None: the primary.
    pub monitor: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    /// "encryption v1", "encryption v2" or "plaintext".
    pub scheme: &'static str,
    /// The lamp was already open for a screen sync that is still running.
    pub sync: Option<SyncInfo>,
}

/// What an open lamp sends: a decrypted 20-byte frame, the link dropping, and screen sync's colours and its end.
#[cfg_attr(not(windows), allow(dead_code))]
pub enum Event {
    Report { id: String, frame: Vec<u8> },
    Lost { id: String, why: String },
    /// The colours sync sent (or holds: `blind` when the screen can't be seen and the last colours are kept).
    Sync { id: String, colours: Vec<[u8; 3]>, blind: bool },
    SyncStopped { id: String, why: String },
}

pub type Emit = std::sync::Arc<dyn Fn(Event) + Send + Sync>;

/// Whether SYNQ drives the model in this advertised name (catalogue.rs `MODELS`, from
/// scripts/lighting/govee/models.json): another Govee device the scan hears (a thermometer, a model not in the table)
/// is neither listed nor opened.
#[cfg(any(windows, test))]
pub fn supported(name: &str) -> bool {
    guard::model(&sku_of(name)).is_some()
}

/// The SKU in an advertised name: `Govee_H6076_7A21` -> `H6076`.
#[cfg(any(windows, test))]
pub fn sku_of(name: &str) -> String {
    name.split('_').find(|p| p.len() >= 4 && p.starts_with('H') && p[1..].chars().all(|c| c.is_ascii_alphanumeric())).unwrap_or("").to_string()
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_id(id: &str) -> Result<u64, String> {
    let hex: String = id.chars().filter(|c| *c != ':').collect();
    if hex.len() != 12 {
        return Err("Not a Bluetooth address.".into());
    }
    u64::from_str_radix(&hex, 16).map_err(|_| "Not a Bluetooth address.".to_string())
}

#[cfg(windows)]
pub use imp::{close, close_all, list, open, send, sync_start, sync_stop, upload};

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use super::ble::{self, GattLink};
    use super::catalogue::Model;
    use super::guard::{a3_frames, check_frame, check_upload, frame, model, UploadKind, FRAME_LEN, TYPED};
    use super::session::{Link, Scheme, Session};
    use super::stream::{changed_pages, gradual_off, page_frame};
    use crate::lighting::screen::{FAST, SLOW, STILL_AFTER};
    use super::{parse_id, sku_of, supported, Emit, Event, Lamp, Opened, SyncInfo};
    use crate::lighting::screen::{self, Edge, Sampler};

    /// Traffic keeps the link alive: a power query when nothing went out for this long.
    const KEEP_ALIVE: Duration = Duration::from_secs(5);
    /// Room between two frames, and between the frames of an upload (the app paces scene uploads at 100 ms).
    const GAP: Duration = Duration::from_millis(25);
    const UPLOAD_GAP: Duration = Duration::from_millis(100);

    #[derive(Clone)]
    struct Open {
        /// The model, from the advertised name: the guard judges every frame against it.
        model: &'static Model,
        session: Arc<Mutex<Session<GattLink>>>,
        stop: Arc<AtomicBool>,
        last_write: Arc<Mutex<Instant>>,
        uploads: Arc<Mutex<Option<Sender<[u8; FRAME_LEN]>>>>,
        /// The lamp's page has it open (a running sync can keep it open without its page).
        page: Arc<AtomicBool>,
        sync: Arc<Mutex<Option<Syncing>>>,
    }

    #[derive(Clone)]
    struct Syncing {
        info: SyncInfo,
        stop: Arc<AtomicBool>,
    }

    fn sync_info(o: &Open) -> Option<SyncInfo> {
        o.sync.lock().ok().and_then(|s| s.as_ref().map(|s| s.info.clone()))
    }

    fn open_map() -> &'static Mutex<HashMap<String, Open>> {
        static OPEN: OnceLock<Mutex<HashMap<String, Open>>> = OnceLock::new();
        OPEN.get_or_init(Mutex::default)
    }

    /// The scheme each lamp answered with (a property of its firmware, so it is kept for the app's lifetime).
    fn schemes() -> &'static Mutex<HashMap<String, Scheme>> {
        static SCHEMES: OnceLock<Mutex<HashMap<String, Scheme>>> = OnceLock::new();
        SCHEMES.get_or_init(Mutex::default)
    }

    fn id_of(address: u64) -> String {
        format!("{address:012x}")
    }

    fn lamp_of(h: ble::Heard) -> Lamp {
        Lamp { id: id_of(h.address), sku: sku_of(&h.name), name: h.name, rssi: h.rssi, heard_ms: h.at.elapsed().as_millis() as u64, sync: None }
    }

    pub fn list() -> Vec<Lamp> {
        let mut out: Vec<Lamp> = ble::heard().into_iter().map(lamp_of).collect();
        // A connected lamp stops advertising: it stays listed while it is open (its page, or a running sync).
        let open: Vec<(String, Option<SyncInfo>)> = open_map().lock().map(|m| m.iter().map(|(id, o)| (id.clone(), sync_info(o))).collect()).unwrap_or_default();
        for (id, sync) in open {
            if !out.iter().any(|l| l.id == id) {
                out.extend(parse_id(&id).ok().and_then(ble::last_heard).map(lamp_of));
            }
            if let Some(l) = out.iter_mut().find(|l| l.id == id) {
                l.sync = sync;
            }
        }
        out.retain(|l| supported(&l.name));
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// A small random source for padding and nonces, seeded from the clock (nothing here needs to be secret).
    fn random() -> impl FnMut() -> u8 {
        let clock = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1);
        let mut x = clock ^ (u64::from(std::process::id()) << 32) ^ 0x9e37_79b9_7f4a_7c15;
        move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        }
    }

    fn write(o: &Open, f: &[u8; FRAME_LEN]) -> Result<(), String> {
        let mut s = o.session.lock().map_err(|_| "lamp state poisoned")?;
        s.send(f)?;
        *o.last_write.lock().map_err(|_| "lamp state poisoned")? = Instant::now();
        Ok(())
    }

    /// Connects, finds the encryption the lamp wants and runs its handshake, then reads its reports and keeps the link
    /// alive until `close`. Reports and a lost link go to `emit`.
    pub fn open(id: &str, emit: Emit) -> Result<Opened, String> {
        if let Some(o) = open_map().lock().map_err(|_| "lamp state poisoned")?.get(id) {
            o.page.store(true, Ordering::SeqCst);
            return Ok(Opened { scheme: o.session.lock().map_err(|_| "lamp state poisoned")?.scheme.name(), sync: sync_info(o) });
        }
        let address = parse_id(id)?;
        let heard = ble::last_heard(address).ok_or("SYNQ hasn't heard this lamp yet. Give it a moment, then try again.")?;
        let Some(model) = model(&sku_of(&heard.name)) else {
            return Err(format!("SYNQ doesn't drive the Govee {} yet.", sku_of(&heard.name)));
        };
        let link = GattLink::connect(address)?;
        let cached = schemes().lock().ok().and_then(|m| m.get(id).copied());
        let session = Session::start(link, cached, random())?;
        let scheme = session.scheme;
        if let Ok(mut m) = schemes().lock() {
            m.insert(id.to_string(), scheme);
        }
        let o = Open {
            model,
            session: Arc::new(Mutex::new(session)),
            stop: Arc::default(),
            last_write: Arc::new(Mutex::new(Instant::now())),
            uploads: Arc::default(),
            page: Arc::new(AtomicBool::new(true)),
            sync: Arc::default(),
        };
        // Reports: decrypted and passed on; upload acknowledgements also go to a waiting upload.
        {
            let (session, stop, uploads, emit, id) = (o.session.clone(), o.stop.clone(), o.uploads.clone(), emit.clone(), id.to_string());
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    let wire = session.lock().ok().and_then(|s| s.link.recv(Duration::ZERO));
                    let Some(wire) = wire else {
                        std::thread::sleep(Duration::from_millis(15));
                        continue;
                    };
                    let Some(plain) = session.lock().ok().and_then(|s| s.open(&wire)) else { continue };
                    if plain[0] == 0xa3 {
                        if let Some(tx) = uploads.lock().ok().and_then(|u| u.clone()) {
                            let _ = tx.send(plain);
                        }
                    }
                    emit(Event::Report { id: id.clone(), frame: plain.to_vec() });
                }
            });
        }
        // Keep-alive: a power query whenever nothing else went out for a few seconds.
        {
            let (session, stop, last_write, emit, id) = (o.session.clone(), o.stop.clone(), o.last_write.clone(), emit, id.to_string());
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(500));
                    let idle = last_write.lock().map(|t| t.elapsed() >= KEEP_ALIVE).unwrap_or(false);
                    if !idle || stop.load(Ordering::SeqCst) {
                        continue;
                    }
                    let sent = session.lock().map_err(|_| "lamp state poisoned".to_string()).and_then(|mut s| s.send(&frame(&[0xaa, 0x01])));
                    match sent {
                        Ok(()) => {
                            if let Ok(mut t) = last_write.lock() {
                                *t = Instant::now();
                            }
                        }
                        Err(why) => {
                            stop.store(true, Ordering::SeqCst);
                            if let Ok(mut m) = open_map().lock() {
                                m.remove(&id);
                            }
                            emit(Event::Lost { id, why });
                            return;
                        }
                    }
                }
            });
        }
        open_map().lock().map_err(|_| "lamp state poisoned")?.insert(id.to_string(), o);
        Ok(Opened { scheme: scheme.name(), sync: None })
    }

    fn with_open<T>(id: &str, f: impl FnOnce(&Open) -> Result<T, String>) -> Result<T, String> {
        let o = open_map().lock().map_err(|_| "lamp state poisoned")?.get(id).cloned().ok_or("The lamp isn't open.")?;
        f(&o)
    }

    /// Single frames, each checked by the guard first, a little apart.
    pub fn send(id: &str, frames: &[Vec<u8>]) -> Result<(), String> {
        let m = with_open(id, |o| Ok(o.model))?;
        for (i, f) in frames.iter().enumerate() {
            check_frame(m, f)?;
            let f: [u8; FRAME_LEN] = f.as_slice().try_into().map_err(|_| "frames are 20 bytes")?;
            if i > 0 {
                std::thread::sleep(GAP);
            }
            with_open(id, |o| write(o, &f))?;
        }
        Ok(())
    }

    /// A checked upload, framed here and paced like the app; true when the lamp acknowledged it.
    /// `code`: the scene the data is for (a scene upload must be that scene's own data).
    pub fn upload(id: &str, kind: &str, body: &[u8], code: Option<u16>) -> Result<bool, String> {
        let kind = UploadKind::parse(kind).ok_or("Unknown upload.")?;
        check_upload(with_open(id, |o| Ok(o.model))?, kind, body, code)?;
        let (tx, rx) = channel();
        with_open(id, |o| {
            *o.uploads.lock().map_err(|_| "lamp state poisoned")? = Some(tx);
            Ok(())
        })?;
        let result = (|| {
            for f in a3_frames(kind, body) {
                with_open(id, |o| write(o, &f))?;
                std::thread::sleep(UPLOAD_GAP);
            }
            // The acknowledgement: a3 <type> <result>, result 0 = taken.
            let end = Instant::now() + Duration::from_millis(1500);
            while let Some(left) = end.checked_duration_since(Instant::now()) {
                match rx.recv_timeout(left) {
                    Ok(ack) if ack[1] == kind.type_byte() => return if ack[2] == 0 { Ok(true) } else { Err(format!("The lamp refused the data (code {}).", ack[2])) },
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            Ok(false)
        })();
        let _ = with_open(id, |o| {
            *o.uploads.lock().map_err(|_| "lamp state poisoned")? = None;
            Ok(())
        });
        result
    }

    /// The lamp's page lets go of it. A lamp whose screen sync runs stays open for the sync (until it stops).
    pub fn close(id: &str) {
        let removed = open_map().lock().ok().and_then(|mut m| {
            let o = m.get(id)?;
            o.page.store(false, Ordering::SeqCst);
            if sync_info(o).is_some() {
                return None;
            }
            m.remove(id)
        });
        if let Some(o) = removed {
            o.stop.store(true, Ordering::SeqCst);
        }
    }

    /// The backstop when the window loses focus: every open lamp is let go, except one whose screen sync runs (the
    /// person started it to run in the background). Returns the ids let go.
    pub fn close_all() -> Vec<String> {
        let ids: Vec<String> = open_map().lock().map(|m| m.iter().filter(|(_, o)| sync_info(o).is_none()).map(|(id, _)| id.clone()).collect()).unwrap_or_default();
        for id in &ids {
            close(id);
        }
        ids
    }

    /// One frame of screen sync, tried again once after a moment if the lamp didn't take it.
    fn sync_write(o: &Open, f: &[u8; FRAME_LEN]) -> Result<(), String> {
        check_frame(o.model, f)?;
        write(o, f).or_else(|_| {
            std::thread::sleep(Duration::from_millis(500));
            write(o, f)
        })
    }

    /// Starts screen sync on an open lamp: the bridge samples the screen (src/lighting/screen.rs) and sends the
    /// segment pages that moved, until `sync_stop`, the lamp dropping, the screen locking, the PC sleeping or the
    /// displays changing. It keeps the lamp open without its page; the page and the Devices home show it running.
    pub fn sync_start(id: &str, edge: &str, vivid: bool, monitor: Option<String>, emit: Emit) -> Result<SyncInfo, String> {
        let edge = Edge::parse(edge).ok_or("Unknown part of the screen.")?;
        let o = open_map().lock().map_err(|_| "lamp state poisoned")?.get(id).cloned().ok_or("The lamp isn't open.")?;
        if !o.model.dialects.contains(&TYPED) || o.model.segments == 0 {
            return Err("Screen sync needs a light with known segments that takes the 0x15 colour pages.".into());
        }
        sync_stop(id);
        let info = SyncInfo { edge, vivid, monitor };
        let stop = Arc::new(AtomicBool::new(false));
        *o.sync.lock().map_err(|_| "lamp state poisoned")? = Some(Syncing { info: info.clone(), stop: stop.clone() });
        let (id, monitor) = (id.to_string(), info.monitor.clone());
        std::thread::spawn(move || {
            let why = run_sync(&o, edge, vivid, monitor.as_deref(), &stop, &emit, &id);
            let ours = o.sync.lock().map(|mut s| match s.as_ref() {
                Some(cur) if Arc::ptr_eq(&cur.stop, &stop) => {
                    *s = None;
                    true
                }
                _ => false,
            });
            if ours.unwrap_or(false) {
                // Without its page, the lamp was open only for the sync.
                if !o.page.load(Ordering::SeqCst) {
                    close(&id);
                }
                emit(Event::SyncStopped { id, why });
            }
        });
        Ok(info)
    }

    pub fn sync_stop(id: &str) {
        if let Some(o) = open_map().lock().ok().and_then(|m| m.get(id).cloned()) {
            if let Some(s) = o.sync.lock().ok().and_then(|s| s.clone()) {
                s.stop.store(true, Ordering::SeqCst);
            }
        }
    }

    /// The sync loop; returns why it ended.
    fn run_sync(o: &Open, edge: Edge, vivid: bool, monitor: Option<&str>, stop: &AtomicBool, emit: &Emit, id: &str) -> String {
        let mut sampler = match Sampler::new(edge, usize::from(o.model.segments), monitor) {
            Ok(s) => s,
            Err(why) => return why,
        };
        let displays = screen::display_signature();
        if let Err(why) = sync_write(o, &gradual_off()) {
            return format!("The lamp stopped answering ({why}).");
        }
        let (mut shown, mut sent): (Vec<[u8; 3]>, Vec<[u8; 3]>) = (Vec::new(), Vec::new());
        let (mut blind_since, mut held) = (None::<Instant>, false);
        let mut moved = Instant::now();
        let mut clock = std::time::SystemTime::now();
        loop {
            let tick = Instant::now();
            if stop.load(Ordering::SeqCst) {
                return "Stopped.".into();
            }
            if o.stop.load(Ordering::SeqCst) {
                return "The lamp stopped answering.".into();
            }
            // The wall clock jumping ahead of the loop's own pace: the PC slept or hibernated.
            let now = std::time::SystemTime::now();
            if now.duration_since(clock).map(|d| d > Duration::from_secs(5)).unwrap_or(false) {
                return "The PC went to sleep.".into();
            }
            clock = now;
            if screen::secure_desktop() {
                return "The screen locked.".into();
            }
            if screen::display_signature() != displays {
                return "The displays changed.".into();
            }
            match sampler.sample() {
                Ok(c) if !screen::blind(&c) => {
                    blind_since = None;
                    shown = screen::smooth(&shown, &c, vivid);
                    let pages = changed_pages(&sent, &shown);
                    if !pages.is_empty() || held {
                        moved = Instant::now();
                    }
                    for p in &pages {
                        if let Err(why) = sync_write(o, &page_frame(*p, &shown)) {
                            return format!("The lamp stopped answering ({why}).");
                        }
                        let from = (*p as usize - 1) * 4;
                        sent.resize(shown.len().max(sent.len()), [0; 3]);
                        let to = (from + 4).min(shown.len());
                        sent[from..to].copy_from_slice(&shown[from..to]);
                        std::thread::sleep(GAP);
                    }
                    if !pages.is_empty() || held {
                        held = false;
                        emit(Event::Sync { id: id.to_string(), colours: shown.clone(), blind: false });
                    }
                }
                // Black (a protected or exclusive-fullscreen window) or a failed grab: the last colours stay, and
                // after a second the page says so. Black is never sent.
                _ => {
                    let since = *blind_since.get_or_insert_with(Instant::now);
                    if !held && since.elapsed() > Duration::from_secs(1) {
                        held = true;
                        emit(Event::Sync { id: id.to_string(), colours: shown.clone(), blind: true });
                    }
                }
            }
            let pace = if moved.elapsed() > STILL_AFTER { SLOW } else { FAST };
            std::thread::sleep(pace.saturating_sub(tick.elapsed()));
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{Emit, Lamp, Opened, SyncInfo};
    const UNAVAILABLE: &str = "Govee lamps are reached over Bluetooth by the Windows app for now.";
    pub fn list() -> Vec<Lamp> {
        Vec::new()
    }
    pub fn open(_id: &str, _emit: Emit) -> Result<Opened, String> {
        Err(UNAVAILABLE.into())
    }
    pub fn send(_id: &str, _frames: &[Vec<u8>]) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
    pub fn upload(_id: &str, _kind: &str, _body: &[u8], _code: Option<u16>) -> Result<bool, String> {
        Err(UNAVAILABLE.into())
    }
    pub fn close(_id: &str) {}
    pub fn close_all() -> Vec<String> {
        Vec::new()
    }
    pub fn sync_start(_id: &str, _edge: &str, _vivid: bool, _monitor: Option<String>, _emit: Emit) -> Result<SyncInfo, String> {
        Err(UNAVAILABLE.into())
    }
    pub fn sync_stop(_id: &str) {}
}

#[cfg(not(windows))]
pub use imp::{close, close_all, list, open, send, sync_start, sync_stop, upload};

#[cfg(test)]
mod tests {
    use super::*;

    /// One screen-sync cycle as the bridge runs it, everything but the radio write: sample the screen, ease the
    /// colours, pick the moved pages, build, check and encrypt (v1) their frames. Every round moves every page, so all
    /// four are sent (the most a cycle sends). Timed in this thread's CPU cycles; run by hand on a desktop:
    /// `cargo test --lib sync_cycle_cost -- --ignored --nocapture` (docs/performance.md has the figures).
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn sync_cycle_cost() {
        use crate::lighting::screen::{smooth, Edge, Sampler};
        use windows::Win32::System::{Threading::GetCurrentThread, WindowsProgramming::QueryThreadCycleTime};
        let cycles = || {
            let mut c = 0u64;
            unsafe { QueryThreadCycleTime(GetCurrentThread(), &mut c).unwrap() };
            c
        };
        let (c0, t0) = (cycles(), std::time::Instant::now());
        while t0.elapsed().as_millis() < 200 {
            std::hint::black_box(0);
        }
        let per_us = (cycles() - c0) as f64 / t0.elapsed().as_micros() as f64;
        let key = *b"MakingLifeSmarte";
        for edge in [Edge::Left, Edge::Both, Edge::Full] {
            let mut sampler = Sampler::new(edge, 14, None).unwrap();
            let (mut shown, rounds) = (Vec::new(), 120u32);
            let mut frames = 0;
            let c0 = cycles();
            for r in 0..rounds {
                shown = smooth(&shown, &sampler.sample().unwrap(), true);
                // Force every page to move (the worst case).
                let moved: Vec<[u8; 3]> = shown.iter().map(|c| [c[0] ^ (r as u8).wrapping_mul(40), c[1], c[2]]).collect();
                for p in stream::changed_pages(&[], &moved) {
                    let f = stream::page_frame(p, &moved);
                    guard::check_frame(guard::model("H6076").unwrap(), &f).unwrap();
                    std::hint::black_box(cipher::safe(&key, &f, false).unwrap());
                    frames += 1;
                }
            }
            let cpu = (cycles() - c0) as f64 / per_us / f64::from(rounds);
            println!("{edge:?}: {cpu:.0} µs CPU per cycle ({} frames a cycle, radio write not included)", frames / rounds);
        }
    }

    #[test]
    fn names_and_ids() {
        assert_eq!(sku_of("Govee_H6076_7A21"), "H6076");
        assert_eq!(sku_of("ihoment_H6199_ABCD"), "H6199");
        assert_eq!(sku_of("Govee"), "");
        assert!(supported("Govee_H6076_7A21"));
        assert!(supported("ihoment_H6199_ABCD"));
        assert!(!supported("GVH5075_1A2B"), "a thermometer is not a lamp");
        assert_eq!(parse_id("a4:c1:38:12:7a:21").unwrap(), 0xa4c1_3812_7a21);
        assert!(parse_id("a4c1385e7a2").is_err());
    }
}
