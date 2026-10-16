//! Lighting (wave L1 onward): lamps and light strips SYNQ drives without their makers' apps. Govee over Bluetooth
//! LE (`govee`), the Wi-Fi brands on the local network (`net`), PC lighting (`hidrgb`, `lamparray`), screen sync's
//! sampling (`screen`) and screen sync across lights (`sync`, wave L5). Each keeps its own allowlist (mirrored in
//! src/lib/lighting) and fixtures.

pub mod govee;
// Wave L4: USB RGB hubs (OpenRGB's documented protocols) and Windows Dynamic Lighting (LampArray).
pub mod hidrgb;
pub mod hubframes;
pub mod lamparray;
// Wave L3: Wi-Fi lights on the local network.
pub mod net;
pub mod screen;
// Wave L5: screen sync across Wi-Fi lights and USB hubs (Govee lamps keep their own).
pub mod sync;
