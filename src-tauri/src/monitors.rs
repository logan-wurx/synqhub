//! Monitors over DDC/CI (MCCS VCP codes), through Windows' Monitor Configuration API (dxva2), named from their EDID.
//! Listing reads the EDID from the registry and talks to no monitor. DDC/CI reads ask the monitor for its capabilities
//! string and the current value of allowlisted codes. A write passes `guard`: only the codes in src/lib/displays/vcp.json, inside the
//! range the monitor reports (or among the values its capabilities list); the input source only with `confirm`; never
//! a factory reset (0x04 and the other restore codes), never power (0xD6), never a manufacturer code (0xE0..0xFF) or
//! anything not listed. Every write is read back.
// The pure parts (tables, parsers, the guard) serve the Windows bridge and the tests; Linux builds list nothing here.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::Serialize;
use std::collections::BTreeMap;

/// A VCP code SYNQ may change, and how its value is checked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rule {
    /// 0..=the maximum the monitor reports.
    Continuous,
    /// One of the values the monitor's capabilities list for this code.
    Listed,
}

#[derive(Clone, Debug)]
pub struct Allowed {
    pub code: u8,
    pub id: String,
    pub rule: Rule,
    /// Switching it blanks this screen (the input source): it needs the person's confirmation.
    pub confirm: bool,
}

#[derive(serde::Deserialize)]
struct RawAllowed {
    code: u8,
    id: String,
    rule: String,
    #[serde(default)]
    confirm: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTable {
    allowed: Vec<RawAllowed>,
    read_only: Vec<u8>,
}

fn table() -> &'static (Vec<Allowed>, Vec<u8>) {
    static T: std::sync::OnceLock<(Vec<Allowed>, Vec<u8>)> = std::sync::OnceLock::new();
    T.get_or_init(|| {
        let t: RawTable = serde_json::from_str(include_str!("../../src/lib/displays/vcp.json")).expect("vcp.json");
        let allowed = t
            .allowed
            .into_iter()
            .map(|a| Allowed { code: a.code, id: a.id, rule: if a.rule == "listed" { Rule::Listed } else { Rule::Continuous }, confirm: a.confirm })
            .collect();
        (allowed, t.read_only)
    })
}

/// The codes SYNQ may change (src/lib/displays/vcp.json, the same file the TypeScript side reads).
pub fn allowed() -> &'static [Allowed] {
    &table().0
}

/// Codes SYNQ reads but never writes: the power mode (0xD6) and the MCCS version (0xDF).
pub fn read_only() -> &'static [u8] {
    &table().1
}

/// What a monitor's EDID says about it.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Edid {
    /// The three-letter PNP maker id ("AUS", "DEL", "GSM").
    pub maker: String,
    pub product: u16,
    pub name: Option<String>,
    pub serial: Option<String>,
    pub year: Option<u16>,
    /// Width x height in cm, when the EDID says.
    pub size_cm: Option<(u8, u8)>,
}

/// Parses the 128-byte base EDID block. None when it isn't one (bad header or checksum).
pub fn parse_edid(b: &[u8]) -> Option<Edid> {
    if b.len() < 128 || b[..8] != [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00] {
        return None;
    }
    if b[..128].iter().fold(0u8, |a, &x| a.wrapping_add(x)) != 0 {
        return None;
    }
    let id = u16::from(b[8]) << 8 | u16::from(b[9]);
    let letter = |v: u16| char::from(b'A' - 1 + (v & 0x1f) as u8);
    let maker: String = [letter(id >> 10), letter(id >> 5), letter(id)].iter().collect();
    let product = u16::from(b[10]) | u16::from(b[11]) << 8;
    let year = (b[17] > 0).then(|| 1990 + u16::from(b[17]));
    let size_cm = (b[21] > 0 && b[22] > 0).then_some((b[21], b[22]));
    let mut name = None;
    let mut serial = None;
    for d in 0..4 {
        let at = 54 + d * 18;
        let desc = &b[at..at + 18];
        if desc[0] != 0 || desc[1] != 0 {
            continue;
        }
        let text = || {
            let raw: String = desc[5..18].iter().take_while(|&&c| c != 0x0a).map(|&c| char::from(c)).collect();
            Some(raw.trim().to_string()).filter(|s| !s.is_empty())
        };
        match desc[3] {
            0xfc => name = text(),
            0xff => serial = text(),
            _ => {}
        }
    }
    Some(Edid { maker, product, name, serial, year, size_cm })
}

/// A monitor's capabilities string, read: the VCP codes it supports with their listed values, its model and MCCS version.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Caps {
    pub model: Option<String>,
    pub mccs: Option<String>,
    /// Code -> values the monitor lists for it (empty for a continuous code).
    pub vcp: BTreeMap<u8, Vec<u16>>,
}

/// The value of `key(...)` at the top level of a capabilities string, with its nested parentheses.
fn section<'a>(s: &'a str, key: &str) -> Option<&'a str> {
    let lower = s.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(&format!("{key}(")) {
        let start = from + i;
        // Only at top level: depth 1 inside the outer parentheses (or 0 for a string without them).
        let depth = s[..start].chars().fold(0i32, |d, c| d + i32::from(c == '(') - i32::from(c == ')'));
        if depth <= 1 {
            let open = start + key.len();
            let mut d = 0;
            for (j, c) in s[open..].char_indices() {
                d += i32::from(c == '(') - i32::from(c == ')');
                if d == 0 {
                    return Some(&s[open + 1..open + j]);
                }
            }
            return None;
        }
        from = start + key.len();
    }
    None
}

/// Parses an MCCS capabilities string: `(prot(monitor)type(lcd)model(VG248)cmds(...)vcp(02 04 10 12 14(05 06 08 0B) 60(01 03 11) ...)mccs_ver(2.1))`.
pub fn parse_caps(s: &str) -> Caps {
    let mut caps = Caps { model: section(s, "model").map(str::to_string), mccs: section(s, "mccs_ver").map(str::to_string), vcp: BTreeMap::new() };
    let Some(v) = section(s, "vcp") else { return caps };
    let mut chars = v.chars().peekable();
    let mut last: Option<u8> = None;
    while let Some(&c) = chars.peek() {
        if c.is_ascii_hexdigit() {
            let mut t = String::new();
            while let Some(&h) = chars.peek().filter(|h| h.is_ascii_hexdigit()) {
                t.push(h);
                chars.next();
            }
            if let Ok(code) = u8::from_str_radix(&t, 16) {
                caps.vcp.entry(code).or_default();
                last = Some(code);
            }
        } else if c == '(' {
            chars.next();
            let mut inner = String::new();
            let mut depth = 1;
            for x in chars.by_ref() {
                depth += i32::from(x == '(') - i32::from(x == ')');
                if depth == 0 {
                    break;
                }
                inner.push(x);
            }
            if let Some(code) = last {
                let values = inner.split(|ch: char| !ch.is_ascii_hexdigit()).filter(|t| !t.is_empty()).filter_map(|t| u16::from_str_radix(t, 16).ok()).collect();
                caps.vcp.insert(code, values);
            }
        } else {
            chars.next();
        }
    }
    caps
}

/// Whether SYNQ may set `code` to `value` on a monitor with these capabilities and this reported maximum.
pub fn guard(code: u8, value: u32, caps: &Caps, max: u32, confirm: bool) -> Result<&'static str, String> {
    let Some(a) = allowed().iter().find(|a| a.code == code) else {
        return Err(format!("Refused: VCP code 0x{code:02X} isn't one SYNQ changes."));
    };
    if !caps.vcp.contains_key(&code) {
        return Err(format!("Refused: this monitor doesn't list VCP 0x{code:02X}."));
    }
    if a.confirm && !confirm {
        return Err("Switching the input blanks this screen: it needs your confirmation.".into());
    }
    match a.rule {
        Rule::Continuous if value <= max && max > 0 => Ok(a.id.as_str()),
        Rule::Continuous => Err(format!("Refused: {value} is past this monitor's maximum ({max}).")),
        Rule::Listed if caps.vcp[&code].iter().any(|&v| u32::from(v) == value) => Ok(a.id.as_str()),
        Rule::Listed => Err(format!("Refused: {value} isn't a value this monitor lists for 0x{code:02X}.")),
    }
}

/// "AUS24AB" and "5&26dc660c&0&UID4352" from a monitor interface path (`\\?\DISPLAY#AUS24AB#5&26dc660c&0&UID4352#{guid}`).
pub fn device_of_interface(path: &str) -> Option<(String, String)> {
    let mut parts = path.split('#');
    let first = parts.next()?;
    if !first.to_ascii_uppercase().ends_with("DISPLAY") {
        return None;
    }
    Some((parts.next()?.to_string(), parts.next()?.to_string()))
}

/// One monitor as listed: what it is (from its EDID) and which display it is. No DDC/CI here.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    /// Stable across restarts: the display device instance ("AUS24AB/5&26dc660c&0&UID4352").
    pub id: String,
    /// "\\.\DISPLAY1".
    pub display: String,
    pub primary: bool,
    pub edid: Option<Edid>,
}

impl Monitor {
    /// As the device list has it (the app's and SYNQ Helper's): named from its EDID, the PNP maker id and product code
    /// standing in for USB ids. No DDC/CI here.
    pub fn entry(&self) -> crate::devices::Connected {
        let (maker, product, name) = match &self.edid {
            Some(e) => (e.maker.to_ascii_lowercase(), format!("{:04x}", e.product), e.name.clone().unwrap_or_else(|| format!("{} monitor", e.maker))),
            None => (String::new(), String::new(), "Monitor".into()),
        };
        crate::devices::Connected { kind: "monitor", name, connection: "Display", generic: false, kb: None, qmk: false, bootloader: false, vid: maker, pid: product, reported: None, collections: Vec::new(), pad: None, path: Some(self.id.clone()) }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub code: u8,
    pub value: u32,
    pub max: u32,
}

#[cfg(windows)]
pub use win::{capabilities, list, read, write};

#[cfg(not(windows))]
pub fn list() -> Vec<Monitor> {
    Vec::new()
}
#[cfg(not(windows))]
pub fn capabilities(_id: &str) -> Result<Caps, String> {
    Err("DDC/CI is read through Windows here; on Linux it needs ddcutil, not wired yet.".into())
}
#[cfg(not(windows))]
pub fn read(_id: &str, _codes: &[u8]) -> Result<Vec<Reading>, String> {
    Err("DDC/CI isn't available here.".into())
}
#[cfg(not(windows))]
pub fn write(_id: &str, _code: u8, _value: u32, _confirm: bool) -> Result<Reading, String> {
    Err("DDC/CI isn't available here.".into())
}

#[cfg(windows)]
mod win {
    use super::{allowed, device_of_interface, guard, parse_caps, parse_edid, read_only, Caps, Monitor, Reading};
    use windows::core::{BOOL, PCWSTR};
    use windows::Win32::Devices::Display::{
        CapabilitiesRequestAndCapabilitiesReply, DestroyPhysicalMonitors, GetCapabilitiesStringLength, GetNumberOfPhysicalMonitorsFromHMONITOR, GetPhysicalMonitorsFromHMONITOR, GetVCPFeatureAndVCPFeatureReply,
        SetVCPFeature, PHYSICAL_MONITOR,
    };
    use windows::Win32::Foundation::{LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{EnumDisplayDevicesW, EnumDisplayMonitors, GetMonitorInfoW, DISPLAY_DEVICEW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW};
    use windows::Win32::UI::WindowsAndMessaging::{EDD_GET_DEVICE_INTERFACE_NAME, MONITORINFOF_PRIMARY};

    fn wide(s: &[u16]) -> String {
        String::from_utf16_lossy(&s[..s.iter().position(|&c| c == 0).unwrap_or(s.len())])
    }

    unsafe extern "system" fn collect(h: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        let list = unsafe { &mut *(data.0 as *mut Vec<HMONITOR>) };
        list.push(h);
        BOOL(1)
    }

    fn handles() -> Vec<HMONITOR> {
        let mut list: Vec<HMONITOR> = Vec::new();
        unsafe {
            let _ = EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut list as *mut _ as isize));
        }
        list
    }

    fn info(h: HMONITOR) -> Option<(String, bool)> {
        let mut mi = MONITORINFOEXW::default();
        mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        let ok = unsafe { GetMonitorInfoW(h, &mut mi as *mut MONITORINFOEXW as *mut MONITORINFO) };
        ok.as_bool().then(|| (wide(&mi.szDevice), mi.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0))
    }

    /// The monitor device behind a display ("\\.\DISPLAY1"): its PNP model id and instance.
    fn device(display: &str) -> Option<(String, String)> {
        let name: Vec<u16> = display.encode_utf16().chain(Some(0)).collect();
        let mut dd = DISPLAY_DEVICEW { cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32, ..Default::default() };
        let ok = unsafe { EnumDisplayDevicesW(PCWSTR(name.as_ptr()), 0, &mut dd, EDD_GET_DEVICE_INTERFACE_NAME) };
        if !ok.as_bool() {
            return None;
        }
        device_of_interface(&wide(&dd.DeviceID))
    }

    fn edid(model: &str, instance: &str) -> Option<Vec<u8>> {
        let key = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE).open_subkey(format!("SYSTEM\\CurrentControlSet\\Enum\\DISPLAY\\{model}\\{instance}\\Device Parameters")).ok()?;
        key.get_raw_value("EDID").ok().map(|v| v.bytes.to_vec())
    }

    pub fn list() -> Vec<Monitor> {
        handles()
            .into_iter()
            .filter_map(|h| {
                let (display, primary) = info(h)?;
                let (model, instance) = device(&display).unwrap_or_default();
                let edid = edid(&model, &instance).and_then(|b| parse_edid(&b));
                let id = if model.is_empty() { display.clone() } else { format!("{model}/{instance}") };
                Some(Monitor { id, display, primary, edid })
            })
            .collect()
    }

    /// Runs `f` with the physical monitor behind `id` (the first one on that display), then releases it.
    fn with_monitor<T>(id: &str, f: impl FnOnce(&PHYSICAL_MONITOR) -> Result<T, String>) -> Result<T, String> {
        for h in handles() {
            let Some((display, _)) = info(h) else { continue };
            let matches = match device(&display) {
                Some((model, instance)) => format!("{model}/{instance}") == id,
                None => display == id,
            };
            if !matches {
                continue;
            }
            let mut n = 0u32;
            unsafe { GetNumberOfPhysicalMonitorsFromHMONITOR(h, &mut n) }.map_err(|e| format!("DDC/CI: {e}"))?;
            if n == 0 {
                return Err("This display has no monitor DDC/CI can reach.".into());
            }
            let mut mons = vec![PHYSICAL_MONITOR::default(); n as usize];
            unsafe { GetPhysicalMonitorsFromHMONITOR(h, &mut mons) }.map_err(|e| format!("DDC/CI: {e}"))?;
            let out = f(&mons[0]);
            let _ = unsafe { DestroyPhysicalMonitors(&mons) };
            return out;
        }
        Err("That monitor isn't connected any more.".into())
    }

    fn caps_of(m: &PHYSICAL_MONITOR) -> Result<Caps, String> {
        let mut len = 0u32;
        if unsafe { GetCapabilitiesStringLength(m.hPhysicalMonitor, &mut len) } == 0 || len == 0 || len > 16 * 1024 {
            return Err("The monitor didn't answer over DDC/CI (it may be off in its own menu).".into());
        }
        let mut buf = vec![0u8; len as usize];
        if unsafe { CapabilitiesRequestAndCapabilitiesReply(m.hPhysicalMonitor, &mut buf) } == 0 {
            return Err("The monitor didn't send its capabilities.".into());
        }
        let text: String = buf.iter().take_while(|&&c| c != 0).map(|&c| char::from(c)).collect();
        Ok(parse_caps(&text))
    }

    fn get(m: &PHYSICAL_MONITOR, code: u8) -> Option<Reading> {
        let (mut value, mut max) = (0u32, 0u32);
        (unsafe { GetVCPFeatureAndVCPFeatureReply(m.hPhysicalMonitor, code, None, &mut value, Some(&mut max)) } != 0).then_some(Reading { code, value, max })
    }

    pub fn capabilities(id: &str) -> Result<Caps, String> {
        with_monitor(id, caps_of)
    }

    /// Current values of the allowlisted and read-only codes asked for (others are skipped).
    pub fn read(id: &str, codes: &[u8]) -> Result<Vec<Reading>, String> {
        with_monitor(id, |m| Ok(codes.iter().filter(|&&c| allowed().iter().any(|a| a.code == c) || read_only().contains(&c)).filter_map(|&c| get(m, c)).collect()))
    }

    /// Sets one allowlisted code and reads it back (a monitor may take a moment, so it asks a few times).
    pub fn write(id: &str, code: u8, value: u32, confirm: bool) -> Result<Reading, String> {
        with_monitor(id, |m| {
            let caps = caps_of(m)?;
            let now = get(m, code).ok_or("The monitor didn't report that setting.")?;
            guard(code, value, &caps, now.max, confirm)?;
            if unsafe { SetVCPFeature(m.hPhysicalMonitor, code, value) } == 0 {
                return Err("The monitor didn't take the change.".into());
            }
            for _ in 0..5 {
                std::thread::sleep(std::time::Duration::from_millis(80));
                if let Some(r) = get(m, code).filter(|r| r.value == value) {
                    return Ok(r);
                }
            }
            Err("Sent, but the monitor reads back something else.".into())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A made-up but well-formed EDID: maker "AUS", product 0x24AB, 2013, 53x30 cm, name "VG248", serial "TEST123".
    fn edid_fixture() -> Vec<u8> {
        let mut b = vec![0u8; 128];
        b[..8].copy_from_slice(&[0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]);
        let id: u16 = (1 << 10) | (21 << 5) | 19; // A U S
        b[8] = (id >> 8) as u8;
        b[9] = id as u8;
        b[10] = 0xab;
        b[11] = 0x24;
        b[17] = 23;
        b[21] = 53;
        b[22] = 30;
        let name = |b: &mut Vec<u8>, at: usize, tag: u8, text: &str| {
            b[at..at + 5].copy_from_slice(&[0, 0, 0, tag, 0]);
            let mut t = text.as_bytes().to_vec();
            t.push(0x0a);
            t.resize(13, 0x20);
            b[at + 5..at + 18].copy_from_slice(&t);
        };
        name(&mut b, 72, 0xfc, "VG248");
        name(&mut b, 90, 0xff, "TEST123");
        let sum = b[..127].iter().fold(0u8, |a, &x| a.wrapping_add(x));
        b[127] = 0u8.wrapping_sub(sum);
        b
    }

    #[test]
    fn edid_names_the_monitor() {
        let e = parse_edid(&edid_fixture()).unwrap();
        assert_eq!(e, Edid { maker: "AUS".into(), product: 0x24ab, name: Some("VG248".into()), serial: Some("TEST123".into()), year: Some(2013), size_cm: Some((53, 30)) });
        let mut bad = edid_fixture();
        bad[127] ^= 1;
        assert!(parse_edid(&bad).is_none(), "checksum");
        assert!(parse_edid(&[0u8; 128]).is_none(), "header");
    }

    const CAPS: &str = "(prot(monitor)type(LCD)model(VG248)cmds(01 02 03 07 0C E3 F3)vcp(02 04 05 08 0B 0C 10 12 14(05 06 08 0B) 16 18 1A 52 60(01 03 11) 62 6C 6E 70 8D(01 02) AC AE B2 B6 C6 C8 C9 D6(01 04 05) DF)mswhql(1)asset_eep(40)mccs_ver(2.2))";

    #[test]
    fn capabilities_list_codes_and_values() {
        let c = parse_caps(CAPS);
        assert_eq!(c.model.as_deref(), Some("VG248"));
        assert_eq!(c.mccs.as_deref(), Some("2.2"));
        assert_eq!(c.vcp[&0x14], vec![0x05, 0x06, 0x08, 0x0b]);
        assert_eq!(c.vcp[&0x60], vec![0x01, 0x03, 0x11]);
        assert!(c.vcp[&0x10].is_empty());
        assert!(c.vcp.contains_key(&0xdf));
        assert_eq!(parse_caps("garbage").vcp.len(), 0);
    }

    #[test]
    fn the_guard_takes_only_listed_codes_in_range() {
        let c = parse_caps(CAPS);
        assert_eq!(guard(0x10, 70, &c, 100, false), Ok("brightness"));
        assert!(guard(0x10, 101, &c, 100, false).is_err(), "past the maximum");
        assert_eq!(guard(0x14, 0x06, &c, 0x0b, false), Ok("colorPreset"));
        assert!(guard(0x14, 0x07, &c, 0x0b, false).is_err(), "not a listed preset");
        assert!(guard(0x60, 0x03, &c, 0x11, false).is_err(), "input needs confirmation");
        assert_eq!(guard(0x60, 0x03, &c, 0x11, true), Ok("input"));
        for code in [0x04, 0x05, 0x08, 0x0b, 0x0c, 0xb6, 0xc8, 0xd6, 0xdf, 0xe0, 0xff] {
            assert!(guard(code, 1, &c, 100, true).is_err(), "0x{code:02x} is never written");
        }
        let without = parse_caps("(vcp(10 12))");
        assert!(guard(0x62, 10, &without, 100, false).is_err(), "a code the monitor doesn't list");
    }

    /// Reads only (EDID, capabilities, current values) from the monitors attached to this PC; never writes.
    /// `cargo test --lib monitors::tests::live_reads -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_reads() {
        for m in list() {
            println!("{} {} primary={} {:?}", m.id, m.display, m.primary, m.edid);
            match capabilities(&m.id) {
                Ok(c) => {
                    println!("  model {:?} mccs {:?} codes {:x?}", c.model, c.mccs, c.vcp.keys().collect::<Vec<_>>());
                    let codes: Vec<u8> = allowed().iter().map(|a| a.code).chain(read_only().iter().copied()).collect();
                    for r in read(&m.id, &codes).unwrap_or_default() {
                        println!("  0x{:02x} = {} / {}  listed {:x?}", r.code, r.value, r.max, c.vcp.get(&r.code));
                    }
                }
                Err(e) => println!("  DDC/CI capabilities: {e}; brightness read: {:?}", read(&m.id, &[0x10]).map(|r| r.first().map(|x| (x.value, x.max)))),
            }
        }
    }

    /// Every vcp line of the TypeScript guard's cases gets the same verdict here.
    #[test]
    fn matches_the_typescript_guard() {
        let mut n = 0;
        for line in include_str!("../../src/lib/displays/display-cases.txt").lines().filter(|l| l.starts_with("vcp ")) {
            let p: Vec<&str> = line.split(' ').collect();
            let (code, value, max): (u8, u32, u32) = (p[1].parse().unwrap(), p[2].parse().unwrap(), p[3].parse().unwrap());
            let mut caps = Caps::default();
            // The cases' monitors list the same codes with values; "absent" codes aren't listed, "-" is continuous.
            for (c, v) in [(16u8, ""), (18, "")] {
                caps.vcp.insert(c, v.split(',').filter(|s| !s.is_empty()).map(|s| s.parse().unwrap()).collect());
            }
            if p[4] != "absent" {
                caps.vcp.insert(code, if p[4] == "-" { vec![] } else { p[4].split(',').map(|s| s.parse().unwrap()).collect() });
            }
            let got = guard(code, value, &caps, max, p[5] == "1");
            assert_eq!(got.is_ok(), p[6] == "1", "{line} -> {got:?}");
            n += 1;
        }
        assert!(n > 1000, "{n} cases");
    }

    #[test]
    fn interface_paths_give_the_device() {
        assert_eq!(
            device_of_interface(r"\\?\DISPLAY#AUS24AB#5&26dc660c&0&UID4352#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}"),
            Some(("AUS24AB".into(), "5&26dc660c&0&UID4352".into()))
        );
        assert_eq!(device_of_interface(r"\\?\USB#VID_046D"), None);
    }
}
