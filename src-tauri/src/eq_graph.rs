//! SYNQ's EQ as a PipeWire filter-chain (the Linux EQ engine; Windows runs Equalizer APO). Pure functions:
//! the graph, its control values, the config file, and the engine status read from `pw-dump`. The commands
//! that run PipeWire's tools are in src/pipewire/mod.rs.
//!
//! The EQ itself is unchanged: it is kept in config.txt in Equalizer APO's syntax and read, checked, backed up
//! and written by eq.rs exactly as on Windows (bypass and the net-peak gate included). This module turns the
//! EQ that file describes into PipeWire's terms:
//!
//! - A virtual "SYNQ EQ" sink (`SINK_NAME`): a preamp (the builtin `mixer`, one input at a linear gain)
//!   followed by PipeWire's builtin biquads, bq_peaking / bq_lowshelf / bq_highshelf / bq_lowpass /
//!   bq_highpass / bq_notch, which play into the output the person picked.
//! - The graph has a fixed number of biquads of each kind (`Shape`), so every change (a band's frequency,
//!   gain or Q, a band added, removed, turned off or changed to another kind, bypass, the preamp) is a live
//!   control update: an unused slot is set to its exact identity (`identity`). Only an EQ with more bands of
//!   one kind than the graph holds needs PipeWire to load a bigger graph.
//! - Cascaded biquads multiply, so their order doesn't change the response: eq.rs' peak and the graph agree.
//! - PipeWire before 1.4 ignores a shelf's Q (slope S = 1, Q = 1/sqrt 2) and takes a low/high-pass "Q" as a
//!   resonance in dB (which can't go below Q = 1/sqrt 2); boosts above 5 dB were cut before 0.3.52.
//!   `effective` is the EQ such a PipeWire really plays, and the peak gate runs on that.

use crate::eq::{EqState, Filter};
use serde::Serialize;
use serde_json::Value;

/// node.name of the virtual sink (what apps play into).
pub const SINK_NAME: &str = "onboard_eq";
/// node.name of the filter's output stream (what plays into the real output).
pub const OUTPUT_NAME: &str = "onboard_eq.output";
/// What desktops show for the sink.
pub const DESCRIPTION: &str = "SYNQ EQ";
/// ~/.config/pipewire/pipewire.conf.d/<CONF_FILE>
pub const CONF_FILE: &str = "onboard-eq.conf";
/// First line of a config SYNQ wrote.
pub const MARK: &str = "# onboard-eq";
/// Identity frequency for a low-pass: at or above the Nyquist frequency PipeWire's low-pass is exactly 1.
const LOWPASS_OPEN_HZ: f64 = 1_000_000.0;
const SQRT1_2: f64 = std::f64::consts::FRAC_1_SQRT_2;

/// The EQ kinds (eq.rs names), their slot prefix and PipeWire's builtin.
pub const KINDS: [(&str, &str, &str); 6] = [
    ("PK", "pk", "bq_peaking"),
    ("LSC", "ls", "bq_lowshelf"),
    ("HSC", "hs", "bq_highshelf"),
    ("LPQ", "lp", "bq_lowpass"),
    ("HPQ", "hp", "bq_highpass"),
    ("NO", "no", "bq_notch"),
];

fn kind_index(kind: &str) -> Option<usize> {
    KINDS.iter().position(|k| k.0 == kind)
}

/// How many biquads of each kind the graph holds (KINDS order).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct Shape(pub [usize; 6]);

/// Room for any EQ SYNQ writes (eq.rs MAX_FILTERS = 20) as long as it uses at most 2 shelves of each side,
/// 1 low-pass, 1 high-pass and 2 notches: 28 biquads. A typical headphone EQ (1 low shelf, 8 peaks, 1 high
/// shelf) never needs a bigger graph.
pub const DEFAULT_SHAPE: Shape = Shape([20, 2, 2, 1, 1, 2]);

impl Shape {
    /// Biquads each kind needs for `state` (bands that are on; one that is off is an unused slot).
    pub fn needed(state: &EqState) -> [usize; 6] {
        let mut n = [0usize; 6];
        for f in state.filters.iter().filter(|f| f.enabled) {
            if let Some(i) = kind_index(&f.kind) {
                n[i] += 1;
            }
        }
        n
    }

    pub fn fits(&self, state: &EqState) -> bool {
        Self::needed(state).iter().zip(self.0).all(|(n, room)| *n <= room)
    }

    /// The default shape, grown where `state` needs more.
    pub fn for_state(state: &EqState) -> Shape {
        let n = Self::needed(state);
        Shape(std::array::from_fn(|i| DEFAULT_SHAPE.0[i].max(n[i])))
    }

    /// The slot names in graph order: pk_1..pk_N, ls_1.., hs_.., lp_.., hp_.., no_...
    pub fn slots(&self) -> Vec<(usize, String)> {
        let mut out = Vec::new();
        for (i, &(_, prefix, _)) in KINDS.iter().enumerate() {
            for n in 1..=self.0[i] {
                out.push((i, format!("{prefix}_{n}")));
            }
        }
        out
    }

    fn label(&self) -> String {
        KINDS.iter().zip(self.0).map(|((_, p, _), n)| format!("{p}={n}")).collect::<Vec<_>>().join(" ")
    }

    fn parse(s: &str) -> Option<Shape> {
        let mut out = [0usize; 6];
        for part in s.split_whitespace() {
            let (k, v) = part.split_once('=')?;
            let i = KINDS.iter().position(|x| x.1 == k)?;
            out[i] = v.parse().ok().filter(|n| *n <= 64)?;
        }
        Some(Shape(out))
    }
}

/// What a PipeWire version's builtin biquads do.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Caps {
    /// 1.4 and later: every biquad takes Q as Equalizer APO does (RBJ cookbook).
    pub rbj: bool,
    /// Largest gain a biquad takes (dB).
    pub gain_max: f64,
}

impl Caps {
    pub const LATEST: Caps = Caps { rbj: true, gain_max: 760.0 };

    /// From PipeWire's version string ("1.0.5", "0.3.48", "1.4.2-1ubuntu1"). Unknown: the oldest rules,
    /// which only ever make the EQ quieter than asked.
    pub fn for_version(version: &str) -> Caps {
        let nums: Vec<u32> = version.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).take(3).filter_map(|s| s.parse().ok()).collect();
        let v = (nums.first().copied().unwrap_or(0), nums.get(1).copied().unwrap_or(0), nums.get(2).copied().unwrap_or(0));
        Caps { rbj: v >= (1, 4, 0), gain_max: if v >= (1, 4, 0) { 760.0 } else if v >= (0, 3, 52) { 20.0 } else { 5.0 } }
    }
}

/// The EQ a PipeWire with `caps` really plays for `state`: shelves at slope 1 and low/high-pass Q of at least
/// 1/sqrt 2 before 1.4, boosts capped at what the biquads take. The same EQ when the server is 1.4 or newer.
pub fn effective(state: &EqState, caps: Caps) -> EqState {
    if caps.rbj && caps.gain_max >= crate::eq::MAX_BOOST_DB {
        return state.clone();
    }
    let filters = state
        .filters
        .iter()
        .map(|f| {
            let mut f = f.clone();
            if !caps.rbj {
                match f.kind.as_str() {
                    "LSC" | "HSC" => f.q = SQRT1_2,
                    "LPQ" | "HPQ" => f.q = f.q.max(SQRT1_2),
                    _ => {}
                }
            }
            f.gain = f.gain.min(caps.gain_max);
            f
        })
        .collect();
    EqState { preamp: state.preamp, filters }
}

/// Whether PipeWire plays `state` exactly as asked.
pub fn exact(state: &EqState, caps: Caps) -> bool {
    effective(state, caps) == *state
}

/// Before 1.4 a low/high-pass "Q" port is a resonance in dB (the old Chromium formula, which is the RBJ
/// filter with Q = 1/d, d = sqrt((4 - sqrt(16 - 16/g^2)) / 2), g = 10^(dB/20)). The dB that gives `q`.
pub fn resonance_db(q: f64) -> f64 {
    let q = q.max(SQRT1_2);
    let k = 4.0 - 2.0 / (q * q);
    let g2 = 16.0 / (16.0 - k * k).max(1e-12);
    10.0 * g2.log10()
}

/// The control values of one unused slot: PipeWire's biquads are exactly 1 at frequency 0 (peaking, shelves,
/// high-pass, notch; with no gain for the shelves) and at or above the Nyquist frequency (low-pass).
fn identity(kind: usize) -> [(&'static str, f64); 3] {
    match KINDS[kind].0 {
        "LPQ" => [("Freq", LOWPASS_OPEN_HZ), ("Q", SQRT1_2), ("Gain", 0.0)],
        _ => [("Freq", 0.0), ("Q", SQRT1_2), ("Gain", 0.0)],
    }
}

fn band(f: &Filter, caps: Caps) -> [(&'static str, f64); 3] {
    let q = match f.kind.as_str() {
        "LPQ" | "HPQ" if !caps.rbj => resonance_db(f.q),
        _ => f.q,
    };
    [("Freq", f.freq), ("Q", q), ("Gain", f.gain)]
}

/// Every control of a graph of `shape` for `state` (the EQ as PipeWire will play it: pass `effective`), as
/// ("node:port", value). Bypassed: every slot unused and the preamp at 0 dB, as Equalizer APO is given a
/// bypassed config. Err when a kind has more bands than the graph holds.
pub fn controls(state: &EqState, bypass: bool, shape: Shape, caps: Caps) -> Result<Vec<(String, f64)>, String> {
    if !bypass && !shape.fits(state) {
        return Err("This EQ has more bands of one kind than the running EQ holds.".into());
    }
    let preamp = if bypass { 0.0 } else { state.preamp };
    let mut out = vec![("preamp:Gain 1".to_string(), 10f64.powf(preamp / 20.0))];
    let mut used = [0usize; 6];
    let mut bands: Vec<Option<[(&str, f64); 3]>> = vec![None; shape.slots().len()];
    if !bypass {
        let slots = shape.slots();
        for f in state.filters.iter().filter(|f| f.enabled) {
            let Some(k) = kind_index(&f.kind) else { continue };
            used[k] += 1;
            let pos = slots.iter().position(|(i, name)| *i == k && *name == format!("{}_{}", KINDS[k].1, used[k])).expect("fits");
            bands[pos] = Some(band(f, caps));
        }
    }
    for ((kind, name), b) in shape.slots().into_iter().zip(bands) {
        for (port, v) in b.unwrap_or_else(|| identity(kind)) {
            out.push((format!("{name}:{port}"), v));
        }
    }
    Ok(out)
}

fn num(v: f64) -> String {
    format!("{v:.6}")
}

/// An output's node.name as it may appear in the config and on a command line.
pub fn valid_node_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 255 && name.chars().all(|c| c.is_ascii_alphanumeric() || "._:-+@".contains(c))
}

/// ~/.config/pipewire/pipewire.conf.d/onboard-eq.conf for a graph of `shape` with `controls`, playing into
/// `target` (a sink's node.name; None: PipeWire's choice).
pub fn conf(shape: Shape, controls: &[(String, f64)], target: Option<&str>) -> String {
    let value = |key: &str| controls.iter().find(|(k, _)| k == key).map(|(_, v)| *v).unwrap_or(0.0);
    let mut nodes = vec![format!("{{ type = builtin name = preamp label = mixer control = {{ \"Gain 1\" = {} }} }}", num(value("preamp:Gain 1")))];
    let mut links = Vec::new();
    let mut last = "preamp".to_string();
    for (kind, name) in shape.slots() {
        let c = |port: &str| num(value(&format!("{name}:{port}")));
        nodes.push(format!(
            "{{ type = builtin name = {name} label = {} control = {{ \"Freq\" = {} \"Q\" = {} \"Gain\" = {} }} }}",
            KINDS[kind].2,
            c("Freq"),
            c("Q"),
            c("Gain")
        ));
        links.push(format!("{{ output = \"{last}:Out\" input = \"{name}:In\" }}"));
        last = name;
    }
    let target = target.filter(|t| valid_node_name(t));
    let mut out = String::new();
    out.push_str(&format!("{MARK}: SYNQ's EQ, a PipeWire filter-chain. Written by SYNQ; edits here are replaced.\n"));
    out.push_str(&format!("{MARK} shape {}\n", shape.label()));
    if let Some(t) = target {
        out.push_str(&format!("{MARK} target {t}\n"));
    }
    out.push_str("context.modules = [\n    {   name = libpipewire-module-filter-chain\n        args = {\n");
    out.push_str(&format!("            node.description = \"{DESCRIPTION}\"\n            media.name = \"{DESCRIPTION}\"\n"));
    out.push_str("            filter.graph = {\n                nodes = [\n");
    for n in &nodes {
        out.push_str(&format!("                    {n}\n"));
    }
    out.push_str("                ]\n                links = [\n");
    for l in &links {
        out.push_str(&format!("                    {l}\n"));
    }
    out.push_str(&format!("                ]\n                inputs = [ \"preamp:In 1\" ]\n                outputs = [ \"{last}:Out\" ]\n            }}\n"));
    out.push_str("            audio.channels = 2\n            audio.position = [ FL FR ]\n");
    out.push_str(&format!("            capture.props = {{\n                node.name = \"{SINK_NAME}\"\n                media.class = \"Audio/Sink\"\n            }}\n"));
    out.push_str(&format!("            playback.props = {{\n                node.name = \"{OUTPUT_NAME}\"\n                node.passive = true\n"));
    if let Some(t) = target {
        out.push_str(&format!("                target.object = \"{t}\"\n                node.target = \"{t}\"\n"));
    }
    out.push_str("            }\n        }\n    }\n]\n");
    out
}

/// What SYNQ wrote in a config of its own: (shape, target). None for a file that isn't SYNQ's.
pub fn read_conf(text: &str) -> Option<(Shape, Option<String>)> {
    if !text.starts_with(MARK) {
        return None;
    }
    let mut shape = None;
    let mut target = None;
    for line in text.lines().take(4) {
        if let Some(s) = line.strip_prefix(&format!("{MARK} shape ")) {
            shape = Shape::parse(s);
        } else if let Some(t) = line.strip_prefix(&format!("{MARK} target ")) {
            target = Some(t.trim().to_string()).filter(|t| valid_node_name(t));
        }
    }
    Some((shape?, target))
}

/// The argument of `pw-cli set-param <id> Props <arg>` that sets every control at once.
pub fn props_arg(controls: &[(String, f64)]) -> String {
    let pairs: Vec<String> = controls.iter().map(|(k, v)| format!("\"{k}\" {}", num(*v))).collect();
    format!("{{ params = [ {} ] }}", pairs.join(" "))
}

// ---------------------------------------------------------------------------------------------------------
// The audio graph as `pw-dump` describes it

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sink {
    pub id: u32,
    pub serial: Option<u64>,
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Graph {
    pub version: String,
    /// The real outputs (Audio/Sink nodes other than SYNQ's).
    pub sinks: Vec<Sink>,
    /// SYNQ's sink (filter loaded) and its output stream.
    pub eq_sink: Option<u32>,
    pub eq_output: Option<u32>,
    /// The sink the EQ's output stream is linked to right now.
    pub eq_linked: Option<String>,
    /// The default output as the session manager has it, and the one the person picked.
    pub default_sink: Option<String>,
    pub configured_sink: Option<String>,
    /// The graph the running EQ has, read from its own controls (when pw-dump lists them).
    pub eq_shape: Option<Shape>,
    /// Audio nodes PipeWire has (none: another sound server plays the sound).
    pub audio_nodes: usize,
}

/// The graph a running EQ has, from its control names ("pk_3:Freq", ...).
pub fn shape_of_controls<'a>(names: impl Iterator<Item = &'a str>) -> Option<Shape> {
    let mut out = [0usize; 6];
    let mut any = false;
    for name in names {
        let Some(slot) = name.strip_suffix(":Freq") else { continue };
        let Some((prefix, n)) = slot.split_once('_') else { continue };
        let (Some(i), Ok(n)) = (KINDS.iter().position(|k| k.1 == prefix), n.parse::<usize>()) else { continue };
        out[i] = out[i].max(n);
        any = true;
    }
    any.then_some(Shape(out))
}

fn metadata_name(v: &Value) -> Option<String> {
    match v {
        Value::Object(_) => v.get("name").and_then(Value::as_str).map(String::from),
        Value::String(s) => serde_json::from_str::<Value>(s).ok().and_then(|j| j.get("name").and_then(Value::as_str).map(String::from)).or_else(|| Some(s.clone()).filter(|s| !s.is_empty() && !s.starts_with('{'))),
        _ => None,
    }
}

/// Reads `pw-dump`'s JSON. None when it isn't pw-dump output.
pub fn parse_dump(json: &str) -> Option<Graph> {
    let all: Vec<Value> = serde_json::from_str(json).ok()?;
    let mut g = Graph::default();
    let mut nodes: Vec<(u32, String, String)> = Vec::new();
    let mut links: Vec<(u32, u32)> = Vec::new();
    for o in &all {
        let id = o.get("id").and_then(Value::as_u64).unwrap_or(u64::MAX) as u32;
        let info = o.get("info");
        let props = info.and_then(|i| i.get("props"));
        let prop = |k: &str| props.and_then(|p| p.get(k)).and_then(Value::as_str).map(String::from);
        match o.get("type").and_then(Value::as_str).unwrap_or("") {
            "PipeWire:Interface:Core" => {
                if let Some(v) = info.and_then(|i| i.get("version")).and_then(Value::as_str) {
                    g.version = v.to_string();
                }
            }
            "PipeWire:Interface:Node" => {
                let name = prop("node.name").unwrap_or_default();
                let class = prop("media.class").unwrap_or_default();
                if name == SINK_NAME {
                    g.eq_sink = Some(id);
                    // Props: [ { volume, ... }, { params: [ "preamp:Gain 1", 1.0, "pk_1:Freq", ... ] } ]
                    let props = info.and_then(|i| i.get("params")).and_then(|p| p.get("Props")).and_then(Value::as_array);
                    let names = props.into_iter().flatten().filter_map(|p| p.get("params").and_then(Value::as_array)).flatten().filter_map(Value::as_str);
                    g.eq_shape = shape_of_controls(names);
                } else if name == OUTPUT_NAME {
                    g.eq_output = Some(id);
                } else if class == "Audio/Sink" {
                    g.audio_nodes += 1;
                    let description = prop("node.description").or_else(|| prop("node.nick")).unwrap_or_else(|| name.clone());
                    let serial = props.and_then(|p| p.get("object.serial")).and_then(|s| s.as_u64().or_else(|| s.as_str().and_then(|s| s.parse().ok())));
                    g.sinks.push(Sink { id, serial, name: name.clone(), description });
                }
                if class.starts_with("Audio/") && class != "Audio/Sink" && name != SINK_NAME {
                    g.audio_nodes += 1;
                }
                nodes.push((id, name, class));
            }
            "PipeWire:Interface:Link" => {
                let n = |k: &str| info.and_then(|i| i.get(k)).and_then(Value::as_u64).map(|v| v as u32);
                if let (Some(out), Some(inp)) = (n("output-node-id"), n("input-node-id")) {
                    links.push((out, inp));
                }
            }
            "PipeWire:Interface:Metadata" => {
                let name = o.get("props").and_then(|p| p.get("metadata.name")).and_then(Value::as_str).map(String::from).or_else(|| prop("metadata.name")).unwrap_or_default();
                if name != "default" {
                    continue;
                }
                for m in o.get("metadata").and_then(Value::as_array).into_iter().flatten() {
                    if m.get("subject").and_then(Value::as_u64) != Some(0) {
                        continue;
                    }
                    let value = m.get("value").and_then(metadata_name);
                    match m.get("key").and_then(Value::as_str) {
                        Some("default.audio.sink") => g.default_sink = value,
                        Some("default.configured.audio.sink") => g.configured_sink = value,
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(out) = g.eq_output {
        g.eq_linked = links.iter().filter(|(o, _)| *o == out).find_map(|(_, i)| nodes.iter().find(|n| n.0 == *i).map(|n| n.1.clone()));
    }
    Some(g)
}

// ---------------------------------------------------------------------------------------------------------
// The engine status the Sound page shows (the same shape as Windows' engine::Status, plus `pipewire`)

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub code: &'static str,
    pub blocking: bool,
    pub message: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    /// The sink's node.name.
    pub id: String,
    pub name: String,
    pub title: String,
    pub short: String,
    pub state: &'static str,
    /// The EQ plays into this output.
    pub engine: bool,
    pub slots: Vec<&'static str>,
    pub enhancements_disabled: bool,
    /// What you hear right now (the EQ's output when the EQ is the default, else the default output).
    pub is_default: bool,
    /// The EQ can be put on it.
    pub can_add: bool,
    pub issues: Vec<Issue>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Pipewire {
    pub running: bool,
    pub version: Option<String>,
    /// The "SYNQ EQ" sink is loaded.
    pub filter_loaded: bool,
    pub config_path: String,
    pub config_written: bool,
    pub default_sink: Option<String>,
    /// The output the EQ plays into.
    pub target: Option<String>,
    /// The EQ needs a bigger graph: PipeWire must load it again (one restart, on the person's click).
    pub needs_restart: bool,
    /// PipeWire plays the saved EQ exactly (1.4+), or with older biquads (`effective`).
    pub exact: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// "active" | "missing" | "notOnOutput" | "broken" | "noOutput"
    pub state: &'static str,
    pub summary: String,
    pub installed: bool,
    pub version: Option<String>,
    pub install_path: Option<String>,
    pub registered: bool,
    pub default_output: Option<Output>,
    pub outputs: Vec<Output>,
    pub inputs_with_engine: Vec<String>,
    pub problems: Vec<Issue>,
    pub can_undo: bool,
    pub installer_ready: bool,
    /// Which engine this is: "pipewire" (Windows' Equalizer APO status has no such field).
    pub backend: &'static str,
    pub pipewire: Pipewire,
}

/// "Built-in Audio Analog Stereo" -> "Built-in Audio"; "FiiO K5 Pro Analog Stereo" -> "FiiO K5 Pro".
pub fn title(description: &str) -> String {
    const SUFFIXES: [&str; 9] = [" Analog Stereo", " Analogue Stereo", " Digital Stereo (IEC958)", " Digital Stereo (HDMI)", " Digital Stereo", " Stereo", " Mono", " Analog Surround 5.1", " Analog Surround 7.1"];
    let mut t = description.trim().to_string();
    for s in SUFFIXES {
        if let Some(stripped) = t.strip_suffix(s) {
            t = stripped.trim().to_string();
            break;
        }
    }
    if t.is_empty() { description.trim().to_string() } else { t }
}

/// For chips: the title, or its first words up to 18 characters.
pub fn short(title: &str) -> String {
    if title.chars().count() <= 18 {
        return title.to_string();
    }
    let mut out = String::new();
    for w in title.split_whitespace() {
        if !out.is_empty() && out.chars().count() + 1 + w.chars().count() > 18 {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(w);
    }
    if out.is_empty() { title.chars().take(18).collect() } else { out }
}

/// What's on disk for the engine (SYNQ's config and its own record of the setup).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Disk {
    pub config_path: String,
    /// SYNQ's config is there: (shape, target).
    pub config: Option<(Shape, Option<String>)>,
    pub needs_restart: bool,
    /// The last live update PipeWire refused, if it did.
    pub push_error: Option<String>,
    /// PipeWire doesn't play the saved EQ exactly (older biquads), and the version that doesn't.
    pub inexact: Option<String>,
}

fn output_of(s: &Sink, engine: bool, is_default: bool) -> Output {
    let t = title(&s.description);
    Output { id: s.name.clone(), name: s.description.clone(), short: short(&t), title: t, state: "active", engine, slots: Vec::new(), enhancements_disabled: false, is_default, can_add: !engine, issues: Vec::new() }
}

/// The engine status from `pw-dump` (None: PipeWire isn't running or its tools aren't installed).
pub fn status(graph: Option<&Graph>, disk: &Disk) -> Status {
    let mut problems = Vec::new();
    let base = |state: &'static str, summary: &str, problems: Vec<Issue>, pw: Pipewire| Status {
        state,
        summary: summary.to_string(),
        installed: pw.running,
        version: pw.version.clone(),
        install_path: Some(disk.config_path.clone()),
        registered: pw.filter_loaded,
        default_output: None,
        outputs: Vec::new(),
        inputs_with_engine: Vec::new(),
        problems,
        can_undo: disk.config.is_some(),
        installer_ready: true,
        backend: "pipewire",
        pipewire: pw,
    };
    let Some(g) = graph else {
        problems.push(Issue {
            code: "noPipewire",
            blocking: true,
            message: "PipeWire isn't running (or its tools, pw-dump and pw-cli, aren't installed), so SYNQ's EQ can't play. On Linux the EQ runs inside PipeWire.".into(),
        });
        let pw = Pipewire { config_path: disk.config_path.clone(), config_written: disk.config.is_some(), exact: true, ..Default::default() };
        return base("missing", "not set up", problems, pw);
    };
    let eq_default = g.default_sink.as_deref() == Some(SINK_NAME);
    let target = g.eq_linked.clone().or_else(|| disk.config.as_ref().and_then(|c| c.1.clone()));
    let pw = Pipewire {
        running: true,
        version: Some(g.version.clone()).filter(|v| !v.is_empty()),
        filter_loaded: g.eq_sink.is_some(),
        config_path: disk.config_path.clone(),
        config_written: disk.config.is_some(),
        default_sink: g.default_sink.clone(),
        target: target.clone(),
        needs_restart: disk.needs_restart,
        exact: disk.inexact.is_none(),
    };
    // What you hear: the EQ's output when the EQ is the default, else the default output.
    let hearing: Option<&Sink> = if eq_default { target.as_deref().and_then(|t| g.sinks.iter().find(|s| s.name == t)) } else { g.default_sink.as_deref().and_then(|d| g.sinks.iter().find(|s| s.name == d)) };
    let eq_on = |s: &Sink| eq_default && g.eq_sink.is_some() && target.as_deref() == Some(s.name.as_str());
    let outputs: Vec<Output> = g.sinks.iter().map(|s| output_of(s, eq_on(s), hearing.is_some_and(|h| h.name == s.name))).collect();
    let default_output = outputs.iter().find(|o| o.is_default).cloned();

    if disk.needs_restart {
        problems.push(Issue { code: "reloadNeeded", blocking: true, message: "This EQ has more bands of one kind than the running EQ holds. Restart the sound once to load it.".into() });
    }
    if let Some(e) = &disk.push_error {
        problems.push(Issue { code: "pushFailed", blocking: true, message: format!("PipeWire didn't take the last EQ change: {e}") });
    }
    if let Some(v) = &disk.inexact {
        problems.push(Issue {
            code: "olderPipewire",
            blocking: false,
            message: format!("PipeWire {v} plays shelf filters with a fixed slope and low/high-pass Q of at least 0.71; SYNQ checked that it stays under 0 dB. PipeWire 1.4 or newer plays the EQ exactly."),
        });
    }
    if g.sinks.is_empty() {
        if g.audio_nodes == 0 {
            problems.insert(0, Issue {
                code: "notSoundServer",
                blocking: true,
                message: "PipeWire runs, but another sound server (PulseAudio) plays your sound, so SYNQ's EQ can't. On Linux the EQ needs PipeWire as the sound server.".into(),
            });
            return base("missing", "not set up", problems, pw);
        }
        let mut s = base("noOutput", "no sound output", problems, pw);
        s.outputs = outputs;
        return s;
    }
    let (state, summary) = if g.eq_sink.is_none() {
        if disk.config.is_some() {
            problems.insert(0, Issue { code: "notLoaded", blocking: true, message: "SYNQ's EQ is set up, but PipeWire hasn't loaded it. Restart the sound once to load it.".into() });
            ("broken", "needs a fix".to_string())
        } else {
            ("notOnOutput", format!("not on {}", default_output.as_ref().map(|o| o.short.as_str()).unwrap_or("this output")))
        }
    } else if !eq_default {
        ("notOnOutput", format!("not on {}", default_output.as_ref().map(|o| o.short.as_str()).unwrap_or("this output")))
    } else if default_output.is_none() {
        problems.insert(0, Issue { code: "noTarget", blocking: true, message: "SYNQ's EQ isn't playing into any output.".into() });
        ("broken", "needs a fix".to_string())
    } else if problems.iter().any(|p| p.blocking) {
        ("broken", "needs a fix".to_string())
    } else {
        ("active", format!("on · {} output", default_output.as_ref().map(|o| o.short.as_str()).unwrap_or("")))
    };
    let mut s = base(state, &summary, problems, pw);
    s.default_output = default_output;
    s.outputs = outputs;
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eq::{self, Filter};

    fn f(kind: &str, freq: f64, gain: f64, q: f64) -> Filter {
        Filter { enabled: true, kind: kind.into(), freq, gain, q }
    }

    fn headphone_eq() -> EqState {
        EqState {
            preamp: -3.0,
            filters: vec![f("LSC", 105.0, 2.5, 0.71), f("PK", 60.0, 0.2, 1.0), f("PK", 3000.0, -3.0, 1.2), f("HSC", 10000.0, -2.0, 0.71), f("PK", 7500.0, -2.8, 2.0)],
        }
    }

    fn get(c: &[(String, f64)], key: &str) -> f64 {
        c.iter().find(|(k, _)| k == key).unwrap_or_else(|| panic!("{key}")).1
    }

    /// RBJ biquad magnitude at `freq` for coefficients computed the way PipeWire's biquad.c does (1.4+), with an
    /// identity at the edges exactly as PipeWire has it. Independent of eq.rs, to check the generated controls.
    fn pipewire_db(label: &str, freq: f64, q: f64, gain: f64, at: f64, rate: f64) -> f64 {
        let cutoff = (freq * 2.0 / rate).clamp(0.0, 1.0);
        let a = 10f64.powf(gain / 40.0);
        let (b, a_) = match label {
            "bq_peaking" if cutoff <= 0.0 || cutoff >= 1.0 => ([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]),
            "bq_lowshelf" if cutoff <= 0.0 => ([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]),
            "bq_highshelf" if cutoff <= 0.0 => ([a * a, 0.0, 0.0], [1.0, 0.0, 0.0]),
            "bq_lowpass" if cutoff >= 1.0 => ([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]),
            "bq_highpass" if cutoff <= 0.0 => ([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]),
            "bq_notch" if cutoff <= 0.0 || cutoff >= 1.0 => ([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]),
            _ => {
                let w0 = std::f64::consts::PI * cutoff;
                let (s, k) = w0.sin_cos();
                let alpha = s / (2.0 * q);
                let k2 = 2.0 * a.sqrt() * alpha;
                match label {
                    "bq_peaking" => ([1.0 + alpha * a, -2.0 * k, 1.0 - alpha * a], [1.0 + alpha / a, -2.0 * k, 1.0 - alpha / a]),
                    "bq_lowshelf" => ([a * ((a + 1.0) - (a - 1.0) * k + k2), 2.0 * a * ((a - 1.0) - (a + 1.0) * k), a * ((a + 1.0) - (a - 1.0) * k - k2)], [(a + 1.0) + (a - 1.0) * k + k2, -2.0 * ((a - 1.0) + (a + 1.0) * k), (a + 1.0) + (a - 1.0) * k - k2]),
                    "bq_highshelf" => ([a * ((a + 1.0) + (a - 1.0) * k + k2), -2.0 * a * ((a - 1.0) + (a + 1.0) * k), a * ((a + 1.0) + (a - 1.0) * k - k2)], [(a + 1.0) - (a - 1.0) * k + k2, 2.0 * ((a - 1.0) - (a + 1.0) * k), (a + 1.0) - (a - 1.0) * k - k2]),
                    "bq_lowpass" => ([(1.0 - k) / 2.0, 1.0 - k, (1.0 - k) / 2.0], [1.0 + alpha, -2.0 * k, 1.0 - alpha]),
                    "bq_highpass" => ([(1.0 + k) / 2.0, -(1.0 + k), (1.0 + k) / 2.0], [1.0 + alpha, -2.0 * k, 1.0 - alpha]),
                    _ => ([1.0, -2.0 * k, 1.0], [1.0 + alpha, -2.0 * k, 1.0 - alpha]),
                }
            }
        };
        let w = 2.0 * std::f64::consts::PI * at / rate;
        let (s1, c1) = w.sin_cos();
        let (s2, c2) = (2.0 * w).sin_cos();
        let (nr, ni) = (b[0] + b[1] * c1 + b[2] * c2, -(b[1] * s1 + b[2] * s2));
        let (dr, di) = (a_[0] + a_[1] * c1 + a_[2] * c2, -(a_[1] * s1 + a_[2] * s2));
        10.0 * ((nr * nr + ni * ni) / (dr * dr + di * di)).log10()
    }

    /// The whole graph's response at `at` Hz from its controls, as PipeWire 1.4+ computes it.
    fn graph_db(controls: &[(String, f64)], shape: Shape, at: f64) -> f64 {
        let mut db = 20.0 * get(controls, "preamp:Gain 1").log10();
        for (kind, name) in shape.slots() {
            let c = |p: &str| get(controls, &format!("{name}:{p}"));
            db += pipewire_db(KINDS[kind].2, c("Freq"), c("Q"), c("Gain"), at, eq::SAMPLE_RATE_HZ);
        }
        db
    }

    #[test]
    fn the_graph_plays_exactly_the_eq_eq_rs_checks() {
        let state = headphone_eq();
        let c = controls(&state, false, DEFAULT_SHAPE, Caps::LATEST).unwrap();
        for at in [20.0, 60.0, 105.0, 400.0, 1000.0, 3000.0, 7500.0, 10_000.0, 16_000.0, 20_000.0] {
            let want = state.preamp + eq::response_db(&state, at);
            let got = graph_db(&c, DEFAULT_SHAPE, at);
            assert!((want - got).abs() < 1e-6, "{at} Hz: eq.rs {want}, graph {got}");
        }
    }

    #[test]
    fn every_unused_slot_is_an_exact_identity() {
        let flat = EqState { preamp: 0.0, filters: Vec::new() };
        let c = controls(&flat, false, DEFAULT_SHAPE, Caps::LATEST).unwrap();
        assert_eq!(c.len(), 1 + 3 * DEFAULT_SHAPE.slots().len());
        for (kind, name) in DEFAULT_SHAPE.slots() {
            for at in [10.0, 1000.0, 22_000.0] {
                let ctl = |p: &str| get(&c, &format!("{name}:{p}"));
                let db = pipewire_db(KINDS[kind].2, ctl("Freq"), ctl("Q"), ctl("Gain"), at, 48_000.0);
                assert!(db.abs() < 1e-12, "{name} at {at}: {db}");
                // At 44.1, 96 and 192 kHz too (a low-pass opened at a megahertz is still open).
                for rate in [44_100.0, 96_000.0, 192_000.0] {
                    assert!(pipewire_db(KINDS[kind].2, ctl("Freq"), ctl("Q"), ctl("Gain"), at, rate).abs() < 1e-12);
                }
            }
        }
        assert_eq!(get(&c, "preamp:Gain 1"), 1.0);
    }

    #[test]
    fn bypass_is_flat_and_off_bands_are_unused_slots() {
        let state = headphone_eq();
        let bypassed = controls(&state, true, DEFAULT_SHAPE, Caps::LATEST).unwrap();
        let flat = controls(&EqState { preamp: 0.0, filters: Vec::new() }, false, DEFAULT_SHAPE, Caps::LATEST).unwrap();
        assert_eq!(bypassed, flat, "bypass = every filter off at 0 dB, as Equalizer APO is given");
        let mut off = state.clone();
        off.filters[2].enabled = false;
        let c = controls(&off, false, DEFAULT_SHAPE, Caps::LATEST).unwrap();
        for at in [100.0, 3000.0, 9000.0] {
            assert!((graph_db(&c, DEFAULT_SHAPE, at) - (off.preamp + eq::response_db(&off, at))).abs() < 1e-6);
        }
    }

    #[test]
    fn any_mix_of_kinds_fits_the_default_graph_live() {
        // A band changing kind, more peaks, a notch: no bigger graph needed.
        let mut s = headphone_eq();
        s.filters.push(f("NO", 4000.0, 0.0, 8.0));
        s.filters.push(f("HPQ", 20.0, 0.0, 0.7));
        s.filters.push(f("LPQ", 18_000.0, 0.0, 0.7));
        s.filters[1].kind = "HSC".into();
        assert!(DEFAULT_SHAPE.fits(&s));
        let c = controls(&s, false, DEFAULT_SHAPE, Caps::LATEST).unwrap();
        for at in [15.0, 50.0, 1000.0, 4000.0, 12_000.0, 19_000.0] {
            assert!((graph_db(&c, DEFAULT_SHAPE, at) - (s.preamp + eq::response_db(&s, at))).abs() < 1e-6, "{at}");
        }
        // Twenty peaks fit; a third low shelf needs a bigger graph.
        let peaks = EqState { preamp: -6.0, filters: (0..20).map(|i| f("PK", 100.0 + 400.0 * i as f64, -1.0, 1.0)).collect() };
        assert!(DEFAULT_SHAPE.fits(&peaks));
        let shelves = EqState { preamp: 0.0, filters: (0..3).map(|i| f("LSC", 50.0 + 10.0 * i as f64, -1.0, 0.7)).collect() };
        assert!(!DEFAULT_SHAPE.fits(&shelves));
        assert!(controls(&shelves, false, DEFAULT_SHAPE, Caps::LATEST).is_err());
        let bigger = Shape::for_state(&shelves);
        assert_eq!(bigger.0, [20, 3, 2, 1, 1, 2]);
        assert!(controls(&shelves, false, bigger, Caps::LATEST).is_ok());
        // Bands that are off need no slot.
        let mut off = shelves.clone();
        off.filters[2].enabled = false;
        assert!(DEFAULT_SHAPE.fits(&off));
    }

    #[test]
    fn older_pipewire_gets_its_own_q_and_the_gate_runs_on_what_it_plays() {
        let v100 = Caps::for_version("1.0.5");
        assert_eq!(v100, Caps { rbj: false, gain_max: 20.0 });
        assert_eq!(Caps::for_version("0.3.48"), Caps { rbj: false, gain_max: 5.0 });
        assert_eq!(Caps::for_version("0.3.52"), Caps { rbj: false, gain_max: 20.0 });
        assert_eq!(Caps::for_version("1.4.2-1ubuntu1"), Caps::LATEST);
        assert_eq!(Caps::for_version("1.6.0"), Caps::LATEST);
        assert_eq!(Caps::for_version("garbage"), Caps { rbj: false, gain_max: 5.0 }, "unknown: the oldest rules");
        let s = EqState { preamp: -7.0, filters: vec![f("LSC", 100.0, 4.0, 0.5), f("HPQ", 30.0, 0.0, 0.5), f("LPQ", 16_000.0, 0.0, 2.0), f("PK", 1000.0, 6.0, 1.0)] };
        let e = effective(&s, v100);
        assert!((e.filters[0].q - SQRT1_2).abs() < 1e-12, "a shelf has slope 1");
        assert!((e.filters[1].q - SQRT1_2).abs() < 1e-12, "a high-pass can't go below Q 0.71");
        assert_eq!(e.filters[2].q, 2.0);
        assert_eq!(e.filters[3], s.filters[3], "peaks are exact");
        assert!(!exact(&s, v100) && exact(&s, Caps::LATEST));
        assert_eq!(effective(&s, Caps::for_version("0.3.48")).filters[3].gain, 5.0, "boosts were capped at 5 dB");
        // The resonance sent for a Q gives that Q back through the old formula.
        for q in [SQRT1_2, 0.8, 1.0, 2.0, 7.5, 20.0] {
            let g = 10f64.powf(resonance_db(q) / 20.0);
            let d = ((4.0 - (16.0 - 16.0 / (g * g)).sqrt()) / 2.0).sqrt();
            assert!((1.0 / d - q).abs() < 1e-6, "{q}");
        }
        let c = controls(&e, false, DEFAULT_SHAPE, v100).unwrap();
        assert!((get(&c, "lp_1:Q") - resonance_db(2.0)).abs() < 1e-12);
        assert!((get(&c, "hp_1:Q") - 0.0).abs() < 1e-9, "Q 0.71 is 0 dB of resonance");
        assert_eq!(get(&c, "ls_1:Q"), SQRT1_2);
        // The peak gate on what 1.0 plays: eq.rs' own validate on the effective EQ.
        assert!(eq::validate(&e).is_ok());
    }

    #[test]
    fn the_config_is_a_filter_chain_onboard_can_read_back() {
        let c = controls(&headphone_eq(), false, DEFAULT_SHAPE, Caps::LATEST).unwrap();
        let text = conf(DEFAULT_SHAPE, &c, Some("alsa_output.usb-FiiO_K5_Pro-00.analog-stereo"));
        assert!(text.starts_with(MARK));
        assert_eq!(read_conf(&text), Some((DEFAULT_SHAPE, Some("alsa_output.usb-FiiO_K5_Pro-00.analog-stereo".to_string()))));
        assert!(text.contains("name = libpipewire-module-filter-chain"));
        assert!(text.contains(&format!("node.name = \"{SINK_NAME}\"")) && text.contains("media.class = \"Audio/Sink\""));
        assert!(text.contains(&format!("node.name = \"{OUTPUT_NAME}\"")) && text.contains("node.passive = true"));
        assert!(text.contains("target.object = \"alsa_output.usb-FiiO_K5_Pro-00.analog-stereo\""));
        assert!(text.contains("inputs = [ \"preamp:In 1\" ]") && text.contains("outputs = [ \"no_2:Out\" ]"));
        for (_, _, label) in KINDS {
            assert!(text.contains(&format!("label = {label} ")), "{label}");
        }
        // Every slot is chained once, in order, from the preamp to the last notch.
        let slots = DEFAULT_SHAPE.slots();
        assert_eq!(text.matches("{ output = ").count(), slots.len());
        assert!(text.contains("{ output = \"preamp:Out\" input = \"pk_1:In\" }"));
        assert!(text.contains("{ output = \"hp_1:Out\" input = \"no_1:In\" }"));
        // Balanced braces and brackets, and quotes.
        assert_eq!(text.matches('{').count(), text.matches('}').count());
        assert_eq!(text.matches('[').count(), text.matches(']').count());
        assert_eq!(text.matches('"').count() % 2, 0);
        // The baked-in values are the controls (so the next PipeWire start plays the current EQ).
        assert!(text.contains("name = pk_1 label = bq_peaking control = { \"Freq\" = 60.000000 \"Q\" = 1.000000 \"Gain\" = 0.200000 }"));
        // A name that isn't a node name never reaches the file; another program's file isn't SYNQ's.
        assert!(!conf(DEFAULT_SHAPE, &c, Some("x\" } evil = {")).contains("evil"));
        assert_eq!(read_conf("context.modules = []"), None);
        assert_eq!(read_conf(&conf(DEFAULT_SHAPE, &c, None)), Some((DEFAULT_SHAPE, None)));
    }

    #[test]
    fn live_updates_set_every_control_at_once() {
        let c = controls(&headphone_eq(), false, DEFAULT_SHAPE, Caps::LATEST).unwrap();
        let arg = props_arg(&c);
        assert!(arg.starts_with("{ params = [ \"preamp:Gain 1\" 0.707946 "));
        assert!(arg.contains("\"ls_1:Freq\" 105.000000 \"ls_1:Q\" 0.710000 \"ls_1:Gain\" 2.500000"));
        assert!(arg.ends_with(" ] }"));
        assert_eq!(arg.matches("\" ").count(), c.len(), "one value per control");
    }

    const DUMP: &str = r#"[
      { "id": 0, "type": "PipeWire:Interface:Core", "info": { "version": "1.0.5", "name": "pipewire-0" } },
      { "id": 40, "type": "PipeWire:Interface:Metadata", "props": { "metadata.name": "default" },
        "metadata": [
          { "subject": 0, "key": "default.audio.sink", "type": "Spa:String:JSON", "value": { "name": "onboard_eq" } },
          { "subject": 0, "key": "default.configured.audio.sink", "type": "Spa:String:JSON", "value": "{ \"name\": \"onboard_eq\" }" },
          { "subject": 63, "key": "target.object", "value": "x" } ] },
      { "id": 41, "type": "PipeWire:Interface:Metadata", "props": { "metadata.name": "settings" }, "metadata": [] },
      { "id": 50, "type": "PipeWire:Interface:Node", "info": { "props": { "node.name": "alsa_output.pci-0000_00_1f.3.analog-stereo", "node.description": "Built-in Audio Analog Stereo", "media.class": "Audio/Sink", "object.serial": 50 } } },
      { "id": 51, "type": "PipeWire:Interface:Node", "info": { "props": { "node.name": "alsa_output.usb-FiiO_K5_Pro-00.analog-stereo", "node.description": "FiiO K5 Pro Analog Stereo", "media.class": "Audio/Sink", "object.serial": "77" } } },
      { "id": 52, "type": "PipeWire:Interface:Node", "info": { "props": { "node.name": "alsa_input.pci.analog-stereo", "media.class": "Audio/Source" } } },
      { "id": 62, "type": "PipeWire:Interface:Node", "info": { "props": { "node.name": "onboard_eq", "media.class": "Audio/Sink", "node.description": "SYNQ EQ" },
        "params": { "Props": [ { "volume": 1.0, "mute": false }, { "params": [ "preamp:Gain 1", 1.0, "pk_1:Freq", 0.0, "pk_2:Freq", 0.0, "ls_1:Freq", 0.0, "ls_2:Freq", 0.0, "hs_1:Freq", 0.0, "lp_1:Freq", 1000000.0, "no_1:Freq", 0.0, "pk_1:Q", 0.7 ] } ] } } },
      { "id": 63, "type": "PipeWire:Interface:Node", "info": { "props": { "node.name": "onboard_eq.output", "media.class": "Stream/Output/Audio" } } },
      { "id": 70, "type": "PipeWire:Interface:Link", "info": { "output-node-id": 63, "input-node-id": 51, "state": "active" } },
      { "id": 71, "type": "PipeWire:Interface:Link", "info": { "output-node-id": 63, "input-node-id": 51, "state": "active" } }
    ]"#;

    fn disk(config: bool) -> Disk {
        Disk { config_path: "/home/u/.config/pipewire/pipewire.conf.d/onboard-eq.conf".into(), config: config.then(|| (DEFAULT_SHAPE, Some("alsa_output.usb-FiiO_K5_Pro-00.analog-stereo".into()))), ..Default::default() }
    }

    #[test]
    fn reads_the_graph_from_pw_dump() {
        let g = parse_dump(DUMP).unwrap();
        assert_eq!(g.version, "1.0.5");
        assert_eq!(g.sinks.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["alsa_output.pci-0000_00_1f.3.analog-stereo", "alsa_output.usb-FiiO_K5_Pro-00.analog-stereo"]);
        assert_eq!(g.sinks[1].serial, Some(77));
        assert_eq!((g.eq_sink, g.eq_output), (Some(62), Some(63)));
        assert_eq!(g.eq_linked.as_deref(), Some("alsa_output.usb-FiiO_K5_Pro-00.analog-stereo"));
        assert_eq!(g.default_sink.as_deref(), Some(SINK_NAME));
        assert_eq!(g.configured_sink.as_deref(), Some(SINK_NAME), "a JSON string value is read too");
        assert_eq!(g.eq_shape, Some(Shape([2, 2, 1, 1, 0, 1])), "read from the running EQ's own controls");
        assert_eq!(g.audio_nodes, 3, "two outputs and a microphone");
        assert!(parse_dump("not json").is_none());
        assert_eq!(parse_dump("[]").unwrap(), Graph::default());
        assert_eq!(shape_of_controls(["preamp:Gain 1", "x_1:Freq", "pk_q:Freq"].into_iter()), None);
    }

    #[test]
    fn the_status_says_where_the_eq_plays() {
        let g = parse_dump(DUMP).unwrap();
        let s = status(Some(&g), &disk(true));
        assert_eq!((s.state, s.summary.as_str()), ("active", "on · FiiO K5 Pro output"));
        let d = s.default_output.as_ref().unwrap();
        assert_eq!((d.id.as_str(), d.title.as_str(), d.engine, d.is_default, d.can_add), ("alsa_output.usb-FiiO_K5_Pro-00.analog-stereo", "FiiO K5 Pro", true, true, false));
        assert_eq!(s.outputs.len(), 2);
        assert!(!s.outputs[0].engine && s.outputs[0].can_add);
        assert!(s.pipewire.running && s.pipewire.filter_loaded && s.can_undo && s.backend == "pipewire");
        // The JSON has every field the Sound page reads (src/lib/backend.ts EngineStatus).
        let j = serde_json::to_value(&s).unwrap();
        for k in ["state", "summary", "installed", "version", "installPath", "registered", "defaultOutput", "outputs", "inputsWithEngine", "problems", "canUndo", "installerReady", "backend", "pipewire"] {
            assert!(j.get(k).is_some(), "{k}");
        }
        for k in ["id", "name", "title", "short", "state", "engine", "slots", "enhancementsDisabled", "isDefault", "canAdd", "issues"] {
            assert!(j["defaultOutput"].get(k).is_some(), "{k}");
        }
    }

    #[test]
    fn the_status_covers_every_case() {
        // No PipeWire at all.
        let s = status(None, &disk(false));
        assert_eq!(s.state, "missing");
        assert!(s.problems[0].blocking && !s.installed);
        // PipeWire, not set up: the default output without the EQ.
        let mut g = parse_dump(DUMP).unwrap();
        g.eq_sink = None;
        g.eq_output = None;
        g.eq_linked = None;
        g.default_sink = Some("alsa_output.pci-0000_00_1f.3.analog-stereo".into());
        let s = status(Some(&g), &disk(false));
        assert_eq!((s.state, s.summary.as_str()), ("notOnOutput", "not on Built-in Audio"));
        assert!(s.default_output.as_ref().is_some_and(|d| !d.engine && d.can_add && d.is_default));
        // Set up but not loaded yet (PipeWire hasn't restarted).
        let s = status(Some(&g), &disk(true));
        assert_eq!(s.state, "broken");
        assert_eq!(s.problems[0].code, "notLoaded");
        // Loaded, but another output is the default: you hear it without the EQ.
        let mut g2 = parse_dump(DUMP).unwrap();
        g2.default_sink = Some("alsa_output.pci-0000_00_1f.3.analog-stereo".into());
        let s = status(Some(&g2), &disk(true));
        assert_eq!(s.state, "notOnOutput");
        assert_eq!(s.default_output.unwrap().id, "alsa_output.pci-0000_00_1f.3.analog-stereo");
        assert!(s.outputs.iter().all(|o| !o.engine));
        // The EQ is the default but plays into nothing.
        let mut g3 = parse_dump(DUMP).unwrap();
        g3.eq_linked = None;
        let s = status(Some(&g3), &Disk { config: Some((DEFAULT_SHAPE, None)), ..disk(true) });
        assert_eq!((s.state, s.problems[0].code), ("broken", "noTarget"));
        // A bigger graph is waiting for a restart; a live update failed; older PipeWire.
        let g = parse_dump(DUMP).unwrap();
        assert_eq!(status(Some(&g), &Disk { needs_restart: true, ..disk(true) }).problems[0].code, "reloadNeeded");
        assert_eq!(status(Some(&g), &Disk { push_error: Some("x".into()), ..disk(true) }).state, "broken");
        let older = status(Some(&g), &Disk { inexact: Some("1.0.5".into()), ..disk(true) });
        assert_eq!((older.state, older.problems[0].code, older.problems[0].blocking), ("active", "olderPipewire", false));
        // No outputs at all.
        let mut empty = parse_dump(DUMP).unwrap();
        empty.sinks.clear();
        assert_eq!(status(Some(&empty), &disk(true)).state, "noOutput");
        // PipeWire runs for screen sharing only (PulseAudio plays the sound, as on a stock Ubuntu 22.04).
        let video_only = parse_dump(r#"[{ "id": 0, "type": "PipeWire:Interface:Core", "info": { "version": "0.3.48" } }]"#).unwrap();
        let s = status(Some(&video_only), &disk(false));
        assert_eq!((s.state, s.problems[0].code), ("missing", "notSoundServer"));
    }

    #[test]
    fn names_for_the_page() {
        assert_eq!(title("Built-in Audio Analog Stereo"), "Built-in Audio");
        assert_eq!(title("HDA NVidia Digital Stereo (HDMI)"), "HDA NVidia");
        assert_eq!(title("Stereo"), "Stereo");
        assert_eq!(short("FiiO K5 Pro"), "FiiO K5 Pro");
        assert_eq!(short("Focusrite Scarlett 2i2 USB"), "Focusrite Scarlett");
        assert!(valid_node_name("alsa_output.usb-FiiO_K5_Pro-00.analog-stereo") && valid_node_name("bluez_output.AA_BB_CC_DD_EE_FF.1"));
        assert!(!valid_node_name("") && !valid_node_name("a b") && !valid_node_name("x\"y") && !valid_node_name("$(rm)"));
    }
}
