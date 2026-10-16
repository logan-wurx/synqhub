//! Screen sync across lights (wave L5): one sampler reads the chosen screen edge into one colour per light (the lights
//! in order along the edge, the first at the bottom), and each light gets its colour at its own pace from a thread of
//! its own, so a slow light never holds the others back: Wi-Fi lights through their brand's messages (net/colour.rs),
//! USB hubs through one static colour per chosen channel (hubframes.rs, held to the page's bytes). Hue lights in the chosen Entertainment area share
//! one DTLS stream (hue.rs) at 25 messages a second; any other Hue light gets its bridge's REST at a gentler pace.
//! Govee lamps keep their own Bluetooth sync (govee/mod.rs); the Lights view starts both.
//!
//! The same safeguards as the Govee sync: it stops when the screen locks, the PC sleeps or the displays change; a black
//! or failed grab holds the last colours (black is never sent); a light that fails twice in a row is let go and the page
//! told; when none is left the sync stops. Nothing runs unless sync is on, and Stop ends it at once.

#![cfg_attr(not(windows), allow(dead_code))]

use super::net::colour;
use crate::lighting::screen::Edge;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// A light in the sync, as the page names it.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub key: String,
    pub brand: String,
    pub id: String,
    pub sub: Option<String>,
    pub mac: Option<String>,
    pub model: String,
    /// A USB hub (`brand` "hub", `id` "vid:pid"): its chosen channels and their LED counts.
    pub channels: Option<Vec<(u8, u16)>>,
}

impl Member {
    /// Whether the bridge can put a colour on it (a hub in the table with channels, or a Wi-Fi light that takes colours).
    fn can_follow(&self) -> bool {
        if self.brand == "hub" {
            return hub_model(&self.id).is_some() && self.channels.as_ref().is_some_and(|c| !c.is_empty());
        }
        !colour::colour(&self.brand, self.sub.as_deref(), self.mac.as_deref(), &self.model, 0, [255, 255, 255]).is_empty()
    }
}

fn hub_model(id: &str) -> Option<&'static crate::lighting::hidrgb::Model> {
    let (vid, pid) = id.split_once(':')?;
    crate::lighting::hidrgb::model(u16::from_str_radix(vid, 16).ok()?, u16::from_str_radix(pid, 16).ok()?)
}

/// Puts one colour on a light: a Wi-Fi light's messages, or a hub's reports on each chosen channel (Corsair answers
/// each report, and the answer is read so the next isn't taken for it). Every message passes its guard.
#[cfg_attr(not(windows), allow(dead_code))]
fn put(m: &Member, seq: u8, rgb: [u8; 3]) -> Result<(), String> {
    if m.brand == "hub" {
        let model = hub_model(&m.id).ok_or("Not a hub SYNQ drives.")?;
        let (vid, pid) = m.id.split_once(':').ok_or("A hub's id is vid:pid.")?;
        for &(ch, leds) in m.channels.as_deref().unwrap_or_default() {
            for f in crate::lighting::hubframes::colour_frames(model, ch, rgb, leds).ok_or("That channel or LED count isn't one this hub has.")? {
                crate::lighting::hidrgb::write(vid, pid, f.report_id, &f.data)?;
                if model.family == "corsair-node" {
                    crate::lighting::hidrgb::read(vid, pid, 50)?;
                }
            }
        }
        return Ok(());
    }
    colour::colour(&m.brand, m.sub.as_deref(), m.mac.as_deref(), &m.model, seq, rgb).iter().try_for_each(|msg| super::net::send_checked(&m.brand, &m.id, msg).map(|_| ()))
}

/// A Hue bridge's Entertainment area to stream to.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct HueArea {
    pub bridge: String,
    pub area: String,
    pub lights: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Running {
    pub members: Vec<String>,
    pub edge: Edge,
    pub vivid: bool,
    /// The monitor read (its id from `screen::monitors`); None: the primary.
    pub monitor: Option<String>,
}

pub enum Event {
    /// The colours sent (or held: `blind`), in the members' order.
    Colours { keys: Vec<String>, colours: Vec<[u8; 3]>, blind: bool },
    /// A light was let go (it failed twice in a row).
    Dropped { key: String, why: String },
    Stopped { why: String },
}

pub type Emit = Arc<dyn Fn(Event) + Send + Sync>;

/// Least time between two colours to one light, by brand (Hue's REST: the bridge takes about ten a second in all).
pub fn pace(brand: &str) -> Duration {
    Duration::from_millis(match brand {
        "hue" => 150,
        "twinkly" => 250,
        "elgato" => 150,
        "lifx" => 50,
        "hub" => 200,
        _ => 100,
    })
}

/// Whether two colours differ enough to send (small changes would only flood the lights).
pub fn moved(a: [u8; 3], b: [u8; 3]) -> bool {
    a.iter().zip(b).any(|(x, y)| x.abs_diff(y) > 6)
}

struct Handle {
    stop: Arc<AtomicBool>,
    info: Running,
}

fn current() -> &'static Mutex<Option<Handle>> {
    static C: OnceLock<Mutex<Option<Handle>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

pub fn running() -> Option<Running> {
    current().lock().ok()?.as_ref().map(|h| h.info.clone())
}

pub fn stop() {
    if let Ok(mut c) = current().lock() {
        if let Some(h) = c.take() {
            h.stop.store(true, Ordering::SeqCst);
        }
    }
}

/// Starts screen sync on these lights (a running one is stopped first).
pub fn start(members: Vec<Member>, edge: Edge, vivid: bool, monitor: Option<String>, area: Option<HueArea>, emit: Emit) -> Result<(), String> {
    stop();
    let members: Vec<Member> = members.into_iter().filter(Member::can_follow).collect();
    if members.is_empty() {
        return Err("None of these lights can follow the screen.".into());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let sampler_on = monitor.clone();
    let info = Running { members: members.iter().map(|m| m.key.clone()).collect(), edge, vivid, monitor };
    *current().lock().map_err(|_| "sync poisoned")? = Some(Handle { stop: stop.clone(), info });
    imp::spawn(members, edge, vivid, sampler_on.as_deref(), area, stop, emit)
}

#[cfg(windows)]
mod imp {
    use super::super::net::hue::Stream;
    use super::{moved, pace, put, Emit, Event, HueArea, Member};
    use crate::lighting::screen::{self, Edge, Sampler, FAST, SLOW, STILL_AFTER};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Condvar, Mutex};
    use std::time::{Duration, Instant};

    /// One light's latest colour, waiting for its thread.
    type Slot = Arc<(Mutex<Option<[u8; 3]>>, Condvar)>;

    pub fn spawn(members: Vec<Member>, edge: Edge, vivid: bool, monitor: Option<&str>, area: Option<HueArea>, stop: Arc<AtomicBool>, emit: Emit) -> Result<(), String> {
        let sampler = Sampler::new(edge, members.len(), monitor)?;
        std::thread::Builder::new()
            .name("net-sync".into())
            .spawn(move || {
                let why = run(sampler, &members, vivid, area, &stop, &emit);
                stop.store(true, Ordering::SeqCst);
                emit(Event::Stopped { why });
            })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// The streamed area's lights (by member index and Hue light number) and the slot they read from.
    struct Streamed {
        lights: Vec<(usize, u16)>,
        slot: Arc<Mutex<Vec<[u8; 3]>>>,
    }

    fn run(mut sampler: Sampler, members: &[Member], vivid: bool, area: Option<HueArea>, stop: &Arc<AtomicBool>, emit: &Emit) -> String {
        let displays = screen::display_signature();
        let (dropped_tx, dropped_rx) = mpsc::channel::<(usize, String)>();
        // Hue lights in the chosen area go through the stream; every other light gets a thread of its own.
        let streamed: Option<Streamed> = area.as_ref().map(|a| Streamed {
            lights: members
                .iter()
                .enumerate()
                .filter(|(_, m)| m.brand == "hue" && m.id == a.bridge && m.sub.as_ref().is_some_and(|s| a.lights.contains(s)))
                .filter_map(|(i, m)| Some((i, m.sub.as_ref()?.parse().ok()?)))
                .collect(),
            slot: Arc::new(Mutex::new(vec![[0; 3]; members.len()])),
        });
        let in_stream = |i: usize| streamed.as_ref().is_some_and(|s| s.lights.iter().any(|(j, _)| *j == i));
        let mut slots: Vec<Option<Slot>> = Vec::new();
        for (i, m) in members.iter().enumerate() {
            if in_stream(i) {
                slots.push(None);
                continue;
            }
            let slot: Slot = Arc::new((Mutex::new(None), Condvar::new()));
            slots.push(Some(slot.clone()));
            let (m, stop, tx) = (m.clone(), stop.clone(), dropped_tx.clone());
            std::thread::spawn(move || sink(i, &m, &slot, &stop, &tx));
        }
        if let (Some(a), Some(s)) = (area, streamed.as_ref()) {
            if !s.lights.is_empty() {
                let (lights, slot, stop, tx) = (s.lights.clone(), s.slot.clone(), stop.clone(), dropped_tx.clone());
                std::thread::spawn(move || stream(&a, &lights, &slot, &stop, &tx));
            }
        }
        drop(dropped_tx);

        let keys: Vec<String> = members.iter().map(|m| m.key.clone()).collect();
        let mut alive = vec![true; members.len()];
        let (mut shown, mut sent): (Vec<[u8; 3]>, Vec<[u8; 3]>) = (Vec::new(), vec![[0; 3]; members.len()]);
        let (mut blind_since, mut held) = (None::<Instant>, false);
        let mut changed = Instant::now();
        let mut clock = std::time::SystemTime::now();
        loop {
            let tick = Instant::now();
            if stop.load(Ordering::SeqCst) {
                return "Stopped.".into();
            }
            while let Ok((i, why)) = dropped_rx.try_recv() {
                if alive[i] {
                    alive[i] = false;
                    emit(Event::Dropped { key: keys[i].clone(), why });
                }
            }
            if !alive.iter().any(|a| *a) {
                return "None of the lights is answering.".into();
            }
            let now = std::time::SystemTime::now();
            if now.duration_since(clock).map(|d| d > Duration::from_secs(5)).unwrap_or(false) {
                return "The PC went to sleep.".into();
            }
            clock = now;
            if screen::secure_desktop() {
                return "The screen locked.".into();
            }
            if screen::display_signature() != displays {
                return "The displays changed.".into();
            }
            match sampler.sample() {
                Ok(c) if !screen::blind(&c) => {
                    blind_since = None;
                    shown = screen::smooth(&shown, &c, vivid);
                    let mut any = held;
                    for (i, colour) in shown.iter().enumerate().take(members.len()) {
                        if !alive[i] || !moved(sent[i], *colour) && !held {
                            continue;
                        }
                        sent[i] = *colour;
                        any = true;
                        if let Some(Some(slot)) = slots.get(i) {
                            *slot.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(*colour);
                            slot.1.notify_one();
                        }
                        if let Some(s) = &streamed {
                            if let Ok(mut v) = s.slot.lock() {
                                v[i] = *colour;
                            }
                        }
                    }
                    if any {
                        held = false;
                        changed = Instant::now();
                        emit(Event::Colours { keys: keys.clone(), colours: sent.clone(), blind: false });
                    }
                }
                // Black (a protected or exclusive-fullscreen window) or a failed grab: the lights keep their colours,
                // and after a second the page says so. Black is never sent.
                _ => {
                    let since = *blind_since.get_or_insert_with(Instant::now);
                    if !held && since.elapsed() > Duration::from_secs(1) {
                        held = true;
                        emit(Event::Colours { keys: keys.clone(), colours: sent.clone(), blind: true });
                    }
                }
            }
            let pace = if changed.elapsed() > STILL_AFTER { SLOW } else { FAST };
            std::thread::sleep(pace.saturating_sub(tick.elapsed()));
        }
    }

    /// One light: waits for a new colour, sends it at the brand's pace; two failures in a row let it go.
    fn sink(i: usize, m: &Member, slot: &Slot, stop: &AtomicBool, dropped: &mpsc::Sender<(usize, String)>) {
        let mut failures = 0;
        let mut seq = 0u8;
        while !stop.load(Ordering::SeqCst) {
            let next = {
                let (lock, cv) = &**slot;
                let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
                let (mut guard, _) = cv.wait_timeout_while(guard, Duration::from_millis(250), |c| c.is_none()).unwrap_or_else(|e| e.into_inner());
                guard.take()
            };
            let Some(rgb) = next else { continue };
            seq = seq.wrapping_add(1);
            let started = Instant::now();
            match put(m, seq, rgb) {
                Ok(()) => failures = 0,
                Err(why) => {
                    failures += 1;
                    if failures >= 2 {
                        let _ = dropped.send((i, why));
                        return;
                    }
                }
            }
            std::thread::sleep(pace(&m.brand).saturating_sub(started.elapsed()));
        }
    }

    /// The Hue area's stream: every light in it, 25 times a second (the bridge expects a steady stream).
    fn stream(a: &HueArea, lights: &[(usize, u16)], slot: &Mutex<Vec<[u8; 3]>>, stop: &AtomicBool, dropped: &mpsc::Sender<(usize, String)>) {
        let mut s = match Stream::open(&a.bridge, &a.area) {
            Ok(s) => s,
            Err(why) => {
                for (i, _) in lights {
                    let _ = dropped.send((*i, why.clone()));
                }
                return;
            }
        };
        let mut failures = 0;
        while !stop.load(Ordering::SeqCst) {
            let started = Instant::now();
            let colours: Vec<(u16, [u8; 3])> = {
                let v = slot.lock().unwrap_or_else(|e| e.into_inner());
                lights.iter().map(|(i, id)| (*id, v[*i])).collect()
            };
            if let Err(why) = s.send(&colours) {
                failures += 1;
                if failures >= 2 {
                    for (i, _) in lights {
                        let _ = dropped.send((*i, why.clone()));
                    }
                    return;
                }
            } else {
                failures = 0;
            }
            std::thread::sleep(Duration::from_millis(40).saturating_sub(started.elapsed()));
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{Emit, HueArea, Member};
    use crate::lighting::screen::Edge;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    pub fn spawn(_: Vec<Member>, _: Edge, _: bool, _: Option<&str>, _: Option<HueArea>, _: Arc<AtomicBool>, _: Emit) -> Result<(), String> {
        Err("Screen sync is in the Windows app for now.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pace_and_change() {
        assert!(pace("lifx") < pace("hue"));
        assert!(moved([0, 0, 0], [0, 0, 20]));
        assert!(!moved([10, 10, 10], [12, 9, 14]), "small wobbles aren't sent");
    }

    #[test]
    fn lights_that_cant_follow_are_left_out() {
        let m = |brand: &str, model: &str| Member { key: brand.into(), brand: brand.into(), id: "x".into(), sub: None, mac: None, model: model.into(), channels: None };
        let emit: Emit = Arc::new(|_| {});
        let hub = Member { brand: "hub".into(), id: "1e71:2019".into(), channels: Some(vec![]), ..m("hub", "") };
        let e = start(vec![m("yeelight", "color"), m("elgato", "Elgato Key Light"), hub], Edge::Left, false, None, None, emit).unwrap_err();
        assert!(e.contains("None of these lights"));
        assert!(running().is_none());
    }
}
