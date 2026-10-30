// Pro is sold through Lemon Squeezy's license API, which needs no secret on our side: a key is activated
// for this machine once and checked again every week. With PRODUCT null, every Pro feature is open to everyone.
const PRODUCT = {
  storeId: 501065,
  productId: 1450746,
  checkoutUrl: 'https://claude-multi-account.lemonsqueezy.com/checkout/buy/34db480b-176b-4f10-91e0-9fa27f6fdac6',
}
const API = 'https://api.lemonsqueezy.com/v1/licenses'
const RECHECK_MS = 7 * 24 * 60 * 60 * 1000
const KEY = 'claudeMultiAccount.license'

async function call(action, fields, fetchImpl = fetch) {
  const res = await fetchImpl(`${API}/${action}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
  return res.json()
}

function isOurs(meta, product) {
  return meta?.store_id === product.storeId && meta?.product_id === product.productId
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
      if (now() - saved.checkedAt < RECHECK_MS) return true
      let r
      try {
        r = await call('validate', { license_key: saved.key, instance_id: saved.instanceId }, fetchImpl)
      } catch {
        // Offline: keep what was paid for until the network is back.
        return true
      }
      // Only the server saying "not valid" drops the key. An outage or a rate limit answers without
      // `valid`, and must not take away what was paid for.
      if (typeof r?.valid !== 'boolean') return true
      if (!r.valid || !isOurs(r.meta, product)) {
        await secrets.delete(KEY)
        return false
      }
      await secrets.store(KEY, JSON.stringify({ ...saved, checkedAt: now() }))
      return true
    },

    async activate(key, instanceName) {
      if (product === null) return { ok: true }
      const r = await call('activate', { license_key: key.trim(), instance_name: instanceName }, fetchImpl)
      if (!r.activated) return { ok: false, error: r.error ?? 'The key was not accepted' }
      if (!isOurs(r.meta, product)) return { ok: false, error: 'This key is for a different product' }
      await secrets.store(KEY, JSON.stringify({ key: key.trim(), instanceId: r.instance.id, checkedAt: now() }))
      return { ok: true }
    },
  }
}

module.exports = { createLicense, PRODUCT }
