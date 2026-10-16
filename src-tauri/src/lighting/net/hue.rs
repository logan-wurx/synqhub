//! Hue Entertainment (wave L5): streaming colours to a Hue Bridge's lights for screen sync, through an Entertainment area
//! (a group of type Entertainment). If the bridge has areas, the person picks one; if it has none, SYNQ makes one
//! named "SYNQ" after the person confirms, records its number, and removes only that one. An area SYNQ didn't
//! make is never changed or removed. The stream is HueStream v1 inside DTLS (dtls.rs) on UDP 2100, with the username and
//! client key from pairing; it is started and stopped on the bridge with `{"stream": {"active": ...}}`. Every request
//! passes guard.rs. The stream itself is UNVERIFIED with a real bridge (LIGHTING.md §8).

// The stream is the Windows bridge's (screen sync reads the screen there); elsewhere its pieces build for their tests.
#![cfg_attr(not(windows), allow(dead_code))]

use super::guard::NetMessage;
use super::{key_of, keys, save_key, send_checked, Reply};
use serde_json::{json, Value};

/// An Entertainment area as the page lists it.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Area {
    pub id: String,
    pub name: String,
    pub lights: Vec<String>,
    /// SYNQ made it (only this one can be removed here).
    pub ours: bool,
}

fn own_key(bridge: &str) -> String {
    format!("{}#area", key_of("hue", bridge))
}

/// The number of the area SYNQ made on this bridge, if it made one.
pub fn own_area(bridge: &str) -> Option<String> {
    keys().lock().ok()?.get(&own_key(bridge)).cloned()
}

fn http(method: &str, path: String, body: Option<Value>) -> NetMessage {
    NetMessage::Http { method: method.into(), path, body }
}

/// The areas from the bridge's list of groups (`GET /groups`, the groups of type Entertainment).
pub fn areas_of(groups: &Value, own: Option<&str>) -> Vec<Area> {
    let mut out: Vec<Area> = groups
        .as_object()
        .map(|o| {
            o.iter()
                .filter(|(_, g)| g["type"] == "Entertainment")
                .map(|(id, g)| Area {
                    id: id.clone(),
                    name: g["name"].as_str().unwrap_or("Entertainment area").to_string(),
                    lights: g["lights"].as_array().map(|l| l.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default(),
                    ours: own == Some(id.as_str()),
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

pub fn areas(bridge: &str) -> Result<Vec<Area>, String> {
    let Reply::Json { body } = send_checked("hue", bridge, &http("GET", "/api/{token}/groups".into(), None))? else { return Err("The bridge didn't list its groups.".into()) };
    Ok(areas_of(&body, own_area(bridge).as_deref()))
}

/// Makes SYNQ's area with these lights (the person confirmed on the page) and records its number.
pub fn create(bridge: &str, lights: &[String]) -> Result<Area, String> {
    if own_area(bridge).is_some() {
        return Err("SYNQ's area is already on this bridge.".into());
    }
    let body = json!({ "name": "SYNQ", "type": "Entertainment", "class": "TV", "lights": lights });
    let Reply::Json { body: answer } = send_checked("hue", bridge, &http("POST", "/api/{token}/groups".into(), Some(body)))? else { return Err("The bridge didn't answer.".into()) };
    let id = answer[0]["success"]["id"].as_str().ok_or_else(|| format!("The bridge didn't make the area ({}).", answer[0]["error"]["description"].as_str().unwrap_or("no reason given")))?.to_string();
    save_key(own_key(bridge), Some(id.clone()))?;
    Ok(Area { id, name: "SYNQ".into(), lights: lights.to_vec(), ours: true })
}

/// Removes the area SYNQ made, and only that one.
pub fn remove(bridge: &str) -> Result<(), String> {
    let id = own_area(bridge).ok_or("SYNQ hasn't made an area on this bridge.")?;
    send_checked("hue", bridge, &http("DELETE", format!("/api/{{token}}/groups/{id}"), None))?;
    save_key(own_key(bridge), None)
}

/// Starts or stops the stream on an area (one SYNQ made or one the person picked).
pub fn set_streaming(bridge: &str, area: &str, active: bool) -> Result<(), String> {
    send_checked("hue", bridge, &http("PUT", format!("/api/{{token}}/groups/{area}"), Some(json!({ "stream": { "active": active } })))).map(|_| ())
}

/// One HueStream v1 message: the header, then each light's id and colour (16 bits a channel, big-endian).
pub fn message(seq: u8, lights: &[(u16, [u8; 3])]) -> Vec<u8> {
    let mut m = b"HueStream".to_vec();
    m.extend_from_slice(&[0x01, 0x00, seq, 0x00, 0x00, 0x00, 0x00]);
    for (id, rgb) in lights {
        m.push(0x00);
        m.extend_from_slice(&id.to_be_bytes());
        for c in rgb {
            m.extend_from_slice(&(u16::from(*c) * 257).to_be_bytes());
        }
    }
    m
}

#[cfg(windows)]
pub use win::Stream;

#[cfg(windows)]
mod win {
    use super::super::dtls::{Aead, Session, Wire};
    use super::super::{device, key_of, keys};
    use super::{message, set_streaming};
    use crate::lighting::govee::cipher::{gcm_open, gcm_seal};
    use std::net::UdpSocket;
    use std::time::Duration;

    struct Cng;
    impl Aead for Cng {
        fn seal(&self, key: &[u8; 16], nonce: &[u8; 12], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
            let (ct, tag) = gcm_seal(key, nonce, aad, plaintext)?;
            Ok([ct, tag.to_vec()].concat())
        }
        fn open(&self, key: &[u8; 16], nonce: &[u8; 12], aad: &[u8], sealed: &[u8]) -> Option<Vec<u8>> {
            let (ct, tag) = sealed.split_at(sealed.len().checked_sub(16)?);
            gcm_open(key, nonce, aad, ct, tag)
        }
    }

    /// A UDP socket connected to the bridge's port 2100: it takes datagrams from the bridge only.
    struct Udp(UdpSocket);
    impl Wire for Udp {
        fn send(&mut self, d: &[u8]) -> Result<(), String> {
            self.0.send(d).map(|_| ()).map_err(|e| format!("The stream didn't go out ({e})."))
        }
        fn recv(&mut self, timeout: Duration) -> Option<Vec<u8>> {
            self.0.set_read_timeout(Some(timeout)).ok()?;
            let mut buf = [0u8; 2048];
            self.0.recv(&mut buf).ok().map(|n| buf[..n].to_vec())
        }
    }

    fn random() -> Result<[u8; 32], String> {
        use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
        let mut r = [0u8; 32];
        unsafe { BCryptGenRandom(None, &mut r, BCRYPT_USE_SYSTEM_PREFERRED_RNG).ok().map_err(|e| format!("random: {e}"))? };
        Ok(r)
    }

    /// A stream to one area: opened on the bridge, then the DTLS session; closed on the bridge when dropped.
    pub struct Stream {
        session: Session<Udp, Cng>,
        bridge: String,
        area: String,
        seq: u8,
    }

    impl Stream {
        pub fn open(bridge: &str, area: &str) -> Result<Self, String> {
            let found = device("hue", bridge)?;
            let (user, client) = {
                let k = keys().lock().map_err(|_| "keys poisoned")?;
                let user = k.get(&key_of("hue", bridge)).cloned().ok_or("Pair with the bridge first.")?;
                let client = k.get(&format!("{}#clientkey", key_of("hue", bridge))).cloned().ok_or("Pair with the bridge again: SYNQ needs its streaming key.")?;
                (user, client)
            };
            let psk: Vec<u8> = (0..client.len() / 2).filter_map(|i| u8::from_str_radix(client.get(i * 2..i * 2 + 2)?, 16).ok()).collect();
            set_streaming(bridge, area, true)?;
            let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
            socket.connect((found.host.as_str(), 2100)).map_err(|e| format!("The bridge can't be reached ({e})."))?;
            match Session::connect(Udp(socket), Cng, user.as_bytes(), &psk, random()?) {
                Ok(session) => Ok(Self { session, bridge: bridge.into(), area: area.into(), seq: 0 }),
                Err(why) => {
                    let _ = set_streaming(bridge, area, false);
                    Err(why)
                }
            }
        }

        pub fn send(&mut self, lights: &[(u16, [u8; 3])]) -> Result<(), String> {
            self.seq = self.seq.wrapping_add(1);
            self.session.send(&message(self.seq, lights))
        }
    }

    impl Drop for Stream {
        fn drop(&mut self) {
            let _ = set_streaming(&self.bridge, &self.area, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn areas_are_the_entertainment_groups_and_only_ours_is_ours() {
        let groups = json!({
            "1": { "name": "Living room", "type": "Room", "lights": ["1", "2"] },
            "3": { "name": "TV area", "type": "Entertainment", "lights": ["1"] },
            "7": { "name": "SYNQ", "type": "Entertainment", "lights": ["2", "4"] }
        });
        let a = areas_of(&groups, Some("7"));
        assert_eq!(a.iter().map(|x| (x.id.as_str(), x.ours)).collect::<Vec<_>>(), vec![("3", false), ("7", true)]);
        assert_eq!(a[1].lights, vec!["2", "4"]);
        assert!(areas_of(&groups, None).iter().all(|x| !x.ours), "an area SYNQ didn't record is never ours");
    }

    #[test]
    fn huestream_v1_layout() {
        let m = message(5, &[(3, [255, 0, 128])]);
        assert_eq!(&m[..9], b"HueStream");
        assert_eq!(&m[9..16], &[1, 0, 5, 0, 0, 0, 0]);
        assert_eq!(&m[16..], &[0, 0, 3, 0xff, 0xff, 0, 0, 0x80, 0x80]);
    }

    #[test]
    fn removing_needs_our_own_area() {
        assert!(remove("no-such-bridge").unwrap_err().contains("hasn't made"));
    }
}
