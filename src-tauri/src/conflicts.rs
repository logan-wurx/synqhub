//! Apps that also talk to game controllers (CONTROLLERS-ROADMAP.md P5). SYNQ only warns: it reads the names of
//! the running processes and nothing else, and never closes, signals or touches any of them.

use serde::Serialize;

/// One running app that may also be driving a controller.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub id: &'static str,
    pub app: &'static str,
    /// What it may do to the pad while it runs.
    pub note: &'static str,
}

/// (id, app, process names in lower case, note). A wrong name only means a missed warning.
/// Verified on a real install: GameSir Nexus legacy (`HJC.XboxApp.GameSir.exe`, Store package
/// GuangzhouChickenRunNetwor.GameSirNexusLegacy 1.5.3.0), `steam.exe`, `DS4Windows.exe`, `DSX.exe`, `iCUE.exe`.
/// UNVERIFIED (no install seen): every Xbox Accessories name, GameSir Connect, Razer Synapse 4's `RazerAppEngine.exe`.
/// Never listed: Windows' Xbox Accessory Management Service (XboxGipSvc), a system service that is always there.
const APPS: [(&str, &str, &[&str], &str); 7] = [
    (
        "xbox-accessories",
        "Xbox Accessories",
        // UNVERIFIED: the Store app (Microsoft.XboxDevices) wasn't installed where these were checked.
        &["xboxdevices.exe", "xboxaccessories.exe", "xbox accessories.exe"],
        "it can remap Xbox pads for your profile and update their firmware; close it while you test.",
    ),
    ("icue", "Corsair iCUE", &["icue.exe"], "it drives SCUF and Corsair pads and can apply its own profiles."),
    (
        "synapse",
        "Razer Synapse",
        &["razer synapse 3.exe", "razer synapse.exe", "razerappengine.exe"],
        "it drives Razer pads; profiles it applies only last while it runs.",
    ),
    // hjc.xboxapp.gamesir.exe is GameSir Nexus (legacy, verified); the other names, GameSir Connect's among them, are UNVERIFIED.
    ("gamesir-nexus", "GameSir Nexus", &["hjc.xboxapp.gamesir.exe", "gamesir nexus.exe", "gamesirnexus.exe", "gamesir connect.exe"], "it talks to GameSir pads and can switch their profiles."),
    ("dsx", "DSX (DualSenseX)", &["dsx.exe", "dualsensex.exe"], "it sets DualSense lights and trigger effects and may turn the pad into a virtual Xbox pad."),
    ("ds4windows", "DS4Windows", &["ds4windows.exe"], "it reads PlayStation pads exclusively when hiding is on and adds a virtual Xbox pad."),
    ("steam", "Steam", &["steam.exe", "steam", "steamwebhelper.exe"], "Steam Input may take over or remap controllers in games; the tester shows what the pad itself sends."),
];

/// The apps among these process names (any case, with or without a path).
pub fn matches(names: &[String]) -> Vec<Conflict> {
    let lower: Vec<String> = names
        .iter()
        .map(|n| n.rsplit(['\\', '/']).next().unwrap_or(n).trim().to_ascii_lowercase())
        .collect();
    APPS.iter()
        .filter(|(_, _, exes, _)| exes.iter().any(|e| lower.iter().any(|n| n == e)))
        .map(|&(id, app, _, note)| Conflict { id, app, note })
        .collect()
}

/// The running processes' names. Windows: the process list; Linux: /proc/*/comm. Read only.
#[cfg(windows)]
fn process_names() -> Vec<String> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    sys.processes().values().map(|p| p.name().to_string_lossy().into_owned()).collect()
}

#[cfg(not(windows))]
fn process_names() -> Vec<String> {
    let Ok(dir) = std::fs::read_dir("/proc") else { return Vec::new() };
    dir.flatten()
        .filter(|e| e.file_name().to_string_lossy().bytes().all(|b| b.is_ascii_digit()))
        .filter_map(|e| std::fs::read_to_string(e.path().join("comm")).ok())
        .map(|s| s.trim().to_string())
        .collect()
}

/// The controller apps running right now.
pub fn running() -> Vec<Conflict> {
    matches(&process_names())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_in_any_case_and_with_a_path() {
        let names: Vec<String> = ["C:\\Program Files\\Steam\\steam.exe", "DS4Windows.EXE", "explorer.exe", "HJC.XboxApp.GameSir.exe"].iter().map(|s| s.to_string()).collect();
        let ids: Vec<&str> = matches(&names).iter().map(|c| c.id).collect();
        assert_eq!(ids, ["gamesir-nexus", "ds4windows", "steam"]);
        assert!(matches(&["steam-runtime-launcher".into(), "notsteam.exe".into()]).is_empty(), "whole names only");
    }

    #[test]
    fn every_app_has_names_and_a_note() {
        for (id, app, exes, note) in APPS {
            assert!(!id.is_empty() && !app.is_empty() && !exes.is_empty() && note.ends_with('.'), "{id}");
            assert!(exes.iter().all(|e| *e == e.to_ascii_lowercase()), "{id}: names are matched in lower case");
        }
    }
}
