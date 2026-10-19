//! SYNQ Helper on its own, for the website (synqhub.app): one file, synq-helper.exe, downloaded and double-clicked.
//! It then puts itself in the user's own folder (%LOCALAPPDATA%\SYNQ Helper, no administrator), turns itself on,
//! starts at sign-in and appears in Windows' installed apps, where it is removed like any app (`--uninstall-self`).
//! With the SYNQ desktop app installed, a double-click turns that copy of the helper on instead of adding a second.
//!
//! The choice of where to run is `plan` (no side effects, tested); the Windows parts are below it.

use std::path::{Path, PathBuf};

/// The folder a helper installed on its own lives in, under %LOCALAPPDATA%.
pub const DIR_NAME: &str = "SYNQ Helper";
/// SYNQ's own program, beside a helper installed on its own: never shown, it only puts game profiles on with no window
/// (src/pass.rs). The website's download carries it (`--features with-app`).
pub const BACKGROUND_EXE: &str = "synq-profiles.exe";
/// Its entry among the installed apps (HKCU\...\Uninstall\<this>).
pub const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\SYNQ Helper";
/// The desktop app's entry, whose InstallLocation holds the helper the installer put there.
pub const DESKTOP_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\SYNQ";

/// What a double-click on synq-helper.exe does.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    /// This copy is the installed one (the desktop app's, or the one installed on its own): run here.
    RunHere,
    /// The desktop app is installed: turn its helper on and start it.
    UseDesktop(PathBuf),
    /// A downloaded copy: install it to the user's folder and start it from there.
    InstallTo(PathBuf),
}

/// Where a double-click on `me` should run the helper from. `desktop`: the desktop app's helper, when SYNQ is
/// installed; `own_dir`: the folder for a helper installed on its own.
pub fn plan(me: &Path, desktop: Option<&Path>, own_dir: &Path) -> Plan {
    let same = |a: &Path, b: &Path| a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy());
    if desktop.is_some_and(|d| same(d, me)) || me.parent().is_some_and(|p| same(p, own_dir)) {
        return Plan::RunHere;
    }
    match desktop {
        Some(d) => Plan::UseDesktop(d.to_path_buf()),
        None => Plan::InstallTo(own_dir.join(crate::helper_cfg::HELPER_EXE)),
    }
}

#[cfg(windows)]
pub use win::*;

#[cfg(windows)]
mod win {
    use super::{BACKGROUND_EXE, DESKTOP_KEY, DIR_NAME, UNINSTALL_KEY};
    use crate::helper_cfg;
    use std::path::{Path, PathBuf};
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    /// %LOCALAPPDATA%\SYNQ Helper.
    pub fn own_dir() -> Option<PathBuf> {
        std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join(DIR_NAME))
    }

    /// The desktop app's helper, from its uninstall entry (the value is quoted), when the file is there.
    pub fn desktop_helper() -> Option<PathBuf> {
        let key = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(DESKTOP_KEY).ok()?;
        let loc: String = key.get_value("InstallLocation").ok()?;
        let exe = PathBuf::from(loc.trim().trim_matches('"')).join(helper_cfg::HELPER_EXE);
        exe.is_file().then_some(exe)
    }

    /// The SYNQ program this download carries (`--features with-app`), or nothing.
    #[cfg(feature = "with-app")]
    const APP: &[u8] = include_bytes!(env!("SYNQ_APP_EXE"));
    #[cfg(not(feature = "with-app"))]
    const APP: &[u8] = &[];

    /// Puts the carried SYNQ program beside the helper (replacing an older one; one that is running stays until next
    /// time). Without it, profiles for most devices switch only while the website is open.
    fn write_background(dir: &Path) {
        if APP.is_empty() {
            return;
        }
        let dest = dir.join(BACKGROUND_EXE);
        let fresh = dir.join(format!("{BACKGROUND_EXE}.new"));
        if std::fs::write(&fresh, APP).is_ok() && std::fs::rename(&fresh, &dest).is_err() {
            let _ = std::fs::remove_file(&fresh);
        }
    }

    /// Copies this exe into `target` (replacing an older copy), with the SYNQ program it carries, and lists it among
    /// the installed apps.
    pub fn install(me: &Path, target: &Path) -> Result<(), String> {
        let dir = target.parent().ok_or("No folder to install to.")?;
        std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't make {}: {e}", dir.display()))?;
        std::fs::copy(me, target).map_err(|e| format!("Couldn't copy SYNQ Helper to {}: {e}", dir.display()))?;
        write_background(dir);
        let size = |p: &Path| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        let size_kb = ((size(target) + size(&dir.join(BACKGROUND_EXE))) / 1024) as u32;
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(UNINSTALL_KEY).map_err(|e| e.to_string())?;
        let exe = target.display().to_string();
        let set = |name: &str, v: &str| key.set_value(name, &v.to_string()).map_err(|e| e.to_string());
        set("DisplayName", "SYNQ Helper")?;
        set("DisplayVersion", env!("CARGO_PKG_VERSION"))?;
        set("Publisher", "logan-wurx")?;
        set("DisplayIcon", &format!("{exe},0"))?;
        set("InstallLocation", &dir.display().to_string())?;
        set("URLInfoAbout", helper_cfg::SITE_ORIGIN)?;
        set("UninstallString", &format!("\"{exe}\" --uninstall-self"))?;
        key.set_value("NoModify", &1u32).map_err(|e| e.to_string())?;
        key.set_value("NoRepair", &1u32).map_err(|e| e.to_string())?;
        key.set_value("EstimatedSize", &size_kb).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// `--uninstall-self`, from the installed apps: the sign-in entry and the apps entry go, and the folder is
    /// deleted once this process has exited (it runs from there). The settings stay with the app's data.
    pub fn uninstall(dir: &Path) {
        let _ = helper_cfg::apply_autostart(&mut helper_cfg::SystemRunKey::default(), false, Path::new(""));
        let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(UNINSTALL_KEY);
        if dir.ends_with(DIR_NAME) {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            // A moment for this process to exit, then the folder goes. Only ever the helper's own folder.
            let _ = std::process::Command::new("cmd")
                .args(["/c", "ping", "127.0.0.1", "-n", "3", ">", "nul", "&", "rmdir", "/s", "/q"])
                .arg(dir)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        }
    }

    /// A plain message for the person who double-clicked (no tray icon yet to speak from).
    pub fn tell(text: &str) {
        use windows::core::PCWSTR;
        use windows::Win32::UI::WindowsAndMessaging::{MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND, MessageBoxW};
        let t: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let c: Vec<u16> = "SYNQ Helper".encode_utf16().chain(std::iter::once(0)).collect();
        unsafe { MessageBoxW(None, PCWSTR(t.as_ptr()), PCWSTR(c.as_ptr()), MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND) };
    }

    /// Opens the website (the tray's "Open SYNQ" when no desktop app is next to this helper).
    pub fn open_site() {
        use windows::core::{w, PCWSTR};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let url: Vec<u16> = helper_cfg::SITE_ORIGIN.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe { ShellExecuteW(None, w!("open"), PCWSTR(url.as_ptr()), None, None, SW_SHOWNORMAL) };
    }
}

// The install-itself flow is Windows' (the website's one file); its paths are Windows paths.
#[cfg(all(test, windows))]
mod tests {
    use super::*;

    const OWN: &str = r"C:\Users\me\AppData\Local\SYNQ Helper";

    #[test]
    fn a_downloaded_copy_installs_itself_without_the_desktop_app() {
        let me = Path::new(r"C:\Users\me\Downloads\synq-helper.exe");
        assert_eq!(plan(me, None, Path::new(OWN)), Plan::InstallTo(Path::new(OWN).join("synq-helper.exe")));
    }

    #[test]
    fn with_the_desktop_app_its_helper_is_used() {
        let me = Path::new(r"C:\Users\me\Downloads\synq-helper (1).exe");
        let desktop = Path::new(r"C:\Program Files\SYNQ\synq-helper.exe");
        assert_eq!(plan(me, Some(desktop), Path::new(OWN)), Plan::UseDesktop(desktop.to_path_buf()));
    }

    #[test]
    fn an_installed_copy_runs_where_it_is() {
        let desktop = Path::new(r"C:\Program Files\SYNQ\synq-helper.exe");
        assert_eq!(plan(desktop, Some(desktop), Path::new(OWN)), Plan::RunHere);
        let own = Path::new(OWN).join("synq-helper.exe");
        assert_eq!(plan(&own, None, Path::new(OWN)), Plan::RunHere);
        // Windows paths don't care about case.
        let shouty = PathBuf::from(r"C:\USERS\ME\APPDATA\LOCAL\SYNQ HELPER\synq-helper.exe");
        assert_eq!(plan(&shouty, None, Path::new(OWN)), Plan::RunHere);
    }
}
