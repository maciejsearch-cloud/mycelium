/** Wykrywanie blokady planu Supabase (HTTP 402 / egress) – ten sam kontrakt co is_quota_block w Pythonie. */
export const QUOTA_BACKOFF_MS = Number(process.env.MYC_QUOTA_BACKOFF_S || 1800) * 1000

export function isQuotaBlock(err) {
  const s = String(err?.message ?? err).toLowerCase()
  if (s.includes('exceed_egress_quota') || s.includes('exceed_cached_egress_quota')) return true
  return s.includes('http 402') || s.includes('http error 402') || s.includes(' 402 ') || s.trimEnd().endsWith(' 402')
}

export function nextPollDelayMs(err, prevMs, quotaMs = QUOTA_BACKOFF_MS) {
  return isQuotaBlock(err) ? quotaMs : Math.min(prevMs * 2, 60_000)
}
