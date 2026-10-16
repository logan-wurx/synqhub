//! What SYNQ may send the Wi-Fi lights of wave L3, judged against src/lib/lighting/net/allowlist.json, the one
//! table the app's guard (src/lib/lighting/net/guard.ts) reads too; the fixture messages.txt (scripts/net-fixtures.ts)
//! holds the two to the same verdicts. This copy has the last word: nothing leaves the PC without it.

use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

/// A message to a light, as the page sends it.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum NetMessage {
    Http { method: String, path: String, body: Option<Value> },
    Json { body: Value },
    Lifx { bytes: Vec<u8> },
}

pub type Verdict = Result<String, String>;

fn no(brand: &str, why: &str) -> Verdict {
    Err(format!("{brand}: {why}."))
}

struct Rule {
    method: Option<String>,
    path: Option<Regex>,
    body: Option<Value>,
    required: Vec<String>,
}

struct Table {
    http: HashMap<String, Vec<Rule>>,
    json: HashMap<String, Vec<Rule>>,
    lifx: HashMap<u16, Vec<(usize, u64, u64)>>,
}

fn table() -> &'static Table {
    static TABLE: OnceLock<Table> = OnceLock::new();
    TABLE.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../../../src/lib/lighting/net/allowlist.json")).expect("allowlist.json");
        let rules = |section: &str| -> HashMap<String, Vec<Rule>> {
            v[section]
                .as_object()
                .map(|o| {
                    o.iter()
                        .map(|(brand, rs)| {
                            let list = rs
                                .as_array()
                                .map(|a| {
                                    a.iter()
                                        .map(|r| Rule {
                                            method: r["method"].as_str().map(str::to_string),
                                            path: r["path"].as_str().map(|p| Regex::new(p).expect("allowlist path")),
                                            body: r.get("body").cloned(),
                                            required: r["required"].as_array().map(|x| x.iter().filter_map(|k| k.as_str().map(str::to_string)).collect()).unwrap_or_default(),
                                        })
                                        .collect()
                                })
                                .unwrap_or_default();
                            (brand.clone(), list)
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        let lifx = v["lifx"]
            .as_object()
            .map(|o| {
                o.iter()
                    .filter_map(|(k, layout)| {
                        let t = k.parse::<u16>().ok()?;
                        let fields = layout.as_array()?.iter().filter_map(|f| Some((f[0].as_u64()? as usize, f[1].as_u64()?, f[2].as_u64()?))).collect();
                        Some((t, fields))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Table { http: rules("http"), json: rules("json"), lifx }
    })
}

fn regex(pattern: &str) -> Option<Regex> {
    static CACHE: OnceLock<std::sync::Mutex<HashMap<String, Regex>>> = OnceLock::new();
    let mut c = CACHE.get_or_init(Default::default).lock().ok()?;
    if let Some(r) = c.get(pattern) {
        return Some(r.clone());
    }
    let r = Regex::new(pattern).ok()?;
    c.insert(pattern.to_string(), r.clone());
    Some(r)
}

/// Whether a value has the shape (allowlist.json's "about" lists the forms).
pub fn fits(shape: &Value, v: Option<&Value>) -> bool {
    let Some(v) = v else { return false };
    match shape {
        Value::String(s) if s == "bool" => v.is_boolean(),
        Value::String(p) => v.as_str().is_some_and(|x| regex(p).is_some_and(|r| r.is_match(x))),
        Value::Array(a) => {
            let num = |i: usize| a.get(i).and_then(Value::as_f64).unwrap_or(f64::NAN);
            match a.first() {
                Some(Value::Number(_)) => v.as_f64().is_some_and(|x| x.fract() == 0.0 && x >= num(0) && x <= num(1)) && (v.is_i64() || v.is_u64()),
                Some(Value::String(h)) if h == "float" => v.as_f64().is_some_and(|x| x.is_finite() && x >= num(1) && x <= num(2)),
                Some(Value::String(h)) if h == "pair" => v.as_array().is_some_and(|p| p.len() == 2 && p.iter().all(|x| x.as_f64().is_some_and(|x| x >= num(1) && x <= num(2)))),
                Some(Value::String(h)) if h == "enum" => (v.is_string() || v.is_number()) && a[1..].contains(v),
                Some(Value::String(h)) if h == "tuple" => v.as_array().is_some_and(|items| items.len() == a.len() - 1 && a[1..].iter().zip(items).all(|(s, x)| fits(s, Some(x)))),
                Some(Value::String(h)) if h == "list" => {
                    let most = a.get(2).and_then(Value::as_u64).unwrap_or(0) as usize;
                    v.as_array().is_some_and(|items| !items.is_empty() && items.len() <= most && items.iter().all(|x| fits(&a[1], Some(x))))
                }
                _ => false,
            }
        }
        Value::Object(o) => {
            let Some(m) = v.as_object() else { return false };
            if o.is_empty() {
                return m.is_empty();
            }
            !m.is_empty() && m.iter().all(|(k, x)| o.get(k).is_some_and(|s| fits(s, Some(x))))
        }
        _ => false,
    }
}

fn body_ok(rule: &Rule, body: Option<&Value>) -> bool {
    let body = body.filter(|b| !b.is_null());
    match &rule.body {
        None => body.is_none(),
        Some(shape) => fits(shape, body) && rule.required.iter().all(|k| body.and_then(|b| b.get(k)).is_some()),
    }
}

/// A LIFX frame: a unicast, addressable protocol-1024 header (GetService alone may be tagged), then a payload of the
/// type's layout.
pub fn check_lifx(b: &[u8]) -> Verdict {
    let u16_at = |i: usize| u16::from_le_bytes([b[i], b[i + 1]]);
    if b.len() < 36 || usize::from(u16_at(0)) != b.len() {
        return no("lifx", "a frame's size is its length, from 36 bytes");
    }
    let (proto, kind) = (u16_at(2), u16_at(32));
    let tagged = proto & 0x2000 != 0;
    if proto & 0x0fff != 1024 || proto & 0x1000 == 0 || proto & 0xc000 != 0 {
        return no("lifx", "protocol 1024, addressable");
    }
    let target = &b[8..16];
    let bad_target = if tagged { kind != 2 || target.iter().any(|&x| x != 0) } else { target.iter().all(|&x| x == 0) || target[6] != 0 || target[7] != 0 };
    if bad_target {
        return no("lifx", "a light's own address (only GetService is broadcast)");
    }
    if b[16..22].iter().any(|&x| x != 0) || b[22] & !0x03 != 0 || b[24..32].iter().any(|&x| x != 0) || u16_at(34) != 0 {
        return no("lifx", "reserved bytes are zero");
    }
    let Some(layout) = table().lifx.get(&kind) else { return no("lifx", &format!("message type {kind} isn't sent")) };
    let size: usize = layout.iter().map(|f| f.0).sum();
    if b.len() != 36 + size {
        return no("lifx", &format!("type {kind} carries {size} bytes"));
    }
    let mut at = 36;
    for &(w, min, max) in layout {
        let v = (0..w).rev().fold(0u64, |acc, i| acc * 256 + u64::from(b[at + i]));
        if v < min || v > max {
            return no("lifx", &format!("type {kind}: a field out of range"));
        }
        at += w;
    }
    Ok(format!("lifx {kind}"))
}

/// Whether a message may go to a light of this brand.
pub fn check(brand: &str, m: &NetMessage) -> Verdict {
    if brand == "lifx" {
        return match m {
            NetMessage::Lifx { bytes } => check_lifx(bytes),
            _ => no(brand, "LIFX lights take LIFX frames"),
        };
    }
    let t = table();
    if let Some(rules) = t.http.get(brand) {
        let NetMessage::Http { method, path, body } = m else { return no(brand, "an HTTP request") };
        let Some(rule) = rules.iter().find(|r| r.method.as_deref() == Some(method) && r.path.as_ref().is_some_and(|p| p.is_match(path))) else {
            return no(brand, &format!("{method} {path} isn't sent (firmware, network, names, resets and keys are refused)"));
        };
        return if body_ok(rule, body.as_ref()) { Ok(format!("{brand} {method} {path}")) } else { no(brand, &format!("that body isn't one {method} {path} takes")) };
    }
    if let Some(rules) = t.json.get(brand) {
        let NetMessage::Json { body } = m else { return no(brand, "a JSON message") };
        return if rules.iter().any(|r| body_ok(r, Some(body))) {
            Ok(format!("{brand} {}", body.get("method").and_then(Value::as_str).unwrap_or("")))
        } else {
            no(brand, "that message isn't sent (settings, Wi-Fi, names, resets and updates are refused)")
        };
    }
    no(brand, "not a brand SYNQ drives")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same verdicts as src/lib/lighting/net/guard.ts on every line of the fixture: `<brand> <1|0> <message JSON>`.
    #[test]
    fn net_guard_matches_the_frontend() {
        let (mut checked, mut allowed) = (0, 0);
        for line in include_str!("messages.txt").lines().filter(|l| !l.is_empty()) {
            let mut parts = line.splitn(3, ' ');
            let (brand, verdict, json) = (parts.next().unwrap(), parts.next().unwrap() == "1", parts.next().unwrap());
            let m: NetMessage = serde_json::from_str(json).unwrap_or_else(|e| panic!("{line}: {e}"));
            assert_eq!(check(brand, &m).is_ok(), verdict, "{line}");
            checked += 1;
            allowed += usize::from(verdict);
        }
        assert!(checked > 300 && allowed > 60, "{checked} lines, {allowed} allowed");
    }

    #[test]
    fn firmware_network_and_keys_are_refused() {
        let http = |method: &str, path: &str, body: Option<Value>| NetMessage::Http { method: method.into(), path: path.into(), body };
        for (brand, m) in [
            ("hue", http("PUT", "/api/{token}/config", Some(serde_json::json!({"swupdate2": {"install": true}})))),
            ("hue", http("DELETE", "/api/{token}/lights/1", None)),
            ("hue", http("POST", "/api/{token}/lights", None)),
            ("nanoleaf", http("DELETE", "/api/v1/{token}", None)),
            ("elgato", http("PUT", "/elgato/accessory-info", Some(serde_json::json!({"displayName": "x"})))),
            ("twinkly", http("POST", "/xled/v1/network/status", Some(serde_json::json!({"mode": 1})))),
            ("twinkly", http("POST", "/xled/v1/led/reset", None)),
            ("wiz", NetMessage::Json { body: serde_json::json!({"method": "setWifiConfig", "params": {"ssid": "x"}}) }),
            ("wiz", NetMessage::Json { body: serde_json::json!({"method": "reboot", "params": {}}) }),
            ("yeelight", NetMessage::Json { body: serde_json::json!({"id": 1, "method": "set_name", "params": ["x"]}) }),
        ] {
            assert!(check(brand, &m).is_err(), "{brand} {m:?}");
        }
        assert!(check("hue", &http("PUT", "/api/{token}/lights/3/state", Some(serde_json::json!({"on": true, "bri": 127})))).is_ok());
    }
}
