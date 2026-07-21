import { app } from "/scripts/app.js"
import { api } from "/scripts/api.js"

// Cloud Offload preferences live in ComfyUI's own settings store, following the
// upstream extension convention (typed `settings` entries, dot-notation ids that
// categorize automatically, read/write through app.extensionManager.setting).
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
  const balance = entry.balance?.available
    ? ` · $${Number(entry.balance.credit ?? 0).toFixed(2)}`
    : ""
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

export function openProviderManager() {
  const overlay = document.createElement("div")
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:10000;background:#0008;display:grid;place-items:center"
  const panel = document.createElement("div")
  panel.style.cssText =
    "width:min(560px,calc(100vw - 32px));max-height:82vh;overflow:auto;padding:20px;border:1px solid #5368d8;border-radius:10px;background:#1b1d27;color:#eee;font:14px sans-serif;box-shadow:0 18px 60px #000a"
  panel.innerHTML = `<h2 style="margin:0 0 4px;font-size:18px">Cloud Offload providers</h2>
    <div style="opacity:.65;margin-bottom:12px;line-height:1.4">Credentials are sent to the coordinator and stored outside ComfyUI's settings file. Install additional providers as connector plugins.</div>
    <div data-list>Loading…</div>
    <div style="display:flex;justify-content:flex-end;margin-top:16px"><button type="button" data-action="close">Close</button></div>`
  overlay.appendChild(panel)
  document.body.appendChild(panel.ownerDocument === document ? overlay : overlay)

  const close = () => overlay.remove()
  panel.querySelector('[data-action="close"]').addEventListener("click", close)
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) close()
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
                ? `OK · ${payload.offer_count ?? 0} offers${
                    payload.balance?.available
                      ? ` · $${Number(payload.balance.credit ?? 0).toFixed(2)}`
                      : ""
                  }`
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
      label: "Cloud Offload: Manage providers",
      icon: "pi pi-cloud-upload",
      function: openProviderManager,
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
