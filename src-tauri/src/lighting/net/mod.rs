//! Wi-Fi lights (wave L3), reached on the local network with no maker's app or cloud at run time: Philips Hue (through
//! its bridge's v1 API), Nanoleaf, Elgato, Twinkly, WiZ, Yeelight and LIFX. Discovery (discover.rs) finds them; the
//! bridge sends only to the addresses discovery found, only messages guard.rs allows, and keeps the pairing keys
//! itself (lighting-keys.json in the app's data folder): the page never sees one. Pairing is the maker's own: Hue's
//! link button, Nanoleaf's power-button hold; Twinkly logs in with its own challenge; the others need no key.
//! First-time Wi-Fi setup is never done here (the page says which app does it).

pub mod colour;
pub mod discover;
pub mod dtls;
pub mod guard;
pub mod hue;
pub mod wire;

use discover::Found;
use guard::NetMessage;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A light as the page lists it: what discovery found, and whether it is paired.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetLight {
    #[serde(flatten)]
    pub found: Found,
    pub paired: bool,
}

/// What a light answered.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Reply {
    Json { body: Value },
    Bytes { bytes: Vec<u8> },
    None,
}

fn found() -> &'static Mutex<HashMap<String, Found>> {
    static FOUND: OnceLock<Mutex<HashMap<String, Found>>> = OnceLock::new();
    FOUND.get_or_init(Default::default)
}

fn key_of(brand: &str, id: &str) -> String {
    format!("{brand}:{id}")
}

// ---- pairing keys (Hue usernames, Nanoleaf tokens), kept in the app's data folder

static KEYS_FILE: OnceLock<PathBuf> = OnceLock::new();

/// Where the keys live (set once at start-up).
pub fn init(data_dir: PathBuf) {
    let _ = KEYS_FILE.set(data_dir.join("lighting-keys.json"));
}

fn keys() -> &'static Mutex<HashMap<String, String>> {
    static KEYS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    KEYS.get_or_init(|| {
        let saved = KEYS_FILE.get().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Mutex::new(saved)
    })
}

fn save_key(key: String, value: Option<String>) -> Result<(), String> {
    let mut k = keys().lock().map_err(|_| "keys poisoned")?;
    match value {
        Some(v) => k.insert(key, v),
        None => k.remove(&key),
    };
    if let Some(p) = KEYS_FILE.get() {
        let json = serde_json::to_string(&*k).map_err(|e| e.to_string())?;
        std::fs::write(p, json).map_err(|e| format!("Could not keep the pairing key: {e}"))?;
    }
    Ok(())
}

fn needs_key(brand: &str) -> bool {
    brand == "hue" || brand == "nanoleaf"
}

fn paired(brand: &str, id: &str) -> bool {
    !needs_key(brand) || keys().lock().map(|k| k.contains_key(&key_of(brand, id))).unwrap_or(false)
}

// ---- listing

/// Asks the network who is there (about 1.5 s, when the person presses "Find lights") and lists every light found
/// this session, paired or not.
pub fn find() -> Vec<NetLight> {
    let now = discover::discover();
    let mut map = match found().lock() {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };
    for f in now {
        map.insert(key_of(f.brand, &f.id), f);
    }
    let mut out: Vec<NetLight> = map.values().map(|f| NetLight { paired: paired(f.brand, &f.id), found: f.clone() }).collect();
    out.sort_by(|a, b| (a.found.brand, &a.found.name).cmp(&(b.found.brand, &b.found.name)));
    out
}

fn device(brand: &str, id: &str) -> Result<Found, String> {
    found().lock().map_err(|_| "lights poisoned")?.get(&key_of(brand, id)).cloned().ok_or_else(|| "SYNQ hasn't found that light on the network.".to_string())
}

// ---- pairing

/// Pairs with a light that takes a key: Hue after its link button, Nanoleaf after its power-button hold.
pub fn pair(brand: &str, id: &str, pc: &str) -> Result<(), String> {
    let d = device(brand, id)?;
    let (method, path, body) = match brand {
        // The client key comes with the username, so Hue's Entertainment streaming won't need pairing again.
        "hue" => ("POST", "/api", Some(serde_json::json!({ "devicetype": format!("onboard#{}", pc_name(pc)), "generateclientkey": true }))),
        "nanoleaf" => ("POST", "/api/v1/new", None),
        _ => return Ok(()),
    };
    let m = NetMessage::Http { method: method.into(), path: path.into(), body: body.clone() };
    guard::check(brand, &m)?;
    let (status, text) = wire::http(&d.host, d.port, method, path, &[], body.map(|b| b.to_string()).as_deref())?;
    let v: Value = serde_json::from_str(&text).unwrap_or_default();
    let key = match brand {
        "hue" => v[0]["success"]["username"].as_str().map(str::to_string),
        _ => v["auth_token"].as_str().map(str::to_string),
    };
    if let Some(client) = v[0]["success"]["clientkey"].as_str().filter(|_| brand == "hue") {
        save_key(format!("{}#clientkey", key_of(brand, id)), Some(client.to_string()))?;
    }
    match key {
        Some(k) => save_key(key_of(brand, id), Some(k)),
        None if brand == "hue" => Err("The bridge said no: press its link button, then Pair within 30 seconds.".into()),
        None => Err(format!("The controller said no ({status}): hold its power button for 5 to 7 seconds first.")),
    }
}

/// A short name for this PC in a Hue bridge's list of apps (letters, digits, spaces, `_ . -`).
fn pc_name(pc: &str) -> String {
    let s: String = pc.chars().filter(|c| c.is_ascii_alphanumeric() || " _.-".contains(*c)).take(19).collect();
    if s.is_empty() { "pc".into() } else { s }
}

pub fn forget(brand: &str, id: &str) -> Result<(), String> {
    save_key(format!("{}#clientkey", key_of(brand, id)), None)?;
    save_key(key_of(brand, id), None)
}

// ---- Twinkly's login (the bridge's own: a random challenge, the light's answer, then its token for a few hours)

struct Session {
    token: String,
    until: Instant,
}

fn twinkly_sessions() -> &'static Mutex<HashMap<String, Session>> {
    static S: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

fn base64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    bytes
        .chunks(3)
        .flat_map(|c| {
            let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
            (0..4).map(move |i| if i <= c.len() { A[(n >> (18 - 6 * i)) as usize & 63] as char } else { '=' })
        })
        .collect()
}

fn twinkly_token(d: &Found) -> Result<String, String> {
    if let Some(s) = twinkly_sessions().lock().map_err(|_| "poisoned")?.get(&d.id).filter(|s| s.until > Instant::now()) {
        return Ok(s.token.clone());
    }
    // A fresh challenge each login (splitmix64 from the clock: it only has to differ, not be secret).
    let mut x = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|t| t.as_nanos() as u64).unwrap_or(1);
    let challenge: Vec<u8> = (0..4)
        .flat_map(|_| {
            x = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
            let mut z = x;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            (z ^ (z >> 31)).to_le_bytes()
        })
        .collect();
    let (_, text) = wire::http(&d.host, d.port, "POST", "/xled/v1/login", &[], Some(&serde_json::json!({ "challenge": base64(&challenge) }).to_string()))?;
    let v: Value = serde_json::from_str(&text).map_err(|_| "Twinkly's login answer isn't JSON.")?;
    let token = v["authentication_token"].as_str().ok_or("Twinkly didn't log SYNQ in.")?.to_string();
    let response = v["challenge-response"].as_str().unwrap_or_default().to_string();
    wire::http(&d.host, d.port, "POST", "/xled/v1/verify", &[("X-Auth-Token", token.clone())], Some(&serde_json::json!({ "challenge-response": response }).to_string()))?;
    let life = v["authentication_token_expires_in"].as_u64().unwrap_or(3600).saturating_sub(60);
    twinkly_sessions().lock().map_err(|_| "poisoned")?.insert(d.id.clone(), Session { token: token.clone(), until: Instant::now() + Duration::from_secs(life) });
    Ok(token)
}

// ---- sending

/// One message from the page. Making or removing a Hue Entertainment area goes only through hue.rs (which records the
/// area SYNQ made and removes only that one), never as a plain message.
pub fn send(brand: &str, id: &str, m: &NetMessage) -> Result<Reply, String> {
    if let NetMessage::Http { method, path, .. } = m {
        if brand == "hue" && path.contains("/groups") && (method == "POST" || method == "DELETE") {
            return Err("Entertainment areas are made and removed from the Lights view only.".into());
        }
    }
    send_checked(brand, id, m)
}

/// One message to a light: the guard first, then the light's own way, and its answer.
pub(crate) fn send_checked(brand: &str, id: &str, m: &NetMessage) -> Result<Reply, String> {
    guard::check(brand, m)?;
    let d = device(brand, id)?;
    match m {
        NetMessage::Http { method, path, body } => {
            let mut path = path.clone();
            if path.contains("{token}") {
                let key = keys().lock().map_err(|_| "keys poisoned")?.get(&key_of(brand, id)).cloned().ok_or("Pair with the light first.")?;
                path = path.replace("{token}", &key);
            }
            let headers = if brand == "twinkly" { vec![("X-Auth-Token", twinkly_token(&d)?)] } else { Vec::new() };
            let (status, text) = wire::http(&d.host, d.port, method, &path, &headers, body.as_ref().map(Value::to_string).as_deref())?;
            if status == 401 || status == 403 {
                if brand == "twinkly" {
                    twinkly_sessions().lock().map_err(|_| "poisoned")?.remove(&d.id);
                }
                return Err("The light no longer knows SYNQ: pair again.".into());
            }
            Ok(serde_json::from_str(&text).map(|body| Reply::Json { body }).unwrap_or(Reply::None))
        }
        NetMessage::Json { body } => {
            let text = body.to_string();
            if brand == "yeelight" {
                let id = body["id"].as_u64().unwrap_or(0);
                let answer = wire::tcp_line(&d.host, d.port, &text, id)?;
                return Ok(serde_json::from_str(&answer).map(|body| Reply::Json { body }).unwrap_or(Reply::None));
            }
            // WiZ answers every message; the answer to a question is the state.
            let want = |p: &[u8]| serde_json::from_slice::<Value>(p).is_ok();
            let answer = wire::udp(&d.host, d.port, text.as_bytes(), Some(&want))?;
            Ok(answer.and_then(|a| serde_json::from_slice(&a).ok()).map(|body| Reply::Json { body }).unwrap_or(Reply::None))
        }
        NetMessage::Lifx { bytes } => {
            let answer = bytes[22] & 0x01 != 0;
            let seq = bytes[23];
            let want = move |p: &[u8]| p.len() >= 36 && p[23] == seq && p[4..8] == bytes[4..8];
            match wire::udp(&d.host, d.port, bytes, if answer { Some(&want) } else { None })? {
                Some(a) => Ok(Reply::Bytes { bytes: a }),
                None => Ok(Reply::None),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_names_and_encoding() {
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
        assert_eq!(pc_name("DESKTOP-ÆØ 42!"), "DESKTOP- 42");
        assert_eq!(pc_name("***"), "pc");
        assert!(needs_key("hue") && needs_key("nanoleaf") && !needs_key("wiz"));
        // Nothing is sent to a light discovery didn't find.
        let m = NetMessage::Json { body: serde_json::json!({"id": 1, "method": "getPilot", "params": {}}) };
        assert!(send("wiz", "nowhere", &m).unwrap_err().contains("hasn't found"));
    }
}
