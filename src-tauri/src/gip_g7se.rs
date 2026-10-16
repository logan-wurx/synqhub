//! The GameSir G7 SE's settings channel over GIP (research item 6, wave C4 spike): the exact message bodies the spike
//! (`gip_spike.rs`, cargo feature `gip-spike`, never built by default) may send, the guard that refuses everything
//! else, and the reply parser. Pure functions; nothing here touches a device.
//!
//! Facts (docs/devices/G7SE-GIP.md): the pad's GIP identification declares message 0x0F (host -> pad, 60 bytes) and
//! 0x10 (pad -> host, 60 bytes); GameSir Nexus sends its settings as message 0x0F with the GameSir register protocol in
//! the body (the family's `03` write / `04` read / `09` firmware / `0B` active profile / `F2` heartbeat), and the pad
//! answers on 0x10 (`05` read reply, `06` ack, `0A` firmware, `0C` active profile). Verified on firmware descriptor
//! 6.30 by gamesir-linux-tools (MIT) from Nexus captures and Linux round trips. On Windows the system builds the GIP
//! header (options, sequence, length); SYNQ passes the body to `GipGameControllerProvider::SendMessage` with class
//! `Command` (what Nexus's own GIP component passes) and message id 0x0F.
#![cfg_attr(not(all(windows, feature = "gip-spike")), allow(dead_code))]

/// GIP message ids of the settings channel.
pub const MSG_REQUEST: u8 = 0x0f;
pub const MSG_REPLY: u8 = 0x10;
/// The pad and the only firmware descriptor the source verified (bcdDevice 6.30).
pub const VID: u16 = 0x3537;
pub const PID: u16 = 0x1010;
pub const TESTED_FIRMWARE: (u16, u16) = (6, 30);
/// The developer's pad (2026-10-16): USB bcdDevice 6.25 (REV_0625), which Windows' GIP layer reports as firmware
/// 1.2.1573.2. Older than the verified 6.30, so READS ONLY on it: the register map may differ, and GameSir's own
/// notes put 1000 Hz at 6.30 or later.
pub const READ_ONLY_GIP_FIRMWARE: (u16, u16, u16, u16) = (1, 2, 1573, 2);
/// Readable profile bytes; banks 1-3 are the editable profiles, bank 4 holds only a report-rate byte SYNQ writes.
pub const PROFILE_SIZE: u16 = 421;
pub const READ_MAX: u8 = 55;
pub const WRITE_LEN: usize = 60;
/// The report rate (one byte, codes 0 / 1 / 2 = 250 / 500 / 1000 Hz), written to every bank 1-4 as Nexus does.
pub const RATE_ADDR: u16 = 0x0036;
pub const RATE_HZ: [u16; 3] = [250, 500, 1000];
/// The rear buttons' 8-byte records.
pub const L4_ADDR: u16 = 0x00ab;
pub const R4_ADDR: u16 = 0x00c7;
/// Remap targets: d-pad 1-4, LB 5, RB 6, LS 7, RS 8, A 15, B 16, X 17, Y 18, View 22, Menu 23.
pub const TARGETS: [u8; 14] = [1, 2, 3, 4, 5, 6, 7, 8, 15, 16, 17, 18, 22, 23];

pub fn heartbeat() -> Vec<u8> {
    vec![0xf2, 0x00]
}
pub fn firmware_query() -> Vec<u8> {
    vec![0x09]
}
pub fn active_profile_query() -> Vec<u8> {
    vec![0x0b]
}

/// A read of `len` bytes at `addr` of `bank` (1-4), or None when it isn't one SYNQ sends.
pub fn read(bank: u8, addr: u16, len: u8) -> Option<Vec<u8>> {
    let ok = (1..=4).contains(&bank) && (1..=READ_MAX).contains(&len) && u32::from(addr) + u32::from(len) <= u32::from(PROFILE_SIZE);
    ok.then(|| vec![0x04, bank, (addr >> 8) as u8, addr as u8, len])
}

fn write(bank: u8, addr: u16, data: &[u8]) -> Vec<u8> {
    let mut b = vec![0u8; WRITE_LEN];
    b[..5].copy_from_slice(&[0x03, bank, (addr >> 8) as u8, addr as u8, data.len() as u8]);
    b[5..5 + data.len()].copy_from_slice(data);
    b
}

/// The report-rate write for one bank (1-4), code 0-2.
pub fn rate_write(bank: u8, code: u8) -> Option<Vec<u8>> {
    ((1..=4).contains(&bank) && usize::from(code) < RATE_HZ.len()).then(|| write(bank, RATE_ADDR, &[code]))
}

/// A rear-button record: a gamepad target, or the default (eight zero bytes). (The spike reads the records only.)
#[cfg_attr(not(test), allow(dead_code))]
pub fn remap_record(target: Option<u8>) -> Option<[u8; 8]> {
    match target {
        None => Some([0; 8]),
        Some(t) if TARGETS.contains(&t) => Some([0x04, 0, 0, 0, 0, 0, 0x01, t]),
        Some(_) => None,
    }
}

/// The whole-record write of L4 or R4 in an editable profile (1-3).
pub fn remap_write(bank: u8, addr: u16, record: [u8; 8]) -> Option<Vec<u8>> {
    let known = record == [0; 8] || (record[..7] == [0x04, 0, 0, 0, 0, 0, 0x01] && TARGETS.contains(&record[7]));
    ((1..=3).contains(&bank) && (addr == L4_ADDR || addr == R4_ADDR) && known).then(|| write(bank, addr, &record))
}

/// The guard: whether this message may go to the G7 SE. Only message 0x0F with one of the bodies above.
pub fn check(message_id: u8, body: &[u8]) -> Result<&'static str, String> {
    if message_id != MSG_REQUEST {
        return Err(format!("G7 SE: GIP message {message_id:#04x} is never sent (power, authentication, firmware and every system message stay the system's)."));
    }
    match body {
        [0xf2, 0x00] => Ok("heartbeat"),
        [0x09] => Ok("firmware query"),
        [0x0b] => Ok("active-profile query"),
        [0x04, bank, hi, lo, len] if read(*bank, u16::from_be_bytes([*hi, *lo]), *len).is_some() => Ok("read"),
        b if b.len() == WRITE_LEN && b[0] == 0x03 => {
            let (bank, addr, n) = (b[1], u16::from_be_bytes([b[2], b[3]]), usize::from(b[4]));
            let data = &b[5..5 + n.min(WRITE_LEN - 5)];
            let want = if addr == RATE_ADDR && n == 1 {
                rate_write(bank, data[0])
            } else if n == 8 {
                let mut r = [0u8; 8];
                r.copy_from_slice(data);
                remap_write(bank, addr, r)
            } else {
                None
            };
            if want.as_deref() == Some(b) {
                Ok("settings write")
            } else {
                Err("G7 SE: only whole L4 / R4 records (profiles 1-3) and the report rate (banks 1-4) are written.".into())
            }
        }
        _ => Err("G7 SE: that body isn't one SYNQ sends.".into()),
    }
}

/// A reply on message 0x10.
#[derive(Debug, PartialEq, Eq)]
pub enum Reply {
    Read { bank: u8, addr: u16, data: Vec<u8> },
    Ack { busy: bool },
    /// The firmware text (UTF-16LE digits in the captures: "0108").
    Firmware(String),
    ActiveProfile(u8),
    Other(u8),
}

pub fn parse_reply(message_id: u8, body: &[u8]) -> Option<Reply> {
    if message_id != MSG_REPLY || body.is_empty() {
        return None;
    }
    Some(match body[0] {
        0x05 if body.len() >= 5 => {
            let len = usize::from(body[4]);
            if body.len() < 5 + len {
                return None;
            }
            Reply::Read { bank: body[1], addr: u16::from_be_bytes([body[2], body[3]]), data: body[5..5 + len].to_vec() }
        }
        0x06 => Reply::Ack { busy: body.get(1) == Some(&1) },
        0x0a => Reply::Firmware(body[1..].chunks(2).map_while(|c| (c[0] != 0).then_some(c[0] as char)).collect()),
        0x0c if body.len() >= 2 => Reply::ActiveProfile(body[1]),
        other => Reply::Other(other),
    })
}

/// The bytes on the USB wire for a body (the system adds this header on Windows): message id, options 0x00,
/// sequence, length. For comparing with the captures only.
#[cfg(test)]
fn usb_frame(message_id: u8, sequence: u8, body: &[u8]) -> Vec<u8> {
    let mut f = vec![message_id, 0x00, sequence, body.len() as u8];
    f.extend_from_slice(body);
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// The frames match the captured Nexus traffic gamesir-linux-tools publishes (tests/fixtures, MIT).
    #[test]
    fn the_bodies_are_the_captured_nexus_frames() {
        assert_eq!(usb_frame(MSG_REQUEST, 0x19, &firmware_query()), hex("0f00190109"));
        assert_eq!(usb_frame(MSG_REQUEST, 0x09, &active_profile_query()), hex("0f0009010b"));
        assert_eq!(usb_frame(MSG_REQUEST, 0x50, &read(1, 0x00aa, 0x2a).unwrap()), hex("0f005005040100aa2a"));
        let mut rate = hex("0f00123c03010036010200");
        rate.resize(64, 0);
        assert_eq!(usb_frame(MSG_REQUEST, 0x12, &rate_write(1, 2).unwrap()), rate);
        let reply = hex("0a3000310030003800000000");
        assert_eq!(parse_reply(MSG_REPLY, &reply), Some(Reply::Firmware("0108".into())));
        assert_eq!(parse_reply(MSG_REPLY, &hex("0c0101")), Some(Reply::ActiveProfile(1)));
        assert_eq!(parse_reply(MSG_REPLY, &hex("0600")), Some(Reply::Ack { busy: false }));
        let read_reply = hex("050100aa020104");
        assert_eq!(parse_reply(MSG_REPLY, &read_reply), Some(Reply::Read { bank: 1, addr: 0x00aa, data: vec![0x01, 0x04] }));
    }

    #[test]
    fn the_guard_lets_only_those_bodies_through() {
        for body in [heartbeat(), firmware_query(), active_profile_query(), read(4, 0, 55).unwrap(), rate_write(4, 0).unwrap()] {
            assert!(check(MSG_REQUEST, &body).is_ok(), "{body:02x?}");
        }
        let a = remap_record(Some(15)).unwrap();
        assert!(check(MSG_REQUEST, &remap_write(1, L4_ADDR, a).unwrap()).is_ok());
        assert!(check(MSG_REQUEST, &remap_write(3, R4_ADDR, remap_record(None).unwrap()).unwrap()).is_ok());
        // Other messages: power (0x05), authentication (0x06), firmware (0x0C), rumble (0x09), anything else.
        for id in [0x01u8, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x09, 0x0a, 0x0c, 0x10, 0x1e, 0x20] {
            assert!(check(id, &heartbeat()).is_err(), "message {id:#04x}");
        }
        // Reads past the profile or of bank 5; writes to bank 4's records, other addresses, partial records, keyboard codes.
        assert!(read(1, 400, 22).is_none() && read(5, 0, 1).is_none() && read(1, 0, 56).is_none());
        assert!(check(MSG_REQUEST, &[0x04, 1, 0x01, 0x90, 0x16]).is_err());
        assert!(remap_write(4, L4_ADDR, a).is_none() && remap_write(1, 0x00b2, a).is_none());
        assert!(remap_record(Some(0x40)).is_none() && rate_write(1, 3).is_none() && rate_write(5, 0).is_none());
        let mut partial = vec![0u8; WRITE_LEN];
        partial[..6].copy_from_slice(&[0x03, 1, 0x00, 0xb2, 0x01, 0x0f]);
        assert!(check(MSG_REQUEST, &partial).is_err(), "Nexus writes the target byte alone; SYNQ writes whole records");
        let mut trailing = rate_write(1, 1).unwrap();
        trailing[20] = 1;
        assert!(check(MSG_REQUEST, &trailing).is_err());
        assert!(check(MSG_REQUEST, &[0x17, 0x55, 0x88]).is_err(), "never the family's firmware loader");
        assert!(check(MSG_REQUEST, &[0x07, 0x01]).is_err(), "no profile switch");
    }
}
