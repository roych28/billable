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
- **Cost report by account.** What each account, and each folder under it, cost in a month. One account per client means one line per client on your invoice. Open it from the hover or with `Claude Multi-Account: Cost report by account`.

## Pro

Pro adds the full history of the cost report, beyond the current and the previous month, and CSV export for invoices. **Every Pro feature is free during the launch.** When Pro goes on sale, `Claude Multi-Account: Enter Pro license key` unlocks it on your machine.

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
3. Run **Claude Multi-Account: Add account** for each client and sign in.
4. Open a project, click the account in the status bar, and pick the account it should run on.

## How it works

Every Claude account lives in its own config directory, which Claude Code reads from `CLAUDE_CONFIG_DIR`. Two plain-text files in `~/.claude-multi-account` hold the setup:

- `accounts`: one account per line, `name<TAB>config dir`
- `folders`: one rule per line, `folder<TAB>account`. The longest matching folder wins, and a `*` line is the default.

The launcher reads these files and starts Claude Code on the right account. The companion plugin reports the account, cost and limits of each session, records each session's cost in `~/.claude-multi-account/ledger`, and writes the handoff note the next session reads. The cost is Claude Code's own figure at API prices; on a Pro or Max plan it measures the work done, not what the plan charged.

## In the terminal

The same rules work for `claude` in any terminal. Add this to `~/.zshrc` or `~/.bashrc`:

```sh
claude() { ~/.claude-multi-account/bin/cma exec claude "$@"; }
```

On Windows, add this to your PowerShell profile (`notepad $PROFILE`):

```powershell
function claude { & "$HOME\.claude-multi-account\bin\cma.exe" exec claude.exe @args }
```

Inside a session, `/account` shows the account, cost and limits, and `/account <name>` switches the folder. The plugin also draws the account and its switch buttons above the prompt.

## Testing

- `cd vscode && npm test`: unit tests for the rules, tokens, cost report and license.
- `cd vscode && npm run test:integration`: runs the extension inside a real VS Code against a throwaway setup.
- `claude plugin test ./plugin`: the Claude Code plugin's tests.
- `scripts/check-accounts`: a live check on the accounts of this machine. For each signed-in account it runs one short session through the launcher and checks that it ran on that account, was reported by the plugin and landed in the cost ledger. Then it moves a folder between two accounts and checks the second one picks up where the first stopped. It uses a temporary setup, never your own rules, and costs a few cents per account.

## Repository layout

- `plugin/`: the Claude Code plugin `multi-account`
- `vscode/`: the VS Code extension, with the launcher in `vscode/bin`

## Commands

- `Claude Multi-Account: Switch account for this folder`
- `Claude Multi-Account: Cost report by account`
- `Claude Multi-Account: Add account`
- `Claude Multi-Account: Start Claude Code tabs on the folder's account`
- `Claude Multi-Account: Refresh`
- `Claude Multi-Account: Enter Pro license key`

## Requirements

macOS, Linux or Windows, with Claude Code installed. The launcher is a shell script on macOS and Linux, and a small `.exe` on Windows (built from `launcher/`, Go), because the Claude Code extension starts its wrapper without a shell there.

## Privacy

Everything stays on your machine. The extension reads Claude Code's local config and transcripts and writes only to `~/.claude-multi-account`. The one network call is to the license server, with your key, when you enter a Pro license key.

## Support

Found a bug or want a feature? [Open an issue](https://github.com/roych28/claude-multi-account/issues). If the extension saves you time, you can [sponsor its development](https://github.com/sponsors/roych28).

## License

MIT. Not affiliated with Anthropic. Made by [Roy Chemo](https://github.com/roych28) at [Kashuv](https://kashuv.ai).
