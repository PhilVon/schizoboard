//! The PDF export: WebView2's own print pipeline, driven from this side.
//!
//! Q-128 chose a *vector* PDF over a raster on a page, and the whole reason was
//! the handwriting — a note printed through Chromium is real text in a real
//! embedded font, selectable and sharp at any magnification, where a bitmap of
//! the same note is pixels forever. D-36 measured it before any of this was
//! built: one page, `AAAAAA+PatrickHand-Regular` embedded and subsetted, 3,176
//! text-drawing operators.
//!
//! What is here is only the plumbing, and it is smaller than it looks. Chromium
//! does the rendering; this reaches it.
//!
//! ## Three things this module knows that the caller cannot
//!
//! 1. **Where the file goes.** A native save dialog, and nothing else — the
//!    argument in ARCHITECTURE section 4.4 that `asset_export` and both bundle
//!    commands already take. The webview passes a *name* to suggest and never a
//!    path, because a path the renderer picks is a path an injected script
//!    picks, and paste ingests HTML from other people's pages. Here the file is
//!    written by the WebView2 browser process rather than by us, which changes
//!    nothing about who is allowed to name it.
//! 2. **That backgrounds are not optional.** The cork, the paper colours, the
//!    ruling and the ageing are all CSS backgrounds, and a print drops
//!    backgrounds by default. Measured, D-36: 31 image objects with them and 27
//!    without, and the cork among what goes. The document says so too
//!    (`print-color-adjust: exact`, T-208) — this is the half the caller owns,
//!    and it is set here rather than passed in so that no caller can forget it.
//! 3. **That a page has a limit.** The PDF format's own is 200 inches a side.
//!    `exportPage` in the frontend already keeps inside it; this refuses
//!    anything that does not, because the page size is the one number that
//!    crosses the boundary and a `NaN` or a negative would reach a COM call.
//!
//! ## What is *not* here, and belongs to the caller
//!
//! Fitting the camera. A print lays the document out at the paper width and
//! fires no `resize` event, so the board would otherwise sit in one corner of a
//! mostly empty page — the first PDF this project ever produced did exactly
//! that (D-36). The camera, the screen-space canvases and the detail tier are
//! set by `app/exportPdf.ts` before this is invoked and put back after, because
//! all three are schema and Rust owns no schema (ARCHITECTURE section 4).
//!
//! ## Why this is two commands rather than one
//!
//! Because the board has to be posed for the page *before* the print, and the
//! print happens the instant the dialog closes. One command meant the board was
//! already zoomed out to its own bounds while the user was still typing a
//! filename — and a cancelled dialog had cost a full re-pose of the board for
//! nothing, which is the common case.
//!
//! So: [`export_pdf_choose`] asks, and [`export_pdf_write`] prints. The path
//! lives in [`PendingExport`] between them and **never crosses the boundary**,
//! which is the whole of ARCHITECTURE section 4.4's rule and the only reason
//! this is not simply `export_pdf(path, page)`. What the webview can do with
//! the pair is bounded and dull: `write` without a `choose` finds an empty slot
//! and fails, a second `write` finds the slot already taken and fails, and a
//! second `choose` replaces a path nobody used with one the user has just
//! agreed to. None of those is a file it named.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

/// Where the next export is going, between the dialog and the print.
///
/// One slot, and the last answer wins. A `choose` whose `write` never came is
/// not a leak worth cleaning up after: it is a path, it is overwritten by the
/// next `choose`, and — unlike the arrangement where the dialog came second —
/// nothing has been written to it.
#[derive(Default)]
pub struct PendingExport(Mutex<Option<PathBuf>>);

/// A PDF page may be 200 inches a side, which is the format's own limit rather
/// than a policy of ours.
const MAX_PAGE_INCHES: f64 = 200.0;

/// The page.
///
/// Inches because that is what both ends of this speak: `ExportView.inches` is
/// computed from the board's own units in `app/export.ts`, and
/// `ICoreWebView2PrintSettings` takes inches.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSpec {
    width: f64,
    height: f64,
}

impl PageSpec {
    /// A page size a COM call can be given.
    ///
    /// Spelled as a rejection of what is *not* allowed rather than a check that
    /// the value is in range, because `NaN` passes every `>` and `<` written the
    /// other way round — and a `NaN` page reaches `SetPageWidth` as a page of no
    /// size, which is a blank file rather than an error.
    fn checked(&self) -> Result<(f64, f64), String> {
        for (axis, value) in [("width", self.width), ("height", self.height)] {
            if !(value.is_finite() && value > 0.0 && value <= MAX_PAGE_INCHES) {
                return Err(format!(
                    "page {axis} must be between 0 and {MAX_PAGE_INCHES} inches, not {value}"
                ));
            }
        }
        Ok((self.width, self.height))
    }
}

/// Ask the user where the PDF should go, and remember the answer.
///
/// `false` is a cancelled dialog — an ordinary outcome and not a failure, the
/// same thing `asset_export`'s `false` and `bundle_save_as`'s `null` mean.
/// Nothing is written and nothing on the board need move.
///
/// `title` is the board's, on exactly the standing `origName` has in
/// `asset_export`: a caller-supplied string that crosses as a *name*, which is
/// the difference that makes it safe, and that `safe_stem` reduces to a bare
/// filename before the dialog ever shows it.
#[tauri::command]
pub async fn export_pdf_choose(app: AppHandle, title: String) -> Result<bool, String> {
    let stem = crate::assets::safe_stem(&title).unwrap_or_else(|| "board".to_string());

    // Off the main thread, or the dialog asks the main thread to open it and
    // then waits for it. See `asset_export`.
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .file()
            .set_title("Export board as PDF")
            .set_file_name(format!("{stem}.pdf"))
            .add_filter("PDF", &["pdf"])
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(dest) = picked else {
        return Ok(false);
    };
    let dest = dest.into_path().map_err(|e| e.to_string())?;

    *app.state::<PendingExport>().0.lock().expect("export lock") = Some(dest);
    Ok(true)
}

/// Print the board into the file the user chose, and answer with where it went.
///
/// The board must be posed for `page` by the time this is called — see the
/// module note and `app/exportPdf.ts`.
///
/// The path comes back as a *string for a person to read* ("saved to …") and
/// not as a handle: nothing the frontend can do with it reaches this side
/// again, because no command here takes one.
#[tauri::command]
pub async fn export_pdf_write(app: AppHandle, page: PageSpec) -> Result<String, String> {
    // Checked before the slot is emptied, so a page this side refuses does not
    // also throw away a location the user has already agreed to.
    let (width, height) = page.checked()?;

    let dest = app
        .state::<PendingExport>()
        .0
        .lock()
        .expect("export lock")
        .take()
        .ok_or_else(|| "nowhere to write: no export has been chosen".to_string())?;

    print_to_pdf(&app, &dest, width, height).await?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Ask the webview to print itself into a file.
///
/// ## Why this is not `wait_for_async_operation`
///
/// `webview2-com` offers one, and it pumps the message loop while it waits — on
/// the thread it was called from, which inside a `with_webview` callback is the
/// thread the window is drawn on. That re-enters the application's own message
/// handling in the middle of a print, and a hang there is a hung window with no
/// way out. A channel costs one `await` and leaves the main thread free to do
/// the one thing it has to do during a print, which is draw.
///
/// ## Why the sender is cloned rather than moved
///
/// Because there are two ways this ends and only one of them is the handler.
/// Every step before `PrintToPdf` can fail — an old runtime with no
/// `ICoreWebView2_7`, a settings call, the call itself — and a sender that only
/// existed inside a handler that will now never run would leave the receiver
/// waiting for ever. Both ends hold one; whichever gets there first is the
/// answer, and the other's `send` is dropped.
#[cfg(windows)]
async fn print_to_pdf(
    app: &AppHandle,
    dest: &std::path::Path,
    width: f64,
    height: f64,
) -> Result<(), String> {
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING, PCWSTR};

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "no window to print".to_string())?;

    // Held as an `HSTRING` for the whole call: `PCWSTR` is a borrowed pointer,
    // and the string it points at has to outlive `PrintToPdf` reading it.
    let path = HSTRING::from(dest.as_os_str());
    // The file name and not the path, for a message: the rest is usually a
    // great deal of somebody's disk.
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| dest.to_string_lossy().into_owned());

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Result<(), String>>();
    let failed = tx.clone();

    // `with_webview` dispatches to the main thread and returns as soon as the
    // work is queued; the outcome arrives on the channel.
    window
        .with_webview(move |platform| {
            let started = (|| -> Result<(), String> {
                let environment = platform
                    .environment()
                    .cast::<ICoreWebView2Environment6>()
                    .map_err(|e| {
                        format!("this WebView2 runtime cannot make print settings: {e}")
                    })?;
                let settings =
                    unsafe { environment.CreatePrintSettings() }.map_err(|e| e.to_string())?;
                unsafe {
                    settings.SetPageWidth(width).map_err(|e| e.to_string())?;
                    settings.SetPageHeight(height).map_err(|e| e.to_string())?;
                    // Zero on both sides of the boundary: the page is already
                    // the size of the board (T-205), so a margin here would
                    // scale the whole export down inside its own file.
                    // `@page { margin: 0 }` is the document saying the same
                    // thing (T-208).
                    settings.SetMarginTop(0.0).map_err(|e| e.to_string())?;
                    settings.SetMarginBottom(0.0).map_err(|e| e.to_string())?;
                    settings.SetMarginLeft(0.0).map_err(|e| e.to_string())?;
                    settings.SetMarginRight(0.0).map_err(|e| e.to_string())?;
                    settings.SetScaleFactor(1.0).map_err(|e| e.to_string())?;
                    // The cork and the paper, which go without this (D-36).
                    settings
                        .SetShouldPrintBackgrounds(true)
                        .map_err(|e| e.to_string())?;
                    // A page number and a URL across a picture of somebody's
                    // wall.
                    settings
                        .SetShouldPrintHeaderAndFooter(false)
                        .map_err(|e| e.to_string())?;
                }

                let webview = unsafe { platform.controller().CoreWebView2() }
                    .map_err(|e| e.to_string())?
                    .cast::<ICoreWebView2_7>()
                    .map_err(|e| format!("this WebView2 runtime cannot print to PDF: {e}"))?;

                let done = tx;
                // `webview2-com` has already turned the `HRESULT` into a
                // `Result` and the `BOOL` into a `bool` by the time the closure
                // sees them, so a failed *call* and a failed *print* arrive as
                // two separate things — which is the distinction worth keeping.
                let handler = PrintToPdfCompletedHandler::create(Box::new(move |called, ok| {
                    let outcome = match called {
                        Err(e) => Err(e.to_string()),
                        Ok(()) if ok => Ok(()),
                        // WebView2 reports a file it could not write the same
                        // way it reports a render that failed: one `FALSE` and
                        // no reason. A folder that refuses the write is the
                        // likeliest cause by a distance, so the name is in the
                        // message — it is the only part of this we can name.
                        Ok(()) => Err(format!("the webview could not write {name}")),
                    };
                    let _ = done.send(outcome);
                    Ok(())
                }));

                unsafe { webview.PrintToPdf(PCWSTR(path.as_ptr()), &settings, &handler) }
                    .map_err(|e| e.to_string())
            })();

            if let Err(e) = started {
                let _ = failed.send(Err(e));
            }
        })
        .map_err(|e| e.to_string())?;

    rx.recv()
        .await
        .ok_or_else(|| "the print ended without saying whether it worked".to_string())?
}

/// Everywhere else, for now.
///
/// `PrintToPdf` is WebView2's, and Tauri exposes only `print()` — the *dialog* —
/// on the other platforms. T-210 is the task that decides what they get; until
/// it lands this says so out loud rather than silently producing nothing.
#[cfg(not(windows))]
async fn print_to_pdf(
    _app: &AppHandle,
    _dest: &std::path::Path,
    _width: f64,
    _height: f64,
) -> Result<(), String> {
    Err("PDF export is Windows-only for now (T-210)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(width: f64, height: f64) -> PageSpec {
        PageSpec { width, height }
    }

    #[test]
    fn a_page_of_ordinary_size_is_accepted() {
        assert_eq!(spec(20.0, 8.7).checked(), Ok((20.0, 8.7)));
    }

    #[test]
    fn the_formats_own_limit_is_the_edge_of_what_is_allowed() {
        assert!(spec(200.0, 200.0).checked().is_ok());
        assert!(spec(200.01, 10.0).checked().is_err());
    }

    /// The reason `checked` is written as a rejection: every one of these
    /// passes a `width > 0.0 && width < MAX` guard written the other way round,
    /// and reaches `SetPageWidth`.
    #[test]
    fn nan_and_infinity_and_zero_are_refused_on_either_axis() {
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -8.0] {
            assert!(spec(bad, 10.0).checked().is_err(), "{bad} as a width");
            assert!(spec(10.0, bad).checked().is_err(), "{bad} as a height");
        }
    }

    #[test]
    fn the_axis_that_was_wrong_is_named() {
        let message = spec(10.0, f64::NAN).checked().unwrap_err();
        assert!(message.contains("height"), "{message}");
    }
}
