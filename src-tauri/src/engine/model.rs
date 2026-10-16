//! The EQ engine (Equalizer APO) as registry data: what counts as "on" for an output, and the
//! exact registry writes that put it on one. The writes mirror Equalizer APO 1.4.2's own Device
//! Selector (`DeviceAPOInfo::load` / `install` / `uninstall` in its source). Pure functions only,
//! so all of it is unit-tested without touching the machine.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ---- The engine build SYNQ installs (bundled; byte-identical to the SourceForge release).
pub const ENGINE_VERSION: &str = "1.4.2";
pub const INSTALLER_FILE: &str = "EqualizerAPO-x64-1.4.2.exe";
/// SHA-256 published by SourceForge for 1.4.2/EqualizerAPO-x64-1.4.2.exe.
pub const INSTALLER_SHA256: &str = "7403be7427bbe1936a40dded082829b6e217fc4f5990fee5cba501f0ae055afa";
pub const INSTALLER_SIZE: u64 = 11_980_366;
pub const INSTALLER_URL: &str = "https://sourceforge.net/projects/equalizerapo/files/1.4.2/EqualizerAPO-x64-1.4.2.exe/download";

pub const PRE_MIX_CLSID: &str = "{EACD2258-FCAC-4FF4-B36D-419E924A6D79}";
pub const POST_MIX_CLSID: &str = "{EC1CC9CE-FAED-4822-828A-82A81A6F018F}";

// ---- Registry locations, all under HKLM.
pub const RENDER_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render";
pub const CAPTURE_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture";
pub const ENGINE_KEY: &str = r"SOFTWARE\EqualizerAPO";
pub const CHILD_APOS_KEY: &str = r"SOFTWARE\EqualizerAPO\Child APOs";
pub const AUDIO_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Audio";
pub const UNINSTALL_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\EqualizerAPO";
/// Lets the audio engine load unsigned APOs. Equalizer APO's installer sets it; driver updates
/// sometimes reset it, which its Device Selector fixes on every start.
pub const PROTECTED_DG: &str = "DisableProtectedAudioDG";
/// While this value exists, EqualizerAPO.dll reports to the named pipe it names each time Windows
/// loads it into an output (used to check that a setup really took).
pub const TEST_PIPE_VALUE: &str = "DeviceTestPipeName";

// ---- Endpoint property names (value names inside Properties / FxProperties).
pub const PROP_DESCRIPTION: &str = "{a45c254e-df1c-4efd-8020-67d146a850e0},2"; // "Speakers"
pub const PROP_INTERFACE: &str = "{b3f8fa53-0004-438e-9003-51a46e139bfc},6"; // "fifine Microphone"
/// Present on Windows 11 combined Bluetooth endpoints, where EFX doesn't work.
pub const PROP_COMBINED: &str = "{b3f8fa53-0004-438e-9003-51a46e139bfc},41";
/// PKEY_AudioEndpoint_Disable_SysFx: non-zero means "Audio enhancements" are off for the output.
pub const DISABLE_SYSFX: &str = "{1da5d803-d492-4edd-8c23-e0c0ffee7f0e},5";
/// AUDIO_SIGNALPROCESSINGMODE_DEFAULT. A processing-mode id (not a COM class, so it is never in
/// HKCR\CLSID). An SFX/MFX/EFX effect only runs for normal playback when its slot's
/// "processing modes supported" list contains it.
pub const DEFAULT_MODE: &str = "{C18E2F7E-933D-4965-B7D1-1EEF228D2AF3}";

// ---- Equalizer APO's per-output bookkeeping under Child APOs\{endpoint}.
pub const NO_VALUE: &str = "!VALUE";
pub const NO_KEY: &str = "!KEY";
pub const CHILD_VERSION: &str = "2";
pub const PRE_MIX_CHILD: &str = "PreMixChild";
pub const POST_MIX_CHILD: &str = "PostMixChild";
pub const ALLOW_SILENT: &str = "AllowSilentBufferModification";
pub const DISABLE_AUTO_ADJUST: &str = "DisableAutomaticAdjustment";
pub const CHILD_VERSION_VALUE: &str = "Version";

pub const DEVICE_STATE_DISABLED: u32 = 0x2;
pub const DEVICE_STATE_NOTPRESENT: u32 = 0x4;
pub const DEVICE_STATE_UNPLUGGED: u32 = 0x8;
/// Disabled outputs carry this bit in the registry instead of DEVICE_STATE_DISABLED.
const DEVICE_STATE_DISABLED_REG: u32 = 0x1000_0000;

pub const REG_SZ: u32 = 1;
pub const REG_DWORD: u32 = 4;
pub const REG_MULTI_SZ: u32 = 7;

/// The five effect positions an endpoint's FxProperties can name a COM class for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Slot {
    Lfx,
    Gfx,
    Sfx,
    Mfx,
    Efx,
}

impl Slot {
    pub const ALL: [Slot; 5] = [Slot::Lfx, Slot::Gfx, Slot::Sfx, Slot::Mfx, Slot::Efx];

    pub fn value_name(self) -> &'static str {
        match self {
            Slot::Lfx => "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},1",
            Slot::Gfx => "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},2",
            Slot::Sfx => "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},5",
            Slot::Mfx => "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},6",
            Slot::Efx => "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},7",
        }
    }

    /// PKEY_{SFX,MFX,EFX}_ProcessingModes_Supported_For_Streaming (REG_MULTI_SZ).
    pub fn modes_name(self) -> Option<&'static str> {
        match self {
            Slot::Sfx => Some("{d3993a3f-99c2-4402-b5ec-a92a0367664b},5"),
            Slot::Mfx => Some("{d3993a3f-99c2-4402-b5ec-a92a0367664b},6"),
            Slot::Efx => Some("{d3993a3f-99c2-4402-b5ec-a92a0367664b},7"),
            _ => None,
        }
    }

    /// PKEY_CompositeFX_{Stream,Mode,Endpoint}EffectClsid (REG_MULTI_SZ, Windows 10 1803+): a
    /// driver's list of several effects for one position.
    pub fn composite_name(self) -> Option<&'static str> {
        match self {
            Slot::Sfx => Some("{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},13"),
            Slot::Mfx => Some("{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},14"),
            Slot::Efx => Some("{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},15"),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Slot::Lfx => "LFX",
            Slot::Gfx => "GFX",
            Slot::Sfx => "SFX",
            Slot::Mfx => "MFX",
            Slot::Efx => "EFX",
        }
    }

    fn index(self) -> usize {
        Slot::ALL.iter().position(|s| *s == self).unwrap_or(0)
    }
}

/// Where the pre-mix and post-mix halves of the engine go. Same names and order as Equalizer
/// APO's InstallMode.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Mode {
    LfxGfx,
    SfxMfx,
    SfxEfx,
}

impl Mode {
    pub fn label(self) -> &'static str {
        match self {
            Mode::LfxGfx => "LFX/GFX",
            Mode::SfxMfx => "SFX/MFX",
            Mode::SfxEfx => "SFX/EFX",
        }
    }
}

/// A registry value, typed where SYNQ needs to read it and raw otherwise.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type", content = "data")]
pub enum RegValue {
    Sz(String),
    MultiSz(Vec<String>),
    Dword(u32),
    Raw { kind: u32, bytes: Vec<u8> },
}

fn utf16(bytes: &[u8]) -> Vec<u16> {
    bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect()
}

fn to_utf16z(s: &str) -> Vec<u8> {
    s.encode_utf16().chain(std::iter::once(0)).flat_map(|u| u.to_le_bytes()).collect()
}

impl RegValue {
    pub fn from_raw(kind: u32, bytes: &[u8]) -> RegValue {
        match kind {
            REG_SZ => {
                let w = utf16(bytes);
                let end = w.iter().position(|&c| c == 0).unwrap_or(w.len());
                RegValue::Sz(String::from_utf16_lossy(&w[..end]))
            }
            REG_MULTI_SZ => {
                let w = utf16(bytes);
                let list = w
                    .split(|&c| c == 0)
                    .filter(|s| !s.is_empty())
                    .map(String::from_utf16_lossy)
                    .collect();
                RegValue::MultiSz(list)
            }
            REG_DWORD if bytes.len() >= 4 => RegValue::Dword(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])),
            _ => RegValue::Raw { kind, bytes: bytes.to_vec() },
        }
    }

    pub fn to_raw(&self) -> (u32, Vec<u8>) {
        match self {
            RegValue::Sz(s) => (REG_SZ, to_utf16z(s)),
            RegValue::MultiSz(list) => {
                let mut out = Vec::new();
                for s in list {
                    out.extend(to_utf16z(s));
                }
                out.extend([0, 0]);
                (REG_MULTI_SZ, out)
            }
            RegValue::Dword(v) => (REG_DWORD, v.to_le_bytes().to_vec()),
            RegValue::Raw { kind, bytes } => (*kind, bytes.clone()),
        }
    }

    /// The same value as exact bytes (what backups hold).
    #[cfg(test)]
    pub fn raw(&self) -> RegValue {
        let (kind, bytes) = self.to_raw();
        RegValue::Raw { kind, bytes }
    }

    /// Typed view of a raw value.
    pub fn typed(&self) -> RegValue {
        match self {
            RegValue::Raw { kind, bytes } => RegValue::from_raw(*kind, bytes),
            v => v.clone(),
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            RegValue::Sz(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_dword(&self) -> Option<u32> {
        match self.typed() {
            RegValue::Dword(v) => Some(v),
            _ => None,
        }
    }

    pub fn strings(&self) -> Vec<String> {
        match self.typed() {
            RegValue::Sz(s) => vec![s],
            RegValue::MultiSz(l) => l,
            _ => Vec::new(),
        }
    }

    pub fn describe(&self) -> String {
        match self.typed() {
            RegValue::Sz(s) => format!("REG_SZ \"{s}\""),
            RegValue::MultiSz(l) => format!("REG_MULTI_SZ [{}]", l.iter().map(|s| format!("\"{s}\"")).collect::<Vec<_>>().join(", ")),
            RegValue::Dword(v) => format!("REG_DWORD {v}"),
            RegValue::Raw { kind, bytes } => format!("type {kind}, {} bytes", bytes.len()),
        }
    }
}

/// Registry state SYNQ needs about the engine itself.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Global {
    pub install_path: Option<String>,
    pub dll_present: bool,
    pub version: Option<String>,
    /// Both engine COM classes are in HKCR\CLSID and HKCR\AudioEngine\AudioProcessingObjects.
    pub registered: bool,
    pub protected_dg: Option<u32>,
    pub child_apos_key: bool,
}

impl Global {
    pub fn installed(&self) -> bool {
        self.install_path.is_some() && self.dll_present
    }
}

/// One audio endpoint as read from the registry. Value names are lowercased.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Endpoint {
    pub guid: String,
    pub capture: bool,
    pub device_state: u32,
    pub props: BTreeMap<String, RegValue>,
    /// None when the endpoint has no FxProperties key at all.
    pub fx: Option<BTreeMap<String, RegValue>>,
    /// Values under Child APOs\{guid}, when that key exists.
    pub child: Option<BTreeMap<String, RegValue>>,
}

fn get<'a>(map: &'a BTreeMap<String, RegValue>, name: &str) -> Option<&'a RegValue> {
    map.get(&name.to_ascii_lowercase())
}

/// Case-insensitive GUID comparison that ignores braces and whitespace.
pub fn same_guid(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().trim_matches(['{', '}']).to_ascii_lowercase();
    !a.trim().is_empty() && norm(a) == norm(b)
}

pub fn is_engine_clsid(s: &str) -> bool {
    same_guid(s, PRE_MIX_CLSID) || same_guid(s, POST_MIX_CLSID)
}

/// Strict "{8-4-4-4-12}" hex form, so an endpoint id can be put into a registry path safely.
pub fn valid_guid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 38 || b[0] != b'{' || b[37] != b'}' {
        return false;
    }
    b[1..37].iter().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => *c == b'-',
        _ => c.is_ascii_hexdigit(),
    })
}

/// "{0.0.0.00000000}.{1f2e3d4c-...}" (an IMMDevice id) to "{1f2e3d4c-...}".
pub fn endpoint_guid_from_id(id: &str) -> Option<String> {
    let guid = id.rsplit_once("}.").map(|(_, g)| g).unwrap_or(id).trim();
    valid_guid(guid).then(|| guid.to_ascii_lowercase())
}

impl Endpoint {
    pub fn description(&self) -> String {
        get(&self.props, PROP_DESCRIPTION).and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
    }

    pub fn interface(&self) -> String {
        get(&self.props, PROP_INTERFACE).and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
    }

    /// What Windows shows: "Speakers (fifine Microphone)".
    pub fn name(&self) -> String {
        match (self.description(), self.interface()) {
            (d, i) if !d.is_empty() && !i.is_empty() => format!("{d} ({i})"),
            (d, _) if !d.is_empty() => d,
            (_, i) if !i.is_empty() => i,
            _ => "Unnamed output".into(),
        }
    }

    pub fn short_name(&self) -> String {
        short_name(&self.description(), &self.interface())
    }

    pub fn title(&self) -> String {
        title(&self.description(), &self.interface())
    }

    pub fn present(&self) -> bool {
        self.device_state & DEVICE_STATE_NOTPRESENT == 0
    }

    pub fn disabled(&self) -> bool {
        self.device_state & (DEVICE_STATE_DISABLED | DEVICE_STATE_DISABLED_REG) != 0
    }

    pub fn unplugged(&self) -> bool {
        self.device_state & DEVICE_STATE_UNPLUGGED != 0
    }

    pub fn state_label(&self) -> &'static str {
        if !self.present() {
            "notPresent"
        } else if self.disabled() {
            "disabled"
        } else if self.unplugged() {
            "unplugged"
        } else {
            "active"
        }
    }

    fn fx_value(&self, name: &str) -> Option<&RegValue> {
        self.fx.as_ref().and_then(|fx| get(fx, name))
    }

    fn child_value(&self, name: &str) -> Option<&RegValue> {
        self.child.as_ref().and_then(|c| get(c, name))
    }

    /// Slots that name one of the engine's two COM classes (Equalizer APO's "installed" test).
    pub fn engine_slots(&self) -> Vec<Slot> {
        Slot::ALL
            .into_iter()
            .filter(|s| self.fx_value(s.value_name()).and_then(RegValue::as_str).is_some_and(is_engine_clsid))
            .collect()
    }

    pub fn has_engine(&self) -> bool {
        !self.engine_slots().is_empty()
    }

    /// Whether the engine on this output wraps the output's own pre-mix / post-mix effects, as
    /// recorded under Child APOs (what a load check waits for).
    pub fn recorded_children(&self) -> (bool, bool) {
        let set = |n: &str| self.child_value(n).and_then(RegValue::as_str).is_some_and(|s| !s.trim().is_empty());
        (set(PRE_MIX_CHILD), set(POST_MIX_CHILD))
    }

    pub fn enhancements_disabled(&self) -> bool {
        self.fx_value(DISABLE_SYSFX).and_then(RegValue::as_dword).is_some_and(|v| v != 0)
    }

    /// The slot's "processing modes supported" list. LFX/GFX have none.
    fn mode_list(&self, slot: Slot) -> ModeList {
        let Some(name) = slot.modes_name() else { return ModeList::Ok };
        match self.fx_value(name) {
            None => ModeList::Missing,
            Some(v) if v.strings().iter().any(|m| same_guid(m, DEFAULT_MODE)) => ModeList::Ok,
            Some(_) => ModeList::LacksDefault,
        }
    }

    /// A composite list for this slot that leaves the engine out, which Windows may run instead.
    fn composite_elsewhere(&self, slot: Slot) -> bool {
        slot.composite_name()
            .and_then(|n| self.fx_value(n))
            .is_some_and(|v| {
                let list = v.strings();
                list.iter().any(|c| !same_guid(c, "{00000000-0000-0000-0000-000000000000}")) && !list.iter().any(|c| is_engine_clsid(c))
            })
    }

    /// Equalizer APO's choice of positions for an output it isn't on yet (Windows 8.1+ branch of
    /// DeviceAPOInfo::load).
    pub fn choose_mode(&self) -> Mode {
        let has = |n: &str| self.fx_value(n).is_some();
        let only_lfx_gfx = (has(Slot::Lfx.value_name()) || has(Slot::Gfx.value_name()))
            && !has(Slot::Sfx.value_name())
            && !has(Slot::Mfx.value_name())
            && !has(Slot::Efx.value_name())
            && [Slot::Sfx, Slot::Mfx, Slot::Efx].iter().all(|s| !has(s.composite_name().unwrap_or_default()));
        if self.fx.is_some() && only_lfx_gfx {
            Mode::LfxGfx
        } else if get(&self.props, PROP_COMBINED).is_some() {
            Mode::SfxMfx
        } else {
            Mode::SfxEfx
        }
    }

    /// What the output had in each slot before the engine went in, as Equalizer APO records it:
    /// the CLSID, or "!VALUE" when the slot was empty.
    fn originals(&self) -> Result<[String; 5], String> {
        let mut out: [String; 5] = Default::default();
        for slot in Slot::ALL {
            out[slot.index()] = match self.fx_value(slot.value_name()) {
                None => NO_VALUE.into(),
                Some(RegValue::Sz(s)) if is_engine_clsid(s) => NO_VALUE.into(),
                Some(RegValue::Sz(s)) => s.clone(),
                Some(_) => return Err(format!("{} holds an unexpected value type, so SYNQ won't change this output.", slot.label())),
            };
        }
        Ok(out)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ModeList {
    Ok,
    /// No list at all. Equalizer APO writes one when it sets an output up, so this is unusual.
    Missing,
    /// A list without the default mode: Windows won't run the effect for normal playback.
    LacksDefault,
}

/// Driver names that say nothing about the device itself.
const GENERIC_FIRST_WORDS: [&str; 8] = ["high", "usb", "digital", "nvidia", "amd", "intel", "intel(r)", "microsoft"];

/// For page titles, the onboard chip's name is generic too: "Headphones" beats "Realtek Audio".
fn is_generic_interface(interface: &str) -> bool {
    let first = interface.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
    first.is_empty() || GENERIC_FIRST_WORDS.contains(&first.as_str()) || first.starts_with("realtek")
}

/// "2- Arctis 7 Game" -> "Arctis 7 Game"; drops (R), (TM), ® and ™.
fn tidy(name: &str) -> String {
    let mut s = name.trim();
    if let Some((n, rest)) = s.split_once("- ") {
        if !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) {
            s = rest.trim();
        }
    }
    let s = s.replace("(R)", "").replace("(r)", "").replace("(TM)", "").replace(['®', '™'], "");
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Short label for chips: "fifine", "Realtek", or the description when the interface name is a
/// generic driver name ("High Definition Audio Device" -> "Speakers").
pub fn short_name(description: &str, interface: &str) -> String {
    let first = interface.split_whitespace().next().unwrap_or("");
    let clean = first.trim_end_matches("(R)").trim_end_matches("(r)").trim_end_matches('®');
    if clean.is_empty() || GENERIC_FIRST_WORDS.contains(&first.to_ascii_lowercase().as_str()) {
        if description.is_empty() { tidy(interface) } else { tidy(description) }
    } else {
        clean.to_string()
    }
}

/// Page title for an output: the device ("fifine Microphone", "Arctis 7 Game") unless that's a
/// generic driver name, then what Windows calls the jack ("VG248", "Speakers").
pub fn title(description: &str, interface: &str) -> String {
    let (d, i) = (tidy(description), tidy(interface));
    match (d.is_empty(), i.is_empty() || is_generic_interface(interface)) {
        (_, false) => i,
        (false, true) => d,
        (true, true) if !i.is_empty() => i,
        _ => "Unnamed output".into(),
    }
}

/// DeviceAPOInfo::getOriginalAPOPreMix: which original APO the engine's pre-mix half wraps.
pub fn original_pre_mix(orig: &[String; 5], mode: Mode) -> String {
    let empty = |s: Slot| orig[s.index()] == NO_VALUE;
    let guid = match mode {
        Mode::LfxGfx if empty(Slot::Lfx) && empty(Slot::Gfx) => &orig[Slot::Sfx.index()],
        Mode::LfxGfx => &orig[Slot::Lfx.index()],
        Mode::SfxMfx if empty(Slot::Sfx) && empty(Slot::Mfx) => &orig[Slot::Lfx.index()],
        Mode::SfxEfx if empty(Slot::Sfx) && empty(Slot::Efx) => &orig[Slot::Lfx.index()],
        Mode::SfxMfx | Mode::SfxEfx => &orig[Slot::Sfx.index()],
    };
    if guid == NO_VALUE || guid == NO_KEY { String::new() } else { guid.clone() }
}

/// DeviceAPOInfo::getOriginalAPOPostMix.
pub fn original_post_mix(orig: &[String; 5], mode: Mode) -> String {
    let empty = |s: Slot| orig[s.index()] == NO_VALUE;
    let guid = match mode {
        Mode::LfxGfx if empty(Slot::Lfx) && empty(Slot::Gfx) => &orig[Slot::Mfx.index()],
        Mode::LfxGfx => &orig[Slot::Gfx.index()],
        Mode::SfxMfx if empty(Slot::Sfx) && empty(Slot::Mfx) => &orig[Slot::Gfx.index()],
        Mode::SfxMfx => &orig[Slot::Mfx.index()],
        Mode::SfxEfx if empty(Slot::Sfx) && empty(Slot::Efx) => &orig[Slot::Gfx.index()],
        Mode::SfxEfx => &orig[Slot::Efx.index()],
    };
    if guid == NO_VALUE || guid == NO_KEY { String::new() } else { guid.clone() }
}

/// `e` as it was before the engine went on: the effect slots Child APOs recorded, put back the way
/// Equalizer APO's uninstall does. Only for previews (`install --dry-run --as-if-missing`).
pub fn without_engine(e: &Endpoint) -> Endpoint {
    let mut out = e.clone();
    if let Some(fx) = out.fx.as_mut() {
        for slot in Slot::ALL {
            let key = slot.value_name().to_ascii_lowercase();
            let recorded = e.child.as_ref().and_then(|c| get(c, slot.value_name())).and_then(RegValue::as_str);
            match recorded {
                Some(NO_VALUE) => {
                    fx.remove(&key);
                }
                Some(orig) if !orig.is_empty() && orig != NO_KEY => {
                    fx.insert(key, RegValue::Sz(orig.into()));
                }
                _ => {
                    if fx.get(&key).and_then(RegValue::as_str).is_some_and(is_engine_clsid) {
                        fx.remove(&key);
                    }
                }
            }
        }
    }
    out.child = None;
    out
}

/// Modes to try, in Equalizer APO's auto-adjust order, starting with `first`.
pub fn fallback_modes(first: Mode) -> Vec<Mode> {
    let mut out = vec![first];
    out.extend([Mode::SfxEfx, Mode::SfxMfx, Mode::LfxGfx].into_iter().filter(|m| *m != first));
    out
}

pub fn endpoint_key(e: &Endpoint) -> String {
    format!(r"{}\{}", if e.capture { CAPTURE_KEY } else { RENDER_KEY }, e.guid)
}

pub fn fx_key(e: &Endpoint) -> String {
    format!(r"{}\FxProperties", endpoint_key(e))
}

pub fn child_key(guid: &str) -> String {
    format!(r"{CHILD_APOS_KEY}\{guid}")
}

// ---------------------------------------------------------------------------------------------
// Status

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub code: &'static str,
    /// True when Windows skips the engine until it is fixed.
    pub blocking: bool,
    pub message: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub id: String,
    /// What Windows shows: "Speakers (fifine Microphone)".
    pub name: String,
    /// For page titles: "fifine Microphone".
    pub title: String,
    /// For chips: "fifine".
    pub short: String,
    pub state: &'static str,
    pub engine: bool,
    pub slots: Vec<&'static str>,
    pub enhancements_disabled: bool,
    pub is_default: bool,
    /// SYNQ can put the engine on it (it has an effects slot and isn't on it yet).
    pub can_add: bool,
    pub issues: Vec<Issue>,
}

pub fn output(e: &Endpoint, default_guid: Option<&str>) -> Output {
    let slots = e.engine_slots();
    let mut issues = Vec::new();
    if !slots.is_empty() {
        if e.enhancements_disabled() {
            issues.push(Issue {
                code: "enhancementsOff",
                blocking: true,
                message: "Windows has \"Audio enhancements\" turned off for this output, so it skips the EQ.".into(),
            });
        }
        if slots.iter().any(|s| e.mode_list(*s) == ModeList::LacksDefault) {
            issues.push(Issue {
                code: "modeMissing",
                blocking: true,
                message: "This output isn't set to run the EQ for normal playback.".into(),
            });
        } else if slots.iter().any(|s| e.mode_list(*s) == ModeList::Missing) {
            issues.push(Issue {
                code: "modeListMissing",
                blocking: false,
                message: "A setting that tells Windows to run the EQ for normal playback is missing on this output.".into(),
            });
        }
        if slots.iter().any(|s| e.composite_elsewhere(*s)) {
            issues.push(Issue {
                code: "compositeOverride",
                blocking: false,
                message: "This output's driver lists its own chain of effects, which Windows may run instead of the EQ.".into(),
            });
        }
        if e.child_value(CHILD_VERSION_VALUE).and_then(RegValue::as_str).is_some_and(|v| v != CHILD_VERSION) {
            issues.push(Issue {
                code: "newerSetup",
                blocking: false,
                message: "A newer version of the EQ engine set up this output, so SYNQ leaves it alone.".into(),
            });
        }
    }
    if e.disabled() {
        issues.push(Issue { code: "outputDisabled", blocking: false, message: "This output is turned off in Windows sound settings.".into() });
    }
    Output {
        id: e.guid.clone(),
        name: e.name(),
        title: e.title(),
        short: e.short_name(),
        state: e.state_label(),
        engine: !slots.is_empty(),
        slots: slots.iter().map(|s| s.label()).collect(),
        enhancements_disabled: e.enhancements_disabled(),
        is_default: default_guid.is_some_and(|d| same_guid(d, &e.guid)),
        can_add: slots.is_empty() && e.fx.is_some() && e.present() && !e.capture,
        issues,
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// "active" | "missing" | "notOnOutput" | "disabled" | "broken" | "noOutput"
    pub state: &'static str,
    /// Short line for the header chip, e.g. "on · fifine output".
    pub summary: String,
    pub installed: bool,
    pub version: Option<String>,
    pub install_path: Option<String>,
    pub registered: bool,
    pub default_output: Option<Output>,
    /// Render outputs connected to this PC (disabled and unplugged included).
    pub outputs: Vec<Output>,
    /// Input devices the engine is also on (informational; SYNQ only manages outputs).
    pub inputs_with_engine: Vec<String>,
    /// Everything that keeps the engine from running on the default output, then warnings.
    pub problems: Vec<Issue>,
    pub can_undo: bool,
    pub installer_ready: bool,
}

pub fn status(g: &Global, render: &[Endpoint], capture: &[Endpoint], default_guid: Option<&str>) -> Status {
    let outputs: Vec<Output> = render.iter().filter(|e| e.present()).map(|e| output(e, default_guid)).collect();
    let default_output = outputs.iter().find(|o| o.is_default).cloned();
    let inputs_with_engine = capture.iter().filter(|e| e.present() && e.has_engine()).map(Endpoint::name).collect();

    let mut problems = Vec::new();
    if g.installed() {
        if !g.registered {
            problems.push(Issue { code: "notRegistered", blocking: true, message: "The EQ engine is installed, but Windows doesn't know about it.".into() });
        }
        if g.protected_dg != Some(1) {
            problems.push(Issue {
                code: "protectedAudio",
                blocking: true,
                message: "A Windows setting the EQ engine needs was reset, often by a driver update.".into(),
            });
        }
    }
    if let Some(o) = &default_output {
        problems.extend(o.issues.iter().filter(|i| i.code != "outputDisabled").cloned());
    }
    problems.sort_by_key(|i| !i.blocking);

    let (state, summary) = if !g.installed() {
        ("missing", "not set up".to_string())
    } else if let Some(o) = &default_output {
        if !o.engine {
            ("notOnOutput", format!("not on {}", o.short))
        } else if o.enhancements_disabled {
            ("disabled", format!("blocked on {}", o.short))
        } else if problems.iter().any(|p| p.blocking) {
            ("broken", "needs a fix".to_string())
        } else {
            ("active", format!("on · {} output", o.short))
        }
    } else {
        ("noOutput", "no sound output".to_string())
    };

    Status {
        state,
        summary,
        installed: g.installed(),
        version: g.version.clone(),
        install_path: g.install_path.clone(),
        registered: g.registered,
        default_output,
        outputs,
        inputs_with_engine,
        problems,
        can_undo: false,
        installer_ready: false,
    }
}

// ---------------------------------------------------------------------------------------------
// Setup plan

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum Op {
    CreateKey { path: String },
    SetValue { path: String, name: String, value: RegValue },
    DeleteValue { path: String, name: String },
    /// Removes a key and everything under it. Only used for a key SYNQ itself created.
    DeleteKey { path: String },
    /// Removes a key only if it has no values and no subkeys left.
    DeleteKeyIfEmpty { path: String },
    /// regsvr32 /s on the engine DLL, as the engine's installer and Device Selector do.
    RegisterEngine { dll: String },
}

impl Op {
    pub fn describe(&self) -> String {
        match self {
            Op::CreateKey { path } => format!("CREATE KEY     HKLM\\{path}"),
            Op::SetValue { path, name, value } => format!("SET VALUE      HKLM\\{path}\n                 \"{name}\" = {}", value.describe()),
            Op::DeleteValue { path, name } => format!("DELETE VALUE   HKLM\\{path}\n                 \"{name}\""),
            Op::DeleteKey { path } => format!("DELETE KEY     HKLM\\{path}"),
            Op::DeleteKeyIfEmpty { path } => format!("DELETE KEY     HKLM\\{path}  (only if empty)"),
            Op::RegisterEngine { dll } => format!("REGISTER       regsvr32.exe /s \"{dll}\""),
        }
    }

    pub fn path(&self) -> &str {
        match self {
            Op::CreateKey { path }
            | Op::SetValue { path, .. }
            | Op::DeleteValue { path, .. }
            | Op::DeleteKey { path }
            | Op::DeleteKeyIfEmpty { path } => path,
            Op::RegisterEngine { dll } => dll,
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub endpoint: String,
    pub endpoint_name: String,
    /// Positions used for a fresh setup; None for a repair of an existing one.
    pub mode: Option<Mode>,
    pub ops: Vec<Op>,
    pub restart_audio: bool,
    /// The output's own effects the engine wraps (fresh setup only), so the load check knows to
    /// wait for them too.
    pub pre_mix_child: Option<String>,
    pub post_mix_child: Option<String>,
}

impl Plan {
    /// What the load check should wait for: (pre-mix child, post-mix child).
    pub fn wants_children(&self) -> (bool, bool) {
        (self.pre_mix_child.as_deref().is_some_and(|c| !c.is_empty()), self.post_mix_child.as_deref().is_some_and(|c| !c.is_empty()))
    }
}

fn set(path: &str, name: &str, value: RegValue) -> Op {
    Op::SetValue { path: path.into(), name: name.into(), value }
}

fn del(path: &str, name: &str) -> Op {
    Op::DeleteValue { path: path.into(), name: name.into() }
}

/// The registry writes that put the engine on `e` (or repair it there), exactly as Equalizer
/// APO's Device Selector would with its default options, plus the two machine-wide fixes it applies
/// on every start. `mode` overrides the automatic choice (used when a check fails and the next
/// mode is tried).
pub fn plan_setup(g: &Global, e: &Endpoint, mode: Option<Mode>) -> Result<Plan, String> {
    if !g.installed() {
        return Err("The EQ engine isn't installed.".into());
    }
    if e.capture {
        return Err("SYNQ only sets the EQ engine up on outputs.".into());
    }
    if !e.present() {
        return Err("That output isn't connected to this PC.".into());
    }
    let mut ops = Vec::new();
    if g.protected_dg != Some(1) {
        ops.push(set(AUDIO_KEY, PROTECTED_DG, RegValue::Dword(1)));
    }
    if !g.registered {
        let dll = format!(r"{}\EqualizerAPO.dll", g.install_path.clone().unwrap_or_default().trim_end_matches('\\'));
        ops.push(Op::RegisterEngine { dll });
    }

    let fx = fx_key(e);
    let mut chosen = None;
    let mut children = (None, None);
    if e.has_engine() {
        // Already there: only fix what keeps Windows from running it.
        if e.child_value(CHILD_VERSION_VALUE).and_then(RegValue::as_str).is_some_and(|v| v != CHILD_VERSION) {
            return Err("A newer version of the EQ engine set up this output, so SYNQ won't change it.".into());
        }
        if e.enhancements_disabled() {
            ops.push(del(&fx, DISABLE_SYSFX));
        }
        for slot in e.engine_slots() {
            if let Some(name) = slot.modes_name().filter(|_| e.mode_list(slot) != ModeList::Ok) {
                // Missing: what Equalizer APO's install writes. Without the default mode: add it.
                let mut list = e.fx_value(name).map(RegValue::strings).unwrap_or_default();
                list.push(DEFAULT_MODE.into());
                ops.push(set(&fx, name, RegValue::MultiSz(list)));
            }
        }
    } else {
        let Some(fx_values) = &e.fx else {
            return Err("Windows doesn't allow sound effects on this output, so the EQ can't go there.".into());
        };
        let mode = mode.unwrap_or_else(|| e.choose_mode());
        chosen = Some(mode);
        let orig = e.originals()?;
        let child = child_key(&e.guid);
        if !g.child_apos_key {
            ops.push(Op::CreateKey { path: CHILD_APOS_KEY.into() });
        }
        if e.child.is_none() {
            ops.push(Op::CreateKey { path: child.clone() });
        }
        for slot in Slot::ALL {
            ops.push(set(&child, slot.value_name(), RegValue::Sz(orig[slot.index()].clone())));
        }
        let (pre_child, post_child) = (original_pre_mix(&orig, mode), original_post_mix(&orig, mode));
        ops.push(set(&child, PRE_MIX_CHILD, RegValue::Sz(pre_child.clone())));
        ops.push(set(&child, POST_MIX_CHILD, RegValue::Sz(post_child.clone())));
        children = (Some(pre_child), Some(post_child));
        ops.push(set(&child, ALLOW_SILENT, RegValue::Sz("false".into())));
        if e.child_value(DISABLE_AUTO_ADJUST).is_some() {
            ops.push(del(&child, DISABLE_AUTO_ADJUST));
        }
        ops.push(set(&child, CHILD_VERSION_VALUE, RegValue::Sz(CHILD_VERSION.into())));

        let has = |slot: Slot| get(fx_values, slot.value_name()).is_some();
        let modes_missing = |slot: Slot| slot.modes_name().is_some_and(|n| get(fx_values, n).is_none());
        let pre = RegValue::Sz(PRE_MIX_CLSID.into());
        let post = RegValue::Sz(POST_MIX_CLSID.into());
        let (pre_slot, post_slot, clear) = match mode {
            Mode::LfxGfx => (Slot::Lfx, Slot::Gfx, [Slot::Sfx, Slot::Mfx, Slot::Efx].to_vec()),
            Mode::SfxMfx => (Slot::Sfx, Slot::Mfx, [Slot::Lfx, Slot::Gfx].to_vec()),
            Mode::SfxEfx => (Slot::Sfx, Slot::Efx, [Slot::Lfx, Slot::Gfx].to_vec()),
        };
        if mode != Mode::LfxGfx {
            for slot in clear.iter().filter(|s| has(**s)) {
                ops.push(del(&fx, slot.value_name()));
            }
        }
        ops.push(set(&fx, pre_slot.value_name(), pre));
        if modes_missing(pre_slot) {
            ops.push(set(&fx, pre_slot.modes_name().unwrap_or_default(), RegValue::MultiSz(vec![DEFAULT_MODE.into()])));
        }
        ops.push(set(&fx, post_slot.value_name(), post));
        if modes_missing(post_slot) {
            ops.push(set(&fx, post_slot.modes_name().unwrap_or_default(), RegValue::MultiSz(vec![DEFAULT_MODE.into()])));
        }
        if mode == Mode::LfxGfx {
            for slot in clear.iter().filter(|s| has(**s)) {
                ops.push(del(&fx, slot.value_name()));
            }
        }
        // Equalizer APO force-enables enhancements on every output it installs on.
        if get(fx_values, DISABLE_SYSFX).is_some() {
            ops.push(del(&fx, DISABLE_SYSFX));
        }
    }

    let restart_audio = !ops.is_empty();
    Ok(Plan {
        endpoint: e.guid.clone(),
        endpoint_name: e.name(),
        mode: chosen,
        ops,
        restart_audio,
        pre_mix_child: children.0,
        post_mix_child: children.1,
    })
}

// ---------------------------------------------------------------------------------------------
// Backups and undo

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyBefore {
    pub path: String,
    pub existed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValueBefore {
    pub path: String,
    pub name: String,
    /// Exact type and bytes, or None when the value didn't exist.
    pub before: Option<RegValue>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub format: u32,
    pub created: u64,
    pub endpoint: String,
    pub endpoint_name: String,
    pub engine_installed_by_onboard: bool,
    pub keys: Vec<KeyBefore>,
    pub values: Vec<ValueBefore>,
}

/// Every key and value any setup mode (and the engine check) may touch for `e`, so one backup
/// taken before the first write can put all of it back.
pub fn backup_targets(e: &Endpoint) -> (Vec<String>, Vec<(String, String)>) {
    let fx = fx_key(e);
    let child = child_key(&e.guid);
    let keys = vec![CHILD_APOS_KEY.to_string(), child.clone()];
    let mut values = vec![(AUDIO_KEY.to_string(), PROTECTED_DG.to_string()), (ENGINE_KEY.to_string(), TEST_PIPE_VALUE.to_string())];
    for slot in Slot::ALL {
        values.push((fx.clone(), slot.value_name().to_string()));
    }
    for slot in [Slot::Sfx, Slot::Mfx, Slot::Efx] {
        values.push((fx.clone(), slot.modes_name().unwrap_or_default().to_string()));
    }
    values.push((fx.clone(), DISABLE_SYSFX.to_string()));
    let mut child_names: Vec<String> = Slot::ALL.iter().map(|s| s.value_name().to_string()).collect();
    child_names.extend([PRE_MIX_CHILD, POST_MIX_CHILD, ALLOW_SILENT, DISABLE_AUTO_ADJUST, CHILD_VERSION_VALUE].map(String::from));
    if let Some(c) = &e.child {
        for name in c.keys() {
            if !child_names.iter().any(|n| n.eq_ignore_ascii_case(name)) {
                child_names.push(name.clone());
            }
        }
    }
    values.extend(child_names.into_iter().map(|n| (child.clone(), n)));
    (keys, values)
}

/// The machine-wide "allow unsigned effects" switch stays as it is on undo: the engine's own
/// installer sets it, other outputs may rely on it, and only uninstalling the engine clears it.
fn kept_on_undo(v: &ValueBefore) -> bool {
    v.path.eq_ignore_ascii_case(AUDIO_KEY) && v.name.eq_ignore_ascii_case(PROTECTED_DG)
}

/// Writes that put every backed-up value and key back to how it was (except the switch above).
pub fn undo_ops(b: &Backup) -> Vec<Op> {
    let created: Vec<&str> = b.keys.iter().filter(|k| !k.existed).map(|k| k.path.as_str()).collect();
    let under_created = |path: &str| created.iter().any(|k| k.eq_ignore_ascii_case(path));
    let mut ops: Vec<Op> = b
        .values
        .iter()
        .filter(|v| !under_created(&v.path) && !kept_on_undo(v))
        .map(|v| match &v.before {
            Some(value) => Op::SetValue { path: v.path.clone(), name: v.name.clone(), value: value.clone() },
            None => Op::DeleteValue { path: v.path.clone(), name: v.name.clone() },
        })
        .collect();
    let mut keys: Vec<&str> = created.clone();
    keys.sort_by_key(|k| std::cmp::Reverse(k.matches('\\').count()));
    for k in keys {
        if k.eq_ignore_ascii_case(CHILD_APOS_KEY) {
            ops.push(Op::DeleteKeyIfEmpty { path: k.into() });
        } else {
            ops.push(Op::DeleteKey { path: k.into() });
        }
    }
    ops
}

/// Puts just the output's own values back (its effects and its Child APOs entry), leaving the
/// machine-wide values and the shared Child APOs key alone. Used between load checks, before the
/// next set of positions is tried (Equalizer APO's reinstall).
pub fn revert_endpoint_ops(b: &Backup) -> Vec<Op> {
    let machine_wide = |p: &str| p.eq_ignore_ascii_case(AUDIO_KEY) || p.eq_ignore_ascii_case(ENGINE_KEY);
    undo_ops(b)
        .into_iter()
        .filter(|op| !machine_wide(op.path()) && !matches!(op, Op::DeleteKeyIfEmpty { .. }))
        .collect()
}

/// Only these places may ever be written by SYNQ's elevated helper, whatever a plan or a
/// backup file says.
pub fn op_allowed(op: &Op) -> bool {
    let lower = |s: &str| s.to_ascii_lowercase();
    let path = lower(op.path());
    // Child APOs itself, or Child APOs\{endpoint guid}.
    let child_apos = path == lower(CHILD_APOS_KEY)
        || path.strip_prefix(&format!("{}\\", lower(CHILD_APOS_KEY))).is_some_and(valid_guid);
    // Render\{endpoint guid}\FxProperties.
    let fx_of_endpoint = path
        .strip_prefix(&format!("{}\\", lower(RENDER_KEY)))
        .and_then(|rest| rest.strip_suffix("\\fxproperties"))
        .is_some_and(valid_guid);
    match op {
        Op::RegisterEngine { dll } => lower(dll).ends_with("\\equalizerapo.dll"),
        Op::SetValue { name, .. } | Op::DeleteValue { name, .. } if path == lower(AUDIO_KEY) => name.eq_ignore_ascii_case(PROTECTED_DG),
        Op::SetValue { name, .. } | Op::DeleteValue { name, .. } if path == lower(ENGINE_KEY) => name.eq_ignore_ascii_case(TEST_PIPE_VALUE),
        Op::SetValue { .. } | Op::DeleteValue { .. } => fx_of_endpoint || child_apos,
        Op::CreateKey { .. } | Op::DeleteKey { .. } | Op::DeleteKeyIfEmpty { .. } => child_apos,
    }
}

/// A .reg file with the values as they were before setup, for reading or double-clicking.
pub fn to_reg_file(b: &Backup) -> String {
    let mut out = String::from("Windows Registry Editor Version 5.00\r\n\r\n");
    out.push_str(&format!("; SYNQ backup taken before setting up the EQ engine on {} {}\r\n", b.endpoint_name, b.endpoint));
    out.push_str("; Importing this file puts these values back. SYNQ's own Undo also restarts Windows Audio.\r\n");
    let created: Vec<&str> = b.keys.iter().filter(|k| !k.existed).map(|k| k.path.as_str()).collect();
    let restored: Vec<&ValueBefore> = b.values.iter().filter(|v| !kept_on_undo(v)).collect();
    let mut paths: Vec<&str> = Vec::new();
    for v in &restored {
        if !paths.iter().any(|p| p.eq_ignore_ascii_case(&v.path)) && !created.iter().any(|k| k.eq_ignore_ascii_case(&v.path)) {
            paths.push(&v.path);
        }
    }
    for path in paths {
        out.push_str(&format!("\r\n[HKEY_LOCAL_MACHINE\\{path}]\r\n"));
        for v in restored.iter().filter(|v| v.path.eq_ignore_ascii_case(path)) {
            out.push_str(&format!("{}={}\r\n", reg_quote(&v.name), reg_data(v.before.as_ref())));
        }
    }
    for k in created {
        if !k.eq_ignore_ascii_case(CHILD_APOS_KEY) {
            out.push_str(&format!("\r\n[-HKEY_LOCAL_MACHINE\\{k}]\r\n"));
        }
    }
    out
}

fn reg_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn reg_data(v: Option<&RegValue>) -> String {
    let hex = |kind: Option<u32>, bytes: &[u8]| {
        let body = bytes.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(",");
        match kind {
            None => format!("hex:{body}"),
            Some(k) => format!("hex({k:x}):{body}"),
        }
    };
    match v.map(RegValue::typed) {
        None => "-".into(),
        Some(RegValue::Sz(s)) => reg_quote(&s),
        Some(RegValue::Dword(d)) => format!("dword:{d:08x}"),
        Some(other) => {
            let (kind, bytes) = other.to_raw();
            hex(if kind == 3 { None } else { Some(kind) }, &bytes)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIFINE: &str = "{1f2e3d4c-5b6a-4789-8abc-def012345678}";
    const VG248: &str = "{2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d}";

    fn sz(s: &str) -> RegValue {
        RegValue::Sz(s.into())
    }

    fn map(pairs: &[(&str, RegValue)]) -> BTreeMap<String, RegValue> {
        pairs.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.clone())).collect()
    }

    fn installed() -> Global {
        Global {
            install_path: Some(r"C:\Program Files\EqualizerAPO".into()),
            dll_present: true,
            version: Some("1.4.2".into()),
            registered: true,
            protected_dg: Some(1),
            child_apos_key: true,
        }
    }

    /// The fifine output on this PC, as read from its registry on 2026-10-11.
    fn fifine() -> Endpoint {
        Endpoint {
            guid: FIFINE.into(),
            capture: false,
            device_state: 1,
            props: map(&[(PROP_DESCRIPTION, sz("Speakers")), (PROP_INTERFACE, sz("fifine Microphone"))]),
            fx: Some(map(&[
                ("{b725f130-47ef-101a-a5f1-02608c9eebac},10", sz("Microsoft Audio Home Theater Effects")),
                ("{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},0", sz("{DFF21CE1-F70F-11D0-B917-00A0C9223196}")),
                ("{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},3", sz("{5860E1C5-F95C-4a7a-8EC8-8AEF24F379A1}")),
                (Slot::Sfx.value_name(), sz(PRE_MIX_CLSID)),
                (Slot::Mfx.value_name(), sz("{13AB3EBD-137E-4903-9D89-60BE8277FD17}")),
                (Slot::Efx.value_name(), sz(POST_MIX_CLSID)),
                (Slot::Sfx.modes_name().unwrap(), RegValue::MultiSz(vec![DEFAULT_MODE.into()])),
                (Slot::Mfx.modes_name().unwrap(), RegValue::MultiSz(vec![DEFAULT_MODE.into()])),
                (Slot::Efx.modes_name().unwrap(), RegValue::MultiSz(vec![DEFAULT_MODE.into()])),
                ("{9c119480-ddc2-4954-a150-5bd240d454ad},7", RegValue::Raw { kind: 3, bytes: vec![11, 0, 0, 0, 1, 0, 0, 0, 255, 255, 0, 0] }),
            ])),
            child: Some(map(&[
                (Slot::Lfx.value_name(), sz(NO_VALUE)),
                (Slot::Gfx.value_name(), sz(NO_VALUE)),
                (Slot::Sfx.value_name(), sz("{C9453E73-8C5C-4463-9984-AF8BAB2F5447}")),
                (Slot::Mfx.value_name(), sz("{13AB3EBD-137E-4903-9D89-60BE8277FD17}")),
                (Slot::Efx.value_name(), sz(NO_VALUE)),
                (PRE_MIX_CHILD, sz("{C9453E73-8C5C-4463-9984-AF8BAB2F5447}")),
                (POST_MIX_CHILD, sz("")),
                (ALLOW_SILENT, sz("false")),
                (CHILD_VERSION_VALUE, sz("2")),
            ])),
        }
    }

    /// The VG248 HDMI output on this PC: stock NVIDIA values, engine not on it.
    fn vg248() -> Endpoint {
        Endpoint {
            guid: VG248.into(),
            capture: false,
            device_state: 1,
            props: map(&[(PROP_DESCRIPTION, sz("VG248")), (PROP_INTERFACE, sz("NVIDIA High Definition Audio"))]),
            fx: Some(map(&[
                ("{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},0", sz("{00000000-0000-0000-0000-000000000000}")),
                (Slot::Sfx.value_name(), sz("{C9453E73-8C5C-4463-9984-AF8BAB2F5447}")),
                (Slot::Mfx.value_name(), sz("{13AB3EBD-137E-4903-9D89-60BE8277FD17}")),
                (Slot::Sfx.modes_name().unwrap(), RegValue::MultiSz(vec![DEFAULT_MODE.into()])),
                (Slot::Mfx.modes_name().unwrap(), RegValue::MultiSz(vec![DEFAULT_MODE.into()])),
            ])),
            child: None,
        }
    }

    #[test]
    fn raw_values_round_trip() {
        for v in [sz("{EACD2258-FCAC-4FF4-B36D-419E924A6D79}"), RegValue::MultiSz(vec!["a".into(), "bc".into()]), RegValue::Dword(1), sz("")] {
            let (kind, bytes) = v.to_raw();
            assert_eq!(RegValue::from_raw(kind, &bytes), v);
            assert_eq!(v.raw().typed(), v);
        }
        // REG_SZ without a terminating NUL, as some drivers write it.
        let bytes: Vec<u8> = "ab".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(RegValue::from_raw(REG_SZ, &bytes), sz("ab"));
    }

    #[test]
    fn guids() {
        assert!(valid_guid(FIFINE));
        assert!(!valid_guid("{1f2e3d4c-5b6a-4789-8abc-def01234567}"));
        assert!(!valid_guid(r"{1f2e3d4c-5b6a-4789-8abc-def012345678}\..\x"));
        assert_eq!(endpoint_guid_from_id("{0.0.0.00000000}.{1F2E3D4C-5B6A-4789-8ABC-DEF012345678}").as_deref(), Some(FIFINE));
        assert_eq!(endpoint_guid_from_id("garbage"), None);
        assert!(same_guid("{eacd2258-fcac-4ff4-b36d-419e924a6d79}", PRE_MIX_CLSID));
        assert!(!same_guid("", ""));
    }

    #[test]
    fn names() {
        let f = fifine();
        assert_eq!(f.name(), "Speakers (fifine Microphone)");
        assert_eq!(f.short_name(), "fifine");
        assert_eq!(vg248().short_name(), "VG248");
        assert_eq!(short_name("Speakers", "High Definition Audio Device"), "Speakers");
        assert_eq!(short_name("Speakers", "Realtek(R) Audio"), "Realtek");
        assert_eq!(short_name("Speakers", "Scarlett 2i2 USB"), "Scarlett");
        assert_eq!(short_name("", ""), "");
    }

    #[test]
    fn detects_the_engine_on_this_pcs_fifine_output() {
        let f = fifine();
        assert_eq!(f.engine_slots(), vec![Slot::Sfx, Slot::Efx]);
        let s = status(&installed(), &[f, vg248()], &[], Some(FIFINE));
        assert_eq!(s.state, "active");
        assert_eq!(s.summary, "on · fifine output");
        assert!(s.problems.is_empty());
        let other = s.outputs.iter().find(|o| o.id == VG248).unwrap();
        assert!(!other.engine && other.can_add);
    }

    #[test]
    fn default_mode_is_a_mode_list_entry_not_a_clsid() {
        // The {C18E2F7E...} values on every endpoint are processing-mode lists; their presence
        // alone must not count as the engine.
        // ({d3993a3f-...},5/6/7 are PKEY_{SFX,MFX,EFX}_ProcessingModes_Supported_For_Streaming, not
        // composite FX; composite FX is {d04e05a6-...},13/14/15.)
        assert!(!vg248().has_engine());
        assert!(!is_engine_clsid(DEFAULT_MODE));
        let s = status(&installed(), &[vg248()], &[], Some(VG248));
        assert_eq!(s.state, "notOnOutput");
    }

    #[test]
    fn states() {
        let missing = status(&Global::default(), &[fifine()], &[], Some(FIFINE));
        assert_eq!(missing.state, "missing");

        let elsewhere = status(&installed(), &[fifine(), vg248()], &[], Some(VG248));
        assert_eq!(elsewhere.state, "notOnOutput");
        assert_eq!(elsewhere.summary, "not on VG248");

        let mut off = fifine();
        off.fx.as_mut().unwrap().insert(DISABLE_SYSFX.into(), RegValue::Dword(1));
        let s = status(&installed(), &[off], &[], Some(FIFINE));
        assert_eq!(s.state, "disabled");
        assert_eq!(s.problems[0].code, "enhancementsOff");

        let g = Global { protected_dg: None, ..installed() };
        assert_eq!(status(&g, &[fifine()], &[], Some(FIFINE)).state, "broken");

        assert_eq!(status(&installed(), &[fifine()], &[], None).state, "noOutput");

        let mut gone = fifine();
        gone.device_state = 0x2100_0004;
        let s = status(&installed(), &[gone], &[], Some(FIFINE));
        assert!(s.outputs.is_empty());
    }

    #[test]
    fn composite_lists_are_a_warning() {
        let mut f = fifine();
        f.fx.as_mut().unwrap().insert(Slot::Efx.composite_name().unwrap().into(), RegValue::MultiSz(vec!["{11111111-2222-3333-4444-555555555555}".into()]));
        let s = status(&installed(), &[f], &[], Some(FIFINE));
        assert_eq!(s.state, "active");
        assert_eq!(s.problems[0].code, "compositeOverride");
        assert!(!s.problems[0].blocking);
    }

    #[test]
    fn mode_choice_matches_device_selector() {
        assert_eq!(vg248().choose_mode(), Mode::SfxEfx);
        let mut bt = vg248();
        bt.props.insert(PROP_COMBINED.into(), RegValue::Dword(1));
        assert_eq!(bt.choose_mode(), Mode::SfxMfx);
        let legacy = Endpoint { fx: Some(map(&[(Slot::Lfx.value_name(), sz("{11111111-2222-3333-4444-555555555555}"))])), ..vg248() };
        assert_eq!(legacy.choose_mode(), Mode::LfxGfx);
        let with_composite = Endpoint {
            fx: Some(map(&[
                (Slot::Lfx.value_name(), sz("{11111111-2222-3333-4444-555555555555}")),
                (Slot::Sfx.composite_name().unwrap(), RegValue::MultiSz(vec!["{11111111-2222-3333-4444-555555555555}".into()])),
            ])),
            ..vg248()
        };
        assert_eq!(with_composite.choose_mode(), Mode::SfxEfx);
        assert_eq!(fallback_modes(Mode::SfxMfx), vec![Mode::SfxMfx, Mode::SfxEfx, Mode::LfxGfx]);
    }

    #[test]
    fn child_apos_match_what_device_selector_recorded_for_fifine() {
        // Reconstruct the fifine output before the engine went in, plan it, and compare with the
        // Child APOs values Equalizer APO's own Device Selector wrote on this PC.
        let before = Endpoint {
            fx: Some(map(&[
                (Slot::Sfx.value_name(), sz("{C9453E73-8C5C-4463-9984-AF8BAB2F5447}")),
                (Slot::Mfx.value_name(), sz("{13AB3EBD-137E-4903-9D89-60BE8277FD17}")),
                (Slot::Sfx.modes_name().unwrap(), RegValue::MultiSz(vec![DEFAULT_MODE.into()])),
                (Slot::Mfx.modes_name().unwrap(), RegValue::MultiSz(vec![DEFAULT_MODE.into()])),
            ])),
            child: None,
            ..fifine()
        };
        let plan = plan_setup(&installed(), &before, None).unwrap();
        assert_eq!(plan.mode, Some(Mode::SfxEfx));
        let child = child_key(FIFINE);
        let recorded = fifine().child.unwrap();
        for (name, value) in recorded {
            let written = plan.ops.iter().find_map(|op| match op {
                Op::SetValue { path, name: n, value } if *path == child && n.eq_ignore_ascii_case(&name) => Some(value.clone()),
                _ => None,
            });
            assert_eq!(written, Some(value), "{name}");
        }
        // And FxProperties ends up as it is on this PC now.
        let fx = fx_key(&before);
        assert!(plan.ops.contains(&set(&fx, Slot::Sfx.value_name(), sz(PRE_MIX_CLSID))));
        assert!(plan.ops.contains(&set(&fx, Slot::Efx.value_name(), sz(POST_MIX_CLSID))));
        assert!(plan.ops.contains(&set(&fx, Slot::Efx.modes_name().unwrap(), RegValue::MultiSz(vec![DEFAULT_MODE.into()]))));
        assert!(!plan.ops.iter().any(|op| matches!(op, Op::DeleteValue { .. })));
        assert!(plan.restart_audio);
        assert!(plan.ops.iter().all(op_allowed));
    }

    #[test]
    fn previewing_a_fresh_setup_on_an_output_that_has_it() {
        // Put the fifine output back as Child APOs recorded it, and planning a fresh setup there
        // lands on what is in the registry now.
        let before = without_engine(&fifine());
        assert!(!before.has_engine() && before.child.is_none());
        let plan = plan_setup(&installed(), &before, None).unwrap();
        assert_eq!(plan.mode, Some(Mode::SfxEfx));
        let fx = fx_key(&before);
        assert!(plan.ops.contains(&set(&fx, Slot::Sfx.value_name(), sz(PRE_MIX_CLSID))));
        assert!(plan.ops.contains(&set(&fx, Slot::Efx.value_name(), sz(POST_MIX_CLSID))));
        assert!(plan.ops.contains(&set(&child_key(FIFINE), PRE_MIX_CHILD, sz("{C9453E73-8C5C-4463-9984-AF8BAB2F5447}"))));
    }

    #[test]
    fn active_output_needs_nothing() {
        let plan = plan_setup(&installed(), &fifine(), None).unwrap();
        assert!(plan.ops.is_empty() && !plan.restart_audio);
    }

    #[test]
    fn repairs_only_what_is_broken() {
        let mut f = fifine();
        f.fx.as_mut().unwrap().insert(DISABLE_SYSFX.into(), RegValue::Dword(1));
        f.fx.as_mut().unwrap().insert(Slot::Efx.modes_name().unwrap().into(), RegValue::MultiSz(vec!["{11111111-2222-3333-4444-555555555555}".into()]));
        let g = Global { protected_dg: Some(0), registered: false, ..installed() };
        let plan = plan_setup(&g, &f, None).unwrap();
        assert_eq!(plan.mode, None);
        let fx = fx_key(&f);
        assert_eq!(
            plan.ops,
            vec![
                set(AUDIO_KEY, PROTECTED_DG, RegValue::Dword(1)),
                Op::RegisterEngine { dll: r"C:\Program Files\EqualizerAPO\EqualizerAPO.dll".into() },
                del(&fx, DISABLE_SYSFX),
                set(&fx, Slot::Efx.modes_name().unwrap(), RegValue::MultiSz(vec!["{11111111-2222-3333-4444-555555555555}".into(), DEFAULT_MODE.into()])),
            ]
        );
    }

    #[test]
    fn lfx_gfx_mode_clears_newer_slots() {
        let plan = plan_setup(&installed(), &vg248(), Some(Mode::LfxGfx)).unwrap();
        let fx = fx_key(&vg248());
        assert!(plan.ops.contains(&set(&fx, Slot::Lfx.value_name(), sz(PRE_MIX_CLSID))));
        assert!(plan.ops.contains(&set(&fx, Slot::Gfx.value_name(), sz(POST_MIX_CLSID))));
        assert!(plan.ops.contains(&del(&fx, Slot::Sfx.value_name())));
        assert!(plan.ops.contains(&del(&fx, Slot::Mfx.value_name())));
        // With LFX and GFX empty, the children are the original SFX/MFX effects.
        let child = child_key(VG248);
        assert!(plan.ops.contains(&set(&child, PRE_MIX_CHILD, sz("{C9453E73-8C5C-4463-9984-AF8BAB2F5447}"))));
        assert!(plan.ops.contains(&set(&child, POST_MIX_CHILD, sz("{13AB3EBD-137E-4903-9D89-60BE8277FD17}"))));
    }

    #[test]
    fn refuses_what_device_selector_would_not_do_quietly() {
        let no_fx = Endpoint { fx: None, ..vg248() };
        assert!(plan_setup(&installed(), &no_fx, None).is_err());
        assert!(plan_setup(&Global::default(), &vg248(), None).is_err());
        let mic = Endpoint { capture: true, ..vg248() };
        assert!(plan_setup(&installed(), &mic, None).is_err());
        let mut newer = fifine();
        newer.child.as_mut().unwrap().insert(CHILD_VERSION_VALUE.to_ascii_lowercase(), sz("3"));
        newer.fx.as_mut().unwrap().insert(DISABLE_SYSFX.into(), RegValue::Dword(1));
        assert!(plan_setup(&installed(), &newer, None).is_err());
    }

    fn sample_backup() -> Backup {
        let fx = fx_key(&vg248());
        Backup {
            format: 1,
            created: 1,
            endpoint: VG248.into(),
            endpoint_name: "VG248 (NVIDIA High Definition Audio)".into(),
            engine_installed_by_onboard: false,
            keys: vec![KeyBefore { path: CHILD_APOS_KEY.into(), existed: true }, KeyBefore { path: child_key(VG248), existed: false }],
            values: vec![
                ValueBefore { path: AUDIO_KEY.into(), name: PROTECTED_DG.into(), before: Some(RegValue::Dword(1).raw()) },
                ValueBefore { path: fx.clone(), name: Slot::Sfx.value_name().into(), before: Some(sz("{C9453E73-8C5C-4463-9984-AF8BAB2F5447}").raw()) },
                ValueBefore { path: fx.clone(), name: Slot::Efx.value_name().into(), before: None },
                ValueBefore { path: child_key(VG248), name: PRE_MIX_CHILD.into(), before: None },
            ],
        }
    }

    #[test]
    fn undo_restores_values_and_drops_created_keys() {
        let b = sample_backup();
        let ops = undo_ops(&b);
        let fx = fx_key(&vg248());
        // DisableProtectedAudioDG is recorded but not reverted.
        assert_eq!(
            ops,
            vec![
                Op::SetValue { path: fx.clone(), name: Slot::Sfx.value_name().into(), value: sz("{C9453E73-8C5C-4463-9984-AF8BAB2F5447}").raw() },
                Op::DeleteValue { path: fx, name: Slot::Efx.value_name().into() },
                Op::DeleteKey { path: child_key(VG248) },
            ]
        );
        assert!(ops.iter().all(op_allowed));
        let json = serde_json::to_string(&b).unwrap();
        assert_eq!(serde_json::from_str::<Backup>(&json).unwrap(), b);
    }

    #[test]
    fn retry_revert_touches_only_the_output() {
        let mut b = sample_backup();
        b.values.push(ValueBefore { path: ENGINE_KEY.into(), name: TEST_PIPE_VALUE.into(), before: None });
        b.keys[0].existed = false;
        let ops = revert_endpoint_ops(&b);
        assert!(ops.iter().all(|op| !op.path().eq_ignore_ascii_case(AUDIO_KEY) && !op.path().eq_ignore_ascii_case(ENGINE_KEY)));
        assert!(!ops.iter().any(|op| matches!(op, Op::DeleteKeyIfEmpty { .. })));
        assert_eq!(ops.last(), Some(&Op::DeleteKey { path: child_key(VG248) }));
    }

    #[test]
    fn titles_name_the_device_not_the_driver() {
        assert_eq!(title("Speakers", "fifine Microphone"), "fifine Microphone");
        assert_eq!(title("VG248", "NVIDIA High Definition Audio"), "VG248");
        assert_eq!(title("Headphones", "Realtek(R) Audio"), "Headphones");
        assert_eq!(title("Speakers", "High Definition Audio Device"), "Speakers");
        assert_eq!(title("Headphones", "2- Arctis 7 Game"), "Arctis 7 Game");
        assert_eq!(title("", ""), "Unnamed output");
        assert_eq!(fifine().title(), "fifine Microphone");
    }

    #[test]
    fn mode_lists() {
        // Missing entirely: a warning (Equalizer APO only writes it when absent), fixed on repair.
        let mut f = fifine();
        f.fx.as_mut().unwrap().remove(&Slot::Efx.modes_name().unwrap().to_ascii_lowercase());
        let s = status(&installed(), &[f.clone()], &[], Some(FIFINE));
        assert_eq!(s.state, "active");
        assert_eq!(s.problems[0].code, "modeListMissing");
        let plan = plan_setup(&installed(), &f, None).unwrap();
        assert_eq!(plan.ops, vec![set(&fx_key(&f), Slot::Efx.modes_name().unwrap(), RegValue::MultiSz(vec![DEFAULT_MODE.into()]))]);
        // A list without the default mode: Windows skips the engine for normal playback.
        let mut g = fifine();
        g.fx.as_mut().unwrap().insert(Slot::Sfx.modes_name().unwrap().into(), RegValue::MultiSz(vec!["{11111111-2222-3333-4444-555555555555}".into()]));
        assert_eq!(status(&installed(), &[g], &[], Some(FIFINE)).state, "broken");
    }

    #[test]
    fn fresh_plan_names_the_children_to_wait_for() {
        let plan = plan_setup(&installed(), &vg248(), None).unwrap();
        assert_eq!(plan.pre_mix_child.as_deref(), Some("{C9453E73-8C5C-4463-9984-AF8BAB2F5447}"));
        assert_eq!(plan.post_mix_child.as_deref(), Some(""));
        assert_eq!(plan.wants_children(), (true, false));
        assert_eq!(plan_setup(&installed(), &fifine(), None).unwrap().wants_children(), (false, false));
    }

    #[test]
    fn undo_keeps_a_shared_child_apos_key_unless_empty() {
        let mut b = sample_backup();
        b.keys[0].existed = false;
        let ops = undo_ops(&b);
        assert_eq!(ops[ops.len() - 2], Op::DeleteKey { path: child_key(VG248) });
        assert_eq!(ops[ops.len() - 1], Op::DeleteKeyIfEmpty { path: CHILD_APOS_KEY.into() });
    }

    #[test]
    fn only_engine_places_are_writable() {
        let fx = fx_key(&vg248());
        assert!(op_allowed(&set(&fx, "anything", RegValue::Dword(0))));
        assert!(op_allowed(&set(AUDIO_KEY, PROTECTED_DG, RegValue::Dword(1))));
        assert!(!op_allowed(&set(AUDIO_KEY, "Other", RegValue::Dword(1))));
        assert!(!op_allowed(&set(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", "x", sz("evil.exe"))));
        assert!(!op_allowed(&set(&format!(r"{RENDER_KEY}\{VG248}\Properties"), "x", sz("y"))));
        assert!(!op_allowed(&set(&format!(r"{RENDER_KEY}\..\..\Run\FxProperties"), "x", sz("y"))));
        assert!(!op_allowed(&Op::DeleteKey { path: RENDER_KEY.into() }));
        assert!(!op_allowed(&Op::RegisterEngine { dll: r"C:\evil.dll".into() }));
        assert!(op_allowed(&Op::DeleteKey { path: child_key(VG248) }));
        assert!(!op_allowed(&Op::DeleteKey { path: format!(r"{CHILD_APOS_KEY}\..\..") }));
        assert!(!op_allowed(&Op::DeleteKey { path: ENGINE_KEY.into() }));
    }

    #[test]
    fn reg_file() {
        let text = to_reg_file(&sample_backup());
        assert!(text.starts_with("Windows Registry Editor Version 5.00\r\n"));
        assert!(!text.contains("DisableProtectedAudioDG"));
        assert_eq!(reg_data(Some(&RegValue::Dword(1))), "dword:00000001");
        assert!(text.contains("\"{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},5\"=\"{C9453E73-8C5C-4463-9984-AF8BAB2F5447}\""));
        assert!(text.contains("\"{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},7\"=-"));
        assert!(text.contains(&format!("[-HKEY_LOCAL_MACHINE\\{}]", child_key(VG248))));
        assert!(!text.contains("PreMixChild"));
        assert_eq!(reg_data(Some(&RegValue::MultiSz(vec!["a".into()]))), "hex(7):61,00,00,00,00,00");
    }
}
