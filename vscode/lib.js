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
  latestStatus,
  pruneSessions,
  sessionTokens,
  short,
}
