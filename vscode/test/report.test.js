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

test('a license key unlocks Pro only when it belongs to our product, and is checked again weekly', async () => {
  const product = { storeId: 7, productId: 42, checkoutUrl: 'https://example.test/buy' }
  let now = 0
  let valid = true
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(url)
    const meta = { store_id: 7, product_id: url.endsWith('activate') && init.body.includes('other') ? 99 : 42 }
    if (url.endsWith('activate')) return { json: async () => ({ activated: true, instance: { id: 'i1' }, meta }) }
    return { json: async () => ({ valid, meta }) }
  }
  const l = createLicense({ secrets: memorySecrets(), product, fetchImpl, now: () => now })
  assert.strictEqual(await l.isPro(), false)
  assert.deepStrictEqual(await l.activate('other-key', 'mac'), { ok: false, error: 'This key is for a different product' })
  assert.strictEqual(await l.isPro(), false)
  assert.deepStrictEqual(await l.activate('good-key', 'mac'), { ok: true })
  assert.strictEqual(await l.isPro(), true)
  assert.strictEqual(calls.filter(c => c.endsWith('validate')).length, 0)
  now = 8 * 24 * 60 * 60 * 1000
  valid = false
  assert.strictEqual(await l.isPro(), false)
  assert.strictEqual(calls.filter(c => c.endsWith('validate')).length, 1)
})

test('a paid key survives an outage, a rate limit and a broken answer at the weekly check, and only "not valid" drops it', async () => {
  const product = { storeId: 7, productId: 42, checkoutUrl: 'https://example.test/buy' }
  let now = 0
  let answer = () => ({ valid: true, meta: { store_id: 7, product_id: 42 } })
  const secrets = memorySecrets()
  const fetchImpl = async url => ({
    json: async () => (url.endsWith('activate') ? { activated: true, instance: { id: 'i1' }, meta: { store_id: 7, product_id: 42 } } : answer()),
  })
  const l = createLicense({ secrets, product, fetchImpl, now: () => now })
  assert.deepStrictEqual(await l.activate('good-key', 'mac'), { ok: true })
  const week = 8 * 24 * 60 * 60 * 1000
  for (const broken of [() => ({ error: 'Too many requests' }), () => ({}), () => null, () => { throw new Error('offline') }]) {
    now += week
    answer = broken
    assert.strictEqual(await l.isPro(), true, 'a broken answer keeps Pro')
    assert.ok(await secrets.get('claudeMultiAccount.license'), 'and keeps the key')
  }
  now += week
  answer = () => ({ valid: false, error: 'license_key not found.' })
  assert.strictEqual(await l.isPro(), false)
  assert.strictEqual(await secrets.get('claudeMultiAccount.license'), undefined, '"not valid" drops the key')
})

test('the shipped PRODUCT points at the Billable Pro store and product', () => {
  const { PRODUCT } = require('../pro')
  assert.strictEqual(PRODUCT.storeId, 501065)
  assert.strictEqual(PRODUCT.productId, 1450746)
  assert.match(PRODUCT.checkoutUrl, /^https:\/\/claude-multi-account\.lemonsqueezy\.com\/checkout\/buy\//)
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
  const product = { storeId: 7, productId: 42, checkoutUrl: 'https://example.test/buy' }
  const secrets = memorySecrets()
  const calls = []
  const fetchImpl = async url => {
    calls.push(url)
    return { json: async () => (url.endsWith('activate') ? { activated: true, instance: { id: 'i1' }, meta: { store_id: 7, product_id: 42 } } : { valid: false }) }
  }
  let now = 10 * 24 * 3_600_000
  const l = createLicense({ secrets, product, fetchImpl, now: () => now })
  await l.activate('good-key', 'mac')
  now -= 3 * 24 * 3_600_000 // the clock was moved back
  assert.strictEqual(await l.isPro(), false)
  assert.strictEqual(calls.filter(c => c.endsWith('validate')).length, 1)
})

test('activation reports a malformed answer or a failing secret store as such, and gives the activation back', async () => {
  const product = { storeId: 7, productId: 42, checkoutUrl: 'https://example.test/buy' }
  const calls = []
  let instance = undefined
  const fetchImpl = async (url, init) => {
    calls.push([url.split('/').pop(), init.body])
    return { json: async () => ({ activated: true, instance, meta: { store_id: 7, product_id: 42 } }) }
  }
  const noInstance = createLicense({ secrets: memorySecrets(), product, fetchImpl })
  assert.deepStrictEqual(await noInstance.activate('k', 'mac'), { ok: false, error: 'The license server gave an answer without an instance id' })
  instance = { id: 'i9' }
  const broken = { get: async () => undefined, store: async () => { throw new Error('keyring unavailable') }, delete: async () => {} }
  const r = await createLicense({ secrets: broken, product, fetchImpl }).activate('k', 'mac')
  assert.strictEqual(r.ok, false)
  assert.match(r.error, /could not keep it: keyring unavailable/)
  const last = calls[calls.length - 1]
  assert.strictEqual(last[0], 'deactivate')
  assert.ok(last[1].includes('instance_id=i9'), last[1])
})
