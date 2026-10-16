//! Getting the official Equalizer APO installer (bundled with SYNQ, or downloaded from its
//! SourceForge release) and running it with no windows. Everything here except `bundled*` runs in
//! the elevated helper only.

use super::model::{INSTALLER_FILE, INSTALLER_SHA256, INSTALLER_SIZE, INSTALLER_URL};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Scheduled task the official installer adds (its "Check for updates automatically" part, on by
/// default and not switchable in a silent install). It starts UpdateChecker.exe at every logon.
pub const UPDATE_TASK: &str = "EqualizerAPOUpdateChecker";

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Right size and the SHA-256 SourceForge publishes for this release.
pub fn verified(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.len() == INSTALLER_SIZE) && sha256_file(path).is_ok_and(|h| h == INSTALLER_SHA256)
}

/// Where SYNQ's installer puts the bundled copy: the `eq-engine` resource folder next to the
/// exe (also where `tauri dev` copies it).
pub fn bundled_path() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    Some(dir.join("eq-engine").join(INSTALLER_FILE))
}

/// Cheap check for the status screen (size only); the helper checks the hash before running it.
pub fn bundled_present() -> bool {
    bundled_path().is_some_and(|p| std::fs::metadata(p).is_ok_and(|m| m.len() == INSTALLER_SIZE))
}

/// A fresh folder under %SystemRoot%\Temp that only Administrators and SYSTEM can change, so the
/// installer can't be swapped between the hash check and the moment it runs. Removed on drop.
pub struct Staging(PathBuf);

impl Staging {
    pub fn new() -> Result<Staging, String> {
        let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("Temp");
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = root.join(format!("SYNQ-eq-engine-{}-{nanos}", std::process::id()));
        std::fs::create_dir(&dir).map_err(|e| format!("Couldn't make a folder for the installer: {e}"))?;
        let staging = Staging(dir);
        let locked = Command::new(system32("icacls.exe"))
            .arg(&staging.0)
            .args(["/inheritance:r", "/grant:r", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "/Q"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .is_ok_and(|s| s.success());
        if !locked {
            return Err("Couldn't protect the installer's folder, so nothing was installed.".into());
        }
        Ok(staging)
    }

    /// A checked copy of the installer in this folder, from `source` or downloaded.
    pub fn installer(&self, source: Option<&Path>, log: &mut Vec<String>) -> Result<PathBuf, String> {
        let dest = self.0.join(INSTALLER_FILE);
        match source {
            Some(src) => {
                std::fs::copy(src, &dest).map_err(|e| format!("Couldn't copy the EQ engine installer: {e}"))?;
                log.push(format!("Copied {} for checking", src.display()));
            }
            None => {
                download(&dest)?;
                log.push(format!("Downloaded {INSTALLER_URL}"));
            }
        }
        if !verified(&dest) {
            return Err("The EQ engine installer didn't match the official file, so it wasn't run.".into());
        }
        log.push(format!("SHA-256 matches the official release ({INSTALLER_SHA256})"));
        Ok(dest)
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn system32(exe: &str) -> PathBuf {
    std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("System32").join(exe)
}

/// The official release, with Windows' own curl.exe.
fn download(dest: &Path) -> Result<(), String> {
    let status = Command::new(system32("curl.exe"))
        .args(["--location", "--fail", "--silent", "--show-error", "--max-time", "300", "--proto", "=https", "--output"])
        .arg(dest)
        .arg(INSTALLER_URL)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| format!("Couldn't start the download: {e}"))?;
    if status.success() { Ok(()) } else { Err("Couldn't download the EQ engine. Check the internet connection and try again.".into()) }
}

/// Runs the official installer with NSIS's `/S`. Its script still starts `DeviceSelector.exe /i`
/// (a window asking which outputs to use) after copying its files; that window is closed as soon
/// as it appears, before it changes anything, because SYNQ sets the output up itself right
/// after. Closing it makes the script set its reboot flag, which a silent install ignores.
pub fn run_silent(installer: &Path, log: &mut Vec<String>) -> Result<(), String> {
    if !verified(installer) {
        return Err("The EQ engine installer didn't match the official file, so it wasn't run.".into());
    }
    let mut child = Command::new(installer)
        .arg("/S")
        .current_dir(installer.parent().unwrap_or(Path::new(".")))
        .spawn()
        .map_err(|e| format!("Couldn't start the EQ engine installer: {e}"))?;
    let pid = sysinfo::Pid::from_u32(child.id());
    log.push(format!("Started {} /S", installer.display()));
    let started = Instant::now();
    let mut sys = sysinfo::System::new();
    let refresh = sysinfo::ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::OnlyIfNotSet);
    let mut closed_picker = false;
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if !status.success() {
                return Err(format!("The EQ engine installer stopped with an error ({status})."));
            }
            log.push("The installer finished".into());
            break;
        }
        if started.elapsed() > Duration::from_secs(300) {
            let _ = child.kill();
            return Err("The EQ engine installer took too long and was stopped.".into());
        }
        sys.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, refresh);
        for p in sys.processes().values() {
            let picker = p.name().eq_ignore_ascii_case("DeviceSelector.exe")
                && (p.parent() == Some(pid) || p.exe().is_some_and(|e| e.to_string_lossy().to_ascii_lowercase().contains("equalizerapo")));
            if picker && p.kill() && !closed_picker {
                closed_picker = true;
                log.push("Closed the engine's own output picker (SYNQ picks the output)".into());
            }
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    Ok(())
}

/// Removes the logon update check the installer just added, so nothing of the engine runs on its
/// own. Uses schtasks.exe because it never shows a window (UpdateChecker.exe -u shows an error
/// dialog when the task isn't there).
pub fn remove_update_task(log: &mut Vec<String>) {
    let run = |args: &[&str]| Command::new(system32("schtasks.exe")).args(args).creation_flags(CREATE_NO_WINDOW).output().is_ok_and(|o| o.status.success());
    if !run(&["/Query", "/TN", UPDATE_TASK]) {
        return;
    }
    if run(&["/Delete", "/TN", UPDATE_TASK, "/F"]) {
        log.push(format!("Removed the engine's logon update check (scheduled task {UPDATE_TASK})"));
    } else {
        log.push(format!("Couldn't remove the scheduled task {UPDATE_TASK}"));
    }
}
