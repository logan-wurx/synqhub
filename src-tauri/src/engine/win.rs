//! Windows calls the engine code needs: the default output (Core Audio), elevation, restarting
//! Windows Audio, and Equalizer APO's own "did it load?" check over a named pipe.

use super::model::endpoint_guid_from_id;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED, ERROR_MORE_DATA, ERROR_PIPE_CONNECTED, HANDLE, HWND};
use windows::Win32::Media::Audio::{eMultimedia, eRender, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_SHAREMODE_SHARED};
use windows::Win32::Security::{
    GetTokenInformation, InitializeSecurityDescriptor, SetSecurityDescriptorDacl, TokenElevation, PSECURITY_DESCRIPTOR,
    SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR, TOKEN_ELEVATION, TOKEN_QUERY,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAGS_AND_ATTRIBUTES, FILE_GENERIC_WRITE, FILE_SHARE_NONE, OPEN_EXISTING, PIPE_ACCESS_INBOUND,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    COINIT_MULTITHREADED,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, WaitNamedPipeW, PIPE_READMODE_MESSAGE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_MESSAGE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows::Win32::System::Services::{
    CloseServiceHandle, ControlService, EnumDependentServicesW, OpenSCManagerW, OpenServiceW, QueryServiceStatus, StartServiceW,
    ENUM_SERVICE_STATUSW, SC_HANDLE, SC_MANAGER_CONNECT, SERVICE_ACTIVE, SERVICE_CONTROL_STOP, SERVICE_ENUMERATE_DEPENDENTS,
    SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_START, SERVICE_STATUS, SERVICE_STOP, SERVICE_STOPPED,
};
use windows::Win32::System::Threading::{GetCurrentProcess, GetExitCodeProcess, OpenProcessToken, WaitForSingleObject, INFINITE};
use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

/// Initializes COM (multithreaded) for the current scope when it isn't already.
pub struct Com(bool);

impl Com {
    pub fn init() -> Com {
        // S_OK / S_FALSE mean this call added a reference that must be released; RPC_E_CHANGED_MODE
        // means the thread already runs COM in another mode, which works for these calls too.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        Com(hr.is_ok())
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

/// The default playback device's endpoint GUID, as Windows (and Equalizer APO) picks it.
pub fn default_output() -> Option<String> {
    let _com = Com::init();
    unsafe {
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let dev = en.GetDefaultAudioEndpoint(eRender, eMultimedia).ok()?;
        let id: PWSTR = dev.GetId().ok()?;
        let s = id.to_string().ok();
        CoTaskMemFree(Some(id.0 as *const _));
        endpoint_guid_from_id(&s?)
    }
}

pub fn is_elevated() -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
}

pub enum Elevation {
    /// The process ran to completion with this exit code.
    Exited(u32),
    /// The person said no at the Windows prompt.
    Cancelled,
}

/// Starts `exe params` elevated (one Windows prompt) with no window, and waits for it.
pub fn run_elevated(exe: &std::path::Path, params: &str, owner: Option<isize>) -> Result<Elevation, String> {
    // ShellExecuteEx wants an apartment-threaded COM on the calling thread.
    let sta = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }.is_ok();
    let res = shell_execute_wait(exe, params, owner);
    if sta {
        unsafe { CoUninitialize() };
    }
    res
}

fn shell_execute_wait(exe: &std::path::Path, params: &str, owner: Option<isize>) -> Result<Elevation, String> {
    let verb = HSTRING::from("runas");
    let file = HSTRING::from(exe.as_os_str());
    let args = HSTRING::from(params);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        hwnd: HWND(owner.unwrap_or(0) as *mut _),
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(args.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    unsafe {
        if let Err(e) = ShellExecuteExW(&mut info) {
            if e.code() == ERROR_CANCELLED.to_hresult() {
                return Ok(Elevation::Cancelled);
            }
            return Err(format!("Could not start the setup helper: {e}"));
        }
        if info.hProcess.is_invalid() {
            return Err("The setup helper didn't start.".into());
        }
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code = 1u32;
        let _ = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
        Ok(Elevation::Exited(code))
    }
}

struct Service(SC_HANDLE, String);

impl Drop for Service {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseServiceHandle(self.0);
        }
    }
}

impl Service {
    fn state(&self) -> Result<u32, String> {
        let mut st = SERVICE_STATUS::default();
        unsafe { QueryServiceStatus(self.0, &mut st) }.map_err(|e| format!("{}: {e}", self.1))?;
        Ok(st.dwCurrentState.0)
    }
}

/// Stops Windows Audio (and whatever running services depend on it), then starts them again,
/// the way Equalizer APO's Device Selector does (ServiceHelper::restartService). The audio engine
/// only loads a newly registered effect when it starts. If anything goes wrong on the way, Windows
/// Audio is started again anyway, so sound is never left off.
pub fn restart_audio_service() -> Result<(), String> {
    let res = restart_audio_inner();
    if res.is_err() {
        start_audio_best_effort();
    }
    res
}

fn start_audio_best_effort() {
    unsafe {
        let Ok(scm) = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT) else { return };
        let _scm = Service(scm, "service manager".into());
        if let Ok(h) = OpenServiceW(scm, &HSTRING::from("AudioSrv"), SERVICE_START | SERVICE_QUERY_STATUS) {
            let s = Service(h, "AudioSrv".into());
            if s.state().is_ok_and(|st| st != SERVICE_RUNNING.0) {
                let _ = StartServiceW(s.0, None);
            }
        }
    }
}

fn restart_audio_inner() -> Result<(), String> {
    unsafe {
        let scm = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT).map_err(|e| format!("Service manager: {e}"))?;
        let scm_guard = Service(scm, "service manager".into());
        let access = SERVICE_START | SERVICE_STOP | SERVICE_QUERY_STATUS | SERVICE_ENUMERATE_DEPENDENTS;
        let open = |name: &str| -> Result<Service, String> {
            let h = OpenServiceW(scm_guard.0, &HSTRING::from(name), access).map_err(|e| format!("{name}: {e}"))?;
            Ok(Service(h, name.to_string()))
        };
        let main = open("AudioSrv")?;
        let mut services = Vec::new();
        if main.state()? == SERVICE_RUNNING.0 {
            let mut needed = 0u32;
            let mut count = 0u32;
            match EnumDependentServicesW(main.0, SERVICE_ACTIVE, None, 0, &mut needed, &mut count) {
                Ok(()) => {}
                Err(e) if e.code() == ERROR_MORE_DATA.to_hresult() => {
                    let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
                    let ptr = buf.as_mut_ptr() as *mut ENUM_SERVICE_STATUSW;
                    EnumDependentServicesW(main.0, SERVICE_ACTIVE, Some(ptr), needed, &mut needed, &mut count)
                        .map_err(|e| format!("Dependent services: {e}"))?;
                    for i in 0..count as usize {
                        let name = (*ptr.add(i)).lpServiceName.to_string().unwrap_or_default();
                        if !name.is_empty() {
                            services.push(open(&name)?);
                        }
                    }
                }
                Err(e) => return Err(format!("Dependent services: {e}")),
            }
        }
        services.push(main);

        let start = Instant::now();
        let limit = Duration::from_secs(30);
        for s in &services {
            if s.state()? == SERVICE_RUNNING.0 {
                let mut st = SERVICE_STATUS::default();
                ControlService(s.0, SERVICE_CONTROL_STOP, &mut st).map_err(|e| format!("Stopping {}: {e}", s.1))?;
            }
            while s.state()? != SERVICE_STOPPED.0 {
                if start.elapsed() > limit {
                    return Err(format!("{} didn't stop in time.", s.1));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        for s in services.iter().rev() {
            let _ = StartServiceW(s.0, None);
            let mut retry = start.elapsed() + Duration::from_secs(5);
            while s.state()? != SERVICE_RUNNING.0 {
                if start.elapsed() > limit {
                    return Err(format!("{} didn't start again in time.", s.1));
                }
                if start.elapsed() > retry {
                    // Sometimes the service won't start on the first try.
                    let _ = StartServiceW(s.0, None);
                    retry = start.elapsed() + Duration::from_secs(5);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        Ok(())
    }
}

/// What the engine reported while Windows opened the output.
#[derive(Default, Debug, Clone, Copy)]
pub struct TestResult {
    pub pre_mix: bool,
    pub post_mix: bool,
    pub pre_child: bool,
    pub post_child: bool,
}

impl TestResult {
    /// DeviceTestThread's TestResult::getScore.
    pub fn score(&self, wants_pre_child: bool, wants_post_child: bool) -> i32 {
        let mut s = 0;
        if self.pre_mix {
            s += 20;
        }
        if self.post_mix {
            s += 10;
        }
        if wants_pre_child && !self.pre_child {
            s -= 2;
        }
        if wants_post_child && !self.post_child {
            s -= 1;
        }
        s
    }

    pub fn ok(&self, wants_pre_child: bool, wants_post_child: bool) -> bool {
        self.pre_mix && self.post_mix && (self.pre_child || !wants_pre_child) && (self.post_child || !wants_post_child)
    }
}

const PIPE_NAME: &str = "OnBoardEqEngineTest";

fn pipe_path() -> HSTRING {
    HSTRING::from(format!(r"\\.\pipe\{PIPE_NAME}"))
}

/// Pipe server like the Device Selector's ReceiveThread: a message pipe anyone local may write
/// to (the audio engine runs as LOCAL SERVICE), one message per connection, "stop" ends it.
fn pipe_server(ready: mpsc::Sender<Result<(), String>>, out: mpsc::Sender<String>) {
    unsafe {
        let mut sd = SECURITY_DESCRIPTOR::default();
        let psd = PSECURITY_DESCRIPTOR(&mut sd as *mut _ as *mut _);
        if InitializeSecurityDescriptor(psd, 1).is_err() || SetSecurityDescriptorDacl(psd, true, None, false).is_err() {
            let _ = ready.send(Err("Could not set up the check pipe.".into()));
            return;
        }
        let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: psd.0, bInheritHandle: false.into() };
        let mut ready = Some(ready);
        loop {
            let pipe = CreateNamedPipeW(
                &pipe_path(),
                PIPE_ACCESS_INBOUND,
                PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                0,
                1024,
                0,
                Some(&sa),
            );
            if pipe.is_invalid() {
                if let Some(r) = ready.take() {
                    let _ = r.send(Err("Could not open the check pipe.".into()));
                }
                return;
            }
            if let Some(r) = ready.take() {
                let _ = r.send(Ok(()));
            }
            let connected = match ConnectNamedPipe(pipe, None) {
                Ok(()) => true,
                Err(e) => e.code() == ERROR_PIPE_CONNECTED.to_hresult(),
            };
            let mut message = None;
            if connected {
                let mut buf = [0u8; 1024];
                let mut read = 0u32;
                if ReadFile(pipe, Some(&mut buf), Some(&mut read), None).is_ok() && read > 0 {
                    message = Some(String::from_utf8_lossy(&buf[..read as usize]).into_owned());
                }
                let _ = DisconnectNamedPipe(pipe);
            }
            let _ = CloseHandle(pipe);
            match message.as_deref() {
                Some("stop") => return,
                Some(m) => {
                    let _ = out.send(m.to_string());
                }
                None => {}
            }
        }
    }
}

fn stop_pipe_server() {
    unsafe {
        let path = pipe_path();
        let open = || CreateFileW(&path, FILE_GENERIC_WRITE.0, FILE_SHARE_NONE, None, OPEN_EXISTING, FILE_FLAGS_AND_ATTRIBUTES(0), None);
        let handle = open().or_else(|_| if WaitNamedPipeW(&path, 1000).as_bool() { open() } else { Err(windows::core::Error::empty()) });
        if let Ok(h) = handle {
            let _ = WriteFile(h, Some(b"stop"), None, None);
            let _ = CloseHandle(h);
        }
    }
}

/// Opens a shared-mode stream on the output so Windows builds its effects chain, which makes the
/// engine report in. Kept alive until the check ends.
fn open_stream(guid: &str) -> Result<IAudioClient, String> {
    unsafe {
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let dev = en.GetDevice(&HSTRING::from(format!("{{0.0.0.00000000}}.{guid}"))).map_err(|e| format!("Output not found: {e}"))?;
        let client: IAudioClient = dev.Activate(CLSCTX_ALL, None).map_err(|e| format!("Could not open the output: {e}"))?;
        let format = client.GetMixFormat().map_err(|e| e.to_string())?;
        let r = client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 1_000_000, 0, format, None);
        CoTaskMemFree(Some(format as *const _));
        r.map_err(|e| format!("Could not open the output: {e}"))?;
        Ok(client)
    }
}

fn parse_message(m: &str) -> Option<(String, String, String)> {
    let v: serde_json::Value = serde_json::from_str(m).ok()?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    Some((s("deviceGuid")?, s("stage")?, s("phase")?))
}

/// Equalizer APO's device check: with HKLM\SOFTWARE\EqualizerAPO\DeviceTestPipeName set,
/// EqualizerAPO.dll writes {"deviceGuid","stage":"PreMix"|"PostMix","phase":"Initialize"|"ChildAPO"}
/// to the pipe each time the audio engine loads it. Call after Windows Audio was restarted.
pub fn device_test(guid: &str, wants_pre_child: bool, wants_post_child: bool, timeout: Duration) -> Result<TestResult, String> {
    let _com = Com::init();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (tx, rx) = mpsc::channel();
    let server = std::thread::spawn(move || pipe_server(ready_tx, tx));
    ready_rx.recv().map_err(|_| "The check pipe stopped.".to_string())??;
    super::registry::set_test_pipe(Some(PIPE_NAME))?;

    let mut result = TestResult::default();
    let stream = open_stream(guid);
    if stream.is_ok() {
        let deadline = Instant::now() + timeout;
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            let Ok(m) = rx.recv_timeout(left) else { break };
            let Some((g, stage, phase)) = parse_message(&m) else { continue };
            if !super::model::same_guid(&g, guid) {
                continue;
            }
            match (stage.as_str(), phase.as_str()) {
                ("PreMix", "Initialize") => result.pre_mix = true,
                ("PreMix", "ChildAPO") => result.pre_child = true,
                ("PostMix", "Initialize") => result.post_mix = true,
                ("PostMix", "ChildAPO") => result.post_child = true,
                _ => {}
            }
            if result.ok(wants_pre_child, wants_post_child) {
                break;
            }
        }
    }
    drop(stream);
    let cleared = super::registry::set_test_pipe(None);
    stop_pipe_server();
    let _ = server.join();
    cleared?;
    Ok(result)
}

/// Lets `--eq-engine` output reach the console it was started from (release builds have no
/// console of their own).
pub fn attach_parent_console() {
    use windows::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_engine_pipe_messages() {
        // Format written by EqualizerAPO::sendMessage.
        let m = r#"{"deviceGuid":"{1f2e3d4c-5b6a-4789-8abc-def012345678}", "stage":"PreMix", "phase":"Initialize"}"#;
        assert_eq!(parse_message(m), Some(("{1f2e3d4c-5b6a-4789-8abc-def012345678}".into(), "PreMix".into(), "Initialize".into())));
        assert_eq!(parse_message("stop"), None);
    }

    #[test]
    fn scores_like_device_selector() {
        let full = TestResult { pre_mix: true, post_mix: true, pre_child: true, post_child: true };
        assert!(full.ok(true, true));
        assert_eq!(full.score(true, true), 30);
        let no_child = TestResult { pre_child: false, ..full };
        assert!(!no_child.ok(true, false) && no_child.ok(false, false));
        assert_eq!(no_child.score(true, false), 28);
        assert_eq!(TestResult::default().score(false, false), 0);
    }
}
