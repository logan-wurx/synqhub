//! Linux device access: the udev rule (`70-onboard-hub.rules`) that lets the signed-in user open the
//! HID devices SYNQ supports, and nothing else (`TAG+="uaccess"`).
//!
//! `rules()` builds it from the same tables and predicates the bridge uses (hid.rs `allowed`,
//! `analog_input_only`, the QMK boards it knows, brands.rs / brand_ids.rs, openmouse_ids.rs), so the rule
//! and the bridge can't drift: a test fails when the copy shipped in `src-tauri/linux/70-onboard-hub.rules`
//! isn't exactly `rules()` (regenerate with `node scripts/gen-udev-rules.mjs`). Devices in firmware-update
//! mode never get access from it. The rule only opens the door; what SYNQ reads and writes through it is
//! still decided per collection and per report id by hid.rs and hid_plan.rs.
//!
//! The .deb installs it in /usr/lib/udev/rules.d; the AppImage offers to put it in /etc/udev/rules.d with one
//! pkexec prompt (`install`, Linux only), or shows the command to paste.

use crate::hid;
use std::collections::BTreeSet;

pub const RULES_FILE: &str = "70-onboard-hub.rules";
/// The copy the packages ship (and the AppImage's in-app install writes).
pub const SHIPPED: &str = include_str!("../linux/70-onboard-hub.rules");
const END: &str = "onboard_hub_end";

/// A whole vendor (every product the bridge's tables allow on it) or one product.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Target {
    Vendor(u16),
    Product(u16, u16),
}

impl Target {
    /// udev's name for the HID device under the hidraw node is BUS:VENDOR:PRODUCT.INSTANCE in upper-case hex
    /// (0003 USB, 0005 Bluetooth), so one pattern covers every bus.
    fn kernels(self) -> String {
        match self {
            Target::Vendor(v) => format!("*:{v:04X}:*"),
            Target::Product(v, p) => format!("*:{v:04X}:{p:04X}.*"),
        }
    }
}

/// Vendors the bridge allows whole: OpenMouse's vendor-wide filters, Logitech (`hid::allowed`), and Wooting,
/// whose analog collections are read on any product (`hid::analog_input_only`).
pub fn vendor_wide() -> BTreeSet<u16> {
    let mut v: BTreeSet<u16> = crate::openmouse_ids::FILTERS.iter().filter(|f| f.1.is_none()).map(|f| f.0).collect();
    v.insert(hid::LOGITECH);
    v.insert(WOOTING);
    v
}

/// Wooting's vendor id: its analog collections are read on any of its products (`hid::analog_input_only`).
const WOOTING: u16 = 0x31e3;

/// VIA / Vial boards the tables name (AnalogSense's raw-HID families, Keychron's Hall-effect boards): they open
/// on QMK's raw-HID collection, which any vendor's board may have, so only these get a rule by name.
fn qmk_known() -> BTreeSet<(u16, u16)> {
    hid::KEYCHRON_ANALOG.iter().chain(hid::MADLIONS_ANALOG.iter()).chain(crate::brand_ids::KEYCHRON_HE.iter()).copied().collect()
}

/// The ASUS ids the Gear Link rule table names (brands.rs reads the same file).
fn asus_rule_pids() -> Vec<u16> {
    #[derive(serde::Deserialize)]
    struct File {
        #[serde(rename = "familyByPid")]
        family_by_pid: std::collections::HashMap<String, String>,
    }
    let file: File = serde_json::from_str(include_str!("../../src/lib/brands/asus/asus-rules.json")).expect("asus-rules.json");
    file.family_by_pid.keys().filter_map(|k| u16::from_str_radix(k, 16).ok()).collect()
}

/// Every product id the tables name: the candidates for a product rule.
fn table_products() -> BTreeSet<(u16, u16)> {
    use crate::brand_ids as ids;
    let mut out: BTreeSet<(u16, u16)> = BTreeSet::new();
    let pairs: [&[(u16, u16)]; 13] = [
        &ids::SONIX,
        &ids::MONSGEEK,
        &ids::DRUNKDEER,
        &ids::DRUNKDEER_X60,
        &ids::FW19F5_MCHOSE,
        &ids::FW19F5_DRUNKDEER,
        &ids::FW19F5_NUPHY,
        &ids::FW19F5_RK_GCOME,
        &ids::RK_BEIYING,
        &ids::SPARKLINK,
        &ids::KEYCHRON_HE,
        &ids::ILLUMIPC,
        &ids::BYTECH,
    ];
    for list in pairs {
        out.extend(list.iter().copied());
    }
    for (vendor, pids) in [
        (0x1532u16, &ids::RAZER_KEYBOARDS[..]),
        (0x1532, &ids::RAZER_BRAND_MICE[..]),
        (0x1b1c, &ids::CORSAIR_BRAGI_KEYBOARDS[..]),
        (0x1b1c, &ids::CORSAIR_BRAGI_MICE[..]),
        (0x1b1c, &ids::CORSAIR_SABRE[..]),
        (0x1b1c, &ids::ICUE_KEYBOARDS[..]),
        (0x1b1c, &ids::ICUE_MICE[..]),
        (0x046d, &ids::LOGITECH_KEYBOARDS[..]),
        (0x1038, &ids::STEELSERIES[..]),
    ] {
        out.extend(pids.iter().map(|&p| (vendor, p)));
    }
    out.extend(ids::LISTED_KEYBOARDS.iter().copied());
    out.extend(asus_rule_pids().into_iter().map(|p| (0x0b05, p)));
    out.extend(hid::ASUS_PRODUCTS.iter().map(|&p| (0x0b05, p)));
    out.extend(hid::ATK_PRODUCTS.iter().map(|&p| (0x373b, p)));
    out.extend(crate::openmouse_ids::FILTERS.iter().filter_map(|&(v, p, _, _)| p.map(|p| (v, p))));
    out.extend(crate::openmouse_ids::KEYBOARD_FILTERS.iter().map(|&(v, p, _, _)| (v, p)));
    out.extend(qmk_known());
    out.extend([(0x03eb, 0xff01), (0x03eb, 0xff02)]); // Wooting One / Two on Atmel's id
    // Game controllers the bridge reads as HID (src/pads.rs): one rule each, so the tester can read their hidraw node.
    out.extend(crate::controller_ids::PADS.iter().filter(|p| p.3 == crate::controller_ids::HID).map(|p| (p.0, p.1)));
    out
}

/// Whether the bridge may open anything on this product (the same predicates hid.rs lists devices by).
pub fn bridge_opens(vendor_id: u16, product_id: u16) -> bool {
    !hid::bootloader_id(vendor_id, product_id)
        && (hid::allowed(vendor_id, product_id)
            || hid::analog_input_only(vendor_id, product_id, 0xff53, 0x0001)
            || (qmk_known().contains(&(vendor_id, product_id)) && hid::qmk_raw_hid(vendor_id, product_id, 0xff60, 0x0061)))
}

/// The rule's targets (vendors first, then products not covered by a vendor), and the update-mode ids of
/// those vendors, which are skipped before any of them.
pub fn targets() -> (Vec<Target>, Vec<String>) {
    let vendors = vendor_wide();
    let mut targets: Vec<Target> = vendors.iter().map(|&v| Target::Vendor(v)).collect();
    targets.extend(table_products().into_iter().filter(|&(v, p)| !vendors.contains(&v) && bridge_opens(v, p)).map(|(v, p)| Target::Product(v, p)));
    let mut skips: Vec<String> = hid::BOOTLOADER_IDS.iter().filter(|(v, _)| vendors.contains(v)).map(|&(v, p)| Target::Product(v, p).kernels()).collect();
    for &(v, from, to) in hid::BOOTLOADER_RANGES.iter().filter(|(v, _, _)| vendors.contains(v)) {
        // Every range in the table is a run of whole hex digits (AF00..AFFF, 2FF0..2FF9).
        let (a, b) = (format!("{from:04X}"), format!("{to:04X}"));
        let common = a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count();
        let rest: String = a.chars().skip(common).zip(b.chars().skip(common)).map(|(x, y)| if (x, y) == ('0', 'F') { "?".to_string() } else { format!("[{x}-{y}]") }).collect();
        skips.push(format!("*:{v:04X}:{}{rest}.*", &a[..common]));
    }
    skips.sort();
    skips.dedup();
    (targets, skips)
}

/// The whole rules file.
pub fn rules() -> String {
    let (targets, skips) = targets();
    let mut out = String::new();
    out.push_str(
        "# SYNQ: lets the signed-in user open the HID devices SYNQ supports (TAG+=\"uaccess\"), and no others.\n\
         # GENERATED from the bridge's own device tables (src-tauri/src/udev.rs: hid.rs, brands.rs, brand_ids.rs,\n\
         # openmouse_ids.rs) by `node scripts/gen-udev-rules.mjs`. Do not edit: a test fails when this file and the\n\
         # tables disagree. What SYNQ reads and writes on these devices is still decided per collection and per\n\
         # report id by the app (keystrokes and mouse movement are never passed on).\n\
         # The .deb installs this file in /usr/lib/udev/rules.d; the AppImage can put it in /etc/udev/rules.d.\n",
    );
    out.push_str(&format!("ACTION==\"remove\", GOTO=\"{END}\"\nSUBSYSTEM!=\"hidraw\", GOTO=\"{END}\"\n"));
    out.push_str("\n# Devices in firmware-update mode are never SYNQ's.\n");
    for s in &skips {
        out.push_str(&format!("KERNELS==\"{s}\", GOTO=\"{END}\"\n"));
    }
    out.push_str("\n# Whole vendors (OpenMouse's vendor-wide filters, Logitech, Wooting's analog collections).\n");
    for t in targets.iter().filter(|t| matches!(t, Target::Vendor(_))) {
        out.push_str(&format!("KERNELS==\"{}\", TAG+=\"uaccess\", GOTO=\"{END}\"\n", t.kernels()));
    }
    out.push_str("\n# Single products (brand drivers, OpenMouse and keyboard-protocol ids, the hand-built panels, known VIA boards).\n");
    for t in targets.iter().filter(|t| matches!(t, Target::Product(..))) {
        out.push_str(&format!("KERNELS==\"{}\", TAG+=\"uaccess\", GOTO=\"{END}\"\n", t.kernels()));
    }
    out.push_str(&format!("\nLABEL=\"{END}\"\n"));
    out
}

/// Whether the rule covers this vendor/product id (for the app's "needs the rule" check).
pub fn covers(vendor_id: u16, product_id: u16) -> bool {
    let (targets, _) = targets();
    !hid::bootloader_id(vendor_id, product_id) && targets.iter().any(|t| matches!(*t, Target::Vendor(v) if v == vendor_id) || *t == Target::Product(vendor_id, product_id))
}

// ---------------------------------------------------------------------------------------------------------
// Linux: is the rule in place, and installing it (only ever on the person's click).

#[cfg(target_os = "linux")]
pub mod access {
    use super::*;
    use serde::Serialize;
    use std::io::Write;
    use std::path::Path;
    use std::process::{Command, Stdio};

    /// Where udev reads rules from, admin overrides first.
    pub const RULE_PATHS: [&str; 3] = ["/etc/udev/rules.d/70-onboard-hub.rules", "/usr/lib/udev/rules.d/70-onboard-hub.rules", "/lib/udev/rules.d/70-onboard-hub.rules"];
    /// Where the in-app install puts it.
    pub const INSTALL_PATH: &str = "/etc/udev/rules.d/70-onboard-hub.rules";

    /// The one root step the in-app install runs (through pkexec, which asks for the password). The rules
    /// come in on stdin from this process, never from a file another program could swap.
    const INSTALL_SCRIPT: &str = "set -e; umask 022; mkdir -p /etc/udev/rules.d; \
        cat > /etc/udev/rules.d/.70-onboard-hub.rules.new; \
        mv -f /etc/udev/rules.d/.70-onboard-hub.rules.new /etc/udev/rules.d/70-onboard-hub.rules; \
        udevadm control --reload-rules && udevadm trigger";

    #[derive(Serialize, Clone, Debug)]
    #[serde(rename_all = "camelCase")]
    pub struct Status {
        /// The card should show: the rule is missing or out of date, or a listed device can't be opened.
        pub needed: bool,
        /// Where the rule is installed, if it is.
        pub installed: Option<String>,
        /// The installed rule is this version's.
        pub up_to_date: bool,
        /// Running as an AppImage (the .deb installs the rule itself).
        pub appimage: bool,
        /// pkexec is there to install it with one click.
        pub can_install: bool,
        /// What to paste in a terminal instead.
        pub command: String,
        /// Devices SYNQ lists but Linux doesn't let it open yet.
        pub blocked: Vec<String>,
    }

    fn quote(s: &str) -> String {
        format!("'{}'", s.replace('\'', "'\\''"))
    }

    fn on_path(cmd: &str) -> bool {
        std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(cmd).is_file()))
    }

    /// The AppImage file this copy runs from, if it does.
    pub fn appimage() -> Option<String> {
        std::env::var("APPIMAGE").ok().filter(|p| Path::new(p).is_file())
    }

    /// The command to paste: prints the rule with this very copy of SYNQ and installs it with sudo.
    pub fn command() -> String {
        let exe = appimage().or_else(|| std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned())).unwrap_or_else(|| "onboard".into());
        format!("{} --print-udev-rules | sudo tee {INSTALL_PATH} >/dev/null && sudo udevadm control --reload-rules && sudo udevadm trigger", quote(&exe))
    }

    pub fn status(blocked: Vec<String>) -> Status {
        let installed = RULE_PATHS.iter().find(|p| Path::new(p).is_file()).map(|p| p.to_string());
        let up_to_date = installed.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).is_some_and(|t| t == SHIPPED);
        Status {
            needed: !up_to_date || !blocked.is_empty(),
            installed,
            up_to_date,
            appimage: appimage().is_some(),
            can_install: Path::new("/usr/bin/pkexec").is_file() || on_path("pkexec"),
            command: command(),
            blocked,
        }
    }

    /// Installs the rule in /etc/udev/rules.d and reloads udev, with one pkexec prompt. Only ever called
    /// from the person's click on the device-access card.
    pub fn install() -> Result<String, String> {
        let mut child = Command::new("pkexec")
            .args(["/bin/sh", "-c", INSTALL_SCRIPT])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Couldn't start pkexec ({e}). Paste the command instead."))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(SHIPPED.as_bytes()).map_err(|e| format!("Couldn't hand the rule to pkexec: {e}"))?;
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        match out.status.code() {
            Some(0) => Ok(format!("Installed {INSTALL_PATH}. Unplug and replug a device if it still isn't found.")),
            // pkexec: 126 = the person dismissed the prompt, 127 = not authorized / no agent.
            Some(126) => Err("Nothing changed: the password prompt was closed.".into()),
            _ => {
                let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
                Err(if why.is_empty() { "pkexec couldn't install the rule. Paste the command instead.".into() } else { format!("pkexec couldn't install the rule ({why}). Paste the command instead.") })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The file the packages ship is exactly what the tables give. To update it after a table changes:
    /// `node scripts/gen-udev-rules.mjs` (runs this test with ONBOARD_WRITE_UDEV_RULES=1).
    #[test]
    fn the_shipped_rules_match_the_tables() {
        let generated = rules();
        if std::env::var_os("ONBOARD_WRITE_UDEV_RULES").is_some() {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("linux").join(RULES_FILE);
            std::fs::write(&path, &generated).unwrap();
            return;
        }
        assert!(
            SHIPPED == generated,
            "src-tauri/linux/{RULES_FILE} is out of date with the device tables: run `node scripts/gen-udev-rules.mjs`"
        );
    }

    #[test]
    fn every_line_is_a_well_formed_rule() {
        let text = rules();
        for line in text.lines().filter(|l| !l.is_empty() && !l.starts_with('#')) {
            let ok = line == format!("LABEL=\"{END}\"")
                || line.ends_with(&format!("GOTO=\"{END}\""))
                    && (line.starts_with("KERNELS==\"*:") || line.starts_with("ACTION==") || line.starts_with("SUBSYSTEM!="));
            assert!(ok, "{line}");
            assert!(!line.contains("MODE=") && !line.contains("RUN") && !line.contains("GROUP="), "only uaccess: {line}");
            if line.contains("TAG+=") {
                assert!(line.contains("TAG+=\"uaccess\""));
            }
        }
        // Kernel names are upper-case hex.
        assert!(text.contains("KERNELS==\"*:046D:*\""));
        assert!(!text.contains(":046d:"));
    }

    #[test]
    fn the_hand_built_devices_and_brand_keyboards_are_covered() {
        for (v, p) in [(0x046d, 0xc54d), (0x046d, 0xc0a0), (0x373b, 0x1278), (0x373b, 0x12a2), (0x0b05, 0x1d1d), (0x2e3c, 0xc365), (0x0416, 0x7372), (0x1532, 0x00c1), (0x1532, 0x02ea), (0x0c45, 0x8030), (0x1b1c, 0x2b0e), (0x1038, 0x1642), (0x19f5, 0x6120), (0x3434, 0x0b10), (0x31e3, 0x1322)] {
            assert!(covers(v, p), "{v:04x}:{p:04x}");
        }
    }

    #[test]
    fn nothing_the_bridge_refuses_gets_access() {
        // Update-mode ids, the ASUS Aura controller, ASUS ids nobody drives, an unknown vendor.
        for &(v, p) in hid::BOOTLOADER_IDS.iter() {
            assert!(!covers(v, p), "bootloader {v:04x}:{p:04x}");
        }
        for (v, p) in [(0x0b05, 0x19af), (0x0b05, 0x1234), (0x1234, 0x5678), (0x2e3c, 0x7500), (0x1532, 0x0001), (0x19f5, 0xaf12), (0x03eb, 0x2ff4)] {
            assert!(!covers(v, p), "{v:04x}:{p:04x}");
        }
        // A whole vendor gets a rule only when the bridge's own predicate allows any product of it.
        for v in vendor_wide() {
            for p in [0x0001u16, 0x1234, 0x8000, 0xfffe] {
                if !hid::bootloader_id(v, p) {
                    assert!(bridge_opens(v, p), "{v:04x}:{p:04x} is in a vendor-wide rule but the bridge refuses it");
                }
            }
        }
        // Every product rule is one the bridge opens.
        let (targets, skips) = targets();
        for t in &targets {
            if let Target::Product(v, p) = *t {
                assert!(bridge_opens(v, p), "{v:04x}:{p:04x}");
            }
        }
        // Update-mode ids of whole vendors are skipped before the vendor rule.
        let text = rules();
        let first_vendor = text.find("\", TAG+=").unwrap();
        for s in &skips {
            assert!(text.find(s.as_str()).unwrap() < first_vendor, "{s}");
        }
        assert!(skips.contains(&"*:046D:AB24.*".to_string()), "the LIGHTSPEED receiver's bootloader");
    }

    #[test]
    fn product_ids_from_every_table_are_in_the_rule() {
        let vendors = vendor_wide();
        let text = rules();
        for (v, p) in table_products() {
            if bridge_opens(v, p) {
                let pattern = if vendors.contains(&v) { Target::Vendor(v).kernels() } else { Target::Product(v, p).kernels() };
                assert!(text.contains(&format!("KERNELS==\"{pattern}\", TAG+=\"uaccess\"")), "{v:04x}:{p:04x}");
            }
        }
    }
}
