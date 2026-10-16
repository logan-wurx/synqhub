//! The GIP-custom spike (wave C4, research item 6): reach the GameSir G7 SE's settings channel on Windows through
//! Windows.Gaming.Input.Custom, the way GameSir Nexus does (a custom controller factory registered for one of the
//! pad's GIP interfaces; messages through `GipGameControllerProvider`). Built only with the cargo feature `gip-spike`
//! (off by default, never in a release) and run only by hand, with the developer present and no game running:
//!
//!     cargo test --features gip-spike --lib gip_spike -- --ignored --nocapture
//!
//! What it sends is written out in docs/devices/G7SE-GIP.md. In short: nothing to any pad but 3537:1010 on firmware
//! 6.30; then only the heartbeat, the firmware and active-profile queries, and reads of the report rate (banks 1-4)
//! and the L4 / R4 records (profiles 1-3). Writes exist only behind `ONBOARD_GIP_SPIKE_WRITE=1`: the report rate,
//! written to all four banks and read back, then put back as it was. Every body passes `gip_g7se::check` first.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::{Duration, Instant};

use windows::core::{implement, IInspectable, Interface, Ref, Result, GUID};
use windows::Gaming::Input::Custom::{
    GameControllerFactoryManager, GipGameControllerProvider, GipMessageClass, ICustomGameControllerFactory, ICustomGameControllerFactory_Impl, IGameControllerInputSink, IGameControllerInputSink_Impl,
    IGameControllerProvider, IGipGameControllerInputSink, IGipGameControllerInputSink_Impl,
};
use windows::Foundation::TypedEventHandler;
use windows::Gaming::Input::{Headset, IGameController, IGameController_Impl};
use windows::System::{User, UserChangedEventArgs};

use crate::gip_g7se as g7;

/// The GIP interface the factory registers for: one the G7 SE declares and Nexus's component registers too
/// (b8f31fe7-...; the alternatives are in the doc). The factory only acts on 3537:1010.
pub const INTERFACE: GUID = GUID::from_u128(0xb8f31fe7_7386_40e9_a9f8_2f21263acfb7);

enum Event {
    /// The pad's provider, and whether its firmware may be written (the verified one) or only read.
    Provider(GipGameControllerProvider, bool),
    Message { class: GipMessageClass, id: u8, sequence: u8, body: Vec<u8> },
}

// The object CreateGameController returns IS the custom controller: Windows hands it back to OnGameControllerAdded typed
// as IGameController, so it must implement that interface. In sessions 1-2 it didn't, and Windows dropped it silently
// (CreateGameController, then nothing: no OnGameControllerAdded, no message).
#[implement(IGipGameControllerInputSink, IGameControllerInputSink, IGameController)]
struct Sink {
    tx: Sender<Event>,
}

impl IGameController_Impl for Sink_Impl {
    fn HeadsetConnected(&self, _value: Ref<TypedEventHandler<IGameController, Headset>>) -> Result<i64> {
        Ok(1)
    }
    fn RemoveHeadsetConnected(&self, _token: i64) -> Result<()> {
        Ok(())
    }
    fn HeadsetDisconnected(&self, _value: Ref<TypedEventHandler<IGameController, Headset>>) -> Result<i64> {
        Ok(2)
    }
    fn RemoveHeadsetDisconnected(&self, _token: i64) -> Result<()> {
        Ok(())
    }
    fn UserChanged(&self, _value: Ref<TypedEventHandler<IGameController, UserChangedEventArgs>>) -> Result<i64> {
        Ok(3)
    }
    fn RemoveUserChanged(&self, _token: i64) -> Result<()> {
        Ok(())
    }
    fn Headset(&self) -> Result<Headset> {
        Err(windows::Win32::Foundation::E_NOTIMPL.into())
    }
    fn IsWireless(&self) -> Result<bool> {
        Ok(false)
    }
    fn User(&self) -> Result<User> {
        Err(windows::Win32::Foundation::E_NOTIMPL.into())
    }
}

impl IGameControllerInputSink_Impl for Sink_Impl {
    // Windows suspends a controller's input for a process that doesn't own the foreground window; logged so the session
    // can tell "the pad is silent" from "Windows isn't delivering to us".
    fn OnInputResumed(&self, timestamp: u64) -> Result<()> {
        println!("  (input resumed at {timestamp})");
        Ok(())
    }
    fn OnInputSuspended(&self, timestamp: u64) -> Result<()> {
        println!("  (input suspended at {timestamp})");
        Ok(())
    }
}

impl IGipGameControllerInputSink_Impl for Sink_Impl {
    fn OnKeyReceived(&self, _timestamp: u64, _key: u8, _pressed: bool) -> Result<()> {
        Ok(())
    }
    fn OnMessageReceived(&self, _timestamp: u64, class: GipMessageClass, id: u8, sequence: u8, body: &[u8]) -> Result<()> {
        let _ = self.tx.send(Event::Message { class, id, sequence, body: body.to_vec() });
        Ok(())
    }
}

#[implement(ICustomGameControllerFactory)]
struct Factory {
    tx: Sender<Event>,
}

impl ICustomGameControllerFactory_Impl for Factory_Impl {
    fn CreateGameController(&self, provider: Ref<IGameControllerProvider>) -> Result<IInspectable> {
        let provider = provider.ok()?;
        // Only the G7 SE on the firmware the source verified; any other pad gets a sink that is never written to.
        let ids = (provider.HardwareVendorId()?, provider.HardwareProductId()?);
        let fw = provider.FirmwareVersionInfo()?;
        // Logged for the developer session: how Windows reports the pad's firmware.
        println!("  provider {:04x}:{:04x} firmware {}.{}.{}.{}", ids.0, ids.1, fw.Major, fw.Minor, fw.Build, fw.Revision);
        // Writable only on the verified firmware; the developer's older pad (READ_ONLY_GIP_FIRMWARE, exactly) is read only.
        let writable = (fw.Major, fw.Minor) == g7::TESTED_FIRMWARE;
        let readable = writable || (fw.Major, fw.Minor, fw.Build, fw.Revision) == g7::READ_ONLY_GIP_FIRMWARE;
        if ids == (g7::VID, g7::PID) && readable {
            if let Ok(gip) = provider.cast::<GipGameControllerProvider>() {
                let _ = self.tx.send(Event::Provider(gip, writable));
            }
        }
        let sink: IGipGameControllerInputSink = Sink { tx: self.tx.clone() }.into();
        sink.cast()
    }
    fn OnGameControllerAdded(&self, _value: Ref<IGameController>) -> Result<()> {
        println!("  (controller added)");
        Ok(())
    }
    fn OnGameControllerRemoved(&self, _value: Ref<IGameController>) -> Result<()> {
        println!("  (controller removed)");
        Ok(())
    }
}

/// The message class for the session's variants: ONBOARD_GIP_SPIKE_CLASS = command (default, what Nexus uses),
/// standard or low.
fn message_class() -> GipMessageClass {
    match std::env::var("ONBOARD_GIP_SPIKE_CLASS").as_deref() {
        Ok("standard") => GipMessageClass::StandardLatency,
        Ok("low") => GipMessageClass::LowLatency,
        _ => GipMessageClass::Command,
    }
}

/// The interface for the session's variants: ONBOARD_GIP_SPIKE_INTERFACE = one of the four the doc lists (the pad's
/// three, and the one Nexus also registers); anything else is the default.
fn interface() -> GUID {
    match std::env::var("ONBOARD_GIP_SPIKE_INTERFACE").as_deref() {
        Ok("9776ff56") => GUID::from_u128(0x9776ff56_9bfd_4581_ad45_b645bba526d6),
        Ok("082e402c") => GUID::from_u128(0x082e402c_07df_45e1_a5ab_a3127af197b5),
        Ok("332054cc") => GUID::from_u128(0x332054cc_a34b_41d5_a34a_a6a6711ec4b3),
        _ => INTERFACE,
    }
}

/// One request through the guard, then the first reply on message 0x10 within `wait`.
fn ask(provider: &GipGameControllerProvider, rx: &Receiver<Event>, body: &[u8], wait: Duration) -> std::result::Result<Option<g7::Reply>, String> {
    g7::check(g7::MSG_REQUEST, body)?;
    provider.SendMessage(message_class(), g7::MSG_REQUEST, body).map_err(|e| format!("SendMessage: {e}"))?;
    let end = Instant::now() + wait;
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(Event::Message { id, body, class, sequence }) => {
                println!("  <- class {:?} message {id:#04x} seq {sequence} {:02x?}", class.0, &body[..body.len().min(16)]);
                if let Some(r) = g7::parse_reply(id, &body) {
                    return Ok(Some(r));
                }
            }
            Ok(Event::Provider(..)) => {}
            Err(_) => break,
        }
    }
    Ok(None)
}

/// The probe: register, wait for the G7 SE, then the reads (and, only with ONBOARD_GIP_SPIKE_WRITE=1, the rate round
/// trip). Prints what it sends and gets.
pub fn probe(seconds: u64) -> std::result::Result<(), String> {
    // A multithreaded apartment, so Windows can call the factory and the sink back on its own threads while this one
    // waits (an uninitialised test thread gets CreateGameController but never OnGameControllerAdded or a message).
    // SAFETY: plain COM initialisation of this thread; S_FALSE (already initialised) is fine too.
    let _ = unsafe { windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED) };
    let (tx, rx) = channel();
    let factory: ICustomGameControllerFactory = Factory { tx }.into();
    let iface = interface();
    println!("  interface {iface:?}, class {:?}", message_class().0);
    GameControllerFactoryManager::RegisterCustomFactoryForGipInterface(&factory, iface).map_err(|e| format!("register: {e}"))?;
    let end = Instant::now() + Duration::from_secs(seconds);
    let (provider, writable) = loop {
        let left = end.checked_duration_since(Instant::now()).ok_or("no G7 SE (3537:1010) on a known firmware appeared")?;
        if let Ok(Event::Provider(p, w)) = rx.recv_timeout(left) {
            break (p, w);
        }
    };
    let wait = Duration::from_millis(400);
    println!("G7 SE found. Heartbeat, firmware, active profile:");
    ask(&provider, &rx, &g7::heartbeat(), Duration::from_millis(100))?;
    println!("  firmware: {:?}", ask(&provider, &rx, &g7::firmware_query(), wait)?);
    println!("  active profile: {:?}", ask(&provider, &rx, &g7::active_profile_query(), wait)?);
    let mut rates = Vec::new();
    for bank in 1..=4u8 {
        let r = ask(&provider, &rx, &g7::read(bank, g7::RATE_ADDR, 1).expect("in range"), wait)?;
        println!("  bank {bank} report rate: {r:?}");
        rates.push(r);
    }
    for bank in 1..=3u8 {
        for (name, addr) in [("L4", g7::L4_ADDR), ("R4", g7::R4_ADDR)] {
            println!("  profile {bank} {name}: {:?}", ask(&provider, &rx, &g7::read(bank, addr, 8).expect("in range"), wait)?);
        }
    }
    if std::env::var_os("ONBOARD_GIP_SPIKE_WRITE").as_deref() != Some(std::ffi::OsStr::new("1")) {
        println!("Read only (set ONBOARD_GIP_SPIKE_WRITE=1 for the report-rate round trip).");
        return Ok(());
    }
    if !writable {
        println!("Read only: this pad's firmware isn't the verified one (6.30), so nothing is written to it.");
        return Ok(());
    }
    // The round trip: every bank to 500 Hz (code 1), read back, then each bank back to the code it had.
    let before: Vec<u8> = rates.iter().map(|r| match r {
        Some(g7::Reply::Read { data, .. }) if data.len() == 1 && data[0] < 3 => Ok(data[0]),
        _ => Err("a report-rate read didn't answer: nothing written".to_string()),
    }).collect::<std::result::Result<_, _>>()?;
    for (code, label) in [(1u8, "to 500 Hz")].into_iter().chain(std::iter::once((u8::MAX, "back"))) {
        for bank in 1..=4u8 {
            let want = if code == u8::MAX { before[usize::from(bank - 1)] } else { code };
            let ack = ask(&provider, &rx, &g7::rate_write(bank, want).expect("allowed"), wait)?;
            let back = ask(&provider, &rx, &g7::read(bank, g7::RATE_ADDR, 1).expect("in range"), wait)?;
            println!("  {label}: bank {bank} write {ack:?}, read back {back:?}");
            if back != Some(g7::Reply::Read { bank, addr: g7::RATE_ADDR, data: vec![want] }) {
                return Err(format!("bank {bank} didn't read back as written; originals were {before:?}"));
            }
        }
    }
    Ok(())
}

/// Session 2: the same probe while this process owns the foreground window. Windows.Gaming.Input delivers to the
/// foreground process, and in session 1 the windowless test never got OnGameControllerAdded or a single message.
/// Opens a small window, waits (up to 60 s) for the developer to click it to the front (it never takes focus by itself),
/// runs `probe` on a worker thread while this thread pumps the window's messages, then closes the window.
pub fn window_probe(seconds: u64) -> std::result::Result<(), String> {
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{BeginPaint, DrawTextW, EndPaint, DT_CENTER, DT_SINGLELINE, DT_VCENTER, PAINTSTRUCT};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect, GetForegroundWindow, PeekMessageW, PostQuitMessage, RegisterClassW,
        ShowWindow, TranslateMessage, CW_USEDEFAULT, MSG, PM_REMOVE, SW_SHOWNOACTIVATE, WM_DESTROY, WM_PAINT, WNDCLASSW, WS_OVERLAPPEDWINDOW,
    };

    extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        unsafe {
            match msg {
                WM_PAINT => {
                    let mut ps = PAINTSTRUCT::default();
                    let hdc = BeginPaint(hwnd, &mut ps);
                    let mut rc = RECT::default();
                    let _ = GetClientRect(hwnd, &mut rc);
                    let mut text: Vec<u16> = "SYNQ G7 SE test: click here and keep this window in front".encode_utf16().collect();
                    DrawTextW(hdc, &mut text, &mut rc, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
                    let _ = EndPaint(hwnd, &ps);
                    LRESULT(0)
                }
                WM_DESTROY => {
                    PostQuitMessage(0);
                    LRESULT(0)
                }
                _ => DefWindowProcW(hwnd, msg, wp, lp),
            }
        }
    }
    fn pump() {
        // SAFETY: the standard message loop for this thread's window.
        unsafe {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    // SAFETY: COM for this (UI) thread, then one window of our own class.
    let hwnd = unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_APARTMENTTHREADED);
        let instance = GetModuleHandleW(None).map_err(|e| format!("module: {e}"))?;
        let class = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: instance.into(), lpszClassName: w!("OnBoardGipSpike"), ..Default::default() };
        RegisterClassW(&class);
        let hwnd = CreateWindowExW(
            Default::default(),
            w!("OnBoardGipSpike"),
            w!("SYNQ G7 SE test"),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            560,
            160,
            None,
            None,
            Some(instance.into()),
            None,
        )
        .map_err(|e| format!("window: {e}"))?;
        // Shown without taking focus: the developer brings it to the front with a click.
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        hwnd
    };
    println!("Click the \"SYNQ G7 SE test\" window so it is in front (60 s)...");
    let deadline = Instant::now() + Duration::from_secs(60);
    // SAFETY: reads which window is in front.
    while unsafe { GetForegroundWindow() } != hwnd {
        pump();
        if Instant::now() > deadline {
            // SAFETY: our own window.
            let _ = unsafe { DestroyWindow(hwnd) };
            return Err("the test window was never brought to the front".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    println!("  window in front");
    let (done_tx, done_rx) = channel();
    std::thread::spawn(move || {
        let _ = done_tx.send(probe(seconds));
    });
    let result = loop {
        pump();
        if let Ok(r) = done_rx.try_recv() {
            break r;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    // SAFETY: our own window.
    let _ = unsafe { DestroyWindow(hwnd) };
    pump();
    result
}

#[cfg(test)]
mod tests {
    /// Never run by CI or verify (ignored, and only built with the `gip-spike` feature): needs the developer, the G7 SE
    /// plugged in, and no game running.
    #[test]
    #[ignore]
    fn gip_spike_probe() {
        super::probe(20).unwrap();
    }

    /// Session 2: the probe with a window the developer clicks to the front (see `window_probe`).
    #[test]
    #[ignore]
    fn gip_spike_window_probe() {
        super::window_probe(20).unwrap();
    }
}
