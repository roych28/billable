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
  const license = createLicense({ secrets: context.secrets })
  // Replaced by the integration tests, which must not run claude.
  const plugin = { install: dir => installPlugin(p, dir) }

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
        'claudeMultiAccount.costReport',
        'claudeMultiAccount.stopIdleSessions',
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

  async function switchTo(name) {
    const folder = folders()[0]
    if (!folder) return
    lib.pin(p, folder, name)
    refresh()
    const next = lib.accountFor(folder, lib.readRules(p)) ?? 'the default account'
    const start = 'Start new conversation'
    const answer = await vscode.window.showInformationMessage(
      `${path.basename(folder)} now runs on ${next}. A new conversation picks up where the last one stopped.`,
      start,
    )
    if (answer === start) await vscode.commands.executeCommand('claude-vscode.newConversation')
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
    signIn(name, lib.expand(dir, p.home), email)
    refresh()
    vscode.window.showInformationMessage(
      `Sign in to ${name} in the browser that opens. If the browser is signed in to another Claude account, sign out there first. Then switch a folder to ${name} from the status bar.`,
    )
  }

  // Runs claude itself, not a shell: a claude() wrapper in the shell profile (the one the README suggests)
  // would replace CLAUDE_CONFIG_DIR with the folder's account and sign that account in again.
  function signIn(name, dir, email) {
    const terminal = vscode.window.createTerminal({
      name: `Claude login: ${name}`,
      shellPath: claudePath(),
      shellArgs: email ? ['auth', 'login', '--email', email] : ['auth', 'login'],
      env: { CLAUDE_CONFIG_DIR: dir },
    })
    const closed = vscode.window.onDidCloseTerminal(async t => {
      if (t !== terminal) return
      closed.dispose()
      refresh()
      const signedIn = lib.emailOf(dir, p.home)
      const wrong = email && signedIn !== lib.NOT_SIGNED_IN && signedIn.toLowerCase() !== email.toLowerCase()
      if (signedIn !== lib.NOT_SIGNED_IN && !wrong) {
        return vscode.window.showInformationMessage(`${name} is signed in as ${signedIn}.`)
      }
      const again = 'Sign in again'
      const answer = await vscode.window.showWarningMessage(
        wrong
          ? `${name} signed in as ${signedIn}, not ${email}. Sign out of Claude in the browser, then sign in again.`
          : `${name} is not signed in yet.`,
        again,
      )
      if (answer === again) signIn(name, dir, email)
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
    const launcher = path.join(p.bin, lib.launcherFiles().wrapper)
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

  async function askForPro(feature) {
    const buy = 'Get Pro'
    const enter = 'Enter license key'
    const answer = await vscode.window.showInformationMessage(
      `${feature} is part of Billable Pro.`,
      ...(license.checkoutUrl ? [buy] : []),
      enter,
    )
    if (answer === buy) await vscode.env.openExternal(vscode.Uri.parse(license.checkoutUrl))
    if (answer === enter) await enterLicense()
  }

  async function enterLicense() {
    if (license.isLaunch) {
      return vscode.window.showInformationMessage('Every Pro feature is free during the launch. No key is needed.')
    }
    const key = await vscode.window.showInputBox({ title: 'Billable Pro', prompt: 'Your license key', ignoreFocusOut: true })
    if (!key) return
    try {
      const r = await license.activate(key, `${os.hostname()} (VS Code)`)
      if (r.ok) vscode.window.showInformationMessage('Pro is active on this machine. Thank you.')
      else vscode.window.showErrorMessage(`License not activated: ${r.error}`)
    } catch (err) {
      vscode.window.showErrorMessage(`Could not reach the license server: ${err.message}`)
    }
  }

  async function costReport() {
    const entries = report.readLedger(p.ledger)
    const free = report.freeMonths()
    const pro = await license.isPro()
    const pick = await vscode.window.showQuickPick(
      report.months(entries).map(m => ({
        label: m,
        description: pro || free.includes(m) ? undefined : '$(lock) Pro',
        month: m,
      })),
      { title: 'Claude cost by account', placeHolder: 'Pick a month' },
    )
    if (!pick) return
    if (!pro && !free.includes(pick.month)) return askForPro('The full history')

    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: report.toMarkdown(report.summarize(entries, pick.month), pick.month, os.homedir()),
    })
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri)

    const exportCsv = 'Export CSV'
    const answer = await vscode.window.showInformationMessage(`Claude cost by account for ${pick.month}.`, exportCsv)
    if (answer !== exportCsv) return
    if (!(await license.isPro())) return askForPro('CSV export for invoices')
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
    vscode.commands.registerCommand('claudeMultiAccount.setupLauncher', setupLauncher),
    vscode.commands.registerCommand('claudeMultiAccount.stopIdleSessions', stopIdleSessions),
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
      ]
      const pick = await vscode.window.showQuickPick(picks, {
        title: `${path.basename(v.folder)} runs on ${v.currentName}`,
        placeHolder: 'Switch this folder to',
      })
      if (!pick) return
      if (pick.name === '+add') return addAccount()
      await switchTo(pick.name)
    }),
  )

  const hasClaudeCode = vscode.extensions.getExtension('anthropic.claude-code') !== undefined
  if (hasClaudeCode && !vscode.workspace.getConfiguration('claudeCode').get('claudeProcessWrapper')) {
    const setUp = 'Set up'
    vscode.window
      .showInformationMessage('Billable: start Claude Code tabs on the account each folder is set to?', setUp)
      .then(answer => answer === setUp && setupLauncher())
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
  }
}

function deactivate() {}

module.exports = { activate, deactivate }
