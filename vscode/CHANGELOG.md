# Changelog

## 0.6.0

- **Idle sessions.** The hover shows how many Claude Code sessions are running, how many are idle, and their total RAM.
- New command `Claude Multi-Account: Stop idle sessions`: pick idle sessions to stop (those quiet past the threshold are pre-selected), then copy the `claude --resume` command for each.
- New setting `claudeMultiAccount.idleSessions.autoStopHours` (default `0`, off): every 30 minutes, stop sessions idle longer than this, with a notification listing them.
- A session is stopped only when Claude Code marks it idle, its transcript has been quiet past the threshold, its process is a live Claude Code binary, and it uses under 2.5% CPU over a 5-second sample. A busy session is never stopped.
- A demo GIF on the Marketplace page.

## 0.5.1

- Fixes to `Add account` and `Use default` in the switch menu.

## 0.5.0

- Windows support: the launcher ships as a small `.exe` built from `launcher/`.

## 0.4.x and earlier

- The account in the status bar, one-click switching per folder, adding accounts from VS Code, real token counts from the transcript, the cost report by account, and the companion Claude Code plugin.
