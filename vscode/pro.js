// Pro is sold through Polar (polar.sh, the merchant of record). Its customer license API needs no secret on our
// side: a key is activated for this machine once and checked again every week. With PRODUCT null, every Pro
// feature is open to everyone.
const POLAR = {
  organizationId: 'b4a6e709-f945-4dcf-81f5-767edb390e1b',
  // The "Billable Pro license key" benefit, granted by both the monthly and the yearly product.
  benefitId: '6d6ba72a-7faa-443b-b23b-42c97fba76d4',
  checkoutUrl: 'https://buy.polar.sh/polar_cl_0e4IP1k5heZr1L5kNRgFrvx6UBOZKe3YW0dlh3oYJn5',
  yearlyCheckoutUrl: 'https://buy.polar.sh/polar_cl_eKMisWMeTtaSu6nnkxAEJbPhLfNpEx1JnA9BL3stAlZ',
}
// Pro stays open to everyone until the Polar account can take payments (payout account connected and the
// account review passed); then PRODUCT = POLAR.
const PRODUCT = null
const API = 'https://api.polar.sh/v1/customer-portal/license-keys'
const RECHECK_MS = 7 * 24 * 60 * 60 * 1000
const KEY = 'claudeMultiAccount.license'

async function call(action, body, fetchImpl = fetch) {
  const res = await fetchImpl(`${API}/${action}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    // 204 (deactivate) and broken answers have no JSON body.
  }
  return { status: res.status, json }
}

function isOurs(licenseKey, product) {
  return licenseKey?.organization_id === product.organizationId && licenseKey?.benefit_id === product.benefitId
}

function usable(licenseKey, now) {
  if (licenseKey?.status !== 'granted') return false
  return !licenseKey.expires_at || Date.parse(licenseKey.expires_at) > now
}

function errorText(json, fallback) {
  const d = json?.detail
  if (typeof d === 'string' && d) return d
  return fallback
}

function createLicense({ secrets, product = PRODUCT, fetchImpl = fetch, now = () => Date.now() }) {
  async function load() {
    try {
      return JSON.parse((await secrets.get(KEY)) ?? 'null')
    } catch {
      return null
    }
  }

  return {
    isLaunch: product === null,
    checkoutUrl: product?.checkoutUrl ?? null,

    async isPro() {
      if (product === null) return true
      const saved = await load()
      if (!saved) return false
      // A check in the future (the clock was moved back) does not count: the key is checked again now.
      const since = now() - saved.checkedAt
      if (since >= 0 && since < RECHECK_MS) return true
      let r
      try {
        r = await call('validate', { key: saved.key, organization_id: product.organizationId, activation_id: saved.activationId }, fetchImpl)
      } catch {
        // Offline: keep what was paid for until the network is back.
        return true
      }
      // Only the server saying "this key is not good" drops it: not found, or a key that is revoked, disabled,
      // expired or for another product. An outage, a rate limit or a broken answer must not take away what was
      // paid for.
      const notFound = r.status === 404
      const answered = r.status === 200 && r.json && typeof r.json.status === 'string'
      if (!notFound && !answered) return true
      if (notFound || !usable(r.json, now()) || !isOurs(r.json, product)) {
        await secrets.delete(KEY)
        return false
      }
      await secrets.store(KEY, JSON.stringify({ ...saved, checkedAt: now() }))
      return true
    },

    async activate(key, label) {
      if (product === null) return { ok: true }
      const k = key.trim()
      const r = await call('activate', { key: k, organization_id: product.organizationId, label }, fetchImpl)
      if (r.status === 404) return { ok: false, error: 'This key was not found. Copy it again from the receipt email.' }
      if (r.status !== 200 && r.status !== 201) return { ok: false, error: errorText(r.json, `The license server answered ${r.status}`) }
      const activationId = r.json?.id
      const licenseKey = r.json?.license_key
      if (typeof activationId !== 'string' || !activationId) return { ok: false, error: 'The license server gave an answer without an activation id' }
      const giveBack = () => call('deactivate', { key: k, organization_id: product.organizationId, activation_id: activationId }, fetchImpl).catch(() => {})
      if (!isOurs(licenseKey, product)) {
        await giveBack()
        return { ok: false, error: 'This key is for a different product' }
      }
      if (!usable(licenseKey, now())) {
        await giveBack()
        return { ok: false, error: 'This key is no longer active' }
      }
      try {
        await secrets.store(KEY, JSON.stringify({ key: k, activationId, checkedAt: now() }))
      } catch (err) {
        // The activation counts against the key's limit: give it back, since nothing here remembers it.
        await giveBack()
        return { ok: false, error: `The key was accepted, but this machine could not keep it: ${err.message}` }
      }
      return { ok: true }
    },
  }
}

module.exports = { createLicense, PRODUCT, POLAR }
