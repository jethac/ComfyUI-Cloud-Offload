function duration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds || 0)))
  if (value < 60) return `${value}s`
  const minutes = Math.floor(value / 60)
  const remainder = value % 60
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`
}

function bytes(value) {
  let amount = Math.max(0, Number(value || 0))
  const units = ["B", "KB", "MB", "GB", "TB"]
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  const digits = unit > 1 && amount < 10 ? 1 : 0
  return `${amount.toFixed(digits)} ${units[unit]}`
}

function shortFile(value, limit = 30) {
  const name = String(value || "").split(/[\\/]/).pop()
  if (!name || name.length <= limit) return name
  return `${name.slice(0, limit - 9)}…${name.slice(-8)}`
}

/** A short, continuously changing label for long cloud setup phases. */
export function partitionProgressStatus(event = {}) {
  const elapsed = event.elapsed_seconds != null ? ` · ${duration(event.elapsed_seconds)}` : ""
  const file = shortFile(event.file)
  switch (event.type) {
    case "preflight_started":
      return "checking workflow and GPU options"
    case "preflight_ready":
      return event.confirmation_required ? "waiting for rental confirmation" : "GPU plan confirmed"
    case "preflight_changed":
      return "GPU plan changed · confirm again"
    case "confirmation_setting_failed":
      return "started · could not save confirmation setting"
    case "provider_request_started":
      return "requesting GPU"
    case "provider_request_progress":
      return `waiting for RunPod${elapsed}`
    case "provider_request_completed":
      return "GPU allocated"
    case "runner_starting":
      return "pulling image / starting ComfyUI"
    case "runner_starting_progress":
      return `pulling image / starting ComfyUI${elapsed}`
    case "cache_mount_ready":
      return "prepared storage mounted"
    case "cache_restore_started":
      return "checking prepared cache"
    case "cache_artifact_hit":
      return `cache hit${file ? ` · ${file}` : ""}${event.bytes ? ` · ${bytes(event.bytes)}` : ""}`
    case "cache_artifact_miss":
      return "cache miss · downloading origin"
    case "weights_staging": {
      const count = event.total_files
        ? ` ${Number(event.downloaded_files || 0) + 1}/${event.total_files}`
        : ""
      return file ? `checking model${count} · ${file}` : "models ready"
    }
    case "weight_download_progress":
      return `downloading${file ? ` ${file}` : " model"}${elapsed}`
    case "cache_population_started":
      return `saving${file ? ` ${file}` : " model"} to prepared storage`
    case "cache_population_progress":
      return `saving cache ${Number(event.percent || 0).toFixed(0)}%${elapsed}`
    case "cache_population_commit":
      if (event.commit_stage === "flushing") return `flushing${file ? ` ${file}` : " model"} to durable storage${elapsed}`
      if (event.commit_stage === "verifying") return `verifying durable cache${elapsed}`
      if (event.commit_stage === "publishing") return "publishing signed cache manifest"
      return "cache commit complete"
    case "cache_population_completed":
      return `saved to cache${event.bytes ? ` · ${bytes(event.bytes)}` : ""}`
    case "cache_restore_completed":
      return "prepared cache ready"
    case "execution_submitted":
      return "workflow submitted"
    case "execution_start":
      return "workflow starting"
    case "progress": {
      const value = Number(event.data?.value || 0)
      const max = Number(event.data?.max || 0)
      return max > 1 ? `processing · ${value}/${max}` : "processing"
    }
    case "progress_state": {
      const nodes = Object.values(event.data?.nodes || {})
      const finished = nodes.filter((node) => node?.state === "finished").length
      return nodes.length ? `running graph · ${finished}/${nodes.length} nodes` : "running graph"
    }
    case "phase_timing":
      if (event.phase === "staging_started") return "runner ready · preparing models"
      if (event.phase === "comfyui_ready") return "models ready · ComfyUI ready"
      if (event.phase === "execution_started") return "starting workflow"
      if (event.phase === "first_sampler") return "sampling"
      if (event.phase === "result_available") return "uploading result"
      return "working"
    default:
      return null
  }
}

export const progressFormatters = { bytes, duration, shortFile }
