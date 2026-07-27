const LIVE_OBJECT_TYPES = new Set([
  "MODEL",
  "CLIP",
  "VAE",
  "CONTROL_NET",
  "SAMPLER",
  "SIGMAS",
  "GUIDER",
  "NOISE",
  "HOOKS",
  "MODEL_PATCH",
])

function clone(value) {
  return structuredClone(value)
}

function isLink(value) {
  return Array.isArray(value) && value.length === 2 &&
    (typeof value[0] === "string" || typeof value[0] === "number") &&
    Number.isInteger(value[1])
}

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "_")
}

function requirePortable(typeName, description) {
  const normalized = String(typeName || "").toUpperCase()
  if (!normalized || normalized === "*") {
    throw new Error(`${description} has no concrete portable type`)
  }
  if (LIVE_OBJECT_TYPES.has(normalized)) {
    throw new Error(
      `${description} is ${normalized}, which cannot cross a cloud boundary. ` +
      `Move its loader or producer into the Cloud Offload box.`
    )
  }
  return normalized
}

function nodeInputType(typeMap, nodeId, inputName) {
  return typeMap[String(nodeId)]?.inputs?.[inputName] || "*"
}

function nodeOutputType(typeMap, nodeId, outputIndex) {
  return typeMap[String(nodeId)]?.outputs?.[outputIndex] || "*"
}

// Case-insensitive fnmatch-style glob: `*` matches any run of characters
// (including none), `?` matches exactly one. Anchored to the whole string, so
// a pattern without wildcards is an exact (case-folded) match.
export function globMatch(pattern, value) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&")
  const source = escaped.replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${source}$`, "is").test(String(value))
}

// An on-prem entry is either a bare glob (strict: outputs are restricted too)
// or {pattern, scope}. Scope "weights" restricts only the file itself, which is
// what most licences actually say — you may not redistribute the weights, but
// the images they produce are yours. Scope "derived" additionally restricts
// everything computed from it, for material whose appearance is the secret.
export function normalizeOnPremPatterns(patterns) {
  const normalized = []
  for (const entry of patterns || []) {
    if (typeof entry === "string") {
      if (entry.trim()) normalized.push({ pattern: entry.trim(), scope: "derived" })
      continue
    }
    const pattern = String(entry?.pattern || "").trim()
    if (!pattern) continue
    const scope = entry?.scope === "weights" ? "weights" : "derived"
    normalized.push({ pattern, scope })
  }
  return normalized
}

// Taint roots: every node with a plain string widget value matching an on-prem
// asset pattern. Link arrays are references to other nodes, not asset names,
// so only string values are considered. Each root carries the scope of the
// pattern that matched, which decides whether its outputs travel, and the
// source of the restriction, which decides how the error reads.
export function findTaintedNodes(prompt, patterns) {
  const tainted = new Map()
  const active = normalizeOnPremPatterns(patterns)
  if (!active.length) return tainted
  for (const [nodeId, node] of Object.entries(prompt)) {
    for (const [inputName, value] of Object.entries(node.inputs || {})) {
      if (typeof value !== "string") continue
      const hit = active.find((entry) => globMatch(entry.pattern, value))
      if (!hit) continue
      tainted.set(String(nodeId), { asset: value, inputName, scope: hit.scope, source: "policy" })
      break
    }
  }
  return tainted
}

// A marked node names itself in the error the way a pattern match would: its
// first plain string input is almost always the file (ckpt_name, lora_name),
// and where there is none the title or class at least identifies it on screen.
function markedAsset(node) {
  for (const [inputName, value] of Object.entries(node.inputs || {})) {
    if (typeof value === "string") return { asset: value, inputName }
  }
  return { asset: node._meta?.title || node.class_type, inputName: null }
}

// Nodes carry their own mark in a `cloud_offload.on_prem` property, set from the
// canvas and serialized into the workflow, so a restriction can travel with the
// graph instead of living only in coordinator policy. `onPremNodes` maps node id
// to scope; an id the prompt does not contain (muted, bypassed) restricts nothing.
//
// Marks only ever tighten. Where policy already restricts a node the stricter
// scope wins — "derived" beats "weights" whichever side asked for it — so no
// amount of right-clicking loosens a restriction the coordinator imposed.
export function mergeNodeMarks(prompt, roots, onPremNodes) {
  const merged = new Map(roots)
  const marks = onPremNodes instanceof Map ? [...onPremNodes] : Object.entries(onPremNodes || {})
  for (const [markedId, markedScope] of marks) {
    if (!markedScope) continue
    const nodeId = String(markedId)
    const node = prompt[nodeId]
    if (!node) continue
    const scope = markedScope === "weights" ? "weights" : "derived"
    const policy = merged.get(nodeId)
    if (!policy) {
      merged.set(nodeId, { ...markedAsset(node), scope, source: "node" })
      continue
    }
    // Policy keeps its record — it names the asset it matched — and only the
    // scope moves, never below what the pattern already asked for.
    const tightest = policy.scope === "derived" || scope === "derived" ? "derived" : "weights"
    merged.set(nodeId, { ...policy, scope: tightest })
  }
  return merged
}

// A "derived"-scope asset taints every value computed from it: BFS downstream
// over the prompt's links, where an input of the form [nodeId, slot] is an edge
// from that upstream node. "weights"-scope roots are included as roots but seed
// nothing, so the file stays home while its outputs are free to travel.
export function propagateTaint(prompt, taintedRoots) {
  const consumers = new Map()
  for (const [nodeId, node] of Object.entries(prompt)) {
    for (const value of Object.values(node.inputs || {})) {
      if (!isLink(value)) continue
      const sourceId = String(value[0])
      if (!consumers.has(sourceId)) consumers.set(sourceId, [])
      consumers.get(sourceId).push(String(nodeId))
    }
  }
  const tainted = new Set([...taintedRoots.keys()].map(String))
  const queue = [...taintedRoots]
    .filter(([, root]) => root.scope !== "weights")
    .map(([nodeId]) => String(nodeId))
  while (queue.length) {
    for (const consumerId of consumers.get(queue.shift()) || []) {
      if (tainted.has(consumerId)) continue
      tainted.add(consumerId)
      queue.push(consumerId)
    }
  }
  return tainted
}

// Walk a tainted node's links upstream to the root that introduced the taint,
// so the error can name the asset rather than an innocent downstream node.
function taintRootFor(prompt, taintedRoots, nodeId) {
  const visited = new Set()
  const queue = [String(nodeId)]
  while (queue.length) {
    const currentId = queue.shift()
    if (visited.has(currentId)) continue
    visited.add(currentId)
    if (taintedRoots.has(currentId)) return currentId
    for (const value of Object.values(prompt[currentId]?.inputs || {})) {
      if (isLink(value)) queue.push(String(value[0]))
    }
  }
  return null
}

// A partition is cloud-eligible only if no tainted asset is referenced inside
// it and no tainted value crosses into it; propagation covers both, because a
// member fed by a tainted upstream is itself downstream-tainted. Returns
// whether the partition is tainted; for a cloud-class backend that is a
// blocking error raised before anything is uploaded or provisioned.
function checkResidency(prompt, members, onPremPatterns, onPremNodes, residencyClass) {
  const taintedRoots = mergeNodeMarks(prompt, findTaintedNodes(prompt, onPremPatterns), onPremNodes)
  if (!taintedRoots.size) return false
  const taintedNodes = propagateTaint(prompt, taintedRoots)
  const taintedMember = [...members].find((memberId) => taintedNodes.has(memberId))
  if (taintedMember === undefined) return false
  if (residencyClass !== "on-prem") {
    const rootId = taintRootFor(prompt, taintedRoots, taintedMember)
    const { asset, source } = taintedRoots.get(rootId)
    const title = prompt[rootId]?._meta?.title
    const where = `node ${rootId}${title ? ` "${title}"` : ""}`
    // A mark the user put on a node is cleared by the user, not by editing
    // policy, so the two restrictions ask for different things to be done.
    if (source === "node") {
      throw new Error(
        `Partition uses "${asset}", which is marked on-prem only on ${where}. ` +
        `Choose an on-prem backend for this partition, or clear the mark.`
      )
    }
    throw new Error(
      `Partition uses "${asset}", which is tagged on-prem only ` +
      `(introduced by ${where}). ` +
      `Choose an on-prem backend for this partition, or remove the asset.`
    )
  }
  return true
}

// The declared asset manifest is server-side truth: this file runs in the
// browser, where folder_paths is unreachable and a 7GB checkpoint cannot be
// hashed. POST /cloud_offload/assets does that work and returns, per box, the
// model files it references plus anything this ComfyUI could not identify.
// Keyed by partition_id because one compile pass carries every box in the graph.
//
// An unknown asset blocks: shipping a partial manifest would turn an honest
// post-provision failure into a green light followed by a paid one. A missing
// manifest does not block — see cloudOffloadPartitions.js for that seam.
function partitionAssets(partition, assetManifest) {
  const manifest = assetManifest?.[partition.partition_id]
  if (!manifest) return null
  const unknown = manifest.unknown || []
  if (unknown.length) {
    const { value, node_id } = unknown[0]
    throw new Error(
      `Partition references "${value}" (node ${node_id}), which is not a known ` +
      `model file on this ComfyUI. Cloud Offload cannot guarantee the runner has it — ` +
      `install it locally or remove the node from the box.`
    )
  }
  const assets = manifest.assets || []
  return assets.length ? clone(assets) : null
}

// The required node packs are the other half of the same question the asset
// manifest answers, and arrive by the same route: only the ComfyUI process can
// say which pack defines a node type, so it reports them per box, keyed by
// partition_id. A pack record carries its content digest, because a declared
// version cannot distinguish a patched pack from the unpatched release that
// shares its version number.
//
// An unattributable node type blocks for the same reason an unknown asset does:
// a requirement list missing a pack is worse than no list at all. A missing
// report does not block — see cloudOffloadPartitions.js for that seam.
function partitionNodePacks(partition, nodePacks) {
  const required = nodePacks?.[partition.partition_id]
  if (!required) return null
  const unknown = required.unknown || []
  if (unknown.length) {
    const { class_type, node_id } = unknown[0]
    throw new Error(
      `Partition uses node type "${class_type}" (node ${node_id}), which this ` +
      `ComfyUI cannot attribute to a node pack. Cloud Offload cannot guarantee ` +
      `the runner has it — remove the node from the box.`
    )
  }
  const packs = required.packs || []
  return packs.length ? clone(packs) : null
}

export function compilePartition(prompt, partition, options = {}) {
  const {
    onPremPatterns = [],
    onPremNodes = null,
    residencyClass = "cloud",
    assetManifest = null,
    nodePacks = null,
  } = options
  const local = clone(prompt)
  const members = new Set(partition.members.map(String))
  const prefix = `__comfy_${safeId(partition.partition_id)}`
  const remote = {}
  const gatewayInputs = {
    partition_json: "",
    provider: partition.provider || "auto",
    timeout_seconds: Number(partition.timeout_seconds || 3600),
  }
  const inputs = []
  const outputs = []
  const outputBySource = new Map()

  for (const memberId of members) {
    if (!local[memberId]) {
      throw new Error(`Cloud Offload partition references missing node ${memberId}`)
    }
    remote[memberId] = clone(local[memberId])
  }

  // Residency, assets and node packs are checked before boundary bridging: a
  // partition blocked for on-prem-only assets, or for a model or node type this
  // ComfyUI cannot identify, must fail on that, not on an incidental type error.
  const tainted = checkResidency(local, members, onPremPatterns, onPremNodes, residencyClass)
  const assets = partitionAssets(partition, assetManifest)
  const requiredPacks = partitionNodePacks(partition, nodePacks)

  for (const memberId of members) {
    const node = remote[memberId]
    for (const [inputName, value] of Object.entries(node.inputs || {})) {
      if (!isLink(value) || members.has(String(value[0]))) continue
      const key = `input_${String(inputs.length).padStart(4, "0")}`
      const typeName = requirePortable(
        nodeInputType(partition.type_map, memberId, inputName),
        `Input ${memberId}.${inputName}`
      )
      const bridgeId = `${prefix}_remote_${key}`
      remote[bridgeId] = {
        class_type: "CloudPartitionInput",
        inputs: { boundary_key: key, artifact_path: "", type_name: typeName },
        _meta: { title: `Cloud Offload Input: ${inputName}` },
      }
      node.inputs[inputName] = [bridgeId, 0]
      gatewayInputs[key] = clone(value)
      inputs.push({ key, type: typeName, target_node: memberId, target_input: inputName })
    }
  }

  for (const [outsideId, outsideNode] of Object.entries(local)) {
    if (members.has(outsideId)) continue
    for (const [inputName, value] of Object.entries(outsideNode.inputs || {})) {
      if (!isLink(value) || !members.has(String(value[0]))) continue
      const sourceKey = `${value[0]}:${value[1]}`
      let boundary = outputBySource.get(sourceKey)
      if (!boundary) {
        const key = `output_${String(outputs.length).padStart(4, "0")}`
        const typeName = requirePortable(
          nodeOutputType(partition.type_map, value[0], value[1]),
          `Output ${value[0]}[${value[1]}]`
        )
        const captureId = `${prefix}_remote_${key}`
        remote[captureId] = {
          class_type: "CloudPartitionOutput",
          inputs: {
            value: clone(value),
            boundary_key: key,
            output_path: "",
            type_name: typeName,
          },
          _meta: { title: `Cloud Offload Output: ${typeName}` },
        }
        const extractId = `${prefix}_extract_${String(outputs.length).padStart(4, "0")}`
        boundary = { key, type: typeName, source_node: String(value[0]), source_output: value[1], extract_id: extractId }
        outputBySource.set(sourceKey, boundary)
        outputs.push(boundary)
      }
      outsideNode.inputs[inputName] = [boundary.extract_id, 0]
    }
  }

  for (const memberId of members) delete local[memberId]

  const gatewayId = `${prefix}_gateway`
  const remoteSpec = {
    schema: "comfy.partition.job.v1",
    partition_id: partition.partition_id,
    // Only stamped when tainted: the coordinator refuses "on-prem" jobs at
    // cloud backends, so the field is the compiled form of the taint analysis.
    ...(tainted ? { residency: "on-prem" } : {}),
    // Omitted when the box references no model files, and when no manifest was
    // available: the coordinator's behaviour for a manifest-less job is exactly
    // what it was before declared assets existed.
    ...(assets ? { assets } : {}),
    // Omitted when the box needs only core node types, and when no report was
    // available: the coordinator's behaviour for a job without node_packs is
    // exactly what it was before node pack requirements existed.
    ...(requiredPacks ? { node_packs: requiredPacks } : {}),
    workflow: remote,
    inputs,
    outputs: outputs.map(({ extract_id, ...item }) => item),
    runner: {
      profile: partition.profile || "comfyui-partition-v1",
      gpu_type: partition.gpu_type || "any",
      min_gpu_ram_gb: Number(partition.min_gpu_ram_gb || 16),
      keep_warm: partition.keep_warm !== false,
    },
  }
  gatewayInputs.partition_json = JSON.stringify(remoteSpec)
  local[gatewayId] = {
    class_type: "CloudPartitionGateway",
    inputs: gatewayInputs,
    _meta: { title: partition.title || "Cloud Offload Partition" },
  }
  outputs.forEach((output) => {
    local[output.extract_id] = {
      class_type: "CloudPartitionExtract",
      inputs: {
        result: [gatewayId, 0],
        boundary_key: output.key,
        type_name: output.type,
      },
      _meta: { title: `Cloud Offload Result: ${output.type}` },
    }
  })
  return { prompt: local, remoteSpec, gatewayId }
}

export function compilePartitions(prompt, partitions, options = {}) {
  let compiled = clone(prompt)
  const specs = []
  const claimed = new Set()
  for (const partition of partitions) {
    for (const nodeId of partition.members.map(String)) {
      if (claimed.has(nodeId)) throw new Error(`Node ${nodeId} belongs to overlapping Cloud Offload boxes`)
      claimed.add(nodeId)
    }
    const result = compilePartition(compiled, partition, options)
    compiled = result.prompt
    specs.push(result.remoteSpec)
  }
  return { prompt: compiled, specs }
}
