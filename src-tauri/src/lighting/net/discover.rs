//! Finding Wi-Fi lights on the local network, with each maker's own discovery and nothing else: mDNS questions for
//! Hue bridges (`_hue._tcp`), Nanoleaf (`_nanoleafapi._tcp`) and Elgato (`_elg._tcp`); Yeelight's SSDP search; one
//! broadcast question each for WiZ (`getPilot`), LIFX (`GetService`) and Twinkly (`discover`). Every one only asks
//! who is there: no light's state changes. The answers' own source addresses are the hosts the bridge may talk to.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

/// A light (or a Hue bridge) that answered.
#[derive(Clone, Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub brand: &'static str,
    pub id: String,
    pub name: String,
    pub model: String,
    pub host: String,
    pub port: u16,
    /// A LIFX light's address (12 hex digits).
    pub mac: Option<String>,
}

const LISTEN: Duration = Duration::from_millis(1500);
const MDNS: &[(&str, &str, u16)] = &[("_hue._tcp.local", "hue", 80), ("_nanoleafapi._tcp.local", "nanoleaf", 16021), ("_elg._tcp.local", "elgato", 9123)];

// ---- mDNS (RFC 6762), just enough to ask for three services and read the answers

fn put_name(out: &mut Vec<u8>, name: &str) {
    for label in name.split('.').filter(|l| !l.is_empty()) {
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
}

/// One query for the three services' PTR records, asking for unicast answers (the QU bit).
pub fn mdns_query() -> Vec<u8> {
    let mut q = vec![0, 0, 0, 0, 0, MDNS.len() as u8, 0, 0, 0, 0, 0, 0];
    for (service, _, _) in MDNS {
        put_name(&mut q, service);
        q.extend_from_slice(&[0, 12, 0x80, 1]);
    }
    q
}

/// A DNS name at `at` (with compression pointers), and where the name's bytes end.
fn read_name(p: &[u8], mut at: usize) -> Option<(String, usize)> {
    let mut labels = Vec::new();
    let mut end = None;
    for _ in 0..32 {
        let len = *p.get(at)? as usize;
        if len == 0 {
            return Some((labels.join("."), end.unwrap_or(at + 1)));
        }
        if len & 0xc0 == 0xc0 {
            end.get_or_insert(at + 2);
            at = ((len & 0x3f) << 8) | *p.get(at + 1)? as usize;
            continue;
        }
        labels.push(String::from_utf8_lossy(p.get(at + 1..at + 1 + len)?).into_owned());
        at += 1 + len;
    }
    None
}

/// Records of one mDNS answer: (instance name, brand, SRV port, TXT key=values).
pub fn mdns_answers(p: &[u8]) -> Vec<(String, &'static str, Option<u16>, HashMap<String, String>)> {
    let mut out: HashMap<String, (&'static str, Option<u16>, HashMap<String, String>)> = HashMap::new();
    let count = |i: usize| p.get(i..i + 2).map(|b| usize::from(u16::from_be_bytes([b[0], b[1]]))).unwrap_or(0);
    let (qd, records) = (count(4), count(6) + count(8) + count(10));
    let mut at = 12;
    for _ in 0..qd {
        let Some((_, end)) = read_name(p, at) else { return Vec::new() };
        at = end + 4;
    }
    for _ in 0..records {
        let Some((name, end)) = read_name(p, at) else { break };
        let Some(head) = p.get(end..end + 10) else { break };
        let kind = u16::from_be_bytes([head[0], head[1]]);
        let len = usize::from(u16::from_be_bytes([head[8], head[9]]));
        let data = end + 10;
        let Some(rdata) = p.get(data..data + len) else { break };
        let lower = name.to_ascii_lowercase();
        if let Some(&(service, brand, _)) = MDNS.iter().find(|(s, _, _)| lower.ends_with(&s[..])) {
            match kind {
                12 => {
                    if let Some((instance, _)) = read_name(p, data) {
                        out.entry(instance).or_insert((brand, None, HashMap::new()));
                    }
                }
                33 if lower != service && len >= 6 => {
                    out.entry(name.clone()).or_insert((brand, None, HashMap::new())).1 = Some(u16::from_be_bytes([rdata[4], rdata[5]]));
                }
                16 if lower != service => {
                    let e = out.entry(name.clone()).or_insert((brand, None, HashMap::new()));
                    let mut i = 0;
                    while i < rdata.len() {
                        let n = rdata[i] as usize;
                        let kv = String::from_utf8_lossy(rdata.get(i + 1..i + 1 + n).unwrap_or(&[])).into_owned();
                        if let Some((k, v)) = kv.split_once('=') {
                            e.2.insert(k.to_ascii_lowercase(), v.to_string());
                        }
                        i += 1 + n;
                    }
                }
                _ => {}
            }
        }
        at = data + len;
    }
    out.into_iter().map(|(k, (b, port, txt))| (k, b, port, txt)).collect()
}

fn instance_label(name: &str) -> String {
    name.split("._").next().unwrap_or(name).to_string()
}

// ---- the broadcast questions and their answers

pub const WIZ_ASK: &[u8] = br#"{"method":"getPilot","params":{}}"#;
pub const TWINKLY_ASK: &[u8] = b"\x01discover";
pub const YEELIGHT_ASK: &[u8] = b"M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1982\r\nMAN: \"ssdp:discover\"\r\nST: wifi_bulb\r\n";

/// LIFX's GetService, tagged (to every light), from SYNQ's source id.
pub fn lifx_get_service() -> Vec<u8> {
    let mut f = vec![0u8; 36];
    f[0] = 36;
    f[2..4].copy_from_slice(&0x3400u16.to_le_bytes());
    f[4..8].copy_from_slice(&0x4f4e_4231u32.to_le_bytes());
    f[32] = 2;
    f
}

/// What one answer says, by the port it came back on.
pub fn read_answer(kind: &str, from: SocketAddr, p: &[u8]) -> Option<Found> {
    let host = from.ip().to_string();
    match kind {
        "wiz" => {
            let v: serde_json::Value = serde_json::from_slice(p).ok()?;
            let mac = v["result"]["mac"].as_str()?.to_ascii_lowercase();
            Some(Found { brand: "wiz", name: format!("WiZ {}", &mac[mac.len().saturating_sub(4)..]), id: mac, model: "WiZ light".into(), host, port: 38899, mac: None })
        }
        "lifx" => {
            if p.len() < 41 || u16::from_le_bytes([p[32], p[33]]) != 3 || p[36] != 1 {
                return None;
            }
            let mac: String = p[8..14].iter().map(|b| format!("{b:02x}")).collect();
            let port = u32::from_le_bytes([p[37], p[38], p[39], p[40]]);
            Some(Found { brand: "lifx", name: format!("LIFX {}", &mac[8..]), id: mac.clone(), model: "LIFX light".into(), host, port: u16::try_from(port).unwrap_or(56700), mac: Some(mac) })
        }
        "twinkly" => {
            if p.len() < 7 || &p[4..6] != b"OK" {
                return None;
            }
            let name = String::from_utf8_lossy(&p[6..]).trim_end_matches('\0').to_string();
            Some(Found { brand: "twinkly", id: name.clone(), name, model: "Twinkly".into(), host, port: 80, mac: None })
        }
        "yeelight" => {
            let text = String::from_utf8_lossy(p);
            let header = |k: &str| text.lines().find_map(|l| l.split_once(':').filter(|(h, _)| h.trim().eq_ignore_ascii_case(k)).map(|(_, v)| v.trim().to_string()));
            let location = header("Location")?;
            let (ip, port) = location.strip_prefix("yeelight://")?.split_once(':')?;
            let id = header("id")?;
            let name = header("name").filter(|n| !n.is_empty()).unwrap_or_else(|| format!("Yeelight {}", &id[id.len().saturating_sub(4)..]));
            Some(Found { brand: "yeelight", id, name, model: header("model").unwrap_or_default(), host: ip.to_string(), port: port.parse().ok()?, mac: None })
        }
        _ => None,
    }
}

/// Asks once, takes the answers for a moment, and returns every light that answered. Each question goes out from its own
/// ephemeral port (never a fixed one such as 5353 or 56700, and no multicast group is joined), and the answers are
/// unicast replies to that port within `LISTEN`: Windows Firewall lets those through as responses to the multicast or
/// broadcast just sent (its "unicast response to multicast" allowance, about 3 s, on by default), so nothing listens
/// and there is nothing for it to ask about. mDNS asks with the unicast-response bit set, and from a port other than
/// 5353 responders answer by unicast anyway (RFC 6762 §6.7).
pub fn discover() -> Vec<Found> {
    let mut found: HashMap<(String, String), Found> = HashMap::new();
    let mut sockets: Vec<(&str, UdpSocket)> = Vec::new();
    let ask = |kind: &'static str, to: SocketAddr, payload: &[u8], sockets: &mut Vec<(&str, UdpSocket)>| {
        if let Ok(s) = UdpSocket::bind("0.0.0.0:0") {
            let _ = s.set_broadcast(true);
            let _ = s.set_nonblocking(true);
            if s.send_to(payload, to).is_ok() {
                sockets.push((kind, s));
            }
        }
    };
    let bcast = |port: u16| SocketAddr::from((Ipv4Addr::BROADCAST, port));
    ask("mdns", SocketAddr::from((Ipv4Addr::new(224, 0, 0, 251), 5353)), &mdns_query(), &mut sockets);
    ask("yeelight", SocketAddr::from((Ipv4Addr::new(239, 255, 255, 250), 1982)), YEELIGHT_ASK, &mut sockets);
    ask("wiz", bcast(38899), WIZ_ASK, &mut sockets);
    ask("lifx", bcast(56700), &lifx_get_service(), &mut sockets);
    ask("twinkly", bcast(5555), TWINKLY_ASK, &mut sockets);
    let end = Instant::now() + LISTEN;
    let mut buf = [0u8; 4096];
    while Instant::now() < end {
        let mut quiet = true;
        for (kind, s) in &sockets {
            while let Ok((n, from)) = s.recv_from(&mut buf) {
                quiet = false;
                let p = &buf[..n];
                if *kind == "mdns" {
                    for (instance, brand, port, txt) in mdns_answers(p) {
                        let id = txt.get("bridgeid").or_else(|| txt.get("id")).cloned().unwrap_or_else(|| instance_label(&instance)).to_ascii_lowercase();
                        let default_port = MDNS.iter().find(|m| m.1 == brand).map(|m| m.2).unwrap_or(80);
                        let model = txt.get("modelid").or_else(|| txt.get("md")).cloned().unwrap_or_default();
                        let f = Found { brand, id: id.clone(), name: instance_label(&instance), model, host: from.ip().to_string(), port: port.unwrap_or(default_port), mac: None };
                        found.insert((brand.to_string(), id), f);
                    }
                } else if let Some(f) = read_answer(kind, from, p) {
                    found.insert((f.brand.to_string(), f.id.clone()), f);
                }
            }
        }
        if quiet {
            std::thread::sleep(Duration::from_millis(40));
        }
    }
    let mut out: Vec<Found> = found.into_values().collect();
    out.sort_by(|a, b| (a.brand, &a.name).cmp(&(b.brand, &b.name)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer_packet() -> Vec<u8> {
        // One answer: PTR _hue._tcp.local -> "Hue Bridge - 1A2B3C._hue._tcp.local", its SRV (port 443) and TXT.
        let mut p = vec![0, 0, 0x84, 0, 0, 0, 0, 3, 0, 0, 0, 0];
        let instance_at = p.len() + 2 + 10;
        put_name(&mut p, "_hue._tcp.local");
        let mut inst = Vec::new();
        put_name(&mut inst, "Hue Bridge - 1A2B3C._hue._tcp.local");
        p.extend_from_slice(&[0, 12, 0, 1, 0, 0, 0, 120]);
        p.extend_from_slice(&(inst.len() as u16).to_be_bytes());
        p.extend_from_slice(&inst);
        let _ = instance_at;
        for (kind, data) in [(33u16, [0u8, 0, 0, 0, 1, 187, 0].to_vec()), (16, {
            let mut t = Vec::new();
            for kv in ["bridgeid=001788FFFE1A2B3C", "modelid=BSB002"] {
                t.push(kv.len() as u8);
                t.extend_from_slice(kv.as_bytes());
            }
            t
        })] {
            p.extend_from_slice(&inst);
            p.extend_from_slice(&kind.to_be_bytes());
            p.extend_from_slice(&[0x80, 1, 0, 0, 0, 120]);
            p.extend_from_slice(&(data.len() as u16).to_be_bytes());
            p.extend_from_slice(&data);
        }
        p
    }

    #[test]
    fn mdns_question_and_answers() {
        let q = mdns_query();
        assert_eq!(&q[4..6], &[0, 3], "three questions");
        let answers = mdns_answers(&answer_packet());
        assert_eq!(answers.len(), 1);
        let (instance, brand, port, txt) = &answers[0];
        assert_eq!((instance.as_str(), *brand, *port), ("Hue Bridge - 1A2B3C._hue._tcp.local", "hue", Some(443)));
        assert_eq!(txt.get("bridgeid").map(String::as_str), Some("001788FFFE1A2B3C"));
        assert_eq!(instance_label(instance), "Hue Bridge - 1A2B3C");
    }

    #[test]
    fn broadcast_answers() {
        let from: SocketAddr = "192.168.1.40:38899".parse().unwrap();
        let wiz = read_answer("wiz", from, br#"{"method":"getPilot","env":"pro","result":{"mac":"A8BB50D1E2F3","state":true}}"#).unwrap();
        assert_eq!((wiz.id.as_str(), wiz.host.as_str()), ("a8bb50d1e2f3", "192.168.1.40"));
        let mut lifx = lifx_get_service();
        lifx[32] = 3;
        lifx[8..14].copy_from_slice(&[0xd0, 0x73, 0xd5, 0x01, 0x02, 0x03]);
        lifx.extend_from_slice(&[1, 0x7c, 0xdd, 0, 0]);
        let l = read_answer("lifx", "192.168.1.41:56700".parse().unwrap(), &lifx).unwrap();
        assert_eq!((l.mac.as_deref(), l.port), (Some("d073d5010203"), 56700));
        let t = read_answer("twinkly", "192.168.1.42:5555".parse().unwrap(), b"\x2a\x01\xa8\xc0OKTwinkly_ABC123\0").unwrap();
        assert_eq!(t.name, "Twinkly_ABC123");
        let y = read_answer("yeelight", "192.168.1.43:1982".parse().unwrap(), b"HTTP/1.1 200 OK\r\nLocation: yeelight://192.168.1.43:55443\r\nid: 0x000000000015243f\r\nmodel: color\r\nname: \r\n").unwrap();
        assert_eq!((y.host.as_str(), y.port, y.name.as_str()), ("192.168.1.43", 55443, "Yeelight 243f"));
    }
}
