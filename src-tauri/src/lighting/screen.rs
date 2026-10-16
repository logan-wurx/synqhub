//! Screen colours for screen sync: one average colour per lamp segment, read from thin strips of the primary monitor
//! (1 % of its width: at the left or right edge, both, or for "full" the left edge, the middle and the right edge).
//! GDI shrinks each strip straight into a bitmap of a few pixels per segment, so the full frame is never copied to the
//! CPU; nothing is recorded or kept. One strip is read per sample (the others keep their last colours), so a sample
//! costs about 0.2 ms of CPU whatever the edge (docs/performance.md).
//!
//! Exclusive-fullscreen and protected windows come back black through GDI: a sample that is all black is "blind",
//! and the caller holds the last colours instead of sending black.

// Only the Windows bridge reads the screen; elsewhere the helpers build for their tests and the shared types.
#![cfg_attr(not(windows), allow(dead_code))]

/// Screen sync's pace, for every light that follows the screen: about 6 samples a second while the picture moves, 2 once
/// it has stood still for `STILL_AFTER`. (Only the Windows bridge samples; elsewhere the tests build this module.)
#[cfg_attr(not(windows), allow(dead_code))]
pub const FAST: std::time::Duration = std::time::Duration::from_millis(166);
#[cfg_attr(not(windows), allow(dead_code))]
pub const SLOW: std::time::Duration = std::time::Duration::from_millis(500);
#[cfg_attr(not(windows), allow(dead_code))]
pub const STILL_AFTER: std::time::Duration = std::time::Duration::from_secs(3);

/// Which part of the screen a lamp follows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Edge {
    Left,
    Right,
    Both,
    Full,
}

impl Edge {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "left" => Some(Self::Left),
            "right" => Some(Self::Right),
            "both" => Some(Self::Both),
            "full" => Some(Self::Full),
            _ => None,
        }
    }
}

/// A strip is this share of the screen's width (at least `MIN_STRIP` pixels): the cost grows with the area read.
const STRIP: f32 = 0.01;
const MIN_STRIP: i32 = 8;
/// Pixels per segment in the shrunk bitmap: COLS across, ROWS_PER_BAND down.
pub const COLS: i32 = 8;
pub const ROWS_PER_BAND: i32 = 4;
/// The whole screen as a grid this many columns wide.


/// The screen rectangles (x, y, w, h) an edge reads, on a `w` × `h` screen.
pub fn regions(edge: Edge, w: i32, h: i32) -> Vec<(i32, i32, i32, i32)> {
    let s = ((w as f32 * STRIP) as i32).max(MIN_STRIP).min(w);
    match edge {
        Edge::Left => vec![(0, 0, s, h)],
        Edge::Right => vec![(w - s, 0, s, h)],
        Edge::Both => vec![(0, 0, s, h), (w - s, 0, s, h)],
        // Three strips stand for the whole screen: reading all of it costs twenty times as much.
        Edge::Full => vec![(0, 0, s, h), ((w - s) / 2, 0, s, h), (w - s, 0, s, h)],
    }
}

/// Averages a top-down BGRA bitmap `cols` wide and `bands * ROWS_PER_BAND` tall into one colour per band, band 0 at
/// the bottom (the lamp's segment 1), added into `acc` (sums) and `n` (counts).
pub fn accumulate(bgra: &[u8], cols: usize, bands: usize, acc: &mut [[u32; 3]], n: &mut [u32]) {
    let rows = bands * ROWS_PER_BAND as usize;
    for r in 0..rows {
        let band = bands - 1 - r / ROWS_PER_BAND as usize;
        for c in 0..cols {
            let p = (r * cols + c) * 4;
            if p + 2 >= bgra.len() {
                return;
            }
            acc[band][0] += u32::from(bgra[p + 2]);
            acc[band][1] += u32::from(bgra[p + 1]);
            acc[band][2] += u32::from(bgra[p]);
            n[band] += 1;
        }
    }
}

pub fn averages(acc: &[[u32; 3]], n: &[u32]) -> Vec<[u8; 3]> {
    acc.iter().zip(n).map(|(a, &k)| if k == 0 { [0; 3] } else { [(a[0] / k) as u8, (a[1] / k) as u8, (a[2] / k) as u8] }).collect()
}

/// The band-by-band mean of several strips' colours.
pub fn mean(strips: &[Vec<[u8; 3]>], bands: usize) -> Vec<[u8; 3]> {
    (0..bands)
        .map(|b| {
            let got: Vec<&[u8; 3]> = strips.iter().filter_map(|s| s.get(b)).collect();
            let k = got.len().max(1) as u32;
            [0, 1, 2].map(|c| (got.iter().map(|v| u32::from(v[c])).sum::<u32>() / k) as u8)
        })
        .collect()
}

/// Nothing to see: every band (nearly) black. A protected or exclusive-fullscreen window, a locked screen, or a black
/// scene; the caller holds the last colours rather than turn the lamp dark.
pub fn blind(colours: &[[u8; 3]]) -> bool {
    colours.iter().all(|c| c.iter().all(|&v| v < 6))
}

/// Eases towards the new colours (no flicker on a cut), and makes them a little more vivid when asked: averaged edge
/// colours tend to grey.
pub fn smooth(prev: &[[u8; 3]], next: &[[u8; 3]], vivid: bool) -> Vec<[u8; 3]> {
    next.iter()
        .enumerate()
        .map(|(i, c)| {
            let c = if vivid { saturate(*c, 1.35) } else { *c };
            match prev.get(i) {
                Some(p) => [0, 1, 2].map(|k| ((u16::from(p[k]) + u16::from(c[k]) * 2) / 3) as u8),
                None => c,
            }
        })
        .collect()
}

fn saturate(c: [u8; 3], k: f32) -> [u8; 3] {
    let grey = (u16::from(c[0]) + u16::from(c[1]) + u16::from(c[2])) as f32 / 3.0;
    c.map(|v| (grey + (f32::from(v) - grey) * k).round().clamp(0.0, 255.0) as u8)
}

/// A display as Windows reports it: its device name (the id the sampler takes), its friendly name, its size, and where
/// it sits on the desktop (the primary's top-left is 0, 0).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    pub id: String,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub primary: bool,
}

/// The rectangle a sync reads: the chosen monitor's, else the primary's.
pub fn area_of(monitors: &[Monitor], chosen: Option<&str>) -> Option<(i32, i32, i32, i32)> {
    let m = chosen.and_then(|id| monitors.iter().find(|m| m.id == id)).or_else(|| monitors.iter().find(|m| m.primary)).or(monitors.first())?;
    Some((m.x, m.y, m.width, m.height))
}

#[cfg(windows)]
pub use win::{display_signature, monitors, secure_desktop, Sampler};

/// Elsewhere there is no screen to read (screen sync is the Windows app's).
#[cfg(not(windows))]
pub fn monitors() -> Vec<Monitor> {
    Vec::new()
}

#[cfg(windows)]
mod win {
    use super::{accumulate, averages, mean, regions, Edge, COLS, ROWS_PER_BAND};
    use std::ffi::c_void;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDCW, CreateDIBSection, DeleteDC, DeleteObject, GdiFlush, SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        COLORONCOLOR, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, SRCCOPY,
    };
    use windows::Win32::System::StationsAndDesktops::{CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, UOI_NAME};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CMONITORS, SM_CXSCREEN, SM_CXVIRTUALSCREEN, SM_CYSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };

    /// The primary monitor's size, the whole desktop's place and size, and the monitor count: a change in any of them
    /// (a monitor added, removed, moved or resized) means the displays changed.
    pub fn display_signature() -> [i32; 7] {
        let m = |i| unsafe { GetSystemMetrics(i) };
        [m(SM_CXSCREEN), m(SM_CYSCREEN), m(SM_XVIRTUALSCREEN), m(SM_YVIRTUALSCREEN), m(SM_CXVIRTUALSCREEN), m(SM_CYVIRTUALSCREEN), m(SM_CMONITORS)]
    }

    /// The displays, primary first, each with the name Windows shows for it (its friendly name, else "Display n").
    pub fn monitors() -> Vec<super::Monitor> {
        use windows::Win32::Foundation::{LPARAM, RECT};
        use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HMONITOR, MONITORINFO, MONITORINFOEXW};
        unsafe extern "system" fn each(h: HMONITOR, _: HDC, _: *mut RECT, out: LPARAM) -> windows::core::BOOL {
            let list = unsafe { &mut *(out.0 as *mut Vec<super::Monitor>) };
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            if unsafe { GetMonitorInfoW(h, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO) }.as_bool() {
                let len = info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len());
                let r = info.monitorInfo.rcMonitor;
                list.push(super::Monitor {
                    id: String::from_utf16_lossy(&info.szDevice[..len]),
                    name: String::new(),
                    x: r.left,
                    y: r.top,
                    width: r.right - r.left,
                    height: r.bottom - r.top,
                    primary: info.monitorInfo.dwFlags & 1 != 0,
                });
            }
            true.into()
        }
        let mut list: Vec<super::Monitor> = Vec::new();
        unsafe {
            let _ = EnumDisplayMonitors(None, None, Some(each), LPARAM(&mut list as *mut Vec<super::Monitor> as isize));
        }
        let names = friendly_names();
        for (i, m) in list.iter_mut().enumerate() {
            m.name = names.iter().find(|(gdi, _)| gdi.eq_ignore_ascii_case(&m.id)).map(|(_, n)| n.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| format!("Display {}", i + 1));
        }
        list.sort_by_key(|m| !m.primary);
        list
    }

    /// Each active display's GDI name ("\\.\DISPLAY1") and the monitor's friendly name, from Windows' display
    /// configuration (what Settings > Display shows).
    fn friendly_names() -> Vec<(String, String)> {
        use windows::Win32::Devices::Display::{
            DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig, DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
            DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SOURCE_DEVICE_NAME, DISPLAYCONFIG_TARGET_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
        };
        let text = |s: &[u16]| String::from_utf16_lossy(&s[..s.iter().position(|&c| c == 0).unwrap_or(s.len())]);
        let mut out = Vec::new();
        unsafe {
            let (mut np, mut nm) = (0u32, 0u32);
            if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut np, &mut nm).is_err() {
                return out;
            }
            let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); np as usize];
            let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); nm as usize];
            if QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &mut np, paths.as_mut_ptr(), &mut nm, modes.as_mut_ptr(), None).is_err() {
                return out;
            }
            for p in paths.iter().take(np as usize) {
                let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
                source.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
                source.header.size = std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
                source.header.adapterId = p.sourceInfo.adapterId;
                source.header.id = p.sourceInfo.id;
                let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME::default();
                target.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
                target.header.size = std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32;
                target.header.adapterId = p.targetInfo.adapterId;
                target.header.id = p.targetInfo.id;
                if DisplayConfigGetDeviceInfo(&mut source.header) == 0 && DisplayConfigGetDeviceInfo(&mut target.header) == 0 {
                    out.push((text(&source.viewGdiDeviceName), text(&target.monitorFriendlyDeviceName)));
                }
            }
        }
        out
    }

    /// True while the input desktop isn't the user's (the lock screen, a UAC prompt).
    pub fn secure_desktop() -> bool {
        unsafe {
            let Ok(desk) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) else { return true };
            let mut name = [0u16; 64];
            let mut needed = 0u32;
            let ok = GetUserObjectInformationW(windows::Win32::Foundation::HANDLE(desk.0), UOI_NAME, Some(name.as_mut_ptr().cast()), (name.len() * 2) as u32, Some(&mut needed)).is_ok();
            let _ = CloseDesktop(desk);
            let len = name.iter().position(|&c| c == 0).unwrap_or(0);
            !ok || !String::from_utf16_lossy(&name[..len]).eq_ignore_ascii_case("default")
        }
    }

    /// The screen DC and a small bitmap, made once per sync and reused for every sample (making them each time costs
    /// more than the sample itself).
    pub struct Sampler {
        screen: HDC,
        mem: HDC,
        bmp: HBITMAP,
        old: HGDIOBJ,
        bits: *const u8,
        /// The monitor read: its place on the desktop and its size (fixed for the sync: a display change stops it).
        area: (i32, i32, i32, i32),
        edge: Edge,
        bands: usize,
        cols: i32,
        rows: i32,
        /// Each strip's last colours: one strip is read per sample, in turn, so a sample costs one read however many
        /// strips the edge has.
        strips: Vec<Option<Vec<[u8; 3]>>>,
        turn: usize,
    }

    // The handles are used from the one sync thread that owns the sampler.
    unsafe impl Send for Sampler {}

    impl Sampler {
        /// A sampler for `edge` of the chosen monitor (by its id from `monitors`; the primary when None or gone).
        pub fn new(edge: Edge, bands: usize, monitor: Option<&str>) -> Result<Self, String> {
            let (cols, rows) = (COLS, bands as i32 * ROWS_PER_BAND);
            if bands == 0 {
                return Err("No segments to fill.".into());
            }
            let area = super::area_of(&monitors(), monitor).unwrap_or_else(|| {
                let s = display_signature();
                (0, 0, s[0], s[1])
            });
            unsafe {
                let screen = CreateDCW(w!("DISPLAY"), PCWSTR::null(), PCWSTR::null(), None);
                if screen.is_invalid() {
                    return Err("The screen can't be read.".into());
                }
                let mem = CreateCompatibleDC(Some(screen));
                let info = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: cols,
                        biHeight: -rows,
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB.0,
                        ..Default::default()
                    },
                    ..Default::default()
                };
                let mut bits: *mut c_void = std::ptr::null_mut();
                let bmp = match CreateDIBSection(Some(mem), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
                    Ok(b) => b,
                    Err(e) => {
                        let _ = DeleteDC(mem);
                        let _ = DeleteDC(screen);
                        return Err(format!("The screen can't be read: {}", e.message()));
                    }
                };
                let old = SelectObject(mem, bmp.into());
                SetStretchBltMode(mem, COLORONCOLOR);
                Ok(Self { screen, mem, bmp, old, bits: bits as *const u8, area, edge, bands, cols, rows, strips: Vec::new(), turn: 0 })
            }
        }

        /// One colour per band (band 0 at the bottom) for the edge of the chosen monitor: the average of its strips,
        /// one of them read fresh (all of them the first time). The screen DC spans the whole desktop, so a monitor is
        /// read at its own place on it.
        pub fn sample(&mut self) -> Result<Vec<[u8; 3]>, String> {
            let (ax, ay, w, h) = self.area;
            if w <= 0 || h <= 0 {
                return Err("No screen to read.".into());
            }
            let rects: Vec<(i32, i32, i32, i32)> = regions(self.edge, w, h).into_iter().map(|(x, y, rw, rh)| (ax + x, ay + y, rw, rh)).collect();
            self.strips.resize(rects.len(), None);
            let first = self.strips.iter().all(Option::is_none);
            for (i, &(x, y, rw, rh)) in rects.iter().enumerate() {
                if !first && i != self.turn % rects.len() {
                    continue;
                }
                let mut acc = vec![[0u32; 3]; self.bands];
                let mut n = vec![0u32; self.bands];
                unsafe {
                    if !StretchBlt(self.mem, 0, 0, self.cols, self.rows, Some(self.screen), x, y, rw, rh, SRCCOPY).as_bool() {
                        return Err("The screen can't be read.".into());
                    }
                    let _ = GdiFlush();
                    let px = std::slice::from_raw_parts(self.bits, (self.cols * self.rows * 4) as usize);
                    accumulate(px, self.cols as usize, self.bands, &mut acc, &mut n);
                }
                self.strips[i] = Some(averages(&acc, &n));
            }
            self.turn = self.turn.wrapping_add(1);
            Ok(mean(&self.strips.iter().flatten().cloned().collect::<Vec<_>>(), self.bands))
        }
    }

    impl Drop for Sampler {
        fn drop(&mut self) {
            unsafe {
                SelectObject(self.mem, self.old);
                let _ = DeleteObject(self.bmp.into());
                let _ = DeleteDC(self.mem);
                let _ = DeleteDC(self.screen);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_chosen_monitor_else_the_primary() {
        let m = |id: &str, x: i32, primary: bool| Monitor { id: id.into(), name: id.into(), x, y: 0, width: 1920, height: 1080, primary };
        let list = vec![m("\\\\.\\DISPLAY1", 0, true), m("\\\\.\\DISPLAY2", 1920, false)];
        assert_eq!(area_of(&list, Some("\\\\.\\DISPLAY2")), Some((1920, 0, 1920, 1080)));
        assert_eq!(area_of(&list, None), Some((0, 0, 1920, 1080)));
        assert_eq!(area_of(&list, Some("gone")), Some((0, 0, 1920, 1080)), "a monitor that left: the primary");
        assert_eq!(area_of(&[], None), None);
    }

    #[test]
    fn strips_are_thin_and_bands_count_from_the_bottom() {
        assert_eq!(regions(Edge::Left, 2560, 1440), vec![(0, 0, 25, 1440)]);
        assert_eq!(regions(Edge::Right, 2560, 1440), vec![(2535, 0, 25, 1440)]);
        assert_eq!(regions(Edge::Both, 200, 100).len(), 2);
        assert_eq!(regions(Edge::Full, 2560, 1440), vec![(0, 0, 25, 1440), (1267, 0, 25, 1440), (2535, 0, 25, 1440)], "never the whole frame");
        assert_eq!(regions(Edge::Left, 200, 100)[0].2, MIN_STRIP, "never thinner than a few pixels");
        // Two bands, two columns: the top band's rows are red, the bottom band's blue (BGRA).
        let red = [0u8, 0, 255, 0];
        let blue = [255u8, 0, 0, 0];
        let per_band = 2 * ROWS_PER_BAND as usize;
        let bitmap: Vec<u8> = [vec![red; per_band], vec![blue; per_band]].concat().concat();
        let (mut acc, mut n) = (vec![[0u32; 3]; 2], vec![0u32; 2]);
        accumulate(&bitmap, 2, 2, &mut acc, &mut n);
        assert_eq!(averages(&acc, &n), vec![[0, 0, 255], [255, 0, 0]], "band 0 is the bottom");
    }

    #[test]
    fn strips_are_averaged_band_by_band() {
        assert_eq!(mean(&[vec![[0, 0, 0], [200, 0, 0]], vec![[100, 0, 0], [0, 0, 200]]], 2), vec![[50, 0, 0], [100, 0, 100]]);
    }

    #[test]
    fn black_is_held_and_cuts_are_eased() {
        assert!(blind(&[[0, 0, 0], [3, 2, 5]]));
        assert!(!blind(&[[0, 0, 0], [40, 0, 0]]));
        assert_eq!(smooth(&[[0, 0, 0]], &[[255, 255, 255]], false), vec![[170, 170, 170]]);
        assert_eq!(smooth(&[], &[[100, 100, 100]], true), vec![[100, 100, 100]], "grey stays grey");
        let v = smooth(&[], &[[200, 100, 100]], true)[0];
        assert!(v[0] > 200 && v[1] < 100, "more vivid: {v:?}");
    }

    /// The displays as this PC reports them, and one sample of each one's left edge (run by hand on a desktop:
    /// `cargo test --lib monitors_here -- --ignored --nocapture`).
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn monitors_here() {
        let list = monitors();
        assert!(!list.is_empty() && list[0].primary, "primary first: {list:?}");
        for m in &list {
            let colours = Sampler::new(Edge::Left, 4, Some(&m.id)).unwrap().sample().unwrap();
            println!("{} \"{}\" {}x{} at {},{} primary={} left edge {colours:?}", m.id, m.name, m.width, m.height, m.x, m.y, m.primary);
        }
    }

    /// One sample of the real screen, timed in this thread's own CPU cycles (run by hand on a desktop:
    /// `cargo test --lib sample_cost -- --ignored --nocapture`); docs/performance.md has the figures.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn sample_cost() {
        use windows::Win32::System::{Threading::GetCurrentThread, WindowsProgramming::QueryThreadCycleTime};
        let cycles = || {
            let mut c = 0u64;
            unsafe { QueryThreadCycleTime(GetCurrentThread(), &mut c).unwrap() };
            c
        };
        // Cycles per microsecond, from a busy wait of this thread.
        let (c0, t0) = (cycles(), std::time::Instant::now());
        while t0.elapsed().as_millis() < 200 {
            std::hint::black_box(0);
        }
        let per_us = (cycles() - c0) as f64 / t0.elapsed().as_micros() as f64;
        for edge in [Edge::Left, Edge::Right, Edge::Both, Edge::Full] {
            let rounds = 120;
            let mut sampler = Sampler::new(edge, 14, None).unwrap();
            let mut last = Vec::new();
            let (c0, w0) = (cycles(), std::time::Instant::now());
            for _ in 0..rounds {
                last = smooth(&last, &sampler.sample().unwrap(), true);
            }
            let cpu = (cycles() - c0) as f64 / per_us / f64::from(rounds);
            let wall = w0.elapsed().as_secs_f64() * 1e6 / f64::from(rounds);
            println!("{edge:?}: {cpu:.0} µs CPU, {wall:.0} µs wall per sample ({per_us:.0} cycles/µs)");
        }
    }
}
