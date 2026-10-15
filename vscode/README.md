# Claude Multi-Account

Run every project on the right Claude account, and always know which one you are on.

Freelancers and consultants often hold a Claude account per client, plus a personal one. Claude Code signs in once per config directory, so it is easy to spend a client's quota on your own project, or lose track of what a session costs. Claude Multi-Account puts the account, the usage and the switch where you can see them.

![Status bar](https://github.com/roych28/claude-multi-account/raw/HEAD/docs/status-bar.png)

## Features

- **The account in the status bar.** The account this folder runs on, the session's tokens and cost, and the highest rate-limit usage. The item turns amber at 90% of a limit.
- **Switch in one click.** Hover the item: the account and its email come first, then a button for every other account. The choice is saved per folder, so each project keeps its own account and you can work on several at once.
- **Add accounts from VS Code.** `Add account` creates a config directory for the new account and opens a terminal to sign in.
- **Pick up where you stopped.** After a switch, start a new conversation right where you are: it receives the last request, the last answer and the path of the previous transcript, so the work continues on the new account without repeating yourself.
- **Real token counts.** Tokens are read from the session transcript: input, output, cache reads and cache writes, for the whole session, resumed sessions included.

## Getting started

1. Install this extension and the companion Claude Code plugin. In a Claude Code session:
   ```
   /plugin install multi-account@claude-multi-account --marketplace roych28/claude-multi-account
   ```
2. When the extension asks, let it start Claude Code tabs on each folder's account. It sets `claudeCode.claudeProcessWrapper` to a small launcher in `~/.claude-multi-account/bin`.
3. Run **Claude Multi-Account: Add account** for each client and sign in.
4. Open a project, click the account in the status bar, and pick the account it should run on.

## How it works

Every Claude account lives in its own config directory, which Claude Code reads from `CLAUDE_CONFIG_DIR`. Two plain-text files in `~/.claude-multi-account` hold the setup:

- `accounts`: one account per line, `name<TAB>config dir`
- `folders`: one rule per line, `folder<TAB>account`. The longest matching folder wins, and a `*` line is the default.

The launcher reads these files and starts Claude Code on the right account. The companion plugin reports the account, cost and limits of each session, and writes the handoff note the next session reads.

## Commands

- `Claude Multi-Account: Switch account for this folder`
- `Claude Multi-Account: Add account`
- `Claude Multi-Account: Start Claude Code tabs on the folder's account`
- `Claude Multi-Account: Refresh`

## Privacy

Everything stays on your machine. The extension reads Claude Code's local config and transcripts and writes only to `~/.claude-multi-account`. It sends nothing anywhere.

## License

MIT. Not affiliated with Anthropic.
