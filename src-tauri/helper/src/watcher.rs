//! Which programs are running, by name only. Anti-cheat safe by construction: one Toolhelp snapshot of
//! the process list (the same list Task Manager shows), read and closed. No game process is opened,
//! read, injected into or signalled; no driver, hook or overlay is involved.
//!
//! Why a poll and not WMI events: process start/stop *traces* (Win32_ProcessStartTrace) need admin
//! rights, and `__InstanceCreationEvent ... WITHIN n` is itself a poll, done by the WMI service with
//! far more work per round than one snapshot here. The helper takes a snapshot every
//! `POLL` only while at least one game has a profile; with none, it doesn't look at all.
//!
//! Linux: the same poll over /proc (`ProcFs`): each process's command line and short name, read and closed,
//! nothing else. A Proton game's command line starts with its Windows path ("Z:\...\cs2.exe"), and a native
//! game's name gets ".exe" after its build suffix (`games::process_name`), so one profile serves both.

use std::collections::HashSet;
use std::time::Duration;

/// How often the process list is read while a profile exists.
pub const POLL: Duration = Duration::from_secs(2);

/// Where the running program names come from (lower case, e.g. "cs2.exe"). Tests use a fake.
pub trait ProcessSource {
    fn names(&mut self) -> Result<HashSet<String>, String>;
}

/// The real one: CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS).
#[cfg(windows)]
pub struct Toolhelp;

/// This OS's process list.
#[cfg(windows)]
pub use Toolhelp as Native;
#[cfg(unix)]
pub use ProcFs as Native;

/// Linux: /proc. Reads each process's `cmdline` and `comm` (both readable by the owner of any process
/// listed there); nothing is opened beyond those two files.
#[cfg(unix)]
pub struct ProcFs;

/// One process's names as games are matched by them: its command line's first word (path removed: a
/// Proton game's is a Windows path, "Z:\...\Game.exe") and the kernel's short name (15 characters at
/// most), each lower case and ending in .exe.
#[cfg_attr(windows, allow(dead_code))]
pub fn names_from(cmdline: &[u8], comm: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let first = cmdline.split(|&b| b == 0).next().unwrap_or(&[]);
    let first = String::from_utf8_lossy(first);
    let base = first.rsplit(['/', '\\']).next().unwrap_or("").trim();
    for raw in [base, comm.trim()] {
        if !raw.is_empty() && !raw.contains(char::is_control) {
            let n = crate::games::process_name(raw);
            if !out.contains(&n) {
                out.push(n);
            }
        }
    }
    out
}

#[cfg(unix)]
impl ProcFs {
    fn list() -> Result<Vec<(u32, String)>, String> {
        let mut out = Vec::with_capacity(512);
        for e in std::fs::read_dir("/proc").map_err(|e| e.to_string())?.flatten() {
            let Some(pid) = e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
            let dir = e.path();
            let cmdline = std::fs::read(dir.join("cmdline")).unwrap_or_default();
            let comm = std::fs::read_to_string(dir.join("comm")).unwrap_or_default();
            for n in names_from(&cmdline, &comm) {
                out.push((pid, n));
            }
        }
        Ok(out)
    }
}

#[cfg(unix)]
impl ProcessSource for ProcFs {
    fn names(&mut self) -> Result<HashSet<String>, String> {
        Ok(Self::list()?.into_iter().map(|(_, n)| n).collect())
    }
}

/// Equalizer APO's editor only exists on Windows.
#[cfg(unix)]
pub fn eapo_editor_open() -> bool {
    false
}

#[cfg(windows)]
fn name_of(entry: &windows::Win32::System::Diagnostics::ToolHelp::PROCESSENTRY32W) -> String {
    let end = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
    String::from_utf16_lossy(&entry.szExeFile[..end]).to_ascii_lowercase()
}

/// Every running process as (pid, lower-case name).
#[cfg(windows)]
fn snapshot() -> Result<Vec<(u32, String)>, String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS};
    let mut out = Vec::with_capacity(256);
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).map_err(|e| e.to_string())?;
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                out.push((entry.th32ProcessID, name_of(&entry)));
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    Ok(out)
}

#[cfg(windows)]
impl ProcessSource for Toolhelp {
    fn names(&mut self) -> Result<HashSet<String>, String> {
        Ok(snapshot()?.into_iter().map(|(_, n)| n).collect())
    }
}

/// Whether SYNQ itself (the app) is running: the battery check leaves devices alone then.
pub fn names_include(names: &HashSet<String>, exe: &str) -> bool {
    names.contains(exe)
}

/// The Equalizer APO Configuration Editor, left open, rewrites config.txt from its own stale copy
/// (the desktop app checks the same before an EQ write). Only a process named Editor.exe is looked at,
/// for its path; nothing else is opened.
#[cfg(windows)]
pub fn eapo_editor_open() -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW};
    let Ok(list) = snapshot() else { return false };
    list.iter().filter(|(_, n)| n == "editor.exe").any(|(pid, _)| unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, *pid) else { return false };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        ok && String::from_utf16_lossy(&buf[..len as usize]).to_ascii_lowercase().contains("equalizerapo")
    })
}

#[cfg(test)]
pub mod fake {
    use super::*;

    /// A process list the test sets by hand.
    #[derive(Default)]
    pub struct FakeProcesses {
        pub running: HashSet<String>,
        pub reads: usize,
    }

    impl FakeProcesses {
        pub fn set(&mut self, names: &[&str]) {
            self.running = names.iter().map(|s| s.to_string()).collect();
        }
    }

    impl ProcessSource for FakeProcesses {
        fn names(&mut self) -> Result<HashSet<String>, String> {
            self.reads += 1;
            Ok(self.running.clone())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proton_and_native_names_are_read_like_windows_ones() {
        // A Proton game: wine puts the Windows path first; the kernel's name is cut at 15 characters.
        assert_eq!(names_from(b"Z:\\home\\me\\.steam\\steam\\steamapps\\common\\Apex\\r5apex_dx12.exe\0-novid\0", "r5apex_dx12.exe\n"), vec!["r5apex_dx12.exe".to_string()]);
        assert_eq!(names_from(b"C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe\0", "VALORANT-Win64-"), vec!["valorant-win64-shipping.exe".to_string(), "valorant-win64-.exe".to_string()]);
        // CS2's native build, and the app itself (so the battery check leaves devices alone while it's open).
        assert_eq!(names_from(b"/home/me/.steam/steam/steamapps/common/Counter-Strike Global Offensive/game/bin/linuxsteamrt64/cs2\0-steam\0", "cs2"), vec!["cs2.exe".to_string()]);
        assert!(names_include(&names_from(b"/usr/bin/synq\0", "synq").into_iter().collect(), "synq.exe"));
        // Kernel threads have no command line; nothing odd gets through.
        assert_eq!(names_from(b"", "kworker/0:1"), vec!["kworker/0:1.exe".to_string()]);
        assert!(names_from(b"\0", "").is_empty());
    }

    /// Reads this machine's process list from /proc (a read of the list only). The test process itself must
    /// be in it, under the name a game's profile would use.
    #[cfg(unix)]
    #[test]
    fn the_proc_list_sees_this_process() {
        let mine = crate::games::process_name(&std::env::current_exe().unwrap().file_name().unwrap().to_string_lossy());
        let names = ProcFs.names().unwrap();
        assert!(names.iter().any(|n| mine.starts_with(n.trim_end_matches(".exe")) || *n == mine), "{mine}");
        assert!(names.len() > 3);
        assert!(names.iter().all(|n| *n == n.to_ascii_lowercase() && n.ends_with(".exe")));
    }

    /// Reads this machine's process list (a read of the list only; nothing is opened). The test
    /// process itself must be in it.
    #[cfg(windows)]
    #[test]
    fn the_snapshot_sees_this_process() {
        let mine = std::env::current_exe().unwrap().file_name().unwrap().to_string_lossy().to_ascii_lowercase();
        let names = Toolhelp.names().unwrap();
        assert!(names.contains(&mine), "{mine}");
        assert!(names.len() > 5);
        assert!(names.iter().all(|n| *n == n.to_ascii_lowercase()));
    }
}
