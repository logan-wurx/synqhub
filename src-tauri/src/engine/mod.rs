//! SYNQ's EQ engine: Equalizer APO, an effect plug-in that Windows' own audio engine loads, so
//! nothing of it runs as a process. SYNQ installs it, puts it on an output and repairs it, so
//! nobody has to open Equalizer APO's own tools.
//!
//! - Reading the state (`status`) needs no admin rights.
//! - Changing it runs this same exe elevated with `--eq-engine <command>` (one Windows prompt). The
//!   helper backs up every value it will touch, writes only inside the engine's registry places
//!   (`model::op_allowed`), restarts Windows Audio only when something changed, and then checks the
//!   way Equalizer APO's Device Selector does that Windows really loaded the engine.
//! - `--dry-run` prints exactly what would be written and touches nothing.
//!
//! See docs/eq-engine.md.

mod installer;
mod model;
mod registry;
mod win;

use model::{Backup, Mode, Op, Plan};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub use model::Status;

/// The app's data folder name (Tauri's identifier), for the helper started without --data-dir.
const APP_DIR: &str = "com.logan.onboard";
/// How long one load check waits for the engine to report in (Device Selector uses 3 s).
const CHECK_TIMEOUT: Duration = Duration::from_secs(3);

const USAGE: &str = "\
SYNQ EQ engine helper

  synq.exe --eq-engine status
  synq.exe --eq-engine setup   [--output {GUID}] [--dry-run] [--no-check]
  synq.exe --eq-engine install [--output {GUID}] [--dry-run] [--only-if-missing] [--installer PATH] [--as-if-missing]
  synq.exe --eq-engine undo    [--backup PATH] [--dry-run]

  --output        a playback device's endpoint id; default: the current default output
  --dry-run       print what would be done and change nothing (no admin needed)
  --data-dir      SYNQ's data folder (backups, results); default: %APPDATA%\\com.logan.onboard
  --result        also write the outcome as JSON to this file
  --as-if-missing (install, dry run only) show what a fresh install would do on this PC

Everything except status and --dry-run needs an elevated (administrator) prompt.";

pub fn backups_dir(data: &Path) -> PathBuf {
    data.join("eq-engine").join("backups")
}

/// Normalizes an endpoint id from the UI ("{CA89...}" or "{0.0.0.00000000}.{ca89...}").
pub fn output_id(s: &str) -> Option<String> {
    model::endpoint_guid_from_id(s.trim())
}

/// The engine's state as Windows has it right now. Read-only.
pub fn status(data: Option<&Path>) -> Status {
    let g = registry::read_global();
    let render = registry::read_endpoints(false);
    let capture = registry::read_endpoints(true);
    let default = win::default_output();
    let mut s = model::status(&g, &render, &capture, default.as_deref());
    s.can_undo = data.and_then(|d| registry::latest_backup(&backups_dir(d))).is_some();
    s.installer_ready = installer::bundled_present();
    s
}

/// What a helper run did, written to --result for the app and printed for people.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub ok: bool,
    /// "done" | "nothing" | "planned" | "unconfirmed" | "cancelled" | "failed"
    pub result: String,
    pub message: String,
    pub log: Vec<String>,
    pub backup: Option<String>,
    pub restarted_audio: bool,
}

impl Outcome {
    fn new(ok: bool, result: &str, message: impl Into<String>) -> Outcome {
        Outcome { ok, result: result.into(), message: message.into(), ..Default::default() }
    }
}

// ---------------------------------------------------------------------------------------------
// The helper (command line)

struct Opts {
    cmd: String,
    output: Option<String>,
    dry_run: bool,
    no_check: bool,
    only_if_missing: bool,
    as_if_missing: bool,
    data_dir: PathBuf,
    result: Option<PathBuf>,
    backup: Option<PathBuf>,
    installer: Option<PathBuf>,
}

impl Opts {
    fn parse(args: &[String]) -> Result<Opts, String> {
        let mut it = args.iter();
        let cmd = it.next().cloned().ok_or("No command given.")?;
        let default_data = std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join(APP_DIR)).unwrap_or_default();
        let mut o = Opts {
            cmd,
            output: None,
            dry_run: false,
            no_check: false,
            only_if_missing: false,
            as_if_missing: false,
            data_dir: default_data,
            result: None,
            backup: None,
            installer: None,
        };
        while let Some(a) = it.next() {
            let mut value = || it.next().cloned().ok_or_else(|| format!("{a} needs a value."));
            match a.as_str() {
                "--output" => o.output = Some(output_id(&value()?).ok_or("--output must be an endpoint id like {1f2e3d4c-...}.")?),
                "--default" => o.output = None,
                "--dry-run" => o.dry_run = true,
                "--no-check" => o.no_check = true,
                "--only-if-missing" => o.only_if_missing = true,
                "--as-if-missing" => o.as_if_missing = true,
                "--data-dir" => o.data_dir = PathBuf::from(value()?),
                "--result" => o.result = Some(PathBuf::from(value()?)),
                "--backup" => o.backup = Some(PathBuf::from(value()?)),
                "--installer" => o.installer = Some(PathBuf::from(value()?)),
                other => return Err(format!("Unknown option {other}.")),
            }
        }
        if o.as_if_missing && !o.dry_run {
            return Err("--as-if-missing only works with --dry-run.".into());
        }
        Ok(o)
    }
}

/// Collects what happened, printing each line as it goes.
struct Report {
    log: Vec<String>,
}

impl Report {
    fn line(&mut self, s: impl Into<String>) {
        let s = s.into();
        let _ = writeln!(std::io::stdout(), "{s}");
        self.log.push(s);
    }

    fn lines(&mut self, more: Vec<String>) {
        for s in more {
            self.line(format!("  {s}"));
        }
    }
}

/// `synq.exe --eq-engine ...`: runs the helper and returns its exit code. None when the app was
/// started normally.
pub fn cli(args: &[String]) -> Option<i32> {
    if args.get(1).map(String::as_str) != Some("--eq-engine") {
        return None;
    }
    win::attach_parent_console();
    let opts = match Opts::parse(&args[2..]) {
        Ok(o) => o,
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "{e}\n\n{USAGE}");
            return Some(2);
        }
    };
    let mut r = Report { log: Vec::new() };
    let run = match opts.cmd.as_str() {
        "status" => {
            let s = status(Some(&opts.data_dir));
            let _ = writeln!(std::io::stdout(), "{}", serde_json::to_string_pretty(&s).unwrap_or_default());
            return Some(0);
        }
        "setup" => setup(&opts, &mut r),
        "install" => install(&opts, &mut r),
        "undo" => undo(&opts, &mut r),
        "help" | "--help" => {
            let _ = writeln!(std::io::stdout(), "{USAGE}");
            return Some(0);
        }
        other => Err(format!("Unknown command {other}.\n\n{USAGE}")),
    };
    let mut outcome = run.unwrap_or_else(|e| Outcome::new(false, "failed", e));
    r.line(String::new());
    r.line(outcome.message.clone());
    outcome.log = r.log;
    if let Some(path) = &opts.result {
        let _ = std::fs::write(path, serde_json::to_string_pretty(&outcome).unwrap_or_default());
    }
    Some(match outcome.result.as_str() {
        "done" | "nothing" | "planned" => 0,
        "unconfirmed" => 3,
        _ => 1,
    })
}

fn require_admin() -> Result<(), String> {
    if win::is_elevated() {
        Ok(())
    } else {
        Err("This needs administrator rights. Use SYNQ's button (it asks Windows once), or an elevated prompt.".into())
    }
}

fn describe_plan(plan: &Plan, r: &mut Report) {
    match plan.mode {
        Some(m) => r.line(format!("Fresh setup, effect positions {} (the engine's own default choice for this output)", m.label())),
        None => r.line("The engine is already on this output: repair only"),
    }
    r.line("Registry writes, in order (all under HKEY_LOCAL_MACHINE):");
    for (i, op) in plan.ops.iter().enumerate() {
        r.line(format!("  {:>2}. {}", i + 1, op.describe()));
    }
}

fn describe_backup(b: &Backup, dir: &Path, r: &mut Report) {
    r.line(format!("Backup first: {} values and {} keys, as they are now, to {}\\eq-engine-<time>-<id>.json (+ a .reg copy)", b.values.len(), b.keys.len(), dir.display()));
    for k in &b.keys {
        r.line(format!("  key   HKLM\\{}  ({})", k.path, if k.existed { "exists" } else { "doesn't exist yet" }));
    }
    for v in &b.values {
        let now = v.before.as_ref().map(|x| x.describe()).unwrap_or_else(|| "(not set)".into());
        r.line(format!("  value HKLM\\{} \"{}\" = {now}", v.path, v.name));
    }
}

/// The output to work on: --output, or the current default output.
fn target(o: &Opts) -> Result<(String, bool), String> {
    let default = win::default_output();
    let guid = o.output.clone().or_else(|| default.clone()).ok_or("There's no sound output to set up.")?;
    let is_default = default.as_deref().is_some_and(|d| model::same_guid(d, &guid));
    Ok((guid, is_default))
}

/// Applies `ops`; if one fails, puts everything from `backup` back before reporting it.
fn apply_or_roll_back(ops: &[Op], backup: &Backup, r: &mut Report) -> Result<(), String> {
    let mut log = Vec::new();
    let res = registry::apply(ops, &mut log);
    r.lines(log.iter().map(|l| format!("done: {}", l.lines().next().unwrap_or_default().trim())).collect());
    if let Err(e) = res {
        let mut undo_log = Vec::new();
        let back = registry::apply(&model::undo_ops(backup), &mut undo_log);
        return Err(match back {
            Ok(()) => format!("{e} Nothing was left changed."),
            Err(e2) => format!("{e} Putting things back also failed ({e2}); the backup is in SYNQ's data folder."),
        });
    }
    Ok(())
}

/// Puts the output back as it was and sets it up again at `mode` (Equalizer APO's reinstall).
fn reposition(backup: &Backup, mode: Mode, r: &mut Report) -> Result<Plan, String> {
    let mut log = Vec::new();
    registry::apply(&model::revert_endpoint_ops(backup), &mut log)?;
    let g = registry::read_global();
    let e = registry::read_endpoint(&backup.endpoint).ok_or("The output went away.")?;
    let plan = model::plan_setup(&g, &e, Some(mode))?;
    registry::apply(&plan.ops, &mut log)?;
    r.line(format!("Moved the engine to {} on this output", mode.label()));
    win::restart_audio_service()?;
    Ok(plan)
}

/// After a write: restart Windows Audio, then confirm the engine loads. A fresh setup that doesn't
/// confirm tries the other positions in Device Selector's order and keeps the best one.
/// Returns whether Windows confirmed it (None when not checked).
fn restart_and_check(plan: &Plan, backup: &Backup, o: &Opts, r: &mut Report) -> Result<Option<bool>, String> {
    r.line("Restarting Windows Audio (and the services that depend on it)…");
    win::restart_audio_service()?;
    let e = registry::read_endpoint(&plan.endpoint).ok_or("The output went away.")?;
    if o.no_check || e.disabled() || e.unplugged() {
        return Ok(None);
    }
    r.line("Checking that Windows loads the engine on this output…");
    let Some(first) = plan.mode else {
        let (pre, post) = e.recorded_children();
        let t = win::device_test(&plan.endpoint, pre, post, CHECK_TIMEOUT)?;
        return Ok(Some(t.ok(pre, post)));
    };
    let mut best: Option<(i32, Mode)> = None;
    let mut current = plan.clone();
    let modes = model::fallback_modes(first);
    for (i, mode) in modes.iter().copied().enumerate() {
        if i > 0 {
            r.line(format!("Not confirmed; trying {}…", mode.label()));
            current = reposition(backup, mode, r)?;
        }
        let (pre, post) = current.wants_children();
        let t = win::device_test(&plan.endpoint, pre, post, CHECK_TIMEOUT)?;
        if t.ok(pre, post) {
            r.line(format!("Windows loaded the engine ({})", mode.label()));
            return Ok(Some(true));
        }
        let score = t.score(pre, post);
        if best.is_none_or(|(s, _)| score > s) {
            best = Some((score, mode));
        }
    }
    if let Some((_, mode)) = best.filter(|(_, m)| Some(*m) != modes.last().copied()) {
        reposition(backup, mode, r)?;
    }
    Ok(Some(false))
}

fn setup(o: &Opts, r: &mut Report) -> Result<Outcome, String> {
    let g = registry::read_global();
    if !g.installed() {
        return Err("The EQ engine isn't installed on this PC.".into());
    }
    let (guid, is_default) = target(o)?;
    let e = registry::read_endpoint(&guid).ok_or("That sound output wasn't found.")?;
    r.line(format!("Output: {} {}{}", e.name(), e.guid, if is_default { " (the default output)" } else { "" }));
    let plan = model::plan_setup(&g, &e, None)?;
    if plan.ops.is_empty() {
        return Ok(Outcome::new(true, "nothing", format!("Nothing to change: the EQ engine is already on {}.", e.name())));
    }
    describe_plan(&plan, r);
    let backup = registry::capture_backup(&e, false);
    let dir = backups_dir(&o.data_dir);
    if o.dry_run {
        describe_backup(&backup, &dir, r);
        r.line("Then: restart Windows Audio, and check that Windows loads the engine on this output.");
        if plan.mode.is_some() {
            r.line("If it doesn't report in, try the other positions in Device Selector's order (SFX/EFX, SFX/MFX, LFX/GFX) and keep the best.");
        }
        return Ok(Outcome::new(true, "planned", "Dry run: nothing was changed."));
    }
    require_admin()?;
    let saved = registry::write_backup(&dir, &backup)?;
    r.line(format!("Backed up to {}", saved.display()));
    apply_or_roll_back(&plan.ops, &backup, r)?;
    let confirmed = restart_and_check(&plan, &backup, o, r)?;
    let name = e.name();
    let mut out = match confirmed {
        Some(false) => Outcome::new(
            true,
            "unconfirmed",
            format!("The EQ engine is set up on {name}, but Windows didn't confirm it loaded. Restarting the PC usually finishes it."),
        ),
        _ if plan.mode.is_some() => Outcome::new(true, "done", format!("The EQ engine is on {name}.")),
        _ => Outcome::new(true, "done", format!("Fixed the EQ engine on {name}.")),
    };
    out.backup = Some(saved.to_string_lossy().into());
    out.restarted_audio = true;
    Ok(out)
}

fn install(o: &Opts, r: &mut Report) -> Result<Outcome, String> {
    let g = registry::read_global();
    if g.installed() && !o.as_if_missing {
        r.line(format!("The EQ engine is already installed (Equalizer APO {}).", g.version.as_deref().unwrap_or("?")));
        if o.only_if_missing {
            return Ok(Outcome::new(true, "nothing", "The EQ engine was already installed, so nothing was changed."));
        }
        return setup(o, r);
    }
    let source = o.installer.clone().or_else(|| installer::bundled_path().filter(|p| p.is_file()));
    let config = eq_config_default();
    let config_existed = config.exists();

    if o.dry_run {
        r.line("Install the EQ engine (Equalizer APO 1.4.2, x64):");
        match &source {
            Some(p) => r.line(format!("  1. Copy {} into a new admin-only folder under %SystemRoot%\\Temp", p.display())),
            None => r.line(format!("  1. Download {} into a new admin-only folder under %SystemRoot%\\Temp", model::INSTALLER_URL)),
        }
        r.line(format!("  2. Check its size ({} bytes) and SHA-256 ({}); stop if either differs", model::INSTALLER_SIZE, model::INSTALLER_SHA256));
        r.line("  3. Run it with /S (silent). Close its output picker window (DeviceSelector.exe /i) as soon as it starts");
        r.line(format!("  4. Remove the logon update check it adds (scheduled task {})", installer::UPDATE_TASK));
        r.line(if config_existed {
            format!("  5. Leave {} as it is (it was there before)", config.display())
        } else {
            format!("  5. Back up the sample {} the installer creates and start flat (Preamp 0 dB, no filters)", config.display())
        });
        r.line("  6. Set it up on the output below:");
        let (guid, is_default) = target(o)?;
        let e = registry::read_endpoint(&guid).ok_or("That sound output wasn't found.")?;
        r.line(format!("Output: {} {}{}", e.name(), e.guid, if is_default { " (the default output)" } else { "" }));
        // The engine's own installer registers it and sets DisableProtectedAudioDG, so plan as if done.
        let after = model::Global {
            install_path: Some(r"C:\Program Files\EqualizerAPO".into()),
            dll_present: true,
            version: Some(model::ENGINE_VERSION.into()),
            registered: true,
            protected_dg: Some(1),
            child_apos_key: g.child_apos_key,
        };
        let mut fresh = e.clone();
        if o.as_if_missing {
            fresh = model::without_engine(&e);
        }
        let plan = model::plan_setup(&after, &fresh, None)?;
        describe_plan(&plan, r);
        describe_backup(&registry::capture_backup(&e, true), &backups_dir(&o.data_dir), r);
        r.line("Then: restart Windows Audio and check that Windows loads the engine (trying other positions if needed).");
        return Ok(Outcome::new(true, "planned", "Dry run: nothing was installed or changed."));
    }

    require_admin()?;
    let staging = installer::Staging::new()?;
    let mut log = Vec::new();
    let exe = staging.installer(source.as_deref(), &mut log);
    r.lines(std::mem::take(&mut log));
    let exe = exe?;
    let ran = installer::run_silent(&exe, &mut log);
    r.lines(std::mem::take(&mut log));
    ran?;
    installer::remove_update_task(&mut log);
    r.lines(log);
    drop(staging);
    if !registry::read_global().installed() {
        return Err("The EQ engine installer finished, but the engine isn't there. Try again, or restart the PC first.".into());
    }
    let config = crate::eq::config_dir().join("config.txt");
    if !config_existed && config.exists() {
        match crate::eq::start_flat(&config, &o.data_dir.join("eq-backups")) {
            Ok(_) => r.line("Started the EQ flat (the installer's sample config was backed up)"),
            Err(e) => r.line(format!("Couldn't reset the sample config: {e}")),
        }
    }
    let mut out = setup(o, r).map_err(|e| format!("Installed the EQ engine, but couldn't set it up on the output: {e}"))?;
    if out.result == "nothing" {
        out.result = "done".into();
    }
    out.message = format!("Installed the EQ engine. {}", out.message);
    Ok(out)
}

/// Where the engine's config.txt goes before the engine is installed.
fn eq_config_default() -> PathBuf {
    crate::eq::config_dir().join("config.txt")
}

fn undo(o: &Opts, r: &mut Report) -> Result<Outcome, String> {
    let (path, backup) = match &o.backup {
        Some(p) => {
            let text = std::fs::read_to_string(p).map_err(|e| format!("Couldn't read {}: {e}", p.display()))?;
            (p.clone(), serde_json::from_str::<Backup>(&text).map_err(|e| format!("That isn't a SYNQ EQ engine backup: {e}"))?)
        }
        None => match registry::latest_backup(&backups_dir(&o.data_dir)) {
            Some(found) => found,
            None => return Ok(Outcome::new(true, "nothing", "There's no EQ engine change to undo.")),
        },
    };
    r.line(format!("Undo the EQ engine setup on {} {} from {}", backup.endpoint_name, backup.endpoint, path.display()));
    let ops = model::undo_ops(&backup);
    r.line("Registry writes, in order (all under HKEY_LOCAL_MACHINE):");
    for (i, op) in ops.iter().enumerate() {
        r.line(format!("  {:>2}. {}", i + 1, op.describe()));
    }
    r.line("  (DisableProtectedAudioDG stays as it is: the engine needs it on every output it's on.)");
    if o.dry_run {
        r.line("Then: restart Windows Audio.");
        return Ok(Outcome::new(true, "planned", "Dry run: nothing was changed."));
    }
    require_admin()?;
    let mut log = Vec::new();
    registry::apply(&ops, &mut log)?;
    r.lines(log.iter().map(|l| format!("done: {}", l.lines().next().unwrap_or_default().trim())).collect());
    r.line("Restarting Windows Audio…");
    win::restart_audio_service()?;
    registry::mark_undone(&path);
    let mut out = Outcome::new(true, "done", format!("Put {} back the way it was.", backup.endpoint_name));
    out.restarted_audio = true;
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// From the app

static BUSY: AtomicBool = AtomicBool::new(false);

/// Quotes one argument for CreateProcess' command line rules.
fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
                out.push('"');
                slashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(slashes));
                out.push(c);
                slashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

/// Runs the helper elevated (Windows shows its one prompt, owned by `owner`), waits for it, and
/// returns what it reported.
pub fn run_elevated(data: &Path, command: &str, extra: &[String], owner: Option<isize>) -> Result<Outcome, String> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("SYNQ is already working on the EQ engine.".into());
    }
    let res = (|| {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let dir = data.join("eq-engine");
        std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
        let result = dir.join("last-run.json");
        let _ = std::fs::remove_file(&result);
        let mut args: Vec<String> = vec!["--eq-engine".into(), command.into()];
        args.extend(extra.iter().cloned());
        args.extend(["--data-dir".into(), data.to_string_lossy().into(), "--result".into(), result.to_string_lossy().into()]);
        let params = args.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" ");
        match win::run_elevated(&exe, &params, owner)? {
            win::Elevation::Cancelled => Ok(Outcome::new(false, "cancelled", "Nothing changed: Windows asked for permission and it wasn't given.")),
            win::Elevation::Exited(code) => {
                let text = std::fs::read_to_string(&result)
                    .map_err(|_| format!("The EQ engine helper stopped without saying what happened (exit code {code})."))?;
                serde_json::from_str(&text).map_err(|e| e.to_string())
            }
        }
    })();
    BUSY.store(false, Ordering::SeqCst);
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(args: &[&str]) -> Result<Opts, String> {
        Opts::parse(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn parses_helper_options() {
        let o = opts(&["setup", "--output", "{1F2E3D4C-5B6A-4789-8ABC-DEF012345678}", "--dry-run", "--data-dir", r"C:\x y"]).unwrap();
        assert_eq!(o.cmd, "setup");
        assert_eq!(o.output.as_deref(), Some("{1f2e3d4c-5b6a-4789-8abc-def012345678}"));
        assert!(o.dry_run && !o.no_check);
        assert_eq!(o.data_dir, PathBuf::from(r"C:\x y"));
        assert!(opts(&["setup", "--output", r"{1f2e3d4c-5b6a-4789-8abc-def012345678}\..\x"]).is_err());
        assert!(opts(&["setup", "--output"]).is_err());
        assert!(opts(&["install", "--as-if-missing"]).is_err());
        assert!(opts(&["setup", "--bogus"]).is_err());
    }

    #[test]
    fn quotes_like_the_windows_command_line() {
        assert_eq!(quote("setup"), "setup");
        assert_eq!(quote(r"C:\Users\A B\data"), r#""C:\Users\A B\data""#);
        assert_eq!(quote(r"C:\A B\"), r#""C:\A B\\""#);
        assert_eq!(quote(r#"a"b"#), r#""a\"b""#);
        assert_eq!(quote(""), r#""""#);
    }
}
