const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const os = require('os')
const lib = require('./lib')
const report = require('./report')
const { createLicense } = require('./pro')

const LIMIT_NAMES = { five_hour: '5-hour limit', seven_day: 'Weekly limit' }
const WARN_PERCENT = 90
const NAME_RULE = /^[a-z0-9][a-z0-9-]{0,30}$/
const EMAIL_RULE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/

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

function activate(context) {
  const p = lib.paths()
  try {
    installBin(context, p)
  } catch (err) {
    vscode.window.showWarningMessage(`Claude Multi-Account could not install its launcher: ${err.message}`)
  }
  lib.pruneSessions(p)
  const license = createLicense({ secrets: context.secrets })

  const item = vscode.window.createStatusBarItem('claudeMultiAccount', vscode.StatusBarAlignment.Left, 100)
  item.name = 'Claude Multi-Account'
  item.command = 'claudeMultiAccount.switch'
  context.subscriptions.push(item)

  // The status bar shows the account the folder is set to, so a switch shows at once. Usage comes from the
  // latest session on that account; a conversation still open on another account is flagged.
  function view() {
    const roots = folders()
    if (roots.length === 0) return null
    const folder = roots[0]
    const accounts = lib.readAccounts(p)
    const latest = lib.latestStatus(p, roots)
    const ruled = lib.accountFor(folder, lib.readRules(p))
    const currentName = ruled ?? latest?.account.name ?? accounts[0].name
    const current = accounts.find(a => a.name === currentName)
    const status = lib.latestStatus(p, roots, currentName)
    const email = status?.account.email ?? (current ? lib.emailOf(current.dir, p.home) : lib.NOT_SIGNED_IN)
    const openOn = latest && latest.account.name !== currentName ? latest.account.name : null
    return { folder, accounts, status, openOn, currentName, email }
  }

  function tooltip(v) {
    const md = new vscode.MarkdownString(undefined, true)
    md.isTrusted = {
      enabledCommands: [
        'claudeMultiAccount.switchTo',
        'claudeMultiAccount.addAccount',
        'claudeMultiAccount.costReport',
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
      return md
    }
    const t = lib.sessionTokens(s.transcript)
    const rows = [
      t
        ? `**Tokens (latest session):** ${lib.short(t.input + t.output + t.cacheRead + t.cacheWrite)} &nbsp; input ${lib.short(t.input)} · output ${lib.short(t.output)} · cache read ${lib.short(t.cacheRead)} · cache write ${lib.short(t.cacheWrite)}`
        : '**Tokens:** transcript not found',
      `**Cost:** ${s.usage?.usd === undefined ? 'unknown' : `$${s.usage.usd.toFixed(2)}`}`,
      ...(s.usage?.limits ?? []).map(l => `**${LIMIT_NAMES[l.kind] ?? l.kind}:** ${l.percentUsed}%`),
    ]
    md.appendMarkdown(rows.join('  \n'))
    return md
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
    const terminal = vscode.window.createTerminal({
      name: `Claude login: ${name}`,
      env: { CLAUDE_CONFIG_DIR: lib.expand(dir, p.home) },
    })
    terminal.show()
    terminal.sendText(email ? `claude auth login --email ${email}` : 'claude auth login')
    refresh()
    vscode.window.showInformationMessage(
      `Sign in to ${name} in the browser that opens. If the browser is signed in to another Claude account, sign out there first. Then switch a folder to ${name} from the status bar.`,
    )
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
        `Claude Code already launches through ${existing}. Replace it with the Claude Multi-Account launcher?`,
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
      `${feature} is part of Claude Multi-Account Pro.`,
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
    const key = await vscode.window.showInputBox({ title: 'Claude Multi-Account Pro', prompt: 'Your license key', ignoreFocusOut: true })
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
      .showInformationMessage('Claude Multi-Account: start Claude Code tabs on the account each folder is set to?', setUp)
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
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(refresh))
  refresh()

  // Read by the integration tests: what the status bar shows right now.
  return {
    statusBar: () => {
      refresh()
      return { text: item.text, tooltip: item.tooltip?.value ?? '', visible: item.text !== '' }
    },
  }
}

function deactivate() {}

module.exports = { activate, deactivate }
