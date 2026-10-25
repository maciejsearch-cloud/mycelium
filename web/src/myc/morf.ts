// Warstwa Morfeusz 2 / SGJP (BSD-2, IPI PAN; dane SGJP: Z. Saloni, W. Gruszczyński, M. Woliński, R. Wołosz,
// D. Skowrońska): lematy i cechy z analizatora, wybór interpretacji przez model grzybni.
// Lustro Pythona: src/iot_mycelium/rozbior/morf.py (select + lex_analyses); zgodność: web/scripts/rozbior-parity.mjs.
// Leksykon: web/public/data/rozbior/morf.json.gz (scripts/export_morf.py) – formy dla lematów z TRAIN UD.
import { FEATS, applyRule, predict, type Feats, type Force, type RbModel, type UTok } from './rozbior'

type Counts = Record<string, number>
export interface MorfLex {
  meta: { alpha: number; min_p: number; n_forms: number; license: string; case_beta?: number; val_gamma?: number }
  tagmap: Record<string, Record<string, Record<string, number>>>
  /** liczności etykiet dla „UPOS” i „UPOS|Przypadek” z TRAIN UD (redecode) */
  relprior?: Record<string, Record<string, Counts>>
  /** liczności przypadków dla kontekstu „relacja|UPOS nadrzędnika” z TRAIN UD (case_bias) */
  caseprior?: Record<string, Record<string, Counts>>
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

const SENT_END = new Set(['.', '!', '?', '…', ':', '-', '–', '—', '"', '„', '”', '«', '»', '(', '*'])
const REL_MIN = 0.01
const FUNC_UPOS = new Set(['CCONJ', 'SCONJ', 'PART', 'ADP', 'ADV', 'INTJ'])
const NKJP_CASE: Record<string, string> = { nom: 'Nom', gen: 'Gen', dat: 'Dat', acc: 'Acc', inst: 'Ins', loc: 'Loc', voc: 'Voc' }
const NKJP_NUM: Record<string, string> = { sg: 'Sing', pl: 'Plur' }
const NKJP_GEN: Record<string, string> = { m1: 'Masc', m2: 'Masc', m3: 'Masc', f: 'Fem', n: 'Neut', n1: 'Neut', n2: 'Neut' }
const NOMINAL = new Set(['subst', 'depr', 'adj', 'ppron12', 'ppron3'])
const UD_NOMINAL = new Set(['NOUN', 'PROPN', 'ADJ', 'PRON', 'DET'])
const VAL_CASE: Record<string, string> = { 'KTO/CO': 'Nom', 'KOGO/CO': 'Acc', 'KOMU/CZEMU': 'Dat', 'KIM/CZYM': 'Ins', 'KOGO/CZEGO': 'Gen' }
const isUp = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase()

/** Lustro morf.proper_only: „Ani” w środku zdania, model widzi spójnik → tylko interpretacje z lematem własnym. */
function properOnly(an: [string, string][], form: string, prev: string | undefined, upos: string): [string, string][] {
  if (!FUNC_UPOS.has(upos) || prev === undefined || SENT_END.has(prev) || !isUp(form.slice(0, 1)) || isUp(form)) return an
  const pr = an.filter(([lm]) => isUp(lm.slice(0, 1)))
  return pr.length ? pr : an
}

/** Lustro morf.agrees: przypadek/liczba tagu NKJP muszą się zgadzać z analizą UD (tylko klasy imienne). */
function agrees(tag: string, u: string, f: Feats): boolean {
  const parts = tag.split(':')
  if (!NOMINAL.has(parts[0]) || !UD_NOMINAL.has(u)) return true
  const cs = new Set(parts.filter((x) => x in NKJP_CASE).map((x) => NKJP_CASE[x]))
  if (cs.size && !cs.has(f.Case ?? '')) return false
  const ns = new Set(parts.filter((x) => x in NKJP_NUM).map((x) => NKJP_NUM[x]))
  if (ns.has('Plur')) ns.add('Ptan')
  if (ns.size && !ns.has(f.Number ?? '')) return false
  const gs = new Set(parts.flatMap((x) => x.split('.')).filter((y) => y in NKJP_GEN).map((y) => NKJP_GEN[y]))
  return !(gs.size && f.Gender !== undefined && !gs.has(f.Gender))
}

/** Poprawia lemat, UPOS i cechy tokenów z log-prawdopodobieństwami modelu (t.lp). Styl PDB (jak w czacie). */
export function select(H: Head, toks: UTok[], lex: MorfLex, tb = 'pdb'): UTok[] {
  const alpha = lex.meta.alpha
  const minP = lex.meta.min_p
  const uix = new Map(H.upos.map((u, i) => [u, i]))
  const fix: Record<string, Map<string, number>> = {}
  for (const k of FEATS) fix[k] = new Map(H.feats[k].map((v, i) => [v, i]))
  const tmap = lex.tagmap[tb] ?? lex.tagmap.pdb ?? {}
  return toks.map((t0, i) => {
    const t: UTok = { ...t0 }
    const lp = t0.lp
    let an = lexAnalyses(lex, t.form)
    if (!lp || t.upos === 'PUNCT' || (an.length && an.every(([, tag]) => tag === 'interp'))) return t
    an = properOnly(an, t.form, i ? toks[i - 1].form : undefined, t.upos)
    const cand = new Map<string, { s: number; lems: Set<string>; base: number }>()
    // lustro morf.select: szum wyrównania odpada przed min_p, masa przechodzi na zgodne analizy imienne;
    // część mowy musi przejść próg w surowym rozkładzie któregoś tagu słowa
    const dists: { lm: string; dist: Record<string, number>; tot: number; nom: Set<string>; ok: Set<string>; sc: number }[] = []
    for (const [lm, tag] of an) {
      const dist = tag !== 'interp' ? tmap[tag] : undefined
      if (!dist) continue
      let tot = 0
      for (const c of Object.values(dist)) tot += c
      const nom = new Set(Object.keys(dist).filter((k) => UD_NOMINAL.has(parseKey(k)[0])))
      const ok = new Set([...nom].filter((k) => agrees(tag, ...parseKey(k))))
      let sn = 0
      let so = 0
      for (const k of nom) sn += dist[k]
      for (const k of ok) so += dist[k]
      dists.push({ lm, dist, tot, nom, ok, sc: ok.size ? sn / so : 1 })
    }
    const ups = new Set<string>()
    for (const d of dists)
      for (const [k, c] of Object.entries(d.dist)) if (c / d.tot >= minP && (!d.nom.has(k) || d.ok.has(k))) ups.add(parseKey(k)[0])
    for (const { lm, dist, tot, nom, ok, sc } of dists) {
      for (const [k, c] of Object.entries(dist)) {
        if (nom.has(k) && !ok.has(k)) continue
        const p = (c * (ok.has(k) ? sc : 1)) / tot
        const [u, f] = parseKey(k)
        if (p < minP || !ups.has(u)) continue
        const have = cand.get(k)
        if (have) {
          have.s = Math.max(have.s, have.base + alpha * Math.log(p))
          have.lems.add(lm)
          continue
        }
        const ui = uix.get(u)
        if (ui === undefined) continue
        let base = lp.upos[ui]
        let good = true
        for (const fk of FEATS) {
          const j = fix[fk].get(f[fk] ?? '_')
          if (j === undefined) {
            good = false
            break
          }
          base += lp.feats[fk][j]
        }
        if (!good) continue
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

function casesOf(an: [string, string][], upos: string): string[] {
  const cls: Record<string, string[]> = { NOUN: ['subst', 'depr'], PROPN: ['subst', 'depr'], ADJ: ['adj'], PRON: ['ppron12', 'ppron3'] }
  const out = new Set<string>()
  for (const [, tag] of an) {
    const parts = tag.split(':')
    if ((cls[upos] ?? []).includes(parts[0])) for (const x of parts) if (x in NKJP_CASE) out.add(NKJP_CASE[x])
  }
  return [...out].sort()
}

type Verbs = Record<string, { s: string[][] }>
function licensed(val: Verbs | undefined, lemma: string, neg: boolean): Set<string> {
  const v = val?.[lemma]
  const out = new Set<string>()
  if (!v) return out
  for (const f of v.s) for (const x of f) if (x in VAL_CASE) out.add(VAL_CASE[x])
  if (neg && out.has('Acc')) out.add('Gen')
  return out
}

const relLogPrior = (deprels: string[], c: Counts): number[] => {
  const v = deprels.map((d) => (c[d] ?? 0) + 1)
  const z = v.reduce((a, b) => a + b, 0)
  return v.map((x) => Math.log(x / z))
}

/** Lustro morf.choose (styl PDB jak w czacie): select → ponowne dekodowanie łuków słów, którym Morfeusz zmienił
 *  analizę („Ani”: spójnik → imię, celownik) → przypadek z kontekstu (TRAIN UD) i schematu czasownika (Walenty). */
export function choose(M: RbModel, forms: string[], raw: UTok[], lex: MorfLex, tb = 'pdb', verbs?: Verbs): UTok[] {
  const H = M.H
  let sel = select(H, raw, lex, tb)
  const rp = lex.relprior?.[tb] ?? lex.relprior?.pdb
  const beta = lex.meta.case_beta ?? 0
  const gamma = lex.meta.val_gamma ?? 0
  if (!rp) return sel
  const force = new Map<number, Force>()
  raw.forEach((t, i) => {
    const u = sel[i].upos
    if (u === 'PUNCT') return
    const an = lexAnalyses(lex, t.form)
    const cs = casesOf(an, u)
    const keys = cs.map((c) => `${u}|${c}`).filter((k) => k in rp)
    if (u === t.upos && !keys.length) return
    const cnt: Counts = {}
    for (const k of keys.length ? keys : [u]) for (const [d, c] of Object.entries(rp[k] ?? {})) cnt[d] = (cnt[d] ?? 0) + c
    const tot = Object.values(cnt).reduce((a, b) => a + b, 0)
    if (u === t.upos && tot && (cnt[t.deprel] ?? 0) / tot >= REL_MIN) return
    const fv: Force = { pr: relLogPrior(H.deprels, cnt) }
    const oc = new Set(cs.filter((c) => c !== 'Nom'))
    if (verbs && gamma && oc.size) {
      const hb = new Array(raw.length + 1).fill(0)
      for (let h = 1; h <= raw.length; h++) {
        if (h === i + 1 || sel[h - 1].upos !== 'VERB') continue
        const neg = raw.slice(Math.max(0, h - 3), h - 1).some((x) => x.form.toLowerCase() === 'nie' && x.upos === 'PART')
        const lic = licensed(verbs, sel[h - 1].lemma ?? '', neg)
        if ([...oc].some((c) => lic.has(c))) hb[h] = gamma
      }
      fv.hb = hb
    }
    force.set(i, fv)
  })
  let tree = raw
  let toks = raw
  if (force.size) {
    const unk = new Set([...force.keys()].filter((i) => FUNC_UPOS.has(raw[i].upos) && !FUNC_UPOS.has(sel[i].upos)))
    tree = predict(M, forms, tb, true, { force, unk })
    if (unk.size) toks = predict(M, forms, tb, true, { unk }).map((t, i) => ({ ...raw[i], lp: t.lp, upos: sel[i].upos !== raw[i].upos ? sel[i].upos : raw[i].upos }))
  }
  if (beta || gamma || force.size) {
    const cp = lex.caseprior?.[tb] ?? lex.caseprior?.pdb
    const cases = H.feats.Case
    const ctx = (t: UTok) => t.deprel.split(':', 1)[0] + '|' + (t.head ? tree[t.head - 1].upos : 'ROOT')
    toks = toks.map((t, i) => {
      if (!t.lp) return t
      const fc = t.lp.feats.Case.slice()
      const tt = tree[i]
      const c = beta && cp ? cp[ctx(tt)] : undefined
      if (c) {
        const tot = Object.values(c).reduce((a, b) => a + b, 0) + cases.length
        cases.forEach((v, j) => (fc[j] += beta * Math.fround(Math.log(((c[v] ?? 0) + 1) / tot))))
      }
      if (gamma && verbs && tt.deprel !== 'nsubj' && tt.head && ['VERB', 'AUX'].includes(sel[tt.head - 1].upos)) {
        const h = tt.head
        if (!tree.some((x) => x.head === i + 1 && x.deprel === 'case')) {
          const neg = tree.some((x) => x.head === h && x.deprel === 'advmod:neg')
          const lic = licensed(verbs, sel[h - 1].lemma ?? '', neg)
          lic.delete('Nom')
          cases.forEach((v, j) => lic.has(v) && (fc[j] += gamma))
        }
      }
      return { ...t, lp: { ...t.lp, feats: { ...t.lp.feats, Case: fc } } }
    })
    sel = select(H, toks, lex, tb)
  }
  return sel.map((s, i) => ({ ...s, head: tree[i].head, deprel: tree[i].deprel, p: tree[i].p }))
}
