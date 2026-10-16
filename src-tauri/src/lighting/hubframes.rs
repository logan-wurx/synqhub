//! One static colour on a USB RGB hub's channel, built by the bridge for screen sync (wave L5): the page's builder
//! (src/lib/lighting/hidrgb/protocol.ts `colourFrames`) runs in the page, and sync runs with the page in the background.
//! The same bytes, held to the page's by the hub fixture (rgb-frames.txt), and every report still goes through
//! hidrgb.rs's guard on its way out.

use super::hidrgb::{max_leds, Model};

/// A report: its id and the bytes after it.
pub struct Frame {
    pub report_id: u8,
    pub data: Vec<u8>,
}

fn frame(report_id: u8, len: usize, bytes: &[u8]) -> Frame {
    let mut data = vec![0u8; len];
    data[..bytes.len().min(len)].copy_from_slice(&bytes[..bytes.len().min(len)]);
    Frame { report_id, data }
}

/// The reports that light one channel in one colour, or None when the channel or LED count is out of range.
pub fn colour_frames(m: &Model, channel: u8, [r, g, b]: [u8; 3], leds: u16) -> Option<Vec<Frame>> {
    if channel >= m.channels || leds < 1 || leds > max_leds(m) {
        return None;
    }
    match m.family.as_str() {
        "nzxt-hue2" => {
            let mut out = Vec::new();
            let mut group = 0u16;
            while group * 20 < leds {
                let n = usize::from((leds - group * 20).min(20));
                let mut bytes = vec![0x10 | group as u8, 1 << channel, 0];
                bytes.extend((0..n).flat_map(|_| [g, r, b]));
                out.push(frame(0x22, 63, &bytes));
                group += 1;
            }
            out.push(frame(0x22, 63, &[0xa0, 1 << channel, 0x00, 0x01, 0, 0, 0x28, 0, 0, 0x80, 0, 0x32, 0, 0, 0x01]));
            Some(out)
        }
        "corsair-node" => Some(vec![
            frame(0, 64, &[0x37, channel]),
            frame(0, 64, &[0x34, channel]),
            frame(0, 64, &[0x38, channel, 0x01]),
            frame(0, 64, &[0x35, channel, 0, leds as u8, 0x04, 0, 0, 0, 0, r, g, b]),
            frame(0, 64, &[0x33, 0xff]),
        ]),
        "lianli-sl" => {
            if leds % 16 != 0 {
                return None;
            }
            let mut colour = vec![0u8; 1 + 64 * 3];
            colour[0] = 0x30 + channel;
            for i in 0..usize::from(leds) {
                colour[1 + i * 3..4 + i * 3].copy_from_slice(&[r, b, g]);
            }
            Some(vec![
                frame(0xe0, 10, &[0x10, 0x32, 0x10 * channel + (leds / 16) as u8]),
                Frame { report_id: 0xe0, data: colour },
                frame(0xe0, 10, &[0x10 + channel, 0x01, 0x02, 0, 0x00]),
            ])
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lighting::hidrgb::model;

    /// Every colour report the page builds for the fixture (src/lib/lighting/hidrgb/rgb-frames.txt) is built the same
    /// way here, byte for byte.
    #[test]
    fn the_same_bytes_as_the_page() {
        let allowed: std::collections::HashSet<String> = include_str!("../../../src/lib/lighting/hidrgb/rgb-frames.txt")
            .lines()
            .filter(|l| l.starts_with("1 "))
            .map(|l| l.split(' ').take(4).collect::<Vec<_>>().join(" "))
            .collect();
        let hex = |d: &[u8]| d.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let mut checked = 0;
        for (vid, pid) in [(0x1e71, 0x2001), (0x1e71, 0x2019), (0x1b1c, 0x0c0b), (0x1b1c, 0x0c1a), (0x0cf2, 0xa100)] {
            let m = model(vid, pid).expect("a hub in hubs.json");
            let counts: Vec<u16> = match m.family.as_str() {
                "lianli-sl" => vec![16, 32, 64],
                "nzxt-hue2" => vec![1, 20, 21, max_leds(m)],
                _ => vec![1, 96, max_leds(m)],
            };
            for ch in 0..m.channels {
                for c in [[255, 0, 0], [12, 200, 77]] {
                    for &n in &counts {
                        for f in colour_frames(m, ch, c, n).expect("in range") {
                            let line = format!("1 {}:{} {:02x} {}", m.vid, m.pid, f.report_id, hex(&f.data));
                            assert!(allowed.contains(&line), "{line}");
                            checked += 1;
                        }
                    }
                }
            }
            assert!(colour_frames(m, m.channels, [1, 2, 3], 1).is_none(), "no channel past the last");
        }
        assert!(checked > 100);
    }
}
