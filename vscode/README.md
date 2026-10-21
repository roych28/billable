# Billable

Claude Code accounts and cost per client: run every project on the right Claude account, and always know what it costs.

*Formerly Claude Multi-Account. Not affiliated with Anthropic; Claude and Claude Code are trademarks of Anthropic.*

Freelancers and consultants often hold a Claude account per client, plus a personal one. Claude Code signs in once per config directory, so it is easy to spend a client's quota on your own project, or lose track of what a session costs. Billable puts the account, the usage and the switch where you can see them.

![Switching a folder's Claude account from the status bar, then the cost report by account](https://github.com/roych28/claude-multi-account/raw/HEAD/docs/demo.gif)

![Status bar](https://github.com/roych28/claude-multi-account/raw/HEAD/docs/status-bar.png)

## Features

- **The account in the status bar.** The account this folder runs on, the session's tokens and cost, and the highest rate-limit usage. The item turns amber at 90% of a limit.
- **Switch in one click.** Hover the item: the account and its email come first, then a button for every other account. The choice is saved per folder, so each project keeps its own account and you can work on several at once.
- **Add accounts from VS Code.** `Add account` creates a config directory for the new account, installs the companion plugin into it, and opens a terminal to sign in. An account you added earlier, or by hand, gets the plugin the next time VS Code starts, once the plugin runs on any of your accounts. An account where you turned the plugin off is left alone.
- **Pick up where you stopped.** After a switch, start a new conversation right where you are: it receives the last request, the last answer and the path of the previous transcript, so the work continues on the new account without repeating yourself.
- **Real token counts.** Tokens are read from the session transcript: input, output, cache reads and cache writes, for the whole session, resumed sessions included.
- **Cost report by account.** What each account, and each folder under it, cost in a month. One account per client means one line per client on your invoice. Open it from the hover or with `Billable: Cost report by account`.
- **Idle sessions.** Every Claude Code session you leave open keeps a few hundred MB of RAM. The hover shows how many sessions are running, how many are idle, and the RAM they hold together. `Stop idle sessions` stops the ones you pick and gives you the command to resume each one, and a setting can stop long-idle sessions on its own.

## Idle sessions

Claude Code sessions stay in memory until you close them, and a dozen forgotten ones can hold several GB. Billable reads the session files Claude Code keeps in each account's config directory (`sessions/<pid>.json`) and the process list.

- **In the hover:** `Claude sessions: 12 running · 8 idle · 3.5 GB RAM`, with a `Stop idle sessions` button.
- **`Billable: Stop idle sessions`** lists the idle sessions with their folder, how long they have been quiet and their RAM. Sessions quiet longer than the threshold are already selected (the auto-stop setting, or 6 hours when it is off). The chosen ones get `SIGTERM`, and you get `cd <folder> && claude --resume <session id>` for each, with a copy action. The conversation itself stays on disk.
- **Automatic:** set `claudeMultiAccount.idleSessions.autoStopHours` to a number of hours (default `0`, off). Every 30 minutes, sessions idle longer than that are stopped, and a notification lists them with their resume commands.

A session is stopped only when all of these hold, checked again right before the signal:

- Claude Code marks it `idle`. A busy session is never stopped, not even when you pick it.
- Its transcript has not been written for the threshold (when no transcript is found, the process must be that old), and the process is at least that old too.
- The process is alive and is a Claude Code binary, started no later than the session it claims (so a reused pid is left alone).
- It uses under 2.5% CPU over a 5-second sample.

It covers the accounts Billable knows (the `accounts` file, or `~/.claude`), on macOS and Linux.

## Pro

Pro adds the full history of the cost report, beyond the current and the previous month, and CSV export for invoices. **Every Pro feature is free during the launch.** When Pro goes on sale, `Billable: Enter Pro license key` unlocks it on your machine.

## Getting started

1. Install this extension and the companion Claude Code plugin. At the prompt of a Claude Code session:
   ```
   /plugin install multi-account --marketplace roych28/claude-multi-account
   ```
   or from a shell:
   ```
   claude plugin install multi-account --marketplace roych28/claude-multi-account
   ```
2. When the extension asks, let it start Claude Code tabs on each folder's account. It sets `claudeCode.claudeProcessWrapper` to a small launcher in `~/.claude-multi-account/bin`.
3. Run **Billable: Add account** for each client and sign in. The plugin is installed into each new account for you.
4. Open a project, click the account in the status bar, and pick the account it should run on.

## How it works

Every Claude account lives in its own config directory, which Claude Code reads from `CLAUDE_CONFIG_DIR`. Two plain-text files in `~/.claude-multi-account` hold the setup:

- `accounts`: one account per line, `name<TAB>config dir`
- `folders`: one rule per line, `folder<TAB>account`. The longest matching folder wins, and a `*` line is the default.

The launcher reads these files and starts Claude Code on the right account. The companion plugin reports the account, cost and limits of each session, records each session's cost in `~/.claude-multi-account/ledger`, and writes the handoff note the next session reads. The cost is Claude Code's own figure at API prices; on a Pro or Max plan it measures the work done, not what the plan charged.

## Commands

- `Billable: Switch account for this folder`
- `Billable: Cost report by account`
- `Billable: Add account`
- `Billable: Stop idle sessions`
- `Billable: Start Claude Code tabs on the folder's account`
- `Billable: Refresh`
- `Billable: Enter Pro license key`

## Settings

- `claudeMultiAccount.idleSessions.autoStopHours`: stop sessions idle longer than this many hours, checked every 30 minutes. `0` (the default) turns it off; any other value counts as at least 1 hour.

## Requirements

macOS, Linux or Windows, with Claude Code installed. The launcher is a shell script on macOS and Linux, and a small `.exe` on Windows (built from `launcher/`, Go), because the Claude Code extension starts its wrapper without a shell there.

## Privacy

Everything stays on your machine. The extension reads Claude Code's local config, session files and transcripts, lists processes with `ps`, and writes only to `~/.claude-multi-account`. It signals a Claude Code process only when you stop a session, or when you turn on automatic stopping. The one network call is to the license server, with your key, when you enter a Pro license key.

## Support

Found a bug or want a feature? [Open an issue](https://github.com/roych28/claude-multi-account/issues). If the extension saves you time, you can [sponsor its development](https://github.com/sponsors/roych28).

## License

MIT. Not affiliated with Anthropic. Made by [Roy Chemo](https://github.com/roych28) at [Kashuv](https://kashuv.ai).
