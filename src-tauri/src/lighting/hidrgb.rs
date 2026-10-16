//! USB RGB hubs (wave L4): NZXT HUE 2 / RGB & Fan Controller, Corsair Lighting Node / Commander Pro and the Lian Li Uni
//! Hub SL, from the protocol facts OpenRGB documents (GPL-2.0, credited; no code copied). The model table is
//! src/lib/lighting/hidrgb/hubs.json, shared with the frontend; the guard mirrors src/lib/lighting/hidrgb/guard.ts and
//! both judge rgb-frames.txt line for line. Listing opens nothing; a hub is opened only on its vendor collection, only
//! for a model in the table, and every report is checked here before it is written. Never fans, pumps, firmware,
//! bootloaders, Corsair's software mode, effects other than one static colour, or anything ASUS / motherboard.
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[derive(Deserialize, Clone)]
pub struct Model {
    pub vid: String,
    pub pid: String,
    pub family: String,
    pub name: String,
    pub channels: u8,
}

#[derive(Deserialize)]
struct FamilyInfo {
    #[serde(rename = "maxLeds")]
    max_leds: u16,
    collection: Option<(u16, u16)>,
}

#[derive(Deserialize)]
struct IdentifyOnly {
    vid: String,
    pid: String,
    name: String,
}

#[derive(Deserialize)]
struct Table {
    families: HashMap<String, FamilyInfo>,
    models: Vec<Model>,
    #[serde(rename = "identifyOnly")]
    identify_only: Vec<IdentifyOnly>,
}

fn table() -> &'static Table {
    static T: OnceLock<Table> = OnceLock::new();
    T.get_or_init(|| serde_json::from_str(include_str!("../../../src/lib/lighting/hidrgb/hubs.json")).expect("hubs.json"))
}

fn hex4(v: u16) -> String {
    format!("{v:04x}")
}

/// A hub SYNQ drives, by its USB ids.
pub fn model(vid: u16, pid: u16) -> Option<&'static Model> {
    table().models.iter().find(|m| m.vid == hex4(vid) && m.pid == hex4(pid))
}

/// A device SYNQ only names (no documented protocol): its name.
fn identify_only(vid: u16, pid: u16) -> Option<&'static str> {
    table().identify_only.iter().find(|m| m.vid == hex4(vid) && m.pid == hex4(pid)).map(|m| m.name.as_str())
}

/// The most LEDs a channel of this hub's family may be given (hubs.json).
pub fn max_leds(m: &Model) -> u16 {
    table().families.get(&m.family).map(|f| f.max_leds).unwrap_or(0)
}

const LIANLI_COLOUR_LEN: usize = 1 + 64 * 3;
const NZXT_APPLY: [i16; 15] = [0xa0, -1, 0x00, 0x01, 0, 0, 0x28, 0, 0, 0x80, 0, 0x32, 0, 0, 0x01];

fn zero_from(d: &[u8], at: usize) -> bool {
    d.iter().skip(at).all(|&b| b == 0)
}

fn channel_bit(v: u8, channels: u8) -> bool {
    (0..channels).any(|c| v == 1u8 << c)
}

fn nzxt(m: &Model, report_id: u8, d: &[u8]) -> Result<&'static str, String> {
    match report_id {
        0x10 if d[0] == 0x01 && zero_from(d, 1) => Ok("identify"),
        0x20 if d[0] == 0x03 && zero_from(d, 1) => Ok("identify"),
        0x22 => {
            if !channel_bit(d[1], m.channels) {
                return Err("Not one of this hub's channels.".into());
            }
            if (d[0] == 0x10 || d[0] == 0x11) && d[2] == 0 {
                return Ok("colour");
            }
            if d[0] == 0xa0 && NZXT_APPLY.iter().enumerate().all(|(i, &b)| b < 0 || d[i] == b as u8) && zero_from(d, NZXT_APPLY.len()) {
                return Ok("apply");
            }
            Err("Not a colour or apply report.".into())
        }
        _ => Err("Not a report SYNQ sends this hub (fans, pump and effects are never sent).".into()),
    }
}

fn corsair(m: &Model, report_id: u8, d: &[u8]) -> Result<&'static str, String> {
    if report_id != 0 {
        return Err("Corsair hubs take report 0 only.".into());
    }
    let ch = d[1];
    match d[0] {
        0x02 if zero_from(d, 1) => Ok("identify"),
        0x33 if ch == 0xff && zero_from(d, 2) => Ok("commit"),
        0x34 | 0x37 if ch < m.channels && zero_from(d, 2) => Ok("setup"),
        // Hardware control only: software (direct) mode needs a keep-alive from a running app.
        0x38 if ch < m.channels && d[2] == 0x01 && zero_from(d, 3) => Ok("setup"),
        0x35 if ch < m.channels => {
            let leds = d[3] as u16;
            if d[2] != 0 || leds < 1 || leds > max_leds(m) {
                return Err("LED count out of range.".into());
            }
            if d[4] != 0x04 || d[5..9].iter().any(|&b| b != 0) {
                return Err("Only a static colour is sent.".into());
            }
            if !zero_from(d, 12) {
                return Err("Only one colour is sent.".into());
            }
            Ok("colour")
        }
        _ => Err("Not a command SYNQ sends (direct mode, LED count, protocol, temperature, fans and firmware are never sent).".into()),
    }
}

fn lianli(m: &Model, report_id: u8, d: &[u8]) -> Result<&'static str, String> {
    if report_id != 0xe0 {
        return Err("The Uni Hub SL takes report 0xE0 only.".into());
    }
    if d.len() == LIANLI_COLOUR_LEN {
        return match d[0].checked_sub(0x30) {
            Some(ch) if ch < m.channels => Ok("colour"),
            _ => Err("Not one of this hub's channels.".into()),
        };
    }
    if d[0] == 0x10 && d[1] == 0x32 {
        let (ch, fans) = (d[2] >> 4, d[2] & 0x0f);
        return if ch < m.channels && (1..=4).contains(&fans) && zero_from(d, 3) { Ok("setup") } else { Err("Not a channel and fan count SYNQ sends.".into()) };
    }
    match d[0].checked_sub(0x10) {
        Some(ch) if ch < m.channels && d[1..5] == [0x01, 0x02, 0, 0] && zero_from(d, 5) => Ok("apply"),
        _ => Err("Only static mode at full brightness is sent.".into()),
    }
}

/// Whether SYNQ may send this report (its id, then the bytes after it) to this hub, and what it is.
pub fn check(m: &Model, report_id: u8, data: &[u8]) -> Result<&'static str, String> {
    let lens: &[usize] = match m.family.as_str() {
        "nzxt-hue2" => &[63],
        "corsair-node" => &[64],
        "lianli-sl" => &[10, LIANLI_COLOUR_LEN],
        _ => return Err("Refused: not a hub family SYNQ drives.".into()),
    };
    if !lens.contains(&data.len()) {
        return Err(format!("A {} report is {:?} bytes after the report id.", m.family, lens));
    }
    match m.family.as_str() {
        "nzxt-hue2" => nzxt(m, report_id, data),
        "corsair-node" => corsair(m, report_id, data),
        _ => lianli(m, report_id, data),
    }
}

/// A hub as listed: its ids, the table's name (or the identify-only name) and the product string it reports.
pub struct Listed {
    pub vid: u16,
    pub pid: u16,
    pub name: String,
    pub reported: Option<String>,
}

impl Listed {
    /// As the device list shows it.
    pub fn entry(self) -> crate::devices::Connected {
        crate::devices::Connected { kind: "rgbhub", name: self.name, connection: "USB", generic: false, kb: None, qmk: false, bootloader: false, vid: format!("{:04x}", self.vid), pid: format!("{:04x}", self.pid), reported: self.reported, collections: Vec::new(), pad: None, path: None }
    }
}

/// The hubs (and identify-only devices) connected, from HID enumeration; nothing is opened.
pub fn list() -> Vec<Listed> {
    let Ok(api) = hidapi::HidApi::new() else { return Vec::new() };
    let mut out: Vec<Listed> = Vec::new();
    for info in api.device_list() {
        let (vid, pid) = (info.vendor_id(), info.product_id());
        if out.iter().any(|l| (l.vid, l.pid) == (vid, pid)) {
            continue;
        }
        let name = match (model(vid, pid), identify_only(vid, pid)) {
            (Some(m), _) => m.name.clone(),
            (None, Some(n)) => n.to_string(),
            _ => continue,
        };
        let reported = info.product_string().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
        out.push(Listed { vid, pid, name, reported });
    }
    out
}

fn open_hubs() -> &'static Mutex<HashMap<(u16, u16), hidapi::HidDevice>> {
    static OPEN: OnceLock<Mutex<HashMap<(u16, u16), hidapi::HidDevice>>> = OnceLock::new();
    OPEN.get_or_init(|| Mutex::new(HashMap::new()))
}

fn parse(v: &str) -> Result<u16, String> {
    u16::from_str_radix(v.trim_start_matches("0x"), 16).map_err(|_| format!("Not a USB id: {v}"))
}

/// The hub's vendor collection: the family's own (Lian Li), else the one vendor-defined page the hub has.
fn open(vid: u16, pid: u16) -> Result<(), String> {
    let mut map = open_hubs().lock().map_err(|_| "Hub state poisoned".to_string())?;
    if map.contains_key(&(vid, pid)) {
        return Ok(());
    }
    let m = model(vid, pid).ok_or("Refused: not a hub SYNQ drives.")?;
    let want = table().families.get(&m.family).and_then(|f| f.collection);
    let api = hidapi::HidApi::new().map_err(|e| format!("HID: {e}"))?;
    let info = api
        .device_list()
        .find(|i| (i.vendor_id(), i.product_id()) == (vid, pid) && want.map_or(i.usage_page() >= 0xff00, |(p, u)| (i.usage_page(), i.usage()) == (p, u)))
        .ok_or("The hub's vendor collection isn't there (unplugged, or not the collection OpenRGB describes).")?;
    let dev = info.open_device(&api).map_err(|e| format!("Couldn't open the hub: {e}"))?;
    map.insert((vid, pid), dev);
    Ok(())
}

/// One report to a hub, after the guard.
pub fn write(vid: &str, pid: &str, report_id: u8, data: &[u8]) -> Result<&'static str, String> {
    let (v, p) = (parse(vid)?, parse(pid)?);
    let m = model(v, p).ok_or("Refused: not a hub SYNQ drives.")?;
    let what = check(m, report_id, data).map_err(|e| format!("Refused: {e}"))?;
    open(v, p)?;
    let map = open_hubs().lock().map_err(|_| "Hub state poisoned".to_string())?;
    let dev = map.get(&(v, p)).ok_or("The hub closed.")?;
    let mut buf = Vec::with_capacity(data.len() + 1);
    buf.push(report_id);
    buf.extend_from_slice(data);
    dev.write(&buf).map_err(|e| format!("The hub didn't take the report: {e}"))?;
    Ok(what)
}

/// The next input report from an open hub, or None when none came in time.
pub fn read(vid: &str, pid: &str, timeout_ms: i32) -> Result<Option<Vec<u8>>, String> {
    let (v, p) = (parse(vid)?, parse(pid)?);
    let map = open_hubs().lock().map_err(|_| "Hub state poisoned".to_string())?;
    let Some(dev) = map.get(&(v, p)) else { return Ok(None) };
    let mut buf = [0u8; 256];
    let n = dev.read_timeout(&mut buf, timeout_ms.clamp(0, 2000)).map_err(|e| format!("HID read: {e}"))?;
    Ok((n > 0).then(|| buf[..n].to_vec()))
}

pub fn close(vid: &str, pid: &str) {
    if let (Ok(v), Ok(p), Ok(mut map)) = (parse(vid), parse(pid), open_hubs().lock()) {
        map.remove(&(v, p));
    }
}

/// Lets go of every hub (the window lost focus).
pub fn close_all() {
    if let Ok(mut map) = open_hubs().lock() {
        map.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(h: &str) -> Vec<u8> {
        (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn hub_guard_matches_the_frontend() {
        let file = include_str!("../../../src/lib/lighting/hidrgb/rgb-frames.txt");
        let mut n = 0;
        for line in file.lines().filter(|l| !l.trim().is_empty()) {
            let parts: Vec<&str> = line.split(' ').collect();
            let (ok, ids, report, data) = (parts[0] == "1", parts[1], parts[2], parts[3]);
            let (v, p) = ids.split_once(':').unwrap();
            let m = model(parse(v).unwrap(), parse(p).unwrap()).unwrap();
            let verdict = check(m, u8::from_str_radix(report, 16).unwrap(), &bytes(data));
            assert_eq!(verdict.is_ok(), ok, "{line}");
            if ok {
                assert_eq!(verdict.unwrap(), parts[4], "{line}");
            }
            n += 1;
        }
        assert!(n > 500, "{n} lines");
    }

    #[test]
    fn the_table_has_no_motherboard_or_asus_device() {
        for m in &table().models {
            assert_ne!(m.vid, "0b05", "{}", m.name);
            assert!(!m.name.to_lowercase().contains("motherboard"), "{}", m.name);
        }
        assert_eq!(identify_only(0x1b1c, 0x0c57), Some("Corsair Nautilus LCD Cap"));
        assert!(model(0x1b1c, 0x0c57).is_none(), "the Nautilus cap is never driven");
    }
}
