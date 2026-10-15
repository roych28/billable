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
