//! The Games page's library: which games are installed (read-only), and their cover art.
//!
//! - Steam: `libraryfolders.vdf` for the library folders, then each `appmanifest_<appid>.acf` for the
//!   name and install folder; the game's program names come from the largest .exe files in that folder
//!   (installers, crash reporters, anti-cheat services and launchers left out). Nothing is written and
//!   nothing is started.
//! - Epic: the launcher's `*.item` manifests (display name, install folder, launch program).
//! - The built-in favourites (games.rs `SEEDS`) are matched by program name or Steam id, and pick up the
//!   icon of their program where their launcher usually installs it.
//!
//! Art: a game with a Steam app id gets its official header image from Steam's public CDN, fetched once
//! and kept in `game-art/`; otherwise its program's icon; or an image the person picked. Every file
//! is checked to be an image (and its size capped) before it is kept or shown.
//!
//! Linux: Steam is found at ~/.steam/steam or ~/.local/share/Steam (or Flatpak's copy); a Proton game's
//! programs are its .exe files as on Windows, and a native game's are its largest executables, named the
//! way the helper sees them running (`games::process_name`: "cs2" is "cs2.exe"). Only the first bytes of
//! such a file are read, to tell a program from a data file. There is no Epic launcher, no program icon
//! (art comes from Steam or the person), and the art is fetched with curl or wget.

use crate::games::{self, SEEDS};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Images larger than this are refused.
pub const MAX_ART_BYTES: usize = 2 * 1024 * 1024;
const MAX_SCAN_ENTRIES: usize = 6000;
const SCAN_DEPTH: usize = 4;
/// Steam's tools and runtimes, not games.
const NOT_GAMES: [u32; 6] = [228980, 1070560, 1391110, 1628350, 250820, 1493710];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    pub id: String,
    pub name: String,
    /// "steam", "epic", or "builtin" for a favourite found on this PC.
    pub source: &'static str,
    pub appid: Option<u32>,
    pub exes: Vec<String>,
    /// A program to take the icon from, when there's no Steam art.
    pub icon_exe: Option<String>,
    pub installed: bool,
}

// ---- Valve's KeyValues text (libraryfolders.vdf, appmanifest_*.acf)

/// Every "key" "value" pair in the file, in order (sections are flattened).
pub fn vdf_pairs(text: &str) -> Vec<(String, String)> {
    let mut tokens: Vec<Option<String>> = Vec::new(); // None = a brace
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                let mut s = String::new();
                while let Some(c) = chars.next() {
                    match c {
                        '\\' => {
                            if let Some(n) = chars.next() {
                                s.push(match n {
                                    'n' => '\n',
                                    't' => '\t',
                                    other => other,
                                });
                            }
                        }
                        '"' => break,
                        other => s.push(other),
                    }
                }
                tokens.push(Some(s));
            }
            '{' | '}' => tokens.push(None),
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < tokens.len() {
        if let (Some(k), Some(v)) = (&tokens[i], &tokens[i + 1]) {
            out.push((k.clone(), v.clone()));
            i += 2;
        } else {
            i += 1;
        }
    }
    out
}

fn first(pairs: &[(String, String)], key: &str) -> Option<String> {
    pairs.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.clone())
}

/// Program files that are never the game itself.
fn not_the_game(name: &str) -> bool {
    const SKIP: [&str; 30] = [
        "unins", "setup", "install", "redist", "vcredist", "vc_redist", "dxsetup", "dxwebsetup", "prereq", "crash", "report", "easyanticheat", "eac", "battleye",
        "beservice", "be_", "launcher", "update", "patch", "cef", "webhelper", "helper", "dotnet", "python", "7z", "notification", "overlay", "steamerror",
        "benchmark", "touchup",
    ];
    let n = name.to_ascii_lowercase();
    SKIP.iter().any(|s| n.contains(s))
}

/// The game's program names: the largest .exe files under `dir` (at most `SCAN_DEPTH` folders down),
/// the obvious non-game programs left out. Reads folder listings only.
pub fn main_exes(dir: &Path, take: usize) -> Vec<String> {
    let mut found: Vec<(u64, String)> = Vec::new();
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    let mut seen = 0usize;
    while let Some((d, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            seen += 1;
            if seen > MAX_SCAN_ENTRIES {
                break;
            }
            let Ok(ft) = e.file_type() else { continue };
            let name = e.file_name().to_string_lossy().to_string();
            if ft.is_dir() {
                if depth < SCAN_DEPTH && !name.starts_with('.') && !name.eq_ignore_ascii_case("_CommonRedist") && !name.eq_ignore_ascii_case("redist") {
                    stack.push((e.path(), depth + 1));
                }
            } else if name.to_ascii_lowercase().ends_with(".exe") && !not_the_game(&name) && games::exe_ok(&name).is_ok() {
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                found.push((size, name.to_ascii_lowercase()));
            } else if cfg!(unix) && native_program(&e.path(), &name) && !not_the_game(&name) {
                let n = games::process_name(&name);
                if games::exe_ok(&n).is_ok() {
                    found.push((e.metadata().map(|m| m.len()).unwrap_or(0), n));
                }
            }
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let mut out: Vec<String> = Vec::new();
    for (_, n) in found {
        if !out.contains(&n) {
            out.push(n);
        }
        if out.len() >= take {
            break;
        }
    }
    out
}

/// A native Linux program: no extension (or a Unity build's .x86_64 / .x86), executable, and an ELF file.
/// Reads its first four bytes only.
#[cfg(unix)]
fn native_program(path: &Path, name: &str) -> bool {
    use std::io::Read;
    use std::os::unix::fs::PermissionsExt;
    let lower = name.to_ascii_lowercase();
    let plain = !lower.contains('.') || lower.ends_with(".x86_64") || lower.ends_with(".x86");
    if !plain || !std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0) {
        return false;
    }
    let mut magic = [0u8; 4];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut magic)).is_ok() && magic == [0x7f, b'E', b'L', b'F']
}

#[cfg(not(unix))]
fn native_program(_path: &Path, _name: &str) -> bool {
    false
}

/// Linux: the Steam folder (~/.steam/steam, ~/.local/share/Steam, or Flatpak's), the first that has a library.
#[cfg(not(windows))]
fn steam_root() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let candidates = [
        home.join(".steam").join("steam"),
        home.join(".local").join("share").join("Steam"),
        home.join(".var").join("app").join("com.valvesoftware.Steam").join(".local").join("share").join("Steam"),
    ];
    candidates.into_iter().find(|p| p.join("steamapps").is_dir()).map(|p| p.canonicalize().unwrap_or(p))
}

#[cfg(windows)]
fn steam_root() -> Option<PathBuf> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    let hkcu = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\Valve\Steam").and_then(|k| k.get_value::<String, _>("SteamPath"));
    let hklm = || RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\WOW6432Node\Valve\Steam").and_then(|k| k.get_value::<String, _>("InstallPath"));
    hkcu.or_else(|_| hklm()).ok().map(|p| PathBuf::from(p.replace('/', "\\"))).filter(|p| p.is_dir())
}

/// Windows paths compare without case, slash style or a trailing separator.
fn same_dir(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    norm(a) == norm(b)
}

/// The installed Steam games under `root` (the Steam folder).
pub fn steam_games(root: &Path) -> Vec<Detected> {
    let mut libraries = vec![root.to_path_buf()];
    if let Ok(t) = std::fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) {
        for (k, v) in vdf_pairs(&t) {
            if k.eq_ignore_ascii_case("path") {
                let p = PathBuf::from(v.replace("\\\\", "\\"));
                // The registry and libraryfolders.vdf spell the same folder differently (case, slashes,
                // a trailing separator), so compare normalised forms or every game is listed twice.
                if !libraries.iter().any(|l| same_dir(l, &p)) {
                    libraries.push(p);
                }
            }
        }
    }
    let mut out = Vec::new();
    for lib in libraries {
        let apps = lib.join("steamapps");
        let Ok(rd) = std::fs::read_dir(&apps) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !(name.starts_with("appmanifest_") && name.ends_with(".acf")) {
                continue;
            }
            let Ok(t) = std::fs::read_to_string(e.path()) else { continue };
            let pairs = vdf_pairs(&t);
            let (Some(appid), Some(title), Some(dir)) = (first(&pairs, "appid").and_then(|a| a.parse::<u32>().ok()), first(&pairs, "name"), first(&pairs, "installdir")) else { continue };
            let lower = title.to_ascii_lowercase();
            if NOT_GAMES.contains(&appid) || lower.contains("redistributable") || lower.contains("proton") || lower.contains("steam linux runtime") || lower.contains("steamworks") {
                continue;
            }
            let install = apps.join("common").join(&dir);
            out.push(Detected { id: format!("steam-{appid}"), name: title, source: "steam", appid: Some(appid), exes: main_exes(&install, 2), icon_exe: None, installed: install.is_dir() });
        }
    }
    out.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
    out
}

/// The installed Epic games (the launcher's manifests).
pub fn epic_games(manifests: &Path) -> Vec<Detected> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(manifests) else { return out };
    for e in rd.flatten() {
        if e.path().extension().is_none_or(|x| x != "item") {
            continue;
        }
        let Ok(t) = std::fs::read_to_string(e.path()) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else { continue };
        let (Some(name), Some(app), Some(dir)) = (v["DisplayName"].as_str(), v["AppName"].as_str(), v["InstallLocation"].as_str()) else { continue };
        if v["bIsApplication"].as_bool() == Some(false) {
            continue;
        }
        let launch = v["LaunchExecutable"].as_str().unwrap_or("");
        let mut exes: Vec<String> = Path::new(launch).file_name().map(|f| f.to_string_lossy().to_ascii_lowercase()).filter(|f| games::exe_ok(f).is_ok() && !not_the_game(f)).into_iter().collect();
        for x in main_exes(Path::new(dir), 2) {
            if exes.len() < 2 && !exes.contains(&x) {
                exes.push(x);
            }
        }
        let id: String = format!("epic-{}", app.chars().filter(|c| c.is_ascii_alphanumeric()).take(30).collect::<String>().to_ascii_lowercase());
        let icon = Path::new(dir).join(launch);
        out.push(Detected { id, name: name.into(), source: "epic", appid: None, exes, icon_exe: icon.is_file().then(|| icon.to_string_lossy().into()), installed: Path::new(dir).is_dir() });
    }
    out
}

/// Everything installed, with the favourites merged in (a detected game whose program or Steam id is a
/// favourite's becomes that favourite). Program names already claimed by another entry are dropped.
pub fn detect_in(steam: Option<&Path>, epic: Option<&Path>) -> Vec<Detected> {
    let mut found: Vec<Detected> = steam.map(steam_games).unwrap_or_default();
    found.extend(epic.map(epic_games).unwrap_or_default());
    // One entry per game even if a library is listed twice or a game is installed in two launchers.
    let mut seen_games: HashSet<String> = HashSet::new();
    found.retain(|d| {
        let by_id = d.appid.map(|a| format!("app:{a}"));
        let by_name = format!("name:{}", d.name.trim().to_ascii_lowercase());
        let fresh = by_id.as_ref().is_none_or(|k| !seen_games.contains(k)) && !seen_games.contains(&by_name);
        if fresh {
            seen_games.extend(by_id);
            seen_games.insert(by_name);
        }
        fresh
    });
    let mut out: Vec<Detected> = SEEDS
        .iter()
        .map(|s| {
            let icon = s.icon_paths.iter().find(|p| Path::new(p).is_file()).map(|p| p.to_string());
            Detected { id: s.id.into(), name: s.name.into(), source: "builtin", appid: s.appid, exes: s.exes.iter().map(|e| e.to_string()).collect(), icon_exe: icon.clone(), installed: icon.is_some() }
        })
        .collect();
    let mut claimed: HashSet<String> = out.iter().flat_map(|d| d.exes.iter().cloned()).collect();
    for d in found {
        let same_name = |s: &Detected| s.name.trim().eq_ignore_ascii_case(d.name.trim());
        if let Some(seed) = out.iter_mut().find(|s| s.source == "builtin" && ((d.appid.is_some() && s.appid == d.appid) || d.exes.iter().any(|e| s.exes.contains(e)) || same_name(s))) {
            seed.installed = true;
            seed.icon_exe = seed.icon_exe.take().or(d.icon_exe);
            continue;
        }
        let exes: Vec<String> = d.exes.iter().filter(|e| !claimed.contains(*e)).cloned().collect();
        claimed.extend(exes.iter().cloned());
        out.push(Detected { exes, ..d });
    }
    out
}

#[cfg(windows)]
pub fn detect() -> Vec<Detected> {
    let epic = std::env::var_os("ProgramData").map(|p| PathBuf::from(p).join(r"Epic\EpicGamesLauncher\Data\Manifests"));
    detect_in(steam_root().as_deref(), epic.as_deref())
}

/// Linux: Steam only (Epic has no Linux launcher; Heroic and Lutris games can be added by name).
#[cfg(not(windows))]
pub fn detect() -> Vec<Detected> {
    detect_in(steam_root().as_deref(), None)
}

// ---- art

/// The image type of `bytes` (by its signature), if it is one the page can show.
pub fn image_kind(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() > MAX_ART_BYTES || bytes.len() < 8 {
        return None;
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(&[0, 0, 1, 0]) {
        return Some("image/x-icon");
    }
    None
}

pub fn data_url(bytes: &[u8]) -> Option<String> {
    let kind = image_kind(bytes)?;
    Some(format!("data:{kind};base64,{}", base64(bytes)))
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Steam's public header image for an app id (two CDN layouts, newest first).
pub fn steam_art_urls(appid: u32) -> [String; 2] {
    [
        format!("https://shared.steamstatic.com/store_item_assets/steam/apps/{appid}/header.jpg"),
        format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/header.jpg"),
    ]
}

/// Linux: curl, or wget (one small public image, 10 s at most, nothing else sent).
#[cfg(not(windows))]
fn download(url: &str, to: &Path) -> bool {
    use std::process::{Command, Stdio};
    let to = to.to_string_lossy();
    let ok = |cmd: &str, args: &[&str]| Command::new(cmd).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
    ok("curl", &["-fsSL", "--max-time", "10", "--max-filesize", "2097152", "-o", &to, url]) || ok("wget", &["-q", "-T", "10", "-O", &to, url])
}

/// Linux: a program's icon lives in its .exe resources, which need Windows to read; none here.
#[cfg(not(windows))]
pub fn exe_icon(_exe: &Path) -> Option<Vec<u8>> {
    None
}

#[cfg(windows)]
fn download(url: &str, to: &Path) -> bool {
    use windows::Win32::System::Com::Urlmon::URLDownloadToFileW;
    let u = windows::core::HSTRING::from(url);
    let p = windows::core::HSTRING::from(to.as_os_str());
    unsafe { URLDownloadToFileW(None, &u, &p, 0, None).is_ok() }
}

/// The program's icon as an .ico file (32-bit, up to 256 px). Reads the program file only.
#[cfg(windows)]
pub fn exe_icon(exe: &Path) -> Option<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::{BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, DeleteObject, GetDC, GetDIBits, GetObjectW, HGDIOBJ, ReleaseDC};
    use windows::Win32::UI::Shell::SHDefExtractIconW;
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};
    let path = windows::core::HSTRING::from(exe.as_os_str());
    unsafe {
        let mut icon = HICON::default();
        let size: u32 = 128;
        if SHDefExtractIconW(&path, 0, 0, Some(&mut icon), None, size | (16 << 16)).is_err() || icon.is_invalid() {
            return None;
        }
        let mut info = ICONINFO::default();
        let ok = GetIconInfo(icon, &mut info).is_ok();
        let result = (|| {
            if !ok || info.hbmColor.is_invalid() {
                return None;
            }
            let mut bm = BITMAP::default();
            if GetObjectW(HGDIOBJ(info.hbmColor.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _)) == 0 {
                return None;
            }
            let (w, h) = (bm.bmWidth, bm.bmHeight);
            if !(1..=256).contains(&w) || !(1..=256).contains(&h) {
                return None;
            }
            let mut bi = BITMAPINFO { bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: h, biPlanes: 1, biBitCount: 32, ..Default::default() }, ..Default::default() };
            let mut px = vec![0u8; (w * h * 4) as usize];
            let dc = GetDC(None);
            let lines = GetDIBits(dc, info.hbmColor, 0, h as u32, Some(px.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
            ReleaseDC(None, dc);
            if lines != h {
                return None;
            }
            // Old icons have no alpha: then everything is opaque.
            if px.chunks(4).all(|p| p[3] == 0) {
                px.chunks_mut(4).for_each(|p| p[3] = 255);
            }
            Some(ico_from_bgra(w as u32, h as u32, &px))
        })();
        if !info.hbmColor.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(info.hbmColor.0));
        }
        if !info.hbmMask.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(info.hbmMask.0));
        }
        let _ = DestroyIcon(icon);
        result
    }
}

/// An .ico file holding one 32-bit image (`bgra` bottom-up, as GetDIBits gives it).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn ico_from_bgra(w: u32, h: u32, bgra: &[u8]) -> Vec<u8> {
    let mask_row = (w.div_ceil(32) * 4) as usize;
    let body = 40 + bgra.len() + mask_row * h as usize;
    let mut f = Vec::with_capacity(22 + body);
    f.extend_from_slice(&[0, 0, 1, 0, 1, 0]);
    f.push(if w >= 256 { 0 } else { w as u8 });
    f.push(if h >= 256 { 0 } else { h as u8 });
    f.extend_from_slice(&[0, 0, 1, 0, 32, 0]);
    f.extend_from_slice(&(body as u32).to_le_bytes());
    f.extend_from_slice(&22u32.to_le_bytes());
    f.extend_from_slice(&40u32.to_le_bytes());
    f.extend_from_slice(&(w as i32).to_le_bytes());
    f.extend_from_slice(&((h * 2) as i32).to_le_bytes());
    f.extend_from_slice(&1u16.to_le_bytes());
    f.extend_from_slice(&32u16.to_le_bytes());
    f.extend_from_slice(&[0u8; 24]);
    f.extend_from_slice(bgra);
    f.extend(std::iter::repeat_n(0u8, mask_row * h as usize));
    f
}

fn read_image(p: &Path) -> Option<Vec<u8>> {
    let bytes = std::fs::read(p).ok()?;
    image_kind(&bytes).map(|_| bytes)
}

/// The art for one game: the person's own image, else Steam's (fetched once), else the program's icon.
/// `dir` is the app's game-art folder.
pub fn art(dir: &Path, id: &str, appid: Option<u32>, icon_exe: Option<&str>) -> Option<String> {
    if !games::id_ok(id) {
        return None;
    }
    let _ = std::fs::create_dir_all(dir);
    if let Some(b) = read_image(&dir.join(format!("custom-{id}"))) {
        return data_url(&b);
    }
    if let Some(appid) = appid {
        let file = dir.join(format!("steam-{appid}.jpg"));
        if let Some(b) = read_image(&file) {
            return data_url(&b);
        }
        // Fetched once: a failed fetch leaves a marker, so it isn't asked for on every visit.
        let miss = dir.join(format!("steam-{appid}.missing"));
        if !miss.exists() {
            for url in steam_art_urls(appid) {
                let tmp = dir.join(format!("steam-{appid}.download"));
                if download(&url, &tmp) {
                    if let Some(b) = read_image(&tmp).filter(|b| image_kind(b) == Some("image/jpeg")) {
                        let _ = std::fs::rename(&tmp, &file);
                        return data_url(&b);
                    }
                }
                let _ = std::fs::remove_file(&tmp);
            }
            let _ = std::fs::write(&miss, b"");
        }
    }
    let file = dir.join(format!("icon-{id}.ico"));
    if let Some(b) = read_image(&file) {
        return data_url(&b);
    }
    let exe = icon_exe.map(Path::new).filter(|p| p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe")))?;
    let ico = exe_icon(exe)?;
    let _ = std::fs::write(&file, &ico);
    data_url(&ico)
}

/// Keeps an image the person picked for a game (checked to be an image, at most 2 MB).
pub fn set_custom(dir: &Path, id: &str, bytes: &[u8]) -> Result<String, String> {
    if !games::id_ok(id) {
        return Err("That isn't a game id.".into());
    }
    let url = data_url(bytes).ok_or("That file isn't a PNG, JPEG, WebP or GIF image of 2 MB or less.")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("custom-{id}")), bytes).map_err(|e| e.to_string())?;
    Ok(url)
}

pub fn clear_custom(dir: &Path, id: &str) -> Result<(), String> {
    if !games::id_ok(id) {
        return Err("That isn't a game id.".into());
    }
    match std::fs::remove_file(dir.join(format!("custom-{id}"))) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("onboard-lib-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn reads_valve_keyvalues() {
        let lib = r#""libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"apps" { "730" "1234" }
	}
	// a comment
	"1" { "path" "D:\\SteamLibrary" }
}"#;
        let paths: Vec<String> = vdf_pairs(lib).into_iter().filter(|(k, _)| k == "path").map(|(_, v)| v).collect();
        assert_eq!(paths, [r"C:\Program Files (x86)\Steam", r"D:\SteamLibrary"]);
        let acf = "\"AppState\"\n{\n\t\"appid\"\t\t\"730\"\n\t\"name\"\t\t\"Counter-Strike 2\"\n\t\"installdir\"\t\t\"Counter-Strike Global Offensive\"\n}";
        let p = vdf_pairs(acf);
        assert_eq!(first(&p, "appid").as_deref(), Some("730"));
        assert_eq!(first(&p, "installdir").as_deref(), Some("Counter-Strike Global Offensive"));
    }

    fn file(p: &Path, size: usize) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, vec![0u8; size]).unwrap();
    }

    #[test]
    fn finds_steam_games_and_their_programs() {
        let root = tmp("steam");
        let d = root.join("D");
        std::fs::write(root.join("steamapps").join("libraryfolders.vdf").tap_dir(), format!("\"libraryfolders\" {{ \"0\" {{ \"path\" \"{}\" }} \"1\" {{ \"path\" \"{}\" }} }}", root.display().to_string().replace('\\', "\\\\"), d.display().to_string().replace('\\', "\\\\"))).unwrap();
        std::fs::write(root.join("steamapps").join("appmanifest_730.acf"), "\"AppState\" { \"appid\" \"730\" \"name\" \"Counter-Strike 2\" \"installdir\" \"CS\" }").unwrap();
        file(&root.join("steamapps/common/CS/game/bin/win64/cs2.exe"), 3000);
        file(&root.join("steamapps/common/CS/game/bin/win64/crashhandler64.exe"), 9000);
        file(&root.join("steamapps/common/CS/_CommonRedist/vcredist_x64.exe"), 9000);
        std::fs::create_dir_all(d.join("steamapps")).unwrap();
        std::fs::write(d.join("steamapps").join("appmanifest_228980.acf"), "\"AppState\" { \"appid\" \"228980\" \"name\" \"Steamworks Common Redistributables\" \"installdir\" \"x\" }").unwrap();
        std::fs::write(d.join("steamapps").join("appmanifest_578080.acf"), "\"AppState\" { \"appid\" \"578080\" \"name\" \"PUBG: BATTLEGROUNDS\" \"installdir\" \"PUBG\" }").unwrap();
        file(&d.join("steamapps/common/PUBG/TslGame/Binaries/Win64/TslGame.exe"), 5000);
        file(&d.join("steamapps/common/PUBG/TslGame/Binaries/Win64/TslGame_BE.exe"), 100);
        file(&d.join("steamapps/common/PUBG/TslGame/Binaries/Win64/BEService_x64.exe"), 8000);
        let found = steam_games(&root);
        assert_eq!(found.iter().map(|g| (g.id.as_str(), g.exes.clone())).collect::<Vec<_>>(), vec![("steam-730", vec!["cs2.exe".to_string()]), ("steam-578080", vec!["tslgame.exe".to_string(), "tslgame_be.exe".to_string()])]);
        // CS2 is a favourite: it merges into the built-in entry (and its art comes from app id 730).
        let all = detect_in(Some(&root), None);
        assert_eq!(all.iter().filter(|g| g.exes.contains(&"cs2.exe".to_string())).count(), 1);
        assert!(all.iter().find(|g| g.id == "cs2").unwrap().installed);
        assert!(all.iter().any(|g| g.id == "steam-578080" && g.appid == Some(578080)));
        let _ = std::fs::remove_dir_all(&root);
    }

    trait TapDir {
        fn tap_dir(self) -> Self;
    }
    impl TapDir for PathBuf {
        fn tap_dir(self) -> Self {
            std::fs::create_dir_all(self.parent().unwrap()).unwrap();
            self
        }
    }

    #[test]
    fn finds_epic_games() {
        let m = tmp("epic");
        let install = m.join("Game");
        file(&install.join("Bin/Game-Win64-Shipping.exe"), 4000);
        let item = serde_json::json!({ "DisplayName": "Some Game", "AppName": "SomeApp", "InstallLocation": install, "LaunchExecutable": "Bin/Game-Win64-Shipping.exe" });
        std::fs::write(m.join("x.item"), item.to_string()).unwrap();
        let found = epic_games(&m);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "epic-someapp");
        assert_eq!(found[0].exes, vec!["game-win64-shipping.exe".to_string()]);
        assert!(found[0].icon_exe.as_deref().unwrap().ends_with("Game-Win64-Shipping.exe"));
        let _ = std::fs::remove_dir_all(&m);
    }

    #[test]
    fn only_images_are_kept() {
        assert_eq!(image_kind(&[0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]), Some("image/jpeg"));
        assert_eq!(image_kind(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(image_kind(b"RIFF....WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_kind(b"<html><script>"), None);
        assert_eq!(image_kind(b"MZ\x90\0\x03\0\0\0\x04"), None, "a program isn't an image");
        assert_eq!(image_kind(&vec![0xff; MAX_ART_BYTES + 1]), None, "too large");
        let d = tmp("art");
        assert!(set_custom(&d, "cs2", b"not an image at all").is_err());
        assert!(set_custom(&d, "../x", b"\x89PNG\r\n\x1a\n....").is_err());
        let url = set_custom(&d, "cs2", b"\x89PNG\r\n\x1a\n....").unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        assert_eq!(art(&d, "cs2", None, None).as_deref(), Some(url.as_str()), "the person's image wins (and no fetch without an app id)");
        clear_custom(&d, "cs2").unwrap();
        assert_eq!(art(&d, "cs2", None, None), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ico_layout() {
        let ico = ico_from_bgra(2, 2, &[255u8; 16]);
        assert_eq!(&ico[..6], &[0, 0, 1, 0, 1, 0]);
        assert_eq!(image_kind(&ico), Some("image/x-icon"));
        assert_eq!(u32::from_le_bytes(ico[14..18].try_into().unwrap()) as usize, ico.len() - 22);
        assert_eq!(i32::from_le_bytes(ico[30..34].try_into().unwrap()), 4, "height counts the mask");
    }

    /// Linux: a native game's programs are its executables (ELF), named as the helper sees them running;
    /// a script, a shared library, a data file and a file that isn't ELF aren't programs.
    #[cfg(unix)]
    #[test]
    fn finds_native_linux_programs() {
        use std::os::unix::fs::PermissionsExt;
        let root = tmp("native");
        let bin = root.join("game/bin/linuxsteamrt64");
        std::fs::create_dir_all(&bin).unwrap();
        let exec = |name: &str, bytes: &[u8]| {
            let p = bin.join(name);
            std::fs::write(&p, bytes).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        let mut elf = vec![0x7f, b'E', b'L', b'F'];
        elf.resize(8000, 0);
        exec("cs2", &elf);
        exec("crashpad_handler", &elf);
        exec("Unity.x86_64", &elf[..6000]);
        exec("run.sh", b"#!/bin/sh\nexec ./cs2\n");
        exec("data.bin", &elf);
        exec("libtier0.so", &elf);
        exec("notelf", &[0u8; 9000]);
        assert_eq!(main_exes(&root, 3), vec!["cs2.exe".to_string(), "unity.exe".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A program's icon, read from a file that is always there (this test's own exe has none; the
    /// Windows shell's does). Reads the file only.
    #[cfg(windows)]
    #[test]
    fn extracts_a_program_icon() {
        let windir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into());
        let ico = exe_icon(&Path::new(&windir).join("explorer.exe")).expect("explorer.exe has an icon");
        assert_eq!(image_kind(&ico), Some("image/x-icon"));
    }

    #[test]
    fn steam_art_is_the_public_cdn() {
        for u in steam_art_urls(730) {
            assert!(u.starts_with("https://") && u.contains("steamstatic.com") && u.ends_with("/730/header.jpg"));
        }
    }
}
