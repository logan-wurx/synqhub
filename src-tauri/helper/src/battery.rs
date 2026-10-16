//! Battery alerts: one Windows notification per level as a wireless mouse runs down, at 20%, 10% and 5%
//! by default (`DEFAULT_LEVELS`; the person can change the list in Settings > SYNQ Helper). Each level
//! alerts once per discharge and comes back only after the battery has been charged.
//!
//! Only devices that report a battery are asked, slowly: every `EVERY` (5 minutes). A device that
//! doesn't answer, or whose receiver says the mouse is asleep or off, is asked less and less often
//! (up to `MAX_BACKOFF`); a device without a battery is never asked again. The questions are the
//! read-only ones the app's own panels ask, sent through the same guarded bridge (hid.rs):
//!
//! - ATK X1 (receiver or cable): GetMouseOnline first (the receiver answers it itself, the mouse isn't
//!   woken), then GetBattery only when the mouse is online.
//! - Logitech HID++ 2.0 mice (receiver or cable): IRoot.GetFeature for Unified Battery (0x1004) or
//!   Battery Status (0x1000), then its status read. A sleeping mouse behind a receiver gets an HID++ 1.0
//!   error from the receiver; the mouse isn't woken. A separate software id (0x0C) keeps these
//!   replies apart from the app's own driver (0x05) and its ping (0x0B).

use crate::hid::{self, Step};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// The alert levels when the person hasn't chosen others (helper.json `batteryLevels`).
pub const DEFAULT_LEVELS: [u8; 3] = [20, 10, 5];
pub const MAX_LEVELS: usize = 5;
/// The battery must climb this far above a level (or be charging) before that level can alert again.
pub const REARM: u8 = 5;
pub const EVERY: Duration = Duration::from_secs(5 * 60);
pub const MAX_BACKOFF: Duration = Duration::from_secs(40 * 60);
/// How long one question waits for its answer.
pub const ANSWER_TIMEOUT: Duration = Duration::from_millis(800);

/// A usable level list: 1 to 5 distinct levels from 1 to 50%, highest first. Anything else falls back
/// to `DEFAULT_LEVELS` (a hand-edited file can't switch the alerts off by accident).
pub fn levels(raw: &[u8]) -> Vec<u8> {
    let mut v: Vec<u8> = raw.iter().copied().filter(|l| (1..=50).contains(l)).collect();
    v.sort_unstable_by(|a, b| b.cmp(a));
    v.dedup();
    if v.is_empty() || v.len() > MAX_LEVELS || v.len() != raw.len() {
        return DEFAULT_LEVELS.to_vec();
    }
    v
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reading {
    Level { percent: u8, charging: bool },
    /// The receiver says the mouse is off or asleep (it wasn't woken).
    Asleep,
    /// Nothing answered in time.
    NoAnswer,
    /// The device has no battery feature: never asked again.
    NoBattery,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Alert {
    pub name: String,
    pub percent: u8,
    /// The level that was crossed.
    pub level: u8,
    /// It's the lowest level in the list.
    pub last: bool,
}

impl Alert {
    pub fn title(&self) -> String {
        if self.last { "Battery almost empty".into() } else { "Battery low".into() }
    }
    pub fn text(&self) -> String {
        if self.last { format!("{} is at {}%. Charge it soon.", self.name, self.percent) } else { format!("{} is at {}%.", self.name, self.percent) }
    }
}

/// Which levels already alerted, per device.
#[derive(Default)]
pub struct Alerts {
    sent: HashMap<String, Vec<u8>>,
}

impl Alerts {
    /// One reading in, at most one alert out. `levels` as `levels()` returns them (highest first).
    pub fn observe(&mut self, key: &str, name: &str, percent: u8, charging: bool, levels: &[u8]) -> Option<Alert> {
        let sent = self.sent.entry(key.to_string()).or_default();
        // Charging, or well above a level: that level can alert again.
        sent.retain(|&l| !charging && percent < l.saturating_add(REARM));
        if charging {
            return None;
        }
        // The lowest level crossed that hasn't alerted; the ones above it count as done too, so a drop
        // straight from 25% to 4% is one notification, not three.
        let crossed: Vec<u8> = levels.iter().copied().filter(|&l| percent <= l).collect();
        let lowest = *crossed.last()?;
        if sent.contains(&lowest) {
            return None;
        }
        for l in crossed {
            if !sent.contains(&l) {
                sent.push(l);
            }
        }
        Some(Alert { name: name.to_string(), percent, level: lowest, last: Some(&lowest) == levels.last() })
    }
}

/// When each device is asked next.
#[derive(Default)]
pub struct Schedule {
    next: HashMap<String, (Instant, Duration)>,
    never: std::collections::HashSet<String>,
}

impl Schedule {
    /// Devices plugged in now: new ones are asked at once, gone ones forgotten.
    pub fn present(&mut self, keys: &[String], now: Instant) {
        self.next.retain(|k, _| keys.contains(k));
        self.never.retain(|k| keys.contains(k));
        for k in keys {
            if !self.never.contains(k) {
                self.next.entry(k.clone()).or_insert((now, EVERY));
            }
        }
    }

    pub fn due(&self, now: Instant) -> Vec<String> {
        let mut v: Vec<String> = self.next.iter().filter(|(_, (t, _))| *t <= now).map(|(k, _)| k.clone()).collect();
        v.sort();
        v
    }

    /// When the next device is due (None: nothing to ask).
    pub fn next_wake(&self) -> Option<Instant> {
        self.next.values().map(|(t, _)| *t).min()
    }

    pub fn update(&mut self, key: &str, r: Reading, now: Instant) {
        match r {
            Reading::NoBattery => {
                self.next.remove(key);
                self.never.insert(key.to_string());
            }
            Reading::Level { .. } => {
                self.next.insert(key.to_string(), (now + EVERY, EVERY));
            }
            Reading::Asleep | Reading::NoAnswer => {
                let gap = self.next.get(key).map_or(EVERY, |(_, g)| (*g * 2).min(MAX_BACKOFF));
                self.next.insert(key.to_string(), (now + gap, gap));
            }
        }
    }

    #[cfg(test)]
    pub fn gap(&self, key: &str) -> Option<Duration> {
        self.next.get(key).map(|(_, g)| *g)
    }
}

// ---- the questions

/// How a device is asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Atk,
    /// HID++ device index (1 behind a receiver, 0xFF on a cable), and whether only long reports exist.
    Hidpp { index: u8, long: bool },
}

const LOGITECH: u16 = 0x046d;
const ATK_REPORT: u8 = 0x08;
const ATK_CHANNEL: (u16, u16) = (0xff02, 0x0002);
const SHORT: u8 = 0x10;
const LONG: u8 = 0x11;
const SW_ID: u8 = 0x0c;
const UNIFIED_BATTERY: u16 = 0x1004;
const BATTERY_STATUS: u16 = 0x1000;

/// Which devices get asked: the ATK X1 and Logitech mice the bridge opens through OpenMouse's table.
/// Brand keyboards (their own guards and sessions) are left alone.
pub fn kind_of(s: &hid::Summary) -> Option<Kind> {
    if hid::atk_device(s.vendor_id, s.product_id) {
        return s.collections.iter().any(|c| (c.usage_page, c.usage) == ATK_CHANNEL).then_some(Kind::Atk);
    }
    if s.vendor_id == LOGITECH && crate::brands::device(s.vendor_id, s.product_id).is_none() {
        let short = s.collections.iter().any(|c| (c.usage_page, c.usage) == (0xff00, 0x0001));
        let long = s.collections.iter().any(|c| (c.usage_page, c.usage) == (0xff00, 0x0002));
        if !short && !long {
            return None;
        }
        let receiver = s.product_id & 0xff00 == 0xc500;
        return Some(Kind::Hidpp { index: if receiver { 1 } else { 0xff }, long: !short });
    }
    None
}

/// The name in the notification.
pub fn display_name(s: &hid::Summary) -> String {
    let n = s.product_name.trim();
    if n.is_empty() || n.to_ascii_lowercase().contains("receiver") || n.to_ascii_lowercase().contains("dongle") {
        return if s.vendor_id == LOGITECH { "Your Logitech mouse".into() } else { "Your mouse".into() };
    }
    n.to_string()
}

/// One question out, answers back.
pub trait Link {
    fn send(&mut self, step: &Step) -> Result<(), String>;
    /// The next input report (report id, data) within `timeout`.
    fn recv(&mut self, timeout: Duration) -> Option<(u8, Vec<u8>)>;
}

fn atk_frame(cmd: u8) -> Vec<u8> {
    let mut f = vec![0u8; 16];
    f[0] = cmd;
    let sum: u32 = u32::from(ATK_REPORT) + f[..15].iter().map(|&b| u32::from(b)).sum::<u32>();
    f[15] = (0x55u32.wrapping_sub(sum & 0xff) & 0xff) as u8;
    f
}

fn atk_ok(f: &[u8], cmd: u8) -> bool {
    f.len() == 16 && f[0] == cmd && f[1] == 0 && (u32::from(ATK_REPORT) + f.iter().map(|&b| u32::from(b)).sum::<u32>()) & 0xff == 0x55
}

fn atk_ask(link: &mut dyn Link, cmd: u8) -> Option<Vec<u8>> {
    let (page, usage) = ATK_CHANNEL;
    link.send(&Step::OutputTo { usage_page: page, usage, report_id: ATK_REPORT, data: atk_frame(cmd) }).ok()?;
    let until = Instant::now() + ANSWER_TIMEOUT;
    while let Some(left) = until.checked_duration_since(Instant::now()) {
        let (id, data) = link.recv(left)?;
        if id == ATK_REPORT && atk_ok(&data, cmd) {
            return Some(data);
        }
    }
    None
}

pub fn probe_atk(link: &mut dyn Link) -> Reading {
    let Some(online) = atk_ask(link, 0x03) else { return Reading::NoAnswer };
    if online[5] == 0 {
        return Reading::Asleep;
    }
    match atk_ask(link, 0x04) {
        Some(b) if b[5] <= 100 => Reading::Level { percent: b[5], charging: b[6] != 0 },
        _ => Reading::NoAnswer,
    }
}

enum Hidpp {
    Ok(Vec<u8>),
    /// HID++ 1.0 error from the receiver: nobody answers on that index (off or asleep).
    Absent,
    /// HID++ 2.0 error: the device is there and refused the request.
    Refused,
}

fn hidpp_ask(link: &mut dyn Link, index: u8, long: bool, feature: u8, function: u8, params: &[u8]) -> Option<Hidpp> {
    let (id, len) = if long { (LONG, 19) } else { (SHORT, 6) };
    let fn_sw = (function << 4) | SW_ID;
    let mut data = vec![0u8; len];
    data[..3].copy_from_slice(&[index, feature, fn_sw]);
    data[3..3 + params.len()].copy_from_slice(params);
    link.send(&Step::Output { report_id: id, data }).ok()?;
    let until = Instant::now() + ANSWER_TIMEOUT;
    while let Some(left) = until.checked_duration_since(Instant::now()) {
        let (rid, d) = link.recv(left)?;
        if (rid != SHORT && rid != LONG) || d.len() < 5 || d[0] != index {
            continue;
        }
        if d[1] == feature && d[2] == fn_sw {
            return Some(Hidpp::Ok(d[3..].to_vec()));
        }
        if d[1] == 0x8f && d[2] == feature && d[3] == fn_sw {
            return Some(Hidpp::Absent);
        }
        if d[1] == 0xff && d[2] == feature && d[3] == fn_sw {
            return Some(Hidpp::Refused);
        }
    }
    None
}

/// `cache`: the battery feature found last time (feature id, index), so a reading is one question.
pub fn probe_hidpp(link: &mut dyn Link, index: u8, long: bool, cache: &mut Option<(u16, u8)>) -> Reading {
    if cache.is_none() {
        for feature in [UNIFIED_BATTERY, BATTERY_STATUS] {
            match hidpp_ask(link, index, long, 0x00, 0, &[(feature >> 8) as u8, feature as u8]) {
                Some(Hidpp::Ok(p)) if p[0] != 0 => {
                    *cache = Some((feature, p[0]));
                    break;
                }
                Some(Hidpp::Ok(_)) | Some(Hidpp::Refused) => continue,
                Some(Hidpp::Absent) => return Reading::Asleep,
                None => return Reading::NoAnswer,
            }
        }
        if cache.is_none() {
            return Reading::NoBattery;
        }
    }
    let (feature, fi) = cache.expect("found above");
    let function = if feature == UNIFIED_BATTERY { 1 } else { 0 };
    match hidpp_ask(link, index, long, fi, function, &[]) {
        Some(Hidpp::Ok(p)) if feature == UNIFIED_BATTERY && p[0] <= 100 => Reading::Level { percent: p[0], charging: matches!(p[2], 1..=3) },
        Some(Hidpp::Ok(p)) if feature == BATTERY_STATUS && p[0] <= 100 => Reading::Level { percent: p[0], charging: matches!(p[2], 1..=4) },
        Some(Hidpp::Absent) => Reading::Asleep,
        Some(Hidpp::Refused) => {
            *cache = None;
            Reading::NoAnswer
        }
        _ => Reading::NoAnswer,
    }
}

/// The real link: the helper's own HidState (not the web bridge's), opened for one reading.
pub struct HidLink<'a> {
    state: &'a hid::HidState,
    key: String,
    rx: std::sync::mpsc::Receiver<(u8, Vec<u8>)>,
}

impl<'a> HidLink<'a> {
    pub fn open(state: &'a hid::HidState, key: &str) -> Result<Self, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let emit: hid::Emit = std::sync::Arc::new(move |e| {
            if let hid::HidEvent::Input { report_id, data, .. } = e {
                let _ = tx.send((report_id, data.to_vec()));
            }
        });
        hid::open_with(state, key, emit)?;
        Ok(Self { state, key: key.to_string(), rx })
    }
}

impl Link for HidLink<'_> {
    fn send(&mut self, step: &Step) -> Result<(), String> {
        while self.rx.try_recv().is_ok() {}
        hid::send_step(self.state, &self.key, step)
    }
    fn recv(&mut self, timeout: Duration) -> Option<(u8, Vec<u8>)> {
        self.rx.recv_timeout(timeout).ok()
    }
}

impl Drop for HidLink<'_> {
    fn drop(&mut self) {
        let _ = hid::close(self.state, &self.key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn run(a: &mut Alerts, readings: &[u8]) -> Vec<(u8, u8)> {
        readings.iter().filter_map(|&p| a.observe("m", "Mouse", p, false, &DEFAULT_LEVELS)).map(|x| (x.level, x.percent)).collect()
    }

    #[test]
    fn one_alert_at_20_10_and_5() {
        let mut a = Alerts::default();
        assert_eq!(run(&mut a, &[40, 30, 21, 20, 19, 15, 11, 10, 9, 6, 5, 4, 1]), vec![(20, 20), (10, 10), (5, 5)]);
        let x = Alerts::default().observe("m", "Mouse", 5, false, &DEFAULT_LEVELS).unwrap();
        assert!(x.last && x.title() == "Battery almost empty" && x.text().contains("Charge it soon"));
        let x = Alerts::default().observe("m", "Mouse", 18, false, &DEFAULT_LEVELS).unwrap();
        assert!(!x.last && x.title() == "Battery low" && x.text() == "Mouse is at 18%.");
    }

    #[test]
    fn a_big_drop_sends_one() {
        let mut a = Alerts::default();
        assert_eq!(run(&mut a, &[25, 4]), vec![(5, 4)]);
        assert_eq!(run(&mut a, &[13, 8]), vec![], "the levels above are implied");
        let mut a = Alerts::default();
        assert_eq!(run(&mut a, &[30, 9, 3]), vec![(10, 9), (5, 3)]);
    }

    #[test]
    fn alerts_come_back_after_charging_not_after_jitter() {
        let mut a = Alerts::default();
        let lv = DEFAULT_LEVELS;
        assert!(a.observe("m", "Mouse", 20, false, &lv).is_some());
        assert!(a.observe("m", "Mouse", 22, false, &lv).is_none());
        assert!(a.observe("m", "Mouse", 20, false, &lv).is_none(), "a reading that wobbles around 20 doesn't alert again");
        assert!(a.observe("m", "Mouse", 19, true, &lv).is_none(), "charging: no alert");
        assert!(a.observe("m", "Mouse", 20, false, &lv).is_some(), "after a charge it can alert again");
        assert!(a.observe("m", "Mouse", 40, false, &lv).is_none());
        assert!(a.observe("m", "Mouse", 17, false, &lv).is_some(), "climbing past 25 re-arms too");
        assert!(a.observe("other", "Keyboard", 15, false, &lv).is_some(), "per device");
    }

    #[test]
    fn levels_are_checked() {
        assert_eq!(levels(&[5, 20, 10]), vec![20, 10, 5]);
        assert_eq!(levels(&[15]), vec![15]);
        assert_eq!(levels(&[30, 15, 8, 4, 2]), vec![30, 15, 8, 4, 2]);
        for bad in [&[][..], &[0], &[60], &[20, 20], &[1, 2, 3, 4, 5, 6]] {
            assert_eq!(levels(bad), DEFAULT_LEVELS.to_vec(), "{bad:?}");
        }
        let mut a = Alerts::default();
        assert_eq!(a.observe("m", "M", 14, false, &levels(&[15])).map(|x| (x.level, x.last)), Some((15, true)));
    }

    #[test]
    fn schedule_backs_off_and_forgets() {
        let t0 = Instant::now();
        let mut s = Schedule::default();
        s.present(&["a".into(), "b".into()], t0);
        assert_eq!(s.due(t0), vec!["a".to_string(), "b".to_string()]);
        s.update("a", Reading::Level { percent: 50, charging: false }, t0);
        assert!(s.due(t0 + Duration::from_secs(299)).iter().all(|k| k != "a"));
        assert!(s.due(t0 + EVERY).contains(&"a".to_string()));
        let mut gaps = vec![];
        for _ in 0..6 {
            s.update("b", Reading::Asleep, t0);
            gaps.push(s.gap("b").unwrap().as_secs() / 60);
        }
        assert_eq!(gaps, vec![10, 20, 40, 40, 40, 40], "asleep: asked less and less, never more than every 40 min");
        s.update("b", Reading::Level { percent: 80, charging: false }, t0);
        assert_eq!(s.gap("b"), Some(EVERY), "an answer resets the pace");
        s.update("a", Reading::NoBattery, t0);
        assert!(s.due(t0 + MAX_BACKOFF * 2).iter().all(|k| k != "a"));
        s.present(&["a".into(), "b".into()], t0);
        assert!(s.gap("a").is_none(), "no battery: never asked again while plugged in");
        s.present(&[], t0);
        assert_eq!(s.next_wake(), None);
    }

    /// A fake device: answers questions from a script, keeps what it was sent.
    struct Fake {
        sent: Vec<Step>,
        answer: Box<dyn FnMut(&Step) -> Vec<(u8, Vec<u8>)>>,
        queue: VecDeque<(u8, Vec<u8>)>,
    }
    impl Link for Fake {
        fn send(&mut self, step: &Step) -> Result<(), String> {
            self.sent.push(step.clone());
            let a = (self.answer)(step);
            self.queue.extend(a);
            Ok(())
        }
        fn recv(&mut self, _: Duration) -> Option<(u8, Vec<u8>)> {
            self.queue.pop_front()
        }
    }

    fn atk_reply(cmd: u8, a: u8, b: u8) -> Vec<u8> {
        let mut f = vec![0u8; 16];
        f[0] = cmd;
        f[4] = 2;
        f[5] = a;
        f[6] = b;
        let sum: u32 = 8 + f[..15].iter().map(|&x| u32::from(x)).sum::<u32>();
        f[15] = (0x55u32.wrapping_sub(sum & 0xff) & 0xff) as u8;
        f
    }

    #[test]
    fn atk_asks_online_first_and_never_more_when_asleep() {
        let mut asleep = Fake { sent: vec![], answer: Box::new(|_| vec![(8, atk_reply(0x03, 0, 0))]), queue: VecDeque::new() };
        assert_eq!(probe_atk(&mut asleep), Reading::Asleep);
        assert_eq!(asleep.sent.len(), 1, "only GetMouseOnline, answered by the receiver itself");
        let mut awake = Fake {
            sent: vec![],
            answer: Box::new(|s| match s {
                Step::OutputTo { data, .. } if data[0] == 0x03 => vec![(8, atk_reply(0x03, 1, 0))],
                Step::OutputTo { data, .. } if data[0] == 0x04 => vec![(8, vec![0; 16]), (8, atk_reply(0x04, 14, 0))],
                _ => vec![],
            }),
            queue: VecDeque::new(),
        };
        assert_eq!(probe_atk(&mut awake), Reading::Level { percent: 14, charging: false });
        // Both questions are frames the ATK guard (the desktop's) lets through without any grant.
        for s in &awake.sent {
            let Step::OutputTo { usage_page, usage, report_id, data } = s else { panic!() };
            assert_eq!((*usage_page, *usage, *report_id), (0xff02, 0x0002, 0x08));
            hid::atk_frame_allowed(0x08, data, crate::advanced::Active::NONE).unwrap();
        }
    }

    #[test]
    fn hidpp_finds_the_battery_feature_once() {
        let answer = |s: &Step| {
            let Step::Output { report_id, data } = s else { return vec![] };
            assert_eq!(*report_id, 0x10);
            assert_eq!(data[2] & 0x0f, SW_ID);
            match (data[1], data[2] >> 4, data[3], data[4]) {
                (0x00, 0, 0x10, 0x04) => vec![(0x11, { let mut r = vec![1, 0x00, data[2], 0x06, 0, 0]; r.resize(19, 0); r })],
                (0x06, 1, ..) => vec![(0x10, vec![1, 0x06, data[2], 62, 4, 1])],
                _ => vec![],
            }
        };
        let mut f = Fake { sent: vec![], answer: Box::new(answer), queue: VecDeque::new() };
        let mut cache = None;
        assert_eq!(probe_hidpp(&mut f, 1, false, &mut cache), Reading::Level { percent: 62, charging: true });
        assert_eq!(cache, Some((UNIFIED_BATTERY, 0x06)));
        assert_eq!(f.sent.len(), 2);
        assert_eq!(probe_hidpp(&mut f, 1, false, &mut cache), Reading::Level { percent: 62, charging: true });
        assert_eq!(f.sent.len(), 3, "the feature index is remembered");
    }

    #[test]
    fn hidpp_asleep_and_no_battery() {
        // The receiver answers for a sleeping mouse with an HID++ 1.0 error.
        let mut asleep = Fake { sent: vec![], answer: Box::new(|s| { let Step::Output { data, .. } = s else { return vec![] }; vec![(0x10, vec![1, 0x8f, 0x00, data[2], 0x09, 0])] }), queue: VecDeque::new() };
        assert_eq!(probe_hidpp(&mut asleep, 1, false, &mut None), Reading::Asleep);
        assert_eq!(asleep.sent.len(), 1);
        // A device without either feature: index 0 for both.
        let mut none = Fake { sent: vec![], answer: Box::new(|s| { let Step::Output { data, .. } = s else { return vec![] }; vec![(0x10, vec![0xff, 0x00, data[2], 0, 0, 0])] }), queue: VecDeque::new() };
        assert_eq!(probe_hidpp(&mut none, 0xff, false, &mut None), Reading::NoBattery);
        // Silence.
        let mut quiet = Fake { sent: vec![], answer: Box::new(|_| vec![]), queue: VecDeque::new() };
        assert_eq!(probe_hidpp(&mut quiet, 1, true, &mut None), Reading::NoAnswer);
        let Step::Output { report_id, data } = &quiet.sent[0] else { panic!() };
        assert_eq!((*report_id, data.len()), (0x11, 19), "long-only devices get a long report");
    }

    #[test]
    fn which_devices_are_asked() {
        use crate::hid::{Collection, Summary};
        let col = |p: u16, u: u16| Collection { usage_page: p, usage: u, ..Default::default() };
        let s = |v: u16, p: u16, name: &str, cols: Vec<Collection>| Summary { key: "k".into(), vendor_id: v, product_id: p, product_name: name.into(), collections: cols };
        assert_eq!(kind_of(&s(0x373b, 0x12a2, "", vec![col(0xff02, 2)])), Some(Kind::Atk));
        assert_eq!(kind_of(&s(0x046d, 0xc54d, "USB Receiver", vec![col(0xff00, 1), col(0xff00, 2)])), Some(Kind::Hidpp { index: 1, long: false }));
        assert_eq!(kind_of(&s(0x046d, 0xc09b, "G502", vec![col(0xff00, 2)])), Some(Kind::Hidpp { index: 0xff, long: true }));
        assert_eq!(kind_of(&s(0x1532, 0x00b7, "Razer", vec![col(0x000c, 1)])), None);
        assert_eq!(display_name(&s(0x046d, 0xc54d, "USB Receiver", vec![])), "Your Logitech mouse");
        assert_eq!(display_name(&s(0x373b, 0x1278, "ATK X1", vec![])), "ATK X1");
    }
}
