// Pytania o wiedzę („czym jest kot?”, „co to jest ssak?”, „kim był Kopernik?”, „jaka jest stolica Francji?”):
// rozpoznanie pytania na rozbiorze i odpowiedź ze strzępków wiedzy w bazie (myc_frags: Wikisłownik, Słowosieć,
// Wikidata, zweryfikowane przez ludzi). Brak strzępka = uczciwe „nie mam tego w bazie”. Czyste funkcje, bez sieci.
import type { Reply, Understanding } from './types'

export interface FactQuery {
  /** lemat (albo nazwa własna) – o co pytają */
  subj: string
  /** relacje strzępków, które odpowiadają na to pytanie (w kolejności ważności) */
  rels: string[]
  /** jak nazwać relację w odpowiedzi */
  ask: 'definicja' | 'stolica' | 'populacja'
}
export interface FactRow {
  id: number
  subj: string
  rel: string
  obj: string
  source: string
  trust: number
  status: string
  n_support?: number
}

const SRC_PL: Record<string, string> = {
  wiktionary: 'Wikisłownik', plwordnet: 'Słowosieć', wordnet: 'WordNet', wikidata: 'Wikidata', consensus: 'konsensus ludzi',
  teach: 'nauczyciele', chat: 'czat (niezweryfikowane)', owner: 'właścicielka', captcha: 'captcha', link: 'powiązania',
}
const WH = new Set(['czym', 'kim', 'co', 'kto'])
const BE = new Set(['być', 'to'])
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Rozpoznaje pytanie o wiedzę – także osadzone („napisz mi, czym jest kot”). */
export function factQuery(u: Understanding): FactQuery | null {
  if (!u.question && !/\b(czym|kim)\b/i.test(u.text)) return null
  if (u.acts.some((a) => ['obraza', 'ciało', 'relacja', 'żart', 'przypomnienie'].includes(a))) return null
  const T = u.toks
  const low = (i: number) => T[i]?.f.toLowerCase() ?? ''
  for (let i = 0; i < T.length; i++) {
    // „stolica X” / „ilu mieszkańców ma X”
    if (T[i].l === 'stolica') {
      const x = T.slice(i + 1).find((t) => t.u === 'PROPN' || (t.u === 'NOUN' && /^\p{Lu}/u.test(t.f)))
      if (x) return { subj: cap(x.l), rels: ['stolica'], ask: 'stolica' }
    }
    if (T[i].l === 'mieszkaniec' && T.some((t) => t.l === 'ile' || t.l === 'ilu')) {
      const x = T.find((t) => t.u === 'PROPN' || (t.u === 'NOUN' && /^\p{Lu}/u.test(t.f)))
      if (x) return { subj: cap(x.l), rels: ['populacja'], ask: 'populacja' }
    }
    // „czym/kim jest X”, „co to (jest) X”, „kto to X”
    if (WH.has(low(i))) {
      let j = i + 1
      let be = false
      while (j < T.length && j <= i + 3 && (BE.has(T[j].l) || BE.has(low(j)))) (be = true), j++
      if (!be) continue
      const x = T.slice(j).find((t) => t.u === 'NOUN' || t.u === 'PROPN')
      if (x && !/^grzybni/i.test(x.f)) return { subj: x.u === 'PROPN' ? cap(x.l) : x.l, rels: ['definicja', 'znaczenie', 'jest'], ask: 'definicja' }
    }
  }
  return null
}

/** Odpowiedź ze strzępków (najwyżej 3 cechy „jest”, najpierw zweryfikowane i najczęściej potwierdzane). */
export function factReply(q: FactQuery, rows: FactRow[]): Reply {
  const ok = rows.filter((r) => r.status !== 'rejected' && r.obj && q.rels.includes(r.rel))
  const score = (r: FactRow) => (r.status === 'verified' ? 2 : 0) + r.trust + Math.min(r.n_support ?? 1, 20) / 20
  ok.sort((a, b) => q.rels.indexOf(a.rel) - q.rels.indexOf(b.rel) || score(b) - score(a))
  if (!ok.length)
    return {
      text: `Nie mam w bazie wiedzy nic o „${q.subj}”${q.ask === 'definicja' ? '' : ` (${q.ask})`}. Jeśli wiesz, napisz zdanie w stylu „${q.subj} jest …” – trafi do Weryfikuj, a ludzie zdecydują.`,
      source: 'fakt', rule: 'fakt.brak', addressed: true,
    }
  const src = (r: FactRow) => `${SRC_PL[r.source] ?? r.source}${r.status === 'verified' ? ', zweryfikowane' : ''}`
  const cite = `myc_frags #${ok.slice(0, 3).map((r) => r.id).join(', #')}`
  if (q.ask === 'stolica') return { text: `Stolica: ${q.subj} → ${ok[0].obj} (${src(ok[0])}).`, source: 'fakt', rule: 'fakt.stolica', addressed: true, cite }
  if (q.ask === 'populacja') return { text: `${q.subj} ma według bazy ${ok[0].obj} mieszkańców (${src(ok[0])}).`, source: 'fakt', rule: 'fakt.populacja', addressed: true, cite }
  const def = ok.find((r) => r.rel !== 'jest')
  const kinds = [...new Map(ok.filter((r) => r.rel === 'jest').map((r) => [r.obj.toLowerCase(), r])).values()].slice(0, 3)
  const parts: string[] = []
  if (def) parts.push(`${cap(q.subj)} to ${def.obj} (${src(def)}).`)
  if (kinds.length) parts.push(`${def ? 'Należy też do' : `${cap(q.subj)} to według mojej bazy`}: ${kinds.map((r) => r.obj.toLowerCase()).join(', ')} (${[...new Set(kinds.map(src))].join('; ')})${kinds.length > 1 ? ' – słowo może mieć kilka znaczeń' : ''}.`)
  return { text: parts.join(' '), source: 'fakt', rule: 'fakt.definicja', addressed: true, cite }
}
