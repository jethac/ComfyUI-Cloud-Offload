import { app } from "/scripts/app.js"
import { api } from "/scripts/api.js"
import { compilePartitions } from "./partitionCompiler.js"

const COMMAND_MARK = "CloudOffload.MarkSelection"
const COMMAND_UNMARK = "CloudOffload.UnmarkSelection"
const COMMAND_CONFIGURE = "CloudOffload.ConfigureSelection"
const FLAG = "cloud_offload_partition"
const PROFILE = "comfyui-partition-v1"
const COLOR = "#4b63d3"
const RUNNING_COLOR = "#c58a17"
const COMPLETE_COLOR = "#2f8f55"
const FAILED_COLOR = "#b13c4a"

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
  return {
    version: 1,
    enabled: true,
    partition_id: uuid(),
    provider: "auto",
    profile: PROFILE,
    gpu_type: "any",
    min_gpu_ram_gb: 16,
    timeout_seconds: 3600,
    keep_warm: true,
  }
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
      <select name="provider"><option value="auto">Auto</option><option value="runpod">RunPod</option><option value="vast.ai">Vast.ai</option></select>
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
  runtime.progress = event.overall_progress ?? runtime.progress ?? 0
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

function typeMapFor(nodes) {
  const result = {}
  for (const node of nodes) {
    result[String(node.id)] = {
      inputs: Object.fromEntries((node.inputs || []).map((slot) => [slot.name, slot.type])),
      outputs: (node.outputs || []).map((slot) => slot.type),
    }
  }
  return result
}

function collectPartitions(graph) {
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
    partitions.push({
      ...settings,
      title: group.title,
      members: nodes.map((node) => String(node.id)),
      type_map: typeMapFor(nodes),
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
  async setup() {
    api.addEventListener("comfy.partition.progress", handlePartitionEvent)
    const original = app.graphToPrompt.bind(app)
    app.graphToPrompt = async function (...args) {
      const result = await original(...args)
      const graph = args[0] || app.graph
      const partitions = collectPartitions(graph)
      if (!partitions.length) return result
      const compiled = compilePartitions(result.output, partitions)
      result.output = compiled.prompt
      result.workflow.extra ||= {}
      result.workflow.extra.cloud_offload_partitions = partitions.map(({ type_map, runtime, ...item }) => item)
      return result
    }
  },
})
