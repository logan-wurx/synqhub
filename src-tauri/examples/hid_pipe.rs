//! Test tool, not part of the app: SYNQ's HID bridge (src/hid.rs, same allowlist) over stdin and
//! stdout, one JSON object per line, so scripts/openmouse-readonly-check.mjs can run OpenMouse's
//! drivers against real mice without a window. It has no feature-report write at all; output
//! reports are checked by the script's read-only guard before they get here.
//!
//!   cargo run --example hid_pipe        (driven by the script; not meant to be typed into)

#[path = "../src/hid.rs"]
#[allow(dead_code)]
mod hid;
#[path = "../src/openmouse_ids.rs"]
#[allow(dead_code)]
mod openmouse_ids;
#[path = "../src/brands.rs"]
#[allow(dead_code)]
mod brands;
#[path = "../src/brand_ids.rs"]
#[allow(dead_code)]
mod brand_ids;
#[path = "../src/advanced.rs"]
#[allow(dead_code)]
mod advanced;

use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::sync::Arc;

fn out(v: Value) {
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{v}");
    let _ = o.flush();
}

fn main() {
    let state = hid::HidState::new();
    let emit: hid::Emit = Arc::new(|e| match e {
        hid::HidEvent::Input { key, report_id, data, .. } => out(json!({ "event": "input", "key": key, "reportId": report_id, "data": data })),
        hid::HidEvent::Lost { key } => out(json!({ "event": "lost", "key": key })),
    });
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let id = req["id"].clone();
        let key = req["key"].as_str().unwrap_or("").to_string();
        let report_id = req["reportId"].as_u64().unwrap_or(0) as u8;
        let data: Vec<u8> = req["data"].as_array().map(|a| a.iter().map(|x| x.as_u64().unwrap_or(0) as u8).collect()).unwrap_or_default();
        let result: Result<Value, String> = match req["op"].as_str().unwrap_or("") {
            "list" => hid::list(&state).map(|l| json!(l)),
            "open" => hid::open_with(&state, &key, emit.clone()).map(|_| Value::Null),
            "close" => hid::close(&state, &key).map(|_| Value::Null),
            "send" => hid::send_report(&state, &key, report_id, &data).map(|_| Value::Null),
            "getFeature" => hid::receive_feature_report(&state, &key, report_id).map(|d| json!(d)),
            "quit" => break,
            other => Err(format!("{other} is not available in the read-only pipe")),
        };
        match result {
            Ok(v) => out(json!({ "id": id, "ok": v })),
            Err(e) => out(json!({ "id": id, "err": e })),
        }
    }
    // Readers stop when their devices are dropped.
    for s in hid::list(&state).unwrap_or_default() {
        let _ = hid::close(&state, &s.key);
    }
}
