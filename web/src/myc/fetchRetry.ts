/** fetch z jedną ponowną próbą przy chwilowym błędzie źródła (sieć, 429, 5xx) – żeby „nie wiem” nie wynikało z przypadkowej przerwy. */
export async function fetchRetry(url: string, tries = 2, waitMs = 700): Promise<Response> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url)
      if (r.ok || (r.status !== 429 && r.status < 500)) return r
      last = new Error(String(r.status))
    } catch (e) {
      last = e
    }
    if (i < tries - 1) await new Promise((res) => setTimeout(res, waitMs * (i + 1)))
  }
  throw last instanceof Error ? last : new Error(String(last))
}
