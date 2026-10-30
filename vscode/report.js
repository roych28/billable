const fs = require('fs')
const path = require('path')

// The ledger is written by the Claude Code plugin: one file per run of a session, with the account it ran on
// and Claude Code's own cost figure for that run.
function readLedger(dir) {
  let files = []
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
  const entries = []
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (typeof e.usd === 'number' && e.account && e.startedAt) entries.push(e)
    } catch {}
  }
  return entries
}

function monthOf(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function months(entries, now = Date.now()) {
  const set = new Set(entries.map(e => monthOf(e.startedAt)))
  set.add(monthOf(now))
  return [...set].sort().reverse()
}

// The months anyone can open: this one and the one before.
function freeMonths(now = Date.now()) {
  const d = new Date(now)
  return [monthOf(now), monthOf(new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime())]
}

function summarize(entries, month) {
  const accounts = new Map()
  for (const e of entries) {
    if (monthOf(e.startedAt) !== month) continue
    let a = accounts.get(e.account)
    if (!a) {
      a = { account: e.account, email: e.email, usd: 0, sessions: new Set(), folders: new Map() }
      accounts.set(e.account, a)
    }
    a.usd += e.usd
    a.sessions.add(e.sessionId)
    const f = a.folders.get(e.folder) ?? { folder: e.folder, usd: 0, sessions: new Set() }
    f.usd += e.usd
    f.sessions.add(e.sessionId)
    a.folders.set(e.folder, f)
  }
  return [...accounts.values()]
    .sort((x, y) => y.usd - x.usd)
    .map(a => ({
      account: a.account,
      email: a.email,
      usd: a.usd,
      sessions: a.sessions.size,
      folders: [...a.folders.values()]
        .sort((x, y) => y.usd - x.usd)
        .map(f => ({ folder: f.folder, usd: f.usd, sessions: f.sessions.size })),
    }))
}

function money(usd) {
  return `$${usd.toFixed(2)}`
}

// The time as the person sees it, with the offset: the month column is in local time, so the timestamps are too,
// and a session half an hour after midnight on the 1st is billed to the new month in every column.
function localIso(ms) {
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const two = n => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}` +
    `${sign}${two(Math.floor(Math.abs(off) / 60))}:${two(Math.abs(off) % 60)}`
  )
}

function toMarkdown(summary, month, home = '') {
  // Only the home folder itself and what is inside it: /Users/me is not a prefix of /Users/meow.
  const tidy = f => (home && (f === home || f.startsWith(home + path.sep) || f.startsWith(home + '/')) ? '~' + f.slice(home.length) : f)
  const lines = [`# Claude cost by account, ${month}`, '']
  if (summary.length === 0) {
    lines.push('No sessions recorded this month yet. The Claude Code plugin records each session as it runs.')
    return lines.join('\n') + '\n'
  }
  lines.push('| Account | Email | Sessions | Cost |', '|---|---|---:|---:|')
  for (const a of summary) lines.push(`| **${a.account}** | ${a.email} | ${a.sessions} | **${money(a.usd)}** |`)
  const total = summary.reduce((s, a) => s + a.usd, 0)
  lines.push(`| Total | | ${summary.reduce((s, a) => s + a.sessions, 0)} | **${money(total)}** |`, '')
  for (const a of summary) {
    lines.push(`## ${a.account}`, '', '| Folder | Sessions | Cost |', '|---|---:|---:|')
    for (const f of a.folders) lines.push(`| ${tidy(f.folder)} | ${f.sessions} | ${money(f.usd)} |`)
    lines.push('')
  }
  lines.push(
    'Cost is Claude Code\'s own figure at API prices. On a Pro or Max plan it measures the work done, not what the plan charged.',
  )
  return lines.join('\n') + '\n'
}

function csvCell(v) {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(entries, month) {
  const rows = [['month', 'account', 'email', 'folder', 'session', 'started', 'last_active', 'usd']]
  for (const e of entries.filter(x => monthOf(x.startedAt) === month).sort((x, y) => x.startedAt - y.startedAt)) {
    rows.push([
      month,
      e.account,
      e.email,
      e.folder,
      e.sessionId,
      localIso(e.startedAt),
      // A ledger row written by another version may lack the last write; the start stands in.
      localIso(typeof e.updatedAt === 'number' ? e.updatedAt : e.startedAt),
      e.usd.toFixed(4),
    ])
  }
  return rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n'
}

module.exports = { readLedger, monthOf, months, freeMonths, summarize, toMarkdown, toCsv, localIso }
