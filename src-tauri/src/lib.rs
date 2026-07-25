//! Schizoboard native shell.
//!
//! Rust owns bytes: the content-addressed asset store, the append-only document
//! log, bundles, the native clipboard, and the embedded sync relay. It owns no
//! schema — everything schema-shaped stays in the frontend. See
//! `docs/ARCHITECTURE.md` section 4.
//!
//! Modules land as their tasks do: `assets` (T-21), `protocol` (T-22),
//! `docstore` (T-20), `clipboard` (T-23), `bundle` (T-84), `sync` (T-69).

use serde::Serialize;

/// What shell the frontend is actually running inside. Consumed by the boot
/// panel now and by the dev HUD (T-14) later.
#[derive(Serialize)]
struct AppInfo {
    name: String,
    version: String,
    os: String,
    arch: String,
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> AppInfo {
    let pkg = app.package_info();
    AppInfo {
        name: pkg.name.clone(),
        version: pkg.version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
