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
// A markdown file read as what it says (T-346, D-65). `pub` for `cues`'s
// reason: `document` names its types in a reader's public shape, and the
// parser itself is a pure function on a string.
pub mod markdown;
// The shape all four of those readings come out in (D-65, T-322). `pub` for
// `markdown`'s reason exactly: `document` and `reading` both name its types.
pub mod prose;
// An rtf read as its words rather than its control words (T-350).
pub mod rtf;
// A docx read as its words, out of the zip it arrives in (T-353).
pub mod docx;
// An epub read as its words, chapter by chapter in the order its spine states
// (T-354).
pub mod epub;
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
mod workshop;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::InvokeBody;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_window_state::StateFlags;

use assets::{AssetMeta, AssetStore};
use docstore::DocStore;
use workshop::Workshop;

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

/// The room the open board is in, or `None` on an installation that is not on a
/// board yet.
///
/// Asked once, at boot, before there is a provider — which is why it cannot be
/// folded into `sync_status`, whose answers are all about a relay that is by
/// then already running. `app/sync.ts` decides what `None` means; all this side
/// knows is whether anybody has ever said otherwise.
///
/// **The only half of T-195's pair that survives T-356.** Its partner
/// `board_remember` let the frontend *set* the room, and had one caller: a
/// bundle open, which replaced this window's document and had to mint a room the
/// discarded board was not in. Opening a board no longer discards one, so
/// nothing mints a room on that side any more — the register does it, on first
/// sight of a pack id it has never seen (`board.rs`, Q-114). The signature here
/// is unchanged so that `app/invite.ts` and `app/sync.ts` are unchanged.
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

/// [`blocking`], for the commands whose failure is a sentence somebody reads
/// rather than a line in a log.
///
/// It keeps the refusal as data across the boundary. The frontend has to decide
/// whether to tell the person the board cannot hold their file — which is true
/// of a four-hundred-megapixel scan and false of a clipboard entry that went
/// stale — and the only thing it had to decide that on was the prose of the
/// message, which is not a contract (T-309).
///
/// Generic in the value since T-343, and the three ingests are no longer alone
/// in it: a pasted link that will not load has exactly the same problem, and
/// [`page_card`] returning a bare string was what made the frontend drop the one
/// sentence Rust had already written.
async fn blocking_said<T, F>(job: F) -> Result<T, assets::Refusal>
where
    F: FnOnce() -> assets::Result<T> + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(job).await {
        Ok(Ok(value)) => Ok(value),
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
    let meta = blocking_said(move || {
        store_of(&handle)
            .map_err(assets::Error::Unavailable)?
            .ingest_ipc_bytes(&bytes, mime.as_deref())
    })
    .await?;

    schedule_variants(&app, meta.sha256.clone());
    Ok(meta)
}

#[tauri::command]
async fn asset_ingest_path(
    app: AppHandle,
    path: String,
    markdown: bool,
) -> Result<AssetMeta, assets::Refusal> {
    let handle = app.clone();
    let meta = blocking_said(move || {
        store_of(&handle)
            .map_err(assets::Error::Unavailable)?
            .ingest_path(&PathBuf::from(path), markdown)
    })
    .await?;
    schedule_variants(&app, meta.sha256.clone());
    Ok(meta)
}

#[tauri::command]
async fn asset_ingest_url(app: AppHandle, url: String) -> Result<AssetMeta, assets::Refusal> {
    let handle = app.clone();
    let meta = blocking_said(move || {
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
/// **Errors are `Refusal`s and were strings until T-343**, and the reasoning
/// that made them strings was right about the object and wrong about the person.
/// A page that will not load is still not a paste being refused — the note lands
/// either way, and nothing here says the board cannot hold it. But three quite
/// different things end in that same scrap of paper: the address is dead, the
/// address would not answer, and the address is not a page at all. Rust is the
/// side that knows which, it had already written the sentence, and a bare string
/// is a thing the frontend can only log.
///
/// What stays true is the volume: the *ordinary* answer here is a page that
/// loaded and had nothing worth a card, and that is an `Ok` with an empty title.
/// It says nothing, as it should.
#[tauri::command]
async fn page_card(url: String) -> Result<opengraph::Card, assets::Refusal> {
    blocking_said(move || {
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

/// The open board's log.
///
/// One indirection more than it used to be, and the indirection is the point:
/// until T-356 there was one document per installation and this could hand out a
/// `tauri::State<DocStore>` that was the same store for the life of the window.
/// A board is a file now, and another one can be opened while the shell is
/// running, so what is managed is the *workshop* and the store comes out of it.
fn docstore_of(app: &AppHandle) -> docstore::Result<Arc<DocStore>> {
    app.try_state::<Workshop>()
        .ok_or_else(|| docstore::Error::Unavailable("the document log failed to open".into()))?
        .store()
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
    blocking(move || {
        mark_ahead(&app);
        docstore_of(&app)?.append(&bytes)
    })
    .await
}

/// The workshop is about to move past this board's file (T-370).
///
/// **Before the append rather than after it**, and the asymmetry is the point.
/// Marked first, a failed append costs one redundant flush later. Marked after,
/// an append that succeeds while this fails leaves a workshop ahead of a file the
/// register calls level — which is the bug T-370 exists to close, reintroduced
/// in the line that closes it.
///
/// Never fatal for the same reason. What failed is a note about a copy of a copy;
/// the document itself is going to the log either way.
///
/// `doc_compact` deliberately does **not** call this. A workshop compaction
/// rewrites the snapshot from the document it already had, so it does not move
/// the board — marking it would buy one whole pack append per megabyte of log,
/// for a document that has not changed.
fn mark_ahead(app: &AppHandle) {
    let Ok(boards) = boards_of(app) else {
        return;
    };
    let Some(entry) = boards.current() else {
        return;
    };
    if let Err(error) = boards.set_ahead(&entry.pack_id, true) {
        eprintln!("board: that board's file could not be noted as behind its workshop: {error}");
    }
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
/// What an export of this board would weigh, before anybody picks a filename —
/// T-291, Q-314.
///
/// Ordinary JSON arguments rather than [`bundle_save_as`]'s framed payload,
/// because the snapshot is the half this question does not need: the caller
/// already holds it and can add its length itself, and sending several
/// megabytes across the boundary to be told a number the store could have
/// answered from its own directory would be the expensive half of an export
/// performed twice.
#[tauri::command]
async fn bundle_weigh(app: AppHandle, spec: bundle::Spec) -> Result<bundle::Weighed, String> {
    blocking(move || -> assets::Result<bundle::Weighed> {
        let store = store_of(&app).map_err(assets::Error::Unavailable)?;
        Ok(bundle::weigh(&store, &spec))
    })
    .await
}

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
        // `None`: this is *Export board…*, and an export is a copy. A copy
        // that carried the pack id of the board it came from would be a second
        // file the register cannot tell apart from the first — open it and you
        // would land in the original's sync room, holding somebody else's
        // document. A fresh id is what makes a copy a different board (T-359).
        bundle::write(&store, &spec, None, &snapshot, &dest)
    })
    .await
    .map(Some)
}

// --- boards (T-356) ---------------------------------------------------------
//
// A `.schizo` stopped being an export — a photograph of a board — and became
// the board: a file at a path the user chose, written to continuously, and
// switched between. These seven commands are the whole of that from the
// webview's side, and between them they carry no path in either direction.
//
// **`bundle_open` is what they replace, and it is the confirmation in the
// middle of it that is worth an obituary.** It read
// *"Opening X will replace the board in this window. The board you have open now
// will be gone."*, and every word of that was true when it was written (Q-111).
// It is not true now: opening board B leaves board A intact in its own file, so
// there is nothing to warn about and nothing to agree to. A dialog that asks
// permission for a destruction that no longer happens teaches people to click
// through dialogs.

/// One board, as the side that may not know where it is sees it.
///
/// ARCHITECTURE section 4.4's rule — no path crosses the boundary — has always
/// been read in one direction, and a webview handed every board's absolute path
/// can name a location just as surely as one that asked for a path. So the
/// register's outward face carries none.
///
/// `folder` is the **display name** of the directory the file sits in and
/// nothing else: enough to tell two boards called "Untitled board" apart, and
/// not somewhere on a disk. Empty for a board that has no file yet.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct BoardCard {
    pack_id: String,
    title: String,
    folder: String,
    homed: bool,
    current: bool,
}

/// What opening a board turned out to involve.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoardOpened {
    board: BoardCard,
    /// True when this machine had no workshop for that board and the pack was
    /// read to make one — see [`take_up`] for why that is the only time it is.
    seeded: bool,
    /// Listed by the pack's manifest and not actually in the file. Normally
    /// empty; not an error when it is not (DESIGN section 11.1, risk 4).
    missing: Vec<String>,
}

/// The board the user picked out of a dialog, named by the id *this* side
/// issued for it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoardPicked {
    pack_id: String,
    title: String,
}

/// A register entry on its way out, with every path taken off it.
fn card(entry: &board::Entry, current: Option<&str>) -> BoardCard {
    BoardCard {
        title: bundle::display_title(&entry.title),
        // `parent().file_name()` and never `display()`: the *name* of the folder
        // is a fact about which board this is, and the rest of the path is a
        // fact about this machine that the webview has no business holding.
        // Reduced by `display_title` on its own standing — a directory name is a
        // string somebody else chose, and it is about to be drawn in a menu.
        folder: entry
            .path
            .as_deref()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .map(|name| bundle::display_title(&name.to_string_lossy()))
            .unwrap_or_default(),
        homed: entry.homed(),
        current: current == Some(entry.pack_id.as_str()),
        pack_id: entry.pack_id.clone(),
    }
}

fn boards_of(app: &AppHandle) -> Result<tauri::State<'_, board::BoardStore>, String> {
    app.try_state::<board::BoardStore>()
        .ok_or_else(|| "the board register failed to open".to_string())
}

fn workshop_of(app: &AppHandle) -> Result<tauri::State<'_, Workshop>, String> {
    app.try_state::<Workshop>()
        .ok_or_else(|| "the document log failed to open".to_string())
}

/// Every board this installation knows about, most recently opened first.
#[tauri::command]
async fn board_list(app: AppHandle) -> Result<Vec<BoardCard>, String> {
    blocking(move || -> Result<Vec<BoardCard>, String> {
        let boards = boards_of(&app)?;
        let current = boards.current().map(|entry| entry.pack_id);
        Ok(boards
            .list()
            .iter()
            .map(|entry| card(entry, current.as_deref()))
            .collect())
    })
    .await
}

/// The board this window is on, or `None` before there is one.
#[tauri::command]
async fn board_current(app: AppHandle) -> Result<Option<BoardCard>, String> {
    blocking(move || -> Result<Option<BoardCard>, String> {
        Ok(boards_of(&app)?
            .current()
            .map(|entry| card(&entry, Some(&entry.pack_id))))
    })
    .await
}

/// Point this window's document log at another board.
///
/// Takes a pack id **this side issued** and resolves the file from its own
/// register, which is the outward half of "no path crosses the boundary": the
/// webview hands back an opaque token it was given by [`board_list`] or
/// [`board_open_picked`] and never names a location.
///
/// ## The caller's half of the contract
///
/// Nothing may append to the old board's log after this returns, and nothing
/// here can enforce that — a lock on this side would serialise an append against
/// the switch and then let the append win. `crdt/persistence.ts`'s `close()`
/// unsubscribes *before* it awaits its own flush, so when it resolves there is
/// nothing left that could enqueue. `workshop.rs` writes the order out in full.
///
/// ## And the register is written last
///
/// Everything above it can fail — the workshop may not open, the pack may not
/// read — and a failure leaves this window on the board it was already on, in
/// the room it was already in. The frontend reloads afterwards; a reload that
/// followed a failure comes back to exactly where it started.
#[tauri::command]
async fn board_open(app: AppHandle, pack_id: String) -> Result<BoardOpened, String> {
    blocking(move || open_board(&app, &pack_id)).await
}

fn open_board(app: &AppHandle, pack_id: &str) -> Result<BoardOpened, String> {
    let boards = boards_of(app)?;
    let missing_board = || "there is no such board on this machine".to_string();
    let entry = boards.find(pack_id).ok_or_else(missing_board)?;
    let previous = boards.current();

    let workshop = workshop_of(app)?;
    let assets = store_of(app)?;
    let taken = take_up(&workshop, &assets, &entry).inspect_err(|_| {
        // `Workshop::switch` already refuses to drop the board it has when the
        // *switch* fails. This is the other half: a switch that worked, followed
        // by a pack that would not be read. A board that will not open is a board
        // you are told about; it is not a reason to lose the one you are on.
        if let (Some(previous), Ok(workshop)) = (&previous, workshop_of(app)) {
            let _ = workshop.switch(previous);
        }
    })?;
    note_generation(&boards, &entry);

    // Thumbnails and display variants are a local derivative, never carried in
    // the file — a pack holds originals, named by the only hash that can name
    // them. Rebuilt on the same background path a paste uses, so the board can
    // start drawing placeholders immediately rather than waiting on a few
    // hundred decodes. Only for what came *in*: doing it for what this machine
    // already held would decode every picture on the board on every open.
    for sha256 in &taken.ingested {
        schedule_variants(app, sha256.clone());
    }

    let entry = boards
        .open(pack_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(missing_board)?;
    Ok(BoardOpened {
        board: card(&entry, Some(pack_id)),
        seeded: taken.seeded,
        missing: taken.missing,
    })
}

/// What [`take_up`] found when it opened a board's workshop.
struct TakenUp {
    seeded: bool,
    ingested: Vec<String>,
    missing: Vec<String>,
}

/// Open a board's workshop, seeding it from the pack if it is empty.
///
/// **The workshop wins when there is one**, and that single branch is what
/// covers a torn append, a power cut mid-flush, a quit with no close hook, and a
/// pack on a USB stick that was pulled. A workshop with anything in it is a
/// session that ended before its pack was flushed, and it is therefore newer
/// than the pack by construction — reading the pack over it would throw away
/// exactly the work the workshop exists to keep.
///
/// A board whose file has been deleted or unplugged still opens, on its
/// workshop, which is the same rule read from the other end.
///
/// ## The photographs are taken either way (T-363)
///
/// The document half above is the whole of what this used to do, and it left
/// stage 1's worst hole open. `assets/` is one store for the whole installation
/// and `AssetStore::gc` takes one keep-set — the board this window is on — so
/// the first sweep after a switch trashes every photograph belonging to every
/// board you are not on. That was argued to be safe because reopening a board
/// brings them back out of its pack, and it was not: this function read the
/// pack only when the workshop was empty, and a board you have opened before
/// always has a workshop. The bytes sat in the thirty-day trash with nothing to
/// pull them out, and the board drew them torn.
///
/// So the assets are topped up on **every** open, and only the document half is
/// conditional. It is nearly free — `bundle::top_up` reads the manifest and one
/// `has` per hash, and never touches an entry this machine already holds
/// (T-359) — and it is what makes the sweep's whole recoverable-for-thirty-days
/// argument true rather than merely stated.
///
/// A top-up that fails is **not** an open that fails, which is the other half
/// of the same rule: the workshop is the board, and a pack that has been
/// deleted or unplugged is a bonus this open does not get.
/// Catch the register up with where that board's file has actually got to
/// (T-368), so the next append can tell somebody else's writing from its own.
///
/// Called after every [`take_up`], because taking a board up is the moment this
/// window's belief about its file is formed — a pack somebody sent you at
/// generation five is one you have just caught up with, not one you are behind
/// on.
///
/// **Never fatal, and a file that will not open leaves the belief alone.** Not
/// knowing has to err toward refusing a later append rather than toward making
/// one, and a stale belief does exactly that.
fn note_generation(boards: &board::BoardStore, entry: &board::Entry) {
    let Some(path) = entry.path.as_deref() else {
        return;
    };
    match bundle::generation_of(path) {
        Ok(generation) => {
            if let Err(error) = boards.set_generation(&entry.pack_id, generation) {
                eprintln!("board: that board's generation could not be kept: {error}");
            }
        }
        Err(error) => {
            eprintln!("board: where that board's file had got to could not be read: {error}");
        }
    }
}

fn take_up(
    workshop: &Workshop,
    assets: &AssetStore,
    entry: &board::Entry,
) -> Result<TakenUp, String> {
    let nothing = || TakenUp {
        seeded: false,
        ingested: Vec::new(),
        missing: Vec::new(),
    };
    let store = workshop.switch(entry).map_err(|e| e.to_string())?;
    let state = store.load().map_err(|e| e.to_string())?;
    let fresh = state.snapshot.is_none() && state.updates.is_empty();
    let Some(path) = entry.path.as_deref() else {
        return Ok(nothing());
    };

    if !fresh {
        // The workshop already holds this board and is newer than the pack by
        // construction, so nothing here may fail the open. A pack that will not
        // read is a console line and a board that opens.
        return match bundle::top_up(assets, path) {
            Ok(restored) => Ok(TakenUp {
                seeded: false,
                ingested: restored.ingested,
                missing: restored.missing,
            }),
            Err(error) => {
                eprintln!("board: that board's file could not be read for its photographs: {error}");
                Ok(nothing())
            }
        };
    }

    // An empty workshop, where the pack is the only copy of the document there
    // is — so here a pack that will not read *is* the failure, and saying so
    // beats opening an empty board.
    let opened = bundle::read(assets, path).map_err(|e| e.to_string())?;
    // A pack with no document in it is not one a workshop can be seeded from,
    // and `DocStore::compact` would refuse it anyway — an empty snapshot would
    // truncate the log in exchange for nothing.
    let seeded = !opened.snapshot.is_empty();
    if seeded {
        store.compact(&opened.snapshot).map_err(|e| e.to_string())?;
    }
    Ok(TakenUp {
        seeded,
        ingested: opened.ingested,
        missing: opened.missing,
    })
}

/// Which board did the user pick? — the dialog half of *Open a board…*.
///
/// Picks and peeks and admits, and deliberately **does not switch**: the caller
/// has to close its persistence between finding out that a board was picked and
/// this window moving onto it, and it cannot close it before, because a cancelled
/// dialog would leave a window that had stopped saving. So the switch is
/// [`board_open`] — the same call the recents make, which is also why a board
/// opened from a picker and a board opened from the menu cannot drift apart.
///
/// `None` is a cancelled dialog: an ordinary outcome, not a failure.
///
/// ## Where the pack id comes from
///
/// Out of `manifest.json` when there is one, which is what keeps a board in its
/// sync room across a rename (`board.rs`, Q-114). A `.schizo` written before
/// T-359 carries none, and that falls back to the path — the one place in this
/// application where a path is a key, and it is a fallback rather than the key
/// precisely so that a renamed board does not silently leave its room. The
/// first flush writes an id into the file and nothing consults the fallback
/// again.
#[tauri::command]
async fn board_open_picked(app: AppHandle) -> Result<Option<BoardPicked>, String> {
    // Off the main thread, or the dialog asks the main thread to open it and
    // then waits for it. See `asset_export`.
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .file()
            .set_title("Open a board")
            .add_filter("Schizoboard board", &[bundle::EXTENSION])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(src) = picked else {
        return Ok(None);
    };
    let src = src.into_path().map_err(|e| e.to_string())?;

    blocking(move || -> Result<Option<BoardPicked>, String> {
        // One small entry rather than the whole archive: this is the step that
        // answers "is that a board at all, and which one" before anything of a
        // stranger's is read into this machine's store.
        let manifest = bundle::peek(&src).map_err(|e| e.to_string())?;
        let boards = boards_of(&app)?;
        let pack_id = manifest
            .pack_id
            .filter(|id| board::is_pack_id(id))
            .or_else(|| boards.by_path(&src).map(|entry| entry.pack_id))
            .unwrap_or_else(board::mint_pack_id);
        let entry = boards
            .admit(&pack_id, &src, &manifest.title)
            .map_err(|e| e.to_string())?;
        Ok(Some(BoardPicked {
            title: bundle::display_title(&entry.title),
            pack_id: entry.pack_id,
        }))
    })
    .await
}

/// A board nothing has ever been on — *New board…*.
///
/// No dialog, and that asymmetry with [`board_open_picked`] is the design rather
/// than an omission: a new board has no file to find. It gets one from
/// [`board_home`] once there is a title to name it by, which is the same road the
/// board adopted from before T-356 takes.
///
/// The caller's contract is [`board_open`]'s, for the same reason: this window's
/// log is about to become another board's.
#[tauri::command]
async fn board_new(app: AppHandle) -> Result<BoardCard, String> {
    blocking(move || -> Result<BoardCard, String> {
        let boards = boards_of(&app)?;
        let entry = boards.mint().map_err(|e| e.to_string())?;
        if let Err(error) = workshop_of(&app)?.switch(&entry) {
            // Taken back out rather than left behind. A board whose workshop
            // will not open is a row in the recents that can never be opened,
            // and nothing on screen would say why.
            let _ = boards.forget(&entry.pack_id);
            return Err(error.to_string());
        }
        let entry = boards
            .open(&entry.pack_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "the new board could not be recorded".to_string())?;
        Ok(card(&entry, Some(&entry.pack_id)))
    })
    .await
}

/// Write the open board into its own file — the second tier of saving.
///
/// The pack id is the **register's**, not the caller's, which is the rule the
/// whole design turns on: a flush preserves the pack id and a copy mints one, so
/// two files never share a sync room. `bundle::write` takes it as a parameter
/// rather than off `Spec` precisely so that it cannot arrive from the webview —
/// a webview that could name a pack id could name a board it is not on.
///
/// `Ok(None)` for a board that has no file yet. That is not a failure: it is the
/// adopted pre-T-356 board, and [`board_home`] is the row that answers it.
///
/// The payload is framed rather than JSON — see [`bundle::split_payload`].
#[tauri::command]
async fn board_flush(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<bundle::Written>, String> {
    let (spec, snapshot) = board_payload("board_flush", &request)?;
    blocking(move || -> Result<Option<bundle::Written>, String> {
        let boards = boards_of(&app)?;
        let entry = boards
            .current()
            .ok_or_else(|| "no board is open in this window".to_string())?;
        let Some(dest) = entry.path.clone() else {
            return Ok(None);
        };
        write_pack(&app, &boards, &entry, &spec, &snapshot, &dest, Writing::Flush).map(Some)
    })
    .await
}

/// Give a board that has no file one, and write it there.
///
/// **The location is chosen entirely on this side**, which is `asset_export`'s
/// rule kept: the frontend supplies a *title* and the shell supplies the place.
/// No dialog either, and that is not the same decision twice — a board that has
/// been running out of the data directory since before T-356 has already been
/// decided on, and asking where to put it would be asking a question the user
/// never asked.
///
/// The pack is written *before* the home is recorded, so a write that failed
/// leaves the board unhomed and running exactly where it was, with the row still
/// on the menu to try again. A migration that can fail and has no manual path
/// leaves somebody stuck.
#[tauri::command]
async fn board_home(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<bundle::Written, String> {
    let (spec, snapshot) = board_payload("board_home", &request)?;
    blocking(move || -> Result<bundle::Written, String> {
        let boards = boards_of(&app)?;
        let entry = boards
            .current()
            .ok_or_else(|| "no board is open in this window".to_string())?;
        if entry.homed() {
            return Err("that board already has a file of its own".to_string());
        }
        let dest = a_home_for(&app, &spec.title)?;
        // A board that has never had a file gets a whole one, which `save_pack`
        // does anyway for a destination that is not there — said here as the
        // intention rather than left to fall out of the path check.
        let written = write_pack(&app, &boards, &entry, &spec, &snapshot, &dest, Writing::Whole)?;
        boards
            .set_home(&entry.pack_id, &dest)
            .map_err(|e| e.to_string())?;
        Ok(written)
    })
    .await
}

/// The spec and the snapshot out of a framed body — [`bundle::split_payload`].
fn board_payload(
    who: &str,
    request: &tauri::ipc::Request<'_>,
) -> Result<(bundle::Spec, Vec<u8>), String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err(format!("{who} expects a raw body"));
    };
    let (json, snapshot) = bundle::split_payload(body).map_err(|e| e.to_string())?;
    let spec: bundle::Spec = serde_json::from_slice(json).map_err(|e| e.to_string())?;
    Ok((spec, snapshot.to_vec()))
}

/// Fold a board's file back into one — the row on the cork menu (T-367).
///
/// Always compacts, however little there is to reclaim, because somebody asked.
/// The automatic half is on the switch (see [`save_pack`]) and is the one with
/// a threshold; a row that decided for itself whether to do the thing it says
/// would be a row you cannot trust.
///
/// Takes the *whole* document rather than reading the pack for it, on
/// `board_flush`'s standing: this window has the newest board there is, and the
/// pack is at best as new as the last flush.
#[tauri::command]
async fn board_compact(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<bundle::Tidied>, String> {
    let (spec, snapshot) = board_payload("board_compact", &request)?;
    blocking(move || -> Result<Option<bundle::Tidied>, String> {
        let boards = boards_of(&app)?;
        let entry = boards
            .current()
            .ok_or_else(|| "no board is open in this window".to_string())?;
        // A board with no file of its own has nothing to compact, which is the
        // same `Ok(None)` a flush gives and means the same thing.
        let Some(dest) = entry.path.clone() else {
            return Ok(None);
        };
        // The agreement check `write_pack` makes, before anything rewrites a
        // whole file: the register says which *file* and the workshop says which
        // *document*, and a disagreement would fold one board's work into
        // another board's pack.
        if workshop_of(&app)?.current().as_deref() != Some(entry.workshop.as_path()) {
            return Err("that board's document is not the one this window has open".to_string());
        }
        let store = store_of(&app)?;
        // Through `noting` like every other write of this file, and T-374 is what
        // it cost not to be. A compaction *is* `bundle::write`, so it leaves a
        // pack with no generations in it — and the register went on saying five.
        // The next flush then read the board's own tidying as another window's
        // writing and sealed the pack, on a machine running one window.
        let tidied = noting(&boards, &entry.pack_id, Writing::Fold, || {
            bundle::compact(&store, &entry.pack_id, &dest)
                .map(|tidied| (tidied, 0))
                .map_err(|e| Refused::Failed(e.to_string()))
        })
        .map_err(|refused| refused.to_string())?;
        if let Err(error) = boards.set_title(&entry.pack_id, &spec.title) {
            eprintln!("board: that board's title could not be kept: {error}");
        }
        Ok(Some(tidied))
    })
    .await
}

/// Leave this board with its file tidied, if there is enough in it to be worth
/// the rewrite (T-367, Q-350).
///
/// The automatic half of compaction, and the threshold lives **here** rather
/// than in the caller for one reason: a number that decides when to spend
/// seconds of somebody's disk, written down in two languages, is a number that
/// will disagree with itself. The frontend asks whether to leave tidily; Rust
/// answers with what it did.
///
/// `Ok(None)` for a board with no file, and for one whose file has too little
/// in it to be worth rewriting — the ordinary case on the ordinary switch, and
/// not news.
#[tauri::command]
async fn board_compact_on_leaving(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<bundle::Written>, String> {
    let (spec, snapshot) = board_payload("board_compact_on_leaving", &request)?;
    blocking(move || -> Result<Option<bundle::Written>, String> {
        let boards = boards_of(&app)?;
        let entry = boards
            .current()
            .ok_or_else(|| "no board is open in this window".to_string())?;
        let Some(dest) = entry.path.clone() else {
            return Ok(None);
        };
        // Cheap enough to ask on every switch: the central directory already
        // knows what each generation weighs, so this reads no entry at all.
        if !bundle::worth_compacting(&dest) {
            return Ok(None);
        }
        write_pack(&app, &boards, &entry, &spec, &snapshot, &dest, Writing::Fold).map(Some)
    })
    .await
}

/// Whether this board's file has enough superseded in it to be worth offering
/// to tidy — for deciding whether the row exists at all.
///
/// **A boolean rather than the fraction**, so that the threshold stays in the
/// one place that also acts on it (`board_compact_on_leaving`). Handing the
/// number across and comparing it on the other side would be the same decision
/// written down in two languages, which is a decision that will eventually
/// disagree with itself — and the two halves disagreeing means a row that
/// offers to reclaim what leaving already reclaimed.
///
/// Costs an open and no reads: the central directory already knows what every
/// generation weighs. `false` on a board with no file, and on one whose file
/// has gone.
#[tauri::command]
async fn board_worth_tidying(app: AppHandle) -> Result<bool, String> {
    blocking(move || -> Result<bool, String> {
        let Some(entry) = boards_of(&app)?.current() else {
            return Ok(false);
        };
        let Some(dest) = entry.path else {
            return Ok(false);
        };
        Ok(bundle::worth_compacting(&dest))
    })
    .await
}

/// Whether this board's workshop has moved since its file was last written
/// (T-370).
///
/// The one question a boot has to ask and could not, and the answer costs no
/// disk at all — it was written down the last time either side of it moved.
///
/// **The frontend asks rather than being told**, because the catch-up is a flush
/// and only that side can produce a snapshot to flush. What crosses is one
/// boolean; the register, the paths and the generation numbers all stay here.
///
/// `false` on a board with no file, which reads oddly and is right: a flush
/// would return `None` for it anyway, and `homeBoard` is what gives such a board
/// a file a second and a half into the session.
#[tauri::command]
async fn board_workshop_ahead(app: AppHandle) -> Result<bool, String> {
    blocking(move || -> Result<bool, String> {
        let Some(entry) = boards_of(&app)?.current() else {
            return Ok(false);
        };
        Ok(entry.ahead && entry.homed())
    })
    .await
}

/// Whether this window has stopped writing this board's file because another
/// one is writing it (T-368).
///
/// **Asked after a flush fails rather than carried back by the failure**, and
/// the reason is the same one `Refused` exists for: the alternative is the
/// frontend matching on the text of an error message, which stops working the
/// day somebody improves the wording. `board_flush` says only that it did not
/// write; this says whether that is the one kind of not-writing there is no
/// point retrying.
///
/// Session-long and one-way — `Entry::taken` is `#[serde(skip)]`, so a relaunch
/// starts clean, which is also the relaunch that re-reads the file and finds out
/// where it actually got to.
#[tauri::command]
async fn board_pack_taken(app: AppHandle) -> Result<bool, String> {
    blocking(move || -> Result<bool, String> {
        Ok(boards_of(&app)?.current().is_some_and(|entry| entry.taken))
    })
    .await
}

/// Why a pack was not written, when the caller has to tell two kinds apart.
///
/// Everything in this application that fails a pack write is a thing to report
/// and try again on — a disk that filled, a network drive that went away, a file
/// somebody had open. **One is not**, and it is the reason this is an enum
/// rather than the `String` it used to be: a file another window is writing must
/// stop being written by this one, and a caller matching on the text of an error
/// message to decide that would be a caller that stops deciding it the day
/// somebody improves the wording.
#[derive(Debug)]
enum Refused {
    /// Another window has written this board's file since this one did (T-368).
    Taken,
    /// Anything else.
    Failed(String),
}

impl Refused {
    /// What the person looking at the board is told. Names the other window
    /// rather than the mechanism, because the generation number is true and is
    /// not what anybody needs.
    const TAKEN: &'static str =
        "another window is writing this board's file, so this one has stopped";
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refused::Taken => write!(f, "{}", Refused::TAKEN),
            Refused::Failed(why) => write!(f, "{why}"),
        }
    }
}

/// Which of the two writes a caller is asking for.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Writing {
    /// The ordinary flush: append a generation, falling back to a whole file
    /// when there is nothing to append to.
    Flush,
    /// A board being given its first file. A whole one, always.
    Whole,
    /// A compaction: fold the generations away, reading the document **out of
    /// the file itself** rather than out of this window.
    Fold,
}

impl Writing {
    /// Whether this write puts *this window's document* into the file (T-374).
    ///
    /// The distinction is what the register's `ahead` flag turns on, and the two
    /// cases are genuinely different rather than a shade of one. A flush and a
    /// first home both carry the document across, so the file is level with the
    /// workshop afterwards and the note comes down. A compaction carries
    /// nothing: `bundle::compact` reads the document out of the pack's own
    /// newest generation, so a workshop that was ahead of that file before is
    /// still ahead of it after, and clearing the note would lose the catch-up at
    /// the next launch.
    ///
    /// It is reachable: `Pack.settle` flushes and then compacts on the way out
    /// of a board, and a flush that failed leaves exactly that state.
    fn carries_the_document(self) -> bool {
        match self {
            Writing::Flush | Writing::Whole => true,
            Writing::Fold => false,
        }
    }
}

/// Append a generation, or write the whole file when appending is not on.
///
/// **Appending is the ordinary case and the whole of T-366.** A flush used to be
/// a fresh zip beside the old one and a rename, which is O(the file) and the
/// free space twice over; a generation is O(the snapshot) whatever the pack
/// weighs. That is what deleted stage 1's size gate — above 256 MB the idle
/// flush used to stand down, and there is nothing left for it to stand down
/// from.
///
/// ## The three cases that fall back to a whole write, and they are one case
///
/// A file that is not there, a file that is not a zip, and a file whose central
/// directory has gone. All three are "there is nothing here to append to", and
/// the third is the interesting one: it is a **torn append**, and this is its
/// recovery.
///
/// `ZipWriter::new_append` leaves the cursor on the first byte of the old EOCD,
/// so a power cut during an append leaves a file with no directory at all and
/// no earlier one to fall back to. D-70 chose to let that happen rather than
/// defend against it, because the pack is not the only copy — the workshop is a
/// crash-safe log and the asset store holds every byte — so the honest recovery
/// is to write the file again from a document that is still on this machine.
/// Which is this line, and it costs one whole write on a board that has just
/// been through a power cut.
///
/// A forward `PK` repair scan is deliberately not built (D-70): it is the
/// hand-rolled zip parsing `Cargo.toml` forbids, and it recovers strictly less
/// than the workshop already does.
fn save_pack(
    store: &AssetStore,
    spec: &bundle::Spec,
    pack_id: &str,
    snapshot: &[u8],
    dest: &Path,
    writing: Writing,
    ours: u32,
) -> Result<(bundle::Written, u32), Refused> {
    if writing == Writing::Fold && dest.is_file() {
        // Everything the pack holds goes back into the store before anything
        // reads the store to decide what the new file gets — `bundle::compact`
        // says why that is not an optimisation.
        return bundle::compact(store, pack_id, dest)
            // A compaction is `write`, so what it leaves is a pack with no
            // generations at all — and the register has to be told that, or the
            // next append would expect a generation the file no longer has and
            // read its own tidying as somebody else's writing (T-374).
            .map(|tidied| (tidied.written, 0))
            .map_err(|e| Refused::Failed(e.to_string()));
    }
    // A fold with no file to fold is nothing to do rather than a whole write.
    // `board_compact_on_leaving` cannot reach it — `worth_compacting` is false
    // for a file that has gone — and the line is here so that the *next* caller
    // of `Fold` cannot silently get a whole file written from a snapshot it only
    // passed along to be polite.
    if writing == Writing::Fold {
        return Err(Refused::Failed(format!(
            "{} is not there to be tidied",
            dest.display()
        )));
    }
    if dest.is_file() {
        match bundle::append(store, spec, pack_id, snapshot, dest, ours) {
            Ok(written) => return Ok((written, ours + 1)),
            // **The one append failure that must not fall back** (T-368). Every
            // other error here means there is nothing to append to, and writing
            // the whole file again is the honest recovery; this one means there
            // is somebody else's work in the file, and the rename underneath
            // that recovery would take all of it.
            Err(error @ bundle::Error::Interleaved { .. }) => {
                eprintln!("board: {} is being written by another window: {error}", dest.display());
                return Err(Refused::Taken);
            }
            Err(error) => eprintln!(
                "board: {} could not be appended to and is being written again: {error}",
                dest.display()
            ),
        }
    }
    // A whole file, so no generations in it — the same zero a compaction leaves,
    // and for the same reason: this *is* the compaction's writer.
    bundle::write(store, spec, Some(pack_id), snapshot, dest)
        .map(|written| (written, 0))
        .map_err(|e| Refused::Failed(e.to_string()))
}

/// **Every write of a board's file goes through here**, and it is the only place
/// that keeps the register's account of that file (T-370, T-368, T-374).
///
/// The account is three facts: whether the workshop is ahead of the file, what
/// generation the file is at, and whether another window has taken it. They were
/// kept in two places for one commit — `write_pack` had all three and
/// `board_compact` had none — and the cost of that was immediate and
/// user-visible: pressing *Tidy up this board's file* left the register saying
/// generation 5 over a file a compaction had just put back to zero, so the very
/// next flush read the board's own tidying as somebody else's writing and sealed
/// the pack, with **THIS BOARD'S FILE IS NOT BEING UPDATED — another window has
/// the file** on the bar and no other window anywhere. So this takes a closure
/// rather than being three calls a caller has to remember, and the second road
/// is gone.
///
/// ## `ahead` is cleared before the write and put back if it fails
///
/// `app/pack.ts`'s discipline one tier down, and load-bearing for the same
/// reason. An edit landing while the write is in flight marks the board ahead
/// again — `doc_append_update` does that, and does it *before* its own append —
/// and clearing afterwards would overwrite exactly that mark, leaving a register
/// saying "level" over a workshop that is not, for the edits made during the
/// slowest writes.
///
/// ## And only by a write that carries the document
///
/// A compaction does not (see [`Writing::carries_the_document`]): it reads the
/// board out of the pack's own newest generation, so a workshop that was ahead
/// of that file before it is still ahead of it after. Clearing the note there
/// would throw away the catch-up at the next launch, and `Pack.settle` reaches
/// it whenever a flush fails on the way out of a board.
///
/// ## None of the three notes is fatal
///
/// What is being kept here is a fact about a copy of a copy. A note that could
/// not be written costs a redundant append at the next boot; refusing to write
/// the file over it would cost the flush itself.
fn noting<T>(
    boards: &board::BoardStore,
    pack_id: &str,
    writing: Writing,
    write: impl FnOnce() -> Result<(T, u32), Refused>,
) -> Result<T, Refused> {
    if writing.carries_the_document() {
        if let Err(error) = boards.set_ahead(pack_id, false) {
            eprintln!("board: that board's file could not be noted as written: {error}");
        }
    }
    match write() {
        Ok((written, generation)) => {
            // What the file is at now, so the next append can tell somebody
            // else's writing from its own.
            if let Err(error) = boards.set_generation(pack_id, generation) {
                eprintln!("board: that board's generation could not be kept: {error}");
            }
            Ok(written)
        }
        Err(refused) => {
            if writing.carries_the_document() {
                if let Err(error) = boards.set_ahead(pack_id, true) {
                    eprintln!("board: that board's file could not be noted as behind: {error}");
                }
            }
            // One way, and only for this session — `Entry::taken` is not written
            // to the register, so a relaunch starts clean and re-reads the file.
            if matches!(refused, Refused::Taken) {
                if let Err(error) = boards.set_taken(pack_id) {
                    eprintln!("board: that board could not be marked as taken: {error}");
                }
            }
            Err(refused)
        }
    }
}

/// The pack, and the register's note of what the board is now called.
///
/// The title is only ever *remembered* here — Rust holds no schema and cannot
/// read `meta.title` (ARCHITECTURE section 4.2). It is written down because the
/// menu names a board before it is open, and a board that is not open has
/// nothing but this register to be named by.
fn write_pack(
    app: &AppHandle,
    boards: &board::BoardStore,
    entry: &board::Entry,
    spec: &bundle::Spec,
    snapshot: &[u8],
    dest: &Path,
    writing: Writing,
) -> Result<bundle::Written, String> {
    // The register says which *file*, and the workshop says which *document*.
    // This is the one place they have to agree: a flush writes a whole document
    // into a whole file, so a disagreement puts one board's work in another
    // board's pack and nothing anywhere reports it. `board_open` is written so
    // that they cannot come apart — the register moves last, and only after the
    // workshop has — and this is the line that says so rather than leaving it as
    // a property of the reading.
    if workshop_of(app)?.current().as_deref() != Some(entry.workshop.as_path()) {
        return Err("that board's document is not the one this window has open".to_string());
    }
    // Already lost this file to another window, so this window does not go on
    // trying (T-368). Re-detecting would work — our belief stays behind, so every
    // append would be refused on its own merits — but it would also read the file
    // and build a whole snapshot to be told the same thing again every idle
    // interval, and the frontend has already been told once and sealed.
    if entry.taken {
        return Err(Refused::TAKEN.to_string());
    }
    let store = store_of(app)?;
    let written = noting(boards, &entry.pack_id, writing, || {
        save_pack(
            &store,
            spec,
            &entry.pack_id,
            snapshot,
            dest,
            writing,
            entry.generation,
        )
    })
    .map_err(|refused| refused.to_string())?;
    // Not fatal. A title the register missed is a stale row in a menu; the file
    // it names is written and correct either way.
    if let Err(error) = boards.set_title(&entry.pack_id, &spec.title) {
        eprintln!("board: that board's title could not be kept: {error}");
    }
    Ok(written)
}

/// Where boards without a file of their own go.
const HOME_DIR: &str = "Schizoboard";

/// Past this, a collision is somebody with a naming scheme rather than a board
/// that needs a home, and going on trying is a directory being enumerated.
const MAX_HOME_TRIES: u32 = 999;

fn a_home_for(app: &AppHandle, title: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .document_dir()
        .map_err(|e| format!("this machine has no Documents folder: {e}"))?
        .join(HOME_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = assets::safe_stem(title).unwrap_or_else(|| "Untitled board".to_string());
    free_name(&dir, &stem).ok_or_else(|| format!("there are already {MAX_HOME_TRIES} of {stem:?}"))
}

/// The first name in `dir` that is not taken, `<stem>.schizo` for choice.
///
/// A race rather than a guarantee, and it is the right shape anyway: two
/// processes homing a board in the same millisecond would be two processes with
/// the same board open, which is a much larger problem than a filename. What
/// this does prevent is the ordinary one — two boards both called *Untitled
/// board*, where the second would silently overwrite the first.
fn free_name(dir: &Path, stem: &str) -> Option<PathBuf> {
    (1..=MAX_HOME_TRIES)
        .map(|n| {
            dir.join(match n {
                1 => format!("{stem}.{}", bundle::EXTENSION),
                n => format!("{stem} {n}.{}", bundle::EXTENSION),
            })
        })
        .find(|candidate| !candidate.exists())
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
            //
            // A register rather than the one string it was until T-356, and it
            // takes up a data directory from before that change on the spot:
            // the document at `doc/` becomes a board with the room the old
            // `board-id` file names, adopted **in place** so that nothing moves
            // and an older binary would still find the same log. See `board.rs`.
            let boards = board::BoardStore::new(data.join("boards.json"))?;
            if let Err(error) = boards.adopt_legacy(&data) {
                // Not fatal, and deliberately: `ensure_current` below still
                // gives this window a board to be on. What is lost is the room
                // the old `board-id` file named, which the next launch will try
                // to take up again — the document itself has not moved and is
                // not at risk either way.
                eprintln!("board: this installation's board could not be taken up: {error}");
            }
            // Which document this window writes to. Fallible, and fatal if it
            // fails: a window with no workshop is a window whose every edit
            // would be refused, and `setup` returning the error is how that
            // becomes a shell that does not start rather than a board that
            // silently is not being saved.
            let workshop = Workshop::new(data.clone());
            let entry = boards.ensure_current()?;
            // **The same road a switch takes, and that is the whole of T-371.**
            //
            // This was `workshop.switch(&entry)?` and nothing else, which left
            // two ways of opening a board that disagreed about where one comes
            // from. `board_open` seeds an *empty* workshop from the board's
            // pack; boot did not. So an installation whose register still named
            // a board, whose pack was intact, and whose workshop directory had
            // gone — a cleanup tool, a quarantine, a partial restore — opened an
            // empty board and then wrote the emptiness back, because
            // `initialiseBoard`'s own meta write reaches the disk and the flush
            // five seconds later put an empty document in the file.
            //
            // `take_up` is already exactly right and always was: the workshop
            // wins when it has anything in it, the pack seeds it when it does
            // not. What was wrong is that this line was not going through it.
            if let Err(error) = take_up(&workshop, store_of(app.handle())?.inner(), &entry) {
                // The seed may fail; the switch may not. A pack that will not
                // read leaves an empty workshop, which is a board somebody can
                // work on — where a shell that refuses to start is not. The
                // retry below is what keeps the fatal half fatal: a window with
                // no workshop is a window whose every edit would be refused, and
                // `setup` returning the error is how that becomes a shell that
                // does not start rather than a board silently not being saved.
                eprintln!("board: that board's file could not be taken up at boot: {error}");
                workshop.switch(&entry)?;
            }
            // Where this window believes that file is, before anything writes to
            // it — including a launch that finds another window already has it.
            note_generation(&boards, &entry);
            app.manage(workshop);
            app.manage(boards);
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
            board_list,
            board_current,
            board_open,
            board_open_picked,
            board_new,
            board_flush,
            board_home,
            board_compact,
            board_compact_on_leaving,
            board_worth_tidying,
            board_workshop_ahead,
            board_pack_taken,
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
            bundle_weigh,
            bundle_save_as,
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
        assert!(
            !is_web_address("https:/example.com"),
            "one slash is not a URL"
        );
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

    // --- boards (T-356) -----------------------------------------------------

    /// A data root with an asset store and a workshop in it, as `setup` would
    /// have left one.
    fn installation() -> (tempfile::TempDir, Workshop, AssetStore) {
        let dir = tempfile::tempdir().unwrap();
        let assets = AssetStore::new(dir.path().join("assets")).unwrap();
        let workshop = Workshop::new(dir.path().to_path_buf());
        (dir, workshop, assets)
    }

    fn a_board(workshop: &str, path: Option<PathBuf>) -> board::Entry {
        board::Entry {
            pack_id: board::mint_pack_id(),
            board_id: board::mint_board_id(),
            path,
            workshop: PathBuf::from(workshop),
            title: "Case one".to_string(),
            last_opened: 0,
            ahead: false,
            generation: 0,
            taken: false,
        }
    }

    /// A `.schizo` with a document in it and no photographs.
    fn a_pack(assets: &AssetStore, dest: &Path, document: &[u8]) {
        let spec = bundle::Spec {
            schema_version: 1,
            title: "Case one".to_string(),
            assets: Vec::new(),
        };
        bundle::write(assets, &spec, None, document, dest).unwrap();
    }

    #[test]
    fn a_board_opened_where_there_is_no_workshop_yet_is_seeded_from_its_pack() {
        let (dir, workshop, assets) = installation();
        let pack = dir.path().join("case one.schizo");
        a_pack(&assets, &pack, b"the pack's document");

        let entry = a_board("boards/board-one", Some(pack));
        let taken = take_up(&workshop, &assets, &entry).unwrap();

        assert!(taken.seeded);
        assert!(taken.missing.is_empty());
        let state = workshop.store().unwrap().load().unwrap();
        assert_eq!(state.snapshot.as_deref(), Some(&b"the pack's document"[..]));
    }

    /// A `.schizo` holding a document and one photograph, and the hash of it.
    fn a_pack_with_a_photograph(assets: &AssetStore, dest: &Path, document: &[u8]) -> String {
        let sha256 = assets.ingest_bytes(b"the photograph's bytes", None).unwrap().sha256;
        let spec = bundle::Spec {
            schema_version: 1,
            title: "Case one".to_string(),
            assets: vec![sha256.clone()],
        };
        bundle::write(assets, &spec, None, document, dest).unwrap();
        sha256
    }

    // --- the note either side of a pack write (T-370) -----------------------

    /// A register with one board on it, currently open.
    fn a_register(dir: &tempfile::TempDir) -> (board::BoardStore, String) {
        let boards = board::BoardStore::new(dir.path().join("boards.json")).unwrap();
        let id = board::mint_pack_id();
        boards
            .admit(&id, &dir.path().join("one.schizo"), "One")
            .unwrap();
        boards.open(&id).unwrap();
        (boards, id)
    }

    #[test]
    fn a_written_file_is_no_longer_behind_its_workshop() {
        let dir = tempfile::tempdir().unwrap();
        let (boards, id) = a_register(&dir);
        boards.set_ahead(&id, true).unwrap();

        noting(&boards, &id, Writing::Flush, || Ok::<_, Refused>(((), 1))).unwrap();

        assert!(!boards.current().unwrap().ahead);
        // And the register knows what the file is at, which is the half T-374
        // was: it used to be kept by the caller, and one caller forgot.
        assert_eq!(boards.current().unwrap().generation, 1);
    }

    /// **T-374.** A compaction reads the document out of the pack's own newest
    /// generation, so it does not carry this window's document into the file —
    /// and a workshop that was ahead of that file before is still ahead of it
    /// after. `Pack.settle` reaches exactly this state whenever a flush fails on
    /// the way out of a board, and clearing the note there would throw away the
    /// catch-up at the next launch.
    #[test]
    fn folding_a_file_up_does_not_claim_the_workshop_is_level_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let (boards, id) = a_register(&dir);
        boards.set_ahead(&id, true).unwrap();

        noting(&boards, &id, Writing::Fold, || Ok::<_, Refused>(((), 0))).unwrap();

        assert!(boards.current().unwrap().ahead);
        // The generation is still recorded, because that half is about the file
        // and a fold changes it — to nothing.
        assert_eq!(boards.current().unwrap().generation, 0);
    }

    /// The bug T-374 is, at the layer it was missing from. A compaction leaves a
    /// pack with no generations in it; a register that went on saying five would
    /// make the next flush read the board's own tidying as another window's
    /// writing, and seal the pack on a machine running one window.
    #[test]
    fn a_folded_file_is_recorded_as_having_no_generations() {
        let dir = tempfile::tempdir().unwrap();
        let (boards, id) = a_register(&dir);
        boards.set_generation(&id, 5).unwrap();

        noting(&boards, &id, Writing::Fold, || Ok::<_, Refused>(((), 0))).unwrap();

        assert_eq!(boards.current().unwrap().generation, 0);
        assert!(!boards.current().unwrap().taken);
    }

    /// The latch, in the one place that holds the register. It used to be in
    /// `write_pack`, which is the road `board_compact` does not take.
    #[test]
    fn a_file_another_window_took_is_taken_for_the_session() {
        let dir = tempfile::tempdir().unwrap();
        let (boards, id) = a_register(&dir);

        let refused = noting(&boards, &id, Writing::Flush, || {
            Err::<((), u32), Refused>(Refused::Taken)
        });

        assert!(matches!(refused, Err(Refused::Taken)));
        assert!(boards.current().unwrap().taken);
        // And it is a fact about a running window, not about a board — nothing
        // of it reaches the register on disk.
        assert!(!std::fs::read_to_string(dir.path().join("boards.json"))
            .unwrap()
            .contains("taken"));
    }

    /// A disk that said no. The document is not at risk — the workshop is the
    /// crash-safe copy — but a file left silently a session behind is the one
    /// somebody hands over, so the note has to go back up or the next boot will
    /// believe the write that failed.
    #[test]
    fn a_file_that_could_not_be_written_is_still_behind_its_workshop() {
        let dir = tempfile::tempdir().unwrap();
        let (boards, id) = a_register(&dir);
        boards.set_ahead(&id, true).unwrap();

        let refused = noting(&boards, &id, Writing::Flush, || {
            Err::<((), u32), Refused>(Refused::Failed("the disk said no".to_string()))
        });

        assert_eq!(refused.unwrap_err().to_string(), "the disk said no");
        assert!(boards.current().unwrap().ahead);
        // And an ordinary failure does not take the file away for the session.
        assert!(!boards.current().unwrap().taken);
    }

    /// The whole reason the note is cleared *before* the write rather than
    /// after. `doc_append_update` marks the board ahead as an edit arrives, and
    /// an edit can arrive while a large board is still being written — so a
    /// clear that ran afterwards would erase the mark belonging to work that is
    /// not in the file being written. Quit inside the next idle interval and
    /// that is T-370 again, in the code that closes it.
    #[test]
    fn an_edit_that_landed_while_the_file_was_being_written_is_still_owed() {
        let dir = tempfile::tempdir().unwrap();
        let (boards, id) = a_register(&dir);

        noting(&boards, &id, Writing::Flush, || {
            // The append that `doc_append_update` is about to make.
            boards.set_ahead(&id, true).unwrap();
            Ok::<_, Refused>(((), 1))
        })
        .unwrap();

        assert!(boards.current().unwrap().ahead);
    }

    /// **T-363, and it is stage 1's worst hole rather than a nicety.**
    ///
    /// `assets/` is one store for the whole installation and `AssetStore::gc`
    /// takes one keep-set — the board this window is on — so the first sweep
    /// after a switch trashes every photograph belonging to every board you are
    /// not on. That was argued to be safe because reopening a board brings them
    /// back out of its pack. It did not: the pack was read only when the
    /// workshop was empty, and a board you have opened before always has a
    /// workshop. Driven before the fix: paste a photograph, switch to a new
    /// board, wait out the sweep, switch back — one blank polaroid and
    /// `1 missing` on the HUD, with the bytes sitting in the trash and nothing
    /// to pull them out.
    #[test]
    fn reopening_a_board_brings_its_photographs_back_out_of_its_pack() {
        let (dir, workshop, assets) = installation();
        let pack = dir.path().join("case one.schizo");
        let sha256 = a_pack_with_a_photograph(&assets, &pack, b"the pack's document");
        let entry = a_board("boards/board-one", Some(pack));

        // A session that has been on this board before, so its workshop is not
        // empty — which is the whole condition the old code turned on.
        DocStore::new(dir.path().join("boards/board-one"))
            .unwrap()
            .append(b"an hour of work")
            .unwrap();
        // And the sweep, while this window was on some other board.
        assets.gc(&HashSet::new()).unwrap();
        assert!(!assets.has(&sha256), "the sweep should have trashed it");

        let taken = take_up(&workshop, &assets, &entry).unwrap();

        assert!(assets.has(&sha256), "the photograph did not come back");
        assert_eq!(taken.ingested, vec![sha256]);
        // And the document half is untouched: the workshop is still newer than
        // the pack and still wins.
        assert!(!taken.seeded);
        let state = workshop.store().unwrap().load().unwrap();
        assert_eq!(state.updates, vec![b"an hour of work".to_vec()]);
    }

    /// The cost of the line above, which is what makes it affordable to run on
    /// every open rather than only on the ones that need it.
    #[test]
    fn a_photograph_this_machine_already_holds_is_never_read_out_of_the_pack() {
        let (dir, workshop, assets) = installation();
        let pack = dir.path().join("case one.schizo");
        let sha256 = a_pack_with_a_photograph(&assets, &pack, b"the pack's document");
        let entry = a_board("boards/board-one", Some(pack));
        DocStore::new(dir.path().join("boards/board-one"))
            .unwrap()
            .append(b"an hour of work")
            .unwrap();

        let taken = take_up(&workshop, &assets, &entry).unwrap();

        // Held already, so nothing was decompressed, hashed or ingested —
        // reopening a six-gigabyte board reads its index and stops.
        assert!(taken.ingested.is_empty());
        assert!(taken.missing.is_empty());
        assert!(assets.has(&sha256));
    }

    /// The other half of the rule. A top-up is a bonus and may not fail an open:
    /// the workshop is the board, and a pack on a stick that was pulled is a
    /// pack this open does not get to read.
    #[test]
    fn a_pack_that_will_not_read_does_not_stop_a_board_that_has_a_workshop() {
        let (dir, workshop, assets) = installation();
        let pack = dir.path().join("case one.schizo");
        std::fs::write(&pack, b"this is not a zip at all").unwrap();
        let entry = a_board("boards/board-one", Some(pack));
        DocStore::new(dir.path().join("boards/board-one"))
            .unwrap()
            .append(b"still here")
            .unwrap();

        let taken = take_up(&workshop, &assets, &entry).unwrap();

        assert!(!taken.seeded);
        let state = workshop.store().unwrap().load().unwrap();
        assert_eq!(state.updates, vec![b"still here".to_vec()]);
    }

    /// And the case that is *not* softened by any of the above: with no
    /// workshop, the pack is the only copy of the document there is, so a pack
    /// that will not read is the failure rather than an empty board.
    #[test]
    fn a_pack_that_will_not_read_is_still_fatal_when_it_is_the_only_copy() {
        let (dir, workshop, assets) = installation();
        let pack = dir.path().join("case one.schizo");
        std::fs::write(&pack, b"this is not a zip at all").unwrap();
        let entry = a_board("boards/board-one", Some(pack));

        assert!(take_up(&workshop, &assets, &entry).is_err());
    }

    /// A pack with no photographs in it — enough to have a manifest, a snapshot
    /// and a central directory, which is all the crash tests need.
    fn pack_spec() -> bundle::Spec {
        bundle::Spec {
            schema_version: 1,
            title: "Case one".to_string(),
            assets: Vec::new(),
        }
    }

    /// T-371, AC-1041, at the level a unit test can reach.
    ///
    /// The defect was not in `take_up` — it was that boot did not go through
    /// it, so this asserts the composition boot now performs: a register entry,
    /// an intact pack, and no workshop at all yields a board with the pack's
    /// document in it rather than an empty one. The wiring in `setup` itself is
    /// a Tauri closure and is verified by driving.
    ///
    /// With generations, because that is what a pack that has been *lived in*
    /// looks like (T-366) and it is the newest one that has to come back.
    #[test]
    fn a_board_whose_workshop_has_gone_comes_back_from_its_pack() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let assets = AssetStore::new(data.join("assets")).unwrap();
        let pack = data.join("case one.schizo");
        let id = board::mint_pack_id();

        bundle::write(&assets, &pack_spec(), Some(&id), b"as of the export", &pack).unwrap();
        bundle::append(&assets, &pack_spec(), &id, b"an afternoon of work", &pack, bundle::generation_of(&pack).unwrap()).unwrap();

        // The register survived and the workshop directory did not — a cleanup
        // tool, a quarantine, half a restore.
        let entry = board::Entry {
            pack_id: id,
            board_id: board::mint_board_id(),
            path: Some(pack),
            workshop: PathBuf::from("boards/board-one"),
            title: "Case one".into(),
            last_opened: 0,
            ahead: false,
            generation: 0,
            taken: false,
        };
        assert!(!data.join("boards/board-one").exists());

        let workshop = Workshop::new(data.to_path_buf());
        let taken = take_up(&workshop, &assets, &entry).unwrap();

        assert!(taken.seeded, "the pack was not read");
        let state = workshop.store().unwrap().load().unwrap();
        // The newest generation, not the base snapshot. Before T-371 this whole
        // path was skipped at boot and the board opened empty — and then wrote
        // the emptiness back over the file.
        assert_eq!(state.snapshot.as_deref(), Some(&b"an afternoon of work"[..]));
    }

    /// AC-1042, which is the half that must not be broken by fixing the other.
    ///
    /// The rule is not "read the pack at boot"; it is "the workshop wins when it
    /// has anything in it". A session that ended before its pack was flushed is
    /// newer than the pack by construction, and reading the pack over it at boot
    /// would throw away exactly the work the workshop exists to keep — which is
    /// the same loss the other way round.
    #[test]
    fn a_workshop_with_work_in_it_is_not_read_over_at_boot_either() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let assets = AssetStore::new(data.join("assets")).unwrap();
        let pack = data.join("case one.schizo");
        let id = board::mint_pack_id();
        bundle::write(&assets, &pack_spec(), Some(&id), b"as of the last flush", &pack).unwrap();

        DocStore::new(data.join("boards/board-one"))
            .unwrap()
            .append(b"an hour after that flush")
            .unwrap();

        let entry = board::Entry {
            pack_id: id,
            board_id: board::mint_board_id(),
            path: Some(pack),
            workshop: PathBuf::from("boards/board-one"),
            title: "Case one".into(),
            last_opened: 0,
            ahead: false,
            generation: 0,
            taken: false,
        };
        let workshop = Workshop::new(data.to_path_buf());
        let taken = take_up(&workshop, &assets, &entry).unwrap();

        assert!(!taken.seeded);
        let state = workshop.store().unwrap().load().unwrap();
        assert_eq!(state.snapshot, None);
        assert_eq!(state.updates, vec![b"an hour after that flush".to_vec()]);
    }

    /// AC-1026, and it is the test D-70's whole crash argument rests on.
    ///
    /// `ZipWriter::new_append` leaves the cursor on the first byte of the old
    /// EOCD, so the first byte of any append destroys the only central
    /// directory the file has and there is no earlier one to scan back to. A
    /// power cut mid-append can therefore leave the pack in *any* state between
    /// "the file as it was" and "the file as it will be", and this walks every
    /// one of them.
    ///
    /// What must be true at each: the board still opens, on its workshop, with
    /// its work intact — and the next flush leaves a pack that reads correctly
    /// again. **No zip repair is involved and none is built.** The recovery is
    /// that the pack was never the only copy.
    #[test]
    fn a_torn_append_is_repaired_from_the_workshop_at_every_offset() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let assets = AssetStore::new(data.join("assets")).unwrap();
        let pack = data.join("case one.schizo");
        let id = board::mint_pack_id();

        bundle::write(&assets, &pack_spec(), Some(&id), b"as of the last flush", &pack).unwrap();
        let intact = std::fs::read(&pack).unwrap();
        bundle::append(&assets, &pack_spec(), &id, b"an hour of work later", &pack, bundle::generation_of(&pack).unwrap()).unwrap();
        let appended = std::fs::read(&pack).unwrap();
        assert!(appended.len() > intact.len());

        for cut in intact.len()..appended.len() {
            std::fs::write(&pack, &appended[..cut]).unwrap();

            // A workshop that has this session's work in it, which is what a
            // machine that has just been through a power cut actually has.
            let workshop = Workshop::new(data.to_path_buf());
            let entry = board::Entry {
                pack_id: id.clone(),
                board_id: board::mint_board_id(),
                path: Some(pack.clone()),
                workshop: PathBuf::from("boards/board-one"),
                title: "Case one".into(),
                last_opened: 0,
                ahead: false,
                generation: 0,
                taken: false,
            };
            DocStore::new(data.join("boards/board-one"))
                .unwrap()
                .append(b"an hour of work later")
                .unwrap();

            // It opens. Not "opens with a warning" — opens, on the workshop,
            // which is newer than any generation by construction.
            let taken = take_up(&workshop, &assets, &entry)
                .unwrap_or_else(|e| panic!("truncated at {cut} of {} refused to open: {e}", appended.len()));
            assert!(!taken.seeded, "truncated at {cut}: the workshop was overwritten");
            let state = workshop.store().unwrap().load().unwrap();
            assert_eq!(
                state.updates,
                vec![b"an hour of work later".to_vec()],
                "truncated at {cut}: the work is not there"
            );

            // And the next flush leaves a file that reads. `save_pack` finds a
            // pack it cannot append to and writes the whole thing instead,
            // which is the repair in one line.
            save_pack(&assets, &pack_spec(), &id, b"an hour of work later", &pack, Writing::Flush, 0)
                .unwrap_or_else(|e| panic!("truncated at {cut}: the repair failed: {e}"));
            let reopened = bundle::read(&assets, &pack)
                .unwrap_or_else(|e| panic!("truncated at {cut}: the repaired pack will not read: {e}"));
            assert_eq!(reopened.snapshot, b"an hour of work later");
            assert_eq!(reopened.manifest.pack_id.as_deref(), Some(id.as_str()));

            std::fs::remove_dir_all(data.join("boards")).unwrap();
        }
    }

    /// The ordinary case, so that the test above is not the only thing
    /// exercising this pair: a pack that *is* fine is appended to rather than
    /// rewritten, which is the whole of what T-366 bought.
    #[test]
    fn a_flush_appends_to_a_pack_that_is_fine() {
        let dir = tempfile::tempdir().unwrap();
        let assets = AssetStore::new(dir.path().join("assets")).unwrap();
        let pack = dir.path().join("case one.schizo");
        let id = board::mint_pack_id();
        bundle::write(&assets, &pack_spec(), Some(&id), b"first", &pack).unwrap();

        save_pack(&assets, &pack_spec(), &id, b"second", &pack, Writing::Flush, 0).unwrap();

        // Appended, not rewritten — the base entries are still where they were,
        // and the newest generation is what a reader gets.
        let opened = bundle::read(&assets, &pack).unwrap();
        assert_eq!(opened.snapshot, b"second");
        let zip = zip::ZipArchive::new(std::io::BufReader::new(std::fs::File::open(&pack).unwrap())).unwrap();
        let names: Vec<&str> = zip.file_names().collect();
        assert!(names.contains(&"gen/1"), "{names:?}");
        assert!(names.contains(&"snapshot.bin"), "{names:?}");
    }

    /// **The most expensive line in T-368, and it is a line that does not run.**
    ///
    /// `save_pack`'s answer to an append it could not make is to write the whole
    /// file again from the document this machine still holds. That is right for
    /// a torn append — D-70 chose it over a zip repair — and it is the worst
    /// possible answer to an interleave: `bundle::write` renames a fresh file
    /// over the destination, so the fallback would take every generation the
    /// other window wrote with it, in the name of recovering from having noticed
    /// them.
    ///
    /// So the assertion is not that it returns an error. It is that their work
    /// is still in the file afterwards.
    #[test]
    fn an_interleave_is_refused_and_never_falls_back_to_rewriting_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let assets = AssetStore::new(dir.path().join("assets")).unwrap();
        let pack = dir.path().join("case one.schizo");
        let id = board::mint_pack_id();
        bundle::write(&assets, &pack_spec(), Some(&id), b"the export", &pack).unwrap();
        // The other window's afternoon, which this one has never read.
        bundle::append(&assets, &pack_spec(), &id, b"theirs", &pack, 0).unwrap();

        // This window still believes the file has no generations in it.
        let refused = save_pack(&assets, &pack_spec(), &id, b"ours", &pack, Writing::Flush, 0);

        assert!(matches!(refused, Err(Refused::Taken)), "{refused:?}");
        assert_eq!(bundle::read(&assets, &pack).unwrap().snapshot, b"theirs");
    }

    /// The failure it *does* fall back on, kept beside the one it does not, so
    /// that a change collapsing the two has to delete one of these to pass.
    #[test]
    fn a_pack_that_is_not_a_zip_at_all_is_still_written_again() {
        let dir = tempfile::tempdir().unwrap();
        let assets = AssetStore::new(dir.path().join("assets")).unwrap();
        let pack = dir.path().join("case one.schizo");
        let id = board::mint_pack_id();
        std::fs::write(&pack, b"not a zip, and not recoverable from").unwrap();

        save_pack(&assets, &pack_spec(), &id, b"ours", &pack, Writing::Flush, 0).unwrap();

        assert_eq!(bundle::read(&assets, &pack).unwrap().snapshot, b"ours");
    }

    /// A board that has never been written has no file to append to, and that
    /// is the first flush of every board rather than an error.
    #[test]
    fn a_first_flush_writes_the_whole_file() {
        let dir = tempfile::tempdir().unwrap();
        let assets = AssetStore::new(dir.path().join("assets")).unwrap();
        let pack = dir.path().join("brand new.schizo");
        let id = board::mint_pack_id();

        save_pack(&assets, &pack_spec(), &id, b"the first one", &pack, Writing::Flush, 0).unwrap();

        assert_eq!(bundle::read(&assets, &pack).unwrap().snapshot, b"the first one");
    }

    /// **The branch the whole crash story rests on.** A workshop with anything
    /// in it is a session that ended before its pack was flushed, so it is newer
    /// than the pack by construction — and reading the pack over it would throw
    /// away exactly the work the workshop exists to keep. One branch, and it
    /// covers a torn append, a power cut mid-flush, a quit with no close hook,
    /// and a pack on a stick that was pulled.
    #[test]
    fn a_workshop_that_already_holds_work_wins_over_the_pack() {
        let (dir, workshop, assets) = installation();
        let pack = dir.path().join("case one.schizo");
        a_pack(&assets, &pack, b"the pack, as of the last flush");
        let entry = a_board("boards/board-one", Some(pack));

        // The session that did not get its pack written.
        DocStore::new(dir.path().join("boards/board-one"))
            .unwrap()
            .append(b"an hour of work after that flush")
            .unwrap();

        let taken = take_up(&workshop, &assets, &entry).unwrap();

        assert!(!taken.seeded);
        let state = workshop.store().unwrap().load().unwrap();
        assert_eq!(state.snapshot, None);
        assert_eq!(
            state.updates,
            vec![b"an hour of work after that flush".to_vec()]
        );
    }

    /// A pack on a USB stick that was pulled, or a board somebody moved while it
    /// was shut. The workshop is a whole copy of the document, so this opens.
    #[test]
    fn a_board_whose_file_has_gone_still_opens_on_its_workshop() {
        let (dir, workshop, assets) = installation();
        DocStore::new(dir.path().join("boards/board-one"))
            .unwrap()
            .append(b"still here")
            .unwrap();

        let entry = a_board("boards/board-one", Some(dir.path().join("gone.schizo")));
        let taken = take_up(&workshop, &assets, &entry).unwrap();

        assert!(!taken.seeded);
        assert_eq!(
            workshop.store().unwrap().load().unwrap().updates,
            vec![b"still here".to_vec()]
        );
    }

    /// And when there is no workshop *either*, there is no board — said out
    /// loud rather than opening an empty one, which would look exactly like the
    /// board having been emptied.
    #[test]
    fn a_board_with_neither_a_workshop_nor_a_file_is_refused() {
        let (dir, workshop, assets) = installation();
        let entry = a_board("boards/board-one", Some(dir.path().join("gone.schizo")));
        assert!(take_up(&workshop, &assets, &entry).is_err());
    }

    /// A board that has never been given a file — the adopted pre-T-356 one, and
    /// every board *New board…* mints. Nothing to seed from, and that is not a
    /// failure.
    #[test]
    fn a_board_with_no_file_yet_opens_on_an_empty_workshop() {
        let (_dir, workshop, assets) = installation();
        let entry = a_board("doc", None);
        let taken = take_up(&workshop, &assets, &entry).unwrap();

        assert!(!taken.seeded);
        assert!(workshop.store().unwrap().load().unwrap().snapshot.is_none());
    }

    /// AC-998, and the reason this struct exists at all: a webview handed every
    /// board's absolute path can name a location just as surely as one that
    /// asked for a path.
    #[test]
    fn a_board_crossing_the_boundary_carries_a_folder_name_and_never_a_location() {
        let entry = board::Entry {
            path: Some(PathBuf::from("D:/Users/somebody/Documents/Case files/one.schizo")),
            ..a_board("boards/board-one", None)
        };
        let card = card(&entry, Some(&entry.pack_id));

        assert_eq!(card.folder, "Case files");
        assert!(card.homed);
        assert!(card.current);
        // Nothing anywhere in it that a path could be reassembled from.
        for field in [&card.folder, &card.title, &card.pack_id] {
            assert!(!field.contains("Documents"), "{field:?}");
            assert!(!field.contains('/') && !field.contains('\\'), "{field:?}");
        }
    }

    #[test]
    fn a_board_with_no_file_is_in_no_folder_and_says_so() {
        let entry = a_board("boards/board-one", None);
        let card = card(&entry, None);
        assert_eq!(card.folder, "");
        assert!(!card.homed);
        assert!(!card.current);
    }

    /// Two boards both called *Untitled board* is the ordinary case, and the
    /// second silently overwriting the first would be the worst thing this
    /// feature could do quietly.
    #[test]
    fn a_home_is_the_first_name_that_is_not_taken() {
        let dir = tempfile::tempdir().unwrap();
        let first = free_name(dir.path(), "Untitled board").unwrap();
        assert_eq!(first.file_name().unwrap(), "Untitled board.schizo");

        std::fs::write(&first, b"a board").unwrap();
        let second = free_name(dir.path(), "Untitled board").unwrap();
        assert_eq!(second.file_name().unwrap(), "Untitled board 2.schizo");

        std::fs::write(&second, b"another").unwrap();
        assert_eq!(
            free_name(dir.path(), "Untitled board")
                .unwrap()
                .file_name()
                .unwrap(),
            "Untitled board 3.schizo"
        );
        // And a name nobody has used starts at the top again.
        assert_eq!(
            free_name(dir.path(), "Wexford").unwrap().file_name().unwrap(),
            "Wexford.schizo"
        );
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
