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

// `asset_export` is deliberately **not** in the invoke handler yet, and
// `AssetStore::export` sits there unexposed with its own tests.
//
// The command takes a destination path and `fs::copy` overwrites whatever is
// already at it. Paired with `asset_ingest_bytes` — which lets a caller choose
// the *content* — that is a write-anything-anywhere primitive: pick some bytes,
// then export them over a file in the Startup folder. The webview only ever
// loads our own frontend today, so nothing can reach it; the moment paste
// starts ingesting HTML from other people's pages (T-23), that stops being a
// comfortable thing to rely on.
//
// Exporting is inherently "save this somewhere the *user* chose", so the fix is
// a native save dialog owning the path rather than a validator guessing at one.
// Until the `dialog` plugin lands (ARCHITECTURE section 4.6), the frontend's
// `assetExport` rejects with "command not found", which is exactly what
// `platform/tauri.ts` documents an unimplemented command doing.

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
