import assert from "node:assert/strict"
import test from "node:test"

import { formatBalance, spendableBalance } from "./providerBalance.js"

// The shapes two real providers actually return.
const RUNPOD = { available: true, currency: "USD", balance: 286.4893925607, current_spend_per_hour: 27.205 }
const VAST = { available: true, currency: "USD", balance: 0.0, credit: 58.71566665669866 }

test("runpod reports money in balance, with no credit field at all", () => {
  // The regression: reading only .credit rendered a funded RunPod account as
  // $0.00, which read as "your provider is broken" rather than "wrong field".
  assert.equal(spendableBalance(RUNPOD), 286.4893925607)
  assert.equal(formatBalance(RUNPOD), " · $286.49")
})

test("vast reports money in credit while balance sits at zero", () => {
  assert.equal(spendableBalance(VAST), 58.71566665669866)
  assert.equal(formatBalance(VAST), " · $58.72")
})

test("an unavailable balance renders nothing", () => {
  assert.equal(spendableBalance({ available: false }), null)
  assert.equal(formatBalance({ available: false }), "")
  assert.equal(formatBalance(undefined), "")
})

test("a genuinely empty account still shows zero rather than vanishing", () => {
  assert.equal(spendableBalance({ available: true, balance: 0.0 }), 0)
  assert.equal(formatBalance({ available: true, balance: 0.0 }), " · $0.00")
})

test("non-numeric fields do not render as NaN", () => {
  assert.equal(spendableBalance({ available: true, balance: null, credit: null }), null)
  assert.equal(formatBalance({ available: true, balance: "unknown" }), "")
})
