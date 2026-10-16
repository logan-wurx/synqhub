//! One colour for a Wi-Fi light, as the bridge builds it for screen sync (wave L5): the page's builders
//! (src/lib/lighting/net/brands.ts) are in the page, and sync runs with the page in the background, so the bridge makes
//! the same messages itself. Each passes guard.rs like any other (a test holds every brand to it). Yeelight (about one
//! change a second) and white-only lights (a Key Light) don't follow the screen; the Lights view says so.

use super::guard::NetMessage;
use serde_json::json;

/// Hue (0-360), saturation and value (0-1) of a colour.
pub fn hsv([r, g, b]: [u8; 3]) -> (f64, f64, f64) {
    let (r, g, b) = (f64::from(r), f64::from(g), f64::from(b));
    let max = r.max(g).max(b);
    let d = max - r.min(g).min(b);
    let h = if d == 0.0 {
        0.0
    } else if max == r {
        ((g - b) / d).rem_euclid(6.0)
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h * 60.0, if max == 0.0 { 0.0 } else { d / max }, max / 255.0)
}

fn clamp(v: f64, lo: f64, hi: f64) -> i64 {
    v.round().clamp(lo, hi) as i64
}

/// The light's own address for LIFX frames (its MAC, 12 hex digits).
fn mac_bytes(mac: &str) -> [u8; 6] {
    let mut out = [0u8; 6];
    for (i, o) in out.iter_mut().enumerate() {
        *o = mac.get(i * 2..i * 2 + 2).and_then(|h| u8::from_str_radix(h, 16).ok()).unwrap_or(0);
    }
    out
}

/// LIFX SetColor (102) to one light: hue, saturation, brightness, 3500 K, no transition.
pub fn lifx_set_colour(mac: &str, seq: u8, rgb: [u8; 3]) -> Vec<u8> {
    let (h, s, v) = hsv(rgb);
    let mut f = vec![0u8; 36 + 13];
    let len = f.len() as u16;
    f[0..2].copy_from_slice(&len.to_le_bytes());
    f[2..4].copy_from_slice(&0x1400u16.to_le_bytes());
    f[4..8].copy_from_slice(&0x4f4e_4231u32.to_le_bytes());
    f[8..14].copy_from_slice(&mac_bytes(mac));
    f[23] = seq;
    f[32..34].copy_from_slice(&102u16.to_le_bytes());
    let put = |f: &mut Vec<u8>, at: usize, v: u16| f[at..at + 2].copy_from_slice(&v.to_le_bytes());
    put(&mut f, 37, clamp(h / 360.0 * 65535.0, 0.0, 65535.0) as u16);
    put(&mut f, 39, clamp(s * 65535.0, 0.0, 65535.0) as u16);
    put(&mut f, 41, clamp(v * 65535.0, 0.0, 65535.0) as u16);
    put(&mut f, 43, 3500);
    f
}

/// The messages that put one colour on a light, or none when it can't take colours from the screen.
pub fn colour(brand: &str, sub: Option<&str>, mac: Option<&str>, model: &str, seq: u8, rgb: [u8; 3]) -> Vec<NetMessage> {
    let (h, s, v) = hsv(rgb);
    let http = |method: &str, path: String, body: serde_json::Value| NetMessage::Http { method: method.into(), path, body: Some(body) };
    match brand {
        "hue" => sub.map_or_else(Vec::new, |n| {
            let body = json!({ "on": true, "hue": clamp(h / 360.0 * 65535.0, 0.0, 65535.0), "sat": clamp(s * 254.0, 0.0, 254.0), "bri": clamp(v * 254.0, 1.0, 254.0), "transitiontime": 1 });
            vec![http("PUT", format!("/api/{{token}}/lights/{n}/state"), body)]
        }),
        "nanoleaf" => vec![http(
            "PUT",
            "/api/v1/{token}/state".into(),
            json!({ "hue": { "value": clamp(h, 0.0, 360.0) }, "sat": { "value": clamp(s * 100.0, 0.0, 100.0) }, "brightness": { "value": clamp(v * 100.0, 0.0, 100.0), "duration": 0 } }),
        )],
        "elgato" if model.to_ascii_lowercase().contains("strip") => vec![http(
            "PUT",
            "/elgato/lights".into(),
            json!({ "numberOfLights": 1, "lights": [{ "on": 1, "hue": clamp(h, 0.0, 360.0), "saturation": clamp(s * 100.0, 0.0, 100.0), "brightness": clamp(v * 100.0, 0.0, 100.0) }] }),
        )],
        "twinkly" => vec![
            http("POST", "/xled/v1/led/color".into(), json!({ "red": rgb[0], "green": rgb[1], "blue": rgb[2] })),
            http("POST", "/xled/v1/led/mode".into(), json!({ "mode": "color" })),
        ],
        "wiz" => {
            // Full-strength colour, the brightness as dimming (WiZ's floor is 10 %).
            let k = if v > 0.0 { 1.0 / v } else { 0.0 };
            let c = rgb.map(|x| clamp(f64::from(x) * k, 0.0, 255.0));
            vec![NetMessage::Json { body: json!({ "id": u16::from(seq), "method": "setPilot", "params": { "r": c[0], "g": c[1], "b": c[2], "dimming": clamp(v * 100.0, 10.0, 100.0) } }) }]
        }
        "lifx" => mac.map_or_else(Vec::new, |m| vec![NetMessage::Lifx { bytes: lifx_set_colour(m, seq, rgb) }]),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lighting::net::guard::check;

    #[test]
    fn every_brand_s_sync_colour_passes_the_guard() {
        for rgb in [[255, 0, 0], [0, 255, 0], [12, 34, 200], [255, 255, 255], [1, 1, 1]] {
            for (brand, sub, mac, model) in [
                ("hue", Some("3"), None, "Hue color lamp"),
                ("nanoleaf", None, None, "NL42"),
                ("elgato", None, None, "Elgato Light Strip"),
                ("twinkly", None, None, "Twinkly"),
                ("wiz", None, None, "WiZ light"),
                ("lifx", None, Some("d073d5010203"), "LIFX light"),
            ] {
                let ms = colour(brand, sub, mac, model, 7, rgb);
                assert!(!ms.is_empty(), "{brand} takes colours");
                for m in &ms {
                    assert!(check(brand, m).is_ok(), "{brand} {rgb:?}: {:?}", check(brand, m));
                }
            }
        }
        // Lights that don't follow the screen get nothing.
        assert!(colour("yeelight", None, None, "color", 1, [255, 0, 0]).is_empty());
        assert!(colour("elgato", None, None, "Elgato Key Light", 1, [255, 0, 0]).is_empty());
        assert!(colour("hue", None, None, "BSB002", 1, [255, 0, 0]).is_empty(), "a bridge isn't a light");
    }

    #[test]
    fn colours_convert() {
        let (h, s, v) = hsv([0, 0, 255]);
        assert_eq!((h.round(), s, v), (240.0, 1.0, 1.0));
        let f = lifx_set_colour("d073d5010203", 9, [255, 0, 0]);
        assert_eq!(f.len(), 49);
        assert_eq!(&f[8..14], &[0xd0, 0x73, 0xd5, 0x01, 0x02, 0x03]);
        assert_eq!(u16::from_le_bytes([f[41], f[42]]), 65535, "full brightness");
    }
}
