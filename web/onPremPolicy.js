// On-prem policy entries, as stored by the coordinator and edited in the
// provider dialog. An entry is either a bare glob (restricting the asset and
// everything computed from it) or {pattern, scope}; scope "weights" restricts
// only the file, which is what most licences actually say.
//
// These are pure so the round trip can be tested: an editor that renders a
// scoped entry as "[object Object]" and saves that back silently unrestricts
// the asset, which is the worst direction for a policy control to fail in.

export const ON_PREM_SCOPES = [
  { value: "derived", label: "Weights and outputs" },
  { value: "weights", label: "Weights only" },
]

const DEFAULT_SCOPE = "derived"

function scopeOf(value) {
  return value === "weights" ? "weights" : DEFAULT_SCOPE
}

// Config shape -> editor rows. Unparseable entries are dropped rather than
// rendered as text, so nothing that cannot round trip reaches an input.
export function parseOnPremEntries(entries) {
  const rows = []
  for (const entry of entries || []) {
    if (typeof entry === "string") {
      if (entry.trim()) rows.push({ pattern: entry.trim(), scope: DEFAULT_SCOPE })
      continue
    }
    if (!entry || typeof entry !== "object") continue
    const pattern = String(entry.pattern || "").trim()
    if (pattern) rows.push({ pattern, scope: scopeOf(entry.scope) })
  }
  return rows
}

// Editor rows -> config shape. A derived row serializes back to a bare string
// so existing configs keep their shape and diffs stay small.
export function serializeOnPremEntries(rows) {
  const entries = []
  for (const row of rows || []) {
    const pattern = String(row?.pattern || "").trim()
    if (!pattern) continue
    const scope = scopeOf(row?.scope)
    entries.push(scope === "weights" ? { pattern, scope } : pattern)
  }
  return entries
}
