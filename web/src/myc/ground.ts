// Ugruntowanie odpowiedzi w sprawdzonych źródłach: Wikidata (liczby i encje, CC0) + fakty grzybni.
// Czysta logika (parsowanie liczb, walidacja) + pobieranie z API Wikidata (CORS: origin=*).

export interface Grounded {
  qid: string
  label: string
  prop: string
  /** nazwa właściwości po polsku / angielsku */
  name: [string, string]
  /** wartość czytelna, np. „1 863 056” */
  value: string
  /** wartości liczbowe do walidacji odpowiedzi modelu */
  nums: number[]
  /** rok stanu (kwalifikator P585), jeśli jest */
  asOf?: string
}

interface PropDef {
  id: string
  re: RegExp
  name: [string, string]
  kind: 'qty' | 'time' | 'item'
}
export const PROPS: PropDef[] = [
  { id: 'P1082', re: /mieszka[nń]c|ludno|populac|population|inhabitant|people live/i, name: ['liczba ludności', 'population'], kind: 'qty' },
  { id: 'P2046', re: /powierzchni|\barea\b/i, name: ['powierzchnia', 'area'], kind: 'qty' },
  { id: 'P36', re: /stolic|capital/i, name: ['stolica', 'capital'], kind: 'item' },
  // „najwyższy szczyt/punkt Polski” → Rysy (P610); pytanie o samą wysokość („jaka jest wysokość najwyższego…”) idzie do P2044
  { id: 'P610', re: /^(?!.*(wysoko|ile metr|how high|elevation)).*(najwyższ\w*|najwyżej położon\w*)\s+(szczyt\w*|punkt\w*|gór[aęy]|wzniesieni\w*|miejsc\w*)|highest (point|peak|mountain)/i, name: ['najwyższy punkt', 'highest point'], kind: 'item' },
  { id: 'P2044', re: /wysoko[sś][cć] n\.?p\.?m|wznies|elevation|how high|jak wysok/i, name: ['wysokość n.p.m.', 'elevation'], kind: 'qty' },
  { id: 'P571', re: /założon|zalozon|powsta[łl]|founded|inception|established/i, name: ['data powstania', 'inception'], kind: 'time' },
  { id: 'P569', re: /urodzi[łl]|\bborn\b|data urodzenia/i, name: ['data urodzenia', 'date of birth'], kind: 'time' },
  { id: 'P570', re: /zmar[łl]|\bdied\b|data śmierci/i, name: ['data śmierci', 'date of death'], kind: 'time' },
]

/** Pytanie o liczbę / datę – bez źródła nie zgadujemy. */
export const NUMERIC_Q = /\b(ile|ilu|ilo[śs][ćc]|liczb[aęy]|how many|how much|kiedy|w którym roku|when|what year)\b|mieszka[nń]c|ludno|population/i

/** „W jakim mieście urodził się…”, „Gdzie zmarł…” – pytanie o miejsce, nie o datę */
const PLACE_Q = /\b(gdzie|where)\b|\bw (jakim|którym|jakiej|której) (mie[śs]cie|kraju|miejscu|mie[śs]cowo[śs]ci|pa[ńn]stwie|regionie|wojew[óo]dztwie)/i
export const propFor = (q: string) => PROPS.find((p) => p.re.test(q) && !(p.kind === 'time' && PLACE_Q.test(q)))

const STOP = new Set('wikidata wikipedia wikisłownik źródło według a ale i oraz to ten ta te tego tej tym ma mają jest są był była było ile ilu kiedy jak jaka jaki jakie gdzie czy co kto w we na o z ze do od po dla the a an of in on is are was what how many much who when where which does do has have'.split(' '))

/** Kandydaci na encję: wyrazy z wielkiej litery (nie na początku zdania), od najnowszych; potem inne wyrazy pytania. */
export function entityCandidates(q: string, history: string[]): string[] {
  const caps = (s: string) => {
    const out: string[] = []
    for (const sent of s.split(/[.!?\n]+/)) {
      const ws = sent.match(/[\p{L}][\p{L}-]*/gu) ?? []
      ws.forEach((w, i) => {
        if (i > 0 && /^\p{Lu}/u.test(w) && !STOP.has(w.toLowerCase())) out.push(w)
      })
    }
    return out.reverse()
  }
  const p = propFor(q)
  const qWords = (q.match(/[\p{L}][\p{L}-]*/gu) ?? []).filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()) && !(p && p.re.test(w)) && !NUMERIC_Q.test(w))
  // wielowyrazowe nazwy („Fryderyk Chopin”, „Mount Everest”) przed pojedynczymi wyrazami
  const phrases = [...q.matchAll(/(?:^|\s)((?:\p{Lu}[\p{L}-]+)(?:\s+\p{Lu}[\p{L}-]+)+)/gu)].map((m) => m[1]).filter((ph) => !STOP.has(ph.split(/\s+/)[0].toLowerCase()) || ph.split(/\s+/).length > 2)
  const capsQ = [...phrases, ...caps(q)]
  const fromH = history.slice(-2).reverse().flatMap(caps)
  // „to miasto”, „ten kraj”, „it” – odwołanie do poprzedniej wypowiedzi: najpierw historia
  const anaphora = !capsQ.length && /\b(to|ten|ta|tego|tej|tym|tam|tamten|this|that|it|its|there)\b/i.test(q)
  // historia tylko przy odwołaniu („to miasto”) albo gdy pytanie nie ma własnej nazwy – inaczej poprzedni temat podmieniał encję
  const all = anaphora ? [...fromH, ...qWords.reverse()] : capsQ.length ? [...capsQ, ...qWords.reverse()] : [...qWords.reverse(), ...fromH]
  return [...new Set(all)].slice(0, 5)
}

const fmtInt = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')
const fmtNum = (n: number) => (Number.isInteger(n) ? fmtInt(n) : n.toLocaleString('pl-PL', { maximumFractionDigits: 2 }))

/** Liczby w tekście: „1 863 056”, „1,86 mln”, „3,7 milionów”, „1.8 million”, „2021”. */
export function numbersIn(text: string): number[] {
  const out: number[] = []
  const re = /(\d{1,3}(?:[\s\u00a0.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(mld|miliard\w*|billion|mln|milion\w*|million|tys\.?|tysi\w*|thousand)?/gi
  for (const m of text.matchAll(re)) {
    let s = m[1]
    if (/^\d{1,3}([\s\u00a0.,]\d{3})+$/.test(s) && !(m[2] && /[.,]\d{1,2}$/.test(s))) s = s.replace(/[\s\u00a0.,]/g, '')
    else s = s.replace(',', '.')
    let v = parseFloat(s)
    const u = (m[2] ?? '').toLowerCase()
    if (/^(mld|miliard|billion)/.test(u)) v *= 1e9
    else if (/^(mln|milion|million)/.test(u)) v *= 1e6
    else if (/^(tys|thousand)/.test(u)) v *= 1e3
    if (Number.isFinite(v)) out.push(v)
  }
  return out
}

/** Czy liczby w odpowiedzi modelu zgadzają się ze źródłem (±3 %, albo występują w pytaniu)? Zwraca liczby niepotwierdzone. */
export function ungroundedNumbers(replyText: string, question: string, sources: number[]): number[] {
  const inQ = numbersIn(question)
  return numbersIn(replyText).filter((v) => {
    if (v < 10) return false
    if (inQ.some((x) => x === v)) return false
    return !sources.some((s) => Math.abs(s - v) <= Math.max(1, Math.abs(s) * 0.03))
  })
}

/** Odpowiedź z faktu Wikidata (deterministyczna, ze źródłem). */
export function groundedSentence(g: Grounded, en: boolean): string {
  const as = g.asOf ? (en ? ` (as of ${g.asOf})` : ` (stan na ${g.asOf})`) : ''
  return en
    ? `According to Wikidata, ${g.label} – ${g.name[1]}: ${g.value}${as}.\nSource: Wikidata ${g.qid}.`
    : `Według Wikidata: ${g.label} – ${g.name[0]}: ${g.value}${as}.\nŹródło: Wikidata ${g.qid}.`
}

export const UNSURE = (en: boolean) =>
  en
    ? 'I am not sure: I could not find this number in verified sources (Wikidata, mycelium facts), so I will not guess.'
    : 'Nie jestem pewna: nie znalazłam tej liczby w sprawdzonych źródłach (Wikidata, fakty grzybni), więc nie będę zgadywać.'

const WD = 'https://www.wikidata.org/w/api.php'
type Fetch = (url: string) => Promise<unknown>
const getJson: Fetch = async (url) => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Wikidata ${r.status}`)
  return r.json()
}
const qs = (o: Record<string, string>) => new URLSearchParams({ format: 'json', origin: '*', ...o }).toString()

interface Snak {
  datavalue?: { value: { amount?: string; unit?: string; time?: string; precision?: number; id?: string } }
}
interface Claim {
  rank: 'preferred' | 'normal' | 'deprecated'
  mainsnak: Snak
  qualifiers?: Record<string, Snak[]>
}

const UNITS: Record<string, string> = { Q712226: 'km²', Q11573: 'm', Q25343: 'm²', Q828224: 'km' }

/** Najlepsze twierdzenie: preferowane, inaczej najnowsze wg P585 (stan na). */
export function pickClaim(claims: Claim[]): Claim | undefined {
  const ok = claims.filter((c) => c.rank !== 'deprecated' && c.mainsnak.datavalue)
  const pref = ok.filter((c) => c.rank === 'preferred')
  const pool = pref.length ? pref : ok
  const at = (c: Claim) => c.qualifiers?.P585?.[0]?.datavalue?.value.time ?? ''
  return [...pool].sort((a, b) => at(b).localeCompare(at(a)))[0]
}

const year = (t?: string) => t?.match(/^[+-]?(\d+)/)?.[1]
const dateTxt = (t: string, prec = 11) => {
  const m = t.match(/^[+-]?(\d+)-(\d\d)-(\d\d)/)
  if (!m) return t
  return prec >= 11 ? `${m[3]}.${m[2]}.${m[1]}` : prec === 10 ? `${m[2]}.${m[1]}` : m[1]
}

/** Szuka encji i wartości właściwości w Wikidata. undefined = brak ugruntowania. */
export async function groundQuestion(q: string, history: string[], lang: 'pl' | 'en', get: Fetch = getJson): Promise<Grounded | undefined> {
  const p = propFor(q)
  if (!p) return undefined
  for (const cand of entityCandidates(q, history)) {
    const stems = [cand, ...(cand.length > 5 ? [cand.slice(0, -1), cand.slice(0, -2)] : [])]
    for (const stem of stems) {
      const sr = (await get(`${WD}?${qs({ action: 'wbsearchentities', search: stem, language: lang, uselang: lang, type: 'item', limit: '5' })}`)) as { search?: { id: string; label?: string; description?: string }[] }
      const hits = (sr.search ?? []).filter((h) => h.label && h.label.toLowerCase().startsWith(stem.toLowerCase().slice(0, Math.max(4, stem.length - 2))) && !/disambiguation|ujednoznaczni/i.test(h.description ?? ''))
      for (const h of hits.slice(0, 3)) {
        const cr = (await get(`${WD}?${qs({ action: 'wbgetclaims', entity: h.id, property: p.id })}`)) as { claims?: Record<string, Claim[]> }
        const c = pickClaim(cr.claims?.[p.id] ?? [])
        const v = c?.mainsnak.datavalue?.value
        if (!c || !v) continue
        const asOf = year(c.qualifiers?.P585?.[0]?.datavalue?.value.time)
        let value = ''
        let nums: number[] = []
        if (p.kind === 'qty' && v.amount) {
          const n = parseFloat(v.amount)
          const unit = UNITS[v.unit?.split('/').pop() ?? ''] ?? ''
          value = `${fmtNum(n)}${unit ? ` ${unit}` : ''}`
          nums = [n]
        } else if (p.kind === 'time' && v.time) {
          value = dateTxt(v.time, v.precision)
          nums = numbersIn(value.replace(/\./g, ' '))
        } else if (p.kind === 'item' && v.id) {
          const er = (await get(`${WD}?${qs({ action: 'wbgetentities', ids: v.id, props: 'labels', languages: `${lang}|en` })}`)) as { entities?: Record<string, { labels?: Record<string, { value: string }> }> }
          const ls = er.entities?.[v.id]?.labels
          value = ls?.[lang]?.value ?? ls?.en?.value ?? v.id
        }
        if (!value) continue
        if (asOf) nums.push(Number(asOf))
        return { qid: h.id, label: h.label!, prop: p.id, name: p.name, value, nums, asOf }
      }
      // trafienia bez tej właściwości („Polski” – nazwisko) → próbujemy krótszego rdzenia („Polsk” → Polska)
    }
  }
  return undefined
}
