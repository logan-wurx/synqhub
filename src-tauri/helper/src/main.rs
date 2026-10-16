//! SYNQ Helper: SYNQ's opt-in background process. Off until the person turns it on in SYNQ's
//! Settings; then it starts at sign-in (per-user Run key) and does three jobs:
//!
//! 1. per-game profiles: when a game starts, its mouse / keyboard profile (encoded by the app from the
//!    settings picked on the Games page) is sent; when it ends, the everyday settings are put back
//!    (profiles.rs, watcher.rs);
//! 2. battery alerts: one notification at each level, 20%, 10% and 5% by default (battery.rs);
//! 3. the web bridge: the SYNQ website can reach Razer, the EQ and the Advanced actions through it,
//!    with the desktop app's own checks (bridge.rs, ws.rs).
//!
//! No WebView, no Tauri: a tray icon on a message-only window, one worker thread that sleeps until
//! something is due, and the bridge's listener. All device traffic goes through SYNQ's own
//! `hid.rs` and its guards, compiled in from the same source files as the app.
//!
//! Linux: the same jobs and the same files. It starts at login from ~/.config/autostart (only while it's
//! on), its tray icon is a StatusNotifierItem where the desktop shows one (else it runs headless and
//! only notifies), battery alerts are desktop notifications, the process list comes from /proc, and the
//! app reaches it through a socket in the login's runtime folder (tray_unix.rs, watcher.rs, `ipc`).
//!
//!   synq-helper.exe              run (exits at once if the helper is turned off)
//!   synq-helper.exe --autostart  the same, from the sign-in entry
//!   synq-helper.exe --stop       ask a running helper to quit (the installer, before an update)
//!   synq-helper.exe --register   put the sign-in entry back if the helper is on (after an update)
//!   synq-helper.exe --uninstall  stop a running helper and remove the sign-in entry (uninstaller)
//!
//! --stop, --register and --uninstall never start the helper: the installer runs elevated, and the helper
//! must only ever run as the signed-in user.

#![cfg_attr(not(test), windows_subsystem = "windows")]

#[path = "../../src/advanced.rs"]
#[allow(dead_code)]
mod advanced;
#[path = "../../src/brand_ids.rs"]
#[allow(dead_code)]
mod brand_ids;
#[path = "../../src/brands.rs"]
#[allow(dead_code)]
mod brands;
#[path = "../../src/controller_ids.rs"]
#[allow(dead_code)]
mod controller_ids;
#[path = "../../src/devices.rs"]
#[allow(dead_code)]
mod devices;
#[cfg(windows)]
#[path = "../../src/engine/mod.rs"]
#[allow(dead_code)]
mod engine;
#[cfg(not(windows))]
#[path = "../../src/pipewire/mod.rs"]
#[allow(dead_code)]
mod engine;
#[path = "../../src/eq.rs"]
#[allow(dead_code)]
mod eq;
#[path = "../../src/eq_graph.rs"]
#[allow(dead_code)]
mod eq_graph;
#[path = "../../src/games.rs"]
#[allow(dead_code)]
mod games;
#[path = "../../src/headsets.rs"]
#[allow(dead_code)]
mod headsets;
#[path = "../../src/helper_cfg.rs"]
#[allow(dead_code)]
mod helper_cfg;
#[path = "../../src/hid.rs"]
#[allow(dead_code)]
mod hid;
// Monitors, webcams and Wi-Fi lights, for the website through the bridge: the app's own code, with the app's paths
// (the Wi-Fi lights' Hue stream uses the Govee cipher as `crate::lighting::govee::cipher`).
#[path = "../../src/monitors.rs"]
#[allow(dead_code)]
mod monitors;
#[path = "../../src/webcams.rs"]
#[allow(dead_code)]
mod webcams;
// Wi-Fi lights, USB hubs and screen sync across them (the website's, through the bridge).
#[allow(dead_code, unused_imports)]
mod lighting {
    #[path = "../../../src/lighting/hidrgb.rs"]
    pub mod hidrgb;
    #[path = "../../../src/lighting/hubframes.rs"]
    pub mod hubframes;
    #[path = "../../../src/lighting/screen.rs"]
    pub mod screen;
    #[path = "../../../src/lighting/sync.rs"]
    pub mod sync;
    #[path = "../../../src/lighting/net/mod.rs"]
    pub mod net;
    pub mod govee {
        #[cfg(windows)]
        #[path = "../../../../src/lighting/govee/cipher.rs"]
        pub mod cipher;
    }
}
#[path = "../../src/hid_plan.rs"]
#[allow(dead_code)]
mod hid_plan;
#[path = "../../src/openmouse_ids.rs"]
#[allow(dead_code)]
mod openmouse_ids;
#[path = "../../src/pads.rs"]
#[allow(dead_code)]
mod pads;

mod battery;
mod bridge;
#[cfg(unix)]
mod ipc;
mod profiles;
// Installed on its own from the website (Windows): where a double-click runs it, its folder and apps entry.
#[cfg_attr(not(windows), allow(dead_code))]
mod standalone;
#[cfg(windows)]
mod tray;
#[cfg(not(windows))]
#[path = "tray_unix.rs"]
mod tray;
mod watcher;
mod ws;

use helper_cfg::HelperSettings;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Arc;
#[cfg(windows)]
use std::sync::Mutex;
use std::time::{Duration, Instant};
use watcher::ProcessSource;

const STATE_FILE: &str = "helper-state.json";
const LOG_FILE: &str = "helper-log.txt";
/// The app's program name as the process list has it (watcher.rs gives Linux names the same .exe).
const APP_EXE: &str = "synq.exe";

fn log(data: &Path, line: &str) {
    use std::io::Write;
    let path = data.join(LOG_FILE);
    if std::fs::metadata(&path).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("old.txt"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} {line}", eq::now_secs());
    }
}

/// What the worker thread is told.
enum Msg {
    Reload,
    Pause(bool),
    /// Restore everything, then answer.
    Quit(mpsc::Sender<()>),
}

struct Ctx {
    data: PathBuf,
    tray: Option<tray::Tray>,
}

impl Ctx {
    fn notify(&self, title: &str, text: &str) {
        if let Some(t) = &self.tray {
            t.notify(title, text);
        }
    }
    fn tooltip(&self, text: &str) {
        if let Some(t) = &self.tray {
            t.tooltip(text);
        }
    }
}

fn load_on(data: &Path) -> BTreeMap<String, profiles::Held> {
    std::fs::read_to_string(data.join(STATE_FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_on(data: &Path, on: &BTreeMap<String, profiles::Held>) {
    if let Ok(t) = serde_json::to_string(on) {
        let _ = helper_cfg::write_atomic(&data.join(STATE_FILE), &t);
    }
}

fn load_games(data: &Path) -> games::GamesFile {
    games::load(data).unwrap_or_else(|e| {
        log(data, &format!("games.json not used: {e}"));
        games::GamesFile::default()
    })
}

/// The worker: process list (only while a profile exists), profile sends, battery readings. Sleeps
/// until the next of those is due, or until the main thread sends a message.
fn worker(ctx: Arc<Ctx>, rx: Receiver<Msg>) {
    let data = &ctx.data;
    let hid_state = hid::HidState::new();
    let mut settings = helper_cfg::load_settings(data);
    let mut file = load_games(data);
    let mut sw = profiles::Switcher::with_on(load_on(data));
    let mut procs = watcher::Native;
    let mut alerts = battery::Alerts::default();
    let mut sched = battery::Schedule::default();
    let mut kinds: HashMap<String, (battery::Kind, String)> = HashMap::new();
    let mut caches: HashMap<String, Option<(u16, u8)>> = HashMap::new();
    let mut next_scan = Instant::now();
    let mut paused = false;
    let mut last_tip = String::new();

    let handle = |events: Vec<profiles::Event>, sw: &profiles::Switcher, file: &games::GamesFile| {
        for e in &events {
            log(data, &format!("{e:?}"));
            if let profiles::Event::Failed { device, error } = e {
                ctx.notify("Game profile not applied", &format!("{device}: {error}"));
            }
        }
        if !events.is_empty() {
            save_on(data, sw.on());
        }
        let _ = file;
    };

    loop {
        let now = Instant::now();
        let profiles_on = settings.enabled && settings.game_profiles && !paused;
        let watching = profiles_on && (file.any_profile() || !sw.on().is_empty());
        let mut names: Option<HashSet<String>> = None;
        if watching {
            match procs.names() {
                Ok(n) => {
                    let ev = sw.tick(&file, &n, &mut profiles::HidDevices { state: &hid_state }, now);
                    handle(ev, &sw, &file);
                    names = Some(n);
                }
                Err(e) => log(data, &format!("process list: {e}")),
            }
        }
        let tip = match (paused, sw.active().and_then(|id| file.games.iter().find(|g| g.id == id))) {
            (true, _) => "SYNQ Helper (paused)".to_string(),
            (false, Some(g)) => format!("SYNQ Helper: {} profile on", g.name),
            _ => "SYNQ Helper".to_string(),
        };
        if tip != last_tip {
            ctx.tooltip(&tip);
            last_tip = tip;
        }

        let battery_on = settings.enabled && settings.battery_alerts && !paused;
        if battery_on {
            if now >= next_scan {
                kinds.clear();
                for s in hid::list(&hid_state).unwrap_or_default() {
                    if let Some(k) = battery::kind_of(&s) {
                        kinds.insert(s.key.clone(), (k, battery::display_name(&s)));
                    }
                }
                let keys: Vec<String> = kinds.keys().cloned().collect();
                sched.present(&keys, now);
                caches.retain(|k, _| kinds.contains_key(k));
                next_scan = now + battery::EVERY;
            }
            let due = sched.due(now);
            if !due.is_empty() {
                let names = names.take().or_else(|| procs.names().ok()).unwrap_or_default();
                // The app is open: it shows the battery itself and may be talking to the device.
                let app_open = watcher::names_include(&names, APP_EXE);
                for key in due {
                    let Some((kind, name)) = kinds.get(&key).cloned() else { continue };
                    if app_open {
                        sched.update(&key, battery::Reading::Level { percent: 100, charging: false }, now);
                        continue;
                    }
                    let reading = match battery::HidLink::open(&hid_state, &key) {
                        Ok(mut link) => match kind {
                            battery::Kind::Atk => battery::probe_atk(&mut link),
                            battery::Kind::Hidpp { index, long } => battery::probe_hidpp(&mut link, index, long, caches.entry(key.clone()).or_default()),
                        },
                        Err(_) => battery::Reading::NoAnswer,
                    };
                    sched.update(&key, reading, now);
                    if let battery::Reading::Level { percent, charging } = reading {
                        if let Some(a) = alerts.observe(&key, &name, percent, charging, &battery::levels(&settings.battery_levels)) {
                            log(data, &format!("{a:?}"));
                            ctx.notify(&a.title(), &a.text());
                        }
                    }
                }
            }
        }

        let mut wait = Duration::from_secs(3600);
        if watching {
            wait = wait.min(watcher::POLL);
        }
        if battery_on {
            let next = sched.next_wake().map_or(next_scan, |t| t.min(next_scan));
            wait = wait.min(next.saturating_duration_since(Instant::now()).max(Duration::from_millis(50)));
        }
        match rx.recv_timeout(wait) {
            Ok(Msg::Reload) => {
                settings = helper_cfg::load_settings(data);
                file = load_games(data);
                next_scan = Instant::now();
                if !(settings.enabled && settings.game_profiles) && !sw.on().is_empty() {
                    let ev = sw.restore_all(&file, &mut profiles::HidDevices { state: &hid_state }, Instant::now());
                    handle(ev, &sw, &file);
                }
            }
            Ok(Msg::Pause(p)) => {
                paused = p;
                if p {
                    let ev = sw.restore_all(&file, &mut profiles::HidDevices { state: &hid_state }, Instant::now());
                    handle(ev, &sw, &file);
                }
            }
            Ok(Msg::Quit(done)) => {
                let ev = sw.restore_all(&file, &mut profiles::HidDevices { state: &hid_state }, Instant::now());
                handle(ev, &sw, &file);
                let _ = done.send(());
                return;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// The bridge while it runs.
struct Serving {
    bridge: Arc<bridge::Bridge>,
    thread: std::thread::JoinHandle<()>,
}

fn start_bridge(data: &Path, paused: Arc<AtomicBool>) -> Result<Serving, String> {
    let listener = bridge::bind(helper_cfg::BRIDGE_PORT)?;
    // Wi-Fi lights' pairing keys: the app's own file in the same folder.
    lighting::net::init(data.to_path_buf());
    let b = Arc::new(bridge::Bridge::new(helper_cfg::BRIDGE_PORT, bridge::allowed_origins(), Some(data.to_path_buf()), Box::new(tray::DialogConsent), paused));
    let served = b.clone();
    let thread = std::thread::Builder::new().name("bridge".into()).stack_size(256 * 1024).spawn(move || bridge::serve(served, listener)).map_err(|e| e.to_string())?;
    Ok(Serving { bridge: b, thread })
}

fn stop_bridge(s: Serving) {
    bridge::stop_serving(&s.bridge);
    let _ = s.thread.join();
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// "Open SYNQ": the app next to this helper, or the website for a helper installed on its own.
#[cfg(windows)]
fn open_app() {
    match std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(APP_EXE))).filter(|a| a.is_file()) {
        Some(app) => {
            let _ = std::process::Command::new(app).spawn();
        }
        None => standalone::open_site(),
    }
}

/// What a double-click (no switches) leaves to do.
#[cfg(windows)]
enum Clicked {
    /// Another process runs the helper now (or nothing could be done): this one is finished.
    Done,
    /// Run here; `welcome`: the helper was just turned on, so say so from the tray.
    Run { welcome: bool },
}

/// A double-click on synq-helper.exe: the person wants the helper on. It is turned on (with the website bridge) and
/// runs from where it belongs: the desktop app's copy, the one installed on its own, or this downloaded file once
/// it has installed itself (src/standalone.rs).
#[cfg(windows)]
fn double_click(data: Option<&Path>, settings: &mut HelperSettings) -> Clicked {
    let Some(data) = data else { return Clicked::Done };
    let (Ok(me), Some(own)) = (std::env::current_exe(), standalone::own_dir()) else { return Clicked::Done };
    let welcome = !settings.enabled;
    settings.enabled = true;
    settings.web_bridge = true;
    if let Err(e) = helper_cfg::save_settings(data, settings) {
        standalone::tell(&format!("SYNQ Helper couldn't save its settings: {e}"));
        return Clicked::Done;
    }
    if helper_cfg::helper_running() {
        helper_cfg::signal(helper_cfg::RELOAD_EVENT);
        standalone::tell("SYNQ Helper is already running. It's in the tray, by the clock.");
        return Clicked::Done;
    }
    let target = match standalone::plan(&me, standalone::desktop_helper().as_deref(), &own) {
        standalone::Plan::RunHere => return Clicked::Run { welcome },
        standalone::Plan::UseDesktop(d) => d,
        standalone::Plan::InstallTo(t) => {
            if let Err(e) = standalone::install(&me, &t) {
                standalone::tell(&format!("SYNQ Helper couldn't install itself: {e}"));
                return Clicked::Done;
            }
            t
        }
    };
    let _ = helper_cfg::apply_autostart(&mut helper_cfg::SystemRunKey::default(), true, &helper_cfg::autostart_target(&target));
    if let Err(e) = std::process::Command::new(&target).arg("--welcome").spawn() {
        standalone::tell(&format!("SYNQ Helper couldn't start: {e}"));
    }
    Clicked::Done
}

/// "Open SYNQ": the AppImage this helper came from, else the app next to it; on its own, no terminal.
#[cfg(not(windows))]
fn open_app() {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    let target = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .or_else(|| std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("synq"))));
    if let Some(t) = target {
        let _ = std::process::Command::new(t).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0).spawn();
    }
}

/// `--stop`: ask a running helper to quit (it puts every device back on its everyday settings first)
/// and wait for it, at most 5 s.
fn stop() {
    helper_cfg::signal(helper_cfg::QUIT_EVENT);
    for _ in 0..50 {
        if !helper_cfg::helper_running() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// The sign-in entry, as the switches say: there (pointing at this exe) when the helper is on, gone
/// when it's off.
fn sync_autostart(settings: &HelperSettings) {
    if let Ok(exe) = std::env::current_exe() {
        let _ = helper_cfg::apply_autostart(&mut helper_cfg::SystemRunKey::default(), settings.enabled, &helper_cfg::autostart_target(&exe));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |f: &str| args.iter().any(|a| a == f);
    let data = helper_cfg::app_data_dir();
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut settings = data.as_deref().map(helper_cfg::load_settings).unwrap_or_default();
    if flag("--stop") {
        stop();
        return;
    }
    if flag("--uninstall") {
        stop();
        let _ = helper_cfg::apply_autostart(&mut helper_cfg::SystemRunKey::default(), false, Path::new(""));
        return;
    }
    // Removed from Windows' installed apps (a helper installed on its own): stopped, off, and its folder goes.
    #[cfg(windows)]
    if flag("--uninstall-self") {
        stop();
        if let Some(d) = data.as_deref() {
            settings.enabled = false;
            let _ = helper_cfg::save_settings(d, &settings);
        }
        if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
            standalone::uninstall(&dir);
        }
        return;
    }
    #[cfg(windows)]
    let welcome = if args.is_empty() {
        match double_click(data.as_deref(), &mut settings) {
            Clicked::Done => return,
            Clicked::Run { welcome } => welcome,
        }
    } else {
        flag("--welcome")
    };
    // Off: never run. A sign-in entry left behind is removed; on, it is put right (an update or a moved
    // install changes the path).
    sync_autostart(&settings);
    if flag("--register") || !settings.enabled {
        return;
    }
    let Some(data) = data else { return };
    let _ = std::fs::create_dir_all(&data);
    #[cfg(windows)]
    run_windows(data, settings, welcome);
    #[cfg(unix)]
    run_unix(data, settings);
}

/// Windows: named events for the app, a message loop for the tray icon.
#[cfg(windows)]
fn run_windows(data: PathBuf, settings: HelperSettings, welcome: bool) {
    use windows::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{CreateEventW, INFINITE};
    use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, MSG, MsgWaitForMultipleObjects, PM_REMOVE, PeekMessageW, QS_ALLINPUT, TranslateMessage, WM_QUIT};

    // One helper per sign-in: the quit event doubles as the lock (and tells the app it's running).
    let quit_name = wide(helper_cfg::QUIT_EVENT);
    let reload_name = wide(helper_cfg::RELOAD_EVENT);
    let (quit, reload): (HANDLE, HANDLE) = unsafe {
        let Ok(q) = CreateEventW(None, false, false, windows::core::PCWSTR(quit_name.as_ptr())) else { return };
        if GetLastError() == ERROR_ALREADY_EXISTS {
            let _ = CloseHandle(q);
            return;
        }
        let Ok(r) = CreateEventW(None, false, false, windows::core::PCWSTR(reload_name.as_ptr())) else { return };
        (q, r)
    };

    let (cmd_tx, cmd_rx) = mpsc::channel::<tray::Command>();
    let tray = tray::Tray::create(cmd_tx).ok();
    if welcome {
        if let Some(t) = tray.as_ref() {
            t.notify("SYNQ Helper is on", "It starts with Windows and waits here in the tray. synqhub.app can use it now.");
        }
    }
    let ctx = Arc::new(Ctx { data: data.clone(), tray });
    log(&data, "started");

    let (work_tx, work_rx) = mpsc::channel::<Msg>();
    let worker_thread = {
        let ctx = ctx.clone();
        std::thread::Builder::new().name("worker".into()).stack_size(512 * 1024).spawn(move || worker(ctx, work_rx)).ok()
    };

    let paused = Arc::new(AtomicBool::new(false));
    let mut serving: Option<Serving> = None;
    let sync_bridge = |settings: &HelperSettings, serving: &mut Option<Serving>| {
        let want = settings.enabled && settings.web_bridge;
        match (want, serving.is_some()) {
            (true, false) => match start_bridge(&data, paused.clone()) {
                Ok(s) => *serving = Some(s),
                Err(e) => log(&data, &format!("bridge: {e}")),
            },
            (false, true) => stop_bridge(serving.take().expect("checked")),
            _ => {}
        }
    };
    sync_bridge(&settings, &mut serving);
    let serving = Mutex::new(serving);

    let mut quitting = false;
    while !quitting {
        let handles = [quit, reload];
        let r = unsafe { MsgWaitForMultipleObjects(Some(&handles), false, INFINITE, QS_ALLINPUT) };
        if r == WAIT_OBJECT_0 {
            quitting = true;
        } else if r.0 == WAIT_OBJECT_0.0 + 1 {
            let s = helper_cfg::load_settings(&data);
            if !s.enabled {
                quitting = true;
            } else {
                if let Ok(mut sv) = serving.lock() {
                    sync_bridge(&s, &mut sv);
                    if let Some(b) = sv.as_ref() {
                        b.bridge.reload_pairings();
                    }
                }
                let _ = work_tx.send(Msg::Reload);
            }
        } else {
            unsafe {
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    if msg.message == WM_QUIT {
                        quitting = true;
                    }
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        }
        while let Ok(c) = cmd_rx.try_recv() {
            match c {
                tray::Command::Open => open_app(),
                tray::Command::TogglePause => {
                    let p = !paused.load(Ordering::SeqCst);
                    paused.store(p, Ordering::SeqCst);
                    if let Some(t) = &ctx.tray {
                        t.set_paused(p);
                    }
                    let _ = work_tx.send(Msg::Pause(p));
                }
                tray::Command::Quit => quitting = true,
            }
        }
    }

    // Quit: everyday settings back on every device, the bridge closed, the icon gone.
    if let Ok(mut sv) = serving.lock() {
        if let Some(s) = sv.take() {
            stop_bridge(s);
        }
    }
    let (done_tx, done_rx) = mpsc::channel();
    if work_tx.send(Msg::Quit(done_tx)).is_ok() {
        let _ = done_rx.recv_timeout(Duration::from_secs(15));
    }
    if let Some(t) = worker_thread {
        drop(work_tx);
        let _ = t.join();
    }
    if let Some(t) = &ctx.tray {
        t.remove();
    }
    log(&data, "stopped");
    unsafe {
        let _ = CloseHandle(reload);
        let _ = CloseHandle(quit);
    }
}

/// Unix: one helper per login (a lock and a socket in the runtime folder), the tray's and the socket's
/// commands on one channel, and SIGTERM / SIGINT (logout, `kill`) quit the same way the menu does, so the
/// devices get their everyday settings back first.
#[cfg(unix)]
fn run_unix(data: PathBuf, settings: HelperSettings) {
    let Some(_lock) = ipc::lock() else { return };
    let Some(listener) = ipc::bind() else { return };
    ipc::catch_termination();

    let (cmd_tx, cmd_rx) = mpsc::channel::<tray::Command>();
    let tray = tray::Tray::create(cmd_tx.clone()).ok();
    let ctx = Arc::new(Ctx { data: data.clone(), tray });
    log(&data, if ctx.tray.as_ref().is_some_and(tray::Tray::shown) { "started" } else { "started (no tray host: notifications only)" });
    {
        let tx = cmd_tx.clone();
        let _ = std::thread::Builder::new().name("ipc".into()).stack_size(128 * 1024).spawn(move || ipc::serve(listener, tx));
    }

    let (work_tx, work_rx) = mpsc::channel::<Msg>();
    let worker_thread = {
        let ctx = ctx.clone();
        std::thread::Builder::new().name("worker".into()).stack_size(512 * 1024).spawn(move || worker(ctx, work_rx)).ok()
    };

    let paused = Arc::new(AtomicBool::new(false));
    let mut serving: Option<Serving> = None;
    let sync_bridge = |settings: &HelperSettings, serving: &mut Option<Serving>| {
        let want = settings.enabled && settings.web_bridge;
        match (want, serving.is_some()) {
            (true, false) => match start_bridge(&data, paused.clone()) {
                Ok(s) => *serving = Some(s),
                Err(e) => log(&data, &format!("bridge: {e}")),
            },
            (false, true) => stop_bridge(serving.take().expect("checked")),
            _ => {}
        }
    };
    sync_bridge(&settings, &mut serving);

    loop {
        if ipc::terminating() {
            break;
        }
        let c = match cmd_rx.recv_timeout(Duration::from_millis(500)) {
            Ok(c) => c,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        match c {
            tray::Command::Open => open_app(),
            tray::Command::TogglePause => {
                let p = !paused.load(Ordering::SeqCst);
                paused.store(p, Ordering::SeqCst);
                if let Some(t) = &ctx.tray {
                    t.set_paused(p);
                }
                let _ = work_tx.send(Msg::Pause(p));
            }
            tray::Command::Reload => {
                let s = helper_cfg::load_settings(&data);
                if !s.enabled {
                    break;
                }
                sync_bridge(&s, &mut serving);
                if let Some(b) = serving.as_ref() {
                    b.bridge.reload_pairings();
                }
                let _ = work_tx.send(Msg::Reload);
            }
            tray::Command::Quit => break,
        }
    }

    // Quit: everyday settings back on every device, the bridge closed, the icon gone.
    if let Some(s) = serving.take() {
        stop_bridge(s);
    }
    let (done_tx, done_rx) = mpsc::channel();
    if work_tx.send(Msg::Quit(done_tx)).is_ok() {
        let _ = done_rx.recv_timeout(Duration::from_secs(15));
    }
    if let Some(t) = worker_thread {
        drop(work_tx);
        let _ = t.join();
    }
    if let Some(t) = &ctx.tray {
        t.remove();
    }
    ipc::unbind();
    log(&data, "stopped");
}
