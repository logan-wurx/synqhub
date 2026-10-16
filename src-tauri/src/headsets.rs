//! Gaming headsets (protocols from HeadsetControl, https://github.com/Sapd/HeadsetControl, GPL-3.0): the models and
//! families in src/lib/headsets/headsets.json, and the Rust copy of src/lib/headsets/guard.ts. A frame passes only
//! when it is one SYNQ builds: a status read, or one setting at a value the app offers. The brand channels in
//! src/brands.rs open each family's collection and send every report through `check`; the test below holds this
//! guard to the TypeScript one, line for line, on headset-frames.txt.

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    SsNova7,
    LogiG535,
    LogiGpro,
    LogiG633,
    HyperxCloud2w,
}

impl Family {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "ss-nova7" => Self::SsNova7,
            "logi-g535" => Self::LogiG535,
            "logi-gpro" => Self::LogiGpro,
            "logi-g633" => Self::LogiG633,
            "hyperx-cloud2w" => Self::HyperxCloud2w,
            _ => return None,
        })
    }
    /// The whole report, report id included.
    fn length(self) -> usize {
        match self {
            Self::SsNova7 => 64,
            Self::LogiG535 | Self::LogiGpro | Self::LogiG633 => 20,
            Self::HyperxCloud2w => 52,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Model {
    pub family: Family,
    pub save_after_sidetone: bool,
    pub name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawModel {
    vid: String,
    pid: String,
    family: String,
    name: String,
    #[serde(default)]
    save_after_sidetone: bool,
}

#[derive(Deserialize)]
struct Table {
    models: Vec<RawModel>,
}

fn table() -> &'static HashMap<(u16, u16), Model> {
    static T: OnceLock<HashMap<(u16, u16), Model>> = OnceLock::new();
    T.get_or_init(|| {
        let t: Table = serde_json::from_str(include_str!("../../src/lib/headsets/headsets.json")).expect("headsets.json");
        t.models
            .into_iter()
            .filter_map(|m| {
                let vid = u16::from_str_radix(&m.vid, 16).ok()?;
                let pid = u16::from_str_radix(&m.pid, 16).ok()?;
                Some(((vid, pid), Model { family: Family::parse(&m.family)?, save_after_sidetone: m.save_after_sidetone, name: m.name }))
            })
            .collect()
    })
}

pub fn model(vid: u16, pid: u16) -> Option<&'static Model> {
    table().get(&(vid, pid))
}

pub fn is_family(vid: u16, pid: u16, family: Family) -> bool {
    model(vid, pid).is_some_and(|m| m.family == family)
}

/// The headset's name in the device list ("SteelSeries Arctis Nova 7"), from the same table.
pub fn name(vid: u16, pid: u16) -> Option<String> {
    let brand = match vid {
        0x1038 => "SteelSeries",
        0x046d => "Logitech",
        0x03f0 => "HyperX",
        _ => "",
    };
    model(vid, pid).map(|m| format!("{brand} {}", m.name).trim().to_string())
}

const PERCENT: [u8; 11] = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const LOGI_OFF: [u8; 7] = [0, 1, 2, 5, 10, 15, 30];
const NOVA_OFF: [u8; 8] = [0, 1, 5, 10, 15, 30, 60, 90];
const HYPERX_OFF: [u8; 7] = [0, 5, 10, 15, 20, 30, 60];
/// The Arctis Nova 7's four EQ presets as sent: 0x14 + gain, truncated (src/lib/headsets/protocol.ts NOVA_EQ_PRESETS).
const NOVA_EQ: [[u8; 10]; 4] = [
    [20, 20, 20, 20, 20, 20, 20, 20, 20, 20],
    [23, 25, 24, 21, 18, 18, 19, 19, 19, 19],
    [15, 16, 19, 16, 17, 24, 26, 16, 20, 20],
    [23, 23, 21, 18, 16, 16, 17, 21, 23, 24],
];

fn zero_from(d: &[u8], at: usize) -> bool {
    d.get(at..).is_none_or(|s| s.iter().all(|&b| b == 0))
}

fn refuse(d: &[u8], why: &str) -> Result<&'static str, String> {
    let head: Vec<String> = d.iter().take(8).map(|b| format!("{b:02x}")).collect();
    Err(format!("Refused: {} ... isn't a headset frame SYNQ builds ({why}).", head.join(" ")))
}

/// One report to a headset: `data` is the report without its id (shorter data counts as zero-padded).
pub fn check(m: &Model, report_id: u8, data: &[u8]) -> Result<&'static str, String> {
    let len = m.family.length() - 1;
    if data.len() > len {
        return refuse(data, "too long");
    }
    let mut d = data.to_vec();
    d.resize(len, 0);
    match m.family {
        Family::SsNova7 => {
            if report_id != 0 {
                return refuse(&d, "report 0 only");
            }
            match d[0] {
                0xb0 if zero_from(&d, 1) => Ok("read"),
                0x39 if d[1] <= 3 && zero_from(&d, 2) => Ok("sidetone"),
                0x09 if m.save_after_sidetone && zero_from(&d, 1) => Ok("sidetone"),
                0xa3 if NOVA_OFF.contains(&d[1]) && zero_from(&d, 2) => Ok("autoOff"),
                0xae if d[1] <= 3 && zero_from(&d, 2) => Ok("micLight"),
                0x3a if d[1] <= 1 && zero_from(&d, 2) => Ok("limiter"),
                0x33 if NOVA_EQ.iter().any(|p| d[1..11] == p[..]) && zero_from(&d, 11) => Ok("eqPreset"),
                _ => refuse(&d, "not a Nova 7 read or setting"),
            }
        }
        Family::LogiG535 | Family::LogiGpro | Family::LogiG633 => {
            if report_id != 0x11 || d[0] != 0xff {
                return refuse(&d, "HID++ long report to the receiver only");
            }
            let (read, sidetone, second): ((u8, u8), (u8, u8), Option<(u8, u8)>) = match m.family {
                Family::LogiG535 => ((0x05, 0x0d), (0x04, 0x1d), Some((0x05, 0x2d))),
                Family::LogiGpro => ((0x06, 0x0d), (0x05, 0x1a), Some((0x07, 0x21))),
                _ => ((0x08, 0x0a), (0x07, 0x1a), None),
            };
            let op = (d[1], d[2]);
            if op == read && zero_from(&d, 3) {
                return Ok("read");
            }
            if op == sidetone && PERCENT.contains(&d[3]) && zero_from(&d, 4) {
                return Ok("sidetone");
            }
            if second == Some(op) && LOGI_OFF.contains(&d[3]) && zero_from(&d, 4) {
                return Ok("autoOff");
            }
            if m.family == Family::LogiG633 && op == (0x04, 0x3c) && d[3] <= 1 && (d[4] == 0 || d[4] == 2) && d[5..12] == [0x00, 0xb6, 0xff, 0x0f, 0xa0, 0x00, 0x64] && zero_from(&d, 12) {
                return Ok("lights");
            }
            refuse(&d, "not a read or setting of this Logitech headset")
        }
        Family::HyperxCloud2w => {
            if report_id != 6 || d[0] != 0xff || d[1] != 0xbb {
                return refuse(&d, "report 6, ff bb commands only");
            }
            match d[2] {
                0x02 | 0x03 | 0x07 if zero_from(&d, 3) => Ok("read"),
                0x22 if HYPERX_OFF.contains(&d[3]) && zero_from(&d, 4) => Ok("autoOff"),
                _ => refuse(&d, "not a Cloud II Wireless read or setting"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// Every line of the TypeScript guard's fixture gets the same verdict here.
    #[test]
    fn matches_the_typescript_guard_line_for_line() {
        let mut passed = 0;
        let mut refused = 0;
        for line in include_str!("../../src/lib/headsets/headset-frames.txt").lines().filter(|l| !l.is_empty()) {
            let p: Vec<&str> = line.split_whitespace().collect();
            let (verdict, vid, pid, report) = (p[0] == "1", u16::from_str_radix(p[1], 16).unwrap(), u16::from_str_radix(p[2], 16).unwrap(), u8::from_str_radix(p[3], 16).unwrap());
            let m = model(vid, pid).unwrap_or_else(|| panic!("{vid:04x}:{pid:04x} in the table"));
            let got = check(m, report, &unhex(p.get(4).copied().unwrap_or("")));
            assert_eq!(got.is_ok(), verdict, "{line} -> {got:?}");
            if verdict { passed += 1 } else { refused += 1 }
        }
        assert!(passed >= 60 && refused >= 300, "{passed} allowed, {refused} refused");
    }

    #[test]
    fn the_table_loads_and_names_its_headsets() {
        assert!(model(0x1038, 0x2202).is_some_and(|m| m.family == Family::SsNova7 && !m.save_after_sidetone));
        assert!(model(0x1038, 0x227e).is_some_and(|m| m.save_after_sidetone));
        assert!(model(0x046d, 0x0ac4).is_some_and(|m| m.family == Family::LogiG535));
        assert_eq!(name(0x03f0, 0x0696).as_deref(), Some("HyperX Cloud II Wireless"));
        assert!(model(0x046d, 0xc0a0).is_none(), "the DEX is a mouse, not a headset");
    }

    #[test]
    fn longer_frames_and_other_reports_are_refused() {
        let nova = model(0x1038, 0x2202).unwrap();
        assert!(check(nova, 0, &[0xb0]).is_ok());
        assert!(check(nova, 0, &[0u8; 64]).is_err(), "longer than the report");
        assert!(check(nova, 6, &[0x09]).is_err(), "the Bluetooth save isn't SYNQ's");
        assert!(check(nova, 0, &[0x09]).is_err(), "no save on a model that doesn't need it");
        assert!(check(model(0x1038, 0x227e).unwrap(), 0, &[0x09]).is_ok());
    }
}
