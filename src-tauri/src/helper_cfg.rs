//! SYNQ Helper's switches, shared by the app (Settings > SYNQ Helper) and the helper itself
//! (src-tauri/helper). The helper is off by default: nothing runs in the background until the person
//! turns it on, and turning it off stops it and removes its sign-in entry.
//!
//! - `helper.json` in the app data folder holds the switches. Only the app writes it.
//! - The sign-in entry is the per-user Run key (HKCU, no admin) on Windows, and
//!   ~/.config/autostart/synq-helper.desktop on Linux; written only while the helper is on.
//! - The app tells a running helper to re-read its files, or to quit, through two named events on
//!   Windows (a helper that is running owns the quit event, so "is it running" is "does that event
//!   exist"), and through a Unix socket in the login's runtime folder on Linux.
//!
//! No device I/O here.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The helper's file name, next to synq.exe.
#[cfg(windows)]
pub const HELPER_EXE: &str = "synq-helper.exe";
/// The helper's file name, next to the app's binary.
#[cfg(not(windows))]
pub const HELPER_EXE: &str = "synq-helper";
/// The app's data folder name (Tauri's identifier).
pub const APP_DIR: &str = "com.logan.onboard";
pub const SETTINGS_FILE: &str = "helper.json";
/// The helper's own record of the sites the person paired (written only by the helper).
pub const PAIRINGS_FILE: &str = "helper-pairings.json";
/// Per-game profiles (src/games.rs), written by the app's Games page.
pub const GAMES_FILE: &str = "games.json";

// The helper's Windows names below keep the app's old name (SYNQ was OnBoard): they are how an installed app and its
// helper find each other, and an update from an OnBoard install still has to reach that one's helper.

/// HKCU\Software\Microsoft\Windows\CurrentVersion\Run, value name.
pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
pub const RUN_VALUE: &str = "OnBoardHelper";
/// The flag the sign-in entry starts the helper with.
pub const AUTOSTART_FLAG: &str = "--autostart";

/// Named events (this sign-in session only).
pub const QUIT_EVENT: &str = r"Local\OnBoardHelper.Quit";
pub const RELOAD_EVENT: &str = r"Local\OnBoardHelper.Reload";

/// The web bridge's fixed port on 127.0.0.1.
pub const BRIDGE_PORT: u16 = 17860;
/// The website's origin. A placeholder until the site is deployed: keep it in step with
/// src/lib/web/links.ts (`SITE_ORIGIN`).
pub const SITE_ORIGIN: &str = "https://synqhub.app";
/// `npm run dev:web` and `npm run preview:web`: allowed in debug builds of the helper only.
pub const DEV_ORIGINS: [&str; 4] = ["http://localhost:1421", "http://127.0.0.1:1421", "http://localhost:4173", "http://127.0.0.1:4173"];

/// The switches. `enabled` is the master switch; the three features can be turned off one by one.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct HelperSettings {
    pub enabled: bool,
    pub game_profiles: bool,
    pub battery_alerts: bool,
    /// Battery alert levels in %, highest first (the helper checks them: 1 to 5 distinct levels, 1..=50).
    pub battery_levels: Vec<u8>,
    pub web_bridge: bool,
}

impl Default for HelperSettings {
    fn default() -> Self {
        Self { enabled: false, game_profiles: true, battery_alerts: true, battery_levels: vec![20, 10, 5], web_bridge: true }
    }
}

/// %APPDATA%\com.logan.onboard (where Tauri's `app_data_dir` points for this app).
#[cfg(windows)]
pub fn app_data_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join(APP_DIR))
}

/// Where Tauri's `app_data_dir` points for this app: $XDG_DATA_HOME/com.logan.onboard
/// (~/.local/share/com.logan.onboard) on Linux, ~/Library/Application Support/com.logan.onboard on macOS.
#[cfg(not(windows))]
pub fn app_data_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from).filter(|h| h.is_absolute());
    if cfg!(target_os = "macos") {
        return home.map(|h| h.join("Library").join("Application Support").join(APP_DIR));
    }
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| home.map(|h| h.join(".local").join("share")))
        .map(|d| d.join(APP_DIR))
}

pub fn load_settings(dir: &Path) -> HelperSettings {
    std::fs::read_to_string(dir.join(SETTINGS_FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save_settings(dir: &Path, s: &HelperSettings) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(SETTINGS_FILE), &text)
}

/// Writes through a temporary file and a rename, so a reader never sees half a file.
pub fn write_atomic(target: &Path, text: &str) -> Result<(), String> {
    let tmp = target.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, target).map_err(|e| format!("Could not replace {}: {e}", target.display()))
}

// ---- the sign-in entry

/// The Run key, as the code that writes it sees it. The real one is `WinRunKey`; tests use a map.
pub trait RunKey {
    fn get(&self, name: &str) -> Option<String>;
    fn set(&mut self, name: &str, value: &str) -> Result<(), String>;
    fn delete(&mut self, name: &str) -> Result<(), String>;
}

/// What the sign-in entry runs.
#[cfg(windows)]
pub fn run_command(exe: &Path) -> String {
    format!("\"{}\" {AUTOSTART_FLAG}", exe.display())
}

/// What the sign-in entry runs, as a desktop entry's Exec line: the helper, or an AppImage with --helper
/// (an AppImage's own files only exist while it runs, so the entry starts the AppImage itself).
#[cfg(not(windows))]
pub fn run_command(exe: &Path) -> String {
    let appimage = exe.file_name().is_some_and(|n| n.to_string_lossy().to_ascii_lowercase().ends_with(".appimage"));
    format!("{}{} {AUTOSTART_FLAG}", exec_quote(&exe.to_string_lossy()), if appimage { " --helper" } else { "" })
}

/// One argument quoted the way the desktop entry spec wants it in Exec: in double quotes, with the
/// characters " ` $ and backslash escaped, and % doubled.
#[cfg(not(windows))]
pub fn exec_quote(arg: &str) -> String {
    let mut out = String::from("\"");
    for c in arg.chars() {
        match c {
            '"' | '`' | '$' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            '%' => out.push_str("%%"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// What the sign-in entry starts: the helper next to the app, or, from an AppImage, the AppImage itself.
#[cfg(not(windows))]
pub fn autostart_target(helper_exe: &Path) -> PathBuf {
    std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|p| p.is_file()).unwrap_or_else(|| helper_exe.to_path_buf())
}

#[cfg(windows)]
pub fn autostart_target(helper_exe: &Path) -> PathBuf {
    helper_exe.to_path_buf()
}

/// Puts the sign-in entry in place when `on` (pointing at `exe`), removes it when not. Touches only
/// the one value; an entry that is already right is left alone.
pub fn apply_autostart(reg: &mut dyn RunKey, on: bool, exe: &Path) -> Result<(), String> {
    if on {
        let want = run_command(exe);
        if reg.get(RUN_VALUE).as_deref() != Some(want.as_str()) {
            reg.set(RUN_VALUE, &want)?;
        }
    } else if reg.get(RUN_VALUE).is_some() {
        reg.delete(RUN_VALUE)?;
    }
    Ok(())
}

/// HKCU\...\Run through winreg. Per user, no admin.
#[cfg(windows)]
#[derive(Default)]
pub struct WinRunKey;

/// The sign-in entry of this OS.
#[cfg(windows)]
pub type SystemRunKey = WinRunKey;
#[cfg(not(windows))]
pub type SystemRunKey = XdgAutostart;

#[cfg(windows)]
impl RunKey for WinRunKey {
    fn get(&self, name: &str) -> Option<String> {
        let key = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).open_subkey(RUN_KEY).ok()?;
        key.get_value::<String, _>(name).ok()
    }

    fn set(&mut self, name: &str, value: &str) -> Result<(), String> {
        let (key, _) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
        key.set_value(name, &value.to_string()).map_err(|e| e.to_string())
    }

    fn delete(&mut self, name: &str) -> Result<(), String> {
        let key = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .open_subkey_with_flags(RUN_KEY, winreg::enums::KEY_SET_VALUE)
            .map_err(|e| e.to_string())?;
        match key.delete_value(name) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Linux: the sign-in entry is ~/.config/autostart/synq-helper.desktop (the XDG autostart spec, which
/// every desktop follows). Only that one file is ever read, written or removed.
#[cfg(not(windows))]
pub struct XdgAutostart {
    pub dir: PathBuf,
}

#[cfg(not(windows))]
pub const AUTOSTART_FILE: &str = "synq-helper.desktop";

#[cfg(not(windows))]
impl Default for XdgAutostart {
    fn default() -> Self {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
            .unwrap_or_else(|| PathBuf::from(".config"));
        Self { dir: config.join("autostart") }
    }
}

/// The desktop entry that starts the helper at login (`exec` is already an Exec line; a backslash is
/// written twice, as a desktop entry's string escaping wants).
#[cfg(not(windows))]
pub fn desktop_entry(exec: &str) -> String {
    let lines = [
        "[Desktop Entry]".to_string(),
        "Type=Application".into(),
        "Name=SYNQ Helper".into(),
        "Comment=SYNQ's game profiles, battery alerts and web bridge. Turn it off in SYNQ's Settings.".into(),
        format!("Exec={}", exec.replace('\\', "\\\\")),
        "Icon=onboard".into(),
        "Terminal=false".into(),
        "NoDisplay=true".into(),
        "X-GNOME-Autostart-enabled=true".into(),
    ];
    lines.join("\n") + "\n"
}

#[cfg(not(windows))]
impl RunKey for XdgAutostart {
    fn get(&self, name: &str) -> Option<String> {
        if name != RUN_VALUE {
            return None;
        }
        let text = std::fs::read_to_string(self.dir.join(AUTOSTART_FILE)).ok()?;
        text.lines().find_map(|l| l.strip_prefix("Exec=")).map(|v| v.replace("\\\\", "\\"))
    }

    fn set(&mut self, name: &str, value: &str) -> Result<(), String> {
        if name != RUN_VALUE {
            return Err("Only SYNQ Helper's own entry is written.".into());
        }
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("Could not create {}: {e}", self.dir.display()))?;
        write_atomic(&self.dir.join(AUTOSTART_FILE), &desktop_entry(value))
    }

    fn delete(&mut self, name: &str) -> Result<(), String> {
        if name != RUN_VALUE {
            return Ok(());
        }
        match std::fs::remove_file(self.dir.join(AUTOSTART_FILE)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

// ---- talking to a running helper

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Sets one of the helper's named events. False when no helper is running.
#[cfg(windows)]
pub fn signal(name: &str) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{EVENT_MODIFY_STATE, OpenEventW, SetEvent};
    let n = wide(name);
    unsafe {
        match OpenEventW(EVENT_MODIFY_STATE, false, windows::core::PCWSTR(n.as_ptr())) {
            Ok(h) => {
                let ok = SetEvent(h).is_ok();
                let _ = CloseHandle(h);
                ok
            }
            Err(_) => false,
        }
    }
}

/// Whether a helper is running in this sign-in session (it owns the quit event).
#[cfg(windows)]
pub fn helper_running() -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenEventW, SYNCHRONIZATION_SYNCHRONIZE};
    let n = wide(QUIT_EVENT);
    unsafe {
        match OpenEventW(SYNCHRONIZATION_SYNCHRONIZE, false, windows::core::PCWSTR(n.as_ptr())) {
            Ok(h) => {
                let _ = CloseHandle(h);
                true
            }
            Err(_) => false,
        }
    }
}

/// Unix: the helper's socket, in the login's runtime folder (only this user can reach it), else in the app
/// data folder.
#[cfg(unix)]
pub fn socket_path() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|d| d.is_absolute() && d.is_dir())
        .map(|d| d.join("synq-helper.sock"))
        .or_else(|| app_data_dir().map(|d| d.join("helper.sock")))
        .unwrap_or_else(|| PathBuf::from("synq-helper.sock"))
}

/// Unix: what a signal is called on the helper's socket.
#[cfg(unix)]
pub fn command_word(name: &str) -> Option<&'static str> {
    match name {
        QUIT_EVENT => Some("quit"),
        RELOAD_EVENT => Some("reload"),
        "ping" => Some("ping"),
        _ => None,
    }
}

/// Unix: sends one word to a running helper and waits for its "ok".
#[cfg(unix)]
fn ask_helper(word: &str) -> bool {
    use std::io::{BufRead, BufReader, Write};
    let Ok(mut s) = std::os::unix::net::UnixStream::connect(socket_path()) else { return false };
    let _ = s.set_read_timeout(Some(std::time::Duration::from_millis(2000)));
    let _ = s.set_write_timeout(Some(std::time::Duration::from_millis(1000)));
    if writeln!(s, "{word}").is_err() {
        return false;
    }
    let mut line = String::new();
    BufReader::new(&s).read_line(&mut line).is_ok() && line.trim() == "ok"
}

/// Tells a running helper to re-read its files (RELOAD_EVENT) or to quit (QUIT_EVENT). False when no
/// helper is running.
#[cfg(unix)]
pub fn signal(name: &str) -> bool {
    command_word(name).is_some_and(ask_helper)
}

/// Whether a helper is running for this login (it answers on its socket).
#[cfg(unix)]
pub fn helper_running() -> bool {
    ask_helper("ping")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// The Run key as a map: the tests never write the real one.
    #[derive(Default)]
    pub struct FakeRunKey {
        pub values: HashMap<String, String>,
        pub writes: usize,
    }

    impl RunKey for FakeRunKey {
        fn get(&self, name: &str) -> Option<String> {
            self.values.get(name).cloned()
        }
        fn set(&mut self, name: &str, value: &str) -> Result<(), String> {
            self.writes += 1;
            self.values.insert(name.into(), value.into());
            Ok(())
        }
        fn delete(&mut self, name: &str) -> Result<(), String> {
            self.writes += 1;
            self.values.remove(name);
            Ok(())
        }
    }

    #[test]
    fn off_by_default() {
        let s = HelperSettings::default();
        assert!(!s.enabled);
        // An old or partial file keeps the helper off.
        let parsed: HelperSettings = serde_json::from_str("{}").unwrap();
        assert!(!parsed.enabled);
        let parsed: HelperSettings = serde_json::from_str(r#"{"batteryAlerts":false}"#).unwrap();
        assert!(!parsed.enabled && !parsed.battery_alerts && parsed.game_profiles);
        assert_eq!(parsed.battery_levels, vec![20, 10, 5], "default levels");
    }

    #[cfg(windows)]
    #[test]
    fn autostart_is_written_only_when_on_and_removed_when_off() {
        let exe = PathBuf::from(r"C:\Program Files\SYNQ\synq-helper.exe");
        let mut reg = FakeRunKey::default();
        reg.values.insert("SomethingElse".into(), "x.exe".into());
        apply_autostart(&mut reg, false, &exe).unwrap();
        assert_eq!(reg.writes, 0, "off and absent: nothing is written");
        apply_autostart(&mut reg, true, &exe).unwrap();
        assert_eq!(reg.get(RUN_VALUE).unwrap(), r#""C:\Program Files\SYNQ\synq-helper.exe" --autostart"#);
        apply_autostart(&mut reg, true, &exe).unwrap();
        assert_eq!(reg.writes, 1, "an entry that is already right is left alone");
        let moved = PathBuf::from(r"D:\Apps\SYNQ\synq-helper.exe");
        apply_autostart(&mut reg, true, &moved).unwrap();
        assert!(reg.get(RUN_VALUE).unwrap().contains(r"D:\Apps"), "a moved install is followed");
        apply_autostart(&mut reg, false, &exe).unwrap();
        assert!(reg.get(RUN_VALUE).is_none());
        assert_eq!(reg.get("SomethingElse").as_deref(), Some("x.exe"), "other entries are never touched");
    }

    /// Linux: the same rules, with the entry's Exec line in the desktop-entry syntax.
    #[cfg(not(windows))]
    #[test]
    fn autostart_entry_is_written_only_when_on_and_removed_when_off() {
        let exe = PathBuf::from("/usr/bin/synq-helper");
        let mut reg = FakeRunKey::default();
        apply_autostart(&mut reg, false, &exe).unwrap();
        assert_eq!(reg.writes, 0);
        apply_autostart(&mut reg, true, &exe).unwrap();
        assert_eq!(reg.get(RUN_VALUE).unwrap(), r#""/usr/bin/synq-helper" --autostart"#);
        apply_autostart(&mut reg, true, &exe).unwrap();
        assert_eq!(reg.writes, 1, "an entry that is already right is left alone");
        let appimage = PathBuf::from("/home/me/Apps/SYNQ_0.1.0_amd64.AppImage");
        apply_autostart(&mut reg, true, &appimage).unwrap();
        assert_eq!(reg.get(RUN_VALUE).unwrap(), r#""/home/me/Apps/SYNQ_0.1.0_amd64.AppImage" --helper --autostart"#);
        apply_autostart(&mut reg, false, &exe).unwrap();
        assert!(reg.get(RUN_VALUE).is_none());
        // Reserved characters are escaped as the desktop entry spec says.
        assert_eq!(exec_quote(r#"/opt/a "b" $c `d` \e 100%"#), r#""/opt/a \"b\" \$c \`d\` \\e 100%%""#);
    }

    /// The real autostart folder, in a temporary directory: one file, written and read back, then removed.
    #[cfg(not(windows))]
    #[test]
    fn the_xdg_autostart_file_round_trips() {
        let dir = std::env::temp_dir().join(format!("onboard-autostart-{}", std::process::id()));
        let mut a = XdgAutostart { dir: dir.clone() };
        let exec = run_command(Path::new("/opt/On Board/synq-helper"));
        a.set(RUN_VALUE, &exec).unwrap();
        let text = std::fs::read_to_string(dir.join(AUTOSTART_FILE)).unwrap();
        assert!(text.starts_with("[Desktop Entry]\nType=Application\n") && text.contains("NoDisplay=true"));
        assert_eq!(a.get(RUN_VALUE).as_deref(), Some(exec.as_str()));
        assert!(a.set("SomethingElse", "x").is_err(), "only the helper's own entry");
        a.delete(RUN_VALUE).unwrap();
        assert!(a.get(RUN_VALUE).is_none() && !dir.join(AUTOSTART_FILE).exists());
        a.delete(RUN_VALUE).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_round_trip() {
        let dir = std::env::temp_dir().join(format!("synq-helper-cfg-{}", std::process::id()));
        let s = HelperSettings { enabled: true, game_profiles: false, battery_alerts: true, battery_levels: vec![25, 5], web_bridge: false };
        save_settings(&dir, &s).unwrap();
        assert_eq!(load_settings(&dir), s);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
