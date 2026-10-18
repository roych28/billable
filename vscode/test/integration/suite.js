const assert = require('assert')
const fs = require('fs')
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
  const cma = path.join(base, 'bin', 'cma')
  assert.ok(fs.statSync(cma).mode & 0o111, 'cma is not executable')
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
  const rules = await until('the folders file', () => {
    const t = fs.readFileSync(path.join(base, 'folders'), 'utf8')
    return t.includes(`${workspace}\tpersonal`) && t
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
