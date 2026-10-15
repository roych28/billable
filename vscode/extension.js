const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const lib = require('./lib')

const LIMIT_NAMES = { five_hour: '5-hour limit', seven_day: 'Weekly limit' }
const WARN_PERCENT = 90
const NAME_RULE = /^[a-z0-9][a-z0-9-]{0,30}$/

function folders() {
  return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
}

function link(label, command, args) {
  return `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`
}

function installBin(context, p) {
  fs.mkdirSync(p.bin, { recursive: true })
  for (const name of ['cma', 'claude-launcher']) {
    const target = path.join(p.bin, name)
    fs.copyFileSync(path.join(context.extensionPath, 'bin', name), target)
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

  const item = vscode.window.createStatusBarItem('claudeMultiAccount', vscode.StatusBarAlignment.Left, 100)
  item.name = 'Claude Multi-Account'
  item.command = 'claudeMultiAccount.switch'
  context.subscriptions.push(item)

  function view() {
    const roots = folders()
    if (roots.length === 0) return null
    const folder = roots[0]
    const accounts = lib.readAccounts(p)
    const status = lib.latestStatus(p, roots)
    const next = lib.accountFor(folder, lib.readRules(p))
    const currentName = status?.account.name ?? next ?? accounts[0].name
    const current = accounts.find(a => a.name === currentName)
    const email = status?.account.email ?? (current ? lib.emailOf(current.dir, p.home) : lib.NOT_SIGNED_IN)
    return { folder, accounts, status, next, currentName, email }
  }

  function tooltip(v) {
    const md = new vscode.MarkdownString(undefined, true)
    md.isTrusted = { enabledCommands: ['claudeMultiAccount.switchTo', 'claudeMultiAccount.addAccount'] }
    md.appendMarkdown(`$(account) **${v.currentName}** &nbsp; ${v.email}\n\n`)

    const buttons = v.accounts
      .filter(a => a.name !== v.currentName)
      .map(a => link(`$(arrow-swap) Switch to ${a.name}`, 'claudeMultiAccount.switchTo', [a.name]))
    buttons.push(link('$(add) Add account', 'claudeMultiAccount.addAccount', []))
    md.appendMarkdown(buttons.join(' &nbsp;&nbsp; ') + '\n\n')
    if (v.next && v.next !== v.currentName) {
      md.appendMarkdown(`$(arrow-right) The next session in this folder runs on **${v.next}**\n\n`)
    }

    md.appendMarkdown('---\n\n')
    const s = v.status
    if (!s) {
      md.appendMarkdown('No session data yet. Open a Claude Code tab in this folder.')
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
    if (v.next && v.next !== v.currentName) parts.push(`$(arrow-right) ${v.next}`)
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
    const name = await vscode.window.showInputBox({
      title: 'Add a Claude account',
      prompt: 'A short name, such as a client: lowercase letters, digits and dashes',
      validateInput: v => (NAME_RULE.test(v) ? null : 'Use lowercase letters, digits and dashes'),
    })
    if (!name) return
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
    terminal.sendText('claude /login')
    refresh()
    vscode.window.showInformationMessage(`Sign in to ${name} in the terminal. Then switch a folder to it from the status bar.`)
  }

  async function setupLauncher() {
    const config = vscode.workspace.getConfiguration('claudeCode')
    const launcher = path.join(p.bin, 'claude-launcher')
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

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeMultiAccount.refresh', refresh),
    vscode.commands.registerCommand('claudeMultiAccount.switchTo', switchTo),
    vscode.commands.registerCommand('claudeMultiAccount.addAccount', addAccount),
    vscode.commands.registerCommand('claudeMultiAccount.setupLauncher', setupLauncher),
    vscode.commands.registerCommand('claudeMultiAccount.switch', async () => {
      const v = view()
      if (!v) return
      const picks = [
        ...v.accounts
          .filter(a => a.name !== v.currentName)
          .map(a => ({ label: `$(account) ${a.name}`, description: lib.emailOf(a.dir, p.home), name: a.name })),
        { label: '$(discard) Use default', description: 'Remove the rule for this folder', name: 'auto' },
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

  if (!vscode.workspace.getConfiguration('claudeCode').get('claudeProcessWrapper')) {
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
}

function deactivate() {}

module.exports = { activate, deactivate }
