//! Game profiles at run time: which game is running, which device should hold which profile, and
//! sending it. Games and profiles come from `games.json` (src-tauri/src/games.rs), encoded offline by
//! the app from the settings the person picked.
//!
//! Each tick compares what every profiled device *should* hold (the most recently started running game
//! that follows it with "Apply automatically", else its everyday settings) with what it holds now, and
//! sends only the difference: the restore set of what it holds (its everyday rows), then the new game's
//! profile. So a game starting applies its profile; the game ending (or the helper pausing or quitting)
//! puts the everyday settings back; two games at once follow the newest; a device plugged in mid-game gets
//! its profile when it appears. The restore set travels with what a device holds (and is kept in
//! helper-state.json), so an edited or deleted profile, or a crash mid-game, still restores exactly what
//! was there. A send that fails is retried a few times, then left until what is wanted changes.
//! Nothing is enumerated or sent while nothing needs to change.

use crate::games::{self, GamesFile};
use crate::hid::{self, Step};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{Duration, Instant};

pub const RETRY: Duration = Duration::from_secs(10);
pub const MAX_TRIES: u32 = 3;
/// Gap between two reports of a profile (the device panels wait for each answer; this is gentler still).
pub const STEP_GAP: Duration = Duration::from_millis(20);

/// The devices, as the switcher sees them. The real one is `HidDevices`; tests use a fake.
pub trait Devices {
    /// Keys of the devices plugged in now (hid.rs `Summary::key`).
    fn present(&mut self) -> Vec<String>;
    /// Sends the steps to one device, in order, through the guarded bridge.
    fn apply(&mut self, key: &str, steps: &[Step]) -> Result<(), String>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Applied { game: String, device: String },
    Restored { device: String },
    Failed { device: String, error: String },
}

/// What a device holds: a game's profile (its id and save time) and how to undo it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Held {
    pub game: String,
    pub saved: u64,
    pub restore: Vec<Step>,
}

type Want = Option<(String, u64)>;

struct Try {
    want: Want,
    count: u32,
    next: Instant,
    gave_up: bool,
}

#[derive(Default)]
pub struct Switcher {
    /// Running games that are followed, oldest first.
    order: Vec<String>,
    /// Device key -> the game profile it holds. Absent: its everyday settings.
    on: BTreeMap<String, Held>,
    tries: HashMap<String, Try>,
}

impl Switcher {
    /// Starts from what an earlier run left on the devices (so a crash mid-game still restores).
    pub fn with_on(on: BTreeMap<String, Held>) -> Self {
        Self { on, ..Default::default() }
    }

    pub fn on(&self) -> &BTreeMap<String, Held> {
        &self.on
    }

    /// The game whose profiles are wanted now.
    pub fn active(&self) -> Option<&str> {
        self.order.last().map(String::as_str)
    }

    /// One look at the running programs, and whatever sending that calls for.
    pub fn tick(&mut self, file: &GamesFile, running: &HashSet<String>, devs: &mut dyn Devices, now: Instant) -> Vec<Event> {
        // Live profiles (`live:<family>`) are SYNQ's to put on through the device's session; only encoded ones are sent here.
        let live: Vec<&str> = file.games.iter().filter(|g| g.auto && g.profiles.keys().any(|k| !games::is_live(k)) && g.exes.iter().any(|e| running.contains(e))).map(|g| g.id.as_str()).collect();
        self.order.retain(|id| live.contains(&id.as_str()));
        for id in live {
            if !self.order.iter().any(|o| o == id) {
                self.order.push(id.to_string());
            }
        }
        self.reconcile(file, devs, now)
    }

    /// Puts every device back on its everyday settings (pause, quit, the feature turned off).
    pub fn restore_all(&mut self, file: &GamesFile, devs: &mut dyn Devices, now: Instant) -> Vec<Event> {
        self.order.clear();
        self.tries.clear();
        self.reconcile(file, devs, now)
    }

    fn reconcile(&mut self, file: &GamesFile, devs: &mut dyn Devices, now: Instant) -> Vec<Event> {
        let mut events = Vec::new();
        let active = self.active().and_then(|id| file.games.iter().find(|g| g.id == id));
        let mut keys: Vec<String> = self.on.keys().cloned().collect();
        if let Some(g) = active {
            keys.extend(g.profiles.keys().filter(|k| !games::is_live(k)).cloned());
        }
        keys.sort();
        keys.dedup();
        let mut present: Option<Vec<String>> = None;
        for key in keys {
            let profile = active.and_then(|g| g.profiles.get(&key));
            let want: Want = active.zip(profile).map(|(g, p)| (g.id.clone(), p.saved));
            let held: Want = self.on.get(&key).map(|h| (h.game.clone(), h.saved));
            if held == want {
                self.tries.remove(&key);
                continue;
            }
            if let Some(t) = self.tries.get(&key) {
                if t.want == want && (t.gave_up || now < t.next) {
                    continue;
                }
            }
            // Undo what it holds, then apply what's wanted.
            let mut steps: Vec<Step> = self.on.get(&key).map(|h| h.restore.clone()).unwrap_or_default();
            if let Some(p) = profile {
                steps.extend(p.steps.iter().cloned());
            }
            let name = profile.map(|p| p.name.clone()).unwrap_or_else(|| file.games.iter().flat_map(|g| g.profiles.iter()).find(|(k, _)| **k == key).map_or(key.clone(), |(_, p)| p.name.clone()));
            let list = present.get_or_insert_with(|| devs.present());
            let Some(target) = list.iter().find(|p| games::same_device(&key, p)).cloned() else {
                // Not plugged in: look again in a while, without counting it as a failure.
                let count = self.tries.get(&key).filter(|t| t.want == want).map_or(0, |t| t.count);
                self.tries.insert(key.clone(), Try { want: want.clone(), count, next: now + RETRY, gave_up: false });
                continue;
            };
            let result = if steps.is_empty() { Ok(()) } else { devs.apply(&target, &steps) };
            match result {
                Ok(()) => {
                    self.tries.remove(&key);
                    match (want, profile) {
                        (Some((game, saved)), Some(p)) => {
                            self.on.insert(key.clone(), Held { game: game.clone(), saved, restore: p.restore.clone() });
                            events.push(Event::Applied { game, device: name });
                        }
                        _ => {
                            self.on.remove(&key);
                            events.push(Event::Restored { device: name });
                        }
                    }
                }
                Err(error) => {
                    let count = self.tries.get(&key).filter(|t| t.want == want).map_or(0, |t| t.count) + 1;
                    let gave_up = count >= MAX_TRIES;
                    if gave_up {
                        events.push(Event::Failed { device: name, error });
                        if want.is_none() {
                            // Can't restore it: stop claiming it holds a game profile.
                            self.on.remove(&key);
                        }
                    }
                    self.tries.insert(key.clone(), Try { want, count, next: now + RETRY, gave_up });
                }
            }
        }
        events
    }
}

/// The real devices: the helper's own HidState (not the web bridge's), opened for one profile and
/// closed again.
pub struct HidDevices<'a> {
    pub state: &'a hid::HidState,
}

impl Devices for HidDevices<'_> {
    fn present(&mut self) -> Vec<String> {
        hid::list(self.state).map(|l| l.into_iter().map(|s| s.key).collect()).unwrap_or_default()
    }

    fn apply(&mut self, key: &str, steps: &[Step]) -> Result<(), String> {
        hid::open_with(self.state, key, std::sync::Arc::new(|_| {}))?;
        let mut result = Ok(());
        for (i, s) in steps.iter().enumerate() {
            if let Err(e) = hid::send_step(self.state, key, s) {
                result = Err(format!("report {} of {}: {e}", i + 1, steps.len()));
                break;
            }
            std::thread::sleep(STEP_GAP);
        }
        let _ = hid::close(self.state, key);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::DeviceProfile;
    use crate::watcher::{ProcessSource, fake::FakeProcesses};

    /// Simulated devices: each holds named rows; a step is [row, value].
    #[derive(Default)]
    struct Sim {
        plugged: Vec<String>,
        rows: HashMap<String, HashMap<u8, u8>>,
        sends: usize,
        scans: usize,
        failing: HashSet<String>,
    }

    impl Sim {
        fn row(&self, key: &str, row: u8) -> u8 {
            self.rows.get(key).and_then(|r| r.get(&row)).copied().unwrap_or(0)
        }
    }

    impl Devices for Sim {
        fn present(&mut self) -> Vec<String> {
            self.scans += 1;
            self.plugged.clone()
        }
        fn apply(&mut self, key: &str, steps: &[Step]) -> Result<(), String> {
            self.sends += 1;
            if self.failing.contains(key) {
                return Err("No collection accepted report 0x08".into());
            }
            for s in steps {
                if let Step::Output { data, .. } = s {
                    self.rows.entry(key.into()).or_default().insert(data[0], data[1]);
                }
            }
            Ok(())
        }
    }

    const MOUSE: &str = "373b:12a2:2:";
    const KB: &str = "2e3c:c365:1:SER";

    fn w(row: u8, v: u8) -> Step {
        Step::Output { report_id: 8, data: vec![row, v] }
    }

    /// A profile writing `rows` (row, value), restoring them to the everyday value 9.
    fn p(name: &str, rows: &[(u8, u8)], saved: u64) -> DeviceProfile {
        DeviceProfile {
            name: name.into(),
            vendor_id: 0x373b,
            product_id: 0x12a2,
            steps: rows.iter().map(|&(r, v)| w(r, v)).collect(),
            restore: rows.iter().map(|&(r, _)| w(r, 9)).collect(),
            settings: serde_json::Value::Null,
            saved,
        }
    }

    fn file() -> GamesFile {
        let mut f = GamesFile::default();
        // CS2: DPI (row 1) only. Apex: DPI and polling (row 2), and the keyboard's actuation (row 3).
        f.games.iter_mut().find(|g| g.id == "cs2").unwrap().profiles.insert(MOUSE.into(), p("mouse", &[(1, 1)], 1));
        let apex = f.games.iter_mut().find(|g| g.id == "apex").unwrap();
        apex.profiles.insert(MOUSE.into(), p("mouse", &[(1, 2), (2, 2)], 1));
        apex.profiles.insert(KB.into(), p("keyboard", &[(3, 3)], 1));
        f
    }

    fn sim() -> Sim {
        let mut d = Sim { plugged: vec![MOUSE.into(), KB.into()], ..Default::default() };
        for k in [MOUSE, KB] {
            d.rows.insert(k.into(), HashMap::from([(1, 9), (2, 9), (3, 9)]));
        }
        d
    }

    fn run(sw: &mut Switcher, f: &GamesFile, procs: &mut FakeProcesses, devs: &mut Sim, t: Instant) -> Vec<Event> {
        let names = procs.names().unwrap();
        sw.tick(f, &names, devs, t)
    }

    #[test]
    fn game_start_applies_and_exit_restores() {
        let (f, mut d, mut procs, mut sw, t) = (file(), sim(), FakeProcesses::default(), Switcher::default(), Instant::now());
        procs.set(&["explorer.exe", "discord.exe"]);
        assert!(run(&mut sw, &f, &mut procs, &mut d, t).is_empty());
        assert_eq!((d.sends, d.scans), (0, 0), "nothing running: nothing enumerated or sent");
        procs.set(&["explorer.exe", "cs2.exe"]);
        assert_eq!(run(&mut sw, &f, &mut procs, &mut d, t), vec![Event::Applied { game: "cs2".into(), device: "mouse".into() }]);
        assert_eq!(d.row(MOUSE, 1), 1);
        assert!(run(&mut sw, &f, &mut procs, &mut d, t).is_empty());
        assert_eq!(d.sends, 1, "already on: not sent again");
        procs.set(&["explorer.exe"]);
        assert_eq!(run(&mut sw, &f, &mut procs, &mut d, t), vec![Event::Restored { device: "mouse".into() }]);
        assert_eq!(d.row(MOUSE, 1), 9);
        assert!(sw.on().is_empty());
        assert_eq!(d.row(KB, 3), 9, "a device cs2 has no profile for is never touched");
    }

    #[test]
    fn switching_games_undoes_the_old_profile_first() {
        let (f, mut d, mut procs, mut sw, t) = (file(), sim(), FakeProcesses::default(), Switcher::default(), Instant::now());
        procs.set(&["r5apex.exe"]);
        run(&mut sw, &f, &mut procs, &mut d, t);
        assert_eq!((d.row(MOUSE, 1), d.row(MOUSE, 2), d.row(KB, 3)), (2, 2, 3));
        procs.set(&["r5apex.exe", "cs2.exe"]);
        run(&mut sw, &f, &mut procs, &mut d, t);
        // CS2 sets only DPI: Apex's polling must not linger.
        assert_eq!((d.row(MOUSE, 1), d.row(MOUSE, 2), d.row(KB, 3)), (1, 9, 9));
        procs.set(&["r5apex.exe"]);
        run(&mut sw, &f, &mut procs, &mut d, t);
        assert_eq!((d.row(MOUSE, 1), d.row(MOUSE, 2), d.row(KB, 3)), (2, 2, 3), "the older game comes back");
        procs.set(&[]);
        run(&mut sw, &f, &mut procs, &mut d, t);
        assert_eq!((d.row(MOUSE, 1), d.row(MOUSE, 2), d.row(KB, 3)), (9, 9, 9));
    }

    #[test]
    fn apply_automatically_off_is_ignored() {
        let (mut f, mut d, mut procs, mut sw, t) = (file(), sim(), FakeProcesses::default(), Switcher::default(), Instant::now());
        f.games.iter_mut().find(|g| g.id == "cs2").unwrap().auto = false;
        procs.set(&["cs2.exe"]);
        assert!(run(&mut sw, &f, &mut procs, &mut d, t).is_empty());
        assert_eq!(d.sends, 0);
    }

    #[test]
    fn a_missing_device_gets_its_profile_when_plugged_in() {
        let (f, mut d, mut procs, mut sw, t) = (file(), sim(), FakeProcesses::default(), Switcher::default(), Instant::now());
        d.plugged = vec![KB.into()];
        procs.set(&["r5apex.exe"]);
        run(&mut sw, &f, &mut procs, &mut d, t);
        assert_eq!(d.row(KB, 3), 3);
        let scans = d.scans;
        run(&mut sw, &f, &mut procs, &mut d, t + Duration::from_secs(2));
        assert_eq!(d.scans, scans, "not looked for again before RETRY");
        d.plugged.push("373b:12a2:2:NEWSERIAL".into());
        run(&mut sw, &f, &mut procs, &mut d, t + RETRY);
        assert_eq!(d.row("373b:12a2:2:NEWSERIAL", 1), 2, "same device, other serial");
    }

    #[test]
    fn failures_retry_then_give_up_until_something_changes() {
        let (f, mut d, mut procs, mut sw, t) = (file(), sim(), FakeProcesses::default(), Switcher::default(), Instant::now());
        d.failing.insert(MOUSE.into());
        procs.set(&["cs2.exe"]);
        let mut failed = vec![];
        for i in 0..10u32 {
            failed.extend(run(&mut sw, &f, &mut procs, &mut d, t + RETRY * i));
        }
        assert_eq!(d.sends, MAX_TRIES as usize);
        assert_eq!(failed.len(), 1, "{failed:?}");
        assert!(matches!(&failed[0], Event::Failed { .. }));
        d.failing.clear();
        procs.set(&["r5apex.exe"]);
        run(&mut sw, &f, &mut procs, &mut d, t + RETRY * 20);
        assert_eq!(d.row(MOUSE, 1), 2, "a new game tries again");
    }

    #[test]
    fn pause_and_quit_restore_everything() {
        let (f, mut d, mut procs, mut sw, t) = (file(), sim(), FakeProcesses::default(), Switcher::default(), Instant::now());
        procs.set(&["r5apex.exe"]);
        run(&mut sw, &f, &mut procs, &mut d, t);
        assert_eq!(sw.on().len(), 2);
        assert_eq!(sw.restore_all(&f, &mut d, t).len(), 2);
        assert_eq!((d.row(MOUSE, 1), d.row(MOUSE, 2), d.row(KB, 3)), (9, 9, 9));
        assert!(sw.on().is_empty());
    }

    #[test]
    fn a_deleted_profile_or_a_crash_still_restores_what_was_held() {
        let (mut f, mut d, mut procs, mut sw, t) = (file(), sim(), FakeProcesses::default(), Switcher::default(), Instant::now());
        procs.set(&["cs2.exe"]);
        run(&mut sw, &f, &mut procs, &mut d, t);
        // The person deletes the profile mid-game; and the helper restarts (state from helper-state.json).
        f.games.iter_mut().for_each(|g| g.profiles.clear());
        let mut again = Switcher::with_on(sw.on().clone());
        procs.set(&[]);
        assert_eq!(run(&mut again, &f, &mut procs, &mut d, t), vec![Event::Restored { device: MOUSE.into() }]);
        assert_eq!(d.row(MOUSE, 1), 9);
    }

    #[test]
    fn a_resaved_profile_is_sent_again() {
        let (mut f, mut d, mut procs, mut sw, t) = (file(), sim(), FakeProcesses::default(), Switcher::default(), Instant::now());
        procs.set(&["cs2.exe"]);
        run(&mut sw, &f, &mut procs, &mut d, t);
        f.games.iter_mut().find(|g| g.id == "cs2").unwrap().profiles.insert(MOUSE.into(), p("mouse", &[(1, 5)], 2));
        run(&mut sw, &f, &mut procs, &mut d, t);
        assert_eq!(d.row(MOUSE, 1), 5);
    }

    /// The real device path, against a device that is "open" with no handles: profile steps go through
    /// the same guards as the app, so a step a guard refuses never reaches a device.
    #[test]
    fn live_profiles_are_left_to_synq() {
        let live = || DeviceProfile { steps: vec![], restore: vec![], settings: serde_json::json!({ "kind": "feel", "family": "logitech", "feel": {} }), ..p("PRO X 2", &[], 1) };
        let mut f = file();
        // Valorant has only a live profile; CS2 has its encoded one and a live one.
        f.games.iter_mut().find(|g| g.id == "valorant").unwrap().profiles.insert("live:logitech".into(), live());
        f.games.iter_mut().find(|g| g.id == "cs2").unwrap().profiles.insert("live:logitech".into(), live());
        let (mut d, mut procs, mut sw, t) = (sim(), FakeProcesses::default(), Switcher::default(), Instant::now());
        procs.set(&["valorant-win64-shipping.exe"]);
        assert!(run(&mut sw, &f, &mut procs, &mut d, t).is_empty());
        assert_eq!((d.sends, d.scans, sw.active()), (0, 0, None), "a game with only live profiles isn't followed here");
        procs.set(&["cs2.exe"]);
        assert_eq!(run(&mut sw, &f, &mut procs, &mut d, t), vec![Event::Applied { game: "cs2".into(), device: "mouse".into() }]);
        assert_eq!(sw.on().keys().map(String::as_str).collect::<Vec<_>>(), [MOUSE], "only the encoded profile is held");
    }

    #[test]
    fn profile_steps_pass_the_guards() {
        let state = hid::HidState::new();
        hid::test_open_fake(&state, "atk", 0x373b, 0x1278);
        let mut reset = vec![0u8; 16];
        reset[0] = 0x09;
        let sum: u32 = 8 + reset[..15].iter().map(|&b| u32::from(b)).sum::<u32>();
        reset[15] = (0x55u32.wrapping_sub(sum & 0xff) & 0xff) as u8;
        let e = hid::send_step(&state, "atk", &Step::Output { report_id: 8, data: reset }).unwrap_err();
        assert!(!e.contains("No collection"), "refused by the guard, not by the missing handle: {e}");
    }
}
