//! Read-only detection of the peripherals SYNQ knows about. Enumerating HID devices sends
//! nothing to them. Only what is plugged in on this PC is listed.
//!
//! Besides the hand-built devices in `KNOWN`, any device OpenMouse has a driver for is listed as a
//! mouse *candidate* (`generic: true`): the Mouse page keeps it only once one of OpenMouse's drivers
//! claims it (src/lib/generic-mice.ts), so a keyboard from the same vendor never shows as a mouse.
//! Keyboards @openmouse/keyboard-protocol drives, and any device with QMK's raw-HID collection (VIA /
//! Vial), are listed as keyboard candidates for the generic Keyboard panel (src/lib/kb/confirm.ts).
//! A device in firmware-update mode is listed only so the pages can say so (`bootloader: true`).
//!
//! Game controllers (src/pads.rs): a HID pad is listed when its gamepad collection is there (`kind:
//! "controller"`, `pad.via: "hid"`); an XInput pad is listed from XInput's slots instead (src/xinput.rs, added by
//! the app's `devices_list`), so on Windows an Xbox-class pad's HID shim or Bluetooth HID personality isn't listed
//! twice.

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    pub kind: &'static str,
    pub name: String,
    pub connection: &'static str,
    /// Found through OpenMouse's device table (a mouse) or a generic keyboard path; still to be claimed.
    pub generic: bool,
    /// A keyboard candidate's path: "omkb" (@openmouse/keyboard-protocol), "qmk" (VIA / Vial raw HID) or
    /// "brand" (a brand driver's channel, src/brands.rs).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kb: Option<&'static str>,
    /// It has QMK's raw-HID collection (0xFF60/0x61).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub qmk: bool,
    /// In firmware-update (bootloader) mode: never opened; the pages show a note instead.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub bootloader: bool,
    pub vid: String,
    pub pid: String,
    /// Product string the device reports about itself, when it has one.
    pub reported: Option<String>,
    /// Every HID collection Windows lists for it (usage page, usage, interface). Listing them opens
    /// nothing; the X68 HE diagnostics export uses this.
    pub collections: Vec<CollectionInfo>,
    /// A game controller: how SYNQ reaches it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pad: Option<PadInfo>,
    /// A monitor or webcam: what SYNQ opens it by (the display device, the camera's interface path).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// How a listed game controller is reached.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PadInfo {
    /// "hid" (the bridge reads its gamepad collection) or "xinput" (an XInput slot).
    pub via: &'static str,
    /// The controller type from the controller table ("ps5", "switchpro", "xboxone", ...).
    pub kind: &'static str,
    /// An XInput pad's slot (0-3).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot: Option<u32>,
    /// What XInput says of its battery: ("wired" | "alkaline" | "nimh" | "unknown", level 0-3).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub battery: Option<(String, u8)>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInfo {
    pub usage_page: u16,
    pub usage: u16,
    pub interface: i32,
}

struct Known {
    vid: u16,
    pid: u16,
    kind: &'static str,
    name: &'static str,
    connection: &'static str,
}

const KNOWN: [Known; 12] = [
    Known { vid: 0x046d, pid: 0xc0a0, kind: "mouse", name: "PRO X 2 DEX", connection: "USB cable" },
    // libratbag lists 046d:c09b as the PRO X SUPERLIGHT 2 on a cable. Not yet seen here.
    Known { vid: 0x046d, pid: 0xc09b, kind: "mouse", name: "PRO X SUPERLIGHT 2", connection: "USB cable" },
    // The LIGHTSPEED receiver serves the DEX and the Superlight 2 alike, so it can't name the mouse;
    // the Mouse page reads the model name from the mouse itself (HID++ device name).
    Known { vid: 0x046d, pid: 0xc54d, kind: "mouse", name: "Logitech mouse", connection: "LIGHTSPEED receiver" },
    Known { vid: 0x373b, pid: 0x1278, kind: "mouse", name: "ATK X1 V2 Air+", connection: "8K receiver" },
    // The mouse's own id on a cable, per ATK HUB's device table (CID/MID 1,61). Not yet seen here.
    Known { vid: 0x373b, pid: 0x12a2, kind: "mouse", name: "ATK X1 V2 Air+", connection: "USB cable" },
    Known { vid: 0x0b05, pid: 0x1d1d, kind: "keyboard", name: "ROG Falchion Ace HFX ZywOo", connection: "USB" },
    // Shared by ~260 boards that illumipc.com drives; `refine` names the X68 HE from its USB product string.
    Known { vid: 0x2e3c, pid: 0xc365, kind: "keyboard", name: "HE keyboard (2E3C:C365)", connection: "USB" },
    // The same firmware's gamepad-mode personalities and Redragon's boards on a Winbond vendor id (src/lib/illumipc/ids.ts).
    Known { vid: 0x2e3c, pid: 0xc366, kind: "keyboard", name: "HE keyboard (2E3C:C366)", connection: "USB" },
    Known { vid: 0x2e3c, pid: 0xc367, kind: "keyboard", name: "HE keyboard (2E3C:C367)", connection: "USB" },
    Known { vid: 0x2e3c, pid: 0xc368, kind: "keyboard", name: "HE keyboard (2E3C:C368)", connection: "USB" },
    Known { vid: 0x0416, pid: 0x7372, kind: "keyboard", name: "HE keyboard (0416:7372)", connection: "USB" },
    Known { vid: 0x3142, pid: 0xa010, kind: "audio", name: "USB audio (EQ output)", connection: "USB" },
];

/// Names a shared VID/PID from the product string the device reports (Chrome shows "X68HE").
fn refine(known: &Known, reported: Option<&str>) -> &'static str {
    match (known.vid, known.pid, reported) {
        (0x2e3c, 0xc365, Some(r)) if r.to_ascii_uppercase().replace([' ', '-'], "").contains("X68") => "MAGIC-REFINER X68 HE",
        _ => known.name,
    }
}

pub fn list() -> Result<Vec<Connected>, String> {
    let api = hidapi::HidApi::new().map_err(|e| format!("HID enumeration failed: {e}"))?;
    // One entry per vendor/product id, with every collection Windows lists for it and the first
    // product string any of its interfaces reports.
    let mut seen: Vec<((u16, u16), Vec<CollectionInfo>, Option<String>)> = Vec::new();
    let mut bluetooth: Vec<(u16, u16)> = Vec::new();
    for info in api.device_list() {
        let id = (info.vendor_id(), info.product_id());
        if matches!(info.bus_type(), hidapi::BusType::Bluetooth) && !bluetooth.contains(&id) {
            bluetooth.push(id);
        }
        let collection = CollectionInfo { usage_page: info.usage_page(), usage: info.usage(), interface: info.interface_number() };
        let reported = info.product_string().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
        match seen.iter_mut().find(|(k, _, _)| *k == id) {
            Some((_, cols, name)) => {
                if !cols.contains(&collection) {
                    cols.push(collection);
                }
                if name.is_none() {
                    *name = reported;
                }
            }
            None => seen.push((id, vec![collection], reported)),
        }
    }
    Ok(seen
        .into_iter()
        .filter_map(|((vid, pid), collections, reported)| {
            let mut c = classify(vid, pid, collections, reported)?;
            if c.pad.is_some() && bluetooth.contains(&(vid, pid)) {
                c.connection = "Bluetooth";
            }
            Some(c)
        })
        .collect())
}

/// An XInput slot as a listed controller (Windows): named by the frontend from its USB ids.
pub fn xinput_pad(slot: u32, vid: u16, pid: u16, wireless: bool, battery: Option<(String, u8)>) -> Connected {
    let kind = crate::pads::kind(vid, pid).unwrap_or("xbox360");
    Connected {
        kind: "controller",
        name: "Game controller".into(),
        connection: if wireless { "Wireless" } else { "USB" },
        generic: false,
        kb: None,
        qmk: false,
        bootloader: false,
        vid: format!("{vid:04x}"),
        pid: format!("{pid:04x}"),
        reported: None,
        collections: Vec::new(),
        pad: Some(PadInfo { via: "xinput", kind, slot: Some(slot), battery }),
        path: None,
    }
}

/// What one vendor/product id is to SYNQ, or `None` when it is nothing SYNQ shows.
pub fn classify(vid: u16, pid: u16, collections: Vec<CollectionInfo>, reported: Option<String>) -> Option<Connected> {
    let entry = |kind: &'static str, name: String, connection: &'static str| Connected {
        kind,
        name,
        connection,
        generic: false,
        kb: None,
        qmk: false,
        bootloader: false,
        vid: format!("{vid:04x}"),
        pid: format!("{pid:04x}"),
        reported: reported.clone(),
        collections: collections.clone(),
        pad: None,
        path: None,
    };
    let (raw_page, raw_usage) = crate::hid::QMK_RAW_COLLECTION;
    let qmk = collections.iter().any(|c| (c.usage_page, c.usage) == (raw_page, raw_usage)) && crate::hid::qmk_raw_hid(vid, pid, raw_page, raw_usage);
    // Firmware-update mode first: whatever else this id would be, it is only a note now.
    if crate::hid::in_bootloader(vid, pid, reported.as_deref()) {
        let kind = bootloader_kind(vid, pid, &collections)?;
        let name = reported.clone().unwrap_or_else(|| "Device".into());
        return Some(Connected { bootloader: true, ..entry(kind, name, "USB") });
    }
    if let Some(known) = KNOWN.iter().find(|k| k.vid == vid && k.pid == pid) {
        return Some(entry(known.kind, refine(known, reported.as_deref()).to_string(), known.connection));
    }
    // A game controller: listed when its gamepad collection is there, and nothing else is made of its id.
    if crate::pads::is_pad(vid, pid) {
        let kind = crate::pads::kind(vid, pid)?;
        // On Windows an Xbox-class pad is read through XInput (its slot is listed instead), Bluetooth included.
        if cfg!(windows) && matches!(kind, "xbox360" | "xboxone" | "xboxelite") {
            return None;
        }
        if !collections.iter().any(|c| crate::pads::pad_collection(vid, pid, c.usage_page, c.usage)) {
            return None;
        }
        let name = reported.clone().unwrap_or_else(|| "Game controller".into());
        return Some(Connected { pad: Some(PadInfo { via: "hid", kind, slot: None, battery: None }), ..entry("controller", name, "USB") });
    }
    // A brand driver's keyboard: listed when its channel is there (and, for a borrowed vendor id, its name
    // fits). Checked before Logitech's mice so a Logitech G keyboard lands here; brand mice aren't listed yet.
    if let Some(ch) = crate::brands::device(vid, pid) {
        let present = collections.iter().any(|c| crate::brands::channel(vid, pid, c.usage_page, c.usage).is_some());
        if present && ch.kind == "headset" {
            let name = crate::headsets::name(vid, pid).or(reported.clone()).unwrap_or_else(|| "Headset".into());
            return Some(Connected { generic: true, ..entry("headset", name, "Wireless") });
        }
        if !present || !crate::brands::name_ok(ch, reported.as_deref()) || ch.kind != "keyboard" || !crate::brands::listed(vid, pid) {
            return None;
        }
        return Some(Connected { generic: true, kb: Some("brand"), ..entry("keyboard", candidate_name(reported.as_deref(), "Keyboard"), "USB") });
    }
    if vid == 0x046d {
        // Another Logitech mouse: SYNQ's Logitech panel reads its name from the mouse.
        return crate::openmouse_ids::LOGITECH_MOUSE_PIDS
            .contains(&pid)
            .then(|| entry("mouse", "Logitech mouse".into(), if pid >= 0xc500 { "LIGHTSPEED receiver" } else { "USB cable" }));
    }
    let allowed = crate::hid::allowed(vid, pid);
    let any = |f: fn(u16, u16, u16, u16) -> bool| collections.iter().any(|c| f(vid, pid, c.usage_page, c.usage));
    if allowed && crate::hid::keyboard_device(vid, pid) && any(crate::hid::keyboard_collection) {
        return Some(Connected { generic: true, kb: Some("omkb"), qmk, ..entry("keyboard", candidate_name(reported.as_deref(), "Keyboard"), "USB") });
    }
    if allowed && crate::hid::openmouse_device(vid, pid) && any(crate::hid::openmouse_collection_or_razer) {
        return Some(Connected { generic: true, qmk, ..entry("mouse", candidate_name(reported.as_deref(), "Mouse"), candidate_connection(reported.as_deref())) });
    }
    if qmk {
        return Some(Connected { generic: true, kb: Some("qmk"), qmk, ..entry("keyboard", candidate_name(reported.as_deref(), "Keyboard"), "USB") });
    }
    None
}

/// Which page shows a device in update mode: its table entry's kind when it has one, else a guess
/// from its vendor and collections; `None` for a device SYNQ would not show anyway.
fn bootloader_kind(vid: u16, pid: u16, collections: &[CollectionInfo]) -> Option<&'static str> {
    const KEYBOARDS: [(u16, u16); 4] = [(0x361d, 0x0201), (0x16c0, 0x0478), (0x16c0, 0x05df), (0x03eb, 0x2067)];
    if KEYBOARDS.contains(&(vid, pid)) || vid == 0x19f5 || (vid == 0x03eb && (0x2ff0..=0x2ff9).contains(&pid)) || (vid == 0x1038 && crate::brand_ids::STEELSERIES_BOOTLOADER.contains(&pid)) {
        return Some("keyboard");
    }
    if crate::pads::boot(vid, pid) {
        return Some("controller");
    }
    if crate::hid::bootloader_id(vid, pid) {
        return Some("mouse");
    }
    // Known by its product string only: shown where its vendor's devices go, if SYNQ knows the vendor.
    if crate::openmouse_ids::KEYBOARD_FILTERS.iter().any(|&(v, ..)| v == vid) || collections.iter().any(|c| (c.usage_page, c.usage) == crate::hid::QMK_RAW_COLLECTION) {
        return Some("keyboard");
    }
    (vid == 0x046d || vid == 0x373b || crate::openmouse_ids::FILTERS.iter().any(|&(v, ..)| v == vid)).then_some("mouse")
}

fn candidate_name(reported: Option<&str>, fallback: &str) -> String {
    reported.unwrap_or(fallback).to_string()
}

fn candidate_connection(reported: Option<&str>) -> &'static str {
    let r = reported.unwrap_or("").to_ascii_lowercase();
    if ["receiver", "dongle", "wireless", "2.4g"].iter().any(|w| r.contains(w)) { "Receiver" } else { "USB" }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn x68_is_named_from_its_product_string() {
        let k = KNOWN.iter().find(|k| k.vid == 0x2e3c).unwrap();
        assert_eq!(refine(k, Some("X68HE")), "MAGIC-REFINER X68 HE");
        assert_eq!(refine(k, Some("X68 HE")), "MAGIC-REFINER X68 HE");
        assert_eq!(refine(k, Some("VL68PRO")), "HE keyboard (2E3C:C365)");
        assert_eq!(refine(k, None), "HE keyboard (2E3C:C365)");
    }

    #[test]
    fn candidates_are_named_from_the_device() {
        assert_eq!(candidate_name(Some("Pulsar 8K Dongle"), "Mouse"), "Pulsar 8K Dongle");
        assert_eq!(candidate_name(None, "Mouse"), "Mouse");
        assert_eq!(candidate_connection(Some("Pulsar 8K Dongle")), "Receiver");
        assert_eq!(candidate_connection(Some("Razer DeathAdder V3")), "USB");
    }

    fn cols(list: &[(u16, u16)]) -> Vec<CollectionInfo> {
        list.iter().map(|&(usage_page, usage)| CollectionInfo { usage_page, usage, interface: 1 }).collect()
    }

    #[test]
    fn keyboards_and_bootloaders_are_classified() {
        let typing = [(0x0001, 0x0006), (0x000c, 0x0001), (0x0001, 0x0002)];
        // A VIA board from an unknown vendor: a keyboard candidate on the QMK path.
        let via = classify(0x4653, 0x0001, cols(&[typing[0], typing[1], (0xff60, 0x0061)]), Some("Some 65%".into())).unwrap();
        assert_eq!((via.kind, via.generic, via.kb, via.qmk, via.bootloader), ("keyboard", true, Some("qmk"), true, false));
        // The same board without its raw-HID collection is nothing SYNQ shows.
        assert!(classify(0x4653, 0x0001, cols(&typing), Some("Some 65%".into())).is_none());
        // A Wuque Studio board: the OpenMouse keyboard path.
        let wuque = classify(0x1ca6, 0x1b10, cols(&[typing[0], (0xffb0, 0x0001)]), Some("BABAO60 HE".into())).unwrap();
        assert_eq!((wuque.kind, wuque.kb), ("keyboard", Some("omkb")));
        // An OpenMouse mouse that also has a raw-HID collection stays a mouse candidate (flagged).
        let pulsar = classify(0x3710, 0x5405, cols(&[(0xff00, 0x0001), (0xff60, 0x0061)]), Some("Pulsar 8K Dongle".into())).unwrap();
        assert_eq!((pulsar.kind, pulsar.generic, pulsar.kb, pulsar.qmk), ("mouse", true, None, true));
        // Firmware-update mode: a note, whichever page, never a candidate.
        let egg = classify(0x3367, 0x1977, cols(&[(0xff01, 0x0001)]), Some("Bootloader".into())).unwrap();
        assert_eq!((egg.kind, egg.generic, egg.bootloader), ("mouse", false, true));
        let by_name = classify(0x3367, 0x1978, cols(&[(0xff01, 0x0001)]), Some("Bootloader".into())).unwrap();
        assert!(by_name.bootloader && !by_name.generic);
        let fm_kb = classify(0x361d, 0x0201, cols(&[(0xff00, 0x0001)]), None).unwrap();
        assert_eq!((fm_kb.kind, fm_kb.bootloader), ("keyboard", true));
        // An unknown device that calls itself a bootloader isn't shown at all.
        assert!(classify(0x1234, 0x5678, cols(&[(0xff00, 0x0001)]), Some("Bootloader".into())).is_none());
        // The hand-built devices are as before.
        let falchion = classify(0x0b05, 0x1d1d, cols(&[(0xff00, 0x0001), typing[0]]), None).unwrap();
        assert_eq!((falchion.kind, falchion.generic, falchion.name.as_str()), ("keyboard", false, "ROG Falchion Ace HFX ZywOo"));
        assert!(classify(0x0b05, 0x19af, cols(&[(0xff72, 0x00a1), (0xff60, 0x0061)]), None).is_none(), "the Aura controller is never listed");
        let x1 = classify(0x373b, 0x1278, cols(&[(0xff02, 0x0002)]), Some("Wireless mouse 8k dongle-L".into())).unwrap();
        assert_eq!((x1.kind, x1.generic), ("mouse", false));
    }

    #[test]
    fn brand_keyboards_are_listed_by_their_channel() {
        let typing = [(0x0001, 0x0006), (0x000c, 0x0001)];
        let sonix = classify(0x0c45, 0x8030, cols(&[typing[0], (0xff68, 0x0061)]), Some("Fighting68 HE".into())).unwrap();
        assert_eq!((sonix.kind, sonix.generic, sonix.kb), ("keyboard", true, Some("brand")));
        assert!(classify(0x0c45, 0x8030, cols(&typing), None).is_none(), "no channel, not listed");
        let mg = classify(0x3151, 0x5030, cols(&[(0xffff, 0x0002), typing[0]]), Some("MonsGeek M1 V5".into())).unwrap();
        assert_eq!((mg.kind, mg.kb), ("keyboard", Some("brand")));
        let dd = classify(0x352d, 0x2383, cols(&[(0xff00, 0x0000)]), Some("DrunkDeer A75".into())).unwrap();
        assert_eq!(dd.kb, Some("brand"));
        assert!(classify(0x1a81, 0x2094, cols(&[(0xff00, 0x0000)]), Some("Generic Keyboard".into())).is_none(), "X60 id without its name");
        assert!(classify(0x1a81, 0x2094, cols(&[(0xff00, 0x0000)]), Some("DrunkDeer X60".into())).is_some());
        let rz = classify(0x1532, 0x02ea, cols(&[(0x000c, 0x0001)]), Some("Razer Huntsman V3 Pro TKL".into())).unwrap();
        assert_eq!((rz.kind, rz.kb), ("keyboard", Some("brand")));
        assert!(classify(0x1532, 0xb005, cols(&[(0x000c, 0x0001)]), None).is_none(), "brand mice are opened, not listed yet");
        let redragon = classify(0x372e, 0x105b, cols(&[(0xff00, 0x0001)]), Some("K709".into())).unwrap();
        assert_eq!((redragon.kind, redragon.kb), ("keyboard", Some("brand")), "not a Bytech mouse candidate");
        // Wave 3a / 4.
        let rog = classify(0x0b05, 0x1b7e, cols(&[typing[0], (0xff00, 0x0001), (0xff13, 0x0001)]), Some("ROG Falchion Ace HFX".into())).unwrap();
        assert_eq!((rog.kind, rog.kb), ("keyboard", Some("brand")));
        let zywoo = classify(0x0b05, 0x1d1d, cols(&[(0xff00, 0x0001), typing[0]]), None).unwrap();
        assert_eq!((zywoo.generic, zywoo.kb), (false, None), "the Falchion ZywOo keeps its own panel");
        let k70 = classify(0x1b1c, 0x2b0e, cols(&[typing[0], (0xff42, 0x0001), (0xff42, 0x0002)]), Some("K70 PRO TKL".into())).unwrap();
        assert_eq!(k70.kb, Some("brand"));
        assert!(classify(0x1b1c, 0x2b0e, cols(&[typing[0], (0xff42, 0x0002)]), None).is_none(), "only the key-press collection: not listed");
        assert!(classify(0x1b1c, 0x1bc0, cols(&[(0xff42, 0x0001)]), Some("K70 MAX".into())).is_none(), "iCUE: no keyboard driver yet, so not listed");
        assert!(classify(0x1b1c, 0x2b0c, cols(&[(0xff42, 0x0001)]), None).is_none(), "a non-HE Bragi board: no driver claims it");
        assert!(classify(0x0b05, 0x1c10, cols(&[(0xff00, 0x0001)]), None).is_some(), "an ASUS HE board the driver claims");
        let g515 = classify(0x046d, 0xc339, cols(&[typing[0], (0xff00, 0x0002)]), Some("G515".into())).unwrap();
        assert_eq!((g515.kind, g515.kb), ("keyboard", Some("brand")), "a Logitech G keyboard, not a mouse");
        let dex = classify(0x046d, 0xc0a0, cols(&[(0xff00, 0x0002)]), None).unwrap();
        assert_eq!((dex.kind, dex.generic), ("mouse", false), "the DEX is unchanged");
        let apex = classify(0x1038, 0x1642, cols(&[typing[0], (0xffc0, 0x0001)]), Some("Apex Pro".into())).unwrap();
        assert_eq!(apex.kb, Some("brand"));
        let boot = classify(0x1038, 0x1643, cols(&[(0xffc0, 0x0001)]), None).unwrap();
        assert_eq!((boot.bootloader, boot.kind), (true, "keyboard"), "an Apex in update mode is only a note");
        // The 0x19F5 firmware family: listed by its Generic Desktop usage-0 collection, never by the typing ones alone.
        let ace = classify(0x41e4, 0x2101, cols(&[typing[0], (0x0001, 0x0000)]), Some("MCHOSE Ace 60".into())).unwrap();
        assert_eq!((ace.kind, ace.generic, ace.kb), ("keyboard", true, Some("brand")));
        assert!(classify(0x41e4, 0x2101, cols(&typing), None).is_none(), "the typing collections alone: not listed");
        let nuphy = classify(0x19f5, 0x6120, cols(&[typing[0], (0x0001, 0x0000)]), Some("NuPhy Air75 HE".into())).unwrap();
        assert_eq!(nuphy.kb, Some("brand"));
        assert!(classify(0x19f5, 0x1234, cols(&[(0x0001, 0x0000)]), None).is_none(), "an unlisted 19F5 id is nobody's");
        for (pid, name) in [(0x6f10, "NuPhy Air75 HE"), (0xaf12, "DrunkDeer"), (0x8a11, "RK K99"), (0xfe00, "RK 2.4G")] {
            let up = classify(0x19f5, pid, cols(&[(0xff00, 0x0001)]), Some(name.into())).unwrap();
            assert_eq!((up.bootloader, up.kind, up.generic), (true, "keyboard", false), "{pid:04x} in update mode is only a note");
        }
    }

    #[test]
    fn the_receiver_does_not_claim_a_model() {
        let k = KNOWN.iter().find(|k| k.pid == 0xc54d).unwrap();
        assert_eq!(refine(k, Some("USB Receiver")), "Logitech mouse");
    }
}
