import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { accountFor, expand, pinTarget, resolveBase } from '../hooks/register'

const HOME = '/Users/tester'
const CWD = `${HOME}/code/app`
const BASE = `${HOME}/.claude-multi-account`
const HANDOFF = `${BASE}/handoff/-Users-tester-code-app.json`

// Every argument hint /account was registered with, across the tests.
const hints: string[] = []

const ACCOUNTS = [
  'personal\t~/.claude',
  'acme\t~/.claude-acme',
  'globex\t~/.claude-globex',
].join('\n')

function world(
  on: On,
  files: Record<string, string>,
  sessionId: string,
  seen: (readonly string[] | undefined)[] = [],
  env: Record<string, string> = {},
  root: string = CWD,
) {
  on('prompt.submit', ($, e) => {
    seen.push(e.context)
    return { text: e.text, context: e.context }
  })
  mock.env(on, { HOME, CLAUDE_CONFIG_DIR: `${HOME}/.claude-acme`, ...env })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('fs.read', ($, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: `${root}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: sessionId }))
  on('session.messages', () => ({ value: [] }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 23 }],
      cost: { usd: 1.5 },
    },
  }))
  on('command.register', ($, e) => {
    hints.push(String(e.argumentHint))
    return { value: { command: e.name } }
  })
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return clock
}

function signedIn(): Record<string, string> {
  return {
    [`${BASE}/accounts`]: ACCOUNTS,
    [`${HOME}/.claude.json`]: JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }),
    [`${HOME}/.claude-acme/.claude.json`]: JSON.stringify({ oauthAccount: { emailAddress: 'me@acme.test' } }),
  }
}

async function start($: Engine) {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
}

const BAND = {
  plugin: 'multi-account',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('the band shows the account first, then a switch for each signed-in account, in English', async ($, on) => {
  const files = signedIn()
  world(on, files, 's-1')
  await start($)

  const status = JSON.parse(files[`${BASE}/sessions/s-1.json`] ?? '{}')
  expect(status.account).toEqual({ name: 'acme', email: 'me@acme.test' })
  expect(status.transcript).toBe(`${HOME}/.claude-acme/projects/-Users-tester-code-app/s-1.jsonl`)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'acme' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'me@acme.test' })).toBeDefined()
    expect(await ui.find({ key: 'switch-personal' })).toBeDefined()
    expect(await ui.find({ key: 'switch-globex' })).toBeUndefined()
    expect(await ui.find({ key: 'switch-acme' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Session cost \$1\.50 {2}· {2}5-hour limit 23%/ })).toBeDefined()
    await ui.unmount()
  }
})

test('inside VS Code the account is a status line, not a band', async ($, on) => {
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, 'the engine band') as RenderElement
  })
  world(on, signedIn(), 's-6', [], { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' })
  await start($)
  expect(statuses).toContain('Claude account: acme (me@acme.test)')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'the engine band' })).toBeDefined()
  expect(await ui.find({ key: 'switch-personal' })).toBeUndefined()
  await ui.unmount()
})

test('inside VS Code the account line follows a switch made outside the session, and new accounts that sign in', async ($, on) => {
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  const files = signedIn()
  const clock = world(on, files, 's-9', [], { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' })
  await start($)
  expect(statuses).toEqual(['Claude account: acme (me@acme.test)'])

  // The VS Code status bar pins the folder to personal, and globex signs in.
  files[`${BASE}/folders`] = `${CWD}\tpersonal\n`
  files[`${HOME}/.claude-globex/.claude.json`] = JSON.stringify({ oauthAccount: { emailAddress: 'me@globex.test' } })
  await clock.advance(5_000)
  expect(statuses.at(-1)).toBe('Claude account: acme (me@acme.test). New conversations in this folder run on personal.')
  const shown = await $.command.run({ command: 'account', args: '' } as never)
  expect(JSON.stringify(shown)).toContain('globex (me@globex.test)')
  expect(JSON.stringify(shown)).toContain('runs on personal')

  // Nothing changed: the line is not set again.
  const count = statuses.length
  await clock.advance(5_000)
  expect(statuses.length).toBe(count)

  // Back to acme: the line goes back to naming the account alone.
  files[`${BASE}/folders`] = `${CWD}\tacme\n`
  await clock.advance(5_000)
  expect(statuses.at(-1)).toBe('Claude account: acme (me@acme.test)')
})

test('inside VS Code the session opens with one line naming its account', async ($, on) => {
  const session = mock.session(on)
  world(on, signedIn(), 's-7', [], { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' })
  await start($)
  const notices = session.appended().filter(r => r.message.type === 'system')
  expect(notices.length).toBe(1)
  expect(JSON.stringify(notices[0]?.message.content)).toContain('Claude account: acme (me@acme.test)')
})

test('in the terminal the band names the account, so no notice is added', async ($, on) => {
  const session = mock.session(on)
  world(on, signedIn(), 's-8')
  await start($)
  expect(session.appended().filter(r => r.message.type === 'system').length).toBe(0)
})

test('switching pins this folder in the folders file and keeps other rules', async ($, on) => {
  const files = { ...signedIn(), [`${BASE}/folders`]: `*\tpersonal\n${HOME}/code/other\tacme\n` }
  world(on, files, 's-4')
  await start($)
  await $.command.run({ command: 'account', args: 'personal' } as never)

  const folders = files[`${BASE}/folders`] ?? ''
  expect(folders).toContain(`*\tpersonal`)
  expect(folders).toContain(`${HOME}/code/other\tacme`)
  expect(folders).toContain(`${CWD}\tpersonal`)

  await $.command.run({ command: 'account', args: 'auto' } as never)
  expect(files[`${BASE}/folders`]).not.toContain(`${CWD}\t`)
})

test('inside a repository whose workspace folder has its own rule, a switch moves that rule, so it takes effect', async ($, on) => {
  // VS Code pinned the workspace folder app, inside the repository code.
  const files = { ...signedIn(), [`${BASE}/folders`]: `${CWD}\tacme\n` }
  world(on, files, 's-10', [], {}, `${HOME}/code`)
  await start($)
  const shown = await $.command.run({ command: 'account', args: 'personal' } as never)
  expect(files[`${BASE}/folders`]).toBe(`${CWD}\tpersonal\n`)
  expect(JSON.stringify(shown)).toContain(`${CWD} now runs on personal`)
})

test('a switch pins the repository root when no deeper rule covers the folder', () => {
  const rules = [
    { path: '*', account: 'personal' },
    { path: '/w/repo/app', account: 'acme' },
    { path: '/w/repo/app/web', account: 'globex' },
    { path: '/w/other', account: 'acme' },
  ]
  expect(pinTarget('/w/repo', '/w/repo/app/web/src', rules)).toBe('/w/repo/app/web')
  expect(pinTarget('/w/repo', '/w/repo/api', rules)).toBe('/w/repo')
  expect(pinTarget('/w/repo', '/w/repo', rules)).toBe('/w/repo')
})

test('the longest matching folder rule wins, then the default', () => {
  const rules = [
    { path: '*', account: 'personal' },
    { path: '/w', account: 'acme' },
    { path: '/w/globex', account: 'globex' },
  ]
  expect(accountFor('/w/globex/api', rules)).toBe('globex')
  expect(accountFor('/w/app', rules)).toBe('acme')
  expect(accountFor('/wx', rules)).toBe('personal')
  expect(accountFor('/elsewhere', [])).toBe(null)
})

test('a new session gets where the previous one stopped, on its first prompt only', async ($, on) => {
  const seen: (readonly string[] | undefined)[] = []
  const note = {
    sessionId: 'old-session',
    account: 'personal',
    at: 1_000_000 - 60_000,
    transcript: `${HOME}/.claude/projects/-Users-tester-code-app/old-session.jsonl`,
    lastRequest: 'fix the checkout',
    lastAnswer: 'the webhook still fails on retries',
  }
  world(on, { ...signedIn(), [HANDOFF]: JSON.stringify(note) }, 's-2', seen)
  await start($)

  await $.prompt.submit({ text: 'continue', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'and now?', wait: false, origin: { kind: 'composer' } })

  expect(seen[0]?.join('\n')).toContain('the webhook still fails on retries')
  expect(seen[0]?.join('\n')).toContain('old-session.jsonl')
  expect(seen[1]).toBeUndefined()
})

test('a new conversation on the same account starts fresh, without the previous one', async ($, on) => {
  const seen: (readonly string[] | undefined)[] = []
  const note = { sessionId: 'old', account: 'acme', at: 1_000_000 - 60_000, transcript: 'x', lastRequest: 'a', lastAnswer: 'b' }
  world(on, { ...signedIn(), [HANDOFF]: JSON.stringify(note) }, 's-11', seen)
  await start($)
  await $.prompt.submit({ text: 'something new', wait: false, origin: { kind: 'composer' } })
  expect(seen[0]).toBeUndefined()
})

test('the same session resumed does not get its own note back', async ($, on) => {
  const seen: (readonly string[] | undefined)[] = []
  const note = { sessionId: 's-3', account: 'acme', at: 1_000_000, transcript: 'x', lastRequest: 'a', lastAnswer: 'b' }
  world(on, { ...signedIn(), [HANDOFF]: JSON.stringify(note) }, 's-3', seen)
  await start($)
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  expect(seen[0]).toBeUndefined()
})

test('with no accounts file, the session still shows its own account', async ($, on) => {
  const files: Record<string, string> = { [`${HOME}/.claude-acme/.claude.json`]: JSON.stringify({ oauthAccount: { emailAddress: 'me@acme.test' } }) }
  world(on, files, 's-5')
  await start($)
  const status = JSON.parse(files[`${BASE}/sessions/s-5.json`] ?? '{}')
  expect(status.account).toEqual({ name: '.claude-acme', email: 'me@acme.test' })
  expect(status.others).toEqual([])
})

test('the ledger bills each run of a session to its account, counting from the run start', async ($, on) => {
  const files = signedIn()
  on('session.measure', () => ({ changed: ['cost'] }) as never)
  world(on, files, 's-9')
  await start($)
  await $.session.measure({ cost: { usd: 4 }, rateLimits: [], changed: ['cost'] } as never)

  const entry = JSON.parse(files[`${BASE}/ledger/s-9-1000000.json`] ?? '{}')
  expect(entry).toEqual({
    sessionId: 's-9',
    account: 'acme',
    email: 'me@acme.test',
    folder: CWD,
    startedAt: 1_000_000,
    updatedAt: 1_000_000,
    usd: 2.5,
  })
})

test('Windows paths match their folder rules whatever the case and slashes', () => {
  const rules = [
    { path: 'C:\\Work\\Acme', account: 'acme' },
    { path: '*', account: 'personal' },
  ]
  expect(accountFor('c:\\work\\acme\\app', rules)).toBe('acme')
  expect(accountFor('C:/Work/Acme', rules)).toBe('acme')
  expect(accountFor('C:\\Work\\Acme-other', rules)).toBe('personal')
  expect(accountFor('/work/Acme/app', [{ path: '/work/acme', account: 'acme' }])).toBe(null)
})

// ---- Findings of the 30.10.2026 second audit ----

test('a note written at a switch is not replaced by another session still at work in the folder', async ($, on) => {
  const files = { ...signedIn() }
  const note = { sessionId: 'switcher', account: 'personal', at: 1_000_000 - 60_000, transcript: 'x', lastRequest: 'a', lastAnswer: 'b', summary: 'the plan' }
  files[HANDOFF] = JSON.stringify(note)
  world(on, files, 'bystander', [], { CLAUDE_CONFIG_DIR: `${HOME}/.claude` })
  await start($)
  await $.turn.complete({ answer: 'done' } as never)
  expect(JSON.parse(files[HANDOFF]!).summary).toBe('the plan')
  expect(JSON.parse(files[HANDOFF]!).sessionId).toBe('switcher')
})

test('the session a note was written for replaces it after its first turn, so the note reaches one session only', async ($, on) => {
  const seen: (readonly string[] | undefined)[] = []
  const files = { ...signedIn() }
  const note = { sessionId: 'switcher', account: 'personal', at: 1_000_000 - 60_000, transcript: 'x', lastRequest: 'a', lastAnswer: 'b', summary: 'the plan' }
  files[HANDOFF] = JSON.stringify(note)
  world(on, files, 'fresh-on-acme', seen)
  await start($)
  await $.prompt.submit({ text: 'continue', wait: false, origin: { kind: 'composer' } })
  expect(seen[0]?.join('\n')).toContain('the plan')
  await $.turn.complete({ answer: 'done' } as never)
  expect(JSON.parse(files[HANDOFF]!).sessionId).toBe('fresh-on-acme')
})

test('a note is kept per working folder, so a sibling folder of the same repository on another account gets none', async ($, on) => {
  const seen: (readonly string[] | undefined)[] = []
  const files = { ...signedIn() }
  // A note of the repository root, not of this folder.
  files[`${BASE}/handoff/-Users-tester-code.json`] = JSON.stringify({ sessionId: 'other', account: 'personal', at: 1_000_000, transcript: 'x', lastRequest: 'a', lastAnswer: 'b' })
  world(on, files, 's-sib', seen, {}, `${HOME}/code`)
  await start($)
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  expect(seen[0]).toBeUndefined()
})

test('the plugin reads the accounts file like the launchers: ~\\ paths, a BOM, CRLF, and a name listed twice', async ($, on) => {
  const files: Record<string, string> = {
    [`${BASE}/accounts`]: '\uFEFFpersonal\t~/.claude\r\nacme\t~\\.claude-acme\r\nacme\t~/.claude-second\r\n',
    [`${HOME}/.claude-acme/.claude.json`]: JSON.stringify({ oauthAccount: { emailAddress: 'me@acme.test' } }),
  }
  world(on, files, 's-win')
  await start($)
  const status = JSON.parse(files[`${BASE}/sessions/s-win.json`]!)
  expect(status.account).toEqual({ name: 'acme', email: 'me@acme.test' })
})

test('a relative CLAUDE_MULTI_ACCOUNT_HOME is taken from the home folder', async () => {
  expect(resolveBase('cma-home', '/Users/t')).toBe('/Users/t/cma-home')
  expect(resolveBase('/abs/base', '/Users/t')).toBe('/abs/base')
  expect(resolveBase('C:\\cma', 'C:\\Users\\t')).toBe('C:\\cma')
  expect(resolveBase(undefined, '/Users/t')).toBe('/Users/t/.claude-multi-account')
  expect(expand('~\\.claude-acme', 'C:\\Users\\t')).toBe('C:\\Users\\t/.claude-acme')
})

test('once this session\'s account is removed, the chat line says where new conversations go', async ($, on) => {
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  const files = signedIn()
  files[`${BASE}/folders`] = `${CWD}\tacme\n`
  const clock = world(on, files, 's-rm', [], { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' })
  await start($)
  expect(statuses.at(-1)).toBe('Claude account: acme (me@acme.test)')
  // Remove account drops the acme line and every rule that ran on it.
  files[`${BASE}/accounts`] = 'personal\t~/.claude\nglobex\t~/.claude-globex\n'
  files[`${BASE}/folders`] = ''
  await clock.advance(5_000)
  expect(statuses.at(-1)).toBe('Claude account: acme (me@acme.test). New conversations in this folder run on personal.')
})

test('/account offers an account added after the session started', async ($, on) => {
  hints.length = 0
  const files = signedIn()
  const clock = world(on, files, 's-hint')
  await start($)
  expect(hints.at(-1)).toBe('[personal|acme|globex|auto]')
  files[`${BASE}/accounts`] = `${ACCOUNTS}\ninitech\t~/.claude-initech\n`
  await clock.advance(5_000)
  expect(hints.at(-1)).toBe('[personal|acme|globex|initech|auto]')
  const count = hints.length
  await clock.advance(5_000)
  expect(hints.length).toBe(count)
})
