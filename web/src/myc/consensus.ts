// Dawid-Skene „one-coin” + apriori Beta + pytania kontrolne (gold) + waga właścicielki.
// Lustrzane odbicie src/iot_mycelium/ai/consensus.py (te same stałe i wyniki).
export const PRIOR: [number, number] = [2, 1]
export const OWNER_PRIOR: [number, number] = [8, 1]
const GOLD_WEIGHT = 2
const CLAMP: [number, number] = [0.02, 0.98]

export interface Ans {
  question_id: string
  node_id: string
  answer: string
  owner?: boolean
}
export interface Consensus {
  posterior: Record<string, Record<string, number>>
  trust: Record<string, number>
  agreement: Record<string, number>
  answersPerNode: Record<string, number>
}

const clamp = (x: number) => Math.min(Math.max(x, CLAMP[0]), CLAMP[1])

export function truth(c: Consensus, q: string): [string, number] | undefined {
  const p = c.posterior[q]
  if (!p) return undefined
  let best = ''
  for (const k in p) if (!best || p[k] > p[best]) best = k
  return [best, p[best]]
}

export function infer(answers: Ans[], options: Record<string, string[]>, gold: Record<string, [number, number]> = {}, iters = 30): Consensus {
  const byQ = new Map<string, [string, string][]>()
  const owners = new Set<string>()
  for (const a of answers) {
    if (!options[a.question_id]?.includes(a.answer)) continue
    if (!byQ.has(a.question_id)) byQ.set(a.question_id, [])
    byQ.get(a.question_id)!.push([a.node_id, a.answer])
    if (a.owner) owners.add(a.node_id)
  }
  const nodes = [...new Set([...[...byQ.values()].flat().map(([n]) => n), ...Object.keys(gold)])].sort()
  const nAns: Record<string, number> = Object.fromEntries(nodes.map((n) => [n, 0]))
  for (const votes of byQ.values()) for (const [n] of votes) nAns[n]++
  const g = (n: string) => {
    const [gn, gc] = gold[n] ?? [0, 0]
    return [GOLD_WEIGHT * gc, GOLD_WEIGHT * gn]
  }
  const prior = (n: string) => (owners.has(n) ? OWNER_PRIOR : PRIOR)
  let acc: Record<string, number> = {}
  for (const n of nodes) {
    const [gc, gn] = g(n)
    const [pa, pb] = prior(n)
    acc[n] = clamp((pa + gc) / (pa + pb + gn))
  }
  const post: Record<string, Record<string, number>> = {}
  for (let it = 0; it < iters; it++) {
    for (const [q, votes] of byQ) {
      const opts = options[q]
      const k = opts.length
      const logp: Record<string, number> = Object.fromEntries(opts.map((o) => [o, 0]))
      for (const [n, ans] of votes) {
        const a = acc[n]
        const wrong = Math.log((1 - a) / (k - 1))
        for (const o of opts) logp[o] += o === ans ? Math.log(a) : wrong
      }
      const m = Math.max(...Object.values(logp))
      let z = 0
      for (const o of opts) z += Math.exp(logp[o] - m)
      post[q] = Object.fromEntries(opts.map((o) => [o, Math.exp(logp[o] - m) / z]))
    }
    const soft: Record<string, number> = Object.fromEntries(nodes.map((n) => [n, 0]))
    for (const [q, votes] of byQ) for (const [n, ans] of votes) soft[n] += post[q][ans]
    const next: Record<string, number> = {}
    let delta = 0
    for (const n of nodes) {
      const [gc, gn] = g(n)
      const [pa, pb] = prior(n)
      next[n] = clamp((pa + gc + soft[n]) / (pa + pb + gn + nAns[n]))
      delta = Math.max(delta, Math.abs(next[n] - acc[n]))
    }
    acc = next
    if (delta < 1e-6) break
  }
  const agreement: Record<string, number> = {}
  for (const n of nodes) {
    let hit = 0
    let tot = 0
    for (const [q, votes] of byQ)
      for (const [m, ans] of votes)
        if (m === n) {
          tot++
          if (truth({ posterior: post } as Consensus, q)?.[0] === ans) hit++
        }
    agreement[n] = tot ? hit / tot : 0
  }
  return { posterior: post, trust: acc, agreement, answersPerNode: nAns }
}
