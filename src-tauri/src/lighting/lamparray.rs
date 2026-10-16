//! Windows Dynamic Lighting (wave L4): the LampArray devices Windows lists, what each reports about its lamps, and
//! colours for them. Listing opens nothing; a device is opened when its page asks for its lamps and let go when the page
//! closes or the window loses focus. Windows gives these lights only to the app in front (a background, "ambient"
//! controller must be a packaged app declaring com.microsoft.windows.lighting; SYNQ is unpackaged), and SYNQ
//! checks that itself before every write.
use serde::Serialize;

/// Called with the whole list when a Dynamic Lighting device arrives or leaves.
pub type Emit = std::sync::Arc<dyn Fn(Vec<Device>) + Send + Sync>;

#[derive(Serialize, Clone)]
pub struct Device {
    pub id: String,
    pub name: String,
    /// Windows' LampArrayKind (keyboard, mouse, ...), once read; -1 until then.
    pub kind: i32,
    /// USB ids, from the interface id (or what the device reports once read); empty when unknown.
    pub vid: String,
    pub pid: String,
}

#[cfg_attr(not(windows), allow(dead_code))] // read by the Windows watcher only
/// The USB ids in a HID interface id (`VID_046D&PID_C0A0`, or Bluetooth's `VID&02046D_PID&C0A0`).
pub fn ids_in(id: &str) -> (String, String) {
    let up = id.to_ascii_uppercase();
    let after = |key: &str, skip: usize| up.find(key).map(|i| up[i + key.len() + skip..].chars().take(4).collect::<String>().to_ascii_lowercase());
    let vid = after("VID_", 0).or_else(|| after("VID&", 2));
    let pid = after("PID_", 0).or_else(|| after("PID&", 0));
    match (vid, pid) {
        (Some(v), Some(p)) if v.len() == 4 && p.len() == 4 && v.chars().chain(p.chars()).all(|c| c.is_ascii_hexdigit()) => (v, p),
        _ => (String::new(), String::new()),
    }
}

#[cfg_attr(not(windows), allow(dead_code))] // built by the Windows side only
#[derive(Serialize, Clone)]
pub struct Lamp {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub purposes: u32,
}

#[cfg_attr(not(windows), allow(dead_code))] // built by the Windows side only
#[derive(Serialize, Clone)]
pub struct Info {
    pub id: String,
    pub name: String,
    pub kind: i32,
    pub width: f32,
    pub height: f32,
    pub depth: f32,
    pub vid: String,
    pub pid: String,
    pub available: bool,
    pub enabled: bool,
    pub lamps: Vec<Lamp>,
}

/// ASUS devices (Aura, Armoury Crate's lighting, ROG peripherals' lights) are never listed, opened or lit: by the USB
/// vendor in the interface id, the vendor Windows reports once open, or the name.
#[cfg_attr(not(windows), allow(dead_code))] // checked by the Windows side only
pub fn asus(id: &str, name: &str, vendor: Option<u16>) -> bool {
    let id = id.to_ascii_uppercase();
    let name = name.to_ascii_lowercase();
    id.contains("VID_0B05") || id.contains("VID&020B05") || vendor == Some(0x0b05) || ["asus", "aura", "armoury", "rog "].iter().any(|w| name.contains(w)) || name.starts_with("rog")
}

/// A colour for every lamp (three bytes each), or three bytes for the whole device.
#[cfg_attr(not(windows), allow(dead_code))] // built by the Windows side only
pub fn colours_fit(colours: &[u8], lamps: usize) -> Result<(), String> {
    if colours.len() == 3 || (colours.len() == lamps * 3 && lamps > 0) {
        Ok(())
    } else {
        Err(format!("{} colour bytes for {} lamps: one colour, or one per lamp.", colours.len(), lamps))
    }
}

#[cfg(windows)]
mod win {
    use super::{asus, colours_fit, Device, Info, Lamp};
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use windows::core::HSTRING;
    use super::Emit;
    use windows::Devices::Enumeration::{DeviceInformation, DeviceInformationUpdate, DeviceWatcher};
    use windows::Foundation::TypedEventHandler;
    use windows::Devices::Lights::LampArray;
    use windows::UI::Color;

    fn err(what: &str, e: windows::core::Error) -> String {
        format!("{what}: {}", e.message())
    }

    fn open_arrays() -> &'static Mutex<HashMap<String, (LampArray, String)>> {
        static OPEN: OnceLock<Mutex<HashMap<String, (LampArray, String)>>> = OnceLock::new();
        OPEN.get_or_init(|| Mutex::new(HashMap::new()))
    }

    struct Watch {
        watcher: DeviceWatcher,
        users: u32,
    }

    fn watch_state() -> &'static Mutex<Option<Watch>> {
        static W: OnceLock<Mutex<Option<Watch>>> = OnceLock::new();
        W.get_or_init(|| Mutex::new(None))
    }

    fn known() -> &'static Mutex<Vec<Device>> {
        static K: OnceLock<Mutex<Vec<Device>>> = OnceLock::new();
        K.get_or_init(|| Mutex::new(Vec::new()))
    }

    fn current() -> Vec<Device> {
        known().lock().map(|k| k.clone()).unwrap_or_default()
    }

    /// Counts a user of the device watcher (the Devices home, a Dynamic Lighting page) in or out. The watcher runs while
    /// anyone uses it and calls `emit` with the whole list on every arrival and removal; there is no timer.
    pub fn watch(on: bool, emit: Emit) -> Result<Vec<Device>, String> {
        let mut state = watch_state().lock().map_err(|_| "Lighting state poisoned".to_string())?;
        if !on {
            if let Some(w) = state.as_mut() {
                w.users = w.users.saturating_sub(1);
                if w.users == 0 {
                    let _ = w.watcher.Stop();
                    *state = None;
                    if let Ok(mut k) = known().lock() {
                        k.clear();
                    }
                }
            }
            return Ok(Vec::new());
        }
        if let Some(w) = state.as_mut() {
            w.users += 1;
            return Ok(current());
        }
        let selector = LampArray::GetDeviceSelector().map_err(|e| err("Dynamic Lighting", e))?;
        let watcher = DeviceInformation::CreateWatcherAqsFilter(&selector).map_err(|e| err("Dynamic Lighting", e))?;
        let (on_add, on_remove) = (emit.clone(), emit);
        watcher
            .Added(&TypedEventHandler::<DeviceWatcher, DeviceInformation>::new(move |_, info| {
                if let Some(i) = info.as_ref() {
                    let id = i.Id()?.to_string();
                    let (vid, pid) = super::ids_in(&id);
                    let device = Device { id, name: i.Name().map(|n| n.to_string()).unwrap_or_default(), kind: -1, vid, pid };
                    if !asus(&device.id, &device.name, None) {
                        let id = device.id.clone();
                        if let Ok(mut k) = known().lock() {
                            k.retain(|d| d.id != device.id);
                            k.push(device);
                        }
                        on_add(current());
                        // What kind of device it is (for its drawing) and the ids it reports: read once, on its own thread,
                        // then let go. Nothing is set on it.
                        let on_kind = on_add.clone();
                        std::thread::spawn(move || {
                            let Ok(la) = LampArray::FromIdAsync(&HSTRING::from(id.as_str())).and_then(|op| op.join()) else { return };
                            let vendor = la.HardwareVendorId().ok();
                            if let Ok(mut k) = known().lock() {
                                if let Some(d) = k.iter_mut().find(|d| d.id == id) {
                                    d.kind = la.LampArrayKind().map(|k| k.0).unwrap_or(0);
                                    if let (Some(v), Ok(p)) = (vendor, la.HardwareProductId()) {
                                        if v != 0 {
                                            (d.vid, d.pid) = (format!("{v:04x}"), format!("{p:04x}"));
                                        }
                                    }
                                }
                                if asus(&id, "", vendor) {
                                    k.retain(|d| d.id != id);
                                }
                            }
                            on_kind(current());
                        });
                    }
                }
                Ok(())
            }))
            .map_err(|e| err("Dynamic Lighting", e))?;
        watcher
            .Removed(&TypedEventHandler::<DeviceWatcher, DeviceInformationUpdate>::new(move |_, update| {
                if let Some(u) = update.as_ref() {
                    let id = u.Id()?.to_string();
                    if let Ok(mut k) = known().lock() {
                        k.retain(|d| d.id != id);
                    }
                    close(&id);
                    on_remove(current());
                }
                Ok(())
            }))
            .map_err(|e| err("Dynamic Lighting", e))?;
        // Windows raises arrivals and removals only when updates are subscribed to as well.
        watcher.Updated(&TypedEventHandler::<DeviceWatcher, DeviceInformationUpdate>::new(|_, _| Ok(()))).map_err(|e| err("Dynamic Lighting", e))?;
        watcher.Start().map_err(|e| err("Dynamic Lighting", e))?;
        *state = Some(Watch { watcher, users: 1 });
        Ok(current())
    }

    pub fn info(id: &str) -> Result<Info, String> {
        let mut map = open_arrays().lock().map_err(|_| "Lighting state poisoned".to_string())?;
        if !map.contains_key(id) {
            let key = HSTRING::from(id);
            let name = DeviceInformation::CreateFromIdAsync(&key).and_then(|op| op.join()).and_then(|d| d.Name()).map(|n| n.to_string()).unwrap_or_default();
            if asus(id, &name, None) {
                return Err("Refused: SYNQ never touches ASUS lighting.".into());
            }
            let la = LampArray::FromIdAsync(&key).and_then(|op| op.join()).map_err(|e| err("Opening the device", e))?;
            if asus(id, &name, la.HardwareVendorId().ok()) {
                return Err("Refused: SYNQ never touches ASUS lighting.".into());
            }
            map.insert(id.to_string(), (la, name));
        }
        let (la, name) = map.get(id).ok_or("The device closed.")?;
        let count = la.LampCount().map_err(|e| err("Lamp count", e))?.max(0);
        let bounds = la.BoundingBox().map_err(|e| err("Size", e))?;
        let mut lamps = Vec::with_capacity(count as usize);
        for i in 0..count {
            let l = la.GetLampInfo(i).map_err(|e| err("Lamp", e))?;
            let p = l.Position().map_err(|e| err("Lamp position", e))?;
            lamps.push(Lamp { x: p.X, y: p.Y, z: p.Z, purposes: l.Purposes().map(|f| f.0).unwrap_or(0) });
        }
        Ok(Info {
            id: id.to_string(),
            name: name.clone(),
            kind: la.LampArrayKind().map(|k| k.0).unwrap_or(0),
            width: bounds.X,
            height: bounds.Y,
            depth: bounds.Z,
            vid: format!("{:04x}", la.HardwareVendorId().unwrap_or(0)),
            pid: format!("{:04x}", la.HardwareProductId().unwrap_or(0)),
            available: la.IsAvailable().unwrap_or(false),
            enabled: la.IsEnabled().unwrap_or(false),
            lamps,
        })
    }

    pub fn set(id: &str, colours: &[u8]) -> Result<(), String> {
        if !crate::rawmouse::win::ours_in_front() {
            return Err("SYNQ isn't in front: Windows lets only the app in front set these lights.".into());
        }
        let map = open_arrays().lock().map_err(|_| "Lighting state poisoned".to_string())?;
        let (la, _) = map.get(id).ok_or("Open the device's page first.")?;
        let count = la.LampCount().map_err(|e| err("Lamp count", e))?.max(0) as usize;
        colours_fit(colours, count)?;
        let colour = |c: &[u8]| Color { A: 255, R: c[0], G: c[1], B: c[2] };
        if colours.len() == 3 {
            return la.SetColor(colour(colours)).map_err(|e| err("Colour", e));
        }
        let all: Vec<Color> = colours.chunks(3).map(colour).collect();
        let indexes: Vec<i32> = (0..count as i32).collect();
        la.SetColorsForIndices(&all, &indexes).map_err(|e| err("Colours", e))
    }

    pub fn close(id: &str) {
        if let Ok(mut map) = open_arrays().lock() {
            map.remove(id);
        }
    }

    pub fn close_all() {
        if let Ok(mut map) = open_arrays().lock() {
            map.clear();
        }
    }
}

#[cfg(windows)]
pub use win::{close, close_all, info, set, watch};

#[cfg(not(windows))]
mod other {
    use super::{Device, Info};
    const WINDOWS_ONLY: &str = "Dynamic Lighting is a Windows feature.";
    pub fn watch(_: bool, _: super::Emit) -> Result<Vec<Device>, String> {
        Ok(Vec::new())
    }
    pub fn info(_: &str) -> Result<Info, String> {
        Err(WINDOWS_ONLY.into())
    }
    pub fn set(_: &str, _: &[u8]) -> Result<(), String> {
        Err(WINDOWS_ONLY.into())
    }
    pub fn close(_: &str) {}
    pub fn close_all() {}
}

#[cfg(not(windows))]
pub use other::{close, close_all, info, set, watch};

#[cfg(test)]
mod tests {
    use super::{asus, colours_fit, ids_in};

    #[test]
    fn asus_lighting_is_never_listed() {
        assert!(asus(r"\\?\HID#VID_0B05&PID_19B6&MI_02#8&1", "", None));
        assert!(asus("x", "AURA LED Controller", None));
        assert!(asus("x", "ROG Falchion Ace HFX", None));
        assert!(asus("x", "Keyboard", Some(0x0b05)));
        assert!(!asus(r"\\?\HID#VID_046D&PID_C0A0", "PRO X 2 DEX", Some(0x046d)));
        assert!(!asus("x", "Progressive strip", None), "a word that only starts like ROG");
    }

    #[test]
    fn usb_ids_from_the_interface_id() {
        assert_eq!(ids_in(r"\?\HID#VID_046D&PID_C0A0&MI_02#8&1"), ("046d".into(), "c0a0".into()));
        assert_eq!(ids_in(r"\?\HID#{00001812-0000-1000-8000-00805f9b34fb}_Dev_VID&02046d_PID&b023_REV&0007"), ("046d".into(), "b023".into()));
        assert_eq!(ids_in("SWD#something"), (String::new(), String::new()));
    }

    #[test]
    fn one_colour_or_one_per_lamp() {
        assert!(colours_fit(&[1, 2, 3], 87).is_ok());
        assert!(colours_fit(&[0; 261], 87).is_ok());
        assert!(colours_fit(&[0; 6], 87).is_err());
        assert!(colours_fit(&[], 0).is_err());
    }
}
