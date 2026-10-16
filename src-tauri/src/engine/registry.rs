//! Reading the engine's registry state, and (in the elevated helper only) applying planned writes,
//! backups and undo.

use super::model::*;
use std::borrow::Cow;
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, RegType};
use winreg::RegKey;

fn hklm() -> RegKey {
    RegKey::predef(HKEY_LOCAL_MACHINE)
}

fn reg_type(kind: u32) -> RegType {
    use RegType::*;
    match kind {
        1 => REG_SZ,
        2 => REG_EXPAND_SZ,
        3 => REG_BINARY,
        4 => REG_DWORD,
        5 => REG_DWORD_BIG_ENDIAN,
        6 => REG_LINK,
        7 => REG_MULTI_SZ,
        8 => REG_RESOURCE_LIST,
        9 => REG_FULL_RESOURCE_DESCRIPTOR,
        10 => REG_RESOURCE_REQUIREMENTS_LIST,
        11 => REG_QWORD,
        _ => REG_NONE,
    }
}

/// All values of a key, names lowercased, typed where possible.
fn values(key: &RegKey) -> BTreeMap<String, RegValue> {
    key.enum_values()
        .filter_map(Result::ok)
        .map(|(name, v)| (name.to_ascii_lowercase(), RegValue::from_raw(v.vtype as u32, &v.bytes)))
        .collect()
}

pub fn read_global() -> Global {
    let engine = hklm().open_subkey(ENGINE_KEY).ok();
    let install_path = engine.as_ref().and_then(|k| k.get_value::<String, _>("InstallPath").ok()).filter(|p| !p.trim().is_empty());
    let dll_present = install_path.as_ref().is_some_and(|p| Path::new(p).join("EqualizerAPO.dll").is_file());
    let version = hklm().open_subkey(UNINSTALL_KEY).and_then(|k| k.get_value::<String, _>("DisplayVersion")).ok();
    let hkcr = RegKey::predef(HKEY_CLASSES_ROOT);
    let registered = [PRE_MIX_CLSID, POST_MIX_CLSID].iter().all(|c| {
        hkcr.open_subkey(format!(r"CLSID\{c}")).is_ok() && hkcr.open_subkey(format!(r"AudioEngine\AudioProcessingObjects\{c}")).is_ok()
    });
    let protected_dg = hklm().open_subkey(AUDIO_KEY).and_then(|k| k.get_value::<u32, _>(PROTECTED_DG)).ok();
    let child_apos_key = hklm().open_subkey(CHILD_APOS_KEY).is_ok();
    Global { install_path, dll_present, version, registered, protected_dg, child_apos_key }
}

fn read_one(root: &str, capture: bool, guid: &str) -> Option<Endpoint> {
    let key = hklm().open_subkey(format!(r"{root}\{guid}")).ok()?;
    let device_state = key.get_value::<u32, _>("DeviceState").unwrap_or(DEVICE_STATE_NOTPRESENT);
    let props = key.open_subkey("Properties").map(|k| values(&k)).unwrap_or_default();
    let props = props
        .into_iter()
        .filter(|(n, _)| [PROP_DESCRIPTION, PROP_INTERFACE, PROP_COMBINED].iter().any(|p| p.eq_ignore_ascii_case(n)))
        .collect();
    let fx = key.open_subkey("FxProperties").ok().map(|k| values(&k));
    let child = hklm().open_subkey(child_key(guid)).ok().map(|k| values(&k));
    Some(Endpoint { guid: guid.to_ascii_lowercase(), capture, device_state, props, fx, child })
}

pub fn read_endpoints(capture: bool) -> Vec<Endpoint> {
    let root = if capture { CAPTURE_KEY } else { RENDER_KEY };
    let Ok(key) = hklm().open_subkey(root) else { return Vec::new() };
    key.enum_keys().filter_map(Result::ok).filter(|g| valid_guid(g)).filter_map(|g| read_one(root, capture, &g)).collect()
}

/// A render endpoint by GUID.
pub fn read_endpoint(guid: &str) -> Option<Endpoint> {
    if !valid_guid(guid) {
        return None;
    }
    read_one(RENDER_KEY, false, guid)
}

fn read_value(path: &str, name: &str) -> Option<RegValue> {
    let key = hklm().open_subkey(path).ok()?;
    let v = key.get_raw_value(name).ok()?;
    Some(RegValue::Raw { kind: v.vtype as u32, bytes: v.bytes.into_owned() })
}

/// The exact state of everything a setup may touch on `e`, taken just before the first write.
pub fn capture_backup(e: &Endpoint, engine_installed_by_onboard: bool) -> Backup {
    let (keys, values) = backup_targets(e);
    Backup {
        format: 1,
        created: crate::eq::now_secs(),
        endpoint: e.guid.clone(),
        endpoint_name: e.name(),
        engine_installed_by_onboard,
        keys: keys.into_iter().map(|path| KeyBefore { existed: hklm().open_subkey(&path).is_ok(), path }).collect(),
        values: values.into_iter().map(|(path, name)| ValueBefore { before: read_value(&path, &name), path, name }).collect(),
    }
}

/// Writes the backup as JSON (what Undo reads) plus a .reg twin (for people), before any change.
pub fn write_backup(dir: &Path, b: &Backup) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create the backup folder: {e}"))?;
    let stem = format!("eq-engine-{}-{}", b.created, b.endpoint.trim_matches(['{', '}']));
    let json = dir.join(format!("{stem}.json"));
    let text = serde_json::to_string_pretty(b).map_err(|e| e.to_string())?;
    crate::eq::write_atomic(&json, &text).map_err(|e| format!("Backup failed, nothing was changed: {e}"))?;
    let reg: Vec<u8> = std::iter::once(0xFEFFu16).chain(to_reg_file(b).encode_utf16()).flat_map(u16::to_le_bytes).collect();
    std::fs::write(dir.join(format!("{stem}.reg")), reg).map_err(|e| format!("Backup failed, nothing was changed: {e}"))?;
    Ok(json)
}

/// Newest backup that hasn't been undone yet.
pub fn latest_backup(dir: &Path) -> Option<(PathBuf, Backup)> {
    let mut found: Vec<(PathBuf, Backup)> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            let n = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            n.starts_with("eq-engine-") && n.ends_with(".json") && !n.ends_with(".undone.json")
        })
        .filter_map(|p| Some((p.clone(), serde_json::from_str::<Backup>(&std::fs::read_to_string(&p).ok()?).ok()?)))
        .collect();
    found.sort_by_key(|(_, b)| b.created);
    found.pop()
}

pub fn mark_undone(path: &Path) {
    let _ = std::fs::rename(path, path.with_extension("undone.json"));
}

fn ignore_missing(r: io::Result<()>) -> io::Result<()> {
    match r {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn apply_one(op: &Op) -> Result<(), String> {
    let fail = |e: io::Error| format!("{}: {e}", op.describe().lines().next().unwrap_or_default().trim());
    match op {
        Op::CreateKey { path } => hklm().create_subkey(path).map(|_| ()).map_err(fail),
        Op::SetValue { path, name, value } => {
            let key = hklm().open_subkey_with_flags(path, KEY_READ | KEY_SET_VALUE).map_err(fail)?;
            let (kind, bytes) = value.to_raw();
            key.set_raw_value(name, &winreg::RegValue { bytes: Cow::Owned(bytes), vtype: reg_type(kind) }).map_err(fail)
        }
        Op::DeleteValue { path, name } => match hklm().open_subkey_with_flags(path, KEY_READ | KEY_SET_VALUE) {
            Ok(key) => ignore_missing(key.delete_value(name)).map_err(fail),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(fail(e)),
        },
        Op::DeleteKey { path } => ignore_missing(hklm().delete_subkey_all(path)).map_err(fail),
        Op::DeleteKeyIfEmpty { path } => match hklm().open_subkey(path) {
            Ok(key) => {
                let info = key.query_info().map_err(fail)?;
                if info.sub_keys == 0 && info.values == 0 {
                    ignore_missing(hklm().delete_subkey(path)).map_err(fail)
                } else {
                    Ok(())
                }
            }
            Err(_) => Ok(()),
        },
        Op::RegisterEngine { dll } => {
            let status = std::process::Command::new("regsvr32.exe").args(["/s", dll]).status().map_err(|e| format!("regsvr32: {e}"))?;
            if status.success() { Ok(()) } else { Err(format!("regsvr32 failed for {dll} ({status})")) }
        }
    }
}

/// Applies `ops` in order, refusing anything outside the engine's own registry places.
pub fn apply(ops: &[Op], log: &mut Vec<String>) -> Result<(), String> {
    if let Some(bad) = ops.iter().find(|op| !op_allowed(op)) {
        return Err(format!("Refused a write outside the EQ engine's settings: {}", bad.describe()));
    }
    for op in ops {
        apply_one(op)?;
        log.push(op.describe());
    }
    Ok(())
}

pub fn set_test_pipe(name: Option<&str>) -> Result<(), String> {
    let op = match name {
        Some(n) => Op::SetValue { path: ENGINE_KEY.into(), name: TEST_PIPE_VALUE.into(), value: RegValue::Sz(n.into()) },
        None => Op::DeleteValue { path: ENGINE_KEY.into(), name: TEST_PIPE_VALUE.into() },
    };
    apply_one(&op)
}
