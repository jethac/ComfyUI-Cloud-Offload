export const DEFAULT_PREPARED_STORAGE = Object.freeze({
  enabled: false,
  provider: "runpod",
  policy: "smart",
  region: "auto",
  cold_fallback: "allow",
  managed_size_gb: 250,
  existing_volume_id: null,
  max_monthly_storage_cost: null,
  confirmed: false,
  tenant: "default",
  cache_private_assets: false,
  shadow_admission: true,
})

export const RUNPOD_NETWORK_VOLUME_MAX_GB = 4000

export function estimateRunPodStorageMonthly(sizeGb) {
  const size = Number(sizeGb) || 0
  return Number((Math.min(size, 1000) * 0.07 + Math.max(0, size - 1000) * 0.05).toFixed(2))
}

export function normalizePreparedStorage(value = {}) {
  const result = { ...DEFAULT_PREPARED_STORAGE, ...(value || {}) }
  result.enabled = Boolean(result.enabled) && result.policy !== "off"
  result.confirmed = Boolean(result.confirmed)
  result.cache_private_assets = Boolean(result.cache_private_assets)
  result.shadow_admission = Boolean(result.shadow_admission)
  const parsedSize = Number(result.managed_size_gb)
  result.managed_size_gb = Number.isFinite(parsedSize) ? parsedSize : 250
  result.region = String(result.region || "auto").trim() || "auto"
  result.existing_volume_id = String(result.existing_volume_id || "").trim() || null
  const budget = result.max_monthly_storage_cost
  result.max_monthly_storage_cost =
    budget === null || budget === undefined || budget === "" ? null : Number(budget)
  return result
}

export function validatePreparedStorage(policy) {
  const value = normalizePreparedStorage(policy)
  if (!new Set(["off", "smart", "strict", "pinned"]).has(value.policy)) {
    return "Choose a valid storage policy"
  }
  if (!new Set(["allow", "ask", "deny"]).has(value.cold_fallback)) {
    return "Choose a valid cold fallback"
  }
  if (value.policy === "pinned" && value.region.toLowerCase() === "auto") {
    return "Pinned storage needs a concrete RunPod datacenter"
  }
  if (
    value.max_monthly_storage_cost !== null &&
    (!Number.isFinite(value.max_monthly_storage_cost) || value.max_monthly_storage_cost < 0)
  ) {
    return "Storage budget must be zero or a positive number"
  }
  if (value.managed_size_gb < 1 || value.managed_size_gb > RUNPOD_NETWORK_VOLUME_MAX_GB) {
    return `Managed RunPod storage must be 1-${RUNPOD_NETWORK_VOLUME_MAX_GB} GB`
  }
  return null
}

export function disclosureFor(policy) {
  const value = normalizePreparedStorage(policy)
  return {
    provider: "RunPod Secure Cloud network volume",
    region:
      value.region === "auto"
        ? "a datacenter you select before creating storage"
        : value.region,
    size_gb: value.managed_size_gb,
    published_estimated_monthly_usd: estimateRunPodStorageMonthly(value.managed_size_gb),
    placement: `Cached runs are constrained to ${
      value.region === "auto" ? "the volume's datacenter" : value.region
    }.`,
    fallback: {
      allow: "If that region has no GPU, a smart run may launch cold elsewhere.",
      ask: "If that region has no GPU, Cloud Offload will wait for your decision.",
      deny: "If that region has no GPU, Cloud Offload will not launch elsewhere.",
    }[value.cold_fallback],
    private_assets: value.cache_private_assets
      ? "Gated/private model bytes may be written to provider storage."
      : "Gated/private model bytes are refused by the prepared cache.",
    deletion: "Deleting a managed provider volume is a separate confirmed action.",
  }
}

export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${value} B`
  const units = ["KiB", "MiB", "GiB", "TiB"]
  let size = value
  let unit = -1
  do {
    size /= 1024
    unit += 1
  } while (size >= 1024 && unit < units.length - 1)
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`
}

export function cacheBenefit(status = {}) {
  const benefit = status.recent_benefit || {}
  return {
    attempts: Number(benefit.attempts) || 0,
    bytes: formatBytes(benefit.bytes),
    saved: `${((Number(benefit.saved_ms) || 0) / 1000).toFixed(1)}s saved`,
    lost: `${((Number(benefit.lost_ms) || 0) / 1000).toFixed(1)}s slower`,
  }
}

export function volumeDeleteQuery(deleteProvider, providerVolumeId = null) {
  const query = new URLSearchParams({ delete_provider: String(Boolean(deleteProvider)) })
  if (providerVolumeId !== null) {
    query.set("confirm_provider_volume_id", String(providerVolumeId))
  }
  return query.toString()
}

function html(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]
  )
}

function problem(payload, status) {
  const detail = payload?.detail ?? payload?.error
  if (typeof detail === "string") return detail
  if (detail?.message) return detail.message
  return `HTTP ${status}`
}

export function mountPreparedStorage(
  container,
  {
    fetchApi,
    confirmAction = (message) => globalThis.confirm(message),
    promptAction = (message) => globalThis.prompt(message),
  }
) {
  let current = normalizePreparedStorage()
  let reviewedPolicy = null
  let status = { health: "ready", volumes: [], recent_benefit: {} }
  const border = "border:1px solid #3a3f55;border-radius:8px;padding:12px"
  container.innerHTML = `
    <fieldset style="${border};margin:0 0 12px">
      <legend style="padding:0 6px;opacity:.85">Prepared storage</legend>
      <label style="display:flex;gap:8px;align-items:flex-start;margin:4px 0 8px">
        <input data-cache-enabled type="checkbox" />
        <span><strong>Keep verified, eligible model artifacts between GPU rentals</strong><br />
        <span style="opacity:.65;font-size:12px">Opt-in. GPUs remain disposable; RunPod storage is billed separately.</span></span>
      </label>
      <div data-cache-off style="opacity:.7;font-size:12px">Off — Cloud Offload keeps its current stateless behavior.</div>
      <div data-cache-controls hidden>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px">
          <label>Policy
            <select data-cache-policy style="display:block;width:100%;margin-top:4px">
              <option value="smart">Smart (recommended)</option>
              <option value="strict">Strict cached region only</option>
              <option value="pinned">Pinned datacenter</option>
            </select>
          </label>
          <label>RunPod datacenter
            <input data-cache-region type="text" placeholder="auto or US-KS-2" style="display:block;width:100%;margin-top:4px" />
          </label>
          <label>When cached capacity is unavailable
            <select data-cache-fallback style="display:block;width:100%;margin-top:4px">
              <option value="allow">Run cold elsewhere</option>
              <option value="ask">Ask me</option>
              <option value="deny">Do not fall back</option>
            </select>
          </label>
          <label>Managed size (GB)
            <input data-cache-size type="number" min="1" max="4000" step="1" style="display:block;width:100%;margin-top:4px" />
          </label>
          <label>Monthly storage budget (USD)
            <input data-cache-budget type="number" min="0" step="1" placeholder="no ceiling" style="display:block;width:100%;margin-top:4px" />
          </label>
        </div>
        <details style="margin-top:10px">
          <summary>Advanced storage and privacy</summary>
          <label style="display:flex;gap:8px;align-items:flex-start;margin-top:8px">
            <input data-cache-private type="checkbox" />
            <span>Allow gated/private model bytes in provider storage</span>
          </label>
          <div data-cache-private-warning hidden style="margin:8px 0;padding:8px;border:1px solid #d8a24a;border-radius:6px;color:#efc36b;font-size:12px;line-height:1.4">
            Gated/private weights can be copied to a RunPod network volume. Provider-account users and workers able to attach that volume may be able to read them. Check the model licence and your residency rules first.
          </div>
        </details>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px">
          <button type="button" data-cache-save>Review &amp; enable</button>
          <button type="button" data-cache-refresh>Refresh status</button>
          <span data-cache-result style="font-size:12px;opacity:.85"></span>
        </div>
        <div data-cache-disclosure hidden style="margin-top:10px;padding:10px;border:1px solid #5368d8;border-radius:8px;background:#151824">
          <strong>Confirm durable storage</strong>
          <ul data-cache-disclosure-list style="margin:8px 0 8px 20px;padding:0;line-height:1.45"></ul>
          <label style="display:flex;gap:8px;align-items:flex-start">
            <input data-cache-understand type="checkbox" />
            <span>I understand the separate storage charge, placement constraint, fallback, privacy policy, and deletion behavior.</span>
          </label>
          <button type="button" data-cache-confirm style="margin-top:8px">Confirm and enable</button>
        </div>
        <div style="${border};margin-top:12px">
          <strong>Create or adopt a RunPod network volume</strong>
          <div style="opacity:.65;font-size:12px;margin:4px 0 8px">A managed volume is created only after confirmation. An adopted volume is never deleted by Cloud Offload.</div>
          <div style="display:flex;gap:6px;align-items:end;flex-wrap:wrap">
            <button type="button" data-cache-create>Create managed volume</button>
            <label style="flex:1;min-width:190px">Existing provider volume ID
              <input data-cache-adopt-id type="text" style="display:block;width:100%;margin-top:4px" />
            </label>
            <button type="button" data-cache-adopt>Adopt volume</button>
          </div>
        </div>
      </div>
      <div data-cache-status style="margin-top:12px"></div>
    </fieldset>`

  const find = (selector) => container.querySelector(selector)
  const enabled = find("[data-cache-enabled]")
  const controls = find("[data-cache-controls]")
  const off = find("[data-cache-off]")
  const result = find("[data-cache-result]")
  const disclosure = find("[data-cache-disclosure]")
  const privateInput = find("[data-cache-private]")
  const privateWarning = find("[data-cache-private-warning]")

  const say = (message, ok = true) => {
    result.textContent = message
    result.style.color = ok ? "#5fbf7f" : "#d8747f"
  }

  const request = async (path, options) => {
    const response = await fetchApi(path, options)
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(problem(payload, response.status))
    return payload
  }

  const renderPolicy = () => {
    enabled.checked = current.enabled
    controls.hidden = !enabled.checked
    off.hidden = enabled.checked
    find("[data-cache-policy]").value = current.policy === "off" ? "smart" : current.policy
    find("[data-cache-region]").value = current.region
    find("[data-cache-fallback]").value = current.cold_fallback
    find("[data-cache-size]").value = current.managed_size_gb
    find("[data-cache-budget]").value = current.max_monthly_storage_cost ?? ""
    privateInput.checked = current.cache_private_assets
    privateWarning.hidden = !privateInput.checked
    find("[data-cache-save]").textContent = current.confirmed ? "Save storage policy" : "Review & enable"
  }

  const invalidateReview = () => {
    reviewedPolicy = null
    disclosure.hidden = true
    const checkbox = find("[data-cache-understand]")
    if (checkbox) checkbox.checked = false
  }

  const readPolicy = () =>
    normalizePreparedStorage({
      ...current,
      enabled: enabled.checked,
      policy: enabled.checked ? find("[data-cache-policy]").value : "smart",
      region: find("[data-cache-region]").value,
      cold_fallback: find("[data-cache-fallback]").value,
      managed_size_gb: find("[data-cache-size]").value,
      max_monthly_storage_cost: find("[data-cache-budget]").value,
      cache_private_assets: privateInput.checked,
    })

  const renderStatus = () => {
    const benefit = cacheBenefit(status)
    const volumes = status.volumes || []
    find("[data-cache-status]").innerHTML = `
      <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:12px">
        <span>Health: <strong style="color:${status.health === "degraded" ? "#d8747f" : "#5fbf7f"}">${html(status.health || "unknown")}</strong></span>
        <span>${html(formatBytes(status.capacity_bytes))} registered</span>
        <span>${benefit.attempts} restores · ${benefit.bytes} · ${benefit.saved} · ${benefit.lost}</span>
      </div>
      <div data-cache-volumes>${
        volumes.length
          ? volumes
              .map(
                (volume) => `<div data-cache-volume="${html(volume.id)}" style="${border};margin-top:8px;font-size:12px">
                  <div><strong>${html(volume.provider_volume_id)}</strong> · ${html(volume.datacenter_id)} · ${html(volume.ownership)} · <span>${html(volume.status)}</span></div>
                  <div style="opacity:.65;margin:3px 0">${html(formatBytes(volume.capacity_bytes))}${volume.s3_compatible ? " · coordinator-side S3" : " · worker population"}${volume.last_verified_at ? ` · verified ${html(volume.last_verified_at)}` : ""}</div>
                  <div style="display:flex;gap:6px;flex-wrap:wrap">
                    <button type="button" data-cache-action="verify">Verify</button>
                    <button type="button" data-cache-action="detach">Detach</button>
                    ${volume.ownership === "managed" ? '<button type="button" data-cache-action="delete">Delete provider volume…</button>' : ""}
                  </div>
                </div>`
              )
              .join("")
          : '<div style="opacity:.65;font-size:12px;margin-top:8px">No cache volumes registered.</div>'
      }</div>`
  }

  const refresh = async () => {
    status = await request("/cloud_offload/cache/status")
    current = normalizePreparedStorage(status.policy)
    renderPolicy()
    renderStatus()
  }

  const persist = async (policy) => {
    const payload = await request("/cloud_offload/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prepared_storage: policy }),
    })
    current = normalizePreparedStorage(payload.config?.prepared_storage || policy)
    disclosure.hidden = true
    reviewedPolicy = null
    renderPolicy()
    say(current.enabled ? "Prepared storage enabled" : "Prepared storage disabled")
    await refresh()
  }

  enabled.addEventListener("change", () => {
    controls.hidden = !enabled.checked
    off.hidden = enabled.checked
    invalidateReview()
    if (!enabled.checked) persist({ ...readPolicy(), enabled: false, confirmed: current.confirmed }).catch((error) => say(error.message, false))
  })
  privateInput.addEventListener("change", () => {
    privateWarning.hidden = !privateInput.checked
  })
  for (const input of [
    find("[data-cache-policy]"),
    find("[data-cache-region]"),
    find("[data-cache-fallback]"),
    find("[data-cache-size]"),
    find("[data-cache-budget]"),
    privateInput,
  ]) {
    input.addEventListener("input", invalidateReview)
    input.addEventListener("change", invalidateReview)
  }

  find("[data-cache-save]").addEventListener("click", async () => {
    const policy = readPolicy()
    const invalid = validatePreparedStorage(policy)
    if (invalid) return say(invalid, false)
    if (!policy.enabled) return persist({ ...policy, confirmed: current.confirmed })
    if (current.confirmed) return persist({ ...policy, confirmed: true })
    const copy = disclosureFor(policy)
    find("[data-cache-disclosure-list]").innerHTML = [
      `${copy.provider}; ${copy.size_gb} GB in ${copy.region} (published estimate: $${copy.published_estimated_monthly_usd.toFixed(2)}/month).`,
      copy.placement,
      copy.fallback,
      copy.private_assets,
      copy.deletion,
    ]
      .map((line) => `<li>${html(line)}</li>`)
      .join("")
    find("[data-cache-understand]").checked = false
    reviewedPolicy = { ...policy }
    disclosure.hidden = false
    say("Review the disclosure below")
  })

  find("[data-cache-confirm]").addEventListener("click", () => {
    if (!find("[data-cache-understand]").checked) {
      return say("Confirm that you understand the disclosure", false)
    }
    if (!reviewedPolicy) return say("Storage controls changed; review the disclosure again", false)
    persist({ ...reviewedPolicy, enabled: true, confirmed: true }).catch((error) =>
      say(error.message, false)
    )
  })
  find("[data-cache-refresh]").addEventListener("click", () =>
    refresh().catch((error) => say(error.message, false))
  )

  find("[data-cache-create]").addEventListener("click", async () => {
    const policy = readPolicy()
    if (!current.enabled || !current.confirmed) return say("Enable and confirm storage first", false)
    if (policy.region.toLowerCase() === "auto") return say("Choose a concrete RunPod datacenter first", false)
    const estimate = estimateRunPodStorageMonthly(policy.managed_size_gb).toFixed(2)
    if (!confirmAction(`Create a ${policy.managed_size_gb} GB RunPod network volume in ${policy.region} (published estimate: $${estimate}/month)?`)) return
    try {
      await request("/cloud_offload/cache/volumes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "create",
          confirmed: true,
          datacenter_id: policy.region,
          size_gb: policy.managed_size_gb,
        }),
      })
      say("Managed volume created")
      await refresh()
    } catch (error) {
      say(error.message, false)
    }
  })

  find("[data-cache-adopt]").addEventListener("click", async () => {
    const providerId = find("[data-cache-adopt-id]").value.trim()
    if (!current.enabled || !current.confirmed) return say("Enable and confirm storage first", false)
    if (!providerId) return say("Enter an existing provider volume ID", false)
    if (!confirmAction(`Adopt RunPod network volume ${providerId}? Cloud Offload will never delete an adopted provider volume.`)) return
    try {
      const body = { operation: "adopt", confirmed: true, provider_volume_id: providerId }
      if (readPolicy().region.toLowerCase() !== "auto") body.datacenter_id = readPolicy().region
      await request("/cloud_offload/cache/volumes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      await persist({ ...readPolicy(), existing_volume_id: providerId, confirmed: true })
      say("Volume adopted")
    } catch (error) {
      say(error.message, false)
    }
  })

  container.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-cache-action]")
    if (!button) return
    const row = button.closest("[data-cache-volume]")
    const volume = (status.volumes || []).find((item) => item.id === row?.dataset.cacheVolume)
    if (!volume) return
    try {
      if (button.dataset.cacheAction === "verify") {
        if (!confirmAction(`Verify provider volume ${volume.provider_volume_id} and reconcile its signed inventory?`)) return
        await request(`/cloud_offload/cache/volumes/${encodeURIComponent(volume.id)}/verify`, {
          method: "POST",
        })
        say("Volume verified")
      } else if (button.dataset.cacheAction === "detach") {
        if (!confirmAction(`Detach ${volume.provider_volume_id} from Cloud Offload metadata? Provider storage will not be deleted.`)) return
        await request(`/cloud_offload/cache/volumes/${encodeURIComponent(volume.id)}?${volumeDeleteQuery(false)}`, {
          method: "DELETE",
        })
        say("Volume detached; provider bytes were kept")
      } else if (button.dataset.cacheAction === "delete") {
        const typed = promptAction(`This permanently deletes managed RunPod volume ${volume.provider_volume_id}. Type the provider volume ID to continue.`)
        if (typed !== volume.provider_volume_id) return say("Provider volume ID did not match; nothing deleted", false)
        if (!confirmAction(`Permanently delete ${volume.provider_volume_id} and its cached bytes?`)) return
        await request(
          `/cloud_offload/cache/volumes/${encodeURIComponent(volume.id)}?${volumeDeleteQuery(true, typed)}`,
          { method: "DELETE" }
        )
        say("Managed provider volume deleted")
      }
      await refresh()
    } catch (error) {
      say(error.message, false)
    }
  })

  renderPolicy()
  renderStatus()
  refresh().catch((error) => say(`Cache status unavailable: ${error.message}`, false))
}
