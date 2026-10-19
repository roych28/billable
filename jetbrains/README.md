# Billable for JetBrains IDEs

Run every project on the right Claude account, and always know which one you are on. A port of the
[Billable](https://github.com/roych28/claude-multi-account) VS Code extension (formerly Claude Multi-Account) to IntelliJ IDEA, PyCharm,
WebStorm, GoLand and the other IntelliJ-based IDEs, 2025.2 and later.

Freelancers and consultants often hold a Claude account per client, plus a personal one. Claude Code signs in once
per config directory, so it is easy to spend a client's quota on your own project, or lose track of what a session
costs. This plugin puts the account, the usage and the switch in the IDE's status bar.

## Features

- **The account in the status bar.** The account this project folder runs on, the latest session's tokens and cost,
  and the highest rate-limit usage. The item turns amber at 90% of a limit, and says so when a conversation is still
  open on another account.
- **Switch in one click.** Click the item: the account and its email come first, then `Switch to <account>` for every
  other account, and `Use default` when the folder has a rule of its own. The choice is written to the same
  `folders` file the VS Code extension and the `cma` launcher read, so each project keeps its own account.
- **Cost report by account.** What each account, and each folder under it, cost in a month, with CSV export for
  invoices and a Markdown copy. The figures are computed exactly as in the VS Code extension.
- **The terminal follows.** Claude Code in a JetBrains IDE runs `claude` in the terminal. `Copy terminal shell
  function` copies the one line that makes `claude` start on the folder's account:
  ```sh
  claude() { ~/.claude-multi-account/bin/cma exec claude "$@"; }
  ```
  Add it to `~/.zshrc` or `~/.bashrc` and open a new terminal tab. The plugin installs the `cma` launcher in
  `~/.claude-multi-account/bin` on startup when it is not there yet (the VS Code extension installs the same file).

Everything is also under **Tools > Billable**.

## Getting started

1. Install the companion Claude Code plugin, which reports each session's account, cost and limits and records the
   cost ledger:
   ```
   claude plugin install multi-account --marketplace roych28/claude-multi-account
   ```
2. Install this plugin (for now from disk: **Settings > Plugins > gear > Install Plugin from Disk**, and pick
   `build/distributions/billable-jetbrains-<version>.zip`).
3. Add the shell function above to your shell profile.
4. Accounts are added as in the VS Code extension or by hand: one line per account in
   `~/.claude-multi-account/accounts` (`name<TAB>config dir`), then sign in once with
   `CLAUDE_CONFIG_DIR=~/.claude-<name> claude auth login`.

## How it works

Every Claude account lives in its own config directory, which Claude Code reads from `CLAUDE_CONFIG_DIR`. Two
plain-text files in `~/.claude-multi-account` hold the setup:

- `accounts`: one account per line, `name<TAB>config dir`
- `folders`: one rule per line, `folder<TAB>account`. The longest matching folder wins, and a `*` line is the default.

`CLAUDE_MULTI_ACCOUNT_HOME` replaces `~/.claude-multi-account`, as in the VS Code extension and the launcher. The IDE
sees it only when it was started from an environment that has it (for example from a terminal on macOS).

The plugin reads `sessions/*.json` (written by the Claude Code plugin for each session), the session transcript for
token counts, and `ledger/*.json` for the cost report. It writes only `folders`, and the launcher in `bin` when it
is missing. The cost is Claude Code's own figure at API prices; on a Pro or Max plan it measures the work done, not
what the plan charged.

## Building

Needs only a JDK 17 or later to start Gradle; the build fetches JDK 21 and IntelliJ IDEA 2025.2.6.3 itself.

```sh
./gradlew test buildPlugin
```

The plugin zip lands in `build/distributions/`. `./gradlew runIde` starts a sandbox IDE with the plugin.

The unit tests (`src/test/kotlin`) port the VS Code extension's fixtures: folder to account resolution, the
`CLAUDE_MULTI_ACCOUNT_HOME` override, pinning, the `cma` launcher agreeing with the plugin, session status and token
parsing, the cost report, the CSV and the license-stamp check. `PluginLoadTest` loads the plugin in a headless IDE and
checks the actions, the status bar widget, the free build and a switch round trip. All of them work in temp dirs:
the Gradle test task points the plugin at `build/cma-test-home`, never at the real home folder.

`./gradlew verifyPlugin` runs JetBrains' Plugin Verifier against IntelliJ IDEA 2025.2.6.3 (the IDE the plugin is
compiled with). Add newer IDEs in `pluginVerification` before a release.

## Paid listing (off)

The plugin is free. A paid or freemium listing on JetBrains Marketplace is prepared but switched off:

- `gradle.properties` has `cmaPaid = false`. With `cmaPaid = true` the build adds
  `<product-descriptor code="..." release-date="..." release-version="..." optional="true"/>` to `plugin.xml`.
  `optional="true"` makes it freemium: the plugin works without a license, and only Pro features ask for one.
- Pro features, as in the VS Code extension: the cost report beyond this month and the previous one, and CSV export.
  `ide/Licensing.kt` asks `com.intellij.ui.LicensingFacade` for the confirmation stamp of our product code and
  verifies it with `core/LicenseStamp.kt`, a Kotlin port of JetBrains' official
  [CheckLicense.java](https://github.com/JetBrains/marketplace-makemecoffee-plugin/blob/master/src/main/java/com/company/license/CheckLicense.java).
  Without a product descriptor every feature is open.
- The product code is not issued by JetBrains any more: the vendor picks it when setting up the paid listing. It must
  be `P` followed by 3 to 14 capital letters, no digits, and it cannot be changed once used
  ([add-required-parameters](https://plugins.jetbrains.com/docs/marketplace/add-required-parameters.html)).
  `PCLAUDEMULTI` in `gradle.properties` is a placeholder until the listing is set up.
- A paid plugin's version must start with its `release-version`: version `2026.1.0` goes with `release-version`
  `20261` ([versioning-of-paid-plugins](https://plugins.jetbrains.com/docs/marketplace/versioning-of-paid-plugins.html)).
  The build refuses `cmaPaid = true` when the code or version breaks these rules.

To turn it on: set the real code, a release date (`YYYYMMDD`) and release version, a matching `pluginVersion`, and
`cmaPaid = true`, then build. See `README-SELLING.md` for the marketplace side.

## Not in this version

- `Add account` and the Claude Code tab launcher of the VS Code extension. The JetBrains Claude Code integration runs
  `claude` in the terminal, so the shell function covers it.
- The Windows launcher (`cma.exe`) is not bundled. On Windows the copied PowerShell function expects it in
  `~/.claude-multi-account/bin`, where the VS Code extension installs it.

## Privacy

Everything stays on your machine. The plugin makes no network calls; with a paid build, license checks go through
the IDE's own licensing.

## License

MIT. Not affiliated with Anthropic or JetBrains. Made by [Roy Chemo](https://github.com/roych28).
