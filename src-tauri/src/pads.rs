//! Game controllers (docs/devices/CONTROLLERS.md, wave C1): which collections of a pad the bridge opens, and the
//! only reports it may send one. The rule is separate from every mouse and keyboard rule and applies to the ids in
//! the controller table only (`controller_ids.rs`, generated from SDL, xpad and src/lib/controllers/models.ts):
//!
//! - a HID pad's Gamepad (Generic Desktop 0x05) or Joystick (0x04) collection, and for Valve's pads their vendor
//!   input collection (0xFF00:0x0001), are opened; nothing else on a pad is (never Mouse 0x02, Keyboard 0x06, the
//!   Keyboard page 0x07, Consumer, a vendor configuration channel);
//! - they are read only (`Access::InputOnly`), except Sony's and Nintendo's pads, which are opened `Full` so the
//!   checks below can let their volatile outputs and their reads through: every other report is refused here;
//! - GameSir's HID pads (wave C2, per PID: `PAD_GAMESIR`) also open their vendor collection (page 0xFFF0) `Full`:
//!   its register reads and the writes of `GAMESIR_MAPS` only (src/lib/controllers/gamesir.ts, generated), never the
//!   firmware loader, macros or a raw bank write;
//! - the 8BitDo Ultimate in HID (`PAD_8BITDO`: 2.4G adapter, PC, config mode) opens its gamepad collection `Full`
//!   for its config channel (report 0x81): report state, version, chunk reads, chunk writes checked field by field,
//!   save, the vibration test; never calibration (0x36 / 0x38), reset or boot commands (src/lib/controllers/eightbitdo.ts);
//! - Flydigi in D-input mode (`PAD_FLYDIGI`, 04B4:2412) opens its vendor collection (page 0xFFA0) `Full` for its
//!   config channel (report 5): device info, config reads, the config write checked field by field, save to flash,
//!   the motor test; never the XInput switch, update mode, LED or screen writes (src/lib/controllers/flydigi.ts);
//! - the SCUF Envision Pro / V2 (`PAD_SCUF`) also open their BRAGI request collection (0xFF42:0x0001) `Full`, for
//!   BRAGI 1.0 GETs of identity, firmware, battery and the connected-pad bitmap only (src/lib/controllers/scuf.ts);
//! - an XInput pad (Xbox 360 class / Xbox One class) is never opened as HID at all: the tester reads it through
//!   XInput (src/xinput.rs). Its HID shims (Windows' "IG_" collections) stay shut;
//! - bootloader and recovery identities are refused everywhere (`boot`, through hid.rs `bootloader_id`).
//!
//! The output and feature checks mirror src/lib/controllers/guard.ts exactly; both judge every line of
//! pad-frames.txt (scripts/pad-fixtures.ts) the same way (test `pad_guard_matches_the_frontend`).

use crate::controller_ids::{
    GamesirMap, GAMESIR_CURVES, GAMESIR_FIELD_KINDS, GAMESIR_LIGHT_MODES, GAMESIR_MAPS, GAMESIR_TARGETS, HID, KINDS, PADS, PAD_BOOT, PAD_DS4, PAD_DS5, PAD_8BITDO, PAD_EDGE, PAD_FLYDIGI, PAD_GAMESIR, PAD_SCUF, PAD_SWITCH,
};
use crate::hid::Access;

pub const GENERIC_DESKTOP: u16 = 0x0001;
pub const JOYSTICK: u16 = 0x0004;
pub const GAMEPAD: u16 = 0x0005;
/// Valve's pads (Steam Controller, Steam Deck, HORIPAD for Steam) report their state on this vendor collection.
pub const VALVE_INPUT: (u16, u16) = (0xff00, 0x0001);
/// GameSir's vendor collection (any usage): the configuration channel (out 0x0F, answers 0x10) and the state report 0x12.
pub const GAMESIR_PAGE: u16 = 0xfff0;
/// Corsair's BRAGI request collection, on the SCUF Envision: reads only.
pub const BRAGI_REQUEST: (u16, u16) = (0xff42, 0x0001);
/// Flydigi's vendor collection in D-input mode (any usage): its config channel.
pub const FLYDIGI_PAGE: u16 = 0xffa0;

/// What may be sent to a HID pad.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Guard {
    /// DualSense.
    Ds5,
    /// DualSense Edge: the DualSense's reports, its profile reads, and (wave C2) its custom-slot writes and deletes.
    Edge,
    /// DualShock 4.
    Ds4,
    /// Switch Pro Controller / Joy-Con.
    Switch,
    /// A GameSir HID pad (wave C2): the register map `GAMESIR_MAPS[i]`.
    Gamesir(u8),
    /// SCUF Envision Pro / V2 (wave C2): BRAGI reads only.
    Scuf,
    /// 8BitDo Ultimate in HID (wave C3): its config channel.
    EightBitDo,
    /// Flydigi in D-input mode (wave C3): its config channel.
    Flydigi,
    /// Everyone else: nothing at all.
    Input,
}

/// The table row of a pad: (kind, transport).
pub fn entry(vendor_id: u16, product_id: u16) -> Option<(u8, u8)> {
    PADS.binary_search_by(|&(v, p, _, _)| (v, p).cmp(&(vendor_id, product_id))).ok().map(|i| (PADS[i].2, PADS[i].3))
}

/// Whether this id is a game controller SYNQ knows (any transport).
pub fn is_pad(vendor_id: u16, product_id: u16) -> bool {
    entry(vendor_id, product_id).is_some()
}

/// A controller in firmware-update or recovery mode: never listed, never opened.
pub fn boot(vendor_id: u16, product_id: u16) -> bool {
    PAD_BOOT.contains(&(vendor_id, product_id))
}

/// A pad the bridge may open as HID (an XInput pad is read through XInput instead).
pub fn hid_pad(vendor_id: u16, product_id: u16) -> bool {
    !boot(vendor_id, product_id) && entry(vendor_id, product_id).is_some_and(|(_, t)| t == HID)
}

/// The controller type's name ("ps5", "switchpro", "xboxone", ...).
pub fn kind(vendor_id: u16, product_id: u16) -> Option<&'static str> {
    entry(vendor_id, product_id).map(|(k, _)| KINDS[k as usize])
}

/// What may be sent to this HID pad.
pub fn guard(vendor_id: u16, product_id: u16) -> Option<Guard> {
    if !hid_pad(vendor_id, product_id) {
        return None;
    }
    let id = (vendor_id, product_id);
    Some(if PAD_DS5.contains(&id) {
        Guard::Ds5
    } else if PAD_EDGE.contains(&id) {
        Guard::Edge
    } else if PAD_DS4.contains(&id) {
        Guard::Ds4
    } else if PAD_SWITCH.contains(&id) {
        Guard::Switch
    } else if let Some(&(_, _, m)) = PAD_GAMESIR.iter().find(|&&(v, p, _)| (v, p) == id) {
        Guard::Gamesir(m)
    } else if PAD_SCUF.contains(&id) {
        Guard::Scuf
    } else if PAD_8BITDO.contains(&id) {
        Guard::EightBitDo
    } else if PAD_FLYDIGI.contains(&id) {
        Guard::Flydigi
    } else {
        Guard::Input
    })
}

/// The collections of a pad the tester reads: Gamepad or Joystick, and Valve's vendor input collection on Valve's pads.
pub fn pad_collection(vendor_id: u16, product_id: u16, usage_page: u16, usage: u16) -> bool {
    if !hid_pad(vendor_id, product_id) {
        return false;
    }
    if usage_page == GENERIC_DESKTOP && (usage == JOYSTICK || usage == GAMEPAD) {
        return true;
    }
    if usage_page == GAMESIR_PAGE && matches!(guard(vendor_id, product_id), Some(Guard::Gamesir(_))) {
        return true;
    }
    if (usage_page, usage) == BRAGI_REQUEST && guard(vendor_id, product_id) == Some(Guard::Scuf) {
        return true;
    }
    if usage_page == FLYDIGI_PAGE && guard(vendor_id, product_id) == Some(Guard::Flydigi) {
        return true;
    }
    let valve = matches!(kind(vendor_id, product_id), Some("steam" | "steamdeck" | "steamtriton" | "horisteam"));
    valve && (usage_page, usage) == VALVE_INPUT
}

/// How a collection of a pad may be used, or None. Only called for ids in the controller table (hid.rs
/// `collection_access` asks this first and stops here for every pad, whatever its vendor's other rules say).
pub fn access(vendor_id: u16, product_id: u16, usage_page: u16, usage: u16) -> Option<Access> {
    if !pad_collection(vendor_id, product_id, usage_page, usage) {
        return None;
    }
    match guard(vendor_id, product_id)? {
        Guard::Ds5 | Guard::Edge | Guard::Ds4 | Guard::Switch | Guard::EightBitDo if usage_page == GENERIC_DESKTOP => Some(Access::Full),
        Guard::Gamesir(_) if usage_page == GAMESIR_PAGE => Some(Access::Full),
        Guard::Scuf if (usage_page, usage) == BRAGI_REQUEST => Some(Access::Full),
        Guard::Flydigi if usage_page == FLYDIGI_PAGE => Some(Access::Full),
        _ => Some(Access::InputOnly),
    }
}

// ---- the output and feature checks (src/lib/controllers/guard.ts)

const CRC_POLY: u32 = 0xedb8_8320;

fn crc32(bytes: &[u8], crc: u32) -> u32 {
    let mut c = !crc;
    for &b in bytes {
        c ^= u32::from(b);
        for _ in 0..8 {
            c = if c & 1 != 0 { CRC_POLY ^ (c >> 1) } else { c >> 1 };
        }
    }
    !c
}

/// The CRC a Sony Bluetooth output report ends in: over the HID header byte 0xA2, the report id and the data.
pub fn sony_bt_crc(report_id: u8, data: &[u8]) -> u32 {
    crc32(data, crc32(&[0xa2, report_id], 0))
}

fn zero(d: &[u8]) -> bool {
    d.iter().all(|&b| b == 0)
}

fn le32(d: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([d[at], d[at + 1], d[at + 2], d[at + 3]])
}

type Verdict = Result<&'static str, String>;

const DS5_COMMON: usize = 47;
const DS5_USB_OUTPUT: u8 = 0x02;
const DS5_BT_OUTPUT: u8 = 0x31;
const DS5_BT_LEN: usize = 77;
const DS5_TRIGGERS: [(&str, [u8; 11]); 3] = [
    ("off", [0x05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ("resistance", [0x01, 0, 110, 0, 0, 0, 0, 0, 0, 0, 0]),
    ("vibration", [0x06, 15, 63, 128, 0, 0, 0, 0, 0, 0, 0]),
];

/// The 47-byte DualSense effects block: exactly one allowed effect, every other byte zero.
fn ds5_common(c: &[u8]) -> Verdict {
    let (e1, e2) = (c[0], c[1]);
    if e1 & !0x0f != 0 {
        return Err(format!("DualSense: enable flags {e1:#04x} aren't SYNQ's."));
    }
    if e2 & !(0x01 | 0x04 | 0x08 | 0x10) != 0 {
        return Err(format!("DualSense: LED flags {e2:#04x} aren't SYNQ's."));
    }
    let rumble = e1 & 0x03;
    let triggers = e1 & 0x0c;
    if rumble != 0 && rumble != 0x03 {
        return Err("DualSense: rumble needs both of its flags.".into());
    }
    if triggers != 0 && triggers != 0x0c {
        return Err("DualSense: the trigger test sets both triggers.".into());
    }
    let mut effects: Vec<&'static str> = Vec::new();
    if rumble != 0 {
        effects.push("rumble");
    } else if c[2] != 0 || c[3] != 0 {
        return Err("DualSense: motor values without the rumble flags.".into());
    }
    let (right, left) = (&c[10..21], &c[21..32]);
    if triggers != 0 {
        let Some(&(name, _)) = DS5_TRIGGERS.iter().find(|(_, t)| t == right) else {
            return Err("DualSense: only the off, resistance and vibration trigger tests are sent.".into());
        };
        if left != right {
            return Err("DualSense: only the off, resistance and vibration trigger tests are sent.".into());
        }
        effects.push(match name {
            "off" => "triggers off",
            "resistance" => "triggers resistance",
            _ => "triggers vibration",
        });
    } else if !zero(right) || !zero(left) {
        return Err("DualSense: trigger bytes without the trigger flags.".into());
    }
    if e2 & 0x01 != 0 {
        if c[8] > 2 {
            return Err("DualSense: the mic LED is off, on or pulsing.".into());
        }
        effects.push("mic LED");
    } else if c[8] != 0 {
        return Err("DualSense: mic LED value without its flag.".into());
    }
    if e2 & 0x04 != 0 {
        effects.push("lightbar");
    } else if c[44] != 0 || c[45] != 0 || c[46] != 0 {
        return Err("DualSense: lightbar colour without its flag.".into());
    }
    if e2 & 0x10 != 0 {
        if c[43] > 0x3f {
            return Err("DualSense: player LED pattern out of range.".into());
        }
        effects.push("player LEDs");
    } else if c[43] != 0 {
        return Err("DualSense: player LEDs without their flag.".into());
    }
    if e2 & 0x08 != 0 {
        effects.push("release LEDs");
    }
    for (from, to) in [(4, 8), (9, 10), (32, 43)] {
        if !zero(&c[from..to]) {
            return Err(format!("DualSense: bytes {from}..{} are audio or setup controls SYNQ never sends.", to - 1));
        }
    }
    match effects.as_slice() {
        [one] => Ok(one),
        [] => Err("DualSense: an empty effects report isn't sent.".into()),
        many => Err(format!("DualSense: one effect per report ({}).", many.join(", "))),
    }
}

fn ds5_output(report_id: u8, d: &[u8]) -> Verdict {
    match report_id {
        DS5_USB_OUTPUT => {
            if d.len() < DS5_COMMON {
                return Err("DualSense: USB output report too short.".into());
            }
            if !zero(&d[DS5_COMMON..]) {
                return Err("DualSense: bytes after the effects block.".into());
            }
            ds5_common(&d[..DS5_COMMON])
        }
        DS5_BT_OUTPUT => {
            if d.len() != DS5_BT_LEN {
                return Err(format!("DualSense: Bluetooth output report is {DS5_BT_LEN} bytes."));
            }
            if d[0] & 0x0f != 0 || d[1] != 0x10 {
                return Err("DualSense: Bluetooth sequence/tag bytes.".into());
            }
            if !zero(&d[2 + DS5_COMMON..DS5_BT_LEN - 4]) {
                return Err("DualSense: padding before the CRC.".into());
            }
            if le32(d, DS5_BT_LEN - 4) != sony_bt_crc(report_id, &d[..DS5_BT_LEN - 4]) {
                return Err("DualSense: Bluetooth CRC doesn't match.".into());
            }
            ds5_common(&d[2..2 + DS5_COMMON])
        }
        _ => Err(format!("DualSense: output report {report_id:#04x} isn't one SYNQ sends.")),
    }
}

/// DualShock 4 common block (10 bytes): rumble or lightbar, no blink, nothing else.
fn ds4_common(c: &[u8]) -> Verdict {
    if c[1] != 0 || c[2] != 0 || c[8] != 0 || c[9] != 0 {
        return Err("DualShock 4: flags 2, reserved and blink bytes stay zero.".into());
    }
    match c[0] {
        0x01 if c[5] == 0 && c[6] == 0 && c[7] == 0 => Ok("DualShock 4 rumble"),
        0x01 => Err("DualShock 4: colour without the LED flag.".into()),
        0x02 if c[3] == 0 && c[4] == 0 => Ok("DualShock 4 lightbar"),
        0x02 => Err("DualShock 4: motor values without the rumble flag.".into()),
        f => Err(format!("DualShock 4: flags {f:#04x}: one of rumble or lightbar per report.")),
    }
}

fn ds4_output(report_id: u8, d: &[u8]) -> Verdict {
    match report_id {
        0x05 => {
            if d.len() < 10 {
                return Err("DualShock 4: USB output report too short.".into());
            }
            if !zero(&d[10..]) {
                return Err("DualShock 4: bytes after the effects.".into());
            }
            ds4_common(&d[..10])
        }
        0x11 => {
            if d.len() != 77 {
                return Err("DualShock 4: Bluetooth output report is 77 bytes.".into());
            }
            if d[0] != 0xc0 || d[1] != 0 {
                return Err("DualShock 4: Bluetooth control bytes.".into());
            }
            if !zero(&d[12..73]) {
                return Err("DualShock 4: padding before the CRC.".into());
            }
            if le32(d, 73) != sony_bt_crc(report_id, &d[..73]) {
                return Err("DualShock 4: Bluetooth CRC doesn't match.".into());
            }
            ds4_common(&d[2..12])
        }
        _ => Err(format!("DualShock 4: output report {report_id:#04x} isn't one SYNQ sends.")),
    }
}

const SWITCH_BT_LEN: usize = 48;
const SWITCH_USB_LEN: usize = 63;
const SWITCH_STOP: [u8; 8] = [0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40];
const SWITCH_PULSE: [u8; 8] = [0x74, 0x88, 0x3d, 0x62, 0x74, 0x88, 0x3d, 0x62];
/// SPI ranges that may be read: stick and IMU calibration, factory and user. Inclusive.
const SWITCH_SPI_READABLE: [(u32, u32); 4] = [(0x6020, 0x6037), (0x603d, 0x604e), (0x8010, 0x8025), (0x8026, 0x8039)];
const SWITCH_SPI_MAX: u8 = 0x1d;

fn refused_sub(id: u8) -> String {
    if (0x20..=0x2b).contains(&id) {
        return format!("Switch: subcommand {id:#04x} (NFC/IR MCU) is never sent.");
    }
    let name = match id {
        0x01 => " (Bluetooth pairing)",
        0x06 => " (HCI state (sleep, reboot, pairing))",
        0x07 => " (reset pairing)",
        0x08 => " (shipment mode)",
        0x11 => " (SPI flash write)",
        0x12 => " (SPI flash erase)",
        0x41 => " (IMU sensitivity)",
        0x42 => " (IMU register write)",
        0x50..=0x52 => " (GPIO)",
        _ => "",
    };
    format!("Switch: subcommand {id:#04x}{name} is never sent.")
}

fn switch_output(report_id: u8, d: &[u8]) -> Verdict {
    if d.len() != SWITCH_BT_LEN && d.len() != SWITCH_USB_LEN {
        return Err(format!("Switch: output reports are {SWITCH_BT_LEN} (Bluetooth) or {SWITCH_USB_LEN} (USB) bytes."));
    }
    if report_id == 0x80 {
        if !(0x01..=0x05).contains(&d[0]) {
            let mcu = if d[0] == 0x06 { " (MCU reset)" } else { "" };
            return Err(format!("Switch: USB command {:#04x} is never sent{mcu}.", d[0]));
        }
        return if zero(&d[1..]) { Ok("Switch USB command") } else { Err("Switch: USB commands carry no data.".into()) };
    }
    if d[0] > 0x0f {
        return Err("Switch: the packet counter is 4 bits.".into());
    }
    let rumble = &d[1..9];
    if report_id == 0x10 {
        if !zero(&d[9..]) {
            return Err("Switch: the rumble report carries rumble only.".into());
        }
        if rumble == SWITCH_STOP {
            return Ok("Switch rumble stop");
        }
        if rumble == SWITCH_PULSE {
            return Ok("Switch rumble test pulse");
        }
        return Err("Switch: only the stop and test-pulse rumble frames are sent.".into());
    }
    if report_id != 0x01 {
        return Err(format!("Switch: output report {report_id:#04x} isn't one SYNQ sends."));
    }
    if rumble != SWITCH_STOP {
        return Err("Switch: a subcommand carries the neutral rumble.".into());
    }
    let sub = d[9];
    let args = &d[10..];
    let rest = |n: usize| zero(&args[n..]);
    match sub {
        0x02 if rest(0) => Ok("Switch device info"),
        0x02 => Err("Switch: device info takes no arguments.".into()),
        0x03 if (args[0] == 0x30 || args[0] == 0x3f) && rest(1) => Ok("Switch input mode"),
        0x03 => Err("Switch: input mode 0x30 (full) or 0x3F (simple, to restore) only.".into()),
        0x10 => {
            let address = le32(args, 0);
            let length = args[4];
            if !rest(5) || length < 1 || length > SWITCH_SPI_MAX {
                return Err("Switch: SPI read of 1 to 29 bytes, no other arguments.".into());
            }
            let last = address.saturating_add(u32::from(length) - 1);
            if SWITCH_SPI_READABLE.iter().any(|&(first, end)| address >= first && last <= end) {
                Ok("Switch SPI read")
            } else {
                Err(format!("Switch: SPI {address:#x}+{length} is outside the calibration ranges."))
            }
        }
        0x30 if rest(1) => Ok("Switch player lights"),
        0x30 => Err("Switch: player lights take one byte.".into()),
        0x38 => {
            let i = args[1] >> 4;
            if args[0] == 0x01 && args[1] == i << 4 && args[2] == i << 4 && args[3] == 0 && rest(4) {
                Ok("Switch HOME light")
            } else {
                Err("Switch: HOME light takes SYNQ's one steady pattern.".into())
            }
        }
        0x40 if args[0] <= 1 && rest(1) => Ok("Switch IMU"),
        0x40 => Err("Switch: IMU on or off only.".into()),
        0x48 if args[0] <= 1 && rest(1) => Ok("Switch vibration"),
        0x48 => Err("Switch: vibration on or off only.".into()),
        other => Err(refused_sub(other)),
    }
}

fn name(g: Guard) -> &'static str {
    match g {
        Guard::Ds5 => "DualSense",
        Guard::Edge => "DualSense Edge",
        Guard::Ds4 => "DualShock 4",
        Guard::Switch => "Switch controller",
        Guard::Gamesir(m) => GAMESIR_MAPS[m as usize].name,
        Guard::Scuf => "SCUF Envision",
        Guard::EightBitDo => "8BitDo Ultimate",
        Guard::Flydigi => "Flydigi",
        Guard::Input => "This controller",
    }
}

// ---- 8BitDo Ultimate (src/lib/controllers/eightbitdo.ts `checkEbdOutput`, which this mirrors)

const EBD_OUT: u8 = 0x81;
const EBD_LEN: usize = 63;
const EBD_CONFIG_SIZE: u32 = 1652;
const EBD_CHUNK: u32 = 45;
const EBD_KEY_BITS: u32 = 0x07c7_ffff;
const EBD_FEATURE_BITS: u32 = 0x309f;

/// CRC-16/KERMIT (poly 0x8408 reflected, init 0xFFFF, no final xor).
pub fn crc16_kermit(bytes: &[u8]) -> u16 {
    let mut crc: u16 = 0xffff;
    for &b in bytes {
        crc ^= u16::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0x8408 } else { crc >> 1 };
        }
    }
    crc
}

/// Why a config chunk at `offset` isn't one SYNQ writes (each field that lies inside it is checked), or None.
fn ebd_chunk_problem(offset: usize, chunk: &[u8]) -> Option<&'static str> {
    let end = offset + chunk.len();
    let has = |at: usize, n: usize| at >= offset && at + n <= end;
    let b = |at: usize| chunk[at - offset];
    let u16_at = |at: usize| u16::from_le_bytes([b(at), b(at + 1)]);
    let u32_at = |at: usize| u32::from_le_bytes([b(at), b(at + 1), b(at + 2), b(at + 3)]);
    let f32_at = |at: usize| f32::from_le_bytes([b(at), b(at + 1), b(at + 2), b(at + 3)]);
    if has(0x010, 2) && u16_at(0x010) > 5 {
        return Some("gamepad mode");
    }
    if has(0x012, 2) && u16_at(0x012) > 2 {
        return Some("active profile");
    }
    for at in offset.max(0x014)..end.min(0x014 + 3 * 32) {
        if b(at) != 0 && b(at) < 0x20 {
            return Some("a control character in a profile name");
        }
    }
    for i in 0..3 {
        for at in [0x074 + i * 12 + 4, 0x074 + i * 12 + 8] {
            if has(at, 4) && !(0.0..=1.0).contains(&f32_at(at)) {
                return Some("rumble 0 to 1");
            }
        }
        for base in [0x098 + i * 8, 0x0b0 + i * 8] {
            for at in [base + 4, base + 6] {
                if has(at, 2) && b(at) > b(at + 1) {
                    return Some("a range that ends before it starts");
                }
            }
        }
        if has(0x0c8 + i * 8 + 4, 4) && u32_at(0x0c8 + i * 8 + 4) & !EBD_FEATURE_BITS != 0 {
            return Some("an unknown special-feature bit");
        }
        for k in 0..20 {
            let at = 0x0e0 + i * 84 + 4 + k * 4;
            if has(at, 4) && u32_at(at) & !EBD_KEY_BITS != 0 {
                return Some("an unknown button bit");
            }
        }
        let macro_at = 0x1dc + i * 392;
        if has(macro_at + 4, 1) && b(macro_at + 4) > 4 {
            return Some("more than 4 macros");
        }
        for m in 0..4 {
            let at = macro_at + 8 + m * 96 + 94;
            if has(at, 1) && b(at) > 18 {
                return Some("a macro longer than 18 steps");
            }
        }
    }
    None
}

/// An output report to an 8BitDo Ultimate in config mode.
fn ebd_output(report_id: u8, d: &[u8]) -> Verdict {
    let no = |why: String| -> Verdict { Err(format!("8BitDo: {why}.")) };
    if report_id != EBD_OUT {
        return no(format!("output report {report_id:#04x} isn't the config channel's"));
    }
    if d.len() != EBD_LEN {
        return no("config reports are 64 bytes".into());
    }
    let rest = |from: usize| zero(&d[from..]);
    let u16_at = |at: usize| u16::from_le_bytes([d[at], d[at + 1]]);
    let u32_at = |at: usize| u32::from_le_bytes([d[at], d[at + 1], d[at + 2], d[at + 3]]);
    if d[1] != 0x04 {
        if d[..5] == [0x05, 0x00, 0x21, 0x01, 0x00] && rest(5) {
            return Ok("8BitDo firmware version");
        }
        let cal = if d[2] == 0x36 || d[2] == 0x38 { " (stick calibration)" } else { "" };
        return no(format!("direct command {:x}{:02x} is never sent{cal}", d[1], d[2]));
    }
    let (cmd, sub) = (u16_at(2), u16_at(4));
    match cmd {
        7 => {
            if d[0] == 0x11 && sub == 0 && rest(6) {
                Ok("8BitDo config mode")
            } else {
                no("the report-state command".into())
            }
        }
        6 => {
            if d[0] == 0x11 && sub == 0x15 && rest(6) {
                Ok("8BitDo save")
            } else {
                no("the save command".into())
            }
        }
        8 => {
            if d[0] == 0x11 && (1..=1000).contains(&sub) && rest(8) {
                Ok("8BitDo vibration test")
            } else {
                no("the vibration test (at most 1 s)".into())
            }
        }
        1 | 2 => {
            let (chunk, total, offset) = (u32::from(u16_at(6)), u32_at(10), u32_at(14));
            if sub != 0 || total != EBD_CONFIG_SIZE || offset % EBD_CHUNK != 0 || offset >= EBD_CONFIG_SIZE || chunk != EBD_CHUNK.min(EBD_CONFIG_SIZE - offset) {
                return no("a chunk of the 1652-byte config".into());
            }
            if cmd == 2 {
                return if d[0] == 0x11 && u16_at(8) == 0 && rest(18) { Ok("8BitDo config read") } else { no("a read carries no data".into()) };
            }
            let n = chunk as usize;
            let payload = &d[18..18 + n];
            if usize::from(d[0]) != 17 + n || u16_at(8) != crc16_kermit(payload) || !rest(18 + n) {
                return no("a write chunk with its CRC".into());
            }
            match ebd_chunk_problem(offset as usize, payload) {
                Some(why) => no(why.into()),
                None => Ok("8BitDo config write"),
            }
        }
        _ => {
            let what = match cmd {
                0x0b | 0x0c => " (vibration parameters: it can disconnect the pad)",
                0x0d => " (reset)",
                _ => "",
            };
            no(format!("command {cmd} is never sent{what}"))
        }
    }
}

// ---- Flydigi (src/lib/controllers/flydigi.ts `checkFlydigiOutput`, which this mirrors)

const FD_OUT: u8 = 0x05;
const FD_LEN: usize = 63;
const FD_PARCELS: u8 = 79;
const FD_SLOTS: u8 = 4;

/// Key-table targets the firmware uses: keys 0-31, macro 0x20, stick directions, sticks / wheel, keyboard, identity.
fn fd_known_target(t: u8) -> bool {
    t <= 0x20 || (0xa0..=0xa8).contains(&t) || (0xf0..=0xf2).contains(&t) || t == 0xfe || t == 0xff
}

/// Why the 10 bytes of config parcel `index` aren't a config SYNQ writes (fields inside the parcel only), or None.
fn fd_parcel_problem(index: usize, data: &[u8]) -> Option<&'static str> {
    let offset = index * 10;
    let has = |at: usize, n: usize| at >= offset && at + n <= offset + data.len();
    let b = |at: usize| data[at - offset];
    for i in 0..32 {
        let at = 13 + i * 3;
        if has(at, 1) && !fd_known_target(b(at)) {
            return Some("a key mapping SYNQ doesn't know");
        }
        if has(at + 1, 1) && b(at + 1) > 2 {
            return Some("a turbo mode SYNQ doesn't know");
        }
    }
    for at in [109, 116] {
        if has(at, 1) && b(at) > 3 {
            return Some("a stick curve SYNQ doesn't know");
        }
        if has(at + 1, 1) && b(at + 1) > 127 {
            return Some("a stick dead zone over 127");
        }
    }
    if has(145, 1) && b(145) > 1 {
        return Some("the vibration switch");
    }
    None
}

/// An output report to a Flydigi pad in D-input mode.
fn flydigi_output(report_id: u8, d: &[u8]) -> Verdict {
    let no = |why: String| -> Verdict { Err(format!("Flydigi: {why}.")) };
    if report_id != FD_OUT {
        return no(format!("output report {report_id:#04x} isn't the config channel's"));
    }
    if d.len() != FD_LEN {
        return no("config reports are 64 bytes".into());
    }
    let rest = |from: usize| zero(&d[from..]);
    let sum = |bytes: &[u8]| bytes.iter().fold(0u8, |a, &b| a.wrapping_add(b));
    match d[0] {
        0xec | 0x11 => {
            if rest(1) {
                Ok("Flydigi info")
            } else {
                no("info queries carry no data".into())
            }
        }
        0xeb => {
            if d[1] < FD_SLOTS && rest(2) {
                Ok("Flydigi config read")
            } else {
                no("a read of slot 0-3".into())
            }
        }
        0xea => {
            if d[1] == FD_PARCELS && d[2] == 0xa0 && d[3] < FD_SLOTS && rest(4) {
                Ok("Flydigi config write")
            } else {
                no("the config write header (79 parcels, slot 0-3)".into())
            }
        }
        0x22 => {
            if d[11] != 0xa0 || d[12] >= FD_PARCELS || !rest(13) {
                return no("a config parcel (0-78)".into());
            }
            match fd_parcel_problem(usize::from(d[12]), &d[1..11]) {
                Some(why) => no(why.into()),
                None => Ok("Flydigi config parcel"),
            }
        }
        0x50 => {
            if d[1] == 0x02 && d[2] < FD_SLOTS && d[3] == sum(&[FD_OUT, 0x50, 0x02, d[2]]) && rest(4) {
                return Ok("Flydigi random id");
            }
            if d[1] == 0x03 && d[4] == sum(&[FD_OUT, 0x50, 0x03, d[2], d[3]]) && rest(5) {
                return Ok("Flydigi save to flash");
            }
            no(format!("sub-command {:#04x} isn't sent", d[1]))
        }
        0x0f => {
            if rest(3) {
                Ok("Flydigi motor test")
            } else {
                no("the motor test".into())
            }
        }
        cmd => {
            let what = match cmd {
                0xed => " (the switch to XInput: it re-enumerates)",
                0x17 => " (update mode)",
                _ => "",
            };
            no(format!("command {cmd:#04x} is never sent{what}"))
        }
    }
}

// ---- SCUF Envision (src/lib/controllers/scuf.ts `checkScufOutput`, which this mirrors)

const SCUF_LEN: usize = 64;
/// Battery level and status, USB vid / pid, firmware, the connected-pad bitmap.
const SCUF_READS: [u16; 6] = [0x0f, 0x10, 0x11, 0x12, 0x13, 0x36];

/// An output report to a SCUF Envision: a BRAGI 1.0 GET of one of `SCUF_READS`, at any device address. Nothing else.
fn scuf_output(report_id: u8, d: &[u8]) -> Verdict {
    let no = |why: String| -> Verdict { Err(format!("SCUF Envision: {why}.")) };
    if report_id != 0 {
        return no(format!("report {report_id:#04x} isn't its BRAGI channel's"));
    }
    if d.len() != SCUF_LEN {
        return no(format!("BRAGI frames are {SCUF_LEN} bytes"));
    }
    if d[0] & 0xf8 != 0x08 {
        return no("only BRAGI 1.0 frames (08..0F) are sent".into());
    }
    if d[1] != 0x02 {
        return no(format!("command {:#04x} isn't sent: SYNQ only reads this pad", d[1]));
    }
    let prop = u16::from_le_bytes([d[2], d[3]]);
    if !SCUF_READS.contains(&prop) {
        return no(format!("property {prop:#x} isn't read"));
    }
    if !zero(&d[4..]) {
        return no("a GET carries nothing after the property".into());
    }
    Ok("SCUF BRAGI read")
}

// ---- GameSir (src/lib/controllers/gamesir.ts `checkGamesirOutput`, which this mirrors)

const GAMESIR_OUT: u8 = 0x0f;
const GAMESIR_LEN: usize = 63;
const GAMESIR_LIGHT_BANK: u8 = 0x20;
const GAMESIR_WRITE_MAX: usize = 48;
const GAMESIR_READ_MAX: usize = 56;

/// Why these bytes may not go into this field (at `offset` inside it), or None.
fn gamesir_field_problem(m: &GamesirMap, kind: &str, field: &str, offset: usize, b: &[u8]) -> Option<String> {
    match kind {
        "percent" => (!b.iter().all(|&v| v <= 100)).then(|| format!("{field}: 0 to 100")),
        "permille16" => {
            if offset % 2 != 0 || b.len() % 2 != 0 {
                return Some(format!("{field}: whole 16-bit values"));
            }
            b.chunks(2).any(|c| u16::from_be_bytes([c[0], c[1]]) > 1000).then(|| format!("{field}: 0 to 1000"))
        }
        "traj" => (!b.iter().all(|&v| v <= 1)).then(|| format!("{field}: circle or raw")),
        "poll" => (b[0] >= m.poll_rates).then(|| format!("report rate code {}", b[0])),
        "remap" => {
            if offset != 0 || b.len() != 2 {
                return Some(format!("{field}: the whole record"));
            }
            let ok = b == [0, 0] || (b[0] == 1 && GAMESIR_TARGETS.contains(&b[1]));
            (!ok).then(|| format!("{field}: a gamepad button"))
        }
        "curve" => (!(offset == 0 && GAMESIR_CURVES.iter().any(|c| c[..] == *b))).then(|| format!("{field}: one of the presets, whole")),
        "lightSlot" => (b[0] > 3).then(|| "lighting effect 1 to 4".to_string()),
        "lightMode" => (!GAMESIR_LIGHT_MODES.contains(&b[0])).then(|| "lighting mode".to_string()),
        other => Some(format!("{field}: unknown kind {other}")),
    }
}

/// An output report to a GameSir pad: its config channel's queries, profile switch, rumble test, reads inside the
/// profile and lighting banks, and writes into the fields of its map with allowed values. Nothing else.
fn gamesir_output(map: u8, report_id: u8, d: &[u8]) -> Verdict {
    let m = &GAMESIR_MAPS[map as usize];
    let no = |why: String| -> Verdict { Err(format!("GameSir: {why}.")) };
    if report_id != GAMESIR_OUT {
        return no(format!("output report {report_id:#04x} isn't the config channel's"));
    }
    if d.len() != GAMESIR_LEN {
        return no("config reports are 64 bytes".into());
    }
    let rest = |from: usize| d[from..].iter().all(|&b| b == 0);
    let bank_size = |bank: u8| -> usize {
        if (1..=4).contains(&bank) {
            m.profile_size as usize
        } else if bank == GAMESIR_LIGHT_BANK {
            m.light_size as usize
        } else {
            0
        }
    };
    let (bank, addr, len) = (d[1], u16::from_be_bytes([d[2], d[3]]) as usize, d[4] as usize);
    match d[0] {
        0xf2 | 0x09 | 0x0b => {
            if rest(1) {
                Ok("GameSir query")
            } else {
                no("queries carry no data".into())
            }
        }
        0x07 => {
            if (1..=4).contains(&d[1]) && rest(2) {
                Ok("GameSir profile switch")
            } else {
                no("profiles 1 to 4".into())
            }
        }
        0x20 => {
            if !m.vibration {
                return no(format!("{}: no rumble is sent (its motors aren't mapped)", m.name));
            }
            if d[1] == 0x66 && d[2] == 0x55 && d[3] <= 100 && d[4] <= 100 && rest(5) {
                Ok("GameSir rumble test")
            } else {
                no("the rumble test frame".into())
            }
        }
        0x04 => {
            if bank_size(bank) == 0 {
                return no(format!("bank {bank:#x} isn't read"));
            }
            if len < 1 || len > GAMESIR_READ_MAX || addr + len > bank_size(bank) || !rest(5) {
                return no("a read inside the bank, 1 to 56 bytes".into());
            }
            Ok("GameSir register read")
        }
        0x03 => {
            if len < 1 || len > GAMESIR_WRITE_MAX || !rest(5 + len) {
                return no("a write of 1 to 48 bytes".into());
            }
            if (addr & 0xff) + len > 0x100 {
                return no("a write crosses a register page".into());
            }
            let place = if (1..=4).contains(&bank) {
                0
            } else if bank == GAMESIR_LIGHT_BANK && m.light_size > 0 {
                1
            } else {
                return no(format!("bank {bank:#x} isn't written"));
            };
            let Some(&(_, at, _, kind, field)) = m.fields.iter().find(|&&(b, at, flen, _, _)| b == place && addr >= at as usize && addr + len <= at as usize + flen as usize) else {
                return no(format!("{addr:#x}+{len} isn't a field SYNQ writes"));
            };
            match gamesir_field_problem(m, GAMESIR_FIELD_KINDS[kind as usize], field, addr - at as usize, &d[5..5 + len]) {
                Some(why) => no(why),
                None => Ok(field),
            }
        }
        cmd => {
            let what = match cmd {
                0x17 => " (the firmware loader: it reboots the pad into its bootloader)",
                0x16 => " (macro recording)",
                0x0d => " (LED keyframe playback)",
                _ => "",
            };
            no(format!("command {cmd:#04x}{what} is never sent"))
        }
    }
}

/// An output report to a pad: allowed only as one of the exact C1 frames.
pub fn check_output(g: Guard, report_id: u8, data: &[u8]) -> Verdict {
    match g {
        Guard::Ds5 | Guard::Edge => ds5_output(report_id, data),
        Guard::Ds4 => ds4_output(report_id, data),
        Guard::Switch => switch_output(report_id, data),
        Guard::Gamesir(m) => gamesir_output(m, report_id, data),
        Guard::Scuf => scuf_output(report_id, data),
        Guard::EightBitDo => ebd_output(report_id, data),
        Guard::Flydigi => flydigi_output(report_id, data),
        Guard::Input => Err(format!("{} is read only: SYNQ sends it nothing.", name(g))),
    }
}

/// A feature report read: Sony's calibration and firmware reports only (never the ones holding Bluetooth addresses).
pub fn check_feature_get(g: Guard, report_id: u8) -> Verdict {
    match (g, report_id) {
        (Guard::Edge, 0x70..=0x7b) => Ok("DualSense Edge profile read"),
        (Guard::Ds5 | Guard::Edge, 0x05) => Ok("DualSense calibration read"),
        (Guard::Ds5 | Guard::Edge, 0x20) => Ok("DualSense firmware read"),
        (Guard::Ds5 | Guard::Edge, id) => Err(format!("DualSense: feature {id:#04x} isn't read{}.", if id == 0x09 { " (it holds the Bluetooth addresses)" } else { "" })),
        (Guard::Ds4, 0x02 | 0x05) => Ok("DualShock 4 calibration read"),
        (Guard::Ds4, 0xa3) => Ok("DualShock 4 firmware read"),
        (Guard::Ds4, id) => Err(format!("DualShock 4: feature {id:#04x} isn't read{}.", if id == 0x12 { " (it holds the Bluetooth addresses)" } else { "" })),
        (g, _) => Err(format!("{}: no feature report is read.", name(g))),
    }
}

/// A feature report write: only the DualSense Edge's custom profile slots and their deletes (src/lib/controllers/edge.ts
/// `edgeFeatureSetProblem`, which this mirrors); never 0x63, the default profile; nothing on any other pad.
pub fn check_feature_set(g: Guard, report_id: u8, data: &[u8]) -> Result<(), String> {
    if g == Guard::Edge {
        return edge_feature_set(report_id, data).map_err(|why| format!("DualSense Edge: {why}."));
    }
    Err(format!("{}: feature report {report_id:#04x} would change the pad; SYNQ sets no feature reports on controllers.", name(g)))
}

const EDGE_PART: usize = 64;
const EDGE_WRITES: [u8; 3] = [0x60, 0x61, 0x62];
const EDGE_DELETE: u8 = 0x68;

/// CRC32 of the seed 0xA3 and the whole 64-byte part with its CRC bytes (60..64) at zero.
pub fn edge_part_crc(part: &[u8]) -> u32 {
    let mut copy = part[..EDGE_PART].to_vec();
    copy[60..].fill(0);
    crc32(&copy, crc32(&[0xa3], 0))
}

fn edge_button(v: u8) -> bool {
    v <= 0x11
}

fn edge_feature_set(report_id: u8, data: &[u8]) -> Result<(), String> {
    if report_id == 0x63 {
        return Err("the default profile (Triangle) is never written".into());
    }
    if report_id == EDGE_DELETE {
        if data.len() != EDGE_PART - 1 {
            return Err("a delete is one 64-byte report".into());
        }
        if !(2..=4).contains(&data[0]) {
            return Err(if data[0] == 1 { "the default profile can't be deleted".into() } else { "a delete names slot 2, 3 or 4".into() });
        }
        return if zero(&data[1..]) { Ok(()) } else { Err("a delete carries nothing but the slot".into()) };
    }
    if !EDGE_WRITES.contains(&report_id) {
        return Err(format!("feature {report_id:#x} isn't an Edge profile write"));
    }
    if data.len() != EDGE_PART - 1 {
        return Err("a profile part is 64 bytes".into());
    }
    let mut part = vec![report_id];
    part.extend_from_slice(data);
    let index = part[1];
    if index > 2 {
        return Err("a profile has three parts".into());
    }
    if le32(&part, 60) != edge_part_crc(&part) {
        return Err("the part's CRC doesn't match".into());
    }
    let odd = |from: usize, to: usize| (from + 1..to).step_by(2).any(|i| part[i] != 0);
    let text = |from: usize, to: usize| (from..to).step_by(2).any(|i| part[i] != 0 && !(0x20..=0x7e).contains(&part[i]));
    match index {
        0 => {
            if part[2] != 1 {
                return Err("part 1 marks the slot as used".into());
            }
            if odd(6, 60) || text(6, 60) {
                return Err("the name is plain text".into());
            }
        }
        1 => {
            if odd(2, 27) || text(2, 27) {
                return Err("the name is plain text".into());
            }
            if ![0x03, 0x04].contains(&part[44]) || ![0x03, 0x04].contains(&part[53]) {
                return Err("stick curve modifier".into());
            }
        }
        _ => {
            if part[30] > 5 || part[32] > 5 {
                return Err("stick curve preset".into());
            }
            if part[4] >= part[5] || part[6] >= part[7] {
                return Err("a trigger range has to start below its end".into());
            }
            if !part[10..26].iter().all(|&v| edge_button(v)) {
                return Err("a button map entry isn't an Edge button".into());
            }
        }
    }
    Ok(())
}

/// The feature buffer for a pad's reads (the largest: DualSense firmware info, 64 bytes with the id).
pub const FEATURE_BUFFER: usize = 65;

/// The reports that stop a pad's rumble (the same frames frames.ts builds for "stop"), sent before the bridge closes
/// a pad the page left open when the window lost focus. Nothing for a read-only pad.
pub fn stop_frames(g: Guard, bluetooth: bool) -> Vec<(u8, Vec<u8>)> {
    match (g, bluetooth) {
        (Guard::Ds5 | Guard::Edge, false) => {
            let mut d = vec![0u8; DS5_COMMON];
            d[0] = 0x03;
            vec![(DS5_USB_OUTPUT, d)]
        }
        (Guard::Ds5 | Guard::Edge, true) => {
            let mut d = vec![0u8; DS5_BT_LEN];
            d[1] = 0x10;
            d[2] = 0x03;
            let crc = sony_bt_crc(DS5_BT_OUTPUT, &d[..DS5_BT_LEN - 4]);
            d[DS5_BT_LEN - 4..].copy_from_slice(&crc.to_le_bytes());
            vec![(DS5_BT_OUTPUT, d)]
        }
        (Guard::Ds4, false) => {
            let mut d = vec![0u8; 31];
            d[0] = 0x01;
            vec![(0x05, d)]
        }
        (Guard::Ds4, true) => {
            let mut d = vec![0u8; 77];
            d[0] = 0xc0;
            d[2] = 0x01;
            let crc = sony_bt_crc(0x11, &d[..73]);
            d[73..].copy_from_slice(&crc.to_le_bytes());
            vec![(0x11, d)]
        }
        (Guard::Switch, _) => {
            let mut d = vec![0u8; SWITCH_BT_LEN];
            d[1..9].copy_from_slice(&SWITCH_STOP);
            vec![(0x10, d)]
        }
        (Guard::Gamesir(m), _) if GAMESIR_MAPS[m as usize].vibration => {
            let mut d = vec![0u8; GAMESIR_LEN];
            d[..3].copy_from_slice(&[0x20, 0x66, 0x55]);
            vec![(GAMESIR_OUT, d)]
        }
        (Guard::Gamesir(_) | Guard::Scuf, _) => Vec::new(),
        (Guard::Flydigi, _) => {
            // The motor test's stop.
            let mut d = vec![0u8; FD_LEN];
            d[0] = 0x0f;
            vec![(FD_OUT, d)]
        }
        (Guard::EightBitDo, _) => {
            // A zero-length vibration test: ends one that is still running (it stops by itself within a second anyway).
            let mut d = vec![0u8; EBD_LEN];
            d[..6].copy_from_slice(&[0x11, 0x04, 0x08, 0x00, 0x01, 0x00]);
            vec![(EBD_OUT, d)]
        }
        (Guard::Input, _) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(hex: &str) -> Vec<u8> {
        (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
    }

    /// `<length>:<data with trailing zeros dropped>`.
    fn frame(spec: &str) -> Vec<u8> {
        let (len, hex) = spec.split_once(':').unwrap();
        let mut d = bytes(hex);
        d.resize(len.parse().unwrap(), 0);
        d
    }

    fn guard_of(name: &str) -> Guard {
        match name {
            "ds5" => Guard::Ds5,
            "edge" => Guard::Edge,
            "ds4" => Guard::Ds4,
            "switch" => Guard::Switch,
            "gamesir-cyclone2" => Guard::Gamesir(0),
            "gamesir-g7pro8k" => Guard::Gamesir(1),
            "gamesir-tarantula" => Guard::Gamesir(2),
            "scuf" => Guard::Scuf,
            "8bitdo" => Guard::EightBitDo,
            "flydigi" => Guard::Flydigi,
            "input" => Guard::Input,
            other => panic!("unknown guard {other}"),
        }
    }

    /// The same verdicts as src/lib/controllers/guard.ts on every frame of the fixture.
    #[test]
    fn pad_guard_matches_the_frontend() {
        let mut checked = 0;
        let mut allowed = 0;
        for line in include_str!("pad-frames.txt").lines().filter(|l| !l.is_empty()) {
            let parts: Vec<&str> = line.split(' ').collect();
            let (g, op, verdict, data) = (guard_of(parts[0]), parts[1], parts[2] == "1", parts[3]);
            let (kind, id) = op.split_once(':').unwrap();
            let id = u8::from_str_radix(id, 16).unwrap();
            let got = match kind {
                "out" => check_output(g, id, &frame(data)).is_ok(),
                "get" => check_feature_get(g, id).is_ok(),
                "set" => check_feature_set(g, id, &frame(data)).is_ok(),
                other => panic!("unknown op {other}"),
            };
            assert_eq!(got, verdict, "{line}");
            checked += 1;
            allowed += usize::from(verdict);
        }
        assert!(checked > 5000 && allowed > 150, "{checked} lines, {allowed} allowed");
    }

    fn switch_sub(sub: u8, args: &[u8]) -> Vec<u8> {
        let mut d = vec![0u8; SWITCH_USB_LEN];
        d[0] = 1;
        d[1..9].copy_from_slice(&SWITCH_STOP);
        d[9] = sub;
        d[10..10 + args.len()].copy_from_slice(args);
        d
    }

    /// The refusals the brief names, asserted directly (not only through the fixture).
    #[test]
    fn dangerous_switch_commands_are_refused() {
        for sub in [0x11, 0x12, 0x07, 0x08, 0x06, 0x01, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b] {
            assert!(check_output(Guard::Switch, 0x01, &switch_sub(sub, &[0x00, 0x60, 0, 0, 0x10])).is_err(), "subcommand {sub:#04x}");
        }
        for arg in (0u8..=255).filter(|&a| a != 0x30 && a != 0x3f) {
            assert!(check_output(Guard::Switch, 0x01, &switch_sub(0x03, &[arg])).is_err(), "input mode {arg:#04x}");
        }
        assert!(check_output(Guard::Switch, 0x01, &switch_sub(0x03, &[0x30])).is_ok());
        assert!(check_output(Guard::Switch, 0x01, &switch_sub(0x03, &[0x3f])).is_ok());
        let mut usb = vec![0u8; SWITCH_USB_LEN];
        for cmd in 0u8..=255 {
            usb[0] = cmd;
            assert_eq!(check_output(Guard::Switch, 0x80, &usb).is_ok(), (1..=5).contains(&cmd), "0x80 {cmd:#04x}");
        }
        // SPI: inside the calibration ranges only.
        assert!(check_output(Guard::Switch, 0x01, &switch_sub(0x10, &[0x3d, 0x60, 0, 0, 0x12])).is_ok());
        assert!(check_output(Guard::Switch, 0x01, &switch_sub(0x10, &[0x3d, 0x60, 0, 0, 0x13])).is_err(), "runs past the factory stick block");
        assert!(check_output(Guard::Switch, 0x01, &switch_sub(0x10, &[0x50, 0x60, 0, 0, 0x0c])).is_err(), "colours aren't calibration");
        assert!(check_output(Guard::Switch, 0x01, &switch_sub(0x10, &[0x00, 0x00, 0, 0, 0x10])).is_err());
    }

    #[test]
    fn sony_pairing_reads_and_every_feature_write_are_refused() {
        for g in [Guard::Ds5, Guard::Ds4, Guard::Switch, Guard::Input] {
            for id in 0u8..=255 {
                assert!(check_feature_set(g, id, &[0; 63]).is_err(), "{g:?} set {id:#04x}");
            }
        }
        assert!(check_feature_get(Guard::Ds5, 0x09).is_err());
        assert!(check_feature_get(Guard::Ds4, 0x12).is_err());
        assert!(check_feature_get(Guard::Ds5, 0x05).is_ok() && check_feature_get(Guard::Ds5, 0x20).is_ok());
        assert!(check_feature_get(Guard::Ds4, 0x02).is_ok() && check_feature_get(Guard::Ds4, 0x05).is_ok() && check_feature_get(Guard::Ds4, 0xa3).is_ok());
        for id in 0u8..=255 {
            assert!(check_feature_get(Guard::Switch, id).is_err() && check_feature_get(Guard::Input, id).is_err());
        }
    }

    #[test]
    fn the_stop_frames_pass_the_guard() {
        for g in [Guard::Ds5, Guard::Ds4, Guard::Switch] {
            for bt in [false, true] {
                let frames = stop_frames(g, bt);
                assert_eq!(frames.len(), 1, "{g:?} bt {bt}");
                for (id, d) in frames {
                    assert!(check_output(g, id, &d).is_ok(), "{g:?} bt {bt}: {:?}", check_output(g, id, &d));
                }
            }
        }
        assert!(stop_frames(Guard::Input, false).is_empty());
        for m in 0..GAMESIR_MAPS.len() as u8 {
            let frames = stop_frames(Guard::Gamesir(m), false);
            assert_eq!(frames.len(), usize::from(GAMESIR_MAPS[m as usize].vibration));
            for (id, d) in frames {
                assert!(check_output(Guard::Gamesir(m), id, &d).is_ok());
            }
        }
    }

    fn gamesir(cmd: &[u8]) -> Vec<u8> {
        let mut d = vec![0u8; GAMESIR_LEN];
        d[..cmd.len()].copy_from_slice(cmd);
        d
    }

    #[test]
    fn gamesir_writes_stay_inside_the_map() {
        let cyclone = Guard::Gamesir(0);
        let g8k = Guard::Gamesir(1);
        let tarantula = Guard::Gamesir(2);
        // The firmware loader, macro recording, LED playback and every unknown command: never.
        for cmd in [0x17u8, 0x16, 0x0d, 0x01, 0x02, 0x08, 0x0a, 0x0e, 0x0f, 0x21, 0xff] {
            for g in [cyclone, g8k, tarantula] {
                assert!(check_output(g, GAMESIR_OUT, &gamesir(&[cmd, 0x55, 0x88])).is_err(), "{g:?} {cmd:#04x}");
            }
        }
        // Queries, profile switch 1-4, reads inside the banks.
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&[0x09])).is_ok());
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&[0x07, 4])).is_ok());
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&[0x07, 5])).is_err(), "bank 5 (the Shift layer) isn't selected");
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&[0x04, 1, 0x02, 0x70, 56])).is_ok());
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&[0x04, 1, 0x02, 0x71, 56])).is_err(), "past the profile");
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&[0x04, 5, 0, 0, 8])).is_err(), "bank 5");
        assert!(check_output(tarantula, GAMESIR_OUT, &gamesir(&[0x04, 0x20, 0, 0, 8])).is_err(), "no lighting map");
        // Writes: vibration 0-100, report-rate codes per model, remaps to gamepad buttons, curves whole.
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&[0x03, 1, 0x00, 0x20, 2, 75, 75])).is_ok());
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&[0x03, 1, 0x00, 0x20, 2, 75, 101])).is_err());
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&[0x03, 1, 0x00, 0x2e, 1, 3])).is_err(), "the Cyclone tops out at 1000 Hz");
        assert!(check_output(g8k, GAMESIR_OUT, &gamesir(&[0x03, 1, 0x00, 0x2e, 1, 5])).is_ok(), "8000 Hz on the 8K");
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&[0x03, 1, 0x00, 0x7a, 2, 1, 0x0a])).is_ok(), "A -> B");
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&[0x03, 1, 0x00, 0x7a, 2, 2, 0x04])).is_err(), "a keyboard key");
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&[0x03, 1, 0x00, 0x7a, 1, 1])).is_err(), "half a record");
        let mut curve = vec![0x03, 1, 0x02, 0x2e, 10];
        curve.extend_from_slice(&GAMESIR_CURVES[1]);
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&curve)).is_ok());
        curve[9] ^= 1;
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&curve)).is_err(), "not a preset");
        // The 8K's 16-bit dead zones: 0-1000, whole values.
        assert!(check_output(g8k, GAMESIR_OUT, &gamesir(&[0x03, 1, 0x03, 0x97, 2, 0x03, 0xe8])).is_ok());
        assert!(check_output(g8k, GAMESIR_OUT, &gamesir(&[0x03, 1, 0x03, 0x97, 2, 0x03, 0xe9])).is_err());
        assert!(check_output(g8k, GAMESIR_OUT, &gamesir(&[0x03, 1, 0x03, 0x98, 1, 0x10])).is_err(), "half a value");
        // Outside every field, the bootloader-adjacent banks, a page crossing, trailing bytes.
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&[0x03, 1, 0x00, 0x00, 1, 0])).is_err());
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&[0x03, 5, 0x00, 0x20, 1, 50])).is_err());
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&[0x03, 1, 0x00, 0x20, 1, 50, 9])).is_err());
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&[0x03, 1, 0x00, 0xff, 2, 0, 0])).is_err());
        // Rumble: the test frame only, and not on the Tarantula.
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&[0x20, 0x66, 0x55, 100, 100])).is_ok());
        assert!(check_output(cyclone, GAMESIR_OUT, &gamesir(&[0x20, 0x66, 0x55, 101, 0])).is_err());
        assert!(check_output(tarantula, GAMESIR_OUT, &gamesir(&[0x20, 0x66, 0x55, 0, 0])).is_err());
        // Other report ids and lengths.
        assert!(check_output(cyclone, 0x10, &gamesir(&[0x09])).is_err());
        assert!(check_output(cyclone, GAMESIR_OUT, &[0x09]).is_err());
        // No feature reports either way.
        assert!(check_feature_get(cyclone, 0x0f).is_err() && check_feature_set(cyclone, 0x0f, &[0; 63]).is_err());
    }

    #[test]
    fn the_8bitdo_config_channel_takes_its_commands_only() {
        let g = Guard::EightBitDo;
        let simple = |cmd: u16, sub: u16, extra: &[u8]| {
            let mut d = vec![0u8; EBD_LEN];
            d[..6].copy_from_slice(&[0x11, 0x04, cmd as u8, (cmd >> 8) as u8, sub as u8, (sub >> 8) as u8]);
            d[6..6 + extra.len()].copy_from_slice(extra);
            d
        };
        assert!(check_output(g, EBD_OUT, &simple(7, 0, &[])).is_ok() && check_output(g, EBD_OUT, &simple(6, 0x15, &[])).is_ok());
        assert!(check_output(g, EBD_OUT, &simple(8, 600, &[200, 200])).is_ok());
        assert!(check_output(g, EBD_OUT, &simple(8, 1001, &[200, 200])).is_err(), "longer than a second");
        for cmd in [0x0bu16, 0x0c, 0x0d, 3, 4, 5, 9, 0x10, 0xff] {
            assert!(check_output(g, EBD_OUT, &simple(cmd, 0, &[])).is_err(), "command {cmd}");
        }
        // Calibration (direct 0x36 / 0x38) and every direct command but the version read.
        for (len, lo, args) in [(3u8, 0x36u8, vec![]), (4, 0x36, vec![1u8]), (4, 0x38, vec![1]), (5, 0x21, vec![1, 0])] {
            let mut d = vec![0u8; EBD_LEN];
            d[..4].copy_from_slice(&[len, 0x00, lo, args.first().copied().unwrap_or(0)]);
            if args.len() > 1 {
                d[4] = args[1];
            }
            assert_eq!(check_output(g, EBD_OUT, &d).is_ok(), lo == 0x21, "direct {lo:#04x}");
        }
        // A read chunk, a write chunk with its CRC, a bad CRC, a write of an unknown button bit.
        let mut read = simple(2, 0, &[]);
        read[6..8].copy_from_slice(&45u16.to_le_bytes());
        read[10..14].copy_from_slice(&1652u32.to_le_bytes());
        read[14..18].copy_from_slice(&90u32.to_le_bytes());
        assert!(check_output(g, EBD_OUT, &read).is_ok());
        read[14..18].copy_from_slice(&91u32.to_le_bytes());
        assert!(check_output(g, EBD_OUT, &read).is_err(), "off the chunk grid");
        let write = |offset: u32, payload: &[u8]| {
            let mut d = vec![0u8; EBD_LEN];
            d[0] = 17 + payload.len() as u8;
            d[1..6].copy_from_slice(&[0x04, 0x01, 0x00, 0x00, 0x00]);
            d[6..8].copy_from_slice(&(payload.len() as u16).to_le_bytes());
            d[8..10].copy_from_slice(&crc16_kermit(payload).to_le_bytes());
            d[10..14].copy_from_slice(&1652u32.to_le_bytes());
            d[14..18].copy_from_slice(&offset.to_le_bytes());
            d[18..18 + payload.len()].copy_from_slice(payload);
            d
        };
        // Offset 225 holds key words of profile 1 (0x0E0 = 224): bytes 225.. are the tail of the flag, then keys.
        let mut keys = vec![0u8; 45];
        keys[3..7].copy_from_slice(&0x2000u32.to_le_bytes());
        assert!(check_output(g, EBD_OUT, &write(225, &keys)).is_ok());
        keys[3..7].copy_from_slice(&0x0800_0000u32.to_le_bytes());
        assert!(check_output(g, EBD_OUT, &write(225, &keys)).is_err(), "an unknown button bit");
        let mut bad = write(225, &[0u8; 45]);
        bad[8] ^= 1;
        assert!(check_output(g, EBD_OUT, &bad).is_err(), "a bad chunk CRC");
        assert_eq!(crc16_kermit(b"123456789"), 0x6f91);
        assert!(check_feature_get(g, 0x81).is_err() && check_feature_set(g, 0x81, &[0; 63]).is_err());
        for (id, d) in stop_frames(g, false) {
            assert!(check_output(g, id, &d).is_ok());
        }
        // Read-only 8BitDo ids: the adapters, the Ultimate 2 and the Pro 2 / Pro 3 send nothing.
        for pid in [0x3100u16, 0x3105, 0x6012, 0x6013, 0x6003, 0x6009] {
            assert_eq!(guard(0x2dc8, pid), Some(Guard::Input), "{pid:04x}");
        }
        assert_eq!(access(0x2dc8, 0x6007, 0x0001, 0x0005), Some(Access::Full));
    }

    #[test]
    fn the_flydigi_config_channel_takes_its_commands_only() {
        let g = Guard::Flydigi;
        let f = |bytes: &[u8]| {
            let mut d = vec![0u8; FD_LEN];
            d[..bytes.len()].copy_from_slice(bytes);
            d
        };
        for ok in [f(&[0xec]), f(&[0xeb, 3]), f(&[0xea, 79, 0xa0, 2]), f(&[0x0f, 200, 200]), f(&[0x50, 0x02, 1, 0x58]), f(&[0x50, 0x03, 0x12, 0x35, 0x9f])] {
            assert!(check_output(g, FD_OUT, &ok).is_ok(), "{:02x?}", &ok[..6]);
        }
        // The XInput switch, update mode, LED and screen writes, ForceAdapt, mapping enable, a slot past 3, a bad sum.
        for bad in [f(&[0xed]), f(&[0x17]), f(&[0xe7, 0, 50]), f(&[0x33]), f(&[0xd0]), f(&[0xa0, 1]), f(&[0xee, 1]), f(&[0xf2, 2, 5]), f(&[0xeb, 4]), f(&[0xea, 79, 0xa0, 4]), f(&[0x50, 0x02, 1, 0x59]), f(&[0x50, 0x05, 1])] {
            assert!(check_output(g, FD_OUT, &bad).is_err(), "{:02x?}", &bad[..4]);
        }
        // Parcels: a key table with known targets passes, an unknown one doesn't; a stick dead zone over 127 doesn't.
        let parcel = |idx: u8, data: [u8; 10]| {
            let mut d = vec![0u8; FD_LEN];
            d[0] = 0x22;
            d[1..11].copy_from_slice(&data);
            d[11] = 0xa0;
            d[12] = idx;
            d
        };
        assert!(check_output(g, FD_OUT, &parcel(2, [0, 0, 0xff, 0, 0, 5, 0, 0, 0x20, 0])).is_ok());
        assert!(check_output(g, FD_OUT, &parcel(2, [0, 0, 0x50, 0, 0, 5, 0, 0, 0x20, 0])).is_err());
        assert!(check_output(g, FD_OUT, &parcel(11, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).is_ok());
        assert!(check_output(g, FD_OUT, &parcel(11, [0, 0, 0, 0, 0, 0, 0, 0xff, 0, 0])).is_err(), "byte 117: the right stick's dead zone");
        assert!(check_output(g, FD_OUT, &parcel(79, [0; 10])).is_err());
        assert!(check_feature_get(g, 5).is_err() && check_feature_set(g, 5, &[0; 63]).is_err());
        for (id, d) in stop_frames(g, false) {
            assert!(check_output(g, id, &d).is_ok());
        }
        assert_eq!(access(0x04b4, 0x2412, 0xffa0, 0x0001), Some(Access::Full));
        assert_eq!(access(0x04b4, 0x2412, 0x0001, 0x0005), Some(Access::InputOnly));
        assert_eq!(access(0x04b4, 0x2412, 0xffef, 0x0001), None, "its other vendor interface stays shut");
        // The 37D7 pads (Vader 5 Pro, Apex 5 / 6) are sent nothing.
        assert_eq!(guard(0x37d7, 0x2401), Some(Guard::Input));
    }

    #[test]
    fn the_scuf_envision_is_only_read() {
        let get = |addr: u8, prop: u16| {
            let mut d = vec![0u8; SCUF_LEN];
            d[..4].copy_from_slice(&[0x08 | addr, 0x02, prop as u8, (prop >> 8) as u8]);
            d
        };
        for prop in SCUF_READS {
            assert!(check_output(Guard::Scuf, 0, &get(0, prop)).is_ok() && check_output(Guard::Scuf, 0, &get(1, prop)).is_ok(), "{prop:#x}");
        }
        // Every other command: SET (operating mode, anything), calibration, files, factory reset, firmware, pairing, sessions.
        for cmd in [0x01u8, 0x03, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0f, 0x10, 0x11, 0x12, 0x16, 0x1b] {
            let mut d = get(0, 0x13);
            d[1] = cmd;
            assert!(check_output(Guard::Scuf, 0, &d).is_err(), "command {cmd:#04x}");
        }
        assert!(check_output(Guard::Scuf, 0, &get(0, 0x03)).is_err(), "operating mode isn't read either");
        let mut v15 = get(0, 0x13);
        v15[0] = 0x00;
        assert!(check_output(Guard::Scuf, 0, &v15).is_err(), "BRAGI 1.5 frames aren't sent");
        let mut tail = get(0, 0x13);
        tail[4] = 1;
        assert!(check_output(Guard::Scuf, 0, &tail).is_err());
        assert!(check_output(Guard::Scuf, 1, &get(0, 0x13)).is_err() && check_output(Guard::Scuf, 0, &get(0, 0x13)[..63]).is_err());
        assert!(check_feature_get(Guard::Scuf, 0).is_err() && check_feature_set(Guard::Scuf, 0, &[0; 64]).is_err());
        assert!(stop_frames(Guard::Scuf, false).is_empty());
        // Its BRAGI request collection opens in full; notifications, keyboard and mouse don't.
        assert_eq!(access(0x2e95, 0x434e, 0xff42, 0x0001), Some(Access::Full));
        assert_eq!(access(0x1b1c, 0x3a08, 0xff42, 0x0001), Some(Access::Full));
        assert_eq!(access(0x2e95, 0x434e, 0xff42, 0x0002), None);
        assert_eq!(access(0x2e95, 0x434e, 0x0001, 0x0006), None);
        assert_eq!(access(0x2e95, 0x434e, 0x0001, 0x0005), Some(Access::InputOnly));
        // Another pad's BRAGI-shaped collection is nothing.
        assert_eq!(access(0x054c, 0x0ce6, 0xff42, 0x0001), None);
    }

    #[test]
    fn gamesir_opens_its_vendor_collection_per_pid_only() {
        // Configurable ids: the vendor collection full, the gamepad collection input only, typing collections never.
        assert_eq!(access(0x3537, 0x1053, GAMESIR_PAGE, 0x0001), Some(Access::Full));
        assert_eq!(access(0x3537, 0x10c7, GAMESIR_PAGE, 0x0002), Some(Access::Full));
        assert_eq!(access(0x3537, 0x103d, GAMESIR_PAGE, 0x0001), Some(Access::Full));
        assert_eq!(access(0x3537, 0x1053, 0x0001, 0x0005), Some(Access::InputOnly));
        for (page, usage) in [(0x0001, 0x0002), (0x0001, 0x0006), (0x000c, 0x0001), (0xff00, 0x0001)] {
            assert_eq!(access(0x3537, 0x1053, page, usage), None, "{page:04x}:{usage:04x}");
        }
        // Read-only ids (shared or dead channel): the vendor collection stays shut.
        for pid in [0x0575u16, 0x103c, 0x10b8] {
            assert_eq!(guard(0x3537, pid), Some(Guard::Input), "{pid:04x}");
            assert_eq!(access(0x3537, pid, GAMESIR_PAGE, 0x0001), None, "{pid:04x}");
        }
        assert_eq!(guard(0x3537, 0x1053), Some(Guard::Gamesir(0)));
        assert_eq!(guard(0x3537, 0x10b9), Some(Guard::Gamesir(1)));
        assert_eq!(guard(0x3537, 0x103d), Some(Guard::Gamesir(2)));
        // Another vendor's 0xFFF0 collection is nothing to a pad rule.
        assert_eq!(access(0x054c, 0x0ce6, GAMESIR_PAGE, 0x0001), None);
    }

    #[test]
    fn the_crc_is_sonys() {
        // CRC-32 of "123456789" is CBF43926; the Bluetooth seed is the HID header 0xA2 then the report id.
        assert_eq!(crc32(b"123456789", 0), 0xcbf4_3926);
        assert_eq!(sony_bt_crc(0x31, &[]), crc32(&[0xa2, 0x31], 0));
    }

    #[test]
    fn only_a_pads_gamepad_collection_opens() {
        // DualSense: Gamepad, full (its outputs are checked above); nothing else on it.
        assert_eq!(access(0x054c, 0x0ce6, 0x0001, 0x0005), Some(Access::Full));
        for (page, usage) in [(0x0001, 0x0002), (0x0001, 0x0006), (0x0007, 0x0000), (0x000c, 0x0001), (0xff00, 0x0001), (0x0001, 0x0000)] {
            assert_eq!(access(0x054c, 0x0ce6, page, usage), None, "{page:04x}:{usage:04x}");
        }
        // Switch Pro: Joystick, full.
        assert_eq!(access(0x057e, 0x2009, 0x0001, 0x0004), Some(Access::Full));
        // Everyone else's gamepad: input only.
        assert_eq!(access(0x2dc8, 0x6012, 0x0001, 0x0005), Some(Access::InputOnly));
        // Valve: the vendor input collection too, input only; never their lizard-mode keyboard or mouse.
        assert_eq!(access(0x28de, 0x1102, 0xff00, 0x0001), Some(Access::InputOnly));
        assert_eq!(access(0x28de, 0x1102, 0x0001, 0x0006), None);
        assert_eq!(access(0x28de, 0x1102, 0x0001, 0x0002), None);
        // An XInput pad is never opened as HID (its IG_ shim stays shut): the G7 SE, an 8BitDo in XInput mode.
        assert_eq!(access(0x3537, 0x1010, 0x0001, 0x0005), None);
        assert_eq!(access(0x2dc8, 0x3106, 0x0001, 0x0005), None);
        assert!(!hid_pad(0x045e, 0x02ff), "Windows' GIP HID shim is not a pad");
        // Boot and recovery ids: nothing.
        for &(v, p) in PAD_BOOT.iter() {
            assert!(!hid_pad(v, p) && access(v, p, 0x0001, 0x0005).is_none(), "{v:04x}:{p:04x}");
        }
    }

    #[test]
    fn the_table_is_sorted_for_binary_search() {
        assert!(PADS.windows(2).all(|w| (w[0].0, w[0].1) < (w[1].0, w[1].1)));
        assert_eq!(kind(0x054c, 0x0ce6), Some("ps5"));
        assert_eq!(kind(0x3537, 0x1010), Some("xboxone"));
        assert_eq!(guard(0x054c, 0x0df2), Some(Guard::Edge));
        assert_eq!(guard(0x054c, 0x09cc), Some(Guard::Ds4));
        assert_eq!(guard(0x057e, 0x2009), Some(Guard::Switch));
        assert_eq!(guard(0x28de, 0x1102), Some(Guard::Input));
        assert_eq!(guard(0x3537, 0x1010), None, "XInput pads have no HID guard: nothing is ever sent as HID");
    }
}
