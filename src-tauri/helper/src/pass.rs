//! The hidden start. Game profiles for every mouse and keyboard ("live" profiles, src/games.rs) are put on by
//! SYNQ itself, through each device's own session (src/lib/profiles/runner.ts). While SYNQ is open, or a SYNQ
//! site is, they do it. With both closed, the helper starts SYNQ with no window (`synq --game-profiles`) when a
//! game with such a profile starts or ends: SYNQ brings every device to what it should hold, then exits. Its
//! window never shows and nothing takes focus. What it couldn't do comes back as lines on its output, which the
//! helper shows as notifications.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// The app's switch for a pass: bring the devices to what they should hold, then exit.
pub const ARG: &str = "--game-profiles";
/// With this after it: game profiles are off (or the helper paused), so only put everyday settings back.
pub const RESTORE: &str = "restore";
/// A line the pass prints for a notification: this, a tab, the title, a tab, the text.
pub const NOTICE: &str = "notice";
/// The pass's exit code when it can't run on this PC (no WebView2; src-tauri/src/lib.rs `PROFILES_NO_WEBVIEW`): no
/// pass is started again until the helper's settings change.
pub const NO_WEBVIEW: i32 = 3;

/// When to start a pass.
#[derive(Default)]
pub struct HiddenStart {
    /// The running games with a live profile at the last look (None before the first).
    last: Option<Vec<String>>,
    /// A pass that is running: true until it exits.
    running: Option<Arc<AtomicBool>>,
    /// Something changed that no pass (nor SYNQ, nor a site) has dealt with yet.
    pending: bool,
}

impl HiddenStart {
    /// One look. `live`: the running games with a live profile. `held`: a device holds a live profile now (so a
    /// first look with nothing running still puts it back, after a crash or a restart mid-game). `app_open`: SYNQ
    /// is running. `site`: a SYNQ site is putting profiles on. True: start a pass now.
    pub fn tick(&mut self, live: Vec<String>, held: bool, app_open: bool, site: bool) -> bool {
        let busy = self.running.as_ref().is_some_and(|r| r.load(Ordering::SeqCst));
        if !busy {
            self.running = None;
        }
        let changed = match &self.last {
            None => !live.is_empty() || held,
            Some(l) => *l != live,
        };
        self.last = Some(live);
        self.pending |= changed;
        // A change while a pass runs waits for it to end: the pass may have looked already.
        if !self.pending || busy {
            return false;
        }
        self.pending = false;
        // SYNQ open (or a site) sees the same change itself.
        !(app_open || site)
    }

    /// Asked for one pass now, whatever changed (game profiles turned off, the helper paused): true to start it.
    pub fn now(&mut self, app_open: bool, site: bool) -> bool {
        let busy = self.running.as_ref().is_some_and(|r| r.load(Ordering::SeqCst));
        !(busy || app_open || site)
    }

    pub fn started(&mut self, running: Arc<AtomicBool>) {
        self.running = Some(running);
    }
}

/// The SYNQ to start: the app next to this helper (the installed app), the AppImage it came from, or the SYNQ program
/// a helper installed from the website keeps beside it (standalone.rs `BACKGROUND_EXE`). None: the website, while it's
/// open, is what puts live profiles on.
pub fn app_path() -> Option<PathBuf> {
    #[cfg(unix)]
    if let Some(a) = std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(a);
    }
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let names: &[&str] = if cfg!(windows) { &["synq.exe", crate::BACKGROUND_EXE] } else { &["synq"] };
    names.iter().map(|n| dir.join(n)).find(|a| a.is_file())
}

/// One notification line from the pass's output, or None for anything else.
pub fn notice(line: &str) -> Option<(String, String)> {
    let mut parts = line.splitn(3, '\t');
    if parts.next()? != NOTICE {
        return None;
    }
    let (title, text) = (parts.next()?.trim(), parts.next()?.trim());
    let ok = |s: &str, max: usize| !s.is_empty() && s.chars().count() <= max && !s.contains(char::is_control);
    (ok(title, 64) && ok(text, 240)).then(|| (title.to_string(), text.to_string()))
}

/// Starts a pass: SYNQ with no window. `running` is true until it exits; each notice it prints goes to `notify`, and
/// its exit code (None: it didn't end normally) to `finished`.
pub fn start(app: &Path, restore: bool, running: Arc<AtomicBool>, notify: impl Fn(&str, &str) + Send + 'static, finished: impl FnOnce(Option<i32>) + Send + 'static) -> Result<(), String> {
    let mut cmd = Command::new(app);
    cmd.arg(ARG);
    if restore {
        cmd.arg(RESTORE);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    running.store(true, Ordering::SeqCst);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            running.store(false, Ordering::SeqCst);
            return Err(format!("couldn't start SYNQ for game profiles: {e}"));
        }
    };
    let out = child.stdout.take();
    std::thread::spawn(move || {
        if let Some(out) = out {
            for line in BufReader::new(out).lines().map_while(Result::ok).take(32) {
                if let Some((title, text)) = notice(&line) {
                    notify(&title, &text);
                }
            }
        }
        finished(child.wait().ok().and_then(|s| s.code()));
        running.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_game_starting_or_ending_starts_one_pass() {
        let mut h = HiddenStart::default();
        assert!(!h.tick(ids(&[]), false, false, false), "nothing running, nothing held");
        assert!(h.tick(ids(&["cs2"]), false, false, false), "a game started");
        assert!(!h.tick(ids(&["cs2"]), true, false, false), "no change");
        assert!(h.tick(ids(&[]), true, false, false), "it ended");
        assert!(!h.tick(ids(&[]), false, false, false));
    }

    #[test]
    fn synq_or_a_site_open_does_it_instead() {
        let mut h = HiddenStart::default();
        assert!(!h.tick(ids(&["cs2"]), false, true, false), "SYNQ is open");
        assert!(!h.tick(ids(&["cs2"]), false, false, false), "and that change was SYNQ's: SYNQ closing isn't a change");
        assert!(!h.tick(ids(&[]), true, false, true), "a site is open");
        assert!(h.tick(ids(&["apex"]), false, false, false));
    }

    #[test]
    fn a_change_during_a_pass_waits_for_it_to_end() {
        let mut h = HiddenStart::default();
        assert!(h.tick(ids(&["cs2"]), false, false, false));
        let running = Arc::new(AtomicBool::new(true));
        h.started(running.clone());
        // While it runs, SYNQ is in the process list: the pass itself.
        assert!(!h.tick(ids(&[]), true, true, false), "the game ended mid-pass");
        assert!(!h.now(false, false), "and nothing else starts while it runs");
        running.store(false, Ordering::SeqCst);
        assert!(h.tick(ids(&[]), true, false, false), "the pass is done: one more for the change it may have missed");
        assert!(!h.tick(ids(&[]), false, false, false));
    }

    #[test]
    fn a_first_look_puts_back_what_a_crash_left() {
        let mut h = HiddenStart::default();
        assert!(h.tick(ids(&[]), true, false, false));
        assert!(h.now(false, false) && !h.now(true, false) && !h.now(false, true));
    }

    #[test]
    fn notices_from_the_pass() {
        assert_eq!(notice("notice\tGame profile not applied\tPRO X 2 DEX: it didn't read back."), Some(("Game profile not applied".into(), "PRO X 2 DEX: it didn't read back.".into())));
        assert_eq!(notice("hello"), None);
        assert_eq!(notice("notice\t\ttext"), None);
        assert_eq!(notice(&format!("notice\tt\t{}", "x".repeat(300))), None);
    }
}
