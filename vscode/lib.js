const fs = require('fs')
const os = require('os')
const path = require('path')

const NOT_SIGNED_IN = 'not signed in'

function paths(home = os.homedir(), env = process.env) {
  // A relative CLAUDE_MULTI_ACCOUNT_HOME is taken from the home folder, in the launchers and the plugin too: each runs
  // in another working folder, and they must all read the same files.
  const set = env.CLAUDE_MULTI_ACCOUNT_HOME
  const base = set ? path.resolve(home, set) : path.join(home, '.claude-multi-account')
  return {
    home,
    base,
    accounts: path.join(base, 'accounts'),
    folders: path.join(base, 'folders'),
    sessions: path.join(base, 'sessions'),
    ledger: path.join(base, 'ledger'),
    sync: path.join(base, 'sync'),
    bin: path.join(base, 'bin'),
  }
}

function expand(p, home) {
  const full = p === '~' ? home : p.startsWith('~/') || p.startsWith('~\\') ? path.join(home, p.slice(2)) : p
  return full.replace(/[\\/]+$/, '')
}

// A tab-separated file edited by hand too: a BOM, CRLF line endings and spaces around the fields are all tolerated,
// here and in the launchers (bin/cma, launcher/main.go), which must read it the same way.
function readRows(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .replace(/^﻿/, '')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => l.split('\t').map(f => f.trim()))
      .filter(r => r[0] && r[1])
  } catch {
    return []
  }
}

// A name listed twice counts once, the first line wins: the launchers resolve a name to its first line too.
function readAccounts(p) {
  const seen = new Set()
  const rows = readRows(p.accounts)
    .filter(r => !seen.has(r[0]) && seen.add(r[0]))
    .map(r => ({ name: r[0], dir: expand(r[1], p.home) }))
  return rows.length ? rows : [{ name: 'default', dir: path.join(p.home, '.claude') }]
}

// Whether two folders are the same place on disk: through links too, and by spelling when neither exists yet.
function sameDir(a, b) {
  const real = d => {
    try {
      return fs.realpathSync(d)
    } catch {
      return d
    }
  }
  return pathKey(real(a)) === pathKey(real(b))
}

function readRules(p) {
  return readRows(p.folders).map(r => ({ path: r[0] === '*' ? '*' : expand(r[0], p.home), account: r[1] }))
}

// How two paths are compared: forward slashes, no trailing slash, and case-insensitive on Windows.
function pathKey(p, platform = process.platform) {
  const k = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'win32' ? k.toLowerCase() : k
}

// The account of the longest rule containing the folder, else the "*" rule. `folder` may be a list of spellings of one
// folder (its path and its real path): the longest rule containing any of them wins, as in the launchers.
function accountFor(folder, rules, platform = process.platform) {
  const fs_ = (Array.isArray(folder) ? folder : [folder]).map(f => pathKey(f, platform))
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
    if (fs_.some(f => f === p || f.startsWith(p + '/')) && p.length > bestLen) {
      best = r
      bestLen = p.length
    }
  }
  return best ? best.account : null
}

function emailOf(dir, home) {
  const file = pathKey(dir) === pathKey(path.join(home, '.claude')) ? path.join(home, '.claude.json') : path.join(dir, '.claude.json')
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

// Edits of accounts, folders and sync run one window at a time: two windows writing at once would each drop the
// other's line. Waits briefly for another window; the file is replaced in one step, so a reader never sees half of it.
function editConfig(p, fn) {
  const lock = path.join(p.base, 'config.lock')
  let release = null
  for (let i = 0; i < 100 && !(release = acquireLock(lock, { staleMs: 10_000 })); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  if (!release) throw new Error('Another VS Code window is changing the Billable settings. Try again in a moment.')
  try {
    return fn()
  } finally {
    release()
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

function pin(p, folder, name, platform = process.platform) {
  fs.mkdirSync(p.base, { recursive: true })
  return editConfig(p, () => pinNow(p, folder, name, platform))
}

function pinNow(p, folder, name, platform) {
  let lines = []
  try {
    lines = fs.readFileSync(p.folders, 'utf8').split('\n').filter(l => l.trim())
  } catch {}
  const kept = lines.filter(l => {
    const first = (l.split('\t')[0] || '').trim()
    return l.trim().startsWith('#') || first === '*' || pathKey(expand(first, p.home), platform) !== pathKey(folder, platform)
  })
  if (name !== 'auto') kept.push(`${folder}\t${name}`)
  writeAtomic(p.folders, kept.join('\n') + '\n')
}

// Drops the folder's own rule, and the rule of its real path when it was opened through a link: "Use default".
function unpin(p, folder) {
  fs.mkdirSync(p.base, { recursive: true })
  editConfig(p, () => {
    pinNow(p, folder, 'auto', process.platform)
    const real = realPath(folder)
    if (pathKey(real) !== pathKey(folder)) pinNow(p, real, 'auto', process.platform)
  })
}

function addAccount(p, name, dir) {
  fs.mkdirSync(p.base, { recursive: true })
  // The folder first: a line for an account whose folder could not be made would block its name for good.
  fs.mkdirSync(expand(dir, p.home), { recursive: true })
  editConfig(p, () => {
    let text = ''
    try {
      text = fs.readFileSync(p.accounts, 'utf8')
    } catch {}
    const rows = readRows(p.accounts)
    if (rows.some(r => r[0] === name)) throw new Error(`An account named ${name} already exists`)
    if (text && !text.endsWith('\n')) text += '\n'
    // The first account added also lists the default one; comments already in the file stay.
    if (rows.length === 0) text = `default\t~/.claude\n${text}`
    writeAtomic(p.accounts, `${text}${name}\t${dir}\n`)
  })
}

// Why an account must not be removed, or null. Removing it sends its folder to the trash, so never the account the
// others share with, ~/.claude itself, a folder another account uses too, or one that holds the home or Billable folder.
function removeBlocker(p, name) {
  const accounts = readAccounts(p)
  const a = readRows(p.accounts).some(r => r[0] === name) ? accounts.find(x => x.name === name) : null
  if (!a) return `There is no account named ${name}`
  if (a === shareSource(accounts)) return `${name} is the default account and cannot be removed`
  const key = pathKey(a.dir)
  if (key === pathKey(path.join(p.home, '.claude'))) return `${name} runs on ~/.claude, Claude Code's own folder, and cannot be removed`
  if (accounts.some(x => x !== a && pathKey(x.dir) === key)) return `${name} uses the same folder as another account`
  if (isInside(p.home, a.dir) || isInside(p.base, a.dir)) return `${name}'s folder holds your home or Billable folder`
  return null
}

// Drops the account and every folder rule that runs on it; its folder is left for the caller.
function removeAccount(p, name) {
  return editConfig(p, () => removeAccountNow(p, name))
}

function removeAccountNow(p, name) {
  const blocker = removeBlocker(p, name)
  if (blocker) throw new Error(blocker)
  const keep = file => {
    let lines = []
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim())
    } catch {}
    return lines.filter(l => l.trim().startsWith('#') || (l.split('\t')[1] || '').trim() !== name)
  }
  writeAtomic(p.accounts, keep(p.accounts).filter(l => (l.split('\t')[0] || '').trim() !== name).join('\n') + '\n')
  if (fs.existsSync(p.folders)) writeAtomic(p.folders, keep(p.folders).join('\n') + '\n')
  if (fs.existsSync(p.sync)) writeShareNow(p, name, 'none')
}

// ---- Sharing with the default account ----
// An account can share what it keeps in its config dir with the default one: each shared item becomes a link to the
// default account's copy. The sign-in (.claude.json and the keychain entry) is never shared. The choice is kept in the
// `sync` file, name<TAB>level, so it can be applied again when Claude Code replaces a link with a file of its own.

// Conversations and memory (projects/<folder>/memory sits next to the transcripts), the prompt history, the
// checkpoints a resumed conversation rewinds to, and your own CLAUDE.md.
const CONVERSATIONS = ['projects', 'file-history', 'todos']
const SHARE_ITEMS = {
  memory: [...CONVERSATIONS, 'history.jsonl', 'CLAUDE.md'],
  all: [...CONVERSATIONS, 'history.jsonl', 'CLAUDE.md', 'settings.json', 'keybindings.json', 'plugins', 'commands', 'agents', 'skills', 'output-styles'],
}
const SHARE_LEVELS = ['none', 'memory', 'all']
const FILE_ITEMS = new Set(['history.jsonl', 'CLAUDE.md', 'settings.json', 'keybindings.json'])

// The account the others share with: the one named default, else the first.
function shareSource(accounts) {
  return accounts.find(a => a.name === 'default') ?? accounts[0]
}

function readShares(p) {
  return new Map(readRows(p.sync).filter(r => SHARE_LEVELS.includes(r[1])).map(r => [r[0], r[1]]))
}

function shareLevel(p, name) {
  return readShares(p).get(name) ?? 'none'
}

function writeShare(p, name, level) {
  fs.mkdirSync(p.base, { recursive: true })
  return editConfig(p, () => writeShareNow(p, name, level))
}

function writeShareNow(p, name, level) {
  let lines = []
  try {
    lines = fs.readFileSync(p.sync, 'utf8').split('\n').filter(l => l.trim())
  } catch {}
  const kept = lines.filter(l => l.trim().startsWith('#') || (l.split('\t')[0] || '').trim() !== name)
  if (level !== 'none') kept.push(`${name}\t${level}`)
  writeAtomic(p.sync, kept.length ? kept.join('\n') + '\n' : '')
}

function lstat(file) {
  try {
    return fs.lstatSync(file)
  } catch {
    return null
  }
}

// A link at `file` that points at `target`: by where both resolve, or, when the target is gone (the source deleted
// its CLAUDE.md), by the path written in the link. A dangling link Billable made is still Billable's link.
function linksTo(file, target) {
  const s = lstat(file)
  if (!s?.isSymbolicLink()) return false
  try {
    if (fs.realpathSync(file) === fs.realpathSync(target)) return true
  } catch {}
  try {
    const written = path.resolve(path.dirname(file), fs.readlinkSync(file))
    return pathKey(written) === pathKey(path.resolve(target))
  } catch {
    return false
  }
}

// Whether a link of this kind can be made in this folder: on Windows a file link needs Developer Mode, a junction
// does not; some file systems allow neither. Found out before anything is moved for it.
function canLink(dir, isDir, platform = process.platform) {
  const probe = path.join(dir, `.billable-link-probe-${process.pid}`)
  try {
    fs.rmSync(probe, { force: true })
    makeLink(dir, probe, isDir, platform)
    fs.unlinkSync(probe)
    return null
  } catch (err) {
    fs.rmSync(probe, { force: true })
    return platform === 'win32' && !isDir ? `${err.message} (on Windows, turn on Developer Mode to allow file links)` : err.message
  }
}

// Moves what src has and dst lacks into dst, folder by folder. What both have stays in src.
function mergeInto(src, dst) {
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name)
    const to = path.join(dst, name)
    const there = lstat(to)
    if (!there) fs.renameSync(from, to)
    else if (there.isDirectory() && lstat(from).isDirectory()) {
      mergeInto(from, to)
      if (fs.readdirSync(from).length === 0) fs.rmdirSync(from)
    }
  }
}

function makeLink(target, file, isDir, platform = process.platform) {
  fs.symlinkSync(target, file, platform === 'win32' ? (isDir ? 'junction' : 'file') : undefined)
}

// Links each item of the level from the account's dir to the source's, and puts back the items the level no longer
// shares. What the account had is merged into the source where the source lacks it; the rest goes to a backup folder
// in the account's dir. Running it again changes nothing. Returns { linked, unlinked, backup, errors }.
function applyShare(accountDir, sourceDir, level, { platform = process.platform, now = Date.now() } = {}) {
  const wanted = new Set(SHARE_ITEMS[level] ?? [])
  const result = { linked: [], unlinked: [], backup: null, errors: [] }
  // Sharing a folder with itself would move its conversations away and leave a link pointing at itself.
  if (sameDir(accountDir, sourceDir)) {
    result.errors.push('the account runs on the same folder as the account it would share with')
    return result
  }
  const backupDir = path.join(accountDir, `billable-backup-${new Date(now).toISOString().replace(/[:.]/g, '-')}`)
  fs.mkdirSync(accountDir, { recursive: true })
  const linkable = { dir: undefined, file: undefined }
  const linkBlocker = isDir => {
    const k = isDir ? 'dir' : 'file'
    if (linkable[k] === undefined) linkable[k] = canLink(accountDir, isDir, platform)
    return linkable[k]
  }
  for (const name of new Set(Object.values(SHARE_ITEMS).flat())) {
    const own = path.join(accountDir, name)
    const shared = path.join(sourceDir, name)
    const isDir = !FILE_ITEMS.has(name)
    // What this item moved, so a failure after it puts it back.
    const moved = []
    const move = (from, to) => {
      fs.renameSync(from, to)
      moved.push([to, from])
    }
    const backup = (from, name) => {
      fs.mkdirSync(backupDir, { recursive: true })
      move(from, path.join(backupDir, name))
      result.backup = backupDir
    }
    try {
      if (!wanted.has(name)) {
        if (!linksTo(own, shared)) continue
        fs.unlinkSync(own)
        // Conversations stay with the source; settings and tools are copied, so the account keeps working as before.
        if (!CONVERSATIONS.includes(name) && lstat(shared)) fs.cpSync(shared, own, { recursive: true, verbatimSymlinks: true })
        result.unlinked.push(name)
        continue
      }
      if (linksTo(own, shared)) {
        // Billable's own link, but the source lost the folder it points at: the folder comes back.
        if (isDir && !lstat(shared)) fs.mkdirSync(shared, { recursive: true })
        continue
      }
      const mine = lstat(own)
      if (mine?.isSymbolicLink()) {
        result.errors.push(`${name} already links to ${fs.readlinkSync(own)}`)
        continue
      }
      const blocker = linkBlocker(isDir)
      if (blocker) {
        result.errors.push(`${name}: cannot make a link here, ${blocker}`)
        continue
      }
      if (!lstat(shared)) {
        if (mine) move(own, shared)
        else if (isDir) fs.mkdirSync(shared, { recursive: true })
        // A file neither has: linked once the source has it.
        else continue
      } else if (mine) {
        if (isDir && mine.isDirectory()) {
          mergeInto(own, shared)
          if (fs.readdirSync(own).length === 0) fs.rmdirSync(own)
          else backup(own, name)
        } else backup(own, name)
      }
      try {
        makeLink(shared, own, isDir, platform)
      } catch (err) {
        for (const [from, to] of moved.reverse()) fs.renameSync(from, to)
        throw err
      }
      result.linked.push(name)
    } catch (err) {
      result.errors.push(`${name}: ${err.message}`)
    }
  }
  return result
}

// Runs fn while holding a lock file, or returns null at once when another window holds it. VS Code restores
// several windows together, and each would otherwise move the same files at the same time.
function withLock(file, fn, { staleMs = 60_000 } = {}) {
  const release = acquireLock(file, { staleMs })
  if (!release) return null
  try {
    return fn()
  } finally {
    release()
  }
}

// Takes the lock file, or returns null when another window holds it. The caller releases it, so work that waits on
// something (a plugin install) can hold it too. Returns the release function.
function acquireLock(file, { staleMs = 60_000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let fd
  try {
    fd = fs.openSync(file, 'wx')
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    // A window that died holding it leaves it behind. A time in the future (a clock that was put right) is stale too.
    if (Math.abs(Date.now() - (lstat(file)?.mtimeMs ?? 0)) < staleMs) return null
    fs.rmSync(file, { force: true })
    try {
      fd = fs.openSync(file, 'wx')
    } catch {
      return null
    }
  }
  return () => {
    fs.closeSync(fd)
    fs.rmSync(file, { force: true })
  }
}

function shareLock(p) {
  return path.join(p.base, 'sync.lock')
}

// Applies every saved choice again: Claude Code may have replaced a link with a file of its own, and accounts that
// share with the source need the items it has gained since. Another window doing it already returns [].
function applyShares(p) {
  return (
    withLock(shareLock(p), () => {
      const accounts = readAccounts(p)
      const source = shareSource(accounts)
      const out = []
      for (const [name, level] of readShares(p)) {
        const a = accounts.find(x => x.name === name)
        if (!a || a === source || sameDir(a.dir, source.dir) || !fs.existsSync(a.dir)) continue
        out.push({ name, ...applyShare(a.dir, source.dir, level) })
      }
      return out
    }) ?? []
  )
}

// claude opens the sign-in page with $BROWSER when it is set; a command that does nothing leaves
// the link and the code prompt in the terminal. Not on Windows, where no such command is assumed.
function noBrowserEnv(platform = process.platform) {
  return platform === 'win32' ? {} : { BROWSER: '/usr/bin/true' }
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

// Accounts to offer the plugin to, when it runs on none of them and was turned off on none: a first install, which
// is asked for rather than done.
function accountsToOfferPlugin(accounts) {
  const states = accounts.map(a => ({ ...a, state: pluginState(a.dir) }))
  if (states.some(a => a.state !== 'missing')) return []
  return states.filter(a => fs.existsSync(a.dir))
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
  // A root written as `/` reaches here empty; on Windows it is the drive root and holds everything too.
  return r === '' || d === r || d.startsWith(r + '/')
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
      // A status from another version, or half written, says nothing the view can use.
      if (typeof s.cwd !== 'string' || typeof s.account?.name !== 'string') continue
      if (!roots.some(r => isInside(s.cwd, r))) continue
      if (account && s.account.name !== account) continue
      if (!best || s.updatedAt > best.updatedAt) best = s
    } catch {}
  }
  return best
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// Whether a Claude Code session still runs. Claude Code keeps sessions/<pid>.json in the config dir while a session
// runs; without that folder (older versions) the session is taken as open, since nothing says otherwise.
function sessionOpen(dir, sessionId, alive = pidAlive) {
  let files
  try {
    files = fs.readdirSync(path.join(dir, 'sessions')).filter(f => f.endsWith('.json'))
  } catch {
    return true
  }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', f), 'utf8'))
      if (d.sessionId === sessionId && Number.isInteger(Number(d.pid)) && alive(Number(d.pid))) return true
    } catch {}
  }
  return false
}

// What the status bar shows: the account the folder is set to, so a switch shows at once, usage from the latest
// session on that account, and a conversation still open on another account. Claude Code runs a window's
// conversations in its first folder, so in a multi-root workspace all of it comes from that folder alone.
function realPath(folder) {
  try {
    return fs.realpathSync(folder)
  } catch {
    return folder
  }
}

// The account a new Claude Code tab in this folder really runs on, as the launchers decide it: the folder's rule (or
// its real path's, opened through a link) when it names a known account; otherwise the launcher changes nothing, so
// the tab runs on CLAUDE_CONFIG_DIR when VS Code has one, else on ~/.claude. Returns { name, dir }; name is the
// listed account's, or the folder's own name when no listed account runs there.
function launchedAccount(p, folder, rules, accounts, env = process.env) {
  const ruled = accountFor([folder, realPath(folder)], rules)
  const named = accounts.find(a => a.name === ruled)
  if (named) return named
  const dir = env.CLAUDE_CONFIG_DIR ? expand(env.CLAUDE_CONFIG_DIR, p.home) : path.join(p.home, '.claude')
  const listed = accounts.find(a => pathKey(a.dir) === pathKey(dir))
  if (listed) return listed
  return { name: pathKey(dir) === pathKey(path.join(p.home, '.claude')) ? '~/.claude' : dir, dir }
}

// Where "Use default" sends the folder: null when it has no rule of its own (on its path or its real path).
function useDefaultTarget(p, folder, env = process.env) {
  const rules = readRules(p)
  const own = new Set([pathKey(folder), pathKey(realPath(folder))])
  const kept = rules.filter(r => r.path === '*' || !own.has(pathKey(r.path)))
  if (kept.length === rules.length) return null
  return launchedAccount(p, folder, kept, readAccounts(p), env).name
}

function folderView(p, roots, env = process.env) {
  if (roots.length === 0) return null
  const folder = roots[0]
  const accounts = readAccounts(p)
  const rules = readRules(p)
  // The launchers resolve the folder's real path when its own has no rule: a workspace opened through a link.
  const real = realPath(folder)
  const places = pathKey(real) === pathKey(folder) ? [folder] : [folder, real]
  const latest = latestStatus(p, places)
  const current = launchedAccount(p, folder, rules, accounts, env)
  const currentName = current.name
  const status = latestStatus(p, places, currentName)
  // The sign-in the account has now, not the one its last session ran as: a "Sign in again" shows at once.
  const email = emailOf(current.dir, p.home)
  // Only while that conversation is still open: once it is closed, nothing runs on the old account. A status of an
  // account that was removed since is not an open chat either.
  const oldDir = latest && accounts.find(a => a.name === latest.account.name)?.dir
  const stillOpen = Boolean(oldDir) && sessionOpen(oldDir, latest.sessionId)
  const openOn = latest && latest.account.name !== currentName && stillOpen ? latest.account.name : null
  return { folder, accounts, status, openOn, currentName, email, listed: accounts.includes(current) }
}

// Accounts signed in as the same Claude account. A sign-in typed in a terminal goes to the folder's account, so
// signing in "the new one" from the wrong folder silently replaces another account's sign-in.
function sharedSignIns(p, accounts) {
  const byEmail = new Map()
  for (const a of accounts) {
    const email = emailOf(a.dir, p.home)
    if (email === NOT_SIGNED_IN) continue
    const key = email.toLowerCase()
    if (!byEmail.has(key)) byEmail.set(key, { email, names: [] })
    byEmail.get(key).names.push(a.name)
  }
  return [...byEmail.values()].filter(s => s.names.length > 1)
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
const TRANSCRIPT_CHUNK = 8 * 1024 * 1024

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
    // In pieces: a transcript can be hundreds of MB, and one string of it all would not fit.
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(Math.min(TRANSCRIPT_CHUNK, size - state.offset))
      while (state.offset < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - state.offset), state.offset)
        if (n <= 0) break
        state.offset += n
        const lines = (state.tail + buf.toString('utf8', 0, n)).split('\n')
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
    } finally {
      fs.closeSync(fd)
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
  // 999,500 rounds to 1.0M, not 1000K.
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1)}M`
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
  const program = words[0] ?? ''
  const base = program.split(/[\\/]/).pop()
  // The program is claude itself, or a versioned install (~/.local/share/claude/versions/<v>) of it.
  // Case matters: the desktop app's binary is Claude, and it is not a session.
  if (/^claude(\.exe)?$/.test(base) || /(^|[\\/])claude[\\/]versions[\\/][^\\/]+$/.test(program)) return true
  // node or bun running Claude Code's script: a path segment that is claude or claude-code, not a folder merely
  // named after it (a project called claude-multi-account runs vitest, not Claude).
  return /(^|[\\/])(node|bun)(\.exe)?$/i.test(program) && /(^|[\\/])(claude|claude-code|claude\.m?js)([\\/]|$)/.test(words[1] ?? '')
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

// Copies the launcher files that changed. One in use (Windows locks a running exe) is left as it is when it is already
// this version, and reported when it is not. Returns { updated, errors }.
function installLauncher(srcDir, binDir, files = launcherFiles()) {
  fs.mkdirSync(binDir, { recursive: true })
  const out = { updated: [], errors: [] }
  for (const name of files.names) {
    const from = path.join(srcDir, files.dir, name)
    const to = path.join(binDir, name)
    try {
      const fresh = fs.readFileSync(from)
      let same = false
      try {
        same = fresh.equals(fs.readFileSync(to))
      } catch {}
      if (same) continue
      fs.copyFileSync(from, to)
      fs.chmodSync(to, 0o755)
      out.updated.push(name)
    } catch (err) {
      out.errors.push(`${name}: ${err.message}`)
    }
  }
  return out
}

// Whether a program is on PATH (a bare name the sign-in terminal would run).
function onPath(name, env = process.env, platform = process.platform) {
  if (path.isAbsolute(name)) return fs.existsSync(name)
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) if (fs.existsSync(path.join(dir, name + ext))) return true
  }
  return false
}

// A plugin install that failed for an account is tried again after a day, not on every window that opens.
const HEAL_RETRY_MS = 24 * 60 * 60 * 1000
function healFailures(p) {
  return readJson(path.join(p.base, 'plugin-heal.json')) ?? {}
}
function healDue(p, dir, now = Date.now()) {
  const at = healFailures(p)[pathKey(dir)]
  return !(typeof at === 'number' && now - at < HEAL_RETRY_MS && now >= at)
}
function healFailed(p, dir, now = Date.now()) {
  const all = healFailures(p)
  all[pathKey(dir)] = now
  fs.mkdirSync(p.base, { recursive: true })
  fs.writeFileSync(path.join(p.base, 'plugin-heal.json'), JSON.stringify(all))
}
function healSucceeded(p, dir) {
  const all = healFailures(p)
  if (!(pathKey(dir) in all)) return
  delete all[pathKey(dir)]
  fs.writeFileSync(path.join(p.base, 'plugin-heal.json'), JSON.stringify(all))
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
  sameDir,
  canLink,
  installLauncher,
  onPath,
  healDue,
  healFailed,
  healSucceeded,
  emailOf,
  pin,
  unpin,
  useDefaultTarget,
  launchedAccount,
  addAccount,
  removeBlocker,
  removeAccount,
  SHARE_ITEMS,
  SHARE_LEVELS,
  shareSource,
  readShares,
  shareLevel,
  writeShare,
  applyShare,
  applyShares,
  withLock,
  acquireLock,
  shareLock,
  noBrowserEnv,
  PLUGIN,
  PUBLIC_MARKETPLACE,
  pluginState,
  pluginSource,
  pluginInstallSteps,
  accountsMissingPlugin,
  accountsToOfferPlugin,
  claudeBinary,
  latestStatus,
  sessionOpen,
  folderView,
  sharedSignIns,
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
