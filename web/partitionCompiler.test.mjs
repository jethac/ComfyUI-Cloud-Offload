import assert from "node:assert/strict"
import test from "node:test"

import {
  compilePartition,
  compilePartitions,
  findTaintedNodes,
  globMatch,
  propagateTaint,
} from "./partitionCompiler.js"

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

// === On-prem asset residency ===

function taintFixture() {
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "StudioX_Hero.safetensors" },
      _meta: { title: "Load Checkpoint" },
    },
    "2": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "portrait" } },
    "3": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0] } },
    "4": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["1", 2] } },
    "9": { class_type: "LoadImage", inputs: { image: "unrelated.png" } },
  }
}

test("glob matcher is case-insensitive and anchored, with * and ? only", () => {
  assert.ok(globMatch("studiox_*.safetensors", "StudioX_Hero.safetensors"))
  assert.ok(globMatch("hero_?.png", "hero_1.png"))
  assert.ok(!globMatch("hero_?.png", "hero_12.png"))
  // Anchored: a pattern without wildcards is not a substring match.
  assert.ok(!globMatch("hero", "hero.safetensors"))
  // Regex metacharacters in patterns and values are literal.
  assert.ok(globMatch("a+b*.ckpt", "a+b_model.ckpt"))
  assert.ok(!globMatch("a.b", "aXb"))
})

test("finds taint roots in string widget values, never in links", () => {
  const tainted = findTaintedNodes(taintFixture(), ["studiox_*.safetensors"])
  assert.deepEqual([...tainted.keys()], ["1"])
  assert.deepEqual(tainted.get("1"), {
    asset: "StudioX_Hero.safetensors",
    inputName: "ckpt_name",
  })
  assert.equal(findTaintedNodes(taintFixture(), []).size, 0)
})

test("taint propagates downstream through multi-hop chains and fan-out", () => {
  const prompt = taintFixture()
  const tainted = propagateTaint(prompt, findTaintedNodes(prompt, ["studiox_*"]))
  // 1 fans out to 2, 3 and 4 directly; 3 is also reached via 1 -> 2 -> 3.
  assert.deepEqual([...tainted].sort(), ["1", "2", "3", "4"])
  assert.ok(!tainted.has("9"))
})

test("blocks a cloud partition whose member references a tainted asset", () => {
  const { prompt, partition } = fixture()
  prompt["2"].inputs.lora = "nda_lora.safetensors"
  assert.throws(
    () => compilePartition(prompt, partition, { onPremPatterns: ["nda_*.safetensors"] }),
    /Partition uses "nda_lora\.safetensors", which is tagged on-prem only \(introduced by node 2\)\. Choose an on-prem backend for this partition, or remove the asset\./
  )
})

test("blocks a cloud partition fed by a tainted upstream across the boundary", () => {
  const { prompt, partition } = fixture()
  prompt["1"].inputs.image = "nda_plate.png"
  prompt["1"]._meta = { title: "Load Plate" }
  // The error names the introducing node, not the member it leaked into.
  assert.throws(
    () => compilePartitions(prompt, [partition], { onPremPatterns: ["nda_*"] }),
    /Partition uses "nda_plate\.png", which is tagged on-prem only \(introduced by node 1 "Load Plate"\)/
  )
})

test("does not block when taint exists elsewhere but never reaches the partition", () => {
  const { prompt, partition } = fixture()
  prompt["7"] = { class_type: "LoadImage", inputs: { image: "nda_reference.png" } }
  prompt["8"] = { class_type: "PreviewImage", inputs: { images: ["7", 0] } }
  const result = compilePartition(prompt, partition, { onPremPatterns: ["nda_*"] })
  assert.equal(result.remoteSpec.residency, undefined)
})

// === Declared asset manifest ===

const CHECKPOINT = {
  category: "checkpoints",
  filename: "sd_xl_base_1.0.safetensors",
  sha256: "a".repeat(64),
  size: 6938040714,
  format: "safetensors",
}

test("stamps the declared assets of the partition being compiled", () => {
  const { prompt, partition } = fixture()
  const result = compilePartition(prompt, partition, {
    assetManifest: {
      "partition-one": { assets: [CHECKPOINT], unknown: [] },
      "other-box": { assets: [{ ...CHECKPOINT, filename: "elsewhere.safetensors" }] },
    },
  })

  assert.deepEqual(result.remoteSpec.assets, [CHECKPOINT])
  // Stamped by value: later edits to the manifest cannot rewrite a compiled job.
  assert.notEqual(result.remoteSpec.assets[0], CHECKPOINT)
})

test("omits assets when the box references no model files", () => {
  const { prompt, partition } = fixture()
  const result = compilePartition(prompt, partition, {
    assetManifest: { "partition-one": { assets: [], unknown: [] } },
  })

  assert.equal("assets" in result.remoteSpec, false)
})

test("blocks a partition referencing a model this ComfyUI cannot identify", () => {
  const { prompt, partition } = fixture()
  assert.throws(
    () =>
      compilePartitions(prompt, [partition], {
        assetManifest: {
          "partition-one": {
            assets: [CHECKPOINT],
            unknown: [
              { node_id: "2", input_name: "ckpt_name", value: "StudioX_Hero.safetensors" },
            ],
          },
        },
      }),
    /Partition references "StudioX_Hero\.safetensors" \(node 2\), which is not a known model file on this ComfyUI\. Cloud Offload cannot guarantee the runner has it — install it locally or remove the node from the box\./
  )
})

test("compiles unchanged when no manifest is available", () => {
  const { prompt, partition } = fixture()
  const withoutManifest = compilePartition(prompt, partition)
  const withEmptyManifest = compilePartition(prompt, partition, { assetManifest: {} })

  assert.equal("assets" in withoutManifest.remoteSpec, false)
  assert.deepEqual(withEmptyManifest.remoteSpec, withoutManifest.remoteSpec)
})

test("stamps residency on the job spec when an on-prem backend takes the partition", () => {
  const { prompt, partition } = fixture()
  prompt["1"].inputs.image = "nda_plate.png"
  const result = compilePartition(prompt, partition, {
    onPremPatterns: ["nda_*"],
    residencyClass: "on-prem",
  })
  assert.equal(result.remoteSpec.residency, "on-prem")

  // An untainted partition carries no residency field even on-prem.
  const clean = compilePartition(fixture().prompt, fixture().partition, {
    onPremPatterns: ["nda_*"],
    residencyClass: "on-prem",
  })
  assert.equal("residency" in clean.remoteSpec, false)
})
