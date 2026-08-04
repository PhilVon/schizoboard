# Answer a native file dialog, for driving the application (T-359).
#
# Every place this application chooses a file is a native dialog opened from
# Rust - ARCHITECTURE section 4.4 says why, and the short version is that a
# script in the webview must not be able to name a path. That is the right rule
# and it puts a window in the middle of everything worth driving: an export, an
# open, a save-a-copy. So a driver has to be able to start the gesture and then
# go and answer a window.
#
# Three things this had to learn, all of them recorded by T-84 and all of them
# silent when got wrong:
#
#   * SendKeys does not reach either dialog. WM_SETTEXT on the edit control and
#     BM_CLICK on the button do.
#   * GetDlgItem will not find the filename edit. It is not a direct child of
#     the dialog on modern Windows - it sits under a DUIViewWndClassName /
#     DirectUIHWND / FloatNotifySink chain - so the walk has to be recursive and
#     has to match on BOTH class and control id. An id alone collides.
#   * The save dialog's filename edit is control 1001 and the open dialog's is
#     1148. They are genuinely different controls, so a driver that assumes one
#     silently types into nothing.
#
# ASCII only, deliberately: a non-ASCII character anywhere in this file - even
# in a comment - surfaces as a terminator error about twenty lines below itself.

param(
  # Window title to wait for, as a substring. "Export board", "Open board".
  [Parameter(Mandatory = $true)][string]$Title,
  # The full path to type in. Omit for a dialog that only needs a button.
  [string]$FilePath = "",
  # The button to press, by its text. Save / Open / Replace.
  [string]$Press = "",
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Dlg {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr FindWindow(string cls, string name);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")]
  public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")]
  public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, string l);
  [DllImport("user32.dll")]
  public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
"@

$WM_SETTEXT = 0x000C
$BM_CLICK   = 0x00F5

function Get-Text([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][Dlg]::GetWindowText($h, $sb, $sb.Capacity)
  return $sb.ToString()
}

function Get-Class([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 256
  [void][Dlg]::GetClassName($h, $sb, $sb.Capacity)
  return $sb.ToString()
}

# Every descendant, not just the direct children. The filename edit is three
# levels down; a non-recursive walk finds the chrome and nothing that matters.
function Get-Descendants([IntPtr]$root) {
  $found = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $parent = $stack.Pop()
    # A script block used as a callback writes into the enclosing scope only if
    # the variable already exists there, so $found and $stack are created above
    # rather than inside. Output from the callback itself is swallowed.
    $cb = [Dlg+EnumProc]{
      param($h, $p)
      [void]$found.Add($h)
      $stack.Push($h)
      return $true
    }
    [void][Dlg]::EnumChildWindows($parent, $cb, [IntPtr]::Zero)
  }
  return $found
}

function Find-Dialog([string]$want) {
  $hit = [IntPtr]::Zero
  $tops = New-Object System.Collections.ArrayList
  $cb = [Dlg+EnumProc]{
    param($h, $p)
    [void]$tops.Add($h)
    return $true
  }
  [void][Dlg]::EnumWindows($cb, [IntPtr]::Zero)
  foreach ($h in $tops) {
    if (-not [Dlg]::IsWindowVisible($h)) { continue }
    $t = Get-Text $h
    if ($t -and $t.Contains($want)) { $hit = $h; break }
  }
  return $hit
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$dialog = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $dialog = Find-Dialog $Title
  if ($dialog -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 250
}
if ($dialog -eq [IntPtr]::Zero) {
  Write-Output "NOT-FOUND $Title"
  exit 1
}
Write-Output ("DIALOG " + (Get-Text $dialog))

$kids = Get-Descendants $dialog

if ($FilePath -ne "") {
  # Class AND id. 1001 is the save dialog's filename edit and 1148 is the open
  # dialog's; matching on the id alone finds a different control in whichever
  # of the two this is not.
  $edit = $kids | Where-Object {
    (Get-Class $_) -eq "Edit" -and (@(1001, 1148) -contains [Dlg]::GetDlgCtrlID($_))
  } | Select-Object -First 1
  if (-not $edit) {
    Write-Output "NO-EDIT"
    exit 2
  }
  [void][Dlg]::SendMessage($edit, $WM_SETTEXT, [IntPtr]::Zero, $FilePath)
  Write-Output ("TYPED id=" + [Dlg]::GetDlgCtrlID($edit) + " " + $FilePath)
}

if ($Press -ne "") {
  $button = $kids | Where-Object {
    (Get-Class $_) -eq "Button" -and (Get-Text $_).Replace("&", "") -like "*$Press*"
  } | Select-Object -First 1
  if (-not $button) {
    Write-Output "NO-BUTTON $Press"
    exit 3
  }
  [void][Dlg]::SendMessage($button, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
  Write-Output ("PRESSED " + (Get-Text $button))
}

exit 0
