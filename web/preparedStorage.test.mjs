import assert from "node:assert/strict"
import test from "node:test"

import {
  cacheBenefit,
  disclosureFor,
  estimateRunPodStorageMonthly,
  normalizePreparedStorage,
  validatePreparedStorage,
  volumeDeleteQuery,
} from "./preparedStorage.js"

test("prepared storage is opt-in and keeps safe defaults", () => {
  const policy = normalizePreparedStorage()
  assert.equal(policy.enabled, false)
  assert.equal(policy.policy, "smart")
  assert.equal(policy.cache_private_assets, false)
  assert.equal(policy.confirmed, false)
})

test("first-run disclosure explains cost, locality, fallback, privacy, and deletion", () => {
  const disclosure = disclosureFor({
    enabled: true,
    region: "US-KS-2",
    managed_size_gb: 100,
    cold_fallback: "ask",
    cache_private_assets: true,
  })
  assert.equal(disclosure.published_estimated_monthly_usd, 7)
  assert.match(disclosure.placement, /US-KS-2/)
  assert.match(disclosure.fallback, /decision/)
  assert.match(disclosure.private_assets, /Gated\/private/)
  assert.match(disclosure.deletion, /separate confirmed action/)
})

test("RunPod published estimate changes tiers after 1TB", () => {
  assert.equal(estimateRunPodStorageMonthly(1000), 70)
  assert.equal(estimateRunPodStorageMonthly(1001), 70.05)
})

test("reviewed policy is a stable normalized snapshot", () => {
  const live = { enabled: true, region: "US-KS-2", managed_size_gb: 250 }
  const reviewed = normalizePreparedStorage(live)
  live.region = "EU-RO-1"
  live.managed_size_gb = 4000
  assert.equal(reviewed.region, "US-KS-2")
  assert.equal(reviewed.managed_size_gb, 250)
})

test("pinned policy refuses an automatic region", () => {
  assert.match(
    validatePreparedStorage({ enabled: true, policy: "pinned", region: "auto" }),
    /concrete RunPod datacenter/
  )
})

test("cache benefit presents health evidence in user units", () => {
  assert.deepEqual(
    cacheBenefit({
      recent_benefit: { attempts: 3, bytes: 1024 ** 3, saved_ms: 12500, lost_ms: 500 },
    }),
    { attempts: 3, bytes: "1.00 GiB", saved: "12.5s saved", lost: "0.5s slower" }
  )
})

test("provider deletion query carries the exact typed provider id", () => {
  assert.equal(
    volumeDeleteQuery(true, "vol id/1"),
    "delete_provider=true&confirm_provider_volume_id=vol+id%2F1"
  )
  assert.equal(volumeDeleteQuery(false), "delete_provider=false")
})
