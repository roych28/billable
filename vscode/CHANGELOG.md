# Changelog

## 0.6.2

- **`Add account` signs in the new account, not the folder's.** The sign-in used to run `claude auth login` in a shell, where a `claude()` wrapper (the one the README suggests for the terminal) set the folder's account and signed that one in again. It now runs Claude Code's own binary directly, so neither the shell profile nor your PATH can change where it lands.
- When the sign-in ends, Billable says which email the new account signed in as. If it is a different email than the one you entered, or the sign-in did not finish, it offers to sign in again.

## 0.6.1

- **New accounts get the plugin.** `Add account` installs the companion Claude Code plugin into the new account before you sign in, so its first session already shows the account, cost and limits above the prompt and has `/account`. It installs from the same place your other accounts use, or from GitHub.
- Accounts that are missing the plugin, because they were added before this version or by hand, get it when VS Code starts, as long as the plugin runs on another of your accounts. An account where the plugin is turned off is left alone.
- The install uses the `claude` binary inside the Claude Code extension, so `claude` does not need to be on your PATH.

## 0.6.0

- **Renamed to Billable** (formerly Claude Multi-Account), now listed as `roychemo.billable`. Settings, commands and `~/.claude-multi-account` keep their names, so nothing needs to be set up again.
- **Idle sessions.** The hover shows how many Claude Code sessions are running, how many are idle, and their total RAM.
- New command `Billable: Stop idle sessions`: pick idle sessions to stop (those quiet past the threshold are pre-selected), then copy the `claude --resume` command for each.
- New setting `claudeMultiAccount.idleSessions.autoStopHours` (default `0`, off): every 30 minutes, stop sessions idle longer than this, with a notification listing them.
- A session is stopped only when Claude Code marks it idle, its transcript has been quiet past the threshold, its process is a live Claude Code binary, and it uses under 2.5% CPU over a 5-second sample. A busy session is never stopped.
- A demo GIF on the Marketplace page.

## 0.5.1

- Fixes to `Add account` and `Use default` in the switch menu.

## 0.5.0

- Windows support: the launcher ships as a small `.exe` built from `launcher/`.

## 0.4.x and earlier

- The account in the status bar, one-click switching per folder, adding accounts from VS Code, real token counts from the transcript, the cost report by account, and the companion Claude Code plugin.
