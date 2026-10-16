//! Plug and unplug, as Windows announces them: one `CM_Register_Notification` for every device interface class, so
//! the frontend re-lists devices when something arrives or leaves instead of polling on a timer. The callback only
//! nudges a thread, which waits for the burst to settle (a USB device brings several interfaces at once) and calls
//! `notify` once. Nothing is opened. On other systems there are no notifications and the frontend keeps its poll.

/// Called once per settled burst of arrivals and removals.
pub type Notify = Box<dyn Fn() + Send + 'static>;

#[cfg(windows)]
mod win {
    use super::Notify;
    use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        CM_Register_Notification, CM_NOTIFY_ACTION, CM_NOTIFY_EVENT_DATA, CM_NOTIFY_FILTER, CM_NOTIFY_FILTER_FLAG_ALL_INTERFACE_CLASSES, CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE, CR_SUCCESS, HCMNOTIFICATION,
    };

    /// A burst is over when nothing more arrives for this long.
    const SETTLE: Duration = Duration::from_millis(400);

    fn nudge() -> &'static Mutex<Option<Sender<()>>> {
        static N: OnceLock<Mutex<Option<Sender<()>>>> = OnceLock::new();
        N.get_or_init(|| Mutex::new(None))
    }

    unsafe extern "system" fn changed(_: HCMNOTIFICATION, _: *const core::ffi::c_void, _: CM_NOTIFY_ACTION, _: *const CM_NOTIFY_EVENT_DATA, _: u32) -> u32 {
        if let Ok(n) = nudge().lock() {
            if let Some(tx) = n.as_ref() {
                let _ = tx.send(());
            }
        }
        0
    }

    /// Registers once for the app's life; false when Windows refused (the frontend then polls).
    pub fn start(notify: Notify) -> bool {
        static STARTED: OnceLock<bool> = OnceLock::new();
        *STARTED.get_or_init(|| {
            let (tx, rx) = channel::<()>();
            if let Ok(mut n) = nudge().lock() {
                *n = Some(tx);
            }
            let filter = CM_NOTIFY_FILTER {
                cbSize: std::mem::size_of::<CM_NOTIFY_FILTER>() as u32,
                Flags: CM_NOTIFY_FILTER_FLAG_ALL_INTERFACE_CLASSES,
                FilterType: CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE,
                ..Default::default()
            };
            let mut handle = HCMNOTIFICATION::default();
            // SAFETY: the filter is a valid, fully initialised struct; the callback is a plain function that only
            // sends on a channel. The registration is never undone: it lasts as long as the app.
            let ok = unsafe { CM_Register_Notification(&filter, None, Some(changed), &mut handle) } == CR_SUCCESS;
            if !ok {
                return false;
            }
            std::thread::spawn(move || {
                while rx.recv().is_ok() {
                    // Let the burst settle, then tell the frontend once.
                    loop {
                        match rx.recv_timeout(SETTLE) {
                            Ok(()) => continue,
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    notify();
                }
            });
            true
        })
    }
}

#[cfg(windows)]
pub use win::start;

#[cfg(not(windows))]
pub fn start(_: Notify) -> bool {
    false
}
