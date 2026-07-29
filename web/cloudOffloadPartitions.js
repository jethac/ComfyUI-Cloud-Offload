import { app } from "/scripts/app.js"
import { api } from "/scripts/api.js"
import { compilePartitions, expandPartitionMembers } from "./partitionCompiler.js"
import { formatBalance } from "./providerBalance.js"
import { partitionProgressStatus } from "./progressFeedback.js"
import { handleRentalConfirmation } from "./rentalConfirmation.js"
import {
  SETTING_GPU_TYPE,
  SETTING_KEEP_WARM,
  SETTING_MIN_VRAM,
  SETTING_PROVIDER,
  SETTING_TIMEOUT,
  settingValue,
} from "./cloudOffloadSettings.js"

const COMMAND_MARK = "CloudOffload.MarkSelection"
const COMMAND_UNMARK = "CloudOffload.UnmarkSelection"
const COMMAND_CONFIGURE = "CloudOffload.ConfigureSelection"
const FLAG = "cloud_offload_partition"
const PROP_ON_PREM = "cloud_offload.on_prem"
const PROFILE = "comfyui-partition-v1"
const COLOR = "#4b63d3"
const RUNNING_COLOR = "#c58a17"
const COMPLETE_COLOR = "#2f8f55"
const FAILED_COLOR = "#b13c4a"
const ON_PREM_BADGE_BG = "#3b2f14"
const ON_PREM_BADGE_FG = "#e0ae4b"

// The two scopes the compiler understands, plus the absence of a mark. Ordered
// loosest first, which is also the order they read in the menu.
const ON_PREM_SCOPES = [
  [null, "Off"],
  ["weights", "Weights only"],
  ["derived", "Weights and outputs"],
]

function uuid() {
  return globalThis.crypto?.randomUUID?.() || `cloud-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function selectedItems() {
  return app.canvas?.selectedItems || new Set()
}

function selectedNodes() {
  return [...selectedItems()].filter((item) => Array.isArray(item.inputs) && Array.isArray(item.outputs))
}

function selectedCloudGroups() {
  return [...selectedItems()].filter((item) => item?.flags?.[FLAG])
}

function partitionSettings() {
  // New boxes inherit the user's ComfyUI settings; each box can still override.
  return {
    version: 1,
    enabled: true,
    partition_id: uuid(),
    provider: settingValue(SETTING_PROVIDER, "auto"),
    profile: PROFILE,
    gpu_type: settingValue(SETTING_GPU_TYPE, "any"),
    min_gpu_ram_gb: Number(settingValue(SETTING_MIN_VRAM, 16)),
    timeout_seconds: Math.max(60, Number(settingValue(SETTING_TIMEOUT, 60)) * 60),
    keep_warm: settingValue(SETTING_KEEP_WARM, true) !== false,
  }
}

// On-prem asset patterns are coordinator policy, fetched through the config
// proxy at queue time with a short cache. The fetch itself fails open — no
// patterns retrievable means no blocking — because a residency check must not
// brick queueing; the coordinator still refuses on-prem jobs at cloud
// backends, so the guarantee does not rest on this fetch.
const ON_PREM_PATTERN_CACHE_MS = 30 * 1000
let onPremPatternCache = null

async function fetchOnPremPatterns() {
  const now = Date.now()
  if (onPremPatternCache && now - onPremPatternCache.at < ON_PREM_PATTERN_CACHE_MS) {
    return onPremPatternCache.patterns
  }
  try {
    const response = await api.fetchApi("/cloud_offload/config")
    if (!response.ok) throw new Error(`config ${response.status}`)
    const payload = await response.json()
    const cloud = payload.cloud || payload
    const patterns = (Array.isArray(cloud.on_prem_assets) ? cloud.on_prem_assets : [])
      .map((pattern) => String(pattern).trim())
      .filter(Boolean)
    onPremPatternCache = { at: now, patterns }
    return patterns
  } catch (error) {
    console.warn(
      "Cloud Offload: on-prem asset patterns unavailable; queueing without residency blocking",
      error
    )
    return []
  }
}

// What a box needs from the runner — the model files it references and the node
// packs its node types come from — is known to this ComfyUI and to nothing else:
// only the server process can map a widget string to a model file, hash it, and
// say which pack defines a class_type. One POST answers both, so a box costs a
// single round trip at queue time. Cached briefly and keyed by the box's own
// nodes, because a compile pass that changed nothing must not rehash the same
// weights.
//
// This fetch fails open like the on-prem one — an unreachable route logs and
// queues without requirements — but for a different reason. The *contents* of a
// report we did receive fail closed: an unknown asset or an unattributable node
// type blocks in the compiler. Failing open here is safe only because a
// report-less job stamps nothing, and the coordinator treats such a job exactly
// as it did before these features existed: the runner gets its worker profile's
// static `weights` and `custom_nodes` and nothing else. Bricking every queue
// when the route is missing (an older node pack, a mid-upgrade reload) would be
// a worse trade than that fallback.
const REQUIREMENTS_CACHE_MS = 30 * 1000
const requirementsCache = new Map()

// Keyed by class_type as well as inputs: swapping a node for another type with
// the same widget values changes which pack the box needs, even when it changes
// no filename.
function requirementsKey(prompt, partition) {
  return JSON.stringify([
    partition.partition_id,
    partition.members.map((nodeId) => {
      const node = prompt[String(nodeId)]
      return node ? [node.class_type ?? null, node.inputs ?? null] : null
    }),
  ])
}

// Absent node_packs is not an empty node_packs: an older node pack server, or
// one whose detection failed, must leave the box unstamped rather than assert
// that it needs nothing.
function readNodePacks(payload) {
  const reported = payload.node_packs
  if (!reported || typeof reported !== "object") return null
  return {
    packs: Array.isArray(reported.packs) ? reported.packs : [],
    unknown: Array.isArray(reported.unknown) ? reported.unknown : [],
  }
}

async function fetchPartitionRequirements(prompt, partitions, modelSources) {
  const assetManifest = {}
  const nodePacks = {}
  const now = Date.now()
  for (const [key, entry] of requirementsCache) {
    if (now - entry.at >= REQUIREMENTS_CACHE_MS) requirementsCache.delete(key)
  }
  for (const partition of partitions) {
    const key = requirementsKey(prompt, partition)
    let entry = requirementsCache.get(key)
    if (!entry) {
      try {
        const response = await api.fetchApi("/cloud_offload/assets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            member_ids: partition.members.map(String),
            model_sources: modelSources,
          }),
        })
        if (!response.ok) throw new Error(`assets ${response.status}`)
        const payload = await response.json()
        entry = {
          at: now,
          manifest: {
            assets: Array.isArray(payload.assets) ? payload.assets : [],
            unknown: Array.isArray(payload.unknown) ? payload.unknown : [],
          },
          packs: readNodePacks(payload),
        }
        requirementsCache.set(key, entry)
      } catch (error) {
        console.warn(
          "Cloud Offload: partition requirements unavailable; queueing without " +
          "declared assets or node packs",
          error
        )
        continue
      }
    }
    assetManifest[partition.partition_id] = entry.manifest
    if (entry.packs) nodePacks[partition.partition_id] = entry.packs
  }
  return { assetManifest, nodePacks }
}

// Providers are discovered from the coordinator so plugin-registered connectors
// appear without shipping a new node pack. The dialog stays usable if the
// coordinator is unreachable: "Auto" is always present.
async function fetchProviders() {
  const response = await api.fetchApi("/cloud_offload/providers")
  if (!response.ok) throw new Error(`providers ${response.status}`)
  return await response.json()
}

function populateProviders(select, hint, selected) {
  fetchProviders().then((payload) => {
    const providers = payload?.providers || []
    if (!providers.length) return
    const previous = selected || select.value || "auto"
    select.innerHTML = '<option value="auto">Auto</option>'
    for (const entry of providers) {
      const option = document.createElement("option")
      option.value = entry.provider
      const balance = formatBalance(entry.balance)
      option.textContent = `${entry.display_name || entry.provider}${entry.configured ? balance : " (needs credentials)"}`
      option.disabled = !entry.configured
      select.appendChild(option)
    }
    select.value = [...select.options].some((option) => option.value === previous) ? previous : "auto"
    if (hint) {
      const policy = payload.routing_policy === "cheapest" ? "cheapest offer" : "preferred order"
      hint.textContent = `Auto uses the coordinator's ${policy}; default is ${payload.default_provider || "runpod"}`
    }
  }).catch(() => {
    if (hint) hint.textContent = "Coordinator unreachable — only Auto is available"
  })
}

function configureGroup(group = selectedCloudGroups()[0]) {
  if (!group) throw new Error("Select a Cloud Offload box to configure it")
  const settings = group.flags[FLAG]
  const overlay = document.createElement("div")
  overlay.style.cssText = "position:fixed;inset:0;z-index:10000;background:#0008;display:grid;place-items:center"
  const form = document.createElement("form")
  form.style.cssText = "width:min(440px,calc(100vw - 32px));padding:20px;border:1px solid #5368d8;border-radius:10px;background:#1b1d27;color:#eee;font:14px sans-serif;box-shadow:0 18px 60px #000a"
  form.innerHTML = `
    <h2 style="margin:0 0 16px;font-size:18px">Cloud Offload box</h2>
    <label style="display:grid;gap:6px;margin:10px 0">Provider
      <select name="provider"><option value="auto">Auto</option></select>
      <span name="provider_hint" style="opacity:.65"></span>
    </label>
    <label style="display:grid;gap:6px;margin:10px 0">GPU type <span style="opacity:.65">“any” chooses the cheapest compatible GPU</span>
      <input name="gpu_type" type="text" placeholder="any or RTX 4090" />
    </label>
    <label style="display:grid;gap:6px;margin:10px 0">Minimum GPU VRAM (GiB)
      <input name="min_gpu_ram_gb" type="number" min="1" max="256" step="1" />
    </label>
    <label style="display:grid;gap:6px;margin:10px 0">Execution timeout (minutes)
      <input name="timeout_minutes" type="number" min="1" max="1440" step="1" />
    </label>
    <label style="display:flex;gap:8px;align-items:center;margin:14px 0">
      <input name="keep_warm" type="checkbox" /> Keep a compatible runner warm after this job
    </label>
    <div style="opacity:.65;line-height:1.4">The box stays expanded. Its original nodes report live execution, progress, previews, and errors while running remotely.</div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px"><button type="button" name="cancel">Cancel</button><button type="submit">Save</button></div>`
  const controls = form.elements
  populateProviders(controls.provider, form.querySelector('[name="provider_hint"]'), settings.provider)
  controls.provider.value = settings.provider || "auto"
  controls.gpu_type.value = settings.gpu_type || "any"
  controls.min_gpu_ram_gb.value = Number(settings.min_gpu_ram_gb || 16)
  controls.timeout_minutes.value = Math.max(1, Math.round(Number(settings.timeout_seconds || 3600) / 60))
  controls.keep_warm.checked = settings.keep_warm !== false
  overlay.appendChild(form)
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  controls.cancel.addEventListener("click", close)
  overlay.addEventListener("pointerdown", (event) => { if (event.target === overlay) close() })
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    settings.provider = controls.provider.value
    settings.gpu_type = controls.gpu_type.value.trim() || "any"
    settings.min_gpu_ram_gb = Math.max(1, Math.min(256, Number(controls.min_gpu_ram_gb.value || 16)))
    settings.timeout_seconds = Math.max(60, Math.min(86400, Number(controls.timeout_minutes.value || 60) * 60))
    settings.keep_warm = controls.keep_warm.checked
    settings.base_title = `☁ Cloud Offload · ${settings.provider === "auto" ? "Auto" : settings.provider}`
    group.title = settings.base_title
    group.color = COLOR
    app.canvas?.setDirty?.(true, true)
    close()
  })
  controls.provider.focus()
}

function cloudGroups() {
  return [...(app.graph?._groups || app.graph?.groups || [])].filter((group) => group?.flags?.[FLAG])
}

function groupForPartition(partitionId) {
  return cloudGroups().find((group) => group.flags[FLAG].partition_id === partitionId)
}

function restoreRunningNodes(group) {
  for (const node of group?.children || group?._children || group?.nodes || []) {
    if (node.__cloudOffloadPreviousColor !== undefined) {
      node.color = node.__cloudOffloadPreviousColor
      delete node.__cloudOffloadPreviousColor
    }
  }
}

function markRemoteNode(group, nodeId, color) {
  const node = app.graph?.getNodeById?.(Number.isNaN(Number(nodeId)) ? nodeId : Number(nodeId))
  const members = [...(group?.children || group?._children || group?.nodes || [])]
  if (!node || !members.includes(node)) return
  if (node.__cloudOffloadPreviousColor === undefined) node.__cloudOffloadPreviousColor = node.color
  node.color = color
}

function previewPanel() {
  let panel = document.getElementById("cloud-offload-preview")
  if (panel) return panel
  panel = document.createElement("div")
  panel.id = "cloud-offload-preview"
  panel.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:9999;padding:8px;background:#171923dd;border:1px solid #4b63d3;border-radius:8px;color:white;font:12px sans-serif;display:none;max-width:280px"
  panel.innerHTML = '<div style="margin-bottom:5px">Cloud Offload preview</div><img style="display:block;max-width:264px;max-height:264px;border-radius:4px" />'
  document.body.appendChild(panel)
  return panel
}

function handlePartitionEvent(message) {
  const detail = message?.detail || message
  const partitionId = detail?.partition_id
  const event = detail?.event || {}
  const group = groupForPartition(partitionId)
  if (!group) return
  const settings = group.flags[FLAG]
  group.__cloudOffloadRuntime ||= {}
  const runtime = group.__cloudOffloadRuntime
  runtime.last_event = event
  runtime.job_id = event.job_id || runtime.job_id
  // Progress events from nested Comfy nodes can arrive interleaved with a
  // coarse 10% progress_state snapshot. Never make a live job move backward.
  runtime.progress = Math.max(
    Number(runtime.progress || 0),
    Number(event.overall_progress ?? runtime.progress ?? 0),
  )
  const baseTitle = settings.base_title || group.title.replace(/ · \d+%.*$/, "")
  settings.base_title = baseTitle

  if (event.type === "executing") {
    runtime.status = "running"
    restoreRunningNodes(group)
    markRemoteNode(group, event.node_id, RUNNING_COLOR)
  } else if (event.type === "execution_cached") {
    for (const nodeId of event.data?.nodes || []) markRemoteNode(group, nodeId, COMPLETE_COLOR)
  } else if (event.type === "executed") {
    markRemoteNode(group, event.node_id, COMPLETE_COLOR)
  } else if (event.type === "partition_failed" || event.type === "execution_error") {
    runtime.status = "failed"
    group.color = FAILED_COLOR
    markRemoteNode(group, event.node_id, FAILED_COLOR)
  } else if (event.type === "partition_completed") {
    runtime.status = "complete"
    restoreRunningNodes(group)
    group.color = COMPLETE_COLOR
  } else if (event.type === "provisioning_started") {
    runtime.status = `renting ${event.gpu_type || "GPU"}`
    group.color = RUNNING_COLOR
  } else if (event.type === "runner_starting") {
    runtime.status = `starting ${event.gpu_type || "runner"}`
    group.color = RUNNING_COLOR
  } else if (event.type === "provisioning_failed") {
    runtime.status = `retry in ${event.retry_seconds || "?"}s`
    group.color = RUNNING_COLOR
  } else if (event.type !== "preview") {
    runtime.status = partitionProgressStatus(event) || runtime.status
    group.color = RUNNING_COLOR
  }

  if (event.type === "preview" && event.data_base64) {
    const panel = previewPanel()
    const mimeType = ["image/jpeg", "image/png", "image/webp"].includes(event.mime_type)
      ? event.mime_type
      : "image/jpeg"
    panel.querySelector("img").src = `data:${mimeType};base64,${event.data_base64}`
    panel.style.display = "block"
  }
  const progress = Math.max(0, Math.min(100, Number(runtime.progress || 0)))
  const nodeLabel = event.node_id ? ` · node ${event.node_id}` : ""
  const statusLabel = runtime.status ? ` · ${runtime.status}` : ""
  group.title = `${baseTitle} · ${progress}%${statusLabel}${nodeLabel}`
  app.canvas?.setDirty?.(true, true)
}

function markSelection() {
  const canvas = app.canvas
  const nodes = selectedNodes()
  if (!canvas?.graph || nodes.length === 0) throw new Error("Select at least one node to offload")
  const group = new LiteGraph.LGraphGroup("☁ Cloud Offload · Auto")
  const padding = 44
  group.resizeTo(new Set(nodes), padding)
  group.color = COLOR
  group.flags ||= {}
  group.flags[FLAG] = partitionSettings()
  canvas.graph.add(group)
  group.recomputeInsideNodes()
  canvas.select(group)
  canvas.setDirty(true, true)
  configureGroup(group)
}

function unmarkSelection() {
  const canvas = app.canvas
  for (const group of selectedCloudGroups()) canvas.graph?.remove(group)
  canvas?.setDirty(true, true)
}

// A node's on-prem mark lives in a node property, so it serializes into the
// workflow and travels with it — unlike coordinator policy, which is a property
// of the installation. The menu and the badge are two views of that one value.
function onPremScope(node) {
  const scope = node?.properties?.[PROP_ON_PREM]
  return scope === "weights" || scope === "derived" ? scope : null
}

function setOnPremScope(nodes, scope) {
  for (const node of nodes) {
    node.properties ||= {}
    if (scope) node.properties[PROP_ON_PREM] = scope
    else delete node.properties[PROP_ON_PREM]
  }
  app.canvas?.setDirty?.(true, true)
}

// Right-clicking a node that is part of the selection marks the whole
// selection; right-clicking one outside it marks only that node.
function onPremTargets(node) {
  const selected = selectedNodes()
  return selected.includes(node) ? selected : [node]
}

function onPremMenuItem(node) {
  const current = onPremScope(node)
  return {
    content: "On-prem only",
    submenu: {
      options: ON_PREM_SCOPES.map(([scope, label]) => ({
        content: `${scope === current ? "●" : "○"} ${label}`,
        callback: () => setOnPremScope(onPremTargets(node), scope),
      })),
    },
  }
}

// Registered once per node as a callback, because the frontend re-runs it on
// every draw: clearing the property clears the badge without further wiring.
// A badge with no text measures and draws as nothing, which is the unmarked case.
function onPremBadge(node) {
  const scope = onPremScope(node)
  return new LGraphBadge({
    text: scope === "weights" ? "on-prem (weights)" : scope ? "on-prem" : "",
    fgColor: ON_PREM_BADGE_FG,
    bgColor: ON_PREM_BADGE_BG,
    fontSize: 10,
    height: 16,
    cornerRadius: 4,
  })
}

// Read from the live graph rather than the API prompt: properties are canvas
// state and never reach the prompt. Ids are stringified to match its keys.
function collectOnPremNodes(graph) {
  const marks = {}
  for (const node of graph?._nodes || graph?.nodes || []) {
    const scope = onPremScope(node)
    if (scope) marks[String(node.id)] = scope
  }
  return marks
}

function collectModelSources(workflow) {
  const sources = []
  const seen = new Set()
  const nodeLists = [
    workflow?.nodes,
    ...(workflow?.definitions?.subgraphs || []).map((definition) => definition?.nodes),
  ]
  for (const nodes of nodeLists) {
    for (const node of nodes || []) {
      for (const source of node?.properties?.models || []) {
        if (!source?.name || !source?.url || !source?.directory) continue
        const key = `${source.directory}\n${source.name}\n${source.url}`
        if (seen.has(key)) continue
        seen.add(key)
        sources.push({ name: source.name, url: source.url, directory: source.directory })
      }
    }
  }
  return sources
}

function collectPartitions(graph, prompt) {
  const partitions = []
  for (const group of graph?._groups || graph?.groups || []) {
    const settings = group?.flags?.[FLAG]
    if (!settings?.enabled) continue
    group.recomputeInsideNodes?.()
    const nodes = [...(group.children || group._children || group.nodes || [])]
      .filter((item) => Array.isArray(item.inputs) && Array.isArray(item.outputs))
    if (nodes.length === 0) throw new Error(`Cloud Offload box “${group.title}” contains no nodes`)
    if (group.title.startsWith("☁ Kao Cloud")) {
      group.title = group.title.replace("☁ Kao Cloud", "☁ Cloud Offload")
    }
    if (settings.base_title?.startsWith("☁ Kao Cloud")) {
      settings.base_title = settings.base_title.replace("☁ Kao Cloud", "☁ Cloud Offload")
    }
    settings.profile = PROFILE
    const expanded = expandPartitionMembers(prompt, nodes)
    partitions.push({
      ...settings,
      title: group.title,
      members: expanded.members,
      type_map: expanded.type_map,
    })
  }
  return partitions
}

app.registerExtension({
  name: "CloudOffload.Partitions",
  commands: [
    {
      id: COMMAND_MARK,
      label: "Cloud Offload selection",
      icon: "pi pi-cloud-upload",
      function: markSelection,
    },
    {
      id: COMMAND_UNMARK,
      label: "Remove Cloud Offload box",
      icon: "pi pi-cloud",
      function: unmarkSelection,
    },
    {
      id: COMMAND_CONFIGURE,
      label: "Configure Cloud Offload box",
      icon: "pi pi-cog",
      function: () => configureGroup(),
    },
  ],
  getSelectionToolboxCommands() {
    if (selectedCloudGroups().length) return [COMMAND_CONFIGURE, COMMAND_UNMARK]
    if (selectedNodes().length) return [COMMAND_MARK]
    return []
  },
  getNodeMenuItems(node) {
    return [onPremMenuItem(node)]
  },
  nodeCreated(node) {
    // Badges are a frontend feature, not a litegraph one; where they are absent
    // the property and its menu still work, only the marker is missing.
    if (typeof LGraphBadge !== "function" || !Array.isArray(node.badges)) return
    node.badges.push(() => onPremBadge(node))
  },
  async setup() {
    api.addEventListener("comfy.partition.progress", handlePartitionEvent)
    api.addEventListener("cloud_offload.confirmation", handleRentalConfirmation)
    const original = app.graphToPrompt.bind(app)
    app.graphToPrompt = async function (...args) {
      const result = await original(...args)
      const graph = args[0] || app.graph
      const partitions = collectPartitions(graph, result.output)
      if (!partitions.length) return result
      const requirements = await fetchPartitionRequirements(
        result.output,
        partitions,
        collectModelSources(result.workflow),
      )
      const compiled = compilePartitions(result.output, partitions, {
        onPremPatterns: await fetchOnPremPatterns(),
        onPremNodes: collectOnPremNodes(graph),
        assetManifest: requirements.assetManifest,
        nodePacks: requirements.nodePacks,
      })
      result.output = compiled.prompt
      result.workflow.extra ||= {}
      result.workflow.extra.cloud_offload_partitions = partitions.map(({ type_map, runtime, ...item }) => item)
      return result
    }
  },
})
