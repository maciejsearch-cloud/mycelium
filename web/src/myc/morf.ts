// Warstwa Morfeusz 2 / SGJP (BSD-2, IPI PAN; dane SGJP: Z. Saloni, W. Gruszczyński, M. Woliński, R. Wołosz,
// D. Skowrońska): lematy i cechy z analizatora, wybór interpretacji przez model grzybni.
// Lustro Pythona: src/iot_mycelium/rozbior/morf.py (select + lex_analyses); zgodność: web/scripts/rozbior-parity.mjs.
// Leksykon: web/public/data/rozbior/morf.json.gz (scripts/export_morf.py) – formy dla lematów z TRAIN UD.
import { FEATS, applyRule, type Feats, type UTok } from './rozbior'

export interface MorfLex {
  meta: { alpha: number; min_p: number; n_forms: number; license: string }
  tagmap: Record<string, Record<string, Record<string, number>>>
  flem: Record<string, [string, number][]>
  tags: string[]
  rules: string[]
  forms: Record<string, [number, number][]>
}
interface Head {
  upos: string[]
  feats: Record<string, string[]>
}

export function lexAnalyses(lex: MorfLex, form: string): [string, string][] {
  const out: [string, string][] = []
  const seen = new Set<string>()
  for (const f of [...new Set([form, form.toLowerCase()])]) {
    for (const [r, ti] of lex.forms[f] ?? []) {
      const a: [string, string] = [applyRule(f, lex.rules[r]), lex.tags[ti]]
      const k = a[0] + '\u0000' + a[1]
      if (!seen.has(k)) {
        seen.add(k)
        out.push(a)
      }
    }
  }
  return out
}

const parseKey = (k: string): [string, Feats] => {
  const [u, ...fs] = k.split('|')
  const f: Feats = {}
  for (const x of fs) {
    if (!x) continue
    const j = x.indexOf('=')
    f[x.slice(0, j)] = x.slice(j + 1)
  }
  return [u, f]
}

/** Poprawia lemat, UPOS i cechy tokenów z log-prawdopodobieństwami modelu (t.lp). Styl PDB (jak w czacie). */
export function select(H: Head, toks: UTok[], lex: MorfLex, tb = 'pdb'): UTok[] {
  const alpha = lex.meta.alpha
  const minP = lex.meta.min_p
  const uix = new Map(H.upos.map((u, i) => [u, i]))
  const fix: Record<string, Map<string, number>> = {}
  for (const k of FEATS) fix[k] = new Map(H.feats[k].map((v, i) => [v, i]))
  const tmap = lex.tagmap[tb] ?? lex.tagmap.pdb ?? {}
  return toks.map((t0) => {
    const t: UTok = { ...t0 }
    const lp = t0.lp
    const an = lexAnalyses(lex, t.form)
    if (!lp || t.upos === 'PUNCT' || (an.length && an.every(([, tag]) => tag === 'interp'))) return t
    const cand = new Map<string, { s: number; lems: Set<string>; base: number }>()
    for (const [lm, tag] of an) {
      const dist = tag !== 'interp' ? tmap[tag] : undefined
      if (!dist) continue
      let tot = 0
      for (const c of Object.values(dist)) tot += c
      for (const [k, c] of Object.entries(dist)) {
        const p = c / tot
        if (p < minP) continue
        const have = cand.get(k)
        if (have) {
          have.s = Math.max(have.s, have.base + alpha * Math.log(p))
          have.lems.add(lm)
          continue
        }
        const [u, f] = parseKey(k)
        const ui = uix.get(u)
        if (ui === undefined) continue
        let base = lp.upos[ui]
        let ok = true
        for (const fk of FEATS) {
          const j = fix[fk].get(f[fk] ?? '_')
          if (j === undefined) {
            ok = false
            break
          }
          base += lp.feats[fk][j]
        }
        if (!ok) continue
        cand.set(k, {
          s: base + alpha * Math.log(p),
          lems: new Set([lm]),
          base,
        })
      }
    }
    const fl = new Map(lex.flem[t.form.toLowerCase()] ?? [])
    let keys = [...cand.keys()]
    const same = keys.filter((q) => q.split('|', 1)[0] === t.upos)
    if (same.length) keys = same
    if (keys.length) {
      let k = keys[0]
      for (const q of keys) if (cand.get(q)!.s > cand.get(k)!.s) k = q
      const [u, f] = parseKey(k)
      t.upos = u
      t.feats = f
      const order = an.map(([a]) => a)
      let best: string | undefined
      for (const x of cand.get(k)!.lems) {
        if (best === undefined) best = x
        else {
          const a = fl.get(x) ?? 0
          const b = fl.get(best) ?? 0
          if (a > b || (a === b && order.indexOf(x) < order.indexOf(best))) best = x
        }
      }
      t.lemma = best
      t.morf = 1
    } else if (fl.size && t.upos !== 'PUNCT') {
      let best = ''
      let bc = -1
      for (const [l, c] of fl) if (c > bc) [best, bc] = [l, c]
      t.lemma = best
    }
    return t
  })
}
