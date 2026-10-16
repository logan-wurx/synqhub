//! Mouse timings for the checkup (Gear Doctor), on Windows: Raw Input delivered to SYNQ's own main window (watched
//! for WM_INPUT while a run lasts), with the time each report arrived. The main window, because Windows 11 hands a
//! listener that isn't in front (a hidden message-only window counts as one) its mouse reports merged, about 125 a
//! second, whatever the mouse's rate: a 4 kHz mouse measured "125 Hz". A report that still arrives that way is counted
//! (`background`), so the checkup doesn't take its timing for the mouse's.
//! It listens to what the mice already send the PC (button transitions and motion counts) and sends nothing to any
//! device. A run lasts at most `SAMPLE_MAX`, only while SYNQ is the focused window (the window's focus event and, on
//! every pass of the loop, the foreground window's own process), and puts back the process's own Raw Input registration
//! when it ends. Keyboards are never listened to here.

use serde::Serialize;
#[cfg(windows)]
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// The longest run (the click step can take a while at a slow pace).
#[cfg_attr(not(windows), allow(dead_code))] // used by the Windows sampler (and the tests) only
pub const SAMPLE_MAX: Duration = Duration::from_secs(45);
/// Reports kept per run (8 kHz for 25 s); a run stops when full.
#[cfg_attr(not(windows), allow(dead_code))] // used by the Windows sampler (and the tests) only
const MAX_EVENTS: usize = 200_000;
/// The button transitions in `usButtonFlags`: left, right, middle, back and forward, down and up. The wheel bits are left out.
pub const BUTTON_BITS: u16 = 0x03ff;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct RawDevice {
    pub vid: String,
    pub pid: String,
}

/// One run, as columns (compact over the bridge): event `i` is `t[i]` ms after the start, from `devices[dev[i]]`.
#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RawMouseRun {
    pub devices: Vec<RawDevice>,
    pub t: Vec<f64>,
    pub dev: Vec<u16>,
    pub dx: Vec<i32>,
    pub dy: Vec<i32>,
    pub buttons: Vec<u16>,
    /// Why it stopped: "time", "stopped", "focus" or "full".
    pub ended: &'static str,
    /// Reports Windows delivered as to a listener in the background (merged, about 125 a second): their timing is not
    /// the mouse's, so the checkup judges no polling from such a run.
    pub background: u32,
}

/// Runs a job on the main window's thread (true when it was handed over). The window's messages are only seen there.
pub type MainThread<'a> = &'a dyn Fn(Box<dyn FnOnce() + Send>) -> bool;

#[cfg_attr(not(windows), allow(dead_code))] // used by the Windows sampler (and the tests) only
impl RawMouseRun {
    /// Keeps one report; false once the run is full.
    pub fn push(&mut self, t: f64, dev: u16, dx: i32, dy: i32, buttons: u16) -> bool {
        if self.t.len() >= MAX_EVENTS {
            return false;
        }
        self.t.push(t);
        self.dev.push(dev);
        self.dx.push(dx);
        self.dy.push(dy);
        self.buttons.push(buttons & BUTTON_BITS);
        true
    }

    /// The device index for a vid:pid, adding it the first time (two collections of one receiver share an entry).
    pub fn device(&mut self, vid: &str, pid: &str) -> u16 {
        if let Some(i) = self.devices.iter().position(|d| d.vid == vid && d.pid == pid) {
            return i as u16;
        }
        self.devices.push(RawDevice { vid: vid.to_string(), pid: pid.to_string() });
        (self.devices.len() - 1) as u16
    }
}

/// The hex digits right after `marker` in an upper-cased path.
#[cfg_attr(not(windows), allow(dead_code))] // used by the Windows sampler (and the tests) only
fn hex_after<'a>(path: &'a str, marker: &str) -> Option<&'a str> {
    let at = path.find(marker)? + marker.len();
    let rest = &path[at..];
    let end = rest.find(|c: char| !c.is_ascii_hexdigit()).unwrap_or(rest.len());
    Some(&rest[..end])
}

/// The USB ids in a device path: `\\?\HID#VID_046D&PID_C547&MI_01...` (USB), `..._VID&0002046d_PID&b023...` (Bluetooth,
/// the vendor id after a 4-digit source), `..._VID&02046d_PID&b023...` (Bluetooth LE, a 2-digit source). Lower case.
#[cfg_attr(not(windows), allow(dead_code))] // used by the Windows sampler (and the tests) only
pub fn ids_from_path(path: &str) -> Option<(String, String)> {
    let p = path.to_ascii_uppercase();
    let vid = hex_after(&p, "VID_").filter(|h| h.len() >= 4).map(|h| &h[..4]).or_else(|| hex_after(&p, "VID&").filter(|h| h.len() >= 4).map(|h| &h[h.len() - 4..]))?;
    let pid = hex_after(&p, "PID_").or_else(|| hex_after(&p, "PID&")).filter(|h| h.len() >= 4).map(|h| &h[..4])?;
    Some((vid.to_ascii_lowercase(), pid.to_ascii_lowercase()))
}

static FOCUSED: AtomicBool = AtomicBool::new(true);
#[cfg(windows)]
static RUN: AtomicU64 = AtomicU64::new(0);

/// The window gained or lost focus. Losing it ends a run at once (a game may be starting).
pub fn set_focused(focused: bool) {
    FOCUSED.store(focused, Ordering::SeqCst);
    if !focused {
        stop();
    }
}

/// Ends the run in progress, if any; it returns what it has.
pub fn stop() {
    #[cfg(windows)]
    RUN.fetch_add(1, Ordering::SeqCst);
}

/// Listens to every mouse for up to `seconds` through the main window `target` (its HWND), whose thread `main` runs
/// jobs on. `motion`: keep motion reports too (otherwise only button transitions). Refused while SYNQ isn't the
/// focused window.
pub fn sample(target: isize, seconds: f64, motion: bool, main: MainThread<'_>) -> Result<RawMouseRun, String> {
    if !FOCUSED.load(Ordering::SeqCst) {
        return Err("SYNQ isn't the focused window, so it doesn't listen to the mouse (a game may be running).".into());
    }
    #[cfg(windows)]
    {
        let run = RUN.fetch_add(1, Ordering::SeqCst) + 1;
        let limit = Duration::from_secs_f64(seconds.clamp(0.5, SAMPLE_MAX.as_secs_f64()));
        win::run(run, target, limit, motion, main)
    }
    #[cfg(not(windows))]
    {
        let _ = (target, seconds, motion, main);
        Err("Raw Input is a Windows feature; the checkup uses the window's own events here.".into())
    }
}

#[cfg(windows)]
pub(crate) mod win {
    use super::{ids_from_path, MainThread, RawMouseRun, BUTTON_BITS, FOCUSED, RUN};
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::atomic::Ordering;
    use std::sync::{mpsc, Mutex};
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::Input::{
        GetRawInputData, GetRawInputDeviceInfoW, GetRegisteredRawInputDevices, RegisterRawInputDevices, HRAWINPUT, MOUSE_MOVE_ABSOLUTE, RAWINPUT, RAWINPUTDEVICE, RAWINPUTDEVICE_FLAGS, RAWINPUTHEADER,
        RIDEV_INPUTSINK, RIDEV_REMOVE, RIDI_DEVICENAME, RID_INPUT, RIM_TYPEMOUSE,
    };
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, WM_INPUT};

    /// The window in front belongs to SYNQ itself. Checked before listening and on every pass, besides the focus
    /// event: with any other window in front (a game) the run ends at once.
    pub(crate) fn ours_in_front() -> bool {
        unsafe {
            let front = GetForegroundWindow();
            if front.is_invalid() {
                return false;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(front, Some(&mut pid));
            pid != 0 && pid == GetCurrentProcessId()
        }
    }

    const DEVICE_SIZE: u32 = std::mem::size_of::<RAWINPUTDEVICE>() as u32;
    const HEADER_SIZE: u32 = std::mem::size_of::<RAWINPUTHEADER>() as u32;
    /// `GET_RAWINPUT_CODE_WPARAM(wParam) == RIM_INPUTSINK`: the report reached a listener that isn't in front. Windows
    /// merges those and hands them over about 125 times a second (since 2023), so their timing isn't the mouse's.
    const RIM_INPUTSINK: usize = 1;
    /// Our id among the main window's subclasses.
    const SUBCLASS_ID: usize = 0x4f42_4d53;
    /// How long a step on the window's thread may take before the run gives up on it.
    const MAIN_WAIT: Duration = Duration::from_secs(2);
    /// How often the run looks at the stop, focus and time limits.
    const PASS: Duration = Duration::from_millis(5);

    /// The run in progress: filled on the window's thread as reports arrive, taken by the run when it ends.
    struct Collector {
        started: Instant,
        motion: bool,
        run: RawMouseRun,
        handles: HashMap<usize, u16>,
        full: bool,
    }
    static COLLECT: Mutex<Option<Collector>> = Mutex::new(None);
    /// The process's own mouse registration from before the run (page, usage, flags, window), put back when it ends;
    /// `Some(None)`: there was none. Set only once listening started, so a run that never started changes nothing.
    static BEFORE: Mutex<Option<Option<(u16, u16, u32, isize)>>> = Mutex::new(None);

    /// The process's current Raw Input registrations (the window library may hold one for the mouse).
    unsafe fn registered() -> Vec<RAWINPUTDEVICE> {
        let mut n = 0u32;
        unsafe { GetRegisteredRawInputDevices(None, &mut n, DEVICE_SIZE) };
        if n == 0 {
            return Vec::new();
        }
        let mut list = vec![RAWINPUTDEVICE::default(); n as usize];
        let got = unsafe { GetRegisteredRawInputDevices(Some(list.as_mut_ptr()), &mut n, DEVICE_SIZE) };
        if got == u32::MAX {
            return Vec::new();
        }
        list.truncate(got as usize);
        list
    }

    unsafe fn device_path(h: HANDLE) -> Option<String> {
        let mut len = 0u32;
        unsafe { GetRawInputDeviceInfoW(Some(h), RIDI_DEVICENAME, None, &mut len) };
        if len == 0 || len > 1024 {
            return None;
        }
        let mut buf = vec![0u16; len as usize];
        let got = unsafe { GetRawInputDeviceInfoW(Some(h), RIDI_DEVICENAME, Some(buf.as_mut_ptr() as *mut c_void), &mut len) };
        if got == 0 || got == u32::MAX {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..(got as usize).min(buf.len())]).trim_end_matches('\0').to_string())
    }

    /// The main window's messages while a run listens: each WM_INPUT is kept, then everything goes on as before.
    unsafe extern "system" fn on_message(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
        if msg == WM_INPUT {
            unsafe { keep(wparam, lparam) };
        }
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    /// One report into the run, with the time it arrived. Nothing is kept once SYNQ isn't the focused window, and a
    /// report delivered to a listener in the background is kept only with SYNQ in front, and counted.
    unsafe fn keep(wparam: WPARAM, lparam: LPARAM) {
        if !FOCUSED.load(Ordering::SeqCst) {
            return;
        }
        let background = wparam.0 & 0xff == RIM_INPUTSINK;
        if background && !ours_in_front() {
            return;
        }
        let mut raw = RAWINPUT::default();
        let mut size = std::mem::size_of::<RAWINPUT>() as u32;
        let got = unsafe { GetRawInputData(HRAWINPUT(lparam.0 as *mut c_void), RID_INPUT, Some(&mut raw as *mut RAWINPUT as *mut c_void), &mut size, HEADER_SIZE) };
        if got == u32::MAX || got == 0 || raw.header.dwType != RIM_TYPEMOUSE.0 {
            return;
        }
        let Ok(mut guard) = COLLECT.lock() else { return };
        let Some(c) = guard.as_mut() else { return };
        if c.full {
            return;
        }
        let m = unsafe { raw.data.mouse };
        let flags = unsafe { m.Anonymous.Anonymous.usButtonFlags } & BUTTON_BITS;
        let relative = m.usFlags.0 & MOUSE_MOVE_ABSOLUTE.0 == 0;
        let (dx, dy) = if relative { (m.lLastX, m.lLastY) } else { (0, 0) };
        if flags == 0 && !(c.motion && (dx != 0 || dy != 0)) {
            return;
        }
        let key = raw.header.hDevice.0 as usize;
        let dev = match c.handles.get(&key) {
            Some(i) => *i,
            None => {
                let (vid, pid) = unsafe { device_path(raw.header.hDevice) }.and_then(|p| ids_from_path(&p)).unwrap_or_default();
                let i = c.run.device(&vid, &pid);
                c.handles.insert(key, i);
                i
            }
        };
        let t = c.started.elapsed().as_secs_f64() * 1000.0;
        if c.run.push(t, dev, dx, dy, flags) {
            if background {
                c.run.background += 1;
            }
        } else {
            c.full = true;
        }
    }

    /// On the window's thread: listen to every mouse through the main window. Windows gives a window in front each
    /// report as it comes; a hidden listener window counts as background and gets them merged, about 125 a second.
    unsafe fn attach(target: isize) -> Result<(), String> {
        let hwnd = HWND(target as *mut c_void);
        let before = unsafe { registered() }.into_iter().find(|d| d.usUsagePage == 1 && d.usUsage == 2);
        if !unsafe { SetWindowSubclass(hwnd, Some(on_message), SUBCLASS_ID, 0) }.as_bool() {
            return Err("the window refused".into());
        }
        let ours = RAWINPUTDEVICE { usUsagePage: 1, usUsage: 2, dwFlags: RIDEV_INPUTSINK, hwndTarget: hwnd };
        if let Err(e) = unsafe { RegisterRawInputDevices(&[ours], DEVICE_SIZE) } {
            let _ = unsafe { RemoveWindowSubclass(hwnd, Some(on_message), SUBCLASS_ID) };
            return Err(e.to_string());
        }
        if let Ok(mut b) = BEFORE.lock() {
            *b = Some(before.map(|d| (d.usUsagePage, d.usUsage, d.dwFlags.0, d.hwndTarget.0 as isize)));
        }
        Ok(())
    }

    /// On the window's thread: put back the process's own mouse registration (or none) and stop watching the window.
    unsafe fn detach(target: isize) {
        let hwnd = HWND(target as *mut c_void);
        if let Some(before) = BEFORE.lock().ok().and_then(|mut b| b.take()) {
            let restore = before
                .map(|(page, usage, flags, window)| RAWINPUTDEVICE { usUsagePage: page, usUsage: usage, dwFlags: RAWINPUTDEVICE_FLAGS(flags), hwndTarget: HWND(window as *mut c_void) })
                .unwrap_or(RAWINPUTDEVICE { usUsagePage: 1, usUsage: 2, dwFlags: RIDEV_REMOVE, hwndTarget: HWND::default() });
            let _ = unsafe { RegisterRawInputDevices(&[restore], DEVICE_SIZE) };
        }
        let _ = unsafe { RemoveWindowSubclass(hwnd, Some(on_message), SUBCLASS_ID) };
    }

    /// Runs `job` on the window's thread and waits for it (up to MAIN_WAIT).
    fn on_main<T: Send + 'static>(main: MainThread<'_>, job: impl FnOnce() -> T + Send + 'static) -> Option<T> {
        let (tx, rx) = mpsc::channel();
        if !main(Box::new(move || {
            let _ = tx.send(job());
        })) {
            return None;
        }
        rx.recv_timeout(MAIN_WAIT).ok()
    }

    pub fn run(run: u64, target: isize, limit: Duration, motion: bool, main: MainThread<'_>) -> Result<RawMouseRun, String> {
        if !ours_in_front() {
            return Err("SYNQ isn't the window in front, so it doesn't listen to the mouse (a game may be running).".into());
        }
        if let Ok(mut c) = COLLECT.lock() {
            *c = Some(Collector { started: Instant::now(), motion, run: RawMouseRun::default(), handles: HashMap::new(), full: false });
        }
        let attached = on_main(main, move || unsafe { attach(target) }).unwrap_or_else(|| Err("the window didn't answer".into()));
        if let Err(e) = attached {
            // A late attach is undone too: detach puts back only what an attach changed.
            let _ = on_main(main, move || unsafe { detach(target) });
            let _ = COLLECT.lock().map(|mut c| c.take());
            return Err(format!("Couldn't listen to the mouse: {e}"));
        }
        let started = Instant::now();
        let ended = loop {
            if RUN.load(Ordering::SeqCst) != run {
                break "stopped";
            }
            if !FOCUSED.load(Ordering::SeqCst) || !ours_in_front() {
                break "focus";
            }
            if started.elapsed() >= limit {
                break "time";
            }
            if COLLECT.lock().map(|c| c.as_ref().is_some_and(|c| c.full)).unwrap_or(false) {
                break "full";
            }
            std::thread::sleep(PASS);
        };
        let _ = on_main(main, move || unsafe { detach(target) });
        let mut out = COLLECT.lock().ok().and_then(|mut c| c.take()).map(|c| c.run).unwrap_or_default();
        out.ended = ended;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_from_usb_and_bluetooth_paths() {
        assert_eq!(ids_from_path(r"\\?\HID#VID_046D&PID_C547&MI_01&Col01#8&2c1f6b7&0&0000#{378de44c-56ef-11d1-bc8c-00a0c91405dd}"), Some(("046d".into(), "c547".into())));
        assert_eq!(ids_from_path(r"\\?\HID#{00001124-0000-1000-8000-00805f9b34fb}_VID&0002046d_PID&b023#9&1ea2b1c3&0&0000#{378de44c}"), Some(("046d".into(), "b023".into())));
        assert_eq!(ids_from_path(r"\\?\HID#{00001812-0000-1000-8000-00805f9b34fb}_Dev_VID&02373b_PID&1278_REV&0011_c0ffee#a&1"), Some(("373b".into(), "1278".into())));
        assert_eq!(ids_from_path(r"\\?\ACPI#PNP0F13#4&22f5829e&0"), None);
    }

    #[test]
    fn a_run_keeps_columns_in_step_and_stops_when_full() {
        let mut r = RawMouseRun::default();
        let a = r.device("046d", "c547");
        let b = r.device("373b", "1278");
        assert_eq!((a, b, r.device("046d", "c547")), (0, 1, 0));
        assert!(r.push(1.5, a, 3, -2, 0xffff));
        assert_eq!(r.buttons, vec![BUTTON_BITS]);
        for i in 1..MAX_EVENTS {
            assert!(r.push(i as f64, b, 1, 0, 0));
        }
        assert!(!r.push(0.0, b, 0, 0, 1));
        assert_eq!((r.t.len(), r.dev.len(), r.dx.len(), r.dy.len(), r.buttons.len()), (MAX_EVENTS, MAX_EVENTS, MAX_EVENTS, MAX_EVENTS, MAX_EVENTS));
    }

    /// A test binary never owns the window in front (the terminal does), so no run starts and nothing is registered.
    #[test]
    fn refused_unless_onboard_is_in_front() {
        let r = sample(0, 1.0, false, &|_| false);
        assert!(r.is_err(), "a run must not start without SYNQ in front");
    }

    #[test]
    fn refused_while_unfocused() {
        set_focused(false);
        assert!(sample(0, 1.0, false, &|_| false).is_err());
        set_focused(true);
    }
}
