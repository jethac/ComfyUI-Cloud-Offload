import { app } from "/scripts/app.js"

import { ON_PREM_SCOPES, parseOnPremEntries, serializeOnPremEntries } from "./onPremPolicy.js"
import { formatBalance } from "./providerBalance.js"
import { mountPreparedStorage } from "./preparedStorage.js"
import { api } from "/scripts/api.js"

// Per-box defaults live in ComfyUI's own settings store, following the upstream
// extension convention. Global rental, cost, residency, and provider policy
// lives in the coordinator so every browser and launch uses the same limits.
//
// Deliberate exception: provider API keys are NOT settings. ComfyUI persists
// settings to a plaintext comfy.settings.json that users export and share, so
// credentials are written to the coordinator instead, through
// POST /api/providers/{name}/credentials, and never round-trip to the browser.

export const SETTING_PROVIDER = "CloudOffload.Provider.Default"
export const SETTING_GPU_TYPE = "CloudOffload.Runner.GpuType"
export const SETTING_MIN_VRAM = "CloudOffload.Runner.MinVramGb"
export const SETTING_TIMEOUT = "CloudOffload.Runner.TimeoutMinutes"
export const SETTING_KEEP_WARM = "CloudOffload.Runner.KeepWarm"

const PROVIDERS_ROUTE = "/cloud_offload/providers"
const SPECS_ROUTE = `${PROVIDERS_ROUTE}/specs`

// The authoring form prefills from the Vast.ai spec Cloud Offload ships and
// actually runs on, fetched live from GET /providers/specs/vast.ai so it cannot
// drift from the file. That spec exercises every primitive at once: a
// JSON-encoded filter query, an MB->GB unit conversion, a templated path, body
// fields that vanish when empty, readiness polling after launch, and
// select-from-collection for a provider with no fetch-by-id route.
//
// Stripped from the prefill: keys the form's own fields own, plus the ones that
// only make sense for the provider being copied from. The engine derives a
// sensible settings_schema when a spec omits it.
const SPEC_PREFILL_OMIT = [
  "spec_version",
  "name",
  "aliases",
  "display_name",
  "base_url",
  "base_url_config_field",
  "auth",
  "settings_schema",
  "_source",
]

// Used only when the coordinator cannot serve the real spec, so the form is
// never an empty box. Deliberately minimal: a skeleton that is honest about
// being one beats a large copy that silently rots.
const FALLBACK_SKELETON = {
  endpoints: {
    offers: {
      method: "GET",
      path: "offers",
      items: "$.data",
      map: {
        id: { path: "$.id", type: "str", required: true },
        gpu_type: { path: "$.gpu.name", default: "unknown" },
        gpu_ram_gb: { path: "$.gpu.vram_mb", unit: "MB->GB", default: 0 },
        hourly_rate: { path: "$.price_per_hour", default: 0 },
      },
    },
  },
}

async function specSkeleton() {
  try {
    const payload = await specRequest("GET", "/vast.ai")
    const spec = payload?.spec
    if (!spec?.endpoints) return FALLBACK_SKELETON
    return Object.fromEntries(
      Object.entries(spec).filter(([key]) => !SPEC_PREFILL_OMIT.includes(key))
    )
  } catch {
    return FALLBACK_SKELETON
  }
}

function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]
  )
}

export function settingValue(id, fallback) {
  try {
    const value = app.extensionManager?.setting?.get(id)
    return value === undefined || value === null ? fallback : value
  } catch {
    return fallback
  }
}

export async function fetchProviders() {
  const response = await api.fetchApi(PROVIDERS_ROUTE)
  if (!response.ok) throw new Error(`providers ${response.status}`)
  return await response.json()
}

async function providerRequest(provider, action, body) {
  const response = await api.fetchApi(
    `${PROVIDERS_ROUTE}/${encodeURIComponent(provider)}/${action}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }
  )
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || payload?.detail || `HTTP ${response.status}`)
  return payload
}

async function specRequest(method, path = "", body) {
  const response = await api.fetchApi(`${SPECS_ROUTE}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  })
  const payload = await response.json().catch(() => ({}))
  // A failed dry run is a 200 carrying {"ok": false, "error": ...}: that is a
  // result about the provider, not a transport failure, so only the status
  // decides whether this throws.
  if (!response.ok) throw new Error(payload?.error || payload?.detail || `HTTP ${response.status}`)
  return payload
}

export async function fetchProviderSpecs() {
  return await specRequest("GET")
}

// Provider options are discovered at load time so plugin-registered connectors
// appear in the settings dropdown without shipping a new node pack.
let providerOptions = [{ text: "Auto (coordinator decides)", value: "auto" }]
try {
  const payload = await fetchProviders()
  providerOptions = [
    { text: "Auto (coordinator decides)", value: "auto" },
    ...(payload.providers || []).map((entry) => ({
      text: `${entry.display_name || entry.provider}${entry.configured ? "" : " — needs credentials"}`,
      value: entry.provider,
    })),
  ]
} catch {
  // Coordinator unreachable at page load; the manager dialog can still fix it.
}

function field(label, help = "") {
  return `<label style="display:grid;gap:4px;margin:8px 0">${label}${
    help ? `<span style="opacity:.6;font-size:12px">${help}</span>` : ""
  }`
}

function providerCard(entry) {
  const status = entry.configured
    ? `<span style="color:#5fbf7f">configured</span>`
    : `<span style="color:#d8a24a">no credentials</span>`
  const balance = formatBalance(entry.balance)
  const schema = entry.settings_schema || []
  const settingsFields = schema
    .map((item) => {
      const current = entry.settings?.[item.key] ?? item.default ?? ""
      if (item.type === "enum") {
        const options = (item.options || [])
          .map(
            (option) =>
              `<option value="${option}"${option === current ? " selected" : ""}>${option}</option>`
          )
          .join("")
        return `${field(item.label || item.key, item.help)}<select data-setting="${item.key}">${options}</select></label>`
      }
      const type = item.type === "int" ? "number" : "text"
      return `${field(item.label || item.key, item.help)}<input data-setting="${item.key}" type="${type}" value="${current}" /></label>`
    })
    .join("")

  return `
    <section data-provider="${entry.provider}" style="border:1px solid #3a3f55;border-radius:8px;padding:12px;margin:10px 0">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <strong>${entry.display_name || entry.provider}</strong>
        <span style="font-size:12px;opacity:.85">${entry.kind} · ${status}${balance}</span>
      </div>
      ${field("API key", "Stored by the coordinator, never in ComfyUI settings")}
        <input data-credential type="password" placeholder="${entry.configured ? "•••••••• (leave blank to keep)" : "paste key"}" autocomplete="off" />
      </label>
      ${settingsFields}
      <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
        <button type="button" data-action="save">Save</button>
        <button type="button" data-action="test">Test connection</button>
        <span data-result style="font-size:12px;opacity:.8"></span>
      </div>
    </section>`
}

// Labels for the auth types the coordinator reports. The list of types is the
// engine's; this only makes them readable, and an unknown one still renders.
const AUTH_TYPE_LABELS = {
  bearer: "Bearer token (Authorization: Bearer <key>)",
  header: "Custom header",
  query: "Query parameter",
  basic: "HTTP Basic",
  none: "No credential",
}

function specForm(authTypes, skeleton) {
  return `
    <section data-spec-form style="border:1px dashed #5368d8;border-radius:8px;padding:12px;margin:10px 0">
      <strong>Add a REST provider</strong>
      <div style="opacity:.7;font-size:12px;margin:6px 0 2px;line-height:1.45">
        This form writes a <em>declarative spec</em>, which covers providers whose API is
        JSON over REST with bearer, header, query-parameter or HTTP Basic auth.
        <b>GraphQL APIs, request signing (AWS SigV4) and multi-step provisioning cannot be
        expressed here</b> — those need a connector plugin: a Python file in
        <code>~/.cloud-offload/connectors/</code>. RunPod is coded for exactly that reason.
      </div>
      ${field("Name", "Lowercase identifier, also the file name (e.g. acme)")}
        <input data-spec="name" type="text" placeholder="acme" autocomplete="off" />
      </label>
      ${field("Display name")}
        <input data-spec="display_name" type="text" placeholder="Acme GPU" autocomplete="off" />
      </label>
      ${field("API base URL")}
        <input data-spec="base_url" type="text" placeholder="https://api.acme.dev/v1" autocomplete="off" />
      </label>
      ${field("Auth type")}
        <select data-spec="auth_type">
          ${authTypes
            .map(
              (value) =>
                `<option value="${esc(value)}">${esc(AUTH_TYPE_LABELS[value] || value)}</option>`
            )
            .join("")}
        </select>
      </label>
      ${field("Auth header / parameter name", "Only for the header and query auth types")}
        <input data-spec="auth_name" type="text" placeholder="X-Api-Key" autocomplete="off" />
      </label>
      ${field(
        "Endpoints and field mapping (JSON)",
        "Prefilled from the Vast.ai spec Cloud Offload ships and runs on. Edit the paths and map entries for your provider."
      )}
        <textarea data-spec="json" rows="14" spellcheck="false" style="font:12px ui-monospace,Consolas,monospace;resize:vertical">${esc(
          JSON.stringify(skeleton, null, 2)
        )}</textarea>
      </label>
      ${field(
        "API key for dry run",
        "Used for this one read-only probe. Not saved here or in ComfyUI. Blank reuses the key already stored for this provider name."
      )}
        <input data-spec="api_key" type="password" autocomplete="off" />
      </label>
      <div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap">
        <button type="button" data-action="validate">Validate</button>
        <button type="button" data-action="dry-run">Dry run</button>
        <button type="button" data-action="save-spec">Save</button>
        <span data-spec-result style="font-size:12px;opacity:.85"></span>
      </div>
      <pre data-spec-detail style="display:none;white-space:pre-wrap;word-break:break-word;font:12px ui-monospace,Consolas,monospace;background:#12141c;border-radius:6px;padding:8px;margin:10px 0 0;max-height:220px;overflow:auto"></pre>
    </section>`
}

function specCard(entry) {
  const state = entry.valid
    ? `<span style="color:#5fbf7f">valid${entry.registered ? " · registered" : ""}</span>`
    : `<span style="color:#d8747f">invalid</span>`
  const problems = entry.valid
    ? ""
    : `<ul style="margin:6px 0 0 18px;padding:0;font-size:12px;color:#d8a24a">${entry.problems
        .map((problem) => `<li>${esc(problem)}</li>`)
        .join("")}</ul>`
  return `
    <div data-spec-name="${esc(entry.name)}" style="border:1px solid #3a3f55;border-radius:8px;padding:10px;margin:8px 0">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <span><strong>${esc(entry.display_name || entry.name)}</strong> <span style="opacity:.6">${esc(entry.name)}</span></span>
        <span style="font-size:12px">${state}</span>
      </div>
      <div style="opacity:.55;font-size:11px;margin-top:4px;word-break:break-all">${esc(entry.source || "")}</div>
      ${problems}
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <button type="button" data-action="delete-spec">Delete</button>
        <span data-spec-row-result style="font-size:12px;opacity:.8"></span>
      </div>
    </div>`
}

async function mountSpecs(container) {
  const say = (element, message, ok = true) => {
    element.textContent = message
    element.style.color = ok ? "#5fbf7f" : "#d8747f"
  }

  // Both requests are independent, so issue them together.
  const [initial, skeleton] = await Promise.all([
    fetchProviderSpecs().catch((error) => ({ error })),
    specSkeleton(),
  ])

  // The form is mounted once and the list refreshes underneath it, so saving a
  // spec never wipes the draft the user is still editing.
  container.innerHTML = `
    <h3 style="margin:18px 0 4px;font-size:15px">Declarative provider specs</h3>
    <div data-spec-dir style="opacity:.6;font-size:12px;margin-bottom:6px;word-break:break-all"></div>
    <div data-spec-list style="opacity:.7;font-size:13px">Loading…</div>
    ${specForm(initial.auth_types || Object.keys(AUTH_TYPE_LABELS), skeleton)}`

  const listing = container.querySelector("[data-spec-list]")
  const directory = container.querySelector("[data-spec-dir]")
  const form = container.querySelector("[data-spec-form]")
  const result = form.querySelector("[data-spec-result]")
  const detail = form.querySelector("[data-spec-detail]")
  const read = (key) => form.querySelector(`[data-spec="${key}"]`).value.trim()
  const show = (text) => {
    detail.style.display = text ? "block" : "none"
    detail.textContent = text || ""
  }

  const render = (payload) => {
    const specs = payload.specs || []
    directory.textContent = payload.directory || ""
    listing.innerHTML = specs.length
      ? specs.map(specCard).join("")
      : "No user specs yet."
  }

  const refresh = () =>
    fetchProviderSpecs()
      .then(render)
      .catch((error) => {
        listing.innerHTML = `<span style="color:#d8747f">Provider specs unavailable: ${esc(
          error.message
        )}</span>`
      })

  // Delegated, so it is bound once and keeps working across re-renders.
  listing.addEventListener("click", async (event) => {
    if (!event.target.matches('[data-action="delete-spec"]')) return
    const row = event.target.closest("[data-spec-name]")
    const name = row.dataset.specName
    try {
      const deleted = await specRequest("DELETE", `/${encodeURIComponent(name)}`)
      await refresh()
      if (deleted.restart_required) {
        say(result, `Deleted ${name} — restart the coordinator to unregister it`)
      }
    } catch (error) {
      say(row.querySelector("[data-spec-row-result]"), String(error.message || error), false)
    }
  })

  // The form owns the identity fields; the textarea is the rest of the spec
  // verbatim, so a user can express anything the engine understands without the
  // form having to grow a control for it.
  const compose = () => {
    const extra = JSON.parse(form.querySelector('[data-spec="json"]').value || "{}")
    const authType = read("auth_type")
    const authName = read("auth_name")
    return {
      spec_version: 1,
      name: read("name").toLowerCase(),
      display_name: read("display_name") || read("name"),
      base_url: read("base_url"),
      auth: {
        type: authType,
        ...(authName && (authType === "header" || authType === "query")
          ? { name: authName }
          : {}),
      },
      ...extra,
    }
  }

  const withSpec = (handler) => async () => {
    show("")
    let spec
    try {
      spec = compose()
    } catch (error) {
      say(result, `Endpoint JSON is not valid: ${error.message}`, false)
      return
    }
    if (!spec.name) {
      say(result, "A name is required", false)
      return
    }
    try {
      await handler(spec)
    } catch (error) {
      say(result, String(error.message || error), false)
    }
  }

  form.querySelector('[data-action="validate"]').addEventListener(
    "click",
    withSpec(async (spec) => {
      const payload = await specRequest("POST", "/validate", { spec })
      if (payload.valid) {
        say(result, "Valid")
        return
      }
      say(result, `${payload.problems.length} problem(s)`, false)
      show(payload.problems.join("\n"))
    })
  )

  form.querySelector('[data-action="dry-run"]').addEventListener(
    "click",
    withSpec(async (spec) => {
      say(result, "Probing offers…")
      const payload = await specRequest("POST", "/dry-run", {
        spec,
        api_key: read("api_key") || undefined,
      })
      if (!payload.ok) {
        say(result, payload.error || "Dry run failed", false)
        show((payload.problems || []).join("\n"))
        return
      }
      say(result, `${payload.offer_count} offer(s)`)
      show(
        payload.sample
          ? `Mapped sample:\n${JSON.stringify(payload.sample, null, 2)}`
          : "The request succeeded but the provider returned no offers, so there is nothing to map."
      )
    })
  )

  form.querySelector('[data-action="save-spec"]').addEventListener(
    "click",
    withSpec(async (spec) => {
      const payload = await specRequest("PUT", `/${encodeURIComponent(spec.name)}`, {
        spec,
      })
      await refresh()
      say(
        result,
        payload.registered
          ? `Saved and registered as ${payload.name}`
          : `Saved to ${payload.source} (not registered)`
      )
      if (payload.errors?.length) show(payload.errors.join("\n"))
    })
  )

  // The listing was already fetched above; render it rather than asking again.
  if (initial.error) {
    listing.innerHTML = `<span style="color:#d8747f">Provider specs unavailable: ${esc(
      initial.error.message
    )}</span>`
  } else {
    render(initial)
  }
}

export function openProviderManager() {
  const overlay = document.createElement("div")
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:10000;background:#0008;display:grid;place-items:center"
  const panel = document.createElement("div")
  panel.style.cssText =
    "width:min(620px,calc(100vw - 32px));max-height:82vh;overflow:auto;padding:20px;border:1px solid #5368d8;border-radius:10px;background:#1b1d27;color:#eee;font:14px sans-serif;box-shadow:0 18px 60px #000a"
  panel.innerHTML = `<h2 style="margin:0 0 4px;font-size:18px">Cloud Offload settings</h2>
    <div style="opacity:.65;margin-bottom:12px;line-height:1.4">Credentials are sent to the coordinator and stored outside ComfyUI's settings file. Install additional providers as connector plugins.</div>
    <fieldset style="border:1px solid #3a3f55;border-radius:8px;padding:12px;margin:0 0 12px">
      <legend style="padding:0 6px;opacity:.85">Coordinator policy</legend>
      ${field("Max hourly rate (USD)", "The dispatcher never rents a GPU above this. Applies to every box.")}
        <input data-max-rate type="number" min="0" step="0.05" style="width:120px" />
      </label>
      ${field("Rental confirmation", "Always shows the short rental confirmation by default. Material changes still interrupt automatic launch when normal confirmation is hidden.")}
        <select data-rental-confirmation>
          <option value="always">Always</option>
          <option value="material_changes">Only material changes</option>
          <option value="never">Never for normal plans</option>
        </select>
      </label>
      ${field("Confirmation countdown (seconds)", "The default is 10 seconds. Start now remains available.")}
        <input data-confirmation-countdown type="number" min="0" max="60" step="1" style="width:120px" />
      </label>
      ${field("GPU recommendation", "Balanced is the default. Manual requires a GPU choice before launch.")}
        <select data-recommendation-policy>
          <option value="balanced">Balanced</option>
          <option value="cheapest">Cheapest total job</option>
          <option value="fastest">Fastest result</option>
          <option value="manual">Manual choice</option>
        </select>
      </label>
      ${field("Max estimated total job cost (USD)", "Optional hard limit. Leave empty for no separate total-cost limit; the hourly limit still applies.")}
        <input data-max-total-cost type="number" min="0" step="0.01" placeholder="no separate limit" style="width:160px" />
      </label>
      ${field("Allowed regions", "Optional comma-separated hard allowlist, for example US-MD-1, EU-RO-1.")}
        <input data-allowed-regions type="text" placeholder="all compatible regions" style="width:100%" />
      </label>
      ${field("Preferred and allowed providers", "Comma-separated provider order. Only configured providers in this list can be recommended automatically.")}
        <input data-provider-order type="text" placeholder="runpod, vast.ai" style="width:100%" />
      </label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${field("Material price change (%)", "A larger change restarts confirmation.")}
          <input data-material-price type="number" min="0" max="100" step="0.5" style="width:100px" />
        </label>
        ${field("Material total-cost change (%)", "A larger estimated cost change restarts confirmation.")}
          <input data-material-cost type="number" min="0" max="100" step="0.5" style="width:100px" />
        </label>
      </div>
      ${field("Public ingress", "How a rented worker reaches this coordinator. Auto opens a Cloudflare tunnel so you never paste a URL; it exposes the coordinator publicly, protected by the required access token.")}
        <select data-ingress>
          <option value="none">Manual — I set a coordinator URL myself</option>
          <option value="cloudflared">Automatic — open a Cloudflare tunnel</option>
        </select>
      </label>
      ${field("On-prem assets", "Globs (case-insensitive, * and ?) matched against asset names such as checkpoints and LoRAs. A partition that uses a matching asset is blocked from cloud backends at queue time. Weights only restricts the file itself, so images made with it can still be offloaded; Weights and outputs also restricts everything computed from it.")}
        <div data-on-prem-rows style="display:flex;flex-direction:column;gap:6px"></div>
      </label>
      <button type="button" data-action="add-on-prem" style="align-self:flex-start;margin-top:6px">Add pattern</button>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <button type="button" data-action="save-policy">Save</button>
        <span data-policy-result style="font-size:12px;opacity:.8"></span>
      </div>
    </fieldset>
    <div data-prepared-storage></div>
    <fieldset style="border:1px solid #3a3f55;border-radius:8px;padding:12px;margin:0 0 12px">
      <legend style="padding:0 6px;opacity:.85">RunPod S3 access</legend>
      <div style="opacity:.68;font-size:12px;line-height:1.4;margin-bottom:8px">A dedicated S3 API key lets the coordinator prepopulate and replicate network volumes without renting a GPU. Both values are stored in the OS keychain and never shown again.</div>
      ${field("Access key", "RunPod S3 access key, usually beginning with user_.")}
        <input data-s3-access type="password" placeholder="paste access key" autocomplete="off" />
      </label>
      ${field("Secret key", "The one-time RunPod S3 secret, usually beginning with rps_.")}
        <input data-s3-secret type="password" placeholder="paste secret key" autocomplete="off" />
      </label>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <button type="button" data-action="save-s3-credentials">Save S3 key pair</button>
        <span data-s3-status style="font-size:12px;opacity:.85"></span>
        <span data-s3-result style="font-size:12px;opacity:.8"></span>
      </div>
    </fieldset>
    <fieldset style="border:1px solid #3a3f55;border-radius:8px;padding:12px;margin:0 0 12px">
      <legend style="padding:0 6px;opacity:.85">Hugging Face token</legend>
      ${field("Access token", "Rented workers use it to download gated profile weights; public repos need none. Stored by the coordinator, never shown again. Prefer a fine-grained read-only token — a pod's environment is visible to the provider account.")}
        <input data-hf-token type="password" placeholder="paste token" autocomplete="off" />
      </label>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <button type="button" data-action="save-hf-token">Save</button>
        <span data-hf-status style="font-size:12px;opacity:.85"></span>
        <span data-hf-result style="font-size:12px;opacity:.8"></span>
      </div>
    </fieldset>
    <div data-list>Loading…</div>
    <div data-specs></div>
    <div style="display:flex;justify-content:flex-end;margin-top:16px"><button type="button" data-action="close">Close</button></div>`
  overlay.appendChild(panel)
  document.body.appendChild(panel.ownerDocument === document ? overlay : overlay)

  const close = () => overlay.remove()
  panel.querySelector('[data-action="close"]').addEventListener("click", close)
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) close()
  })

  mountPreparedStorage(panel.querySelector("[data-prepared-storage]"), {
    fetchApi: (...args) => api.fetchApi(...args),
  })

  // Coordinator policy: the hourly-rate ceiling is server state, not a
  // per-browser setting, so it is read from and written to the coordinator.
  const rateInput = panel.querySelector("[data-max-rate]")
  const rentalConfirmation = panel.querySelector("[data-rental-confirmation]")
  const confirmationCountdown = panel.querySelector("[data-confirmation-countdown]")
  const recommendationPolicy = panel.querySelector("[data-recommendation-policy]")
  const maxTotalCost = panel.querySelector("[data-max-total-cost]")
  const allowedRegions = panel.querySelector("[data-allowed-regions]")
  const providerOrder = panel.querySelector("[data-provider-order]")
  const materialPrice = panel.querySelector("[data-material-price]")
  const materialCost = panel.querySelector("[data-material-cost]")
  const ingressSelect = panel.querySelector("[data-ingress]")
  const onPremRows = panel.querySelector("[data-on-prem-rows]")
  const s3AccessInput = panel.querySelector("[data-s3-access]")
  const s3SecretInput = panel.querySelector("[data-s3-secret]")
  const s3Status = panel.querySelector("[data-s3-status]")
  const s3Result = panel.querySelector("[data-s3-result]")

  // One row per policy entry. The scope lives in a dropdown rather than a line
  // of text so a scoped entry can never be flattened into an unparseable string.
  const addOnPremRow = (entry = { pattern: "", scope: "derived" }) => {
    const row = document.createElement("div")
    row.dataset.onPremRow = "1"
    row.style.cssText = "display:flex;gap:6px;align-items:center"
    const pattern = document.createElement("input")
    pattern.type = "text"
    pattern.dataset.pattern = "1"
    pattern.placeholder = "studiox_*.safetensors"
    pattern.spellcheck = false
    pattern.value = entry.pattern
    pattern.style.cssText = "flex:1;font:12px ui-monospace,Consolas,monospace"
    const scope = document.createElement("select")
    scope.dataset.scope = "1"
    for (const option of ON_PREM_SCOPES) {
      const el = document.createElement("option")
      el.value = option.value
      el.textContent = option.label
      scope.appendChild(el)
    }
    scope.value = entry.scope
    const remove = document.createElement("button")
    remove.type = "button"
    remove.textContent = "✕"
    remove.title = "Remove this pattern"
    remove.addEventListener("click", () => row.remove())
    row.append(pattern, scope, remove)
    onPremRows.appendChild(row)
    return row
  }

  const readOnPremRows = () =>
    serializeOnPremEntries(
      [...onPremRows.querySelectorAll("[data-on-prem-row]")].map((row) => ({
        pattern: row.querySelector("[data-pattern]").value,
        scope: row.querySelector("[data-scope]").value,
      })),
    )

  panel
    .querySelector('[data-action="add-on-prem"]')
    .addEventListener("click", () => addOnPremRow())
  const policyResult = panel.querySelector("[data-policy-result]")

  // Hugging Face token: write-only, like the provider keys. The coordinator
  // only ever reports a boolean, so the field never echoes a stored value.
  const hfInput = panel.querySelector("[data-hf-token]")
  const hfStatus = panel.querySelector("[data-hf-status]")
  const hfResult = panel.querySelector("[data-hf-result]")
  const showHfConfigured = (configured) => {
    hfStatus.textContent = configured ? "configured" : "no token stored"
    hfStatus.style.color = configured ? "#5fbf7f" : "#d8a24a"
    hfInput.placeholder = configured ? "•••••••• (leave blank to keep)" : "paste token"
  }

  api.fetchApi("/cloud_offload/config")
    .then((response) => response.json())
    .then((payload) => {
      const cloud = payload.cloud || payload
      if (typeof cloud.max_hourly_rate === "number") rateInput.value = cloud.max_hourly_rate
      rentalConfirmation.value = cloud.rental_confirmation || "always"
      confirmationCountdown.value = Number(cloud.confirmation_countdown_seconds ?? 10)
      recommendationPolicy.value = cloud.recommendation_policy || "balanced"
      maxTotalCost.value = cloud.max_total_job_cost == null ? "" : cloud.max_total_job_cost
      allowedRegions.value = Array.isArray(cloud.allowed_regions) ? cloud.allowed_regions.join(", ") : ""
      providerOrder.value = Array.isArray(cloud.provider_order) ? cloud.provider_order.join(", ") : ""
      materialPrice.value = Number(cloud.material_price_change_percent ?? 5)
      materialCost.value = Number(cloud.material_cost_change_percent ?? 10)
      if (cloud.ingress) ingressSelect.value = cloud.ingress
      if (Array.isArray(cloud.on_prem_assets)) {
        onPremRows.replaceChildren()
        for (const entry of parseOnPremEntries(cloud.on_prem_assets)) addOnPremRow(entry)
      }
      showHfConfigured(Boolean(cloud.huggingface_configured))
    })
    .catch(() => {
      policyResult.textContent = "Coordinator unreachable"
      policyResult.style.color = "#d8747f"
    })
  api.fetchApi("/cloud_offload/cache/status")
    .then(async (response) => {
      const payload = await response.json().catch(() => ({}))
      s3Status.textContent = payload.s3_credentials_configured
        ? "Configured"
        : "Not configured"
      s3Status.style.color = payload.s3_credentials_configured ? "#5fbf7f" : "#d5a75f"
    })
    .catch(() => {
      s3Status.textContent = "Status unavailable"
    })
  panel.querySelector('[data-action="save-s3-credentials"]').addEventListener("click", async () => {
    const accessKey = s3AccessInput.value.trim()
    const secretKey = s3SecretInput.value.trim()
    if (!accessKey || !secretKey) {
      s3Result.textContent = "Paste both values"
      s3Result.style.color = "#d8747f"
      return
    }
    try {
      const response = await api.fetchApi("/cloud_offload/cache/s3-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_key: accessKey, secret_key: secretKey }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
      s3AccessInput.value = ""
      s3SecretInput.value = ""
      s3Status.textContent = "Configured"
      s3Status.style.color = "#5fbf7f"
      s3Result.textContent = "Saved"
      s3Result.style.color = "#5fbf7f"
    } catch (error) {
      s3Result.textContent = String(error.message || error)
      s3Result.style.color = "#d8747f"
    }
  })
  panel.querySelector('[data-action="save-hf-token"]').addEventListener("click", async () => {
    const token = hfInput.value.trim()
    if (!token) {
      hfResult.textContent = "Paste a token first"
      hfResult.style.color = "#d8747f"
      return
    }
    try {
      await providerRequest("huggingface", "credentials", { api_key: token })
      hfInput.value = ""
      hfResult.textContent = "Saved"
      hfResult.style.color = "#5fbf7f"
      showHfConfigured(true)
    } catch (error) {
      hfResult.textContent = String(error.message || error)
      hfResult.style.color = "#d8747f"
    }
  })
  panel.querySelector('[data-action="save-policy"]').addEventListener("click", async () => {
    const value = Number(rateInput.value)
    if (!Number.isFinite(value) || value <= 0) {
      policyResult.textContent = "Enter a positive rate"
      policyResult.style.color = "#d8747f"
      return
    }
    const onPremAssets = readOnPremRows()
    const countdown = Number(confirmationCountdown.value)
    const totalCost = maxTotalCost.value.trim() === "" ? null : Number(maxTotalCost.value)
    const priceTolerance = Number(materialPrice.value)
    const costTolerance = Number(materialCost.value)
    if (!Number.isInteger(countdown) || countdown < 0 || countdown > 60) {
      policyResult.textContent = "Countdown must be from 0 to 60 seconds"
      policyResult.style.color = "#d8747f"
      return
    }
    if (totalCost != null && (!Number.isFinite(totalCost) || totalCost <= 0)) {
      policyResult.textContent = "Enter a positive total cost or leave it empty"
      policyResult.style.color = "#d8747f"
      return
    }
    if (
      !Number.isFinite(priceTolerance) || priceTolerance < 0 || priceTolerance > 100 ||
      !Number.isFinite(costTolerance) || costTolerance < 0 || costTolerance > 100
    ) {
      policyResult.textContent = "Material change values must be from 0 to 100%"
      policyResult.style.color = "#d8747f"
      return
    }
    try {
      const response = await api.fetchApi("/cloud_offload/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          max_hourly_rate: value,
          max_total_job_cost: totalCost,
          recommendation_policy: recommendationPolicy.value,
          rental_confirmation: rentalConfirmation.value,
          confirmation_countdown_seconds: countdown,
          allowed_regions: allowedRegions.value.split(",").map((item) => item.trim()).filter(Boolean),
          provider_order: providerOrder.value.split(",").map((item) => item.trim()).filter(Boolean),
          material_price_change_percent: priceTolerance,
          material_cost_change_percent: costTolerance,
          ingress: ingressSelect.value,
          on_prem_assets: onPremAssets,
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
      policyResult.textContent = "Saved"
      policyResult.style.color = "#5fbf7f"
    } catch (error) {
      policyResult.textContent = String(error.message || error)
      policyResult.style.color = "#d8747f"
    }
  })

  const list = panel.querySelector("[data-list]")
  fetchProviders()
    .then((payload) => {
      const providers = payload.providers || []
      list.innerHTML = providers.length
        ? providers.map(providerCard).join("")
        : "<div style='opacity:.7'>No connectors registered.</div>"

      for (const section of list.querySelectorAll("[data-provider]")) {
        const name = section.dataset.provider
        const result = section.querySelector("[data-result]")
        const say = (message, ok = true) => {
          result.textContent = message
          result.style.color = ok ? "#5fbf7f" : "#d8747f"
        }

        section.querySelector('[data-action="save"]').addEventListener("click", async () => {
          try {
            const key = section.querySelector("[data-credential]").value
            if (key.trim()) await providerRequest(name, "credentials", { api_key: key.trim() })
            const settings = {}
            for (const input of section.querySelectorAll("[data-setting]")) {
              settings[input.dataset.setting] =
                input.type === "number" ? Number(input.value) : input.value
            }
            if (Object.keys(settings).length) await providerRequest(name, "settings", { settings })
            section.querySelector("[data-credential]").value = ""
            say("Saved")
          } catch (error) {
            say(String(error.message || error), false)
          }
        })

        section.querySelector('[data-action="test"]').addEventListener("click", async () => {
          say("Testing…")
          try {
            const payload = await providerRequest(name, "test")
            say(
              payload.ok
                ? `OK · ${payload.offer_count ?? 0} offers${formatBalance(payload.balance)}`
                : payload.error || "Failed",
              Boolean(payload.ok)
            )
          } catch (error) {
            say(String(error.message || error), false)
          }
        })
      }
    })
    .catch((error) => {
      list.innerHTML = `<div style="color:#d8747f">Coordinator unreachable: ${error.message}</div>`
    })

  mountSpecs(panel.querySelector("[data-specs]"))
}

app.registerExtension({
  name: "CloudOffload.Settings",

  aboutPageBadges: [
    {
      label: "Cloud Offload",
      url: "https://github.com/jethac/ComfyUI-Cloud-Offload",
      icon: "pi pi-cloud",
    },
  ],

  commands: [
    {
      id: "CloudOffload.ManageProviders",
      label: "Cloud Offload: Settings and providers",
      icon: "pi pi-cloud-upload",
      function: openProviderManager,
    },
  ],

  actionBarButtons: [
    {
      icon: "pi pi-cloud-upload",
      label: "Cloud Offload",
      tooltip: "Manage rental confirmation, cost limits, providers, and prepared storage",
      onClick: openProviderManager,
    },
  ],

  settings: [
    {
      id: SETTING_PROVIDER,
      category: ["Cloud Offload", "Provider", "Default provider"],
      name: "Default provider",
      tooltip:
        "Provider used by new Cloud Offload boxes. 'Auto' lets the coordinator choose by its routing policy.",
      type: "combo",
      options: providerOptions,
      defaultValue: "auto",
    },
    {
      id: SETTING_GPU_TYPE,
      category: ["Cloud Offload", "Runner", "GPU type"],
      name: "Default GPU type",
      tooltip: "'any' lets the coordinator pick the cheapest compatible GPU.",
      type: "text",
      defaultValue: "any",
    },
    {
      id: SETTING_MIN_VRAM,
      category: ["Cloud Offload", "Runner", "Minimum VRAM (GiB)"],
      name: "Minimum GPU VRAM (GiB)",
      type: "slider",
      attrs: { min: 4, max: 141, step: 1 },
      defaultValue: 16,
    },
    {
      id: SETTING_TIMEOUT,
      category: ["Cloud Offload", "Runner", "Timeout (minutes)"],
      name: "Execution timeout (minutes)",
      type: "number",
      attrs: { min: 1, max: 1440 },
      defaultValue: 60,
    },
    {
      id: SETTING_KEEP_WARM,
      category: ["Cloud Offload", "Runner", "Keep runner warm"],
      name: "Keep a compatible runner warm after a job",
      tooltip: "Avoids cold starts on the next job, but keeps paying for the GPU while idle.",
      type: "boolean",
      defaultValue: true,
    },
  ],
})
