//! Linux: the helper's only UI, as tray.rs is on Windows. A tray icon (a StatusNotifierItem through ksni:
//! KDE, Cinnamon, XFCE, LXQt, Budgie and GNOME with the AppIndicator extension show it) with Open SYNQ,
//! Pause / Resume and Quit; battery alerts as desktop notifications (the freedesktop notification service on
//! D-Bus, notify-rust); and the one-time "allow this site?" question for the web bridge, asked with the
//! notification's own buttons (or zenity / kdialog). Where the desktop shows no tray icons the helper runs
//! headless: notifications only, paused or turned off from SYNQ's Settings.

use std::sync::Mutex;
use std::sync::mpsc::Sender;
use std::time::Duration;

/// What the menu (and, on Linux, the app's socket) asks the main loop to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Open,
    TogglePause,
    Quit,
    /// The app changed the helper's files (Windows: the reload event).
    Reload,
}

const APP_NAME: &str = "SYNQ Helper";

/// The icon from the app's own package (the .deb installs it in the icon theme as "synq"), else a
/// standard one.
fn icon_name() -> String {
    let themed = ["/usr/share/icons/hicolor/32x32/apps/synq.png", "/usr/share/icons/hicolor/128x128/apps/synq.png"].iter().any(|p| std::path::Path::new(p).is_file());
    if themed { "synq".into() } else { "input-gaming".into() }
}

#[cfg(target_os = "linux")]
struct TrayIcon {
    commands: Sender<Command>,
    tip: String,
    paused: bool,
    icon: String,
}

#[cfg(target_os = "linux")]
impl ksni::Tray for TrayIcon {
    fn id(&self) -> String {
        "synq-helper".into()
    }

    fn title(&self) -> String {
        APP_NAME.into()
    }

    fn category(&self) -> ksni::Category {
        ksni::Category::Hardware
    }

    fn icon_name(&self) -> String {
        self.icon.clone()
    }

    fn tool_tip(&self) -> ksni::ToolTip {
        ksni::ToolTip { title: self.tip.clone(), ..Default::default() }
    }

    fn activate(&mut self, _x: i32, _y: i32) {
        let _ = self.commands.send(Command::Open);
    }

    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        use ksni::menu::StandardItem;
        vec![
            StandardItem { label: "Open SYNQ".into(), activate: Box::new(|t: &mut Self| { let _ = t.commands.send(Command::Open); }), ..Default::default() }.into(),
            StandardItem {
                label: if self.paused { "Resume".into() } else { "Pause".into() },
                activate: Box::new(|t: &mut Self| { let _ = t.commands.send(Command::TogglePause); }),
                ..Default::default()
            }
            .into(),
            ksni::MenuItem::Separator,
            StandardItem { label: "Quit".into(), activate: Box::new(|t: &mut Self| { let _ = t.commands.send(Command::Quit); }), ..Default::default() }.into(),
        ]
    }

    /// No tray host (yet, or any more): keep running headless; the icon comes back if one starts.
    fn watcher_offline(&self, _reason: ksni::OfflineReason) -> bool {
        true
    }
}

pub struct Tray {
    #[cfg(target_os = "linux")]
    handle: Option<Mutex<ksni::blocking::Handle<TrayIcon>>>,
    #[cfg(not(target_os = "linux"))]
    _none: Option<Mutex<()>>,
}

impl Tray {
    /// Adds the icon where the desktop shows tray icons; without one the helper is headless (never an error).
    #[cfg(target_os = "linux")]
    pub fn create(commands: Sender<Command>) -> Result<Tray, String> {
        use ksni::blocking::TrayMethods;
        let icon = TrayIcon { commands, tip: APP_NAME.into(), paused: false, icon: icon_name() };
        Ok(Tray { handle: icon.spawn().ok().map(Mutex::new) })
    }

    #[cfg(not(target_os = "linux"))]
    pub fn create(_commands: Sender<Command>) -> Result<Tray, String> {
        Ok(Tray { _none: None })
    }

    /// Whether a tray icon is showing (else notifications are the helper's only UI).
    pub fn shown(&self) -> bool {
        #[cfg(target_os = "linux")]
        return self.handle.is_some();
        #[cfg(not(target_os = "linux"))]
        return false;
    }

    pub fn tooltip(&self, text: &str) {
        #[cfg(target_os = "linux")]
        if let Some(h) = self.handle.as_ref().and_then(|h| h.lock().ok()) {
            let text = text.to_string();
            h.update(|t| t.tip = text);
        }
        #[cfg(not(target_os = "linux"))]
        let _ = text;
    }

    /// A desktop notification (the desktop holds it back in do-not-disturb and full-screen games, as it
    /// decides; it never takes the keyboard focus).
    pub fn notify(&self, title: &str, text: &str) {
        #[cfg(target_os = "linux")]
        {
            let _ = notify_rust::Notification::new()
                .appname(APP_NAME)
                .summary(title)
                .body(text)
                .icon(&icon_name())
                .timeout(notify_rust::Timeout::Milliseconds(10_000))
                .show();
        }
        #[cfg(not(target_os = "linux"))]
        let _ = (title, text);
    }

    pub fn set_paused(&self, paused: bool) {
        #[cfg(target_os = "linux")]
        if let Some(h) = self.handle.as_ref().and_then(|h| h.lock().ok()) {
            h.update(|t| t.paused = paused);
        }
        #[cfg(not(target_os = "linux"))]
        let _ = paused;
    }

    pub fn remove(&self) {
        #[cfg(target_os = "linux")]
        if let Some(h) = self.handle.as_ref().and_then(|h| h.lock().ok()) {
            h.shutdown().wait();
        }
    }
}

/// "Allow this site?" (once per site), shown only when a site the helper allows asks to pair, which happens
/// when the person presses Connect on the website. Asked with the notification's own buttons where the
/// desktop's notifications have them, else with zenity or kdialog; with none of those it's refused.
pub struct DialogConsent;

const ANSWER_WITHIN: Duration = Duration::from_secs(60);

#[cfg(target_os = "linux")]
fn ask_with_notification(text: &str) -> Option<bool> {
    let caps = notify_rust::get_capabilities().ok()?;
    if !caps.iter().any(|c| c == "actions") {
        return None;
    }
    let handle = notify_rust::Notification::new()
        .appname(APP_NAME)
        .summary("Allow this website?")
        .body(text)
        .icon(&icon_name())
        .action("allow", "Allow")
        .action("deny", "Don't allow")
        .timeout(notify_rust::Timeout::Milliseconds(ANSWER_WITHIN.as_millis() as u32))
        .show()
        .ok()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || handle.wait_for_action(|action| { let _ = tx.send(action == "allow"); }));
    Some(rx.recv_timeout(ANSWER_WITHIN + Duration::from_secs(5)).unwrap_or(false))
}

#[cfg(not(target_os = "linux"))]
fn ask_with_notification(_text: &str) -> Option<bool> {
    None
}

fn ask_with_dialog(text: &str) -> Option<bool> {
    let tries: [(&str, Vec<&str>); 2] = [
        ("zenity", vec!["--question", "--title", APP_NAME, "--text", text, "--timeout", "60"]),
        ("kdialog", vec!["--title", APP_NAME, "--yesno", text]),
    ];
    for (cmd, args) in tries {
        match std::process::Command::new(cmd).args(&args).stdin(std::process::Stdio::null()).status() {
            Ok(status) => return Some(status.success()),
            Err(_) => continue,
        }
    }
    None
}

impl crate::bridge::Consent for DialogConsent {
    fn ask(&self, origin: &str) -> bool {
        let text = format!(
            "{origin} wants to use SYNQ Helper. It will be able to change your mouse, keyboard and controller settings, your EQ, your monitors and webcams, and your lights, with the same safety checks as the SYNQ app. Firmware updates are never possible."
        );
        ask_with_notification(&text).or_else(|| ask_with_dialog(&format!("{text}\n\nAllow it?"))).unwrap_or(false)
    }
}
