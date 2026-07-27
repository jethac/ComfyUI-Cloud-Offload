import assert from "node:assert/strict"
import test from "node:test"

import {
  compilePartition,
  compilePartitions,
  findTaintedNodes,
  globMatch,
  mergeNodeMarks,
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
    scope: "derived",
    source: "policy",
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

// === Required custom node packs ===

const QWEN_PACK = {
  id: "eric-qwen-layer",
  directory: "eric-qwen-layer",
  version: "0.1.0",
  digest: "b".repeat(64),
  declared: { id: true, version: true },
}

test("stamps the node packs the partition being compiled requires", () => {
  const { prompt, partition } = fixture()
  const result = compilePartition(prompt, partition, {
    nodePacks: {
      "partition-one": { packs: [QWEN_PACK], unknown: [] },
      "other-box": { packs: [{ ...QWEN_PACK, id: "elsewhere" }], unknown: [] },
    },
  })

  assert.deepEqual(result.remoteSpec.node_packs, [QWEN_PACK])
  // Stamped by value: later edits to the report cannot rewrite a compiled job.
  assert.notEqual(result.remoteSpec.node_packs[0], QWEN_PACK)
})

test("omits node packs when the box uses only core node types", () => {
  const { prompt, partition } = fixture()
  const result = compilePartition(prompt, partition, {
    nodePacks: { "partition-one": { packs: [], unknown: [] } },
  })

  assert.equal("node_packs" in result.remoteSpec, false)
})

test("blocks a partition using a node type this ComfyUI cannot attribute", () => {
  const { prompt, partition } = fixture()
  assert.throws(
    () =>
      compilePartitions(prompt, [partition], {
        nodePacks: {
          "partition-one": {
            packs: [QWEN_PACK],
            unknown: [{ node_id: "3", class_type: "SomeUninstalledNode" }],
          },
        },
      }),
    (error) => {
      assert.equal(
        error.message,
        'Partition uses node type "SomeUninstalledNode" (node 3), which this ' +
        "ComfyUI cannot attribute to a node pack. Cloud Offload cannot guarantee " +
        "the runner has it — remove the node from the box.",
      )
      return true
    },
  )
})

test("compiles unchanged when no node pack report is available", () => {
  const { prompt, partition } = fixture()
  const withoutReport = compilePartition(prompt, partition)
  const withEmptyReport = compilePartition(prompt, partition, { nodePacks: {} })

  assert.equal("node_packs" in withoutReport.remoteSpec, false)
  assert.deepEqual(withEmptyReport.remoteSpec, withoutReport.remoteSpec)
})

test("assets and node packs are stamped side by side", () => {
  const { prompt, partition } = fixture()
  const result = compilePartition(prompt, partition, {
    assetManifest: { "partition-one": { assets: [CHECKPOINT], unknown: [] } },
    nodePacks: { "partition-one": { packs: [QWEN_PACK], unknown: [] } },
  })

  assert.deepEqual(result.remoteSpec.assets, [CHECKPOINT])
  assert.deepEqual(result.remoteSpec.node_packs, [QWEN_PACK])
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

// --- on-prem scopes: weights-only vs derived ---

const scopeGraph = {
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "licensed_base.safetensors" } },
  "2": { class_type: "KSampler", inputs: { model: ["1", 0] } },
  "3": { class_type: "ImageUpscaleWithModel", inputs: { image: ["2", 0] } },
  "4": { class_type: "PreviewImage", inputs: { images: ["3", 0] } },
}

// "3" takes an IMAGE from the restricted model's sampler and returns an IMAGE:
// the boxable downstream step in a generate-on-prem, upscale-in-cloud split.
const scopePartition = (members) => ({
  partition_id: `scope-${members.join("-")}`,
  provider: "runpod",
  members,
  type_map: Object.fromEntries(
    members.map((id) => [id, { inputs: { image: "IMAGE", model: "MODEL" }, outputs: ["IMAGE"] }]),
  ),
})

test("weights scope keeps the file home but frees its outputs", () => {
  const patterns = [{ pattern: "licensed_*.safetensors", scope: "weights" }]
  const roots = findTaintedNodes(scopeGraph, patterns)
  assert.equal(roots.size, 1)
  assert.equal(roots.get("1").scope, "weights")
  const tainted = propagateTaint(scopeGraph, roots)
  assert.ok(tainted.has("1"), "the loader itself stays restricted")
  assert.ok(!tainted.has("2"), "sampling from it is not restricted")
  assert.ok(!tainted.has("3"), "the downstream upscale is free to offload")
})

test("derived scope restricts everything computed from the asset", () => {
  const roots = findTaintedNodes(scopeGraph, [{ pattern: "licensed_*.safetensors", scope: "derived" }])
  const tainted = propagateTaint(scopeGraph, roots)
  assert.ok(tainted.has("2") && tainted.has("3"), "taint reaches downstream nodes")
})

test("a bare glob string stays strict", () => {
  const roots = findTaintedNodes(scopeGraph, ["licensed_*.safetensors"])
  assert.equal(roots.get("1").scope, "derived")
  assert.ok(propagateTaint(scopeGraph, roots).has("3"), "strings keep restricting outputs")
})

test("a weights-scope partition still blocks when it holds the file itself", () => {
  const patterns = [{ pattern: "licensed_*.safetensors", scope: "weights" }]
  assert.throws(
    () => compilePartition(scopeGraph, scopePartition(["1", "2"]), { onPremPatterns: patterns }),
    /tagged on-prem only/,
  )
})

test("a weights-scope downstream partition compiles for the cloud", () => {
  const patterns = [{ pattern: "licensed_*.safetensors", scope: "weights" }]
  const out = compilePartition(scopeGraph, scopePartition(["3"]), { onPremPatterns: patterns })
  assert.ok(out.remoteSpec, "the upscale box offloads even though its input came from a restricted model")
})

// --- on-prem marks placed on the node itself ---

test("a node mark becomes a taint root with the same scopes as a pattern", () => {
  const derived = mergeNodeMarks(scopeGraph, new Map(), { "1": "derived" })
  assert.deepEqual(derived.get("1"), {
    asset: "licensed_base.safetensors",
    inputName: "ckpt_name",
    scope: "derived",
    source: "node",
  })
  assert.ok(propagateTaint(scopeGraph, derived).has("3"), "derived marks reach downstream nodes")

  const weights = mergeNodeMarks(scopeGraph, new Map(), new Map([["1", "weights"]]))
  const tainted = propagateTaint(scopeGraph, weights)
  assert.ok(tainted.has("1"), "the marked node itself stays restricted")
  assert.ok(!tainted.has("3"), "a weights mark frees what is computed from it")

  // A mark on a node the prompt does not contain — muted, bypassed — restricts nothing.
  assert.equal(mergeNodeMarks(scopeGraph, new Map(), { "42": "derived" }).size, 0)
})

test("a node mark alone blocks a cloud partition with no patterns configured", () => {
  assert.throws(
    () => compilePartition(scopeGraph, scopePartition(["3"]), { onPremNodes: { "1": "derived" } }),
    /marked on-prem only/,
  )
  const out = compilePartition(scopeGraph, scopePartition(["3"]), { onPremNodes: { "1": "weights" } })
  assert.ok(out.remoteSpec, "a weights mark still lets the downstream box offload")
  assert.throws(
    () => compilePartition(scopeGraph, scopePartition(["1", "2"]), { onPremNodes: { "1": "weights" } }),
    /marked on-prem only/,
  )
})

test("a node mark tightens a pattern and can never loosen one", () => {
  const weightsPolicy = [{ pattern: "licensed_*.safetensors", scope: "weights" }]
  const tightened = mergeNodeMarks(
    scopeGraph,
    findTaintedNodes(scopeGraph, weightsPolicy),
    { "1": "derived" },
  )
  assert.equal(tightened.get("1").scope, "derived")
  assert.ok(propagateTaint(scopeGraph, tightened).has("3"), "the mark extends policy downstream")

  // The other direction is the one that matters: a "weights" mark on a node the
  // policy already restricts derived must not hand its outputs to a cloud box.
  const derivedPolicy = [{ pattern: "licensed_*.safetensors", scope: "derived" }]
  const loosened = mergeNodeMarks(
    scopeGraph,
    findTaintedNodes(scopeGraph, derivedPolicy),
    { "1": "weights" },
  )
  assert.equal(loosened.get("1").scope, "derived")
  assert.equal(loosened.get("1").source, "policy", "policy keeps the record it matched")
  assert.throws(
    () =>
      compilePartition(scopeGraph, scopePartition(["3"]), {
        onPremPatterns: derivedPolicy,
        onPremNodes: { "1": "weights" },
      }),
    /tagged on-prem only/,
  )
})

test("the error for a node mark names the node and does not claim a policy tag", () => {
  const graph = {
    ...scopeGraph,
    "1": { ...scopeGraph["1"], _meta: { title: "Client Base Model" } },
  }
  assert.throws(
    () => compilePartitions(graph, [scopePartition(["3"])], { onPremNodes: { "1": "derived" } }),
    (error) => {
      assert.equal(
        error.message,
        'Partition uses "licensed_base.safetensors", which is marked on-prem only on ' +
        'node 1 "Client Base Model". Choose an on-prem backend for this partition, ' +
        "or clear the mark.",
      )
      return true
    },
  )
})

test("marks leave pattern-only residency exactly as it was", () => {
  const patterns = [{ pattern: "licensed_*.safetensors", scope: "weights" }]
  const withoutMarks = compilePartition(scopeGraph, scopePartition(["3"]), { onPremPatterns: patterns })
  const withNoMarks = compilePartition(scopeGraph, scopePartition(["3"]), {
    onPremPatterns: patterns,
    onPremNodes: {},
  })
  assert.deepEqual(withNoMarks.remoteSpec, withoutMarks.remoteSpec)
  assert.throws(
    () =>
      compilePartition(scopeGraph, scopePartition(["1", "2"]), {
        onPremPatterns: patterns,
        onPremNodes: {},
      }),
    /tagged on-prem only/,
  )
})

test("a marked node with no string input is named by its title, then its class", () => {
  const graph = {
    "1": { class_type: "KSampler", inputs: { model: ["9", 0] }, _meta: { title: "Hero Sampler" } },
    "2": { class_type: "VAEDecode", inputs: { samples: ["1", 0] } },
  }
  const roots = mergeNodeMarks(graph, new Map(), { "1": "derived", "2": "weights" })
  assert.deepEqual(roots.get("1"), {
    asset: "Hero Sampler",
    inputName: null,
    scope: "derived",
    source: "node",
  })
  assert.equal(roots.get("2").asset, "VAEDecode")
})
