//! Native HID transport for the WebHID-based drivers in `@openmouse/protocol`, the keyboard
//! service and the ATK mouse service.
//!
//! The frontend installs a `navigator.hid` stand-in that forwards here, so the drivers run
//! unchanged. Devices are grouped the way Chrome groups them on Windows: one device per USB
//! interface, carrying every top-level collection of that interface. Each collection is its own
//! Windows HID path, so a report goes to whichever opened collection accepts its report ID, or to
//! a named collection with `send_report_to`.
//!
//! This module moves bytes and has no firmware or bootloader paths. The two protocols it knows are a
//! shape check for the X68 HE (`x68_frame_allowed`), which refuses that keyboard's reset, firmware
//! and calibration commands even if the frontend asked for them, and one refusal for Razer's
//! device-mode command (`razer_frame_allowed`).
//!
//! Razer mice that take their settings as feature reports on the Generic Desktop mouse or Consumer
//! Control collection are opened *feature-only* (`Access::FeatureOnly`, module `feature_only`): no
//! reader thread, no input report ever read, no output report ever written, nothing about movement or
//! clicks leaves Rust.
//!
//! Linux (and other Unix systems): one hidraw node carries every collection of a USB interface, so the
//! per-collection rules above are applied per report id instead: each node is planned from its report
//! descriptor before it is opened (`crate::hid_plan`), only the input reports of an allowed collection are
//! passed on (keystrokes and mouse movement are dropped in Rust), and only that collection's own output and
//! feature reports are written. The guards below run unchanged on every platform.

use hidapi::{HidApi, HidDevice};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[cfg(unix)]
use std::ffi::CStr;
use std::ffi::CString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Vendors SYNQ drives with its own hand-built code: Logitech (the DEX), ASUS (the keyboard), ATK
/// (the X1 V2 Air+) and the MAGIC-REFINER X68 HE's chip vendor (0x2E3C). Every other mouse comes from
/// OpenMouse's own device table (`openmouse_ids.rs`): vendor-defined collections only, plus, for the
/// Razer ids in `RAZER_FEATURE_ONLY_PIDS`, their mouse / consumer collection for feature reports only.
pub(crate) const LOGITECH: u16 = 0x046d;
/// Usage pages that carry what a person types or points (Generic Desktop, Keyboard, Consumer,
/// Digitizer). Never listed or opened for an OpenMouse device, even when its filter names one.
const INPUT_PAGES: [u16; 4] = [0x0001, 0x0007, 0x000c, 0x000d];
const ASUS: u16 = 0x0b05;
/// ASUS makes a lot of HID devices (motherboard lighting, Armoury Crate's own hardware). The ROG
/// Falchion Ace HFX ZywOo is hand-built here (its own panel); the keyboards and mice the ASUS brand
/// driver knows open only their Gear Link channel (src/brands.rs); nothing else from ASUS is touched.
pub(crate) const ASUS_PRODUCTS: [u16; 1] = [0x1d1d];
const ATK: u16 = 0x373b;
/// ATK (Compx) ships keyboards and many mice under one vendor id. Only the X1 V2 Air+ is listed:
/// its "Wireless mouse 8k dongle-L" receiver and the mouse's own id on a cable (from ATK HUB's table).
pub(crate) const ATK_PRODUCTS: [u16; 2] = [0x1278, 0x12a2];
/// The one ATK collection SYNQ opens: the vendor config channel (report 0x08, 16-byte frames).
/// The pointer, keyboard, consumer and other vendor collections are never listed or opened.
const ATK_CONFIG_COLLECTION: (u16, u16) = (0xff02, 0x0002);
/// 0x2E3C is shared by many keyboards; only the ids in `brand_ids::ILLUMIPC` (generated from
/// src/lib/illumipc/ids.ts: 2E3C:C365, its gamepad-mode personalities C366..C368, and Redragon's 0416:7372) are
/// listed: the MAGIC-REFINER X68 HE and the other boards illumipc.com drives on them.
fn illumipc(vendor_id: u16, product_id: u16) -> bool {
    crate::brand_ids::ILLUMIPC.contains(&(vendor_id, product_id))
}
/// The one X68 collection SYNQ opens: illumipc's configurator channel (usage page 0xFF1B, usage
/// 0x91, report id 1, 63-byte output and input reports). The keyboard, consumer and other collections
/// are never listed or opened.
pub const X68_CONFIG_COLLECTION: (u16, u16) = (0xff1b, 0x0091);
pub const X68_REPORT_ID: u8 = 1;
pub const X68_FRAME_LEN: usize = 63;
const READ_TIMEOUT_MS: i32 = 100;
const FEATURE_BUFFER: usize = 65;
/// Razer's control reports are 90 bytes (91 with the report id); Windows refuses a smaller buffer.
const RAZER_FEATURE_BUFFER: usize = 256;
const RAZER: u16 = 0x1532;
/// The only two collections a feature-only Razer is opened on: Generic Desktop Mouse and Consumer
/// Control (usage page, usage). Its keyboard and system-control collections are never touched.
const RAZER_FEATURE_COLLECTIONS: [(u16, u16); 2] = [(0x0001, 0x0002), (0x000c, 0x0001)];
const RAZER_PACKET_LEN: usize = 90;
/// hidapi's HID_API_MAX_REPORT_DESCRIPTOR_SIZE.
const DESCRIPTOR_BUFFER: usize = 4096;

pub fn allowed(vendor_id: u16, product_id: u16) -> bool {
    if bootloader_id(vendor_id, product_id) {
        return false;
    }
    // A game controller (src/pads.rs): allowed when it's a HID pad. An XInput pad is read through XInput
    // (src/xinput.rs) and never opened here, whatever its vendor's other rules say.
    if crate::pads::is_pad(vendor_id, product_id) {
        return crate::pads::hid_pad(vendor_id, product_id);
    }
    // A brand driver's device (src/brands.rs): allowed, and only its own channel ever opens.
    if crate::brands::device(vendor_id, product_id).is_some() {
        return true;
    }
    // The keyboards illumipc.com's configurator drives: allowed, and only FF1B:0091 ever opens (`full_access`).
    if illumipc(vendor_id, product_id) {
        return true;
    }
    match vendor_id {
        LOGITECH => true,
        ASUS => ASUS_PRODUCTS.contains(&product_id) || openmouse_device(vendor_id, product_id),
        ATK => ATK_PRODUCTS.contains(&product_id) || openmouse_device(vendor_id, product_id),
        v => openmouse_device(v, product_id) || keyboard_device(v, product_id),
    }
}

/// USB identities devices take in firmware-update (bootloader / DFU) mode. Such a device is never
/// listed, opened or written, whatever else would allow it (a vendor-wide filter, Logitech's "every
/// collection"): it belongs to the maker's update tool, and some bootloaders latch across replugs.
/// The same table as src/lib/bootloader-ids.ts (compared by scripts/kb-safety.test.ts).
pub const BOOTLOADER_IDS: [(u16, u16); 125] = [
    (0x3367, 0x1977), // Endgame Gear OP1 8K v2 bootloader (latches)
    (0x373e, 0xb01c), // Lamzu Maya X
    (0x373e, 0xb01d), // Lamzu Maya X 1K receiver
    (0x373e, 0xb01e), // Lamzu Maya X 4K/8K receiver
    (0x37b0, 0x0002), // Lamzu 4K/8K receiver
    (0x37b0, 0x0004), // Lamzu Paro 1K receiver
    (0x37b0, 0x0006), // Lamzu Tachi
    (0x37b0, 0x0008), // Lamzu Paro
    (0x37b0, 0x000a), // Lamzu Inca
    (0x37b0, 0x0012), // Lamzu Maya
    (0x37b0, 0x0018), // Lamzu Thorn
    (0x37b0, 0x0033), // Lamzu Thorn V2 receiver
    (0x37b0, 0x0041), // Lamzu Thorn V2
    (0x373e, 0xb032), // LunaFury
    (0x373e, 0xb033),
    (0x373e, 0xb054),
    (0x373e, 0xb084),
    (0x361d, 0x0111), // Finalmouse UltralightX (mouse bootloader)
    (0x361d, 0x0201), // Finalmouse keyboard bootloader
    (0x1fc9, 0x0021), // NXP bootloaders Finalmouse's Xpanel asks for
    (0x1fc9, 0x0022),
    (0x2e3c, 0xaf01), // Pulsar ZywOo route (assumed bootloader)
    (0x0b05, 0x1948), // ASUS Gear Link OTA bootloader_pid fields (asus/devices.ts ASUS_BOOTLOADER_PIDS)
    (0x0b05, 0x194a),
    (0x0b05, 0x1aaf),
    (0x0b05, 0x1ab6),
    (0x0b05, 0x1acf),
    (0x0b05, 0x1ad1),
    (0x0b05, 0x1b40),
    (0x0b05, 0x1b7f),
    (0x0b05, 0x1c11),
    (0x0b05, 0x1c6a),
    (0x0b05, 0x1c7e),
    (0x0b05, 0x1cad),
    (0x0b05, 0x1ce9),
    (0x0b05, 0x1cf0),
    (0x0b05, 0x1d46),
    (0x0b05, 0x1d4d),
    (0x0b05, 0x1d69),
    (0x0b05, 0x1d6d),
    (0x0b05, 0x1d7b),
    (0x0b05, 0x1da3),
    (0x0b05, 0x1ddf),
    (0x0b05, 0x1de1),
    (0x0b05, 0x1df4),
    (0x0b05, 0x1df6),
    (0x0b05, 0x1e0b),
    (0x0b05, 0x1e4d),
    (0x0b05, 0x1e5c),
    (0x1038, 0x1611), // SteelSeries Apex bootloaders (each keyboard's PID + 1; steelseries/devices.ts BOOTLOADER_PIDS)
    (0x1038, 0x1613),
    (0x1038, 0x1615),
    (0x1038, 0x1617),
    (0x1038, 0x1619),
    (0x1038, 0x161b),
    (0x1038, 0x161d),
    (0x1038, 0x1623),
    (0x1038, 0x1625),
    (0x1038, 0x1627),
    (0x1038, 0x1629),
    (0x1038, 0x1631),
    (0x1038, 0x1633),
    (0x1038, 0x1641),
    (0x1038, 0x1643),
    (0x1038, 0x1645),
    (0x1038, 0x1647),
    (0x1038, 0x1651),
    (0x1038, 0x1653),
    (0x1038, 0x1661),
    (0x1038, 0x1663),
    (0x046d, 0x0ad0), // Logitech (OpenMouse LOGITECH_BOOTLOADER_PRODUCT_IDS)
    (0x046d, 0x0ad2),
    (0x046d, 0x0ad3),
    (0x046d, 0x0ad6),
    (0x046d, 0xab24), // Logitech LIGHTSPEED receiver bootloader (seen live)
    (0x16c0, 0x0478), // PJRC HalfKay (Teensy keyboards)
    (0x16c0, 0x05df), // V-USB bootloadHID
    (0x03eb, 0x2067), // QMK HID bootloader
    (0x0483, 0xdf11), // STM32 DFU
    (0x19f5, 0x0720), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x0721), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x0722), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x0723), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x0724), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x072b), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x072c), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x072d), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x072e), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x072f), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x0730), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x0731), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x0732), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x0733), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x0734), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x0735), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x0736), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x0737), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x0738), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x0739), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x073a), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x073b), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x073c), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x073f), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x0740), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x0742), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x0743), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x0744), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x6f03), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x6f04), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x6f10), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x6f11), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x8a04), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x8a11), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x8a1a), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x8a1c), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x8a1d), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x8a27), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x8a3d), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x8a3e), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x8a40), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0x8a44), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0xfe00), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0xff02), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0xff20), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
    (0x19f5, 0xff5a), // 0x19F5 family upgrader (NuPhy / Royal Kludge; fw19f5 devices.ts)
];
/// Whole product-id ranges a vendor uses only for update mode: (vendor id, first, last).
pub const BOOTLOADER_RANGES: [(u16, u16, u16); 2] = [
    (0x19f5, 0xaf00, 0xafff), // NuPhy upgrader PIDs (19F5:AFxx)
    (0x03eb, 0x2ff0, 0x2ff9), // Atmel DFU bootloaders
];

pub fn bootloader_id(vendor_id: u16, product_id: u16) -> bool {
    BOOTLOADER_IDS.contains(&(vendor_id, product_id))
        || BOOTLOADER_RANGES.iter().any(|&(v, from, to)| v == vendor_id && (from..=to).contains(&product_id))
        || crate::pads::boot(vendor_id, product_id)
}

/// A product string only a device in update mode reports: the whole word "bootloader" or "dfu",
/// "boot device", or "firmware update mode" (case-insensitive; "Reboot" or a model name don't count).
pub fn bootloader_name(product: &str) -> bool {
    let lower = product.to_ascii_lowercase();
    let words: Vec<&str> = lower.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).collect();
    words.iter().any(|w| *w == "bootloader" || *w == "dfu" || *w == "bootdevice")
        || words.windows(2).any(|p| p == ["boot", "device"])
        || words.windows(3).any(|p| p == ["firmware", "update", "mode"])
}

/// In firmware-update mode, by id or by what it calls itself.
pub fn in_bootloader(vendor_id: u16, product_id: u16, product: Option<&str>) -> bool {
    bootloader_id(vendor_id, product_id) || product.is_some_and(bootloader_name)
}

/// A keyboard @openmouse/keyboard-protocol drives (Wooting, Wuque Studio, Kochi), by vendor and product id.
pub fn keyboard_device(vendor_id: u16, product_id: u16) -> bool {
    crate::openmouse_ids::KEYBOARD_FILTERS.iter().any(|&(v, p, _, _)| v == vendor_id && p == product_id)
}

/// That keyboard's configuration collection, exactly as the generated table names it. The table never
/// holds a typing, pointing or consumer page; this checks again.
pub fn keyboard_collection(vendor_id: u16, product_id: u16, usage_page: u16, usage: u16) -> bool {
    !INPUT_PAGES.contains(&usage_page) && crate::openmouse_ids::KEYBOARD_FILTERS.contains(&(vendor_id, product_id, usage_page, usage))
}

/// QMK's raw-HID collection, which VIA and Vial talk through: 32-byte output and input reports, no
/// report id. It is the only collection a keyboard from a vendor SYNQ doesn't otherwise know may be
/// opened. Never for ASUS (only the Falchion is ever touched there) or the X68 HE (its own checked channel).
pub const QMK_RAW_COLLECTION: (u16, u16) = (0xff60, 0x0061);

pub fn qmk_raw_hid(vendor_id: u16, product_id: u16, usage_page: u16, usage: u16) -> bool {
    (usage_page, usage) == QMK_RAW_COLLECTION
        && vendor_id != ASUS
        && !illumipc(vendor_id, product_id)
        && !bootloader_id(vendor_id, product_id)
}

/// Whether frames to this collection pass `via_frame_allowed`: every QMK raw-HID collection, except one
/// an OpenMouse filter names by product id for its own protocol on that page (Keychron's Nape Pro mouse,
/// the AJAZZ AK820), whose driver allowlist governs it instead.
pub fn via_guarded(vendor_id: u16, product_id: u16, usage_page: u16, usage: u16) -> bool {
    (usage_page, usage) == QMK_RAW_COLLECTION
        && !crate::openmouse_ids::FILTERS.iter().any(|&(v, p, page, _)| v == vendor_id && p == Some(product_id) && page == Some(usage_page))
}

/// Keyboards whose key depth AnalogSense reads over the raw-HID channel (src/lib/kb/analogsense), and
/// only with these exact read frames: Keychron / Lemokey 0xA9 depth reads, Madlions' 02 96 1C read.
pub(crate) const KEYCHRON_ANALOG: [(u16, u16); 10] = [
    (0x3434, 0x0b10), (0x3434, 0x0b11), (0x3434, 0x0b12), (0x3434, 0x0b30), (0x3434, 0x0b50),
    (0x3434, 0x0e20), (0x3434, 0x0e21), (0x3434, 0x0e22), (0x362d, 0x0610), (0x362d, 0x0611),
];
pub(crate) const MADLIONS_ANALOG: [(u16, u16); 10] = [
    (0x373b, 0x1053), (0x373b, 0x1054), (0x373b, 0x1055), (0x373b, 0x1056), (0x373b, 0x105d),
    (0x373b, 0x1058), (0x373b, 0x1059), (0x373b, 0x105a), (0x373b, 0x105c), (0x373b, 0x10a7),
];

/// Mirrors checkAnalogFrame (src/lib/kb/analogsense/protocol.ts) for the raw-HID families; the
/// fixture analogsense-frames.txt keeps them in step. Never a write, never calibration (0xA9 0x40...).
pub fn analog_raw_read_allowed(vendor_id: u16, product_id: u16, data: &[u8]) -> bool {
    if data.len() != 32 {
        return false;
    }
    let zero = |from: usize| data[from..].iter().all(|&b| b == 0);
    if KEYCHRON_ANALOG.contains(&(vendor_id, product_id)) && data[0] == 0xa9 {
        return ((data[1] == 0x01 || data[1] == 0x31) && zero(2)) || (data[1] == 0x30 && data[2] < 6 && data[3] < 19 && zero(4));
    }
    if MADLIONS_ANALOG.contains(&(vendor_id, product_id)) {
        return data[..6] == [0x02, 0x96, 0x1c, 0, 0, 0] && data[6] % 4 == 0 && data[6] < 75 && data[7] == 4 && zero(8);
    }
    false
}

/// Keychron / Lemokey Hall-effect keyboards take Keychron's own commands (0xA0..0xA9) beside VIA's on the same raw-HID
/// collection: a second tier that only ever widens what one of these keyboards is sent, and never touches VIA's bootloader
/// jump (0x0B) or EEPROM reset (0x0A). Mirror of `checkKeychronFrame` (src/lib/kb/via/keychron/guard.ts); the fixture
/// src/lib/kb/via/keychron/keychron-he-frames.txt keeps the two in step.
pub fn keychron_he_frame_allowed(vendor_id: u16, product_id: u16, data: &[u8]) -> Result<&'static str, String> {
    if !crate::brand_ids::KEYCHRON_HE.contains(&(vendor_id, product_id)) {
        return Err("Not a Keychron Hall-effect keyboard SYNQ knows.".into());
    }
    keychron_he_frame(data)
}

/// The static rules for one 32-byte Keychron frame (see `keychron_he_frame_allowed`).
pub fn keychron_he_frame(f: &[u8]) -> Result<&'static str, String> {
    if f.len() != 32 {
        return Err(format!("Keychron raw-HID frames are 32 bytes (got {}).", f.len()));
    }
    let zero_from = |from: usize| f[from..].iter().all(|&b| b == 0);
    let bad = || Err(format!("Blocked: Keychron command {:02x} {:02x} {:02x} {:02x} isn't on SYNQ's list.", f[0], f[1], f[2], f[3]));
    match f[0] {
        0xa0 => if zero_from(1) { Ok("keychron protocol version") } else { bad() },
        0xa1 => if zero_from(1) { Ok("keychron firmware version") } else { bad() },
        0xa2 => if zero_from(1) { Ok("keychron features") } else { bad() },
        0xaa => Err("Blocked: Keychron's wireless firmware update (0xAA).".into()),
        0xab => Err("Blocked: Keychron's factory and RF test (0xAB).".into()),
        0xa7 => {
            if f[1] == 0x11 {
                Err("Blocked: Keychron factory reset (0xA7 0x11).".into())
            } else if f[1] == 0x01 && zero_from(2) {
                Ok("keychron misc version")
            } else {
                bad()
            }
        }
        0xa9 => match f[1] {
            0x01 | 0x10 => if zero_from(2) { Ok(if f[1] == 0x01 { "analog version" } else { "analog profiles" }) } else { bad() },
            0x12 => {
                let (profile, offset, size) = (f[2], usize::from(f[3]) | usize::from(f[4]) << 8, usize::from(f[5]));
                if profile < 8 && (1..=26).contains(&size) && offset + size <= 4096 && zero_from(6) { Ok("analog profile bytes") } else { bad() }
            }
            0x14 => {
                let (profile, mode, act, sens, rls, entire) = (f[2], f[3], f[4], f[5], f[6], f[7]);
                if profile >= 8 || mode > 2 || act > 39 || sens > 39 || rls > 39 || entire > 1 {
                    return bad();
                }
                if entire == 1 {
                    if mode >= 1 && zero_from(8) { Ok("analog global travel") } else { bad() }
                } else if !zero_from(8) {
                    Ok("analog key travel")
                } else {
                    bad()
                }
            }
            0x1f => if f[2] < 8 && zero_from(3) { Ok("analog save profile") } else { bad() },
            0x1e => Err("Blocked: resetting an analog profile (0xA9 0x1E).".into()),
            0x40 => Err("Blocked: Keychron sensor calibration (0xA9 0x40).".into()),
            _ => bad(),
        },
        _ => bad(),
    }
}

/// Last line of defence for VIA / Vial (the first is src/lib/kb/via/guard.ts, which this mirrors; the
/// fixtures src/via-frames.txt (default path) and via-frames-advanced.txt (with grants) keep the two in
/// step). By default only the commands SYNQ uses get through: protocol / firmware / layout reads,
/// keymap reads and single basic-keycode writes, the three QMK lighting channels, macro reads, and
/// Vial's definition reads. Never: bootloader jump (0x0B), EEPROM reset (0x0A), bulk keymap write
/// (0x13), the switch-matrix read (which keys are held, 0x02 0x03), setting keyboard values (0x03),
/// encoder writes, and every Vial command but its reads (no unlock, lock, QMK-settings write or reset,
/// dynamic entries). Those stay refused whatever is granted.
///
/// The Advanced section can add, per live grant (src/advanced.rs): "remap" keycodes above the basic range
/// from `advanced_keycode_ok`'s list (never QK_BOOT, QK_REBOOT, QK_CLEAR_EEPROM or custom codes);
/// "macros" macro buffer writes (0x0F); "reset" the dynamic keymap reset (0x06) and macro reset (0x10).
#[cfg_attr(not(test), allow(dead_code))]
pub fn via_frame_allowed(data: &[u8]) -> Result<&'static str, String> {
    via_frame_allowed_with(data, crate::advanced::Active::NONE)
}

/// Ranges refused under every keycode encoding (mirrors NEVER_KEYCODES in src/lib/kb/via/keycode-safety.ts).
const NEVER_KEYCODES: [(u16, u16); 3] = [(0x5c00, 0x5cff), (0x7c00, 0x7cff), (0x7e00, 0xffff)];
/// Allowed above the basic range, QMK 0.19 and later (ADVANCED_KEYCODES.current).
const ADVANCED_CURRENT: [(u16, u16); 6] = [(0x0100, 0x1fff), (0x2000, 0x3fff), (0x4000, 0x4fff), (0x5000, 0x51ff), (0x5200, 0x52df), (0x7700, 0x777f)];
/// Allowed above the basic range, before QMK 0.19 (ADVANCED_KEYCODES.legacy).
const ADVANCED_LEGACY: [(u16, u16); 8] = [(0x0100, 0x1fff), (0x4000, 0x4fff), (0x5010, 0x501f), (0x5100, 0x55ff), (0x5800, 0x59ff), (0x5f12, 0x5f21), (0x6000, 0x7bff), (0x7d00, 0x7dff)];

/// Whether the Advanced remap may write this keycode on a board that uses `scheme`.
pub fn advanced_keycode_ok(code: u16, scheme: crate::advanced::Scheme) -> bool {
    if code <= 0x00ff {
        return true;
    }
    if NEVER_KEYCODES.iter().any(|&(a, b)| (a..=b).contains(&code)) {
        return false;
    }
    let list: &[(u16, u16)] = match scheme {
        crate::advanced::Scheme::Current => &ADVANCED_CURRENT,
        crate::advanced::Scheme::Legacy => &ADVANCED_LEGACY,
    };
    list.iter().any(|&(a, b)| (a..=b).contains(&code))
}

/// Largest macro write (one frame's data after the 4-byte header) and the macro memory SYNQ reaches.
const MACRO_CHUNK: usize = 28;
const MACRO_LIMIT: usize = 4096;

fn macro_write_shape(data: &[u8]) -> Result<(), &'static str> {
    let offset = usize::from(data[1]) << 8 | usize::from(data[2]);
    let size = usize::from(data[3]);
    if size < 1 || size > MACRO_CHUNK || size > data.len() - 4 {
        return Err("a macro write takes 1 to 28 bytes");
    }
    if offset + size > MACRO_LIMIT {
        return Err("macro writes stay inside the first 4096 bytes");
    }
    if data[4 + size..].iter().any(|&b| b != 0) {
        return Err("bytes after the macro data must be zero");
    }
    Ok(())
}

/// `via_frame_allowed` with the grants live on the device right now.
pub fn via_frame_allowed_with(data: &[u8], active: crate::advanced::Active) -> Result<&'static str, String> {
    use crate::advanced::Scope;
    if data.len() != 32 && data.len() != 64 {
        return Err(format!("QMK raw-HID frames are 32 bytes (got {}).", data.len()));
    }
    let blocked = |what: &str| Err(format!("Blocked: {what}."));
    match data[0] {
        0x01 => Ok("get protocol version"),
        0x02 => match data[1] {
            0x02 => Ok("get layout options"),
            0x04 => Ok("get firmware version"),
            0x03 => blocked("the switch-matrix read (it reports which keys are held)"),
            v => Err(format!("Blocked: keyboard value {v:#04x} isn't one SYNQ reads.")),
        },
        0x03 => blocked("setting keyboard values"),
        0x04 => Ok("get keycode"),
        0x05 => {
            let code = u16::from(data[4]) << 8 | u16::from(data[5]);
            if code <= 0x00ff {
                Ok("set keycode")
            } else if active.has(Scope::Remap) {
                match active.scheme {
                    Some(scheme) if advanced_keycode_ok(code, scheme) => Ok("set keycode (advanced)"),
                    _ => Err(format!("Blocked: keycode {code:#06x} isn't one SYNQ puts on a key (bootloader, reboot, EEPROM-clear and custom codes are never written).")),
                }
            } else {
                Err(format!("Blocked: keycode {code:#06x} (SYNQ only writes basic keycodes)."))
            }
        }
        0x06 => {
            if active.has(Scope::Reset) { Ok("dynamic keymap reset (advanced)") } else { blocked("dynamic keymap reset") }
        }
        0x07 => {
            let channel = (1..=3).contains(&data[1]) && (1..=4).contains(&data[2]);
            let legacy = matches!(data[1], 0x09 | 0x0a | 0x80..=0x83);
            if channel || legacy { Ok("set lighting value") } else { blocked("a custom value outside the QMK lighting channels") }
        }
        0x08 => Ok("get custom value"),
        0x09 => {
            if data[1] <= 3 { Ok("save lighting") } else { blocked("saving a custom channel") }
        }
        0x0a => blocked("EEPROM reset"),
        0x0b => blocked("bootloader jump"),
        0x0c => Ok("get macro count"),
        0x0d => Ok("get macro buffer size"),
        0x0e => Ok("get macro buffer"),
        0x0f => {
            if !active.has(Scope::Macros) {
                return blocked("macro writes");
            }
            match macro_write_shape(data) {
                Ok(()) => Ok("set macro buffer (advanced)"),
                Err(why) => blocked(why),
            }
        }
        0x10 => {
            if active.has(Scope::Reset) { Ok("macro reset (advanced)") } else { blocked("macro reset") }
        }
        0x11 => Ok("get layer count"),
        0x12 => Ok("get keymap buffer"),
        0x13 => blocked("bulk keymap write"),
        0x14 => Ok("get encoder"),
        0x15 => blocked("encoder writes"),
        0xfe => match data[1] {
            0x00 => Ok("vial keyboard id"),
            0x01 => Ok("vial definition size"),
            0x02 => Ok("vial definition page"),
            0x05 => Ok("vial unlock status"),
            v => Err(format!("Blocked: Vial command {v:#04x} (only Vial's reads are sent).")),
        },
        c => Err(format!("Blocked: QMK raw-HID command {c:#04x} isn't on SYNQ's list.")),
    }
}

/// What SYNQ may do with a collection it lists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// Open it, read its input reports and write its output and feature reports.
    Full,
    /// Feature reports only: get and set. It is never read and never written with `write()`.
    FeatureOnly,
    /// Input reports only: it is read and nothing is ever sent to it (Wooting's analog stream).
    InputOnly,
}

/// Wooting's analog-depth collections (usage pages 0xFF53 / 0xFF54): input reports only, for any
/// Wooting board (VID 0x31E3) and the original One / Two on Atmel's VID (0x03EB:0xFF01 / 0xFF02).
/// Nothing is ever sent to them; each is listed as a device of its own, so opening a board's
/// configuration channel never starts the depth stream (AnalogSense opens it for a live view only).
const WOOTING_ANALOG_PAGES: [u16; 2] = [0xff53, 0xff54];

pub fn analog_input_only(vendor_id: u16, product_id: u16, usage_page: u16, _usage: u16) -> bool {
    WOOTING_ANALOG_PAGES.contains(&usage_page)
        && (vendor_id == 0x31e3 || (vendor_id == 0x03eb && matches!(product_id, 0xff01 | 0xff02)))
        && !bootloader_id(vendor_id, product_id)
}

/// How a collection of an allowed device may be used, or `None` when it must stay closed. Everything
/// for Logitech and the Falchion (Windows keeps the pointer and keyboard ones anyway); only the config
/// channel for the X1 and the X68 HE; for every other mouse, only the vendor-defined collections
/// OpenMouse's table names, plus the one exception `razer_feature_only` describes.
pub fn collection_access(vendor_id: u16, product_id: u16, usage_page: u16, usage: u16) -> Option<Access> {
    if bootloader_id(vendor_id, product_id) {
        return None;
    }
    // A game controller: its own separate, read-only rule (src/pads.rs) and nothing else, so a pad never gets
    // a mouse or keyboard rule's access (Logitech's "everything", an OpenMouse vendor filter).
    if crate::pads::is_pad(vendor_id, product_id) {
        return crate::pads::access(vendor_id, product_id, usage_page, usage);
    }
    // A brand driver's device (src/brands.rs): its channel's collections, nothing else on the device
    // (not Logitech's "everything", not a vendor page an OpenMouse filter names).
    if crate::brands::device(vendor_id, product_id).is_some() {
        return crate::brands::channel(vendor_id, product_id, usage_page, usage).map(|c| match c.takes {
            crate::brands::Takes::Output | crate::brands::Takes::Both => Access::Full,
            crate::brands::Takes::Feature => Access::FeatureOnly,
        });
    }
    if razer_feature_only(vendor_id, product_id, usage_page, usage) {
        return Some(Access::FeatureOnly);
    }
    if analog_input_only(vendor_id, product_id, usage_page, usage) {
        return Some(Access::InputOnly);
    }
    (full_access(vendor_id, product_id, usage_page, usage) || qmk_raw_hid(vendor_id, product_id, usage_page, usage)).then_some(Access::Full)
}

/// Whether a collection may be listed: not in update mode (by id or product string), and either a
/// collection of an allowed device or a QMK raw-HID collection.
pub fn usable(vendor_id: u16, product_id: u16, product: Option<&str>, usage_page: u16, usage: u16) -> bool {
    if let Some(c) = crate::brands::channel(vendor_id, product_id, usage_page, usage) {
        return !in_bootloader(vendor_id, product_id, product) && crate::brands::name_ok(c, product);
    }
    !in_bootloader(vendor_id, product_id, product)
        && (allowed(vendor_id, product_id) || qmk_raw_hid(vendor_id, product_id, usage_page, usage) || analog_input_only(vendor_id, product_id, usage_page, usage))
        && collection_allowed(vendor_id, product_id, usage_page, usage)
}

/// Whether the collection may be listed and opened at all (with either kind of access).
pub fn collection_allowed(vendor_id: u16, product_id: u16, usage_page: u16, usage: u16) -> bool {
    collection_access(vendor_id, product_id, usage_page, usage).is_some()
}

fn full_access(vendor_id: u16, product_id: u16, usage_page: u16, usage: u16) -> bool {
    if illumipc(vendor_id, product_id) {
        return (usage_page, usage) == X68_CONFIG_COLLECTION;
    }
    match vendor_id {
        LOGITECH => true,
        ASUS if ASUS_PRODUCTS.contains(&product_id) => true,
        ATK if ATK_PRODUCTS.contains(&product_id) => (usage_page, usage) == ATK_CONFIG_COLLECTION,
        _ => openmouse_collection(vendor_id, product_id, usage_page, usage) || keyboard_collection(vendor_id, product_id, usage_page, usage),
    }
}

/// The one place a pointing or consumer collection is opened. Many Razer mice take their settings as
/// feature reports on their Generic Desktop mouse or Consumer Control collection (OpenMouse's Razer
/// drivers claim them by that collection and talk through sendFeatureReport / receiveFeatureReport
/// only). It applies to vendor 0x1532, only the product ids in `RAZER_FEATURE_ONLY_PIDS` (derived from
/// those drivers by scripts/razer-feature-only.mjs), only the two collections in
/// `RAZER_FEATURE_COLLECTIONS`, and only where OpenMouse's own filter for that product names the
/// collection. Nothing else on any vendor gets a pointing, keyboard or consumer collection.
pub fn razer_feature_only(vendor_id: u16, product_id: u16, usage_page: u16, usage: u16) -> bool {
    vendor_id == RAZER
        && crate::openmouse_ids::RAZER_FEATURE_ONLY_PIDS.contains(&product_id)
        && RAZER_FEATURE_COLLECTIONS.contains(&(usage_page, usage))
        && crate::openmouse_ids::FILTERS.iter().any(|&(v, p, page, u)| {
            v == vendor_id && p == Some(product_id) && page.is_none_or(|page| page == usage_page) && u.is_none_or(|u| u == usage)
        })
}

/// A collection an OpenMouse mouse driver may use: a vendor collection from its table, or a Razer
/// feature-only one. What makes a device a mouse candidate in the device list (devices.rs).
pub fn openmouse_collection_or_razer(vendor_id: u16, product_id: u16, usage_page: u16, usage: u16) -> bool {
    openmouse_collection(vendor_id, product_id, usage_page, usage) || razer_feature_only(vendor_id, product_id, usage_page, usage)
}

/// A device OpenMouse has a driver for (by vendor and product id; the collection is checked apart).
pub fn openmouse_device(vendor_id: u16, product_id: u16) -> bool {
    crate::openmouse_ids::FILTERS.iter().any(|&(v, p, _, _)| v == vendor_id && p.is_none_or(|p| p == product_id))
}

/// An OpenMouse configuration collection: never a typing or pointing page; a vendor-defined page
/// (0xFF00 and up) where the filter names no page, or exactly the page the filter names.
pub fn openmouse_collection(vendor_id: u16, product_id: u16, usage_page: u16, usage: u16) -> bool {
    if INPUT_PAGES.contains(&usage_page) {
        return false;
    }
    crate::openmouse_ids::FILTERS.iter().any(|&(v, p, page, u)| {
        v == vendor_id
            && p.is_none_or(|p| p == product_id)
            && match page {
                Some(page) => page == usage_page && u.is_none_or(|u| u == usage),
                None => usage_page >= 0xff00,
            }
    })
}

/// An ATK mouse SYNQ drives with its own code (the X1 V2 Air+ receiver and cable): every report to it
/// passes `atk_frame_allowed`.
pub fn atk_device(vendor_id: u16, product_id: u16) -> bool {
    vendor_id == ATK && ATK_PRODUCTS.contains(&product_id)
}

/// Commands the ATK service never sends by default. Three can be unlocked, each by one Advanced scope
/// (`ATK_ADVANCED`); the others (firmware transfer 0x01 / 0x02 / 0x5A / 0x5B, the bootloader 0x0D, the
/// profile bank switch 0x0F, un-pairing 0x13, and the unknown 0x0A / 0x0B / 0x0C / 0x11) never pass.
const ATK_FORBIDDEN: [u8; 14] = [0x01, 0x02, 0x05, 0x06, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0f, 0x11, 0x13, 0x5a, 0x5b];
/// The commands the service sends: GetMouseOnline, GetBattery, SetEeprom, GetEeprom, GetCidMid, GetVersion,
/// GetDongleVersion.
const ATK_ALLOWED: [u8; 7] = [0x03, 0x04, 0x07, 0x08, 0x10, 0x12, 0x1d];
/// Forbidden commands one Advanced scope unlocks: SetWirelessDonglePair + GetWirelessDonglePairResult
/// (pair), RestoreFactory (reset).
const ATK_ADVANCED: [(u8, crate::advanced::Scope); 3] = [(0x05, crate::advanced::Scope::Pair), (0x06, crate::advanced::Scope::Pair), (0x09, crate::advanced::Scope::Reset)];
/// Commands whose frame is the id and nothing else.
const ATK_BARE: [u8; 7] = [0x03, 0x04, 0x10, 0x12, 0x1d, 0x06, 0x09];
/// Mice the pair request may name (CID, MID): the ones SYNQ has checked (ATK_MODELS, verified).
const ATK_PAIRABLE: [(u8, u8); 1] = [(1, 61)];
/// The six button rows: 4 bytes at 0x0060 + 4 × button, written only inside the "remap" scope.
const ATK_KEY_BASE: usize = 0x0060;
const ATK_KEY_COUNT: usize = 6;
/// The left button's row, always: [mouse class, left click, 0, check].
const ATK_LEFT_CLICK: [u8; 4] = [0x01, 0x01, 0x00, 0x53];

fn atk_checksum_ok(f: &[u8]) -> bool {
    let sum: i32 = 0x08 + f[..15].iter().map(|&b| i32::from(b)).sum::<i32>();
    i32::from(f[15]) == (0x55 - (sum & 0xff)) & 0xff
}

fn atk_sum_ok(row: &[u8]) -> bool {
    row.iter().map(|&b| u32::from(b)).sum::<u32>() & 0xff == 0x55
}

fn atk_pairs_ok(row: &[u8]) -> bool {
    row.len() % 2 == 0 && row.chunks(2).all(|p| (u32::from(p[0]) + u32::from(p[1])) & 0xff == 0x55)
}

/// One button's action as the service writes it: off, a mouse button, or a DPI control.
fn atk_button_ok(row: &[u8]) -> bool {
    if row.len() != 4 || !atk_sum_ok(row) || row[2] != 0 {
        return false;
    }
    match row[0] {
        0x00 => row[1] == 0,
        0x01 => matches!(row[1], 1 | 2 | 4 | 8 | 16),
        0x02 => matches!(row[1], 1..=3),
        _ => false,
    }
}

/// The rows the service writes by default: (address, length, whole row sums to 0x55 instead of value/check pairs).
fn atk_default_row(address: usize) -> Option<(usize, bool)> {
    match address {
        0x0000 => Some((10, false)),
        0x000a => Some((2, false)),
        0x00a9 => Some((10, false)),
        0x00b5 => Some((6, false)),
        a if (0x1b00..0x1b00 + 8 * 6).contains(&a) && (a - 0x1b00) % 6 == 0 => Some((6, true)),
        _ => None,
    }
}

/// Second line of defence for the ATK X1 V2 Air+ (the first is `checkFrame` in src/lib/atk-protocol.ts,
/// which this mirrors; the fixtures src/atk-frames.txt and atk-frames-advanced.txt keep the two in step).
/// By default: the reads the service makes and EEPROM writes of the rows it owns (DPI, polling, lift-off,
/// the function and performance rows). Never, whatever is granted: firmware, the bootloader, the profile
/// bank switch, un-pairing, and any EEPROM address outside those rows and the six button rows.
///
/// Inside the Advanced scopes (src/advanced.rs): "pair" the pair request (for a checked mouse only) and
/// its result read; "reset" RestoreFactory; "remap" the six button rows (off / mouse button / DPI
/// control only, and the left button's row is always left click).
pub fn atk_frame_allowed(report_id: u8, f: &[u8], active: crate::advanced::Active) -> Result<&'static str, String> {
    use crate::advanced::Scope;
    if report_id != 0x08 || f.len() != 16 {
        return Err(format!("ATK frames are report 8, 16 bytes (got report {report_id}, {} bytes).", f.len()));
    }
    let cmd = f[0];
    if ATK_FORBIDDEN.contains(&cmd) {
        let unlocked = ATK_ADVANCED.iter().any(|&(c, scope)| c == cmd && active.has(scope));
        if !unlocked {
            return Err(format!("Blocked: ATK command {cmd:#04x} (firmware, bootloader, pairing, reset or unknown) is not sent from here."));
        }
    } else if !ATK_ALLOWED.contains(&cmd) {
        return Err(format!("Blocked: ATK command {cmd:#04x} isn't on SYNQ's list."));
    }
    if !atk_checksum_ok(f) {
        return Err("Refused: bad ATK frame checksum.".into());
    }
    if ATK_BARE.contains(&cmd) && f[1..15].iter().any(|&b| b != 0) {
        return Err(format!("Refused: ATK command {cmd:#04x} takes no arguments."));
    }
    match cmd {
        0x08 => {
            if !(1..=10).contains(&f[4]) || f[1] != 0 || f[5..15].iter().any(|&b| b != 0) {
                return Err("Refused: an ATK read is [8, 0, address hi, address lo, length 1..10].".into());
            }
            Ok("eeprom read")
        }
        0x05 => {
            if f[1] != 0 || f[2] != 0 || f[3] != 0 || f[4] != 2 || f[7..15].iter().any(|&b| b != 0) {
                return Err("Refused: a pair request is [5, 0, 0, 0, 2, CID, MID].".into());
            }
            if !ATK_PAIRABLE.contains(&(f[5], f[6])) {
                return Err(format!("Refused: pairing is only offered for a mouse SYNQ has checked (CID/MID {},{} isn't one).", f[5], f[6]));
            }
            Ok("pair request")
        }
        0x06 => Ok("pair result"),
        0x09 => Ok("restore factory"),
        0x07 => {
            let address = usize::from(f[2]) << 8 | usize::from(f[3]);
            let len = usize::from(f[4]);
            let zero_tail = |n: usize| f[1] == 0 && f[5 + n..15].iter().all(|&b| b == 0);
            if let Some((row_len, whole)) = atk_default_row(address) {
                if len != row_len {
                    return Err(format!("Refused: the ATK row at {address:#06x} is written whole ({row_len} bytes, got {len})."));
                }
                let row = &f[5..5 + row_len];
                if !(if whole { atk_sum_ok(row) } else { atk_pairs_ok(row) }) {
                    return Err(format!("Refused: the ATK row at {address:#06x} has a bad checksum."));
                }
                if !zero_tail(row_len) {
                    return Err("Refused: nothing follows an ATK row.".into());
                }
                return Ok("eeprom write");
            }
            let key = address.checked_sub(ATK_KEY_BASE).filter(|d| d % 4 == 0 && d / 4 < ATK_KEY_COUNT).map(|d| d / 4);
            let Some(key) = key else {
                return Err(format!("Blocked: ATK EEPROM address {address:#06x} isn't one SYNQ writes."));
            };
            if !active.has(Scope::Remap) {
                return Err("Blocked: ATK button rows are only written from Advanced.".into());
            }
            if len != 4 || !zero_tail(4) {
                return Err("Refused: a button row is written whole (4 bytes).".into());
            }
            let row = &f[5..9];
            if !atk_button_ok(row) {
                return Err("Refused: that is not an action SYNQ writes to a button.".into());
            }
            if key == 0 && row != ATK_LEFT_CLICK {
                return Err("Refused: the left button always stays left click.".into());
            }
            Ok("button write")
        }
        _ => Ok("atk read"),
    }
}

/// Second line of defence for the X68 HE (the first is `checkFrame` in src/lib/x68he-protocol.ts,
/// which this mirrors): only the read and write shapes SYNQ knows get through. Never: bootloader /
/// firmware (0x0B), keyboard or factory reset (0x14 with byte 5 set, 0x14 02), gamepad mode (0x14 03),
/// reset of all triggers (0x21 .. 06), switch calibration (0x21 .. 07/08/0F/10), the raw sensor
/// stream (0x23) and per-key switch types (0x25 01). See docs/keyboard-x68he/PROTOCOL.md.
pub fn x68_frame_allowed(f: &[u8]) -> Result<&'static str, String> {
    if f.len() != X68_FRAME_LEN {
        return Err(format!("X68 frames are {X68_FRAME_LEN} bytes (got {}).", f.len()));
    }
    let zero_from = |i: usize| f[i..].iter().all(|&b| b == 0);
    let refuse = |why: &str| -> Result<&'static str, String> { Err(format!("Blocked X68 frame {:02x?}: {why}", &f[..8])) };
    let unknown = || refuse("not on SYNQ's list of known-safe commands");
    let (c, b1, b2, b3, b4, b5, b6, b7) = (f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7]);
    match c {
        0x0b => refuse("bootloader / firmware update"),
        0x23 => refuse("raw sensor stream (switch calibration)"),
        0x14 => {
            if b1 == 0x02 {
                refuse("factory reset")
            } else if b1 == 0x03 {
                refuse("gamepad mode")
            } else if b1 == 0x00 && b5 != 0 {
                refuse("keyboard reset")
            } else if b1 == 0
                && b2 == 0
                && b3 == 0
                && b4 == 1
                && f[6..12].iter().all(|&b| b == 0)
                && f[16] == 0
                && zero_from(19)
                && [12, 13, 14, 15, 17, 18].iter().all(|&i| f[i] <= 1)
            {
                Ok("device settings write")
            } else {
                unknown()
            }
        }
        0x21 => {
            if b1 != 0 || b2 != 0 || b3 != 0 {
                return unknown();
            }
            match (b4, b5) {
                (_, 0x06) => refuse("reset of every key's trigger"),
                (_, 0x07 | 0x08 | 0x0f | 0x10) => refuse("switch calibration"),
                (24, 0x04) if zero_from(6) => Ok("trigger config read"),
                (24, 0x05) if b6 < 6 && b7 < 22 && zero_from(8) => Ok("key trigger read"),
                (1, 0x09) if zero_from(6) => Ok("poll rate read"),
                (0, 0x09) if b6 == 1 && matches!(b7, 1 | 2 | 4 | 8) && zero_from(8) => Ok("poll rate write"),
                (0, 0x11) if zero_from(6) => Ok("profile query"),
                (0, 0x12) if b6 < 5 && zero_from(7) => Ok("profile write"),
                (24, 0 | 12 | 13) => {
                    let bitmap = &f[6..28];
                    let travel = f[28] as u16 | (f[32] as u16) << 8;
                    if zero_from(36)
                        && bitmap.iter().all(|&b| b <= 0x3f)
                        && bitmap.iter().any(|&b| b != 0)
                        && f[28] == f[29]
                        && f[32] == f[33]
                        && travel != 0
                    {
                        Ok("key trigger write")
                    } else {
                        unknown()
                    }
                }
                _ => unknown(),
            }
        }
        0x01 | 0x0d | 0x15 | 0x0e | 0x0a | 0x02 if zero_from(1) => Ok("read"),
        0x07 | 0x08 => {
            if b1 == 1 && zero_from(2) {
                Ok("lighting read")
            } else if b1 == 0 && b2 == 0 && b3 == 0 && b4 == 14 && zero_from(18) {
                Ok("lighting write")
            } else {
                unknown()
            }
        }
        0x09 if matches!(b1, 0x20 | 0x80 | 0x81) && zero_from(2) => Ok("custom light read"),
        0x18 => {
            if matches!(b1, 0x80 | 0x82) && zero_from(2) {
                return Ok("keymap read");
            }
            let len = if b3 == 9 { 24 } else { 56 };
            if matches!(b1, 0 | 2) && b2 == 0 && b3 < 10 && b4 as usize == len && zero_from(5 + len) {
                Ok("keymap write")
            } else {
                unknown()
            }
        }
        0x19 if (0x80..0x8a).contains(&b1) && zero_from(2) => Ok("macro read"),
        0x22 => {
            if b1 == 0x80 && zero_from(2) {
                Ok("advanced keys read")
            } else if b1 < 40 && b2 == 0 && b3 == 0 && b4 == 50 && b5 <= 6 && zero_from(42) {
                Ok("advanced key write")
            } else {
                unknown()
            }
        }
        0x24 => {
            if matches!(b1, 1 | 2) && zero_from(2) {
                Ok("socd read")
            } else if b1 == 0 && b2 == 0 && b3 < 2 && b4 == 40 && zero_from(45) {
                Ok("socd write")
            } else if b1 == 3 && b2 == 0 && b3 == 0 && b4 == 1 && b5 <= 1 && zero_from(6) {
                Ok("socd switch write")
            } else {
                unknown()
            }
        }
        0x25 => {
            if b1 == 1 {
                refuse("per-key switch type (switch calibration)")
            } else if matches!(b1, 0 | 2) && zero_from(2) {
                Ok("switch read")
            } else {
                unknown()
            }
        }
        0x26 => {
            if b1 == 0 && zero_from(2) {
                return Ok("dead zone read");
            }
            let len = if b3 == 4 { 32 } else { 58 };
            if b1 == 1 && b2 == 0 && b3 < 5 && b4 as usize == len && zero_from(5 + len) {
                Ok("dead zone write")
            } else {
                unknown()
            }
        }
        _ => unknown(),
    }
}

/// Last line of defence for Razer feature reports (the first is SYNQ's method allowlist in
/// src/lib/openmouse/policy.ts, which only ever calls settings methods). Razer's 90-byte reports carry
/// the command class at byte 6 and the command id at byte 7. Class 0x00 id 0x04 is "set device mode":
/// its modes include the bootloader and factory test modes, so it is refused whatever asked for it
/// (id 0x84, the read of it, too). A feature-only collection also takes nothing but Razer's own
/// report shape: report id 0 and exactly 90 bytes.
pub fn razer_frame_allowed(report_id: u8, data: &[u8], strict_shape: bool) -> Result<(), String> {
    if strict_shape && (report_id != 0 || data.len() != RAZER_PACKET_LEN) {
        return Err(format!("A Razer mouse only takes report 0 with {RAZER_PACKET_LEN} bytes here (got report {report_id}, {} bytes).", data.len()));
    }
    if report_id == 0 && data.len() > 7 && data[6] == 0x00 && matches!(data[7], 0x04 | 0x84) {
        return Err("Blocked: Razer's device-mode command (it can switch the mouse into its bootloader or test mode).".into());
    }
    Ok(())
}

/// One HID collection the way WebHID describes it (HIDCollectionInfo), from the report descriptor.
/// OpenMouse's drivers pick their channel by these report ids and sizes.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub usage_page: u16,
    pub usage: u16,
    #[serde(rename = "type")]
    pub kind: u8,
    pub children: Vec<Collection>,
    pub input_reports: Vec<Report>,
    pub output_reports: Vec<Report>,
    pub feature_reports: Vec<Report>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub report_id: u8,
    pub items: Vec<ReportItem>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReportItem {
    pub report_size: u32,
    pub report_count: u32,
}

/// Parses a report descriptor into its top-level collections, with each Input / Output / Feature
/// item filed under the innermost collection that holds it and grouped by report id, as Chrome does.
/// Only reads bytes; anything it doesn't understand is skipped.
pub fn parse_descriptor(desc: &[u8]) -> Vec<Collection> {
    #[derive(Clone, Copy, Default)]
    struct Globals {
        usage_page: u16,
        report_size: u32,
        report_count: u32,
        report_id: u8,
    }
    fn close(open: &mut Vec<Collection>, tops: &mut Vec<Collection>) {
        if let Some(done) = open.pop() {
            match open.last_mut() {
                Some(parent) => parent.children.push(done),
                None => tops.push(done),
            }
        }
    }
    let mut g = Globals::default();
    let mut pushed: Vec<Globals> = Vec::new();
    let mut usages: Vec<u32> = Vec::new();
    let mut open: Vec<Collection> = Vec::new();
    let mut tops: Vec<Collection> = Vec::new();
    let mut i = 0;
    while i < desc.len() {
        let prefix = desc[i];
        if prefix == 0xfe {
            let size = desc.get(i + 1).copied().unwrap_or(0) as usize;
            i += 3 + size;
            continue;
        }
        let size = [0usize, 1, 2, 4][(prefix & 3) as usize];
        let data = desc.get(i + 1..i + 1 + size).unwrap_or(&[]).iter().rev().fold(0u32, |acc, &b| acc << 8 | b as u32);
        i += 1 + size;
        match prefix & 0xfc {
            0x04 => g.usage_page = data as u16,
            0x74 => g.report_size = data,
            0x84 => g.report_id = data as u8,
            0x94 => g.report_count = data,
            0xa4 => pushed.push(g),
            0xb4 => g = pushed.pop().unwrap_or(g),
            0x08 => usages.push(if size == 4 { data } else { (g.usage_page as u32) << 16 | (data & 0xffff) }),
            0xa0 => {
                let u = usages.first().copied().unwrap_or((g.usage_page as u32) << 16);
                open.push(Collection { usage_page: (u >> 16) as u16, usage: u as u16, kind: data as u8, ..Default::default() });
            }
            0xc0 => close(&mut open, &mut tops),
            key @ (0x80 | 0x90 | 0xb0) => {
                if let Some(c) = open.last_mut() {
                    let list = match key {
                        0x80 => &mut c.input_reports,
                        0x90 => &mut c.output_reports,
                        _ => &mut c.feature_reports,
                    };
                    let item = ReportItem { report_size: g.report_size, report_count: g.report_count };
                    match list.iter_mut().find(|r| r.report_id == g.report_id) {
                        Some(r) => r.items.push(item),
                        None => list.push(Report { report_id: g.report_id, items: vec![item] }),
                    }
                }
            }
            _ => {}
        }
        // Local items (usages) last until the next main item.
        if prefix & 0x0c == 0 {
            usages.clear();
        }
    }
    while !open.is_empty() {
        close(&mut open, &mut tops);
    }
    tops
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub key: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub product_name: String,
    pub collections: Vec<Collection>,
}

/// What the readers report. `Input` carries the collection it came from, so a caller listening to
/// one channel (the keyboard's vendor collection) can ignore the others.
pub enum HidEvent<'a> {
    Input { key: &'a str, report_id: u8, usage_page: u16, usage: u16, data: &'a [u8] },
    /// A game controller's input reports, read since the last batch, each with the time it was read (src/pads.rs).
    /// Batched (at most every `PAD_BATCH_MS`) so a 1-8 kHz pad doesn't flood the page; the times make the
    /// tester's polling-rate figures exact.
    Pad { key: &'a str, usage_page: u16, usage: u16, reports: &'a [PadReport] },
    /// A reader failed (the device was unplugged or re-enumerated). Its handles are dead.
    Lost { key: &'a str },
}

pub type Emit = Arc<dyn Fn(HidEvent<'_>) + Send + Sync>;

/// One input report of a game controller and when the bridge read it (microseconds on the bridge's clock).
#[derive(Serialize, Clone, Debug)]
pub struct PadReport {
    pub t: u64,
    pub id: u8,
    pub d: Vec<u8>,
}

/// How often a pad's reports go to the page, and the most a batch holds.
pub const PAD_BATCH_MS: u64 = 12;
const PAD_BATCH_MAX: usize = 512;
/// A pad's reader waits this long for a report before it checks for a stop (and sends what it has).
const PAD_READ_TIMEOUT_MS: i32 = 8;

/// Microseconds since the bridge's first read: the clock pad reports are stamped with.
pub fn now_us() -> u64 {
    static EPOCH: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    EPOCH.get_or_init(Instant::now).elapsed().as_micros() as u64
}

/// Collects a pad's reports and hands them on in batches.
struct PadBatch {
    reports: Vec<PadReport>,
    since: Instant,
}

impl PadBatch {
    fn new() -> Self {
        Self { reports: Vec::new(), since: Instant::now() }
    }

    fn push(&mut self, report_id: u8, data: &[u8]) {
        self.reports.push(PadReport { t: now_us(), id: report_id, d: data.to_vec() });
    }

    fn flush_if_due(&mut self, emit: &Emit, key: &str, usage_page: u16, usage: u16) {
        if self.reports.is_empty() || (self.since.elapsed() < Duration::from_millis(PAD_BATCH_MS) && self.reports.len() < PAD_BATCH_MAX) {
            return;
        }
        emit(HidEvent::Pad { key, usage_page, usage, reports: &self.reports });
        self.reports.clear();
        self.since = Instant::now();
    }
}

/// One report of a game profile (src/games.rs). The app encodes profiles offline with the device
/// drivers' own frame builders; the helper replays them with `send_step`, which is `send_report` /
/// `send_report_to` / `send_feature_report` with every guard they apply (and no Advanced grant).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Step {
    #[serde(rename_all = "camelCase")]
    Output { report_id: u8, data: Vec<u8> },
    #[serde(rename_all = "camelCase")]
    OutputTo { usage_page: u16, usage: u16, report_id: u8, data: Vec<u8> },
    #[serde(rename_all = "camelCase")]
    Feature { report_id: u8, data: Vec<u8> },
}

struct Writer {
    dev: HidDevice,
    usage_page: u16,
    usage: u16,
    /// A QMK raw-HID (VIA / Vial) collection: only `send_report_to` reaches it, and every frame
    /// passes `via_frame_allowed` (see `via_guarded`).
    via: bool,
    /// `Access::InputOnly`: read, never written (no send path reaches it).
    input_only: bool,
    /// Unix: the node this collection shares with the interface's other collections, and which of its
    /// reports this collection may send there (hid_plan.rs).
    #[cfg(unix)]
    plan: Arc<crate::hid_plan::NodePlan>,
}

impl Writer {
    /// Writes one output report (report id first, as hidapi wants it). On Windows the collection's own
    /// handle refuses an id it doesn't own; on a shared Unix node only this collection's own output reports
    /// go out, padded to their length.
    fn write(&self, buf: &[u8]) -> Result<usize, String> {
        #[cfg(unix)]
        let framed = {
            let (&id, data) = buf.split_first().ok_or("An empty report.")?;
            let route = self
                .plan
                .output(self.usage_page, self.usage, id)
                .ok_or_else(|| format!("Collection {:04x}:{:04x} doesn't take output report 0x{id:02x}.", self.usage_page, self.usage))?;
            crate::hid_plan::NodePlan::frame(route, data)?
        };
        #[cfg(unix)]
        let buf = &framed[..];
        self.dev.write(buf).map_err(|e| e.to_string())
    }

    /// Sends one feature report (report id first). On a shared Unix node only this collection's own.
    fn send_feature(&self, buf: &[u8]) -> Result<(), String> {
        #[cfg(unix)]
        let framed = {
            let (&id, data) = buf.split_first().ok_or("An empty report.")?;
            let route = self
                .plan
                .feature(self.usage_page, self.usage, id)
                .ok_or_else(|| format!("Collection {:04x}:{:04x} doesn't take feature report 0x{id:02x}.", self.usage_page, self.usage))?;
            crate::hid_plan::NodePlan::frame(route, data)?
        };
        #[cfg(unix)]
        let buf = &framed[..];
        self.dev.send_feature_report(buf).map_err(|e| e.to_string())
    }

    /// Reads one feature report into a buffer of `size` bytes (the report id included) and returns it
    /// without the id. On a shared Unix node only this collection's own, asked for at its own length.
    fn get_feature(&self, report_id: u8, size: usize) -> Result<Vec<u8>, String> {
        // A shared node asks for this collection's own report at its own length, whatever the caller's buffer.
        #[cfg(unix)]
        let _ = size;
        #[cfg(unix)]
        let size = self
            .plan
            .feature(self.usage_page, self.usage, report_id)
            .map(|r| r.len + 1)
            .ok_or_else(|| format!("Collection {:04x}:{:04x} doesn't have feature report 0x{report_id:02x}.", self.usage_page, self.usage))?;
        let mut buf = vec![0u8; size];
        buf[0] = report_id;
        match self.dev.get_feature_report(&mut buf) {
            Ok(n) if n > 0 => Ok(buf[1..n].to_vec()),
            Ok(_) => Err("empty".into()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// A collection SYNQ may only get and set feature reports on (`Access::FeatureOnly`). The handle
/// lives in its own module with a private field, so nothing else in this file can call `read`,
/// `write` or any output-report function on it: the type has no such method.
///
/// On Windows hidapi opens a path read/write first and falls back to a zero-access handle when the
/// system owns the collection (hidapi 2.6.7, etc/hidapi/windows/hid.c, `hid_open_path`). A mouse
/// collection is always the system's, so it ends up zero-access, which still allows
/// HidD_GetFeature / HidD_SetFeature. A Consumer Control collection may open read/write; it is
/// still never read from.
///
/// On Linux the node is the whole interface (the mouse's movement included), and the handle is still never
/// read: hidraw keeps a copy of each input report per open handle, which nobody ever picks up here. Its
/// feature reports are this collection's own only (hid_plan.rs).
mod feature_only {
    use hidapi::{HidApi, HidDevice};
    use std::ffi::CStr;

    pub struct FeatureHandle {
        dev: HidDevice,
        /// Unix: the shared node's plan and this collection's usage.
        #[cfg(unix)]
        gate: (std::sync::Arc<crate::hid_plan::NodePlan>, u16, u16),
    }

    impl FeatureHandle {
        #[cfg(not(unix))]
        pub fn open(api: &HidApi, path: &CStr) -> Option<Self> {
            api.open_path(path).ok().map(|dev| Self { dev })
        }

        #[cfg(unix)]
        pub fn open(api: &HidApi, path: &CStr, plan: std::sync::Arc<crate::hid_plan::NodePlan>, usage_page: u16, usage: u16) -> Result<Self, String> {
            api.open_path(path).map(|dev| Self { dev, gate: (plan, usage_page, usage) }).map_err(|e| e.to_string())
        }

        /// This collection's own feature report on the shared node, if `report_id` is one.
        #[cfg(unix)]
        fn route(&self, report_id: u8) -> Result<crate::hid_plan::Route, String> {
            let (plan, page, usage) = &self.gate;
            plan.feature(*page, *usage, report_id).copied().ok_or_else(|| format!("Collection {page:04x}:{usage:04x} doesn't have feature report 0x{report_id:02x}."))
        }

        /// Sends one feature report (the report id first, as hidapi wants it).
        pub fn set(&self, report: &[u8]) -> Result<(), String> {
            #[cfg(unix)]
            let framed = {
                let (&id, data) = report.split_first().ok_or("An empty report.")?;
                crate::hid_plan::NodePlan::frame(&self.route(id)?, data)?
            };
            #[cfg(unix)]
            let report = &framed[..];
            self.dev.send_feature_report(report).map_err(|e| e.to_string())
        }

        /// Reads one feature report into a buffer of `size` bytes; returns it without the report id.
        pub fn get(&self, report_id: u8, size: usize) -> Result<Vec<u8>, String> {
            #[cfg(unix)]
            let _ = size;
            #[cfg(unix)]
            let size = self.route(report_id)?.len + 1;
            let mut buf = vec![0u8; size];
            buf[0] = report_id;
            match self.dev.get_feature_report(&mut buf) {
                Ok(n) if n > 0 => Ok(buf[1..n].to_vec()),
                Ok(_) => Err("empty".into()),
                Err(e) => Err(e.to_string()),
            }
        }
    }
}
use feature_only::FeatureHandle;

struct OpenDevice {
    vendor_id: u16,
    product_id: u16,
    /// A brand driver's device: every report passes that brand's guard (src/brands.rs).
    brand: Option<&'static crate::brands::Channel>,
    /// What that guard remembers (Corsair's open file and report length, Logitech's feature map).
    brand_state: crate::brands::State,
    writers: Vec<Writer>,
    /// Feature-only collections (see `Access`). A device is either all writers or all of these;
    /// they get no reader thread.
    features: Vec<FeatureHandle>,
    /// Report ID -> index of the writer that accepted it last time.
    route: HashMap<u8, usize>,
    /// Advanced actions the person confirmed for this device (src/advanced.rs); empty by default, gone on close.
    grants: crate::advanced::Grants,
    /// A game controller: what may be sent to it (src/pads.rs); every report passes that check first.
    pad: Option<crate::pads::Guard>,
    /// A Sony pad over Bluetooth (its output report is 0x31 / 0x11): which stop frame it takes.
    pad_bt: bool,
    stop: Arc<AtomicBool>,
    readers: Vec<JoinHandle<()>>,
}

impl Drop for OpenDevice {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        for t in self.readers.drain(..) {
            let _ = t.join();
        }
    }
}

pub struct HidState {
    api: Mutex<Option<HidApi>>,
    open: Mutex<HashMap<String, OpenDevice>>,
    /// Each collection's layout, read once per path from its report descriptor (keyed by its usage too:
    /// on Linux one path is a whole interface).
    layouts: Mutex<HashMap<(CString, u16, u16), Collection>>,
}

impl HidState {
    pub fn new() -> Self {
        Self { api: Mutex::new(None), open: Mutex::new(HashMap::new()), layouts: Mutex::new(HashMap::new()) }
    }
}

/// Sends one profile step through the same path (and guards) as the command it stands for.
#[allow(dead_code)] // SYNQ Helper replays profiles; the app only stores them
pub fn send_step(state: &HidState, key: &str, step: &Step) -> Result<(), String> {
    match step {
        Step::Output { report_id, data } => send_report(state, key, *report_id, data),
        Step::OutputTo { usage_page, usage, report_id, data } => send_report_to(state, key, *usage_page, *usage, *report_id, data),
        Step::Feature { report_id, data } => send_feature_report(state, key, *report_id, data),
    }
}

/// Tests only (this crate's and the helper's): a device that counts as open but has no handles, with
/// its brand guard when it has one. Every send runs the same guards and then finds nothing to write to,
/// so no hardware is touched.
#[cfg(test)]
pub fn test_open_fake(state: &HidState, key: &str, vendor_id: u16, product_id: u16) {
    let brand = crate::brands::device(vendor_id, product_id);
    let dev = OpenDevice {
        vendor_id,
        product_id,
        brand,
        brand_state: crate::brands::State::new(product_id),
        writers: Vec::new(),
        features: Vec::new(),
        route: HashMap::new(),
        grants: Default::default(),
        pad: crate::pads::guard(vendor_id, product_id),
        pad_bt: false,
        stop: Arc::new(AtomicBool::new(false)),
        readers: Vec::new(),
    };
    state.open.lock().unwrap().insert(key.to_string(), dev);
}

/// The collection at `path` with its reports. Opening a handle and asking for its descriptor sends
/// nothing to the device. If Windows won't give the descriptor, just the usage, as before.
#[cfg(not(unix))]
fn layout(api: &HidApi, cache: &mut HashMap<(CString, u16, u16), Collection>, path: &CString, usage_page: u16, usage: u16) -> Collection {
    let cache_key = (path.clone(), usage_page, usage);
    if let Some(c) = cache.get(&cache_key) {
        return c.clone();
    }
    let bare = Collection { usage_page, usage, kind: 1, ..Default::default() };
    let Ok(dev) = api.open_path(path) else { return bare };
    let mut desc = vec![0u8; DESCRIPTOR_BUFFER];
    let found = match dev.get_report_descriptor(&mut desc) {
        Ok(n) if n > 0 => parse_descriptor(&desc[..n]).into_iter().find(|c| c.usage_page == usage_page && c.usage == usage),
        _ => None,
    };
    let c = found.unwrap_or(bare);
    cache.insert(cache_key, c.clone());
    c
}

/// Unix: the collection with `usage` out of the node's whole descriptor (read from sysfs, which needs no
/// access to the device; `node_descriptor`).
#[cfg(unix)]
fn layout(api: &HidApi, cache: &mut HashMap<(CString, u16, u16), Collection>, path: &CString, usage_page: u16, usage: u16) -> Collection {
    let cache_key = (path.clone(), usage_page, usage);
    if let Some(c) = cache.get(&cache_key) {
        return c.clone();
    }
    let bare = Collection { usage_page, usage, kind: 1, ..Default::default() };
    let Some(desc) = node_descriptor(api, path) else { return bare };
    let c = parse_descriptor(&desc).into_iter().find(|c| c.usage_page == usage_page && c.usage == usage).unwrap_or(bare);
    cache.insert(cache_key, c.clone());
    c
}

/// Unix: a node's whole report descriptor. Linux keeps it in sysfs (readable without access to the
/// device); otherwise the device is opened and asked for it, which sends nothing to it.
#[cfg(unix)]
fn node_descriptor(api: &HidApi, path: &CStr) -> Option<Vec<u8>> {
    if let Some(d) = sysfs_descriptor(path) {
        return Some(d);
    }
    let dev = api.open_path(path).ok()?;
    let mut desc = vec![0u8; DESCRIPTOR_BUFFER];
    match dev.get_report_descriptor(&mut desc) {
        Ok(n) if n > 0 => {
            desc.truncate(n);
            Some(desc)
        }
        _ => None,
    }
}

/// /dev/hidrawN's descriptor as the kernel parsed it: /sys/class/hidraw/hidrawN/device/report_descriptor.
#[cfg(target_os = "linux")]
fn sysfs_descriptor(path: &CStr) -> Option<Vec<u8>> {
    let name = path.to_str().ok()?.strip_prefix("/dev/")?;
    if !name.strip_prefix("hidraw").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    std::fs::read(format!("/sys/class/hidraw/{name}/device/report_descriptor")).ok().filter(|d| !d.is_empty())
}

#[cfg(all(unix, not(target_os = "linux")))]
fn sysfs_descriptor(_path: &CStr) -> Option<Vec<u8>> {
    None
}

/// Unix: plans one node for the collections a group wants on it (hid_plan.rs).
#[cfg(unix)]
fn plan_node(api: &HidApi, vendor_id: u16, product_id: u16, path: &CStr, wanted: &[(u16, u16, Access)]) -> Result<crate::hid_plan::NodePlan, String> {
    let desc = node_descriptor(api, path).ok_or("The device's report descriptor couldn't be read, so it isn't opened.")?;
    crate::hid_plan::plan(vendor_id, product_id, &desc, wanted)
}

fn key_for(info: &hidapi::DeviceInfo) -> String {
    format!(
        "{:04x}:{:04x}:{}:{}",
        info.vendor_id(),
        info.product_id(),
        info.interface_number(),
        info.serial_number().unwrap_or("")
    )
}

/// True when a report descriptor declares Report ID items (global item tag 8, prefix 0x85..0x87).
/// Walks the items properly so data bytes are never mistaken for a prefix.
pub fn descriptor_uses_report_ids(desc: &[u8]) -> bool {
    let mut i = 0;
    while i < desc.len() {
        let prefix = desc[i];
        if prefix == 0xfe {
            // Long item: 0xFE, data size, long tag, data.
            let size = desc.get(i + 1).copied().unwrap_or(0) as usize;
            i += 3 + size;
            continue;
        }
        if prefix & 0xfc == 0x84 {
            return true;
        }
        let size = match prefix & 0x03 {
            3 => 4,
            n => n as usize,
        };
        i += 1 + size;
    }
    false
}

/// Splits what hidapi read into (report id, payload). Numbered collections put the report id first.
/// Unnumbered ones carry only the payload: Windows prefixes a 0 that hidapi strips on read, so the
/// whole buffer is the report (id 0).
/// Bytes in a collection's output report `report_id` (without the id), from its descriptor.
fn output_len(c: &Collection, report_id: u8) -> Option<usize> {
    let r = c.output_reports.iter().find(|r| r.report_id == report_id)?;
    let bits: u32 = r.items.iter().map(|i| i.report_size * i.report_count).sum();
    (bits > 0 && bits % 8 == 0 && bits / 8 <= 1024).then_some((bits / 8) as usize)
}

#[cfg_attr(unix, allow(dead_code))]
pub fn split_input(numbered: bool, buf: &[u8]) -> (u8, &[u8]) {
    match (numbered, buf.split_first()) {
        (true, Some((id, rest))) => (*id, rest),
        _ => (0, buf),
    }
}

/// Whether a collection uses report IDs. If the descriptor can't be read, assume it does, which is
/// how the reader always behaved for the mouse.
#[cfg_attr(unix, allow(dead_code))]
fn uses_report_ids(dev: &HidDevice) -> bool {
    let mut desc = vec![0u8; DESCRIPTOR_BUFFER];
    match dev.get_report_descriptor(&mut desc) {
        Ok(n) if n > 0 => descriptor_uses_report_ids(&desc[..n]),
        _ => true,
    }
}

/// The group a collection is listed under. Collections of one USB interface share a group, as in
/// Chrome on Windows, except a feature-only one: it stands alone, as Chrome lists a collection
/// alone, so a driver that wants "the mouse collection is the only collection" (the Razer Viper,
/// Viper Mini and Viper V4 Pro) sees exactly that.
fn group_key(base: String, access: Access, usage_page: u16, usage: u16) -> String {
    match access {
        Access::Full => base,
        Access::FeatureOnly | Access::InputOnly => format!("{base}:{usage_page:04x}{usage:04x}"),
    }
}

type Paths = Vec<(CString, u16, u16, Access)>;

/// Fresh enumeration of the allowed devices: (summary, paths with their usage and access).
fn scan(state: &HidState) -> Result<Vec<(Summary, Paths)>, String> {
    let mut guard = state.api.lock().map_err(|_| "HID state poisoned")?;
    if guard.is_none() {
        *guard = Some(HidApi::new().map_err(|e| format!("HID init failed: {e}"))?);
    }
    let api = guard.as_mut().unwrap();
    api.refresh_devices().map_err(|e| format!("HID scan failed: {e}"))?;

    let mut groups: Vec<(Summary, Paths)> = Vec::new();
    let mut layouts = state.layouts.lock().map_err(|_| "HID state poisoned")?;
    let listable = |d: &&hidapi::DeviceInfo| usable(d.vendor_id(), d.product_id(), d.product_string(), d.usage_page(), d.usage());
    let infos: Vec<hidapi::DeviceInfo> = api.device_list().filter(listable).cloned().collect();
    for info in &infos {
        let Some(access) = collection_access(info.vendor_id(), info.product_id(), info.usage_page(), info.usage()) else { continue };
        // A shared node never opens a typing or pointing collection for reading or writing (hid_plan.rs).
        #[cfg(unix)]
        let Some(access) = crate::hid_plan::node_access(info.vendor_id(), info.product_id(), info.usage_page(), info.usage(), access) else { continue };
        let key = group_key(key_for(info), access, info.usage_page(), info.usage());
        let collection = layout(api, &mut layouts, &info.path().to_owned(), info.usage_page(), info.usage());
        let path = (info.path().to_owned(), info.usage_page(), info.usage(), access);
        match groups.iter_mut().find(|(s, _)| s.key == key) {
            Some((summary, paths)) => {
                summary.collections.push(collection);
                paths.push(path);
            }
            None => groups.push((
                Summary {
                    key,
                    vendor_id: info.vendor_id(),
                    product_id: info.product_id(),
                    product_name: info.product_string().unwrap_or("").trim().to_string(),
                    collections: vec![collection],
                },
                vec![path],
            )),
        }
    }
    // Unix: a group lists only what its node's plan opens (a node whose descriptor can't be read, or holds
    // nothing that can be used without touching a typing or pointing collection, isn't listed at all).
    #[cfg(unix)]
    for (summary, paths) in groups.iter_mut() {
        let mut keep = vec![false; paths.len()];
        let mut nodes: Vec<&CString> = paths.iter().map(|p| &p.0).collect();
        nodes.sort();
        nodes.dedup();
        for node in nodes {
            let wanted: Vec<(u16, u16, Access)> = paths.iter().filter(|p| &p.0 == node).map(|p| (p.1, p.2, p.3)).collect();
            if let Ok(plan) = plan_node(api, summary.vendor_id, summary.product_id, node, &wanted) {
                for (i, p) in paths.iter().enumerate() {
                    keep[i] |= &p.0 == node && plan.open.contains(&(p.1, p.2, p.3));
                }
            }
        }
        let mut it = keep.iter();
        paths.retain(|_| *it.next().unwrap_or(&false));
        let mut it = keep.iter();
        summary.collections.retain(|_| *it.next().unwrap_or(&false));
    }
    #[cfg(unix)]
    groups.retain(|(_, paths)| !paths.is_empty());
    Ok(groups)
}

pub fn list(state: &HidState) -> Result<Vec<Summary>, String> {
    Ok(scan(state)?.into_iter().map(|(s, _)| s).collect())
}

/// Opens every collection of the device that Windows lets us open and starts one reader per
/// collection. Opening a device that is already open does nothing; close it first to reopen.
pub fn open_with(state: &HidState, key: &str, emit: Emit) -> Result<(), String> {
    if state.open.lock().map_err(|_| "HID state poisoned")?.contains_key(key) {
        return Ok(());
    }
    let groups = scan(state)?;
    let (summary, paths) = groups.into_iter().find(|(s, _)| s.key == key).ok_or("That device is no longer connected.")?;

    let api_guard = state.api.lock().map_err(|_| "HID state poisoned")?;
    let api = api_guard.as_ref().ok_or("HID not initialised")?;
    let stop = Arc::new(AtomicBool::new(false));
    let mut writers = Vec::new();
    let mut features = Vec::new();
    let mut readers = Vec::new();
    let brand = crate::brands::device(summary.vendor_id, summary.product_id);
    let mut brand_state = crate::brands::State::new(summary.product_id);
    if brand.is_some_and(|c| matches!(c.guard, crate::brands::Guard::Bragi)) {
        if let Some(len) = summary.collections.iter().find(|c| (c.usage_page, c.usage) == (0xff42, 0x0001)).and_then(|c| output_len(c, 0)) {
            brand_state.out_len = len;
        }
    }
    // Logitech HID++: the readers learn feature indexes from the keyboard's own IRoot replies.
    let logi = brand.filter(|c| matches!(c.guard, crate::brands::Guard::LogitechKb)).map(|_| brand_state.logi.clone());
    // A game controller: its reports go out in timestamped batches; Sony's Bluetooth personality takes other frames.
    let pad = crate::pads::guard(summary.vendor_id, summary.product_id);
    let pad_bt = pad.is_some()
        && summary.collections.iter().any(|c| c.output_reports.iter().any(|r| (r.report_id == 0x31 && pad == Some(crate::pads::Guard::Ds5)) || (r.report_id == 0x11 && pad == Some(crate::pads::Guard::Ds4))));
    // Unix: one node per USB interface carries every collection on it. Each node is planned from its report
    // descriptor first (hid_plan.rs): only the plan's collections open, each collection's handle sends only its
    // own reports, and one reader per node passes on only the reports of an allowed collection.
    #[cfg(unix)]
    let mut denied = false;
    #[cfg(unix)]
    {
        let mut nodes: Vec<&CString> = paths.iter().map(|p| &p.0).collect();
        nodes.sort();
        nodes.dedup();
        for node in nodes {
            let wanted: Vec<(u16, u16, Access)> = paths.iter().filter(|p| &p.0 == node).map(|p| (p.1, p.2, p.3)).collect();
            let Ok(plan) = plan_node(api, summary.vendor_id, summary.product_id, node, &wanted) else { continue };
            let plan = Arc::new(plan);
            let mut opened = false;
            for &(usage_page, usage, access) in &plan.open {
                if access == Access::FeatureOnly {
                    // One handle to get and set feature reports with; never read.
                    match FeatureHandle::open(api, node, plan.clone(), usage_page, usage) {
                        Ok(h) => features.push(h),
                        Err(e) => denied |= permission_denied(&e),
                    }
                    continue;
                }
                match api.open_path(node) {
                    Ok(dev) => {
                        let via = via_guarded(summary.vendor_id, summary.product_id, usage_page, usage);
                        writers.push(Writer { dev, usage_page, usage, via, input_only: access == Access::InputOnly, plan: plan.clone() });
                        opened = true;
                    }
                    Err(e) => denied |= permission_denied(&e.to_string()),
                }
            }
            if !opened || !plan.reads() {
                continue;
            }
            let reader = match api.open_path(node) {
                Ok(r) => r,
                Err(e) => {
                    denied |= permission_denied(&e.to_string());
                    continue;
                }
            };
            let (stop, emit, key, logi, plan) = (stop.clone(), emit.clone(), key.to_string(), logi.clone(), plan.clone());
            let pad_route = pad.is_some().then(|| plan.inputs.first().map(|r| (r.usage_page, r.usage))).flatten();
            readers.push(std::thread::spawn(move || {
                let mut buf = vec![0u8; plan.read_buffer()];
                let mut batch = PadBatch::new();
                let timeout = if pad_route.is_some() { PAD_READ_TIMEOUT_MS } else { READ_TIMEOUT_MS };
                while !stop.load(Ordering::SeqCst) {
                    if let Some((page, usage)) = pad_route {
                        batch.flush_if_due(&emit, &key, page, usage);
                    }
                    match reader.read_timeout(&mut buf, timeout) {
                        Ok(0) => continue,
                        Ok(n) => {
                            // Only the reports of an allowed collection go on; keystrokes and movement end here.
                            let Some((report_id, data, usage_page, usage)) = plan.route_input(&buf[..n]) else { continue };
                            if pad_route.is_some() {
                                batch.push(report_id, data);
                                continue;
                            }
                            if let Some(Ok(mut l)) = logi.as_ref().map(|l| l.lock()) {
                                l.observe(report_id, data);
                            }
                            emit(HidEvent::Input { key: &key, report_id, usage_page, usage, data });
                        }
                        Err(_) => {
                            if !stop.load(Ordering::SeqCst) {
                                emit(HidEvent::Lost { key: &key });
                            }
                            break;
                        }
                    }
                }
            }));
        }
    }
    #[cfg(not(unix))]
    for (path, usage_page, usage, access) in &paths {
        if *access == Access::FeatureOnly {
            // One handle to get and set feature reports with: no second handle, no reader thread.
            if let Some(handle) = FeatureHandle::open(api, path) {
                features.push(handle);
            }
            continue;
        }
        // Windows keeps the pointer and keyboard collections for itself; only the vendor ones open.
        let Ok(writer) = api.open_path(path) else { continue };
        let Ok(reader) = api.open_path(path) else { continue };
        let numbered = uses_report_ids(&writer);
        let via = via_guarded(summary.vendor_id, summary.product_id, *usage_page, *usage);
        let input_only = *access == Access::InputOnly;
        writers.push(Writer { dev: writer, usage_page: *usage_page, usage: *usage, via, input_only });
        let stop = stop.clone();
        let emit = emit.clone();
        let key = key.to_string();
        let (usage_page, usage) = (*usage_page, *usage);
        let logi = logi.clone();
        let is_pad = pad.is_some();
        readers.push(std::thread::spawn(move || {
            let mut buf = [0u8; 256];
            let mut batch = PadBatch::new();
            let timeout = if is_pad { PAD_READ_TIMEOUT_MS } else { READ_TIMEOUT_MS };
            while !stop.load(Ordering::SeqCst) {
                if is_pad {
                    batch.flush_if_due(&emit, &key, usage_page, usage);
                }
                match reader.read_timeout(&mut buf, timeout) {
                    Ok(0) => continue,
                    Ok(n) => {
                        let (report_id, data) = split_input(numbered, &buf[..n]);
                        if is_pad {
                            batch.push(report_id, data);
                            continue;
                        }
                        if let Some(Ok(mut l)) = logi.as_ref().map(|l| l.lock()) {
                            l.observe(report_id, data);
                        }
                        emit(HidEvent::Input { key: &key, report_id, usage_page, usage, data });
                    }
                    Err(_) => {
                        if !stop.load(Ordering::SeqCst) {
                            emit(HidEvent::Lost { key: &key });
                        }
                        break;
                    }
                }
            }
        }));
    }
    drop(api_guard);
    if writers.is_empty() && features.is_empty() {
        #[cfg(unix)]
        if denied {
            return Err(DEVICE_ACCESS.into());
        }
        return Err("Couldn't open the device. Close any other app using it (G HUB, Gear Link, ATK HUB, Razer Synapse), then try again.".into());
    }
    state
        .open
        .lock()
        .map_err(|_| "HID state poisoned")?
        .insert(key.to_string(), OpenDevice { vendor_id: summary.vendor_id, product_id: summary.product_id, brand, brand_state, writers, features, route: HashMap::new(), grants: Default::default(), pad, pad_bt, stop, readers });
    Ok(())
}

/// Linux: what opening a device the signed-in user has no access to says (the udev rule is missing).
#[cfg(unix)]
pub const DEVICE_ACCESS: &str = "Linux doesn't let SYNQ open this device yet. Install SYNQ's device rule (Devices > Device access), then unplug and replug it.";

#[cfg(unix)]
fn permission_denied(error: &str) -> bool {
    error.contains("Permission denied") || error.contains("EACCES")
}

/// Linux: the devices SYNQ lists whose hidraw node the signed-in user can't open yet (no udev rule), as
/// "name (vid:pid)". Looks at the nodes' permissions only; nothing is opened.
#[cfg(target_os = "linux")]
pub fn inaccessible(state: &HidState) -> Vec<String> {
    let Ok(groups) = scan(state) else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    for (summary, paths) in groups {
        // SAFETY: a NUL-terminated path; access() only checks permissions.
        if paths.iter().any(|p| unsafe { libc::access(p.0.as_ptr(), libc::R_OK | libc::W_OK) } != 0) {
            let name = if summary.product_name.is_empty() { "Device" } else { summary.product_name.as_str() };
            let label = format!("{name} ({:04x}:{:04x})", summary.vendor_id, summary.product_id);
            if !out.contains(&label) {
                out.push(label);
            }
        }
    }
    out
}

/// Every open game controller is stopped (its rumble frame, where it takes one) and closed: the window lost focus
/// and the page didn't release them itself (a game may be starting). Returns the keys it closed.
pub fn release_pads(state: &HidState) -> Vec<String> {
    let keys: Vec<String> = match state.open.lock() {
        Ok(open) => open.iter().filter(|(_, d)| d.pad.is_some()).map(|(k, _)| k.clone()).collect(),
        Err(_) => return Vec::new(),
    };
    for key in &keys {
        let frames = state.open.lock().ok().and_then(|o| o.get(key).map(|d| crate::pads::stop_frames(d.pad.unwrap_or(crate::pads::Guard::Input), d.pad_bt)));
        for (report_id, data) in frames.unwrap_or_default() {
            let _ = send_report(state, key, report_id, &data);
        }
        let _ = close(state, key);
    }
    keys
}

pub fn close(state: &HidState, key: &str) -> Result<(), String> {
    // Take it out under the lock, drop (join the readers) after releasing it.
    let removed = state.open.lock().map_err(|_| "HID state poisoned")?.remove(key);
    drop(removed);
    Ok(())
}

fn with_open<T>(state: &HidState, key: &str, f: impl FnOnce(&mut OpenDevice) -> Result<T, String>) -> Result<T, String> {
    let mut open = state.open.lock().map_err(|_| "HID state poisoned")?;
    let dev = open.get_mut(key).ok_or("The device isn't open.")?;
    f(dev)
}

fn with_id(report_id: u8, data: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(data.len() + 1);
    buf.push(report_id);
    buf.extend_from_slice(data);
    buf
}

/// The X68 HE only talks through `send_report_to` on its configurator collection, where every frame
/// is checked; the other send paths refuse it.
fn refuse_x68(dev: &OpenDevice, what: &str) -> Result<(), String> {
    if illumipc(dev.vendor_id, dev.product_id) {
        return Err(format!("{what} isn't used for the X68 HE; SYNQ only sends it checked output reports on FF1B:0091."));
    }
    Ok(())
}

/// Every report to the hand-built ATK mouse passes `atk_frame_allowed`; other devices are not its business.
fn atk_guard(dev: &OpenDevice, report_id: u8, data: &[u8], active: crate::advanced::Active) -> Result<(), String> {
    if atk_device(dev.vendor_id, dev.product_id) {
        atk_frame_allowed(report_id, data, active)?;
    }
    Ok(())
}

/// Which family of Advanced commands this open device has, if any (src/advanced.rs `scopes_for`).
fn advanced_family(dev: &OpenDevice) -> Option<crate::advanced::Family> {
    use crate::advanced::Family;
    if atk_device(dev.vendor_id, dev.product_id) {
        return Some(Family::Atk);
    }
    if dev.writers.iter().any(|w| w.via) {
        return Some(Family::Qmk);
    }
    if dev.brand.is_some_and(|c| c.brand == "Sonix") {
        return Some(Family::Sonix);
    }
    None
}

/// Grants one Advanced scope on an open device after the person's confirmation. Returns how many
/// milliseconds it lasts. Nothing is sent to the device.
pub fn advanced_grant(state: &HidState, key: &str, scope: &str, ack: crate::advanced::Ack, scheme: Option<&str>) -> Result<u64, String> {
    use crate::advanced::{Scheme, Scope, check_ack};
    let scope = Scope::parse(scope).ok_or("That isn't an advanced action SYNQ knows.")?;
    check_ack(scope, &ack)?;
    let scheme = match scheme {
        None => None,
        Some(s) => Some(Scheme::parse(s).ok_or("Unknown keycode scheme.")?),
    };
    with_open(state, key, |dev| {
        grantable(advanced_family(dev), scope, scheme)?;
        Ok(dev.grants.grant(scope, scheme, Instant::now()).as_millis() as u64)
    })
}

/// Whether a device of this family may hold a grant for `scope`: only for scopes its guard has frames
/// for, and a keyboard remap must also say which keycode encoding the board uses.
fn grantable(family: Option<crate::advanced::Family>, scope: crate::advanced::Scope, scheme: Option<crate::advanced::Scheme>) -> Result<(), String> {
    use crate::advanced::{Family, Scope, scopes_for};
    let family = family.ok_or("This device has no advanced actions in SYNQ.")?;
    if !scopes_for(family).contains(&scope) {
        return Err(format!("This device has no advanced {} action in SYNQ.", scope.name()));
    }
    if scope == Scope::Remap && family == Family::Qmk && scheme.is_none() {
        return Err("A keyboard remap needs to know the board's keycode scheme.".into());
    }
    Ok(())
}

/// Ends one grant (or all of them with scope "all").
pub fn advanced_revoke(state: &HidState, key: &str, scope: &str) -> Result<(), String> {
    use crate::advanced::Scope;
    with_open(state, key, |dev| {
        if scope == "all" {
            dev.grants.revoke_all();
            return Ok(());
        }
        let scope = Scope::parse(scope).ok_or("That isn't an advanced action SYNQ knows.")?;
        dev.grants.revoke(scope);
        Ok(())
    })
}

/// The scopes live on a device right now, by name.
pub fn advanced_status(state: &HidState, key: &str) -> Result<Vec<&'static str>, String> {
    with_open(state, key, |dev| {
        let active = dev.grants.active(Instant::now());
        Ok(crate::advanced::Scope::ALL.into_iter().filter(|&s| active.has(s)).map(|s| s.name()).collect())
    })
}

pub fn send_report(state: &HidState, key: &str, report_id: u8, data: &[u8]) -> Result<(), String> {
    let buf = with_id(report_id, data);
    with_open(state, key, |dev| {
        if let Some(g) = dev.pad {
            crate::pads::check_output(g, report_id, data)?;
        }
        refuse_x68(dev, "An unrouted output report")?;
        let active = dev.grants.active(Instant::now());
        atk_guard(dev, report_id, data, active)?;
        if let Some(c) = dev.brand {
            crate::brands::check_with(c, &mut dev.brand_state, crate::brands::Transport::Output, report_id, data, active)?;
        }
        if let Some(&i) = dev.route.get(&report_id) {
            if !dev.writers[i].via && !dev.writers[i].input_only && dev.writers[i].write(&buf).is_ok() {
                return Ok(());
            }
        }
        // A collection rejects report IDs it does not own, so the first one that takes it is the right one.
        // A QMK raw-HID collection is never tried here: it only takes checked frames through send_report_to.
        let mut last = String::from("no collection takes unrouted reports");
        for (i, w) in dev.writers.iter().enumerate() {
            if w.via || w.input_only {
                continue;
            }
            match w.write(&buf) {
                Ok(_) => {
                    dev.route.insert(report_id, i);
                    return Ok(());
                }
                Err(e) => last = e,
            }
        }
        Err(format!("No collection accepted report 0x{report_id:02x}: {last}"))
    })
}

/// Writes an output report to one named collection only. For unnumbered collections pass report
/// id 0: it becomes the leading 0x00 that hidapi expects and is not sent on the wire.
pub fn send_report_to(state: &HidState, key: &str, usage_page: u16, usage: u16, report_id: u8, data: &[u8]) -> Result<(), String> {
    let buf = with_id(report_id, data);
    with_open(state, key, |dev| {
        if let Some(g) = dev.pad {
            crate::pads::check_output(g, report_id, data)?;
        }
        if illumipc(dev.vendor_id, dev.product_id) {
            if (usage_page, usage) != X68_CONFIG_COLLECTION || report_id != X68_REPORT_ID {
                return Err(format!("The X68 HE only takes report {X68_REPORT_ID} on FF1B:0091."));
            }
            x68_frame_allowed(data)?;
        }
        let active = dev.grants.active(Instant::now());
        atk_guard(dev, report_id, data, active)?;
        if let Some(c) = dev.brand {
            crate::brands::check_with(c, &mut dev.brand_state, crate::brands::Transport::Output, report_id, data, active)?;
        }
        let w = dev
            .writers
            .iter()
            .find(|w| w.usage_page == usage_page && w.usage == usage)
            .ok_or_else(|| format!("Collection {usage_page:04x}:{usage:04x} isn't open."))?;
        if w.input_only {
            return Err(format!("Collection {usage_page:04x}:{usage:04x} is read-only: nothing is ever sent to it."));
        }
        if w.via {
            if report_id != 0 {
                return Err("QMK raw HID has no report ids; SYNQ only sends it report 0.".into());
            }
            if let Err(e) = via_frame_allowed_with(data, active) {
                if !analog_raw_read_allowed(dev.vendor_id, dev.product_id, data) && keychron_he_frame_allowed(dev.vendor_id, dev.product_id, data).is_err() {
                    return Err(e);
                }
            }
        }
        w.write(&buf).map(|_| ())
    })
}

pub fn send_feature_report(state: &HidState, key: &str, report_id: u8, data: &[u8]) -> Result<(), String> {
    let buf = with_id(report_id, data);
    with_open(state, key, |dev| {
        if let Some(g) = dev.pad {
            crate::pads::check_feature_set(g, report_id, data)?;
        }
        refuse_x68(dev, "A feature report")?;
        if atk_device(dev.vendor_id, dev.product_id) {
            return Err("The ATK X1 takes output reports on its config channel only; no feature report is ever sent.".into());
        }
        let active = dev.grants.active(Instant::now());
        if let Some(c) = dev.brand {
            // A brand's own guard replaces the generic Razer rule for its ids.
            crate::brands::check_with(c, &mut dev.brand_state, crate::brands::Transport::Feature, report_id, data, active)?;
        } else if dev.vendor_id == RAZER {
            razer_frame_allowed(report_id, data, !dev.features.is_empty())?;
        }
        let mut last = String::new();
        for f in &dev.features {
            match f.set(&buf) {
                Ok(()) => return Ok(()),
                Err(e) => last = e,
            }
        }
        for w in dev.writers.iter().filter(|w| !w.via && !w.input_only) {
            match w.send_feature(&buf) {
                Ok(()) => return Ok(()),
                Err(e) => last = e,
            }
        }
        Err(format!("Feature report 0x{report_id:02x} rejected: {last}"))
    })
}

pub fn receive_feature_report(state: &HidState, key: &str, report_id: u8) -> Result<Vec<u8>, String> {
    with_open(state, key, |dev| {
        if let Some(g) = dev.pad {
            crate::pads::check_feature_get(g, report_id)?;
        }
        refuse_x68(dev, "A feature report")?;
        if let Some(c) = dev.brand {
            if c.takes == crate::brands::Takes::Output || !c.report_ids.contains(&report_id) {
                return Err(format!("{} is only read with feature report {:?}.", c.brand, c.report_ids));
            }
        }
        let size = match dev.brand {
            Some(c) => c.feature_size,
            None if dev.pad.is_some() => crate::pads::FEATURE_BUFFER,
            None if dev.vendor_id == RAZER => RAZER_FEATURE_BUFFER,
            None => FEATURE_BUFFER,
        };
        let mut last = String::new();
        for f in &dev.features {
            match f.get(report_id, size) {
                Ok(bytes) => return Ok(bytes),
                Err(e) => last = e,
            }
        }
        for w in dev.writers.iter().filter(|w| !w.via && !w.input_only) {
            match w.get_feature(report_id, size) {
                Ok(bytes) => return Ok(bytes),
                Err(e) => last = e,
            }
        }
        Err(format!("Feature report 0x{report_id:02x} unavailable: {last}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Vendor collection like the Falchion's FF00:0001: 64-byte input and output, no report ID.
    const UNNUMBERED: [u8; 22] = [
        0x06, 0x00, 0xff, // Usage Page (0xFF00)
        0x09, 0x01, // Usage (1)
        0xa1, 0x01, // Collection (Application)
        0x15, 0x00, 0x26, 0xff, 0x00, // Logical min 0, max 255 (2-byte data holding 0x85-free bytes)
        0x75, 0x08, 0x95, 0x40, // Report size 8, count 64
        0x09, 0x01, 0x81, 0x02, // Input
        0x91, 0x02, // Output (no End Collection needed for the scan)
    ];

    #[test]
    fn unnumbered_descriptor_has_no_report_ids() {
        assert!(!descriptor_uses_report_ids(&UNNUMBERED));
    }

    #[test]
    fn numbered_descriptor_is_detected() {
        // Logitech HID++ style: Usage Page FF00, Usage 1, Collection, Report ID 0x10 ...
        let d = [0x06, 0x00, 0xff, 0x09, 0x01, 0xa1, 0x01, 0x85, 0x10, 0x75, 0x08, 0x95, 0x06, 0x15, 0x00, 0x26, 0xff, 0x00];
        assert!(descriptor_uses_report_ids(&d));
    }

    #[test]
    fn data_bytes_that_look_like_report_id_are_skipped() {
        // Logical Maximum (2 bytes) whose data is 0x85 0x00, then Usage with 0x85 data.
        let d = [0x26, 0x85, 0x00, 0x09, 0x85, 0x75, 0x08];
        assert!(!descriptor_uses_report_ids(&d));
        // A long item whose data contains 0x85.
        let long = [0xfe, 0x02, 0x10, 0x85, 0x85, 0x09, 0x01];
        assert!(!descriptor_uses_report_ids(&long));
    }

    #[test]
    fn split_keeps_the_whole_unnumbered_report() {
        let mut echo = [0u8; 64];
        echo[..5].copy_from_slice(&[0x51, 0x50, 0x00, 0x00, 0x0a]);
        let (id, data) = split_input(false, &echo);
        assert_eq!(id, 0);
        assert_eq!(data.len(), 64);
        assert_eq!(&data[..2], &[0x51, 0x50]);
    }

    #[test]
    fn split_takes_the_id_off_numbered_reports() {
        let (id, data) = split_input(true, &[0x11, 0xff, 0x00, 0x01]);
        assert_eq!(id, 0x11);
        assert_eq!(data, &[0xff, 0x00, 0x01]);
        assert_eq!(split_input(true, &[]), (0, &[][..]));
    }

    #[test]
    fn only_the_falchion_is_allowed_from_asus() {
        assert!(allowed(0x0b05, 0x1d1d));
        assert!(!allowed(0x0b05, 0x19af)); // Aura motherboard controller
        assert!(allowed(0x046d, 0xc0a0));
        assert!(!allowed(0x1532, 0x0001));
    }

    #[test]
    fn only_the_x1_and_its_config_channel_are_allowed_from_atk() {
        assert!(allowed(0x373b, 0x1278)); // 8K dongle-L
        assert!(allowed(0x373b, 0x12a2)); // the mouse on a cable
        assert!(collection_allowed(0x373b, 0x1278, 0xff02, 0x0002));
        for pid in [0x1278, 0x12a2] {
            for (page, usage) in [(0xff05, 0), (0xff03, 0), (0x000c, 1), (0x0001, 0x80), (0xff04, 2), (0xff06, 2), (0x0001, 6), (0x0001, 2)] {
                assert!(!collection_allowed(0x373b, pid, page, usage), "{page:04x}:{usage:04x} must stay closed");
            }
        }
        // Another ATK mouse goes by OpenMouse's table: its config collection only.
        assert!(allowed(0x373b, 0x1270));
        assert!(collection_allowed(0x373b, 0x1270, 0xff02, 0x0002));
        assert!(!collection_allowed(0x373b, 0x1270, 0x0001, 0x0002));
        assert!(!collection_allowed(0x373b, 0x1270, 0x000c, 0x0001));
        // Logitech and the Falchion keep every collection, as before.
        assert!(collection_allowed(0x046d, 0xc54d, 0xff00, 0x0002));
        assert!(collection_allowed(0x0b05, 0x1d1d, 0xff00, 0x0001));
    }

    #[test]
    fn openmouse_devices_get_vendor_collections_only() {
        // Razer Viper V3 Pro receiver: its control channel is the mouse collection, which opens
        // feature-only (see `razer_feature_only_is_exact` for the rest of that rule).
        assert!(allowed(0x1532, 0x00c1));
        assert_eq!(collection_access(0x1532, 0x00c1, 0x0001, 0x0002), Some(Access::FeatureOnly));
        assert_eq!(collection_access(0x1532, 0x00c1, 0x000c, 0x0001), None);
        // A vendor-wide filter (Pulsar 0x3710) opens vendor pages only.
        assert!(allowed(0x3710, 0x1234));
        assert!(collection_allowed(0x3710, 0x1234, 0xff02, 0x0002));
        for page in INPUT_PAGES {
            assert!(!collection_allowed(0x3710, 0x1234, page, 0x0002), "{page:04x} must stay closed");
        }
        // Not OpenMouse's, not ours.
        assert!(!allowed(0x1234, 0x5678));
        assert!(!allowed(0x0b05, 0x19af)); // Aura motherboard controller: never
        assert!(!collection_allowed(0x0b05, 0x19af, 0xff72, 0x00a1));
        // Every OpenMouse filter that names a page: allowed only when that page is a vendor/config page.
        for &(v, p, page, usage) in crate::openmouse_ids::FILTERS.iter() {
            let pid = p.unwrap_or(0x0001);
            if let Some(page) = page {
                if v == 0x046d || (v == 0x0b05 && ASUS_PRODUCTS.contains(&pid)) || (v == 0x373b && ATK_PRODUCTS.contains(&pid)) {
                    continue;
                }
                let usage = usage.unwrap_or(1);
                let expected = if !INPUT_PAGES.contains(&page) {
                    Some(Access::Full)
                } else if razer_feature_only(v, pid, page, usage) {
                    Some(Access::FeatureOnly)
                } else {
                    None
                };
                assert_eq!(collection_access(v, pid, page, usage), expected, "{v:04x}:{pid:04x} {page:04x}:{usage:04x}");
            }
        }
    }

    /// Razer mice whose drivers talk to the mouse or consumer collection get feature-only access to
    /// exactly those two collections; nothing else changes.
    #[test]
    fn razer_feature_only_is_exact() {
        use crate::openmouse_ids::{FILTERS, RAZER_FEATURE_ONLY_PIDS};
        // The table is sorted, has no duplicates, and every id is one OpenMouse lists for Razer.
        assert!(RAZER_FEATURE_ONLY_PIDS.windows(2).all(|w| w[0] < w[1]));
        for pid in RAZER_FEATURE_ONLY_PIDS {
            assert!(FILTERS.iter().any(|&(v, p, _, _)| v == RAZER && p == Some(pid)), "{pid:04x} isn't in OpenMouse's table");
            assert!(allowed(RAZER, pid));
        }
        // A Razer id from the set gets feature-only access to its mouse collection, and only the
        // collections its own OpenMouse filter names.
        assert_eq!(collection_access(RAZER, 0x00c1, 0x0001, 0x0002), Some(Access::FeatureOnly)); // Viper V3 Pro receiver
        assert_eq!(collection_access(RAZER, 0x0078, 0x0001, 0x0002), Some(Access::FeatureOnly)); // Viper
        assert_eq!(collection_access(RAZER, 0x008a, 0x0001, 0x0002), Some(Access::FeatureOnly)); // Viper Mini
        assert_eq!(collection_access(RAZER, 0x00a3, 0x0001, 0x0002), Some(Access::FeatureOnly)); // Cobra
        assert_eq!(collection_access(RAZER, 0x00c5, 0x0001, 0x0002), Some(Access::FeatureOnly)); // DeathAdder V3 HyperSpeed
        assert_eq!(collection_access(RAZER, 0x00c5, 0x000c, 0x0001), Some(Access::FeatureOnly)); // ... and its Consumer Control
        assert_eq!(collection_access(RAZER, 0x00e5, 0x000c, 0x0001), Some(Access::FeatureOnly)); // Viper V4 Pro
        assert_eq!(collection_access(RAZER, 0x00c1, 0x000c, 0x0001), None); // its filter names the mouse collection only
        // The same device's keyboard, system-control and digitizer collections stay closed.
        for (page, usage) in [(0x0001, 0x0006), (0x0001, 0x0080), (0x0001, 0x0001), (0x0007, 0x0006), (0x000c, 0x0002), (0x000d, 0x0001)] {
            assert_eq!(collection_access(RAZER, 0x00c5, page, usage), None, "{page:04x}:{usage:04x} must stay closed");
        }
        // A Razer id with a vendor-defined control interface of its own is unchanged: its vendor
        // collections open as before, its mouse collection stays closed.
        assert!(!RAZER_FEATURE_ONLY_PIDS.contains(&0x00b2)); // DeathAdder V3
        assert_eq!(collection_access(RAZER, 0x00b2, 0x0001, 0x0002), None);
        assert_eq!(collection_access(RAZER, 0x00b2, 0xff00, 0x0001), Some(Access::Full));
        // A Razer id outside OpenMouse's list gets no access at all.
        assert!(!allowed(RAZER, 0x0001));
        assert_eq!(collection_access(RAZER, 0x0001, 0x0001, 0x0002), None);
        // Another vendor's mouse collection is refused, even for an id OpenMouse lists.
        assert_eq!(collection_access(0x3710, 0x1234, 0x0001, 0x0002), None); // Pulsar
        assert_eq!(collection_access(0x3554, 0xf520, 0x0001, 0x0002), None);
        assert_eq!(collection_access(0x1234, 0x5678, 0x0001, 0x0002), None); // not OpenMouse's
        assert_eq!(collection_access(0x1234, 0x5678, 0x000c, 0x0001), None);
        // ATK's X1 (hand-built panel) keeps its one config channel.
        assert_eq!(collection_access(0x373b, 0x1278, 0x0001, 0x0002), None);
        assert_eq!(collection_access(0x373b, 0x1278, 0xff02, 0x0002), Some(Access::Full));
        // Nothing but the Razer rule ever returns FeatureOnly.
        for &(v, p, page, usage) in FILTERS.iter() {
            let (pid, page, usage) = (p.unwrap_or(0x0001), page.unwrap_or(0xff00), usage.unwrap_or(1));
            if collection_access(v, pid, page, usage) == Some(Access::FeatureOnly) {
                assert!(v == RAZER && RAZER_FEATURE_ONLY_PIDS.contains(&pid) && RAZER_FEATURE_COLLECTIONS.contains(&(page, usage)));
            }
        }
    }

    /// ASUS makes motherboard lighting hardware that SYNQ must never touch (a prior driver
    /// problem nearly bricked a machine): the Aura controller stays refused on every collection.
    #[test]
    fn the_asus_aura_controller_stays_refused() {
        assert!(!allowed(0x0b05, 0x19af));
        for (page, usage) in [(0x0001, 0x0002), (0x0001, 0x0006), (0x000c, 0x0001), (0xff00, 0x0001), (0xff72, 0x00a1), (0xff01, 0x0001), (0xff02, 0x0001)] {
            assert_eq!(collection_access(0x0b05, 0x19af, page, usage), None, "{page:04x}:{usage:04x}");
            assert!(!collection_allowed(0x0b05, 0x19af, page, usage));
        }
        // The same vendor's Falchion keeps working as before.
        assert_eq!(collection_access(0x0b05, 0x1d1d, 0xff00, 0x0001), Some(Access::Full));
    }

    #[test]
    fn a_feature_only_collection_is_listed_alone() {
        let full = "1532:00c5:0:SN".to_string();
        assert_eq!(group_key(full.clone(), Access::Full, 0xff00, 0x0001), full);
        let mouse = group_key(full.clone(), Access::FeatureOnly, 0x0001, 0x0002);
        let consumer = group_key(full.clone(), Access::FeatureOnly, 0x000c, 0x0001);
        assert_ne!(mouse, full);
        assert_ne!(mouse, consumer);
    }

    #[test]
    fn razer_device_mode_is_refused() {
        let frame = |class: u8, id: u8| {
            let mut f = vec![0u8; RAZER_PACKET_LEN];
            f[5] = 2;
            f[6] = class;
            f[7] = id;
            f
        };
        // 0x00/0x04 is "set device mode" (normal, driver, and the bootloader / test modes); 0x84 reads it.
        for strict in [false, true] {
            assert!(razer_frame_allowed(0, &frame(0x00, 0x04), strict).is_err());
            assert!(razer_frame_allowed(0, &frame(0x00, 0x84), strict).is_err());
            // Settings SYNQ writes and reads: firmware read, DPI set/get, polling, lighting.
            for (class, id) in [(0x00, 0x81), (0x00, 0x82), (0x00, 0x05), (0x00, 0x85), (0x00, 0x40), (0x00, 0xc0), (0x04, 0x05), (0x04, 0x85), (0x0f, 0x02), (0x03, 0x04), (0x07, 0x80)] {
                assert!(razer_frame_allowed(0, &frame(class, id), strict).is_ok(), "{class:02x}/{id:02x}");
            }
        }
        // A feature-only collection takes Razer's own report shape only.
        assert!(razer_frame_allowed(1, &frame(0x00, 0x81), true).is_err());
        assert!(razer_frame_allowed(0, &frame(0x00, 0x81)[..64], true).is_err());
        assert!(razer_frame_allowed(0, &frame(0x00, 0x81)[..64], false).is_ok(), "other Razer reports are not reshaped");
    }

    #[test]
    fn descriptor_reports_are_grouped_like_webhid() {
        // Vendor page FF02 usage 2, report 8: 16-byte input and output (the ATK config channel).
        let d = [
            0x06, 0x02, 0xff, 0x09, 0x02, 0xa1, 0x01, // Usage Page FF02, Usage 2, Collection (Application)
            0x85, 0x08, 0x75, 0x08, 0x95, 0x10, 0x09, 0x02, 0x81, 0x02, // Report 8, 8 bits x 16, Input
            0x09, 0x02, 0x91, 0x02, // Output
            0x85, 0x09, 0x95, 0x40, 0x09, 0x02, 0xb1, 0x02, // Report 9, 64 bytes, Feature
            0xc0,
        ];
        let tops = parse_descriptor(&d);
        assert_eq!(tops.len(), 1);
        let c = &tops[0];
        assert_eq!((c.usage_page, c.usage, c.kind), (0xff02, 0x0002, 1));
        assert_eq!(c.input_reports, vec![Report { report_id: 8, items: vec![ReportItem { report_size: 8, report_count: 16 }] }]);
        assert_eq!(c.output_reports, vec![Report { report_id: 8, items: vec![ReportItem { report_size: 8, report_count: 16 }] }]);
        assert_eq!(c.feature_reports, vec![Report { report_id: 9, items: vec![ReportItem { report_size: 8, report_count: 64 }] }]);
        // Nested collection and an unnumbered report.
        let n = [0x05, 0x01, 0x09, 0x02, 0xa1, 0x01, 0x09, 0x01, 0xa1, 0x00, 0x75, 0x01, 0x95, 0x03, 0x81, 0x02, 0xc0, 0xc0];
        let tops = parse_descriptor(&n);
        assert_eq!((tops[0].usage_page, tops[0].usage), (0x0001, 0x0002));
        assert_eq!(tops[0].children.len(), 1);
        assert_eq!(tops[0].children[0].input_reports[0].report_id, 0);
        assert!(parse_descriptor(&[0x85]).is_empty(), "truncated input must not panic");
    }

    fn x68(bytes: &[u8]) -> Vec<u8> {
        let mut f = vec![0u8; X68_FRAME_LEN];
        f[..bytes.len()].copy_from_slice(bytes);
        f
    }

    #[test]
    fn only_the_illumipc_config_channel_is_allowed_from_its_ids() {
        // 2E3C:C365, the gamepad-mode personalities of the same firmware (C366..C368) and Redragon's 0416:7372.
        for &(v, p) in &crate::brand_ids::ILLUMIPC {
            assert!(allowed(v, p), "{v:04x}:{p:04x}");
            assert!(collection_allowed(v, p, 0xff1b, 0x0091));
            for (page, usage) in [(0x0001, 0x06), (0x000c, 0x01), (0x0001, 0x80), (0xff1b, 0x0001), (0xffff, 0x0002), (0x0001, 0x02), (0xff60, 0x0061)] {
                assert!(!collection_allowed(v, p, page, usage), "{v:04x}:{p:04x} {page:04x}:{usage:04x} must stay closed");
            }
            assert!(!qmk_raw_hid(v, p, 0xff60, 0x0061), "its own checked channel, never QMK raw HID");
        }
        assert_eq!(crate::brand_ids::ILLUMIPC.len(), 5);
        // Any other id on those vendors is nobody's.
        assert!(!allowed(0x2e3c, 0x7500));
        assert!(!allowed(0x0416, 0x7500));
        assert!(!collection_allowed(0x2e3c, 0x7500, 0xff1b, 0x0091));
        assert!(!collection_allowed(0x0416, 0xb23c, 0xff1b, 0x0091));
    }

    #[test]
    fn x68_destructive_frames_are_refused() {
        for bytes in [
            &[0x0b][..],                   // bootloader
            &[0x14, 0, 0, 0, 1, 1],        // resetKeyboard (Factory Reset)
            &[0x14, 2],                    // factoryReset
            &[0x14, 3, 0, 0, 1, 1],        // gamepad mode
            &[0x21, 0, 0, 0, 24, 6],       // reset all triggers
            &[0x21, 0, 0, 0, 24, 7, 3, 4], // calibrate one key
            &[0x21, 0, 0, 0, 24, 8],       // calibrate all keys
            &[0x21, 0, 0, 0, 24, 8, 1],    // stop calibration
            &[0x21, 0, 0, 0, 24, 0x0f],    // any-key calibration
            &[0x21, 0, 0, 0, 24, 0x10],
            &[0x23, 0, 0, 0, 0, 1],        // ADC stream
            &[0x25, 1, 0, 0, 58, 1, 1],    // switch types
            &[0x19, 0, 0, 0, 58, 1],       // macro write (not on the list)
            &[0x21, 0, 0, 0, 24, 2],       // trigger test (not on the list)
            &[0x99],
        ] {
            assert!(x68_frame_allowed(&x68(bytes)).is_err(), "{bytes:02x?} must be refused");
        }
        assert!(x68_frame_allowed(&[0x01; 64]).is_err(), "wrong length");
    }

    #[test]
    fn x68_known_frames_pass() {
        let mut trig = x68(&[0x21, 0, 0, 0, 24, 13]);
        trig[8] = 0x08; // A (row 3, col 2)
        trig[10] = 0x08; // D (row 3, col 4)
        trig[28] = 120;
        trig[29] = 120;
        trig[30] = 15;
        trig[31] = 20;
        let mut keymap_last = x68(&[0x18, 0, 0, 9, 24]);
        keymap_last[5] = 1;
        for f in [
            x68(&[0x01]),
            x68(&[0x0d]),
            x68(&[0x18, 0x80]),
            x68(&[0x18, 0x82]),
            x68(&[0x21, 0, 0, 0, 24, 4]),
            x68(&[0x21, 0, 0, 0, 24, 5, 3, 4]),
            x68(&[0x21, 0, 0, 0, 1, 9]),
            x68(&[0x21, 0, 0, 0, 0, 9, 1, 8]),
            x68(&[0x21, 0, 0, 0, 0, 0x12, 2]),
            x68(&[0x24, 0, 0, 0, 40, 1, 0, 4, 7]),
            x68(&[0x24, 3, 0, 0, 1, 1]),
            x68(&[0x07, 0, 0, 0, 14, 2, 4, 3, 255]),
            x68(&[0x14, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]),
            x68(&[0x22, 0, 0, 0, 50, 2, 0, 0xe0, 0, 0, 0, 4, 0, 0, 15]),
            trig,
            keymap_last,
        ] {
            assert!(x68_frame_allowed(&f).is_ok(), "{:02x?} should pass: {:?}", &f[..12], x68_frame_allowed(&f));
        }
    }

    /// Same verdicts as the frontend's checkFrame (src/lib/x68he-protocol.ts) on ~4500 frames:
    /// every encoder output plus mutations. Regenerate with `node scripts/x68he-allowlist-fixture.ts`.
    #[test]
    fn x68_allowlist_matches_the_frontend() {
        let mut checked = 0;
        for line in include_str!("x68-frames.txt").lines().filter(|l| !l.is_empty()) {
            let (verdict, hex) = line.split_once(' ').unwrap();
            let mut bytes: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
            bytes.resize(X68_FRAME_LEN, 0); // the fixture drops trailing zeros
            assert_eq!(x68_frame_allowed(&bytes).is_ok(), verdict == "1", "frame {hex} ({:?})", x68_frame_allowed(&bytes));
            checked += 1;
        }
        assert!(checked > 3000);
    }

    /// Typing, pointing, consumer and digitizer collections of every keyboard SYNQ can now reach
    /// (OpenMouse keyboards, any VIA/Vial board) stay closed; only their config / raw-HID collection opens.
    #[test]
    fn keyboard_typing_interfaces_stay_refused() {
        let typing = [(0x0001, 0x0006), (0x0001, 0x0002), (0x0001, 0x0080), (0x0001, 0x0001), (0x0007, 0x0000), (0x0007, 0x0006), (0x000c, 0x0001), (0x000d, 0x0001)];
        // @openmouse/keyboard-protocol keyboards: their table's config collections, nothing else.
        for &(v, p, page, usage) in crate::openmouse_ids::KEYBOARD_FILTERS.iter() {
            assert!(allowed(v, p), "{v:04x}:{p:04x}");
            assert_eq!(collection_access(v, p, page, usage), Some(Access::Full));
            assert!(usable(v, p, Some("Keyboard"), page, usage));
            assert!(!INPUT_PAGES.contains(&page));
            for (tp, tu) in typing {
                assert_eq!(collection_access(v, p, tp, tu), None, "{v:04x}:{p:04x} {tp:04x}:{tu:04x} must stay closed");
                assert!(!usable(v, p, Some("Keyboard"), tp, tu));
            }
            // Wooting's analog stream (FF53/FF54) is input-only (see `wooting_analog_stream_is_input_only_and_listed_alone`);
            // its other vendor pages stay closed.
            if v == 0x31e3 {
                for page in [0xff53, 0xff54] {
                    assert_eq!(collection_access(v, p, page, 0x0001), Some(Access::InputOnly), "{page:04x}");
                }
                assert_eq!(collection_access(v, p, 0xff00, 0x0001), None);
            }
        }
        // A VIA/Vial board from a vendor SYNQ doesn't otherwise know: the raw-HID collection only.
        for (v, p) in [(0x4653, 0x0001), (0x3434, 0x0281), (0xfeed, 0x6060), (0x5043, 0x5a4c)] {
            // Keychron (0x3434) is also an OpenMouse vendor (its mice), so it is listed as a whole; the
            // typing collections still stay closed below.
            assert!(v == 0x3434 || !allowed(v, p), "{v:04x}:{p:04x} is not allowed as a whole");
            assert_eq!(collection_access(v, p, 0xff60, 0x0061), Some(Access::Full));
            assert!(usable(v, p, Some("Some 65%"), 0xff60, 0x0061));
            for (tp, tu) in typing {
                assert!(!usable(v, p, Some("Some 65%"), tp, tu), "{v:04x}:{p:04x} {tp:04x}:{tu:04x}");
            }
            // Other vendor pages of that board, and the raw page with another usage, stay closed.
            for (page, usage) in [(0xff60, 0x0062), (0xff00, 0x0001), (0xff61, 0x0061), (0xff31, 0x0074)] {
                assert!(!usable(v, p, None, page, usage), "{page:04x}:{usage:04x}");
            }
        }
        // Never for ASUS (only the Falchion is touched there) or the X68 HE (its own checked channel).
        assert!(!qmk_raw_hid(0x0b05, 0x19af, 0xff60, 0x0061));
        assert!(!usable(0x0b05, 0x19af, None, 0xff60, 0x0061));
        assert!(!usable(0x2e3c, 0xc365, Some("X68HE"), 0xff60, 0x0061));
        // The hand-built devices are unchanged.
        assert_eq!(collection_access(0x0b05, 0x1d1d, 0xff00, 0x0001), Some(Access::Full));
        assert_eq!(collection_access(0x373b, 0x1278, 0xff02, 0x0002), Some(Access::Full));
        assert_eq!(collection_access(0x373b, 0x1278, 0x0001, 0x0006), None);
    }

    /// Brand keyboards (src/brands.rs): exactly their channel opens, with its access; every typing,
    /// pointing, consumer and other vendor collection of the same board stays closed.
    #[test]
    fn brand_keyboards_open_only_their_channel() {
        use crate::brand_ids as ids;
        let typing = [(0x0001, 0x0006), (0x0001, 0x0002), (0x0001, 0x0080), (0x0007, 0x0000), (0x000d, 0x0001), (0x000c, 0x0001), (0xff00, 0x0001), (0xff60, 0x0061)];
        let mut boards: Vec<(u16, u16, u16, u16, Access)> = Vec::new();
        boards.extend(ids::SONIX.iter().map(|&(v, p)| (v, p, 0xff68, 0x0061, Access::Full)));
        boards.extend(ids::MONSGEEK.iter().map(|&(v, p)| (v, p, 0xffff, 0x0002, Access::FeatureOnly)));
        boards.extend(ids::DRUNKDEER.iter().map(|&(v, p)| (v, p, 0xff00, 0x0000, Access::Full)));
        boards.extend(ids::BYTECH.iter().map(|&(v, p)| (v, p, 0xff00, 0x0001, Access::Full)));
        // The 0x19F5 family: Generic Desktop usage 0 only (its typing, mouse and system-control collections stay closed below).
        boards.extend(ids::FW19F5_MCHOSE.iter().chain(&ids::FW19F5_DRUNKDEER).chain(&ids::FW19F5_NUPHY).chain(&ids::FW19F5_RK_GCOME).map(|&(v, p)| (v, p, 0x0001, 0x0000, Access::Full)));
        boards.extend(ids::RAZER_KEYBOARDS.iter().map(|&p| (0x1532, p, 0x000c, 0x0001, Access::FeatureOnly)));
        let asus: Vec<(u16, &str)> = crate::brands::asus_pids().into_iter().filter(|&(p, _)| crate::brands::device(0x0b05, p).is_some()).collect();
        assert!(asus.len() > 20, "ASUS keyboards and mice");
        boards.extend(asus.iter().map(|&(p, fam)| (0x0b05, p, if fam == "mouse" { 0xff01 } else { 0xff00 }, 0x0001, Access::Full)));
        boards.extend(ids::CORSAIR_BRAGI_KEYBOARDS.iter().chain(&ids::CORSAIR_BRAGI_MICE).chain(&ids::ICUE_KEYBOARDS).chain(&ids::ICUE_MICE).map(|&p| (0x1b1c, p, 0xff42, 0x0001, Access::Full)));
        boards.extend(ids::CORSAIR_SABRE.iter().map(|&p| (0x1b1c, p, 0xff02, 0x0002, Access::Full)));
        boards.extend(ids::LOGITECH_KEYBOARDS.iter().map(|&p| (0x046d, p, 0xff00, 0x0001, Access::Full)));
        boards.extend(ids::STEELSERIES.iter().map(|&p| (0x1038, p, 0xffc0, 0x0001, Access::Full)));
        for (v, p, page, usage, access) in boards {
            assert!(allowed(v, p), "{v:04x}:{p:04x}");
            assert_eq!(collection_access(v, p, page, usage), Some(access), "{v:04x}:{p:04x} channel");
            assert!(usable(v, p, Some("Keyboard"), page, usage), "{v:04x}:{p:04x}");
            for (tp, tu) in typing {
                if (tp, tu) == (page, usage) || (page == 0xff00 && tp == 0xff00) {
                    continue;
                }
                assert_eq!(collection_access(v, p, tp, tu), None, "{v:04x}:{p:04x} {tp:04x}:{tu:04x} must stay closed");
                assert!(!usable(v, p, Some("Keyboard"), tp, tu));
            }
            // Never a vendor page other than the channel's: ASUS's in-place firmware pages FF13..FF15
            // and key-event pages FFC0..FFC2, Corsair's key presses FF42:0002, OpenMouse's pages.
            for other in [0xff01, 0xff02, 0xff13, 0xff14, 0xff15, 0xffc0, 0xffc1, 0xffc2, 0xff60] {
                if other != page && !(v == 0x046d && other == 0xff43) {
                    assert_eq!(collection_access(v, p, other, 0x0001), None, "{v:04x}:{p:04x} {other:04x}");
                    assert_eq!(collection_access(v, p, other, 0x0002), None, "{v:04x}:{p:04x} {other:04x}:0002");
                }
            }
            assert_eq!(collection_access(v, p, 0xff42, 0x0002), None, "{v:04x}:{p:04x} FF42:0002");
        }
        // The Falchion ZywOo keeps its own panel and full access; the plain HFX is the ASUS driver's.
        assert!(crate::brands::device(0x0b05, 0x1d1d).is_none());
        assert_eq!(collection_access(0x0b05, 0x1d1d, 0x0001, 0x0006), Some(Access::Full));
        assert_eq!(collection_access(0x0b05, 0x1b7e, 0xff00, 0x0001), Some(Access::Full));
        assert_eq!(collection_access(0x0b05, 0x1b7e, 0x0001, 0x0006), None);
        assert!(!allowed(0x0b05, 0x19af), "Aura");
        // Logitech mice and receivers keep every collection (the DEX, LIGHTSPEED receivers).
        for p in [0xc0a0, 0xc09b, 0xc54d, 0xc547] {
            assert!(crate::brands::device(0x046d, p).is_none());
            assert_eq!(collection_access(0x046d, p, 0x0001, 0x0002), Some(Access::Full), "046d:{p:04x}");
        }
        // Logitech G keyboards: HID++ on FF00 / FF43 only.
        assert_eq!(collection_access(0x046d, 0xc339, 0xff43, 0x0202), Some(Access::Full));
        assert_eq!(collection_access(0x046d, 0xc339, 0xff00, 0x0002), Some(Access::Full));
        // The 0x19F5 family's upgraders (NuPhy's, Royal Kludge's, DrunkDeer's AFxx range) are refused everywhere, and no
        // claimed board is one of them.
        for &(v, p) in BOOTLOADER_IDS.iter().filter(|&&(v, _)| v == 0x19f5) {
            assert!(!allowed(v, p) && !usable(v, p, Some("Keyboard"), 0x0001, 0x0000) && collection_access(v, p, 0x0001, 0x0000).is_none(), "{v:04x}:{p:04x}");
        }
        assert!(!allowed(0x19f5, 0xaf12) && !usable(0x19f5, 0xaf12, Some("Keyboard"), 0xff00, 0x0001), "the DrunkDeer upgrader range");
        assert!(BOOTLOADER_IDS.len() >= 125);
        // Update-mode ids of the new brands are refused everywhere.
        for &p in ids::ASUS_BOOTLOADER.iter() {
            assert!(!allowed(0x0b05, p) && !usable(0x0b05, p, Some("ROG"), 0xff00, 0x0001), "0b05:{p:04x}");
        }
        for &p in ids::STEELSERIES_BOOTLOADER.iter() {
            assert!(!allowed(0x1038, p) && !usable(0x1038, p, Some("Apex"), 0xffc0, 0x0001), "1038:{p:04x}");
        }
        // The X60's borrowed vendor id: listed only when its product string says DrunkDeer / X60.
        assert!(usable(0x1a81, 0x2094, Some("DrunkDeer X60"), 0xff00, 0x0000));
        assert!(!usable(0x1a81, 0x2094, Some("USB Keyboard"), 0xff00, 0x0000));
        assert!(!usable(0x1a81, 0x2094, None, 0xff00, 0x0000));
        // Ids the brand tables leave out stay closed: Apple's VID, a Sonix webcam, Razer's detect-only boards.
        assert!(!usable(0x05ac, 0x024f, Some("Keyboard"), 0xff68, 0x0061));
        assert!(!usable(0x0c45, 0x636b, Some("USB Camera"), 0xff68, 0x0061));
        for p in [0x0266, 0x0282] {
            assert_eq!(collection_access(0x1532, p, 0x000c, 0x0001), None, "1532:{p:04x} is detect-only");
        }
        // OpenMouse's own Razer feature-only rule is unchanged for its ids.
        assert_eq!(collection_access(0x1532, 0x00c1, 0x0001, 0x0002), Some(Access::FeatureOnly));
    }

    #[test]
    fn wooting_analog_stream_is_input_only_and_listed_alone() {
        for pid in [0x1322, 0x1100, 0x1220, 0x1310] {
            for page in [0xff53, 0xff54] {
                assert_eq!(collection_access(0x31e3, pid, page, 0x0001), Some(Access::InputOnly), "{pid:04x} {page:04x}");
                assert!(usable(0x31e3, pid, Some("Wooting"), page, 0x0001));
            }
            // Its typing and other vendor collections stay closed (unless the keyboard table names them).
            for (page, usage) in [(0x0001, 0x0006), (0x000c, 0x0001), (0xff00, 0x0001)] {
                assert_eq!(collection_access(0x31e3, pid, page, usage), None, "{pid:04x} {page:04x}");
            }
        }
        assert_eq!(collection_access(0x03eb, 0xff01, 0xff53, 0x0001), Some(Access::InputOnly));
        assert_eq!(collection_access(0x03eb, 0x2067, 0xff53, 0x0001), None, "an Atmel id that isn't a Wooting");
        assert_eq!(collection_access(0x1234, 0x0001, 0xff53, 0x0001), None, "another vendor's FF53");
        let key = "31e3:1322:2:SN".to_string();
        assert_ne!(group_key(key.clone(), Access::InputOnly, 0xff53, 0x0001), key, "listed alone, never with the config channel");
    }

    #[test]
    fn devices_in_firmware_update_mode_are_never_listed_or_opened() {
        assert!(BOOTLOADER_IDS.len() >= 40);
        for (v, p) in BOOTLOADER_IDS {
            assert!(!allowed(v, p), "{v:04x}:{p:04x}");
            for (page, usage) in [(0xff00, 0x0001), (0xff01, 0x0001), (0xff02, 0x0002), (0xff60, 0x0061), (0xffff, 0x0001), (0x0001, 0x0002)] {
                assert_eq!(collection_access(v, p, page, usage), None, "{v:04x}:{p:04x} {page:04x}:{usage:04x}");
                assert!(!usable(v, p, None, page, usage));
            }
        }
        // Endgame Gear's vendor-wide filter and Logitech's "every collection" don't reach a bootloader.
        assert!(allowed(0x3367, 0x1978));
        assert!(!allowed(0x3367, 0x1977));
        assert!(allowed(0x046d, 0xc54d));
        assert!(!usable(0x046d, 0xab24, Some("USB Receiver"), 0xff00, 0x0001));
        // By product string: whole words only.
        for name in ["Bootloader", "OP1 8K BOOTLOADER", "STM32 DFU", "STM32  BOOTLOADER", "Boot Device", "Keyboard (firmware update mode)", "x-dfu-x"] {
            assert!(bootloader_name(name), "{name}");
        }
        for name in ["Reboot Pro", "OP1 8K", "DFUSE Mouse", "Bootstrap", "Pulsar 8K Dongle", "BootDev"] {
            assert!(!bootloader_name(name), "{name}");
        }
        assert!(!usable(0x3367, 0x1978, Some("Bootloader"), 0xff01, 0x0001), "a known mouse id that says it's a bootloader");
        assert!(!usable(0x4653, 0x0001, Some("DFU"), 0xff60, 0x0061));
        assert!(usable(0x3367, 0x1978, Some("Endgame Gear OP1 8K v2"), 0xff01, 0x0001));
    }

    fn via(bytes: &[u8]) -> Vec<u8> {
        let mut f = vec![0u8; 32];
        f[..bytes.len()].copy_from_slice(bytes);
        f
    }

    #[test]
    fn via_destructive_frames_are_refused() {
        for bytes in [
            &[0x0b][..],                        // bootloader jump
            &[0x0a],                            // EEPROM reset
            &[0x06],                            // dynamic keymap reset
            &[0x13, 0, 0, 28],                  // bulk keymap write
            &[0x0f, 0, 0, 28],                  // macro write
            &[0x10],                            // macro reset
            &[0x02, 0x03],                      // switch matrix (what's held)
            &[0x03, 0x02, 0, 0, 0, 1],          // set layout options
            &[0x03, 0x05],                      // device indication
            &[0x15, 0, 0, 1, 0, 4],             // encoder write
            &[0x05, 1, 0, 0, 0x7c, 0x00],       // QK_BOOT
            &[0x05, 1, 0, 0, 0x7c, 0x03],       // QK_CLEAR_EEPROM
            &[0x05, 1, 0, 0, 0x5c, 0x00],       // old RESET
            &[0x05, 0, 0, 0, 0x01, 0x04],       // a modded key (not basic)
            &[0x07, 0x00, 0x01, 5],             // custom channel 0
            &[0x07, 0x04, 0x01, 5],             // audio channel
            &[0x09, 0x04],                      // save a non-lighting channel
            &[0xfe, 0x06],                      // vial unlock start
            &[0xfe, 0x07],                      // vial unlock poll
            &[0xfe, 0x08],                      // vial lock
            &[0xfe, 0x0b, 1, 0, 0],             // vial QMK settings set
            &[0xfe, 0x0c],                      // vial QMK settings reset
            &[0xfe, 0x0d, 0x02],                // vial dynamic entry (tap dance set)
            &[0xfe, 0x04, 0, 0, 0, 0, 4],       // vial encoder set
            &[0xff],
            &[0x00],
        ] {
            assert!(via_frame_allowed(&via(bytes)).is_err(), "{bytes:02x?} must be refused");
        }
        assert!(via_frame_allowed(&[0x01; 31]).is_err(), "wrong length");
        assert!(via_frame_allowed(&[0x01; 33]).is_err(), "wrong length");
    }

    #[test]
    fn via_known_frames_pass() {
        for bytes in [
            &[0x01][..],
            &[0x02, 0x02],
            &[0x02, 0x04],
            &[0x11],
            &[0x12, 0, 0, 28],
            &[0x04, 0, 1, 2],
            &[0x05, 0, 1, 2, 0x00, 0x04], // A
            &[0x05, 0, 1, 2, 0x00, 0x01], // transparent
            &[0x08, 3, 1],
            &[0x07, 3, 1, 200],
            &[0x07, 2, 4, 10, 255],
            &[0x07, 1, 2, 1],
            &[0x07, 0x80, 120],
            &[0x07, 0x83, 10, 255],
            &[0x09, 3],
            &[0x09],
            &[0x0c],
            &[0x0d],
            &[0x0e, 0, 0, 28],
            &[0xfe, 0x00],
            &[0xfe, 0x01],
            &[0xfe, 0x02, 3, 0, 0, 0],
            &[0xfe, 0x05],
        ] {
            assert!(via_frame_allowed(&via(bytes)).is_ok(), "{bytes:02x?} should pass: {:?}", via_frame_allowed(&via(bytes)));
        }
    }

    /// Same verdicts as the frontend's checkViaFrame (src/lib/kb/via/guard.ts) on every frame of the
    /// fixture. Regenerate with `node scripts/via-guard-fixture.ts`.
    #[test]
    fn via_guard_matches_the_frontend() {
        let mut checked = 0;
        for line in include_str!("via-frames.txt").lines().filter(|l| !l.is_empty()) {
            let (verdict, hex) = line.split_once(' ').unwrap();
            let mut bytes: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
            bytes.resize(32, 0);
            assert_eq!(via_frame_allowed(&bytes).is_ok(), verdict == "1", "frame {hex} ({:?})", via_frame_allowed(&bytes));
            checked += 1;
        }
        assert!(checked > 1000);
    }

    // -----------------------------------------------------------------------------------------
    // Advanced actions (src/advanced.rs): what a grant opens in the QMK and ATK guards, and what no
    // grant ever opens.
    // -----------------------------------------------------------------------------------------

    use crate::advanced::{Active, Scheme, Scope};

    use crate::advanced::testing::{fixture_bytes, spec_active};

    /// Same verdicts as the frontend's checkViaFrame with an AdvancedGate holding those scopes, on every
    /// frame of the fixture. Regenerate with `node scripts/advanced-fixtures.ts`.
    #[test]
    fn via_advanced_guard_matches_the_frontend() {
        let mut checked = 0;
        for line in include_str!("via-frames-advanced.txt").lines().filter(|l| !l.is_empty()) {
            let mut parts = line.splitn(3, ' ');
            let (spec, verdict, hex) = (parts.next().unwrap(), parts.next().unwrap(), parts.next().unwrap());
            let mut bytes = fixture_bytes(hex);
            let len = if bytes.len() > 32 { 64 } else { 32 };
            bytes.resize(len, 0);
            let active = spec_active(spec);
            assert_eq!(via_frame_allowed_with(&bytes, active).is_ok(), verdict == "1", "grants {spec}, frame {hex} ({:?})", via_frame_allowed_with(&bytes, active));
            checked += 1;
        }
        assert!(checked > 5000, "{checked}");
    }

    fn via32(bytes: &[u8]) -> Vec<u8> {
        let mut f = vec![0u8; 32];
        f[..bytes.len()].copy_from_slice(bytes);
        f
    }

    #[test]
    fn via_advanced_commands_are_refused_without_a_grant() {
        for (bytes, scope) in [
            (&[0x05u8, 0, 0, 0, 0x52, 0x21][..], Scope::Remap), // MO(1): above the basic range
            (&[0x05, 0, 0, 0, 0x77, 0x00], Scope::Remap),       // a macro key
            (&[0x06], Scope::Reset),                            // dynamic keymap reset
            (&[0x0f, 0, 0, 2, 0x41, 0x42], Scope::Macros),      // macro write
            (&[0x10], Scope::Reset),                            // macro reset
        ] {
            assert!(via_frame_allowed(&via32(bytes)).is_err(), "{bytes:02x?} needs a grant");
            // a grant for any other scope doesn't help either
            let others: Vec<Scope> = Scope::ALL.into_iter().filter(|&s| s != scope).collect();
            assert!(via_frame_allowed_with(&via32(bytes), Active::of(&others).with_scheme(Scheme::Current)).is_err(), "{bytes:02x?} with unrelated grants");
            assert!(via_frame_allowed_with(&via32(bytes), Active::of(&[scope]).with_scheme(Scheme::Current)).is_ok(), "{bytes:02x?} with its own");
        }
    }

    #[test]
    fn via_advanced_commands_pass_with_exactly_their_grant() {
        let remap = Active::of(&[Scope::Remap]).with_scheme(Scheme::Current);
        assert!(via_frame_allowed_with(&via32(&[0x05, 0, 0, 0, 0x52, 0x21]), remap).is_ok(), "MO(1)");
        assert!(via_frame_allowed_with(&via32(&[0x05, 0, 0, 0, 0x77, 0x03]), remap).is_ok(), "M3");
        assert!(via_frame_allowed_with(&via32(&[0x05, 0, 0, 0, 0x22, 0x04]), remap).is_ok(), "mod-tap");
        assert!(via_frame_allowed_with(&via32(&[0x05, 0, 0, 0, 0x52, 0x21]), Active::of(&[Scope::Remap])).is_err(), "a remap grant without a scheme writes basic keys only");
        assert!(via_frame_allowed_with(&via32(&[0x0f, 0, 0, 3, 0x41, 0x42, 0x43]), Active::of(&[Scope::Macros])).is_ok());
        assert!(via_frame_allowed_with(&via32(&[0x06]), Active::of(&[Scope::Reset])).is_ok());
        assert!(via_frame_allowed_with(&via32(&[0x10]), Active::of(&[Scope::Reset])).is_ok());
        // macro writes keep their shape
        let m = |off: u16, size: u8| {
            let mut f = via32(&[0x0f, (off >> 8) as u8, off as u8, size]);
            for i in 0..usize::from(size).min(28) {
                f[4 + i] = 0x41;
            }
            f
        };
        let macros = Active::of(&[Scope::Macros]);
        assert!(via_frame_allowed_with(&m(0, 28), macros).is_ok());
        assert!(via_frame_allowed_with(&m(4068, 28), macros).is_ok(), "the last chunk of 4096 bytes");
        for (off, size) in [(0, 0), (0, 29), (4069, 28), (4096, 1), (0xffff, 1)] {
            assert!(via_frame_allowed_with(&m(off, size), macros).is_err(), "offset {off} size {size}");
        }
        let mut stray = m(0, 3);
        stray[10] = 1;
        assert!(via_frame_allowed_with(&stray, macros).is_err(), "bytes past the macro data");
    }

    /// Firmware, bootloader and EEPROM-clear paths stay shut with every scope granted, in both keycode encodings.
    #[test]
    fn via_firmware_and_bootloader_paths_are_unreachable_even_with_every_grant() {
        for scheme in [Scheme::Current, Scheme::Legacy] {
            let all = Active::of(&Scope::ALL).with_scheme(scheme);
            for bytes in [
                &[0x0b][..],                              // bootloader jump
                &[0x0a],                                  // EEPROM reset
                &[0x13, 0, 0, 4, 1, 2, 3, 4],             // bulk keymap write
                &[0x03, 0x01, 0, 0, 0, 1],                // setting keyboard values
                &[0x15, 0, 0, 0, 0x7c, 0x00],             // encoder write
                &[0x02, 0x03],                            // the switch-matrix read
                &[0xfe, 0x06],                            // Vial unlock
                &[0xfe, 0x08],                            // Vial lock
                &[0xfe, 0x0b],                            // Vial QMK-settings write
                &[0xfe, 0x0c],                            // Vial QMK-settings reset
                &[0xfe, 0x0d],                            // Vial dynamic entry
                &[0x07, 0x40, 0x01, 0x00],                // a custom value outside the lighting channels
                &[0x09, 0x08],                            // saving a custom channel
            ] {
                assert!(via_frame_allowed_with(&via32(bytes), all).is_err(), "{bytes:02x?} ({scheme:?})");
            }
            // The keycodes that jump to a bootloader, reboot, or clear the EEPROM, in every spelling QMK has used.
            for code in [0x7c00u16, 0x7c01, 0x7c02, 0x7c03, 0x7c04, 0x7c10, 0x7c73, 0x5c00, 0x5c01, 0x5c02, 0x5c03, 0x5c10, 0x5c2f, 0x7e00, 0x7e40, 0x7fff, 0x8000, 0xffff] {
                let f = via32(&[0x05, 0, 0, 0, (code >> 8) as u8, code as u8]);
                assert!(via_frame_allowed_with(&f, all).is_err(), "keycode {code:#06x} ({scheme:?})");
                assert!(!advanced_keycode_ok(code, scheme), "keycode {code:#06x} ({scheme:?})");
            }
            // every other command byte is either a read, or refused
            for c in 0..=255u8 {
                let f = via32(&[c, 0, 0, 0, 0, 0]);
                if let Ok(what) = via_frame_allowed_with(&f, all) {
                    assert!(
                        what.starts_with("get ") || what.starts_with("vial ") || what.starts_with("set ") || what.starts_with("save ") || what.starts_with("dynamic keymap reset") || what.starts_with("macro reset"),
                        "{c:#04x} -> {what}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_default_via_path_is_unchanged_by_the_advanced_section() {
        for c in 0..=255u8 {
            let f = via32(&[c, 1, 0, 0, 0x52, 0x21]);
            assert_eq!(via_frame_allowed(&f).is_ok(), via_frame_allowed_with(&f, Active::NONE).is_ok());
        }
        assert!(via_frame_allowed(&via32(&[0x05, 0, 0, 0, 0x00, 0xff])).is_ok(), "basic keys still pass");
        assert!(via_frame_allowed(&via32(&[0x05, 0, 0, 0, 0x01, 0x00])).is_err(), "nothing above them does");
    }

    /// Same verdicts as the frontend's atk-protocol checkFrame with an AdvancedGate holding those scopes.
    #[test]
    fn atk_guard_matches_the_frontend() {
        let mut checked = 0;
        for line in include_str!("atk-frames.txt").lines().filter(|l| !l.is_empty()) {
            let mut parts = line.splitn(3, ' ');
            let (spec, verdict, hex) = (parts.next().unwrap(), parts.next().unwrap(), parts.next().unwrap());
            let bytes = fixture_bytes(hex);
            let active = spec_active(spec);
            assert_eq!(atk_frame_allowed(0x08, &bytes, active).is_ok(), verdict == "1", "grants {spec}, frame {hex} ({:?})", atk_frame_allowed(0x08, &bytes, active));
            checked += 1;
        }
        assert!(checked > 5000, "{checked}");
    }

    /// A 16-byte ATK frame with the checksum filled in. `body` starts at byte 1.
    fn atk(cmd: u8, body: &[u8]) -> Vec<u8> {
        let mut f = vec![0u8; 16];
        f[0] = cmd;
        f[1..1 + body.len()].copy_from_slice(body);
        let sum: i32 = 0x08 + f[..15].iter().map(|&b| i32::from(b)).sum::<i32>();
        f[15] = ((0x55 - (sum & 0xff)) & 0xff) as u8;
        f
    }

    #[test]
    fn atk_advanced_commands_are_refused_without_their_grant() {
        let pair = atk(0x05, &[0, 0, 0, 2, 1, 61]);
        let result = atk(0x06, &[]);
        let reset = atk(0x09, &[]);
        let key = atk(0x07, &[0, 0, 0x64, 4, 1, 2, 0, 0x52]); // right button, right click
        for (what, f) in [("pair", &pair), ("pair result", &result), ("restore factory", &reset), ("button row", &key)] {
            assert!(atk_frame_allowed(0x08, f, Active::NONE).is_err(), "{what} needs a grant");
        }
        // Each opens with its own scope and no other.
        for (f, scope) in [(&pair, Scope::Pair), (&result, Scope::Pair), (&reset, Scope::Reset), (&key, Scope::Remap)] {
            assert!(atk_frame_allowed(0x08, f, Active::of(&[scope])).is_ok(), "{scope:?} opens {:02x?}", &f[..6]);
            for other in Scope::ALL.into_iter().filter(|&o| o != scope) {
                assert!(atk_frame_allowed(0x08, f, Active::of(&[other])).is_err(), "{other:?} must not open {:02x?}", &f[..6]);
            }
        }
    }

    #[test]
    fn atk_firmware_bootloader_and_unpair_stay_unreachable_with_every_grant() {
        let all = Active::of(&Scope::ALL).with_scheme(Scheme::Current);
        for cmd in [0x01u8, 0x02, 0x0a, 0x0b, 0x0c, 0x0d, 0x0f, 0x11, 0x13, 0x5a, 0x5b] {
            assert!(atk_frame_allowed(0x08, &atk(cmd, &[]), all).is_err(), "command {cmd:#04x}");
            assert!(atk_frame_allowed(0x08, &atk(cmd, &[0, 0, 0, 1, 1]), all).is_err(), "command {cmd:#04x} with arguments");
        }
        // a firmware-sized EEPROM write, or one at an address nobody owns
        for address in [0x0001u16, 0x0100, 0x0300, 0x00bd, 0x1b01, 0x1b30, 0x005c, 0x0078, 0x7fff] {
            assert!(atk_frame_allowed(0x08, &atk(0x07, &[0, (address >> 8) as u8, address as u8, 4, 1, 1, 0, 0x53]), all).is_err(), "address {address:#06x}");
        }
        // the report id and length are fixed
        assert!(atk_frame_allowed(0x09, &atk(0x03, &[]), all).is_err());
        assert!(atk_frame_allowed(0x08, &atk(0x03, &[])[..15], all).is_err());
    }

    #[test]
    fn the_left_button_always_stays_left_click() {
        let remap = Active::of(&[Scope::Remap]);
        let write = |key: u8, row: [u8; 4]| atk(0x07, &[0, 0, 0x60 + 4 * key, 4, row[0], row[1], row[2], row[3]]);
        assert!(atk_frame_allowed(0x08, &write(0, [1, 1, 0, 0x53]), remap).is_ok(), "left stays left");
        for row in [[1u8, 2, 0, 0x52], [1, 4, 0, 0x50], [1, 8, 0, 0x4c], [2, 1, 0, 0x52], [0, 0, 0, 0x55]] {
            assert!(atk_frame_allowed(0x08, &write(0, row), remap).is_err(), "left button can't become {row:02x?}");
        }
        for key in 1..6u8 {
            for row in [[1u8, 1, 0, 0x53], [1, 2, 0, 0x52], [0, 0, 0, 0x55], [2, 3, 0, 0x50]] {
                assert!(atk_frame_allowed(0x08, &write(key, row), remap).is_ok(), "button {key} -> {row:02x?}");
            }
        }
        assert!(atk_frame_allowed(0x08, &write(6, [1, 1, 0, 0x53]), remap).is_err(), "there are six buttons");
        assert!(atk_frame_allowed(0x08, &write(2, [0x0b, 1, 0, 0x49]), remap).is_err(), "only off, mouse and DPI actions");
        assert!(atk_frame_allowed(0x08, &write(2, [1, 1, 0, 0x54]), remap).is_err(), "bad check byte");
    }

    #[test]
    fn pairing_names_only_a_checked_mouse() {
        let pair = Active::of(&[Scope::Pair]);
        assert!(atk_frame_allowed(0x08, &atk(0x05, &[0, 0, 0, 2, 1, 61]), pair).is_ok());
        for (cid, mid) in [(1u8, 8u8), (0, 0), (255, 255), (1, 60)] {
            assert!(atk_frame_allowed(0x08, &atk(0x05, &[0, 0, 0, 2, cid, mid]), pair).is_err(), "{cid},{mid}");
        }
    }

    fn fake_open(vendor_id: u16, product_id: u16) -> OpenDevice {
        OpenDevice {
            vendor_id,
            product_id,
            brand: None,
            brand_state: crate::brands::State::new(product_id),
            writers: Vec::new(),
            features: Vec::new(),
            route: HashMap::new(),
            grants: Default::default(),
            pad: crate::pads::guard(vendor_id, product_id),
            pad_bt: false,
            stop: Arc::new(AtomicBool::new(false)),
            readers: Vec::new(),
        }
    }

    fn with_fake(vendor_id: u16, product_id: u16) -> HidState {
        let state = HidState::new();
        state.open.lock().unwrap().insert("k".into(), fake_open(vendor_id, product_id));
        state
    }

    #[test]
    fn a_step_replays_through_the_guards() {
        let state = HidState::new();
        test_open_fake(&state, "k", 0x373b, 0x1278);
        // The ATK factory reset is refused by the guard before any handle is looked at.
        let reset = atk(0x09, &[]);
        let e = send_step(&state, "k", &Step::OutputTo { usage_page: 0xff02, usage: 0x0002, report_id: 0x08, data: reset }).unwrap_err();
        assert!(!e.contains("isn't open"), "{e}");
        // A battery read passes the guard and then finds no collection (nothing real is open).
        let e = send_step(&state, "k", &Step::OutputTo { usage_page: 0xff02, usage: 0x0002, report_id: 0x08, data: atk(0x04, &[]) }).unwrap_err();
        assert!(e.contains("isn't open"), "{e}");
        // The ATK X1 never takes feature reports.
        assert!(send_step(&state, "k", &Step::Feature { report_id: 0x08, data: atk(0x04, &[]) }).is_err());
    }

    #[test]
    fn steps_round_trip_as_json() {
        let s = Step::OutputTo { usage_page: 0xff60, usage: 0x61, report_id: 0, data: vec![1, 2, 3] };
        let j = serde_json::to_string(&s).unwrap();
        assert_eq!(j, r#"{"kind":"outputTo","usagePage":65376,"usage":97,"reportId":0,"data":[1,2,3]}"#);
        assert_eq!(serde_json::from_str::<Step>(&j).unwrap(), s);
    }

    fn ack(typed: Option<&str>) -> crate::advanced::Ack {
        crate::advanced::Ack { acknowledged: true, typed: typed.map(Into::into) }
    }

    #[test]
    fn a_grant_needs_the_confirmation_and_belongs_to_one_device() {
        let state = with_fake(0x373b, 0x1278);
        let none = crate::advanced::Ack::default();
        assert!(advanced_grant(&state, "k", "pair", none, None).is_err(), "no tick");
        assert!(advanced_grant(&state, "k", "reset", ack(None), None).is_err(), "no word");
        assert!(advanced_grant(&state, "k", "reset", ack(Some("reset")), None).is_err(), "wrong case");
        assert!(advanced_grant(&state, "k", "firmware", ack(None), None).is_err(), "there is no firmware scope");
        assert!(advanced_grant(&state, "k", "macros", ack(None), None).is_err(), "the mouse has no macro commands");
        assert!(advanced_grant(&state, "k", "calibrate", ack(None), None).is_err(), "nor calibration");
        assert!(advanced_grant(&state, "nope", "pair", ack(None), None).is_err(), "no such device");
        assert_eq!(advanced_status(&state, "k").unwrap(), Vec::<&str>::new());
        assert!(advanced_grant(&state, "k", "pair", ack(None), None).unwrap() > 0);
        assert!(advanced_grant(&state, "k", "reset", ack(Some("RESET")), None).unwrap() > 0);
        assert_eq!(advanced_status(&state, "k").unwrap(), vec!["pair", "reset"]);
        advanced_revoke(&state, "k", "pair").unwrap();
        assert_eq!(advanced_status(&state, "k").unwrap(), vec!["reset"]);
        advanced_revoke(&state, "k", "all").unwrap();
        assert!(advanced_status(&state, "k").unwrap().is_empty());
        // closing the device drops every grant with it
        advanced_grant(&state, "k", "pair", ack(None), None).unwrap();
        close(&state, "k").unwrap();
        assert!(advanced_status(&state, "k").is_err());
    }

    #[test]
    fn a_device_without_advanced_commands_cannot_be_granted_anything() {
        for (vid, pid) in [(0x046d, 0xc54d), (0x0b05, 0x1d1d), (0x2e3c, 0xc365), (0x1532, 0x00c1), (0x373b, 0x1053)] {
            let state = with_fake(vid, pid);
            for scope in ["pair", "remap", "macros", "calibrate", "reset"] {
                assert!(advanced_grant(&state, "k", scope, ack(Some("RESET")), Some("current")).is_err(), "{vid:04x}:{pid:04x} {scope}");
            }
        }
    }

    #[test]
    fn a_keyboard_remap_grant_must_name_its_keycode_scheme() {
        use crate::advanced::Family;
        assert!(grantable(Some(Family::Qmk), Scope::Remap, None).is_err());
        assert!(grantable(Some(Family::Qmk), Scope::Remap, Some(Scheme::Current)).is_ok());
        assert!(grantable(Some(Family::Qmk), Scope::Remap, Some(Scheme::Legacy)).is_ok());
        assert!(grantable(Some(Family::Qmk), Scope::Macros, None).is_ok());
        assert!(grantable(Some(Family::Qmk), Scope::Pair, None).is_err(), "a keyboard on raw HID has no pairing commands here");
        assert!(grantable(Some(Family::Qmk), Scope::Calibrate, None).is_err());
        assert!(grantable(Some(Family::Atk), Scope::Remap, None).is_ok(), "the mouse has no keycodes");
        assert!(grantable(None, Scope::Reset, None).is_err());
    }

    #[test]
    fn a_sonix_board_can_be_granted_calibrate_and_reset_only_and_the_bridge_checks_before_writing() {
        let state = HidState::new();
        let mut dev = fake_open(0x0c45, 0x8030);
        dev.brand = crate::brands::device(0x0c45, 0x8030);
        assert!(dev.brand.is_some_and(|c| c.brand == "Sonix"));
        state.open.lock().unwrap().insert("k".into(), dev);
        for scope in ["pair", "remap", "macros"] {
            assert!(advanced_grant(&state, "k", scope, ack(None), Some("current")).is_err(), "{scope}");
        }
        assert!(advanced_grant(&state, "k", "reset", ack(None), None).is_err(), "no word");
        let mut frame = [0u8; 64];
        frame[0] = 0xaa;
        frame[1] = 0x64; // start travel calibration
        let err = send_report_to(&state, "k", 0xff68, 0x61, 0, &frame).unwrap_err();
        assert!(err.contains("Blocked"), "{err}");
        advanced_grant(&state, "k", "calibrate", ack(None), None).unwrap();
        let err = send_report_to(&state, "k", 0xff68, 0x61, 0, &frame).unwrap_err();
        assert!(err.contains("isn't open"), "past the guard, stopped only for want of a writer: {err}");
        // the factory reset is a different scope
        frame[1] = 0x0f;
        frame[2] = 0xff;
        assert!(send_report_to(&state, "k", 0xff68, 0x61, 0, &frame).unwrap_err().contains("Blocked"));
        advanced_grant(&state, "k", "reset", ack(Some("RESET")), None).unwrap();
        assert!(send_report_to(&state, "k", 0xff68, 0x61, 0, &frame).unwrap_err().contains("isn't open"));
        // the key-check reset never opens
        frame[2] = 0x05;
        assert!(send_report_to(&state, "k", 0xff68, 0x61, 0, &frame).unwrap_err().contains("Blocked"));
        advanced_revoke(&state, "k", "all").unwrap();
        frame[1] = 0x64;
        frame[2] = 0;
        assert!(send_report_to(&state, "k", 0xff68, 0x61, 0, &frame).unwrap_err().contains("Blocked"));
    }

    /// The bridge checks before it writes: a refused ATK frame never reaches `write`, an allowed one does
    /// (here it only fails for want of a writer, which is the proof it got past the guard).
    #[test]
    fn the_bridge_applies_the_grant_before_any_write() {
        let state = with_fake(0x373b, 0x1278);
        let pair = atk(0x05, &[0, 0, 0, 2, 1, 61]);
        let err = send_report(&state, "k", 8, &pair).unwrap_err();
        assert!(err.contains("Blocked"), "{err}");
        let err = send_report_to(&state, "k", 0xff02, 2, 8, &pair).unwrap_err();
        assert!(err.contains("Blocked"), "{err}");
        advanced_grant(&state, "k", "pair", ack(None), None).unwrap();
        let err = send_report(&state, "k", 8, &pair).unwrap_err();
        assert!(err.contains("No collection accepted"), "past the guard: {err}");
        // the grant covers pairing only
        let reset = atk(0x09, &[]);
        assert!(send_report(&state, "k", 8, &reset).unwrap_err().contains("Blocked"));
        // after the revoke it's refused again
        advanced_revoke(&state, "k", "pair").unwrap();
        assert!(send_report(&state, "k", 8, &pair).unwrap_err().contains("Blocked"));
        // never a feature report to the X1
        assert!(send_feature_report(&state, "k", 0, &[0u8; 16]).is_err());
    }

    /// Same verdicts as AnalogSense's checkAnalogFrame for its raw-HID families (Keychron / Lemokey,
    /// Madlions) on every frame of its fixture; any other board never gets these frames.
    #[test]
    fn analog_raw_reads_match_analogsense() {
        let mut checked = 0;
        for line in include_str!("../../src/lib/kb/analogsense/analogsense-frames.txt").lines().filter(|l| !l.is_empty()) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            let (verdict, family, report, len, hex) = (parts[0], parts[1], parts[2], parts[3], parts.get(4).copied().unwrap_or(""));
            let (vid, pid) = match family {
                "keychron" => (0x3434, 0x0b10),
                "madlions" => (0x373b, 0x1053),
                _ => continue,
            };
            let mut bytes: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
            bytes.resize(len.parse().unwrap(), 0);
            let ours = report == "0" && analog_raw_read_allowed(vid, pid, &bytes);
            assert_eq!(ours, verdict == "1", "{family} {report} {hex}");
            checked += 1;
        }
        assert!(checked > 100, "{checked}");
        // The same read on a board that isn't listed, or from another family, is refused.
        let mut kc = vec![0u8; 32];
        kc[0] = 0xa9;
        kc[1] = 0x31;
        assert!(analog_raw_read_allowed(0x3434, 0x0b10, &kc));
        assert!(!analog_raw_read_allowed(0x3434, 0x0281, &kc), "a Keychron board AnalogSense doesn't list");
        assert!(!analog_raw_read_allowed(0x373b, 0x1053, &kc), "Madlions doesn't take Keychron's read");
        kc[1] = 0x40;
        assert!(!analog_raw_read_allowed(0x3434, 0x0b10, &kc), "0xA9 0x40 is calibration");
    }

    /// Same verdicts as the frontend's checkKeychronFrame on every frame of src/lib/kb/via/keychron/keychron-he-frames.txt
    /// (regenerate with `node scripts/keychron-he-allowlist-fixture.ts`).
    #[test]
    fn keychron_he_matches_its_frames() {
        let (mut total, mut allowed) = (0, 0);
        for line in include_str!("../../src/lib/kb/via/keychron/keychron-he-frames.txt").lines().filter(|l| !l.is_empty()) {
            let (verdict, hex) = line.split_once(' ').unwrap_or((line.trim(), ""));
            let mut bytes: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
            bytes.resize(32, 0);
            let got = keychron_he_frame(&bytes);
            assert_eq!(got.is_ok(), verdict == "1", "{hex} -> {got:?}");
            total += 1;
            allowed += usize::from(verdict == "1");
        }
        assert!(total >= 6000 && allowed > 200 && allowed < total / 4, "{total} frames, {allowed} allowed");
    }

    /// The Keychron tier is per id, and never reaches VIA's own bootloader jump or EEPROM reset.
    #[test]
    fn keychron_he_tier_is_per_id_and_leaves_vias_blocks_alone() {
        let frame = |bytes: &[u8]| {
            let mut f = vec![0u8; 32];
            f[..bytes.len()].copy_from_slice(bytes);
            f
        };
        let set = frame(&[0xa9, 0x14, 0, 2, 15, 3, 3, 0, 1]);
        assert!(keychron_he_frame_allowed(0x3434, 0x0b10, &set).is_ok(), "a Q1 HE");
        assert!(keychron_he_frame_allowed(0x362d, 0x0610, &set).is_ok(), "a Lemokey P1 HE");
        assert!(keychron_he_frame_allowed(0x3434, 0x0281, &set).is_err(), "a Keychron board that isn't Hall-effect");
        assert!(keychron_he_frame_allowed(0x373b, 0x1053, &set).is_err(), "another vendor");
        for ids_row in crate::brand_ids::KEYCHRON_HE.iter() {
            assert!(keychron_he_frame_allowed(ids_row.0, ids_row.1, &frame(&[0xa0])).is_ok());
        }
        // VIA's destructive commands are not in the Keychron tier's range, and VIA's guard still refuses them.
        for bytes in [&[0x0bu8][..], &[0x0a], &[0x02, 0x03], &[0xaa], &[0xab], &[0xa7, 0x11], &[0xa9, 0x1e, 0], &[0xa9, 0x40, 1]] {
            assert!(keychron_he_frame(&frame(bytes)).is_err(), "{bytes:02x?}");
        }
        assert!(via_frame_allowed(&frame(&[0x0b])).is_err() && via_frame_allowed(&frame(&[0x0a])).is_err());
        assert!(keychron_he_frame(&vec![0u8; 33]).is_err() && keychron_he_frame(&vec![0u8; 31]).is_err());
        // Row masks: a travel write names at least one key.
        assert!(keychron_he_frame(&frame(&[0xa9, 0x14, 0, 1, 15, 3, 3, 0])).is_err(), "no key named");
        assert!(keychron_he_frame(&frame(&[0xa9, 0x14, 0, 0, 15, 3, 3, 1])).is_err(), "a global write needs a mode");
        assert!(keychron_he_frame(&frame(&[0xa9, 0x14, 0, 2, 40, 3, 3, 1])).is_err(), "4.0 mm is beyond 3.9");
        assert_eq!(crate::brand_ids::KEYCHRON_HE.len(), 35);
    }

    #[test]
    fn the_raw_hid_guard_covers_every_unpinned_raw_collection() {
        // Keychron's Nape Pro mouse and the AJAZZ AK820 speak their own protocol on 0xFF60 under an
        // OpenMouse filter that names them; their driver allowlist governs them.
        assert!(!via_guarded(0x3434, 0x0440, 0xff60, 0x0061));
        assert!(via_guarded(0x3434, 0x0281, 0xff60, 0x0061), "a Keychron keyboard is VIA");
        assert!(via_guarded(0x3710, 0x2402, 0xff60, 0x0061), "a vendor-wide filter doesn't exempt a board");
        assert!(via_guarded(0x4653, 0x0001, 0xff60, 0x0061));
        assert!(!via_guarded(0x4653, 0x0001, 0xff00, 0x0001));
    }

    /// Read-only check on the real ATK X1 V2 Air+ through its 8K receiver: lists it, opens the
    /// config channel, and sends GetMouseCIDMID (0x10), GetMouseVersion (0x12), GetBatteryLevel
    /// (0x04) and one GetEEPROM (0x08) of the system row. Nothing is written.
    /// Run with: cargo test --lib -- --ignored --nocapture atk_reads
    #[test]
    #[ignore = "needs the ATK 8K receiver plugged in and the mouse awake"]
    fn atk_reads() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        let state = HidState::new();
        let rx_dev = list(&state)
            .unwrap()
            .into_iter()
            .find(|s| s.vendor_id == 0x373b && s.product_id == 0x1278)
            .expect("ATK receiver not found");
        println!("device {} {:?}", rx_dev.key, rx_dev.collections);
        assert_eq!(rx_dev.collections.len(), 1, "only the config collection may be listed");
        assert_eq!((rx_dev.collections[0].usage_page, rx_dev.collections[0].usage), (0xff02, 0x0002));

        let (tx, rx) = mpsc::channel::<(u8, Vec<u8>)>();
        let tx = Mutex::new(tx);
        let emit: Emit = Arc::new(move |e| {
            if let HidEvent::Input { report_id, data, .. } = e {
                let _ = tx.lock().unwrap().send((report_id, data.to_vec()));
            }
        });
        open_with(&state, &rx_dev.key, emit).unwrap();

        let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<Vec<_>>().join(" ");
        let ask = |body: &[u8]| -> Vec<u8> {
            while rx.try_recv().is_ok() {}
            let mut frame = [0u8; 16];
            frame[..body.len()].copy_from_slice(body);
            let sum = frame[..15].iter().fold(0x08u32, |s, &b| s + b as u32);
            frame[15] = 0x55u8.wrapping_sub(sum as u8);
            let t0 = Instant::now();
            send_report(&state, &rx_dev.key, 0x08, &frame).unwrap();
            loop {
                let (id, data) = rx.recv_timeout(Duration::from_millis(1000)).expect("no reply");
                if id == 0x08 && data.len() == 16 && data[0] == frame[0] {
                    println!("out {:<47} in {}  ({} ms)", hex(&frame), hex(&data), t0.elapsed().as_millis());
                    let sum = data[..15].iter().fold(0x08u32, |s, &b| s + b as u32);
                    assert_eq!(data[15], 0x55u8.wrapping_sub(sum as u8), "reply checksum");
                    return data;
                }
            }
        };
        let id = ask(&[0x10]);
        let version = ask(&[0x12]);
        let battery = ask(&[0x04]);
        let system = ask(&[0x08, 0x00, 0x00, 0x00, 0x0a]);
        close(&state, &rx_dev.key).unwrap();

        println!(
            "cid/mid {},{}  firmware {:x}.{:02x}  battery {}%  rate code {}  stages {}  active {}",
            id[5], id[6], version[5], version[6], battery[5], system[5], system[7], system[9]
        );
        assert_eq!((id[5], id[6]), (1, 61), "X1 V2 Air+ answers CID 1, MID 61");
        assert!(system[4] >= 10 && (system[5] as u32 + system[6] as u32) & 0xff == 0x55, "system row pair checksum");
    }

    /// Read-only check on the real keyboard: lists it, opens the vendor collection, and sends the
    /// captured Gear Link reads (12 14 02, 12 00, 25 00, 25 01). Nothing is written to its settings.
    /// Run with: cargo test --lib -- --ignored --nocapture falchion_reads
    #[test]
    #[ignore = "needs the ROG Falchion Ace HFX plugged in"]
    fn falchion_reads() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        let state = HidState::new();
        let kb = list(&state)
            .unwrap()
            .into_iter()
            .find(|s| s.vendor_id == 0x0b05 && s.product_id == 0x1d1d && s.collections.iter().any(|c| c.usage_page == 0xff00 && c.usage == 1))
            .expect("keyboard vendor collection not found");
        println!("device {} {:?}", kb.key, kb.collections);

        let (tx, rx) = mpsc::channel::<(u8, u16, u16, Vec<u8>)>();
        let tx = Mutex::new(tx);
        let emit: Emit = Arc::new(move |e| {
            if let HidEvent::Input { report_id, usage_page, usage, data, .. } = e {
                let _ = tx.lock().unwrap().send((report_id, usage_page, usage, data.to_vec()));
            }
        });
        open_with(&state, &kb.key, emit).unwrap();

        let hex = |b: &[u8]| {
            let end = b.iter().rposition(|&x| x != 0).map_or(0, |i| i + 1);
            b[..end].iter().map(|x| format!("{x:02x}")).collect::<Vec<_>>().join(" ")
        };
        let ask = |cmd: &[u8]| -> Vec<u8> {
            while rx.try_recv().is_ok() {}
            let mut frame = [0u8; 64];
            frame[..cmd.len()].copy_from_slice(cmd);
            let t0 = Instant::now();
            send_report_to(&state, &kb.key, 0xff00, 1, 0, &frame).unwrap();
            loop {
                let (id, page, usage, data) = rx.recv_timeout(Duration::from_millis(1000)).expect("no reply");
                if page == 0xff00 && usage == 1 && id == 0 && data.len() >= 4 && data[..4] == frame[..4] {
                    println!("out {:<10} in [{} bytes, id {id}] {}  ({} ms)", hex(&frame), data.len(), hex(&data), t0.elapsed().as_millis());
                    assert_eq!(data.len(), 64, "unnumbered report must arrive whole");
                    return data;
                }
            }
        };
        let serial = ask(&[0x12, 0x14, 0x02]);
        let basic = ask(&[0x12, 0x00]);
        let rt = ask(&[0x25, 0x00]);
        let speed_tap = ask(&[0x25, 0x01]);
        close(&state, &kb.key).unwrap();

        let serial: String = serial[4..].iter().take_while(|&&b| b != 0).map(|&b| b as char).collect();
        println!("serial {serial}, firmware {:x}.{:02x}.{:02x}, profiles {}, lighting effect {}, profile {}", basic[6], basic[5], basic[4], basic[8], basic[9], basic[10]);
        println!("rapid trigger switch {}, speed tap {}", rt[4], speed_tap[4]);
        assert_eq!((basic[6], basic[5], basic[4]), (1, 0, 3), "firmware 1.00.03");
        assert_eq!(basic[8], 6, "six profiles");
    }
}
