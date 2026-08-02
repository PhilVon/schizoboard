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
//! So: [`export_choose`] asks, and [`export_pdf_write`] prints. The path
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

/// What kind of file an export is going to be.
///
/// One dialog command for both routes rather than a second near-identical one.
/// The two differ in three strings and nothing else, and the part that is worth
/// getting right — the path never crossing the boundary, the last answer
/// winning, a cancel costing nothing — is the part that would have been
/// duplicated.
#[derive(Clone, Copy)]
pub enum ExportKind {
    Pdf,
    /// Both raster formats at once - which one the file is comes back from the
    /// *dialog*, as the extension of the name the user settled on. Offering
    /// them as filters rather than as two more menu rows is what a save dialog
    /// is for, and it means the board's own menu does not grow a row for every
    /// format anybody ever adds.
    Image,
}

impl ExportKind {
    /// From the string the webview sends. Unknown kinds are refused rather than
    /// defaulted: a typo that silently saved a PNG as a PDF would be a file
    /// nothing can open, named as though it could.
    fn parse(kind: &str) -> Result<Self, String> {
        match kind {
            "pdf" => Ok(Self::Pdf),
            "image" => Ok(Self::Image),
            other => Err(format!("unknown export kind: {other}")),
        }
    }

    /// What the dialog opens on, and so also the default format. PNG, because
    /// lossless is what somebody who has not thought about it wants; WebP is
    /// there for somebody who has seen the file size.
    fn default_extension(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Image => "png",
        }
    }

    fn dialog_title(self) -> &'static str {
        match self {
            Self::Pdf => "Export board as PDF",
            Self::Image => "Export board as an image",
        }
    }

    /// Label and extension for each offered format, in the order the dialog
    /// shows them.
    fn filters(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Self::Pdf => &[("PDF", "pdf")],
            Self::Image => &[("PNG image", "png"), ("WebP image", "webp")],
        }
    }
}

/// Ask the user where an export should go and in which format, and remember
/// the answer.
///
/// `null` is a cancelled dialog — an ordinary outcome and not a failure, the
/// same thing `asset_export`'s `false` and `bundle_save_as`'s `null` mean.
/// Nothing is written and nothing on the board need move.
///
/// `title` is the board's, on exactly the standing `origName` has in
/// `asset_export`: a caller-supplied string that crosses as a *name*, which is
/// the difference that makes it safe, and that `safe_stem` reduces to a bare
/// filename before the dialog ever shows it.
///
/// The slot this fills is shared by both writers, and deliberately: a `choose`
/// for a PNG followed by an `export_pdf_write` would print a PDF into the file
/// the user named `.png`. That is a caller confusing itself with a file the
/// user did agree to, in a place they agreed to it — not something this side
/// can be tricked into, and not worth a second slot to make impossible.
///
/// **What comes back is the format**, taken from the extension the dialog
/// settled on, and that is the whole reason this is a string rather than a
/// boolean: the renderer encodes the picture, so it has to be told what to
/// encode it *as*, and the answer belongs to the dialog rather than to a menu
/// row. An extension we did not offer falls back to `png` - what somebody who
/// typed their own name over the top gets - which is the safe direction,
/// because PNG is lossless and always encodes where WebP can hand back nothing.
#[tauri::command]
pub async fn export_choose(
    app: AppHandle,
    title: String,
    kind: String,
) -> Result<Option<String>, String> {
    let kind = ExportKind::parse(&kind)?;
    let stem = crate::assets::safe_stem(&title).unwrap_or_else(|| "board".to_string());

    // Off the main thread, or the dialog asks the main thread to open it and
    // then waits for it. See `asset_export`.
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = handle
            .dialog()
            .file()
            .set_title(kind.dialog_title())
            .set_file_name(format!("{stem}.{}", kind.default_extension()));
        for (label, extension) in kind.filters() {
            dialog = dialog.add_filter(*label, &[*extension]);
        }
        dialog.blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(dest) = picked else {
        return Ok(None);
    };
    let dest = dest.into_path().map_err(|e| e.to_string())?;
    let format = chosen_format(&dest, kind);

    *app.state::<PendingExport>().0.lock().expect("export lock") = Some(dest);
    Ok(Some(format))
}

/// Which of the offered formats the chosen filename names.
///
/// Case-folded, because a dialog hands back `Board.PNG` as readily as
/// `board.png` and the renderer switches on this string.
fn chosen_format(dest: &std::path::Path, kind: ExportKind) -> String {
    let extension = dest
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    kind.filters()
        .iter()
        .find(|(_, offered)| *offered == extension)
        .map(|(_, offered)| (*offered).to_string())
        .unwrap_or_else(|| kind.default_extension().to_string())
}

/// Write an already-encoded image into the file the user chose.
///
/// The counterpart to [`export_pdf_write`], and much the smaller of the two:
/// the PDF is rendered by Chromium and this is a `write`. The picture was
/// composited in the renderer (`app/exportImage.ts`) because that is where the
/// board is — every layer of it is a painter that takes a camera, and none of
/// them exists on this side.
///
/// A raw body rather than an argument, the same shape `asset_ingest_bytes`
/// takes and for the same reason: a four-megabyte PNG as a JSON array of
/// numbers is about six times the bytes and a parse stall on every one of them.
///
/// Refuses an empty body. `toBlob` resolving to nothing is the shape a canvas
/// failure takes in the renderer, and a zero-byte `.png` on somebody's desktop
/// is a worse answer to it than an error they can see.
#[tauri::command]
pub async fn export_image_write(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("export_image_write expects a raw body".into());
    };
    if bytes.is_empty() {
        return Err("there was nothing to write: the board encoded to no bytes".into());
    }
    let bytes = bytes.clone();

    // Taken after the body is checked, so a call this side refuses does not
    // also throw away a location the user has already agreed to.
    let dest = app
        .state::<PendingExport>()
        .0
        .lock()
        .expect("export lock")
        .take()
        .ok_or_else(|| "nowhere to write: no export has been chosen".to_string())?;

    let path = dest.clone();
    tauri::async_runtime::spawn_blocking(move || std::fs::write(&path, &bytes))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("could not write {}: {e}", dest.display()))?;

    Ok(dest.to_string_lossy().into_owned())
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

/// Everywhere else — a backstop, and nothing should reach it.
///
/// `PrintToPdf` is WebView2's. Tauri's own `print()` is the print *dialog* and
/// only on macOS; the cross-platform one is JS `window.print()`, which cannot
/// be handed the page size the board computed and never says when it finished.
/// So Q-139 chose not to ship a second, worse PDF: on macOS and Linux the menu
/// has no PDF row, and the image export — which composites in the renderer and
/// only needs a `write` from this side — is the picture there (T-210).
///
/// This stays anyway. The row being absent is a frontend fact, and a command is
/// reachable by anything that can call one; an error is a better answer to that
/// than a zero-byte `.pdf` on somebody's desktop.
#[cfg(not(windows))]
async fn print_to_pdf(
    _app: &AppHandle,
    _dest: &std::path::Path,
    _width: f64,
    _height: f64,
) -> Result<(), String> {
    Err("PDF export is Windows only — export the board as an image instead".to_string())
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
    fn both_export_kinds_are_understood_and_nothing_else_is() {
        assert_eq!(ExportKind::parse("pdf").unwrap().default_extension(), "pdf");
        assert_eq!(
            ExportKind::parse("image").unwrap().default_extension(),
            "png"
        );
        assert!(ExportKind::parse("PDF").is_err());
        assert!(ExportKind::parse("png").is_err());
        assert!(ExportKind::parse("").is_err());
    }

    #[test]
    fn the_image_dialog_offers_png_first_and_webp_beside_it() {
        let offered: Vec<_> = ExportKind::Image.filters().iter().map(|f| f.1).collect();
        assert_eq!(offered, ["png", "webp"]);
    }

    /// The renderer switches on what this returns, so an extension it does not
    /// recognise has to land on the format that always encodes rather than on
    /// the one that can hand back nothing.
    #[test]
    fn the_format_comes_from_the_name_the_dialog_settled_on() {
        let f = |name: &str| chosen_format(std::path::Path::new(name), ExportKind::Image);
        assert_eq!(f("C:/wall/board.png"), "png");
        assert_eq!(f("C:/wall/board.webp"), "webp");
        assert_eq!(f("C:/wall/board.WEBP"), "webp");
        // A name somebody typed over the top of the offered one.
        assert_eq!(f("C:/wall/board.jpg"), "png");
        assert_eq!(f("C:/wall/board"), "png");
        // And a board whose own title ends in something that looks like one.
        assert_eq!(f("C:/wall/notes.webp.png"), "png");
    }

    #[test]
    fn the_axis_that_was_wrong_is_named() {
        let message = spec(10.0, f64::NAN).checked().unwrap_err();
        assert!(message.contains("height"), "{message}");
    }
}
