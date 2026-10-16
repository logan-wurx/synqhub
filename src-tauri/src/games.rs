//! Per-game profiles: what SYNQ Helper sends a mouse or keyboard when a game starts, and what puts
//! the everyday settings back when it ends. Shared by the app (the Games page edits `games.json`) and
//! the helper (src-tauri/helper reads it).
//!
//! A profile is made from settings, not by recording a device: the Games page edits DPI, polling,
//! actuation and so on with nothing sent to the device, and on save the app encodes them OFFLINE into
//! the exact reports the device's own driver sends (its pure frame builders, src/lib/profiles/encode.ts),
//! starting from the device's last-known state. `restore` is the same rows as they were in that state.
//! Replaying either goes through `hid::send_step`, so every report passes the same guards again, with no
//! Advanced grant; firmware and bootloader commands have no encoder and no guard lets them through.
//!
//! Games are recognised by their process name only; nothing reads, opens or touches a game's process.

use crate::hid::Step;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

pub const VERSION: u32 = 2;
pub const MAX_GAMES: usize = 400;
pub const MAX_EXES: usize = 4;
pub const MAX_EXE_LEN: usize = 64;
/// Reports per profile (and per restore set), at most.
pub const MAX_PROFILE_STEPS: usize = 400;
/// One report's payload, at most.
pub const MAX_STEP_BYTES: usize = 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProfile {
    /// The device's name as the app showed it.
    pub name: String,
    pub vendor_id: u16,
    pub product_id: u16,
    /// What is sent when the game starts.
    pub steps: Vec<Step>,
    /// What puts the everyday settings back (the same rows, as the device last had them).
    #[serde(default)]
    pub restore: Vec<Step>,
    /// The settings as the Games page edits them (the app's own format; the helper ignores it).
    #[serde(default)]
    pub settings: serde_json::Value,
    /// When it was saved (seconds since 1970). A newer save is sent again while the game runs.
    #[serde(default, alias = "recorded")]
    pub saved: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub id: String,
    pub name: String,
    /// Process names (lower case, e.g. "cs2.exe").
    pub exes: Vec<String>,
    /// One of the games SYNQ lists by itself (can't be removed, only left without a profile).
    #[serde(default)]
    pub builtin: bool,
    /// Its Steam app id, for the cover art.
    #[serde(default)]
    pub appid: Option<u32>,
    /// "Apply automatically": the helper follows this game.
    #[serde(default = "yes")]
    pub auto: bool,
    /// Device key (hid.rs `Summary::key`) -> its profile for this game.
    #[serde(default)]
    pub profiles: BTreeMap<String, DeviceProfile>,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GamesFile {
    pub version: u32,
    pub games: Vec<Game>,
}

/// A game SYNQ lists before any is added.
pub struct Seed {
    pub id: &'static str,
    pub name: &'static str,
    pub exes: &'static [&'static str],
    pub appid: Option<u32>,
    /// Where its launcher usually installs it (for the program's icon when there's no Steam art).
    pub icon_paths: &'static [&'static str],
}

pub const SEEDS: [Seed; 7] = [
    Seed { id: "cs2", name: "Counter-Strike 2", exes: &["cs2.exe"], appid: Some(730), icon_paths: &[] },
    Seed { id: "valorant", name: "Valorant", exes: &["valorant-win64-shipping.exe"], appid: None, icon_paths: &[r"C:\Riot Games\VALORANT\live\VALORANT.exe"] },
    Seed { id: "league", name: "League of Legends", exes: &["league of legends.exe"], appid: None, icon_paths: &[r"C:\Riot Games\League of Legends\Game\League of Legends.exe", r"C:\Riot Games\League of Legends\LeagueClient.exe"] },
    Seed { id: "fortnite", name: "Fortnite", exes: &["fortniteclient-win64-shipping.exe"], appid: None, icon_paths: &[r"C:\Program Files\Epic Games\Fortnite\FortniteGame\Binaries\Win64\FortniteClient-Win64-Shipping.exe"] },
    Seed { id: "apex", name: "Apex Legends", exes: &["r5apex.exe", "r5apex_dx12.exe"], appid: Some(1172470), icon_paths: &[] },
    Seed { id: "overwatch2", name: "Overwatch 2", exes: &["overwatch.exe"], appid: Some(2357570), icon_paths: &[r"C:\Program Files (x86)\Overwatch\_retail_\Overwatch.exe"] },
    Seed { id: "rocketleague", name: "Rocket League", exes: &["rocketleague.exe"], appid: Some(252950), icon_paths: &[r"C:\Program Files\Epic Games\rocketleague\Binaries\Win64\RocketLeague.exe"] },
];

impl Default for GamesFile {
    fn default() -> Self {
        let mut f = GamesFile { version: VERSION, games: Vec::new() };
        f.ensure_seeds();
        f
    }
}

impl GamesFile {
    /// Puts back any built-in game that is missing (an older file, or one edited by hand).
    pub fn ensure_seeds(&mut self) {
        for (i, s) in SEEDS.iter().enumerate() {
            if !self.games.iter().any(|g| g.id == s.id) {
                let g = Game { id: s.id.into(), name: s.name.into(), exes: s.exes.iter().map(|e| e.to_string()).collect(), builtin: true, appid: s.appid, auto: true, profiles: BTreeMap::new() };
                self.games.insert(i.min(self.games.len()), g);
            }
        }
        self.version = VERSION;
    }

    /// The game a process name belongs to.
    pub fn game_for_exe(&self, exe: &str) -> Option<&Game> {
        let exe = exe.to_ascii_lowercase();
        self.games.iter().find(|g| g.exes.iter().any(|e| *e == exe))
    }

    /// Whether any game is followed (has a profile and "Apply automatically" on). If none is, the helper
    /// doesn't even look at processes.
    pub fn any_profile(&self) -> bool {
        self.games.iter().any(|g| g.auto && !g.profiles.is_empty())
    }
}

/// A process name a game may use: a bare file name ending in .exe, no path, not SYNQ's own or a
/// part of Windows that is always running.
pub fn exe_ok(exe: &str) -> Result<String, String> {
    let e = exe.trim().to_ascii_lowercase();
    if e.is_empty() || e.len() > MAX_EXE_LEN {
        return Err("A game's program name is 1 to 64 characters, like game.exe.".into());
    }
    if !e.ends_with(".exe") || e.len() <= 4 {
        return Err("A game's program name ends in .exe (like game.exe).".into());
    }
    const NOT_IN_A_NAME: [char; 9] = ['\\', '/', ':', '*', '?', '\"', '<', '>', '|'];
    if e.contains(NOT_IN_A_NAME) || e.chars().any(char::is_control) {
        return Err("Just the program's file name, without a folder (like game.exe).".into());
    }
    const NOT_GAMES: [&str; 8] = ["synq.exe", "synq-helper.exe", "explorer.exe", "svchost.exe", "dwm.exe", "csrss.exe", "winlogon.exe", "system"];
    if NOT_GAMES.contains(&e.as_str()) {
        return Err(format!("{e} isn't a game."));
    }
    Ok(e)
}

/// A program's name the way a game's program names are written: lower case and ending in .exe. Windows
/// names already are; on Linux a Proton game keeps its .exe name, and a native game ("cs2", "Game.x86_64")
/// gets ".exe" after its build suffix is dropped, so one profile matches the game on both.
pub fn process_name(raw: &str) -> String {
    let lower = raw.trim().to_ascii_lowercase();
    if lower.ends_with(".exe") {
        return lower;
    }
    let base = lower.strip_suffix(".x86_64").or_else(|| lower.strip_suffix(".x86")).unwrap_or(&lower);
    format!("{base}.exe")
}

/// A game id: letters, digits and dashes, 1 to 40 (also a file name for its cover art).
pub fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn steps_ok(steps: &[Step]) -> Result<(), String> {
    if steps.len() > MAX_PROFILE_STEPS {
        return Err(format!("A profile holds at most {MAX_PROFILE_STEPS} reports."));
    }
    for s in steps {
        let n = match s {
            Step::Output { data, .. } | Step::OutputTo { data, .. } | Step::Feature { data, .. } => data.len(),
        };
        if n > MAX_STEP_BYTES {
            return Err("A report in a profile is too long.".into());
        }
    }
    Ok(())
}

/// Checks a file the app is about to save (or the helper just read): sizes, names, process names.
pub fn validate(f: &GamesFile) -> Result<(), String> {
    if f.games.len() > MAX_GAMES {
        return Err(format!("At most {MAX_GAMES} games."));
    }
    let mut ids = std::collections::HashSet::new();
    let mut exes = std::collections::HashSet::new();
    for g in &f.games {
        if !id_ok(&g.id) || !ids.insert(g.id.clone()) {
            return Err(format!("Game id {:?} isn't usable.", g.id));
        }
        if g.name.trim().is_empty() || g.name.chars().count() > 80 {
            return Err("A game's name is 1 to 80 characters.".into());
        }
        if g.exes.is_empty() || g.exes.len() > MAX_EXES {
            return Err(format!("{} needs 1 to {MAX_EXES} program names.", g.name));
        }
        for e in &g.exes {
            let clean = exe_ok(e)?;
            if clean != *e {
                return Err(format!("Program names are kept in lower case ({clean})."));
            }
            if !exes.insert(clean.clone()) {
                return Err(format!("{clean} belongs to two games."));
            }
        }
        for (key, d) in &g.profiles {
            if key.is_empty() || key.len() > 200 {
                return Err("A device key is missing or too long.".into());
            }
            steps_ok(&d.steps)?;
            steps_ok(&d.restore)?;
        }
    }
    Ok(())
}

/// The games file, or the built-in list when there is none yet. A file that doesn't parse or check is
/// treated as missing by the helper (nothing is sent), and reported by the app.
pub fn load(dir: &Path) -> Result<GamesFile, String> {
    let path = dir.join(crate::helper_cfg::GAMES_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(GamesFile::default()),
        Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
    };
    let mut f: GamesFile = serde_json::from_str(&text).map_err(|e| format!("{} isn't a games file: {e}", path.display()))?;
    f.ensure_seeds();
    validate(&f)?;
    Ok(f)
}

pub fn save(dir: &Path, f: &GamesFile) -> Result<(), String> {
    validate(f)?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let text = serde_json::to_string(f).map_err(|e| e.to_string())?;
    crate::helper_cfg::write_atomic(&dir.join(crate::helper_cfg::GAMES_FILE), &text)
}

/// Whether a device key names a device that is plugged in now: the same key, or the same device
/// (vendor, product, interface, and collection when the key names one) with another serial.
pub fn same_device(recorded: &str, present: &str) -> bool {
    if recorded == present {
        return true;
    }
    let a: Vec<&str> = recorded.split(':').collect();
    let b: Vec<&str> = present.split(':').collect();
    a.len() >= 4 && a.len() == b.len() && a[..3] == b[..3] && a[4..] == b[4..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_and_proton_names_match_the_same_profile() {
        assert_eq!(process_name("cs2.exe"), "cs2.exe");
        assert_eq!(process_name("CS2.EXE"), "cs2.exe");
        assert_eq!(process_name("cs2"), "cs2.exe", "CS2's native Linux build");
        assert_eq!(process_name("Game.x86_64"), "game.exe", "a Unity build");
        assert_eq!(process_name("game.x86"), "game.exe");
        assert_eq!(process_name("onboard"), "onboard.exe");
        assert!(exe_ok(&process_name("dota2")).is_ok());
        assert!(exe_ok(&process_name("synq-helper")).is_err(), "never SYNQ's own");
    }

    pub fn profile(n: u8) -> DeviceProfile {
        DeviceProfile {
            name: "Mouse".into(),
            vendor_id: 0x373b,
            product_id: 0x12a2,
            steps: vec![Step::Output { report_id: 8, data: vec![n; 16] }],
            restore: vec![Step::Output { report_id: 8, data: vec![0; 16] }],
            settings: serde_json::json!({ "family": "atk" }),
            saved: 1,
        }
    }

    #[test]
    fn seeds_are_listed_and_valid() {
        let f = GamesFile::default();
        let ids: Vec<&str> = f.games.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["cs2", "valorant", "league", "fortnite", "apex", "overwatch2", "rocketleague"]);
        validate(&f).unwrap();
        assert_eq!(f.game_for_exe("CS2.EXE").unwrap().id, "cs2");
        assert_eq!(f.game_for_exe("r5apex_dx12.exe").unwrap().appid, Some(1172470));
        assert!(f.game_for_exe("notepad.exe").is_none());
        assert!(!f.any_profile());
    }

    #[test]
    fn auto_off_means_not_followed() {
        let mut f = GamesFile::default();
        f.games[0].profiles.insert("k".into(), profile(1));
        assert!(f.any_profile());
        f.games[0].auto = false;
        assert!(!f.any_profile());
    }

    #[test]
    fn missing_seeds_come_back_and_old_files_load() {
        // A version 1 file: "recorded", "everyday", no appid / auto / restore.
        let old = r#"{"version":1,"games":[{"id":"custom-1","name":"Mine","exes":["mine.exe"],"builtin":false,
            "profiles":{"k":{"name":"M","vendorId":1,"productId":2,"steps":[],"recorded":5}}}],"everyday":{}}"#;
        let mut f: GamesFile = serde_json::from_str(old).unwrap();
        f.ensure_seeds();
        assert_eq!(f.games.len(), 8);
        let mine = f.games.iter().find(|g| g.id == "custom-1").unwrap();
        assert!(mine.auto && mine.profiles["k"].saved == 5 && mine.profiles["k"].restore.is_empty());
        validate(&f).unwrap();
    }

    #[test]
    fn exe_names() {
        assert_eq!(exe_ok(" Game.EXE ").unwrap(), "game.exe");
        assert_eq!(exe_ok("League of Legends.exe").unwrap(), "league of legends.exe");
        for bad in ["", ".exe", "game", "C:\\Games\\game.exe", "../game.exe", "synq.exe", "explorer.exe", "a\u{0}.exe"] {
            assert!(exe_ok(bad).is_err(), "{bad:?}");
        }
        assert!(exe_ok(&format!("{}.exe", "a".repeat(64))).is_err());
    }

    #[test]
    fn validate_refuses_bad_files() {
        let mut f = GamesFile::default();
        f.games[0].exes = vec!["CS2.exe".into()];
        assert!(validate(&f).is_err(), "upper case");
        let mut f = GamesFile::default();
        f.games[1].exes.push("cs2.exe".into());
        assert!(validate(&f).is_err(), "one exe, two games");
        let mut f = GamesFile::default();
        f.games[0].profiles.insert("k".into(), DeviceProfile { steps: vec![Step::Output { report_id: 1, data: vec![0; 2000] }], ..profile(1) });
        assert!(validate(&f).is_err(), "huge report");
        let mut f = GamesFile::default();
        f.games[0].profiles.insert("k".into(), DeviceProfile { restore: vec![Step::Output { report_id: 1, data: vec![0] }; 401], ..profile(1) });
        assert!(validate(&f).is_err(), "too many restore reports");
        let mut f = GamesFile::default();
        f.games[0].id = "../x".into();
        assert!(validate(&f).is_err(), "id");
    }

    #[test]
    fn save_and_load() {
        let dir = std::env::temp_dir().join(format!("onboard-games-{}", std::process::id()));
        let mut f = GamesFile::default();
        f.games[0].profiles.insert("373b:12a2:2:".into(), profile(7));
        save(&dir, &f).unwrap();
        assert_eq!(load(&dir).unwrap(), f);
        std::fs::write(dir.join(crate::helper_cfg::GAMES_FILE), "not json").unwrap();
        assert!(load(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
        let empty = std::env::temp_dir().join(format!("onboard-games-none-{}", std::process::id()));
        assert_eq!(load(&empty).unwrap(), GamesFile::default());
    }

    #[test]
    fn device_keys() {
        assert!(same_device("046d:c54d:2:ABC", "046d:c54d:2:ABC"));
        assert!(same_device("046d:c54d:2:ABC", "046d:c54d:2:XYZ"), "another serial");
        assert!(!same_device("046d:c54d:2:ABC", "046d:c54d:1:ABC"), "another interface");
        assert!(!same_device("046d:c54d:2:ABC", "046d:c547:2:ABC"));
        assert!(same_device("1532:00b7:0::0001000c", "1532:00b7:0:S:0001000c"));
        assert!(!same_device("1532:00b7:0::0001000c", "1532:00b7:0::ff000001"));
    }
}
