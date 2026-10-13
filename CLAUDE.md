# For Claude: installing Detaly for a user

A user sent you this repository (or opened a session in it). It is **Detaly**, a Claude Code **mod** (a plugin of
function hooks) that draws progress bars above the prompt for long jobs. Install it for them, then tell them what
changed.
Talk to the user in their own language, briefly. Do the steps yourself where your tools allow; ask before anything
that touches their settings file.

**Developing the mod instead?** If the session runs in a clone the user develops in, skip the install: see Develop in
[README.md](README.md). The installed copy is a separate clone; after a change, commit here, then `git pull` in the
installed copy.

## 1. Check that mods work there

- Mods need Claude Code **2.1.286+**. Find the version: `claude --version` in a shell; in the desktop app the
  bundled CLI is the running `claude` process (Windows: `Get-CimInstance Win32_Process -Filter "Name='claude.exe'"`
  shows its path, under `%APPDATA%\Claude\claude-code\<version>\`), or ask the user to look at `/status`.
- Older, a WSL session or a cloud session: say mods are not available there and stop.

## 2. Install

Pick the first route that fits:

- **A. A `claude` CLI on PATH** (`claude --version` works):
  `claude plugin marketplace add qr1x55/Detaly-Claude-Mod`, then
  `claude plugin install detaly@detaly`. Updates: `claude plugin update detaly`.
- **B. No CLI on PATH** (the desktop app alone; its bundled CLI may be called by full path for `plugin validate` /
  `plugin test`, but install through settings):
  1. Clone into the user's Claude folder, outside AppData (the Windows desktop app is an MSIX package: files written
     under `%APPDATA%` from inside it can be invisible to other programs):
     `git clone https://github.com/qr1x55/Detaly-Claude-Mod "<home>/.claude/mods/detaly"`.
     No git: download the zip of `main` and unpack it there.
  2. Edit `<home>/.claude/settings.json` (the **user** settings; a project's settings are not read for this).
     **Read it first and merge; never overwrite what is there.** Missing: create it. Under `env` set
     `CLAUDE_CODE_PLUGIN_DIRS` to the absolute folder path; if the variable already holds folders, append with `;`
     on Windows, `:` elsewhere. Add `"CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"` so a later `git pull` reloads it in open
     sessions. Check the file still parses as JSON.
- Optional check with the CLI (bundled one by full path is fine):
  `claude plugin validate <folder>` (expect "Validation passed"), `claude plugin test <folder>` (expect every test to pass).

## 3. Tell the user (adapt, keep it short)

- **Restart:** fully quit the Claude app (tray icon → Quit, not just the window) and open it again; mods load when a
  session starts. **A restart ends every background task running in every chat** (trainings, renders): look for
  running ones first (the Background tasks pane) and tell them to wait if there are any.
- **What they get:** above the prompt of each chat, a row per long job of that chat: timer, bar, percent, time
  left; green when done, red when it failed. Background commands of the chat show up by themselves; jobs started
  outside Claude show up when they write `~/.claude/progress/<id>.json` (`bin/progress.py`, or
  `bin/progress_tail.ps1` on any log, no change to the job). Tabs show every open chat's jobs (All, this chat,
  the others; hover a tab for Sync / Clear / Close); **▾ Minimize** keeps this chat's rows under a line of the
  session's figures (context, rate limits with rings, tokens, cost); `/detaly` opens the All tab.
- **Cost:** no tokens; it only draws and reads local files.
- **Optional, worth offering:** a line in their global `~/.claude/CLAUDE.md` such as "When starting a long
  background command, put the expected duration in its description, e.g. `~15 min`." With it the bar has an
  estimate almost always. This one costs a few dozen (cached) tokens per request. Add it only if they agree.

## 4. After their restart: verify

Run one background command with an estimate and countable output, e.g. (bash)
`for i in $(seq 1 30); do echo "step $i/30"; sleep 1; done` with the description `Progress test ~30 s`. While it
runs the user should see `Progress test` with a bar near `n / 30`, then green `done`. No row: check the version, that
`settings.json` parses and names the folder, and that the app was fully quit.

## Your own habits once it is installed

- Give long background commands a description with the expected duration (`~15 min`, `~2 h`).
- A job that runs outside your background tasks (a script you launch detached, a training that logs to a file):
  have it write the protocol file (`bin/progress.py` `report(...)`), or start `bin/progress_tail.ps1 -Log <log>`
  detached with `Start-Process`, not as your background task (a background task wakes the chat when it exits:
  a paid turn).
- The protocol and the helpers are in [README.md](README.md).

## Uninstall

Remove the folder from `CLAUDE_CODE_PLUGIN_DIRS` (route B) or `claude plugin uninstall detaly` (route A), then
restart the app. `~/.claude/progress/` holds only small JSON files and can be deleted.
