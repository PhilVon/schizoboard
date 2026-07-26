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
//! lengths. There is nothing for a native fallback to add there, so this
//! reports honestly that it has nothing rather than duplicating a path that
//! already works — and the frontend keeps the fallback ordering, so the day a
//! platform *does* need it, the only thing missing is the answer below.
//!
//! **The measurement was Windows only.** This answers for macOS and Linux too,
//! where nobody has checked, so if a Finder copy really is invisible to the web
//! event there, paste does nothing there and says so only to the console. That
//! is a known hole with a task on it rather than an oversight — but it is a
//! hole, and writing NSPasteboard code on the strength of a guess that has
//! already been wrong once would not close it.
//!
//! What a native reader would genuinely add on Windows is the `SourceURL:`
//! header of `CF_HTML`, which the webview strips — it is the only way to
//! resolve a relative `<img src>` copied out of a page. That is a real gap and
//! it has its own task.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, WebviewWindow, WindowEvent};

#[derive(Serialize)]
pub struct ClipboardManifest {
    kinds: Vec<String>,
}

/// What the shell can see on the clipboard that the webview cannot.
#[tauri::command]
pub async fn clipboard_read_manifest() -> ClipboardManifest {
    ClipboardManifest { kinds: Vec::new() }
}

/// Nothing yet — see the module comment. Present rather than absent so the
/// frontend's fallback is ordinary control flow instead of a caught exception.
#[tauri::command]
pub async fn clipboard_read_item(_kind: String) -> Option<serde_json::Value> {
    None
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
