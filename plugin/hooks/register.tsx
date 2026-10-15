import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ClaudeMultiAccountAccount, ClaudeMultiAccountInfo, ClaudeMultiAccountUsage } from '../types'

const info = atom({ plugin: 'multi-account', key: 'info' } as const, null)
const usage = atom({ plugin: 'multi-account', key: 'usage' } as const, { limits: [] })
const nextAccount = atom({ plugin: 'multi-account', key: 'next' } as const, null)
const handoff = atom({ plugin: 'multi-account', key: 'handoff' } as const, null)
const run = atom({ plugin: 'multi-account', key: 'run' } as const, null)

const HANDOFF_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000
const NOT_SIGNED_IN = 'not signed in'
const LIMIT_NAMES: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'Weekly limit' }

type Handoff = {
  sessionId: string
  account: string
  at: number
  transcript: string
  lastRequest: string
  lastAnswer: string
  summary?: string
}

type Rule = { path: string; account: string }

async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('HOME')) ?? ''
}

async function base($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDE_MULTI_ACCOUNT_HOME')) || `${await home($)}/.claude-multi-account`
}

function expand(p: string, h: string): string {
  return (p === '~' || p.startsWith('~/') ? h + p.slice(1) : p).replace(/\/+$/, '')
}

async function readLines($: EngineInterface, path: string): Promise<string[][]> {
  try {
    return (await $.fs.read(path))
      .split('\n')
      .map(l => l.trim())
      .filter(l => l !== '' && !l.startsWith('#'))
      .map(l => l.split('\t').map(f => f.trim()))
  } catch {
    return []
  }
}

async function emailOf($: EngineInterface, dir: string, h: string): Promise<string> {
  const file = dir === `${h}/.claude` ? `${h}/.claude.json` : `${dir}/.claude.json`
  try {
    const parsed = JSON.parse(await $.fs.read(file)) as { oauthAccount?: { emailAddress?: string } }
    return parsed.oauthAccount?.emailAddress ?? NOT_SIGNED_IN
  } catch {
    return NOT_SIGNED_IN
  }
}

async function accounts($: EngineInterface): Promise<ClaudeMultiAccountAccount[]> {
  const h = await home($)
  const rows = await readLines($, `${await base($)}/accounts`)
  const list = rows.filter(r => r[0] && r[1]).map(r => ({ name: r[0]!, dir: expand(r[1]!, h) }))
  const all = list.length > 0 ? list : [{ name: 'default', dir: `${h}/.claude` }]
  const out: ClaudeMultiAccountAccount[] = []
  for (const a of all) out.push({ ...a, email: await emailOf($, a.dir, h) })
  return out
}

async function rules($: EngineInterface): Promise<Rule[]> {
  const h = await home($)
  const rows = await readLines($, `${await base($)}/folders`)
  return rows.filter(r => r[0] && r[1]).map(r => ({ path: r[0] === '*' ? '*' : expand(r[0]!, h), account: r[1]! }))
}

export function accountFor(folder: string, list: Rule[]): string | null {
  let best: Rule | null = null
  for (const r of list) {
    if (r.path === '*') {
      if (!best) best = r
      continue
    }
    const matches = folder === r.path || folder.startsWith(`${r.path}/`)
    if (matches && (!best || best.path === '*' || r.path.length > best.path.length)) best = r
  }
  return best?.account ?? null
}

async function folderRoot($: EngineInterface, cwd: string): Promise<string> {
  try {
    const ran = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
    return ran.exitCode === 0 && ran.stdout.trim() ? ran.stdout.trim() : cwd
  } catch {
    return cwd
  }
}

function keyOf(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

async function loadInfo($: EngineInterface, cwd: string): Promise<ClaudeMultiAccountInfo> {
  const h = await home($)
  const list = await accounts($)
  const dir = expand((await $.env.get('CLAUDE_CONFIG_DIR')) || `${h}/.claude`, h)
  const current = list.find(a => a.dir === dir) ?? {
    name: dir.split('/').pop() ?? dir,
    dir,
    email: await emailOf($, dir, h),
  }
  const sessionId = await $.session.id()
  return {
    current,
    others: list.filter(a => a.dir !== current.dir && a.email !== NOT_SIGNED_IN),
    folder: await folderRoot($, cwd),
    transcript: `${dir}/projects/${keyOf(cwd)}/${sessionId}.jsonl`,
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)} [...]` : text
}

async function handoffPath($: EngineInterface, folder: string): Promise<string> {
  return `${await base($)}/handoff/${keyOf(folder)}.json`
}

async function readHandoff($: EngineInterface, folder: string): Promise<Handoff | null> {
  try {
    return JSON.parse(await $.fs.read(await handoffPath($, folder))) as Handoff
  } catch {
    return null
  }
}

async function writeHandoff($: EngineInterface, summary?: string): Promise<void> {
  const i = await read($, info)
  if (!i) return
  const sessionId = await $.session.id()
  const messages = await $.session.messages()
  const lastRequest = [...messages].reverse().find(m => m.role === 'user' && m.text.trim() !== '')
  const lastAnswer = [...messages].reverse().find(m => m.role === 'assistant' && m.text.trim() !== '')
  const previous = await readHandoff($, i.folder)
  const keptSummary = summary ?? (previous?.sessionId === sessionId ? previous.summary : undefined)
  const note: Handoff = {
    sessionId,
    account: i.current.name,
    at: await $.clock.now(),
    transcript: i.transcript,
    lastRequest: clip(lastRequest?.text ?? '', 2000),
    lastAnswer: clip(lastAnswer?.text ?? '', 3000),
    ...(keptSummary ? { summary: keptSummary } : {}),
  }
  await $.fs.write(await handoffPath($, i.folder), JSON.stringify(note, null, 2))
}

async function writeStatus($: EngineInterface): Promise<void> {
  const i = await read($, info)
  if (!i) return
  const sessionId = await $.session.id()
  const status = {
    sessionId,
    cwd: await $.session.cwd(),
    folder: i.folder,
    transcript: i.transcript,
    account: { name: i.current.name, email: i.current.email },
    others: i.others.map(o => ({ name: o.name, email: o.email })),
    usage: await read($, usage),
    next: await read($, nextAccount),
    updatedAt: await $.clock.now(),
  }
  await $.fs.write(`${await base($)}/sessions/${sessionId}.json`, JSON.stringify(status))
  await writeLedger($, sessionId, i, status.usage, status.updatedAt)
}

// One ledger entry per run of a session, so a session resumed on another account is billed to each account
// for its own part. The cost counts from the run's start, whether or not Claude Code restores it on resume.
async function writeLedger(
  $: EngineInterface,
  sessionId: string,
  i: ClaudeMultiAccountInfo,
  u: ClaudeMultiAccountUsage,
  now: number,
): Promise<void> {
  const r = await read($, run)
  if (!r || u.usd === undefined) return
  const entry = {
    sessionId,
    account: i.current.name,
    email: i.current.email,
    folder: i.folder,
    startedAt: r.startedAt,
    updatedAt: now,
    usd: Math.max(0, u.usd - r.startUsd),
  }
  await $.fs.write(`${await base($)}/ledger/${sessionId}-${r.startedAt}.json`, JSON.stringify(entry))
}

function handoffPrompt(note: Handoff): string {
  return [
    '# Where the previous session in this folder stopped',
    `Session ${note.sessionId} on the ${note.account} account, last active ${new Date(note.at).toISOString()}.`,
    'If the person continues earlier work, pick up from here without asking them to repeat it; if they start something new, ignore this.',
    `Full transcript (JSONL, read its tail for more detail): ${note.transcript}`,
    '',
    'Last request from the person:',
    note.lastRequest || '(none)',
    '',
    'Last answer:',
    note.lastAnswer || '(none)',
    ...(note.summary ? ['', 'Handoff summary written when the account was switched:', note.summary] : []),
  ].join('\n')
}

const SUMMARY_PROMPT =
  'The person is moving this work to another Claude account; a fresh session will continue from a note. ' +
  'Write that handoff note in the language of the conversation, under 300 words: the goal, what is done ' +
  '(with full file paths and commits), what is in progress, the exact next step, and open questions. ' +
  'No secrets, keys or tokens. Reply with the note only.'

async function pin($: EngineInterface, folder: string, name: string): Promise<void> {
  const path = `${await base($)}/folders`
  let lines: string[] = []
  try {
    lines = (await $.fs.read(path)).split('\n').filter(l => l.trim() !== '')
  } catch {}
  const h = await home($)
  const kept = lines.filter(l => {
    const first = l.split('\t')[0]?.trim() ?? ''
    return l.trim().startsWith('#') || first === '*' || expand(first, h) !== folder
  })
  if (name !== 'auto') kept.push(`${folder}\t${name}`)
  await $.fs.write(path, kept.join('\n') + '\n')
}

async function switchTo($: EngineInterface, name: string): Promise<string> {
  const i = await read($, info)
  if (!i) return 'Not ready yet.'
  const list = await accounts($)
  if (name !== 'auto' && !list.some(a => a.name === name)) {
    return `Unknown account: ${name}. Known: ${list.map(a => a.name).join(', ')}, or auto.`
  }
  await pin($, i.folder, name)
  const next = accountFor(i.folder, await rules($))
  await update($, nextAccount, () => next)

  const fork = await $.model.fork({ prompt: SUMMARY_PROMPT })
  let note = ''
  if (fork.isAnswered) {
    await writeHandoff($, fork.text.trim())
  } else {
    await writeHandoff($)
    note = `\nNo handoff summary (${fork.reason}): the next session gets the last request, the last answer and the transcript path.`
    $.ui.toast(`Handoff summary not written (${fork.reason})`)
  }
  await writeStatus($)
  return (
    `${i.folder} now runs on ${next ?? 'the default account'}.${note}\n` +
    'To continue from here: open a new Claude tab, or exit and run claude --continue in this folder.'
  )
}

function usageLine(u: ClaudeMultiAccountUsage): string {
  const cost = `Session cost ${u.usd === undefined ? 'unknown' : `$${u.usd.toFixed(2)}`}`
  return [cost, ...u.limits.map(l => `${LIMIT_NAMES[l.kind] ?? l.kind} ${l.percentUsed}%`)].join('  ·  ')
}

function statusText(i: ClaudeMultiAccountInfo, u: ClaudeMultiAccountUsage, next: string | null): string {
  const lines = [
    `Account: ${i.current.name} (${i.current.email})`,
    `Other accounts: ${i.others.map(o => `${o.name} (${o.email})`).join(', ') || 'none signed in'}`,
    usageLine(u),
  ]
  if (next && next !== i.current.name) lines.push(`The next session in ${i.folder} runs on ${next}.`)
  lines.push('Switch with /account <name>, or /account auto for the default.')
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const loaded = await loadInfo($, e.cwd)
    await update($, info, () => loaded)
    await update($, nextAccount, () => null)

    const now = await $.session.usage()
    await update($, usage, () => ({
      usd: now.cost?.usd,
      limits: now.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed })),
    }))
    const startedAt = await $.clock.now()
    await update($, run, () => ({ startedAt, startUsd: now.cost?.usd ?? 0 }))

    const names = (await accounts($)).map(a => a.name)
    await $.command.register({
      name: 'account',
      description: 'Show the Claude account, cost and limits; /account <name> switches this folder',
      argumentHint: `[${[...names, 'auto'].join('|')}]`,
    })

    const isFresh = (await $.session.messages()).length === 0
    const note = await readHandoff($, loaded.folder)
    const sessionId = await $.session.id()
    const isRecent = note !== null && (await $.clock.now()) - note.at < HANDOFF_MAX_AGE_MS
    if (isFresh && note && isRecent && note.sessionId !== sessionId) {
      await update($, handoff, () => handoffPrompt(note))
    }
    await writeStatus($)

    if ((await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-vscode') {
      const text = `Claude account: ${loaded.current.name} (${loaded.current.email})`
      $.ui.status(text)
      try {
        await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
      } catch (err) {
        $.ui.toast(`${text}. The notice could not be added: ${String(err)}`)
      }
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    const text = await read($, handoff)
    if (!text) return next(e)
    await update($, handoff, () => null)
    return next({ ...e, context: [...(e.context ?? []), text] })
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => ({
      usd: e.cost?.usd,
      limits: e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed })),
    }))
    await writeStatus($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      try {
        await writeHandoff($)
      } catch (err) {
        $.ui.toast(`Handoff note not saved: ${String(err)}`)
      }
    }
    await writeStatus($)
    return done
  })

  on('command.run', { command: 'account' }, async ($, e) => {
    const name = e.args.trim()
    if (name) return { text: await switchTo($, name) }
    const i = (await read($, info)) ?? (await loadInfo($, await $.session.cwd()))
    return { text: statusText(i, await read($, usage), await read($, nextAccount)) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    if ((await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-vscode') return next(e)
    const i = await read($, info)
    if (!i) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const u = await read($, usage)
    const pending = await read($, nextAccount)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold>{i.current.name}</Text>
          <Text dimColor>  {i.current.email}</Text>
        </Box>
        {i.others.length > 0 && (
          <Box flexDirection="row">
            <Text dimColor>Switch to  </Text>
            {i.others.map(o => (
              <Button
                key={`switch-${o.name}`}
                label={o.name}
                onPress={async () => {
                  const result = await switchTo($, o.name)
                  $.ui.toast(result.split('\n')[0] ?? result)
                }}
              />
            ))}
          </Box>
        )}
        {pending && pending !== i.current.name && (
          <Text color="yellow">The next session in this folder runs on {pending}</Text>
        )}
        <Text dimColor>{usageLine(u)}</Text>
      </Box>
    )
  })
}
