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

// Taint roots: every node with a plain string widget value matching an on-prem
// asset pattern. Link arrays are references to other nodes, not asset names,
// so only string values are considered.
export function findTaintedNodes(prompt, patterns) {
  const tainted = new Map()
  const active = (patterns || []).filter((pattern) => String(pattern).trim())
  if (!active.length) return tainted
  for (const [nodeId, node] of Object.entries(prompt)) {
    for (const [inputName, value] of Object.entries(node.inputs || {})) {
      if (typeof value !== "string") continue
      if (!active.some((pattern) => globMatch(pattern, value))) continue
      tainted.set(String(nodeId), { asset: value, inputName })
      break
    }
  }
  return tainted
}

// An on-prem asset taints every value derived from it: BFS downstream over the
// prompt's links, where an input of the form [nodeId, slot] is an edge from
// that upstream node. Returns the roots plus everything they reach.
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
  const queue = [...tainted]
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
function checkResidency(prompt, members, onPremPatterns, residencyClass) {
  const taintedRoots = findTaintedNodes(prompt, onPremPatterns)
  if (!taintedRoots.size) return false
  const taintedNodes = propagateTaint(prompt, taintedRoots)
  const taintedMember = [...members].find((memberId) => taintedNodes.has(memberId))
  if (taintedMember === undefined) return false
  if (residencyClass !== "on-prem") {
    const rootId = taintRootFor(prompt, taintedRoots, taintedMember)
    const { asset } = taintedRoots.get(rootId)
    const title = prompt[rootId]?._meta?.title
    throw new Error(
      `Partition uses "${asset}", which is tagged on-prem only ` +
      `(introduced by node ${rootId}${title ? ` "${title}"` : ""}). ` +
      `Choose an on-prem backend for this partition, or remove the asset.`
    )
  }
  return true
}

export function compilePartition(prompt, partition, options = {}) {
  const { onPremPatterns = [], residencyClass = "cloud" } = options
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

  // Residency is checked before boundary bridging: a partition blocked for
  // on-prem-only assets must fail on that, not on an incidental type error.
  const tainted = checkResidency(local, members, onPremPatterns, residencyClass)

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
