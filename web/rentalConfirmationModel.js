export function moneyRange(values) {
  const range = Array.isArray(values) ? values.map(Number) : []
  if (range.length < 2 || range.some((item) => !Number.isFinite(item))) return "Cost unknown"
  const digits = Math.max(...range.map(Math.abs)) < 0.1 ? 3 : 2
  return `$${range[0].toFixed(digits)}–$${range[1].toFixed(digits)}`
}

export function durationRange(values) {
  const range = Array.isArray(values) ? values.map(Number) : []
  if (range.length < 2 || range.some((item) => !Number.isFinite(item))) return "Time unknown"
  const format = (seconds) => {
    if (seconds < 60) return `${Math.max(0, Math.round(seconds))} sec`
    const minutes = seconds / 60
    return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} min`
  }
  return `${format(range[0])}–${format(range[1])}`
}

export function byteSize(value) {
  let amount = Math.max(0, Number(value || 0))
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount.toFixed(unit > 1 && amount < 10 ? 1 : 0)} ${units[unit]}`
}

export function candidateView(candidate = {}, report = {}) {
  const estimate = candidate.estimate || {}
  const preparation = candidate.preparation || {}
  const rationale = report.recommendation?.rationale || [
    `Compatible GPU choice${candidate.rank ? ` ranked ${candidate.rank}` : ""}.`,
  ]
  return {
    title: `${candidate.provider || "Provider"} · ${candidate.gpu_type || "GPU"}`,
    region: candidate.region || "Region selected at launch",
    hourly: Number.isFinite(Number(candidate.hourly_rate))
      ? `$${Number(candidate.hourly_rate).toFixed(2)}/hour`
      : "Hourly price unknown",
    cost: moneyRange(estimate.total_job_cost_usd),
    startup: durationRange(estimate.startup_seconds),
    execution: durationRange(estimate.execution_seconds),
    coverage: `${Number(preparation.coverage_percent || 0).toFixed(1)}% prepared`,
    missing: `${byteSize(preparation.missing_bytes)} missing`,
    confidence: estimate.confidence || "unknown",
    rationale,
  }
}
