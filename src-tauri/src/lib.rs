//! Schizoboard native shell.
//!
//! Rust owns bytes: the content-addressed asset store, the append-only document
//! log, bundles, the native clipboard, and the embedded sync relay. It owns no
//! schema — everything schema-shaped stays in the frontend. See
//! `docs/ARCHITECTURE.md` section 4.
//!
//! Modules land as their tasks do: `assets` (T-21), `protocol` (T-22),
//! `docstore` (T-20), `clipboard` (T-23), `bundle` (T-84), `sync` (T-69),
//! `print` (T-207), `document` (T-297), `media` (T-300).
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
mod board;
mod bundle;
mod clipboard;
// The one question asked of a text file before it is paginated: is it made of
// cues? (T-287, Q-301). `pub` for `text`'s reason — ingest counts pages through
// it and the reading surface reads through it, so both must ask it the same
// question and get the same answer.
pub mod cues;
mod docstore;
// `pub` for the same reason `sync` is, and now a command as well: `asset_title`
// asks it what a folder is called (T-267), and asks `media` the same thing about
// a tape (T-302). The rest of it — the pages themselves — is `reading`.
pub mod document;
mod media;
// What a page says it is (T-289, Q-304). `pub` so the fetch that feeds it and
// the command that answers with it can both name the type; the parser itself
// touches no network and is testable on a string.
pub mod opengraph;
// `pub` for the reason `document` is, and reached through `reading` (T-318).
pub mod pages;
mod print;
mod protocol;
// The reading surface's side of the boundary (T-318): the commands that turn
// `document` and `pages` from a reader nothing could call into a page on a
// sheet of paper.
mod reading;
pub mod sync;
// The other half of `document`: the rule that gives a file with no pages of its
// own some anyway, so that a page reference means the same thing on both kinds
// (T-298). `pub` because ingest asks it for a count and the reading surface
// (T-275) will ask it for a page.
pub mod text;

use std::collections::HashSet;
use std::path::PathBuf;

use serde::Serialize;
use tauri::ipc::InvokeBody;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_window_state::StateFlags;

use assets::{AssetMeta, AssetStore};
use docstore::DocStore;

// --- sync (T-69) -----------------------------------------------------------

/// The relay this client is hosting, if it is hosting one.
#[derive(Default)]
struct Hosting {
    relay: std::sync::Mutex<Option<sync::Relay>>,
    mode: std::sync::Mutex<Option<String>>,
    /// Relay mode's address, as the frontend gave it to us.
    url: std::sync::Mutex<Option<String>>,
    board: std::sync::Mutex<Option<String>>,
    /// This board's secret (T-70). Whoever holds it is a peer.
    secret: std::sync::Mutex<Option<String>>,
    /// The mDNS advertisement and browse, while hosting (T-70).
    discovery: std::sync::Mutex<Option<sync::discovery::Discovery>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncConfig {
    mode: String,
    /// Relay mode: where somebody else's relay is. The webview dials it, not
    /// us — this is here so the shell can report what it was told.
    url: Option<String>,
    /// Which board. Carried for `sync_status` and for the mDNS advertisement.
    board_id: String,
    /// The board's secret, when the frontend already has one — from `?secret=`
    /// today and from the invite link when that lands.
    ///
    /// Absent in LAN mode means *this* peer is opening the board, so the shell
    /// makes one up and hands it back: somebody has to be first, and there is
    /// nobody else to ask. Absent in relay mode means the relay does not want
    /// one, which is every loopback relay a developer runs.
    secret: Option<String>,
}

#[derive(Serialize)]
struct SyncStatus {
    connected: bool,
    peers: Vec<String>,
    mode: Option<String>,
    url: Option<String>,
    /// The board's secret, for the frontend to put in an invite. `null` when
    /// this client is not the one hosting.
    secret: Option<String>,
}

/// Start hosting, in the mode asked for.
///
/// ## Why this binds every interface, and what pays for it
///
/// LAN mode binds `0.0.0.0`, because a board only this machine can reach is not
/// a LAN board — the whole of T-70 is another machine finding this one. Until
/// T-70 it bound loopback deliberately, with a comment saying the relay has no
/// authentication at all and so a wider bind would put a read-write board on
/// whatever network this machine is attached to.
///
/// That is now paid for rather than ignored: the relay is started with a
/// secret (`sync/secret.rs`) and refuses, with a reason, anybody who cannot
/// present it (`sync/mod.rs`). The one invariant to keep is the one the
/// headless binary states out loud in `guard`: **never bind wider than
/// loopback without a secret.** There is no path through this function that
/// does, and there should never be one.
#[tauri::command]
async fn sync_start(app: AppHandle, config: SyncConfig) -> Result<(), String> {
    let hosting = app.state::<Hosting>();
    *hosting.mode.lock().expect("hosting lock") = Some(config.mode.clone());
    *hosting.url.lock().expect("hosting lock") = config.url.clone();
    *hosting.board.lock().expect("hosting lock") = Some(config.board_id.clone());

    // A secret that arrived from outside — an invite link, or `?secret=` — is
    // this board's from now on (Q-75). Kept before the mode branch because it is
    // true in both: a relay-mode window that was invited still holds the secret
    // for when it later hosts the same board itself.
    if let Some(given) = config.secret.as_deref() {
        if let Err(error) = app
            .state::<sync::secret::SecretStore>()
            .remember(&config.board_id, given)
        {
            eprintln!("[sync] this board's secret is not being kept: {error}");
        }
    }

    // Relay mode: somebody else is hosting, and the webview's own provider
    // dials them. There is nothing for this side to start — but the secret is
    // still kept, because it is what says which advertised board is ours.
    if config.mode != "lan" {
        *hosting.secret.lock().expect("hosting lock") = config.secret;
        return Ok(());
    }
    // Whoever opens the board first invents its secret; every launch after that
    // finds the same one on disk (Q-75). A caller that arrived holding one — a
    // second window told to join, an invite link — has just had it written
    // above, so `ensure` hands that same one straight back.
    //
    // Resolved *before* the comparison below rather than after it, which is the
    // change persistence makes to this decision: an ordinary reload used to be
    // "asked for nothing in particular, so keep what is running", and is now
    // "asked for the secret the relay is already hosting". Same answer, arrived
    // at by knowing rather than by not knowing.
    let secret = app
        .state::<sync::secret::SecretStore>()
        .ensure(&config.board_id);

    // Already hosting — but of *what*? A reload that asks for the same board
    // wants the relay it already has; one that asks for a different secret is
    // somebody joining a different board, and that is not a request that can be
    // met by the relay standing.
    //
    // Found by driving it: two windows were sent to `?secret=…` after boot, and
    // both silently kept the secret they had made up on their first load a
    // moment earlier. Each then advertised a fingerprint the other could not
    // match, so two peers on one board never saw each other and the failure
    // looked exactly like mDNS being broken. The invite link arrives by the same
    // route — a window that is already up being told to go somewhere else — so
    // this is its path too, not a testing quirk.
    //
    // The lock guards are dropped before the await below, which is what keeps
    // this command's future `Send`.
    {
        let hosted = hosting.secret.lock().expect("hosting lock").clone();
        let running = hosting.relay.lock().expect("hosting lock").is_some();
        match hosting_change(running, hosted.as_deref(), &secret) {
            HostingChange::Keep => return Ok(()),
            HostingChange::Restart => {
                // Stopped rather than left beside the new one: the old board's
                // advertisement would otherwise stay on the network naming a
                // port this window no longer answers on.
                hosting.relay.lock().expect("hosting lock").take();
                hosting.discovery.lock().expect("hosting lock").take();
            }
            HostingChange::Start => {}
        }
    }

    // Port zero: the operating system picks, and `sync_status` reports back.
    // A fixed port is one more thing to collide with on a machine somebody is
    // working on, and the advertisement carries whatever this turns out to be.
    let relay = sync::Relay::start_guarded(([0, 0, 0, 0], 0).into(), Some(secret.clone()))
        .await
        .map_err(|error| format!("the relay could not start: {error}"))?;
    let port = relay.addr().port();
    *hosting.relay.lock().expect("hosting lock") = Some(relay);
    *hosting.secret.lock().expect("hosting lock") = Some(secret.clone());

    // Say so on the network. A relay nobody can find is only reachable by
    // somebody who was told its address, which is what LAN mode exists not to
    // require.
    //
    // A discovery that will not start is reported and then let go: the board
    // works, the relay is up, and a peer given the address by hand still
    // connects. Multicast is blocked on plenty of networks — a guest wifi, a
    // corporate VLAN — and "you cannot use this board" is the wrong thing to
    // say to somebody who was only ever going to use it alone.
    let announced = app.clone();
    let ours = secret.clone();
    match sync::discovery::Discovery::start(
        instance_name(),
        config.board_id,
        sync::secret::fingerprint(&secret),
        port,
        move |peer| {
            // Our own secret goes on here, not the peer's — the advertisement
            // never carried one. The fingerprint already said this is a board
            // we hold the secret to; this is where holding it is spent.
            let found = PeerFound {
                url: format!("{}?token={ours}", peer.url()),
                board: peer.board,
                instance: peer.instance,
            };
            let _ = announced.emit("sync:peer-found", found);
        },
    ) {
        Ok(discovery) => *hosting.discovery.lock().expect("hosting lock") = Some(discovery),
        Err(error) => eprintln!("[sync] the board is not being advertised: {error}"),
    }
    Ok(())
}

/// Where to keep this instance's board, overriding the usual place.
///
/// Exists because **two peers on one machine need two boards**, and there was
/// no way to say so. Multiplayer cannot be watched with one window, and the
/// obvious trick for separating two instances does not work: Tauri resolves the
/// application data directory through the platform's own known-folder API — on
/// Windows `SHGetKnownFolderPath(FOLDERID_RoamingAppData)` — which does not read
/// the `APPDATA` environment variable. Setting `APPDATA` per process therefore
/// separates the WebView2 profiles and nothing else, and both instances quietly
/// open the same document.
///
/// That is not a theoretical failure. It happened: two shells launched with
/// separate `APPDATA` values opened the same real board, wrote to it, and
/// converged through the disk — which looks exactly like the network working
/// and is the most misleading result a multiplayer test could produce.
const DATA_DIR_ENV: &str = "SCHIZOBOARD_DATA_DIR";

/// The directory `assets/` and `doc/` live in.
///
/// Split from the setup hook so the choice can be tested, and taking the
/// default by value so the test never has to build an `AppHandle`.
fn data_root(default: PathBuf) -> PathBuf {
    data_dir_override().unwrap_or(default)
}

/// Where this process was told to keep its board, if it was told.
///
/// Three callers now, and they must agree: `data_root` puts the board there,
/// and `run` reads the *presence* of an override as "this process is
/// deliberately a separate peer" twice over — skipping the single-instance
/// plugin for it, and skipping `window-state` (T-233). If they ever disagreed
/// about what counts as being set, an instance would get its own board and then
/// be killed for having one.
///
/// An empty value is somebody exporting the variable without setting it, which
/// is much more likely to be a script bug than a request to keep the board in
/// the current directory.
fn data_dir_override() -> Option<PathBuf> {
    match std::env::var_os(DATA_DIR_ENV) {
        Some(path) if !path.is_empty() => Some(PathBuf::from(path)),
        _ => None,
    }
}

/// What to do about a relay that may already be running.
#[derive(Debug, PartialEq, Eq)]
enum HostingChange {
    /// Nothing is up. Start one.
    Start,
    /// One is up and it is hosting the board being asked for.
    Keep,
    /// One is up and it is hosting a *different* board. Stop it first.
    Restart,
}

/// Whether a `sync_start` in LAN mode can be answered by the relay already
/// running.
///
/// The case that matters is the third one, and it was found by driving rather
/// than by reading: a window that boots with no secret makes one up, and if it
/// is then sent to a board whose secret it *was* given, the relay standing
/// answers for the wrong board. It advertises a fingerprint nobody else can
/// match, so two peers who should have found each other never do — and the
/// symptom is indistinguishable from mDNS not working at all.
///
/// An ordinary reload lands on `Keep`, which is what matters for everybody
/// already connected: re-hosting on a fresh port would drop every one of them.
/// It gets there by *agreeing* — the reload resolves the same persisted secret
/// the relay is hosting (Q-75). Before persistence there was a third arm here
/// for a caller that asked for no secret at all, and it kept the relay for want
/// of a reason not to; there is now always a secret to compare, so the answer is
/// the same and the guess is gone.
fn hosting_change(running: bool, hosted: Option<&str>, wanted: &str) -> HostingChange {
    if !running {
        return HostingChange::Start;
    }
    if hosted == Some(wanted) {
        return HostingChange::Keep;
    }
    HostingChange::Restart
}

/// A name for this board's advertisement, unique on the network.
///
/// Random rather than derived from the machine, the board or the secret. The
/// machine's name is more identifying than anybody agreed to broadcast, the
/// board's is not unique — two windows on one machine hosting `demo` is the
/// ordinary development case, and DNS-SD would read the second as a correction
/// of the first — and the secret must not appear on the wire in any form,
/// including a few characters of it.
fn instance_name() -> String {
    format!("schizoboard-{}", &sync::secret::generate()[..12])
}

/// A board somebody on this network is hosting, on its way to the frontend.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PeerFound {
    /// Dialable as it stands, secret and all.
    url: String,
    board: String,
    /// The DNS-SD instance name. Stable while that peer is up, so the frontend
    /// can tell a re-announcement from a second peer.
    instance: String,
}

// --- the invite link (T-163) ------------------------------------------------

/// The last `schizo://` link the operating system handed us, until somebody
/// takes it.
///
/// Held as well as emitted, and that is not belt-and-braces — it is the two
/// genuinely different ways a link arrives, and only one of them is an event:
///
/// **Cold.** A click on an invite launches the application. The link is known
/// before there is a webview, let alone a frontend listening on it, so an
/// `emit` at that moment goes nowhere. It is kept here and the frontend asks
/// for it at boot.
///
/// **Warm.** The board is already open. The frontend has been listening for
/// minutes, and an event is exactly right.
///
/// A single `Option` covers both because a second link supersedes a first: two
/// invites clicked in a row means the second one is where the user wants to be,
/// and joining the first on the way would be a board flashing past.
#[derive(Default)]
struct PendingInvite(std::sync::Mutex<Option<String>>);

/// The link that brought us here, once. `None` when there wasn't one.
///
/// Taken rather than read, so a reload does not re-join a board the user has
/// since left. The frontend calls this at boot; the `sync:invite` event covers
/// every link that arrives after that.
#[tauri::command]
async fn sync_take_invite(app: AppHandle) -> Option<String> {
    app.state::<PendingInvite>()
        .0
        .lock()
        .expect("invite lock")
        .take()
}

// --- which board this is (T-195) -------------------------------------------

/// The board this installation is on, or `None` for the one it starts on.
///
/// Asked once, at boot, before there is a provider — which is why it cannot be
/// folded into `sync_status`, whose answers are all about a relay that is by
/// then already running. `app/sync.ts` decides what `None` means; all this side
/// knows is whether anybody has ever said otherwise.
#[tauri::command]
async fn board_remembered(app: AppHandle) -> Option<String> {
    // The state is read *inside* the closure rather than handed to it, because
    // `tauri::State` borrows the handle and `spawn_blocking` takes ownership —
    // the same shape every other command here uses `store_of` for.
    tauri::async_runtime::spawn_blocking(move || -> Option<String> {
        app.try_state::<board::BoardStore>()?.get()
    })
    .await
    .ok()
    .flatten()
}

/// This is the board from now on (Q-114).
///
/// One caller: a bundle open, which has just replaced the document and is about
/// to reload the window into a room the board it discarded is not in. See
/// `board.rs` for why that room has to survive a relaunch and not merely a
/// reload.
///
/// The name is minted by the frontend, because `app/sync.ts` is where what a
/// board may be called has always been decided — and it is checked again here,
/// because it becomes a file name under `secrets/` on the very next launch.
#[tauri::command]
async fn board_remember(app: AppHandle, board_id: String) -> Result<(), String> {
    blocking(move || -> Result<(), String> {
        app.try_state::<board::BoardStore>()
            .ok_or_else(|| "this board's name cannot be kept".to_string())?
            .remember(&board_id)
            .map_err(|error| error.to_string())
    })
    .await
}

/// A link on its way to the frontend.
#[derive(Clone, Serialize)]
struct DeepLink {
    url: String,
}

/// Remember a link and tell the frontend, in that order.
///
/// The order matters: emitting first leaves a window in which the frontend
/// answers the event by calling `sync_take_invite` and finds nothing there.
///
/// `deeplink:open` rather than a name of this feature's own, because
/// `platform/types.ts` has carried that event since the platform layer was
/// written and nothing had ever emitted it. It is also the better name: it says
/// a link arrived, not what the link meant. What it means is `app/invite.ts`'s
/// business, and that file already anticipates a second verb.
fn invite_arrived(app: &AppHandle, url: String) {
    *app.state::<PendingInvite>().0.lock().expect("invite lock") = Some(url.clone());
    let _ = app.emit("deeplink:open", DeepLink { url });
}

/// Stop hosting. Dropping the relay closes the port and every connection on it.
#[tauri::command]
async fn sync_stop(app: AppHandle) -> Result<(), String> {
    let hosting = app.state::<Hosting>();
    hosting.relay.lock().expect("hosting lock").take();
    // Dropped rather than merely forgotten: `Discovery`'s own `Drop` sends the
    // goodbye packet that takes this board off every other machine's list now,
    // instead of when the record ages out.
    hosting.discovery.lock().expect("hosting lock").take();
    *hosting.mode.lock().expect("hosting lock") = None;
    *hosting.url.lock().expect("hosting lock") = None;
    *hosting.board.lock().expect("hosting lock") = None;
    *hosting.secret.lock().expect("hosting lock") = None;
    Ok(())
}

#[tauri::command]
async fn sync_status(app: AppHandle) -> SyncStatus {
    let hosting = app.state::<Hosting>();
    let mode = hosting.mode.lock().expect("hosting lock").clone();
    let relay = hosting.relay.lock().expect("hosting lock");
    let board = hosting.board.lock().expect("hosting lock").clone();

    let secret = hosting.secret.lock().expect("hosting lock").clone();

    match relay.as_ref() {
        Some(running) => SyncStatus {
            connected: true,
            peers: running.peer_ids(),
            mode,
            // The address a peer should dial, board and secret and all, so
            // nothing else has to know how a relay URL is spelled.
            //
            // Loopback rather than `running.addr()`, which since the bind
            // widened is `0.0.0.0:port` — a wildcard is what to *listen* on and
            // has never been an address to dial. This one is for the window
            // that started the relay; the address other machines use is the one
            // the advertisement carries, and mDNS resolves that itself.
            url: Some(format!(
                "ws://127.0.0.1:{}/{}{}",
                running.addr().port(),
                board.unwrap_or_else(|| "board".to_string()),
                match secret.as_deref() {
                    Some(token) => format!("?token={token}"),
                    None => String::new(),
                }
            )),
            secret,
        },
        None => SyncStatus {
            connected: false,
            peers: Vec::new(),
            mode,
            url: hosting.url.lock().expect("hosting lock").clone(),
            secret,
        },
    }
}

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
pub(crate) async fn blocking<T, E, F>(job: F) -> Result<T, String>
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

/// [`blocking`], for the three commands whose failure is a sentence somebody
/// reads rather than a line in a log.
///
/// It keeps the refusal as data across the boundary. The frontend has to decide
/// whether to tell the person the board cannot hold their file — which is true
/// of a four-hundred-megapixel scan and false of a clipboard entry that went
/// stale — and the only thing it had to decide that on was the prose of the
/// message, which is not a contract (T-309).
async fn blocking_ingest<F>(job: F) -> Result<AssetMeta, assets::Refusal>
where
    F: FnOnce() -> assets::Result<AssetMeta> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(job).await {
        Ok(Ok(meta)) => Ok(meta),
        Ok(Err(error)) => Err(error.into()),
        Err(join) => Err(assets::Refusal::failed(join.to_string())),
    }
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
///
/// **This is the road with the low ceiling** (`assets::MAX_PASTE_BYTES`, about
/// 93 MiB against `asset_ingest_path`'s 448 MiB). Measured at its own ceiling it
/// peaks at 943.8 MiB, where the path road at *its* ceiling peaks at 774.9 MiB
/// for nearly five times the file — so anything big is meant to arrive as a
/// path, and the refusal here says so rather than only reporting a number.
#[tauri::command]
async fn asset_ingest_bytes(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<AssetMeta, assets::Refusal> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(assets::Refusal::failed(
            "asset_ingest_bytes expects a raw body".into(),
        ));
    };
    let bytes = bytes.clone();
    let mime = request
        .headers()
        .get("x-asset-mime")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let handle = app.clone();
    let meta = blocking_ingest(move || {
        store_of(&handle)
            .map_err(assets::Error::Unavailable)?
            .ingest_ipc_bytes(&bytes, mime.as_deref())
    })
    .await?;

    schedule_variants(&app, meta.sha256.clone());
    Ok(meta)
}

#[tauri::command]
async fn asset_ingest_path(app: AppHandle, path: String) -> Result<AssetMeta, assets::Refusal> {
    let handle = app.clone();
    let meta = blocking_ingest(move || {
        store_of(&handle)
            .map_err(assets::Error::Unavailable)?
            .ingest_path(&PathBuf::from(path))
    })
    .await?;
    schedule_variants(&app, meta.sha256.clone());
    Ok(meta)
}

#[tauri::command]
async fn asset_ingest_url(app: AppHandle, url: String) -> Result<AssetMeta, assets::Refusal> {
    let handle = app.clone();
    let meta = blocking_ingest(move || {
        store_of(&handle)
            .map_err(assets::Error::Unavailable)?
            .ingest_url(&url)
    })
    .await?;
    schedule_variants(&app, meta.sha256.clone());
    Ok(meta)
}

/// What a page says it is — T-289, T-290, Q-304.
///
/// The other half of a pasted URL. `asset_ingest_url` is for an address that
/// names a file; this is for one that names a *page about* a file, which is
/// what an archive.org item, a Commons file page and a watch page all are.
///
/// **It ingests nothing and returns no bytes.** What comes back is four strings
/// the page said about itself, and the frontend decides what to do with them —
/// which is the same division `document_page` keeps: Rust reads, the frontend
/// means. A lead in `image` goes back through `asset_ingest_url` like any other
/// picture, so the store still sniffs every byte that becomes an object and no
/// page's claim about itself is ever believed about a file.
///
/// Errors are strings rather than `Refusal`s: a page that will not load is not
/// a paste being refused, it is a paste falling back to the note it was always
/// going to be if this failed.
#[tauri::command]
async fn page_card(url: String) -> Result<opengraph::Card, String> {
    blocking(move || {
        assets::fetch_page(&url).map(|page| match page.kind {
            assets::PageKind::Markup => opengraph::card(&page.text),
            // A feed is a list rather than a page about a thing, so it is read
            // for the file it hands over rather than for what it says about
            // itself — T-289. One command either way: the frontend is asking
            // "what is at this address", and a feed is one of the answers.
            assets::PageKind::Feed => opengraph::feed(&page.text),
        })
    })
    .await
}

/// Hand an address to whatever the operating system opens links with — T-290.
///
/// **`http` and `https` only, and the check is here rather than at the caller.**
/// The address comes off an item's `source`, which is a field in a *shared
/// document*: a peer can write anything into it, and that peer is not
/// necessarily somebody whose board you would run a program from. Handing the
/// shell an arbitrary scheme is how a link becomes an execution — `file:` opens
/// whatever is on this disk, and Windows has a long history of registered
/// handlers that take arguments. The frontend validates the same thing for the
/// same reason; this is the one that has to hold, because it is the last line
/// before the OS.
///
/// It is also the first time this application hands anything to the shell at
/// all. `tauri-plugin-opener` has been a dependency since T-101 for the save
/// dialog and has never been reachable from the webview — it still is not, and
/// this command is the whole of the exposure.
#[tauri::command]
async fn open_link(app: AppHandle, url: String) -> Result<(), String> {
    if !is_web_address(&url) {
        return Err(format!("{url} is not a web address"));
    }
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// The whole of what [`open_link`] will hand to the shell.
///
/// Its own function so it can be tested without an `AppHandle`, which the
/// command needs and a rule does not. **A prefix test and not a parse**: a URL
/// parser that disagreed with the shell's about where the scheme ends is
/// exactly the gap this is here to close, and "starts with http:// or https://"
/// is a claim no parser can talk anybody out of.
fn is_web_address(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
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

// --- asset transfer ---------------------------------------------------------
//
// The store half of the peer exchange. `crdt/sync/exchange.ts` owns the
// conversation — who has what, what to ask for next, who to ask — because the
// socket to the relay belongs to the webview and Rust has no way to speak on
// it. These five are what it needs from the disk, and none of them lets it read
// a chunk it is carrying (D-28).

#[tauri::command]
async fn peer_have_summary(app: AppHandle) -> Result<Vec<String>, String> {
    blocking(move || -> assets::Result<Vec<String>> {
        store_of(&app).map_err(assets::Error::Unavailable)?.hashes()
    })
    .await
}

#[tauri::command]
async fn asset_size(app: AppHandle, sha256: String) -> Result<u64, String> {
    blocking(move || -> assets::Result<u64> {
        let store = store_of(&app).map_err(assets::Error::Unavailable)?;
        Ok(store.size(&sha256).unwrap_or(0))
    })
    .await
}

/// How much of an interrupted transfer is still on the disk, so the exchange can
/// ask for the rest of it rather than for all of it again (T-265).
///
/// Asked of the *receiving* side about its own partial, which is why it is
/// separate from `asset_size` — that one answers about an asset this machine
/// holds whole and is what a holder uses to decide how many chunks to send.
///
/// Zero covers every way of not having one, including the hour-long `gc` sweep
/// having taken it, and zero means "start at the beginning" all the way down.
#[tauri::command]
async fn asset_partial(app: AppHandle, sha256: String) -> Result<u64, String> {
    blocking(move || -> assets::Result<u64> {
        let store = store_of(&app).map_err(assets::Error::Unavailable)?;
        Ok(store.partial_len(&sha256))
    })
    .await
}

/// What this file says it is called, read off a copy this machine holds.
///
/// **A derived local index and nothing else** — Q-211. The answer never enters
/// the document, is never sent to a peer and is never written down: a machine
/// that does not hold the bytes has no title for this asset, and that is the
/// intended state rather than a gap. So this is asked on demand, once per object
/// the board actually puts on screen, which is also what makes it the single
/// path serving a paste, a committed transfer, a board reopened tomorrow and an
/// opened bundle alike.
///
/// **One question, not three.** A folder, a tape and a cassette all want the
/// same line under their filename, and which parser answers it is a fact about
/// the bytes rather than about the label — so the frontend asks once and this
/// side dispatches on the file's own head, the way [`assets::sniff_path`] says.
/// Trusting the record's `mime` instead would let a peer decide which parser
/// this machine runs over its own disk.
///
/// `None` for five things that are one thing to a label: no such asset, a kind
/// that carries no name, a container this build cannot read, a PDF it cannot
/// open (about 6% of real files — D-47), and a file that simply declares no
/// title — which is most of them, and overwhelmingly so for video (D-52). All
/// five mean the label writes its filename and stops.
///
/// It costs a structure load for a document — 3 to 53 ms on the corpus D-47
/// swept — and a handful of bounded reads for anything else, which is why it is
/// on `blocking` with the rest of the store's work.
#[tauri::command]
async fn asset_title(app: AppHandle, sha256: String) -> Result<Option<String>, String> {
    blocking(move || -> assets::Result<Option<String>> {
        let store = store_of(&app).map_err(assets::Error::Unavailable)?;
        let path = store.original_path(&sha256);
        let Some(mime) = assets::sniff_path(&path) else {
            return Ok(None);
        };
        if mime == "application/pdf" {
            return Ok(document::probe_path(&path).and_then(|probe| probe.title));
        }
        let Ok(mut file) = std::fs::File::open(&path) else {
            return Ok(None);
        };
        Ok(media::probe_title(&mut file, mime))
    })
    .await
}

/// One chunk, as a **raw response** — an ArrayBuffer in the webview, not a JSON
/// array of a quarter of a million numbers.
///
/// The frontend hands this straight to `encodeData` without reading it. That is
/// the whole arrangement: the bytes cross JavaScript, because the WebSocket is
/// there, but nothing in JavaScript interprets them.
#[tauri::command]
async fn asset_chunk(
    app: AppHandle,
    sha256: String,
    index: u64,
) -> Result<tauri::ipc::Response, String> {
    let bytes = blocking(move || {
        store_of(&app)
            .map_err(assets::Error::Unavailable)?
            .chunk(&sha256, index)
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// A chunk arriving from a peer. Raw body, with the filing details on headers —
/// the same shape as `asset_ingest_bytes`, and for the same reason.
#[tauri::command]
async fn asset_receive(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("asset_receive expects a raw body".into());
    };
    let bytes = bytes.clone();
    let header = |name: &str| -> Option<String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let (Some(sha256), Some(index), Some(total)) = (
        header("x-asset-sha256"),
        header("x-asset-index").and_then(|v| v.parse::<u64>().ok()),
        header("x-asset-total").and_then(|v| v.parse::<u64>().ok()),
    ) else {
        return Err("asset_receive wants a hash, an index and a total".into());
    };

    blocking(move || {
        store_of(&app)
            .map_err(assets::Error::Unavailable)?
            .receive_chunk(&sha256, index, total, &bytes)
    })
    .await
}

/// Verify a completed transfer and commit it, or throw it away.
///
/// `false` is an ordinary answer — the bytes did not hash to the name they came
/// under — and the caller's response to it is to ask a different peer. Only a
/// rejection means something went wrong with the disk.
#[tauri::command]
async fn asset_commit(app: AppHandle, sha256: String) -> Result<bool, String> {
    let handle = app.clone();
    let hash = sha256.clone();
    let committed = blocking(move || {
        store_of(&handle)
            .map_err(assets::Error::Unavailable)?
            .commit_received(&hash)
    })
    .await?;

    // The same tail as every other way an asset arrives: build the variants off
    // the main thread and announce it, which is what makes the item stop being
    // an empty frame.
    if committed {
        schedule_variants(&app, sha256);
    }
    Ok(committed)
}

#[tauri::command]
async fn asset_abort(app: AppHandle, sha256: String) -> Result<(), String> {
    blocking(move || {
        store_of(&app)
            .map_err(assets::Error::Unavailable)?
            .abort_received(&sha256)
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
    let blob =
        blocking(move || docstore_of(&app)?.load().map(docstore::DocState::into_blob)).await?;
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

// --- bundles (T-84) ---------------------------------------------------------

/// Zip this board up somewhere the user picked.
///
/// The destination comes from a native save dialog and never from the webview,
/// which is the rule `asset_export` above sets out at length and the reason
/// `dialog` appears in no capability. ARCHITECTURE section 4.4 writes this
/// command as `bundle_save_as(path)`; taking a `path` is the shape that
/// argument rejects, so this takes the *intent* — a title to suggest a name
/// from — and obtains the location on this side. The doc's signature predates
/// its own conclusion, the same way `asset_export(sha256, dest)` did.
///
/// `Ok(None)` is a cancelled dialog: an ordinary outcome, not a failure.
///
/// The payload is framed rather than JSON — see [`bundle::split_payload`].
#[tauri::command]
async fn bundle_save_as(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<bundle::Written>, String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("bundle_save_as expects a raw body".into());
    };
    let (json, snapshot) = bundle::split_payload(body).map_err(|e| e.to_string())?;
    let spec: bundle::Spec = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    let snapshot = snapshot.to_vec();

    // The board's title is a caller-supplied string on exactly the standing
    // `origName` has: it comes from the document, so it came from whoever typed
    // it — or from a peer over sync. It crosses as a *name* and is reduced to
    // one before a dialog ever shows it.
    let stem = assets::safe_stem(&spec.title).unwrap_or_else(|| "board".to_string());

    // Off the main thread, or the dialog asks the main thread to open it and
    // then waits for it. See `asset_export`.
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .file()
            .set_title("Export board")
            .set_file_name(format!("{stem}.{}", bundle::EXTENSION))
            .add_filter("Schizoboard bundle", &[bundle::EXTENSION])
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(dest) = picked else {
        return Ok(None);
    };
    let dest = dest.into_path().map_err(|e| e.to_string())?;

    blocking(move || -> bundle::Result<bundle::Written> {
        let store = store_of(&app).map_err(assets::Error::Unavailable)?;
        bundle::write(&store, &spec, &snapshot, &dest)
    })
    .await
    .map(Some)
}

/// Read a bundle the user picked, and put its photographs in this machine's
/// store.
///
/// Returns the manifest and the document snapshot; what happens to the snapshot
/// is a question about boards rather than about bytes, and it is answered on
/// the other side of the boundary. Q-111 answered it *replace*, which is why
/// there is a confirmation in the middle of this.
///
/// ## Three dialogs, in this order, and the order is the design
///
/// Pick, then peek, then ask. Asking first would be asking about a file that
/// might not be a bundle; reading the whole thing first would put a stranger's
/// photographs in this machine's store before anybody agreed to open their
/// board. [`bundle::peek`] is the step that makes the middle possible — it
/// costs one small entry and tells the confirmation which board it is about.
///
/// ## The confirmation's words are this side's, and that is not fussiness
///
/// Nothing in `capabilities/` grants the webview a dialog, so a native
/// confirmation *has* to be opened from here. It must also be *worded* here.
/// If the message crossed the boundary as an argument, then anything that can
/// reach `invoke` — and paste ingests HTML from other people's pages — could
/// put a sentence of its choosing in a box wearing the operating system's
/// chrome, which is a far better phishing surface than anything the renderer
/// can draw. So the frame is fixed and the only variable in it is the bundle's
/// own title, reduced by [`bundle::display_title`] first.
///
/// An empty response body is a cancelled dialog — the raw equivalent of
/// `Ok(None)` above, because a `Response` has no room for one. Saying no to the
/// confirmation is the same outcome as closing the picker: no board arrived.
#[tauri::command]
async fn bundle_open(app: AppHandle) -> Result<tauri::ipc::Response, String> {
    let nothing = || Ok(tauri::ipc::Response::new(Vec::new()));

    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .file()
            .set_title("Open board")
            .add_filter("Schizoboard bundle", &[bundle::EXTENSION])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(src) = picked else {
        return nothing();
    };
    let src = src.into_path().map_err(|e| e.to_string())?;

    let peeked = src.clone();
    let manifest = blocking(move || bundle::peek(&peeked)).await?;
    let name = bundle::display_title(&manifest.title);

    let handle = app.clone();
    let agreed = tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .message(format!(
                "Opening “{name}” will replace the board in this window.\n\n\
                 The board you have open now will be gone."
            ))
            .title("Replace this board?")
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                "Replace".into(),
                "Keep this board".into(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|e| e.to_string())?;

    if !agreed {
        return nothing();
    }

    let handle = app.clone();
    let opened = blocking(move || -> bundle::Result<bundle::Opened> {
        let store = store_of(&handle).map_err(assets::Error::Unavailable)?;
        bundle::read(&store, &src)
    })
    .await?;

    // Thumbnails and display variants are a local derivative, never carried in
    // the file — the bundle holds originals, named by the only hash that can
    // name them. Rebuilt here on the same background path a paste uses, so the
    // board can start drawing placeholders immediately rather than waiting on a
    // few hundred decodes.
    for sha256 in &opened.ingested {
        schedule_variants(&app, sha256.clone());
    }

    let json = serde_json::to_vec(&opened).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bundle::join_payload(
        &json,
        &opened.snapshot,
    )))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // T-163, and it must be first. `single-instance` decides whether this
    // process is going to live at all, and everything registered before it is
    // set up in a process that is about to hand over its arguments and exit. The
    // callback runs in the *original* instance, which is the one with the board
    // open — so this is the warm path: an invite clicked while Schizoboard is
    // already running.
    //
    // `argv` rather than a parsed link, because on Windows and Linux that is
    // genuinely all the operating system gives us: it re-launched the
    // application with the URL as a command-line argument. The `deep-link`
    // feature on this plugin is what turns that argument back into an
    // `on_open_url` event, which is why the two are one dependency decision and
    // not two.
    //
    // ## Unless this process was told to keep its board somewhere else
    //
    // Found by launching two peers a minute after this plugin landed: the second
    // one exited instantly, and the whole two-instance arrangement T-70 built —
    // `SCHIZOBOARD_DATA_DIR`, a devtools port each, the multiplayer half of
    // `.claude/skills/verify/SKILL.md` — stopped working. Two features that were
    // each right and were wrong together, which is not something the test suite
    // can see: neither of them is reachable from a unit test.
    //
    // The override is exactly the right thing to key on, because it already
    // means what is needed here. `DATA_DIR_ENV` exists for one reason — "two
    // peers on one machine need two boards" (Q-73) — so a process that has been
    // given one has *said* it is a separate peer. Single-instancing it would be
    // taking that back.
    //
    // What it costs: a `schizo://` click while such an instance is running goes
    // to whichever peer is the singleton rather than to it. That is the correct
    // trade — the override is a development affordance, an installed
    // Schizoboard never sets it, and every user-facing path keeps the plugin.
    if data_dir_override().is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Whatever the user just clicked, they meant to look at. A window
            // that stays behind the browser they clicked it in reads as nothing
            // having happened.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    // T-233, and skipped on the same condition as the plugin above for a reason
    // of the same shape. The saved geometry does **not** live in the data
    // directory, and on Windows it looks as though it does: the plugin keeps
    // `.window-state.json` in `app_config_dir()`, which resolves to the same
    // `%APPDATA%\com.philw.schizoboard` that `app_data_dir()` does, so the file
    // lands next to `doc/` and `assets/` while going nowhere near
    // `data_root`. Every instance on this machine shares it whatever
    // `SCHIZOBOARD_DATA_DIR` says — the same fact `DATA_DIR_ENV`'s own comment
    // records about `APPDATA`, arrived at from the other direction.
    //
    // So a scratch peer registering this would write the *installed*
    // application's window position on its way out. Open two peers to watch a
    // board sync, shove them either side of the screen, and Schizoboard opens
    // half-width in a corner tomorrow with no way to tell why. A development
    // affordance may not redecorate the real application, and this is the
    // second time that sentence has had to be written in this function.
    //
    // ## Three flags, not six
    //
    // `StateFlags::all()` is the default, and two of the three it adds are
    // traps rather than features:
    //
    // `VISIBLE` saves `is_visible()` at teardown and then *refuses to show the
    // window* on the next launch if it reads false. A board that starts
    // invisible has nothing that could bring it back — `single-instance` would
    // hand a clicked invite to a window nobody can see, and the fix would be to
    // find and delete a JSON file. Restoring where a window was is worth a
    // little; restoring whether it existed is worth nothing at all.
    //
    // `DECORATIONS` is the same trade with less on the other side: nothing in
    // this application ever undecorates a window, so the field can only ever
    // agree with the default or be wrong. `FULLSCREEN` is simply unreachable —
    // there is no way into it from here, so it would record `false` forever.
    //
    // Which leaves exactly what the task asks for: where it was, how big it
    // was, and whether it was maximised.
    if data_dir_override().is_none() {
        builder = builder.plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        );
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
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
            let data = data_root(app.path().app_data_dir()?);
            app.manage(AssetStore::new(data.join("assets"))?);
            app.manage(DocStore::new(data.join("doc"))?);
            // Beside the document rather than inside it, which is what Q-75
            // settled: the secret is about who may reach this board, not about
            // what is on it, and a document handed to somebody as a bundle
            // (T-84) must not carry the key to the board it came from.
            app.manage(sync::secret::SecretStore::new(data.join("secrets"))?);
            // Which board those secrets are keyed by, when it is no longer the
            // one every installation starts on (T-195, Q-114). Beside them and
            // beside the document for the same reason: it is the third thing
            // that says which board this is, and all three have to be the same
            // age or a launch resolves a mixture of two.
            app.manage(board::BoardStore::new(data.join("board-id"))?);
            app.manage(Hosting::default());
            app.manage(PendingInvite::default());
            // Where the next PDF is going, between the save dialog and the
            // print (T-207). One slot; the path never crosses the boundary.
            app.manage(print::PendingExport::default());
            // One document held open and the pages read off it (T-299, T-318).
            // Nothing in it is written down, so unlike the four above it takes
            // no path and cannot fail to open: everything it holds is derived
            // from a file the asset store already has, and losing all of it
            // costs time and nothing else.
            app.manage(pages::PageStore::default());
            if let Some(window) = app.get_webview_window("main") {
                clipboard::forward_drops(&window, app.handle());
            }

            // T-163. One handler for both arrivals — the plugin delivers the
            // launch URL here as well as later clicks, so cold and warm are the
            // same code and only `PendingInvite` tells them apart.
            {
                use tauri_plugin_deep_link::DeepLinkExt;

                // The link that launched this process, if one did.
                //
                // Separate from `on_open_url` below, and it has to be: on
                // Windows and Linux a cold click does not arrive as an event at
                // all — the operating system re-launches the binary with the URL
                // as `argv[1]`, and `get_current` is what reads it back.
                // `on_open_url` fires for the *handoff* (a link clicked while an
                // instance is already up) and on macOS, where the system really
                // does deliver an event.
                //
                // Found by driving it, not by reading: with only the handler
                // registered, a peer launched with an invite on its command line
                // came up on its own board and never joined, which looks exactly
                // like mDNS failing to find anybody. Both tests passed
                // throughout — neither of these paths is reachable from one.
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    if let Some(url) = urls.last() {
                        invite_arrived(app.handle(), url.to_string());
                    }
                }

                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    // One link, even when several arrive: the last is where the
                    // user wants to be, and joining the others on the way would
                    // be boards flashing past.
                    if let Some(url) = event.urls().last() {
                        invite_arrived(&handle, url.to_string());
                    }
                });

                // Register the scheme with the operating system at runtime.
                //
                // Debug only, and that asymmetry is the whole point: an
                // *installed* Schizoboard gets `schizo://` from its installer,
                // out of `tauri.conf.json`, which is the correct and permanent
                // route. A development build has no installer, so without this
                // there is no way to click an invite on a machine you are
                // building on — and a feature that cannot be driven is a feature
                // nobody can check.
                //
                // It writes to the current user's registry on Windows (HKCU, not
                // HKLM) and to a `.desktop` entry on Linux, so it needs no
                // elevation and touches nobody else's account. It also means the
                // last `npm run tauri dev` to run wins the scheme, which is
                // exactly what you want while working on it and worth knowing
                // if an invite ever opens a build you had forgotten about.
                #[cfg(debug_assertions)]
                if let Err(error) = app.deep_link().register_all() {
                    eprintln!("[sync] schizo:// links will not open this build: {error}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            sync_start,
            sync_stop,
            sync_status,
            sync_take_invite,
            board_remembered,
            board_remember,
            asset_ingest_bytes,
            asset_ingest_path,
            asset_ingest_url,
            page_card,
            open_link,
            asset_has,
            asset_export,
            asset_gc,
            peer_have_summary,
            asset_size,
            asset_partial,
            asset_title,
            asset_chunk,
            asset_receive,
            asset_commit,
            asset_abort,
            doc_append_update,
            doc_load,
            doc_compact,
            bundle_save_as,
            bundle_open,
            reading::document_page_count,
            reading::document_page,
            reading::document_page_image,
            reading::document_text,
            reading::document_close,
            print::export_choose,
            print::export_pdf_write,
            print::export_image_write,
            clipboard::clipboard_read_manifest,
            clipboard::clipboard_read_item,
            clipboard::clipboard_source_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// T-290. `source` is a field in a shared document, so this is untrusted
    /// input from a peer, and the failure it prevents is a link that is an
    /// execution rather than a link.
    #[test]
    fn only_the_web_is_handed_to_the_shell() {
        assert!(is_web_address("https://example.com/a"));
        assert!(is_web_address("HTTP://EXAMPLE.COM"));
        assert!(is_web_address("  https://example.com"), "leading space");

        assert!(!is_web_address("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_web_address("javascript:alert(1)"));
        // This application's own scheme, which is exactly the one somebody
        // would think is safe: a schizo:// link is handled by the deep-link
        // plugin and is not something an item gets to trigger.
        assert!(!is_web_address("schizo://board/x"));
        assert!(!is_web_address("ftp://example.com/x"));
        assert!(!is_web_address("https:/example.com"), "one slash is not a URL");
        assert!(!is_web_address(""));
        // A scheme that merely begins the same way.
        assert!(!is_web_address("httpsx://example.com"));
    }

    /// The environment is process-wide, so these run one after another rather
    /// than in parallel with each other.
    #[test]
    fn the_board_goes_where_it_is_told() {
        let usual = PathBuf::from("C:/Users/somebody/AppData/Roaming/com.philw.schizoboard");

        std::env::remove_var(DATA_DIR_ENV);
        assert_eq!(data_root(usual.clone()), usual);
        // The same answer drives whether this process is single-instanced
        // (T-166), so the two must never disagree about what "set" means.
        assert!(data_dir_override().is_none());

        // An empty value is a script exporting the variable without setting it,
        // not a request to keep the board in the current directory.
        std::env::set_var(DATA_DIR_ENV, "");
        assert_eq!(data_root(usual.clone()), usual);

        std::env::set_var(DATA_DIR_ENV, "D:/scratch/peer-a");
        assert_eq!(data_root(usual.clone()), PathBuf::from("D:/scratch/peer-a"));

        std::env::remove_var(DATA_DIR_ENV);
    }

    #[test]
    fn nothing_running_means_start() {
        assert_eq!(hosting_change(false, None, "abc"), HostingChange::Start);
    }

    #[test]
    fn an_ordinary_reload_keeps_the_relay_it_has() {
        // Since Q-75 a reload resolves the *persisted* secret, which is the one
        // the relay is already hosting — so this arrives as an agreement rather
        // than as an absence. Re-hosting on a fresh port would drop every peer
        // already connected.
        assert_eq!(
            hosting_change(true, Some("abc"), "abc"),
            HostingChange::Keep
        );
    }

    #[test]
    fn a_different_secret_is_a_different_board() {
        // The one found by driving: a window that booted with no secret invents
        // one, and if it is then sent to a board whose secret it was given, the
        // relay standing answers for the wrong board — advertising a
        // fingerprint no peer can match, which looks exactly like mDNS being
        // broken.
        assert_eq!(
            hosting_change(true, Some("abc"), "def"),
            HostingChange::Restart
        );
        assert_eq!(hosting_change(true, None, "def"), HostingChange::Restart);
    }
}
