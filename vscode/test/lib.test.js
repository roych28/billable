const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const lib = require('../lib')

function sandbox() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cma-')))
  return lib.paths(home)
}

function assistant(id, input, output, cacheRead, cacheWrite) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      },
    },
  })
}

test('tokens count each message once and pick up what is appended later', () => {
  const p = sandbox()
  const file = path.join(p.home, 's1.jsonl')
  const partial = assistant('m3', 1, 1, 1, 1)
  fs.writeFileSync(
    file,
    [assistant('m1', 10, 5, 100, 20), assistant('m1', 10, 5, 100, 20), assistant('m2', 1, 2, 3, 4), ''].join('\n') +
      partial.slice(0, 20),
  )
  assert.deepStrictEqual(lib.sessionTokens(file), { input: 11, output: 7, cacheRead: 103, cacheWrite: 24 })
  fs.appendFileSync(file, partial.slice(20) + '\n')
  assert.deepStrictEqual(lib.sessionTokens(file), { input: 12, output: 8, cacheRead: 104, cacheWrite: 25 })
  assert.strictEqual(lib.sessionTokens(path.join(p.home, 'missing.jsonl')), null)
})

test('the longest folder rule wins, then the default', () => {
  const rules = [
    { path: '*', account: 'personal' },
    { path: '/w', account: 'acme' },
    { path: '/w/globex', account: 'globex' },
  ]
  assert.strictEqual(lib.accountFor('/w/globex/api', rules), 'globex')
  assert.strictEqual(lib.accountFor('/w/app', rules), 'acme')
  assert.strictEqual(lib.accountFor('/wx', rules), 'personal')
  assert.strictEqual(lib.accountFor('/x', []), null)
})

test('pinning a folder keeps the other rules, and auto removes the pin', () => {
  const p = sandbox()
  fs.mkdirSync(p.base, { recursive: true })
  fs.writeFileSync(p.folders, `# rules\n*\tpersonal\n~/code/other\tacme\n`)
  lib.pin(p, path.join(p.home, 'code/app'), 'globex')
  const rules = lib.readRules(p)
  assert.strictEqual(lib.accountFor(path.join(p.home, 'code/app/src'), rules), 'globex')
  assert.strictEqual(lib.accountFor(path.join(p.home, 'code/other'), rules), 'acme')
  lib.pin(p, path.join(p.home, 'code/app'), 'auto')
  assert.strictEqual(lib.accountFor(path.join(p.home, 'code/app'), lib.readRules(p)), 'personal')
  assert.match(fs.readFileSync(p.folders, 'utf8'), /^# rules/)
})

test('the first added account also records the existing default one', () => {
  const p = sandbox()
  lib.addAccount(p, 'acme', '~/.claude-acme')
  assert.deepStrictEqual(lib.readAccounts(p), [
    { name: 'default', dir: path.join(p.home, '.claude') },
    { name: 'acme', dir: path.join(p.home, '.claude-acme') },
  ])
  assert.ok(fs.existsSync(path.join(p.home, '.claude-acme')))
  assert.throws(() => lib.addAccount(p, 'acme', '~/.claude-acme'), /already exists/)
})

test('the launcher picks the same account as the extension', () => {
  const p = sandbox()
  fs.mkdirSync(p.base, { recursive: true })
  fs.writeFileSync(p.accounts, 'personal\t~/.claude\nacme\t~/.claude-acme\nglobex\t~/.claude-globex\n')
  fs.writeFileSync(p.folders, '*\tpersonal\n~/w\tacme\n~/w/globex\tglobex\n')
  const win = process.platform === 'win32'
  const cma = path.join(__dirname, '..', ...(win ? ['bin', 'win32', 'cma.exe'] : ['bin', 'cma']))
  const env = { ...process.env, HOME: p.home, USERPROFILE: p.home, CLAUDE_MULTI_ACCOUNT_HOME: p.base }
  const launch = args => (win ? execFileSync(cma, args, { env }) : execFileSync('sh', [cma, ...args], { env }))
  const dirFor = d => launch(['dir', path.join(p.home, d)]).toString().trim()
  assert.strictEqual(dirFor('w/globex/api'), path.join(p.home, '.claude-globex'))
  assert.strictEqual(dirFor('w/app'), path.join(p.home, '.claude-acme'))
  assert.strictEqual(dirFor('elsewhere'), path.join(p.home, '.claude'))
  if (win) return // exec on Windows is covered by the launcher's own Go tests

  const run = cwd =>
    execFileSync('sh', [cma, 'exec', 'sh', '-c', 'printf %s "${CLAUDE_CONFIG_DIR-unset}"'], {
      env: { ...env, CLAUDE_CONFIG_DIR: 'inherited' },
      cwd,
    }).toString()
  fs.mkdirSync(path.join(p.home, 'w/app'), { recursive: true })
  assert.strictEqual(run(path.join(p.home, 'w/app')), path.join(p.home, '.claude-acme'))
  assert.strictEqual(run(p.home), 'unset')
})

test('the latest status can be narrowed to one account', () => {
  const p = sandbox()
  fs.mkdirSync(p.sessions, { recursive: true })
  const row = (id, account, updatedAt) =>
    fs.writeFileSync(path.join(p.sessions, `${id}.json`), JSON.stringify({ sessionId: id, cwd: '/w/app', account: { name: account }, updatedAt }))
  row('a', 'acme', 1)
  row('b', 'personal', 2)
  row('c', 'acme', 3)
  assert.strictEqual(lib.latestStatus(p, ['/w/app']).sessionId, 'c')
  assert.strictEqual(lib.latestStatus(p, ['/w/app'], 'personal').sessionId, 'b')
  assert.strictEqual(lib.latestStatus(p, ['/w/app'], 'globex'), null)
  assert.strictEqual(lib.latestStatus(p, ['/w/other']), null)
})

test('on Windows folder rules ignore case and slash direction', () => {
  const rules = [{ path: 'C:\\Work\\Acme', account: 'acme' }, { path: '*', account: 'personal' }]
  assert.strictEqual(lib.accountFor('c:\\work\\acme\\app', rules, 'win32'), 'acme')
  assert.strictEqual(lib.accountFor('C:/Work/Acme', rules, 'win32'), 'acme')
  assert.strictEqual(lib.accountFor('C:\\Work\\Acme-other', rules, 'win32'), 'personal')
  assert.strictEqual(lib.accountFor('/work/Acme/app', [{ path: '/work/acme', account: 'acme' }], 'darwin'), null)
})

test('each platform gets its own launcher, and the files exist in the package', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const f = lib.launcherFiles(platform)
    for (const name of f.names) assert.ok(fs.existsSync(path.join(__dirname, '..', f.dir, name)), `${platform}: ${f.dir}/${name}`)
    assert.ok(f.names.includes(f.wrapper))
  }
})

test('the inherited account is what a folder falls back to once its own rule is dropped', () => {
  const rules = [
    { path: '*', account: 'personal' },
    { path: '/w', account: 'acme' },
    { path: '/w/app', account: 'globex' },
  ]
  assert.strictEqual(lib.inheritedAccount('/w/app', rules), 'acme')
  assert.strictEqual(lib.inheritedAccount('/w', rules), 'personal')
  assert.strictEqual(lib.inheritedAccount('/w/app/sub', rules), undefined)
  assert.strictEqual(lib.inheritedAccount('/elsewhere', rules), undefined)
  assert.strictEqual(lib.inheritedAccount('/w/app', [{ path: '/w/app', account: 'globex' }]), null)
})
