import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { accountFor } from '../hooks/register'

const HOME = '/Users/tester'
const CWD = `${HOME}/code/app`
const BASE = `${HOME}/.claude-multi-account`
const HANDOFF = `${BASE}/handoff/-Users-tester-code-app.json`

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
) {
  on('prompt.submit', ($, e) => {
    seen.push(e.context)
    return { text: e.text, context: e.context }
  })
  mock.env(on, { HOME, CLAUDE_CONFIG_DIR: `${HOME}/.claude-acme`, ...env })
  mock.clock(on, { now: 1_000_000 })
  on('fs.read', ($, e) => {
    const text = files[e.path]
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', () => ({
    value: { exitCode: 0, stdout: `${CWD}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
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
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
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
