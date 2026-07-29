import assert from "node:assert/strict"
import test from "node:test"

import {
  cloudJobsIntervals,
  formatBytes,
  formatDuration,
  hasActiveJobs,
  jobView,
  mergeJobPage,
  pollDelay,
  sortJobs,
} from "./cloudJobsModel.js"

function job(overrides = {}) {
  return {
    job_id: "job-1",
    status: "running",
    terminal: false,
    progress: 23.4,
    progress_basis: "stage_time_estimate",
    stage_label: "Starting the cloud worker",
    active_operation: "Cloud worker is still starting",
    elapsed_seconds: 75,
    eta_seconds: [90, 180],
    eta_confidence: "medium",
    updated_at: "2026-07-30T00:00:00Z",
    resource: {
      provider: "runpod",
      gpu_type: "A100 SXM",
      region: "US-MD-1",
      pod_id: "pod-1",
      lease_id: "lease-1",
      volume_id: "volume-1",
    },
    cost: {
      hourly_rate_usd: 0.72,
      estimated_spend_usd: 0.011,
      estimated_total_usd: [0.22, 0.30],
    },
    transfer: {
      bytes_completed: 1024,
      bytes_total: 4096,
      throughput_bps: 512,
    },
    cache: { hits: 2, misses: 1, hit_bytes: 1024, items_saved: 1 },
    recommendation: { preparation_class: "prepared-local" },
    preflight: { state: "confirmed", confidence: "medium", history_sample_count: 2 },
    billing: { state: "accruing" },
    cancellation: { can_cancel: true, requested: false },
    recent_events: [{ sequence: 3, message: "Cloud worker is still starting" }],
    event_count: 3,
    ...overrides,
  }
}

test("sorts active jobs before the newest terminal jobs", () => {
  const jobs = sortJobs([
    job({ job_id: "done", terminal: true, updated_at: "2026-07-30T03:00:00Z" }),
    job({ job_id: "active-old", updated_at: "2026-07-30T01:00:00Z" }),
    job({ job_id: "active-new", updated_at: "2026-07-30T02:00:00Z" }),
  ])
  assert.deepEqual(jobs.map((item) => item.job_id), ["active-new", "active-old", "done"])
})

test("does not regress active progress when a stale poll arrives", () => {
  const merged = mergeJobPage([job({ progress: 28 })], {
    schema: "cloud-offload.job-visibility.v1",
    jobs: [job({ progress: 21 })],
  })
  assert.equal(merged[0].progress, 28)
})

test("builds a complete view of stage, ETA, cost, transfer, cache, and identity", () => {
  const view = jobView(job())
  assert.equal(view.title, "runpod · A100 SXM")
  assert.equal(view.stage, "Starting the cloud worker")
  assert.equal(view.progressText, "23.4% estimated")
  assert.equal(view.elapsed, "1 min 15 sec")
  assert.equal(view.eta, "1 min 30 sec–3 min 00 sec · medium confidence")
  assert.equal(view.transfer, "1.0 KiB / 4.0 KiB")
  assert.equal(view.throughput, "512 B/sec")
  assert.equal(view.hourly, "$0.72/hr")
  assert.equal(view.spend, "$0.011 estimated spend")
  assert.equal(view.expectedCost, "$0.22–$0.30")
  assert.equal(view.cache, "2 hit · 1 miss · 1.0 KiB restored · 1 saved")
  assert.equal(view.podId, "pod-1")
  assert.equal(view.leaseId, "lease-1")
  assert.equal(view.volumeId, "volume-1")
  assert.equal(view.billing, "Billing is active")
  assert.equal(view.closure, "Provider closure is not confirmed")
  assert.equal(view.preflight, "Confirmed · medium confidence · 2 history samples")
})

test("shows the provider closure receipt", () => {
  const view = jobView(job({
    terminal: true,
    billing: {
      state: "stopped",
      termination_confirmed: true,
      termination_confirmed_at: "2026-07-30T01:02:03Z",
    },
  }))
  assert.equal(view.billing, "GPU closed; billing stopped")
  assert.equal(view.closure, "Provider confirmed · 2026-07-30T01:02:03Z")
})

test("keeps unknown ETA, spend, and billing honest", () => {
  const view = jobView(job({
    eta_seconds: null,
    eta_confidence: "unavailable",
    cost: { hourly_rate_usd: null, estimated_spend_usd: null },
    billing: { state: "termination_unconfirmed" },
    transfer: {},
  }))
  assert.equal(view.eta, "ETA is not available")
  assert.equal(view.spend, "Spend is not available")
  assert.equal(view.billing, "GPU closure is not confirmed")
  assert.equal(view.transfer, "No measured bytes yet")
})

test("terminal jobs do not present a zero-second ETA as active work", () => {
  const view = jobView(job({ terminal: true, status: "completed", eta_seconds: [0, 0] }))
  assert.equal(view.eta, "Job ended")
})

test("polls each second while active and every five seconds while idle", () => {
  assert.equal(hasActiveJobs([job()]), true)
  assert.equal(pollDelay([job()]), cloudJobsIntervals.active)
  assert.equal(pollDelay([job({ terminal: true })]), cloudJobsIntervals.idle)
  assert.equal(formatBytes(1024 ** 3), "1.0 GiB")
  assert.equal(formatDuration(3605), "1 hr 0 min")
})
