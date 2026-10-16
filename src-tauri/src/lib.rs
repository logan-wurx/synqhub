mod advanced;
mod brand_ids;
mod brands;
// Game controllers: the id table (generated) and what the bridge may open and send (src/pads.rs).
#[allow(dead_code)]
mod controller_ids;
// Apps that also drive controllers (warnings only: their names are read, nothing else).
mod conflicts;
mod devices;
// The EQ engine: Equalizer APO on Windows (src/engine), PipeWire's filter-chain elsewhere (src/pipewire).
#[cfg(windows)]
mod engine;
#[cfg(not(windows))]
#[path = "pipewire/mod.rs"]
mod engine;
mod eq;
// SYNQ's EQ as a PipeWire filter-chain (the Linux EQ engine): pure, tested on every OS.
#[cfg_attr(windows, allow(dead_code))]
mod eq_graph;
// Shared with SYNQ Helper (src-tauri/helper), which uses the parts the app doesn't.
#[allow(dead_code)]
mod games;
// Gaming headsets: the models and the frame guard the brand channels use (src/brands.rs).
mod headsets;
// Plug and unplug notifications, so the device list needn't be polled.
mod hotplug;
#[allow(dead_code)]
mod helper_cfg;
mod hid;
// Shared hidraw nodes (Linux): which collections and report ids one node may use. Pure; tested everywhere.
#[cfg_attr(windows, allow(dead_code))]
mod hid_plan;
mod library;
// Monitors over DDC/CI (read; allowlisted writes) and their EDID.
mod monitors;
// Webcams over UVC through Media Foundation (read; allowlisted writes; no capture).
mod webcams;
mod lighting;
mod openmouse_ids;
mod pads;
// The checkup's mouse timings (Windows Raw Input, listen only).
mod rawmouse;
// The G7 SE's GIP settings bodies and their guard (tests, and the C4 spike behind the `gip-spike` feature).
#[cfg(any(test, all(windows, feature = "gip-spike")))]
mod gip_g7se;
#[cfg(all(windows, feature = "gip-spike"))]
#[cfg_attr(not(test), allow(dead_code))]
mod gip_spike;
// `--self-test`: the HID layer, the device tables and the EQ engine's detection, without a window.
mod selftest;
mod sleep;
// XInput pads (Windows): read-only slots, state, battery and the tester's sampler.
#[cfg_attr(not(windows), allow(dead_code))]
mod xinput;
// The udev rule for Linux device access, generated from the same device tables as the bridge.
#[allow(dead_code)]
mod udev;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupInfo {
    path: String,
    modified: u64,
}

fn data_dir(app: &AppHandle, sub: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(sub);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

use eq::{ApplyResult, EqSnapshot, config_file, inside};

/// The Equalizer APO Configuration Editor, left open, rewrites config.txt from its own stale
/// copy the next time it is touched, silently undoing changes made elsewhere.
#[cfg(not(windows))]
fn eapo_editor_open() -> bool {
    false
}

#[cfg(windows)]
fn eapo_editor_open() -> bool {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );
    sys.processes().values().any(|p| {
        p.name().eq_ignore_ascii_case("Editor.exe")
            && p.exe().is_none_or(|e| e.to_string_lossy().to_ascii_lowercase().contains("equalizerapo"))
    })
}

#[tauri::command]
fn eq_load() -> Result<EqSnapshot, String> {
    Ok(eq::snapshot(eapo_editor_open()))
}

/// Saves `state`. With `bypass`, Equalizer APO gets it with every filter off at 0 dB preamp, and
/// the real EQ stays recoverable from the same file.
#[cfg(windows)]
#[tauri::command]
fn eq_apply(app: AppHandle, state: eq::EqState, bypass: bool) -> Result<ApplyResult, String> {
    eq::apply(&state, bypass, &data_dir(&app, "eq-backups")?)
}

/// Linux: the same save, then the running PipeWire EQ takes it live. What PipeWire would really play for
/// it passes the peak gate first (`engine::prepare`); nothing is written when it doesn't.
#[cfg(not(windows))]
#[tauri::command]
fn eq_apply(app: AppHandle, state: eq::EqState, bypass: bool) -> Result<ApplyResult, String> {
    let live = engine::prepare(&state, bypass)?;
    let res = eq::apply(&state, bypass, &data_dir(&app, "eq-backups")?)?;
    engine::push(&live, &state, bypass, app_data(&app).ok().as_deref());
    Ok(res)
}

#[tauri::command]
fn eq_presets(app: AppHandle) -> Result<Vec<eq::PresetInfo>, String> {
    Ok(eq::list_presets(&data_dir(&app, "eq-presets")?, &eq::config_dir()))
}

#[tauri::command]
fn eq_preset_read(app: AppHandle, path: String) -> Result<eq::Parsed, String> {
    let p = inside(&path, &[data_dir(&app, "eq-presets")?, eq::config_dir()])?;
    let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    Ok(eq::parse(&text))
}

#[tauri::command]
fn eq_preset_save(app: AppHandle, name: String, state: eq::EqState) -> Result<String, String> {
    eq::validate(&state)?;
    let path = data_dir(&app, "eq-presets")?.join(eq::preset_file_name(&name)?);
    eq::write_atomic(&path, &eq::serialize(&state))?;
    Ok(path.to_string_lossy().into())
}

#[tauri::command]
fn eq_preset_delete(app: AppHandle, path: String) -> Result<(), String> {
    let p = inside(&path, &[data_dir(&app, "eq-presets")?])?;
    std::fs::remove_file(p).map_err(|e| e.to_string())
}

#[tauri::command]
fn eq_backups(app: AppHandle) -> Result<Vec<BackupInfo>, String> {
    let dir = data_dir(&app, "eq-backups")?;
    let mut out: Vec<BackupInfo> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "txt"))
        .map(|p| BackupInfo { modified: eq::modified_secs(&p), path: p.to_string_lossy().into() })
        .collect();
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

/// Puts a backup back exactly as it was, after backing up what is there now.
#[tauri::command]
fn eq_restore_backup(app: AppHandle, path: String) -> Result<ApplyResult, String> {
    let backups = data_dir(&app, "eq-backups")?;
    let src = inside(&path, &[backups.clone()])?;
    let text = std::fs::read_to_string(&src).map_err(|e| e.to_string())?;
    let target = config_file();
    #[cfg(not(windows))]
    let parsed = eq::parse(&text);
    #[cfg(not(windows))]
    let live = engine::prepare(&parsed.state, parsed.bypassed)?;
    let backup = eq::backup(&target, &backups)?;
    eq::write_atomic(&target, &text)?;
    #[cfg(not(windows))]
    engine::push(&live, &parsed.state, parsed.bypassed, app_data(&app).ok().as_deref());
    Ok(ApplyResult {
        peak_db: eq::peak_db(&eq::parse(&text).state),
        backup: backup.map(|b| b.to_string_lossy().into()),
        modified: eq::modified_secs(&target),
    })
}

#[tauri::command]
fn devices_list() -> Result<Vec<devices::Connected>, String> {
    let mut list = devices::list()?;
    // XInput pads (Xbox 360 class and Xbox One class) aren't HID pads: XInput's slots list them (read only).
    for (s, (vid, pid)) in xinput_identities(&xinput::slots(), &xinput::usb_xinput_pads()) {
        if listed_as_hid(&list, vid, pid) {
            continue;
        }
        list.push(devices::xinput_pad(s.slot, vid, pid, s.wireless, s.battery));
    }
    // Monitors (EDID from the registry) and webcams (their interface paths): listed only, nothing opened.
    list.extend(monitors::list().iter().map(monitors::Monitor::entry));
    list.extend(webcams::list().iter().map(webcams::Webcam::entry));
    // USB RGB hubs (and devices SYNQ only names, like the Nautilus LCD Cap): listed from HID enumeration, not opened.
    list.extend(lighting::hidrgb::list().into_iter().map(lighting::hidrgb::Listed::entry));
    Ok(list)
}



/// A monitor's or webcam's settings as they were before SYNQ's first change (its backup), in app data.
#[tauri::command]
fn display_backup_save(app: AppHandle, json: String, prefix: String) -> Result<String, String> {
    let path = data_dir(&app, "display-backups")?.join(format!("{}-{}.json", safe_name(&prefix, "display"), eq::now_secs()));
    eq::write_atomic(&path, &json)?;
    Ok(path.to_string_lossy().into())
}

/// A monitor's DDC/CI capabilities string, read (slow on some monitors: ~1 s).
#[tauri::command]
async fn monitor_caps(id: String) -> Result<monitors::Caps, String> {
    tauri::async_runtime::spawn_blocking(move || monitors::capabilities(&id)).await.map_err(|e| e.to_string())?
}

/// Current values of allowlisted (and read-only) VCP codes.
#[tauri::command]
async fn monitor_read(id: String, codes: Vec<u8>) -> Result<Vec<monitors::Reading>, String> {
    tauri::async_runtime::spawn_blocking(move || monitors::read(&id, &codes)).await.map_err(|e| e.to_string())?
}

/// Sets one allowlisted VCP code (the input source only with `confirm`) and reads it back.
#[tauri::command]
async fn monitor_write(id: String, code: u8, value: u32, confirm: bool) -> Result<monitors::Reading, String> {
    tauri::async_runtime::spawn_blocking(move || monitors::write(&id, code, value, confirm)).await.map_err(|e| e.to_string())?
}

/// A webcam's allowlisted controls: ranges and current values (the camera is opened, never started: nothing captured).
#[tauri::command]
async fn webcam_controls(id: String) -> Result<Vec<webcams::Control>, String> {
    tauri::async_runtime::spawn_blocking(move || webcams::controls(&id)).await.map_err(|e| e.to_string())?
}

/// Sets one allowlisted webcam control (inside its range, or to auto) and reads it back.
#[tauri::command]
async fn webcam_set(id: String, control: String, value: i32, auto: bool) -> Result<webcams::Control, String> {
    tauri::async_runtime::spawn_blocking(move || webcams::set(&id, &control, value, auto)).await.map_err(|e| e.to_string())?
}

/// A pad already listed through its HID interface (a GameSir pad's settings channel next to its XInput interface) is
/// listed once, as that HID pad: its tester reads the pad's own state report there.
fn listed_as_hid(list: &[devices::Connected], vid: u16, pid: u16) -> bool {
    let (v, p) = (format!("{vid:04x}"), format!("{pid:04x}"));
    list.iter().any(|d| d.kind == "controller" && d.vid == v && d.pid == p && d.pad.as_ref().is_some_and(|x| x.via == "hid"))
}

/// Which pad each XInput slot is. XInput gives Windows' own ids for most pads (xboxgip's 045E:02FF for every Xbox
/// One-class pad); a slot like that becomes the one USB pad of its class Windows lists as present, when there is
/// exactly one such slot and one such pad. Otherwise it keeps Windows' id and is named as a generic Xbox pad.
fn xinput_identities(slots: &[xinput::Slot], usb: &[(u16, u16)]) -> Vec<(xinput::Slot, (u16, u16))> {
    let class = |id: (u16, u16)| pads::entry(id.0, id.1).map(|(_, t)| t);
    let shim_class = |id: (u16, u16)| match id {
        (0x045e, 0x02ff) => Some(2u8), // xboxgip: GIP
        (0x045e, 0x02a1) => Some(1u8), // xusb22: XUSB
        _ => None,
    };
    let named: Vec<(u16, u16)> = slots.iter().map(|s| (s.vid, s.pid)).filter(|&id| shim_class(id).is_none()).collect();
    slots
        .iter()
        .map(|s| {
            let id = (s.vid, s.pid);
            let Some(t) = shim_class(id) else { return (s.clone(), id) };
            let same_class_slots = slots.iter().filter(|o| shim_class((o.vid, o.pid)) == Some(t)).count();
            let candidates: Vec<(u16, u16)> = usb.iter().copied().filter(|&u| class(u) == Some(t) && !named.contains(&u)).collect();
            if same_class_slots == 1 && candidates.len() == 1 { (s.clone(), candidates[0]) } else { (s.clone(), id) }
        })
        .collect()
}

/// Apps running now that also drive controllers (a warning on the Controllers page; nothing is done to them).
#[tauri::command]
fn pads_conflicts() -> Vec<conflicts::Conflict> {
    conflicts::running()
}

#[tauri::command]
fn xinput_slots() -> Vec<xinput::Slot> {
    xinput::slots()
}

#[tauri::command]
fn xinput_read(slot: u32) -> Option<xinput::Reading> {
    xinput::read(slot)
}

/// Samples an XInput pad for the tester (at most 8 s; stops when the window loses focus). Batches arrive as
/// "xinput-batch" events. Read only.
#[tauri::command]
fn xinput_sample(app: AppHandle, slot: u32, seconds: f64) -> Result<(), String> {
    xinput::sample(slot, seconds, std::sync::Arc::new(move |b| {
        let _ = app.emit("xinput-batch", b);
    }))
}

#[tauri::command]
fn xinput_stop() {
    xinput::stop();
}

/// The checkup's mouse timings: every mouse's button transitions (and motion, with `motion`) with the time each report
/// arrived, for at most 45 s, only while SYNQ is focused. Listen only: nothing is sent to a device.
#[tauri::command]
async fn mouse_sample(window: WebviewWindow, seconds: f64, motion: bool) -> Result<rawmouse::RawMouseRun, String> {
    // The reports come to the main window (rawmouse.rs says why), so the run needs its handle and its thread.
    #[cfg(windows)]
    let target = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    #[cfg(not(windows))]
    let target = 0isize;
    tauri::async_runtime::spawn_blocking(move || rawmouse::sample(target, seconds, motion, &|job| window.run_on_main_thread(job).is_ok())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn mouse_sample_stop() {
    rawmouse::stop();
}

/// The window's focus changes: losing it stops XInput sampling at once, and a game controller the page left open
/// is stopped and closed a moment later (the page closes its own on blur; this is the backstop).
fn on_focus(app: &AppHandle, focused: bool) {
    static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let generation = GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    xinput::set_focused(focused);
    rawmouse::set_focused(focused);
    if focused {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        if GENERATION.load(std::sync::atomic::Ordering::SeqCst) != generation {
            return;
        }
        for key in hid::release_pads(&app.state::<hid::HidState>()) {
            let _ = app.emit("hid-lost", LostDevice { key: &key });
        }
        // RGB hubs and Dynamic Lighting devices are let go of as well (their pages open them again).
        lighting::hidrgb::close_all();
        lighting::lamparray::close_all();
        // Lamps too: a connection lasts only while their page is open and focused.
        for id in lighting::govee::close_all() {
            let _ = app.emit("light-lost", LightLost { id: &id, why: "The window lost focus." });
        }
    });
}

#[derive(Clone, serde::Serialize)]
struct LightReport<'a> {
    id: &'a str,
    frame: &'a [u8],
}

#[derive(Clone, serde::Serialize)]
struct LightLost<'a> {
    id: &'a str,
    why: &'a str,
}

#[derive(Clone, serde::Serialize)]
struct LightSync<'a> {
    id: &'a str,
    colours: &'a [[u8; 3]],
    blind: bool,
}

/// An open lamp's events, as the frontend hears them.
fn light_events(app: AppHandle) -> lighting::govee::Emit {
    std::sync::Arc::new(move |e| match e {
        lighting::govee::Event::Report { id, frame } => {
            let _ = app.emit("light-report", LightReport { id: &id, frame: &frame });
        }
        lighting::govee::Event::Lost { id, why } => {
            let _ = app.emit("light-lost", LightLost { id: &id, why: &why });
        }
        lighting::govee::Event::Sync { id, colours, blind } => {
            let _ = app.emit("light-sync", LightSync { id: &id, colours: &colours, blind });
        }
        lighting::govee::Event::SyncStopped { id, why } => {
            let _ = app.emit("light-sync-stopped", LightLost { id: &id, why: &why });
        }
    })
}

/// Starts the plug and unplug notifications ("devices-changed" after each settled burst). False where there are
/// none (not Windows, or Windows refused): the frontend then polls the device list.
#[tauri::command]
fn hotplug_watch(app: AppHandle) -> bool {
    hotplug::start(Box::new(move || {
        let _ = app.emit("devices-changed", ());
    }))
}

/// Dynamic Lighting: counts the asker in (or out) of the LampArray device watcher and returns the devices known now;
/// "lamparray-changed" carries the list on every arrival and removal. Nothing is opened.
#[tauri::command]
fn lamparray_watch(app: AppHandle, on: bool) -> Result<Vec<lighting::lamparray::Device>, String> {
    let emit: lighting::lamparray::Emit = std::sync::Arc::new(move |list| {
        let _ = app.emit("lamparray-changed", list);
    });
    lighting::lamparray::watch(on, emit)
}

/// Opens one LampArray device (kept open until lamparray_close) and reads its lamps.
#[tauri::command]
async fn lamparray_info(id: String) -> Result<lighting::lamparray::Info, String> {
    tauri::async_runtime::spawn_blocking(move || lighting::lamparray::info(&id)).await.map_err(|e| e.to_string())?
}

/// Colours for an open LampArray device (one, or one per lamp); only while SYNQ is the window in front.
#[tauri::command]
fn lamparray_set(id: String, colors: Vec<u8>) -> Result<(), String> {
    lighting::lamparray::set(&id, &colors)
}

#[tauri::command]
fn lamparray_close(id: String) {
    lighting::lamparray::close(&id);
}

/// One report to a USB RGB hub, after the hub guard (src/lighting/hidrgb.rs).
#[tauri::command]
fn rgbhub_write(vid: String, pid: String, report_id: u8, data: Vec<u8>) -> Result<&'static str, String> {
    lighting::hidrgb::write(&vid, &pid, report_id, &data)
}

/// The next input report from an open hub (its id first), or null after `timeout_ms`.
#[tauri::command]
async fn rgbhub_read(vid: String, pid: String, timeout_ms: i32) -> Result<Option<Vec<u8>>, String> {
    tauri::async_runtime::spawn_blocking(move || lighting::hidrgb::read(&vid, &pid, timeout_ms)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn rgbhub_close(vid: String, pid: String) {
    lighting::hidrgb::close(&vid, &pid);
}

/// The Govee lamps the Bluetooth scan heard recently (the scan runs while this is asked for, and stops after).
#[tauri::command]
async fn lights_list() -> Result<Vec<lighting::govee::Lamp>, String> {
    tauri::async_runtime::spawn_blocking(lighting::govee::list).await.map_err(|e| e.to_string())
}

/// Connects to a lamp (its page opened): encryption detection, handshake, then its reports as "light-report" events.
#[tauri::command]
async fn light_open(app: AppHandle, id: String) -> Result<lighting::govee::Opened, String> {
    let emit = light_events(app);
    tauri::async_runtime::spawn_blocking(move || lighting::govee::open(&id, emit)).await.map_err(|e| e.to_string())?
}

/// Single frames to an open lamp; each is checked by the lighting guard first.
#[tauri::command]
async fn light_send(id: String, frames: Vec<Vec<u8>>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || lighting::govee::send(&id, &frames)).await.map_err(|e| e.to_string())?
}

/// A checked upload (a catalogue scene's data, or a DIY effect), framed and paced by the bridge.
#[tauri::command]
async fn light_upload(id: String, kind: String, body: Vec<u8>, code: Option<u16>) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || lighting::govee::upload(&id, &kind, &body, code)).await.map_err(|e| e.to_string())?
}

/// Finds the Wi-Fi lights on the local network: asks for about 1.5 s, only when the person presses "Find lights"
/// (never in the background); lists every one found this session.
#[tauri::command]
async fn net_lights_find() -> Result<Vec<lighting::net::NetLight>, String> {
    tauri::async_runtime::spawn_blocking(lighting::net::find).await.map_err(|e| e.to_string())
}

#[derive(serde::Serialize, Clone)]
struct NetSyncColours<'a> {
    keys: &'a [String],
    colours: &'a [[u8; 3]],
    blind: bool,
}

#[derive(serde::Serialize, Clone)]
struct NetSyncNote<'a> {
    key: Option<&'a str>,
    why: &'a str,
}

/// Screen sync across Wi-Fi lights (wave L5): the colours as "net-sync", a light let go as "net-sync-dropped", the end as
/// "net-sync-stopped". It runs until Stop, a lock, sleep, a display change or every light dropping.
#[tauri::command]
fn net_sync_start(app: AppHandle, members: Vec<lighting::sync::Member>, edge: String, vivid: bool, monitor: Option<String>, area: Option<lighting::sync::HueArea>) -> Result<(), String> {
    let edge = lighting::screen::Edge::parse(&edge).ok_or("An edge is left, right, both or full.")?;
    let emit: lighting::sync::Emit = std::sync::Arc::new(move |e| match e {
        lighting::sync::Event::Colours { keys, colours, blind } => {
            let _ = app.emit("net-sync", NetSyncColours { keys: &keys, colours: &colours, blind });
        }
        lighting::sync::Event::Dropped { key, why } => {
            let _ = app.emit("net-sync-dropped", NetSyncNote { key: Some(&key), why: &why });
        }
        lighting::sync::Event::Stopped { why } => {
            let _ = app.emit("net-sync-stopped", NetSyncNote { key: None, why: &why });
        }
    });
    lighting::sync::start(members, edge, vivid, monitor, area, emit)
}

#[tauri::command]
fn net_sync_stop() {
    lighting::sync::stop();
}

#[tauri::command]
fn net_sync_state() -> Option<lighting::sync::Running> {
    lighting::sync::running()
}

/// A Hue bridge's Entertainment areas (SYNQ's own marked).
#[tauri::command]
async fn hue_areas(bridge: String) -> Result<Vec<lighting::net::hue::Area>, String> {
    tauri::async_runtime::spawn_blocking(move || lighting::net::hue::areas(&bridge)).await.map_err(|e| e.to_string())?
}

/// Makes SYNQ's Entertainment area on a bridge (the person confirmed what changes) and records its number.
#[tauri::command]
async fn hue_area_create(bridge: String, lights: Vec<String>) -> Result<lighting::net::hue::Area, String> {
    tauri::async_runtime::spawn_blocking(move || lighting::net::hue::create(&bridge, &lights)).await.map_err(|e| e.to_string())?
}

/// Removes the area SYNQ made on a bridge, and only that one.
#[tauri::command]
async fn hue_area_remove(bridge: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || lighting::net::hue::remove(&bridge)).await.map_err(|e| e.to_string())?
}

/// Pairs with a Wi-Fi light that takes a key (Hue after its link button, Nanoleaf after its power-button hold).
#[tauri::command]
async fn net_light_pair(brand: String, id: String) -> Result<(), String> {
    let pc = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || lighting::net::pair(&brand, &id, &pc)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn net_light_forget(brand: String, id: String) -> Result<(), String> {
    lighting::net::forget(&brand, &id)
}

/// One message to a Wi-Fi light, checked by the lighting guard first; the light's answer.
#[tauri::command]
async fn net_light_send(brand: String, id: String, message: lighting::net::guard::NetMessage) -> Result<lighting::net::Reply, String> {
    tauri::async_runtime::spawn_blocking(move || lighting::net::send(&brand, &id, &message)).await.map_err(|e| e.to_string())?
}

/// Screen sync on an open lamp (src/lighting/screen.rs): it runs in the bridge until stopped, and keeps the lamp open
/// while it runs, even without its page.
#[tauri::command]
async fn light_sync_start(app: AppHandle, id: String, edge: String, vivid: bool, monitor: Option<String>) -> Result<lighting::govee::SyncInfo, String> {
    let emit = light_events(app);
    tauri::async_runtime::spawn_blocking(move || lighting::govee::sync_start(&id, &edge, vivid, monitor, emit)).await.map_err(|e| e.to_string())?
}

/// The displays screen sync can read, named and sized as Windows reports them, primary first.
#[tauri::command]
fn screen_monitors() -> Vec<lighting::screen::Monitor> {
    lighting::screen::monitors()
}

#[tauri::command]
fn light_sync_stop(id: String) {
    lighting::govee::sync_stop(&id);
}

#[tauri::command]
fn light_close(id: String) {
    lighting::govee::close(&id);
}


#[tauri::command]
async fn hid_list(state: State<'_, hid::HidState>) -> Result<Vec<hid::Summary>, String> {
    hid::list(&state)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InputReport<'a> {
    key: &'a str,
    report_id: u8,
    usage_page: u16,
    usage: u16,
    data: &'a [u8],
}

#[derive(Serialize, Clone)]
struct LostDevice<'a> {
    key: &'a str,
}

/// A game controller's input reports, each with the time the bridge read it (src/hid.rs `PadReport`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PadBatch<'a> {
    key: &'a str,
    usage_page: u16,
    usage: u16,
    reports: &'a [hid::PadReport],
}

#[tauri::command]
async fn hid_open(app: AppHandle, state: State<'_, hid::HidState>, key: String) -> Result<(), String> {
    let emit: hid::Emit = std::sync::Arc::new(move |event| match event {
        hid::HidEvent::Input { key, report_id, usage_page, usage, data } => {
            let _ = app.emit("hid-input", InputReport { key, report_id, usage_page, usage, data });
        }
        hid::HidEvent::Pad { key, usage_page, usage, reports } => {
            let _ = app.emit("hid-input-batch", PadBatch { key, usage_page, usage, reports });
        }
        hid::HidEvent::Lost { key } => {
            let _ = app.emit("hid-lost", LostDevice { key });
        }
    });
    hid::open_with(&state, &key, emit)
}


#[tauri::command]
async fn hid_close(state: State<'_, hid::HidState>, key: String) -> Result<(), String> {
    hid::close(&state, &key)
}

#[tauri::command]
async fn hid_send_report(state: State<'_, hid::HidState>, key: String, report_id: u8, data: Vec<u8>) -> Result<(), String> {
    hid::send_report(&state, &key, report_id, &data)
}

/// Output report to one named collection (the keyboard's vendor channel is FF00:0001, report id 0).
#[tauri::command]
async fn hid_send_report_to(
    state: State<'_, hid::HidState>,
    key: String,
    usage_page: u16,
    usage: u16,
    report_id: u8,
    data: Vec<u8>,
) -> Result<(), String> {
    hid::send_report_to(&state, &key, usage_page, usage, report_id, &data)
}

#[tauri::command]
async fn hid_send_feature_report(state: State<'_, hid::HidState>, key: String, report_id: u8, data: Vec<u8>) -> Result<(), String> {
    hid::send_feature_report(&state, &key, report_id, &data)
}

#[tauri::command]
async fn hid_receive_feature_report(state: State<'_, hid::HidState>, key: String, report_id: u8) -> Result<Vec<u8>, String> {
    hid::receive_feature_report(&state, &key, report_id)
}

/// The person's confirmation for one Advanced action, as the panel collected it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdvancedAck {
    acknowledged: bool,
    typed: Option<String>,
}

/// Unlocks one Advanced action (pair, remap, macros, calibrate, reset) on an open device, for a few
/// minutes at most, after the panel's confirmation step (a tick, and for a reset the word RESET).
/// Sends nothing to the device. Returns how many milliseconds the grant lasts. Firmware, bootloader and
/// DFU commands have no action to unlock.
#[tauri::command]
async fn hid_advanced_grant(state: State<'_, hid::HidState>, key: String, scope: String, ack: AdvancedAck, scheme: Option<String>) -> Result<u64, String> {
    hid::advanced_grant(&state, &key, &scope, advanced::Ack { acknowledged: ack.acknowledged, typed: ack.typed }, scheme.as_deref())
}

/// Ends one Advanced grant, or all of them with scope "all".
#[tauri::command]
async fn hid_advanced_revoke(state: State<'_, hid::HidState>, key: String, scope: String) -> Result<(), String> {
    hid::advanced_revoke(&state, &key, &scope)
}

/// Which Advanced actions are unlocked on a device right now.
#[tauri::command]
async fn hid_advanced_status(state: State<'_, hid::HidState>, key: String) -> Result<Vec<&'static str>, String> {
    hid::advanced_status(&state, &key)
}

/// Keeps a copy of a mouse's settings before SYNQ first changes them. `prefix` names the file
/// (letters, digits and dashes only); the Logitech service leaves it out and gets `profiles-`.
#[tauri::command]
fn mouse_backup_save(app: AppHandle, json: String, prefix: Option<String>) -> Result<String, String> {
    let clean: String = prefix.unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect();
    let name = if clean.is_empty() { "profiles".to_string() } else { clean };
    let path = data_dir(&app, "mouse-backups")?.join(format!("{name}-{}.json", eq::now_secs()));
    eq::write_atomic(&path, &json)?;
    Ok(path.to_string_lossy().into())
}

/// Saves a controller's diagnostics bundle (descriptor, a few seconds of input reports, the allowlisted reads; the
/// page has already taken out any Bluetooth address) as `controllers/<name>-<time>.json`. Returns the path.
#[tauri::command]
fn pad_diagnostics_save(app: AppHandle, name: String, json: String) -> Result<String, String> {
    let clean: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(48).collect();
    let name = if clean.is_empty() { "controller".to_string() } else { clean };
    let path = data_dir(&app, "controllers")?.join(format!("{name}-diag-{}.json", eq::now_secs()));
    eq::write_atomic(&path, &json)?;
    Ok(path.to_string_lossy().into())
}

/// Keeps a copy of everything SYNQ read from a controller before its first change (a DualSense Edge's four profile
/// slots, wave C2) as `controllers/backups/<prefix>-<time>.json`. Returns the path.
#[tauri::command]
fn pad_backup_save(app: AppHandle, json: String, prefix: String) -> Result<String, String> {
    let path = data_dir(&app, "controllers")?.join("backups").join(format!("{}-{}.json", safe_name(&prefix, "controller"), eq::now_secs()));
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    eq::write_atomic(&path, &json)?;
    Ok(path.to_string_lossy().into())
}

/// Appends to the log of what the generic (OpenMouse) mouse panel wrote and what it read back.
/// `prefix` names the file like `mouse_backup_save`. Rolls over at 1 MB, keeping one old file.
#[tauri::command]
fn mouse_log(app: AppHandle, prefix: String, lines: Vec<String>) -> Result<(), String> {
    use std::io::Write;
    let clean: String = prefix.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect();
    let name = if clean.is_empty() { "mouse".to_string() } else { clean };
    let path = data_dir(&app, "mouse-backups")?.join(format!("{name}-log.txt"));
    if std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("old.txt"));
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    for line in lines {
        writeln!(f, "{line}").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A file-name-safe name: letters, digits and dashes only (so it can't leave its folder), at most 60.
fn safe_name(raw: &str, fallback: &str) -> String {
    let clean: String = raw.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(60).collect();
    if clean.is_empty() { fallback.to_string() } else { clean }
}

/// Keeps a copy of everything the generic Keyboard panel read from a keyboard before its first change
/// (src/lib/kb/session.ts). `prefix` names the file.
#[tauri::command]
fn kb_backup_save(app: AppHandle, json: String, prefix: String) -> Result<String, String> {
    let path = data_dir(&app, "keyboard-backups")?.join(format!("{}-{}.json", safe_name(&prefix, "keyboard"), eq::now_secs()));
    eq::write_atomic(&path, &json)?;
    Ok(path.to_string_lossy().into())
}

/// Appends to the generic Keyboard panel's log of what it wrote and read back. Rolls over at 1 MB.
#[tauri::command]
fn kb_log(app: AppHandle, prefix: String, lines: Vec<String>) -> Result<(), String> {
    use std::io::Write;
    let path = data_dir(&app, "keyboard-backups")?.join(format!("{}-log.txt", safe_name(&prefix, "keyboard")));
    if std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("old.txt"));
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    for line in lines {
        writeln!(f, "{line}").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// VIA keyboard definitions are fetched once from usevia.app (src/lib/kb/via/definitions.ts) and kept
/// here, so a board is drawn offline after its first connect. `key` is e.g. "v3-1077979750".
const DEFINITION_MAX_BYTES: usize = 2_000_000;

#[tauri::command]
fn kb_definition_load(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let path = data_dir(&app, "via-definitions")?.join(format!("{}.json", safe_name(&key, "definition")));
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

#[tauri::command]
fn kb_definition_save(app: AppHandle, key: String, json: String) -> Result<(), String> {
    if json.len() > DEFINITION_MAX_BYTES {
        return Err("That keyboard definition is too large to keep.".into());
    }
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("Not a keyboard definition: {e}"))?;
    eq::write_atomic(&data_dir(&app, "via-definitions")?.join(format!("{}.json", safe_name(&key, "definition"))), &json)
}

/// File name for a keyboard's serial: letters, digits and dashes only, so it can't leave the folder.
fn keyboard_file(app: &AppHandle, serial: &str, suffix: &str) -> Result<PathBuf, String> {
    let clean: String = serial.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect();
    let name = if clean.is_empty() { "unknown".to_string() } else { clean };
    Ok(data_dir(app, "keyboard")?.join(format!("{name}{suffix}")))
}

/// SYNQ's copy of the keyboard's settings (the keyboard can't report most of them).
#[tauri::command]
fn keyboard_state_load(app: AppHandle, serial: String) -> Result<Option<String>, String> {
    let path = keyboard_file(&app, &serial, ".json")?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

#[tauri::command]
fn keyboard_state_save(app: AppHandle, serial: String, json: String) -> Result<(), String> {
    eq::write_atomic(&keyboard_file(&app, &serial, ".json")?, &json)
}

/// Appends to the log of every report SYNQ sent the keyboard and what came back, so what the
/// app does to the keyboard can always be checked. Rolls over at 1 MB, keeping one old file.
#[tauri::command]
fn keyboard_log(app: AppHandle, serial: String, lines: Vec<String>) -> Result<(), String> {
    use std::io::Write;
    let path = keyboard_file(&app, &serial, "-hid-log.txt")?;
    if std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("old.txt"));
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    for line in lines {
        writeln!(f, "{line}").map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---- EQ engine (see src/engine and docs/eq-engine.md)

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Read-only: is the engine installed, which outputs have it, is it on the default output.
#[tauri::command]
async fn eq_engine_status(app: AppHandle) -> Result<engine::Status, String> {
    let data = app_data(&app).ok();
    tauri::async_runtime::spawn_blocking(move || engine::status(data.as_deref())).await.map_err(|e| e.to_string())
}

/// Runs the elevated helper (one Windows prompt over this window) and waits for it.
#[cfg(windows)]
async fn engine_elevated(app: AppHandle, window: WebviewWindow, command: &'static str, extra: Vec<String>) -> Result<engine::Outcome, String> {
    let data = app_data(&app)?;
    let owner = window.hwnd().ok().map(|h| h.0 as isize);
    tauri::async_runtime::spawn_blocking(move || engine::run_elevated(&data, command, &extra, owner)).await.map_err(|e| e.to_string())?
}

/// Linux: PipeWire's engine needs no prompt; setup restarts PipeWire for this login the first time.
#[cfg(not(windows))]
async fn engine_elevated(app: AppHandle, _window: WebviewWindow, command: &'static str, extra: Vec<String>) -> Result<engine::Outcome, String> {
    let data = app_data(&app)?;
    let output = extra.iter().position(|a| a == "--output").and_then(|i| extra.get(i + 1)).cloned();
    tauri::async_runtime::spawn_blocking(move || engine::run(&data, command, output)).await.map_err(|e| e.to_string())?
}

/// Puts the engine on `output` (default: the current default output), or repairs it there.
#[tauri::command]
async fn eq_engine_setup(app: AppHandle, window: WebviewWindow, output: Option<String>) -> Result<engine::Outcome, String> {
    let mut extra = Vec::new();
    if let Some(o) = output {
        extra = vec!["--output".into(), engine::output_id(&o).ok_or("That isn't a sound output id.")?];
    }
    engine_elevated(app, window, "setup", extra).await
}

/// Installs the engine (bundled installer, or the official download) and sets it up on the
/// default output.
#[tauri::command]
async fn eq_engine_install(app: AppHandle, window: WebviewWindow) -> Result<engine::Outcome, String> {
    engine_elevated(app, window, "install", Vec::new()).await
}

/// Puts back what the last setup changed.
#[tauri::command]
async fn eq_engine_undo(app: AppHandle, window: WebviewWindow) -> Result<engine::Outcome, String> {
    engine_elevated(app, window, "undo", Vec::new()).await
}

/// What the person calls the headphones on one output of this PC, and whether to show the IEM
/// picture for it. Kept per PC in app data, so nothing about one PC's gear shows on another.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct SoundName {
    name: String,
    picture: Option<String>,
}

const SOUND_NAMES_FILE: &str = "sound-names.json";
const PICTURES: [&str; 1] = ["iems"];

fn read_sound_names(app: &AppHandle) -> Result<BTreeMap<String, SoundName>, String> {
    let path = app_data(app)?.join(SOUND_NAMES_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_default()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

#[tauri::command]
fn sound_names_load(app: AppHandle) -> Result<BTreeMap<String, SoundName>, String> {
    read_sound_names(&app)
}

/// Names the headphones on `output`. An empty name forgets it.
#[tauri::command]
fn sound_name_save(app: AppHandle, output: String, name: String, picture: Option<String>) -> Result<BTreeMap<String, SoundName>, String> {
    let id = engine::output_id(&output).ok_or("That isn't a sound output id.")?;
    let name: String = name.trim().chars().filter(|c| !c.is_control()).take(40).collect();
    let picture = picture.filter(|p| PICTURES.contains(&p.as_str()));
    let mut names = read_sound_names(&app)?;
    if name.is_empty() {
        names.remove(&id);
    } else {
        names.insert(id, SoundName { name, picture });
    }
    let text = serde_json::to_string_pretty(&names).map_err(|e| e.to_string())?;
    eq::write_atomic(&app_data(&app)?.join(SOUND_NAMES_FILE), &text)?;
    Ok(names)
}

/// The page has device work in flight (or not): a minimized window isn't suspended until it's done.
#[tauri::command]
fn page_busy(state: State<'_, sleep::Sleep>, busy: bool) {
    state.set_busy(busy);
}

/// A page was closed: hand back the memory it left behind (src/sleep.rs).
#[tauri::command]
fn memory_trim(window: WebviewWindow) {
    sleep::trim(&window);
}

/// Test hook (`--features perf-test` only): runs exactly what minimizing does, without a window
/// being minimized, and restores after `ms`. `ms` 0 only answers whether the hook is there.
#[tauri::command]
fn perf_test_suspend(window: WebviewWindow, ms: u64) -> Result<(), String> {
    if !cfg!(feature = "perf-test") {
        return Err("This build has no test hooks.".into());
    }
    if ms > 0 {
        sleep::minimized(&window);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(ms));
            sleep::restored(&window);
        });
    }
    Ok(())
}

/// Test hook (`--features perf-test` only): what the sleep code did and when.
#[tauri::command]
fn perf_test_log(state: State<'_, sleep::Sleep>) -> Result<Vec<String>, String> {
    if !cfg!(feature = "perf-test") {
        return Err("This build has no test hooks.".into());
    }
    Ok(state.take_log())
}

// ---- SYNQ Helper (src-tauri/helper, docs/helper.md): off until the person turns it on.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HelperStatus {
    settings: helper_cfg::HelperSettings,
    running: bool,
    /// synq-helper.exe is next to the app (a build without it can't turn it on).
    installed: bool,
    /// The sign-in entry is there and points at this helper.
    autostart: bool,
    /// Sites the person paired with the helper's web bridge.
    sites: Vec<String>,
    port: u16,
}

fn helper_exe() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|d| d.join(helper_cfg::HELPER_EXE))
}

fn helper_status_now(app: &AppHandle) -> Result<HelperStatus, String> {
    use helper_cfg::RunKey;
    let dir = app_data(app)?;
    let exe = helper_exe();
    let autostart = exe
        .as_ref()
        .is_some_and(|e| helper_cfg::SystemRunKey::default().get(helper_cfg::RUN_VALUE).as_deref() == Some(helper_cfg::run_command(&helper_cfg::autostart_target(e)).as_str()));
    let sites = std::fs::read_to_string(dir.join(helper_cfg::PAIRINGS_FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["sites"].as_array().map(|a| a.iter().filter_map(|s| s["origin"].as_str().map(String::from)).collect()))
        .unwrap_or_default();
    Ok(HelperStatus {
        settings: helper_cfg::load_settings(&dir),
        running: helper_cfg::helper_running(),
        installed: exe.is_some_and(|e| e.is_file()),
        autostart,
        sites,
        port: helper_cfg::BRIDGE_PORT,
    })
}

#[cfg(windows)]
fn start_helper() -> Result<(), String> {
    let exe = helper_exe().filter(|e| e.is_file()).ok_or("SYNQ Helper isn't installed with this copy of SYNQ.")?;
    std::process::Command::new(exe).spawn().map(|_| ()).map_err(|e| format!("Couldn't start SYNQ Helper: {e}"))
}

/// Unix: the helper runs on its own (its own process group, no terminal), so it outlives the app. From an
/// AppImage it is started through the AppImage file (`--helper`), whose own files exist only while it runs.
#[cfg(not(windows))]
fn start_helper() -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    let exe = helper_exe().filter(|e| e.is_file()).ok_or("SYNQ Helper isn't installed with this copy of SYNQ.")?;
    let target = helper_cfg::autostart_target(&exe);
    let mut cmd = std::process::Command::new(&target);
    if target != exe {
        cmd.arg("--helper");
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0);
    cmd.spawn().map(|_| ()).map_err(|e| format!("Couldn't start SYNQ Helper: {e}"))
}

#[tauri::command]
fn helper_status(app: AppHandle) -> Result<HelperStatus, String> {
    helper_status_now(&app)
}

/// Saves the helper's switches. On: the sign-in entry is written and the helper started (or told to
/// re-read its settings). Off: the entry is removed and a running helper quits.
#[tauri::command]
fn helper_set(app: AppHandle, settings: helper_cfg::HelperSettings) -> Result<HelperStatus, String> {
    let dir = app_data(&app)?;
    let exe = helper_exe().ok_or("Couldn't find SYNQ's folder.")?;
    if settings.enabled && !exe.is_file() {
        return Err("SYNQ Helper isn't installed with this copy of SYNQ.".into());
    }
    helper_cfg::save_settings(&dir, &settings)?;
    helper_cfg::apply_autostart(&mut helper_cfg::SystemRunKey::default(), settings.enabled, &helper_cfg::autostart_target(&exe))?;
    if settings.enabled {
        if !helper_cfg::signal(helper_cfg::RELOAD_EVENT) {
            start_helper()?;
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
    } else {
        helper_cfg::signal(helper_cfg::QUIT_EVENT);
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    helper_status_now(&app)
}

/// Forgets every site paired with the web bridge; they ask again next time.
#[tauri::command]
fn helper_forget_sites(app: AppHandle) -> Result<HelperStatus, String> {
    let path = app_data(&app)?.join(helper_cfg::PAIRINGS_FILE);
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Could not remove {}: {e}", path.display())),
    }
    helper_cfg::signal(helper_cfg::RELOAD_EVENT);
    helper_status_now(&app)
}

#[tauri::command]
fn games_load(app: AppHandle) -> Result<games::GamesFile, String> {
    games::load(&app_data(&app)?)
}

/// The Games page's library: installed Steam and Epic games and the built-in favourites. Read-only.
#[tauri::command]
async fn games_detect() -> Result<Vec<library::Detected>, String> {
    tauri::async_runtime::spawn_blocking(library::detect).await.map_err(|e| e.to_string())
}

/// One game's cover art as a data URL: the person's image, Steam's header (fetched once, kept in
/// game-art/), or the program's icon. None when there is none.
#[tauri::command]
async fn game_art(app: AppHandle, id: String, appid: Option<u32>, icon_exe: Option<String>) -> Result<Option<String>, String> {
    let dir = data_dir(&app, "game-art")?;
    tauri::async_runtime::spawn_blocking(move || library::art(&dir, &id, appid, icon_exe.as_deref())).await.map_err(|e| e.to_string())
}

/// An image the person picked for a game (checked to be an image of 2 MB or less).
#[tauri::command]
fn game_art_set(app: AppHandle, id: String, bytes: Vec<u8>) -> Result<String, String> {
    library::set_custom(&data_dir(&app, "game-art")?, &id, &bytes)
}

#[tauri::command]
fn game_art_clear(app: AppHandle, id: String) -> Result<(), String> {
    library::clear_custom(&data_dir(&app, "game-art")?, &id)
}

/// A device's last-known settings, as its panel last read them (src/lib/profiles/state.ts). The Games
/// page encodes profiles and their restore sets from these, offline.
#[tauri::command]
fn device_state_save(app: AppHandle, id: String, json: String) -> Result<(), String> {
    if json.len() > 256 * 1024 {
        return Err("That device state is too large to keep.".into());
    }
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("Not a device state: {e}"))?;
    eq::write_atomic(&data_dir(&app, "device-state")?.join(format!("{}.json", safe_name(&id, "device"))), &json)
}

#[tauri::command]
fn device_states_load(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = data_dir(&app, "device-state")?;
    let mut out = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        if e.path().extension().is_some_and(|x| x == "json") {
            if let Ok(t) = std::fs::read_to_string(e.path()) {
                out.push(t);
            }
        }
    }
    Ok(out)
}

/// "Keep your feel" (src/lib/feel): the saved feel, the devices already seen and the last-configured marks,
/// as one small JSON document in the app data folder. Nothing else is stored here and nothing leaves the PC.
const FEEL_FILE: &str = "feel.json";
const FEEL_MAX_BYTES: usize = 64 * 1024;

#[tauri::command]
fn feel_load(app: AppHandle) -> Result<Option<String>, String> {
    let path = app_data(&app)?.join(FEEL_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

#[tauri::command]
fn feel_save(app: AppHandle, json: String) -> Result<(), String> {
    if json.len() > FEEL_MAX_BYTES {
        return Err("That feel is too large to keep.".into());
    }
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("Not a saved feel: {e}"))?;
    eq::write_atomic(&app_data(&app)?.join(FEEL_FILE), &json)
}

/// What the person keeps for their lamps (saved colours and gradients, DIY effects): lighting.json in the data folder.
const LIGHTING_FILE: &str = "lighting.json";
const LIGHTING_MAX_BYTES: usize = 256 * 1024;

#[tauri::command]
fn lighting_load(app: AppHandle) -> Result<Option<String>, String> {
    let path = app_data(&app)?.join(LIGHTING_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

#[tauri::command]
fn lighting_save(app: AppHandle, json: String) -> Result<(), String> {
    if json.len() > LIGHTING_MAX_BYTES {
        return Err("That is too much to keep.".into());
    }
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("Not saved lighting: {e}"))?;
    eq::write_atomic(&app_data(&app)?.join(LIGHTING_FILE), &json)
}

/// Device keys that hold a game profile right now (the helper's helper-state.json): their state as read
/// now isn't their everyday state.
#[tauri::command]
fn helper_held(app: AppHandle) -> Result<Vec<String>, String> {
    let text = std::fs::read_to_string(app_data(&app)?.join("helper-state.json")).unwrap_or_default();
    Ok(serde_json::from_str::<BTreeMap<String, serde_json::Value>>(&text).map(|m| m.into_keys().collect()).unwrap_or_default())
}

/// Saves the Games page (checked first), and tells a running helper to pick it up.
#[tauri::command]
fn games_save(app: AppHandle, file: games::GamesFile) -> Result<(), String> {
    games::save(&app_data(&app)?, &file)?;
    helper_cfg::signal(helper_cfg::RELOAD_EVENT);
    Ok(())
}

/// Linux device access: is SYNQ's udev rule installed and current, and which listed devices Linux
/// doesn't let SYNQ open yet. Reads file permissions only; nothing is opened.
#[cfg(target_os = "linux")]
#[tauri::command]
async fn device_access(state: State<'_, hid::HidState>) -> Result<udev::access::Status, String> {
    Ok(udev::access::status(hid::inaccessible(&state)))
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
async fn device_access() -> Result<(), String> {
    Err("Device access rules are a Linux thing.".into())
}

/// Linux: installs the udev rule with one pkexec prompt (the person's click on the device-access card).
#[cfg(target_os = "linux")]
#[tauri::command]
async fn device_access_install() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(udev::access::install).await.map_err(|e| e.to_string())?
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
async fn device_access_install() -> Result<String, String> {
    Err("Device access rules are a Linux thing.".into())
}

/// Moves backups and presets saved before the app was renamed (com.logan.hub) to the new
/// data folder, once.
fn migrate_old_data(app: &AppHandle) {
    let Ok(new) = app.path().app_data_dir() else { return };
    let Some(old) = new.parent().map(|p| p.join("com.logan.hub")) else { return };
    if old.exists() && !new.exists() {
        let _ = std::fs::rename(&old, &new);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `synq.exe --eq-engine ...` is the EQ engine helper: it does its job and exits before any
    // window or webview starts.
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = engine::cli(&args) {
        std::process::exit(code);
    }
    // `--self-test` (CI's smoke test) and `--print-udev-rules` (the Linux device-access command) also
    // exit before any window.
    match args.get(1).map(String::as_str) {
        Some("--self-test") => std::process::exit(selftest::run()),
        Some("--print-udev-rules") => {
            print!("{}", udev::rules());
            std::process::exit(0);
        }
        // An AppImage starts its helper (and the helper's sign-in entry) through itself.
        #[cfg(unix)]
        Some("--helper") => {
            use std::os::unix::process::CommandExt;
            let Some(exe) = helper_exe().filter(|e| e.is_file()) else { std::process::exit(1) };
            let err = std::process::Command::new(exe).args(&args[2..]).exec();
            eprintln!("Couldn't start SYNQ Helper: {err}");
            std::process::exit(1);
        }
        _ => {}
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(hid::HidState::new())
        .manage(sleep::Sleep::default())
        .setup(|app| {
            migrate_old_data(app.handle());
            // The helper is on (the person turned it on) but not running in this session: start it.
            if let Ok(dir) = app_data(app.handle()) {
                if helper_cfg::load_settings(&dir).enabled && !helper_cfg::helper_running() {
                    let _ = start_helper();
                }
                // The Wi-Fi lights' pairing keys live next to the app's other data.
                lighting::net::init(dir);
            }
            // Minimized: the page sleeps until the window is restored (src/sleep.rs).
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                let handle = app.handle().clone();
                window.on_window_event(move |event| match event {
                    tauri::WindowEvent::Resized(_) => sleep::on_resized(&w),
                    tauri::WindowEvent::Focused(focused) => on_focus(&handle, *focused),
                    _ => {}
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            lamparray_watch,
            hotplug_watch,
            lamparray_info,
            lamparray_set,
            lamparray_close,
            rgbhub_write,
            rgbhub_read,
            rgbhub_close,
            lights_list,
            light_open,
            light_send,
            light_upload,
            light_close,
            light_sync_start,
            screen_monitors,
            light_sync_stop,
            net_lights_find,
            net_light_pair,
            net_light_forget,
            net_light_send,
            net_sync_start,
            net_sync_stop,
            net_sync_state,
            hue_areas,
            hue_area_create,
            hue_area_remove,
            lighting_load,
            lighting_save,
            eq_load,
            eq_apply,
            eq_presets,
            eq_preset_read,
            eq_preset_save,
            eq_preset_delete,
            eq_backups,
            eq_restore_backup,
            devices_list,
            pads_conflicts,
            pad_diagnostics_save,
            pad_backup_save,
            xinput_slots,
            xinput_read,
            xinput_sample,
            xinput_stop,
            mouse_sample,
            mouse_sample_stop,
            display_backup_save,
            monitor_caps,
            monitor_read,
            monitor_write,
            webcam_controls,
            webcam_set,
            hid_list,
            hid_open,
            hid_close,
            hid_send_report,
            hid_send_report_to,
            hid_send_feature_report,
            hid_receive_feature_report,
            hid_advanced_grant,
            hid_advanced_revoke,
            hid_advanced_status,
            helper_status,
            helper_set,
            helper_forget_sites,
            games_load,
            games_save,
            games_detect,
            game_art,
            game_art_set,
            game_art_clear,
            device_state_save,
            device_states_load,
            feel_load,
            feel_save,
            helper_held,
            mouse_backup_save,
            mouse_log,
            keyboard_state_load,
            keyboard_state_save,
            keyboard_log,
            kb_backup_save,
            kb_log,
            kb_definition_load,
            kb_definition_save,
            eq_engine_status,
            eq_engine_setup,
            eq_engine_install,
            eq_engine_undo,
            sound_names_load,
            sound_name_save,
            device_access,
            device_access_install,
            page_busy,
            memory_trim,
            perf_test_suspend,
            perf_test_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(slot: u32, vid: u16, pid: u16) -> xinput::Slot {
        xinput::Slot { slot, vid, pid, sub_type: 1, wireless: false, battery: None }
    }

    #[test]
    fn an_xinput_slot_with_windows_own_id_becomes_the_one_usb_pad_present() {
        // The G7 SE on this PC: XInput says 045E:02FF, Windows lists 3537:1010 as present.
        let got = xinput_identities(&[slot(0, 0x045e, 0x02ff)], &[(0x3537, 0x1010)]);
        assert_eq!(got[0].1, (0x3537, 0x1010));
        // Two GIP pads, one shim slot each: which is which isn't known, so both keep Windows' id.
        let two = xinput_identities(&[slot(0, 0x045e, 0x02ff), slot(1, 0x045e, 0x02ff)], &[(0x3537, 0x1010), (0x045e, 0x0b12)]);
        assert!(two.iter().all(|(_, id)| *id == (0x045e, 0x02ff)));
        // A slot that already names its pad keeps it, and that pad isn't handed to another slot.
        let named = xinput_identities(&[slot(0, 0x2dc8, 0x3106), slot(1, 0x045e, 0x02a1)], &[(0x2dc8, 0x3106)]);
        assert_eq!(named[0].1, (0x2dc8, 0x3106));
        assert_eq!(named[1].1, (0x045e, 0x02a1));
        // A USB pad of the other class isn't taken.
        assert_eq!(xinput_identities(&[slot(0, 0x045e, 0x02ff)], &[(0x2dc8, 0x3106)])[0].1, (0x045e, 0x02ff));
    }

    #[test]
    fn a_pad_listed_as_hid_isnt_listed_again_from_xinput() {
        let hid = devices::classify(0x3537, 0x1053, vec![devices::CollectionInfo { usage_page: 0xfff0, usage: 0x0001, interface: 1 }], Some("GameSir-Cyclone 2".into())).expect("a GameSir Cyclone 2 is listed by its settings channel");
        assert_eq!(hid.pad.as_ref().map(|p| p.via), Some("hid"));
        let list = vec![hid];
        assert!(listed_as_hid(&list, 0x3537, 0x1053));
        assert!(!listed_as_hid(&list, 0x3537, 0x1010), "another pad still lists from XInput");
    }
}
