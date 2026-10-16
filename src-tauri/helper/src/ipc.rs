//! Unix: how the app reaches a running helper (the named events on Windows). One lock and one socket in the
//! login's runtime folder ($XDG_RUNTIME_DIR, which only this user can reach; else the app data folder, with
//! the socket readable by its owner only). The app sends one word, "quit", "reload" or "ping", and the helper
//! answers "ok" (helper_cfg::signal / helper_running). SIGTERM and SIGINT (logout, `kill`) quit the same way
//! the tray's Quit does, so every device gets its everyday settings back first.

use crate::{helper_cfg, tray};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::time::Duration;

static TERMINATING: AtomicBool = AtomicBool::new(false);

/// One helper per login: an exclusive lock held for as long as this helper runs. None when another helper
/// already holds it.
pub fn lock() -> Option<std::fs::File> {
    let path = helper_cfg::socket_path().with_extension("lock");
    let f = std::fs::OpenOptions::new().create(true).write(true).truncate(false).open(&path).ok()?;
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    // SAFETY: flock on a descriptor this process owns; released when the file is dropped or the process ends.
    let r = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    (r == 0).then_some(f)
}

/// The socket the app talks to. Called with the lock held, so a socket file already there is a leftover of
/// a helper that didn't exit cleanly.
pub fn bind() -> Option<UnixListener> {
    let path = helper_cfg::socket_path();
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).ok()?;
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    Some(listener)
}

pub fn unbind() {
    let _ = std::fs::remove_file(helper_cfg::socket_path());
}

/// Answers the app until the helper quits: "quit" and "reload" go to the main loop, "ping" only answers.
pub fn serve(listener: UnixListener, commands: Sender<tray::Command>) {
    for stream in listener.incoming() {
        let Ok(mut s) = stream else { continue };
        let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
        let _ = s.set_write_timeout(Some(Duration::from_secs(1)));
        let mut line = String::new();
        if BufReader::new(&s).read_line(&mut line).is_err() {
            continue;
        }
        let command = match line.trim() {
            "quit" => Some(tray::Command::Quit),
            "reload" => Some(tray::Command::Reload),
            "ping" => None,
            _ => continue,
        };
        let _ = writeln!(s, "ok");
        if let Some(c) = command {
            if commands.send(c).is_err() {
                break;
            }
        }
    }
}

extern "C" fn on_signal(_: libc::c_int) {
    TERMINATING.store(true, Ordering::SeqCst);
}

/// SIGTERM / SIGINT set a flag the main loop checks twice a second.
pub fn catch_termination() {
    let handler = on_signal as extern "C" fn(libc::c_int);
    // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
    unsafe {
        libc::signal(libc::SIGTERM, handler as libc::sighandler_t);
        libc::signal(libc::SIGINT, handler as libc::sighandler_t);
    }
}

pub fn terminating() -> bool {
    TERMINATING.load(Ordering::SeqCst)
}
