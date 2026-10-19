//! While SYNQ is minimized its page sleeps: WebView2's memory target goes to Low at once, and a
//! moment later the page is suspended (scripts, timers and drawing stop, and Windows can reuse the
//! memory). Restoring the window wakes it straight away: the page is shown, resumed and set back to
//! the Normal memory target before the first frame. Nothing about devices or the EQ changes here.
//!
//! The page tells us while device work is in flight (`page_busy`), and it isn't suspended until
//! that's done, so a write or read-back is never frozen half way.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, Runtime, WebviewWindow};

/// Wait this long after minimizing before suspending: a quick minimize/restore costs nothing, and
/// debounced saves (EQ 250 ms, keyboard batches 300 ms, X68 colour 450 ms) have gone out.
const SETTLE: Duration = Duration::from_millis(2000);
/// While the page reports device work in flight, look again this often.
const RETRY: Duration = Duration::from_millis(500);
/// How long a trim keeps the Low memory target before going back to Normal.
const TRIM_HOLD: Duration = Duration::from_millis(1500);

#[derive(Default)]
pub struct Sleep {
    minimized: AtomicBool,
    busy: AtomicBool,
    trimming: AtomicBool,
    /// Bumped by every minimize and restore, so a suspend that was due is dropped if things changed.
    generation: AtomicU64,
    /// What happened and when, for the perf test hook.
    log: Mutex<Vec<String>>,
    since: Mutex<Option<Instant>>,
}

impl Sleep {
    fn note(&self, what: impl AsRef<str>) {
        let t = self.since.lock().ok().and_then(|s| *s).map(|s| s.elapsed().as_millis()).unwrap_or(0);
        if let Ok(mut log) = self.log.lock() {
            if log.len() < 64 {
                log.push(format!("{t} ms {}", what.as_ref()));
            }
        }
    }

    pub fn set_busy(&self, busy: bool) {
        self.busy.store(busy, SeqCst);
    }

    pub fn take_log(&self) -> Vec<String> {
        self.log.lock().map(|mut l| std::mem::take(&mut *l)).unwrap_or_default()
    }
}

/// Follows the window: called on every resize (Windows sends one when minimizing and restoring).
pub fn on_resized<R: Runtime>(window: &WebviewWindow<R>) {
    if window.is_minimized().unwrap_or(false) {
        minimized(window);
    } else {
        restored(window);
    }
}

pub fn minimized<R: Runtime>(window: &WebviewWindow<R>) {
    let state = window.state::<Sleep>();
    if state.minimized.swap(true, SeqCst) {
        return;
    }
    if let Ok(mut s) = state.since.lock() {
        *s = Some(Instant::now());
    }
    let generation = state.generation.fetch_add(1, SeqCst) + 1;
    state.note("minimized");
    set_level(window, false);
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SETTLE);
        loop {
            let state = window.state::<Sleep>();
            if state.generation.load(SeqCst) != generation || !state.minimized.load(SeqCst) {
                return;
            }
            if !state.busy.load(SeqCst) {
                suspend(&window, generation);
                return;
            }
            std::thread::sleep(RETRY);
        }
    });
}

/// Hands back memory a page that was just closed left behind (its code, caches and freed heap):
/// the memory target goes to Low for a moment, which makes WebView2 purge, then back to Normal.
/// Scripts keep running and nothing on screen changes. Skipped while minimized, where the
/// target is already Low.
pub fn trim<R: Runtime>(window: &WebviewWindow<R>) {
    let state = window.state::<Sleep>();
    if state.minimized.load(SeqCst) || state.trimming.swap(true, SeqCst) {
        return;
    }
    let generation = state.generation.load(SeqCst);
    state.note("trim");
    set_level(window, false);
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(TRIM_HOLD);
        let state = window.state::<Sleep>();
        state.trimming.store(false, SeqCst);
        // Minimized meanwhile: the sleep path owns the target now.
        if state.generation.load(SeqCst) == generation && !state.minimized.load(SeqCst) {
            set_level(&window, true);
        }
    });
}

pub fn restored<R: Runtime>(window: &WebviewWindow<R>) {
    let state = window.state::<Sleep>();
    if !state.minimized.swap(false, SeqCst) {
        return;
    }
    state.generation.fetch_add(1, SeqCst);
    state.note("restored");
    wake(window);
}

#[cfg(windows)]
fn set_level<R: Runtime>(window: &WebviewWindow<R>, normal: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows::core::Interface;
    let w = window.clone();
    let _ = window.with_webview(move |webview| unsafe {
        let level = if normal { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW };
        let done = webview
            .controller()
            .CoreWebView2()
            .and_then(|core| core.cast::<ICoreWebView2_19>())
            .and_then(|core| core.SetMemoryUsageTargetLevel(level));
        w.state::<Sleep>().note(format!("memory target {} {}", if normal { "normal" } else { "low" }, if done.is_ok() { "set" } else { "failed" }));
    });
}

#[cfg(windows)]
fn suspend<R: Runtime>(window: &WebviewWindow<R>, generation: u64) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::TrySuspendCompletedHandler;
    use windows::core::Interface;
    let w = window.clone();
    let _ = window.with_webview(move |webview| unsafe {
        let state = w.state::<Sleep>();
        // Restored meanwhile: leave it awake.
        if state.generation.load(SeqCst) != generation || !state.minimized.load(SeqCst) {
            return;
        }
        let controller = webview.controller();
        // WebView2 only suspends a page that isn't visible.
        let _ = controller.SetIsVisible(false);
        let Ok(core) = controller.CoreWebView2().and_then(|c| c.cast::<ICoreWebView2_3>()) else {
            state.note("suspend: no ICoreWebView2_3");
            return;
        };
        let w2 = w.clone();
        let handler = TrySuspendCompletedHandler::create(Box::new(move |result, ok| {
            w2.state::<Sleep>().note(format!("suspended={ok} ({result:?})"));
            // Asleep, its game profiles can't go on: the claim is let go, so the helper can start SYNQ with no
            // window for a game meanwhile. Awake again, the page's next look claims it back.
            if ok {
                crate::profile_lock::release();
            }
            Ok(())
        }));
        state.note("suspend requested");
        if let Err(e) = core.TrySuspend(&handler) {
            state.note(format!("suspend failed: {e}"));
        }
    });
}

#[cfg(windows)]
fn wake<R: Runtime>(window: &WebviewWindow<R>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows::core::{Interface, BOOL};
    let w = window.clone();
    let _ = window.with_webview(move |webview| unsafe {
        let controller = webview.controller();
        let core = controller.CoreWebView2().and_then(|c| c.cast::<ICoreWebView2_19>());
        let mut was = BOOL(0);
        if let Ok(core) = &core {
            let _ = core.IsSuspended(&mut was);
        }
        // Showing it resumes it; Resume() covers a page that was suspended while already visible.
        let _ = controller.SetIsVisible(true);
        if let Ok(core) = &core {
            let _ = core.Resume();
            let _ = core.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL);
        }
        w.state::<Sleep>().note(format!("woke (was suspended: {})", was.as_bool()));
    });
}

#[cfg(not(windows))]
fn set_level<R: Runtime>(_: &WebviewWindow<R>, _: bool) {}
#[cfg(not(windows))]
fn suspend<R: Runtime>(_: &WebviewWindow<R>, _: u64) {}
#[cfg(not(windows))]
fn wake<R: Runtime>(_: &WebviewWindow<R>) {}
