import assert from "node:assert/strict"
import test from "node:test"

import { parseOnPremEntries, serializeOnPremEntries } from "./onPremPolicy.js"

test("bare globs parse as strict entries", () => {
  assert.deepEqual(parseOnPremEntries(["hero_*.safetensors", "  ", "nda_*"]), [
    { pattern: "hero_*.safetensors", scope: "derived" },
    { pattern: "nda_*", scope: "derived" },
  ])
})

test("scoped entries keep their scope", () => {
  assert.deepEqual(
    parseOnPremEntries([
      { pattern: "licensed_*.safetensors", scope: "weights" },
      { pattern: "nda_*.safetensors" },
    ]),
    [
      { pattern: "licensed_*.safetensors", scope: "weights" },
      { pattern: "nda_*.safetensors", scope: "derived" },
    ],
  )
})

test("unknown scopes fall back to the strict default", () => {
  const rows = parseOnPremEntries([{ pattern: "a*", scope: "public" }])
  assert.equal(rows[0].scope, "derived")
})

test("junk entries are dropped rather than rendered", () => {
  assert.deepEqual(parseOnPremEntries([null, 42, {}, { scope: "weights" }, ""]), [])
})

test("derived rows serialize back to bare strings", () => {
  assert.deepEqual(
    serializeOnPremEntries([
      { pattern: "hero_*.safetensors", scope: "derived" },
      { pattern: "licensed_*.safetensors", scope: "weights" },
    ]),
    ["hero_*.safetensors", { pattern: "licensed_*.safetensors", scope: "weights" }],
  )
})

test("empty patterns never reach the config", () => {
  assert.deepEqual(serializeOnPremEntries([{ pattern: "   ", scope: "weights" }, {}]), [])
})

test("a scoped policy survives a load and save unchanged", () => {
  // The regression this file exists for: the old textarea rendered a scoped
  // entry as "[object Object]" and saved that back as a pattern, silently
  // unrestricting the asset.
  const stored = [
    "hero_character_*.safetensors",
    { pattern: "licensed_base_*.safetensors", scope: "weights" },
  ]

  assert.deepEqual(serializeOnPremEntries(parseOnPremEntries(stored)), stored)
})

test("a second round trip is still stable", () => {
  const stored = [{ pattern: "licensed_*.safetensors", scope: "weights" }, "nda_*"]
  const once = serializeOnPremEntries(parseOnPremEntries(stored))

  assert.deepEqual(serializeOnPremEntries(parseOnPremEntries(once)), once)
})
