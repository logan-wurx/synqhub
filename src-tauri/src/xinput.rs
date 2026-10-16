//! XInput pads (Windows): the Xbox 360-class (xusb22) and Xbox One-class (xboxgip) controllers, which aren't
//! reachable as HID. Read only: `XInputGetState`, `XInputGetCapabilities` (and its extended form, which adds the
//! USB vendor and product id) and `XInputGetBatteryInformation`. Nothing is ever sent: no rumble, no LED.
//!
//! The tester's polling figure comes from a sampler thread that reads the state as fast as it can and stamps every
//! change of `dwPacketNumber` (CONTROLLERS.md §6.3: XInput counts changes, so the stick has to move: Gamepadla's
//! method). It runs only while the tester asks for it, at most `SAMPLE_MAX` at a time, and stops when the window
//! loses focus (`set_focused`), so nothing spins while a game runs.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Longest single sampling run.
pub const SAMPLE_MAX: Duration = Duration::from_secs(8);
/// How often the sampler hands its changes to the page.
const BATCH: Duration = Duration::from_millis(12);

#[repr(C)]
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
struct Gamepad {
    buttons: u16,
    left_trigger: u8,
    right_trigger: u8,
    thumb_lx: i16,
    thumb_ly: i16,
    thumb_rx: i16,
    thumb_ry: i16,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct State {
    packet: u32,
    gamepad: Gamepad,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Vibration {
    left: u16,
    right: u16,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Capabilities {
    kind: u8,
    sub_type: u8,
    flags: u16,
    gamepad: Gamepad,
    vibration: Vibration,
}

/// `XINPUT_CAPABILITIES_EX` (xinput1_4 ordinal 108, as SDL uses it): the capabilities plus the pad's USB ids.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CapabilitiesEx {
    caps: Capabilities,
    vendor_id: u16,
    product_id: u16,
    version: u16,
    unknown1: u16,
    unknown2: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Battery {
    kind: u8,
    level: u8,
}

type GetState = unsafe extern "system" fn(u32, *mut State) -> u32;
type GetCapabilities = unsafe extern "system" fn(u32, u32, *mut Capabilities) -> u32;
type GetCapabilitiesEx = unsafe extern "system" fn(u32, u32, u32, *mut CapabilitiesEx) -> u32;
type GetBattery = unsafe extern "system" fn(u32, u8, *mut Battery) -> u32;

struct Api {
    state: GetState,
    caps: GetCapabilities,
    caps_ex: Option<GetCapabilitiesEx>,
    battery: Option<GetBattery>,
}

#[cfg(windows)]
mod sys {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        pub fn LoadLibraryW(name: *const u16) -> isize;
        pub fn GetProcAddress(module: isize, name: *const u8) -> *const core::ffi::c_void;
    }
    #[link(name = "cfgmgr32")]
    unsafe extern "system" {
        pub fn CM_Get_Device_ID_List_SizeW(len: *mut u32, filter: *const u16, flags: u32) -> u32;
        pub fn CM_Get_Device_ID_ListW(filter: *const u16, buffer: *mut u16, len: u32, flags: u32) -> u32;
    }
    pub const CM_GETIDLIST_FILTER_ENUMERATOR: u32 = 0x0000_0001;
    pub const CM_GETIDLIST_FILTER_PRESENT: u32 = 0x0000_0100;
}


/// The USB vendor and product id in a device instance id ("USB\VID_3537&PID_1010\..." -> (0x3537, 0x1010)).
pub fn usb_ids(instance: &str) -> Option<(u16, u16)> {
    let upper = instance.to_ascii_uppercase();
    let hex = |tag: &str| -> Option<u16> {
        let at = upper.find(tag)? + tag.len();
        u16::from_str_radix(upper.get(at..at + 4)?, 16).ok()
    };
    Some((hex("VID_")?, hex("PID_")?))
}

/// The USB devices present right now that the controller table knows as XInput pads (Xbox 360 class or Xbox One
/// class), from Windows' device list. Nothing is opened: this is how an XInput slot that only reports Windows' own
/// ids gets a model (identify by query, not by guessing).
#[cfg(windows)]
pub fn usb_xinput_pads() -> Vec<(u16, u16)> {
    let filter: Vec<u16> = "USB".encode_utf16().chain(std::iter::once(0)).collect();
    let flags = sys::CM_GETIDLIST_FILTER_ENUMERATOR | sys::CM_GETIDLIST_FILTER_PRESENT;
    let mut len = 0u32;
    if unsafe { sys::CM_Get_Device_ID_List_SizeW(&mut len, filter.as_ptr(), flags) } != 0 || len == 0 {
        return Vec::new();
    }
    let mut buf = vec![0u16; len as usize];
    if unsafe { sys::CM_Get_Device_ID_ListW(filter.as_ptr(), buf.as_mut_ptr(), len, flags) } != 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for id in buf.split(|&c| c == 0).filter(|s| !s.is_empty()) {
        let Some(ids) = usb_ids(&String::from_utf16_lossy(id)) else { continue };
        let xinput = crate::pads::entry(ids.0, ids.1).is_some_and(|(_, t)| t != crate::controller_ids::HID);
        if xinput && !out.contains(&ids) {
            out.push(ids);
        }
    }
    out
}

#[cfg(not(windows))]
pub fn usb_xinput_pads() -> Vec<(u16, u16)> {
    Vec::new()
}

const ERROR_SUCCESS: u32 = 0;
const BATTERY_DEVTYPE_GAMEPAD: u8 = 0;

/// xinput1_4.dll (Windows 8 and later; the extended capabilities live there), else xinput9_1_0.dll.
#[cfg(windows)]
fn api() -> Option<&'static Api> {
    static API: std::sync::OnceLock<Option<Api>> = std::sync::OnceLock::new();
    API.get_or_init(|| unsafe {
        for dll in ["xinput1_4.dll", "xinput9_1_0.dll"] {
            let wide: Vec<u16> = dll.encode_utf16().chain(std::iter::once(0)).collect();
            let m = sys::LoadLibraryW(wide.as_ptr());
            if m == 0 {
                continue;
            }
            let state = sys::GetProcAddress(m, c"XInputGetState".as_ptr().cast());
            let caps = sys::GetProcAddress(m, c"XInputGetCapabilities".as_ptr().cast());
            if state.is_null() || caps.is_null() {
                continue;
            }
            // Ordinal 108: XInputGetCapabilitiesEx (an ordinal goes in the low word of the name pointer).
            let ex = sys::GetProcAddress(m, 108usize as *const u8);
            let battery = sys::GetProcAddress(m, c"XInputGetBatteryInformation".as_ptr().cast());
            return Some(Api {
                state: std::mem::transmute::<*const core::ffi::c_void, GetState>(state),
                caps: std::mem::transmute::<*const core::ffi::c_void, GetCapabilities>(caps),
                caps_ex: (!ex.is_null()).then(|| std::mem::transmute::<*const core::ffi::c_void, GetCapabilitiesEx>(ex)),
                battery: (!battery.is_null()).then(|| std::mem::transmute::<*const core::ffi::c_void, GetBattery>(battery)),
            });
        }
        None
    })
    .as_ref()
}

#[cfg(not(windows))]
fn api() -> Option<&'static Api> {
    None
}

/// One XInput slot with a pad in it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    pub slot: u32,
    /// USB ids from the extended capabilities, when Windows gives them (0 when it doesn't).
    pub vid: u16,
    pub pid: u16,
    /// XInput's subtype: 1 gamepad, 2 wheel, 3 arcade stick, 4 flight stick, 5 dance pad, 6 guitar, 8 drum kit, 0x13 arcade pad.
    pub sub_type: u8,
    pub wireless: bool,
    /// "wired", "alkaline", "nimh", "unknown", "disconnected"; with a level of 0 (empty) to 3 (full).
    pub battery: Option<(String, u8)>,
}

/// The pads XInput sees right now. Read only.
pub fn slots() -> Vec<Slot> {
    let Some(api) = api() else { return Vec::new() };
    let mut out = Vec::new();
    for slot in 0..4u32 {
        let mut s = State::default();
        if unsafe { (api.state)(slot, &mut s) } != ERROR_SUCCESS {
            continue;
        }
        let mut c = Capabilities::default();
        let _ = unsafe { (api.caps)(slot, 0, &mut c) };
        let (mut vid, mut pid) = (0, 0);
        if let Some(ex) = api.caps_ex {
            let mut e = CapabilitiesEx::default();
            if unsafe { ex(1, slot, 0, &mut e) } == ERROR_SUCCESS {
                vid = e.vendor_id;
                pid = e.product_id;
                c = e.caps;
            }
        }
        let battery = api.battery.and_then(|b| {
            let mut info = Battery::default();
            (unsafe { b(slot, BATTERY_DEVTYPE_GAMEPAD, &mut info) } == ERROR_SUCCESS).then(|| {
                let kind = match info.kind {
                    0 => "disconnected",
                    1 => "wired",
                    2 => "alkaline",
                    3 => "nimh",
                    _ => "unknown",
                };
                (kind.to_string(), info.level)
            })
        });
        out.push(Slot { slot, vid, pid, sub_type: c.sub_type, wireless: c.flags & 0x0002 != 0, battery });
    }
    out
}

/// One reading: the packet number and the pad's state, with the time it was seen (microseconds, the bridge's clock).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reading {
    pub t: u64,
    pub n: u32,
    pub b: u16,
    pub lt: u8,
    pub rt: u8,
    pub lx: i16,
    pub ly: i16,
    pub rx: i16,
    pub ry: i16,
}

/// The state of one slot now, or None when no pad is in it.
pub fn read(slot: u32) -> Option<Reading> {
    let api = api()?;
    let mut s = State::default();
    (unsafe { (api.state)(slot, &mut s) } == ERROR_SUCCESS).then(|| reading(&s))
}

fn reading(s: &State) -> Reading {
    let g = s.gamepad;
    Reading { t: crate::hid::now_us(), n: s.packet, b: g.buttons, lt: g.left_trigger, rt: g.right_trigger, lx: g.thumb_lx, ly: g.thumb_ly, rx: g.thumb_rx, ry: g.thumb_ry }
}

/// What a sampling run hands the page: the changes seen since the last batch and how fast it was sampling.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SampleBatch {
    pub slot: u32,
    pub readings: Vec<Reading>,
    /// XInputGetState calls per second in this batch: a polling figure near half of this is sample-limited.
    pub sample_hz: u32,
    /// The run ended (time up, focus lost, the pad gone or stopped by the page).
    pub done: bool,
}

static FOCUSED: AtomicBool = AtomicBool::new(true);
static RUN: AtomicU64 = AtomicU64::new(0);
static RUNNING: Mutex<Option<u32>> = Mutex::new(None);

/// The window gained or lost focus. Losing it ends any sampling run at once (a game may be starting).
pub fn set_focused(focused: bool) {
    FOCUSED.store(focused, Ordering::SeqCst);
    if !focused {
        stop();
    }
}

/// Ends the sampling run, if one is going.
pub fn stop() {
    RUN.fetch_add(1, Ordering::SeqCst);
}

/// Starts sampling `slot` for at most `SAMPLE_MAX`, handing batches to `emit`. Only one run at a time; a new one
/// replaces the old. Refused while the window isn't focused.
pub fn sample(slot: u32, seconds: f64, emit: Arc<dyn Fn(SampleBatch) + Send + Sync>) -> Result<(), String> {
    if !FOCUSED.load(Ordering::SeqCst) {
        return Err("SYNQ isn't the focused window, so it doesn't sample the pad (a game may be running).".into());
    }
    let api = api().ok_or("XInput isn't available on this PC.")?;
    if slot > 3 {
        return Err("XInput has slots 0 to 3.".into());
    }
    let run = RUN.fetch_add(1, Ordering::SeqCst) + 1;
    let limit = Duration::from_secs_f64(seconds.clamp(0.5, SAMPLE_MAX.as_secs_f64()));
    if let Ok(mut r) = RUNNING.lock() {
        *r = Some(slot);
    }
    std::thread::spawn(move || {
        let started = Instant::now();
        let mut last_flush = Instant::now();
        let mut calls: u64 = 0;
        let mut readings = Vec::new();
        let mut last: Option<u32> = None;
        let mut gone = false;
        loop {
            let live = RUN.load(Ordering::SeqCst) == run && FOCUSED.load(Ordering::SeqCst) && started.elapsed() < limit;
            let mut s = State::default();
            if live {
                calls += 1;
                if unsafe { (api.state)(slot, &mut s) } != ERROR_SUCCESS {
                    gone = true;
                } else if last != Some(s.packet) {
                    last = Some(s.packet);
                    readings.push(reading(&s));
                }
            }
            let done = !live || gone;
            if done || last_flush.elapsed() >= BATCH {
                let secs = last_flush.elapsed().as_secs_f64().max(1e-6);
                emit(SampleBatch { slot, readings: std::mem::take(&mut readings), sample_hz: (calls as f64 / secs) as u32, done });
                calls = 0;
                last_flush = Instant::now();
            }
            if done {
                break;
            }
            // A short spin between reads: XInputGetState itself takes a few microseconds.
            std::hint::spin_loop();
        }
        if let Ok(mut r) = RUNNING.lock() {
            if RUN.load(Ordering::SeqCst) == run {
                *r = None;
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_ids_give_usb_ids() {
        assert_eq!(usb_ids(r"USB\VID_3537&PID_1010\6&2B5F3A4&0&2"), Some((0x3537, 0x1010)));
        assert_eq!(usb_ids(r"usb\vid_045e&pid_0b12&mi_00\7&1"), Some((0x045e, 0x0b12)));
        assert_eq!(usb_ids(r"USB\ROOT_HUB30\4&1"), None);
    }

    #[test]
    fn layouts_match_xinput() {
        assert_eq!(std::mem::size_of::<Gamepad>(), 12);
        assert_eq!(std::mem::size_of::<State>(), 16);
        assert_eq!(std::mem::size_of::<Capabilities>(), 20);
        assert_eq!(std::mem::size_of::<CapabilitiesEx>(), 32);
        assert_eq!(std::mem::size_of::<Battery>(), 2);
    }

    /// Read-only look at the pads XInput sees on this PC, and a 2 s sampling run on the first one (move a stick).
    /// Nothing is sent to any pad. Run with: cargo test --lib -- --ignored --nocapture xinput_probe
    #[test]
    #[ignore = "reads the XInput pads plugged into this PC"]
    fn xinput_probe() {
        let found = slots();
        println!("xinput slots: {found:?}");
        println!("USB XInput pads present: {:04x?}", usb_xinput_pads());
        let Some(first) = found.first() else { return };
        let (tx, rx) = std::sync::mpsc::channel::<SampleBatch>();
        let tx = Mutex::new(tx);
        sample(first.slot, 2.0, Arc::new(move |b| {
            let _ = tx.lock().map(|t| t.send(b));
        }))
        .unwrap();
        let mut times = Vec::new();
        let mut rates = Vec::new();
        while let Ok(b) = rx.recv_timeout(Duration::from_secs(4)) {
            times.extend(b.readings.iter().map(|r| r.t));
            rates.push(b.sample_hz);
            if b.done {
                break;
            }
        }
        let mut gaps: Vec<u64> = times.windows(2).map(|w| w[1] - w[0]).filter(|&g| g < 50_000).collect();
        gaps.sort_unstable();
        let median = gaps.get(gaps.len() / 2).copied().unwrap_or(0);
        rates.sort_unstable();
        println!(
            "changes: {}, median gap: {median} us ({} Hz by changes), sampler: ~{} calls/s",
            times.len(),
            if median > 0 { 1_000_000 / median } else { 0 },
            rates.get(rates.len() / 2).copied().unwrap_or(0)
        );
    }
}
