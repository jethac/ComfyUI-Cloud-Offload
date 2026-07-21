import assert from "node:assert/strict"
import test from "node:test"

import { compilePartition, compilePartitions } from "./partitionCompiler.js"

function fixture(type = "IMAGE") {
  return {
    prompt: {
      "1": { class_type: "LoadImage", inputs: { image: "input.png" } },
      "2": { class_type: "CloudA", inputs: { image: ["1", 0], amount: 2 } },
      "3": { class_type: "CloudB", inputs: { image: ["2", 0] } },
      "4": { class_type: "PreviewImage", inputs: { images: ["3", 0] } },
    },
    partition: {
      partition_id: "partition-one",
      provider: "runpod",
      members: ["2", "3"],
      type_map: {
        "2": { inputs: { image: type }, outputs: [type] },
        "3": { inputs: { image: type }, outputs: [type] },
      },
    },
  }
}

test("compiles selected nodes into a gateway and typed bridges", () => {
  const { prompt, partition } = fixture()
  const result = compilePartition(prompt, partition)

  assert.equal(result.prompt["2"], undefined)
  assert.equal(result.prompt["3"], undefined)
  const gateway = result.prompt[result.gatewayId]
  assert.equal(gateway.class_type, "CloudPartitionGateway")
  assert.equal(result.remoteSpec.runner.profile, "comfyui-partition-v1")
  assert.deepEqual(gateway.inputs.input_0000, ["1", 0])
  const extract = Object.values(result.prompt).find((node) => node.class_type === "CloudPartitionExtract")
  assert.deepEqual(result.prompt["4"].inputs.images, ["__comfy_partition-one_extract_0000", 0])
  assert.equal(extract.inputs.type_name, "IMAGE")

  const remoteInput = Object.values(result.remoteSpec.workflow).find((node) => node.class_type === "CloudPartitionInput")
  const remoteOutput = Object.values(result.remoteSpec.workflow).find((node) => node.class_type === "CloudPartitionOutput")
  assert.equal(remoteInput.inputs.type_name, "IMAGE")
  assert.deepEqual(result.remoteSpec.workflow["2"].inputs.image, ["__comfy_partition-one_remote_input_0000", 0])
  assert.deepEqual(remoteOutput.inputs.value, ["3", 0])
})

test("rejects live model objects at a boundary", () => {
  const { prompt, partition } = fixture("MODEL")
  assert.throws(() => compilePartition(prompt, partition), /Move its loader or producer/)
})

test("rejects overlapping cloud boxes", () => {
  const { prompt, partition } = fixture()
  assert.throws(
    () => compilePartitions(prompt, [partition, { ...partition, partition_id: "two" }]),
    /overlapping/
  )
})

test("deduplicates a remote output consumed by multiple local nodes", () => {
  const { prompt, partition } = fixture()
  prompt["5"] = { class_type: "SaveImage", inputs: { images: ["3", 0] } }
  const result = compilePartition(prompt, partition)
  const captures = Object.values(result.remoteSpec.workflow).filter((node) => node.class_type === "CloudPartitionOutput")
  assert.equal(captures.length, 1)
  assert.deepEqual(result.prompt["4"].inputs.images, result.prompt["5"].inputs.images)
})
