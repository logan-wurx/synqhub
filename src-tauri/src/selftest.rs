//! `onboard --self-test`: CI's smoke test of a built app, run before (and without) any window. It starts the
//! HID layer and enumerates (nothing is opened or sent), checks the device tables the bridge and the Linux
//! udev rule are built from, and runs the EQ engine's detection (read-only). Prints one JSON report and
//! exits 0 when every check passed.

use serde::Serialize;

#[derive(Serialize)]
struct Check {
    name: &'static str,
    ok: bool,
    detail: String,
}

#[derive(Serialize)]
struct Report {
    app: &'static str,
    version: &'static str,
    os: &'static str,
    checks: Vec<Check>,
    ok: bool,
}

fn hid_layer() -> Check {
    match hidapi::HidApi::new() {
        Ok(api) => {
            let all: Vec<&hidapi::DeviceInfo> = api.device_list().collect();
            let listable = all.iter().filter(|d| crate::hid::usable(d.vendor_id(), d.product_id(), d.product_string(), d.usage_page(), d.usage())).count();
            Check { name: "hid", ok: true, detail: format!("hidapi started; {} HID collections present, {listable} of them SYNQ's (nothing opened)", all.len()) }
        }
        Err(e) => Check { name: "hid", ok: false, detail: format!("hidapi didn't start: {e}") },
    }
}

fn device_tables() -> Check {
    use crate::hid;
    let mut problems = Vec::new();
    if hid::BOOTLOADER_IDS.iter().any(|&(v, p)| hid::allowed(v, p)) {
        problems.push("a bootloader id is allowed".to_string());
    }
    if hid::allowed(0x0b05, 0x19af) {
        problems.push("the ASUS Aura controller is allowed".into());
    }
    for (v, p, page, usage) in [(0x046du16, 0xc54du16, 0x0001u16, 0x0006u16), (0x373b, 0x1278, 0x0001, 0x0002), (0x0b05, 0x1d1d, 0x0001, 0x0006)] {
        let a = hid::collection_access(v, p, page, usage);
        if a.and_then(|a| crate::hid_plan::node_access(v, p, page, usage, a)).is_some_and(|a| a != hid::Access::FeatureOnly) {
            problems.push(format!("{v:04x}:{p:04x} {page:04x}:{usage:04x} would be read on a shared node"));
        }
    }
    let rules = crate::udev::rules();
    if rules.replace("\r\n", "\n") != crate::udev::SHIPPED.replace("\r\n", "\n") {
        problems.push("the shipped udev rule is out of date with the tables".into());
    }
    let n_rules = rules.lines().filter(|l| l.contains("uaccess\"")).count();
    Check {
        name: "device-tables",
        ok: problems.is_empty(),
        detail: if problems.is_empty() {
            format!(
                "{} OpenMouse filters, {} keyboard filters, {} brand channels, {} update-mode ids refused; udev rule: {n_rules} entries, matches the tables",
                crate::openmouse_ids::FILTERS.len(),
                crate::openmouse_ids::KEYBOARD_FILTERS.len(),
                crate::brands::CHANNELS.len(),
                hid::BOOTLOADER_IDS.len()
            )
        } else {
            problems.join("; ")
        },
    }
}

fn eq_engine() -> Check {
    let status = crate::engine::status(None);
    let json = serde_json::to_value(&status).unwrap_or_default();
    let state = json["state"].as_str().unwrap_or("?").to_string();
    let backend = json["backend"].as_str().unwrap_or("equalizer-apo").to_string();
    let version = json["version"].as_str().map(|v| format!(" {v}")).unwrap_or_default();
    let problem = json["problems"].get(0).and_then(|p| p["message"].as_str()).map(|m| format!(": {m}")).unwrap_or_default();
    Check { name: "eq-engine", ok: !state.is_empty() && state != "?", detail: format!("{backend}{version}: {state}{problem}") }
}

/// The EQ graph for a sample EQ: every control set, the config readable back.
fn eq_graph() -> Check {
    use crate::eq_graph::{Caps, DEFAULT_SHAPE, conf, controls, read_conf};
    let sample = crate::eq::parse("Preamp: -4 dB\nFilter: ON LSC Fc 105 Hz Gain 3 dB Q 0.71\nFilter: ON PK Fc 3000 Hz Gain -2 dB Q 1.2\nFilter: ON HSC Fc 10000 Hz Gain -2 dB Q 0.71\n").state;
    match controls(&sample, false, DEFAULT_SHAPE, Caps::LATEST) {
        Ok(c) => {
            let text = conf(DEFAULT_SHAPE, &c, Some("alsa_output.sample"));
            let ok = read_conf(&text) == Some((DEFAULT_SHAPE, Some("alsa_output.sample".into()))) && crate::eq::validate(&sample).is_ok();
            Check { name: "eq-graph", ok, detail: format!("{} controls, {} biquads, config {} bytes", c.len(), DEFAULT_SHAPE.slots().len(), text.len()) }
        }
        Err(e) => Check { name: "eq-graph", ok: false, detail: e },
    }
}

#[cfg(windows)]
fn attach_console() {
    use windows::Win32::System::Console::{ATTACH_PARENT_PROCESS, AttachConsole};
    // SAFETY: attaches to the parent's console when there is one; a no-op otherwise.
    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

/// Runs every check, prints the report, returns the exit code.
pub fn run() -> i32 {
    #[cfg(windows)]
    attach_console();
    let checks = vec![hid_layer(), device_tables(), eq_engine(), eq_graph()];
    let ok = checks.iter().all(|c| c.ok);
    let report = Report { app: "SYNQ", version: env!("CARGO_PKG_VERSION"), os: std::env::consts::OS, checks, ok };
    println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
    if ok { 0 } else { 1 }
}
