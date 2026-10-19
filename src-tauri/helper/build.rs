// SYNQ Helper is handed out on its own (the website's "Get SYNQ Helper"), so it has to start on a Windows that has never
// had the Visual C++ runtime installed: the runtime is linked into the exe instead of needing VCRUNTIME140.dll (the
// app gets the same from tauri-build). The Universal CRT stays dynamic; it is part of Windows 10 and 11.
// The approach is ChrisDenton's static_vcruntime (MIT / Apache-2.0), as tauri-build uses it, for debug builds too.
use std::{env, fs, io::Write, path::Path};

fn main() {
    // `--features with-app`: the SYNQ program to carry (src/standalone.rs), rebuilt when it changes.
    println!("cargo:rerun-if-env-changed=SYNQ_APP_EXE");
    if env::var_os("CARGO_FEATURE_WITH_APP").is_some() {
        let app = env::var("SYNQ_APP_EXE").expect("--features with-app needs SYNQ_APP_EXE (the built synq.exe)");
        assert!(Path::new(&app).is_file(), "SYNQ_APP_EXE isn't a file: {app}");
        println!("cargo:rerun-if-changed={app}");
    }
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") || env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc") {
        return;
    }
    override_msvcrt_lib();
    // Leave out the runtime libraries Rust and the toolchain would otherwise pick, then name the static ones.
    for lib in ["libvcruntimed.lib", "vcruntime.lib", "vcruntimed.lib", "libcmtd.lib", "msvcrt.lib", "msvcrtd.lib", "libucrt.lib", "libucrtd.lib"] {
        println!("cargo:rustc-link-arg=/NODEFAULTLIB:{lib}");
    }
    for lib in ["libcmt.lib", "libvcruntime.lib", "ucrt.lib"] {
        println!("cargo:rustc-link-arg=/DEFAULTLIB:{lib}");
    }
}

/// Rust hard-codes msvcrt.lib: an (almost) empty library of that name, found first, takes its place.
fn override_msvcrt_lib() {
    let machine: &[u8] = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86_64") => &[0x64, 0x86],
        Ok("x86") => &[0x4C, 0x01],
        _ => return,
    };
    let bytes: &[u8] = &[
        1, 0, 94, 3, 96, 98, 60, 0, 0, 0, 1, 0, 0, 0, 0, 0, 132, 1, 46, 100, 114, 101, 99, 116, 118, 101, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 60, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 16, 0, 46, 100, 114, 101, 99, 116, 118, 101, 0, 0, 0, 0, 1, 0, 0, 0, 3, 0, 4, 0, 0, 0,
    ];
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR");
    let path = Path::new(&out_dir).join("msvcrt.lib");
    if let Ok(mut f) = fs::OpenOptions::new().write(true).create_new(true).open(path) {
        f.write_all(machine).expect("write msvcrt.lib");
        f.write_all(bytes).expect("write msvcrt.lib");
    }
    println!("cargo:rustc-link-search=native={out_dir}");
}
