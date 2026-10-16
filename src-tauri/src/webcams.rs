//! Webcams over UVC through Media Foundation (Windows): listing (the camera device interfaces and their names, no
//! camera opened), the allowlisted controls' ranges and values (IAMCameraControl / IAMVideoProcAmp on the device
//! source, which is created but never started: no frame is captured), and a guarded set read back after. The allowlist
//! is src/lib/displays/uvc.json, the file the TypeScript side reads too. The live preview is the page's own, only
//! while the person has it open.
// The pure parts (tables, parsers, the guard) serve the Windows bridge and the tests; Linux builds list nothing here.
#![cfg_attr(not(windows), allow(dead_code))]

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Iface {
    /// IAMCameraControl.
    Camera,
    /// IAMVideoProcAmp.
    Proc,
}

#[derive(Clone, Debug)]
pub struct Spec {
    pub id: String,
    pub iface: Iface,
    pub prop: i32,
}

#[derive(Deserialize)]
struct RawSpec {
    id: String,
    iface: String,
    prop: i32,
}

#[derive(Deserialize)]
struct RawTable {
    allowed: Vec<RawSpec>,
}

pub fn allowed() -> &'static [Spec] {
    static T: OnceLock<Vec<Spec>> = OnceLock::new();
    T.get_or_init(|| {
        let t: RawTable = serde_json::from_str(include_str!("../../src/lib/displays/uvc.json")).expect("uvc.json");
        t.allowed.into_iter().map(|s| Spec { id: s.id, iface: if s.iface == "camera" { Iface::Camera } else { Iface::Proc }, prop: s.prop }).collect()
    })
}

/// KS flags: the control can run itself (auto) / be set by hand (manual).
pub const FLAG_AUTO: i32 = 1;
pub const FLAG_MANUAL: i32 = 2;

/// One control as the camera reports it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub id: String,
    pub min: i32,
    pub max: i32,
    pub step: i32,
    pub default: i32,
    pub value: i32,
    pub auto: bool,
    pub can_auto: bool,
}

/// Whether SYNQ may set this control to `value` (or to auto) on a camera that reports this range.
pub fn guard(id: &str, c: &Control, value: i32, auto: bool) -> Result<(), String> {
    if !allowed().iter().any(|s| s.id == id) {
        return Err(format!("Refused: \"{id}\" isn't a webcam control SYNQ changes."));
    }
    if auto {
        return if c.can_auto { Ok(()) } else { Err("This camera has no automatic mode for that.".into()) };
    }
    if value < c.min || value > c.max {
        return Err(format!("Refused: {value} is outside the camera's range ({} to {}).", c.min, c.max));
    }
    if c.step > 0 && (value - c.min) % c.step != 0 {
        return Err(format!("Refused: {value} isn't on the camera's step of {}.", c.step));
    }
    Ok(())
}

/// The USB ids in a camera's device interface path (`\\?\usb#vid_0458&pid_6006&mi_00#...`), lower case.
pub fn ids_of(link: &str) -> Option<(String, String)> {
    let l = link.to_ascii_lowercase();
    let v = l.find("vid_")? + 4;
    let p = l.find("pid_")? + 4;
    Some((l.get(v..v + 4)?.to_string(), l.get(p..p + 4)?.to_string()))
}

/// The device instance a camera's interface path belongs to (`USB\VID_0458&PID_6006&MI_00\7&1a3e2012&1&0000`).
pub fn instance_of(link: &str) -> Option<String> {
    let body = link.strip_prefix(r"\\?\")?;
    let mut parts = body.split('#');
    let (bus, hw, inst) = (parts.next()?, parts.next()?, parts.next()?);
    Some(format!("{bus}\\{hw}\\{inst}").to_ascii_uppercase())
}

/// A webcam as listed.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Webcam {
    /// The device interface path Media Foundation opens it by.
    pub id: String,
    pub name: String,
    pub vid: String,
    pub pid: String,
}

impl Webcam {
    /// As the device list has it (the app's and SYNQ Helper's): its interface path; the camera isn't opened.
    pub fn entry(&self) -> crate::devices::Connected {
        crate::devices::Connected { kind: "webcam", name: self.name.clone(), connection: "USB", generic: false, kb: None, qmk: false, bootloader: false, vid: self.vid.clone(), pid: self.pid.clone(), reported: None, collections: Vec::new(), pad: None, path: Some(self.id.clone()) }
    }
}

#[cfg(windows)]
pub use win::{controls, list, set};

#[cfg(not(windows))]
pub fn list() -> Vec<Webcam> {
    Vec::new()
}
#[cfg(not(windows))]
pub fn controls(_id: &str) -> Result<Vec<Control>, String> {
    Err("Webcam controls are read through Windows here; Linux (V4L2) isn't wired yet.".into())
}
#[cfg(not(windows))]
pub fn set(_id: &str, _control: &str, _value: i32, _auto: bool) -> Result<Control, String> {
    Err("Webcam controls aren't available here.".into())
}

#[cfg(windows)]
mod win {
    use super::{allowed, guard, ids_of, instance_of, Control, Iface, Webcam, FLAG_AUTO, FLAG_MANUAL};
    use windows::core::{Interface, GUID, HSTRING};
    use windows::Win32::Media::DirectShow::{IAMCameraControl, IAMVideoProcAmp};
    use windows::Win32::Media::MediaFoundation::{
        IMFAttributes, IMFMediaSource, MFCreateAttributes, MFCreateDeviceSource, MFShutdown, MFStartup, MFSTARTUP_LITE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
        MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, MF_VERSION,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    /// KSCATEGORY_VIDEO_CAMERA.
    const VIDEO_CAMERA: GUID = GUID::from_u128(0xe5323777_f976_4f5b_9b55_b94699c46e44);

    mod sys {
        use windows::core::GUID;
        #[link(name = "cfgmgr32")]
        unsafe extern "system" {
            pub fn CM_Get_Device_Interface_List_SizeW(len: *mut u32, class: *const GUID, device: *const u16, flags: u32) -> u32;
            pub fn CM_Get_Device_Interface_ListW(class: *const GUID, device: *const u16, buffer: *mut u16, len: u32, flags: u32) -> u32;
        }
    }

    fn name_of(link: &str) -> String {
        let Some(inst) = instance_of(link) else { return "Webcam".into() };
        let key = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE).open_subkey(format!("SYSTEM\\CurrentControlSet\\Enum\\{inst}"));
        let read = |k: &winreg::RegKey, v: &str| k.get_value::<String, _>(v).ok().map(|s| s.rsplit(';').next().unwrap_or(&s).trim().to_string()).filter(|s| !s.is_empty());
        key.ok().and_then(|k| read(&k, "FriendlyName").or_else(|| read(&k, "DeviceDesc"))).unwrap_or_else(|| "Webcam".into())
    }

    /// The present cameras' interface paths: cfgmgr32 only, no camera opened.
    pub fn list() -> Vec<Webcam> {
        let mut len = 0u32;
        if unsafe { sys::CM_Get_Device_Interface_List_SizeW(&mut len, &VIDEO_CAMERA, std::ptr::null(), 0) } != 0 || len <= 1 {
            return Vec::new();
        }
        let mut buf = vec![0u16; len as usize];
        if unsafe { sys::CM_Get_Device_Interface_ListW(&VIDEO_CAMERA, std::ptr::null(), buf.as_mut_ptr(), len, 0) } != 0 {
            return Vec::new();
        }
        buf.split(|&c| c == 0)
            .filter(|s| !s.is_empty())
            .map(String::from_utf16_lossy)
            .map(|id| {
                let (vid, pid) = ids_of(&id).unwrap_or_default();
                Webcam { name: name_of(&id), vid, pid, id }
            })
            .collect()
    }

    /// Runs `f` with the camera's device source (created, never started), then shuts it down.
    fn with_source<T>(link: &str, f: impl FnOnce(&IMFMediaSource) -> Result<T, String>) -> Result<T, String> {
        unsafe {
            let co = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            MFStartup(MF_VERSION, MFSTARTUP_LITE).map_err(|e| format!("Media Foundation: {e}"))?;
            let out = (|| {
                let mut attrs: Option<IMFAttributes> = None;
                MFCreateAttributes(&mut attrs, 2).map_err(|e| e.to_string())?;
                let attrs = attrs.ok_or("no attributes")?;
                attrs.SetGUID(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID).map_err(|e| e.to_string())?;
                attrs.SetString(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, &HSTRING::from(link)).map_err(|e| e.to_string())?;
                let source = MFCreateDeviceSource(&attrs).map_err(|e| format!("The camera couldn't be opened (another app may be using it): {e}"))?;
                let r = f(&source);
                let _ = source.Shutdown();
                r
            })();
            let _ = MFShutdown();
            if co {
                CoUninitialize();
            }
            out
        }
    }

    fn read_one(cam: Option<&IAMCameraControl>, amp: Option<&IAMVideoProcAmp>, iface: Iface, prop: i32) -> Option<(i32, i32, i32, i32, i32, i32, i32)> {
        let (mut min, mut max, mut step, mut def, mut caps, mut value, mut flags) = (0, 0, 0, 0, 0, 0, 0);
        unsafe {
            match iface {
                Iface::Camera => {
                    let c = cam?;
                    c.GetRange(prop, &mut min, &mut max, &mut step, &mut def, &mut caps).ok()?;
                    c.Get(prop, &mut value, &mut flags).ok()?;
                }
                Iface::Proc => {
                    let a = amp?;
                    a.GetRange(prop, &mut min, &mut max, &mut step, &mut def, &mut caps).ok()?;
                    a.Get(prop, &mut value, &mut flags).ok()?;
                }
            }
        }
        Some((min, max, step, def, caps, value, flags))
    }

    fn read_all(source: &IMFMediaSource) -> Vec<Control> {
        let cam = source.cast::<IAMCameraControl>().ok();
        let amp = source.cast::<IAMVideoProcAmp>().ok();
        allowed()
            .iter()
            .filter_map(|s| {
                let (min, max, step, default, caps, value, flags) = read_one(cam.as_ref(), amp.as_ref(), s.iface, s.prop)?;
                (max > min || caps & FLAG_AUTO != 0).then(|| Control { id: s.id.clone(), min, max, step, default, value, auto: flags & FLAG_AUTO != 0, can_auto: caps & FLAG_AUTO != 0 })
            })
            .collect()
    }

    pub fn controls(link: &str) -> Result<Vec<Control>, String> {
        with_source(link, |s| Ok(read_all(s)))
    }

    /// Sets one allowlisted control (inside the camera's range, or to auto) and reads it back.
    pub fn set(link: &str, id: &str, value: i32, auto: bool) -> Result<Control, String> {
        with_source(link, |source| {
            let spec = allowed().iter().find(|s| s.id == id).ok_or_else(|| format!("Refused: \"{id}\" isn't a webcam control SYNQ changes."))?;
            let now = read_all(source).into_iter().find(|c| c.id == id).ok_or("The camera doesn't report that control.")?;
            guard(id, &now, value, auto)?;
            let flags = if auto { FLAG_AUTO } else { FLAG_MANUAL };
            let v = if auto { now.value } else { value };
            let sent = unsafe {
                match spec.iface {
                    Iface::Camera => source.cast::<IAMCameraControl>().map_err(|e| e.to_string())?.Set(spec.prop, v, flags),
                    Iface::Proc => source.cast::<IAMVideoProcAmp>().map_err(|e| e.to_string())?.Set(spec.prop, v, flags),
                }
            };
            sent.map_err(|e| format!("The camera didn't take it: {e}"))?;
            let back = read_all(source).into_iter().find(|c| c.id == id).ok_or("The camera stopped reporting that control.")?;
            if auto != back.auto || (!auto && back.value != value) {
                return Err("Sent, but the camera reads back something else.".into());
            }
            Ok(back)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctl(min: i32, max: i32, step: i32, can_auto: bool) -> Control {
        Control { id: "exposure".into(), min, max, step, default: min, value: min, auto: false, can_auto }
    }

    #[test]
    fn the_allowlist_loads() {
        let ids: Vec<&str> = allowed().iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["exposure", "focus", "zoom", "pan", "tilt", "brightness", "contrast", "saturation", "whiteBalance", "powerline"]);
        assert!(allowed().iter().any(|s| s.id == "powerline" && s.iface == Iface::Proc && s.prop == 13));
    }

    #[test]
    fn the_guard_keeps_to_the_cameras_range_and_step() {
        let c = ctl(-11, -2, 1, true);
        assert!(guard("exposure", &c, -6, false).is_ok());
        assert!(guard("exposure", &c, -1, false).is_err());
        assert!(guard("exposure", &c, 0, true).is_ok(), "auto, the camera has it");
        let wb = ctl(2800, 6500, 10, false);
        assert!(guard("whiteBalance", &wb, 4005, false).is_err(), "off the step");
        assert!(guard("whiteBalance", &wb, 4000, false).is_ok());
        assert!(guard("whiteBalance", &wb, 0, true).is_err(), "no auto on this camera");
        assert!(guard("gain", &wb, 4000, false).is_err(), "not on the list");
        assert!(guard("roll", &wb, 4000, false).is_err());
    }

    /// Lists the cameras attached to this PC (cfgmgr32 only: no camera is opened).
    /// `cargo test --lib webcams::tests::live_list -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_list() {
        for w in list() {
            println!("{} {}:{} {}", w.name, w.vid, w.pid, w.id);
        }
    }

    /// Every uvc line of the TypeScript guard's cases gets the same verdict here.
    #[test]
    fn matches_the_typescript_guard() {
        let mut n = 0;
        for line in include_str!("../../src/lib/displays/display-cases.txt").lines().filter(|l| l.starts_with("uvc ")) {
            let p: Vec<&str> = line.split(' ').collect();
            let c = Control { id: p[1].into(), min: p[2].parse().unwrap(), max: p[3].parse().unwrap(), step: p[4].parse().unwrap(), default: 0, value: 0, auto: false, can_auto: p[5] == "1" };
            let got = guard(p[1], &c, p[6].parse().unwrap(), p[7] == "1");
            assert_eq!(got.is_ok(), p[8] == "1", "{line} -> {got:?}");
            n += 1;
        }
        assert!(n > 300, "{n} cases");
    }

    #[test]
    fn camera_paths_give_ids_and_the_device() {
        let link = r"\\?\usb#vid_0458&pid_6006&mi_00#7&1a3e2012&1&0000#{e5323777-f976-4f5b-9b55-b94699c46e44}\global";
        assert_eq!(ids_of(link), Some(("0458".into(), "6006".into())));
        assert_eq!(instance_of(link).as_deref(), Some(r"USB\VID_0458&PID_6006&MI_00\7&1A3E2012&1&0000"));
        assert_eq!(ids_of(r"\\?\root#camera#0000"), None);
    }
}
