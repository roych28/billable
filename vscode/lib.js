const fs = require('fs')
const os = require('os')
const path = require('path')

const NOT_SIGNED_IN = 'not signed in'

function paths(home = os.homedir()) {
  const base = process.env.CLAUDE_MULTI_ACCOUNT_HOME || path.join(home, '.claude-multi-account')
  return {
    home,
    base,
    accounts: path.join(base, 'accounts'),
    folders: path.join(base, 'folders'),
    sessions: path.join(base, 'sessions'),
    ledger: path.join(base, 'ledger'),
    bin: path.join(base, 'bin'),
  }
}

function expand(p, home) {
  const full = p === '~' ? home : p.startsWith('~/') || p.startsWith('~\\') ? path.join(home, p.slice(2)) : p
  return full.replace(/[\\/]+$/, '')
}

function readRows(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => l.split('\t').map(f => f.trim()))
      .filter(r => r[0] && r[1])
  } catch {
    return []
  }
}

function readAccounts(p) {
  const rows = readRows(p.accounts).map(r => ({ name: r[0], dir: expand(r[1], p.home) }))
  return rows.length ? rows : [{ name: 'default', dir: path.join(p.home, '.claude') }]
}

function readRules(p) {
  return readRows(p.folders).map(r => ({ path: r[0] === '*' ? '*' : expand(r[0], p.home), account: r[1] }))
}

// How two paths are compared: forward slashes, no trailing slash, and case-insensitive on Windows.
function pathKey(p, platform = process.platform) {
  const k = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'win32' ? k.toLowerCase() : k
}

function accountFor(folder, rules, platform = process.platform) {
  const f = pathKey(folder, platform)
  let best = null
  let bestLen = -1
  for (const r of rules) {
    if (r.path === '*') {
      if (bestLen < 0) {
        best = r
        bestLen = 0
      }
      continue
    }
    const p = pathKey(r.path, platform)
    if ((f === p || f.startsWith(p + '/')) && p.length > bestLen) {
      best = r
      bestLen = p.length
    }
  }
  return best ? best.account : null
}

function emailOf(dir, home) {
  const file = dir === path.join(home, '.claude') ? path.join(home, '.claude.json') : path.join(dir, '.claude.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount?.emailAddress ?? NOT_SIGNED_IN
  } catch {
    return NOT_SIGNED_IN
  }
}

// The account a folder would run on without a rule of its own, or undefined when it has no rule of its own.
function inheritedAccount(folder, rules, platform = process.platform) {
  const own = rules.filter(r => r.path !== '*' && pathKey(r.path, platform) === pathKey(folder, platform))
  if (own.length === 0) return undefined
  return accountFor(folder, rules.filter(r => !own.includes(r)), platform)
}

function pin(p, folder, name, platform = process.platform) {
  let lines = []
  try {
    lines = fs.readFileSync(p.folders, 'utf8').split('\n').filter(l => l.trim())
  } catch {}
  const kept = lines.filter(l => {
    const first = (l.split('\t')[0] || '').trim()
    return l.trim().startsWith('#') || first === '*' || pathKey(expand(first, p.home), platform) !== pathKey(folder, platform)
  })
  if (name !== 'auto') kept.push(`${folder}\t${name}`)
  fs.mkdirSync(p.base, { recursive: true })
  fs.writeFileSync(p.folders, kept.join('\n') + '\n')
}

function addAccount(p, name, dir) {
  fs.mkdirSync(p.base, { recursive: true })
  let text = ''
  try {
    text = fs.readFileSync(p.accounts, 'utf8')
  } catch {}
  const rows = readRows(p.accounts)
  if (rows.length === 0) text = `default\t~/.claude\n`
  if (rows.some(r => r[0] === name)) throw new Error(`An account named ${name} already exists`)
  if (text && !text.endsWith('\n')) text += '\n'
  fs.writeFileSync(p.accounts, `${text}${name}\t${dir}\n`)
  fs.mkdirSync(expand(dir, p.home), { recursive: true })
}

const PLUGIN = 'multi-account'
const PUBLIC_MARKETPLACE = { name: 'claude-multi-account', arg: 'roych28/claude-multi-account' }

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// The marketplace an account installed this plugin from, or null when the plugin is not installed there.
function installedMarketplace(dir) {
  const installed = readJson(path.join(dir, 'plugins', 'installed_plugins.json'))?.plugins ?? {}
  const key = Object.keys(installed).find(k => k.startsWith(`${PLUGIN}@`))
  return key ? key.slice(PLUGIN.length + 1) : null
}

// 'installed', 'disabled' (the user turned it off: leave it), or 'missing'.
function pluginState(dir) {
  const market = installedMarketplace(dir)
  const enabled = readJson(path.join(dir, 'settings.json'))?.enabledPlugins ?? {}
  const keys = Object.keys(enabled).filter(k => k.startsWith(`${PLUGIN}@`))
  if (keys.length && keys.every(k => enabled[k] === false)) return 'disabled'
  return market ? 'installed' : 'missing'
}

// Where a new account gets the plugin from: the same marketplace another account already uses (a local checkout
// stays local), else the public GitHub repo.
function pluginSource(accounts) {
  for (const a of accounts) {
    const name = installedMarketplace(a.dir)
    if (!name) continue
    const s = readJson(path.join(a.dir, 'plugins', 'known_marketplaces.json'))?.[name]?.source
    const arg = s?.source === 'github' ? s.repo : s?.source === 'directory' ? s.path : s?.url
    if (arg) return { name, arg }
  }
  return PUBLIC_MARKETPLACE
}

// The claude commands that install the plugin into one account, run with CLAUDE_CONFIG_DIR set to it.
function pluginInstallSteps(source) {
  return [
    ['plugin', 'marketplace', 'add', source.arg],
    ['plugin', 'install', `${PLUGIN}@${source.name}`],
  ]
}

// Accounts that should get the plugin without asking: those missing it, once the user runs it on another account.
function accountsMissingPlugin(accounts) {
  const states = accounts.map(a => ({ ...a, state: pluginState(a.dir) }))
  if (!states.some(a => a.state === 'installed')) return []
  return states.filter(a => a.state === 'missing' && fs.existsSync(a.dir))
}

// The claude binary inside the Claude Code extension, so installing does not depend on claude being on PATH.
function claudeBinary(claudeCodePath, platform = process.platform) {
  if (claudeCodePath) {
    const bin = path.join(claudeCodePath, 'resources', 'native-binary', platform === 'win32' ? 'claude.exe' : 'claude')
    if (fs.existsSync(bin)) return bin
  }
  return 'claude'
}

function isInside(dir, root, platform = process.platform) {
  const d = pathKey(dir, platform)
  const r = pathKey(root, platform)
  return d === r || d.startsWith(r + '/')
}

function latestStatus(p, roots, account) {
  let best = null
  let files = []
  try {
    files = fs.readdirSync(p.sessions).filter(f => f.endsWith('.json'))
  } catch {
    return null
  }
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(p.sessions, f), 'utf8'))
      if (!roots.some(r => isInside(s.cwd, r))) continue
      if (account && s.account?.name !== account) continue
      if (!best || s.updatedAt > best.updatedAt) best = s
    } catch {}
  }
  return best
}

function pruneSessions(p, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  try {
    for (const f of fs.readdirSync(p.sessions)) {
      const file = path.join(p.sessions, f)
      if (Date.now() - fs.statSync(file).mtimeMs > maxAgeMs) fs.unlinkSync(file)
    }
  } catch {}
}

// The launcher shipped for this platform: the shell scripts on macOS and Linux, the Go build on Windows, whose
// Claude Code extension starts its wrapper without a shell.
function launcherFiles(platform = process.platform) {
  return platform === 'win32'
    ? { dir: 'bin/win32', names: ['cma.exe', 'claude-launcher.exe'], wrapper: 'claude-launcher.exe' }
    : { dir: 'bin', names: ['cma', 'claude-launcher'], wrapper: 'claude-launcher' }
}

const transcripts = new Map()

function sessionTokens(file) {
  if (!file || !fs.existsSync(file)) return null
  let state = transcripts.get(file)
  if (!state) {
    state = { offset: 0, tail: '', byMessage: new Map() }
    transcripts.set(file, state)
  }
  const size = fs.statSync(file).size
  if (size < state.offset) {
    state.offset = 0
    state.tail = ''
    state.byMessage.clear()
  }
  if (size > state.offset) {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(size - state.offset)
    fs.readSync(fd, buf, 0, buf.length, state.offset)
    fs.closeSync(fd)
    state.offset = size
    const lines = (state.tail + buf.toString('utf8')).split('\n')
    state.tail = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.includes('"usage"')) continue
      try {
        const r = JSON.parse(line)
        const u = r.type === 'assistant' ? r.message?.usage : null
        if (u) state.byMessage.set(r.message.id ?? r.requestId ?? r.uuid, u)
      } catch {}
    }
  }
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const u of state.byMessage.values()) {
    t.input += u.input_tokens ?? 0
    t.output += u.output_tokens ?? 0
    t.cacheRead += u.cache_read_input_tokens ?? 0
    t.cacheWrite += u.cache_creation_input_tokens ?? 0
  }
  return t
}

function short(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

// ---- Idle sessions ----
// Claude Code writes <config dir>/sessions/<pid>.json for every running session ({pid, sessionId, cwd, status, startedAt}),
// and its transcript to <config dir>/projects/<project>/<sessionId>.jsonl. Process listing and signalling are passed in,
// so the tests never touch a real process.

// Measured on a loaded Mac over 5 seconds: idle sessions used 0.4-2.0% CPU in short bursts, working ones 3.6-21%.
// (A session waiting on the API uses little CPU too; its status, busy, is what holds it.)
const IDLE_CPU_PERCENT = 2.5
// ps reports CPU time in hundredths of a second on macOS (whole seconds on Linux), so the window is several seconds.
const CPU_SAMPLE_MS = 5000
// A pid from a session file that belongs to a process started well after that session is a reused pid.
const PID_START_SLACK_MS = 60_000

// The config directories of the known accounts, each once (an account may be a link to another).
function claudeDirs(p) {
  const seen = new Set()
  const dirs = []
  for (const a of readAccounts(p)) {
    let key = a.dir
    try {
      key = fs.realpathSync(a.dir)
    } catch {}
    if (seen.has(key)) continue
    seen.add(key)
    dirs.push(a.dir)
  }
  return dirs
}

// Every session file under the given config directories, one per pid.
function readClaudeSessions(dirs) {
  const byPid = new Map()
  for (const dir of dirs) {
    let files = []
    try {
      files = fs.readdirSync(path.join(dir, 'sessions')).filter(f => f.endsWith('.json'))
    } catch {
      continue
    }
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', f), 'utf8'))
        const pid = Number(d.pid)
        if (!Number.isInteger(pid) || pid <= 1 || byPid.has(pid)) continue
        byPid.set(pid, {
          pid,
          sessionId: typeof d.sessionId === 'string' ? d.sessionId : '',
          cwd: typeof d.cwd === 'string' ? d.cwd : '',
          status: d.status,
          startedAt: typeof d.startedAt === 'number' ? d.startedAt : null,
          dir,
        })
      } catch {}
    }
  }
  return [...byPid.values()]
}

// The latest write to a session's transcript in any of the config directories, or null when none is found.
function transcriptMtime(dirs, sessionId) {
  if (!sessionId || /[\\/]/.test(sessionId)) return null
  let latest = null
  for (const dir of dirs) {
    let projects = []
    try {
      projects = fs.readdirSync(path.join(dir, 'projects'))
    } catch {
      continue
    }
    for (const project of projects) {
      try {
        const m = fs.statSync(path.join(dir, 'projects', project, `${sessionId}.jsonl`)).mtimeMs
        if (latest === null || m > latest) latest = m
      } catch {}
    }
  }
  return latest
}

// ps durations: [[dd-]hh:]mm:ss[.cc], for both elapsed time and CPU time.
function parseDuration(text) {
  const m = /^(?:(\d+)-)?([\d:.]+)$/.exec(String(text).trim())
  if (!m) return null
  const parts = m[2].split(':').map(Number)
  if (parts.some(n => !Number.isFinite(n))) return null
  let secs = 0
  for (const n of parts) secs = secs * 60 + n
  return secs + (m[1] ? Number(m[1]) * 86400 : 0)
}

// Output of `ps -o pid=,rss=,%cpu=,etime=,time=,command=`, by pid.
function parsePs(stdout) {
  const out = new Map()
  for (const line of String(stdout).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.,]+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    const age = parseDuration(m[4])
    const cpuTime = parseDuration(m[5])
    if (age === null || cpuTime === null) continue
    out.set(Number(m[1]), {
      rssKb: Number(m[2]),
      pcpu: Number(m[3].replace(',', '.')),
      ageSec: age,
      cpuTimeSec: cpuTime,
      command: m[6].trim(),
    })
  }
  return out
}

// The real process listing (macOS and Linux). Returns an empty map when ps is not there.
function systemPs(pids) {
  if (pids.length === 0 || process.platform === 'win32') return new Map()
  try {
    const stdout = require('child_process').execFileSync(
      'ps',
      ['-o', 'pid=,rss=,%cpu=,etime=,time=,command=', '-p', pids.join(',')],
      { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return parsePs(stdout)
  } catch (err) {
    // ps exits 1 when some of the pids are gone, and still prints the rest.
    return parsePs(err.stdout ?? '')
  }
}

// A Claude Code binary: the program itself is named claude (native install, the VS Code extension's binary),
// or node or bun running Claude Code's script.
function isClaudeCommand(command) {
  const words = String(command).trim().split(/\s+/)
  if (/claude/.test(words[0] ?? '')) return true
  return /(^|\/)(node|bun)$/.test(words[0] ?? '') && /claude/.test(words[1] ?? '')
}

// The sessions of these config directories whose process is still a running claude, with RAM, age and quiet time.
function surveySessions({ dirs, ps, now = Date.now(), transcripts = true }) {
  const files = readClaudeSessions(dirs)
  const procs = ps(files.map(s => s.pid))
  const live = []
  for (const s of files) {
    const proc = procs.get(s.pid)
    if (!proc || !isClaudeCommand(proc.command)) continue
    const startedMs = now - proc.ageSec * 1000
    if (s.startedAt !== null && startedMs > s.startedAt + PID_START_SLACK_MS) continue
    const ageMs = proc.ageSec * 1000
    const last = transcripts ? transcriptMtime(dirs, s.sessionId) : null
    live.push({
      ...s,
      rssKb: proc.rssKb,
      pcpu: proc.pcpu,
      cpuTimeSec: proc.cpuTimeSec,
      command: proc.command,
      ageMs,
      transcriptAt: last,
      quietMs: last !== null ? Math.max(0, now - last) : ageMs,
    })
  }
  return live
}

function summarizeSessions(list) {
  return {
    running: list.length,
    idle: list.filter(s => s.status === 'idle').length,
    rssKb: list.reduce((t, s) => t + (s.rssKb || 0), 0),
  }
}

// CPU over a short window: CPU time used between two listings, over the nominal window (the real one is never
// shorter, so this never reads low).
async function sampleCpu(list, { ps, sleep, ms = CPU_SAMPLE_MS }) {
  if (list.length === 0) return list
  await sleep(ms)
  const after = ps(list.map(s => s.pid))
  for (const s of list) {
    const p = after.get(s.pid)
    if (!p || !isClaudeCommand(p.command)) {
      s.cpu = Infinity
      s.gone = true
      continue
    }
    const delta = Math.max(0, p.cpuTimeSec - s.cpuTimeSec)
    s.cpu = (delta / (ms / 1000)) * 100
  }
  return list
}

// Idle, with no transcript write (or, without a transcript, no process) for the threshold.
function quietPast(s, thresholdMs) {
  return s.status === 'idle' && s.quietMs >= thresholdMs && s.ageMs >= thresholdMs
}

// Why a session must not be stopped, or null when every safety rule holds. Needs a CPU sample (sampleCpu).
function autoStopBlocker(s, thresholdMs) {
  if (s.status !== 'idle') return `status ${s.status ?? 'unknown'}`
  if (s.gone) return 'process gone'
  if (!(s.cpu < IDLE_CPU_PERCENT)) return `CPU ${Number.isFinite(s.cpu) ? s.cpu.toFixed(1) + '%' : 'not sampled'}`
  if (!(s.quietMs >= thresholdMs)) return 'active recently'
  if (!(s.ageMs >= thresholdMs)) return 'started recently'
  return null
}

// Stops the chosen sessions. Each one is checked again just before the signal: still idle, still the same claude
// process, CPU still low. Returns what was stopped and what was skipped, with the reason.
async function stopSessions(chosen, { dirs, ps, kill, sleep, sampleMs = CPU_SAMPLE_MS, thresholdMs = 0, now = () => Date.now() }) {
  const wanted = new Map(chosen.map(s => [s.pid, s]))
  const fresh = surveySessions({ dirs, ps, now: now() }).filter(s => wanted.has(s.pid) && s.sessionId === wanted.get(s.pid).sessionId)
  await sampleCpu(fresh, { ps, sleep, ms: sampleMs })
  const stopped = []
  const skipped = []
  for (const s of chosen) {
    const f = fresh.find(x => x.pid === s.pid)
    const why = f ? autoStopBlocker(f, thresholdMs) : 'no longer running'
    if (why) {
      skipped.push({ ...s, reason: why })
      continue
    }
    try {
      kill(f.pid, 'SIGTERM')
      stopped.push(f)
    } catch (err) {
      skipped.push({ ...s, reason: err.code === 'ESRCH' ? 'no longer running' : err.message })
    }
  }
  return { stopped, skipped }
}

function shellQuote(s) {
  return /^[A-Za-z0-9_\/.,:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

// How to pick a stopped session up again. A session of another config directory than ~/.claude needs that directory.
function resumeCommand(s, home = os.homedir()) {
  const onDefault = !s.dir || pathKey(s.dir) === pathKey(path.join(home, '.claude'))
  const env = onDefault ? '' : `CLAUDE_CONFIG_DIR=${shellQuote(s.dir)} `
  return `cd ${shellQuote(s.cwd || home)} && ${env}claude --resume ${shellQuote(s.sessionId)}`
}

function formatRam(kb) {
  const mb = kb / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

function formatQuiet(ms) {
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min} min`
  const h = ms / 3_600_000
  return h < 48 ? `${h.toFixed(1)} h` : `${Math.floor(h / 24)} days`
}

module.exports = {
  NOT_SIGNED_IN,
  paths,
  pathKey,
  launcherFiles,
  inheritedAccount,
  expand,
  readAccounts,
  readRules,
  accountFor,
  emailOf,
  pin,
  addAccount,
  PLUGIN,
  PUBLIC_MARKETPLACE,
  pluginState,
  pluginSource,
  pluginInstallSteps,
  accountsMissingPlugin,
  claudeBinary,
  latestStatus,
  pruneSessions,
  sessionTokens,
  short,
  IDLE_CPU_PERCENT,
  CPU_SAMPLE_MS,
  claudeDirs,
  readClaudeSessions,
  transcriptMtime,
  parseDuration,
  parsePs,
  systemPs,
  isClaudeCommand,
  surveySessions,
  summarizeSessions,
  sampleCpu,
  quietPast,
  autoStopBlocker,
  stopSessions,
  resumeCommand,
  formatRam,
  formatQuiet,
}
