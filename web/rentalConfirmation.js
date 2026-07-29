import { api } from "/scripts/api.js"
import {
  byteSize,
  candidateView,
  durationRange,
  moneyRange,
} from "./rentalConfirmationModel.js"

export { byteSize, candidateView, durationRange, moneyRange }

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function candidateById(report, candidateId) {
  return (report.candidates || []).find((item) => item.candidate_id === candidateId)
}

export function openRentalConfirmation(report, options = {}) {
  const doc = options.document || document
  const candidates = report.candidates || []
  if (!candidates.length) return Promise.reject(new Error("Preflight returned no GPU choices"))
  const recommendedId = report.recommendation?.candidate_id
  let selectedId = recommendedId || candidates[0].candidate_id
  const confirmation = report.confirmation || {}
  const canAutoStart = Boolean(confirmation.required && recommendedId)
  let paused = false
  let settled = false
  const countdownSeconds = Math.max(0, Number(confirmation.countdown_seconds || 0))
  const deadline = Date.now() + countdownSeconds * 1000

  return new Promise((resolve) => {
    const overlay = doc.createElement("div")
    overlay.dataset.cloudOffloadConfirmation = "1"
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:11000;background:#000a;display:grid;place-items:center;padding:16px"
    const panel = doc.createElement("div")
    panel.style.cssText =
      "width:min(620px,calc(100vw - 32px));max-height:88vh;overflow:auto;padding:22px;border:1px solid #6174ea;border-radius:12px;background:#171923;color:#f2f3fa;font:14px/1.45 sans-serif;box-shadow:0 22px 80px #000d"
    panel.innerHTML = `
      <div style="font-size:12px;color:#9eabea;text-transform:uppercase;letter-spacing:.08em">Cloud Offload rental</div>
      <div data-mandatory hidden style="margin:8px 0;padding:8px 10px;border:1px solid #d69b45;border-radius:7px;background:#3a2a14;color:#ffd89a">The GPU plan changed. Review and confirm it again before rental.</div>
      <h2 data-title style="margin:4px 0 2px;font-size:20px"></h2>
      <div data-region style="opacity:.72;margin-bottom:14px"></div>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:14px">
        <div style="padding:10px;background:#222637;border-radius:8px"><div style="opacity:.62;font-size:11px">PRICE</div><strong data-hourly></strong></div>
        <div style="padding:10px;background:#222637;border-radius:8px"><div style="opacity:.62;font-size:11px">ESTIMATED TOTAL</div><strong data-cost></strong></div>
        <div style="padding:10px;background:#222637;border-radius:8px"><div style="opacity:.62;font-size:11px">STARTUP</div><strong data-startup></strong></div>
        <div style="padding:10px;background:#222637;border-radius:8px"><div style="opacity:.62;font-size:11px">EXECUTION</div><strong data-execution></strong></div>
      </div>
      <div data-cache style="margin-bottom:8px"></div>
      <div data-rationale style="opacity:.82;margin-bottom:12px"></div>
      <button type="button" data-action="details">View cost and uncertainty details</button>
      <div data-details hidden style="margin:10px 0;padding:10px;background:#11131b;border-radius:8px"></div>
      <div data-choice hidden style="margin:12px 0">
        <label style="display:flex;flex-direction:column;gap:5px">Choose another GPU
          <select data-candidate style="width:100%;padding:7px"></select>
        </label>
      </div>
      <div data-countdown style="margin:16px 0 8px;font-size:16px;color:#c9d0ff"></div>
      <label style="display:flex;gap:8px;align-items:flex-start;margin:8px 0 16px">
        <input type="checkbox" data-dont-show />
        <span>Don't show this confirmation again.<br><small style="opacity:.65">Restore it in Cloud Offload settings.</small></span>
      </label>
      <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end">
        <button type="button" data-action="choose">Choose another GPU</button>
        <button type="button" data-action="cancel">Cancel</button>
        <button type="button" data-action="start" style="background:#5368d8;color:white;border:0;border-radius:5px;padding:7px 14px">Start now</button>
      </div>`
    overlay.appendChild(panel)
    doc.body.appendChild(overlay)
    panel.querySelector("[data-mandatory]").hidden = !confirmation.mandatory

    const select = panel.querySelector("[data-candidate]")
    for (const candidate of candidates) {
      const option = doc.createElement("option")
      const view = candidateView(candidate, report)
      option.value = candidate.candidate_id
      option.textContent = `${view.title} · ${view.hourly} · ${view.cost} · ${view.region}`
      select.appendChild(option)
    }
    select.value = selectedId

    const pause = () => {
      paused = true
      panel.querySelector("[data-countdown]").textContent = "Automatic start paused"
    }
    const render = () => {
      const candidate = candidateById(report, selectedId) || candidates[0]
      const view = candidateView(candidate, report)
      panel.querySelector("[data-title]").textContent = `${recommendedId === selectedId ? "Recommended: " : "Selected: "}${view.title}`
      panel.querySelector("[data-region]").textContent = view.region
      panel.querySelector("[data-hourly]").textContent = view.hourly
      panel.querySelector("[data-cost]").textContent = view.cost
      panel.querySelector("[data-startup]").textContent = view.startup
      panel.querySelector("[data-execution]").textContent = view.execution
      panel.querySelector("[data-cache]").textContent = `${view.coverage} · ${view.missing}`
      panel.querySelector("[data-rationale]").textContent = view.rationale.join(" ")
      panel.querySelector("[data-details]").innerHTML = `Confidence: <strong>${esc(view.confidence)}</strong><br>${(report.unknowns || []).map((item) => esc(item.message || item.code)).join("<br>") || "No additional uncertainty reported."}`
    }
    const finish = (action) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      const decision = {
        action,
        candidate_id: selectedId,
        dont_show_again: panel.querySelector("[data-dont-show]").checked,
      }
      overlay.remove()
      resolve(decision)
    }
    panel.querySelector('[data-action="start"]').addEventListener("click", () => finish("start_now"))
    panel.querySelector('[data-action="cancel"]').addEventListener("click", () => finish("cancel"))
    panel.querySelector('[data-action="choose"]').addEventListener("click", () => {
      panel.querySelector("[data-choice]").hidden = false
      pause()
    })
    panel.querySelector('[data-action="details"]').addEventListener("click", () => {
      const details = panel.querySelector("[data-details]")
      details.hidden = !details.hidden
      pause()
    })
    select.addEventListener("change", () => {
      selectedId = select.value
      pause()
      render()
    })
    overlay.addEventListener("pointerdown", (event) => {
      if (event.target === overlay) finish("cancel")
    })
    const countdown = panel.querySelector("[data-countdown]")
    const updateCountdown = () => {
      if (!canAutoStart) {
        countdown.textContent = "Select a GPU to continue"
        return
      }
      if (paused) return
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      countdown.textContent = `Starting in ${remaining} second${remaining === 1 ? "" : "s"}…`
      if (remaining === 0) finish("countdown_elapsed")
    }
    const timer = setInterval(updateCountdown, 200)
    render()
    updateCountdown()
  })
}

export async function postRentalDecision(confirmationId, decision, fetchApi = api.fetchApi) {
  const response = await fetchApi(
    `/cloud_offload/confirmations/${encodeURIComponent(confirmationId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(decision),
    },
  )
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
  return payload
}

let confirmationQueue = Promise.resolve()

export function handleRentalConfirmation(message) {
  const detail = message?.detail || message || {}
  if (!detail.confirmation_id || !detail.report) return
  confirmationQueue = confirmationQueue
    .then(() => openRentalConfirmation(detail.report))
    .then((decision) => postRentalDecision(detail.confirmation_id, decision))
    .catch((error) => {
      console.error("Cloud Offload rental confirmation failed", error)
      globalThis.alert?.(`Cloud Offload confirmation failed: ${error.message || error}`)
    })
}
