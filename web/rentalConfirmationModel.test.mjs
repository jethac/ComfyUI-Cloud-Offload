import test from "node:test"
import assert from "node:assert/strict"

import {
  bindApiFetch,
  byteSize,
  candidateView,
  durationRange,
  moneyRange,
} from "./rentalConfirmationModel.js"

test("binds the ComfyUI request method to its API object", async () => {
  const api = {
    marker: "comfy-api",
    fetchApi(path) {
      assert.equal(this.marker, "comfy-api")
      return path
    },
  }

  assert.equal(await bindApiFetch(api)("/cloud_offload/test"), "/cloud_offload/test")
})

test("formats the cost and time ranges shown before rental", () => {
  assert.equal(moneyRange([0.12, 0.24]), "$0.12–$0.24")
  assert.equal(moneyRange([0.004, 0.009]), "$0.004–$0.009")
  assert.equal(durationRange([60, 120]), "1.0 min–2.0 min")
  assert.equal(byteSize(3 * 1024 ** 3), "3.0 GiB")
})

test("builds the safe candidate view with cache and rationale", () => {
  const view = candidateView(
    {
      provider: "runpod",
      gpu_type: "A100 80 GB",
      region: "US-MD-1",
      hourly_rate: 1.49,
      preparation: { coverage_percent: 88, missing_bytes: 2 * 1024 ** 3 },
      estimate: {
        total_job_cost_usd: [0.12, 0.24],
        startup_seconds: [60, 120],
        execution_seconds: [90, 180],
        confidence: "medium",
      },
    },
    { recommendation: { rationale: ["Fastest expected result."] } },
  )

  assert.deepEqual(view, {
    title: "runpod · A100 80 GB",
    region: "US-MD-1",
    hourly: "$1.49/hour",
    cost: "$0.12–$0.24",
    startup: "1.0 min–2.0 min",
    execution: "1.5 min–3.0 min",
    coverage: "88.0% prepared",
    missing: "2.0 GiB missing",
    confidence: "medium",
    rationale: ["Fastest expected result."],
  })
})
