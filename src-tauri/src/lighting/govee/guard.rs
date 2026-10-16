//! The frames SYNQ may send a Govee light, by model, mirrored from src/lib/lighting/govee/frames.ts
//! (`checkLightFrame`, `checkLightUpload`, `a3Frames`). Both judge every line of frames.txt (scripts/govee-fixtures.ts)
//! the same way (test `light_guard_matches_the_frontend`). Single frames are power, brightness, colour / white in the
//! colour dialects the model takes (and segment colour and brightness where it has segments), gradual change,
//! the model's catalogue scenes, its own music modes, DIY slots and a few queries; uploads are the model's catalogue
//! data for the scene being switched on, byte for byte, or a DIY effect in the shape the references decode. Everything
//! else is refused: firmware / OTA, reset, network provisioning, renaming, `aa b1`, loose multi-packet frames, the
//! handshake, video and DreamView.

use super::catalogue::{Model, BLOB_AT, KELVIN_RGB, MODELS, NONE, SCENES, SCENE_DATA};

pub const FRAME_LEN: usize = 20;
/// DIY styles: (family, variants), src/lib/lighting/govee/diy.ts `DIY_STYLES`.
const DIY_STYLES: [(u8, &[u8]); 8] = [(0, &[0, 1, 2]), (1, &[0, 2]), (2, &[0, 1, 2]), (3, &[3, 4, 5]), (4, &[8, 6, 7]), (8, &[9, 10]), (9, &[9, 10]), (10, &[0])];
const DIY_CODES: [u16; 2] = [24, 254];
const KELVIN_STEP: u16 = 100;

pub const TYPED: u8 = 0x15;
const IC: u8 = 0x0b;
const CCT: u8 = 0x0d;
const RGB: u8 = 0x02;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UploadKind {
    Scene,
    Diy,
}

impl UploadKind {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "scene" => Some(Self::Scene),
            "diy" => Some(Self::Diy),
            _ => None,
        }
    }
    pub fn type_byte(self) -> u8 {
        match self {
            Self::Scene => 0x02,
            Self::Diy => 0x04,
        }
    }
}

pub fn xor(b: &[u8]) -> u8 {
    b.iter().fold(0, |a, &x| a ^ x)
}

/// A 20-byte frame: the bytes, zero padding, the checksum.
pub fn frame(bytes: &[u8]) -> [u8; FRAME_LEN] {
    let mut f = [0u8; FRAME_LEN];
    f[..bytes.len()].copy_from_slice(bytes);
    f[FRAME_LEN - 1] = xor(&f[..FRAME_LEN - 1]);
    f
}

type Verdict = Result<&'static str, String>;

fn no(why: &str) -> Verdict {
    Err(format!("Govee: {why}."))
}

fn diy_pair_allowed(family: u8, variant: u8) -> bool {
    DIY_STYLES.iter().any(|&(f, v)| f == family && v.contains(&variant))
}

/// The model SYNQ drives under this SKU.
pub fn model(sku: &str) -> Option<&'static Model> {
    MODELS.iter().find(|m| m.sku == sku)
}

/// Segments a mask may name in a dialect: the model's count, or the dialect's most (16 for 0x15, 15 for 0x0b).
pub fn limit_of(m: &Model, dialect: u8) -> u32 {
    if m.segments > 0 {
        u32::from(m.segments)
    } else if dialect == TYPED {
        16
    } else if dialect == IC {
        15
    } else {
        0
    }
}

/// The model's scene data by code: None when the code isn't in its catalogue, Some(None) for a built-in scene.
pub fn scene_data(sku: &str, code: u16) -> Option<Option<&'static [u8]>> {
    let at = SCENES.binary_search_by(|&(s, c, _)| s.cmp(sku).then(c.cmp(&code))).ok()?;
    let blob = SCENES[at].2;
    Some((blob != NONE).then(|| {
        let (offset, len) = BLOB_AT[usize::from(blob)];
        &SCENE_DATA[offset as usize..offset as usize + usize::from(len)]
    }))
}

fn white_ok(m: &Model, k: u16, rendering: &[u8]) -> bool {
    let Some((lo, hi)) = m.kelvin else { return false };
    (lo..=hi).contains(&k) && k % KELVIN_STEP == 0 && KELVIN_RGB.iter().any(|&(kk, rgb)| kk == k && rgb == rendering)
}

/// Whether a single frame may go to a light of this model (uploads go through `check_upload`; the bridge frames them).
pub fn check_frame(m: &Model, f: &[u8]) -> Verdict {
    if f.len() != FRAME_LEN {
        return no("frames are 20 bytes");
    }
    if xor(&f[..FRAME_LEN - 1]) != f[FRAME_LEN - 1] {
        return no("bad checksum");
    }
    let zero_from = |i: usize| f[i..FRAME_LEN - 1].iter().all(|&b| b == 0);
    let mask = |at: usize| u32::from(u16::from_le_bytes([f[at], f[at + 1]]));
    let mask_ok = |v: u32, dialect: u8| v != 0 && v & !((1u32 << limit_of(m, dialect)) - 1) == 0;
    let typed = m.dialects.contains(&TYPED);
    let pages = limit_of(m, TYPED).div_ceil(4) as u8;
    let (head, cmd) = (f[0], f[1]);
    if head == 0xaa {
        return match cmd {
            0x01 | 0x04 | 0x06 | 0x40 if zero_from(2) => Ok("query"),
            0x05 if f[2] <= 1 && zero_from(3) => Ok("mode query"),
            0xa5 if typed && (1..=pages).contains(&f[2]) && zero_from(3) => Ok("segment colour query"),
            0xb1 => no("query 0xb1 isn't asked (it carries the device's key)"),
            _ => no(&format!("query {cmd:#04x} isn't asked")),
        };
    }
    if head != 0x33 {
        return no(match head {
            0xa3 => "multi-packet frames are built by the bridge from a checked upload, never sent loose",
            0xe7 => "the handshake is the bridge's own",
            0xee => "0xEE is OTA preparation in this direction",
            _ => "that header is never sent",
        });
    }
    match cmd {
        0x01 => return if f[2] <= 1 && zero_from(3) { Ok("power") } else { no("power is 0 or 1") },
        0x04 => return if (1..=m.brightness_max).contains(&f[2]) && zero_from(3) { Ok("brightness") } else { no("brightness is on the light's own scale") },
        0xa3 => return if typed && f[2] <= 1 && zero_from(3) { Ok("gradual change") } else { no("gradual change is 0 or 1, on a 0x15 light") },
        0x05 => {}
        _ => return no("that command is never sent (firmware, reset, network and name commands are refused)"),
    }
    let sub = f[2];
    if [TYPED, IC, CCT, RGB].contains(&sub) {
        if !m.dialects.contains(&sub) {
            return no("the light doesn't take that colour dialect");
        }
        return match sub {
            RGB => if zero_from(6) { Ok("colour") } else { no("a plain colour is three bytes") },
            IC => if mask_ok(mask(6), IC) && zero_from(8) { Ok("colour") } else { no("a colour for a set of the light's segments") },
            CCT => {
                let k = u16::from_be_bytes([f[6], f[7]]);
                if !zero_from(11) {
                    no("colour and temperature are 8 bytes")
                } else if k == 0 {
                    if f[8..11].iter().all(|&b| b == 0) { Ok("colour") } else { no("a colour carries no temperature rendering") }
                } else if f[3..6].iter().all(|&b| b == 0) && white_ok(m, k, &f[8..11]) {
                    Ok("white")
                } else {
                    no("white in the light's range, with its own RGB rendering")
                }
            }
            _ => match f[3] {
                0x01 => {
                    if !mask_ok(mask(12), TYPED) || !zero_from(14) {
                        return no("a colour for a set of the light's segments");
                    }
                    let k = u16::from_be_bytes([f[7], f[8]]);
                    if k == 0 {
                        return if f[9..12].iter().all(|&b| b == 0) { Ok("colour") } else { no("a colour carries no temperature rendering") };
                    }
                    if f[4..7].iter().all(|&b| b == 0) && white_ok(m, k, &f[9..12]) {
                        Ok("white")
                    } else {
                        no("white is the light's range in steps of 100 K, with its own RGB rendering")
                    }
                }
                0x02 => {
                    if f[4] <= 100 && mask_ok(mask(5), TYPED) && zero_from(7) {
                        Ok("segment brightness")
                    } else {
                        no("segment brightness is 0-100 on the light's segments")
                    }
                }
                0x04 => {
                    let page = f[4];
                    if !(1..=pages).contains(&page) || !zero_from(17) {
                        return no("segment pages");
                    }
                    let used = (limit_of(m, TYPED) as usize - (usize::from(page) - 1) * 4).min(4);
                    if f[5 + used * 3..17].iter().all(|&b| b == 0) {
                        Ok("segment page")
                    } else {
                        no("a page past the last segment carries no colour")
                    }
                }
                t => no(&format!("colour type {t} isn't sent")),
            },
        };
    }
    match sub {
        0x04 => {
            let code = u16::from_le_bytes([f[3], f[4]]);
            if scene_data(m.sku, code).is_some() && zero_from(5) {
                Ok("scene")
            } else {
                no(&format!("scene {code} isn't in the {}'s catalogue", m.sku))
            }
        }
        0x13 => {
            let (mode, sens, style, count) = (f[3], f[4], f[5], f[6]);
            if !m.music.contains(&mode) || sens > 99 || style > 1 || count > 1 {
                return no("a music mode of the light's own, sensitivity 0-99");
            }
            if zero_from(if count == 1 { 10 } else { 7 }) {
                Ok("music")
            } else {
                no("music carries one colour at most")
            }
        }
        0x0a => {
            let code = u16::from_le_bytes([f[3], f[4]]);
            if m.diy && DIY_CODES.contains(&code) && zero_from(5) {
                Ok("DIY")
            } else {
                no(&format!("DIY slot {code} isn't used on the {}", m.sku))
            }
        }
        sub => no(&format!("mode {sub:#04x} isn't sent (video, DreamView and the rest stay off)")),
    }
}

/// Whether an upload body may go to a light of this model: the catalogue's own data for the scene `code`, byte for
/// byte, or a DIY effect in the shape the references decode.
pub fn check_upload(m: &Model, kind: UploadKind, body: &[u8], code: Option<u16>) -> Verdict {
    if kind == UploadKind::Scene {
        return match code.and_then(|c| scene_data(m.sku, c)).flatten() {
            Some(want) if want == body => Ok("scene data"),
            _ => no("scene data must be the catalogue's own for that scene, byte for byte"),
        };
    }
    if !m.diy {
        return no("the light isn't sent DIY effects");
    }
    // [family][variant][speed][3 * colours][colours…] and, for a combo (family 0xFF), [2 * pairs][(family, variant)…].
    if body.len() < 4 {
        return no("a DIY effect: speed 0-100, 1-8 colours");
    }
    let (family, variant, speed, len) = (body[0], body[1], body[2], usize::from(body[3]));
    if speed > 100 || len % 3 != 0 || !(3..=24).contains(&len) || body.len() < 4 + len {
        return no("a DIY effect: speed 0-100, 1-8 colours");
    }
    if family != 0xff {
        return if diy_pair_allowed(family, variant) && body.len() == 4 + len { Ok("DIY effect") } else { no("a DIY style the light has") };
    }
    let n = body.get(4 + len).copied().map(usize::from).unwrap_or(0);
    if variant != 0 || n % 2 != 0 || !(2..=8).contains(&n) || body.len() != 5 + len + n {
        return no("a combo of 1-4 DIY styles");
    }
    if body[5 + len..].chunks(2).all(|p| diy_pair_allowed(p[0], p[1])) {
        Ok("DIY combo")
    } else {
        no("a combo of DIY styles the light has")
    }
}

/// The A3 frames of one upload: [A3][index][17 bytes]; payload `01 <frame count> <type> <body…>`; last index FF.
pub fn a3_frames(kind: UploadKind, body: &[u8]) -> Vec<[u8; FRAME_LEN]> {
    let mut data = vec![kind.type_byte()];
    data.extend_from_slice(body);
    let chunks = (data.len() + 2).div_ceil(17);
    let terminator = chunks == 1;
    let mut payload = vec![0x01, (chunks + usize::from(terminator)) as u8];
    payload.extend_from_slice(&data);
    let mut out = Vec::new();
    for (i, chunk) in payload.chunks(17).enumerate() {
        let index = if terminator || i != chunks - 1 { i as u8 } else { 0xff };
        let mut bytes = vec![0xa3, index];
        bytes.extend_from_slice(chunk);
        out.push(frame(&bytes));
    }
    if terminator {
        out.push(frame(&[0xa3, 0xff]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(hex: &str) -> Vec<u8> {
        (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
    }

    /// The same verdicts as src/lib/lighting/govee/frames.ts on every line of the fixture, and the same A3 framing.
    /// Lines: `frame <sku> <1|0> <hex>`, `scene <sku> <code> <1|0> <body> [frames…]`, `diy <sku> <1|0> <body> [frames…]`.
    #[test]
    fn light_guard_matches_the_frontend() {
        let (mut checked, mut allowed) = (0, 0);
        for line in include_str!("frames.txt").lines().filter(|l| !l.is_empty()) {
            let parts: Vec<&str> = line.split(' ').collect();
            let m = model(parts[1]).unwrap_or_else(|| panic!("unknown model in {line}"));
            let (verdict, got) = match parts[0] {
                "frame" => (parts[2] == "1", check_frame(m, &bytes(parts[3])).is_ok()),
                "scene" | "diy" => {
                    let kind = UploadKind::parse(parts[0]).unwrap();
                    let (code, rest) = if kind == UploadKind::Scene { (Some(parts[2].parse::<u16>().unwrap()), &parts[3..]) } else { (None, &parts[2..]) };
                    let body = bytes(rest[1]);
                    let ok = check_upload(m, kind, &body, code).is_ok();
                    if ok {
                        // The frames the bridge builds are the ones the app builds (the fixture lists them).
                        let want: Vec<String> = rest[2..].iter().map(|s| s.to_string()).collect();
                        let made: Vec<String> = a3_frames(kind, &body).iter().map(|f| f.iter().map(|b| format!("{b:02x}")).collect()).collect();
                        assert_eq!(made, want, "{line}");
                    }
                    (rest[0] == "1", ok)
                }
                other => panic!("unknown line kind {other}"),
            };
            assert_eq!(got, verdict, "{line}");
            checked += 1;
            allowed += usize::from(verdict);
        }
        assert!(checked > 3000 && allowed > 400, "{checked} lines, {allowed} allowed");
    }

    #[test]
    fn the_proven_frames_pass_and_the_dangerous_ones_dont() {
        let h6076 = model("H6076").unwrap();
        // Proven live on the developer's lamps: power, brightness, the queries.
        for ok in [frame(&[0x33, 0x01, 0x00]), frame(&[0x33, 0x01, 0x01]), frame(&[0x33, 0x04, 0x23]), frame(&[0xaa, 0x01]), frame(&[0xaa, 0x04]), frame(&[0xaa, 0x05]), frame(&[0xaa, 0x06])] {
            assert!(check_frame(h6076, &ok).is_ok(), "{ok:02x?}");
        }
        // The capture's blue on all 14 segments.
        assert!(check_frame(h6076, &frame(&bytes("3305150100 00ff0000000000ff3f".replace(' ', "").as_str()))).is_ok());
        // The H6076 takes only its own dialect; an unverified model takes the four documented ones.
        assert!(check_frame(h6076, &frame(&[0x33, 0x05, 0x02, 0xff, 0, 0])).is_err());
        assert!(check_frame(model("H6046").unwrap(), &frame(&[0x33, 0x05, 0x02, 0xff, 0, 0])).is_ok());
        // Never: the handshake, OTA preparation, loose upload frames, the key query, firmware / reset / name / Wi-Fi commands.
        for m in [h6076, model("H6046").unwrap(), model("H7020").unwrap()] {
            for bad in [frame(&[0xe7, 0x01]), frame(&[0xee, 0x30]), frame(&[0xa3, 0x00, 0x01]), frame(&[0xaa, 0xb1]), frame(&[0x33, 0xb1]), frame(&[0x33, 0x0f]), frame(&[0x33, 0x0a]), frame(&[0x33, 0x05, 0x00])] {
                assert!(check_frame(m, &bad).is_err(), "{} {bad:02x?}", m.sku);
            }
        }
        let mut broken = frame(&[0x33, 0x01, 0x01]);
        broken[19] ^= 1;
        assert!(check_frame(h6076, &broken).is_err());
        // A scene's data goes only with its own code, on its own model.
        let (code, data) = SCENES.iter().find(|s| s.0 == "H6076" && s.2 != NONE).map(|s| (s.1, scene_data("H6076", s.1).unwrap().unwrap())).unwrap();
        assert!(check_upload(h6076, UploadKind::Scene, data, Some(code)).is_ok());
        assert!(check_upload(h6076, UploadKind::Scene, data, Some(code + 1)).is_err());
        assert!(check_upload(model("H7020").unwrap(), UploadKind::Scene, data, Some(code)).is_err());
    }
}
