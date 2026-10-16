//! The Linux EQ engine: PipeWire's filter-chain module. Built in as `engine` on Linux (Windows' engine is
//! Equalizer APO, src/engine/); the graph, its controls and the status are pure code in src/eq_graph.rs, and
//! this module runs PipeWire's own tools for them. Nothing here needs root, and no command goes through a shell.
//!
//! - `status` runs `pw-dump` once: is PipeWire running, is the "SYNQ EQ" sink loaded, which output is
//!   the default, where the EQ plays.
//! - Setting up (`run("setup")`, only ever on the person's click) writes
//!   ~/.config/pipewire/pipewire.conf.d/onboard-eq.conf, restarts PipeWire for this login the first time (or
//!   when the EQ needs a bigger graph), and makes "SYNQ EQ" the default output. Moving the EQ to another
//!   output once it runs is live (no restart).
//! - Every EQ save after that is live (`prepare` + `push`): `pw-cli set-param <id> Props` sets every control
//!   at once, and the config is rewritten with the same graph so the next PipeWire start plays the current EQ.
//!   Before anything is written, the EQ the running PipeWire would really play passes eq.rs' peak gate.
//! - Undo removes the config (putting back a file of the same name that wasn't SYNQ's), puts the previous
//!   default output back and restarts PipeWire once.

use crate::eq::{self, EqState};
use crate::eq_graph::{self as graph, Caps, Disk, Graph, Shape};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub use graph::Status;

const TOOL_TIMEOUT: Duration = Duration::from_secs(6);
/// How long a restarted PipeWire gets to load the EQ.
const LOAD_TIMEOUT: Duration = Duration::from_secs(12);

/// What a setup or undo did (the same shape as Windows' engine::Outcome).
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

/// SYNQ's record of its setup: data/eq-engine/pipewire.json.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct Record {
    /// The default output before SYNQ made the EQ the default (put back on undo).
    previous_default: Option<String>,
    /// The graph PipeWire loaded last (when pw-dump can't say).
    running_shape: Option<Shape>,
    /// The EQ needs a bigger graph than the one running.
    needs_restart: bool,
    /// The last live update PipeWire refused.
    push_error: Option<String>,
    /// A file of the same name that wasn't SYNQ's, kept here and put back on undo.
    foreign_backup: Option<String>,
}

fn record_path(data: &Path) -> PathBuf {
    data.join("eq-engine").join("pipewire.json")
}

fn load_record(data: &Path) -> Record {
    std::fs::read_to_string(record_path(data)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_record(data: &Path, r: &Record) {
    let path = record_path(data);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(t) = serde_json::to_string_pretty(r) {
        let _ = crate::helper_cfg::write_atomic(&path, &t);
    }
}

pub fn backups_dir(data: &Path) -> PathBuf {
    data.join("eq-engine").join("backups")
}

fn config_home() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| PathBuf::from(".config"))
}

/// ~/.config/pipewire/pipewire.conf.d/onboard-eq.conf
pub fn conf_path() -> PathBuf {
    config_home().join("pipewire").join("pipewire.conf.d").join(graph::CONF_FILE)
}

fn read_conf() -> Option<(Shape, Option<String>)> {
    std::fs::read_to_string(conf_path()).ok().and_then(|t| graph::read_conf(&t))
}

fn write_conf(text: &str) -> Result<(), String> {
    let path = conf_path();
    let dir = path.parent().ok_or("No PipeWire config folder.")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    crate::helper_cfg::write_atomic(&path, text)
}

/// Normalizes an output id from the UI: a sink's node.name.
pub fn output_id(s: &str) -> Option<String> {
    let s = s.trim();
    graph::valid_node_name(s).then(|| s.to_string())
}

// ---- PipeWire's tools

/// Runs one of PipeWire's (or systemd's) tools, no shell, with a time limit; its output.
fn tool(cmd: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut child = Command::new(cmd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { format!("{cmd} isn't installed") } else { format!("{cmd}: {e}") })?;
    let mut out = child.stdout.take().ok_or("no stdout")?;
    let mut err = child.stderr.take().ok_or("no stderr")?;
    let reader = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = out.read_to_end(&mut v);
        v
    });
    let err_reader = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = err.read_to_end(&mut v);
        v
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{cmd} didn't answer within {} s", timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(e) => return Err(e.to_string()),
        }
    };
    let stdout = String::from_utf8_lossy(&reader.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err_reader.join().unwrap_or_default()).trim().to_string();
    if status.success() {
        Ok(stdout)
    } else {
        Err(if stderr.is_empty() { format!("{cmd} failed ({status})") } else { format!("{cmd}: {stderr}") })
    }
}

/// The audio graph right now (None: PipeWire isn't running or pw-dump isn't installed).
pub fn read_graph() -> Option<Graph> {
    tool("pw-dump", &[], TOOL_TIMEOUT).ok().and_then(|json| graph::parse_dump(&json))
}

fn caps_of(g: Option<&Graph>) -> Caps {
    g.map(|g| Caps::for_version(&g.version)).unwrap_or(Caps::for_version(""))
}

fn set_default(g: &Graph, name: &str) -> Result<(), String> {
    let value = format!("{{ \"name\": \"{name}\" }}");
    tool("pw-metadata", &["-n", "default", "0", "default.configured.audio.sink", &value, "Spa:String:JSON"], TOOL_TIMEOUT).map(|_| ()).or_else(|e| {
        // WirePlumber's own tool, by node id.
        let id = if name == graph::SINK_NAME { g.eq_sink } else { g.sinks.iter().find(|s| s.name == name).map(|s| s.id) };
        let id = id.ok_or(e)?;
        tool("wpctl", &["set-default", &id.to_string()], TOOL_TIMEOUT).map(|_| ())
    })
}

/// Moves the EQ's output stream to `target` (the session manager relinks it; no restart).
fn retarget(g: &Graph, target: &graph::Sink) -> Result<(), String> {
    let out = g.eq_output.ok_or("SYNQ's EQ isn't loaded.")?.to_string();
    // target.object (by serial) for WirePlumber 0.4.12+, target.node (by id) for older session managers: either is enough.
    let by_serial = target.serial.map(|serial| tool("pw-metadata", &["-n", "default", &out, "target.object", &serial.to_string(), "Spa:Id"], TOOL_TIMEOUT));
    let by_id = tool("pw-metadata", &["-n", "default", &out, "target.node", &target.id.to_string(), "Spa:Id"], TOOL_TIMEOUT);
    match (by_serial, by_id) {
        (Some(Ok(_)), _) | (_, Ok(_)) => Ok(()),
        (_, Err(e)) => Err(format!("Couldn't move SYNQ's EQ to {}: {e}", target.description)),
    }
}

fn active_units() -> Vec<&'static str> {
    ["pipewire.service", "pipewire-pulse.service", "wireplumber.service", "pipewire-media-session.service"]
        .into_iter()
        .filter(|u| tool("systemctl", &["--user", "show", "-p", "ActiveState", "--value", u], TOOL_TIMEOUT).is_ok_and(|s| s.trim() == "active"))
        .collect()
}

/// Restarts PipeWire for this login (and its session manager and Pulse server, when they run), so it loads
/// the config again. Sound stops for a moment.
fn restart_pipewire() -> Result<(), String> {
    let units = active_units();
    if !units.contains(&"pipewire.service") {
        return Err("PipeWire doesn't run as a systemd user service here, so SYNQ can't restart it. Log out and back in to load SYNQ's EQ.".into());
    }
    let mut args = vec!["--user", "restart"];
    args.extend(units);
    tool("systemctl", &args, Duration::from_secs(30)).map(|_| ())
}

fn wait_for_eq(timeout: Duration) -> Option<Graph> {
    let start = Instant::now();
    loop {
        if let Some(g) = read_graph().filter(|g| g.eq_sink.is_some()) {
            return Some(g);
        }
        if start.elapsed() > timeout {
            return None;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

// ---- status

/// What's on disk, and what the running PipeWire does with the saved EQ.
fn disk(data: Option<&Path>, g: Option<&Graph>) -> Disk {
    let config = read_conf();
    let rec = data.map(load_record).unwrap_or_default();
    let inexact = g.filter(|g| !g.version.is_empty() && config.is_some()).and_then(|g| {
        let state = eq::snapshot(false).state;
        (!graph::exact(&state, Caps::for_version(&g.version))).then(|| g.version.clone())
    });
    Disk {
        config_path: conf_path().to_string_lossy().into_owned(),
        needs_restart: rec.needs_restart && config.is_some(),
        push_error: rec.push_error.filter(|_| config.is_some()),
        config,
        inexact,
    }
}

/// The engine's state as PipeWire has it right now. Read-only.
pub fn status(data: Option<&Path>) -> Status {
    let g = read_graph();
    graph::status(g.as_ref(), &disk(data, g.as_ref()))
}

// ---- EQ saves

/// The graph read once per save, for the check before it and the update after it.
pub struct Prepared {
    graph: Option<Graph>,
}

/// Before an EQ is saved: the EQ the running PipeWire would really play for it (older PipeWire plays shelves
/// and low/high-pass filters a little differently) must pass eq.rs' peak gate too. Nothing is written when it
/// doesn't.
pub fn prepare(state: &EqState, bypass: bool) -> Result<Prepared, String> {
    let g = if read_conf().is_some() { read_graph() } else { None };
    if !bypass {
        if let Some(g) = &g {
            let caps = Caps::for_version(&g.version);
            if !graph::exact(state, caps) {
                eq::validate(&graph::effective(state, caps)).map_err(|e| format!("PipeWire {} plays shelves and low/high-pass filters a little differently, and then: {e}", g.version))?;
            }
        }
    }
    Ok(Prepared { graph: g })
}

/// The graph PipeWire runs: from the EQ sink's own controls when pw-dump shows them, else SYNQ's record.
fn running_shape(g: Option<&Graph>, rec: &Record) -> Option<Shape> {
    g.and_then(|g| g.eq_shape).or(rec.running_shape)
}

/// After config.txt was written: the running EQ takes the same EQ at once, and the config is rewritten so the
/// next PipeWire start plays it too. Never fails the save: what PipeWire refused shows on the engine card.
pub fn push(p: &Prepared, state: &EqState, bypass: bool, data: Option<&Path>) {
    let Some((conf_shape, target)) = read_conf() else { return };
    let caps = caps_of(p.graph.as_ref());
    let eff = graph::effective(state, caps);
    let mut rec = data.map(load_record).unwrap_or_default();
    let running = running_shape(p.graph.as_ref(), &rec).unwrap_or(conf_shape);
    let file_shape = Shape(std::array::from_fn(|i| conf_shape.0[i].max(running.0[i]).max(Shape::for_state(&eff).0[i])));
    if let Ok(c) = graph::controls(&eff, bypass, file_shape, caps) {
        let _ = write_conf(&graph::conf(file_shape, &c, target.as_deref()));
    }
    rec.needs_restart = !bypass && !running.fits(&eff);
    rec.push_error = None;
    if !rec.needs_restart {
        if let (Some(id), Ok(c)) = (p.graph.as_ref().and_then(|g| g.eq_sink), graph::controls(&eff, bypass, running, caps)) {
            if let Err(e) = tool("pw-cli", &["set-param", &id.to_string(), "Props", &graph::props_arg(&c)], TOOL_TIMEOUT) {
                rec.push_error = Some(e);
            }
        }
    }
    if let Some(d) = data {
        save_record(d, &rec);
    }
}

// ---- setup and undo (the person's click)

static BUSY: AtomicBool = AtomicBool::new(false);

/// `setup` (also `install`: there's nothing to install on Linux) or `undo`, from the app.
pub fn run(data: &Path, command: &str, output: Option<String>) -> Result<Outcome, String> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("SYNQ is already working on the EQ engine.".into());
    }
    let res = match command {
        "setup" | "install" => setup(data, output.as_deref(), false),
        "undo" => undo(data, false),
        other => Err(format!("Unknown EQ engine command {other}.")),
    };
    BUSY.store(false, Ordering::SeqCst);
    res
}

fn setup(data: &Path, output: Option<&str>, dry_run: bool) -> Result<Outcome, String> {
    let g = read_graph().ok_or("PipeWire isn't running (or pw-dump isn't installed), so SYNQ's EQ can't be set up.")?;
    if g.sinks.is_empty() {
        return Err("PipeWire has no sound output to put the EQ on.".into());
    }
    let mut rec = load_record(data);
    let current = read_conf();
    let default = g.default_sink.clone().filter(|d| d != graph::SINK_NAME);
    let target_name = output
        .map(String::from)
        .or_else(|| (g.default_sink.as_deref() == Some(graph::SINK_NAME)).then(|| g.eq_linked.clone().or_else(|| current.as_ref().and_then(|c| c.1.clone()))).flatten())
        .or_else(|| default.clone())
        .or_else(|| g.sinks.first().map(|s| s.name.clone()))
        .ok_or("There's no sound output to put the EQ on.")?;
    let target = g.sinks.iter().find(|s| s.name == target_name).ok_or("That sound output isn't connected.")?.clone();
    let snap = eq::snapshot(false);
    let caps = Caps::for_version(&g.version);
    let eff = graph::effective(&snap.state, caps);
    if !snap.bypassed {
        eq::validate(&eff).map_err(|e| format!("The saved EQ can't be played safely: {e}"))?;
    }
    let loaded = g.eq_sink.is_some();
    let running = running_shape(Some(&g), &rec);
    let shape = Shape(std::array::from_fn(|i| Shape::for_state(&eff).0[i].max(running.map_or(0, |r| r.0[i]))));
    let controls = graph::controls(&eff, snap.bypassed, shape, caps)?;
    let text = graph::conf(shape, &controls, Some(&target.name));
    let restart = !loaded || running != Some(shape);
    let mut log = vec![
        format!("PipeWire {} with {} output(s); the default is {}", g.version, g.sinks.len(), g.default_sink.as_deref().unwrap_or("not set")),
        format!("Write {} (the EQ as a filter-chain: a preamp and {} builtin biquads, playing into {})", conf_path().display(), shape.slots().len(), target.description),
        if restart { "Restart PipeWire for this login so it loads the EQ (sound stops for a moment)".into() } else { "PipeWire already runs the EQ: move it to that output live, no restart".into() },
        format!("Make \"{}\" the default output", graph::DESCRIPTION),
    ];
    if dry_run {
        log.push(String::new());
        log.push(text);
        let mut o = Outcome::new(true, "planned", "Dry run: nothing was changed.");
        o.log = log;
        return Ok(o);
    }
    // A file of the same name that isn't SYNQ's is kept and put back on undo.
    let path = conf_path();
    if path.exists() && current.is_none() {
        let dir = backups_dir(data);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let saved = dir.join(format!("{}-{}", graph::CONF_FILE, eq::now_secs()));
        std::fs::copy(&path, &saved).map_err(|e| format!("Couldn't back up {}: {e}", path.display()))?;
        rec.foreign_backup = Some(saved.to_string_lossy().into_owned());
    }
    if g.default_sink.as_deref() != Some(graph::SINK_NAME) {
        rec.previous_default = g.default_sink.clone();
    }
    write_conf(&text)?;
    let g = if restart {
        restart_pipewire()?;
        rec.running_shape = Some(shape);
        match wait_for_eq(LOAD_TIMEOUT) {
            Some(g) => g,
            None => {
                rec.needs_restart = false;
                save_record(data, &rec);
                let mut o = Outcome::new(true, "unconfirmed", "SYNQ's EQ is set up, but PipeWire didn't load it yet. Logging out and back in usually finishes it.");
                o.restarted_audio = true;
                o.log = log;
                return Ok(o);
            }
        }
    } else {
        retarget(&g, &target)?;
        if let Some(id) = g.eq_sink {
            tool("pw-cli", &["set-param", &id.to_string(), "Props", &graph::props_arg(&controls)], TOOL_TIMEOUT)?;
        }
        g
    };
    set_default(&g, graph::SINK_NAME)?;
    rec.needs_restart = false;
    rec.push_error = None;
    save_record(data, &rec);
    let mut o = Outcome::new(true, "done", format!("SYNQ's EQ is on {}.", graph::title(&target.description)));
    o.restarted_audio = restart;
    o.backup = rec.foreign_backup.clone();
    o.log = log;
    Ok(o)
}

fn undo(data: &Path, dry_run: bool) -> Result<Outcome, String> {
    let path = conf_path();
    if read_conf().is_none() {
        return Ok(Outcome::new(true, "nothing", "SYNQ's EQ isn't set up, so there's nothing to undo."));
    }
    let mut rec = load_record(data);
    let g = read_graph();
    let previous = rec.previous_default.clone().filter(|p| g.as_ref().is_some_and(|g| g.sinks.iter().any(|s| &s.name == p)));
    let log = vec![
        format!("Remove {}", path.display()),
        match &previous {
            Some(p) => format!("Make {p} the default output again"),
            None => "Let PipeWire pick the default output".into(),
        },
        "Restart PipeWire for this login so it unloads the EQ (sound stops for a moment)".into(),
    ];
    if dry_run {
        let mut o = Outcome::new(true, "planned", "Dry run: nothing was changed.");
        o.log = log;
        return Ok(o);
    }
    match rec.foreign_backup.take() {
        Some(b) if Path::new(&b).is_file() => std::fs::copy(&b, &path).map(|_| ()).map_err(|e| format!("Couldn't put back {}: {e}", path.display()))?,
        _ => std::fs::remove_file(&path).map_err(|e| format!("Couldn't remove {}: {e}", path.display()))?,
    }
    if let Some(g) = &g {
        match &previous {
            Some(p) => {
                let _ = set_default(g, p);
            }
            None => {
                let _ = tool("pw-metadata", &["-n", "default", "-d", "0", "default.configured.audio.sink"], TOOL_TIMEOUT);
            }
        }
    }
    let restarted = restart_pipewire().is_ok();
    let _ = std::fs::remove_file(record_path(data));
    let mut o = Outcome::new(true, "done", if restarted { "SYNQ's EQ is off and your sound is back the way it was." } else { "SYNQ's EQ is removed. Log out and back in to unload it." });
    o.restarted_audio = restarted;
    o.log = log;
    Ok(o)
}

// ---- `onboard --eq-engine ...`

const USAGE: &str = "\
SYNQ EQ engine (PipeWire)

  onboard --eq-engine status
  onboard --eq-engine setup [--output NODE_NAME] [--dry-run]
  onboard --eq-engine undo  [--dry-run]
  onboard --eq-engine config

  --output   a sink's node.name (pw-dump / wpctl status); default: the current default output
  --dry-run  print what would be done and change nothing";

/// `onboard --eq-engine ...`: runs the command and returns its exit code. None when the app was started normally.
pub fn cli(args: &[String]) -> Option<i32> {
    if args.get(1).map(String::as_str) != Some("--eq-engine") {
        return None;
    }
    let rest = &args[2..];
    let data = crate::helper_cfg::app_data_dir().unwrap_or_else(|| PathBuf::from("."));
    let flag = |f: &str| rest.iter().any(|a| a == f);
    let output = rest.iter().position(|a| a == "--output").and_then(|i| rest.get(i + 1)).and_then(|o| output_id(o));
    let mut stdout = std::io::stdout();
    let result = match rest.first().map(String::as_str) {
        Some("status") => {
            let _ = writeln!(stdout, "{}", serde_json::to_string_pretty(&status(Some(&data))).unwrap_or_default());
            return Some(0);
        }
        Some("config") => {
            let _ = writeln!(stdout, "{}", std::fs::read_to_string(conf_path()).unwrap_or_else(|_| format!("{} isn't there.", conf_path().display())));
            return Some(0);
        }
        Some("setup") | Some("install") => setup(&data, output.as_deref(), flag("--dry-run")),
        Some("undo") => undo(&data, flag("--dry-run")),
        _ => {
            let _ = writeln!(std::io::stderr(), "{USAGE}");
            return Some(2);
        }
    };
    match result {
        Ok(o) => {
            for l in &o.log {
                let _ = writeln!(stdout, "{l}");
            }
            let _ = writeln!(stdout, "\n{}", o.message);
            Some(if o.ok { 0 } else { 1 })
        }
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "{e}");
            Some(1)
        }
    }
}
