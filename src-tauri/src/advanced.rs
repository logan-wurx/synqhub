//! Advanced capabilities: the one place that says which extra commands a device may be sent, for how
//! long, and after what confirmation.
//!
//! SYNQ's guards (the Rust ones in `hid.rs` and `brands.rs`, mirroring the TypeScript ones) refuse
//! pairing, button / macro rewrites, switch calibration and factory resets by default. The Advanced
//! section of a panel can unlock exactly those, one action at a time:
//!
//! 1. the person confirms in the panel (a tick for every action, and the word RESET for a reset);
//! 2. the panel asks the bridge for a *grant* (`hid_advanced_grant`): a scope, on one open device, that
//!    expires by itself (`Scope::ttl`) and ends when the device closes;
//! 3. while the grant is live the device's guard accepts the exact extra frames that scope needs, and
//!    nothing else. Without a grant (the default) the guards behave exactly as before.
//!
//! Firmware, bootloader and DFU commands have no scope: no grant can reach them. Each guard names them
//! as blocked before it looks at any grant, and the tests in `hid.rs` / `brands.rs` try every one with
//! every scope granted.
//!
//! No device I/O here: this module only keeps time and bookkeeping.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// What an Advanced action is allowed to do. There is deliberately no firmware scope.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Scope {
    /// Pair a wireless mouse or keyboard with its receiver.
    Pair,
    /// Rewrite buttons / keys (never the left mouse button, never a bootloader or EEPROM-reset key).
    Remap,
    /// Rewrite the macro memory.
    Macros,
    /// Switch / button calibration.
    Calibrate,
    /// Factory reset (always after a full backup, and after the person typed RESET).
    Reset,
}

impl Scope {
    pub const ALL: [Scope; 5] = [Scope::Pair, Scope::Remap, Scope::Macros, Scope::Calibrate, Scope::Reset];

    pub fn parse(s: &str) -> Option<Scope> {
        Some(match s {
            "pair" => Scope::Pair,
            "remap" => Scope::Remap,
            "macros" => Scope::Macros,
            "calibrate" => Scope::Calibrate,
            "reset" => Scope::Reset,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Scope::Pair => "pair",
            Scope::Remap => "remap",
            Scope::Macros => "macros",
            Scope::Calibrate => "calibrate",
            Scope::Reset => "reset",
        }
    }

    /// How long a grant lasts if the panel never revokes it. Short for the ones that act once.
    pub fn ttl(self) -> Duration {
        Duration::from_secs(match self {
            Scope::Pair => 3 * 60,
            Scope::Reset => 5 * 60,
            Scope::Calibrate => 10 * 60,
            Scope::Remap | Scope::Macros => 15 * 60,
        })
    }

    fn bit(self) -> u8 {
        match self {
            Scope::Pair => 1,
            Scope::Remap => 2,
            Scope::Macros => 4,
            Scope::Calibrate => 8,
            Scope::Reset => 16,
        }
    }
}

/// Which keycode encoding a QMK / VIA board uses (the same code means different things in each), so the
/// bridge knows which codes are safe to write. Chosen by the panel from the board's protocol version.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scheme {
    /// QMK 0.19 and later (VIA protocol 12+, Vial 6+).
    Current,
    /// Before QMK 0.19.
    Legacy,
}

impl Scheme {
    pub fn parse(s: &str) -> Option<Scheme> {
        match s {
            "current" => Some(Scheme::Current),
            "legacy" => Some(Scheme::Legacy),
            _ => None,
        }
    }
}

/// What is granted right now: the value a guard reads. `NONE` is the default path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Active {
    bits: u8,
    pub scheme: Option<Scheme>,
}

#[cfg_attr(not(test), allow(dead_code))]
impl Active {
    pub const NONE: Active = Active { bits: 0, scheme: None };

    pub fn has(self, scope: Scope) -> bool {
        self.bits & scope.bit() != 0
    }

    /// For tests and fixtures: these scopes, no keycode scheme.
    pub fn of(scopes: &[Scope]) -> Active {
        Active { bits: scopes.iter().fold(0, |b, s| b | s.bit()), scheme: None }
    }

    pub fn with_scheme(self, scheme: Scheme) -> Active {
        Active { scheme: Some(scheme), ..self }
    }
}

struct Grant {
    expires: Instant,
    scheme: Option<Scheme>,
}

/// The grants on one open device. Dropped with the device.
#[derive(Default)]
pub struct Grants {
    by_scope: HashMap<Scope, Grant>,
}

impl Grants {
    /// Grants `scope` from `now` for its TTL; returns how long it lasts.
    pub fn grant(&mut self, scope: Scope, scheme: Option<Scheme>, now: Instant) -> Duration {
        let ttl = scope.ttl();
        self.by_scope.insert(scope, Grant { expires: now + ttl, scheme });
        ttl
    }

    pub fn revoke(&mut self, scope: Scope) {
        self.by_scope.remove(&scope);
    }

    pub fn revoke_all(&mut self) {
        self.by_scope.clear();
    }

    /// The scopes that haven't expired at `now`. A guard calls this for every frame.
    pub fn active(&self, now: Instant) -> Active {
        let mut a = Active::NONE;
        for (&scope, g) in &self.by_scope {
            if g.expires > now {
                a.bits |= scope.bit();
                if scope == Scope::Remap {
                    a.scheme = g.scheme;
                }
            }
        }
        a
    }
}

/// What the person did in the confirmation step.
#[derive(Clone, Debug, Default)]
pub struct Ack {
    /// They ticked "I understand".
    pub acknowledged: bool,
    /// What they typed (a reset needs exactly RESET).
    pub typed: Option<String>,
}

/// The word a factory reset needs typed.
pub const RESET_WORD: &str = "RESET";

/// A grant needs the tick, and a reset also needs the word typed exactly.
pub fn check_ack(scope: Scope, ack: &Ack) -> Result<(), String> {
    if !ack.acknowledged {
        return Err("Advanced actions need your confirmation first.".into());
    }
    if scope == Scope::Reset && ack.typed.as_deref() != Some(RESET_WORD) {
        return Err(format!("A factory reset needs the word {RESET_WORD} typed to confirm."));
    }
    Ok(())
}

/// Which scopes a device's guard has any extra frames for. A grant for any other scope is refused
/// outright, so an unrelated device can't be left holding a grant that means nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    /// The ATK X1 V2 Air+ (src/lib/atk-protocol.ts).
    Atk,
    /// A QMK board on its raw-HID channel (VIA / Vial).
    Qmk,
    /// Sonix HE boards (FightingControlCenter protocol).
    Sonix,
}

pub fn scopes_for(family: Family) -> &'static [Scope] {
    match family {
        Family::Atk => &[Scope::Pair, Scope::Remap, Scope::Reset],
        Family::Qmk => &[Scope::Remap, Scope::Macros, Scope::Reset],
        Family::Sonix => &[Scope::Calibrate, Scope::Reset],
    }
}

/// Test helpers shared by the guards' fixture tests (hid.rs, brands.rs).
#[cfg(test)]
pub mod testing {
    use super::*;

    /// "-" for none, else scopes joined by "+", a remap scope optionally "remap:current" / "remap:legacy"
    /// (the form scripts/advanced-fixtures.ts writes).
    pub fn spec_active(spec: &str) -> Active {
        let mut scopes = Vec::new();
        let mut scheme = None;
        if spec != "-" {
            for part in spec.split('+') {
                let (name, s) = part.split_once(':').map_or((part, None), |(n, s)| (n, Some(s)));
                scopes.push(Scope::parse(name).unwrap_or_else(|| panic!("scope {name}")));
                if let Some(s) = s {
                    scheme = Some(Scheme::parse(s).unwrap_or_else(|| panic!("scheme {s}")));
                }
            }
        }
        let a = Active::of(&scopes);
        scheme.map_or(a, |s| a.with_scheme(s))
    }

    pub fn fixture_bytes(hex: &str) -> Vec<u8> {
        (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_granted_by_default() {
        let g = Grants::default();
        let a = g.active(Instant::now());
        assert_eq!(a, Active::NONE);
        for s in Scope::ALL {
            assert!(!a.has(s));
        }
    }

    #[test]
    fn a_grant_covers_its_scope_only_and_expires() {
        let mut g = Grants::default();
        let t0 = Instant::now();
        let ttl = g.grant(Scope::Pair, None, t0);
        assert_eq!(ttl, Scope::Pair.ttl());
        let during = g.active(t0 + Duration::from_secs(10));
        assert!(during.has(Scope::Pair));
        for s in Scope::ALL.into_iter().filter(|&s| s != Scope::Pair) {
            assert!(!during.has(s), "{s:?} must not ride along");
        }
        assert!(!g.active(t0 + ttl).has(Scope::Pair), "expired exactly at the TTL");
        assert!(!g.active(t0 + ttl + Duration::from_secs(1)).has(Scope::Pair));
    }

    #[test]
    fn revoke_ends_a_grant_and_revoke_all_ends_every_grant() {
        let mut g = Grants::default();
        let t0 = Instant::now();
        g.grant(Scope::Remap, Some(Scheme::Current), t0);
        g.grant(Scope::Macros, None, t0);
        g.revoke(Scope::Remap);
        let a = g.active(t0);
        assert!(!a.has(Scope::Remap) && a.has(Scope::Macros));
        assert_eq!(a.scheme, None, "the scheme goes with the remap grant");
        g.revoke_all();
        assert_eq!(g.active(t0), Active::NONE);
    }

    #[test]
    fn the_remap_grant_carries_the_keycode_scheme() {
        let mut g = Grants::default();
        let t0 = Instant::now();
        g.grant(Scope::Remap, Some(Scheme::Legacy), t0);
        assert_eq!(g.active(t0).scheme, Some(Scheme::Legacy));
    }

    #[test]
    fn a_confirmation_is_needed_and_a_reset_needs_the_word() {
        let none = Ack::default();
        for s in Scope::ALL {
            assert!(check_ack(s, &none).is_err(), "{s:?} without a tick");
        }
        let ticked = Ack { acknowledged: true, typed: None };
        for s in Scope::ALL.into_iter().filter(|&s| s != Scope::Reset) {
            assert!(check_ack(s, &ticked).is_ok(), "{s:?}");
        }
        assert!(check_ack(Scope::Reset, &ticked).is_err());
        for wrong in ["reset", "Reset", "RESET ", " RESET", "RESE", ""] {
            assert!(check_ack(Scope::Reset, &Ack { acknowledged: true, typed: Some(wrong.into()) }).is_err(), "{wrong:?}");
        }
        assert!(check_ack(Scope::Reset, &Ack { acknowledged: true, typed: Some("RESET".into()) }).is_ok());
        assert!(check_ack(Scope::Reset, &Ack { acknowledged: false, typed: Some("RESET".into()) }).is_err(), "the word alone isn't enough");
    }

    #[test]
    fn scope_names_round_trip_and_there_is_no_firmware_scope() {
        for s in Scope::ALL {
            assert_eq!(Scope::parse(s.name()), Some(s));
        }
        for bad in ["firmware", "flash", "bootloader", "dfu", "update", "all", "*", ""] {
            assert_eq!(Scope::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn every_ttl_is_short() {
        for s in Scope::ALL {
            assert!(s.ttl() <= Duration::from_secs(15 * 60), "{s:?}");
        }
    }

    #[test]
    fn each_family_names_its_own_scopes() {
        assert_eq!(scopes_for(Family::Atk), &[Scope::Pair, Scope::Remap, Scope::Reset]);
        assert!(!scopes_for(Family::Qmk).contains(&Scope::Pair));
        assert!(!scopes_for(Family::Qmk).contains(&Scope::Calibrate));
        assert!(!scopes_for(Family::Sonix).contains(&Scope::Remap));
    }
}
