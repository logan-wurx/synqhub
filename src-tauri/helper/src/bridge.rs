//! The web bridge: lets the SYNQ website reach what a browser can't (Razer on Windows Chromium 153+,
//! the EQ, the Advanced actions) through this helper, with the desktop app's own checks.
//!
//! - A WebSocket on 127.0.0.1 only (`helper_cfg::BRIDGE_PORT`), never on another interface.
//! - Only the website's origin may connect (`helper_cfg::SITE_ORIGIN`; plus `npm run dev:web` and
//!   `preview:web` in debug builds), and the Host must be this machine (no DNS rebinding).
//! - The first time a site connects, the person is asked (a Windows dialog) whether to allow it. A
//!   site they allowed gets a random token; only its SHA-256 is kept (`helper-pairings.json`).
//! - Every device command goes to `hid.rs` exactly as the desktop app's commands do, so every report
//!   passes the same guards (`brands.rs`, `advanced.rs`, the ATK / X68 / VIA / Razer checks), Advanced
//!   grants work the same way (a grant per device and scope, after the panel's confirmation, gone when
//!   the device closes), and devices in update mode are never listed or opened. There is no firmware
//!   path. EQ writes pass `eq::validate` (limits and the net peak) after a backup, as in the app.
//! - A device is open in one tab at a time and is closed when that tab's connection ends.

use crate::{devices, engine, eq, helper_cfg, hid};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// More tabs than this at once are turned away.
pub const MAX_CONNECTIONS: usize = 4;
/// A connection must say hello (and the person answer the dialog) within this.
const HELLO_TIMEOUT: Duration = Duration::from_secs(120);
/// After the person says no, the same site isn't asked again for this long.
const DECLINE_COOLDOWN: Duration = Duration::from_secs(60);

pub const DESKTOP_ONLY: &str = "This needs the SYNQ desktop app.";
#[cfg(windows)]
const ENGINE_DESKTOP_ONLY: &str = "Setting up the EQ engine needs the SYNQ desktop app (Windows asks for administrator rights).";
#[cfg(not(windows))]
const ENGINE_DESKTOP_ONLY: &str = "Setting up the EQ engine needs the SYNQ desktop app (it restarts your sound once).";
#[cfg(windows)]
const PAUSED: &str = "SYNQ Helper is paused. Resume it from its icon in the taskbar.";
#[cfg(not(windows))]
const PAUSED: &str = "SYNQ Helper is paused. Resume it from its tray icon, or turn it off and on in SYNQ's Settings.";

/// The origins that may connect: the website, and in debug builds the local dev servers.
pub fn allowed_origins() -> Vec<String> {
    let mut v = vec![helper_cfg::SITE_ORIGIN.to_string()];
    if cfg!(debug_assertions) {
        v.extend(helper_cfg::DEV_ORIGINS.iter().map(|s| s.to_string()));
    }
    v
}

/// Exact match only: scheme, host and port as the browser sends them, no trailing slash, no wildcard.
pub fn origin_allowed(origin: Option<&str>, allow: &[String]) -> bool {
    origin.is_some_and(|o| allow.iter().any(|a| a == o))
}

/// The Host header must name this machine on the bridge's port.
pub fn host_ok(host: Option<&str>, port: u16) -> bool {
    host.is_some_and(|h| h == format!("127.0.0.1:{port}") || h.eq_ignore_ascii_case(&format!("localhost:{port}")))
}

/// Asks the person whether a site may use the helper. The real one is a Windows dialog (main.rs).
pub trait Consent: Send + Sync {
    fn ask(&self, origin: &str) -> bool;
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Pairings {
    pub sites: Vec<Site>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Site {
    pub origin: String,
    pub token_sha256: String,
    pub paired: u64,
}

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// 32 random bytes from the kernel, as hex.
#[cfg(unix)]
pub fn new_token() -> Result<String, String> {
    use std::io::Read;
    let mut buf = [0u8; 32];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).map_err(|_| "Couldn't make a pairing token.".to_string())?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// 32 random bytes from Windows, as hex.
#[cfg(windows)]
pub fn new_token() -> Result<String, String> {
    use windows::Win32::Security::Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom};
    let mut buf = [0u8; 32];
    let status = unsafe { BCryptGenRandom(None, &mut buf, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    if status.is_err() {
        return Err("Windows couldn't make a pairing token.".into());
    }
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

impl Pairings {
    pub fn knows(&self, origin: &str, token: &str) -> bool {
        let h = sha256_hex(token);
        !token.is_empty() && self.sites.iter().any(|s| s.origin == origin && s.token_sha256 == h)
    }

    /// Pairs `origin` with `token` (replacing an earlier pairing of that site).
    pub fn add(&mut self, origin: &str, token: &str) {
        self.sites.retain(|s| s.origin != origin);
        self.sites.push(Site { origin: origin.to_string(), token_sha256: sha256_hex(token), paired: eq::now_secs() });
    }
}

pub struct Bridge {
    pub hid: hid::HidState,
    allow: Vec<String>,
    pub port: u16,
    /// The app data folder (pairings, EQ backups and presets). None in tests: nothing is written.
    data: Option<PathBuf>,
    pairings: Mutex<Pairings>,
    consent: Box<dyn Consent>,
    asking: Mutex<HashMap<String, Instant>>,
    pub paused: Arc<AtomicBool>,
    /// Device key -> the connection that has it open.
    owners: Mutex<HashMap<String, u64>>,
    /// The connection that started screen sync: the sync ends with it.
    sync_owner: Mutex<Option<u64>>,
    next_conn: AtomicU64,
    connections: AtomicUsize,
    stop: AtomicBool,
    /// Live sockets, so turning the bridge off (or quitting) closes them at once.
    streams: Mutex<HashMap<u64, TcpStream>>,
}

/// One connection's state.
pub struct Conn {
    pub id: u64,
    pub origin: String,
    pub paired: bool,
    /// Where events for this connection go (hid-input / hid-lost), as JSON text.
    pub events: Arc<dyn Fn(String) + Send + Sync>,
}

#[derive(Deserialize)]
struct Ack {
    acknowledged: bool,
    typed: Option<String>,
}

fn arg<T: serde::de::DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null)).map_err(|e| format!("Argument {name}: {e}"))
}

impl Bridge {
    pub fn new(port: u16, allow: Vec<String>, data: Option<PathBuf>, consent: Box<dyn Consent>, paused: Arc<AtomicBool>) -> Self {
        let pairings = data.as_ref().map(|d| load_pairings(d)).unwrap_or_default();
        Self {
            hid: hid::HidState::new(),
            allow,
            port,
            data,
            pairings: Mutex::new(pairings),
            consent,
            asking: Mutex::new(HashMap::new()),
            paused,
            owners: Mutex::new(HashMap::new()),
            sync_owner: Mutex::new(None),
            next_conn: AtomicU64::new(1),
            connections: AtomicUsize::new(0),
            stop: AtomicBool::new(false),
            streams: Mutex::new(HashMap::new()),
        }
    }

    /// Re-reads the pairings (the app's "Forget paired sites" removes the file).
    pub fn reload_pairings(&self) {
        if let (Some(d), Ok(mut p)) = (&self.data, self.pairings.lock()) {
            *p = load_pairings(d);
        }
    }

    /// Stops accepting and closes every open connection (their devices close with them). The accept
    /// loop ends at its next connection: `stop_serving` pokes it.
    pub fn shut(&self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Ok(mut s) = self.streams.lock() {
            for (_, t) in s.drain() {
                let _ = t.shutdown(std::net::Shutdown::Both);
            }
        }
    }

    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    fn save_pairings(&self, p: &Pairings) {
        if let Some(d) = &self.data {
            if let Ok(text) = serde_json::to_string_pretty(p) {
                let _ = std::fs::create_dir_all(d);
                let _ = helper_cfg::write_atomic(&d.join(helper_cfg::PAIRINGS_FILE), &text);
            }
        }
    }

    /// The first message of a connection: a known token, or the person's yes for a new site.
    pub fn hello(&self, conn: &mut Conn, args: &Value) -> Result<Value, String> {
        let token = args.get("token").and_then(Value::as_str).unwrap_or("");
        if self.pairings.lock().map_err(|_| "pairings poisoned")?.knows(&conn.origin, token) {
            conn.paired = true;
            return Ok(json!({ "paired": true, "version": env!("CARGO_PKG_VERSION"), "features": ["hid", "eq", "advanced"] }));
        }
        {
            let mut asking = self.asking.lock().map_err(|_| "poisoned")?;
            if asking.get(&conn.origin).is_some_and(|t| t.elapsed() < DECLINE_COOLDOWN) {
                return Err("SYNQ Helper was just told no for this site. Try again in a minute.".into());
            }
            // One dialog at a time: the lock is held while the person decides.
            if !self.consent.ask(&conn.origin) {
                asking.insert(conn.origin.clone(), Instant::now());
                return Err("The site wasn't allowed to use SYNQ Helper.".into());
            }
            asking.remove(&conn.origin);
        }
        let token = new_token()?;
        let snapshot = {
            let mut p = self.pairings.lock().map_err(|_| "pairings poisoned")?;
            p.add(&conn.origin, &token);
            p.clone()
        };
        self.save_pairings(&snapshot);
        conn.paired = true;
        Ok(json!({ "paired": true, "token": token, "version": env!("CARGO_PKG_VERSION"), "features": ["hid", "eq", "advanced"] }))
    }

    fn owned(&self, conn: &Conn, key: &str) -> Result<(), String> {
        match self.owners.lock().map_err(|_| "poisoned")?.get(key) {
            Some(&id) if id == conn.id => Ok(()),
            _ => Err("The device isn't open.".into()),
        }
    }

    /// Tests: marks a device (opened with `hid::test_open_fake`) as this connection's.
    #[cfg(test)]
    pub fn test_own(&self, conn: &Conn, key: &str) {
        self.owners.lock().unwrap().insert(key.to_string(), conn.id);
    }

    fn data_dir(&self, sub: &str) -> Result<PathBuf, String> {
        let d = self.data.as_ref().ok_or("No data folder.")?.join(sub);
        std::fs::create_dir_all(&d).map_err(|e| format!("Could not create {}: {e}", d.display()))?;
        Ok(d)
    }

    /// One command, named and shaped as the desktop app's (src-tauri/src/lib.rs).
    pub fn dispatch(&self, conn: &Conn, cmd: &str, args: &Value) -> Result<Value, String> {
        if !conn.paired {
            return Err("Pair with SYNQ Helper first.".into());
        }
        if self.paused.load(Ordering::SeqCst) {
            return Err(PAUSED.into());
        }
        let key = || arg::<String>(args, "key");
        match cmd {
            "hid_list" => hid::list(&self.hid).map(|l| json!(l)),
            "hid_open" => {
                let key = key()?;
                {
                    let owners = self.owners.lock().map_err(|_| "poisoned")?;
                    if owners.get(&key).is_some_and(|&id| id != conn.id) {
                        return Err("That device is open in another SYNQ tab. Close it there first.".into());
                    }
                }
                let events = conn.events.clone();
                let emit: hid::Emit = Arc::new(move |e| {
                    let msg = match e {
                        hid::HidEvent::Input { key, report_id, usage_page, usage, data } => {
                            json!({ "event": "hid-input", "payload": { "key": key, "reportId": report_id, "usagePage": usage_page, "usage": usage, "data": data } })
                        }
                        hid::HidEvent::Pad { key, usage_page, usage, reports } => {
                            json!({ "event": "hid-input-batch", "payload": { "key": key, "usagePage": usage_page, "usage": usage, "reports": reports } })
                        }
                        hid::HidEvent::Lost { key } => json!({ "event": "hid-lost", "payload": { "key": key } }),
                    };
                    events(msg.to_string());
                });
                hid::open_with(&self.hid, &key, emit)?;
                self.owners.lock().map_err(|_| "poisoned")?.insert(key, conn.id);
                Ok(Value::Null)
            }
            "hid_close" => {
                let key = key()?;
                if self.owned(conn, &key).is_ok() {
                    self.owners.lock().map_err(|_| "poisoned")?.remove(&key);
                    hid::close(&self.hid, &key)?;
                }
                Ok(Value::Null)
            }
            "hid_send_report" => {
                let key = key()?;
                self.owned(conn, &key)?;
                hid::send_report(&self.hid, &key, arg(args, "reportId")?, &arg::<Vec<u8>>(args, "data")?).map(|_| Value::Null)
            }
            "hid_send_report_to" => {
                let key = key()?;
                self.owned(conn, &key)?;
                hid::send_report_to(&self.hid, &key, arg(args, "usagePage")?, arg(args, "usage")?, arg(args, "reportId")?, &arg::<Vec<u8>>(args, "data")?).map(|_| Value::Null)
            }
            "hid_send_feature_report" => {
                let key = key()?;
                self.owned(conn, &key)?;
                hid::send_feature_report(&self.hid, &key, arg(args, "reportId")?, &arg::<Vec<u8>>(args, "data")?).map(|_| Value::Null)
            }
            "hid_receive_feature_report" => {
                let key = key()?;
                self.owned(conn, &key)?;
                hid::receive_feature_report(&self.hid, &key, arg(args, "reportId")?).map(|d| json!(d))
            }
            "hid_advanced_grant" => {
                let key = key()?;
                self.owned(conn, &key)?;
                let ack: Ack = arg(args, "ack")?;
                let scheme: Option<String> = arg(args, "scheme").unwrap_or(None);
                hid::advanced_grant(&self.hid, &key, &arg::<String>(args, "scope")?, crate::advanced::Ack { acknowledged: ack.acknowledged, typed: ack.typed }, scheme.as_deref()).map(|ms| json!(ms))
            }
            "hid_advanced_revoke" => {
                let key = key()?;
                self.owned(conn, &key)?;
                hid::advanced_revoke(&self.hid, &key, &arg::<String>(args, "scope")?).map(|_| Value::Null)
            }
            "hid_advanced_status" => {
                let key = key()?;
                self.owned(conn, &key)?;
                hid::advanced_status(&self.hid, &key).map(|s| json!(s))
            }
            // As the app lists them (lib.rs devices_list), less XInput pads: devices, monitors, webcams, RGB hubs.
            "devices_list" => devices::list().map(|mut l| {
                l.extend(crate::monitors::list().iter().map(crate::monitors::Monitor::entry));
                l.extend(crate::webcams::list().iter().map(crate::webcams::Webcam::entry));
                l.extend(crate::lighting::hidrgb::list().into_iter().map(crate::lighting::hidrgb::Listed::entry));
                json!(l)
            }),
            // USB RGB hubs: one colour per channel, every report through the app's hub guard (hidrgb.rs).
            "rgbhub_write" => crate::lighting::hidrgb::write(&arg::<String>(args, "vid")?, &arg::<String>(args, "pid")?, arg(args, "reportId")?, &arg::<Vec<u8>>(args, "data")?).map(|w| json!(w)),
            "rgbhub_read" => crate::lighting::hidrgb::read(&arg::<String>(args, "vid")?, &arg::<String>(args, "pid")?, arg(args, "timeoutMs")?).map(|r| json!(r)),
            "rgbhub_close" => {
                crate::lighting::hidrgb::close(&arg::<String>(args, "vid")?, &arg::<String>(args, "pid")?);
                Ok(Value::Null)
            }
            // Monitors (DDC/CI) and webcams, with the app's own allowlists: the website's Displays tab.
            "monitor_caps" => crate::monitors::capabilities(&arg::<String>(args, "id")?).map(|c| json!(c)),
            "monitor_read" => crate::monitors::read(&arg::<String>(args, "id")?, &arg::<Vec<u8>>(args, "codes")?).map(|r| json!(r)),
            "monitor_write" => crate::monitors::write(&arg::<String>(args, "id")?, arg(args, "code")?, arg(args, "value")?, arg(args, "confirm").unwrap_or(false)).map(|r| json!(r)),
            "webcam_controls" => crate::webcams::controls(&arg::<String>(args, "id")?).map(|c| json!(c)),
            "webcam_set" => crate::webcams::set(&arg::<String>(args, "id")?, &arg::<String>(args, "control")?, arg(args, "value")?, arg(args, "auto").unwrap_or(false)).map(|c| json!(c)),
            // Wi-Fi lights on the local network (a browser can't reach them), through the app's message guard. Pairing
            // keys are the app's own file, so a light paired in either is paired in both.
            "net_lights_find" => Ok(json!(crate::lighting::net::find())),
            "net_light_pair" => {
                let pc = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default();
                crate::lighting::net::pair(&arg::<String>(args, "brand")?, &arg::<String>(args, "id")?, &pc).map(|_| Value::Null)
            }
            "net_light_forget" => crate::lighting::net::forget(&arg::<String>(args, "brand")?, &arg::<String>(args, "id")?).map(|_| Value::Null),
            "net_light_send" => {
                let message: crate::lighting::net::guard::NetMessage = arg(args, "message")?;
                crate::lighting::net::send(&arg::<String>(args, "brand")?, &arg::<String>(args, "id")?, &message).map(|r| json!(r))
            }
            // Screen sync across Wi-Fi lights and hubs (lighting/sync.rs), as the app runs it: its colours and its end
            // come to the tab that started it, and it ends when that tab goes.
            "net_sync_start" => {
                let edge = crate::lighting::screen::Edge::parse(&arg::<String>(args, "edge")?).ok_or("An edge is left, right, both or full.")?;
                let events = conn.events.clone();
                let emit: crate::lighting::sync::Emit = Arc::new(move |e| {
                    let msg = match e {
                        crate::lighting::sync::Event::Colours { keys, colours, blind } => json!({ "event": "net-sync", "payload": { "keys": keys, "colours": colours, "blind": blind } }),
                        crate::lighting::sync::Event::Dropped { key, why } => json!({ "event": "net-sync-dropped", "payload": { "key": key, "why": why } }),
                        crate::lighting::sync::Event::Stopped { why } => json!({ "event": "net-sync-stopped", "payload": { "why": why } }),
                    };
                    events(msg.to_string());
                });
                let area: Option<crate::lighting::sync::HueArea> = arg(args, "area").ok().flatten();
                crate::lighting::sync::start(arg(args, "members")?, edge, arg(args, "vivid").unwrap_or(false), arg(args, "monitor").ok().flatten(), area, emit)?;
                *self.sync_owner.lock().map_err(|_| "poisoned")? = Some(conn.id);
                Ok(Value::Null)
            }
            "net_sync_stop" => {
                crate::lighting::sync::stop();
                *self.sync_owner.lock().map_err(|_| "poisoned")? = None;
                Ok(Value::Null)
            }
            "net_sync_state" => Ok(json!(crate::lighting::sync::running())),
            "screen_monitors" => Ok(json!(crate::lighting::screen::monitors())),
            // Hue Entertainment areas: SYNQ's own is made only after the person confirmed it on the page, and only it is removed.
            "hue_areas" => crate::lighting::net::hue::areas(&arg::<String>(args, "bridge")?).map(|a| json!(a)),
            "hue_area_create" => crate::lighting::net::hue::create(&arg::<String>(args, "bridge")?, &arg::<Vec<String>>(args, "lights")?).map(|a| json!(a)),
            "hue_area_remove" => crate::lighting::net::hue::remove(&arg::<String>(args, "bridge")?).map(|_| Value::Null),
            "eq_load" => Ok(json!(eq::snapshot(crate::watcher::eapo_editor_open()))),
            "eq_apply" => {
                let state: eq::EqState = arg(args, "state")?;
                let bypass: bool = arg(args, "bypass").unwrap_or(false);
                // Linux: the running PipeWire EQ takes the save live, as in the desktop app (lib.rs eq_apply).
                #[cfg(not(windows))]
                let live = engine::prepare(&state, bypass)?;
                let r = eq::apply(&state, bypass, &self.data_dir("eq-backups")?)?;
                #[cfg(not(windows))]
                engine::push(&live, &state, bypass, self.data.as_deref());
                Ok(json!(r))
            }
            "eq_presets" => Ok(json!(eq::list_presets(&self.data_dir("eq-presets")?, &eq::config_dir()))),
            "eq_preset_read" => {
                let p = eq::inside(&arg::<String>(args, "path")?, &[self.data_dir("eq-presets")?, eq::config_dir()])?;
                let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
                Ok(json!(eq::parse(&text)))
            }
            "eq_engine_status" => Ok(json!(engine::status(self.data.as_deref()))),
            "sound_names_load" => {
                let path = self.data.as_ref().ok_or("No data folder.")?.join("sound-names.json");
                Ok(std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({})))
            }
            "eq_engine_setup" | "eq_engine_install" | "eq_engine_undo" => Err(ENGINE_DESKTOP_ONLY.into()),
            _ => Err(DESKTOP_ONLY.into()),
        }
    }

    /// Everything a closed connection had open is closed (and its Advanced grants end with it).
    pub fn release(&self, conn: &Conn) {
        let keys: Vec<String> = match self.owners.lock() {
            Ok(mut o) => {
                let k: Vec<String> = o.iter().filter(|(_, id)| **id == conn.id).map(|(k, _)| k.clone()).collect();
                for x in &k {
                    o.remove(x);
                }
                k
            }
            Err(_) => Vec::new(),
        };
        for k in keys {
            let _ = hid::close(&self.hid, &k);
        }
        // A screen sync this tab started ends with it (a website can't keep lights following the screen after it closes).
        if let Ok(mut owner) = self.sync_owner.lock() {
            if *owner == Some(conn.id) {
                *owner = None;
                crate::lighting::sync::stop();
            }
        }
    }

    /// Serves one TCP connection until it closes.
    pub fn connection(self: &Arc<Self>, mut stream: TcpStream) {
        let _ = stream.set_nodelay(true);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let port = self.port;
        let allow = self.allow.clone();
        let req = match crate::ws::handshake(&mut stream, |r| {
            if r.path != "/" {
                return Err("404 Not Found");
            }
            if !host_ok(r.header("host"), port) || !origin_allowed(r.header("origin"), &allow) {
                return Err("403 Forbidden");
            }
            Ok(())
        }) {
            Ok(r) => r,
            Err(_) => return,
        };
        let Ok(write_half) = stream.try_clone() else { return };
        let writer = Arc::new(Mutex::new(write_half));
        let send = {
            let w = Arc::downgrade(&writer);
            move |op: u8, payload: &[u8]| -> Result<(), String> {
                use std::io::Write;
                let w = w.upgrade().ok_or("closed")?;
                let mut s = w.lock().map_err(|_| "poisoned")?;
                s.write_all(&crate::ws::frame(op, payload)).map_err(|e| e.to_string())
            }
        };
        let events_send = send.clone();
        let mut conn = Conn {
            id: self.next_conn.fetch_add(1, Ordering::SeqCst),
            origin: req.header("origin").unwrap_or_default().to_string(),
            paired: false,
            events: Arc::new(move |text: String| {
                let _ = events_send(0x1, text.as_bytes());
            }),
        };
        let _ = stream.set_read_timeout(Some(HELLO_TIMEOUT));
        if let (Ok(mut s), Ok(t)) = (self.streams.lock(), stream.try_clone()) {
            s.insert(conn.id, t);
        }
        let mut reply_send = send.clone();
        loop {
            let msg = match crate::ws::read_message(&mut stream, &mut reply_send) {
                Ok(crate::ws::Message::Text(t)) => t,
                _ => break,
            };
            if self.stopped() {
                break;
            }
            let req: Value = match serde_json::from_str(&msg) {
                Ok(v) => v,
                Err(_) => break,
            };
            let id = req.get("id").cloned().unwrap_or(Value::Null);
            let cmd = req.get("cmd").and_then(Value::as_str).unwrap_or("");
            let args = req.get("args").cloned().unwrap_or(Value::Null);
            let result = if cmd == "hello" {
                let r = self.hello(&mut conn, &args);
                if conn.paired {
                    let _ = stream.set_read_timeout(None);
                }
                r
            } else {
                self.dispatch(&conn, cmd, &args)
            };
            let out = match result {
                Ok(v) => json!({ "id": id, "ok": v }),
                Err(e) => json!({ "id": id, "err": e }),
            };
            if send(0x1, out.to_string().as_bytes()).is_err() {
                break;
            }
        }
        let _ = send(0x8, &[]);
        if let Ok(mut s) = self.streams.lock() {
            s.remove(&conn.id);
        }
        self.release(&conn);
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }
}

fn load_pairings(dir: &std::path::Path) -> Pairings {
    std::fs::read_to_string(dir.join(helper_cfg::PAIRINGS_FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Binds 127.0.0.1:`port` (0 = any free port, for tests).
pub fn bind(port: u16) -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("Couldn't listen on 127.0.0.1:{port}: {e}"))
}

/// Shuts the bridge and wakes its accept loop so `serve` returns.
pub fn stop_serving(bridge: &Bridge) {
    bridge.shut();
    let _ = TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], bridge.port)), Duration::from_millis(500));
}

/// Accepts connections until `bridge.shut()` (followed by one connection to wake the loop).
pub fn serve(bridge: Arc<Bridge>, listener: TcpListener) {
    let busy: Arc<Mutex<HashSet<u64>>> = Arc::new(Mutex::new(HashSet::new()));
    let mut n = 0u64;
    for stream in listener.incoming() {
        if bridge.stopped() {
            break;
        }
        let Ok(stream) = stream else { continue };
        if bridge.connections.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
            drop(stream);
            continue;
        }
        n += 1;
        let id = n;
        bridge.connections.fetch_add(1, Ordering::SeqCst);
        let b = bridge.clone();
        let busy = busy.clone();
        if let Ok(mut s) = busy.lock() {
            s.insert(id);
        }
        let spawned = std::thread::Builder::new().name("bridge-conn".into()).stack_size(256 * 1024).spawn(move || {
            b.connection(stream);
            b.connections.fetch_sub(1, Ordering::SeqCst);
            if let Ok(mut s) = busy.lock() {
                s.remove(&id);
            }
        });
        if spawned.is_err() {
            bridge.connections.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};

    struct Answer(bool, Arc<AtomicUsize>);
    impl Consent for Answer {
        fn ask(&self, _origin: &str) -> bool {
            self.1.fetch_add(1, Ordering::SeqCst);
            self.0
        }
    }

    const SITE: &str = "https://synqhub.app";

    fn bridge(yes: bool) -> (Arc<Bridge>, Arc<AtomicUsize>) {
        let asked = Arc::new(AtomicUsize::new(0));
        let b = Bridge::new(0, vec![SITE.into()], None, Box::new(Answer(yes, asked.clone())), Arc::new(AtomicBool::new(false)));
        (Arc::new(b), asked)
    }

    fn conn(id: u64) -> Conn {
        Conn { id, origin: SITE.into(), paired: true, events: Arc::new(|_| {}) }
    }

    // ---- origin allowlist

    #[test]
    fn only_the_site_origin_is_allowed() {
        let allow = vec![SITE.to_string()];
        assert!(origin_allowed(Some(SITE), &allow));
        for bad in [
            None,
            Some(""),
            Some("null"),
            Some("https://synqhub.app/"),
            Some("http://synqhub.app"),
            Some("https://synqhub.app:8443"),
            Some("https://evil.synqhub.app"),
            Some("https://synqhub.app.evil.com"),
            Some("HTTPS://ONBOARD.EXAMPLE"),
            Some("http://localhost:1421"),
            Some("chrome-extension://abc"),
        ] {
            assert!(!origin_allowed(bad, &allow), "{bad:?}");
        }
    }

    #[test]
    fn dev_origins_only_in_debug_builds() {
        let a = allowed_origins();
        assert_eq!(a[0], helper_cfg::SITE_ORIGIN);
        assert_eq!(a.iter().any(|o| o.contains("localhost")), cfg!(debug_assertions));
        assert!(a.iter().all(|o| !o.ends_with('/') && !o.contains('*')));
    }

    #[test]
    fn host_must_be_this_machine() {
        assert!(host_ok(Some("127.0.0.1:17860"), 17860));
        assert!(host_ok(Some("localhost:17860"), 17860));
        for bad in [None, Some("127.0.0.1"), Some("127.0.0.1:80"), Some("evil.com:17860"), Some("192.168.1.2:17860"), Some("[::1]:17860")] {
            assert!(!host_ok(bad, 17860), "{bad:?}");
        }
    }

    // ---- pairing

    #[test]
    fn pairing_asks_once_then_uses_the_token() {
        let (b, asked) = bridge(true);
        let mut c = Conn { paired: false, ..conn(1) };
        assert!(b.dispatch(&c, "hid_list", &json!({})).unwrap_err().contains("Pair"), "nothing before hello");
        let r = b.hello(&mut c, &json!({})).unwrap();
        let token = r["token"].as_str().unwrap().to_string();
        assert_eq!(token.len(), 64);
        assert_eq!(asked.load(Ordering::SeqCst), 1);
        let mut again = Conn { paired: false, ..conn(2) };
        let r = b.hello(&mut again, &json!({ "token": token })).unwrap();
        assert!(again.paired && r.get("token").is_none());
        assert_eq!(asked.load(Ordering::SeqCst), 1, "a known token isn't asked about");
        // The token is only good for the origin it was given to.
        assert!(!b.pairings.lock().unwrap().knows("https://other.example", &token));
        assert!(!b.pairings.lock().unwrap().knows(SITE, ""));
        assert!(!b.pairings.lock().unwrap().sites[0].token_sha256.contains(&token), "only the hash is kept");
    }

    #[test]
    fn a_no_is_remembered_for_a_minute() {
        let (b, asked) = bridge(false);
        let mut c = Conn { paired: false, ..conn(1) };
        assert!(b.hello(&mut c, &json!({})).is_err());
        assert!(b.hello(&mut c, &json!({ "token": "guess" })).is_err());
        assert_eq!(asked.load(Ordering::SeqCst), 1);
        assert!(!c.paired);
    }

    // ---- commands

    #[test]
    fn paused_refuses_everything() {
        let (b, _) = bridge(true);
        b.paused.store(true, Ordering::SeqCst);
        assert!(b.dispatch(&conn(1), "eq_load", &json!({})).unwrap_err().contains("paused"));
    }

    #[test]
    fn desktop_only_commands_stay_desktop_only() {
        let (b, _) = bridge(true);
        for cmd in ["eq_engine_setup", "eq_engine_install", "eq_engine_undo", "eq_preset_save", "eq_restore_backup", "games_save", "helper_set", "hid_capture_start", "mouse_backup_save", "firmware_update"] {
            assert!(b.dispatch(&conn(1), cmd, &json!({})).is_err(), "{cmd}");
        }
    }

    #[test]
    fn a_device_belongs_to_one_connection() {
        let (b, _) = bridge(true);
        hid::test_open_fake(&b.hid, "k", 0x373b, 0x1278);
        let (mine, theirs) = (conn(1), conn(2));
        b.test_own(&mine, "k");
        let read = json!({ "key": "k", "usagePage": 0xff02, "usage": 2, "reportId": 8, "data": atk(0x04) });
        assert!(b.dispatch(&theirs, "hid_send_report_to", &read).unwrap_err().contains("isn't open"));
        assert!(b.dispatch(&theirs, "hid_open", &json!({ "key": "k" })).unwrap_err().contains("another"));
        assert!(b.dispatch(&theirs, "hid_advanced_grant", &json!({ "key": "k", "scope": "reset", "ack": { "acknowledged": true, "typed": "RESET" } })).is_err());
        b.release(&mine);
        assert!(b.dispatch(&mine, "hid_send_report_to", &read).unwrap_err().contains("isn't open"), "released with its connection");
    }

    /// A 16-byte ATK frame with its check byte.
    fn atk(cmd: u8) -> Vec<u8> {
        let mut f = vec![0u8; 16];
        f[0] = cmd;
        let sum: i32 = 0x08 + f[..15].iter().map(|&b| i32::from(b)).sum::<i32>();
        f[15] = ((0x55 - (sum & 0xff)) & 0xff) as u8;
        f
    }

    fn fixture_bytes(hex: &str) -> Vec<u8> {
        (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
    }

    /// Guard parity: every frame of the ATK fixture (the frontend's verdicts, which the desktop bridge's
    /// tests also check) gets the same verdict through the web bridge, with and without an Advanced
    /// grant. A frame the guard lets through then finds no real collection ("isn't open": no hardware
    /// in tests); a refused one never gets that far.
    #[test]
    fn web_bridge_guard_matches_the_desktop_on_the_atk_fixture() {
        let (b, _) = bridge(true);
        let c = conn(1);
        let mut checked = 0;
        for line in include_str!("../../src/atk-frames.txt").lines().filter(|l| !l.is_empty()) {
            let mut parts = line.splitn(3, ' ');
            let (spec, verdict, hex) = (parts.next().unwrap(), parts.next().unwrap(), parts.next().unwrap());
            // Fresh device per frame, with exactly the fixture's grants.
            hid::test_open_fake(&b.hid, "atk", 0x373b, 0x1278);
            b.test_own(&c, "atk");
            for scope in if spec == "-" { vec![] } else { spec.split('+').map(|s| s.split(':').next().unwrap()).collect::<Vec<_>>() } {
                let typed = (scope == "reset").then_some("RESET");
                let granted = b.dispatch(&c, "hid_advanced_grant", &json!({ "key": "atk", "scope": scope, "ack": { "acknowledged": true, "typed": typed } }));
                // Only the ATK's own scopes can be granted (as on the desktop); macros / calibrate are refused.
                let atk_scope = crate::advanced::scopes_for(crate::advanced::Family::Atk).iter().any(|s| s.name() == scope);
                assert_eq!(granted.is_ok(), atk_scope, "{scope}: {granted:?}");
            }
            let bytes = fixture_bytes(hex);
            let desktop = hid::atk_frame_allowed(0x08, &bytes, crate::advanced::testing::spec_active(spec)).is_ok();
            assert_eq!(desktop, verdict == "1", "fixture {line}");
            let web = b.dispatch(&c, "hid_send_report_to", &json!({ "key": "atk", "usagePage": 0xff02, "usage": 2, "reportId": 8, "data": bytes }));
            let passed_guard = matches!(&web, Err(e) if e.contains("isn't open"));
            assert_eq!(passed_guard, desktop, "grants {spec}, frame {hex}: {web:?}");
            checked += 1;
        }
        assert!(checked > 5000, "{checked}");
    }

    /// Guard parity on a brand guard: the Razer fixture (90-byte feature reports) through the web
    /// bridge's feature path, as the desktop's `brands::check_with` judges them.
    #[test]
    fn web_bridge_guard_matches_the_desktop_on_the_razer_fixture() {
        let (b, _) = bridge(true);
        let c = conn(1);
        // A Razer id with a brand channel in brands.rs.
        let (vid, pid) = (0x1532, crate::brand_ids::RAZER_KEYBOARDS[0]);
        assert!(crate::brands::device(vid, pid).is_some());
        let mut checked = 0;
        for line in include_str!("../../../src/lib/brands/razer/razer-frames.txt").lines().filter(|l| !l.trim().is_empty()).take(4000) {
            let Some((verdict, hex)) = line.split_once(' ') else { continue };
            if hex.len() % 2 != 0 || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
                continue;
            }
            let mut bytes = fixture_bytes(hex);
            bytes.resize(90, 0);
            hid::test_open_fake(&b.hid, "rz", vid, pid);
            b.test_own(&c, "rz");
            let web = b.dispatch(&c, "hid_send_feature_report", &json!({ "key": "rz", "reportId": 0, "data": bytes }));
            let passed_guard = matches!(&web, Err(e) if e.contains("rejected"));
            assert_eq!(passed_guard, verdict == "1", "frame {hex}: {web:?}");
            checked += 1;
        }
        assert!(checked > 1000, "{checked}");
    }

    #[test]
    fn bootloader_ids_are_never_usable() {
        for &(v, p) in hid::BOOTLOADER_IDS.iter() {
            assert!(!hid::usable(v, p, None, 0xff00, 0x0001), "{v:04x}:{p:04x}");
        }
        assert!(!hid::usable(0x1532, 0x0084, Some("Razer Bootloader"), 0xff00, 0x0001));
    }

    // ---- the server, headless (no tray, no dialog, an ephemeral port)

    fn ws_connect(port: u16, origin: &str, host: &str) -> (TcpStream, String) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        write!(s, "GET / HTTP/1.1\r\nHost: {host}\r\nOrigin: {origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").unwrap();
        let mut r = BufReader::new(s.try_clone().unwrap());
        let mut head = String::new();
        loop {
            let mut l = String::new();
            if r.read_line(&mut l).unwrap_or(0) == 0 || l == "\r\n" {
                break;
            }
            head.push_str(&l);
        }
        (s, head)
    }

    fn call(s: &mut TcpStream, id: u32, cmd: &str, args: Value) -> Value {
        let msg = json!({ "id": id, "cmd": cmd, "args": args }).to_string();
        s.write_all(&crate::ws::client_frame(0x1, true, msg.as_bytes(), [3, 1, 4, 1])).unwrap();
        loop {
            let (op, payload) = crate::ws::read_server_frame(s).unwrap();
            assert_eq!(op, 0x1);
            let v: Value = serde_json::from_slice(&payload).unwrap();
            if v["id"] == json!(id) {
                return v;
            }
        }
    }

    #[test]
    fn headless_server_handshake_origin_pairing_and_commands() {
        let listener = bind(0).unwrap();
        let port = listener.local_addr().unwrap().port();
        let asked = Arc::new(AtomicUsize::new(0));
        let b = Arc::new(Bridge::new(port, vec![SITE.into()], None, Box::new(Answer(true, asked.clone())), Arc::new(AtomicBool::new(false))));
        let server = {
            let b = b.clone();
            std::thread::spawn(move || serve(b, listener))
        };
        let host = format!("127.0.0.1:{port}");

        // Wrong origin, wrong host: refused before any WebSocket exists.
        let (_, head) = ws_connect(port, "https://evil.example", &host);
        assert!(head.starts_with("HTTP/1.1 403"), "{head}");
        let (_, head) = ws_connect(port, SITE, &format!("evil.example:{port}"));
        assert!(head.starts_with("HTTP/1.1 403"), "{head}");

        // The site: upgraded, asked once, then commands work.
        let (mut s, head) = ws_connect(port, SITE, &host);
        assert!(head.starts_with("HTTP/1.1 101"), "{head}");
        assert!(head.contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));
        let r = call(&mut s, 1, "eq_engine_setup", json!({}));
        assert!(r["err"].as_str().unwrap().contains("Pair"));
        let r = call(&mut s, 2, "hello", json!({}));
        let token = r["ok"]["token"].as_str().unwrap().to_string();
        assert_eq!(asked.load(Ordering::SeqCst), 1);
        let r = call(&mut s, 3, "eq_engine_setup", json!({}));
        assert!(r["err"].as_str().unwrap().contains("desktop app"));
        let r = call(&mut s, 4, "hid_send_report", json!({ "key": "nope", "reportId": 1, "data": [1, 2] }));
        assert!(r["err"].as_str().unwrap().contains("isn't open"));
        // Ping is answered with a pong.
        s.write_all(&crate::ws::client_frame(0x9, true, b"hi", [1, 2, 3, 4])).unwrap();
        let (op, p) = crate::ws::read_server_frame(&mut s).unwrap();
        assert_eq!((op, p.as_slice()), (0xA, b"hi".as_slice()));
        s.write_all(&crate::ws::client_frame(0x8, true, b"", [0, 0, 0, 0])).unwrap();

        // A second connection with the token isn't asked again.
        let (mut s2, _) = ws_connect(port, SITE, &host);
        let r = call(&mut s2, 1, "hello", json!({ "token": token }));
        assert_eq!(r["ok"]["paired"], json!(true));
        assert_eq!(asked.load(Ordering::SeqCst), 1);
        // Garbage closes the connection.
        s2.write_all(&crate::ws::client_frame(0x1, true, b"not json", [1, 1, 1, 1])).unwrap();
        let mut rest = Vec::new();
        let _ = s2.read_to_end(&mut rest);

        // Turning the bridge off closes live connections too.
        let (mut s3, _) = ws_connect(port, SITE, &host);
        call(&mut s3, 1, "hello", json!({ "token": token }));
        stop_serving(&b);
        server.join().unwrap();
        let mut rest = Vec::new();
        let _ = s3.read_to_end(&mut rest);
        assert!(rest.len() <= 2, "only a close frame, then the socket ends");
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err(), "no longer listening");
    }
}
