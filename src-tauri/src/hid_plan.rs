//! Shared HID nodes: which collections of one Linux hidraw node SYNQ may use, and exactly which
//! report ids that allows.
//!
//! On Windows every top-level collection is its own handle, a collection refuses report ids it doesn't
//! own, and Windows keeps the keyboard and mouse collections to itself. On Linux one hidraw node carries
//! a whole USB interface: reading it returns the input reports of every collection on it (keystrokes and
//! mouse movement included), and a write reaches whichever collection its report id names. So before a
//! node is opened, the bridge plans it from its report descriptor (`plan`), and then:
//!
//! - an input report is forwarded only when its report id belongs to an allowed collection and to no
//!   other collection on the node (`NodePlan::route_input`); everything else is dropped in Rust and never
//!   reaches the page;
//! - an output or feature report is written only when its id is that collection's own and not another
//!   collection's (`NodePlan::output`, `NodePlan::feature`), padded to the length the descriptor gives and
//!   never longer (`NodePlan::frame`), as Windows sizes it;
//! - a typing, pointing, consumer, digitizer or FIDO collection (`protected`) is never read or written:
//!   it opens feature-only, and only where the per-collection rules (`hid::collection_access`, unchanged)
//!   already say feature-only (the Razer mice and keyboards, Royal Kludge BeiYing); otherwise it stays shut;
//! - when the reports carry no report ids and another collection on the node also has input reports, an
//!   input report can't be told apart, so the node is used for feature reports only, or refused;
//! - Logitech's DJ collection (`DJ_COLLECTION`), where Linux's receiver driver puts the paired keyboard's
//!   keys and the mouse's movement, is never opened, and DJ reports 0x20 / 0x21 are never forwarded.
//!
//! Pure functions only, so all of it is tested on every OS with synthetic report descriptors.

use crate::hid::{Access, Collection, Report, descriptor_uses_report_ids, parse_descriptor};
use std::collections::{BTreeMap, BTreeSet};

pub const LOGITECH: u16 = 0x046d;
/// Logitech receivers' DJ collection. With Linux's hid-logitech-dj driver loaded (every distribution
/// loads it) the receiver sends the paired keyboard's keys and the mouse's movement here.
pub const DJ_COLLECTION: (u16, u16) = (0xff00, 0x0004);
/// Logitech DJ short and long reports: never forwarded, whichever collection declares them.
pub const DJ_REPORTS: [u8; 2] = [0x20, 0x21];
/// Largest report (bytes after the report id) the bridge reads, writes or asks for on a shared node.
pub const MAX_REPORT: usize = 4096;

/// Collections that carry what a person types, points, presses or touches, and FIDO security keys:
/// every Generic Desktop usage except 0 (the undefined usage some keyboards' configuration channel
/// uses), and the Keyboard/Keypad, Consumer, Digitizer and FIDO pages.
pub fn protected(usage_page: u16, usage: u16) -> bool {
    match usage_page {
        0x0001 => usage != 0,
        0x0007 | 0x000c | 0x000d | 0xf1d0 => true,
        _ => false,
    }
}

/// The access a collection gets on a shared node: what `hid::collection_access` says, except that a
/// protected collection is never read or written (feature-only where the rules already say so, else
/// shut), and Logitech's DJ collection is shut. The one exception to "protected": a game controller's own
/// Gamepad / Joystick collection (src/pads.rs, ids in the controller table only), whose reports are still
/// routed per report id like everything else here, so a keyboard or mouse collection on the same node is
/// never forwarded.
pub fn node_access(vendor_id: u16, product_id: u16, usage_page: u16, usage: u16, access: Access) -> Option<Access> {
    if vendor_id == LOGITECH && (usage_page, usage) == DJ_COLLECTION {
        return None;
    }
    if crate::pads::pad_collection(vendor_id, product_id, usage_page, usage) {
        return Some(access);
    }
    if protected(usage_page, usage) && access != Access::FeatureOnly {
        return None;
    }
    Some(access)
}

/// One report SYNQ may use on a node: its id, the collection it belongs to, and its length in bytes
/// (without the id).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Route {
    pub report_id: u8,
    pub usage_page: u16,
    pub usage: u16,
    pub len: usize,
}

/// What SYNQ may do on one node.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NodePlan {
    /// The descriptor declares report ids (every report then starts with its id).
    pub numbered: bool,
    /// The collections opened on this node, with the access they get here.
    pub open: Vec<(u16, u16, Access)>,
    /// Input reports that are forwarded. Empty: the node is never read.
    pub inputs: Vec<Route>,
    /// Output reports that may be written.
    pub outputs: Vec<Route>,
    /// Feature reports that may be set and got.
    pub features: Vec<Route>,
    /// What was shut or narrowed, and why.
    pub notes: Vec<String>,
}

impl NodePlan {
    /// Whether anything on the node is read (a reader thread runs only then).
    pub fn reads(&self) -> bool {
        !self.inputs.is_empty()
    }

    /// The report a read returned, as (report id, payload, usage page, usage) of the allowed collection
    /// it belongs to; None means it is dropped here and goes nowhere.
    pub fn route_input<'a>(&self, buf: &'a [u8]) -> Option<(u8, &'a [u8], u16, u16)> {
        if self.numbered {
            let (&id, rest) = buf.split_first()?;
            if id == 0 {
                return None;
            }
            let r = self.inputs.iter().find(|r| r.report_id == id)?;
            Some((id, rest, r.usage_page, r.usage))
        } else {
            let r = self.inputs.first()?;
            Some((0, buf, r.usage_page, r.usage))
        }
    }

    /// The output report `report_id` of collection (usage_page, usage), if it may be written.
    pub fn output(&self, usage_page: u16, usage: u16, report_id: u8) -> Option<&Route> {
        self.outputs.iter().find(|r| r.report_id == report_id && (r.usage_page, r.usage) == (usage_page, usage))
    }

    /// The feature report `report_id` of collection (usage_page, usage), if it may be set and got.
    pub fn feature(&self, usage_page: u16, usage: u16, report_id: u8) -> Option<&Route> {
        self.features.iter().find(|r| r.report_id == report_id && (r.usage_page, r.usage) == (usage_page, usage))
    }

    /// Bytes for one read (the largest forwarded input report, with its id).
    pub fn read_buffer(&self) -> usize {
        self.inputs.iter().map(|r| r.len + 1).max().unwrap_or(0).clamp(64, MAX_REPORT + 1)
    }

    /// One output or feature report as the node takes it: the report id, the data, then zeros up to the
    /// report's length (Windows sizes reports the same way). Longer data is refused.
    pub fn frame(route: &Route, data: &[u8]) -> Result<Vec<u8>, String> {
        if data.len() > route.len {
            return Err(format!(
                "Report 0x{:02x} of {:04x}:{:04x} is {} bytes; {} bytes were given.",
                route.report_id,
                route.usage_page,
                route.usage,
                route.len,
                data.len()
            ));
        }
        let mut buf = Vec::with_capacity(route.len + 1);
        buf.push(route.report_id);
        buf.extend_from_slice(data);
        buf.resize(route.len + 1, 0);
        Ok(buf)
    }
}

/// One top-level collection with the report ids it declares (its child collections included) and how
/// many bits each has.
#[derive(Default)]
struct Top {
    usage_page: u16,
    usage: u16,
    input: BTreeMap<u8, u32>,
    output: BTreeMap<u8, u32>,
    feature: BTreeMap<u8, u32>,
}

fn bits(r: &Report) -> u32 {
    r.items.iter().fold(0u32, |sum, i| sum.saturating_add(i.report_size.saturating_mul(i.report_count)))
}

fn gather(c: &Collection, t: &mut Top) {
    for r in &c.input_reports {
        *t.input.entry(r.report_id).or_default() += bits(r);
    }
    for r in &c.output_reports {
        *t.output.entry(r.report_id).or_default() += bits(r);
    }
    for r in &c.feature_reports {
        *t.feature.entry(r.report_id).or_default() += bits(r);
    }
    for child in &c.children {
        gather(child, t);
    }
}

fn tops(desc: &[u8]) -> Vec<Top> {
    parse_descriptor(desc)
        .iter()
        .map(|c| {
            let mut t = Top { usage_page: c.usage_page, usage: c.usage, ..Default::default() };
            gather(c, &mut t);
            t
        })
        .collect()
}

fn reads(a: Option<Access>) -> bool {
    matches!(a, Some(Access::Full | Access::InputOnly))
}

fn writes(a: Option<Access>) -> bool {
    a == Some(Access::Full)
}

fn takes_features(a: Option<Access>) -> bool {
    matches!(a, Some(Access::Full | Access::FeatureOnly))
}

/// Plans one node from its report descriptor. `wanted` is the collections of one device group on this
/// node with the access `hid::collection_access` gives them; every other collection in the descriptor
/// counts as someone else's. Refused when the descriptor can't be read, doesn't hold a wanted
/// collection, or nothing can be used without touching another collection's reports.
pub fn plan(vendor_id: u16, product_id: u16, desc: &[u8], wanted: &[(u16, u16, Access)]) -> Result<NodePlan, String> {
    let tops = tops(desc);
    if tops.is_empty() {
        return Err("The device's report descriptor couldn't be read, so it isn't opened.".into());
    }
    let numbered = descriptor_uses_report_ids(desc);
    let mut plan = NodePlan { numbered, ..Default::default() };
    let mut role: Vec<Option<Access>> = vec![None; tops.len()];
    for &(page, usage, access) in wanted {
        let found: Vec<usize> = tops.iter().enumerate().filter(|(_, t)| (t.usage_page, t.usage) == (page, usage)).map(|(i, _)| i).collect();
        if found.is_empty() {
            plan.notes.push(format!("{page:04x}:{usage:04x} isn't in the report descriptor: not opened"));
            continue;
        }
        let Some(a) = node_access(vendor_id, product_id, page, usage, access) else {
            plan.notes.push(format!("{page:04x}:{usage:04x} carries typing, pointing or a receiver's paired devices: never opened here"));
            continue;
        };
        for i in found {
            role[i] = Some(a);
        }
        if !plan.open.contains(&(page, usage, a)) {
            plan.open.push((page, usage, a));
        }
    }
    if plan.open.is_empty() {
        return Err("Nothing SYNQ may use is on this interface, so it isn't opened.".into());
    }

    // Report ids that a collection SYNQ doesn't read (or write, or use features of) declares.
    let others = |pick: fn(&Top) -> &BTreeMap<u8, u32>, ours: fn(Option<Access>) -> bool| -> BTreeSet<u8> {
        tops.iter().zip(&role).filter(|(_, r)| !ours(**r)).flat_map(|(t, _)| pick(t).keys().copied()).collect()
    };
    let others_in = others(|t| &t.input, reads);
    let others_out = others(|t| &t.output, writes);
    let others_feat = others(|t| &t.feature, takes_features);
    // Without report ids, an input report on a node that another collection also reports on can't be
    // told apart: features only.
    let shared_unnumbered = !numbered && !others_in.is_empty();
    if shared_unnumbered {
        plan.notes.push("reports have no ids and another collection reports here too: feature reports only".into());
    }
    let usable = |id: u8, b: u32| numbered == (id != 0) && b > 0 && (b as usize).div_ceil(8) <= MAX_REPORT;
    let route = |t: &Top, id: u8, b: u32| Route { report_id: id, usage_page: t.usage_page, usage: t.usage, len: (b as usize).div_ceil(8) };
    for (t, &r) in tops.iter().zip(&role) {
        if reads(r) && !shared_unnumbered {
            for (&id, &b) in &t.input {
                let dj = vendor_id == LOGITECH && DJ_REPORTS.contains(&id);
                if usable(id, b) && !others_in.contains(&id) && !dj && !plan.inputs.iter().any(|x| x.report_id == id) {
                    plan.inputs.push(route(t, id, b));
                }
            }
        }
        if writes(r) && !shared_unnumbered && (numbered || others_out.is_empty()) {
            for (&id, &b) in &t.output {
                if usable(id, b) && !others_out.contains(&id) {
                    plan.outputs.push(route(t, id, b));
                }
            }
        }
        if takes_features(r) && (numbered || others_feat.is_empty()) {
            for (&id, &b) in &t.feature {
                if usable(id, b) && !others_feat.contains(&id) {
                    plan.features.push(route(t, id, b));
                }
            }
        }
    }
    if plan.inputs.is_empty() && plan.outputs.is_empty() && plan.features.is_empty() {
        return Err("No report on this interface can be used without touching another collection's, so it isn't opened.".into());
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hid::collection_access;

    // ---- a tiny report-descriptor writer

    /// A top-level application collection.
    fn coll(page: u16, usage: u16, body: &[u8]) -> Vec<u8> {
        let mut d = vec![0x06, page as u8, (page >> 8) as u8, 0x0a, usage as u8, (usage >> 8) as u8, 0xa1, 0x01];
        d.extend_from_slice(body);
        d.push(0xc0);
        d
    }

    fn id(n: u8) -> Vec<u8> {
        vec![0x85, n]
    }

    /// `bytes` 8-bit fields of one main item (0x81 input, 0x91 output, 0xb1 feature).
    fn item(main: u8, bytes: u8) -> Vec<u8> {
        vec![0x15, 0x00, 0x26, 0xff, 0x00, 0x75, 0x08, 0x95, bytes, 0x09, 0x01, main, 0x02]
    }
    fn input(bytes: u8) -> Vec<u8> {
        item(0x81, bytes)
    }
    fn output(bytes: u8) -> Vec<u8> {
        item(0x91, bytes)
    }
    fn feature(bytes: u8) -> Vec<u8> {
        item(0xb1, bytes)
    }

    fn cat(parts: &[Vec<u8>]) -> Vec<u8> {
        parts.concat()
    }

    /// A boot-style keyboard: 8-byte key report, 1-byte LED output report.
    fn keyboard(rid: Option<u8>) -> Vec<u8> {
        let mut body = rid.map(id).unwrap_or_default();
        body.extend(input(8));
        body.extend(output(1));
        coll(0x0001, 0x0006, &body)
    }

    /// A mouse: buttons and movement in a pointer sub-collection.
    fn mouse(rid: Option<u8>, feature_bytes: Option<u8>) -> Vec<u8> {
        let mut body = rid.map(id).unwrap_or_default();
        body.extend([0x09, 0x01, 0xa1, 0x00]); // Usage (Pointer), Collection (Physical)
        body.extend(input(5));
        body.push(0xc0);
        if let Some(n) = feature_bytes {
            body.extend(feature(n));
        }
        coll(0x0001, 0x0002, &body)
    }

    fn consumer(rid: Option<u8>) -> Vec<u8> {
        let mut body = rid.map(id).unwrap_or_default();
        body.extend(input(2));
        coll(0x000c, 0x0001, &body)
    }

    fn vendor(page: u16, usage: u16, rid: Option<u8>, inp: u8, out: u8, feat: u8) -> Vec<u8> {
        let mut body = rid.map(id).unwrap_or_default();
        if inp > 0 {
            body.extend(input(inp));
        }
        if out > 0 {
            body.extend(output(out));
        }
        if feat > 0 {
            body.extend(feature(feat));
        }
        coll(page, usage, &body)
    }

    fn report(id: u8, len: usize) -> Vec<u8> {
        let mut r = vec![0x41u8; len + 1];
        r[0] = id;
        r
    }

    const FULL: Access = Access::Full;
    const FEAT: Access = Access::FeatureOnly;

    /// The planner never forwards a report id that a protected collection on the node declares, and a
    /// numbered read that isn't on the allowed list goes nowhere.
    fn assert_never_forwards_protected(vendor_id: u16, desc: &[u8], np: &NodePlan) {
        for t in tops(desc) {
            if !protected(t.usage_page, t.usage) {
                continue;
            }
            for (&rid, &b) in &t.input {
                let r = report(rid, (b as usize).div_ceil(8));
                if np.numbered {
                    assert!(np.route_input(&r).is_none(), "{vendor_id:04x}: input report {rid:#04x} of {:04x}:{:04x} was forwarded", t.usage_page, t.usage);
                } else {
                    // Unnumbered: the whole read is the report. If a protected collection reports here, nothing is read.
                    assert!(np.inputs.is_empty(), "unnumbered node with a typing/pointing collection must not be read");
                }
            }
            for &rid in t.output.keys() {
                assert!(np.outputs.iter().all(|r| r.report_id != rid), "output report {rid:#04x} of a protected collection is writable");
            }
        }
    }

    #[test]
    fn a_keyboard_on_the_same_node_is_never_forwarded() {
        // A typical gaming keyboard interface: NKRO keys (1), consumer keys (2), the vendor channel (6).
        let desc = cat(&[keyboard(Some(1)), consumer(Some(2)), vendor(0xff00, 0x0001, Some(6), 32, 32, 0)]);
        let np = plan(0x1234, 0, &desc, &[(0xff00, 0x0001, FULL)]).unwrap();
        assert!(np.numbered);
        assert_eq!(np.open, vec![(0xff00, 0x0001, FULL)]);
        assert_eq!(np.inputs, vec![Route { report_id: 6, usage_page: 0xff00, usage: 0x0001, len: 32 }]);
        assert!(np.route_input(&report(1, 8)).is_none(), "a key report");
        assert!(np.route_input(&report(2, 2)).is_none(), "a media key");
        assert!(np.route_input(&report(0, 8)).is_none(), "report id 0 on a numbered node");
        assert!(np.route_input(&report(7, 8)).is_none(), "an id nobody declares");
        assert!(np.route_input(&[]).is_none());
        let six = report(6, 32);
        let (rid, data, page, usage) = np.route_input(&six).unwrap();
        assert_eq!((rid, data.len(), page, usage), (6, 32, 0xff00, 0x0001));
        // The keyboard's LED report can't be written through the vendor channel.
        assert!(np.output(0xff00, 0x0001, 1).is_none());
        assert_eq!(np.output(0xff00, 0x0001, 6).map(|r| r.len), Some(32));
        assert_never_forwards_protected(0x1234, &desc, &np);
    }

    #[test]
    fn typing_and_pointing_collections_never_open_for_reading_even_when_the_rules_say_everything() {
        // Logitech and the Falchion get every collection from collection_access; on a shared node the
        // keyboard, mouse and consumer ones stay shut.
        for (page, usage) in [(0x0001, 0x0006), (0x0001, 0x0002), (0x0001, 0x0001), (0x0001, 0x0080), (0x000c, 0x0001), (0x0007, 0x0000), (0x000d, 0x0002), (0xf1d0, 0x0001)] {
            assert!(protected(page, usage), "{page:04x}:{usage:04x}");
            assert_eq!(node_access(0x046d, 0, page, usage, FULL), None);
            assert_eq!(node_access(0x046d, 0, page, usage, Access::InputOnly), None);
            assert_eq!(node_access(0x1532, 0, page, usage, FEAT), Some(FEAT), "feature-only stays feature-only");
        }
        for (page, usage) in [(0x0001, 0x0000), (0xff00, 0x0001), (0xff60, 0x0061), (0xff53, 0x0001)] {
            assert!(!protected(page, usage), "{page:04x}:{usage:04x}");
        }
        let desc = cat(&[keyboard(Some(1)), mouse(Some(2), None)]);
        assert!(plan(0x0b05, 0, &desc, &[(0x0001, 0x0006, FULL), (0x0001, 0x0002, FULL)]).is_err(), "nothing left to open");
    }

    #[test]
    fn a_logitech_receiver_forwards_hidpp_only() {
        // LIGHTSPEED / Unifying receiver interface 2: HID++ short (0x10), long (0x11), DJ (0x20 / 0x21).
        let desc = cat(&[
            vendor(0xff00, 0x0001, Some(0x10), 6, 6, 0),
            vendor(0xff00, 0x0002, Some(0x11), 19, 19, 0),
            coll(0xff00, 0x0004, &cat(&[id(0x20), input(14), output(14), id(0x21), input(31), output(31)])),
        ]);
        // What collection_access gives Logitech: every collection, all Full.
        let wanted: Vec<(u16, u16, Access)> = tops(&desc).iter().map(|t| (t.usage_page, t.usage, collection_access(0x046d, 0xc54d, t.usage_page, t.usage).unwrap())).collect();
        assert!(wanted.iter().all(|w| w.2 == FULL));
        let np = plan(0x046d, 0, &desc, &wanted).unwrap();
        assert_eq!(np.open, vec![(0xff00, 0x0001, FULL), (0xff00, 0x0002, FULL)], "the DJ collection is never opened");
        assert_eq!(np.inputs.iter().map(|r| r.report_id).collect::<Vec<_>>(), vec![0x10, 0x11]);
        for dj in DJ_REPORTS {
            assert!(np.route_input(&report(dj, 14)).is_none(), "DJ report {dj:#04x} carries the paired keyboard's keys");
            assert!(np.outputs.iter().all(|r| r.report_id != dj));
        }
        assert!(np.route_input(&report(0x10, 6)).is_some());
        assert!(np.route_input(&report(0x11, 19)).is_some());
        // DJ ids are dropped even if a receiver declared them in the HID++ collection itself.
        let odd = cat(&[coll(0xff00, 0x0001, &cat(&[id(0x10), input(6), output(6), id(0x20), input(14)]))]);
        let p = plan_ok(0x046d, &odd, &[(0xff00, 0x0001, FULL)]);
        assert_eq!(p.inputs.iter().map(|r| r.report_id).collect::<Vec<_>>(), vec![0x10]);
        assert!(p.route_input(&report(0x20, 14)).is_none());
    }

    fn plan_ok(vendor_id: u16, desc: &[u8], wanted: &[(u16, u16, Access)]) -> NodePlan {
        plan(vendor_id, 0, desc, wanted).unwrap()
    }

    #[test]
    fn a_receiver_with_keyboard_and_mouse_on_one_interface_forwards_neither() {
        // Some receivers put everything on one interface (ATK-style 8K dongles, many Chinese receivers).
        let desc = cat(&[mouse(Some(1), None), keyboard(Some(2)), consumer(Some(3)), vendor(0xff02, 0x0002, Some(8), 16, 16, 0)]);
        let np = plan_ok(0x373b, &desc, &[(0xff02, 0x0002, FULL)]);
        assert_eq!(np.inputs.iter().map(|r| r.report_id).collect::<Vec<_>>(), vec![8]);
        for rid in [1u8, 2, 3] {
            assert!(np.route_input(&report(rid, 8)).is_none(), "{rid}");
        }
        assert_never_forwards_protected(0x373b, &desc, &np);
    }

    #[test]
    fn an_id_a_keyboard_also_declares_is_dropped_and_refused() {
        // Broken descriptor: the vendor channel and the keyboard both declare input/output id 3.
        let desc = cat(&[keyboard(Some(3)), vendor(0xff00, 0x0001, Some(3), 8, 8, 0), vendor(0xff00, 0x0002, Some(4), 8, 8, 0)]);
        let np = plan_ok(0x1234, &desc, &[(0xff00, 0x0001, FULL), (0xff00, 0x0002, FULL)]);
        assert!(np.route_input(&report(3, 8)).is_none());
        assert!(np.output(0xff00, 0x0001, 3).is_none());
        assert!(np.route_input(&report(4, 8)).is_some());
        // When the shared id was the only one, the node is refused outright.
        let only = cat(&[keyboard(Some(3)), vendor(0xff00, 0x0001, Some(3), 8, 8, 0)]);
        assert!(plan(0x1234, 0, &only, &[(0xff00, 0x0001, FULL)]).is_err());
    }

    #[test]
    fn an_unnumbered_vendor_interface_on_its_own_is_read_whole() {
        // The Falchion's FF00:0001: 64-byte input and output, no report ids, alone on its interface.
        let desc = vendor(0xff00, 0x0001, None, 64, 64, 0);
        let np = plan_ok(0x0b05, &desc, &[(0xff00, 0x0001, FULL)]);
        assert!(!np.numbered);
        let mut echo = vec![0u8; 64];
        echo[0] = 0x12;
        let (rid, data, page, usage) = np.route_input(&echo).unwrap();
        assert_eq!((rid, data.len(), page, usage), (0, 64, 0xff00, 0x0001));
        assert_eq!(np.output(0xff00, 0x0001, 0).map(|r| r.len), Some(64));
        assert!(np.output(0xff00, 0x0001, 1).is_none());
    }

    #[test]
    fn unnumbered_reports_shared_with_a_keyboard_are_feature_only_or_refused() {
        // Invalid but real: two top-level collections without report ids on one interface.
        let desc = cat(&[keyboard(None), vendor(0xff00, 0x0001, None, 32, 32, 32)]);
        let np = plan_ok(0x1234, &desc, &[(0xff00, 0x0001, FULL)]);
        assert!(!np.reads(), "no reader: an unnumbered read could be a key report");
        assert!(np.route_input(&[0u8; 32]).is_none());
        assert!(np.outputs.is_empty(), "no output either: the device can't tell whose it is");
        assert_eq!(np.features.iter().map(|r| (r.report_id, r.len)).collect::<Vec<_>>(), vec![(0, 32)]);
        assert_never_forwards_protected(0x1234, &desc, &np);
        // Without a feature report of its own, there's nothing safe left: refused.
        let desc = cat(&[mouse(None, None), vendor(0xff00, 0x0001, None, 32, 32, 0)]);
        assert!(plan(0x1234, 0, &desc, &[(0xff00, 0x0001, FULL)]).is_err());
        // And a feature report the keyboard also has (unnumbered) can't be told apart either.
        let desc = cat(&[coll(0x0001, 0x0006, &cat(&[input(8), feature(4)])), vendor(0xff00, 0x0001, None, 32, 0, 32)]);
        assert!(plan(0x1234, 0, &desc, &[(0xff00, 0x0001, FULL)]).is_err());
    }

    #[test]
    fn a_feature_only_razer_mouse_collection_is_never_read() {
        // A Razer mouse interface: the mouse collection, no report ids, a 90-byte feature report.
        let desc = mouse(None, Some(90));
        let access = collection_access(0x1532, 0x00c1, 0x0001, 0x0002).unwrap();
        assert_eq!(access, FEAT);
        let np = plan_ok(0x1532, &desc, &[(0x0001, 0x0002, access)]);
        assert_eq!(np.open, vec![(0x0001, 0x0002, FEAT)]);
        assert!(!np.reads(), "movement and clicks are never read");
        assert!(np.outputs.is_empty());
        assert_eq!(np.feature(0x0001, 0x0002, 0).map(|r| r.len), Some(90));
        assert!(np.route_input(&[1, 2, 3, 4, 5]).is_none());
        // Opened Full by mistake it would still be shut: a mouse collection is protected.
        assert!(plan_ok_or_err(0x1532, &desc, &[(0x0001, 0x0002, FULL)]).is_err());
    }

    fn plan_ok_or_err(vendor_id: u16, desc: &[u8], wanted: &[(u16, u16, Access)]) -> Result<NodePlan, String> {
        plan(vendor_id, 0, desc, wanted)
    }

    #[test]
    fn a_vendor_group_sharing_a_node_with_a_feature_only_collection_never_reads_it() {
        // Numbered: the mouse (1) is another group's feature-only collection; the vendor channel (5) is this group's.
        let desc = cat(&[mouse(Some(1), Some(90)), vendor(0xff00, 0x0001, Some(5), 16, 16, 0)]);
        let vendor_group = plan_ok(0x1532, &desc, &[(0xff00, 0x0001, FULL)]);
        assert_eq!(vendor_group.inputs.iter().map(|r| r.report_id).collect::<Vec<_>>(), vec![5]);
        assert!(vendor_group.route_input(&report(1, 5)).is_none());
        assert!(vendor_group.feature(0xff00, 0x0001, 1).is_none(), "the mouse's feature report isn't the vendor group's");
        let mouse_group = plan_ok(0x1532, &desc, &[(0x0001, 0x0002, FEAT)]);
        assert!(!mouse_group.reads());
        assert_eq!(mouse_group.feature(0x0001, 0x0002, 1).map(|r| r.len), Some(90));
        assert!(mouse_group.output(0xff00, 0x0001, 5).is_none(), "the vendor channel isn't the mouse group's");
    }

    #[test]
    fn the_0x19f5_family_reads_its_usage_zero_channel_only() {
        // Generic Desktop usage 0 is the configuration channel; its keyboard and system control stay shut.
        let desc = cat(&[keyboard(Some(1)), coll(0x0001, 0x0080, &cat(&[id(3), input(1)])), coll(0x0001, 0x0000, &cat(&[id(5), input(63), output(63)]))]);
        let wanted: Vec<_> = tops(&desc).iter().filter_map(|t| collection_access(0x19f5, 0x6120, t.usage_page, t.usage).map(|a| (t.usage_page, t.usage, a))).collect();
        assert_eq!(wanted, vec![(0x0001, 0x0000, FULL)], "the rules themselves open usage 0 only");
        let np = plan_ok(0x19f5, &desc, &wanted);
        assert_eq!(np.inputs.iter().map(|r| r.report_id).collect::<Vec<_>>(), vec![5]);
        assert_never_forwards_protected(0x19f5, &desc, &np);
    }

    #[test]
    fn wooting_analog_is_read_and_never_written() {
        let desc = cat(&[keyboard(Some(1)), vendor(0xff54, 0x0001, Some(2), 32, 32, 0)]);
        let access = collection_access(0x31e3, 0x1322, 0xff54, 0x0001).unwrap();
        assert_eq!(access, Access::InputOnly);
        let np = plan_ok(0x31e3, &desc, &[(0xff54, 0x0001, access)]);
        assert_eq!(np.inputs.iter().map(|r| r.report_id).collect::<Vec<_>>(), vec![2]);
        assert!(np.outputs.is_empty() && np.features.is_empty());
        assert!(np.route_input(&report(1, 8)).is_none());
    }

    #[test]
    fn a_collection_missing_from_the_descriptor_or_an_unreadable_descriptor_is_refused() {
        let desc = cat(&[keyboard(Some(1)), vendor(0xff00, 0x0001, Some(2), 8, 8, 0)]);
        assert!(plan(0x4653, 0, &desc, &[(0xff60, 0x0061, FULL)]).is_err(), "QMK raw HID isn't there");
        assert!(plan(0x4653, 0, &[], &[(0xff60, 0x0061, FULL)]).is_err());
        assert!(plan(0x4653, 0, &[0x85], &[(0xff60, 0x0061, FULL)]).is_err(), "truncated");
        let p = plan_ok(0x4653, &desc, &[(0xff60, 0x0061, FULL), (0xff00, 0x0001, FULL)]);
        assert_eq!(p.open, vec![(0xff00, 0x0001, FULL)]);
        assert!(p.notes.iter().any(|n| n.contains("ff60:0061")));
    }

    #[test]
    fn frames_are_padded_to_the_report_and_never_longer() {
        let r = Route { report_id: 0x10, usage_page: 0xff00, usage: 0x0001, len: 6 };
        assert_eq!(NodePlan::frame(&r, &[0xff, 0x00, 0x0d]).unwrap(), vec![0x10, 0xff, 0x00, 0x0d, 0, 0, 0]);
        assert_eq!(NodePlan::frame(&r, &[1; 6]).unwrap().len(), 7);
        assert!(NodePlan::frame(&r, &[1; 7]).is_err());
        let unnumbered = Route { report_id: 0, usage_page: 0xff00, usage: 0x0001, len: 64 };
        let f = NodePlan::frame(&unnumbered, &[0x12, 0x00]).unwrap();
        assert_eq!((f.len(), f[0], f[1]), (65, 0, 0x12), "a leading 0 that the kernel doesn't send");
    }

    #[test]
    fn read_buffers_fit_the_largest_forwarded_report() {
        let desc = cat(&[vendor(0xff00, 0x0001, Some(1), 255, 0, 0), vendor(0xff00, 0x0002, Some(2), 8, 0, 0)]);
        let wanted = [(0xff00, 0x0001, FULL), (0xff00, 0x0002, FULL)];
        assert_eq!(plan_ok(0x1234, &desc, &wanted).read_buffer(), 256);
        let small = vendor(0xff00, 0x0001, Some(1), 8, 0, 0);
        assert_eq!(plan_ok(0x1234, &small, &[(0xff00, 0x0001, FULL)]).read_buffer(), 64);
    }

    /// Thousands of generated interfaces mixing keyboards, mice, consumer keys and vendor channels, with and
    /// without report ids (including colliding ids): whatever the planner decides, no report id a typing or
    /// pointing collection declares is ever forwarded or writable.
    /// A gamepad collection (Generic Desktop 0x05): input under `rid`, output under `rid + 1`, then the features.
    fn gamepad(rid: Option<u8>, inp: u8, out: u8, feat: &[(u8, u8)]) -> Vec<u8> {
        let mut body = rid.map(id).unwrap_or_default();
        body.extend(input(inp));
        if out > 0 {
            if let Some(r) = rid {
                body.extend(id(r + 1));
            }
            body.extend(output(out));
        }
        for &(fid, n) in feat {
            body.extend(id(fid));
            body.extend(feature(n));
        }
        coll(0x0001, 0x0005, &body)
    }

    /// What the bridge's rules give each collection of this descriptor for this pad (hid.rs `collection_access`).
    fn wanted_for(vid: u16, pid: u16, desc: &[u8]) -> Vec<(u16, u16, Access)> {
        tops(desc).iter().filter_map(|t| collection_access(vid, pid, t.usage_page, t.usage).map(|a| (t.usage_page, t.usage, a))).collect()
    }

    /// No typing, pointing or consumer report of the node is ever forwarded or writable: only the pad's own.
    fn assert_pad_forwards_only_itself(vid: u16, pid: u16, desc: &[u8], np: &NodePlan) {
        for t in tops(desc) {
            if crate::pads::pad_collection(vid, pid, t.usage_page, t.usage) {
                continue;
            }
            for (&rid, &b) in &t.input {
                let r = report(rid, (b as usize).div_ceil(8));
                assert!(!np.numbered || np.route_input(&r).is_none(), "input report {rid:#04x} of {:04x}:{:04x} was forwarded", t.usage_page, t.usage);
            }
            for &rid in t.output.keys() {
                assert!(np.outputs.iter().all(|r| r.report_id != rid), "output {rid:#04x} of {:04x}:{:04x} is writable", t.usage_page, t.usage);
            }
        }
    }

    #[test]
    fn a_pads_keyboard_and_mouse_on_the_same_node_are_never_forwarded() {
        // An 8BitDo Ultimate 2 in its Bluetooth mode (2DC8:6012) with keyboard and mouse emulation on one interface.
        let desc = cat(&[gamepad(Some(1), 11, 0, &[]), keyboard(Some(2)), mouse(Some(3), None), consumer(Some(4))]);
        let wanted = wanted_for(0x2dc8, 0x6012, &desc);
        assert_eq!(wanted, vec![(0x0001, 0x0005, Access::InputOnly)], "only the gamepad collection is wanted");
        let np = plan(0x2dc8, 0x6012, &desc, &wanted).unwrap();
        assert_eq!(np.inputs, vec![Route { report_id: 1, usage_page: 0x0001, usage: 0x0005, len: 11 }]);
        assert!(np.outputs.is_empty() && np.features.is_empty(), "input only: nothing to write");
        let one = report(1, 11);
        let (rid, data, page, usage) = np.route_input(&one).unwrap();
        assert_eq!((rid, data.len(), page, usage), (1, 11, 0x0001, 0x0005));
        for rid in [2, 3, 4, 0, 9] {
            assert!(np.route_input(&report(rid, 8)).is_none(), "report {rid}");
        }
        assert_pad_forwards_only_itself(0x2dc8, 0x6012, &desc, &np);
    }

    #[test]
    fn a_dualsense_node_reads_its_gamepad_reports_and_nothing_else() {
        // DualSense over USB: input 0x01, output 0x02, features 0x05 / 0x09 / 0x20 on the Gamepad collection.
        let desc = gamepad(Some(1), 63, 47, &[(0x05, 40), (0x09, 19), (0x20, 63)]);
        let wanted = wanted_for(0x054c, 0x0ce6, &desc);
        assert_eq!(wanted, vec![(0x0001, 0x0005, Access::Full)]);
        let np = plan(0x054c, 0x0ce6, &desc, &wanted).unwrap();
        assert_eq!(np.inputs.iter().map(|r| r.report_id).collect::<Vec<_>>(), vec![1]);
        assert_eq!(np.output(0x0001, 0x0005, 0x02).map(|r| r.len), Some(47));
        // The node plan lets the pad's own reports through; which of them may be sent is pads.rs's call.
        assert!(np.feature(0x0001, 0x0005, 0x09).is_some() && crate::pads::check_feature_get(crate::pads::Guard::Ds5, 0x09).is_err());
        assert!(crate::pads::check_feature_set(crate::pads::Guard::Ds5, 0x05, &[0; 40]).is_err());
    }

    #[test]
    fn a_gamepad_collection_stays_shut_for_ids_outside_the_controller_table() {
        // A wheel or an unknown device's joystick collection: still a protected Generic Desktop collection.
        for (vid, pid) in [(0x1234u16, 0x0001u16), (0x046d, 0xc24f), (0x3537, 0x1010)] {
            for usage in [0x0004u16, 0x0005] {
                assert_eq!(node_access(vid, pid, 0x0001, usage, Access::InputOnly), None, "{vid:04x}:{pid:04x} usage {usage:#x}");
            }
        }
        // Even for a pad, its keyboard and mouse collections stay protected.
        assert_eq!(node_access(0x054c, 0x0ce6, 0x0001, 0x0006, Access::InputOnly), None);
        assert_eq!(node_access(0x054c, 0x0ce6, 0x0001, 0x0002, Access::InputOnly), None);
    }

    #[test]
    fn an_unnumbered_pad_sharing_its_node_with_a_keyboard_is_refused() {
        // No report ids, and a keyboard reports on the same node: the pad's reports can't be told apart, and a
        // read-only pad has no feature reports to fall back to.
        let desc = cat(&[gamepad(None, 8, 0, &[]), keyboard(None)]);
        let wanted = wanted_for(0x2dc8, 0x6012, &desc);
        assert!(plan(0x2dc8, 0x6012, &desc, &wanted).is_err());
        // Alone on its node, an unnumbered pad is read whole.
        let alone = gamepad(None, 8, 0, &[]);
        let np = plan(0x2dc8, 0x6012, &alone, &wanted_for(0x2dc8, 0x6012, &alone)).unwrap();
        assert_eq!(np.route_input(&[1, 2, 3, 4, 5, 6, 7, 8]).map(|(id, d, ..)| (id, d.len())), Some((0, 8)));
    }

    #[test]
    fn a_steam_controller_forwards_its_vendor_input_only() {
        // Valve's pads report on 0xFF00:0x0001; their lizard-mode keyboard and mouse are never read.
        let desc = cat(&[vendor(0xff00, 0x0001, Some(1), 63, 0, 63), keyboard(Some(2)), mouse(Some(3), None)]);
        let wanted = wanted_for(0x28de, 0x1102, &desc);
        assert_eq!(wanted, vec![(0xff00, 0x0001, Access::InputOnly)]);
        let np = plan(0x28de, 0x1102, &desc, &wanted).unwrap();
        assert_eq!(np.inputs.iter().map(|r| r.report_id).collect::<Vec<_>>(), vec![1]);
        assert!(np.features.is_empty() && np.outputs.is_empty(), "nothing is ever sent to a Valve pad");
        assert_pad_forwards_only_itself(0x28de, 0x1102, &desc, &np);
    }

    #[test]
    fn generated_interfaces_never_leak_typing_or_pointing() {
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut next = move |n: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % n
        };
        let mut planned = 0;
        for _ in 0..4000 {
            let numbered = next(4) != 0;
            let mut parts = Vec::new();
            let mut wanted = Vec::new();
            for _ in 0..1 + next(4) {
                let rid = numbered.then(|| 1 + next(8) as u8);
                match next(5) {
                    0 => parts.push(keyboard(rid)),
                    1 => parts.push(mouse(rid, (next(2) == 0).then_some(90))),
                    2 => parts.push(consumer(rid)),
                    _ => {
                        let usage = 1 + next(3) as u16;
                        parts.push(vendor(0xff00, usage, rid, 1 + next(64) as u8, next(64) as u8, next(64) as u8));
                        wanted.push((0xff00, usage, if next(5) == 0 { FEAT } else { FULL }));
                    }
                }
            }
            // Sometimes the group also asks for typing collections (as Logitech's "everything" does).
            if next(3) == 0 {
                wanted.push((0x0001, 0x0006, FULL));
                wanted.push((0x0001, 0x0002, FEAT));
            }
            let desc = parts.concat();
            if let Ok(p) = plan(0x1234, 0, &desc, &wanted) {
                planned += 1;
                assert_never_forwards_protected(0x1234, &desc, &p);
                // Every forwarded id belongs to exactly the collections SYNQ opened.
                for r in &p.inputs {
                    assert!(p.open.iter().any(|&(page, usage, a)| (page, usage) == (r.usage_page, r.usage) && a != FEAT));
                }
                for r in &p.outputs {
                    assert!(p.open.iter().any(|&(page, usage, a)| (page, usage) == (r.usage_page, r.usage) && a == FULL));
                }
            }
        }
        assert!(planned > 500, "{planned}");
    }
}
