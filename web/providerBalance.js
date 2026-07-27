// Providers disagree about which field holds spendable money: RunPod reports
// {balance}, Vast.ai reports {balance: 0, credit: N} with the real figure in
// credit. Reading one field renders the other provider as $0.00 no matter how
// much is in the account, so prefer whichever is actually present.
export function spendableBalance(balance) {
  if (!balance || !balance.available) return null
  const numeric = (key) => {
    const value = balance[key]
    return typeof value === "number" && Number.isFinite(value) ? value : null
  }
  for (const key of ["credit", "balance"]) {
    const value = numeric(key)
    if (value !== null && value > 0) return value
  }
  // A genuinely empty account reports a real zero and should still say so;
  // a missing or non-numeric field is unknown, and guessing $0.00 there would
  // read as "your provider is broken".
  for (const key of ["balance", "credit"]) {
    const value = numeric(key)
    if (value !== null) return value
  }
  return null
}

export function formatBalance(balance) {
  const value = spendableBalance(balance)
  return value === null ? "" : ` · $${value.toFixed(2)}`
}
