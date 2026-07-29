const ACTIVE_POLL_MS = 1000
const IDLE_POLL_MS = 5000

function number(value) {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function formatDuration(value) {
  const seconds = number(value)
  if (seconds === null) return "Unknown"
  const rounded = Math.max(0, Math.round(seconds))
  if (rounded < 60) return `${rounded} sec`
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const remainder = rounded % 60
  if (hours) return `${hours} hr ${minutes} min`
  return `${minutes} min ${String(remainder).padStart(2, "0")} sec`
}

export function formatBytes(value) {
  let amount = Math.max(0, number(value) || 0)
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  const digits = unit > 0 && amount < 10 ? 1 : 0
  return `${amount.toFixed(digits)} ${units[unit]}`
}

export function formatMoney(value, fallback = "Unknown") {
  const amount = number(value)
  if (amount === null) return fallback
  const digits = Math.abs(amount) < 0.1 ? 3 : 2
  return `$${amount.toFixed(digits)}`
}

export function formatRange(values, formatter = formatDuration, fallback = "Unknown") {
  if (!Array.isArray(values) || values.length !== 2) return fallback
  if (number(values[0]) === null || number(values[1]) === null) return fallback
  return `${formatter(values[0])}–${formatter(values[1])}`
}

export function hasActiveJobs(jobs = []) {
  return jobs.some((job) => !job?.terminal)
}

export function pollDelay(jobs = []) {
  return hasActiveJobs(jobs) ? ACTIVE_POLL_MS : IDLE_POLL_MS
}

function updatedMillis(job) {
  const value = Date.parse(job?.updated_at || job?.created_at || "")
  return Number.isFinite(value) ? value : 0
}

export function sortJobs(jobs = []) {
  return [...jobs].sort((left, right) => {
    if (Boolean(left?.terminal) !== Boolean(right?.terminal)) {
      return left?.terminal ? 1 : -1
    }
    return updatedMillis(right) - updatedMillis(left)
  })
}

export function mergeJobPage(previous = [], page = {}) {
  if (page?.schema !== "cloud-offload.job-visibility.v1" || !Array.isArray(page.jobs)) {
    throw new Error("Cloud Jobs returned an unsupported response")
  }
  const old = new Map(previous.map((job) => [job.job_id, job]))
  return sortJobs(
    page.jobs.map((incoming) => {
      const prior = old.get(incoming.job_id)
      if (!prior || incoming.terminal) return incoming
      return {
        ...incoming,
        progress: Math.max(number(prior.progress) || 0, number(incoming.progress) || 0),
      }
    }),
  )
}

function billingLabel(billing = {}) {
  return {
    not_started: "Billing has not started",
    accruing: "Billing is active",
    termination_unconfirmed: "GPU closure is not confirmed",
    stopped: "GPU closed; billing stopped",
  }[billing.state] || "Billing state is unknown"
}

function statusLabel(job = {}) {
  if (job.cancellation?.requested && job.terminal) return "Cancelled"
  return {
    pending: "Pending",
    preview_done: "Ready",
    queued: "Queued",
    dispatched: "Dispatched",
    running: "Running",
    completed: "Complete",
    failed: "Failed",
    dead_letter: "Failed",
  }[job.status] || "Unknown"
}

export function jobView(job = {}) {
  const resource = job.resource || {}
  const cost = job.cost || {}
  const transfer = job.transfer || {}
  const cache = job.cache || {}
  const recommendation = job.recommendation || {}
  const progress = Math.max(0, Math.min(100, number(job.progress) || 0))
  const eta = formatRange(job.eta_seconds)
  const etaConfidence = String(job.eta_confidence || "unavailable")
  const completed = number(transfer.bytes_completed) || 0
  const total = number(transfer.bytes_total)
  const throughput = number(transfer.throughput_bps)
  const transferText = total !== null
    ? `${formatBytes(completed)} / ${formatBytes(total)}`
    : completed > 0
      ? formatBytes(completed)
      : "No measured bytes yet"
  const provider = resource.provider || recommendation.provider || "Provider unknown"
  const gpu = resource.gpu_type || recommendation.gpu_type || "GPU unknown"
  const region = resource.region || recommendation.region || "Region unknown"
  return {
    id: String(job.job_id || ""),
    partitionId: job.partition_id ? String(job.partition_id) : null,
    title: `${provider} · ${gpu}`,
    status: statusLabel(job),
    stage: job.stage_label || "Working",
    operation: job.active_operation || job.stage_label || "Working",
    progress,
    progressText: `${progress.toFixed(1)}%${
      job.progress_basis === "stage_time_estimate" ? " estimated" : ""
    }`,
    elapsed: formatDuration(job.elapsed_seconds),
    eta: job.terminal
      ? "Job ended"
      : eta === "Unknown"
        ? "ETA is not available"
        : `${eta} · ${etaConfidence} confidence`,
    transfer: transferText,
    throughput: throughput ? `${formatBytes(throughput)}/sec` : "Throughput is not available",
    provider,
    gpu,
    region,
    podId: resource.pod_id ? String(resource.pod_id) : "Not allocated",
    volumeId: resource.volume_id ? String(resource.volume_id) : "Not mounted",
    hourly: number(cost.hourly_rate_usd) === null
      ? "Hourly rate is unknown"
      : `${formatMoney(cost.hourly_rate_usd)}/hr`,
    spend: number(cost.estimated_spend_usd) === null
      ? "Spend is not available"
      : `${formatMoney(cost.estimated_spend_usd)} estimated spend`,
    expectedCost: formatRange(
      cost.estimated_total_usd,
      (value) => formatMoney(value),
      "Expected total cost is unknown",
    ),
    cache: `${Number(cache.hits || 0)} hit · ${Number(cache.misses || 0)} miss · ${
      formatBytes(cache.hit_bytes)
    } restored · ${Number(cache.items_saved || 0)} saved`,
    preparation: recommendation.preparation_class || "Preparation class is unknown",
    preflight: job.preflight?.state === "confirmed"
      ? `Confirmed · ${job.preflight.confidence || "unknown"} confidence · ${Number(
          job.preflight.history_sample_count || 0,
        )} history samples`
      : "Preflight details are not available",
    billing: billingLabel(job.billing),
    canCancel: Boolean(job.cancellation?.can_cancel),
    cancellationRequested: Boolean(job.cancellation?.requested),
    terminal: Boolean(job.terminal),
    events: Array.isArray(job.recent_events) ? job.recent_events : [],
    eventCount: Number(job.event_count || 0),
  }
}

export const cloudJobsIntervals = { active: ACTIVE_POLL_MS, idle: IDLE_POLL_MS }
