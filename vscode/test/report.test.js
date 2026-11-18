const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const report = require('../report')
const { createLicense } = require('../pro')

const OCT = new Date(2026, 9, 10).getTime()
const SEP = new Date(2026, 8, 20).getTime()
const entry = (o) => ({ sessionId: 's1', account: 'acme', email: 'me@acme.test', folder: '/u/acme/app', startedAt: OCT, updatedAt: OCT, usd: 1, ...o })

test('the report sums each account and folder for the month, sessions counted once', () => {
  const entries = [
    entry({ usd: 2 }),
    entry({ usd: 0.5, startedAt: OCT + 1000 }),
    entry({ sessionId: 's2', folder: '/u/acme/api', usd: 1 }),
    entry({ sessionId: 's3', account: 'globex', email: 'me@globex.test', usd: 4 }),
    entry({ sessionId: 's4', usd: 9, startedAt: SEP }),
  ]
  const s = report.summarize(entries, '2026-10')
  assert.deepStrictEqual(s.map(a => [a.account, a.usd, a.sessions]), [['globex', 4, 1], ['acme', 3.5, 2]])
  assert.deepStrictEqual(s[1].folders, [{ folder: '/u/acme/app', usd: 2.5, sessions: 1 }, { folder: '/u/acme/api', usd: 1, sessions: 1 }])
  const md = report.toMarkdown(s, '2026-10', '/u')
  assert.match(md, /\| \*\*acme\*\* \| me@acme\.test \| 2 \| \*\*\$3\.50\*\* \|/)
  assert.match(md, /\| Total \| \| 3 \| \*\*\$7\.50\*\* \|/)
  assert.match(md, /\| ~\/acme\/app \| 1 \| \$2\.50 \|/)
  assert.deepStrictEqual(report.months(entries, OCT), ['2026-10', '2026-09'])
})

test('the CSV has one row per run of the month, and quotes what needs quoting', () => {
  const csv = report.toCsv([entry({ folder: '/u/a,b' }), entry({ startedAt: SEP })], '2026-10').trim().split('\n')
  assert.strictEqual(csv.length, 2)
  assert.strictEqual(csv[0], 'month,account,email,folder,session,started,last_active,usd')
  assert.match(csv[1], /^2026-10,acme,me@acme\.test,"\/u\/a,b",s1,/)
  assert.match(csv[1], /,1\.0000$/)
})

test('the ledger reader skips broken files and the free months are this one and the last', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-ledger-'))
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(entry()))
  fs.writeFileSync(path.join(dir, 'b.json'), '{not json')
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ account: 'x' }))
  assert.strictEqual(report.readLedger(dir).length, 1)
  assert.deepStrictEqual(report.freeMonths(new Date(2026, 0, 15).getTime()), ['2026-01', '2025-12'])
})

function memorySecrets() {
  const m = new Map()
  return { get: async k => m.get(k), store: async (k, v) => m.set(k, v), delete: async k => m.delete(k) }
}

test('without a store every Pro feature is open', async () => {
  const l = createLicense({ secrets: memorySecrets(), product: null })
  assert.strictEqual(await l.isPro(), true)
  assert.strictEqual(l.isLaunch, true)
})

const PRODUCT = { organizationId: 'org1', benefitId: 'ben1', checkoutUrl: 'https://example.test/buy' }
const keyObj = (over = {}) => ({ organization_id: 'org1', benefit_id: 'ben1', status: 'granted', expires_at: null, ...over })
const reply = (status, json) => ({ status, json: async () => json })

test('a license key unlocks Pro only when it belongs to our product, and is checked again weekly', async () => {
  let now = 0
  let valid = true
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(url.split('/').pop())
    if (url.endsWith('/activate')) return reply(200, { id: 'a1', license_key: keyObj(body.key === 'other-key' ? { benefit_id: 'ben9' } : {}) })
    if (url.endsWith('/deactivate')) return reply(204, null)
    return reply(200, keyObj(valid ? {} : { status: 'revoked' }))
  }
  const l = createLicense({ secrets: memorySecrets(), product: PRODUCT, fetchImpl, now: () => now })
  assert.strictEqual(await l.isPro(), false)
  assert.deepStrictEqual(await l.activate('other-key', 'mac'), { ok: false, error: 'This key is for a different product' })
  assert.strictEqual(calls.at(-1), 'deactivate', 'a key for another product gives its activation back')
  assert.strictEqual(await l.isPro(), false)
  assert.deepStrictEqual(await l.activate('good-key', 'mac'), { ok: true })
  assert.strictEqual(await l.isPro(), true)
  assert.strictEqual(calls.filter(c => c === 'validate').length, 0)
  now = 8 * 24 * 60 * 60 * 1000
  valid = false
  assert.strictEqual(await l.isPro(), false)
  assert.strictEqual(calls.filter(c => c === 'validate').length, 1)
})

test('the weekly check sends the key, the organization and this machine\'s activation', async () => {
  let now = 0
  const bodies = []
  const fetchImpl = async (url, init) => {
    bodies.push([url.split('/').pop(), JSON.parse(init.body)])
    return url.endsWith('/activate') ? reply(201, { id: 'a7', license_key: keyObj() }) : reply(200, keyObj())
  }
  const l = createLicense({ secrets: memorySecrets(), product: PRODUCT, fetchImpl, now: () => now })
  assert.deepStrictEqual(await l.activate('  BILL-123  ', 'mac (VS Code)'), { ok: true })
  assert.deepStrictEqual(bodies[0], ['activate', { key: 'BILL-123', organization_id: 'org1', label: 'mac (VS Code)' }])
  now = 8 * 24 * 60 * 60 * 1000
  assert.strictEqual(await l.isPro(), true)
  assert.deepStrictEqual(bodies[1], ['validate', { key: 'BILL-123', organization_id: 'org1', activation_id: 'a7' }])
})

test('a paid key survives an outage, a rate limit and a broken answer at the weekly check, and only "not good" drops it', async () => {
  let now = 0
  let answer = () => reply(200, keyObj())
  const secrets = memorySecrets()
  const fetchImpl = async url => (url.endsWith('/activate') ? reply(200, { id: 'a1', license_key: keyObj() }) : answer())
  const l = createLicense({ secrets, product: PRODUCT, fetchImpl, now: () => now })
  assert.deepStrictEqual(await l.activate('good-key', 'mac'), { ok: true })
  const week = 8 * 24 * 60 * 60 * 1000
  const broken = [
    () => reply(429, { error: 'TooManyRequests' }),
    () => reply(500, null),
    () => reply(200, {}),
    () => reply(200, null),
    () => ({ status: 200, json: async () => { throw new SyntaxError('bad json') } }),
    () => { throw new Error('offline') },
  ]
  for (const b of broken) {
    now += week
    answer = b
    assert.strictEqual(await l.isPro(), true, 'a broken answer keeps Pro')
    assert.ok(await secrets.get('claudeMultiAccount.license'), 'and keeps the key')
  }
  for (const [label, bad] of [
    ['not found', () => reply(404, { error: 'ResourceNotFound', detail: 'Not found' })],
    ['disabled', () => reply(200, keyObj({ status: 'disabled' }))],
    ['expired', () => reply(200, keyObj({ expires_at: new Date(now - 1000).toISOString() }))],
    ['another product', () => reply(200, keyObj({ organization_id: 'org9' }))],
  ]) {
    await secrets.store('claudeMultiAccount.license', JSON.stringify({ key: 'good-key', activationId: 'a1', checkedAt: now }))
    now += week
    answer = bad
    assert.strictEqual(await l.isPro(), false, label)
    assert.strictEqual(await secrets.get('claudeMultiAccount.license'), undefined, `${label} drops the key`)
  }
})

test('the shipped build opens Pro to everyone and offers no checkout until Polar can take payments', async () => {
  const { PRODUCT: shipped } = require('../pro')
  assert.strictEqual(shipped, null, 'a published Get Pro must not lead to a checkout that cannot take money')
  const l = createLicense({ secrets: memorySecrets() })
  assert.strictEqual(l.isLaunch, true)
  assert.strictEqual(l.checkoutUrl, null)
  assert.strictEqual(await l.isPro(), true)
})

test('POLAR keeps the Billable Pro organization, benefit and checkout links for when payments open', () => {
  const { POLAR } = require('../pro')
  assert.strictEqual(POLAR.organizationId, 'b4a6e709-f945-4dcf-81f5-767edb390e1b')
  assert.strictEqual(POLAR.benefitId, '6d6ba72a-7faa-443b-b23b-42c97fba76d4')
  assert.match(POLAR.checkoutUrl, /^https:\/\/buy\.polar\.sh\/polar_cl_/)
  assert.match(POLAR.yearlyCheckoutUrl, /^https:\/\/buy\.polar\.sh\/polar_cl_/)
})

test('the CSV export survives a ledger entry without updatedAt, and its timestamps agree with the month column', () => {
  const firstNight = new Date(2026, 10, 1, 0, 30).getTime() // 1 Nov 00:30 local
  const csv = report.toCsv([entry({ startedAt: firstNight, updatedAt: undefined })], '2026-11').trim().split('\n')
  assert.strictEqual(csv.length, 2)
  const cells = csv[1].split(',')
  assert.strictEqual(cells[0], '2026-11')
  assert.match(cells[5], /^2026-11-01T00:30:00[+-]\d\d:\d\d$/)
  assert.strictEqual(cells[6], cells[5], 'the start stands in for a missing last write')
  assert.strictEqual(report.localIso(undefined), '')
})

test('a path that merely starts with the home string is not shortened to ~', () => {
  const summary = report.summarize([entry({ folder: '/Users/me/app' }), entry({ sessionId: 's2', folder: '/Users/meow/app' })], '2026-10')
  const md = report.toMarkdown(summary, '2026-10', '/Users/me')
  assert.ok(md.includes('| ~/app |'), md)
  assert.ok(md.includes('| /Users/meow/app |'), md)
})

test('a checkedAt in the future forces a re-validation', async () => {
  const secrets = memorySecrets()
  const calls = []
  const fetchImpl = async url => {
    calls.push(url.split('/').pop())
    return url.endsWith('/activate') ? reply(200, { id: 'a1', license_key: keyObj() }) : reply(200, keyObj({ status: 'revoked' }))
  }
  let now = 10 * 24 * 3_600_000
  const l = createLicense({ secrets, product: PRODUCT, fetchImpl, now: () => now })
  await l.activate('good-key', 'mac')
  now -= 3 * 24 * 3_600_000 // the clock was moved back
  assert.strictEqual(await l.isPro(), false)
  assert.strictEqual(calls.filter(c => c === 'validate').length, 1)
})

test('activation reports a refused key, a malformed answer or a failing secret store as such, and gives the activation back', async () => {
  const calls = []
  let answer = () => reply(403, { error: 'NotPermitted', detail: 'License key only allows 3 activations.' })
  const fetchImpl = async (url, init) => {
    calls.push([url.split('/').pop(), JSON.parse(init.body)])
    return url.endsWith('/deactivate') ? reply(204, null) : answer()
  }
  const make = secrets => createLicense({ secrets, product: PRODUCT, fetchImpl })
  assert.deepStrictEqual(await make(memorySecrets()).activate('k', 'mac'), { ok: false, error: 'License key only allows 3 activations.' })
  answer = () => reply(404, { error: 'ResourceNotFound', detail: 'Not found' })
  assert.match((await make(memorySecrets()).activate('k', 'mac')).error, /not found/)
  answer = () => reply(200, { license_key: keyObj() })
  assert.deepStrictEqual(await make(memorySecrets()).activate('k', 'mac'), { ok: false, error: 'The license server gave an answer without an activation id' })
  answer = () => reply(200, { id: 'a9', license_key: keyObj({ status: 'revoked' }) })
  assert.deepStrictEqual(await make(memorySecrets()).activate('k', 'mac'), { ok: false, error: 'This key is no longer active' })
  assert.deepStrictEqual(calls.at(-1), ['deactivate', { key: 'k', organization_id: 'org1', activation_id: 'a9' }])
  answer = () => reply(200, { id: 'a10', license_key: keyObj() })
  const broken = { get: async () => undefined, store: async () => { throw new Error('keyring unavailable') }, delete: async () => {} }
  const r = await make(broken).activate('k', 'mac')
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /could not keep it: keyring unavailable/)
  assert.deepStrictEqual(calls.at(-1), ['deactivate', { key: 'k', organization_id: 'org1', activation_id: 'a10' }])
})
