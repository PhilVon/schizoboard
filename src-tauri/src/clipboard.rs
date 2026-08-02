//! Getting files in from the operating system.
//!
//! Two routes, and they are not symmetrical.
//!
//! ## Drag and drop, which only the shell can see
//!
//! Tauri intercepts the OS drop before the webview does, so an HTML5 `drop`
//! event never fires and a file dragged onto the board would otherwise do
//! nothing at all. The shell forwards the paths and the position instead:
//!
//! > Files dragged in from the OS arrive as paths rather than blobs and go
//! > straight into the store without ever touching JS.
//! > — docs/ARCHITECTURE.md section 4.5
//!
//! The position is converted to CSS pixels here rather than in the frontend.
//! Tauri reports it in physical pixels, and every other coordinate that crosses
//! this boundary is already in the units `Camera` speaks — one conversion in
//! one place beats a `devicePixelRatio` in the paste code that is right on the
//! developer's monitor and wrong on everyone else's.
//!
//! ## The clipboard, which mostly it can
//!
//! > Fall back to native when it comes back empty or reports zero-length files,
//! > which is what happens with Explorer and Finder file copies.
//! > — ARCHITECTURE section 4.5
//!
//! That was worth measuring before implementing, and the measurement did not
//! agree: on Windows and WebView2 an Explorer copy of three files reaches the
//! web `paste` event as three `File`s with their real MIME types and real byte
//! lengths. **That finding still stands** — nothing below contradicts it, and
//! the web route is not broken on this platform.
//!
//! What it did not weigh is what the web route *costs*, because it was written
//! when this meant photographs. A `File` has to be read into the JS heap and
//! pushed back across the IPC boundary as a raw body, and that boundary was
//! measured at about **55 MiB/s** (T-266, D-51) — four times slower than the
//! SHA-256 it feeds. A 12 MB photograph pays 220 ms for it and nobody notices.
//! A 46.5 MiB film pays 832 ms, and half a gigabyte of interview pays nine
//! seconds. `asset_ingest_path` crosses nothing: the same work on the same file
//! is 237 ms against 1069 ms.
//!
//! So the conclusion aged out from under the finding. A dropped file already
//! took the cheap route and a pasted one could not, and the two were about five
//! times apart for no reason anybody chose. This reads the clipboard's file
//! list so they are not.
//!
//! It reports **only paths that are files**. A copied *folder* is a real entry
//! on that list, and expanding it the way [`expand`] does for a drop would be a
//! new gesture rather than a cheaper road to an old one — so a folder is
//! reported as nothing here, falls through to the web route, and behaves
//! exactly as it did before.
//!
//! ## All three platforms, which took a fact rather than a decision
//!
//! This was Windows-only until T-303, and deliberately: nobody had checked
//! whether a Finder copy even *reaches* the web `paste` event on the other two,
//! and writing `NSPasteboard` code on the strength of a guess that had already
//! been wrong once would not have closed that hole.
//!
//! It does reach it, on both, as a real `File` with bytes — read out of
//! WebKit's own source rather than guessed at, in D-59. So the web route there
//! was never broken, only slow, and since T-264 capped the road it takes, the
//! whole of what those platforms were missing is a file between `MAX_PASTE_BYTES`
//! and `MAX_ASSET_BYTES`: too big to hand over in one piece, small enough for
//! the board to hold, and reachable only by dragging it.
//!
//! `arboard::Get::file_list` closes that on all four backends — Windows,
//! `NSPasteboard`, X11 and Wayland — and Q-238 took it here too, replacing the
//! `CF_HDROP` this file used to spell out by hand. The argument was about *this*
//! platform: the only clipboard anyone on this project can watch run is the
//! Windows one, so the road worth testing is the road all three take.
//!
//! **These commands are synchronous, and that is load-bearing.** Tauri runs an
//! `async` command on a runtime worker and a plain one inline on the thread that
//! took the IPC message, which is the main thread. `NSPasteboard` is main-thread
//! only, and WebKit's own pasteboard proxy is on it too — reading the clipboard
//! off a worker segfaults on macOS (`tauri-apps/plugins-workspace#3205`). A
//! clipboard read is microseconds, so the main thread is both the correct place
//! and the cheap one. Do not make these `async` for symmetry.
//!
//! The other thing a native reader adds on Windows is the `SourceURL:` header
//! of `CF_HTML`, which the webview strips — the only way to resolve a relative
//! `<img src>` copied out of a page. That is [`clipboard_source_url`], below.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, WebviewWindow, WindowEvent};

#[derive(Serialize)]
pub struct ClipboardManifest {
    kinds: Vec<String>,
}

/// What the shell can see on the clipboard that the webview cannot.
///
/// "Cannot" is doing less work than it looks: on Windows the webview sees a
/// file copy perfectly well, and what it cannot see is the *path*. See the
/// module comment for why that is worth a round trip.
#[tauri::command]
pub fn clipboard_read_manifest() -> ClipboardManifest {
    let kinds = if clipboard_files().is_empty() {
        Vec::new()
    } else {
        vec!["files".to_string()]
    };
    ClipboardManifest { kinds }
}

/// The paths behind a file copy, or `None`.
///
/// `None` rather than an empty list for everything else, including a `kind`
/// this does not answer for: the frontend's fallback is then ordinary control
/// flow rather than a caught exception, which is what it was when this was a
/// stub and is what the four-case ladder in `paste.ts` is written against.
#[tauri::command]
pub fn clipboard_read_item(kind: String) -> Option<serde_json::Value> {
    if kind != "files" {
        return None;
    }
    let paths = clipboard_files();
    if paths.is_empty() {
        return None;
    }
    Some(serde_json::json!({ "kind": "files", "paths": paths }))
}

/// Files named by a file copy on the clipboard. Empty whenever the clipboard is
/// carrying anything else, and empty rather than an error when it cannot be
/// read at all.
///
/// Empty is not a failure to report. The clipboard is a single global lock that
/// whoever last wrote it holds for a few milliseconds, and a display server may
/// hand over nothing for reasons of its own; every one of those means the same
/// thing here, which is that there is no path to be had and the web route takes
/// the paste — the behaviour this had before it could read a path at all.
fn clipboard_files() -> Vec<String> {
    let Ok(mut clipboard) = arboard::Clipboard::new() else {
        return Vec::new();
    };
    let Ok(paths) = clipboard.get().file_list() else {
        return Vec::new();
    };
    files_only(&paths)
}

/// The entries of a clipboard file list that are files, as strings.
///
/// Separate from the read for the reason [`source_url_of`] is: this is the part
/// with a decision in it, and it is the part a test can stand up. The clipboard
/// itself cannot be — on any platform, and least of all on the two where nobody
/// here can run a binary at all.
///
/// A copied *folder* is a real entry on the list, and expanding it would be a
/// new gesture rather than a cheaper road to an old one, so it is dropped and
/// the paste falls through to the web route exactly as it did before this file
/// could read a path. A path that has gone since it was copied is dropped for
/// the same reason and lands in the same place.
fn files_only(paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

/// The page a copied fragment came from, if the clipboard says.
///
/// "Copy image" in a browser puts `CF_HTML` on the clipboard, and its header
/// carries a `SourceURL:` naming the page. The webview strips the whole header
/// before the `paste` event sees it, which leaves the frontend holding markup
/// whose `<img src="/photos/1.jpg">` cannot be resolved against anything — so it
/// drops it, and copying an image out of any site that writes relative sources
/// puts nothing on the board.
///
/// Returns `None` on every other platform, and on Windows whenever the clipboard
/// is not carrying `CF_HTML`, is held by another process, or names a source that
/// is not a page. Never an error: a paste without a base URL is the behaviour
/// that was there before this existed.
#[tauri::command]
pub fn clipboard_source_url() -> Option<String> {
    read_source_url()
}

/// Pull `SourceURL:` out of a `CF_HTML` payload.
///
/// Separate from the Win32 call and platform-independent, because the parsing is
/// the part with decisions in it and the part worth testing — the clipboard
/// cannot be stood up in a unit test on any platform, and least of all on the
/// one where CI does not run.
///
/// The header is a run of `Name:value` lines before the markup begins. It is
/// specified with this exact casing, but producers vary and matching loosely
/// costs nothing.
fn source_url_of(cf_html: &str) -> Option<String> {
    for line in cf_html.lines() {
        let line = line.trim();
        // The header ends where the fragment starts, and everything after that
        // is the page's own content — which can contain anything at all,
        // including the text "SourceURL:".
        if line.starts_with('<') {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if !name.eq_ignore_ascii_case("SourceURL") {
            continue;
        }
        let url = value.trim();
        // Only a scheme that names a page on the web. Word and several editors
        // write `about:blank` for a fragment that came from nowhere in
        // particular, and `file:///` for a local document; resolving a relative
        // source against either produces a plausible URL to nothing, which is a
        // worse answer than admitting there is no base.
        if url.starts_with("http://") || url.starts_with("https://") {
            return Some(url.to_owned());
        }
        return None;
    }
    None
}

#[cfg(not(windows))]
fn read_source_url() -> Option<String> {
    // macOS and Linux put the source URL on the pasteboard in their own ways and
    // neither has been looked at from a machine that runs them. Reporting
    // nothing is what this did before; guessing would be the regression.
    None
}

#[cfg(windows)]
fn read_source_url() -> Option<String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard, RegisterClipboardFormatW,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    /// Closes the clipboard however this function leaves.
    ///
    /// Not a nicety. The clipboard is a single global lock held across the whole
    /// session: an early `return` that skipped `CloseClipboard` would leave every
    /// other application on the machine unable to copy or paste until this one
    /// exited, and there are six early returns below.
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            // SAFETY: only constructed after OpenClipboard returned success.
            unsafe { CloseClipboard() };
        }
    }

    let name: Vec<u16> = OsStr::new("HTML Format")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // SAFETY: `name` is a NUL-terminated wide string that outlives the call.
    // The clipboard is opened before it is read and closed by `Guard` on every
    // path. The handle from `GetClipboardData` is owned by the clipboard and is
    // valid while it stays open, which is for the rest of this scope; the slice
    // is built from the size the allocator reports for that handle and is not
    // held past the unlock.
    unsafe {
        let format = RegisterClipboardFormatW(name.as_ptr());
        if format == 0 {
            return None;
        }
        // A null owner is allowed and means "this task". The clipboard is
        // routinely held for a few milliseconds by whoever last wrote it, and a
        // failure here is ordinary rather than exceptional.
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return None;
        }
        let _guard = Guard;

        let handle = GetClipboardData(format);
        if handle.is_null() {
            return None;
        }
        let ptr = GlobalLock(handle);
        if ptr.is_null() {
            return None;
        }
        let size = GlobalSize(handle);
        let bytes = std::slice::from_raw_parts(ptr.cast::<u8>(), size);
        // CF_HTML is specified as UTF-8. Lossy rather than strict: a producer
        // that got that wrong should cost the source URL, not the paste.
        let found = source_url_of(&String::from_utf8_lossy(bytes));
        GlobalUnlock(handle);
        found
    }
}

#[derive(Clone, Serialize)]
struct FilesDropped {
    paths: Vec<String>,
    /// CSS pixels, relative to the webview.
    x: f64,
    y: f64,
}

/// How deep a dropped folder is walked.
///
/// One level, not the whole tree. Dropping a folder of holiday photographs is
/// the natural bulk-import gesture and has to work; dropping a home directory
/// by accident must not enumerate a hundred thousand files. One level is the
/// depth a person can see in the window they dragged from.
const DROP_FOLDER_DEPTH: usize = 1;

/// Expand a drop into the files it actually names.
///
/// Tauri hands over exactly what was dragged, which for a folder is one path to
/// a directory. Passing that straight to the store means `fs::read` on a
/// directory, an error nobody sees, and a board that stays empty with no
/// feedback at all — the least helpful possible answer to the most natural
/// possible gesture.
fn expand(paths: &[PathBuf], depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for path in paths {
        if !path.is_dir() {
            out.push(path.clone());
            continue;
        }
        if depth == 0 {
            continue;
        }
        let Ok(entries) = fs::read_dir(path) else {
            continue;
        };
        // Sorted, so a folder arrives in the order the window showed it rather
        // than in whatever order the filesystem felt like.
        let mut children: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        children.sort();
        out.extend(expand(&children, depth - 1));
    }
    out
}

/// Forward OS drops to the frontend, which treats them exactly as a paste.
pub fn forward_drops(window: &WebviewWindow, app: &AppHandle) {
    let app = app.clone();
    // The scale factor is read per drop rather than captured: a window moved to
    // a second monitor with a different DPI keeps the same handle, and a stale
    // factor would put the photographs somewhere the cursor was not.
    window.on_window_event(move |event| {
        let WindowEvent::DragDrop(DragDropEvent::Drop { paths, position }) = event else {
            return;
        };
        let scale = app
            .get_webview_window("main")
            .and_then(|w| w.scale_factor().ok())
            .unwrap_or(1.0);
        let _ = app.emit(
            "files:dropped",
            FilesDropped {
                paths: expand(paths, DROP_FOLDER_DEPTH)
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect(),
                x: position.x / scale,
                y: position.y / scale,
            },
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real header, in the shape Chromium writes it.
    fn cf_html(source: &str) -> String {
        format!(
            "Version:0.9\r\nStartHTML:00000117\r\nEndHTML:00000210\r\n\
             StartFragment:00000151\r\nEndFragment:00000174\r\n{source}\r\n\
             <html><body><!--StartFragment--><img src=\"/photos/1.jpg\"><!--EndFragment--></body></html>"
        )
    }

    #[test]
    fn reads_the_page_a_fragment_was_copied_from() {
        assert_eq!(
            source_url_of(&cf_html("SourceURL:https://example.com/gallery/index.html")),
            Some("https://example.com/gallery/index.html".to_owned())
        );
    }

    #[test]
    fn tolerates_the_casing_producers_actually_use() {
        assert_eq!(
            source_url_of(&cf_html("sourceurl: https://example.com/a")),
            Some("https://example.com/a".to_owned())
        );
    }

    #[test]
    fn refuses_a_source_that_does_not_name_a_page() {
        // What Word writes for a fragment from nowhere in particular, and what a
        // local document gives. Resolving a relative src against either produces
        // a plausible URL to nothing.
        assert_eq!(source_url_of(&cf_html("SourceURL:about:blank")), None);
        assert_eq!(
            source_url_of(&cf_html("SourceURL:file:///C:/notes.docx")),
            None
        );
        assert_eq!(source_url_of(&cf_html("SourceURL:")), None);
    }

    #[test]
    fn stops_at_the_markup_rather_than_reading_the_page() {
        // The copied page can say anything, including this. Only the header
        // before the fragment counts.
        let hostile = "Version:0.9\r\nStartHTML:00000097\r\n\
                       <html><body>SourceURL:https://evil.example/\r\n</body></html>";
        assert_eq!(source_url_of(hostile), None);
    }

    #[test]
    fn says_nothing_when_there_is_no_header_at_all() {
        assert_eq!(source_url_of(""), None);
        assert_eq!(source_url_of("Version:0.9\r\nStartHTML:00000097\r\n"), None);
    }

    #[test]
    fn reports_only_the_entries_of_a_file_copy_that_are_files() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("interview.wav");
        let folder = dir.path().join("holiday");
        fs::write(&file, b"x").unwrap();
        fs::create_dir(&folder).unwrap();

        // A folder copied alongside a file is dropped rather than expanded, and
        // the file beside it still goes by path.
        assert_eq!(
            files_only(&[folder, file.clone()]),
            vec![file.to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn reports_nothing_for_a_folder_on_its_own() {
        let dir = tempfile::tempdir().unwrap();
        // Not an empty list for the sake of it: `clipboard_read_item` answers
        // `None` for this, which is what puts the paste back on the web route.
        assert!(files_only(&[dir.path().to_path_buf()]).is_empty());
    }

    #[test]
    fn drops_a_path_that_is_no_longer_there() {
        // The opposite of what `expand` does with one, and deliberately. A drop
        // names what the shell had in its hand a moment ago; a clipboard can
        // name something copied an hour and a delete ago, and reporting it
        // would refuse the paste on this side over a file the web route may
        // still be holding perfectly good bytes for.
        assert!(files_only(&[PathBuf::from("D:/nothing/here.png")]).is_empty());
    }

    #[test]
    fn expands_a_dropped_folder_into_the_files_it_holds() {
        let dir = tempfile::tempdir().unwrap();
        let photos = dir.path().join("photos");
        fs::create_dir_all(photos.join("nested")).unwrap();
        fs::write(photos.join("b.png"), b"b").unwrap();
        fs::write(photos.join("a.png"), b"a").unwrap();
        fs::write(photos.join("nested").join("deep.png"), b"d").unwrap();

        let expanded = expand(std::slice::from_ref(&photos), DROP_FOLDER_DEPTH);
        let names: Vec<_> = expanded
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        // In the order the window showed them, and only one level down: a
        // folder dropped by accident must not enumerate a whole tree.
        assert_eq!(names, vec!["a.png", "b.png"]);
    }

    #[test]
    fn leaves_a_dropped_file_alone() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("one.png");
        fs::write(&file, b"x").unwrap();
        assert_eq!(
            expand(std::slice::from_ref(&file), DROP_FOLDER_DEPTH),
            vec![file]
        );
    }

    #[test]
    fn passes_a_path_it_cannot_make_sense_of_straight_through() {
        // Not this function's job to decide. A path that is not there is handed
        // on, fails at the ingest that tries to read it, and is reported there
        // with the reason — rather than vanishing here with none.
        let missing = PathBuf::from("D:/nothing/here.png");
        assert_eq!(expand(std::slice::from_ref(&missing), 1), vec![missing]);
    }

    #[test]
    fn stops_at_the_depth_it_was_given() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("outer").join("inner")).unwrap();
        fs::write(
            dir.path().join("outer").join("inner").join("deep.png"),
            b"d",
        )
        .unwrap();
        // Zero depth: a folder is not expanded at all rather than half expanded.
        assert!(expand(&[dir.path().join("outer")], 0).is_empty());
    }
}
