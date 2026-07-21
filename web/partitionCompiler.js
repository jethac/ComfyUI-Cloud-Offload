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

export function compilePartition(prompt, partition) {
  const local = clone(prompt)
  const members = new Set(partition.members.map(String))
  const prefix = `__kao_${safeId(partition.partition_id)}`
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
        class_type: "KaoPartitionInput",
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
          class_type: "KaoPartitionOutput",
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
    schema: "kao.partition.job.v1",
    partition_id: partition.partition_id,
    workflow: remote,
    inputs,
    outputs: outputs.map(({ extract_id, ...item }) => item),
    runner: {
      profile: partition.profile || "comfyui-omni",
      gpu_type: partition.gpu_type || "any",
      min_gpu_ram_gb: Number(partition.min_gpu_ram_gb || 16),
      keep_warm: partition.keep_warm !== false,
    },
  }
  gatewayInputs.partition_json = JSON.stringify(remoteSpec)
  local[gatewayId] = {
    class_type: "KaoCloudPartitionGateway",
    inputs: gatewayInputs,
    _meta: { title: partition.title || "Cloud Offload Partition" },
  }
  outputs.forEach((output) => {
    local[output.extract_id] = {
      class_type: "KaoCloudPartitionExtract",
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

export function compilePartitions(prompt, partitions) {
  let compiled = clone(prompt)
  const specs = []
  const claimed = new Set()
  for (const partition of partitions) {
    for (const nodeId of partition.members.map(String)) {
      if (claimed.has(nodeId)) throw new Error(`Node ${nodeId} belongs to overlapping Cloud Offload boxes`)
      claimed.add(nodeId)
    }
    const result = compilePartition(compiled, partition)
    compiled = result.prompt
    specs.push(result.remoteSpec)
  }
  return { prompt: compiled, specs }
}
