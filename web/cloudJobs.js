import { app } from "/scripts/app.js"
import { api } from "/scripts/api.js"
import {
  formatBytes,
  formatDuration,
  hasActiveJobs,
  jobView,
  mergeJobPage,
  pollDelay,
} from "./cloudJobsModel.js"

const JOBS_ROUTE = "/cloud_offload/jobs"
const PANEL_ID = "cloud-offload-jobs-panel"
const BUTTON_ID = "cloud-offload-jobs-button"
const OPEN_KEY = "cloud-offload.jobs.open"

const state = {
  jobs: [],
  loaded: false,
  error: null,
  timer: null,
  inFlight: false,
  cancelling: new Set(),
  cardOpen: new Map(),
}

function node(tag, className = "", text = null) {
  const result = document.createElement(tag)
  if (className) result.className = className
  if (text !== null) result.textContent = String(text)
  return result
}

function savedOpenState() {
  try {
    return globalThis.localStorage?.getItem(OPEN_KEY)
  } catch {
    return null
  }
}

function saveOpenState(open) {
  try {
    globalThis.localStorage?.setItem(OPEN_KEY, String(Boolean(open)))
  } catch {
    // The panel still works when browser storage is disabled.
  }
}

function panel() {
  return document.getElementById(PANEL_ID)
}

function setOpen(open, persist = true) {
  const drawer = panel()
  if (!drawer) return
  drawer.dataset.open = String(Boolean(open))
  drawer.setAttribute("aria-hidden", String(!open))
  document.getElementById(BUTTON_ID)?.setAttribute("aria-expanded", String(Boolean(open)))
  if (persist) saveOpenState(open)
}

export function openCloudJobs() {
  mountCloudJobs()
  setOpen(true)
  void refreshJobs()
}

function fact(label, value) {
  const item = node("div", "coj-fact")
  item.append(node("span", "coj-fact-label", label), node("span", "coj-fact-value", value))
  return item
}

function eventRow(event) {
  const row = node("li", "coj-event")
  const stamp = event.occurred_at ? new Date(event.occurred_at).toLocaleTimeString() : ""
  row.append(node("span", "coj-event-time", stamp), node("span", "", event.message || "Update"))
  if (event.bytes_total != null) {
    row.append(
      node(
        "span",
        "coj-event-metric",
        `${formatBytes(event.bytes_completed || 0)} / ${formatBytes(event.bytes_total)}`,
      ),
    )
  } else if (event.elapsed_seconds != null) {
    row.append(node("span", "coj-event-metric", formatDuration(event.elapsed_seconds)))
  }
  return row
}

async function cancelJob(jobId) {
  if (!jobId || state.cancelling.has(jobId)) return
  state.cancelling.add(jobId)
  renderJobs(true)
  try {
    const response = await api.fetchApi(
      `/cloud_offload/jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST" },
    )
    if (!response.ok) throw new Error("Cloud Offload could not cancel this job")
    await refreshJobs({ immediate: true })
  } catch (error) {
    state.error = String(error?.message || "Cloud Offload could not cancel this job")
  } finally {
    state.cancelling.delete(jobId)
    renderJobs(true)
  }
}

function jobCard(raw) {
  const view = jobView(raw)
  const card = node("section", `coj-card coj-${raw.status || "unknown"}`)
  const isOpen = state.cardOpen.has(view.id) ? state.cardOpen.get(view.id) : !view.terminal
  card.dataset.open = String(isOpen)
  const summary = node("div", "coj-summary")
  const summaryText = node("span", "coj-summary-text")
  summaryText.append(
    node("strong", "coj-title", view.title),
    node("span", "coj-stage", `${view.status} · ${view.stage}`),
    node("span", "coj-operation", view.operation),
  )
  const summaryMeta = node("span", "coj-summary-meta")
  summaryMeta.append(node("span", "coj-progress-text", view.progressText), node("span", "", view.elapsed))
  const toggle = node("button", "coj-toggle", isOpen ? "Hide details" : "Show details")
  toggle.type = "button"
  toggle.setAttribute("aria-expanded", String(isOpen))
  summary.append(summaryText, summaryMeta, toggle)
  card.append(summary)

  const body = node("div", "coj-body")
  body.hidden = !isOpen
  toggle.addEventListener("click", () => {
    const open = body.hidden
    body.hidden = !open
    card.dataset.open = String(open)
    state.cardOpen.set(view.id, open)
    toggle.textContent = open ? "Hide details" : "Show details"
    toggle.setAttribute("aria-expanded", String(open))
  })
  const progress = node("div", "coj-progress")
  const bar = node("span", "coj-progress-bar")
  bar.style.width = `${view.progress}%`
  progress.append(bar)
  body.append(progress)

  const primary = node("div", "coj-primary")
  primary.append(node("span", "", view.eta), node("span", "", view.spend), node("span", "", view.billing))
  body.append(primary)

  const grid = node("div", "coj-facts")
  for (const [label, value] of [
    ["Provider", view.provider],
    ["GPU", view.gpu],
    ["Region", view.region],
    ["Pod", view.podId],
    ["Resource lease", view.leaseId],
    ["Prepared volume", view.volumeId],
    ["Hourly rate", view.hourly],
    ["Expected total", view.expectedCost],
    ["Transfer", view.transfer],
    ["Throughput", view.throughput],
    ["Cache", view.cache],
    ["Preparation", view.preparation],
    ["Preflight", view.preflight],
    ["Provider closure", view.closure],
  ]) {
    grid.append(fact(label, value))
  }
  body.append(grid)

  const ids = node("div", "coj-ids")
  ids.append(node("span", "", `Job ${view.id}`))
  if (view.partitionId) ids.append(node("span", "", `Partition ${view.partitionId}`))
  body.append(ids)

  if (view.events.length) {
    const history = node("details", "coj-history")
    history.append(node("summary", "", `Recent events · ${view.events.length} of ${view.eventCount}`))
    const list = node("ol", "coj-event-list")
    for (const event of view.events) list.append(eventRow(event))
    history.append(list)
    body.append(history)
  }

  if (view.canCancel) {
    const cancel = node(
      "button",
      "coj-cancel",
      state.cancelling.has(view.id)
        ? "Cancelling…"
        : view.cancellationRequested
          ? "Cancellation requested"
          : "Cancel job",
    )
    cancel.type = "button"
    cancel.disabled = state.cancelling.has(view.id) || view.cancellationRequested
    cancel.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
      void cancelJob(view.id)
    })
    body.append(cancel)
  }
  card.append(body)
  return card
}

function renderJobs(force = false) {
  const drawer = panel()
  if (!drawer) return
  const list = drawer.querySelector("[data-jobs]")
  const status = drawer.querySelector("[data-status]")
  const count = document.getElementById(BUTTON_ID)?.querySelector("[data-count]")
  const activeCount = state.jobs.filter((job) => !job.terminal).length
  if (count) count.textContent = activeCount ? String(activeCount) : ""
  if (status) {
    status.textContent = state.error
      ? state.error
      : !state.loaded
        ? "Loading jobs…"
        : activeCount
          ? `${activeCount} active cloud job${activeCount === 1 ? "" : "s"}`
          : "No active cloud jobs"
    status.dataset.error = String(Boolean(state.error))
  }
  const renderKey = JSON.stringify(state.jobs)
  if (!force && list.dataset.renderKey === renderKey) return
  list.dataset.renderKey = renderKey
  list.replaceChildren()
  if (!state.jobs.length && state.loaded) {
    list.append(node("div", "coj-empty", "Cloud jobs will appear here after preflight."))
    return
  }
  for (const item of state.jobs) list.append(jobCard(item))
}

function scheduleRefresh() {
  if (state.timer) globalThis.clearTimeout(state.timer)
  state.timer = globalThis.setTimeout(() => void refreshJobs(), pollDelay(state.jobs))
}

export async function refreshJobs(options = {}) {
  if (state.inFlight && !options.immediate) return
  state.inFlight = true
  try {
    const response = await api.fetchApi(`${JOBS_ROUTE}?limit=20`)
    if (!response.ok) throw new Error("Cloud Offload coordinator is not available")
    const payload = await response.json()
    state.jobs = mergeJobPage(state.jobs, payload)
    state.loaded = true
    state.error = null
    if (hasActiveJobs(state.jobs) && savedOpenState() === null) setOpen(true, false)
  } catch (error) {
    state.error = String(error?.message || "Cloud Offload coordinator is not available")
  } finally {
    state.inFlight = false
    renderJobs()
    scheduleRefresh()
  }
}

function mountCloudJobs() {
  if (panel()) return
  const style = node("style")
  style.textContent = `
    #${PANEL_ID}{position:fixed;z-index:10020;top:0;right:0;width:min(440px,96vw);height:100vh;background:#17191f;color:#e8eaf0;border-left:1px solid #3b3f4b;box-shadow:-12px 0 35px #0008;transform:translateX(105%);transition:transform .18s ease;display:flex;flex-direction:column;font:13px/1.4 system-ui,sans-serif}
    #${PANEL_ID}[data-open="true"]{transform:translateX(0)}
    #${PANEL_ID} .coj-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid #343844;background:#20232b}
    #${PANEL_ID} .coj-head h2{font-size:17px;margin:0;flex:1}
    #${PANEL_ID} .coj-close{border:0;background:transparent;color:#cdd1da;font-size:22px;cursor:pointer}
    #${PANEL_ID} .coj-status{padding:9px 16px;color:#aeb5c3;border-bottom:1px solid #2b2f39}
    #${PANEL_ID} .coj-status[data-error="true"]{color:#f39aa2}
    #${PANEL_ID} .coj-list{overflow:auto;padding:10px;display:grid;gap:9px}
    #${PANEL_ID} .coj-card{border:1px solid #393e49;border-radius:8px;background:#20232a;overflow:hidden}
    #${PANEL_ID} .coj-card[data-open="true"]{border-color:#58647c}
    #${PANEL_ID} .coj-summary{display:flex;align-items:flex-start;gap:10px;padding:11px 12px}
    #${PANEL_ID} .coj-summary-text{display:grid;gap:2px;min-width:0;flex:1}
    #${PANEL_ID} .coj-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #${PANEL_ID} .coj-stage,#${PANEL_ID} .coj-operation{color:#b9c0ce;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #${PANEL_ID} .coj-operation{font-size:12px;color:#9099aa}
    #${PANEL_ID} .coj-summary-meta{display:grid;text-align:right;align-content:start;color:#c9cfda;white-space:nowrap}
    #${PANEL_ID} .coj-body{padding:0 12px 12px;display:grid;gap:10px}
    #${PANEL_ID} .coj-body[hidden]{display:none}
    #${PANEL_ID} .coj-toggle{border:1px solid #495166;border-radius:4px;background:#2b3140;color:#dce3f1;padding:4px 7px;white-space:nowrap;cursor:pointer}
    #${PANEL_ID} .coj-progress{height:5px;border-radius:4px;background:#303541;overflow:hidden}
    #${PANEL_ID} .coj-progress-bar{display:block;height:100%;background:#7289da;transition:width .2s linear}
    #${PANEL_ID} .coj-completed .coj-progress-bar{background:#51a96c}
    #${PANEL_ID} .coj-failed .coj-progress-bar,#${PANEL_ID} .coj-dead_letter .coj-progress-bar{background:#c95a66}
    #${PANEL_ID} .coj-primary{display:flex;flex-wrap:wrap;gap:5px 12px;color:#dbe0e9}
    #${PANEL_ID} .coj-facts{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px}
    #${PANEL_ID} .coj-fact{display:grid;min-width:0}
    #${PANEL_ID} .coj-fact-label{font-size:11px;color:#858e9f;text-transform:uppercase;letter-spacing:.04em}
    #${PANEL_ID} .coj-fact-value{overflow-wrap:anywhere}
    #${PANEL_ID} .coj-ids{display:grid;color:#858e9f;font:11px/1.4 ui-monospace,monospace;overflow-wrap:anywhere}
    #${PANEL_ID} .coj-history>summary{cursor:pointer;color:#b9c2d2}
    #${PANEL_ID} .coj-event-list{list-style:none;margin:7px 0 0;padding:0;display:grid;gap:5px}
    #${PANEL_ID} .coj-event{display:grid;grid-template-columns:68px 1fr auto;gap:6px;font-size:12px;color:#c6ccd7}
    #${PANEL_ID} .coj-event-time,#${PANEL_ID} .coj-event-metric{color:#818a9a;white-space:nowrap}
    #${PANEL_ID} .coj-cancel{justify-self:start;border:1px solid #9f4f58;border-radius:5px;background:#512d32;color:#ffd8dc;padding:6px 10px;cursor:pointer}
    #${PANEL_ID} .coj-cancel:disabled{opacity:.55;cursor:default}
    #${PANEL_ID} .coj-empty{padding:28px 15px;color:#929aaa;text-align:center}
    #${BUTTON_ID}{position:fixed;z-index:10010;right:18px;bottom:18px;border:1px solid #52617d;border-radius:20px;background:#262d3c;color:#edf2ff;padding:8px 13px;box-shadow:0 5px 18px #0007;cursor:pointer}
    #${BUTTON_ID} [data-count]:not(:empty){display:inline-grid;place-items:center;min-width:18px;height:18px;margin-left:6px;border-radius:10px;background:#d98d2b;color:#1b1408;font-weight:700}
    @media(max-width:560px){#${PANEL_ID} .coj-facts{grid-template-columns:1fr}}
  `
  document.head.append(style)

  const drawer = node("aside")
  drawer.id = PANEL_ID
  drawer.dataset.open = "false"
  drawer.setAttribute("aria-label", "Cloud Jobs")
  drawer.setAttribute("aria-hidden", "true")
  const head = node("div", "coj-head")
  head.append(node("h2", "", "Cloud Jobs"))
  const close = node("button", "coj-close", "×")
  close.type = "button"
  close.setAttribute("aria-label", "Close Cloud Jobs")
  close.addEventListener("click", () => setOpen(false))
  head.append(close)
  const status = node("div", "coj-status", "Loading jobs…")
  status.dataset.status = ""
  const list = node("div", "coj-list")
  list.dataset.jobs = ""
  drawer.append(head, status, list)

  const button = node("button", "", "Cloud Jobs")
  button.id = BUTTON_ID
  button.type = "button"
  button.setAttribute("aria-controls", PANEL_ID)
  button.setAttribute("aria-expanded", "false")
  const count = node("span")
  count.dataset.count = ""
  button.append(count)
  button.addEventListener("click", () => setOpen(panel()?.dataset.open !== "true"))
  document.body.append(drawer, button)

  const restored = savedOpenState()
  if (restored === "true") setOpen(true, false)
  renderJobs(true)
}

app.registerExtension({
  name: "CloudOffload.Jobs",
  commands: [
    {
      id: "CloudOffload.OpenJobs",
      label: "Cloud Offload: Open Cloud Jobs",
      icon: "pi pi-cloud",
      function: openCloudJobs,
    },
  ],
  actionBarButtons: [
    {
      icon: "pi pi-cloud",
      label: "Cloud Jobs",
      tooltip: "Show cloud job progress, cost, resource, and billing state",
      onClick: openCloudJobs,
    },
  ],
  setup() {
    mountCloudJobs()
    void refreshJobs()
    globalThis.addEventListener("online", () => void refreshJobs({ immediate: true }))
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void refreshJobs({ immediate: true })
    })
  },
})
