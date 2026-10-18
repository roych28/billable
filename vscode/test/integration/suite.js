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
  const ext = vscode.extensions.getExtension('roychemo.billable')
  api = await ext.activate()
  const all = await vscode.commands.getCommands(true)
  for (const c of ['switch', 'switchTo', 'addAccount', 'setupLauncher', 'refresh', 'costReport', 'enterLicense', 'stopIdleSessions']) {
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

// Answers each prompt in turn from a list.
function answers(fn, values) {
  const real = vscode.window[fn]
  const seen = []
  vscode.window[fn] = async (...args) => {
    seen.push(args)
    const v = values[seen.length - 1]
    return typeof v === 'function' ? v(...args) : v
  }
  return { seen, restore: () => { vscode.window[fn] = real } }
}

// Records the login terminal instead of opening one.
function fakeTerminal() {
  const real = vscode.window.createTerminal
  const made = []
  vscode.window.createTerminal = options => {
    const t = { options, sent: [], show() {}, dispose() {}, sendText(text) { this.sent.push(text) } }
    made.push(t)
    return t
  }
  return { made, restore: () => { vscode.window.createTerminal = real } }
}

check('add account creates its folder, records it and signs in with claude auth login and the email', async () => {
  // The account folder lands in the real home (~/.claude-<name>), so the name is unique and the folder is removed.
  const name = `cmatest${Date.now().toString(36)}`
  const dir = path.join(os.homedir(), `.claude-${name}`)
  const input = answers('showInputBox', [name, 'me@client.test'])
  const info = answer('showInformationMessage', undefined)
  const term = fakeTerminal()
  try {
    await vscode.commands.executeCommand('claudeMultiAccount.addAccount')
    const accounts = fs.readFileSync(path.join(base, 'accounts'), 'utf8')
    assert.ok(accounts.includes(`${name}\t~/.claude-${name}`), accounts)
    assert.ok(fs.statSync(dir).isDirectory(), 'the config folder was not created')
    assert.strictEqual(term.made.length, 1)
    assert.strictEqual(term.made[0].options.env.CLAUDE_CONFIG_DIR, dir)
    assert.deepStrictEqual(term.made[0].sent, ['claude auth login --email me@client.test'])
    const [nameRule, emailRule] = input.seen.map(a => a[0].validateInput)
    assert.strictEqual(nameRule('Bad Name'), 'Use lowercase letters, digits and dashes')
    assert.match(nameRule('auto'), /reserved/)
    assert.strictEqual(nameRule('acme'), 'An account named acme already exists')
    assert.strictEqual(nameRule('client-2'), null)
    assert.strictEqual(emailRule(''), null)
    assert.strictEqual(emailRule('nope'), 'Enter an email address, or leave it empty')
    assert.strictEqual(emailRule('a@b.co; rm -rf ~'), 'Enter an email address, or leave it empty')
  } finally {
    input.restore()
    info.restore()
    term.restore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('add account without an email runs claude auth login, and cancelling the email adds nothing', async () => {
  const name = `cmatest${Date.now().toString(36)}b`
  const dir = path.join(os.homedir(), `.claude-${name}`)
  const info = answer('showInformationMessage', undefined)
  const term = fakeTerminal()
  try {
    let input = answers('showInputBox', [name, ''])
    await vscode.commands.executeCommand('claudeMultiAccount.addAccount')
    input.restore()
    assert.deepStrictEqual(term.made[0].sent, ['claude auth login'])

    const other = `${name}x`
    input = answers('showInputBox', [other, undefined])
    await vscode.commands.executeCommand('claudeMultiAccount.addAccount')
    input.restore()
    assert.ok(!fs.readFileSync(path.join(base, 'accounts'), 'utf8').includes(other), 'a cancelled add must not record the account')
    assert.strictEqual(term.made.length, 1)
  } finally {
    info.restore()
    term.restore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('the menu offers "Use default" only for a folder with its own rule, and it falls back to the parent rule', async () => {
  const { pathKey } = require('../../lib')
  const ownRule = () =>
    fs.readFileSync(path.join(base, 'folders'), 'utf8').split('\n').map(l => l.split('\t')).find(([f]) => f && f !== '*' && pathKey(f) === pathKey(workspace))
  assert.ok(ownRule(), 'the earlier switch should have pinned this folder')

  let items
  const pick = answer('showQuickPick', list => { items = list; return list.find(i => i.name === 'auto') })
  const info = answer('showInformationMessage', undefined)
  try {
    await vscode.commands.executeCommand('claudeMultiAccount.switch')
  } finally {
    pick.restore()
    info.restore()
  }
  const useDefault = items.find(i => i.name === 'auto')
  assert.ok(useDefault, JSON.stringify(items.map(i => i.label)))
  assert.match(useDefault.description, /it runs on acme/)
  assert.strictEqual(ownRule(), undefined, 'the folder rule should be gone')
  assert.ok(api.statusBar().text.startsWith('$(account) acme'), api.statusBar().text)

  const again = answer('showQuickPick', list => { items = list; return undefined })
  try {
    await vscode.commands.executeCommand('claudeMultiAccount.switch')
  } finally {
    again.restore()
  }
  assert.ok(!items.some(i => i.name === 'auto'), 'no "Use default" without a rule of its own')
  assert.ok(items.some(i => i.name === '+add'), 'Add account stays in the menu')
})

check('"Add account" in the menu runs the add-account flow', async () => {
  const name = `cmatest${Date.now().toString(36)}m`
  const dir = path.join(os.homedir(), `.claude-${name}`)
  const pick = answer('showQuickPick', list => list.find(i => i.name === '+add'))
  const input = answers('showInputBox', [name, ''])
  const info = answer('showInformationMessage', undefined)
  const term = fakeTerminal()
  try {
    await vscode.commands.executeCommand('claudeMultiAccount.switch')
    assert.ok(fs.readFileSync(path.join(base, 'accounts'), 'utf8').includes(`${name}\t`))
    assert.strictEqual(term.made.length, 1)
  } finally {
    pick.restore()
    input.restore()
    info.restore()
    term.restore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
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

// Idle sessions run against fixture session files and a fake process table. The pids are above the highest pid
// macOS and Linux hand out, and signalling goes to a recorder, so no real process is ever touched.
const idleFake = {
  table: new Map(),
  killed: [],
  copied: [],
}

// Idle sessions read ps, so they are off on Windows: there the command only says so.
const unixCheck = process.platform === 'win32' ? () => {} : check

if (process.platform === 'win32') {
  check('on Windows "Stop idle sessions" says it works on macOS and Linux, and the hover has no sessions line', async () => {
    const info = answer('showInformationMessage', undefined)
    try {
      await vscode.commands.executeCommand('claudeMultiAccount.stopIdleSessions')
    } finally {
      info.restore()
    }
    assert.match(String(info.seen[0]?.[0]), /macOS and Linux/)
    assert.ok(!api.statusBar().tooltip.includes('**Claude sessions:**'), api.statusBar().tooltip)
  })
}

function idleSetup() {
  const now = Date.now()
  const acme = path.join(tmp, 'claude-acme')
  const write = (pid, sessionId, cwd, status, quietMs) => {
    fs.mkdirSync(path.join(acme, 'sessions'), { recursive: true })
    fs.writeFileSync(path.join(acme, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, status, startedAt: now - 20 * 3_600_000 }))
    const t = path.join(acme, 'projects', 'idle-test', `${sessionId}.jsonl`)
    fs.mkdirSync(path.dirname(t), { recursive: true })
    fs.writeFileSync(t, '{}\n')
    fs.utimesSync(t, (now - quietMs) / 1000, (now - quietMs) / 1000)
  }
  write(9_900_001, 'sess-old', workspace, 'idle', 10 * 3_600_000)
  write(9_900_002, 'sess-recent', path.join(tmp, 'work', 'api'), 'idle', 5 * 60_000)
  write(9_900_003, 'sess-busy', path.join(tmp, 'work', 'web'), 'busy', 10 * 3_600_000)
  const row = (rssMb, command = '/x/native-binary/claude --output-format stream-json') => ({ rssKb: rssMb * 1024, pcpu: 0, ageSec: 20 * 3600, cpuTimeSec: 5, command })
  idleFake.table = new Map([[9_900_001, row(600)], [9_900_002, row(300)], [9_900_003, row(200)]])
  idleFake.killed = []
  idleFake.copied = []
  api.setIdleDeps({
    ps: pids => new Map(pids.filter(p => idleFake.table.has(p)).map(p => [p, { ...idleFake.table.get(p) }])),
    kill: (pid, signal) => {
      idleFake.killed.push([pid, signal])
      idleFake.table.delete(pid)
    },
    sleep: async () => {},
    copy: async text => { idleFake.copied.push(text) },
  })
}

unixCheck('the hover counts the running and idle Claude sessions and their RAM, below the usage', async () => {
  idleSetup()
  const t = api.statusBar().tooltip
  const line = t.indexOf('**Claude sessions:** 3 running · 2 idle · 1.1 GB RAM')
  assert.ok(line > 0, t)
  assert.ok(line > t.indexOf('---') && line > t.indexOf('Cost report'), t)
  assert.ok(t.indexOf('Stop idle sessions') > line, t)
})

unixCheck('"Stop idle sessions" lists the idle ones, pre-selects the long quiet one, stops only what was chosen, and copies the resume command', async () => {
  idleSetup()
  let listed, options
  const pick = answers('showQuickPick', [
    (list, opts) => { listed = list; options = opts; return list.filter(i => i.picked) },
    list => list.find(i => i.label.includes('Copy all')),
  ])
  const info = answer('showInformationMessage', undefined)
  const warn = answer('showWarningMessage', undefined)
  try {
    await vscode.commands.executeCommand('claudeMultiAccount.stopIdleSessions')
  } finally {
    pick.restore()
    info.restore()
    warn.restore()
  }
  assert.ok(options.canPickMany, 'the list must allow several sessions')
  assert.deepStrictEqual(listed.map(i => i.label), ['app', 'api'])
  assert.deepStrictEqual(listed.map(i => !!i.picked), [true, false])
  assert.match(listed[0].description, /^quiet 10\.0 h · 600 MB$/)
  assert.deepStrictEqual(idleFake.killed, [[9_900_001, 'SIGTERM']])
  assert.deepStrictEqual(idleFake.copied, [`cd ${workspace} && CLAUDE_CONFIG_DIR=${path.join(tmp, 'claude-acme')} claude --resume sess-old`])
  assert.strictEqual(warn.seen.length, 0, JSON.stringify(warn.seen))
  assert.ok(api.statusBar().tooltip.includes('**Claude sessions:** 2 running · 1 idle'), api.statusBar().tooltip)
})

unixCheck('with autoStopHours set, the check stops only sessions idle past it and says which', async () => {
  idleSetup()
  const config = vscode.workspace.getConfiguration('claudeMultiAccount')
  await config.update('idleSessions.autoStopHours', 6, vscode.ConfigurationTarget.Global)
  const info = answer('showInformationMessage', undefined)
  let result
  try {
    result = await api.autoStopIdleNow()
  } finally {
    info.restore()
    await config.update('idleSessions.autoStopHours', undefined, vscode.ConfigurationTarget.Global)
  }
  assert.deepStrictEqual(idleFake.killed, [[9_900_001, 'SIGTERM']])
  assert.deepStrictEqual(result.stopped.map(s => s.sessionId), ['sess-old'])
  assert.strictEqual(info.seen.length, 1)
  assert.match(info.seen[0][0], /stopped 1 session idle over 6 h: app \(10\.0 h\)/)

  idleSetup()
  const off = await api.autoStopIdleNow()
  assert.deepStrictEqual(off.stopped, [], 'with the setting at 0 nothing is stopped')
  assert.deepStrictEqual(idleFake.killed, [])
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
