//! The Windows Bluetooth side of Govee lamps: the lamps heard in advertisements (a scan runs while the app asks for
//! the list, and stops a minute after it stops asking; it never connects), and the GATT link of an open lamp:
//! service `…1910`, write `…2b11` (write without response), notify `…2b10`, and the `…2b12` version marker when the
//! lamp has one.

use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use windows::core::GUID;
use windows::Devices::Bluetooth::Advertisement::{BluetoothLEAdvertisementReceivedEventArgs, BluetoothLEAdvertisementWatcher, BluetoothLEScanningMode};
use windows::Devices::Bluetooth::GenericAttributeProfile::{
    GattCharacteristic, GattClientCharacteristicConfigurationDescriptorValue, GattCommunicationStatus, GattValueChangedEventArgs, GattWriteOption,
};
use windows::Devices::Bluetooth::{BluetoothCacheMode, BluetoothLEDevice};
use windows::Foundation::TypedEventHandler;
use windows::Storage::Streams::{DataReader, DataWriter};

use super::session::Link;

const SERVICE: GUID = GUID::from_u128(0x00010203_0405_0607_0809_0a0b0c0d1910);
const WRITE: GUID = GUID::from_u128(0x00010203_0405_0607_0809_0a0b0c0d2b11);
const NOTIFY: GUID = GUID::from_u128(0x00010203_0405_0607_0809_0a0b0c0d2b10);
const MARKER: GUID = GUID::from_u128(0x00010203_0405_0607_0809_0a0b0c0d2b12);

/// Name prefixes Govee lamps advertise with.
const PREFIXES: [&str; 4] = ["Govee_", "ihoment_", "GBK_", "GVH_"];
/// A lamp not heard for this long is no longer listed.
const PRESENT: Duration = Duration::from_secs(30);
/// The scan stops this long after the app last asked for the list.
const IDLE: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct Heard {
    pub address: u64,
    pub name: String,
    pub rssi: i16,
    pub at: Instant,
}

struct Scan {
    watcher: BluetoothLEAdvertisementWatcher,
    asked: Instant,
}

fn heard_map() -> &'static Mutex<HashMap<u64, Heard>> {
    static HEARD: OnceLock<Mutex<HashMap<u64, Heard>>> = OnceLock::new();
    HEARD.get_or_init(Mutex::default)
}

fn scan() -> &'static Mutex<Option<Scan>> {
    static SCAN: OnceLock<Mutex<Option<Scan>>> = OnceLock::new();
    SCAN.get_or_init(Mutex::default)
}

pub fn is_govee(name: &str) -> bool {
    PREFIXES.iter().any(|p| name.starts_with(p))
}

fn start_scan() -> windows::core::Result<BluetoothLEAdvertisementWatcher> {
    let watcher = BluetoothLEAdvertisementWatcher::new()?;
    // Active scanning asks for the scan response too, where the lamps put their name.
    watcher.SetScanningMode(BluetoothLEScanningMode::Active)?;
    watcher.Received(&TypedEventHandler::<BluetoothLEAdvertisementWatcher, BluetoothLEAdvertisementReceivedEventArgs>::new(|_, args| {
        if let Some(a) = args.as_ref() {
            let address = a.BluetoothAddress()?;
            let name = a.Advertisement()?.LocalName()?.to_string();
            let rssi = a.RawSignalStrengthInDBm()?;
            if let Ok(mut map) = heard_map().lock() {
                match map.get_mut(&address) {
                    Some(h) => {
                        h.rssi = rssi;
                        h.at = Instant::now();
                        if !name.is_empty() {
                            h.name = name;
                        }
                    }
                    None if is_govee(&name) => {
                        map.insert(address, Heard { address, name, rssi, at: Instant::now() });
                    }
                    None => {}
                }
            }
        }
        Ok(())
    }))?;
    watcher.Start()?;
    Ok(watcher)
}

/// The Govee lamps heard recently. Starts the scan when it isn't running; it stops by itself once the app stops asking.
pub fn heard() -> Vec<Heard> {
    if let Ok(mut s) = scan().lock() {
        match s.as_mut() {
            Some(running) => running.asked = Instant::now(),
            None => {
                if let Ok(watcher) = start_scan() {
                    *s = Some(Scan { watcher, asked: Instant::now() });
                    std::thread::spawn(|| loop {
                        std::thread::sleep(Duration::from_secs(5));
                        let Ok(mut s) = scan().lock() else { return };
                        if s.as_ref().is_some_and(|r| r.asked.elapsed() > IDLE) {
                            if let Some(r) = s.take() {
                                let _ = r.watcher.Stop();
                            }
                            return;
                        }
                    });
                }
            }
        }
    }
    let Ok(map) = heard_map().lock() else { return Vec::new() };
    map.values().filter(|h| h.at.elapsed() < PRESENT).cloned().collect()
}

/// The last time a lamp was heard, and how loud.
pub fn last_heard(address: u64) -> Option<Heard> {
    heard_map().lock().ok()?.get(&address).cloned()
}

fn err(what: &str, e: windows::core::Error) -> String {
    format!("{what}: {}", e.message())
}

/// An open GATT link to one lamp.
pub struct GattLink {
    device: BluetoothLEDevice,
    write: GattCharacteristic,
    notify: GattCharacteristic,
    token: i64,
    rx: Mutex<Receiver<Vec<u8>>>,
    marker: Option<u8>,
}

impl GattLink {
    pub fn connect(address: u64) -> Result<Self, String> {
        let device = BluetoothLEDevice::FromBluetoothAddressAsync(address).and_then(|op| op.join()).map_err(|e| err("Bluetooth", e))?;
        let mut service = None;
        for attempt in 0..3 {
            let found = device.GetGattServicesForUuidWithCacheModeAsync(SERVICE, BluetoothCacheMode::Uncached).and_then(|op| op.join());
            if let Ok(r) = found {
                if r.Status() == Ok(GattCommunicationStatus::Success) {
                    service = r.Services().ok().and_then(|v| v.into_iter().next());
                    if service.is_some() {
                        break;
                    }
                }
            }
            if attempt < 2 {
                std::thread::sleep(Duration::from_millis(700));
            }
        }
        let service = service.ok_or("The lamp didn't answer. It may be out of range, switched off at the wall, or connected to a phone.")?;
        let chars: Vec<GattCharacteristic> = service
            .GetCharacteristicsWithCacheModeAsync(BluetoothCacheMode::Uncached)
            .and_then(|op| op.join())
            .and_then(|r| r.Characteristics())
            .map_err(|e| err("Bluetooth", e))?
            .into_iter()
            .collect();
        let find = |u: GUID| chars.iter().find(|c| c.Uuid().map(|x| x == u).unwrap_or(false)).cloned();
        let write = find(WRITE).ok_or("This lamp has no Govee control characteristic.")?;
        let notify = find(NOTIFY).ok_or("This lamp has no Govee report characteristic.")?;
        // The encryption-version marker: [01, version]. Absent on many lamps, which proves nothing (§10.3).
        let marker = find(MARKER).and_then(|c| {
            let r = c.ReadValueWithCacheModeAsync(BluetoothCacheMode::Uncached).and_then(|op| op.join()).ok()?;
            let buf = r.Value().ok()?;
            let reader = DataReader::FromBuffer(&buf).ok()?;
            let mut v = vec![0u8; buf.Length().ok()? as usize];
            reader.ReadBytes(&mut v).ok()?;
            (v.len() >= 2 && v[0] == 0x01).then(|| v[1])
        });
        let (tx, rx) = channel::<Vec<u8>>();
        let token = notify
            .ValueChanged(&TypedEventHandler::<GattCharacteristic, GattValueChangedEventArgs>::new(move |_, args| {
                if let Some(a) = args.as_ref() {
                    let buf = a.CharacteristicValue()?;
                    let reader = DataReader::FromBuffer(&buf)?;
                    let mut v = vec![0u8; buf.Length()? as usize];
                    reader.ReadBytes(&mut v)?;
                    let _ = tx.send(v);
                }
                Ok(())
            }))
            .map_err(|e| err("Bluetooth", e))?;
        let status = notify
            .WriteClientCharacteristicConfigurationDescriptorAsync(GattClientCharacteristicConfigurationDescriptorValue::Notify)
            .and_then(|op| op.join())
            .map_err(|e| err("Bluetooth", e))?;
        if status != GattCommunicationStatus::Success {
            return Err("The lamp didn't accept SYNQ's report subscription.".into());
        }
        Ok(Self { device, write, notify, token, rx: Mutex::new(rx), marker })
    }
}

impl Link for GattLink {
    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        let w = DataWriter::new().map_err(|e| err("Bluetooth", e))?;
        w.WriteBytes(bytes).map_err(|e| err("Bluetooth", e))?;
        let buf = w.DetachBuffer().map_err(|e| err("Bluetooth", e))?;
        let status = self.write.WriteValueWithOptionAsync(&buf, GattWriteOption::WriteWithoutResponse).and_then(|op| op.join()).map_err(|e| err("Bluetooth", e))?;
        if status == GattCommunicationStatus::Success {
            Ok(())
        } else {
            Err("The lamp went out of reach.".into())
        }
    }
    fn recv(&self, timeout: Duration) -> Option<Vec<u8>> {
        self.rx.lock().ok()?.recv_timeout(timeout).ok()
    }
    fn version_marker(&self) -> Option<u8> {
        self.marker
    }
}

impl Drop for GattLink {
    fn drop(&mut self) {
        let _ = self.notify.RemoveValueChanged(self.token);
        let _ = self.device.Close();
    }
}
