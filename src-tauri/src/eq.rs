//! Equalizer APO config.txt: parse, validate, and write it safely.
//!
//! SYNQ owns only simple configs (one Preamp plus PK/LSC/HSC/LPQ/HPQ/NO filters). Anything
//! else (Device/Channel scoping, Include, convolution, GraphicEQ, slope-style shelves) makes the
//! config read-only here, so SYNQ never rewrites something it does not fully understand.
//!
//! Every write is gated on the net peak gain (preamp + summed filter response) staying at or
//! under 0 dB, so a change made here can never make anything louder than the source.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_BOOST_DB: f64 = 6.0;
pub const MAX_CUT_DB: f64 = -24.0;
pub const PREAMP_RANGE_DB: (f64, f64) = (-30.0, 6.0);
pub const FREQ_RANGE_HZ: (f64, f64) = (10.0, 22_000.0);
pub const Q_RANGE: (f64, f64) = (0.1, 20.0);
pub const MAX_FILTERS: usize = 20;
/// Rounding slack for the peak check, so a preamp shown to one decimal still passes.
pub const PEAK_TOLERANCE_DB: f64 = 0.05;
/// Equalizer APO designs its biquads at the device rate; 48 kHz matches the fifine output.
pub const SAMPLE_RATE_HZ: f64 = 48_000.0;
const MAX_BACKUPS: usize = 50;
const GAIN_KINDS: [&str; 3] = ["PK", "LSC", "HSC"];
const ALL_KINDS: [&str; 6] = ["PK", "LSC", "HSC", "LPQ", "HPQ", "NO"];
/// Example files Equalizer APO ships in its config folder; not presets.
const EAPO_EXAMPLES: [&str; 5] = ["demo.txt", "example.txt", "iir_lowpass.txt", "multichannel.txt", "selective_delay.txt"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub enabled: bool,
    pub kind: String,
    pub freq: f64,
    pub gain: f64,
    pub q: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EqState {
    pub preamp: f64,
    pub filters: Vec<Filter>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Parsed {
    /// The EQ as the user set it. When bypassed, this is the EQ that comes back on un-bypass.
    pub state: EqState,
    /// Why the file cannot be edited here, if it cannot.
    pub advanced: Option<String>,
    pub bypassed: bool,
}

/// Comment line SYNQ writes when bypassing. Bypass turns every filter OFF and the preamp to
/// 0 dB inside config.txt itself, so the EQ survives restarts; this line remembers the preamp and
/// which filters were already off.
const BYPASS_MARK: &str = "# onboard-bypass";
/// Written by builds from before the rename; still read.
const LEGACY_BYPASS_MARK: &str = "# hub-bypass";


pub fn parse(text: &str) -> Parsed {
    let mut preamp = 0.0;
    let mut filters = Vec::new();
    let mut advanced: Vec<String> = Vec::new();
    let mut bypass: Option<(f64, Vec<usize>)> = None;

    for (n, raw) in text.lines().enumerate() {
        let line = raw.trim().trim_start_matches('\u{feff}');
        if let Some(rest) = line.strip_prefix(BYPASS_MARK).or_else(|| line.strip_prefix(LEGACY_BYPASS_MARK)) {
            bypass = parse_bypass_mark(rest);
            continue;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, rest)) = line.split_once(':') else {
            advanced.push(format!("line {}: not a command", n + 1));
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        if key == "preamp" {
            match parse_preamp(rest) {
                Some(db) => preamp += db,
                None => advanced.push(format!("line {}: unreadable Preamp", n + 1)),
            }
        } else if key == "filter" || (key.starts_with("filter") && key[6..].trim().parse::<u32>().is_ok()) {
            match parse_filter(rest) {
                Some(f) => filters.push(f),
                None => advanced.push(format!("line {}: filter type SYNQ doesn't edit", n + 1)),
            }
        } else {
            let name = line.split(':').next().unwrap_or("").trim();
            advanced.push(format!("line {}: uses '{}'", n + 1, name));
        }
    }

    let advanced = if advanced.is_empty() {
        None
    } else {
        Some(format!("This config uses features SYNQ doesn't edit ({}).", advanced.join("; ")))
    };
    let bypassed = bypass.is_some();
    if let Some((saved_preamp, off)) = bypass {
        preamp = saved_preamp;
        for (i, f) in filters.iter_mut().enumerate() {
            f.enabled = !off.contains(&i);
        }
    }
    Parsed { state: EqState { preamp, filters }, advanced, bypassed }
}

fn parse_bypass_mark(rest: &str) -> Option<(f64, Vec<usize>)> {
    let mut preamp = None;
    let mut off = Vec::new();
    for part in rest.split_whitespace() {
        if let Some(v) = part.strip_prefix("preamp=") {
            preamp = v.parse::<f64>().ok();
        } else if let Some(v) = part.strip_prefix("off=") {
            off = v.split(',').filter_map(|x| x.parse::<usize>().ok()).collect();
        }
    }
    Some((preamp?, off))
}

fn parse_preamp(rest: &str) -> Option<f64> {
    let mut tokens = rest.split_whitespace();
    let value = tokens.next()?.parse::<f64>().ok()?;
    match tokens.next() {
        Some(unit) if unit.eq_ignore_ascii_case("db") => Some(value),
        None => Some(value),
        _ => None,
    }
}

fn parse_filter(rest: &str) -> Option<Filter> {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    let enabled = match tokens.first()?.to_ascii_uppercase().as_str() {
        "ON" => true,
        "OFF" => false,
        _ => return None,
    };
    let kind = tokens.get(1)?.to_ascii_uppercase();
    if !ALL_KINDS.contains(&kind.as_str()) {
        return None;
    }
    let (mut freq, mut gain, mut q) = (None, None, None);
    let mut i = 2;
    while i < tokens.len() {
        let value = tokens.get(i + 1).and_then(|v| v.parse::<f64>().ok());
        match tokens[i].to_ascii_lowercase().as_str() {
            "fc" => freq = value,
            "gain" => gain = value,
            "q" => q = value,
            // Units that follow a value.
            "hz" | "db" => {
                i += 1;
                continue;
            }
            _ => return None,
        }
        value?;
        i += 2;
    }
    let needs_gain = GAIN_KINDS.contains(&kind.as_str());
    if needs_gain && gain.is_none() {
        return None;
    }
    Some(Filter { enabled, kind, freq: freq?, gain: if needs_gain { gain? } else { 0.0 }, q: q? })
}


pub fn serialize(state: &EqState) -> String {
    let mut out = String::from("# Written by SYNQ. Hand edits are fine; SYNQ re-reads this file.\n");
    out.push_str(&format!("Preamp: {} dB\n", num(state.preamp)));
    for f in &state.filters {
        let on = if f.enabled { "ON" } else { "OFF" };
        if GAIN_KINDS.contains(&f.kind.as_str()) {
            out.push_str(&format!("Filter: {on} {} Fc {} Hz Gain {} dB Q {}\n", f.kind, num(f.freq), num(f.gain), num(f.q)));
        } else {
            out.push_str(&format!("Filter: {on} {} Fc {} Hz Q {}\n", f.kind, num(f.freq), num(f.q)));
        }
    }
    out
}

/// The file to write for `state`. Bypassed: every filter OFF at 0 dB preamp, plus the marker that
/// lets parse() give back the real EQ.
pub fn serialize_for(state: &EqState, bypass: bool) -> String {
    if !bypass {
        return serialize(state);
    }
    let off: Vec<String> = state.filters.iter().enumerate().filter(|(_, f)| !f.enabled).map(|(i, _)| i.to_string()).collect();
    let flat = EqState { preamp: 0.0, filters: state.filters.iter().map(|f| Filter { enabled: false, ..f.clone() }).collect() };
    let body = serialize(&flat);
    let (header, rest) = body.split_once('\n').unwrap_or((&body, ""));
    format!("{header}\n{BYPASS_MARK} preamp={} off={}\n{rest}", num(state.preamp), off.join(","))
}

/// Up to two decimals, no trailing zeros, no "-0".
fn num(v: f64) -> String {
    let s = format!("{:.2}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    if s == "-0" { "0".into() } else { s }
}

pub fn validate(state: &EqState) -> Result<f64, String> {
    let (pmin, pmax) = PREAMP_RANGE_DB;
    if !(pmin..=pmax).contains(&state.preamp) {
        return Err(format!("Preamp must be between {pmin} and {pmax} dB."));
    }
    if state.filters.len() > MAX_FILTERS {
        return Err(format!("At most {MAX_FILTERS} filters."));
    }
    for (i, f) in state.filters.iter().enumerate() {
        let n = i + 1;
        if !ALL_KINDS.contains(&f.kind.as_str()) {
            return Err(format!("Filter {n}: unknown type {}.", f.kind));
        }
        if !(FREQ_RANGE_HZ.0..=FREQ_RANGE_HZ.1).contains(&f.freq) {
            return Err(format!("Filter {n}: frequency must be {}-{} Hz.", FREQ_RANGE_HZ.0, FREQ_RANGE_HZ.1));
        }
        if !(Q_RANGE.0..=Q_RANGE.1).contains(&f.q) {
            return Err(format!("Filter {n}: Q must be {}-{}.", Q_RANGE.0, Q_RANGE.1));
        }
        if GAIN_KINDS.contains(&f.kind.as_str()) && !(MAX_CUT_DB..=MAX_BOOST_DB).contains(&f.gain) {
            return Err(format!("Filter {n}: gain must be {MAX_CUT_DB} to +{MAX_BOOST_DB} dB."));
        }
    }
    let peak = peak_db(state);
    if peak > PEAK_TOLERANCE_DB {
        return Err(format!(
            "Net peak would be +{:.1} dB, which can clip and is louder than the source. Lower the preamp by at least {:.1} dB.",
            peak, peak
        ));
    }
    Ok(peak)
}


struct Biquad {
    b: [f64; 3],
    a: [f64; 3],
}

/// Coefficients from the RBJ Audio EQ Cookbook, which Equalizer APO also uses.
fn biquad(f: &Filter) -> Biquad {
    let w0 = 2.0 * std::f64::consts::PI * f.freq / SAMPLE_RATE_HZ;
    let (sin, cos) = w0.sin_cos();
    let alpha = sin / (2.0 * f.q);
    let a = 10f64.powf(f.gain / 40.0);
    let sa = 2.0 * a.sqrt() * alpha;
    match f.kind.as_str() {
        "PK" => Biquad { b: [1.0 + alpha * a, -2.0 * cos, 1.0 - alpha * a], a: [1.0 + alpha / a, -2.0 * cos, 1.0 - alpha / a] },
        "LSC" => Biquad {
            b: [a * ((a + 1.0) - (a - 1.0) * cos + sa), 2.0 * a * ((a - 1.0) - (a + 1.0) * cos), a * ((a + 1.0) - (a - 1.0) * cos - sa)],
            a: [(a + 1.0) + (a - 1.0) * cos + sa, -2.0 * ((a - 1.0) + (a + 1.0) * cos), (a + 1.0) + (a - 1.0) * cos - sa],
        },
        "HSC" => Biquad {
            b: [a * ((a + 1.0) + (a - 1.0) * cos + sa), -2.0 * a * ((a - 1.0) + (a + 1.0) * cos), a * ((a + 1.0) + (a - 1.0) * cos - sa)],
            a: [(a + 1.0) - (a - 1.0) * cos + sa, 2.0 * ((a - 1.0) - (a + 1.0) * cos), (a + 1.0) - (a - 1.0) * cos - sa],
        },
        "LPQ" => Biquad { b: [(1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0], a: [1.0 + alpha, -2.0 * cos, 1.0 - alpha] },
        "HPQ" => Biquad { b: [(1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0], a: [1.0 + alpha, -2.0 * cos, 1.0 - alpha] },
        _ /* NO */ => Biquad { b: [1.0, -2.0 * cos, 1.0], a: [1.0 + alpha, -2.0 * cos, 1.0 - alpha] },
    }
}

fn magnitude_db(bq: &Biquad, freq: f64) -> f64 {
    let w = 2.0 * std::f64::consts::PI * freq / SAMPLE_RATE_HZ;
    let (s1, c1) = w.sin_cos();
    let (s2, c2) = (2.0 * w).sin_cos();
    let nr = bq.b[0] + bq.b[1] * c1 + bq.b[2] * c2;
    let ni = -(bq.b[1] * s1 + bq.b[2] * s2);
    let dr = bq.a[0] + bq.a[1] * c1 + bq.a[2] * c2;
    let di = -(bq.a[1] * s1 + bq.a[2] * s2);
    10.0 * ((nr * nr + ni * ni) / (dr * dr + di * di)).log10()
}

/// Summed response of the enabled filters at `freq`, without preamp.
pub fn response_db(state: &EqState, freq: f64) -> f64 {
    state.filters.iter().filter(|f| f.enabled).map(|f| magnitude_db(&biquad(f), freq)).sum()
}

/// Highest net gain (preamp + filters) across the audible band, also probing each filter's own
/// frequency so a narrow peak between grid points is not missed.
pub fn peak_db(state: &EqState) -> f64 {
    let (lo, hi) = (10f64.ln(), 22_000f64.ln());
    let grid = (0..=1024).map(|i| (lo + (hi - lo) * i as f64 / 1024.0).exp());
    let centers = state.filters.iter().map(|f| f.freq);
    let max = grid.chain(centers).map(|f| response_db(state, f)).fold(f64::MIN, f64::max);
    state.preamp + max
}


// ---- what the app's commands (and SYNQ Helper's web bridge) answer with

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_boost_db: f64,
    pub max_cut_db: f64,
    pub preamp_range_db: (f64, f64),
    pub freq_range_hz: (f64, f64),
    pub q_range: (f64, f64),
    pub max_filters: usize,
    pub peak_tolerance_db: f64,
    pub sample_rate_hz: f64,
}

pub const LIMITS: Limits = Limits {
    max_boost_db: MAX_BOOST_DB,
    max_cut_db: MAX_CUT_DB,
    preamp_range_db: PREAMP_RANGE_DB,
    freq_range_hz: FREQ_RANGE_HZ,
    q_range: Q_RANGE,
    max_filters: MAX_FILTERS,
    peak_tolerance_db: PEAK_TOLERANCE_DB,
    sample_rate_hz: SAMPLE_RATE_HZ,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EqSnapshot {
    pub config_path: String,
    pub state: EqState,
    pub advanced: Option<String>,
    pub bypassed: bool,
    pub peak_db: f64,
    pub editor_open: bool,
    pub modified: u64,
    pub limits: &'static Limits,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub peak_db: f64,
    pub backup: Option<String>,
    pub modified: u64,
}

pub fn config_file() -> PathBuf {
    config_dir().join("config.txt")
}

/// Only files directly inside one of `roots` may be read or replaced through the commands.
pub fn inside(path: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let parent = p.parent().map(Path::to_path_buf).unwrap_or_default();
    let ok = roots.iter().any(|r| {
        let (a, b) = (parent.canonicalize(), r.canonicalize());
        matches!((a, b), (Ok(a), Ok(b)) if a == b)
    });
    if ok { Ok(p) } else { Err("That file is outside SYNQ's folders.".into()) }
}

/// The EQ as config.txt has it now. `editor_open`: Equalizer APO's own editor is running.
pub fn snapshot(editor_open: bool) -> EqSnapshot {
    let path = config_file();
    let text = fs::read_to_string(&path).unwrap_or_default();
    let parsed = parse(&text);
    EqSnapshot {
        config_path: path.to_string_lossy().into(),
        peak_db: peak_db(&parsed.state),
        state: parsed.state,
        advanced: parsed.advanced,
        bypassed: parsed.bypassed,
        editor_open,
        modified: modified_secs(&path),
        limits: &LIMITS,
    }
}

/// Checks `state` (`validate`: limits and the net peak), backs up config.txt into `backups`, then
/// writes it. Nothing is written when the check fails.
pub fn apply(state: &EqState, bypass: bool, backups: &Path) -> Result<ApplyResult, String> {
    let peak = validate(state)?;
    let path = config_file();
    // Linux: config.txt is SYNQ's own file in its data folder (the PipeWire engine plays what it says).
    #[cfg(not(windows))]
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    let backup = backup(&path, backups)?;
    write_atomic(&path, &serialize_for(state, bypass))?;
    Ok(ApplyResult {
        peak_db: peak,
        backup: backup.map(|b| b.to_string_lossy().into()),
        modified: modified_secs(&path),
    })
}

/// Where config.txt lives: Equalizer APO's config folder on Windows; on Linux SYNQ's own data folder
/// (~/.local/share/com.logan.onboard/eq), whose EQ the PipeWire engine plays.
pub fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("HUB_EAPO_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    default_config_dir()
}

#[cfg(windows)]
fn default_config_dir() -> PathBuf {
    let from_registry = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\EqualizerAPO")
        .and_then(|k| k.get_value::<String, _>("ConfigPath"));
    PathBuf::from(from_registry.unwrap_or_else(|_| r"C:\Program Files\EqualizerAPO\config".into()))
}

#[cfg(not(windows))]
fn default_config_dir() -> PathBuf {
    crate::helper_cfg::app_data_dir().map(|d| d.join("eq")).unwrap_or_else(|| PathBuf::from("eq"))
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn modified_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Copies the current config.txt into `backups`, pruning the oldest past MAX_BACKUPS.
pub fn backup(config: &Path, backups: &Path) -> Result<Option<PathBuf>, String> {
    if !config.exists() {
        return Ok(None);
    }
    fs::create_dir_all(backups).map_err(|e| format!("Could not create backup folder: {e}"))?;
    let mut dest = backups.join(format!("config-{}.txt", now_secs()));
    let mut n = 1;
    while dest.exists() {
        dest = backups.join(format!("config-{}-{n}.txt", now_secs()));
        n += 1;
    }
    fs::copy(config, &dest).map_err(|e| format!("Backup failed, nothing was written: {e}"))?;

    let mut all: Vec<PathBuf> = fs::read_dir(backups)
        .map(|it| it.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "txt")).collect())
        .unwrap_or_default();
    all.sort_by_key(|p| modified_secs(p));
    while all.len() > MAX_BACKUPS {
        let _ = fs::remove_file(all.remove(0));
    }
    Ok(Some(dest))
}

/// Writes through a temp file in the same folder and renames it over the target, so Equalizer
/// APO never reloads a half-written config. The final timestamp bump makes sure its folder
/// watcher sees a last-write change on config.txt itself, not only a rename.
pub fn write_atomic(target: &Path, text: &str) -> Result<(), String> {
    let tmp = target.with_extension("txt.onboard-tmp");
    fs::write(&tmp, text).map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Could not replace {}: {e}", target.display())
    })?;
    let _ = fs::OpenOptions::new().write(true).open(target).and_then(|f| f.set_modified(SystemTime::now()));
    Ok(())
}

/// Flat: 0 dB preamp, no filters.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn flat() -> EqState {
    EqState { preamp: 0.0, filters: Vec::new() }
}

/// Makes a freshly installed engine start flat. Its installer writes its own sample config.txt;
/// SYNQ replaces it only when its own setup just ran that installer and the installer created
/// the file. Same path as every other save: checked, backed up, written atomically.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn start_flat(config: &Path, backups: &Path) -> Result<Option<PathBuf>, String> {
    let state = flat();
    validate(&state)?;
    let saved = backup(config, backups)?;
    write_atomic(config, &serialize(&state))?;
    Ok(saved)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PresetInfo {
    pub name: String,
    pub path: String,
    /// "onboard" for presets saved here, "eapo" for .txt files already in Equalizer APO's folder.
    pub source: String,
    pub editable: bool,
}

pub fn list_presets(own_dir: &Path, eapo_dir: &Path) -> Vec<PresetInfo> {
    let mut out = Vec::new();
    for (dir, source) in [(own_dir, "onboard"), (eapo_dir, "eapo")] {
        let Ok(entries) = fs::read_dir(dir) else { continue };
        let mut files: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
        files.sort();
        for path in files {
            let file = path.file_name().and_then(|f| f.to_str()).unwrap_or_default().to_string();
            let lower = file.to_ascii_lowercase();
            if !lower.ends_with(".txt") || lower == "config.txt" || EAPO_EXAMPLES.contains(&lower.as_str()) {
                continue;
            }
            let editable = fs::read_to_string(&path).map(|t| parse(&t).advanced.is_none()).unwrap_or(false);
            out.push(PresetInfo {
                name: file.trim_end_matches(".txt").to_string(),
                path: path.to_string_lossy().into(),
                source: source.into(),
                editable,
            });
        }
    }
    out
}

/// Keeps preset names safe as Windows file names.
pub fn preset_file_name(name: &str) -> Result<String, String> {
    let clean: String = name
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() || " -_.()+".contains(c) { c } else { '-' })
        .collect();
    let clean = clean.trim_matches(['.', ' ']).to_string();
    if clean.is_empty() {
        return Err("Give the preset a name.".into());
    }
    Ok(format!("{clean}.txt"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIVE: &str = "Preamp: 0.4 dB\n\
        Filter: ON LSC Fc 120 Hz Gain 0.4 dB Q 0.71\n\
        Filter: ON PK Fc 60 Hz Gain 0.2 dB Q 1\n\
        Filter: ON PK Fc 250 Hz Gain 0.3 dB Q 0.8\n\
        Filter: ON PK Fc 3000 Hz Gain -3 dB Q 1.2\n\
        Filter: ON PK Fc 7500 Hz Gain -2.8 dB Q 2\n\
        Filter: ON PK Fc 10000 Hz Gain -3.1 dB Q 1.4\n\
        Filter: ON HSC Fc 13000 Hz Gain -2.5 dB Q 0.71\n";

    #[test]
    fn parses_the_live_config() {
        let p = parse(LIVE);
        assert!(p.advanced.is_none());
        assert_eq!(p.state.filters.len(), 7);
        assert_eq!(p.state.preamp, 0.4);
        assert_eq!(p.state.filters[0], Filter { enabled: true, kind: "LSC".into(), freq: 120.0, gain: 0.4, q: 0.71 });
    }

    #[test]
    fn round_trips() {
        let p = parse(LIVE);
        assert_eq!(parse(&serialize(&p.state)).state, p.state);
    }

    #[test]
    fn numbered_and_off_filters() {
        let p = parse("Filter 3: OFF PK Fc 1000 Hz Gain -2 dB Q 1.5\nFilter: ON HPQ Fc 20 Hz Q 0.7");
        assert!(p.advanced.is_none());
        assert!(!p.state.filters[0].enabled);
        assert_eq!(p.state.filters[1].kind, "HPQ");
    }

    #[test]
    fn advanced_configs_are_read_only() {
        assert!(parse("Include: config.txt").advanced.is_some());
        assert!(parse("Device: fifine\nPreamp: -3 dB").advanced.is_some());
        assert!(parse("Filter: ON LS 6dB Fc 100 Hz Gain 3 dB").advanced.is_some());
        assert!(parse("GraphicEQ: 20 0; 20000 0").advanced.is_some());
    }

    #[test]
    fn peak_gate_blocks_boosts_without_preamp() {
        let boost = EqState { preamp: 0.0, filters: vec![Filter { enabled: true, kind: "PK".into(), freq: 100.0, gain: 4.0, q: 1.0 }] };
        assert!((peak_db(&boost) - 4.0).abs() < 0.05);
        assert!(validate(&boost).is_err());
        let safe = EqState { preamp: -4.0, ..boost };
        assert!(validate(&safe).is_ok());
    }

    #[test]
    fn live_config_peaks_above_zero() {
        // The file as found: +0.4 dB preamp on top of small boosts.
        let p = parse(LIVE);
        assert!(peak_db(&p.state) > 0.4);
    }

    #[test]
    fn caps_reject_big_boosts() {
        let s = EqState { preamp: -10.0, filters: vec![Filter { enabled: true, kind: "PK".into(), freq: 100.0, gain: 9.0, q: 1.0 }] };
        assert!(validate(&s).unwrap_err().contains("gain"));
    }

    #[test]
    fn bypass_keeps_the_eq_in_the_file() {
        let mut state = parse(LIVE).state;
        state.filters[2].enabled = false;
        let text = serialize_for(&state, true);
        // What Equalizer APO sees: flat.
        assert!(text.contains("Preamp: 0 dB"));
        assert!(!text.contains("Filter: ON"));
        // What SYNQ reads back: the real EQ, flagged as bypassed.
        let back = parse(&text);
        assert!(back.bypassed && back.advanced.is_none());
        assert_eq!(back.state, state);
        // And un-bypassing writes it normally again.
        assert!(!parse(&serialize_for(&state, false)).bypassed);
    }

    #[test]
    fn fresh_engine_starts_flat_with_a_backup() {
        let dir = std::env::temp_dir().join(format!("onboard-eq-flat-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let config = dir.join("config.txt");
        fs::write(&config, "Preamp: -6 dB\nInclude: example.txt\n").unwrap();
        let saved = start_flat(&config, &dir.join("backups")).unwrap().unwrap();
        assert!(fs::read_to_string(saved).unwrap().contains("Include"));
        let p = parse(&fs::read_to_string(&config).unwrap());
        assert!(p.advanced.is_none() && !p.bypassed);
        assert_eq!(p.state, flat());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn preset_names_are_sanitized() {
        assert_eq!(preset_file_name("Zero:2 / footsteps").unwrap(), "Zero-2 - footsteps.txt");
        assert!(preset_file_name("  ..  ").is_err());
    }
}
