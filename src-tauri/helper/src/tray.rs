//! The helper's only UI: a notification-area icon (Open SYNQ, Pause / Resume, Quit), its
//! notifications (battery), and the one-time "allow this site?" question for the web bridge. Plain
//! Win32: a message-only window (never shown) owns the icon.

use std::sync::OnceLock;
use std::sync::mpsc::Sender;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::UI::Shell::{
    NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_TIP, NIIF_WARNING, NIM_ADD, NIM_DELETE, NIM_MODIFY, NOTIFYICONDATAW, Shell_NotifyIconW,
};
use windows::Win32::UI::WindowsAndMessaging::*;
use windows::core::{PCWSTR, w};

const WM_TRAY: u32 = WM_APP + 1;
const ID_OPEN: usize = 1;
const ID_PAUSE: usize = 2;
const ID_QUIT: usize = 3;
const ICON_ID: u32 = 1;

/// What the menu asks the main loop to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Open,
    TogglePause,
    Quit,
}

static COMMANDS: OnceLock<Sender<Command>> = OnceLock::new();
static PAUSED_LABEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static TASKBAR_CREATED: OnceLock<u32> = OnceLock::new();

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn copy_into<const N: usize>(dst: &mut [u16; N], s: &str) {
    let w: Vec<u16> = s.encode_utf16().take(N - 1).collect();
    dst[..w.len()].copy_from_slice(&w);
    dst[w.len()] = 0;
}

/// The icon (a window handle as a number, so it can be shared with the worker thread).
#[derive(Clone, Copy)]
pub struct Tray {
    hwnd: isize,
    icon: isize,
}

fn app_icon() -> isize {
    // The app's own 32 px icon (PNG data is a valid icon resource since Vista).
    static PNG: &[u8] = include_bytes!("../../icons/32x32.png");
    unsafe {
        let size = GetSystemMetrics(SM_CXSMICON).max(16);
        match CreateIconFromResourceEx(PNG, true, 0x0003_0000, size, size, LR_DEFAULTCOLOR) {
            Ok(h) => h.0 as isize,
            Err(_) => LoadIconW(None, IDI_APPLICATION).map(|h| h.0 as isize).unwrap_or(0),
        }
    }
}

impl Tray {
    /// Creates the hidden owner window and adds the icon. Menu picks go to `commands`.
    pub fn create(commands: Sender<Command>) -> Result<Tray, String> {
        let _ = COMMANDS.set(commands);
        unsafe {
            let _ = TASKBAR_CREATED.set(RegisterWindowMessageW(w!("TaskbarCreated")));
            let instance = windows::Win32::System::LibraryLoader::GetModuleHandleW(None).map_err(|e| e.to_string())?;
            let class = w!("OnBoardHelperTray");
            let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: instance.into(), lpszClassName: class, ..Default::default() };
            RegisterClassW(&wc);
            let hwnd = CreateWindowExW(WINDOW_EX_STYLE::default(), class, w!("SYNQ Helper"), WINDOW_STYLE::default(), 0, 0, 0, 0, Some(HWND_MESSAGE), None, Some(instance.into()), None)
                .map_err(|e| e.to_string())?;
            let tray = Tray { hwnd: hwnd.0 as isize, icon: app_icon() };
            tray.add();
            Ok(tray)
        }
    }

    fn data(&self) -> NOTIFYICONDATAW {
        NOTIFYICONDATAW {
            cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: HWND(self.hwnd as *mut _),
            uID: ICON_ID,
            ..Default::default()
        }
    }

    fn add(&self) {
        let mut d = self.data();
        d.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
        d.uCallbackMessage = WM_TRAY;
        d.hIcon = HICON(self.icon as *mut _);
        copy_into(&mut d.szTip, "SYNQ Helper");
        unsafe {
            let _ = Shell_NotifyIconW(NIM_ADD, &d);
        }
    }

    pub fn tooltip(&self, text: &str) {
        let mut d = self.data();
        d.uFlags = NIF_TIP;
        copy_into(&mut d.szTip, text);
        unsafe {
            let _ = Shell_NotifyIconW(NIM_MODIFY, &d);
        }
    }

    /// A Windows notification from the icon. Windows holds it back during full-screen games and Focus
    /// Assist, and it never takes the keyboard focus.
    pub fn notify(&self, title: &str, text: &str) {
        let mut d = self.data();
        d.uFlags = NIF_INFO;
        d.dwInfoFlags = NIIF_WARNING;
        copy_into(&mut d.szInfoTitle, title);
        copy_into(&mut d.szInfo, text);
        unsafe {
            let _ = Shell_NotifyIconW(NIM_MODIFY, &d);
        }
    }

    pub fn set_paused(&self, paused: bool) {
        PAUSED_LABEL.store(paused, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn remove(&self) {
        let d = self.data();
        unsafe {
            let _ = Shell_NotifyIconW(NIM_DELETE, &d);
            let _ = DestroyWindow(HWND(self.hwnd as *mut _));
        }
    }
}

fn send(c: Command) {
    if let Some(tx) = COMMANDS.get() {
        let _ = tx.send(c);
    }
}

unsafe fn menu(hwnd: HWND) {
    unsafe {
        let Ok(m) = CreatePopupMenu() else { return };
        let pause = if PAUSED_LABEL.load(std::sync::atomic::Ordering::SeqCst) { wide("Resume") } else { wide("Pause") };
        let _ = AppendMenuW(m, MF_STRING, ID_OPEN, w!("Open SYNQ"));
        let _ = AppendMenuW(m, MF_STRING, ID_PAUSE, PCWSTR(pause.as_ptr()));
        let _ = AppendMenuW(m, MF_SEPARATOR, 0, PCWSTR::null());
        let _ = AppendMenuW(m, MF_STRING, ID_QUIT, w!("Quit"));
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        // Needed so the menu closes when the person clicks elsewhere (documented TrackPopupMenu quirk).
        let _ = SetForegroundWindow(hwnd);
        let picked = TrackPopupMenu(m, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON, pt.x, pt.y, Some(0), hwnd, None);
        let _ = DestroyMenu(m);
        match picked.0 as usize {
            ID_OPEN => send(Command::Open),
            ID_PAUSE => send(Command::TogglePause),
            ID_QUIT => send(Command::Quit),
            _ => {}
        }
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe {
        if msg == WM_TRAY {
            match lparam.0 as u32 {
                WM_RBUTTONUP | WM_CONTEXTMENU => menu(hwnd),
                WM_LBUTTONDBLCLK => send(Command::Open),
                _ => {}
            }
            return LRESULT(0);
        }
        if TASKBAR_CREATED.get().is_some_and(|&m| m == msg) {
            // Explorer restarted: put the icon back.
            Tray { hwnd: hwnd.0 as isize, icon: app_icon() }.add();
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

/// "Allow this site?" (once per site). Shown only when a site the helper allows asks to pair, which
/// happens when the person presses Connect on the website.
pub struct DialogConsent;

impl crate::bridge::Consent for DialogConsent {
    fn ask(&self, origin: &str) -> bool {
        let text = wide(&format!(
            "{origin} wants to use SYNQ Helper.\n\nIt will be able to change your mouse and keyboard settings and your EQ, with the same safety checks as the SYNQ app. Firmware updates are never possible.\n\nAllow it?"
        ));
        unsafe { MessageBoxW(None, PCWSTR(text.as_ptr()), w!("SYNQ Helper"), MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2 | MB_TOPMOST | MB_SETFOREGROUND) == IDYES }
    }
}
