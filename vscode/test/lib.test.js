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

// ---- Idle sessions: fixture config dirs and a fake process table; nothing here lists or signals a real process ----

const HOUR = 3_600_000

function idleFixture() {
  const p = sandbox()
  const now = Date.now()
  const acme = path.join(p.home, 'claude-acme')
  const personal = path.join(p.home, 'claude-personal')
  fs.mkdirSync(p.base, { recursive: true })
  fs.writeFileSync(p.accounts, `acme\t${acme}\npersonal\t${personal}\n`)
  const session = (dir, pid, fields) => {
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'sessions', `${pid}.json`), JSON.stringify({ pid, startedAt: now - 20 * HOUR, ...fields }))
  }
  const transcript = (dir, id, ageMs) => {
    const f = path.join(dir, 'projects', '-w-app', `${id}.jsonl`)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, '{}\n')
    const t = (now - ageMs) / 1000
    fs.utimesSync(f, t, t)
  }
  session(acme, 9101, { sessionId: 'old', cwd: '/w/app', status: 'idle' })
  transcript(acme, 'old', 10 * HOUR)
  session(acme, 9102, { sessionId: 'recent', cwd: '/w/api', status: 'idle' })
  transcript(personal, 'recent', 10 * 60_000)
  session(acme, 9103, { sessionId: 'working', cwd: '/w/web', status: 'busy' })
  transcript(acme, 'working', 10 * HOUR)
  session(personal, 9104, { sessionId: 'dead', cwd: '/w/x', status: 'idle' })
  session(personal, 9105, { sessionId: 'reused', cwd: '/w/y', status: 'idle' })
  session(personal, 9106, { sessionId: 'notranscript', cwd: '/w/my app', status: 'idle', startedAt: now - 12 * HOUR })
  session(personal, 9107, { sessionId: 'spinning', cwd: '/w/z', status: 'idle' })
  transcript(personal, 'spinning', 10 * HOUR)
  // A pid reused by a claude process that started after the session file was written.
  session(personal, 9108, { sessionId: 'newerpid', cwd: '/w/q', status: 'idle', startedAt: now - 30 * HOUR })
  const table = new Map([
    [9101, { rssKb: 600 * 1024, pcpu: 0, ageSec: 20 * 3600, cpuTimeSec: 50, command: '/x/native-binary/claude --output-format stream-json' }],
    [9102, { rssKb: 300 * 1024, pcpu: 0, ageSec: 20 * 3600, cpuTimeSec: 10, command: '/Users/me/.local/share/claude/versions/2.1.300' }],
    [9103, { rssKb: 200 * 1024, pcpu: 40, ageSec: 20 * 3600, cpuTimeSec: 900, command: 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js' }],
    [9105, { rssKb: 100 * 1024, pcpu: 0, ageSec: 20 * 3600, cpuTimeSec: 1, command: '/usr/bin/vim notes.txt' }],
    [9106, { rssKb: 100 * 1024, pcpu: 0, ageSec: 12 * 3600, cpuTimeSec: 3, command: '/x/claude' }],
    [9107, { rssKb: 100 * 1024, pcpu: 0.2, ageSec: 20 * 3600, cpuTimeSec: 100, command: '/x/claude' }],
    [9108, { rssKb: 100 * 1024, pcpu: 0, ageSec: 2 * 3600, cpuTimeSec: 1, command: '/x/claude' }],
  ])
  const calls = []
  const ps = pids => {
    calls.push(pids)
    const out = new Map()
    for (const pid of pids) {
      const row = table.get(pid)
      if (!row) continue
      // The spinning session burns half a second of CPU between two listings.
      if (pid === 9107) row.cpuTimeSec += calls.length > 1 ? 0.5 : 0
      out.set(pid, { ...row })
    }
    return out
  }
  const killed = []
  const kill = (pid, signal) => {
    if (!table.has(pid)) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    killed.push([pid, signal])
    table.delete(pid)
  }
  const sleep = async () => {}
  return { p, now, acme, personal, dirs: lib.claudeDirs(p), ps, kill, killed, sleep, table }
}

test('ps durations and output parse on macOS and Linux formats', () => {
  assert.strictEqual(lib.parseDuration('07:12:42'), 25962)
  assert.strictEqual(lib.parseDuration('1-02:03:04'), 93784)
  assert.strictEqual(lib.parseDuration('12:34'), 754)
  assert.strictEqual(lib.parseDuration('11:56.39'), 716.39)
  assert.strictEqual(lib.parseDuration('junk'), null)
  const out = lib.parsePs(
    '11405 533456  62.6 07:12:42  11:56.39 /Users/me/.vscode/extensions/anthropic.claude-code-2.1.301-darwin-arm64/resources/native-binary/claude --output-format stream-json\n' +
      '  77  1024   0,0    01:02  00:00:00 /usr/bin/vim a b\n',
  )
  assert.deepStrictEqual(out.get(11405), {
    rssKb: 533456, pcpu: 62.6, ageSec: 25962, cpuTimeSec: 716.39,
    command: '/Users/me/.vscode/extensions/anthropic.claude-code-2.1.301-darwin-arm64/resources/native-binary/claude --output-format stream-json',
  })
  assert.strictEqual(out.get(77).pcpu, 0)
  assert.strictEqual(out.get(77).command, '/usr/bin/vim a b')
})

test('a claude binary is recognised, other programs are not', () => {
  assert.ok(lib.isClaudeCommand('/x/resources/native-binary/claude --verbose'))
  assert.ok(lib.isClaudeCommand('/Users/me/.local/share/claude/versions/2.1.300'))
  assert.ok(lib.isClaudeCommand('/usr/local/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'))
  assert.ok(!lib.isClaudeCommand('/usr/bin/vim claude.md'))
  assert.ok(!lib.isClaudeCommand('/Applications/Claude.app/Contents/MacOS/Claude'))
  assert.ok(!lib.isClaudeCommand(''))
})

test('the survey keeps only live claude processes of the session files, with RAM and quiet time', () => {
  const f = idleFixture()
  const list = lib.surveySessions({ dirs: f.dirs, ps: f.ps, now: f.now })
  const byId = Object.fromEntries(list.map(s => [s.sessionId, s]))
  assert.deepStrictEqual(Object.keys(byId).sort(), ['notranscript', 'old', 'recent', 'spinning', 'working'])
  assert.ok(Math.abs(byId.old.quietMs - 10 * HOUR) < 5000, byId.old.quietMs)
  // The transcript can sit under another account's directory.
  assert.ok(byId.recent.quietMs < HOUR, byId.recent.quietMs)
  // Without a transcript the process age counts.
  assert.strictEqual(byId.notranscript.quietMs, 12 * HOUR)
  assert.deepStrictEqual(lib.summarizeSessions(list), { running: 5, idle: 4, rssKb: 1300 * 1024 })
  assert.strictEqual(lib.formatRam(1300 * 1024), '1.3 GB')
  assert.strictEqual(lib.formatRam(300 * 1024), '300 MB')
  assert.strictEqual(lib.formatQuiet(45 * 60_000), '45 min')
  assert.strictEqual(lib.formatQuiet(10 * HOUR), '10.0 h')
})

test('the survey reads nothing outside the given directories, and an account linked to another counts once', () => {
  const f = idleFixture()
  fs.symlinkSync(f.acme, path.join(f.p.home, 'claude-acme-link'))
  fs.appendFileSync(f.p.accounts, `link\t${path.join(f.p.home, 'claude-acme-link')}\n`)
  assert.strictEqual(lib.claudeDirs(f.p).length, 2)
  assert.deepStrictEqual(lib.readClaudeSessions([path.join(f.p.home, 'nowhere')]), [])
})

test('only sessions that pass every safety rule are stopped automatically', async () => {
  const f = idleFixture()
  const list = lib.surveySessions({ dirs: f.dirs, ps: f.ps, now: f.now })
  await lib.sampleCpu(list, { ps: f.ps, sleep: f.sleep, ms: 1000 })
  const why = Object.fromEntries(list.map(s => [s.sessionId, lib.autoStopBlocker(s, 6 * HOUR)]))
  assert.deepStrictEqual(why, {
    old: null,
    recent: 'active recently',
    working: 'status busy',
    notranscript: null,
    spinning: 'CPU 50.0%',
  })
  // What the manual list pre-selects, before any CPU sample.
  assert.deepStrictEqual(list.filter(s => lib.quietPast(s, 6 * HOUR)).map(s => s.sessionId).sort(), ['notranscript', 'old', 'spinning'])
  // A threshold above the process age holds even an untouched session.
  assert.strictEqual(lib.autoStopBlocker(list.find(s => s.sessionId === 'notranscript'), 13 * HOUR), 'active recently')
})

test('stopping sends SIGTERM only to sessions that are still idle claude processes, checked again first', async () => {
  const f = idleFixture()
  const list = lib.surveySessions({ dirs: f.dirs, ps: f.ps, now: f.now })
  const pick = ids => list.filter(s => ids.includes(s.sessionId))
  // The busy one is refused even when chosen by hand, and so is one that turned busy since the list was shown.
  fs.writeFileSync(path.join(f.personal, 'sessions', '9106.json'), JSON.stringify({ pid: 9106, sessionId: 'notranscript', cwd: '/w/my app', status: 'busy' }))
  const r = await lib.stopSessions(pick(['old', 'working', 'notranscript', 'spinning']), { dirs: f.dirs, ps: f.ps, kill: f.kill, sleep: f.sleep })
  assert.deepStrictEqual(f.killed, [[9101, 'SIGTERM']])
  assert.deepStrictEqual(r.stopped.map(s => s.sessionId), ['old'])
  // Half a second of CPU over the default five-second window.
  assert.deepStrictEqual(Object.fromEntries(r.skipped.map(s => [s.sessionId, s.reason])), {
    working: 'status busy',
    notranscript: 'status busy',
    spinning: 'CPU 10.0%',
  })
  // Gone by now: nothing is signalled.
  const again = await lib.stopSessions(pick(['old']), { dirs: f.dirs, ps: f.ps, kill: f.kill, sleep: f.sleep })
  assert.deepStrictEqual(again.skipped.map(s => s.reason), ['no longer running'])
  assert.strictEqual(f.killed.length, 1)
})

test('the resume command goes to the folder, and names the config dir unless it is ~/.claude', () => {
  const home = '/Users/me'
  assert.strictEqual(lib.resumeCommand({ cwd: '/w/app', sessionId: 'abc-1', dir: '/Users/me/.claude' }, home), 'cd /w/app && claude --resume abc-1')
  assert.strictEqual(
    lib.resumeCommand({ cwd: "/w/my app's", sessionId: 'abc-2', dir: '/Users/me/.claude-acme' }, home),
    `cd '/w/my app'\\''s' && CLAUDE_CONFIG_DIR=/Users/me/.claude-acme claude --resume abc-2`,
  )
})
