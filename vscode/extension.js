const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const lib = require('./lib')
const report = require('./report')
const { createLicense } = require('./pro')

const LIMIT_NAMES = { five_hour: '5-hour limit', seven_day: 'Weekly limit' }
const WARN_PERCENT = 90
const NAME_RULE = /^[a-z0-9][a-z0-9-]{0,30}$/
const EMAIL_RULE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/
const IDLE_CHECK_MS = 30 * 60_000
// Sessions quiet this long are pre-selected in "Stop idle sessions" when automatic stopping is off.
const DEFAULT_IDLE_HOURS = 6
const SESSIONS_CACHE_MS = 15_000

function folders() {
  return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
}

function link(label, command, args) {
  return `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`
}

function installBin(context, p) {
  fs.mkdirSync(p.bin, { recursive: true })
  const files = lib.launcherFiles()
  for (const name of files.names) {
    const target = path.join(p.bin, name)
    fs.copyFileSync(path.join(context.extensionPath, files.dir, name), target)
    fs.chmodSync(target, 0o755)
  }
}

function run(file, args, env) {
  return new Promise((resolve, reject) =>
    execFile(file, args, { env, timeout: 120_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || stdout || err.message).trim().split('\n').pop())) : resolve(),
    ),
  )
}

function claudePath() {
  return lib.claudeBinary(vscode.extensions.getExtension('anthropic.claude-code')?.extensionPath)
}

// Installs this extension's Claude Code plugin (the account above the prompt, /account) into one account.
async function installPlugin(p, dir) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir }
  if (lib.pathKey(dir) === lib.pathKey(path.join(p.home, '.claude'))) delete env.CLAUDE_CONFIG_DIR
  const bin = claudePath()
  const [addMarketplace, install] = lib.pluginInstallSteps(lib.pluginSource(lib.readAccounts(p)))
  // Fails when the marketplace is already there; the install below is what has to succeed.
  await run(bin, addMarketplace, env).catch(() => {})
  await run(bin, install, env)
}

function activate(context) {
  const p = lib.paths()
  try {
    installBin(context, p)
  } catch (err) {
    vscode.window.showWarningMessage(`Billable could not install its launcher: ${err.message}`)
  }
  lib.pruneSessions(p)
  // `license` is swapped by the integration tests, which must not reach the license server.
  let license = createLicense({ secrets: context.secrets })
  // Replaced by the integration tests, which must not run claude.
  const plugin = { install: dir => installPlugin(p, dir) }
  // Replaced by the integration tests, which sign in with a stand-in for claude in a real terminal.
  const login = { claude: claudePath }

  const item = vscode.window.createStatusBarItem('claudeMultiAccount', vscode.StatusBarAlignment.Left, 100)
  item.name = 'Billable'
  item.command = 'claudeMultiAccount.switch'
  context.subscriptions.push(item)

  function view() {
    return lib.folderView(p, folders())
  }

  function tooltip(v) {
    const md = new vscode.MarkdownString(undefined, true)
    md.isTrusted = {
      enabledCommands: [
        'claudeMultiAccount.switchTo',
        'claudeMultiAccount.addAccount',
        'claudeMultiAccount.signIn',
        'claudeMultiAccount.costReport',
        'claudeMultiAccount.stopIdleSessions',
        'claudeMultiAccount.share',
        'claudeMultiAccount.setupLauncher',
        'claude-vscode.newConversation',
      ],
    }
    md.appendMarkdown(`$(account) **${v.currentName}** &nbsp; ${v.email}\n\n`)

    const buttons = v.accounts
      .filter(a => a.name !== v.currentName)
      .map(a => {
        const signedOut = lib.emailOf(a.dir, p.home) === lib.NOT_SIGNED_IN
        return link(`$(arrow-swap) Switch to ${a.name}${signedOut ? ' (not signed in)' : ''}`, 'claudeMultiAccount.switchTo', [a.name])
      })
    buttons.push(link('$(add) Add account', 'claudeMultiAccount.addAccount', []))
    buttons.push(link('$(graph) Cost report', 'claudeMultiAccount.costReport', []))
    md.appendMarkdown(buttons.join(' &nbsp;&nbsp; ') + '\n\n')
    for (const s of lib.sharedSignIns(p, v.accounts)) md.appendMarkdown(`${sharedText(s)}\n\n`)
    const src = lib.shareSource(v.accounts)
    if (launcherMissing() && v.currentName !== src.name) {
      md.appendMarkdown(
        `$(warning) Claude Code tabs do not start through the Billable launcher, so they run on ${src.name}. ${link('Set up', 'claudeMultiAccount.setupLauncher', [])}\n\n`,
      )
    }
    if (v.accounts.length > 1 && v.currentName !== src.name) {
      const level = lib.shareLevel(p, v.currentName)
      const what = level === 'none' ? `Shares nothing with ${src.name}` : `Shares ${SHARE_LABELS[level].toLowerCase()} with ${src.name}`
      md.appendMarkdown(`$(sync) ${what} &nbsp; ${link('Change', 'claudeMultiAccount.share', [v.currentName])}\n\n`)
    }
    if (v.openOn) {
      md.appendMarkdown(
        `$(warning) The open conversation still runs on **${v.openOn}**. ${link('Start a new conversation', 'claude-vscode.newConversation', [])} to move it to **${v.currentName}**.\n\n`,
      )
    }

    md.appendMarkdown('---\n\n')
    const s = v.status
    if (!s) {
      md.appendMarkdown(`No session on ${v.currentName} in this folder yet. Start a conversation to see its usage.`)
    } else {
      const t = lib.sessionTokens(s.transcript)
      const rows = [
        t
          ? `**Tokens (latest session):** ${lib.short(t.input + t.output + t.cacheRead + t.cacheWrite)} &nbsp; input ${lib.short(t.input)} · output ${lib.short(t.output)} · cache read ${lib.short(t.cacheRead)} · cache write ${lib.short(t.cacheWrite)}`
          : '**Tokens:** transcript not found',
        `**Cost:** ${s.usage?.usd === undefined ? 'unknown' : `$${s.usage.usd.toFixed(2)}`}`,
        ...(s.usage?.limits ?? []).map(l => `**${LIMIT_NAMES[l.kind] ?? l.kind}:** ${l.percentUsed}%`),
      ]
      md.appendMarkdown(rows.join('  \n'))
    }
    const fleet = sessionsSummary()
    if (fleet && fleet.running > 0) {
      const stop = fleet.idle > 0 ? ` &nbsp; ${link('$(debug-stop) Stop idle sessions', 'claudeMultiAccount.stopIdleSessions', [])}` : ''
      md.appendMarkdown(
        `\n\n$(server-process) **Claude sessions:** ${fleet.running} running · ${fleet.idle} idle · ${lib.formatRam(fleet.rssKb)} RAM${stop}`,
      )
    }
    return md
  }

  // ---- Idle sessions ----
  // Process listing, signalling and waiting are swapped out by the integration tests, so they never touch a real process.
  const idle = {
    ps: lib.systemPs,
    kill: (pid, signal) => process.kill(pid, signal),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    copy: text => vscode.env.clipboard.writeText(text),
    sampleMs: lib.CPU_SAMPLE_MS,
  }
  let fleetCache = null

  // Running, idle and RAM of every session on the known accounts, cached briefly: the hover refreshes often.
  function sessionsSummary(fresh = false) {
    if (process.platform === 'win32') return null
    if (!fresh && fleetCache && Date.now() - fleetCache.at < SESSIONS_CACHE_MS) return fleetCache.summary
    try {
      const summary = lib.summarizeSessions(lib.surveySessions({ dirs: lib.claudeDirs(p), ps: idle.ps, transcripts: false }))
      fleetCache = { at: Date.now(), summary }
      return summary
    } catch {
      return null
    }
  }

  function autoStopHours() {
    const h = Number(vscode.workspace.getConfiguration('claudeMultiAccount').get('idleSessions.autoStopHours', 0)) || 0
    return h <= 0 ? 0 : Math.max(1, h)
  }

  // Shows the command that resumes each stopped session; picking one copies it, or all of them at once.
  async function showResumeCommands(stopped) {
    if (stopped.length === 0) return
    const all = stopped.map(s => lib.resumeCommand(s, p.home))
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(copy) Copy all resume commands', command: all.join('\n') },
        ...stopped.map((s, i) => ({ label: path.basename(s.cwd) || s.cwd, description: s.sessionId.slice(0, 8), detail: all[i], command: all[i] })),
      ],
      { title: 'Resume a stopped session', placeHolder: 'Pick one to copy its command, then run it in a terminal' },
    )
    if (!pick) return
    await idle.copy(pick.command)
    vscode.window.showInformationMessage('Copied. Run it in a terminal to pick the conversation up again.')
  }

  function withProgress(title, task) {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task)
  }

  function describe(list) {
    return list.map(s => `${path.basename(s.cwd) || s.cwd} (${lib.formatQuiet(s.quietMs)})`).join(', ')
  }

  async function stopIdleSessions() {
    if (process.platform === 'win32') {
      return vscode.window.showInformationMessage('Stopping idle sessions works on macOS and Linux for now.')
    }
    const dirs = lib.claudeDirs(p)
    const hours = autoStopHours() || DEFAULT_IDLE_HOURS
    const thresholdMs = hours * 3_600_000
    const list = lib.surveySessions({ dirs, ps: idle.ps }).filter(s => s.status === 'idle')
    if (list.length === 0) {
      return vscode.window.showInformationMessage('No idle Claude sessions are running.')
    }
    // CPU is sampled just before the stop, on the chosen sessions only.
    list.sort((a, b) => b.quietMs - a.quietMs)
    const items = list.map(s => ({
      label: path.basename(s.cwd) || s.cwd,
      description: `quiet ${lib.formatQuiet(s.quietMs)} · ${lib.formatRam(s.rssKb)}`,
      detail: s.cwd,
      picked: lib.quietPast(s, thresholdMs),
      session: s,
    }))
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: `Stop idle Claude sessions (quiet over ${hours} h are selected)`,
      placeHolder: 'The conversations stay on disk; you get a command to resume each one',
    })
    if (!chosen || chosen.length === 0) return
    const { stopped, skipped } = await withProgress('Stopping the chosen Claude sessions', () =>
      lib.stopSessions(chosen.map(c => c.session), { dirs, ps: idle.ps, kill: idle.kill, sleep: idle.sleep, sampleMs: idle.sampleMs }),
    )
    fleetCache = null
    refresh()
    if (skipped.length) {
      vscode.window.showWarningMessage(`Not stopped: ${skipped.map(s => `${path.basename(s.cwd) || s.cwd} (${s.reason})`).join(', ')}`)
    }
    if (stopped.length) await showResumeCommands(stopped)
  }

  // Stops sessions idle past the setting. One window does it per round: the others see the recent run and skip.
  async function autoStopIdle(force = false) {
    const hours = autoStopHours()
    if (!hours || process.platform === 'win32') return { stopped: [], skipped: [] }
    const lock = path.join(p.base, 'idle-stop.json')
    if (!force) {
      try {
        if (Date.now() - JSON.parse(fs.readFileSync(lock, 'utf8')).at < IDLE_CHECK_MS - 60_000) return { stopped: [], skipped: [] }
      } catch {}
    }
    try {
      fs.mkdirSync(p.base, { recursive: true })
      fs.writeFileSync(lock, JSON.stringify({ at: Date.now() }))
    } catch {}
    const dirs = lib.claudeDirs(p)
    const thresholdMs = hours * 3_600_000
    const candidates = lib
      .surveySessions({ dirs, ps: idle.ps })
      .filter(s => lib.quietPast(s, thresholdMs))
    if (candidates.length === 0) return { stopped: [], skipped: [] }
    const result = await lib.stopSessions(candidates, {
      dirs, ps: idle.ps, kill: idle.kill, sleep: idle.sleep, sampleMs: idle.sampleMs, thresholdMs,
    })
    fleetCache = null
    refresh()
    if (result.stopped.length) {
      const show = 'Resume commands'
      vscode.window
        .showInformationMessage(
          `Billable stopped ${result.stopped.length} session${result.stopped.length === 1 ? '' : 's'} idle over ${hours} h: ${describe(result.stopped)}.`,
          show,
        )
        .then(answer => answer === show && showResumeCommands(result.stopped))
    }
    return result
  }

  function refresh() {
    const v = view()
    if (!v) return item.hide()
    warnShared(v.accounts)
    const parts = [`$(account) ${v.currentName}`]
    let top = 0
    if (v.status) {
      const t = lib.sessionTokens(v.status.transcript)
      const limits = v.status.usage?.limits ?? []
      top = limits.reduce((m, l) => Math.max(m, l.percentUsed), 0)
      if (t) parts.push(`$(symbol-number) ${lib.short(t.input + t.output + t.cacheRead + t.cacheWrite)}`)
      if (v.status.usage?.usd !== undefined) parts.push(`$(credit-card) $${v.status.usage.usd.toFixed(2)}`)
      if (limits.length) parts.push(`$(dashboard) ${top}%`)
    }
    if (v.openOn) parts.push(`$(warning) chat on ${v.openOn}`)
    item.text = parts.join('   ')
    item.tooltip = tooltip(v)
    item.backgroundColor = top >= WARN_PERCENT ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
    item.show()
  }

  function sharedText(s) {
    const names = s.names.map(n => `**${n}**`).join(' and ')
    const again = s.names.map(n => link(`Sign in to ${n} again`, 'claudeMultiAccount.signIn', [n])).join(' &nbsp; ')
    return `$(warning) ${names} are signed in as the same Claude account, ${s.email}. ${again}`
  }

  // Once per VS Code window for each set of accounts sharing a sign-in.
  const warned = new Set()
  function warnShared(accounts) {
    for (const s of lib.sharedSignIns(p, accounts)) {
      const key = `${s.email.toLowerCase()} ${s.names.join(' ')}`
      if (warned.has(key)) continue
      warned.add(key)
      const buttons = s.names.map(n => `Sign in to ${n} again`)
      vscode.window
        .showWarningMessage(
          `${s.names.join(' and ')} are signed in as the same Claude account, ${s.email}, so they share one plan and its limits. Sign in again to the one that should use another account.`,
          ...buttons,
        )
        .then(pick => {
          const name = s.names[buttons.indexOf(pick)]
          if (name) signInAgain(name)
        })
    }
  }

  async function signInAgain(name) {
    const accounts = lib.readAccounts(p)
    const pick =
      name ??
      (await vscode.window.showQuickPick(
        accounts.map(a => a.name),
        { title: 'Sign in to which account?' },
      ))
    const account = accounts.find(a => a.name === pick)
    if (!account) return
    signIn(account.name, account.dir)
    vscode.window.showInformationMessage(SIGN_IN_HOW(account.name))
  }

  function launcherPath() {
    return path.join(p.bin, lib.launcherFiles().wrapper)
  }

  // Without the launcher, Claude Code tabs start on the default account whatever the folder is set to.
  function launcherMissing() {
    return (
      vscode.extensions.getExtension('anthropic.claude-code') !== undefined &&
      vscode.workspace.getConfiguration('claudeCode').get('claudeProcessWrapper') !== launcherPath()
    )
  }

  async function switchTo(name) {
    const folder = folders()[0]
    if (!folder) return
    // A conversation on an account with no sign-in asks to sign in through the default browser, which usually
    // authorizes another Claude account. So the sign-in comes first, with the link and the code.
    const target = lib.readAccounts(p).find(a => a.name === name)
    if (target && lib.emailOf(target.dir, p.home) === lib.NOT_SIGNED_IN) {
      const signInFirst = 'Sign in'
      const anyway = 'Switch anyway'
      const answer = await vscode.window.showWarningMessage(
        `${name} is not signed in. Sign in first: otherwise a new conversation on ${name} asks to sign in through your default browser, which is usually signed in to another Claude account.`,
        signInFirst,
        anyway,
      )
      if (!answer) return
      lib.pin(p, folder, name)
      refresh()
      if (answer === signInFirst) {
        signIn(name, target.dir, undefined, email => switched(folder, `${name} is signed in as ${email}.`))
        vscode.window.showInformationMessage(SIGN_IN_HOW(name))
        return
      }
    } else {
      lib.pin(p, folder, name)
      refresh()
    }
    await switched(folder)
  }

  // Says where the folder's new conversations run now, or why they do not run there yet.
  async function switched(folder, lead = '') {
    const next = lib.accountFor(folder, lib.readRules(p)) ?? 'the default account'
    const before = lead ? `${lead} ` : ''
    if (launcherMissing()) {
      const setUp = 'Set up'
      const answer = await vscode.window.showWarningMessage(
        `${before}${path.basename(folder)} is set to ${next}, but Claude Code tabs do not start through the Billable launcher yet, so they still run on the default account.`,
        setUp,
      )
      if (answer === setUp) await setupLauncher()
      return
    }
    await offerNewConversation(`${before}${path.basename(folder)} now runs on ${next}. A new conversation picks up where the last one stopped.`)
  }

  async function offerNewConversation(text) {
    const start = 'Start new conversation'
    const answer = await vscode.window.showInformationMessage(text, start)
    if (answer === start) await vscode.commands.executeCommand('claude-vscode.newConversation')
  }

  const SIGN_IN_HOW = name =>
    `Sign in to ${name}: open the link in the terminal in a browser signed in to that account (or a private window), then paste the code back into the terminal.`

  // Right after a new account signs in: it starts with nothing of the default account unless it shares.
  async function offerShare(name, email) {
    const src = source()
    const account = lib.readAccounts(p).find(a => a.name === name)
    if (!account || account === src || lib.shareLevel(p, name) !== 'none') {
      return vscode.window.showInformationMessage(`${name} is signed in as ${email}.`)
    }
    const memory = 'Share conversations and memory'
    const apart = 'Keep apart'
    const answer = await vscode.window.showInformationMessage(
      `${name} is signed in as ${email}. Share conversations and memory with ${src.name}, so Claude on ${name} knows what it learned there? Keep it apart for a client whose work should stay separate. You can change this later from the status bar.`,
      memory,
      apart,
    )
    if (answer === memory) setShare(account, src, 'memory')
  }

  async function addAccount() {
    const known = new Set(lib.readAccounts(p).map(a => a.name))
    const name = await vscode.window.showInputBox({
      title: 'Add a Claude account (1/2)',
      prompt: 'A short name, such as a client: lowercase letters, digits and dashes',
      validateInput: v => {
        if (!NAME_RULE.test(v)) return 'Use lowercase letters, digits and dashes'
        if (v === 'auto') return '"auto" is reserved: it means the folder follows its default account'
        if (known.has(v)) return `An account named ${v} already exists`
        return null
      },
    })
    if (!name) return
    const email = await vscode.window.showInputBox({
      title: 'Add a Claude account (2/2)',
      prompt: 'The email of that Claude account, to fill in the sign-in page (optional)',
      placeHolder: 'you@client.com',
      validateInput: v => (v === '' || EMAIL_RULE.test(v) ? null : 'Enter an email address, or leave it empty'),
    })
    if (email === undefined) return
    const dir = `~/.claude-${name}`
    try {
      lib.addAccount(p, name, dir)
    } catch (err) {
      return vscode.window.showErrorMessage(err.message)
    }
    // Before the sign-in, so the first session on the new account already shows the account above the prompt.
    await withProgress(`Adding the Billable plugin to ${name}`, () =>
      plugin.install(lib.expand(dir, p.home)).catch(err => {
        vscode.window.showWarningMessage(`Billable could not add its plugin to ${name}: ${err.message}`)
      }),
    )
    signIn(name, lib.expand(dir, p.home), email, signedIn => offerShare(name, signedIn))
    refresh()
    vscode.window.showInformationMessage(`${SIGN_IN_HOW(name)} Then switch a folder to ${name} from the status bar.`)
  }

  async function removeAccount() {
    // Never the default account, ~/.claude, or a folder another account uses: the folder goes to the trash.
    const accounts = lib.readAccounts(p).filter(a => !lib.removeBlocker(p, a.name))
    if (!accounts.length) return vscode.window.showInformationMessage('There are no accounts to remove besides the default one.')
    const pick = await vscode.window.showQuickPick(
      accounts.map(a => ({ label: a.name, description: `${lib.emailOf(a.dir, p.home)}  ${a.dir}`, account: a })),
      { title: 'Remove which account?' },
    )
    if (!pick) return
    const { name, dir } = pick.account
    const remove = 'Remove'
    const answer = await vscode.window.showWarningMessage(
      `Remove ${name}? It is signed out, folders that run on it go back to the default account, and ${dir} moves to the trash.`,
      { modal: true },
      remove,
    )
    if (answer !== remove) return
    if (lib.emailOf(dir, p.home) !== lib.NOT_SIGNED_IN) {
      // Signs out with the account's own config dir, so its keychain entry goes too.
      await new Promise(resolve =>
        execFile(login.claude(), ['auth', 'logout'], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir } }, () => resolve()),
      )
    }
    try {
      lib.removeAccount(p, name)
    } catch (err) {
      return vscode.window.showErrorMessage(`Could not remove ${name}: ${err.message}`)
    }
    refresh()
    try {
      // A shared item in the folder is a link; the trash takes the link, never what it points to.
      await vscode.workspace.fs.delete(vscode.Uri.file(dir), { recursive: true, useTrash: true })
    } catch (err) {
      return vscode.window.showWarningMessage(`${name} was removed, but ${dir} could not be moved to the trash: ${err.message}`)
    }
    vscode.window.showInformationMessage(`${name} was removed.`)
  }

  // Runs claude itself, not a shell: a claude() wrapper in the shell profile (the one the README suggests)
  // would replace CLAUDE_CONFIG_DIR with the folder's account and sign that account in again.
  // `then` gets the email once the sign-in succeeds; without it, Billable says which email signed in.
  function signIn(name, dir, email, then) {
    const terminal = vscode.window.createTerminal({
      name: `Claude login: ${name}`,
      shellPath: login.claude(),
      shellArgs: email ? ['auth', 'login', '--email', email] : ['auth', 'login'],
      env: {
        // ~/.claude is the account with no CLAUDE_CONFIG_DIR: naming it would make claude look for another sign-in.
        CLAUDE_CONFIG_DIR: lib.pathKey(dir) === lib.pathKey(path.join(p.home, '.claude')) ? null : dir,
        // No browser: the default one is usually signed in to another Claude account and authorizes that one.
        // claude then prints the sign-in link and waits for the code, so the user picks the browser.
        ...lib.noBrowserEnv(),
      },
    })
    const closed = vscode.window.onDidCloseTerminal(async t => {
      if (t !== terminal) return
      closed.dispose()
      refresh()
      const signedIn = lib.emailOf(dir, p.home)
      const wrong = email && signedIn !== lib.NOT_SIGNED_IN && signedIn.toLowerCase() !== email.toLowerCase()
      if (signedIn !== lib.NOT_SIGNED_IN && !wrong) {
        return then ? then(signedIn) : vscode.window.showInformationMessage(`${name} is signed in as ${signedIn}.`)
      }
      const again = 'Sign in again'
      const answer = await vscode.window.showWarningMessage(
        wrong
          ? `${name} signed in as ${signedIn}, not ${email}. Open the link in a private window, or one signed in as ${email}, and sign in again.`
          : `${name} is not signed in yet.`,
        again,
      )
      if (answer === again) signIn(name, dir, email, then)
    })
    context.subscriptions.push(closed)
    terminal.show()
  }

  async function setupLauncher() {
    if (!vscode.extensions.getExtension('anthropic.claude-code')) {
      return vscode.window.showWarningMessage(
        'Install the Claude Code extension first. In a terminal, run claude through the cma launcher in ~/.claude-multi-account/bin.',
      )
    }
    const config = vscode.workspace.getConfiguration('claudeCode')
    const launcher = launcherPath()
    const existing = config.get('claudeProcessWrapper')
    if (existing && existing !== launcher) {
      const replace = 'Replace it'
      const answer = await vscode.window.showWarningMessage(
        `Claude Code already launches through ${existing}. Replace it with the Billable launcher?`,
        { modal: true },
        replace,
      )
      if (answer !== replace) return
    }
    await config.update('claudeProcessWrapper', launcher, vscode.ConfigurationTarget.Global)
    vscode.window.showInformationMessage('Claude Code tabs now start on the account each folder is set to.')
  }

  function source() {
    return lib.shareSource(lib.readAccounts(p))
  }

  const SHARE_LABELS = {
    none: 'Nothing',
    memory: 'Conversations and memory',
    all: 'Everything but the sign-in',
  }

  function shareSummary(r, srcName) {
    const parts = []
    if (r.backup) parts.push(`What ${r.name} had and ${srcName} already has is in ${r.backup}.`)
    if (r.errors.length) parts.push(`Not shared: ${r.errors.join('; ')}.`)
    return parts.join(' ')
  }

  async function share(name) {
    const accounts = lib.readAccounts(p)
    const src = lib.shareSource(accounts)
    const others = accounts.filter(a => a.name !== src.name)
    if (!others.length) return vscode.window.showInformationMessage('Add another account first: it can then share with the default one.')
    const current = view()?.currentName
    const pickName =
      name ??
      (others.length === 1
        ? others[0].name
        : (
            await vscode.window.showQuickPick(
              others
                .sort((a, b) => (b.name === current) - (a.name === current))
                .map(a => ({ label: a.name, description: SHARE_LABELS[lib.shareLevel(p, a.name)], name: a.name })),
              { title: `Which account shares with ${src.name}?` },
            )
          )?.name)
    const account = others.find(a => a.name === pickName)
    if (!account) return
    const level = lib.shareLevel(p, account.name)
    const pick = await vscode.window.showQuickPick(
      [
        { label: SHARE_LABELS.none, description: 'Its own conversations, memory and settings. Best for a client you keep apart', level: 'none' },
        { label: SHARE_LABELS.memory, description: `The conversations, memory, prompt history and CLAUDE.md of ${src.name}`, level: 'memory' },
        { label: SHARE_LABELS.all, description: 'Also settings, plugins, commands, agents and skills', level: 'all' },
      ].map(i => (i.level === level ? { ...i, label: `$(check) ${i.label}` } : i)),
      {
        title: `What does ${account.name} share with ${src.name}?`,
        placeHolder: 'Each account keeps its own sign-in, plan and limits. What it shares goes into the context of its conversations',
      },
    )
    if (!pick || pick.level === level) return
    setShare(account, src, pick.level)
  }

  function setShare(account, src, level) {
    const applied = lib.withLock(lib.shareLock(p), () => lib.applyShare(account.dir, src.dir, level))
    if (!applied) {
      return vscode.window.showWarningMessage('Another VS Code window is updating what accounts share. Try again in a moment.')
    }
    const r = { name: account.name, ...applied }
    lib.writeShare(p, account.name, level)
    refresh()
    const what =
      level === 'none'
        ? `${account.name} no longer shares with ${src.name}. It keeps a copy of the settings; the conversations stay with ${src.name}.`
        : `${account.name} now shares ${SHARE_LABELS[level].toLowerCase()} with ${src.name}. New conversations on ${account.name} see it; open ones pick it up once restarted.`
    const show = r.errors.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage
    return show(`${what} ${shareSummary(r, src.name)}`.trim())
  }

  async function askForPro(feature) {
    const buy = 'Get Pro'
    const enter = 'Enter license key'
    const answer = await vscode.window.showInformationMessage(
      `${feature} is part of Billable Pro.`,
      ...(license.checkoutUrl ? [buy] : []),
      enter,
    )
    if (answer === buy) await vscode.env.openExternal(vscode.Uri.parse(license.checkoutUrl))
    // Once the key is in, the report the user asked for opens without asking again.
    if (answer === enter) return enterLicense()
    return false
  }

  async function enterLicense() {
    if (license.isLaunch) {
      vscode.window.showInformationMessage('Every Pro feature is free during the launch. No key is needed.')
      return true
    }
    if (await license.isPro()) {
      const again = 'Enter another key'
      const answer = await vscode.window.showInformationMessage('Pro is already active on this machine.', again)
      if (answer !== again) return true
    }
    const key = await vscode.window.showInputBox({
      title: 'Billable Pro',
      prompt: 'Your license key, from the receipt email',
      placeHolder: 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX',
      ignoreFocusOut: true,
    })
    if (!key?.trim()) return false
    try {
      const r = await license.activate(key, `${os.hostname()} (VS Code)`)
      if (r.ok) {
        vscode.window.showInformationMessage('Pro is active on this machine. Thank you.')
        return true
      }
      vscode.window.showErrorMessage(`License not activated: ${r.error}`)
    } catch (err) {
      vscode.window.showErrorMessage(`Could not reach the license server: ${err.message}`)
    }
    return false
  }

  async function costReport(month) {
    const entries = report.readLedger(p.ledger)
    const free = report.freeMonths()
    const pro = await license.isPro()
    const pick =
      month !== undefined
        ? { month }
        : await vscode.window.showQuickPick(
            report.months(entries).map(m => ({
              label: m,
              description: pro || free.includes(m) ? undefined : '$(lock) Pro',
              month: m,
            })),
            { title: 'Claude cost by account', placeHolder: 'Pick a month' },
          )
    if (!pick) return
    if (!pro && !free.includes(pick.month)) {
      if (await askForPro('The full history')) return costReport(pick.month)
      return
    }

    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: report.toMarkdown(report.summarize(entries, pick.month), pick.month, os.homedir()),
    })
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri)

    const exportCsv = 'Export CSV'
    const answer = await vscode.window.showInformationMessage(`Claude cost by account for ${pick.month}.`, exportCsv)
    if (answer !== exportCsv) return
    if (!(await license.isPro()) && !(await askForPro('CSV export for invoices'))) return
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `claude-cost-${pick.month}.csv`)),
      filters: { CSV: ['csv'] },
    })
    if (!target) return
    fs.writeFileSync(target.fsPath, report.toCsv(entries, pick.month))
    vscode.window.showInformationMessage(`Saved ${target.fsPath}`)
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeMultiAccount.costReport', costReport),
    vscode.commands.registerCommand('claudeMultiAccount.enterLicense', enterLicense),
    vscode.commands.registerCommand('claudeMultiAccount.refresh', refresh),
    vscode.commands.registerCommand('claudeMultiAccount.switchTo', switchTo),
    vscode.commands.registerCommand('claudeMultiAccount.addAccount', addAccount),
    vscode.commands.registerCommand('claudeMultiAccount.signIn', signInAgain),
    vscode.commands.registerCommand('claudeMultiAccount.removeAccount', removeAccount),
    vscode.commands.registerCommand('claudeMultiAccount.setupLauncher', setupLauncher),
    vscode.commands.registerCommand('claudeMultiAccount.stopIdleSessions', stopIdleSessions),
    vscode.commands.registerCommand('claudeMultiAccount.share', share),
    vscode.commands.registerCommand('claudeMultiAccount.switch', async () => {
      const v = view()
      if (!v) return
      // Offered only when the folder has a rule of its own; it then names the account the folder falls back to.
      const inherited = lib.inheritedAccount(v.folder, lib.readRules(p))
      const inherit = inherited === undefined ? null : (inherited ?? v.accounts[0].name)
      const picks = [
        ...v.accounts
          .filter(a => a.name !== v.currentName)
          .map(a => ({ label: `$(account) ${a.name}`, description: lib.emailOf(a.dir, p.home), name: a.name })),
        ...(inherit ? [{ label: '$(discard) Use default', description: `Drop this folder's own rule: it runs on ${inherit}`, name: 'auto' }] : []),
        { label: '$(add) Add account', description: 'Sign in to another Claude account', name: '+add' },
        ...(v.accounts.length > 1 ? [{ label: '$(trash) Remove account', description: 'Sign out an account and drop it', name: '+remove' }] : []),
      ]
      const pick = await vscode.window.showQuickPick(picks, {
        title: `${path.basename(v.folder)} runs on ${v.currentName}`,
        placeHolder: 'Switch this folder to',
      })
      if (!pick) return
      if (pick.name === '+add') return addAccount()
      if (pick.name === '+remove') return removeAccount()
      await switchTo(pick.name)
    }),
  )

  const hasClaudeCode = vscode.extensions.getExtension('anthropic.claude-code') !== undefined
  const NEVER = "Don't ask again"
  if (
    hasClaudeCode &&
    !vscode.workspace.getConfiguration('claudeCode').get('claudeProcessWrapper') &&
    !context.globalState.get('launcherPrompt.off')
  ) {
    const setUp = 'Set up'
    vscode.window
      .showInformationMessage('Billable: start Claude Code tabs on the account each folder is set to?', setUp, NEVER)
      .then(answer => {
        if (answer === setUp) return setupLauncher()
        if (answer === NEVER) return context.globalState.update('launcherPrompt.off', true)
      })
  }

  // A first install of the companion plugin, which shows the account and cost in the chat and reports usage to the
  // status bar. Asked for once, not done: it changes the person's Claude Code setup.
  const offer = hasClaudeCode && !context.globalState.get('pluginPrompt.off') ? lib.accountsToOfferPlugin(lib.readAccounts(p)) : []
  if (offer.length) {
    const install = 'Install'
    vscode.window
      .showInformationMessage(
        'Billable: install its Claude Code plugin? It shows the account, cost and limits in each Claude chat, and the status bar shows usage only once it runs.',
        install,
        NEVER,
      )
      .then(async answer => {
        if (answer === NEVER) return context.globalState.update('pluginPrompt.off', true)
        if (answer !== install) return
        const failed = []
        await withProgress('Installing the Billable plugin', async () => {
          for (const a of offer) await plugin.install(a.dir).catch(err => failed.push(`${a.name} (${err.message})`))
        })
        if (failed.length) vscode.window.showWarningMessage(`Billable could not add its plugin to ${failed.join(', ')}.`)
        else vscode.window.showInformationMessage('Billable plugin installed. New Claude conversations show the account above the prompt.')
      })
  }

  try {
    fs.mkdirSync(p.sessions, { recursive: true })
    for (const dir of [p.sessions, p.base]) {
      const watcher = fs.watch(dir, () => refresh())
      context.subscriptions.push({ dispose: () => watcher.close() })
    }
  } catch {}
  const timer = setInterval(refresh, 30_000)
  context.subscriptions.push({ dispose: () => clearInterval(timer) })
  const idleTimer = setInterval(() => autoStopIdle().catch(() => {}), IDLE_CHECK_MS)
  context.subscriptions.push({ dispose: () => clearInterval(idleTimer) })
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(refresh))
  refresh()

  // Shared items Claude Code replaced with a file of its own, or that the default account has gained, are linked again.
  try {
    const src = source()
    for (const r of lib.applyShares(p)) {
      const summary = shareSummary(r, src.name)
      if (summary) vscode.window.showWarningMessage(`Billable, sharing ${r.name} with ${src.name}: ${summary}`)
    }
  } catch (err) {
    vscode.window.showWarningMessage(`Billable could not check what accounts share: ${err.message}`)
  }

  // Accounts added before the plugin was installed with them, or by hand, get it now, one after another.
  const healed = (async () => {
    for (const a of lib.accountsMissingPlugin(lib.readAccounts(p))) {
      try {
        await plugin.install(a.dir)
        vscode.window.showInformationMessage(
          `Billable added its plugin to ${a.name}. New Claude sessions on ${a.name} show the account above the prompt.`,
        )
      } catch (err) {
        vscode.window.showWarningMessage(`Billable could not add its plugin to ${a.name}: ${err.message}`)
      }
    }
  })()

  // Read by the integration tests: what the status bar shows right now.
  return {
    statusBar: () => {
      fleetCache = null
      refresh()
      return { text: item.text, tooltip: item.tooltip?.value ?? '', visible: item.text !== '' }
    },
    // Tests only: replace process listing, signalling and waiting with fakes.
    setIdleDeps: deps => Object.assign(idle, deps),
    autoStopIdleNow: () => autoStopIdle(true),
    pluginHealed: () => healed,
    setPluginInstaller: install => (plugin.install = install),
    setClaude: file => (login.claude = file ? () => file : claudePath),
    setLicense: l => (license = l),
  }
}

function deactivate() {}

module.exports = { activate, deactivate }
