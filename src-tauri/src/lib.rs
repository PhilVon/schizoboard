//! Schizoboard native shell.
//!
//! Rust owns bytes: the content-addressed asset store, the append-only document
//! log, bundles, the native clipboard, and the embedded sync relay. It owns no
//! schema — everything schema-shaped stays in the frontend. See
//! `docs/ARCHITECTURE.md` section 4.
//!
//! Modules land as their tasks do: `assets` (T-21), `protocol` (T-22),
//! `docstore` (T-20), `clipboard` (T-23), `bundle` (T-84), `sync` (T-69).
//!
//! ## Nothing runs on the main thread
//!
//! Every command below is `async` and does its work inside `spawn_blocking`,
//! including the ones that look trivial. A synchronous Tauri command runs on
//! the *main* thread, which is the thread the window is drawn from — so a
//! `stat` per asset on a large board, or a directory walk during collection,
//! is a visible hitch on a board that is otherwise holding 60 fps. The cost of
//! being careful here is one `await`; the cost of not being is a stutter
//! nobody can attribute to anything.

mod assets;
mod clipboard;
mod docstore;
mod protocol;

use std::collections::HashSet;
use std::path::PathBuf;

use serde::Serialize;
use tauri::ipc::InvokeBody;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use assets::{AssetMeta, AssetStore};
use docstore::DocStore;

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

// --- assets -----------------------------------------------------------------

#[derive(Clone, Serialize)]
struct AssetReady {
    sha256: String,
}

/// Run the slow half of ingestion — decode, orientation, downscale — and tell
/// the frontend when it lands.
///
/// Deliberately fire-and-forget, and deliberately after the command has already
/// returned. Ingestion's contract is "returns as soon as the hash and the
/// dimensions are known" (AC-46), because those two facts are all the document
/// needs for the item to exist at its correct size. Everything here is about
/// making it *sharper*, and none of it is allowed to be in the way.
///
/// `asset:ready` fires even when variant building failed. The event means "the
/// bytes are here", not "the downscale worked" — the original is servable
/// either way, and an item that waits forever because a thumbnail could not be
/// encoded is a worse outcome than a slightly heavier image.
fn schedule_variants(app: &AppHandle, sha256: String) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(store) = app.try_state::<AssetStore>() {
            if let Err(error) = store.build_variants(&sha256) {
                eprintln!("assets: no variants for {sha256}: {error}");
            }
        }
        let _ = app.emit("asset:ready", AssetReady { sha256 });
    });
}

/// Run `job` off the main thread and flatten both failure modes into the string
/// the frontend's promise rejects with.
///
/// Generic in the error as well as the value: the asset store and the document
/// log have separate error types on purpose — neither should be able to return
/// the other's failures — and this only ever needs them to be printable.
async fn blocking<T, E, F>(job: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, E> + Send + 'static,
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

fn store_of(app: &AppHandle) -> Result<tauri::State<'_, AssetStore>, String> {
    app.try_state::<AssetStore>()
        .ok_or_else(|| "the asset store failed to open".to_string())
}

/// The bytes arrive as a **raw request body**, not as a JSON array of numbers —
/// a third smaller and no serialisation stall (ARCHITECTURE section 4.4).
///
/// The mime hint rides on a header of our own rather than `Content-Type`,
/// which Tauri uses itself to decide that this payload is raw in the first
/// place. It is only a hint: `sniff_mime` trusts the magic numbers first.
#[tauri::command]
async fn asset_ingest_bytes(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<AssetMeta, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("asset_ingest_bytes expects a raw body".into());
    };
    let bytes = bytes.clone();
    let mime = request
        .headers()
        .get("x-asset-mime")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let handle = app.clone();
    let meta = blocking(move || {
        store_of(&handle)
            .map_err(assets::Error::Unavailable)?
            .ingest_bytes(&bytes, mime.as_deref())
    })
    .await?;

    schedule_variants(&app, meta.sha256.clone());
    Ok(meta)
}

#[tauri::command]
async fn asset_ingest_path(app: AppHandle, path: String) -> Result<AssetMeta, String> {
    let handle = app.clone();
    let meta = blocking(move || {
        store_of(&handle)
            .map_err(assets::Error::Unavailable)?
            .ingest_path(&PathBuf::from(path))
    })
    .await?;
    schedule_variants(&app, meta.sha256.clone());
    Ok(meta)
}

#[tauri::command]
async fn asset_ingest_url(app: AppHandle, url: String) -> Result<AssetMeta, String> {
    let handle = app.clone();
    let meta = blocking(move || {
        store_of(&handle)
            .map_err(assets::Error::Unavailable)?
            .ingest_url(&url)
    })
    .await?;
    schedule_variants(&app, meta.sha256.clone());
    Ok(meta)
}

#[tauri::command]
async fn asset_has(app: AppHandle, hashes: Vec<String>) -> Result<Vec<bool>, String> {
    // The return type is spelled out because `?` alone does not pin it: it
    // converts through `From`, so the error could be anything the store's error
    // converts into, and inference gives up.
    blocking(move || -> assets::Result<Vec<bool>> {
        let store = store_of(&app).map_err(assets::Error::Unavailable)?;
        Ok(hashes.iter().map(|hash| store.has(hash)).collect())
    })
    .await
}

/// Copy an original out to somewhere the user picked.
///
/// **The destination does not cross the IPC boundary, and that is the whole
/// design of this command.** ARCHITECTURE section 4.4 writes it as
/// `asset_export(sha256, dest)`; taking the `dest` is what made it dangerous.
/// `fs::copy` overwrites whatever is already at a path, and paired with
/// `asset_ingest_bytes` — which lets a caller choose the *content* — a
/// caller-supplied path is a write-anything-anywhere primitive: pick some
/// bytes, then export them over a file in the Startup folder. Nothing could
/// reach it while the webview only ever loaded our own frontend, but paste now
/// ingests HTML from other people's pages (T-23), so that stopped being a
/// comfortable thing to rely on.
///
/// A validator was the other option and it is not one. There is no rule
/// separating the paths a *user* may reasonably save an image to from the paths
/// an injected script would like to write: both are "somewhere on this disk".
/// So the path comes from a native save dialog instead — the user names the
/// file, and consent and destination arrive as the same act. The webview gets
/// to say *which asset*, and `valid_hash` already treats that as hostile.
///
/// The plugin makes this the only reachable dialog in the application: nothing
/// in `capabilities/` grants the webview one of its commands, so a script
/// cannot open a picker of its own — only ask for this one.
///
/// What the webview *does* get to suggest is a filename, because the document
/// holds the asset's `orig_name` and Rust holds no schema to read it from. A
/// name is a suggestion this side can meaningfully reduce, where a path is not —
/// [`assets::AssetStore::export_name`] is where that happens, and why the two
/// are not the same kind of argument.
///
/// `Ok(false)` is a cancelled dialog. That is an ordinary outcome, not an
/// error: rejecting on it would make every caller write a `catch` that has to
/// tell "the user changed their mind" apart from "the disk is full".
#[tauri::command]
async fn asset_export(
    app: AppHandle,
    sha256: String,
    orig_name: Option<String>,
) -> Result<bool, String> {
    let handle = app.clone();
    let hash = sha256.clone();
    let offer = blocking(move || {
        store_of(&handle)
            .map_err(assets::Error::Unavailable)?
            .export_name(&hash, orig_name.as_deref())
    })
    .await?;

    // `blocking_save_file` must not be called from the main thread — it asks the
    // main thread to open the dialog and then waits for it, so calling it there
    // deadlocks. Off-thread is both the documented usage and this file's rule.
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .file()
            .set_title("Export image")
            .set_file_name(&offer.file_name)
            .add_filter(offer.extension.to_uppercase(), &[offer.extension])
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(dest) = picked else {
        return Ok(false);
    };
    // Always the `Path` variant on desktop — the `Url` one is Android's
    // `content://`. Handled rather than unwrapped because "desktop" is a
    // property of the platform, not of this function.
    let dest = dest.into_path().map_err(|e| e.to_string())?;

    blocking(move || {
        store_of(&app)
            .map_err(assets::Error::Unavailable)?
            .export(&sha256, &dest)
    })
    .await
    .map(|()| true)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GcReport {
    freed_bytes: u64,
}

#[tauri::command]
async fn asset_gc(app: AppHandle, keep: Vec<String>) -> Result<GcReport, String> {
    blocking(move || -> assets::Result<GcReport> {
        let keep: HashSet<String> = keep.into_iter().collect();
        let freed = store_of(&app)
            .map_err(assets::Error::Unavailable)?
            .gc(&keep)?;
        Ok(GcReport { freed_bytes: freed })
    })
    .await
}

// --- the document log -------------------------------------------------------

fn docstore_of(app: &AppHandle) -> docstore::Result<tauri::State<'_, DocStore>> {
    app.try_state::<DocStore>()
        .ok_or_else(|| docstore::Error::Unavailable("the document log failed to open".into()))
}

/// Fire-and-forget from the frontend's side, and already a batch by the time it
/// arrives: `crdt/persistence.ts` merges roughly 200 ms or 32 kB of updates
/// into one frame before crossing (ARCHITECTURE section 4.4, AC-45).
///
/// Raw body, like every other binary payload here.
#[tauri::command]
async fn doc_append_update(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("doc_append_update expects a raw body".into());
    };
    let bytes = bytes.clone();
    blocking(move || docstore_of(&app)?.append(&bytes)).await
}

/// The snapshot and every frame since, as one raw response body rather than as
/// JSON arrays of numbers — see [`docstore::DocState::into_blob`].
#[tauri::command]
async fn doc_load(app: AppHandle) -> Result<tauri::ipc::Response, String> {
    let blob = blocking(move || {
        docstore_of(&app)?
            .load()
            .map(docstore::DocState::into_blob)
    })
    .await?;
    Ok(tauri::ipc::Response::new(blob))
}

#[tauri::command]
async fn doc_compact(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("doc_compact expects a raw body".into());
    };
    let bytes = bytes.clone();
    blocking(move || docstore_of(&app)?.compact(&bytes)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // T-94, and Rust-side only. `capabilities/default.json` grants the
        // webview none of this plugin's commands, so the save dialog inside
        // `asset_export` is the only one the application can open.
        .plugin(tauri_plugin_dialog::init())
        // T-22. Registered on the builder, but the store it reads is managed in
        // `setup` below — which is fine, because nothing can request an asset
        // until there is a window to request it from.
        .register_asynchronous_uri_scheme_protocol("asset", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            // Off the main thread: this reads a file, and the whole point of
            // the scheme is that a photograph arriving never costs a frame.
            tauri::async_runtime::spawn_blocking(move || {
                let response = match app.try_state::<AssetStore>() {
                    Some(store) => protocol::respond(&store, &request),
                    None => tauri::http::Response::builder()
                        .status(tauri::http::StatusCode::SERVICE_UNAVAILABLE)
                        .body(Vec::new())
                        .expect("static response"),
                };
                responder.respond(response);
            });
        })
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            app.manage(AssetStore::new(data.join("assets"))?);
            app.manage(DocStore::new(data.join("doc"))?);
            if let Some(window) = app.get_webview_window("main") {
                clipboard::forward_drops(&window, app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            asset_ingest_bytes,
            asset_ingest_path,
            asset_ingest_url,
            asset_has,
            asset_export,
            asset_gc,
            doc_append_update,
            doc_load,
            doc_compact,
            clipboard::clipboard_read_manifest,
            clipboard::clipboard_read_item,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
