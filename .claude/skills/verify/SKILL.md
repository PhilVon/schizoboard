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

> **`SendKeys` cannot press most of this app's shortcuts.** Chromium derives
> `KeyboardEvent.code` from the hardware scan code, and `SendKeys` leaves it
> zero — so `code` arrives empty. Anything bound to `e.key` works (`Ctrl+0`,
> `Ctrl+1`, in `navigation.ts`) and everything bound to `e.code` silently does
> nothing: undo's `KeyZ`, `Delete`, `Space` for panning, `F` to frame. Ctrl+V is
> the confusing exception — WebView2 handles it natively and fires the `paste`
> event without JavaScript ever seeing a key. So a run can look like "keys work"
> and then quietly refuse the one you are testing.
>
> Send a scan code with the key:
>
> ```powershell
> # keybd_event(vk, MapVirtualKey(vk, 0), flags, 0)
> [K]::Down(0x11, $false)   # Ctrl
> [K]::Down(0x5A, $false)   # Z
> [K]::Up(0x5A, $false); [K]::Up(0x11, $false)
> ```
>
> `Delete` (0x2E) additionally needs `KEYEVENTF_EXTENDEDKEY` (0x0001).

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
drag, rotate, marquee, and every context menu — needs real mouse input, below.

## Pointer input

`SetCursorPos` then `mouse_event`. Screen coordinates, so add the window origin
from `GetWindowRect` — and because `PrintWindow` captures the **whole** window,
a coordinate read off a screenshot is already in that frame and needs no
correction for the title bar beyond the origin itself.

Do the same foreground dance as for keys, and **read the pid back before
pressing a button**: a click that lands in somebody's browser is worse than a
keystroke, because it can move something.

```powershell
Add-Type @"
using System; using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
# left 0x0002/0x0004 · right 0x0008/0x0010 · middle 0x0020/0x0040 · wheel 0x0800
$r = New-Object M+RECT
[void][M]::GetWindowRect($h, [ref]$r)               # $h from the raise above
[void][M]::SetCursorPos(($r.L + $x), ($r.T + $y))
[M]::mouse_event(0x0008, 0, 0, 0, [IntPtr]::Zero)   # right down
[M]::mouse_event(0x0010, 0, 0, 0, [IntPtr]::Zero)   # right up
```

Sleep ~60 ms between down and up, and a few hundred after the release before
screenshotting. That is the cadence these gestures were driven at and it is
reliable; nothing here has been tested tighter, so treat it as a floor to relax
deliberately rather than as a measured limit.

A **drag** is down, `SetCursorPos` steps, then up. One jump does start a real
drag — `select.ts` begins the gesture on the first move more than
`DRAG_THRESHOLD_PX` (3) from the press — but it lands the whole delta in a
single frame, which no hand does. Step it whenever the *path* is part of what
is being tested: the carry lag and scale-up on a moving item, a marquee sweeping
over things, or anything downstream of the rope solver, all of which are
functions of how the pointer got there rather than of where it ended up.

> **Wheel down is not `-120`.** The delta is a signed `WHEEL_DELTA` widened into
> a `DWORD`, so up is `[uint32]120` and down is `[uint32]4294967176`.
> PowerShell refuses to cast `-120` and throws *inside* the notch loop, so the
> script still runs to the end and prints its usual success line — scroll-up
> works, scroll-down silently does nothing, and it reads as the app ignoring the
> gesture.

> **Keep helper `.ps1` files pure ASCII.** 5.1 reads a BOM-less script as ANSI,
> so an em-dash in a *comment* turns into two bytes that unbalance the next
> string — reported as a missing terminator twenty lines below, which reads as a
> quoting bug in the code.

**Find the target by pixel, not by eye.** Estimating a point on a rope off a
screenshot misses by the few pixels the hit radius does not cover, and a missed
right-click opens no menu — after which the *next* click lands on the board
instead of on the menu row you meant. Scan the frame for the colour instead:

```python
ys = [y for y in range(y0, y1) if blue(px[x, y])]   # the string at column x
```

And **re-locate between gestures**. Anything that changes a rope's pose moves it
out from under coordinates measured one screenshot ago; the same right-click
point that worked before a material change hit bare cork after it.

**The menu is a fixed offset from the click.** It opens with its top-left corner
at the cursor, so once the row geometry is measured from one screenshot the
chips can be clicked without re-cropping: at the time of writing the *Material*
chips sit at `+28/+59/+90` in x and `+144` in y from the right-click. Re-measure
if the rows change — that is three numbers, not a lookup table worth trusting.

**Let the simulation settle before measuring.** A restyle that moves a rope
leaves it awake for a second or two; the HUD's `awake` counter is the signal,
and a screenshot taken mid-ring reports a pose the string is only passing
through. Watching a *sequence* of frames is also the only way to tell a paced
change from a snap.

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
