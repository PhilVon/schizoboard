---
name: verify
description: Build, launch and drive Schizoboard on Windows to observe a change actually working — the app is a Tauri v2 shell around a Vite frontend, so "run it" means two processes and a webview.
---

# Verifying Schizoboard

The surface is **pixels in the Tauri window**. `npm run check` is CI, not
evidence — a board that persists, culls, drapes or draws is only observable by
running it.

## Launching

```sh
npm run tauri dev            # the normal way: starts Vite, then the shell
```

**If port 1420 is already in use, a Vite server for this project is already
running** (the fixed port is deliberate — `vite.config.ts` sets
`strictPort`). Don't kill it; it is probably the human's. Start only the Rust
half against it:

```sh
npx tauri dev --config '{"build":{"beforeDevCommand":""}}'
```

First Rust build after touching `src-tauri/` is about 80 seconds — `Cargo.toml`
turns incremental compilation off because the `cdylib` half of the lib target
will not otherwise link on Windows. Frontend edits need no rebuild at all: Vite
HMR full-reloads the webview, which re-runs `boot()`, which is a genuinely
useful way to get a second session against the same disk.

Run it in the background and wait for `Running \`target\debug\schizoboard.exe\``
in the log, then give the webview a few seconds more.

## Screenshotting

`user32!PrintWindow(hwnd, hdc, 2)` — `PW_RENDERFULLCONTENT`, which WebView2
needs. Never `CopyFromScreen`: Windows' foreground lock silently refuses the
raise and you capture whatever the human is actually looking at.

**Find the window by process name, never by title.** `MainWindowTitle -like
"*Schizoboard*"` will happily hand you Firefox — the kanban board's own tab is
titled `SchizoBoard · KanAgentBan`, and any editor with a project file open
matches too. Handing that hwnd to `PrintWindow` screenshots the human's
browser; handing it to `SendKeys` types into it.

```powershell
$p = Get-Process -Name schizoboard -ErrorAction SilentlyContinue | Select-Object -First 1
```

The **dev HUD is
the cheapest assertion in the project** — it prints zoom, camera, item count,
DOM nodes and document size, so one screenshot answers most questions about
state. Press `` ` `` to toggle it; `boot()` leaves it on.

Devtools open with Ctrl+Shift+I into a *separate* top-level window titled
`DevTools - localhost:1420/` — screenshot that by title too. `{F12}` through
SendKeys does not reach it.

## Driving

The app has no CLI and no test hooks. Drive it the way a person does:

```powershell
Set-Clipboard -Value "some text"
$w = New-Object -ComObject wscript.shell
$w.AppActivate("Schizoboard"); Start-Sleep -Milliseconds 600
$w.SendKeys("^v")
```

**`AppActivate` fails silently while the human is at the machine.** Windows'
foreground lock refuses the raise for a background process, `AppActivate`
returns without complaint, and `SendKeys` then types into whatever the human
*is* looking at. Borrowing the foreground thread's input queue gets past it
without sending a keystroke to find out:

```powershell
$fgThread = [FG]::GetWindowThreadProcessId([FG]::GetForegroundWindow(), [ref]$null)
[void][FG]::AttachThreadInput([FG]::GetCurrentThreadId(), $fgThread, $true)
[void][FG]::SetForegroundWindow($h)
[void][FG]::AttachThreadInput([FG]::GetCurrentThreadId(), $fgThread, $false)
```

Then **read `GetForegroundWindow` back and compare its pid to the target before
typing a single key**, and abort if it does not match. The raise still fails
sometimes; the difference is whether you find out before or after pasting into
somebody's browser.

Paste is the primary verb, so it is also the cheapest way to get state onto a
board: text becomes a note, image bytes become a polaroid. Everything else —
drag, rotate, marquee — needs real mouse input.

## Reading the document on disk

`%APPDATA%\com.philw.schizoboard\` holds `assets/` and `doc/`
(`log.bin`, `snapshot.bin`). `log.bin` starts with `SZBDLOG1`.

> **The file size is a lie while the app is running.** NTFS updates the
> directory entry lazily for an open handle, so `ls`, `Get-ChildItem` and
> Explorer all report the size as of some earlier moment — this looks exactly
> like "the write never happened" and will send you hunting a bug that is not
> there. Read the **bytes** (`wc -c`, `xxd`), or close the app first.

`Get-FileHash` and `[IO.File]::ReadAllBytes` fail outright with a sharing
violation while the app holds the log open; Git Bash tools read it fine.

To exercise a failure path, edit the files directly between runs: append a
frame header that claims more bytes than follow (torn tail — the shell prints
`docstore: dropping N unreadable bytes` to stderr and repairs the file), or
overwrite `log.bin` with something that is not ours (the board opens read-only
and says so in the hint line). Back the directory up first and put it back
after; it is the human's real board.
