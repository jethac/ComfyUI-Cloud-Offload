import assert from "node:assert/strict"
import test from "node:test"

import { partitionProgressStatus, progressFormatters } from "./progressFeedback.js"

test("shows preflight and confirmation state before provider launch", () => {
  assert.equal(
    partitionProgressStatus({ type: "preflight_started" }),
    "checking workflow and GPU options",
  )
  assert.equal(
    partitionProgressStatus({ type: "preflight_ready", confirmation_required: true }),
    "waiting for rental confirmation",
  )
  assert.equal(
    partitionProgressStatus({ type: "preflight_changed" }),
    "GPU plan changed · confirm again",
  )
})

test("long runner startup reports an elapsed plain-language stage", () => {
  assert.equal(
    partitionProgressStatus({ type: "runner_starting_progress", elapsed_seconds: 75 }),
    "pulling image / starting ComfyUI · 1m 15s",
  )
})

test("cache publication reports measurable byte progress", () => {
  assert.equal(
    partitionProgressStatus({
      type: "cache_population_progress",
      percent: 61.8,
      elapsed_seconds: 43,
    }),
    "saving cache 62% · 43s",
  )
})

test("large model names stay readable inside a group title", () => {
  const status = partitionProgressStatus({
    type: "weight_download_progress",
    file: "Qwen-Image-InstantX-ControlNet-Inpainting.safetensors",
    elapsed_seconds: 12,
  })
  assert.match(status, /^downloading Qwen-Image-InstantX-C…etensors · 12s$/)
  assert.equal(progressFormatters.bytes(20 * 1024 ** 3), "20 GB")
})

test("execution feedback summarizes nested graph progress", () => {
  assert.equal(
    partitionProgressStatus({
      type: "progress_state",
      data: { nodes: { a: { state: "finished" }, b: { state: "running" } } },
    }),
    "running graph · 1/2 nodes",
  )
})

test("durability flush is distinct from byte copy", () => {
  assert.equal(
    partitionProgressStatus({
      type: "cache_population_commit",
      commit_stage: "flushing",
      file: "controlnet.safetensors",
      elapsed_seconds: 8,
    }),
    "flushing controlnet.safetensors to durable storage · 8s",
  )
})
