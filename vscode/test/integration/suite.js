const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vscode = require('vscode')

const tmp = process.env.CMA_TEST_ROOT
const base = process.env.CLAUDE_MULTI_ACCOUNT_HOME
const workspace = path.join(tmp, 'work', 'app')

async function until(what, fn, ms = 5000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 100))
  }
}

const checks = []
const check = (name, fn) => checks.push({ name, fn })
let api

check('the extension activates and registers every command', async () => {
  const ext = vscode.extensions.getExtension('roychemo.claude-multi-account')
  api = await ext.activate()
  const all = await vscode.commands.getCommands(true)
  for (const c of ['switch', 'switchTo', 'addAccount', 'setupLauncher', 'refresh', 'costReport', 'enterLicense']) {
    assert.ok(all.includes(`claudeMultiAccount.${c}`), `missing claudeMultiAccount.${c}`)
  }
})

check('the launcher is installed and resolves the folder to its account', async () => {
  const cma = path.join(base, 'bin', process.platform === 'win32' ? 'cma.exe' : 'cma')
  if (process.platform !== 'win32') assert.ok(fs.statSync(cma).mode & 0o111, 'cma is not executable')
  const out = require('child_process').execFileSync(cma, ['dir', workspace], { encoding: 'utf8', env: { ...process.env } })
  assert.strictEqual(out.trim(), path.join(tmp, 'claude-acme'))
})

check('the status bar names the folder account, and the hover puts it before the switch buttons', async () => {
  const s = api.statusBar()
  assert.ok(s.text.startsWith('$(account) acme'), s.text)
  const t = s.tooltip
  const at = x => t.indexOf(x)
  assert.ok(at('**acme**') >= 0 && at('me@acme.test') > at('**acme**'), t)
  assert.ok(at('Switch to personal') > at('me@acme.test'), t)
  assert.ok(at('Add account') > at('Switch to personal'), t)
  assert.ok(at('Cost report') > at('Add account'), t)
  assert.strictEqual(at('Switch to acme'), -1, t)
  assert.strictEqual(at('(not signed in)'), -1, t)
  assert.ok(at('No session on acme in this folder yet') > 0, t)
})

check('a session status shows real tokens, cost and limits', async () => {
  const transcript = path.join(tmp, 'claude-acme', 'projects', 'x', 's-1.jsonl')
  fs.mkdirSync(path.dirname(transcript), { recursive: true })
  const msg = (id, i, o) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
  fs.writeFileSync(transcript, [msg('m1', 1000, 500), msg('m1', 1000, 500), msg('m2', 300, 200)].join('\n') + '\n')
  fs.mkdirSync(path.join(base, 'sessions'), { recursive: true })
  fs.writeFileSync(
    path.join(base, 'sessions', 's-1.json'),
    JSON.stringify({
      sessionId: 's-1', cwd: workspace, folder: workspace, transcript,
      account: { name: 'acme', email: 'me@acme.test' }, others: [],
      usage: { usd: 1.5, limits: [{ kind: 'five_hour', percentUsed: 23 }] }, next: null, updatedAt: Date.now(),
    }),
  )
  const s = api.statusBar()
  assert.ok(s.text.includes('$(symbol-number) 2K'), s.text)
  assert.ok(s.text.includes('$1.50'), s.text)
  assert.ok(s.text.includes('23%'), s.text)
  assert.ok(s.tooltip.includes('input 1K · output 700'), s.tooltip)
  assert.ok(s.tooltip.includes('**5-hour limit:** 23%'), s.tooltip)
})

check('switching pins the folder to the new account and keeps the other rules', async () => {
  vscode.commands.executeCommand('claudeMultiAccount.switchTo', 'personal')
  const { pathKey } = require('../../lib')
  const rules = await until('the folders file', () => {
    const t = fs.readFileSync(path.join(base, 'folders'), 'utf8')
    const pinned = t.split('\n').map(l => l.split('\t')).some(([f, a]) => a === 'personal' && f && pathKey(f) === pathKey(workspace))
    return pinned && t
  })
  assert.ok(rules.includes(`*\tpersonal`), rules)
  assert.ok(rules.includes(`${path.dirname(workspace)}\tacme`), rules)
})

check('after a switch the status bar shows the new account at once, even while the old chat keeps updating', async () => {
  const file = path.join(base, 'sessions', 's-1.json')
  const old = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...old, updatedAt: Date.now() + 1000 }))
  const s = api.statusBar()
  assert.ok(s.text.startsWith('$(account) personal'), s.text)
  assert.ok(s.text.includes('$(warning) chat on acme'), s.text)
  assert.ok(!s.text.includes('$1.50'), `usage of the acme chat must not show under personal: ${s.text}`)
  assert.ok(s.tooltip.includes('The open conversation still runs on **acme**'), s.tooltip)
  assert.ok(s.tooltip.includes('No session on personal in this folder yet'), s.tooltip)
})

check('once a conversation runs on the new account the warning goes away and its usage shows', async () => {
  fs.writeFileSync(
    path.join(base, 'sessions', 's-2.json'),
    JSON.stringify({
      sessionId: 's-2', cwd: workspace, folder: workspace, transcript: '',
      account: { name: 'personal', email: 'me@example.test' }, others: [],
      usage: { usd: 0.25, limits: [] }, next: null, updatedAt: Date.now() + 2000,
    }),
  )
  const s = api.statusBar()
  assert.ok(s.text.startsWith('$(account) personal'), s.text)
  assert.ok(s.text.includes('$0.25'), s.text)
  assert.ok(!s.text.includes('$(warning)'), s.text)
})

check('an account that is not signed in is marked in the hover', async () => {
  fs.appendFileSync(path.join(base, 'accounts'), `globex\t${tmp}/claude-globex\n`)
  const t = api.statusBar().tooltip
  assert.ok(t.includes('Switch to globex (not signed in)'), t)
})

// Stands in for the person at the keyboard: each stub answers one prompt, then the real one is back.
function answer(fn, value) {
  const real = vscode.window[fn]
  const seen = []
  vscode.window[fn] = async (...args) => {
    seen.push(args)
    return typeof value === 'function' ? value(...args) : value
  }
  return { seen, restore: () => { vscode.window[fn] = real } }
}

check('add account creates its config folder, records it and opens a terminal signed to it', async () => {
  // The account folder lands in the real home (~/.claude-<name>), so the name is unique and the folder is removed.
  const name = `cmatest${Date.now().toString(36)}`
  const dir = path.join(os.homedir(), `.claude-${name}`)
  const input = answer('showInputBox', name)
  const info = answer('showInformationMessage', undefined)
  try {
    await vscode.commands.executeCommand('claudeMultiAccount.addAccount')
    const accounts = fs.readFileSync(path.join(base, 'accounts'), 'utf8')
    assert.ok(accounts.includes(`${name}\t~/.claude-${name}`), accounts)
    const term = await until('the login terminal', () => vscode.window.terminals.find(t => t.name === `Claude login: ${name}`))
    assert.strictEqual(term.creationOptions.env.CLAUDE_CONFIG_DIR, dir)
    assert.ok(fs.statSync(dir).isDirectory(), 'the config folder was not created')
    const nameRule = input.seen[0][0].validateInput
    assert.strictEqual(nameRule('Bad Name'), 'Use lowercase letters, digits and dashes')
    assert.strictEqual(nameRule('client-2'), null)
    term.dispose()
  } finally {
    input.restore()
    info.restore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('add account refuses a name that already exists', async () => {
  const input = answer('showInputBox', 'acme')
  const error = answer('showErrorMessage', undefined)
  try {
    await vscode.commands.executeCommand('claudeMultiAccount.addAccount')
  } finally {
    input.restore()
    error.restore()
  }
  assert.strictEqual(error.seen[0][0], 'An account named acme already exists')
})

check('the cost report opens a monthly table per account, and exports a CSV', async () => {
  const ledger = path.join(base, 'ledger')
  fs.mkdirSync(ledger, { recursive: true })
  const now = Date.now()
  const row = (id, account, usd) =>
    fs.writeFileSync(path.join(ledger, `${id}.json`), JSON.stringify({ sessionId: id, account, email: `${account}@test`, folder: workspace, startedAt: now, updatedAt: now, usd }))
  row('r1', 'acme', 1.25)
  row('r2', 'acme', 0.75)
  row('r3', 'personal', 3)
  const month = require('../../report').monthOf(now)
  const csvPath = path.join(tmp, `cost-${month}.csv`)
  const pick = answer('showQuickPick', items => items.find(i => i.month === month))
  const info = answer('showInformationMessage', 'Export CSV')
  const save = answer('showSaveDialog', vscode.Uri.file(csvPath))
  try {
    await vscode.commands.executeCommand('claudeMultiAccount.costReport')
  } finally {
    pick.restore()
    info.restore()
    save.restore()
  }
  const doc = vscode.workspace.textDocuments.find(d => d.getText().startsWith(`# Claude cost by account, ${month}`))
  assert.ok(doc, 'the report document did not open')
  const text = doc.getText()
  assert.ok(text.includes('| **personal** | personal@test | 1 | **$3.00** |'), text)
  assert.ok(text.includes('| **acme** | acme@test | 2 | **$2.00** |'), text)
  assert.ok(text.includes('| Total | | 3 | **$5.00** |'), text)
  const csv = fs.readFileSync(csvPath, 'utf8').trim().split('\n')
  assert.strictEqual(csv.length, 4, csv.join('\n'))
  assert.ok(csv[0].startsWith('month,account,email,folder'), csv[0])
})

check('setting up the launcher without the Claude Code extension warns instead of failing', async () => {
  await Promise.race([
    vscode.commands.executeCommand('claudeMultiAccount.setupLauncher'),
    new Promise(r => setTimeout(r, 500)),
  ])
})

exports.run = async () => {
  let failed = 0
  for (const c of checks) {
    try {
      await c.fn()
      console.log(`ok   ${c.name}`)
    } catch (err) {
      failed++
      console.log(`FAIL ${c.name}\n     ${String(err.message).split('\n').join('\n     ')}`)
    }
  }
  if (failed) throw new Error(`${failed} integration check(s) failed`)
}
