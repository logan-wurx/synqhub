//! Keyboards whose configuration channel the bridge opens for a brand driver, and the Rust copy of each
//! driver's frame allowlist (the last line of defence; the first is the TypeScript guard). Every guard
//! here mirrors one TS guard and is tested against that guard's frame fixture:
//!
//! | brand            | ids (brand_ids.rs)  | collection     | access        | report | bytes | TS guard |
//! |------------------|---------------------|----------------|---------------|--------|-------|----------|
//! | Sonix (FCC)      | SONIX (75)          | FF68:0061      | output+input  | 0      | 64    | src/lib/kb/fcc/sonix-protocol.ts checkFrame |
//! | MonsGeek / Akko  | MONSGEEK (10)       | FFFF:0002      | feature only  | 0      | 64    | src/lib/brands/monsgeek/guard.ts classifyFrame(f, "any") |
//! | DrunkDeer        | DRUNKDEER (13), X60 | FF00, any usage| output+input  | 4      | 63    | src/lib/brands/drunkdeer/guard.ts DRUNKDEER_GUARD |
//! | MCHOSE gen 1     | FW19F5_MCHOSE (31)  | 0001:0000      | output+input  | 0      | 64    | src/lib/brands/fw19f5/guard.ts classifyFrame(f, "mchose") |
//! | DrunkDeer gen 2  | FW19F5_DRUNKDEER (7)| 0001:0000      | output+input  | 0      | 64    | classifyFrame(f, "drunkdeer") |
//! | NuPhy V3 / HE    | FW19F5_NUPHY (38)   | 0001:0000      | output+input  | 0      | 64    | classifyFrame(f, "readonly") (info + base reads only) |
//! | RK Gcome         | FW19F5_RK_GCOME (9) | 0001:0000      | output+input  | 0      | 64    | classifyFrame(f, "readonly") |
//! | Royal Kludge BeiYing | RK_BEIYING (168) | 0001:0080 (System Control) | feature only | 0x0A | 64 | src/lib/brands/rk-beiying/guard.ts RK_BEIYING_GUARD (write-only: lighting and key-map reports) |
//! | SparkLink        | SPARKLINK (56)      | FFA0:0001      | output+input  | 0      | 64    | src/lib/brands/sparklink/guard.ts classifyFrame (RK C / M75 HE, AULA HE, Kochi) |
//! | Bytech (Redragon)| BYTECH (1)          | FF00, any usage| output+input  | 9      | 63    | src/lib/kb/analogsense/protocol.ts checkAnalogFrame("bytech") |
//! | Razer analog kb  | RAZER_KEYBOARDS (11)+mice (2) | 000C:0001 | feature only | 0 | 90 | src/lib/brands/razer/guard.ts classifyRazerFrame |
//! | ASUS Gear Link   | asus-rules.json families (not 1D1D, not bootloaders) | kb FF00:0001, mice FF01:0001 | output+input | 0 / 2 | 63-64 | src/lib/brands/asus/guard.ts (rules in asus-rules.json) |
//! | Corsair Bragi    | CORSAIR_BRAGI_KEYBOARDS (17) + mice (10) | FF42:0001 | output+input | 0 | descriptor (64) | src/lib/brands/corsair/guard.ts classifyBragiFrame (open file tracked here) |
//! | Corsair Sabre v2 | CORSAIR_SABRE (6)   | FF02:0002      | output+input  | 8      | 16    | src/lib/brands/corsair/sabre.ts classifySabreFrame |
//! | Corsair iCUE     | ICUE_KEYBOARDS (10) + mice (6) | FF42:0001 | output+input | 0 | 64 | src/lib/brands/corsair-icue/guard.ts |
//! | Logitech G kb    | LOGITECH_KEYBOARDS (10) | FF00 / FF43, any usage | output+input | 10/11/12 | 6/19/63 | src/lib/brands/logitech-kb/guard.ts (feature map learned here from IRoot replies) |
//! | SteelSeries Apex | STEELSERIES (17, never PID+1) | FFC0:0001 | output+feature | 0 | 64 / 641-644 | src/lib/brands/steelseries/guard.ts STEELSERIES_GUARD |
//! | Headsets (HeadsetControl) | src/lib/headsets/headsets.json (27) | Nova 7 FFC0:0001, G535 000C:0001, G PRO / G633 FF43:0202, Cloud II FF90:0303 | output+input | 0 / 0x11 / 6 | 64 / 20 / 52 | src/lib/headsets/guard.ts checkHeadsetFrame (src/headsets.rs) |
//!
//! For one of these ids the bridge opens only that brand's collections and nothing else (not even a
//! vendor collection an OpenMouse filter would otherwise allow), and every report to it passes its guard.
//! Ids OpenMouse pins one by one stay with OpenMouse. The user's Falchion ZywOo (0B05:1D1D) is never a
//! brand device: it keeps its own panel. "mouse" rows are opened for a driver but not listed yet.
//! The 0x19F5 family is configured on Generic Desktop 0001:0000 (usage 0, "undefined"): that is the one
//! input-page collection a brand channel opens for an output+input protocol. It is exactly that usage for
//! exactly those ids; the same board's keyboard (0001:0006), mouse (0001:0002), system-control (0001:0080)
//! and consumer collections stay closed like every other brand's.
//! The other input-page exception is Royal Kludge's BeiYing boards, whose software configures them through the
//! System Control collection 0001:0080 with feature reports only (no input, no output report, never a read-back
//! the board could answer): exactly that collection for exactly those ids; their keyboard collection stays closed.
//!
//! Adding a brand: add its ids to scripts/gen-brand-bridge.ts, a guard function here mirroring its TS
//! guard, a row in `CHANNELS`, and a test against its fixture. Nothing else in hid.rs needs to change.

use crate::brand_ids as ids;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

/// A stateless guard: Ok(what the frame is) or Err(why it's refused). `data` is the report without its id.
pub type Simple = fn(report_id: u8, data: &[u8]) -> Result<&'static str, String>;

/// A stateless guard that also reads the Advanced scopes the person has confirmed for this device
/// (src/advanced.rs). With `Active::NONE` it must give exactly the verdicts of the guard it extends.
pub type SimpleAdv = fn(report_id: u8, data: &[u8], active: crate::advanced::Active) -> Result<&'static str, String>;

/// How a report travels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    Output,
    Feature,
}

/// What a channel takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Takes {
    /// Output reports out, input reports in; no feature reports.
    Output,
    /// Feature reports only (set and get); no reader, nothing read or written otherwise.
    Feature,
    /// Output and feature reports, input reports in (SteelSeries: 64-byte output, 641..644-byte feature).
    Both,
}

/// How the 0x19F5 family is guarded (src/lib/brands/fw19f5/guard.ts GuardFamily).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FwFamily {
    /// MCHOSE gen 1: info/base/function/trigger reads, function-config and key-trigger writes.
    Mchose,
    /// DrunkDeer gen 2: the same reads, key-trigger writes (the last chunk may carry flag 1).
    DrunkDeer,
    /// NuPhy and Royal Kludge Gcome: the info and base reads only.
    ReadOnly,
}

#[derive(Clone, Copy)]
pub enum Guard {
    Simple(Simple),
    /// A `Simple` guard with Advanced frames behind a live grant (Sonix: calibration and factory reset).
    Advanced(SimpleAdv),
    /// ASUS Gear Link rules (src/lib/brands/asus/asus-rules.json), by the device's family.
    Asus,
    /// Corsair Bragi, with the open file remembered per device.
    Bragi,
    /// Corsair Sabre v2 EEPROM protocol.
    Sabre,
    /// Corsair iCUE BRAGI lighting.
    Icue,
    /// Logitech G keyboards over HID++ 2.0, with the feature map learned from IRoot replies.
    LogitechKb,
    /// SteelSeries Apex (model scope in steelseries-scope.json).
    SteelSeries,
    /// The 0x19F5 firmware family (MCHOSE, DrunkDeer gen 2, NuPhy, Royal Kludge Gcome).
    Fw19f5(FwFamily),
    /// A gaming headset (src/headsets.rs), by vendor id: the model decides the frames.
    Headset(u16),
}

pub struct Channel {
    pub brand: &'static str,
    /// "keyboard" is listed in the device list; "mouse" is opened but not listed (no panel yet).
    pub kind: &'static str,
    pub ids: fn(u16, u16) -> bool,
    /// The collections this brand talks on: (usage page, usage or None for any usage on that page).
    pub collections: &'static [(u16, Option<u16>)],
    pub takes: Takes,
    pub report_ids: &'static [u8],
    /// Buffer for a feature read, report id included.
    pub feature_size: usize,
    pub guard: Guard,
    /// A further identity check on the product string, for ids on a borrowed vendor id.
    pub name_ok: Option<fn(&str) -> bool>,
}

fn sonix_id(v: u16, p: u16) -> bool {
    ids::SONIX.contains(&(v, p))
}
fn monsgeek_id(v: u16, p: u16) -> bool {
    ids::MONSGEEK.contains(&(v, p))
}
fn drunkdeer_id(v: u16, p: u16) -> bool {
    ids::DRUNKDEER.contains(&(v, p))
}
fn x60_id(v: u16, p: u16) -> bool {
    ids::DRUNKDEER_X60.contains(&(v, p))
}
fn fw_mchose_id(v: u16, p: u16) -> bool {
    ids::FW19F5_MCHOSE.contains(&(v, p))
}
fn fw_drunkdeer_id(v: u16, p: u16) -> bool {
    ids::FW19F5_DRUNKDEER.contains(&(v, p))
}
fn fw_nuphy_id(v: u16, p: u16) -> bool {
    ids::FW19F5_NUPHY.contains(&(v, p))
}
fn fw_rk_gcome_id(v: u16, p: u16) -> bool {
    ids::FW19F5_RK_GCOME.contains(&(v, p))
}
fn rk_beiying_id(v: u16, p: u16) -> bool {
    ids::RK_BEIYING.contains(&(v, p))
}
fn sparklink_id(v: u16, p: u16) -> bool {
    ids::SPARKLINK.contains(&(v, p))
}
fn bytech_id(v: u16, p: u16) -> bool {
    ids::BYTECH.contains(&(v, p))
}
fn razer_kb_id(v: u16, p: u16) -> bool {
    v == 0x1532 && ids::RAZER_KEYBOARDS.contains(&p)
}
fn razer_mouse_id(v: u16, p: u16) -> bool {
    v == 0x1532 && ids::RAZER_BRAND_MICE.contains(&p)
}
const FALCHION_ZYWOO: u16 = 0x1d1d;
fn asus_family(p: u16) -> Option<&'static str> {
    asus_rules().family.get(&p).map(|s| s.as_str())
}
fn asus_kb_id(v: u16, p: u16) -> bool {
    v == 0x0b05 && p != FALCHION_ZYWOO && !ids::ASUS_BOOTLOADER.contains(&p) && matches!(asus_family(p), Some("mech" | "hfx" | "he-v1" | "he-v2"))
}
fn asus_mouse_id(v: u16, p: u16) -> bool {
    v == 0x0b05 && !ids::ASUS_BOOTLOADER.contains(&p) && asus_family(p) == Some("mouse")
}
fn corsair_bragi_kb_id(v: u16, p: u16) -> bool {
    v == 0x1b1c && ids::CORSAIR_BRAGI_KEYBOARDS.contains(&p)
}
fn corsair_bragi_mouse_id(v: u16, p: u16) -> bool {
    v == 0x1b1c && ids::CORSAIR_BRAGI_MICE.contains(&p)
}
fn corsair_sabre_id(v: u16, p: u16) -> bool {
    v == 0x1b1c && ids::CORSAIR_SABRE.contains(&p)
}
fn icue_kb_id(v: u16, p: u16) -> bool {
    v == 0x1b1c && ids::ICUE_KEYBOARDS.contains(&p)
}
fn icue_mouse_id(v: u16, p: u16) -> bool {
    v == 0x1b1c && ids::ICUE_MICE.contains(&p)
}
fn logitech_kb_id(v: u16, p: u16) -> bool {
    v == 0x046d && ids::LOGITECH_KEYBOARDS.contains(&p)
}
fn steelseries_id(v: u16, p: u16) -> bool {
    v == 0x1038 && ids::STEELSERIES.contains(&p) && !ids::STEELSERIES_BOOTLOADER.contains(&p)
}
/// The X60's vendor id isn't DrunkDeer's: its product string must say so (as DrunkDeerSession.connect checks).
fn x60_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.contains("x60") || n.replace([' ', '-', '_'], "").contains("drunkdeer")
}

const OUT: Takes = Takes::Output;
const FEAT: Takes = Takes::Feature;

pub const CHANNELS: &[Channel] = &[
    Channel { brand: "Sonix", kind: "keyboard", ids: sonix_id, collections: &[(0xff68, Some(0x0061))], takes: OUT, report_ids: &[0], feature_size: 65, guard: Guard::Advanced(sonix_with), name_ok: None },
    Channel { brand: "MonsGeek", kind: "keyboard", ids: monsgeek_id, collections: &[(0xffff, Some(0x0002))], takes: FEAT, report_ids: &[0], feature_size: 65, guard: Guard::Simple(monsgeek), name_ok: None },
    Channel { brand: "DrunkDeer", kind: "keyboard", ids: drunkdeer_id, collections: &[(0xff00, None)], takes: OUT, report_ids: &[4], feature_size: 65, guard: Guard::Simple(drunkdeer), name_ok: None },
    Channel { brand: "DrunkDeer", kind: "keyboard", ids: x60_id, collections: &[(0xff00, None)], takes: OUT, report_ids: &[4], feature_size: 65, guard: Guard::Simple(drunkdeer), name_ok: Some(x60_name) },
    Channel { brand: "Bytech", kind: "keyboard", ids: bytech_id, collections: &[(0xff00, None)], takes: OUT, report_ids: &[9], feature_size: 65, guard: Guard::Simple(bytech), name_ok: None },
    Channel { brand: "Razer", kind: "keyboard", ids: razer_kb_id, collections: &[(0x000c, Some(0x0001))], takes: FEAT, report_ids: &[0], feature_size: 256, guard: Guard::Simple(razer), name_ok: None },
    Channel { brand: "Razer", kind: "mouse", ids: razer_mouse_id, collections: &[(0x000c, Some(0x0001))], takes: FEAT, report_ids: &[0], feature_size: 256, guard: Guard::Simple(razer), name_ok: None },
    // Wave 3a. ASUS: never FF13 / FF14 / FF15 (in-place firmware), never FFC0..FFC2 (key events).
    Channel { brand: "ASUS", kind: "keyboard", ids: asus_kb_id, collections: &[(0xff00, Some(0x0001))], takes: OUT, report_ids: &[0, 2], feature_size: 65, guard: Guard::Asus, name_ok: None },
    Channel { brand: "ASUS", kind: "mouse", ids: asus_mouse_id, collections: &[(0xff01, Some(0x0001))], takes: OUT, report_ids: &[0, 2], feature_size: 65, guard: Guard::Asus, name_ok: None },
    // Corsair: never FF42:0002 (key presses).
    Channel { brand: "Corsair", kind: "keyboard", ids: corsair_bragi_kb_id, collections: &[(0xff42, Some(0x0001))], takes: OUT, report_ids: &[0], feature_size: 65, guard: Guard::Bragi, name_ok: None },
    Channel { brand: "Corsair", kind: "mouse", ids: corsair_bragi_mouse_id, collections: &[(0xff42, Some(0x0001))], takes: OUT, report_ids: &[0], feature_size: 65, guard: Guard::Bragi, name_ok: None },
    Channel { brand: "Corsair", kind: "mouse", ids: corsair_sabre_id, collections: &[(0xff02, Some(0x0002))], takes: OUT, report_ids: &[8], feature_size: 65, guard: Guard::Sabre, name_ok: None },
    // Wave 4.
    Channel { brand: "Corsair iCUE", kind: "keyboard", ids: icue_kb_id, collections: &[(0xff42, Some(0x0001))], takes: OUT, report_ids: &[0], feature_size: 65, guard: Guard::Icue, name_ok: None },
    Channel { brand: "Corsair iCUE", kind: "mouse", ids: icue_mouse_id, collections: &[(0xff42, Some(0x0001))], takes: OUT, report_ids: &[0], feature_size: 65, guard: Guard::Icue, name_ok: None },
    Channel { brand: "Logitech", kind: "keyboard", ids: logitech_kb_id, collections: &[(0xff00, None), (0xff43, None)], takes: OUT, report_ids: &[0x10, 0x11, 0x12], feature_size: 65, guard: Guard::LogitechKb, name_ok: None },
    Channel { brand: "SteelSeries", kind: "keyboard", ids: steelseries_id, collections: &[(0xffc0, Some(0x0001))], takes: Takes::Both, report_ids: &[0], feature_size: 1024, guard: Guard::SteelSeries, name_ok: None },
    // Wave 4a. The 0x19F5 firmware family: Generic Desktop 0001:0000 only (never the keyboard, mouse or system-control collections).
    Channel { brand: "MCHOSE", kind: "keyboard", ids: fw_mchose_id, collections: &[(0x0001, Some(0x0000))], takes: OUT, report_ids: &[0], feature_size: 65, guard: Guard::Fw19f5(FwFamily::Mchose), name_ok: None },
    Channel { brand: "DrunkDeer", kind: "keyboard", ids: fw_drunkdeer_id, collections: &[(0x0001, Some(0x0000))], takes: OUT, report_ids: &[0], feature_size: 65, guard: Guard::Fw19f5(FwFamily::DrunkDeer), name_ok: None },
    Channel { brand: "NuPhy", kind: "keyboard", ids: fw_nuphy_id, collections: &[(0x0001, Some(0x0000))], takes: OUT, report_ids: &[0], feature_size: 65, guard: Guard::Fw19f5(FwFamily::ReadOnly), name_ok: None },
    Channel { brand: "Royal Kludge", kind: "keyboard", ids: fw_rk_gcome_id, collections: &[(0x0001, Some(0x0000))], takes: OUT, report_ids: &[0], feature_size: 65, guard: Guard::Fw19f5(FwFamily::ReadOnly), name_ok: None },
    // Wave 4e. RK BeiYing: System Control 0001:0080, feature reports only, report 0x0A.
    Channel { brand: "Royal Kludge", kind: "keyboard", ids: rk_beiying_id, collections: &[(0x0001, Some(0x0080))], takes: FEAT, report_ids: &[0x0a], feature_size: 65, guard: Guard::Simple(rk_beiying), name_ok: None },
    // Wave 4c. SparkLink (Royal Kludge C / M75 HE, AULA HE, Kochi): the vendor collection 0xFFA0:0x0001, output report 0.
    Channel { brand: "SparkLink", kind: "keyboard", ids: sparklink_id, collections: &[(0xffa0, Some(0x0001))], takes: OUT, report_ids: &[0], feature_size: 65, guard: Guard::Simple(sparklink), name_ok: None },
    // Gaming headsets (HeadsetControl's protocols): each family's one collection, nothing else on the device.
    Channel { brand: "SteelSeries", kind: "headset", ids: hs_nova7_id, collections: &[(0xffc0, Some(0x0001))], takes: OUT, report_ids: &[0], feature_size: 65, guard: Guard::Headset(0x1038), name_ok: None },
    Channel { brand: "Logitech", kind: "headset", ids: hs_g535_id, collections: &[(0x000c, Some(0x0001))], takes: OUT, report_ids: &[0x11], feature_size: 65, guard: Guard::Headset(0x046d), name_ok: None },
    Channel { brand: "Logitech", kind: "headset", ids: hs_logi_hidpp_id, collections: &[(0xff43, Some(0x0202))], takes: OUT, report_ids: &[0x11], feature_size: 65, guard: Guard::Headset(0x046d), name_ok: None },
    Channel { brand: "HyperX", kind: "headset", ids: hs_cloud2w_id, collections: &[(0xff90, Some(0x0303))], takes: OUT, report_ids: &[6], feature_size: 65, guard: Guard::Headset(0x03f0), name_ok: None },
];

fn hs_nova7_id(v: u16, p: u16) -> bool {
    crate::headsets::is_family(v, p, crate::headsets::Family::SsNova7)
}
fn hs_g535_id(v: u16, p: u16) -> bool {
    crate::headsets::is_family(v, p, crate::headsets::Family::LogiG535)
}
fn hs_logi_hidpp_id(v: u16, p: u16) -> bool {
    crate::headsets::is_family(v, p, crate::headsets::Family::LogiGpro) || crate::headsets::is_family(v, p, crate::headsets::Family::LogiG633)
}
fn hs_cloud2w_id(v: u16, p: u16) -> bool {
    crate::headsets::is_family(v, p, crate::headsets::Family::HyperxCloud2w)
}

/// An id OpenMouse's own table names one by one: its driver keeps it (a brand channel never takes it over).
fn openmouse_pinned(vendor_id: u16, product_id: u16) -> bool {
    crate::openmouse_ids::FILTERS.iter().any(|&(v, p, _, _)| v == vendor_id && p == Some(product_id))
}

/// Whether this vendor/product id belongs to a brand channel (then only that channel is ever opened).
pub fn device(vendor_id: u16, product_id: u16) -> Option<&'static Channel> {
    if openmouse_pinned(vendor_id, product_id) {
        return None;
    }
    CHANNELS.iter().find(|c| (c.ids)(vendor_id, product_id))
}

/// The brand channel this collection is, if it is one.
pub fn channel(vendor_id: u16, product_id: u16, usage_page: u16, usage: u16) -> Option<&'static Channel> {
    device(vendor_id, product_id).filter(|c| c.collections.iter().any(|&(page, u)| page == usage_page && u.is_none_or(|u| u == usage)))
}

/// Whether the device list shows this brand keyboard: a registered keyboard driver claims it. Every id
/// of the earlier brands; for ASUS, Corsair, Logitech and SteelSeries the ids in LISTED_KEYBOARDS (generated
/// from the drivers' own claims). The others are opened for a driver only, never listed.
pub fn listed(vendor_id: u16, product_id: u16) -> bool {
    !matches!(vendor_id, 0x0b05 | 0x1b1c | 0x046d | 0x1038) || ids::LISTED_KEYBOARDS.contains(&(vendor_id, product_id))
}

/// The name check passes (or the channel has none).
pub fn name_ok(c: &Channel, product: Option<&str>) -> bool {
    c.name_ok.is_none_or(|f| product.is_some_and(f))
}

/// What a guard remembers per open device.
pub struct State {
    pub product_id: u16,
    /// Corsair Bragi: the file opened by the last allowed 0x0D (cleared by 0x05).
    pub open_file: Option<u16>,
    /// Output report length from the descriptor (Corsair Bragi); 64 when unknown.
    pub out_len: usize,
    /// Logitech HID++: feature index -> feature id, learned from IRoot replies (the reader threads update it).
    pub logi: Arc<Mutex<Logi>>,
}

impl State {
    pub fn new(product_id: u16) -> Self {
        Self { product_id, open_file: None, out_len: 64, logi: Arc::new(Mutex::new(Logi::default())) }
    }
}

/// Checks one outgoing report to a brand channel: transport, report id, then the guard. The default
/// path: no Advanced action is unlocked (`check_with` takes the ones that are).
#[cfg_attr(not(test), allow(dead_code))]
pub fn check(c: &Channel, st: &mut State, transport: Transport, report_id: u8, data: &[u8]) -> Result<&'static str, String> {
    check_with(c, st, transport, report_id, data, crate::advanced::Active::NONE)
}

/// `check` with the Advanced scopes the person has confirmed for this device (src/advanced.rs). A guard
/// that has no Advanced frames ignores them; firmware, bootloader and DFU commands have no scope.
pub fn check_with(c: &Channel, st: &mut State, transport: Transport, report_id: u8, data: &[u8], active: crate::advanced::Active) -> Result<&'static str, String> {
    let ok_transport = matches!((c.takes, transport), (Takes::Both, _) | (Takes::Output, Transport::Output) | (Takes::Feature, Transport::Feature));
    if !ok_transport {
        return Err(format!("{} takes {} only.", c.brand, if c.takes == Takes::Feature { "feature reports" } else { "output reports" }));
    }
    if !c.report_ids.contains(&report_id) {
        return Err(format!("{} uses report {:?} (got {report_id}).", c.brand, c.report_ids));
    }
    match c.guard {
        Guard::Simple(g) => g(report_id, data),
        Guard::Advanced(g) => g(report_id, data, active),
        Guard::Asus => asus(st.product_id, data),
        Guard::Bragi => {
            let r = bragi(st.product_id, st.open_file, st.out_len, data);
            if r.is_ok() {
                bragi_observe(st, data);
            }
            r
        }
        Guard::Sabre => sabre(report_id, data),
        Guard::Icue => icue(report_id, data),
        Guard::LogitechKb => {
            let mut logi = st.logi.lock().map_err(|_| "HID++ state poisoned".to_string())?;
            logitech_kb(&mut logi, report_id, data)
        }
        Guard::Fw19f5(family) => fw19f5(family, report_id, data),
        Guard::SteelSeries => match ss_family(st.product_id) {
            Some(family) => steelseries(Some(family), transport, report_id, data),
            None => Err("Refused: not a SteelSeries keyboard in SYNQ's table.".into()),
        },
        Guard::Headset(vendor) => match crate::headsets::model(vendor, st.product_id) {
            Some(m) => crate::headsets::check(m, report_id, data),
            None => Err("Refused: not a headset in SYNQ's table.".into()),
        },
    }
}

fn zero_from(f: &[u8], from: usize) -> bool {
    f.get(from..).is_none_or(|s| s.iter().all(|&b| b == 0))
}
fn u16le(f: &[u8], at: usize) -> u16 {
    u16::from(f[at]) | u16::from(f[at + 1]) << 8
}
fn u16be(f: &[u8], at: usize) -> u16 {
    u16::from(f[at]) << 8 | u16::from(f[at + 1])
}
fn not_listed<T>(brand: &str, f: &[u8], why: &str) -> Result<T, String> {
    let head: Vec<String> = f.iter().take(8).map(|b| format!("{b:02x}")).collect();
    Err(format!("Refused: {} ... isn't a {brand} frame SYNQ builds ({why}).", head.join(" ")))
}

// ---------------------------------------------------------------------------------------------
// Sonix (FCC): 64-byte frames [AA, cmd, len, offset LE, 0, 0, 0, payload...]
// ---------------------------------------------------------------------------------------------

const SONIX_FORBIDDEN: [u8; 9] = [0x0f, 0x26, 0x62, 0x64, 0x65, 0x66, 0x67, 0xfb, 0xfc];
const SONIX_CHUNK: usize = 56;
const SONIX_MAX_HID: u8 = 0xe7;
const SONIX_MAX_TRAVEL: u16 = 400;
const SONIX_DKS_POINT_MAX: u8 = 40;
const SONIX_EFFECTS: [u8; 21] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 0x80];
const SONIX_SETTINGS_UNKNOWN: [usize; 9] = [0, 1, 2, 4, 6, 7, 10, 12, 13];
const SONIX_POLL_CODES: [u8; 3] = [3, 5, 6];
const SONIX_SOCD_MODES: [u8; 4] = [3, 1, 2, 4];
/// (name, read command, write command (0 = never written), region size, bytes written from offset 0)
const SONIX_REGIONS: [(&str, u8, u8, usize, usize); 9] = [
    ("info", 0x10, 0, 24, 0),
    ("settings", 0x11, 0x21, 32, 16),
    ("keys", 0x12, 0x22, 512, 512),
    ("led", 0x13, 0x23, 16, 16),
    ("colors", 0x14, 0x24, 512, 512),
    ("macros", 0x15, 0x25, 4008, 4008),
    ("fn", 0x16, 0, 512, 0),
    ("rt", 0x17, 0x27, 1024, 1024),
    ("dks", 0x18, 0x28, 1024, 1024),
];

fn sonix_binding_ok(t: u8, a: u8, b: u8, c: u8) -> bool {
    match t {
        0 => a == 0 && b == 0 && c == 0,
        1 => c == 0 && ((a == 1 && [1, 2, 4, 8, 16].contains(&b)) || (a == 3 && (b == 1 || b == 255))),
        2 => b <= SONIX_MAX_HID && c == 0,
        3 => {
            let usage = u16::from(a) | u16::from(b) << 8;
            (1..=0x3ff).contains(&usage) && c == 0
        }
        6 => a < 100 && b <= 2 && if b == 1 { c >= 1 } else { c == 0 },
        8 => (1..64).contains(&a) && b == 0 && c == 0,
        9 => a <= SONIX_MAX_HID && b <= SONIX_MAX_HID && c >= 1,
        10 => a <= SONIX_MAX_HID && b == 0 && c == 0,
        11 => SONIX_SOCD_MODES.contains(&a) && b <= SONIX_MAX_HID && c <= SONIX_MAX_HID,
        12 => a == 0 && b <= SONIX_MAX_HID && c <= SONIX_MAX_HID,
        _ => false,
    }
}

fn sonix_write_ok(name: &str, offset: usize, p: &[u8]) -> bool {
    match name {
        "settings" => {
            p[3] <= 30
                && (p[5] == 0 || SONIX_POLL_CODES.contains(&p[5]))
                && [11, 14, 15].iter().all(|&i| p[i] <= 1)
                && SONIX_SETTINGS_UNKNOWN.iter().all(|&i| p[i] == 0)
        }
        "keys" => p.chunks(4).all(|e| e.len() == 4 && sonix_binding_ok(e[0], e[1], e[2], e[3])),
        "led" => {
            SONIX_EFFECTS.contains(&p[0])
                && p[4] == 255
                && p[14] == 0xaa
                && p[15] == 0x55
                && [5, 6, 7, 12, 13].iter().all(|&i| p[i] == 0)
                && p[8] <= 1
                && p[11] <= 1
                && (1..=5).contains(&p[9])
                && (1..=5).contains(&p[10])
        }
        "colors" => p.chunks(4).enumerate().all(|(n, e)| {
            let index = (offset + n * 4) / 4;
            if index >= 126 { e.iter().all(|&b| b == 0) } else { e[0] as usize == index || e[0] == 0 }
        }),
        "macros" => {
            let mut i = 0;
            while i + 4 <= p.len() {
                if offset + i >= 400 {
                    break;
                }
                let addr = u32::from_le_bytes([p[i], p[i + 1], p[i + 2], p[i + 3]]);
                if addr != 0 && (addr < 400 || addr + 4 > 4008 || addr % 4 != 0) {
                    return false;
                }
                i += 4;
            }
            true
        }
        "rt" => p.chunks(8).all(|e| e.len() == 8 && e[1] <= 7 && u16le(e, 2) <= SONIX_MAX_TRAVEL && u16le(e, 4) <= SONIX_MAX_TRAVEL && u16le(e, 6) <= SONIX_MAX_TRAVEL),
        "dks" => p.iter().enumerate().all(|(i, &v)| {
            let field = (offset + i) & 15;
            !(field < 4 && v > SONIX_DKS_POINT_MAX) && !((4..12).contains(&field) && field % 2 == 0 && v != 0) && !((5..12).contains(&field) && field % 2 == 1 && v > SONIX_MAX_HID)
        }),
        _ => false,
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn sonix(report_id: u8, f: &[u8]) -> Result<&'static str, String> {
    sonix_with(report_id, f, crate::advanced::Active::NONE)
}

/// The Sonix frames an Advanced action can unlock, each in its one shape: travel calibration start
/// (0x64) and end (0x65) with "calibrate", the factory reset [0x0F, 0xFF] with "reset". The key-check
/// reset [0x0F, 0x05], the unknown 0x66 / 0x67, the Fn-layer write and the status command stay blocked.
fn sonix_unlocked(f: &[u8], active: crate::advanced::Active) -> Option<&'static str> {
    use crate::advanced::Scope;
    match f[1] {
        0x64 if active.has(Scope::Calibrate) && f[2] == 0 && zero_from(f, 3) => Some("calibration start"),
        0x65 if active.has(Scope::Calibrate) && f[2] == 0 && zero_from(f, 3) => Some("calibration end"),
        0x0f if active.has(Scope::Reset) && f[2] == 0xff && zero_from(f, 3) => Some("factory reset"),
        _ => None,
    }
}

/// `sonix` with the Advanced scopes live on the device.
pub fn sonix_with(report_id: u8, f: &[u8], active: crate::advanced::Active) -> Result<&'static str, String> {
    if report_id != 0 || f.len() != 64 {
        return Err(format!("Sonix frames are report 0, 64 bytes (got report {report_id}, {} bytes).", f.len()));
    }
    if f[0] != 0xaa {
        return not_listed("Sonix", f, "byte 0 must be 0xAA");
    }
    let cmd = f[1];
    if SONIX_FORBIDDEN.contains(&cmd) {
        if let Some(what) = sonix_unlocked(f, active) {
            return Ok(what);
        }
        return Err(format!("Blocked: Sonix command 0x{cmd:02x} (reset, calibration, Fn-layer write, status or a device event) is never sent."));
    }
    let len = f[2] as usize;
    let offset = u16le(f, 3) as usize;
    if f[5] != 0 || f[6] != 0 || f[7] != 0 {
        return not_listed("Sonix", f, "header bytes 5..7 must be 0");
    }
    if cmd == 0x00 {
        return if len == 4 && offset == 0 && zero_from(f, 8) { Ok("commit") } else { not_listed("Sonix", f, "commit shape") };
    }
    let Some(&(name, read, _write, size, write_len)) = SONIX_REGIONS.iter().find(|r| r.1 == cmd || (r.2 != 0 && r.2 == cmd)) else {
        return not_listed("Sonix", f, "unknown command");
    };
    let is_read = cmd == read;
    let span = if is_read { size } else { write_len };
    if offset % SONIX_CHUNK != 0 || offset >= span || len != SONIX_CHUNK.min(span - offset) || !zero_from(f, 8 + len) {
        return not_listed("Sonix", f, "chunk shape");
    }
    let payload = &f[8..8 + len];
    if is_read {
        return if payload.iter().all(|&b| b == 0) { Ok("region read") } else { not_listed("Sonix", f, "read payload must be 0") };
    }
    if sonix_write_ok(name, offset, payload) { Ok("region write") } else { Err(format!("Refused Sonix {name} write: a value SYNQ doesn't write.")) }
}

// ---------------------------------------------------------------------------------------------
// MonsGeek / Akko: 64-byte feature reports [cmd, p1..p6, checksum, data...]
// ---------------------------------------------------------------------------------------------

const MG_BLOCKED: [u8; 34] = [
    1, 2, 127, 172, 44, 48, 49, 67, 68, 195, 196, 80, 208, 28, 30, 156, 158, 254, 26, 29, 27, 18, 24, 25, 37, 41, 165, 169, 34, 39, 40, 246, 248, 122,
];
const MG_LIGHT_MODES: [u8; 22] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 23, 24];
const MG_READ_TABLES: [u8; 11] = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 254];
const MG_YC_READ_TABLES: [u8; 10] = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10];
const MG_U16_TABLES: [u8; 7] = [0, 1, 2, 3, 4, 6, 254];
const MG_KINDS: [u8; 6] = [0, 2, 3, 4, 5, 7];
/// TABLE_LIMITS: (table, min, max).
const MG_TABLE_LIMITS: [(u8, u16, u16); 7] = [(0, 1, 4000), (1, 1, 4000), (2, 1, 2500), (3, 1, 2500), (4, 1, 4000), (5, 1, 255), (6, 0, 1000)];

fn mg_variants(mode: u8) -> u8 {
    match mode {
        4 => 4,
        7 | 11 | 15 | 24 => 2,
        13 => 5,
        _ => 1,
    }
}
fn mg_entry_ok(e: &[u8]) -> bool {
    let (t, a, b, c) = (e[0], e[1], e[2], e[3]);
    match t {
        0 => b <= 0xe7 && c <= 0xe7,
        1 => a == 0 && (((240..=244).contains(&b) && c == 0) || (b == 245 && (c == 1 || c == 255))),
        3 => a == 0 && c <= 3,
        8 => a <= 0x0f && c == 0,
        9 => a <= 2 && b < 50 && c == 0,
        10 => a <= 0x3f && b == 0 && c == 0,
        13 => a <= 0x1f && b <= 0x0f && c == 0,
        19 => a <= 0x0f && b <= 0x0f && c == 0,
        _ => false,
    }
}
fn mg_params(f: &[u8], params: &[u8]) -> bool {
    (1..=6).all(|i| f[i] == params.get(i - 1).copied().unwrap_or(0))
}
fn mg_bare(f: &[u8]) -> bool {
    mg_params(f, &[]) && zero_from(f, 8)
}
fn mg_read_pages(table: u8, yc: bool) -> u8 {
    if table == 10 {
        8
    } else if yc {
        2
    } else if MG_U16_TABLES.contains(&table) {
        4
    } else {
        2
    }
}

fn mg_gen2(f: &[u8]) -> bool {
    let (c, b1, b2, b3, b4, b5, b6) = (f[0], f[1], f[2], f[3], f[4], f[5], f[6]);
    match c {
        0x8f | 0x80 | 0xe6 | 0x84 | 0x83 | 0x86 | 0x87 | 0x89 => mg_bare(f),
        0x04 => b1 < 4 && mg_params(f, &[b1]) && zero_from(f, 8),
        0x03 => b1 == 0 && b2 <= 6 && mg_params(f, &[0, b2]) && zero_from(f, 8),
        0x06 => b1 <= 10 && mg_params(f, &[b1]) && zero_from(f, 8),
        0x09 => b1 == 0 && b2 <= 3 && b3 <= 1 && b4 <= 5 && b5 <= 1 && b6 == 0 && zero_from(f, 8),
        0x07 => {
            let (variant, nibble) = (b4 >> 4, b4 & 0x0f);
            MG_LIGHT_MODES.contains(&b1)
                && b2 <= 4
                && b3 <= 4
                && zero_from(f, 9)
                && variant < mg_variants(b1)
                && if b1 == 13 { nibble == 0 } else { [1, 7, 8].contains(&nibble) }
        }
        0x8a => b1 < 4 && b2 == 0xff && b3 < 8 && b4 < 4 && b5 == 0 && b6 == 0 && zero_from(f, 8),
        0x0a => {
            if b1 >= 4 {
                return false;
            }
            if b2 == 0xff {
                if b3 >= 10 || b6 >= 4 {
                    return false;
                }
                let last = b3 == 9;
                let len = if last { 512 - 56 * 9 } else { 56 };
                b4 as usize == len && b5 == u8::from(last) && zero_from(f, 8 + len) && f[8..8 + len].chunks(4).all(mg_entry_ok)
            } else {
                b2 < 128 && b3 == 0 && b4 == 0 && b5 == 1 && b6 < 4 && mg_entry_ok(&f[8..12]) && zero_from(f, 12)
            }
        }
        0xe5 => MG_READ_TABLES.contains(&b1) && b2 == 1 && b3 < mg_read_pages(b1, false) && mg_params(f, &[b1, 1, b3]) && zero_from(f, 8),
        0x65 => {
            if b2 != 0 || b3 >= 128 || b4 > 1 || b5 != 0 || b6 != 0 {
                return false;
            }
            let v8 = f[8];
            match b1 {
                7 => v8 & 0x78 == 0 && MG_KINDS.contains(&(v8 & 0x07)) && zero_from(f, 9),
                9 => ((v8 < 128 && v8 != b3) || v8 == 255) && zero_from(f, 9),
                8 => zero_from(f, 12),
                t => match MG_TABLE_LIMITS.iter().find(|l| l.0 == t) {
                    Some(&(_, min, max)) => {
                        let wide = MG_U16_TABLES.contains(&t);
                        let v = if wide { u16::from(v8) | u16::from(f[9]) << 8 } else { u16::from(v8) };
                        (min..=max).contains(&v) && zero_from(f, if wide { 10 } else { 9 })
                    }
                    None => false,
                },
            }
        }
        _ => false,
    }
}

fn mg_yc500(f: &[u8]) -> bool {
    let (c, b1, b2, b3) = (f[0], f[1], f[2], f[3]);
    match c {
        0x8f | 0x80 | 0x85 | 0x86 | 0x87 | 0x91 => mg_bare(f),
        0x89 => b1 <= 31 && b2 < 8 && mg_params(f, &[b1, b2]) && zero_from(f, 8),
        0xe5 => MG_YC_READ_TABLES.contains(&b1) && b2 == 1 && b3 < mg_read_pages(b1, true) && mg_params(f, &[b1, 1, b3]) && zero_from(f, 8),
        _ => false,
    }
}

pub fn monsgeek(report_id: u8, f: &[u8]) -> Result<&'static str, String> {
    if report_id != 0 || f.len() != 64 {
        return Err(format!("MonsGeek frames are feature report 0, 64 bytes (got report {report_id}, {} bytes).", f.len()));
    }
    if MG_BLOCKED.contains(&f[0]) {
        return Err(format!("Blocked: MonsGeek command 0x{:02x} (firmware, bootloader, reset, calibration, identity, device mode or pairing).", f[0]));
    }
    let at = if f[0] == 0x07 { 8 } else { 7 };
    let sum = f[..at].iter().fold(0u32, |s, &b| s + u32::from(b));
    if f[at] != 255 - (sum & 0xff) as u8 {
        return Err(format!("Refused: bad MonsGeek checksum at byte {at}."));
    }
    if mg_gen2(f) || mg_yc500(f) { Ok("monsgeek frame") } else { not_listed("MonsGeek", f, "not a frame SYNQ builds") }
}

// ---------------------------------------------------------------------------------------------
// DrunkDeer: output report 4, 63 bytes [cmd, sub, ...]
// ---------------------------------------------------------------------------------------------

/// (sub, legacy+oldHighPrec range, newHighPrec range) per key field: actuation, downstroke, upstroke.
const DD_FIELDS: [(u8, (u8, u8), (u16, u16)); 3] = [(1, (2, 200), (40, 660)), (4, (0, 200), (0, 620)), (5, (0, 200), (0, 620))];
const DD_PRESETS: [u8; 20] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 240];
const DD_SLOTS: u8 = 126;

pub fn drunkdeer(report_id: u8, f: &[u8]) -> Result<&'static str, String> {
    if report_id != 4 || f.len() != 63 {
        return Err(format!("DrunkDeer frames are report 4, 63 bytes (got report {report_id}, {} bytes).", f.len()));
    }
    let bool01 = |v: u8| v <= 1;
    let (c, s) = (f[0], f[1]);
    let ok = |cond: bool, what: &'static str| if cond { Ok(what) } else { not_listed("DrunkDeer", f, what) };
    match c {
        0xf9 => Err("Blocked: DrunkDeer firmware upgrade (0xF9).".into()),
        0xaa => Err("Blocked: DrunkDeer reset / clear RTP (0xAA).".into()),
        0xa7 | 0xa8 => Err("Blocked: DrunkDeer RTP authority (0xA7 / 0xA8).".into()),
        0xab => Err("Blocked: DrunkDeer delete profile (0xAB).".into()),
        0xfb => Err("Blocked: DrunkDeer profile switch (0xFB).".into()),
        0xc1 | 0xc2 => Err("Blocked: DrunkDeer knob remap / LED strip.".into()),
        0xa0 => {
            if s == 0x02 && f[2] == 0x04 {
                return Err("Blocked: DrunkDeer keymap layer write (0xA0 02 04).".into());
            }
            ok(s == 0x02 && zero_from(f, 2), "identity")
        }
        0xa2 => {
            if s != 0 {
                return Err("Blocked: DrunkDeer set profile count (0xA2 n).".into());
            }
            ok(zero_from(f, 2), "profile count")
        }
        0xb5 => ok(
            s == 0 && f[2] == 0x1e && f[3] == 1 && f[4] == 0 && f[5] == 0 && f[6] == 1 && bool01(f[7]) && bool01(f[8]) && f[9] == 0 && f[10] <= 3 && bool01(f[11]) && zero_from(f, 12),
            "common switch",
        ),
        0xb6 => {
            if s == 3 {
                return ok(f[2] <= 1 && zero_from(f, 3), "keystroke tracking");
            }
            let Some(&(_, (lo, hi), _)) = DD_FIELDS.iter().find(|x| x.0 == s) else { return not_listed("DrunkDeer", f, "key field") };
            if f[2] != 0 || f[3] > 2 {
                return not_listed("DrunkDeer", f, "key batch");
            }
            let n = if f[3] < 2 { 59 } else { 8 };
            ok((0..n).all(|i| (lo..=hi).contains(&f[4 + i])) && zero_from(f, 4 + n), "key batch")
        }
        0xfd => match s {
            3 => ok(f[2] <= 1 && zero_from(f, 3), "keystroke tracking"),
            7 => ok([1, 3, 4].contains(&f[2]) && zero_from(f, 3), "per-key read-back"),
            12 => ok([0, 1, 2, 255].contains(&f[2]) && zero_from(f, 3), "auto-match"),
            _ => {
                let Some(&(_, _, (lo, hi))) = DD_FIELDS.iter().find(|x| x.0 == s) else { return not_listed("DrunkDeer", f, "key field") };
                if f[2] > 4 {
                    return not_listed("DrunkDeer", f, "key batch");
                }
                let n = if f[2] < 4 { 30 } else { 6 };
                ok((0..n).all(|i| (lo..=hi).contains(&u16le(f, 3 + i * 2))) && zero_from(f, 3 + n * 2), "key batch")
            }
        },
        0xfc => match s {
            11 => ok(bool01(f[2]) && zero_from(f, 3), "last-win replace"),
            10 => ok(f[2] <= 3 && zero_from(f, 3), "pair table mode"),
            5 | 7 => ok(zero_from(f, 2), "pair read-back"),
            1 => {
                let n = f[3] as usize;
                if f[2] != 0 || n > 14 {
                    return not_listed("DrunkDeer", f, "last-win pairs");
                }
                ok(
                    (0..n).all(|i| {
                        let e = 4 + i * 4;
                        f[e] < DD_SLOTS && f[e + 1] < DD_SLOTS && f[e] != f[e + 1] && f[e + 2] == 0 && f[e + 3] == 0
                    }) && zero_from(f, 4 + n * 4),
                    "last-win pairs",
                )
            }
            3 => {
                let n = f[2] as usize;
                if n > 7 {
                    return not_listed("DrunkDeer", f, "RDT pairs");
                }
                ok(
                    (0..n).all(|i| {
                        let e = 3 + i * 8;
                        f[e] < DD_SLOTS
                            && f[e + 1] < DD_SLOTS
                            && f[e] != f[e + 1]
                            && (10..=50).contains(&u16le(f, e + 2))
                            && (300..=500).contains(&u16le(f, e + 4))
                            && f[e + 6] == 0
                            && f[e + 7] == 0
                    }) && zero_from(f, 3 + n * 8),
                    "RDT pairs",
                )
            }
            _ => not_listed("DrunkDeer", f, "pairs sub-command"),
        },
        0xae => {
            if s != 1 {
                return not_listed("DrunkDeer", f, "lighting");
            }
            if f[5] == 0x06 && f[7] == 0xff {
                return Err("Blocked: DrunkDeer per-key custom light stream (soft-brick risk).".into());
            }
            if f[5] > 9 || f[6] > 9 {
                return Err("Blocked: DrunkDeer lighting level above 9 (soft-brick risk).".into());
            }
            ok(f[2] == 0 && f[3] == 0 && DD_PRESETS.contains(&f[4]) && f[7] < 8 && zero_from(f, 8), "lighting mode")
        }
        _ => not_listed("DrunkDeer", f, "command"),
    }
}

// ---------------------------------------------------------------------------------------------
// The 0x19F5 firmware family: output report 0, 64 bytes [0x55, cmd, 0, checksum, len, offset lo, offset hi, flag, data...]
// ---------------------------------------------------------------------------------------------

const FW_CHUNK: usize = 56;
const FW_PROFILES: usize = 4;
const FW_FUNC_BLOCK: usize = 64;
const FW_TRIGGER_BLOCK: usize = 1024;
const FW_TRIGGER_BYTES: usize = 8;
const FW_MAX_KEYS: usize = 128;
/// Function-block byte positions with a known range (src/lib/brands/fw19f5/protocol.ts FUNC).
const FW_FUNC_EFFECT: usize = 8;
const FW_FUNC_BRIGHTNESS: usize = 9;
const FW_FUNC_SPEED: usize = 10;

fn fw_checksum(f: &[u8]) -> u8 {
    f.iter().skip(4).fold(0u8, |a, &b| a.wrapping_add(b))
}

/// A key-trigger record the table can hold: byte 0's high nibble is 0xA, both precision codes are 0..2.
fn fw_record_ok(f: &[u8], at: usize) -> bool {
    f[at] & 0xf0 == 0xa0 && (f[at + 3] >> 3) & 3 <= 2 && (f[at + 3] >> 1) & 3 <= 2
}

/// Function-block bytes that have a range; every other byte is written back as the board reported it.
fn fw_func_bytes_ok(rel: usize, f: &[u8]) -> bool {
    (0..f[4] as usize).all(|j| {
        let (pos, v) = (rel + j, f[8 + j]);
        !(pos == FW_FUNC_EFFECT && v > 22 && v != 255) && !(pos == FW_FUNC_BRIGHTNESS && v > 100) && !(pos == FW_FUNC_SPEED && v > 4)
    })
}

/// Mirror of src/lib/brands/fw19f5/guard.ts `classifyStatic` for one family.
pub fn fw19f5(family: FwFamily, report_id: u8, f: &[u8]) -> Result<&'static str, String> {
    if report_id != 0 || f.len() != 64 {
        return Err(format!("These keyboards take report 0, 64 bytes (got report {report_id}, {} bytes).", f.len()));
    }
    let bad = |why: &str| not_listed("0x19F5-family", f, why);
    if f[0] != 0x55 || f[2] != 0 || f[4] < 1 || f[4] as usize > FW_CHUNK || f[3] != fw_checksum(f) {
        return bad("envelope");
    }
    let (cmd, len, flag) = (f[1], f[4] as usize, f[7]);
    let offset = usize::from(u16le(f, 5));
    match cmd {
        238 => return Err("Blocked: factory reset (area 238).".into()),
        9 | 11 | 13 | 165 | 167 => return Err("Blocked: key map / colour / macro / mod-tap / toggle write.".into()),
        _ => {}
    }
    let block = |size: usize| -> Option<usize> { (offset / size < FW_PROFILES).then(|| offset % size) };
    match cmd {
        3 | 4 => {
            if flag == 0 && offset == 0 && zero_from(f, 8) {
                Ok(if cmd == 3 { "info" } else { "base" })
            } else {
                bad("info / base read")
            }
        }
        5 | 160 => {
            if family == FwFamily::ReadOnly {
                return Err("Blocked: NuPhy and Royal Kludge boards are only asked for their firmware version.".into());
            }
            let size = if cmd == 5 { FW_FUNC_BLOCK } else { FW_TRIGGER_BLOCK };
            match block(size) {
                Some(rel) if flag == 0 && rel + len <= size && zero_from(f, 8) => Ok(if cmd == 5 { "function config" } else { "key triggers" }),
                _ => bad("read"),
            }
        }
        6 => {
            if family != FwFamily::Mchose {
                return Err("Blocked: only MCHOSE boards take function-config writes.".into());
            }
            match block(FW_FUNC_BLOCK) {
                Some(rel) if flag == 0 && len == FW_CHUNK && (rel == 0 || rel == FW_FUNC_BLOCK - FW_CHUNK) && zero_from(f, 8 + len) && fw_func_bytes_ok(rel, f) => Ok("function config"),
                _ => bad("function-config write"),
            }
        }
        161 => {
            if family == FwFamily::ReadOnly {
                return Err("Blocked: NuPhy and Royal Kludge boards are never written.".into());
            }
            let Some(rel) = block(FW_TRIGGER_BLOCK) else { return bad("key-trigger write") };
            if len % FW_TRIGGER_BYTES != 0 || rel % FW_TRIGGER_BYTES != 0 || rel + len > FW_TRIGGER_BLOCK || !zero_from(f, 8 + len) {
                return bad("key-trigger write");
            }
            if flag != 0 && !(flag == 1 && family == FwFamily::DrunkDeer) {
                return bad("key-trigger write flag");
            }
            if rel / FW_TRIGGER_BYTES + len / FW_TRIGGER_BYTES > FW_MAX_KEYS || !(0..len / FW_TRIGGER_BYTES).all(|i| fw_record_ok(f, 8 + i * FW_TRIGGER_BYTES)) {
                return bad("key-trigger record");
            }
            Ok("key triggers")
        }
        _ => bad("area"),
    }
}

// ---------------------------------------------------------------------------------------------
// Royal Kludge BeiYing boards: feature report 0x0A, 64 data bytes, write-only (lighting and the nine key-map reports)
// ---------------------------------------------------------------------------------------------

const RK_MAP_REPORTS: u8 = 9;

/// Bytes of key data in report n (1-based): 60 in the first, 62 in the rest.
fn rk_chunk(n: u8) -> usize {
    if n == 1 { 60 } else { 62 }
}

/// Where report n's key data starts in the 556-byte key data.
fn rk_offset(n: u8) -> usize {
    if n == 1 { 0 } else { 60 + (usize::from(n) - 2) * 62 }
}

/// Mirror of src/lib/brands/rk-beiying/guard.ts `classifyStatic`.
pub fn rk_beiying(report_id: u8, d: &[u8]) -> Result<&'static str, String> {
    if report_id != 0x0a || d.len() != 64 {
        return Err(format!("Royal Kludge boards take feature report 0x0A with 64 data bytes (got report {report_id:#04x}, {} bytes).", d.len()));
    }
    let bad = |why: &str| not_listed("Royal Kludge", d, why);
    if d[0] == 1 && d[1] == 1 {
        let rgb0 = d[8] == 0 && d[9] == 0 && d[10] == 0;
        let ok = d[2] == 2
            && d[3] == 0x29
            && (1..=21).contains(&d[4])
            && d[5] == 0
            && (1..=5).contains(&d[6])
            && d[7] <= 5
            && d[11] <= 1
            && (d[11] == 0 || rgb0)
            && (1..=5).contains(&d[12])
            && zero_from(d, 13);
        return if ok { Ok("lighting") } else { bad("lighting report") };
    }
    if d[0] == 7 {
        return Err("Blocked: Royal Kludge per-key colour reports aren't sent by SYNQ.".into());
    }
    if d[0] != RK_MAP_REPORTS || d[1] < 1 || d[1] > RK_MAP_REPORTS {
        return bad("report kind");
    }
    let n = d[1];
    if n == 1 && (d[2] != 0x01 || d[3] != 0xf8) {
        return bad("key map header");
    }
    let start = if n == 1 { 4 } else { 2 };
    let (len, g0) = (rk_chunk(n), rk_offset(n));
    for j in 0..len {
        let v = d[start + j];
        let pos = (g0 + j) % 4;
        let first = if j >= pos { Some(d[start + j - pos]) } else { None };
        if (pos == 0 && v > 1) || (first == Some(1) && pos == 1 && v != 0) || (first == Some(0) && pos == 2 && v > 0xe7) || (first == Some(0) && pos == 3 && v != 0) {
            return bad("key code");
        }
    }
    if zero_from(d, start + len) { Ok("key map") } else { bad("key map padding") }
}

// ---------------------------------------------------------------------------------------------
// SparkLink: output report 0, 64 bytes [0x5C, len, cmd, checksum, data...]
// ---------------------------------------------------------------------------------------------

const SL_READ_ORDERS: [u8; 10] = [0x01, 0x20, 0x21, 0x22, 0x25, 0x26, 0x50, 0x70, 0x75, 0x76];
const SL_MODE_ORDERS: [u8; 2] = [0x30, 0x31];
/// Key layouts read and written: actuation (4), mode (8), rapid-trigger press / release (20, 21), dead zones (22, 23).
const SL_LAYOUTS: [u8; 6] = [4, 8, 20, 21, 22, 23];
const SL_LAYOUT_MODE: u8 = 8;
const SL_LAYOUT_AXIS: u8 = 25;
const SL_MAX_TRAVEL: u16 = 4000;
const SL_MAX_GROUPS: usize = 14;
const SL_ROWS: u8 = 6;
/// Command classes that are never sent: bootloader (8-14), raw travel matrix (18), macros (32, 33), advanced keys
/// (36-40, 44, 45), screen pictures (48, 49).
const SL_NEVER: [u8; 19] = [8, 9, 10, 11, 12, 13, 14, 18, 32, 33, 36, 37, 38, 39, 40, 44, 45, 48, 49];

fn sl_checksum(f: &[u8]) -> u8 {
    0x35u8.wrapping_add(f[0]).wrapping_add(f[1]).wrapping_add(f[2]).wrapping_add(f[3 + f[1] as usize])
}

/// Mirror of src/lib/brands/sparklink/guard.ts `classifyStatic`.
pub fn sparklink(report_id: u8, f: &[u8]) -> Result<&'static str, String> {
    if report_id != 0 || f.len() != 64 {
        return Err(format!("These keyboards take report 0, 64 bytes (got report {report_id}, {} bytes).", f.len()));
    }
    let bad = |why: &str| not_listed("SparkLink", f, why);
    let len = f[1] as usize;
    if f[0] != 0x5c || !(1..=60).contains(&len) || f[3] != sl_checksum(f) || !zero_from(f, 4 + len) {
        return bad("envelope");
    }
    let (cmd, d) = (f[2], &f[4..4 + len]);
    if SL_NEVER.contains(&cmd) {
        return Err(format!("Blocked: SparkLink command class {cmd} (bootloader, macros, advanced keys or screen pictures)."));
    }
    match cmd {
        1 => {
            if d == [1, 2, 3, 4, 0xff, 0xff] { Ok("board info") } else { bad("board info") }
        }
        0 => {
            match d[0] {
                0x11 => return Err("Blocked: factory reset (order 0x11).".into()),
                0x04 | 0x0c | 0x0d => return Err("Blocked: sensor calibration orders.".into()),
                0x10 => return Err("Blocked: macro storage erase (order 0x10).".into()),
                _ => {}
            }
            if len != 3 || d[1] != 0xff || d[2] != 0xff {
                return bad("order");
            }
            if SL_READ_ORDERS.contains(&d[0]) {
                Ok("order read")
            } else if SL_MODE_ORDERS.contains(&d[0]) {
                Ok("system mode")
            } else {
                bad("order")
            }
        }
        43 => {
            if len == 3 && d[0] == 0 && d[1] < SL_ROWS && d[2] < SL_ROWS { Ok("default keys") } else { bad("default keys") }
        }
        41 => {
            if len != 15 {
                return bad("global travel");
            }
            if d[0] == 0 {
                return if zero_from(d, 1) { Ok("global travel") } else { bad("global travel") };
            }
            if d[0] != 1 || d[1] != 0 || d[2] != 0 || !zero_from(d, 9) {
                return bad("global travel");
            }
            let (travel, press, release) = (u16le(d, 3), u16le(d, 5), u16le(d, 7));
            if (1..=SL_MAX_TRAVEL).contains(&travel) && press <= SL_MAX_TRAVEL && release <= SL_MAX_TRAVEL { Ok("global travel") } else { bad("global travel") }
        }
        35 => {
            if len < 5 || (len - 1) % 4 != 0 || (len - 1) / 4 > SL_MAX_GROUPS {
                return bad("key settings");
            }
            let groups = (len - 1) / 4;
            if d[0] == 0 {
                let ok = (0..groups).all(|g| {
                    let at = 1 + g * 4;
                    d[at] >= 1 && SL_LAYOUTS.contains(&d[at + 1]) && d[at + 2] == 0 && d[at + 3] == 0
                });
                return if ok { Ok("key settings") } else { bad("key settings") };
            }
            if d[0] != 1 || groups != 1 || d[1] < 1 {
                return bad("key settings");
            }
            let (layout, value) = (d[2], u16le(d, 3));
            if layout == SL_LAYOUT_AXIS {
                return Err("Blocked: a key's switch type (axis) belongs to the sensor calibration.".into());
            }
            if !SL_LAYOUTS.contains(&layout) {
                return bad("key settings");
            }
            if layout == SL_LAYOUT_MODE {
                return if value & 0xff00 == 0 && value & 15 == 0 && value >> 4 <= 2 { Ok("key mode") } else { bad("key mode") };
            }
            if value <= SL_MAX_TRAVEL && (layout == 22 || layout == 23 || value >= 1) { Ok("key travel") } else { bad("key travel") }
        }
        _ => bad("command class"),
    }
}

// ---------------------------------------------------------------------------------------------
// Bytech (Redragon K709 HE): one fixed depth request, output report 9
// ---------------------------------------------------------------------------------------------

pub fn bytech(report_id: u8, f: &[u8]) -> Result<&'static str, String> {
    if report_id == 9 && f == ids::BYTECH_REQUEST {
        Ok("bytech depth request")
    } else {
        Err("Refused: only the 0x97 depth request (report 9, 63 bytes) is ever sent to this keyboard.".into())
    }
}

// ---------------------------------------------------------------------------------------------
// Razer analog keyboards (and the two brand mice): 90-byte feature reports
// ---------------------------------------------------------------------------------------------

const RZ_BLOCKED: [(u8, Option<u8>); 25] = [
    (0x00, Some(0x04)),
    (0x00, Some(0x84)),
    (0x00, Some(0x0b)),
    (0x00, Some(0x02)),
    (0x00, Some(0x36)),
    (0x00, Some(0x41)),
    (0x00, Some(0x42)),
    (0x00, Some(0x46)),
    (0x00, Some(0x47)),
    (0x00, Some(0x53)),
    (0x00, Some(0x55)),
    (0x00, Some(0x5c)),
    (0xfe, None),
    (0x02, Some(0x9c)),
    (0x02, Some(0x21)),
    (0x05, Some(0x02)),
    (0x05, Some(0x03)),
    (0x05, Some(0x0b)),
    (0x06, Some(0x0a)),
    (0x06, Some(0x09)),
    (0x0b, Some(0x01)),
    (0x0b, Some(0x0c)),
    (0x0b, Some(0x0d)),
    (0x0b, Some(0x05)),
    (0x0b, Some(0x08)),
];

const RZ_ALL_KEYS: u8 = 255;
const RZ_POLL_CODES: [u8; 7] = [1, 2, 4, 8, 16, 32, 64];

fn rz_key(k: u8) -> bool {
    ids::RAZER_VALID_KEYS.contains(&k)
}
fn rz_profile(p: u8) -> bool {
    p <= 8
}
fn rz_key_list_read(a: &[u8], n: usize, stride: usize, max: usize) -> bool {
    if n < 2 || (n - 2) % stride != 0 {
        return false;
    }
    let k = (n - 2) / stride;
    (1..=max).contains(&k) && a[0] == 0 && rz_profile(a[1]) && (0..k).all(|i| {
        let o = 2 + stride * i;
        rz_key(a[o]) && (1..stride).all(|j| a[o + j] == 0)
    })
}

/// The argument checks of each Razer command SYNQ sends, by (class, id). None = not a command SYNQ knows.
fn rz_args_ok(cls: u8, id: u8, a: &[u8], n: usize) -> Option<bool> {
    let z = |from: usize| zero_from(a, from);
    let pick = |i: usize| a.get(i).copied().unwrap_or(0);
    Some(match (cls, id) {
        (0x00, 0x81) => n == 2 && z(0),                                         // firmware
        (0x00, 0x82) => n == 22 && z(0),                                        // serial
        (0x00, 0xc0) => n == 2 && rz_profile(pick(0)) && pick(1) == 0,          // polling get
        (0x00, 0x40) => n == 2 && rz_profile(pick(0)) && RZ_POLL_CODES.contains(&pick(1)), // polling set
        (0x05, 0x80) => n == 1 && pick(0) == 0,                                 // profile count
        (0x05, 0x81) => n == 80 && z(0),                                        // profile list
        (0x05, 0x84) => n == 1 && pick(0) == 0,                                 // active profile get
        (0x05, 0x04) => n == 1 && pick(0) >= 1 && rz_profile(pick(0)),          // active profile set
        (0x02, 0x99) => rz_key_list_read(a, n, 5, 15),                          // actuation get
        (0x02, 0x19) => {
            // actuation set: [0, profile, (key, release u16 BE, actuation u16 BE) x k]
            if n < 2 || (n - 2) % 5 != 0 {
                return Some(false);
            }
            let k = (n - 2) / 5;
            (1..=15).contains(&k)
                && a[0] == 0
                && rz_profile(a[1])
                && (0..k).all(|i| {
                    let o = 2 + 5 * i;
                    let (rel, act) = (u16be(a, o + 1), u16be(a, o + 3));
                    (rz_key(a[o]) || (a[o] == RZ_ALL_KEYS && k == 1)) && (1638..=65520).contains(&act) && rel >= 256 && rel <= act
                })
        }
        (0x02, 0x9a) => rz_key_list_read(a, n, 6, 13), // rapid trigger get
        (0x02, 0x1a) => {
            if n < 2 || (n - 2) % 6 != 0 {
                return Some(false);
            }
            let k = (n - 2) / 6;
            (1..=13).contains(&k)
                && a[0] == 0
                && rz_profile(a[1])
                && (0..k).all(|i| {
                    let o = 2 + 6 * i;
                    (rz_key(a[o]) || (a[o] == RZ_ALL_KEYS && k == 1)) && a[o + 1] <= 1 && (1638..=32760).contains(&u16be(a, o + 2)) && (1638..=32760).contains(&u16be(a, o + 4))
                })
        }
        (0x02, 0xa8) => n == 2 && rz_profile(pick(0)) && pick(1) == 0,                  // bottom dead zone get
        (0x02, 0x28) => n == 2 && rz_profile(pick(0)) && (1..=20).contains(&pick(1)),   // bottom dead zone set
        (0x02, 0xa7) => n == 15 && rz_profile(pick(0)) && z(1),                         // snap tap get
        (0x02, 0x27) => {
            n == 15
                && rz_profile(a[0])
                && a[1] <= 4
                && a[2] <= 1
                && (0..a[1] as usize).all(|i| {
                    let o = 3 + 3 * i;
                    rz_key(a[o]) && rz_key(a[o + 1]) && a[o] != a[o + 1] && a[o + 2] <= 4
                })
                && z(3 + 3 * a[1] as usize)
        }
        (0x02, 0xac) => n == 11 && rz_profile(pick(0)) && z(1), // single-key snap tap get
        (0x02, 0x2c) => n == 11 && rz_profile(a[0]) && a[1] <= 4 && a[2] <= 1 && (0..a[1] as usize).all(|i| rz_key(a[3 + 2 * i])) && z(3 + 2 * a[1] as usize),
        (0x02, 0xb1) => n == 7 && rz_profile(pick(0)) && z(1), // dual priority get
        (0x02, 0x31) => {
            if n != 7 || !rz_profile(a[0]) || a[1] > 4 || a[2] > 1 {
                return Some(false);
            }
            let keys = &a[3..3 + a[1] as usize];
            keys.iter().all(|&k| rz_key(k)) && keys.iter().enumerate().all(|(i, k)| !keys[..i].contains(k)) && z(3 + a[1] as usize)
        }
        (0x0f, 0x84) => n == 3 && rz_profile(pick(0)) && pick(1) == 0 && pick(2) == 0, // brightness get
        (0x0f, 0x04) => n == 3 && rz_profile(pick(0)) && pick(1) == 0,                 // brightness set
        (0x04, 0x86) => n == 80 && rz_profile(pick(0)) && z(1),                        // DPI stages get
        (0x04, 0x06) => {
            if n < 3 {
                return Some(false);
            }
            let k = a[2] as usize;
            (1..=5).contains(&k)
                && n == 3 + 7 * k
                && rz_profile(a[0])
                && a[1] >= 1
                && a[1] as usize <= k
                && (0..k).all(|i| {
                    let o = 3 + 7 * i;
                    a[o] <= 8 && (50..=50000).contains(&u16be(a, o + 1)) && (50..=50000).contains(&u16be(a, o + 3)) && a[o + 5] == 0 && a[o + 6] == 0
                })
        }
        (0x07, 0x80) | (0x07, 0x84) => n == 2 && z(0), // battery, charging
        (0x0b, 0x8b) => n == 4 && pick(0) == 0 && pick(1) == 4 && pick(2) == 0 && pick(3) == 0, // lift get
        (0x0b, 0x0b) => n == 4 && pick(0) == 0 && pick(1) == 4 && pick(2) == 1 && pick(3) <= 9, // lift set
        (0x0b, 0x03) => n == 3 && pick(0) == 0 && pick(1) == 4 && pick(2) == 1,                // proximity state set
        _ => return None,
    })
}

pub fn razer(report_id: u8, f: &[u8]) -> Result<&'static str, String> {
    if report_id != 0 || f.len() != 90 {
        return Err(format!("Razer control reports are report 0, 90 bytes (got report {report_id}, {} bytes).", f.len()));
    }
    let (status, tx, size, cls, id) = (f[0], f[1], f[5] as usize, f[6], f[7]);
    if RZ_BLOCKED.iter().any(|&(c, i)| c == cls && i.is_none_or(|i| i == id)) {
        return Err(format!("Blocked: Razer class 0x{cls:02x} id 0x{id:02x} (device mode, reset, identity, pairing, calibration or profile wipe)."));
    }
    let crc = f[2..88].iter().fold(0u8, |c, &b| c ^ b);
    let shape_ok = status == 0 && f[2] == 0 && f[3] == 0 && f[4] == 0 && f[89] == 0 && (tx <= 0x1f || tx == 0xff) && size <= 80 && f[88] == crc && f[8 + size..88].iter().all(|&b| b == 0);
    match rz_args_ok(cls, id, &f[8..8 + size.min(80)], size) {
        None => Err(format!("Refused: Razer class 0x{cls:02x} id 0x{id:02x} isn't on SYNQ's list.")),
        Some(true) if shape_ok => Ok("razer command"),
        Some(_) => Err(format!("Refused: Razer class 0x{cls:02x} id 0x{id:02x} with arguments or a frame shape SYNQ doesn't send.")),
    }
}

// ---------------------------------------------------------------------------------------------
// ASUS Gear Link: the TS guard's own rule table (asus-rules.json), run by the same matcher as
// src/lib/brands/rules.ts. Blocked rules first, then allowed; no match = refused.
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct AsusRulesFile {
    #[serde(rename = "familyByPid")]
    family_by_pid: HashMap<String, String>,
    #[serde(rename = "bootloaderPids")]
    bootloader_pids: Vec<String>,
    rules: Vec<Rule>,
}

#[derive(Deserialize)]
struct Rule {
    verdict: String,
    families: Vec<String>,
    bytes: Vec<ByteRule>,
    #[serde(default)]
    u16: Vec<U16Rule>,
    #[serde(rename = "zeroFrom")]
    zero_from: Option<usize>,
    #[serde(rename = "eachMax")]
    each_max: Option<EachMax>,
    contains: Option<Vec<u8>>,
}

#[derive(Deserialize)]
struct ByteRule {
    at: usize,
    eq: Option<u8>,
    #[serde(rename = "in")]
    one_of: Option<Vec<u8>>,
    min: Option<u8>,
    max: Option<u8>,
}

#[derive(Deserialize)]
struct U16Rule {
    at: usize,
    min: u16,
    max: u16,
}

#[derive(Deserialize)]
struct EachMax {
    from: usize,
    to: usize,
    max: u8,
}

pub struct AsusRules {
    family: HashMap<u16, String>,
    bootloader: HashSet<u16>,
    rules: Vec<Rule>,
}

pub fn asus_rules() -> &'static AsusRules {
    static RULES: OnceLock<AsusRules> = OnceLock::new();
    RULES.get_or_init(|| {
        let file: AsusRulesFile = serde_json::from_str(include_str!("../../src/lib/brands/asus/asus-rules.json")).expect("asus-rules.json");
        let pid = |s: &str| u16::from_str_radix(s, 16).expect("ASUS pid");
        AsusRules {
            family: file.family_by_pid.iter().map(|(k, v)| (pid(k), v.clone())).collect(),
            bootloader: file.bootloader_pids.iter().map(|s| pid(s)).collect(),
            rules: file.rules,
        }
    })
}

/// Every ASUS id the rule table names, with its family (for the bridge tests).
#[cfg(test)]
pub fn asus_pids() -> Vec<(u16, &'static str)> {
    let mut v: Vec<(u16, &'static str)> = asus_rules().family.iter().map(|(&p, f)| (p, f.as_str())).collect();
    v.sort();
    v
}

fn rule_matches(r: &Rule, family: &str, f: &[u8]) -> bool {
    if !r.families.iter().any(|x| x == "*" || x == family) {
        return false;
    }
    if let Some(seq) = &r.contains {
        if seq.is_empty() || !f.windows(seq.len()).any(|w| w == seq.as_slice()) {
            return false;
        }
    }
    for b in &r.bytes {
        let Some(&v) = f.get(b.at) else { return false };
        if b.eq.is_some_and(|e| v != e) || b.one_of.as_ref().is_some_and(|s| !s.contains(&v)) || b.min.is_some_and(|m| v < m) || b.max.is_some_and(|m| v > m) {
            return false;
        }
    }
    for u in &r.u16 {
        if u.at + 1 >= f.len() {
            return false;
        }
        let v = u16le(f, u.at);
        if v < u.min || v > u.max {
            return false;
        }
    }
    if let Some(e) = &r.each_max {
        if (e.from..e.to).any(|i| f.get(i).is_some_and(|&v| v > e.max)) {
            return false;
        }
    }
    r.zero_from.is_none_or(|z| zero_from(f, z))
}

pub fn asus(product_id: u16, f: &[u8]) -> Result<&'static str, String> {
    let rules = asus_rules();
    if rules.bootloader.contains(&product_id) {
        return Err(format!("Blocked: 0b05:{product_id:04x} is a firmware-update identity."));
    }
    let Some(family) = rules.family.get(&product_id) else { return Err("Refused: not an ASUS device in SYNQ's table.".into()) };
    if f.len() != 64 && f.len() != 63 {
        return Err(format!("ASUS frames are 63/64 bytes (got {}).", f.len()));
    }
    if rules.rules.iter().any(|r| r.verdict == "blocked" && rule_matches(r, family, f)) {
        return Err("Blocked: an ASUS command SYNQ never sends (bootloader, firmware, reset, calibration or pairing).".into());
    }
    if rules.rules.iter().any(|r| r.verdict != "blocked" && rule_matches(r, family, f)) {
        Ok("asus frame")
    } else {
        not_listed("ASUS", f, "not on the Gear Link allowlist")
    }
}

// ---------------------------------------------------------------------------------------------
// Corsair Bragi (src/lib/brands/corsair/guard.ts classifyBragiFrame) and Sabre v2 (sabre.ts)
// ---------------------------------------------------------------------------------------------

const BRAGI_GET: [u16; 30] = [1, 2, 3, 6, 7, 8, 10, 15, 16, 17, 18, 19, 20, 24, 25, 26, 27, 28, 29, 30, 31, 54, 56, 58, 65, 110, 150, 223, 261, 275];
/// (property, min, max, families: bit 0 kb-he, 1 kb, 2 mouse-bragi, 3 receiver)
const BRAGI_SET: [(u16, u32, u32, u8); 15] = [
    (1, 1, 7, 0b1111),
    (2, 0, 1000, 0b0011),
    (3, 1, 2, 0b1111),
    (110, 0, 4, 0b0111),
    (6, 1, 7, 0b0100),
    (7, 0, 1, 0b0100),
    (10, 5, 14, 0b0100),
    (56, 5, 14, 0b0100),
    (24, 100, 65535, 0b0100),
    (25, 100, 65535, 0b0100),
    (26, 100, 65535, 0b0100),
    (27, 100, 65535, 0b0100),
    (28, 100, 65535, 0b0100),
    (30, 0, 4, 0b0100),
    (275, 0, 1, 0b0100),
];
const BRAGI_IDENTITY_FILES: [u16; 9] = [31000, 30999, 30998, 30997, 30996, 28399, 28398, 28397, 28396];

fn bragi_family_bit(pid: u16) -> u8 {
    if ids::CORSAIR_FAMILY_KB_HE.contains(&pid) {
        0b0001
    } else if ids::CORSAIR_FAMILY_KB.contains(&pid) {
        0b0010
    } else if ids::CORSAIR_BRAGI_MICE.contains(&pid) {
        0b0100
    } else if ids::CORSAIR_FAMILY_RECEIVER.contains(&pid) {
        0b1000
    } else {
        0
    }
}
fn bragi_v1(pid: u16) -> bool {
    ids::CORSAIR_BRAGI_V1.contains(&pid)
}
fn bragi_readable(id: u16) -> bool {
    id == 15 || id == 38 || ((28000..=32767).contains(&id) && !BRAGI_IDENTITY_FILES.contains(&id))
}
fn bragi_writable(id: Option<u16>) -> bool {
    id.is_some_and(|id| (28000..=32767).contains(&id) && !BRAGI_IDENTITY_FILES.contains(&id))
}
fn u32le(f: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([f[at], f[at + 1], f[at + 2], f[at + 3]])
}

pub fn bragi(pid: u16, open_file: Option<u16>, len: usize, f: &[u8]) -> Result<&'static str, String> {
    if f.len() != len {
        return Err(format!("Corsair Bragi frames are {len} bytes (got {}).", f.len()));
    }
    let family = bragi_family_bit(pid);
    if family == 0 {
        return Err("Refused: not a Corsair Bragi device in SYNQ's table.".into());
    }
    let v1 = bragi_v1(pid);
    let refuse = |what: &str| Err(format!("Refused Corsair frame: {what}."));
    // Host sessions (Bragi 1.5): start, or stop of a session (the TS guard tracks whose).
    if f[3] == 0x1b && f[1] == 0x01 && f[0] <= 7 {
        if v1 {
            return refuse("only Bragi 1.5 devices take sessions");
        }
        if f[4] == 0x01 && f[2] == 0 && f[9] == 0 && zero_from(f, 10) {
            return Ok("start host session");
        }
        if f[4] == 0x02 && f[2] == f[9] && zero_from(f, 10) && f[5..9].iter().all(|&b| b == 0) {
            return Ok("stop host session");
        }
        return refuse("unknown session operation");
    }
    if v1 {
        if f[0] & 0xf8 != 0x08 {
            return refuse("Bragi 1.0 frames start 08..0F");
        }
    } else if f[0] > 7 || f[1] != 0x01 {
        return refuse("Bragi 1.5 frames start [addr 0..7, 01, session]");
    }
    let (cmd, p) = if v1 { (f[1], 2) } else { (f[3], 4) };
    match cmd {
        0x0a => Err("Blocked: Corsair calibration control (0x0A).".into()),
        0x0b | 0x0c => Err("Blocked: Corsair create / delete file.".into()),
        0x0f => Err("Blocked: Corsair factory reset (0x0F).".into()),
        0x10 | 0x16 => Err("Blocked: Corsair apply firmware.".into()),
        0x11 => Err("Blocked: Corsair pairing control (0x11).".into()),
        0x03 => refuse("get multiple"),
        0x12 => {
            if zero_from(f, p) {
                Ok("ping")
            } else {
                Err("Blocked: Corsair pairing (0x12 with a payload).".into())
            }
        }
        0x02 => {
            let prop = u16le(f, p);
            if BRAGI_GET.contains(&prop) && zero_from(f, p + 2) { Ok("get") } else { refuse("GET of a property SYNQ doesn't read") }
        }
        0x01 => {
            let prop = u16le(f, p);
            let value = u32le(f, p + 2);
            if prop == 3 && (value == 3 || value == 5) {
                return Err("Blocked: Corsair operating mode = bootloader.".into());
            }
            if prop == 3 && value > 2 {
                return refuse("operating modes other than self-operated / host-controlled");
            }
            match BRAGI_SET.iter().find(|r| r.0 == prop) {
                Some(&(_, min, max, fams)) if fams & family != 0 && (min..=max).contains(&value) && zero_from(f, p + 6) => Ok("set"),
                _ => refuse("SET of a property or value SYNQ doesn't write"),
            }
        }
        0x0d => {
            let file = u16le(f, p + 1);
            if f[p] == 0 && bragi_readable(file) && zero_from(f, p + 3) { Ok("open file") } else { Err(format!("Refused: opening Corsair file {file} (firmware, pairing, calibration or identity files are never opened).")) }
        }
        0x09 | 0x08 => {
            if f[p] == 0 && zero_from(f, p + 1) { Ok("buffer read") } else { refuse("buffer op") }
        }
        0x05 => {
            if f[p] == 1 && f[p + 1] == 0 && zero_from(f, p + 2) { Ok("close buffer") } else { refuse("unbind") }
        }
        0x06 | 0x07 => {
            if f[p] != 0 {
                return refuse("buffer 0 only");
            }
            if !bragi_writable(open_file) {
                return Err("Blocked: Corsair data writes go only to an open, host-allocated profile file.".into());
            }
            if cmd == 0x06 && u32le(f, p + 1) > 4096 {
                return refuse("write too large");
            }
            Ok("write file")
        }
        _ => refuse("not a known-safe Bragi command"),
    }
}

/// What the TS BragiGuardState.observe does after a frame is sent: track the open file.
fn bragi_observe(st: &mut State, f: &[u8]) {
    if f.len() < 8 || (f[3] == 0x1b && f[1] == 0x01) {
        return;
    }
    let (cmd, p) = if bragi_v1(st.product_id) { (f[1], 2) } else { (f[3], 4) };
    if cmd == 0x0d {
        st.open_file = Some(u16le(f, p + 1));
    } else if cmd == 0x05 {
        st.open_file = None;
    }
}

pub fn sabre(report_id: u8, f: &[u8]) -> Result<&'static str, String> {
    if report_id != 8 || f.len() != 16 {
        return Err(format!("Sabre frames are report 8, 16 bytes (got report {report_id}, {} bytes).", f.len()));
    }
    let sum = f[..15].iter().fold(8u32, |s, &b| s + u32::from(b));
    if f[15] != (0x55u32.wrapping_sub(sum & 0xff) & 0xff) as u8 {
        return Err("Refused: bad Sabre checksum.".into());
    }
    match f[0] {
        0x09 => Err("Blocked: Sabre factory reset (0x09).".into()),
        0x01 | 0x02 => Err("Blocked: Sabre handshake / driver mode (firmware transfer on the ATK family).".into()),
        0x04 | 0x12 | 0x1d => if f[1..15].iter().all(|&b| b == 0) { Ok("status read") } else { not_listed("Sabre", f, "status read with payload") },
        0x08 => {
            let (addr, len) = (u16::from(f[2]) << 8 | u16::from(f[3]), f[4]);
            if f[1] == 0 && (1..=10).contains(&len) && addr <= 0x2ff && f[5..15].iter().all(|&b| b == 0) { Ok("EEPROM read") } else { not_listed("Sabre", f, "EEPROM read") }
        }
        0x07 => {
            let (addr, len) = (u16::from(f[2]) << 8 | u16::from(f[3]), f[4] as usize);
            if (0xdb..=0xdf).contains(&addr) {
                return Err("Blocked: Sabre surface-calibration rows 0xDB-0xDF.".into());
            }
            let dpi = (12..32).step_by(4).any(|a| a == addr);
            let row_len = match addr {
                0x00 | 0x04 | 0x0a | 0xab | 0xaf | 0xb1 => 2,
                _ if dpi => 4,
                _ => return not_listed("Sabre", f, "EEPROM row not on SYNQ's write list"),
            };
            if f[1] != 0 || len != row_len || !f[5 + len..15].iter().all(|&b| b == 0) {
                return not_listed("Sabre", f, "EEPROM write shape");
            }
            let d = &f[5..5 + len];
            let value_ok = match addr {
                0x00 => [1, 16, 32, 64].contains(&d[0]),
                0x04 => d[0] < 5,
                0x0a => [0, 3, 4].contains(&d[0]),
                0xab | 0xaf | 0xb1 => d[0] <= 1,
                _ => d.iter().fold(0u32, |s, &b| s + u32::from(b)) & 0xff == 0x55 && d[0] == d[1],
            };
            let pair_ok = len != 2 || (u32::from(d[0]) + u32::from(d[1])) & 0xff == 0x55;
            if value_ok && pair_ok { Ok("EEPROM write") } else { not_listed("Sabre", f, "bad value or value / checksum pair") }
        }
        _ => not_listed("Sabre", f, "not on the Sabre allowlist"),
    }
}

/// Corsair iCUE BRAGI (src/lib/brands/corsair-icue/guard.ts): identity / lighting reads, the render-mode
/// switch, lighting transactions and their data blocks. Nothing else (firmware, reset, pairing, actuation).
pub fn icue(report_id: u8, d: &[u8]) -> Result<&'static str, String> {
    if report_id != 0 || d.len() != 64 {
        return Err(format!("iCUE BRAGI frames are report 0, 64 bytes (got report {report_id}, {} bytes).", d.len()));
    }
    if d[0] != 0x08 && d[0] != 0x09 {
        return not_listed("iCUE", d, "write id must be 08 / 09");
    }
    let (cmd, addr) = (d[1], d[2]);
    let ok = match cmd {
        0x02 => [0x11, 0x12, 0x41, 0x01, 0x22].contains(&addr),
        0x01 => addr == 0x03,
        0x0d => addr == 0x00 && (d[3] == 0x01 || d[3] == 0x22),
        0x05 => addr == 0x01 && (d[3] == 0x00 || d[3] == 0x01 || d[3] == 0x22),
        0x06 | 0x07 => true,
        _ => false,
    };
    if ok { Ok("icue frame") } else { not_listed("iCUE", d, "not a lighting or identity command") }
}

// ---------------------------------------------------------------------------------------------
// Logitech G keyboards, HID++ 2.0 (src/lib/brands/logitech-kb/guard.ts). Feature indexes are learned
// from IRoot.getFeature: the request names the feature id, the reply (seen by the reader) its index.
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
pub struct Logi {
    /// (device index, software id) -> feature id asked for.
    pending: HashMap<(u8, u8), u16>,
    /// feature index -> feature id.
    pub map: HashMap<u8, u16>,
}

impl Logi {
    /// An input report from the device: an IRoot.getFeature reply resolves a pending request.
    pub fn observe(&mut self, report_id: u8, data: &[u8]) {
        if !matches!(report_id, 0x10..=0x12) || data.len() < 4 || data[1] != 0x00 || data[2] >> 4 != 0 {
            return;
        }
        if let Some(feature) = self.pending.remove(&(data[0], data[2] & 0x0f)) {
            if data[3] != 0 {
                self.map.insert(data[3], feature);
            }
        }
    }
}

const LOGI_BLOCKED: [u16; 26] = [
    0x00c0, 0x00c1, 0x00c2, 0x00c3, 0x00d0, 0x00d1, 0x010a, 0x1800, 0x1802, 0x1805, 0x1806, 0x1500, 0x1814, 0x1815, 0x1816, 0x1894, 0x1895, 0x1df0, 0x1e00, 0x1b30, 0x1b05, 0x1b20,
    0x8101, 0x8102, 0x4521, 0x4522,
];
/// (feature id, read functions, write functions)
const LOGI_SAFE: [(u16, &[u8], &[u8]); 12] = [
    (0x0001, &[0, 1], &[]),
    (0x0003, &[0, 1], &[]),
    (0x0005, &[0, 1, 2], &[]),
    (0x8060, &[0, 1], &[2]),
    (0x8061, &[1, 2], &[3]),
    (0x8040, &[0, 1], &[2, 4]),
    (0x8070, &[0], &[1, 2, 3]),
    (0x8071, &[0, 1, 3], &[1, 2, 5]),
    (0x8080, &[0], &[1, 2, 4, 5]),
    (0x8081, &[0], &[1, 2, 4, 5]),
    (0x8100, &[0, 2, 4], &[1]),
    (0x1b08, &[0, 3, 5], &[2, 4, 6]),
];

pub fn logitech_kb(st: &mut Logi, report_id: u8, d: &[u8]) -> Result<&'static str, String> {
    let len = match report_id {
        0x10 => 6,
        0x11 => 19,
        0x12 => 63,
        _ => return Err(format!("Refused: report 0x{report_id:02x} isn't a HID++ report.")),
    };
    if d.len() != len {
        return Err(format!("HID++ report 0x{report_id:02x} is {len} bytes (got {}).", d.len()));
    }
    let (dev, index, func) = (d[0], d[1], d[2] >> 4);
    if !(dev == 0xff || (1..=6).contains(&dev)) {
        return not_listed("HID++", d, "device index");
    }
    if index == 0x00 {
        return match func {
            0 => {
                st.pending.insert((dev, d[2] & 0x0f), u16::from(d[3]) << 8 | u16::from(d[4]));
                Ok("IRoot getFeature")
            }
            1 => Ok("IRoot ping"),
            _ => not_listed("HID++", d, "IRoot function"),
        };
    }
    let Some(&feature) = st.map.get(&index) else { return not_listed("HID++", d, "feature index not resolved through IRoot") };
    if LOGI_BLOCKED.contains(&feature) {
        return Err(format!("Blocked: HID++ feature 0x{feature:04x} (DFU, reset, pairing, device mode, remap or profile management) is never sent."));
    }
    match LOGI_SAFE.iter().find(|s| s.0 == feature) {
        Some(s) if s.1.contains(&func) || s.2.contains(&func) => Ok("hid++ feature call"),
        _ => not_listed("HID++", d, "feature or function SYNQ doesn't use"),
    }
}

// ---------------------------------------------------------------------------------------------
// SteelSeries Apex (src/lib/brands/steelseries/guard.ts STEELSERIES_GUARD over every driven model)
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct SsFamily {
    caps: Vec<String>,
    pairs: Vec<[u8; 2]>,
    #[serde(rename = "keyLists")]
    key_lists: Vec<Vec<u8>>,
    leds: Vec<u8>,
}

fn ss_scope() -> &'static HashMap<String, SsFamily> {
    static SCOPE: OnceLock<HashMap<String, SsFamily>> = OnceLock::new();
    SCOPE.get_or_init(|| serde_json::from_str(include_str!("steelseries-scope.json")).expect("steelseries-scope.json"))
}

const SS_ANALOG: usize = 68;
/// Patterns SYNQ never sends (guard.ts BLOCKED): leading bytes.
const SS_BLOCKED: [&[u8]; 25] = [
    &[0x02], &[0x03], &[0xb1], &[0xe6], &[0xa6], &[0x42], &[0x43], &[0x88], &[0x05], &[0xeb], &[0x75], &[0x36], &[0x3c], &[0x35], &[0x38, 0x83], &[0x4c], &[0x41], &[0x34],
    &[0x69], &[0x74], &[0x1a], &[0x53], &[0x13], &[0x68], &[0x28],
];

fn ss_feature_len(family: &str) -> usize {
    match family {
        "legacy" => 642,
        "single" => 644,
        _ => 641,
    }
}

#[derive(Clone, Copy)]
enum SsCheck {
    Firmware,
    Only(usize),
    Brightness,
    Profile,
    Triplets(usize),
    DuplesRelease(usize),
    DuplesSens(usize),
    DuplesBool(usize),
    Direct,
}

/// (family, cap, feature (else output), head, check) in the TS SPECS order.
const SS_SPECS: [(&str, &str, bool, &[u8], SsCheck); 27] = [
    ("legacy", "firmware", false, &[0x90], SsCheck::Firmware),
    ("legacy", "brightness", false, &[0xa3], SsCheck::Only(1)),
    ("legacy", "brightness", false, &[0x23], SsCheck::Brightness),
    ("legacy", "release", false, &[0x3b], SsCheck::Only(1)),
    ("legacy", "profiles", false, &[0x89], SsCheck::Profile),
    ("legacy", "actuation", true, &[0x31, 0x47], SsCheck::Triplets(2)),
    ("legacy", "direct", true, &[0x3a], SsCheck::Direct),
    ("single", "firmware", false, &[0x90], SsCheck::Firmware),
    ("single", "region", false, &[0xf5], SsCheck::Only(1)),
    ("single", "region", false, &[0xf2], SsCheck::Only(1)),
    ("single", "init", false, &[0x4b], SsCheck::Only(1)),
    ("single", "actuation", true, &[0x38, 0x61, 68, 0x00], SsCheck::Triplets(4)),
    ("single", "rapidTrigger", true, &[0x38, 0x62, 68], SsCheck::DuplesRelease(3)),
    ("single", "sensitivity", true, &[0x38, 0x65, 68], SsCheck::DuplesSens(3)),
    ("single", "direct", true, &[0x40], SsCheck::Direct),
    ("wireless-rx", "status", false, &[0xbc], SsCheck::Only(1)),
    ("wireless-rx", "status", false, &[0xd2], SsCheck::Only(1)),
    ("wireless-rx", "release", false, &[0x62], SsCheck::Only(1)),
    ("wireless-rx", "actuation", true, &[0x6f, 0x00, 68], SsCheck::Triplets(3)),
    ("wireless-rx", "rapidTrigger", true, &[0x76, 68], SsCheck::DuplesBool(2)),
    ("wireless-rx", "sensitivity", true, &[0x77, 68], SsCheck::DuplesSens(2)),
    ("wireless-rx", "direct", true, &[0x61], SsCheck::Direct),
    ("wireless-usb", "status", false, &[0x92], SsCheck::Only(1)),
    ("wireless-usb", "release", false, &[0x22], SsCheck::Only(1)),
    ("wireless-usb", "actuation", true, &[0x2f, 0x00, 68], SsCheck::Triplets(3)),
    ("wireless-usb", "sensitivity", true, &[0x37, 68], SsCheck::DuplesSens(2)),
    ("wireless-usb", "direct", true, &[0x21], SsCheck::Direct),
];

fn ss_key_list<'a>(fam: &'a SsFamily, f: &[u8], at: usize, stride: usize) -> Option<&'a Vec<u8>> {
    fam.key_lists.iter().find(|l| l.iter().enumerate().all(|(i, &k)| f.get(at + i * stride) == Some(&k)))
}

fn ss_check(check: SsCheck, family: &str, f: &[u8]) -> bool {
    let Some(fam) = ss_scope().get(family) else { return false };
    let hl = family == "legacy" || family == "single";
    match check {
        SsCheck::Firmware => f[1] <= 1 && zero_from(f, 2),
        SsCheck::Only(n) => zero_from(f, n),
        SsCheck::Brightness => f[1] <= 10 && zero_from(f, 2),
        SsCheck::Profile => (1..=5).contains(&f[1]) && zero_from(f, 2),
        SsCheck::Triplets(at) => {
            if fam.pairs.is_empty() || ss_key_list(fam, f, at, 3).is_none() {
                return false;
            }
            (0..SS_ANALOG).all(|i| {
                let (a, b) = (f[at + i * 3 + 1], f[at + i * 3 + 2]);
                let pair = if hl { [b, a] } else { [a, b] };
                fam.pairs.contains(&pair)
            }) && zero_from(f, at + SS_ANALOG * 3)
        }
        SsCheck::DuplesRelease(at) | SsCheck::DuplesSens(at) | SsCheck::DuplesBool(at) => {
            if ss_key_list(fam, f, at, 2).is_none() {
                return false;
            }
            let ok = |v: u8| match check {
                SsCheck::DuplesRelease(_) => v == 0 || v == 2,
                SsCheck::DuplesSens(_) => (1..=40).contains(&v),
                _ => v <= 1,
            };
            (0..SS_ANALOG).all(|i| ok(f[at + i * 2 + 1])) && zero_from(f, at + SS_ANALOG * 2)
        }
        SsCheck::Direct => {
            let n = f[1] as usize;
            let cap = (ss_feature_len(family) - 2) / 4;
            if fam.leds.is_empty() || n < 1 || n > cap {
                return false;
            }
            (0..n).all(|i| {
                let id = f[2 + i * 4];
                fam.leds.contains(&id) && (i == 0 || id > f[2 + (i - 1) * 4])
            }) && zero_from(f, 2 + n * 4)
        }
    }
}

/// The command family of a driven SteelSeries id (what guardFor(model) narrows to).
fn ss_family(pid: u16) -> Option<&'static str> {
    [(&ids::SS_LEGACY[..], "legacy"), (&ids::SS_SINGLE[..], "single"), (&ids::SS_RX[..], "wireless-rx"), (&ids::SS_USB[..], "wireless-usb")].into_iter().find(|(l, _)| l.contains(&pid)).map(|(_, f)| f)
}

/// `family`: the device's command family (None = every family, as the static STEELSERIES_GUARD the fixture is made from).
pub fn steelseries(family: Option<&str>, transport: Transport, report_id: u8, f: &[u8]) -> Result<&'static str, String> {
    if report_id != 0 {
        return Err(format!("SteelSeries reports use report id 0 (got {report_id})."));
    }
    let feature = transport == Transport::Feature;
    if (!feature && f.len() != 64) || (feature && ![641, 642, 644].contains(&f.len())) {
        return Err(format!("Refused: SteelSeries {} reports can't be {} bytes.", if feature { "feature" } else { "output" }, f.len()));
    }
    if SS_BLOCKED.iter().any(|p| f.len() >= p.len() && f[..p.len()] == **p) {
        return Err("Blocked: a SteelSeries flash, profile, key-binding or reset command SYNQ never sends.".into());
    }
    for &(fam, cap, is_feature, head, check) in &SS_SPECS {
        if family.is_some_and(|x| x != fam) {
            continue;
        }
        let family = fam;
        let len = if is_feature { ss_feature_len(family) } else { 64 };
        if is_feature != feature || len != f.len() || f[..head.len()] != *head {
            continue;
        }
        if !ss_scope().get(family).is_some_and(|s| s.caps.iter().any(|c| c == cap)) {
            continue;
        }
        if ss_check(check, family, f) {
            return Ok("steelseries frame");
        }
    }
    not_listed("SteelSeries", f, "not a command SYNQ builds for these keyboards")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(hex: &str) -> Vec<u8> {
        let hex = if hex.len() % 2 == 1 { format!("{hex}0") } else { hex.to_string() };
        (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
    }

    fn frames(text: &str, len: usize) -> Vec<(bool, Vec<u8>)> {
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|line| {
                let (verdict, hex) = line.split_once(' ').unwrap_or((line.trim(), ""));
                let mut bytes = unhex(hex.trim());
                bytes.resize(len, 0);
                (verdict == "1", bytes)
            })
            .collect()
    }

    fn tally(name: &str, results: &[(bool, bool)], min: usize) {
        let ok = results.iter().filter(|r| r.0).count();
        assert!(results.len() >= min && ok > 0 && ok < results.len(), "{name}: {} frames ({ok} allowed)", results.len());
    }

    fn show(f: &[u8]) -> String {
        f.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn agree(name: &str, guard: Simple, report_id: u8, text: &str, len: usize, min: usize) {
        let list = frames(text, len);
        let mut results = vec![];
        for (want, f) in &list {
            let got = guard(report_id, f);
            assert_eq!(got.is_ok(), *want, "{name}: {} -> {got:?}", show(f));
            results.push((*want, true));
        }
        tally(name, &results, min);
    }

    #[test]
    fn sonix_matches_fcc_frames() {
        agree("sonix", sonix, 0, include_str!("../../src/lib/kb/fcc/fcc-frames.txt"), 64, 6000);
    }

    /// Same verdicts as the frontend's sonix-protocol checkFrame with an AdvancedGate holding those scopes.
    /// Regenerate with `node scripts/advanced-fixtures.ts`.
    #[test]
    fn sonix_advanced_matches_the_frontend() {
        use crate::advanced::testing::{fixture_bytes, spec_active};
        let mut checked = 0;
        for line in include_str!("sonix-frames-advanced.txt").lines().filter(|l| !l.is_empty()) {
            let mut parts = line.splitn(3, ' ');
            let (spec, verdict, hex) = (parts.next().unwrap(), parts.next().unwrap(), parts.next().unwrap());
            let mut bytes = fixture_bytes(hex);
            bytes.resize(64, 0);
            let active = spec_active(spec);
            assert_eq!(sonix_with(0, &bytes, active).is_ok(), verdict == "1", "grants {spec}, frame {hex} ({:?})", sonix_with(0, &bytes, active));
            checked += 1;
        }
        assert!(checked > 5000, "{checked}");
    }

    fn sonix_frame(bytes: &[u8]) -> Vec<u8> {
        let mut f = vec![0u8; 64];
        f[0] = 0xaa;
        f[1..1 + bytes.len()].copy_from_slice(bytes);
        f
    }

    #[test]
    fn sonix_calibration_and_reset_need_their_grant() {
        use crate::advanced::{Active, Scope};
        for (bytes, scope) in [(&[0x64u8][..], Scope::Calibrate), (&[0x65], Scope::Calibrate), (&[0x0f, 0xff], Scope::Reset)] {
            let f = sonix_frame(bytes);
            assert!(sonix(0, &f).is_err(), "{bytes:02x?} needs a grant");
            assert!(sonix_with(0, &f, Active::NONE).is_err());
            assert!(sonix_with(0, &f, Active::of(&[scope])).is_ok(), "{bytes:02x?} with {scope:?}");
            for other in Scope::ALL.into_iter().filter(|&o| o != scope) {
                assert!(sonix_with(0, &f, Active::of(&[other])).is_err(), "{bytes:02x?} must not open with only {other:?}");
            }
        }
    }

    /// The key-check reset, the unknown toggles, the status command, the Fn-layer write and the device
    /// events stay blocked with every scope held; so does every command that isn't one of the three.
    #[test]
    fn sonix_everything_else_stays_blocked_with_every_grant() {
        use crate::advanced::{Active, Scope, Scheme};
        let all = Active::of(&Scope::ALL).with_scheme(Scheme::Current);
        for bytes in [&[0x0fu8, 0x05][..], &[0x0f, 0x00], &[0x0f, 0xfe], &[0x66], &[0x67], &[0x62], &[0x26, 56], &[0xfb], &[0xfc, 4], &[0x64, 1], &[0x65, 0, 1]] {
            assert!(sonix_with(0, &sonix_frame(bytes), all).is_err(), "{bytes:02x?}");
        }
        let mut extra = sonix_frame(&[0x0f, 0xff]);
        extra[63] = 1;
        assert!(sonix_with(0, &extra, all).is_err(), "a stray byte after the reset");
        let passing: Vec<u8> = (0..=255u8).filter(|&c| sonix_with(0, &sonix_frame(&[c]), all).is_ok()).collect();
        assert_eq!(passing, vec![0x64, 0x65], "of all bare commands only the two calibration frames pass");
        // wrong report id or length never passes
        assert!(sonix_with(1, &sonix_frame(&[0x64]), all).is_err());
        assert!(sonix_with(0, &sonix_frame(&[0x64])[..63], all).is_err());
    }

    #[test]
    fn the_sonix_channel_hands_the_grant_to_its_guard() {
        use crate::advanced::{Active, Scope};
        let (vid, pid) = ids::SONIX[0];
        let c = device(vid, pid).expect("a Sonix id");
        assert_eq!(c.brand, "Sonix");
        let mut st = State::new(pid);
        let start = sonix_frame(&[0x64]);
        assert!(check(c, &mut st, Transport::Output, 0, &start).is_err());
        assert!(check_with(c, &mut st, Transport::Output, 0, &start, Active::NONE).is_err());
        assert!(check_with(c, &mut st, Transport::Output, 0, &start, Active::of(&[Scope::Calibrate])).is_ok());
        assert!(check_with(c, &mut st, Transport::Feature, 0, &start, Active::of(&[Scope::Calibrate])).is_err(), "still output reports only");
        assert!(check_with(c, &mut st, Transport::Output, 1, &start, Active::of(&[Scope::Calibrate])).is_err(), "still report 0 only");
    }

    #[test]
    fn monsgeek_matches_its_frames() {
        agree("monsgeek", monsgeek, 0, include_str!("../../src/lib/brands/monsgeek/monsgeek-frames.txt"), 64, 3000);
    }

    #[test]
    fn drunkdeer_matches_its_frames() {
        agree("drunkdeer", drunkdeer, 4, include_str!("../../src/lib/brands/drunkdeer/drunkdeer-frames.txt"), 63, 3000);
    }

    /// `src/lib/brands/fw19f5/fw19f5-frames.txt`: `<m><d><r> <hex>`, the verdicts of the MCHOSE, DrunkDeer and
    /// read-only guards for each frame (regenerate with `node scripts/fw19f5-allowlist-fixture.ts`).
    #[test]
    fn fw19f5_matches_its_frames() {
        let text = include_str!("../../src/lib/brands/fw19f5/fw19f5-frames.txt");
        let mut counts = [0usize; 3];
        let mut total = 0;
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let (verdicts, hex) = line.split_once(' ').unwrap_or((line.trim(), ""));
            let mut f = unhex(hex.trim());
            f.resize(64, 0);
            for (i, family) in [FwFamily::Mchose, FwFamily::DrunkDeer, FwFamily::ReadOnly].into_iter().enumerate() {
                let want = verdicts.as_bytes()[i] == b'1';
                let got = fw19f5(family, 0, &f);
                assert_eq!(got.is_ok(), want, "{family:?}: {} -> {got:?}", show(&f));
                counts[i] += usize::from(want);
            }
            total += 1;
        }
        assert!(total >= 4000 && counts[0] > 300 && counts[1] > 100 && counts[2] > 5 && counts[2] < 50, "{total} frames {counts:?}");
    }

    #[test]
    fn fw19f5_only_takes_report_zero_and_64_bytes() {
        let mut f = vec![0u8; 64];
        f[..8].copy_from_slice(&[0x55, 3, 0, 0x38, 56, 0, 0, 0]);
        assert!(fw19f5(FwFamily::ReadOnly, 0, &f).is_ok());
        assert!(fw19f5(FwFamily::ReadOnly, 4, &f).is_err());
        assert!(fw19f5(FwFamily::ReadOnly, 0, &f[..63]).is_err());
        assert!(fw19f5(FwFamily::ReadOnly, 0, &[f.clone(), vec![0]].concat()).is_err());
    }

    #[test]
    fn fw19f5_channels_open_only_the_generic_desktop_usage_zero_collection() {
        let mut all: Vec<(u16, u16)> = Vec::new();
        for list in [&ids::FW19F5_MCHOSE[..], &ids::FW19F5_DRUNKDEER[..], &ids::FW19F5_NUPHY[..], &ids::FW19F5_RK_GCOME[..]] {
            all.extend_from_slice(list);
        }
        for &(v, p) in &all {
            let c = device(v, p).unwrap_or_else(|| panic!("{v:04x}:{p:04x} has no channel"));
            assert_eq!(c.kind, "keyboard");
            assert!(channel(v, p, 0x0001, 0x0000).is_some(), "{v:04x}:{p:04x} 0001:0000");
            for (page, usage) in [(0x0001, 0x0006), (0x0001, 0x0002), (0x0001, 0x0080), (0x0001, 0x0001), (0x0007, 0x0006), (0x000c, 0x0001), (0xff00, 0x0001), (0xff00, 0x0000)] {
                assert!(channel(v, p, page, usage).is_none(), "{v:04x}:{p:04x} {page:04x}:{usage:04x} must stay closed");
            }
            assert_eq!(c.takes, Takes::Output);
            assert_eq!(c.report_ids, &[0]);
            assert!(listed(v, p));
        }
        // Every id belongs to exactly one family.
        let n = all.len();
        all.sort_unstable();
        all.dedup();
        assert_eq!(all.len(), n, "no id in two families");
        assert_eq!(n, 85);
    }

    #[test]
    fn fw19f5_families_are_narrowed_the_way_the_session_does() {
        let frame = |bytes: &[u8]| {
            let mut f = vec![0u8; 64];
            f[..bytes.len()].copy_from_slice(bytes);
            f[3] = fw_checksum(&f);
            f
        };
        let rec = [0xa0u8, 0, 0x3b, 0, 0x0e, 0, 0x31, 0];
        let mut w = vec![0x55, 0xa1, 0, 0, 8, 0, 0, 1];
        w.extend_from_slice(&rec);
        let flagged = frame(&w);
        assert!(fw19f5(FwFamily::DrunkDeer, 0, &flagged).is_ok());
        assert!(fw19f5(FwFamily::Mchose, 0, &flagged).is_err(), "MCHOSE never flags a chunk");
        assert!(fw19f5(FwFamily::ReadOnly, 0, &flagged).is_err());
        let reset = frame(&[0x55, 238, 0, 0, 1, 0, 0, 0, 255]);
        for fam in [FwFamily::Mchose, FwFamily::DrunkDeer, FwFamily::ReadOnly] {
            assert!(fw19f5(fam, 0, &reset).is_err());
        }
    }

    /// `src/lib/brands/rk-beiying/rk-beiying-frames.txt`: `<1|0> <hex>` of the 64 data bytes of feature report 0x0A.
    #[test]
    fn rk_beiying_matches_its_frames() {
        agree("rk-beiying", rk_beiying, 0x0a, include_str!("../../src/lib/brands/rk-beiying/rk-beiying-frames.txt"), 64, 4000);
    }

    #[test]
    fn rk_beiying_is_feature_only_on_system_control() {
        let c = device(0x258a, ids::RK_BEIYING[0].1).expect("an RK BeiYing id has a channel");
        assert_eq!((c.takes, c.report_ids, c.kind), (Takes::Feature, &[0x0au8][..], "keyboard"));
        for &(v, p) in ids::RK_BEIYING.iter() {
            assert!(channel(v, p, 0x0001, 0x0080).is_some(), "{v:04x}:{p:04x} System Control");
            // Never the keyboard, mouse, consumer, input-style usage-0 or any vendor collection of the same board.
            for (page, usage) in [(0x0001, 0x0006), (0x0001, 0x0002), (0x0001, 0x0000), (0x0001, 0x0001), (0x0007, 0x0006), (0x000c, 0x0001), (0xff00, 0x0001), (0xff02, 0x0002)] {
                assert!(channel(v, p, page, usage).is_none(), "{v:04x}:{p:04x} {page:04x}:{usage:04x} must stay closed");
            }
            assert!(listed(v, p));
        }
        let mut st = State::new(0);
        let lighting = {
            let mut d = vec![0u8; 64];
            d[..13].copy_from_slice(&[1, 1, 2, 0x29, 10, 0, 3, 5, 255, 255, 255, 0, 5]);
            d
        };
        assert!(check(c, &mut st, Transport::Feature, 0x0a, &lighting).is_ok());
        assert!(check(c, &mut st, Transport::Output, 0x0a, &lighting).is_err(), "output reports are never sent");
        assert!(check(c, &mut st, Transport::Feature, 0, &lighting).is_err(), "report 0x0A only");
        assert!(check(c, &mut st, Transport::Feature, 0x0a, &lighting[..63]).is_err());
        // Another SinoWealth id (an AULA or Redragon board on 258A) is nobody's.
        assert!(device(0x258a, 0x010c).is_none() && device(0x258a, 0x1006).is_none());
    }

    /// `src/lib/brands/sparklink/sparklink-frames.txt`: `<1|0> <hex>` of the 64 bytes of output report 0.
    #[test]
    fn sparklink_matches_its_frames() {
        agree("sparklink", sparklink, 0, include_str!("../../src/lib/brands/sparklink/sparklink-frames.txt"), 64, 9000);
    }

    #[test]
    fn sparklink_opens_only_its_vendor_collection() {
        let all: Vec<(u16, u16)> = ids::SPARKLINK.to_vec();
        for &(v, p) in &all {
            let c = device(v, p).unwrap_or_else(|| panic!("{v:04x}:{p:04x} has no channel"));
            assert_eq!((c.brand, c.kind), ("SparkLink", "keyboard"));
            assert!(channel(v, p, 0xffa0, 0x0001).is_some(), "{v:04x}:{p:04x} ffa0:0001");
            for (page, usage) in [(0x0001, 0x0006), (0x0001, 0x0002), (0x0001, 0x0080), (0x000c, 0x0001), (0xff00, 0x0001), (0xffa0, 0x0002), (0xffb0, 0x0001), (0xff60, 0x0061)] {
                assert!(channel(v, p, page, usage).is_none(), "{v:04x}:{p:04x} {page:04x}:{usage:04x} must stay closed");
            }
            assert_eq!(c.takes, Takes::Output);
            assert_eq!(c.report_ids, &[0]);
            assert!(listed(v, p));
        }
        let n = all.len();
        let mut sorted = all.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), n, "no repeated id");
        assert_eq!(n, 56);
        // Kochi's Hummingbird 68 is OpenMouse's keyboard id too: the brand channel is the one that opens it.
        assert!(all.contains(&(0x1ca2, 0x0901)));
    }

    #[test]
    fn sparklink_refuses_firmware_reset_calibration_and_unlisted_writes() {
        let frame = |cmd: u8, data: &[u8]| {
            let mut f = vec![0u8; 64];
            f[0] = 0x5c;
            f[1] = data.len() as u8;
            f[2] = cmd;
            f[4..4 + data.len()].copy_from_slice(data);
            f[3] = sl_checksum(&f);
            f
        };
        // The reads and the Windows / Mac switch pass.
        for order in [0x01u8, 0x25, 0x26, 0x21, 0x22, 0x50, 0x70] {
            assert!(sparklink(0, &frame(0, &[order, 0xff, 0xff])).is_ok(), "order {order:#04x}");
        }
        assert!(sparklink(0, &frame(0, &[0x30, 0xff, 0xff])).is_ok());
        // Never: factory reset, calibration, macro erase, saving, the bootloader classes, screen pictures, advanced keys.
        for order in [0x11u8, 0x04, 0x0c, 0x0d, 0x10, 0x02, 0x03, 0x32, 0x33, 0x40] {
            assert!(sparklink(0, &frame(0, &[order, 0xff, 0xff])).is_err(), "order {order:#04x}");
        }
        for cmd in [8u8, 9, 10, 11, 12, 13, 14, 18, 32, 33, 36, 37, 38, 39, 40, 44, 45, 48, 49] {
            assert!(sparklink(0, &frame(cmd, &[1, 2, 3, 4])).is_err(), "class {cmd}");
        }
        // Key layouts: a travel write passes, the switch type never does, a mode write names no advanced mode.
        assert!(sparklink(0, &frame(35, &[1, 4, 4, 0xdc, 0x05])).is_ok(), "1.5 mm on key 4");
        assert!(sparklink(0, &frame(35, &[1, 4, 8, 0x10, 0x00])).is_ok(), "single mode");
        assert!(sparklink(0, &frame(35, &[1, 4, 8, 0x13, 0x00])).is_err(), "advanced mode bits");
        assert!(sparklink(0, &frame(35, &[1, 4, 25, 1, 0])).is_err(), "axis");
        assert!(sparklink(0, &frame(35, &[1, 4, 5, 1, 0])).is_err(), "DKS travel layout");
        assert!(sparklink(0, &frame(35, &[1, 4, 4, 0xa1, 0x0f])).is_err(), "4001 um");
        assert!(sparklink(0, &frame(35, &[1, 4, 4, 0xa0, 0x0f])).is_ok(), "4000 um");
        assert!(sparklink(0, &[frame(35, &[1, 4, 4, 0xa0, 0x0f]), vec![0]].concat()).is_err(), "65 bytes");
        assert!(sparklink(4, &frame(35, &[1, 4, 4, 0xa0, 0x0f])).is_err(), "report 4");
    }

    #[test]
    fn razer_matches_its_frames() {
        agree("razer", razer, 0, include_str!("../../src/lib/brands/razer/razer-frames.txt"), 90, 5000);
    }

    #[test]
    fn asus_matches_its_frames() {
        let mut results = vec![];
        for line in include_str!("../../src/lib/brands/asus/asus-frames.txt").lines().filter(|l| !l.trim().is_empty()) {
            let p: Vec<&str> = line.split_whitespace().collect();
            let (want, pid) = (p[0] == "1", u16::from_str_radix(p[1], 16).unwrap());
            let mut f = unhex(p.get(2).copied().unwrap_or(""));
            f.resize(64, 0);
            let got = asus(pid, &f);
            assert_eq!(got.is_ok(), want, "asus {line} -> {got:?}");
            results.push((want, true));
        }
        tally("asus", &results, 5000);
        assert!(asus_rules().bootloader.iter().all(|p| ids::ASUS_BOOTLOADER.contains(p)) && asus_rules().bootloader.len() == ids::ASUS_BOOTLOADER.len());
    }

    #[test]
    fn corsair_matches_its_frames() {
        let (mut bragi_n, mut sabre_n) = (vec![], vec![]);
        for line in include_str!("../../src/lib/brands/corsair/corsair-frames.txt").lines().filter(|l| !l.trim().is_empty()) {
            let p: Vec<&str> = line.split_whitespace().collect();
            let (want, pid, open) = (p[0] == "1", u16::from_str_radix(p[1], 16).unwrap(), p[2]);
            let mut f = unhex(p.get(3).copied().unwrap_or(""));
            if ids::CORSAIR_SABRE.contains(&pid) {
                f.resize(16, 0);
                let got = sabre(8, &f);
                assert_eq!(got.is_ok(), want, "sabre {line} -> {got:?}");
                sabre_n.push((want, true));
            } else {
                f.resize(64, 0);
                let open = if open == "-" { None } else { Some(open.parse::<u16>().unwrap()) };
                let got = bragi(pid, open, 64, &f);
                assert_eq!(got.is_ok(), want, "bragi {line} -> {got:?}");
                bragi_n.push((want, true));
            }
        }
        tally("bragi", &bragi_n, 1000);
        tally("sabre", &sabre_n, 100);
    }

    /// The bridge remembers the file from the last allowed open and refuses data writes to anything else.
    #[test]
    fn corsair_writes_need_an_open_profile_file() {
        let c = device(0x1b1c, 0x2b0e).expect("K70 MAX-class Bragi keyboard");
        let mut st = State::new(0x2b0e);
        let frame = |cmd: u8, rest: &[u8]| {
            let mut f = vec![0u8; 64];
            f[1] = 0x01;
            f[3] = cmd;
            f[4..4 + rest.len()].copy_from_slice(rest);
            f
        };
        let write = frame(0x06, &[0, 8, 0, 0, 0]);
        assert!(check(c, &mut st, Transport::Output, 0, &write).is_err(), "no file open");
        assert!(check(c, &mut st, Transport::Output, 0, &frame(0x0d, &[0, 0x0f, 0])).is_ok(), "open the readable file 15");
        assert!(check(c, &mut st, Transport::Output, 0, &write).is_err(), "file 15 isn't a profile file");
        assert!(check(c, &mut st, Transport::Output, 0, &frame(0x05, &[1, 0])).is_ok());
        let profile = 28100u16.to_le_bytes();
        assert!(check(c, &mut st, Transport::Output, 0, &frame(0x0d, &[0, profile[0], profile[1]])).is_ok());
        assert!(check(c, &mut st, Transport::Output, 0, &write).is_ok(), "profile file open");
        assert!(check(c, &mut st, Transport::Output, 0, &frame(0x05, &[1, 0])).is_ok());
        assert!(check(c, &mut st, Transport::Output, 0, &write).is_err(), "closed again");
        let identity = 31000u16.to_le_bytes();
        assert!(check(c, &mut st, Transport::Output, 0, &frame(0x0d, &[0, identity[0], identity[1]])).is_err(), "identity files are never opened");
        assert_eq!(st.open_file, None);
    }

    #[test]
    fn icue_matches_its_frames() {
        let mut results = vec![];
        for line in include_str!("../../src/lib/brands/corsair-icue/corsair-icue-frames.txt").lines().filter(|l| !l.trim().is_empty()) {
            let (verdict, hex) = line.split_once(' ').unwrap();
            let bytes = unhex(hex.trim());
            let mut d = bytes.get(1..).unwrap_or(&[]).to_vec();
            d.resize(64, 0);
            d.truncate(64);
            let got = icue(bytes[0], &d);
            assert_eq!(got.is_ok(), verdict == "1", "icue {line} -> {got:?}");
            results.push((verdict == "1", true));
        }
        tally("icue", &results, 100);
    }

    fn example_feature_map() -> Logi {
        let mut l = Logi::default();
        for (i, f) in [
            (0x01, 0x0001),
            (0x02, 0x0003),
            (0x03, 0x0005),
            (0x04, 0x8060),
            (0x05, 0x8061),
            (0x06, 0x8040),
            (0x07, 0x8071),
            (0x08, 0x8081),
            (0x09, 0x8100),
            (0x0a, 0x1b08),
            (0x0b, 0x00d0),
            (0x0c, 0x1802),
            (0x0d, 0x1e00),
            (0x0e, 0x1b30),
            (0x0f, 0x8101),
            (0x10, 0x1500),
            (0x11, 0x1b05),
        ] {
            l.map.insert(i, f);
        }
        l
    }

    #[test]
    fn logitech_kb_matches_its_frames() {
        let mut l = example_feature_map();
        let mut results = vec![];
        for line in include_str!("../../src/lib/brands/logitech-kb/logitech-kb-frames.txt").lines().filter(|l| !l.trim().is_empty()) {
            let (verdict, hex) = line.split_once(' ').unwrap();
            let bytes = unhex(hex.trim());
            let len = match bytes[0] {
                0x10 => 6,
                0x11 => 19,
                0x12 => 63,
                _ => bytes.len() - 1,
            };
            let mut d = bytes[1..].to_vec();
            d.resize(len, 0);
            let got = logitech_kb(&mut l, bytes[0], &d);
            assert_eq!(got.is_ok(), verdict == "1", "logitech {line} -> {got:?}");
            results.push((verdict == "1", true));
        }
        tally("logitech", &results, 300);
    }

    /// Feature indexes come only from the device's own IRoot replies, as the reader sees them.
    #[test]
    fn logitech_kb_learns_feature_indexes_from_iroot_replies() {
        let c = device(0x046d, 0xc339).expect("a Logitech G keyboard");
        let mut st = State::new(0xc339);
        let mut set_rate = vec![0u8; 6];
        set_rate[..4].copy_from_slice(&[0xff, 0x04, 0x2a, 0x01]);
        assert!(check(c, &mut st, Transport::Output, 0x10, &set_rate).is_err(), "index 4 not resolved yet");
        // getFeature(0x8060), software id 0xa.
        assert!(check(c, &mut st, Transport::Output, 0x10, &[0xff, 0x00, 0x0a, 0x80, 0x60, 0x00]).is_ok());
        st.logi.lock().unwrap().observe(0x11, &[0xff, 0x00, 0x0a, 0x04, 0x00, 0x00]);
        assert!(check(c, &mut st, Transport::Output, 0x10, &set_rate).is_ok(), "report rate write once resolved");
        // A reply naming DFU keeps that index blocked.
        assert!(check(c, &mut st, Transport::Output, 0x10, &[0xff, 0x00, 0x0b, 0x00, 0xd0, 0x00]).is_ok());
        st.logi.lock().unwrap().observe(0x11, &[0xff, 0x00, 0x0b, 0x09, 0x00, 0x00]);
        assert!(check(c, &mut st, Transport::Output, 0x10, &[0xff, 0x09, 0x1b, 0, 0, 0]).is_err());
        // An unsolicited reply (no pending request) teaches nothing.
        st.logi.lock().unwrap().observe(0x11, &[0xff, 0x00, 0x0c, 0x0a, 0x00, 0x00]);
        assert!(check(c, &mut st, Transport::Output, 0x10, &[0xff, 0x0a, 0x2c, 0, 0, 0]).is_err());
    }

    /// The TS test pads each line by its natural shape (protocol.ts naturalShape).
    fn ss_shape(d: &[u8]) -> (Transport, usize) {
        let (op, d1) = (d.first().copied().unwrap_or(0), d.get(1).copied().unwrap_or(0));
        if op == 0x38 && (d1 == 0x66 || d1 == 0x67) {
            (Transport::Output, 64)
        } else if [0x31, 0x3a, 0x03, 0x83].contains(&op) {
            (Transport::Feature, 642)
        } else if [0x38, 0x40, 0x36, 0xb6].contains(&op) {
            (Transport::Feature, 644)
        } else if [0x6f, 0x76, 0x77, 0x61, 0x2f, 0x37, 0x21, 0x54, 0x43, 0x4a, 0x4c, 0x0a].contains(&op) {
            (Transport::Feature, 641)
        } else {
            (Transport::Output, 64)
        }
    }

    #[test]
    fn steelseries_matches_its_frames() {
        let mut results = vec![];
        for line in include_str!("../../src/lib/brands/steelseries/steelseries-frames.txt").lines().filter(|l| !l.is_empty()) {
            let (verdict, hex) = line.split_once(' ').unwrap_or((line, ""));
            let bytes = unhex(hex.trim());
            assert_eq!(bytes.first().copied().unwrap_or(0), 0, "report id byte");
            let mut d = bytes.get(1..).unwrap_or(&[]).to_vec();
            let (transport, len) = ss_shape(&d);
            d.resize(len, 0);
            let got = steelseries(None, transport, 0, &d);
            assert_eq!(got.is_ok(), verdict == "1", "steelseries {} -> {got:?}", &line[..line.len().min(60)]);
            results.push((verdict == "1", true));
        }
        tally("steelseries", &results, 2000);
    }

    /// AnalogSense's fixed requests: Bytech's must match exactly, DrunkDeer's must pass the DrunkDeer guard.
    #[test]
    fn analog_requests_pass_the_brand_guards() {
        let mut checked = 0;
        for line in include_str!("../../src/lib/kb/analogsense/analogsense-frames.txt").lines().filter(|l| !l.is_empty()) {
            let p: Vec<&str> = line.split_whitespace().collect();
            let (verdict, family, report, len, hex) = (p[0] == "1", p[1], p[2].parse::<u8>().unwrap(), p[3].parse::<usize>().unwrap(), p.get(4).copied().unwrap_or(""));
            let mut f = unhex(hex);
            f.resize(len, 0);
            match family {
                "bytech" => assert_eq!(bytech(report, &f).is_ok(), verdict, "bytech {hex}"),
                "drunkdeer" if verdict => assert!(drunkdeer(report, &f).is_ok(), "the depth request must pass: {hex}"),
                _ => continue,
            }
            checked += 1;
        }
        assert!(checked >= 5);
    }

    /// Every id any table names, with its vendor id.
    fn all_ids() -> Vec<(u16, u16)> {
        let mut v: Vec<(u16, u16)> = vec![];
        v.extend(ids::SONIX);
        v.extend(ids::MONSGEEK);
        v.extend(ids::DRUNKDEER);
        v.extend(ids::DRUNKDEER_X60);
        v.extend(ids::BYTECH);
        v.extend(ids::FW19F5_MCHOSE.iter().chain(&ids::FW19F5_DRUNKDEER).chain(&ids::FW19F5_NUPHY).chain(&ids::FW19F5_RK_GCOME).chain(&ids::RK_BEIYING));
        v.extend(ids::RAZER_KEYBOARDS.iter().chain(&ids::RAZER_BRAND_MICE).map(|&p| (0x1532, p)));
        v.extend(asus_rules().family.keys().chain(&ids::ASUS_BOOTLOADER).map(|&p| (0x0b05, p)));
        v.extend(ids::CORSAIR_BRAGI_KEYBOARDS.iter().chain(&ids::CORSAIR_BRAGI_MICE).chain(&ids::CORSAIR_SABRE).chain(&ids::ICUE_KEYBOARDS).chain(&ids::ICUE_MICE).map(|&p| (0x1b1c, p)));
        v.extend(ids::LOGITECH_KEYBOARDS.iter().map(|&p| (0x046d, p)));
        v.extend(ids::STEELSERIES.iter().chain(&ids::STEELSERIES_BOOTLOADER).map(|&p| (0x1038, p)));
        v
    }

    #[test]
    fn every_channel_is_a_config_collection_with_a_known_report() {
        for c in CHANNELS {
            for &(page, usage) in c.collections {
                // Vendor pages, plus the two input-page exceptions: Razer's Consumer Control (feature reports only) and the
                // 0x19F5 family's Generic Desktop usage 0 (not the keyboard, mouse or system-control usage).
                let exception = (c.brand == "Razer" && (page, usage) == (0x000c, Some(0x0001)))
                    || (matches!(c.guard, Guard::Fw19f5(_)) && (page, usage) == (0x0001, Some(0x0000)))
                    || (c.brand == "Royal Kludge" && c.takes == Takes::Feature && (page, usage) == (0x0001, Some(0x0080)))
                    // The Logitech G535 takes HID++ long reports (0x11) on its Consumer Control collection (HeadsetControl).
                    || (c.kind == "headset" && c.report_ids == [0x11] && (page, usage) == (0x000c, Some(0x0001)));
                assert!(page >= 0xff00 || exception, "{} {page:04x}", c.brand);
                // ASUS: never the in-place firmware pages or the key-event pages. Corsair: never FF42:0002.
                assert!(!(0xff13..=0xff15).contains(&page) && !(0xffc0..=0xffc2).contains(&page) || c.brand == "SteelSeries", "{} {page:04x}", c.brand);
                assert!(!(page == 0xff42 && usage != Some(0x0001)), "Corsair key presses");
            }
            let mut st = State::new(0);
            let wrong_id = (0..=255u8).find(|r| !c.report_ids.contains(r)).unwrap();
            let t = if c.takes == Takes::Feature { Transport::Feature } else { Transport::Output };
            assert!(check(c, &mut st, t, wrong_id, &[0u8; 64]).is_err(), "{} wrong report id", c.brand);
            if c.takes != Takes::Both {
                let other = if c.takes == Takes::Output { Transport::Feature } else { Transport::Output };
                assert!(check(c, &mut st, other, c.report_ids[0], &[0u8; 64]).is_err(), "{} wrong transport", c.brand);
            }
            // An all-zero frame is nobody's command.
            assert!(check(c, &mut st, t, c.report_ids[0], &[0u8; 64]).is_err(), "{} zero frame", c.brand);
        }
        assert!(device(0x05ac, 0x024f).is_none(), "Apple's id is left out");
        assert!(device(0x0c45, 0x636b).is_none(), "a Sonix webcam id isn't a keyboard");
        assert!(x60_name("DrunkDeer X60") && x60_name("X60 HE") && !x60_name("Gaming Keyboard"));
    }

    /// One channel per id, never a bootloader, never the user's Falchion, never an id OpenMouse pins.
    #[test]
    fn each_id_has_at_most_one_channel() {
        for (v, p) in all_ids() {
            let n = CHANNELS.iter().filter(|c| (c.ids)(v, p)).count();
            assert!(n <= 1, "{v:04x}:{p:04x} is claimed by {n} channels");
        }
        for &p in ids::ASUS_BOOTLOADER.iter() {
            assert!(device(0x0b05, p).is_none(), "ASUS bootloader {p:04x}");
        }
        for &p in ids::STEELSERIES_BOOTLOADER.iter() {
            assert!(device(0x1038, p).is_none(), "SteelSeries bootloader {p:04x}");
        }
        assert!(device(0x0b05, 0x1d1d).is_none(), "the Falchion ZywOo stays on its own panel");
        assert_eq!(device(0x0b05, 0x1b7e).map(|c| c.brand), Some("ASUS"), "plain Falchion HFX is the ASUS driver's");
        assert_eq!(device(0x1b1c, 0x1bc0).map(|c| c.brand), Some("Corsair iCUE"), "K70 MAX");
        for &(v, p, _, _) in crate::openmouse_ids::FILTERS.iter() {
            if let Some(p) = p {
                assert!(device(v, p).is_none(), "OpenMouse pins {v:04x}:{p:04x}");
            }
        }
    }

    #[test]
    fn steelseries_reports_are_report_zero_and_never_flash() {
        let c = device(0x1038, 0x1642).expect("an Apex Pro single-board id");
        let mut st = State::new(0x1642);
        let mut fw = vec![0u8; 64];
        fw[0] = 0x90;
        assert!(check(c, &mut st, Transport::Output, 0, &fw).is_ok(), "firmware version read");
        assert!(check(c, &mut st, Transport::Output, 1, &fw).is_err());
        // Narrowed to the board's family: a legacy brightness write is refused on a single board.
        let mut legacy = vec![0u8; 64];
        legacy[..2].copy_from_slice(&[0x23, 5]);
        assert!(check(c, &mut st, Transport::Output, 0, &legacy).is_err());
        let old = device(0x1038, 0x1610).expect("an Apex legacy id");
        assert!(check(old, &mut State::new(0x1610), Transport::Output, 0, &legacy).is_ok());
        assert!(steelseries(None, Transport::Output, 0, &legacy).is_ok());
        for op in [0x02u8, 0x03, 0xb1, 0xe6, 0xa6, 0x88, 0x05] {
            let mut f = vec![0u8; 64];
            f[0] = op;
            assert!(check(c, &mut st, Transport::Output, 0, &f).is_err(), "op {op:02x}");
        }
    }
}
