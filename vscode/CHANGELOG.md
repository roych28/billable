# Changelog

## 0.8.0

- **Billable Pro is on.** The cost report's full history (beyond the current and the previous month) and the CSV export now take a license key: `Get Pro` opens the checkout, `Billable: Enter license key` activates a key on this machine (up to three machines per key), and the report the user asked for opens right after. The key is checked again once a week.
- A paid key is never dropped by an outage, a rate limit or a broken answer from the license server at the weekly check; only the server saying the key is not valid does that.
- `Billable: Enter license key` says when Pro is already active on this machine, and ignores a blank key.
- **Sharing never eats the default account's own folder.** An account whose folder is, or links to, the default account's folder (an accounts file written by hand) is not offered sharing, and a saved choice for one is skipped; it used to move the conversations into a backup and leave a link pointing at itself.
- **Nothing is moved for a link that cannot be made.** Whether links work in the account's folder is found out first (on Windows a file link needs Developer Mode), and a failure after a move puts the moved item back. A link Billable made whose target the default account deleted is recognised as Billable's and remade, instead of being reported as someone else's.
- **The launchers read the account files like the extension does**: a BOM, CRLF line endings and spaces around the fields no longer send every tab to `~/.claude` while the status bar says otherwise; a name listed twice keeps its first line everywhere.
- **The status bar agrees with the launcher** for a workspace opened through a link (the real path is tried too) and for a folder without a rule (the account on `~/.claude`, not the first account in the file).
- The hover shows the sign-in the account has now, so `Sign in again` with another email shows at once.
- A session status from another version, without an account or folder, no longer stops every refresh; a refresh that fails is logged and the next one runs.
- A transcript of hundreds of MB is read in pieces instead of one string.
- `Switch` to an account name that no longer exists is refused instead of pinning it.
- `Remove account` says when the sign-out could not run (claude not found), since the keychain entry then remains.
- The sign-in says when Claude Code is not found at all, instead of asking to sign in again forever.
- `Set up` for the launcher warns when a workspace setting still launches Claude Code through something else.
- The launcher files are copied only when they changed, so a launcher in use on Windows no longer fails every start.
- The plugin install for an account that is missing it runs in one window at a time, and after a failure is tried again the next day, not on every window that opens.
- The CSV's timestamps are in local time with the offset, like its month column, so a session half an hour after midnight on the 1st is in the new month in every column; a row without a last write no longer breaks the export.
- A lock file with a time in the future (a clock that was put right) counts as stale.
- A paid key whose weekly check was recorded in the future (a clock moved back) is checked again now; an activation the server accepted but this machine could not keep is given back to the key's limit and reported as such.
- Only a program named `claude` (or Claude Code's script under node or bun) counts as a Claude session: a project folder named claude-something running something else never does.
- `~` in the report stands only for the home folder itself; 999,999 tokens read 1.0M, not 1000K.
- **The status bar names the account a new tab really runs on.** A folder without a rule, or whose rule names an account that does not exist, shows `~/.claude` (or the folder VS Code's own `CLAUDE_CONFIG_DIR` points at), never the first account of the file. A folder opened through a link takes the longer rule of its path and its real path, in the status bar and in both launchers alike, so a `*` rule no longer hides the real path's rule.
- `Use default` drops the rule of the folder's real path too, when it was opened through a link.
- A status left by an account that was removed no longer shows as a chat still open on it.
- **Edits to the account files run one window at a time** (`Add account`, a switch, `Remove account`, sharing): two windows writing at once no longer drop each other's line, and each file is replaced in one step.
- `Add account` makes the folder before it records the account, so a folder that cannot be made no longer leaves a name that can be neither used nor added again; comments in an accounts file with no account yet are kept.
- `Remove account` on an account whose folder is already gone says it was removed, not that the folder could not be moved to the trash.
- When the sign-in cannot start, no instructions follow for a terminal that never opened. On Windows, where Claude Code opens the default browser itself, the sign-in says so.
- A share choice made while another window is busy waits for it, and if it is still busy, is kept and applied at the next start instead of being dropped.
- A relative `CLAUDE_MULTI_ACCOUNT_HOME` is taken from the home folder by the extension, both launchers and the plugin alike.
- Companion plugin 0.2.3: the handoff note is kept per working folder, so a sibling folder of the same repository on another account gets none; a note written at a switch waits for the session it was written for instead of being replaced by another session still at work there; it reads the accounts file like the launchers (`~\`, a BOM, CRLF, a name listed twice); once its account is removed, the chat line says where new conversations go; and `/account` offers accounts added after the session started.

## 0.7.0

- **Switching to an account that is not signed in offers the sign-in first.** A new conversation there used to ask to sign in through the default browser, which usually authorizes another Claude account. Now `Switch` says the account is not signed in and offers `Sign in` (with the link and the code) or `Switch anyway`; once signed in, it offers the new conversation.
- **A new account is offered to share with the default one** right after it signs in: `Share conversations and memory`, or `Keep apart` for a client whose work stays separate.
- **`Remove account` never offers the default account, `~/.claude`, or a folder two accounts use.** An accounts file written by hand could list `~/.claude` under another name, and removing it moved Claude Code's own folder to the trash. When the folder cannot go to the trash, Billable now says so instead of saying the account was removed.
- **`/account` in a chat switches the folder the chat runs in.** It pinned the repository root, so when the workspace folder inside the repository had its own rule (as the status bar sets), the switch said "now runs on" and changed nothing (companion plugin 0.2.2).
- **The note on where the last session stopped goes only to a new conversation after a switch** (companion plugin 0.2.2). It used to reach every new conversation in the folder for three days, on the same account too, where the earlier one is a resume away.
- **The "chat on another account" warning goes away once that conversation is closed**, instead of staying until a new conversation starts.
- **First run:** when no account has the companion plugin, Billable offers to install it, since the status bar shows usage only once it runs. That prompt and the launcher prompt have `Don't ask again`.
- VS Code windows that start together no longer apply the sharing at the same time.

- **Share memory between accounts, or keep them apart.** New command `Billable: Share conversations, memory and settings with the default account`, and a sharing line in the hover. Per account: nothing (the default), conversations and memory, or everything but the sign-in. Shared items become links to the default account's copy; what the account had is merged in, and anything that clashes is kept in a backup folder. Sign-ins, plans and limits stay separate.
- **A switch no longer claims to work without the launcher.** When Claude Code tabs do not start through the Billable launcher, `Switch` used to say the folder "now runs on" the new account while new tabs kept running on the default one. It now says so and offers `Set up`, and the hover warns too.
- `Sign in with a code`: the sign-in prints the link and waits for the code instead of opening the default browser, which is usually signed in to another Claude account. New command `Billable: Remove account`.

## 0.6.2

- **`Add account` signs in the new account, not the folder's.** The sign-in used to run `claude auth login` in a shell, where a `claude()` wrapper (the one the README suggests for the terminal) set the folder's account and signed that one in again. It now runs Claude Code's own binary directly, so neither the shell profile nor your PATH can change where it lands.
- When the sign-in ends, Billable says which email the new account signed in as. If it is a different email than the one you entered, or the sign-in did not finish, it offers to sign in again.
- **The account line in the Claude chat follows a switch.** It used to be set once when the conversation started. When the folder is switched from the status bar, `/account` or another session, it now says within seconds where new conversations in the folder run, and accounts that sign in later show up in `/account` (companion plugin 0.2.1).
- **Two accounts on one sign-in are flagged.** When two accounts are signed in as the same Claude account (a sign-in typed in a terminal goes to the folder's account, and can replace another account's), the hover says so and a notification offers to sign either one in again. New command `Billable: Sign in to an account again`.
- **Multi-root workspaces.** The status bar took the account from the first folder but usage and the "chat on" warning from every folder, so it could name three accounts at once. Claude Code runs the window's conversations in the first folder, so all of it now comes from there.

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
