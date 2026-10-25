// Rozbiór zdania w przeglądarce (warstwa rozumienia): tokenizacja → model grzybni (tagger + parser, wagi MYCRB1)
// → te same reguły co src/iot_mycelium/rozbior/analiza.py (części mowy, cechy, części zdania, pytania przypadków,
// zdania składowe, ramy orzeczeń). Zgodność z Pythonem sprawdza web/scripts/rozbior-parity.mjs w CI.
// Wagi: opublikowana wersja z bazy (myc_rb_list → Storage), zweryfikowana niezależnie na teście UD.

export type Feats = Record<string, string>
export interface UTok {
  form: string
  lemma?: string
  upos: string
  feats?: Feats
  head: number
  deprel: string
  p?: number
  sa?: number
  /** log-prawdopodobieństwa modelu (UPOS i cechy) – dla warstwy Morfeusza (morf.ts) */
  lp?: { upos: number[]; feats: Record<string, number[]> }
  morf?: number
}
export interface ATok {
  i: number
  form: string
  lemma?: string
  upos: string
  pos: string
  feats: Feats
  cechy: string[]
  head: number
  deprel: string
  part: string | null
  q: string | null
  okol: string | null
  of: number | null
  clause: number | null
}
export interface Clause {
  id: number
  head: number
  type: string
  conj: string | null
  parent: number | null
}
export interface Arg {
  q: string | null
  part: string | null
  okol: string | null
  i: number
  span: [number, number]
}
export interface Frame {
  pred: number
  words: number[]
  kind: string
  aspect: string | null
  tense: string | null
  mood: string | null
  voice: string | null
  neg: boolean
  clause: number | null
  args: Arg[]
}
export interface Analysis {
  tokens: ATok[]
  clauses: Clause[]
  frames: Frame[]
}

export const POS_PL: Record<string, string> = {
  NOUN: 'rzeczownik',
  PROPN: 'rzeczownik własny',
  VERB: 'czasownik',
  AUX: 'czasownik posiłkowy',
  ADJ: 'przymiotnik',
  ADV: 'przysłówek',
  PRON: 'zaimek',
  DET: 'zaimek określający',
  NUM: 'liczebnik',
  ADP: 'przyimek',
  CCONJ: 'spójnik współrzędny',
  SCONJ: 'spójnik podrzędny',
  PART: 'partykuła',
  INTJ: 'wykrzyknik',
  PUNCT: 'interpunkcja',
  SYM: 'symbol',
  X: 'inne',
}
export const FEAT_PL: Record<string, Record<string, string>> = {
  Case: { Nom: 'mianownik', Gen: 'dopełniacz', Dat: 'celownik', Acc: 'biernik', Ins: 'narzędnik', Loc: 'miejscownik', Voc: 'wołacz' },
  Number: { Sing: 'liczba pojedyncza', Plur: 'liczba mnoga', Ptan: 'tylko mnoga' },
  Gender: { Masc: 'rodzaj męski', Fem: 'rodzaj żeński', Neut: 'rodzaj nijaki' },
  Animacy: { Hum: 'męskoosobowy', Nhum: 'niemęskoosobowy', Anim: 'żywotny', Inan: 'nieżywotny' },
  Person: { '1': '1. osoba', '2': '2. osoba', '3': '3. osoba', '0': 'bezosobowo' },
  Tense: { Past: 'czas przeszły', Pres: 'czas teraźniejszy', Fut: 'czas przyszły' },
  Aspect: { Imp: 'niedokonany', Perf: 'dokonany' },
  Mood: { Ind: 'oznajmujący', Imp: 'rozkazujący', Cnd: 'przypuszczający' },
  Degree: { Pos: 'stopień równy', Cmp: 'stopień wyższy', Sup: 'stopień najwyższy' },
  VerbForm: { Fin: 'forma osobowa', Inf: 'bezokolicznik', Part: 'imiesłów', Conv: 'imiesłów przysłówkowy', Vnoun: 'rzeczownik odczasownikowy' },
  Voice: { Act: 'strona czynna', Pass: 'strona bierna' },
  Polarity: { Pos: 'twierdzenie', Neg: 'przeczenie' },
}
export const FEATS = Object.keys(FEAT_PL)
const CASE_Q: Record<string, string> = { Nom: 'KTO/CO', Gen: 'KOGO/CZEGO', Dat: 'KOMU/CZEMU', Acc: 'KOGO/CO', Ins: 'KIM/CZYM', Loc: 'O KIM/O CZYM', Voc: 'WOŁACZ' }
const CASE_Q_PREP: Record<string, string> = { Gen: 'KOGO/CZEGO', Dat: 'KOMU/CZEMU', Acc: 'KOGO/CO', Ins: 'KIM/CZYM', Loc: 'KIM/CZYM' }
const PREP_NORM: Record<string, string> = { we: 'w', ze: 'z', ku: 'ku', ode: 'od', nade: 'nad', pode: 'pod', przede: 'przed', przeze: 'przez', beze: 'bez', spode: 'spod', obe: 'o' }
const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean))
const TIME_N = set(`rok lata dzień doba tydzień miesiąc godzina minuta sekunda chwila moment czas okres wiek stulecie tysiąclecie
    era epoka noc ranek rano poranek wieczór popołudnie południe północ świt zmierzch weekend sezon semestr kwartał
    wiosna lato jesień zima poniedziałek wtorek środa czwartek piątek sobota niedziela styczeń luty marzec kwiecień
    maj czerwiec lipiec sierpień wrzesień październik listopad grudzień święto wakacje ferie urlop wojna początek koniec
    przeszłość przyszłość teraźniejszość dzieciństwo młodość starość dekada termin data pora godz okazja`)
const PLACE_PREP = set('w na przy pod nad za przed między pomiędzy obok u wśród pośród koło poza wokół naprzeciw naprzeciwko niedaleko wewnątrz opodal blisko dookoła')
const TO_PREP = set('do ku')
const FROM_PREP = set('z od spod znad zza sprzed spośród spomiędzy')
const TIME_PREP = set('podczas około przed po od do w przez na za koło pod u z')
const CAUSE_PREP = set('dzięki wskutek wobec skutkiem')
const CAUSE_N = set('powód przyczyna skutek racja wynik względ')
const ADV_PLACE = set(`tu tutaj tam gdzie wszędzie nigdzie gdzieś gdziekolwiek daleko blisko wysoko nisko obok wokół dookoła stąd
    stamtąd skąd dokąd dotąd tędy tamtędy wewnątrz zewnątrz naprzeciw naprzód wstecz dalej bliżej wyżej niżej
    niedaleko opodal dookoła góra dół nigdzie owdzie indziej`)
const ADV_TIME = set(`teraz wczoraj dziś dzisiaj jutro pojutrze przedwczoraj zawsze nigdy często rzadko wtedy potem później
    wcześniej niedawno dawno kiedyś wkrótce zaraz natychmiast codziennie ostatnio obecnie dotychczas dopiero
    nadal wciąż ciągle odtąd wówczas kiedy kiedykolwiek kiedyś nieraz czasem czasami zazwyczaj zwykle
    rano wieczorem nocą latem zimą wiosną jesienią długo krótko prędko szybko wreszcie nareszcie znowu znów
    ponownie odtąd tymczasem dotąd dziennie rocznie corocznie właśnie`)
const ADV_CAUSE = set('dlatego dlaczego czemu przeto stąd zatem toteż')
const ADV_PURPOSE = new Set(['celowo', 'umyślnie', 'naumyślnie', 'specjalnie', 'po co'])
const ADV_DEGREE = set('bardzo trochę nieco zbyt za dość dosyć całkiem zupełnie całkowicie prawie niemal mniej więcej najbardziej najmniej tak aż')
export const MARK_TYPE: Record<string, string> = {
  gdy: 'czasu', kiedy: 'czasu', zanim: 'czasu', aż: 'czasu', odkąd: 'czasu', dopóki: 'czasu', dopóty: 'czasu', ilekroć: 'czasu',
  skoro: 'przyczyny', bo: 'przyczyny', ponieważ: 'przyczyny', gdyż: 'przyczyny', albowiem: 'przyczyny',
  żeby: 'celu', aby: 'celu', by: 'celu', ażeby: 'celu', iżby: 'celu',
  gdzie: 'miejsca', dokąd: 'miejsca', skąd: 'miejsca',
  jeśli: 'warunku', jeżeli: 'warunku', gdyby: 'warunku', jeśliby: 'warunku',
  choć: 'przyzwolenia', chociaż: 'przyzwolenia', mimo: 'przyzwolenia', aczkolwiek: 'przyzwolenia',
  jak: 'sposobu', jakby: 'sposobu', niż: 'porównania',
}
export const OKOL_Q: Record<string, string> = {
  miejsca: 'GDZIE', kierunku: 'DOKĄD', skąd: 'SKĄD', czasu: 'KIEDY', sposobu: 'JAK', stopnia: 'JAK BARDZO', przyczyny: 'DLACZEGO',
  celu: 'PO CO', warunku: 'POD JAKIM WARUNKIEM', przyzwolenia: 'MIMO CZEGO', porównania: 'JAK',
}
const CC_TYPE: Record<string, string> = {
  i: 'łączne', oraz: 'łączne', także: 'łączne', ani: 'łączne', ni: 'łączne',
  a: 'przeciwstawne', ale: 'przeciwstawne', lecz: 'przeciwstawne', jednak: 'przeciwstawne', jednakże: 'przeciwstawne', zaś: 'przeciwstawne', natomiast: 'przeciwstawne',
  albo: 'rozłączne', lub: 'rozłączne', czy: 'rozłączne', bądź: 'rozłączne',
  więc: 'wynikowe', zatem: 'wynikowe', dlatego: 'wynikowe', toteż: 'wynikowe', przeto: 'wynikowe',
}
const ARG_PARTS = new Set(['podmiot', 'dopełnienie', 'okolicznik'])
const PRED_AUX = new Set(['aux', 'aux:clitic', 'aux:cnd', 'aux:pass', 'aux:imp', 'expl:pv', 'expl:impers'])
const CLAUSE_REL: Record<string, string> = {
  ccomp: 'podrzędne dopełnieniowe', 'ccomp:obj': 'podrzędne dopełnieniowe', 'ccomp:cleft': 'podrzędne dopełnieniowe',
  csubj: 'podrzędne podmiotowe', acl: 'podrzędne przydawkowe', 'acl:relcl': 'podrzędne przydawkowe',
  advcl: 'podrzędne okolicznikowe', 'advcl:relcl': 'podrzędne okolicznikowe', 'advcl:cmp': 'podrzędne okolicznikowe',
  parataxis: 'współrzędne (bez spójnika)', 'parataxis:obj': 'wtrącone', 'parataxis:insert': 'wtrącone',
}
const base = (r: string) => r.split(':')[0]
const norm = (s: string) => {
  const x = (s || '').toLowerCase()
  return PREP_NORM[x] ?? x
}
export function featsPl(f: Feats): string[] {
  const out: string[] = []
  for (const k of FEATS) {
    const v = f[k]
    if (v && FEAT_PL[k][v]) out.push(FEAT_PL[k][v])
  }
  return out
}

class Tree {
  t: UTok[]
  n: number
  kids: number[][]
  constructor(t: UTok[]) {
    this.t = t
    this.n = t.length
    this.kids = Array.from({ length: this.n + 1 }, () => [])
    t.forEach((x, k) => {
      const i = k + 1
      let h = Number(x.head || 0)
      if (!(h >= 0 && h <= this.n) || h === i) h = 0
      this.kids[h].push(i)
    })
  }
  tok(i: number) {
    return this.t[i - 1]
  }
  rel(i: number) {
    return this.tok(i).deprel || 'dep'
  }
  head(i: number) {
    const h = Number(this.tok(i).head || 0)
    return h >= 0 && h <= this.n && h !== i ? h : 0
  }
  f(i: number, k: string): string | undefined {
    return (this.tok(i).feats || {})[k]
  }
  lem(i: number) {
    return (this.tok(i).lemma || this.tok(i).form || '').toLowerCase()
  }
  children(i: number, ...rels: string[]) {
    return this.kids[i].filter((c) => !rels.length || rels.includes(this.rel(c)) || rels.includes(base(this.rel(c))))
  }
  prep(i: number): string | null {
    const cs = this.children(i, 'case')
    if (!cs.length) return null
    const c = cs[0]
    const p = norm(this.lem(c))
    const fx = this.children(c, 'fixed').map((x) => this.lem(x))
    return fx.length ? [p, ...fx].join(' ') : p
  }
  subtree(i: number, stop: Set<number> = new Set()) {
    const out: number[] = []
    const st = [i]
    const seen = new Set<number>()
    while (st.length) {
      const j = st.pop()!
      if (seen.has(j)) continue
      seen.add(j)
      out.push(j)
      for (const c of this.kids[j]) if (!stop.has(c)) st.push(c)
    }
    return out.sort((a, b) => a - b)
  }
  isPred(i: number): boolean {
    const up = this.tok(i).upos
    const r = base(this.rel(i))
    if (this.children(i, 'cop').length) return true
    const vf = this.f(i, 'VerbForm')
    if ((up === 'VERB' || up === 'AUX') && (['Fin', 'Inf', 'Part', undefined].includes(vf) || this.children(i, 'aux', 'nsubj').length)) {
      if (vf === 'Part' && (r === 'amod' || r === 'acl') && !this.children(i, 'aux', 'cop').length) return r === 'acl'
      return !['amod', 'nmod', 'case', 'mark', 'cc', 'fixed', 'flat', 'det'].includes(r)
    }
    if (r === 'root' && up !== 'PUNCT') return true
    return ['ccomp', 'csubj', 'advcl', 'acl', 'parataxis'].includes(r) && up !== 'PUNCT'
  }
}

function okolType(T: Tree, i: number, prep: string | null): string | null {
  const lem = T.lem(i)
  const cas = T.f(i, 'Case')
  if (prep) {
    const ps = prep.split(' ')
    const p0 = ps[0]
    if (ps.length > 1 && CAUSE_N.has(ps[1])) return 'przyczyny'
    if (CAUSE_PREP.has(p0)) return 'przyczyny'
    if (CAUSE_N.has(lem) && (p0 === 'z' || p0 === 'na')) return 'przyczyny'
    if (p0 === 'dla' || (p0 === 'w' && lem === 'cel')) return 'celu'
    if (TIME_N.has(lem) && TIME_PREP.has(p0)) return 'czasu'
    if (T.tok(i).upos === 'NUM' && ['w', 'od', 'do', 'po', 'przed'].includes(p0) && /^\d+$/.test(T.tok(i).form || '')) return 'czasu'
    if (p0 === 'podczas' || p0 === 'temu') return 'czasu'
    if (TO_PREP.has(p0) || (['w', 'pod', 'nad', 'za', 'przed', 'między'].includes(p0) && cas === 'Acc')) return 'kierunku'
    if (FROM_PREP.has(p0) && cas === 'Gen') return 'skąd'
    if (PLACE_PREP.has(p0)) return 'miejsca'
    if (p0 === 'bez' || (p0 === 'z' && cas === 'Ins')) return 'sposobu'
    return null
  }
  if (TIME_N.has(lem) && (cas === 'Acc' || cas === 'Gen' || cas === 'Ins')) return 'czasu'
  return null
}
function advType(T: Tree, i: number): string {
  const lem = T.lem(i)
  if (ADV_PLACE.has(lem)) return 'miejsca'
  if (ADV_TIME.has(lem)) return 'czasu'
  if (ADV_CAUSE.has(lem)) return 'przyczyny'
  if (ADV_PURPOSE.has(lem)) return 'celu'
  if (ADV_DEGREE.has(lem)) return 'stopnia'
  return 'sposobu'
}
function caseQ(T: Tree, i: number, prep: string | null): string {
  const cas = T.f(i, 'Case')
  const up = T.tok(i).upos
  if (prep) {
    const q = CASE_Q_PREP[cas || ''] ?? 'KOGO/CO'
    if (prep === 'o' && cas === 'Loc') return 'O KIM/O CZYM'
    return `${prep.toUpperCase()} ${q}`
  }
  if (up === 'VERB' && T.f(i, 'VerbForm') === 'Inf') return 'CO ROBIĆ'
  return CASE_Q[cas || ''] ?? (['NOUN', 'PROPN', 'PRON'].includes(up) ? 'KTO/CO' : 'CO')
}
function attrQ(T: Tree, i: number): string {
  const r = T.rel(i)
  const up = T.tok(i).upos
  if (r === 'nmod:poss' || r === 'det:poss' || T.f(i, 'Poss') === 'Yes') return 'CZYJ'
  if (base(r) === 'nummod' || up === 'NUM' || r.startsWith('det:num')) return 'ILE'
  if (up === 'ADJ' && T.f(i, 'NumType') === 'Ord') return 'KTÓRY'
  if (up === 'DET') return 'KTÓRY'
  if (base(r) === 'nmod') {
    const p = T.prep(i)
    return p ? `JAKI (${caseQ(T, i, p)})` : 'JAKI (KOGO/CZEGO)'
  }
  if (base(r) === 'acl') return 'JAKI (zdanie)'
  if (base(r) === 'appos') return 'KTO/CO (dopowiedzenie)'
  return 'JAKI'
}
const okQ = (o: string | null, T: Tree, i: number, p: string | null) => (o && OKOL_Q[o] && o !== 'sposobu' ? OKOL_Q[o] : caseQ(T, i, p))

function depth(T: Tree, i: number) {
  let d = 0
  const seen = new Set<number>()
  while (i && !seen.has(i)) {
    seen.add(i)
    i = T.head(i)
    d++
  }
  return d
}
function clauseOf(T: Tree, i: number, ids: Map<number, number>): number | null {
  const seen = new Set<number>()
  while (i && !seen.has(i)) {
    if (ids.has(i)) return ids.get(i)!
    seen.add(i)
    i = T.head(i)
  }
  if (!ids.size) return null
  const first = ids.keys().next().value as number
  return ids.get(first) ?? null
}
function conjuncts(T: Tree, i: number) {
  const out: number[] = []
  const st = [...T.children(i, 'conj')]
  while (st.length) {
    const c = st.pop()!
    if (out.includes(c)) continue
    out.push(c)
    st.push(...T.children(c, 'conj'))
  }
  return out
}

export function analyse(toks: UTok[]): Analysis {
  const T = new Tree(toks)
  const n = T.n
  const part: (string | null)[] = Array(n + 1).fill(null)
  const q: (string | null)[] = Array(n + 1).fill(null)
  const okol: (string | null)[] = Array(n + 1).fill(null)
  const of: (number | null)[] = Array(n + 1).fill(null)
  const preds: number[] = []
  for (let i = 1; i <= n; i++) if (T.isPred(i)) preds.push(i)
  const pset = new Set(preds)
  for (let i = 1; i <= n; i++) {
    const r = T.rel(i)
    const br = base(r)
    const up = T.tok(i).upos
    const h = T.head(i)
    if (br === 'punct' || up === 'PUNCT') part[i] = 'interpunkcja'
    else if (br === 'case') part[i] = 'przyimek'
    else if (br === 'cc' || br === 'mark') part[i] = 'spójnik'
    else if (r === 'advmod:neg' || (up === 'PART' && T.lem(i) === 'nie')) part[i] = 'przeczenie'
    else if (br === 'cop') part[i] = 'łącznik'
    else if (PRED_AUX.has(r)) part[i] = 'orzeczenie'
    else if (br === 'vocative') part[i] = 'wołacz'
    else if (br === 'discourse' || up === 'INTJ') part[i] = 'wykrzyknik'
    else if (r === 'advmod:emph' || up === 'PART') part[i] = 'partykuła'
    else if (pset.has(i) && ['root', 'conj', 'parataxis', 'xcomp', 'ccomp', 'advcl', 'acl', 'csubj'].includes(br)) part[i] = T.children(i, 'cop').length ? 'orzecznik' : 'orzeczenie'
    else if (br === 'nsubj' || br === 'csubj') {
      part[i] = 'podmiot'
      q[i] = 'KTO/CO'
    } else if (['obj', 'iobj', 'xcomp', 'ccomp'].includes(br) || ['obl:arg', 'nmod:arg', 'obl:agent', 'advmod:arg'].includes(r)) {
      if (r === 'nmod:arg' && !pset.has(h)) {
        part[i] = 'przydawka'
        of[i] = h
        q[i] = attrQ(T, i)
      } else {
        part[i] = 'dopełnienie'
        q[i] = br === 'ccomp' ? 'CO (zdanie)' : r === 'obl:agent' ? 'PRZEZ KOGO/CO' : caseQ(T, i, T.prep(i))
      }
    } else if (br === 'obl') {
      part[i] = 'okolicznik'
      const p = T.prep(i)
      okol[i] = okolType(T, i, p)
      q[i] = okQ(okol[i], T, i, p)
    } else if (br === 'advmod') {
      part[i] = 'okolicznik'
      okol[i] = advType(T, i)
      q[i] = OKOL_Q[okol[i]!]
      if (!pset.has(h)) {
        okol[i] = okol[i] === 'sposobu' || okol[i] === 'stopnia' ? 'stopnia' : okol[i]
        q[i] = OKOL_Q[okol[i]!]
      }
    } else if (br === 'advcl') {
      part[i] = 'okolicznik'
      const m = T.children(i, 'mark').map((c) => T.lem(c))
      okol[i] = m.map((x) => MARK_TYPE[x]).find(Boolean) ?? null
      q[i] = OKOL_Q[okol[i] || ''] ?? 'W JAKICH OKOLICZNOŚCIACH'
    } else if (['amod', 'det', 'nummod', 'nmod', 'acl', 'appos'].includes(br)) {
      part[i] = 'przydawka'
      of[i] = h
      q[i] = attrQ(T, i)
    } else if (['fixed', 'flat', 'goeswith', 'compound', 'list', 'orphan', 'dep', 'reparandum', 'conj'].includes(br)) part[i] = null
    else part[i] = 'inne'
  }
  const inherit = (i: number, d = 0): void => {
    if (part[i] !== null || d > n) return
    const h = T.head(i)
    if (h === 0) {
      part[i] = pset.has(i) ? 'orzeczenie' : 'inne'
      return
    }
    inherit(h, d + 1)
    if (base(T.rel(i)) === 'conj' && pset.has(i) && (part[h] === 'orzeczenie' || part[h] === 'orzecznik')) {
      part[i] = T.children(i, 'cop').length ? 'orzecznik' : 'orzeczenie'
      return
    }
    part[i] = part[h]
    q[i] = q[h]
    okol[i] = okol[h]
    of[i] = of[h]
    if (base(T.rel(i)) === 'conj' && ['dopełnienie', 'okolicznik', 'podmiot'].includes(part[i] || '')) {
      const p = T.prep(i) ?? T.prep(h)
      if (part[i] === 'okolicznik') {
        okol[i] = okolType(T, i, p) ?? okol[h]
        q[i] = okQ(okol[i], T, i, p)
      }
    }
  }
  for (let i = 1; i <= n; i++) inherit(i)

  const ids = new Map<number, number>()
  const isClauseHead = (i: number) => {
    const br = base(T.rel(i))
    if (T.head(i) === 0) return true
    if (CLAUSE_REL[T.rel(i)]) return true
    return br === 'conj' && pset.has(i) && ids.has(T.head(i))
  }
  const order = Array.from({ length: n }, (_, k) => k + 1).sort((a, b) => depth(T, a) - depth(T, b) || a - b)
  for (const i of order) if (isClauseHead(i)) ids.set(i, ids.size)
  const clauses: Clause[] = []
  for (const [hd, cid] of ids) {
    const r = T.rel(hd)
    const br = base(r)
    const par = T.head(hd) ? clauseOf(T, T.head(hd), ids) : null
    let typ: string
    let conj: string | null
    if (T.head(hd) === 0) {
      typ = 'główne'
      conj = null
    } else if (br === 'conj') {
      const cc = T.children(hd, 'cc').map((c) => T.lem(c))
      conj = cc[0] ?? null
      typ = 'współrzędne ' + (CC_TYPE[conj || ''] ?? (conj ? 'łączne' : '(bez spójnika)'))
      typ = typ.replace('współrzędne (bez spójnika)', 'współrzędne bezspójnikowe')
    } else {
      const m = T.children(hd, 'mark').map((c) => T.lem(c))
      conj = m[0] ?? null
      typ = CLAUSE_REL[r] ?? CLAUSE_REL[br] ?? 'podrzędne'
      if (typ === 'podrzędne okolicznikowe' && okol[hd]) typ += ` ${okol[hd]}`
    }
    clauses.push({ id: cid, head: hd, type: typ, conj, parent: par })
  }
  const cOf: (number | null)[] = [null]
  for (let i = 1; i <= n; i++) cOf.push(clauseOf(T, i, ids))

  const frames: Frame[] = []
  for (const p of preds) {
    if (part[p] !== 'orzeczenie' && part[p] !== 'orzecznik') continue
    const words = [p, ...T.kids[p].filter((c) => PRED_AUX.has(T.rel(c)) || PRED_AUX.has(base(T.rel(c))) || base(T.rel(c)) === 'cop')].sort((a, b) => a - b)
    const verb = T.children(p, 'cop')[0] ?? p
    const kind = T.children(p, 'cop').length ? 'imienne' : 'czasownikowe'
    const allw = [verb, ...words.filter((c) => c !== verb)]
    const aspect = allw.map((w) => T.f(w, 'Aspect')).find(Boolean) ?? null
    const tense = allw.filter((w) => T.rel(w) !== 'aux:clitic').map((w) => T.f(w, 'Tense')).find(Boolean) ?? null
    let mood = allw.map((w) => T.f(w, 'Mood')).find((m) => m && m !== 'Ind') ?? null
    if (T.children(p, 'aux:cnd').length) mood = 'Cnd'
    mood = mood ?? (tense ? 'Ind' : null)
    const voice = T.children(p, 'aux:pass').length || T.f(p, 'Voice') === 'Pass' ? 'Pass' : null
    const neg = T.kids[p].some((c) => part[c] === 'przeczenie') || words.some((w) => T.kids[w].some((c) => part[c] === 'przeczenie'))
    const args: Arg[] = []
    const stop = new Set(preds)
    for (const c of T.kids[p]) {
      if (!ARG_PARTS.has(part[c] || '')) continue
      for (const a of [c, ...conjuncts(T, c)]) {
        if (!ARG_PARTS.has(part[a] || '')) continue
        const st = new Set(stop)
        st.delete(a)
        const span = T.subtree(a, st).filter((x) => part[x] !== 'interpunkcja')
        args.push({ q: q[a], part: part[a], okol: okol[a], i: a, span: [Math.min(...span), Math.max(...span)] })
      }
    }
    args.sort((a, b) => a.i - b.i)
    frames.push({ pred: p, words, kind, aspect, tense, mood, voice, neg, clause: cOf[p], args })
  }
  const tokens: ATok[] = toks.map((x, k) => {
    const i = k + 1
    const fe: Feats = {}
    for (const [kk, v] of Object.entries(x.feats || {})) if (FEAT_PL[kk]) fe[kk] = v
    return {
      i,
      form: x.form,
      lemma: x.lemma,
      upos: x.upos,
      pos: POS_PL[x.upos || 'X'] ?? 'inne',
      feats: fe,
      cechy: featsPl(x.feats || {}),
      head: T.head(i),
      deprel: T.rel(i),
      part: part[i],
      q: q[i],
      okol: okol[i],
      of: of[i],
      clause: cOf[i],
    }
  })
  return { tokens, clauses, frames }
}

// ------------------------------------------------------------------ model (MYCRB1, fp16)
const WDIM = 64, CDIM = 32, CFIL = 96, CASED = 8, TBD = 8, HID = 160, ARC = 256, REL = 96, MAXC = 20
const TBS = ['pdb', 'lfg']
export interface Header {
  words: string[]
  chars: string[]
  upos: string[]
  feats: Record<string, string[]>
  lemmas: string[]
  deprels: string[]
  shapes: [string, number[]][]
  train?: unknown
}
interface Mat {
  d: Float32Array
  shape: number[]
}
export interface RbModel {
  H: Header
  W: Record<string, Mat>
  wv: Map<string, number>
  cv: Map<string, number>
  bytes: number
}

function f16(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) return s * 2 ** -14 * (m / 1024)
  if (e === 31) return m ? NaN : s * Infinity
  return s * 2 ** (e - 15) * (1 + m / 1024)
}
export function loadModel(buf: ArrayBuffer): RbModel {
  const u8 = new Uint8Array(buf)
  const magic = new TextDecoder().decode(u8.slice(0, 6))
  if (magic !== 'MYCRB2' && magic !== 'MYCRB1') throw new Error('to nie jest plik MYCRB2')
  const v1 = magic === 'MYCRB1'
  const n = new DataView(buf).getUint32(6, true)
  const H = JSON.parse(new TextDecoder().decode(u8.slice(10, 10 + n))) as Header
  let o = 10 + n
  const W: Record<string, Mat> = {}
  const dv = new DataView(buf)
  const lut = new Float32Array(65536)
  for (let i = 0; i < 65536; i++) lut[i] = f16(i)
  const i8 = new Int8Array(buf)
  for (const [k, sh] of H.shapes) {
    const cnt = sh.reduce((a, b) => a * b, 1)
    const d = new Float32Array(cnt)
    if (!v1 && sh.length >= 2 && cnt >= 4096) {
      // int8 + skala fp32 na wiersz (ostatni wymiar = wiersz)
      const cols = sh[sh.length - 1]
      const rows = cnt / cols
      const sc = new Float32Array(rows)
      for (let r = 0; r < rows; r++) sc[r] = dv.getFloat32(o + 4 * r, true)
      o += 4 * rows
      for (let i = 0; i < cnt; i++) d[i] = i8[o + i] * sc[(i / cols) | 0]
      o += cnt
    } else {
      for (let i = 0; i < cnt; i++) d[i] = lut[dv.getUint16(o + 2 * i, true)]
      o += 2 * cnt
    }
    W[k] = { d, shape: sh }
  }
  if (o !== buf.byteLength) throw new Error(`rozmiar pliku ${buf.byteLength} != ${o}`)
  return { H, W, wv: new Map(H.words.map((w, i) => [w, i + 3])), cv: new Map(H.chars.map((c, i) => [c, i + 3])), bytes: buf.byteLength }
}

export function charsOf(w: string): string[] {
  const s = [...('^' + w.toLowerCase() + '$')]
  return s.length <= MAXC ? s : [...s.slice(0, 2), ...s.slice(s.length - (MAXC - 2))]
}
export function casing(w: string): number {
  if (!w || !/\p{L}/u.test(w)) return 3
  if (w === w.toUpperCase() && w.length > 1) return 2
  return w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase() ? 1 : 0
}
export function applyRule(form: string, rule: string): string {
  const [ks, app, cap] = rule.split('|')
  const k = Number(ks)
  const f = form.toLowerCase()
  if (!Number.isFinite(k) || app === undefined) return f
  if (k > [...f].length) return f
  const fa = [...f]
  const out = fa.slice(0, fa.length - k).join('') + app
  return cap ? out.charAt(0).toUpperCase() + out.slice(1) : out
}

/** y = W x + b  (W: [out, in]) */
function affine(W: Mat, b: Mat | null, x: Float32Array, xo = 0): Float32Array {
  const [no, ni] = W.shape
  const y = new Float32Array(no)
  for (let r = 0; r < no; r++) {
    let s = b ? b.d[r] : 0
    const ro = r * ni
    for (let c = 0; c < ni; c++) s += W.d[ro + c] * x[xo + c]
    y[r] = s
  }
  return y
}
const sig = (x: number) => 1 / (1 + Math.exp(-x))
function lstm(xs: Float32Array[], wi: Mat, wh: Mat, b: Mat, rev: boolean): Float32Array[] {
  const n = xs.length
  let h = new Float32Array(HID)
  let c = new Float32Array(HID)
  const out: Float32Array[] = Array(n)
  const idx = Array.from({ length: n }, (_, k) => (rev ? n - 1 - k : k))
  for (const t of idx) {
    const g = affine(wi, b, xs[t])
    const gh = affine(wh, null, h)
    const h2 = new Float32Array(HID)
    const c2 = new Float32Array(HID)
    for (let j = 0; j < HID; j++) {
      const ii = sig(g[j] + gh[j])
      const ff = sig(g[HID + j] + gh[HID + j])
      const gg = Math.tanh(g[2 * HID + j] + gh[2 * HID + j])
      const oo = sig(g[3 * HID + j] + gh[3 * HID + j])
      c2[j] = ff * c[j] + ii * gg
      h2[j] = oo * Math.tanh(c2[j])
    }
    h = h2
    c = c2
    out[t] = h2
  }
  return out
}
const row = (m: Mat, r: number) => m.d.subarray(r * m.shape[1], (r + 1) * m.shape[1])
const argmax = (a: ArrayLike<number>) => {
  let k = 0
  for (let i = 1; i < a.length; i++) if (a[i] > a[k]) k = i
  return k
}
const relu = (a: Float32Array) => a.map((v) => (v > 0 ? v : 0))

function hidden(M: RbModel, forms: string[], tb = 'pdb'): Float32Array[] {
  const { W } = M
  const xs = forms.map((w) => {
    const wid = M.wv.get(w.toLowerCase()) ?? 1
    const cs = charsOf(w).map((ch) => M.cv.get(ch) ?? 1)
    const ch = new Float32Array(CFIL).fill(-Infinity)
    const cw = W.conv_w // [F, C, 3]
    for (let t = 0; t + 3 <= cs.length; t++) {
      for (let f = 0; f < CFIL; f++) {
        let s = W.conv_b.d[f]
        for (let k = 0; k < 3; k++) {
          const e = row(W.cemb, cs[t + k])
          for (let cc = 0; cc < CDIM; cc++) s += cw.d[(f * CDIM + cc) * 3 + k] * e[cc]
        }
        if (s > ch[f]) ch[f] = s
      }
    }
    const x = new Float32Array(WDIM + CFIL + CASED + TBD)
    x.set(row(W.wemb, wid), 0)
    x.set(ch.map((v) => (v > 0 ? v : 0)), WDIM)
    x.set(row(W.case, casing(w)), WDIM + CFIL)
    x.set(row(W.tb, Math.max(0, TBS.indexOf(tb))), WDIM + CFIL + CASED)
    return x
  })
  let cur = xs
  for (const l of [0, 1]) {
    const f = lstm(cur, W[`l${l}f_wi`], W[`l${l}f_wh`], W[`l${l}f_b`], false)
    const b = lstm(cur, W[`l${l}b_wi`], W[`l${l}b_wh`], W[`l${l}b_b`], true)
    cur = f.map((v, t) => {
      const z = new Float32Array(2 * HID)
      z.set(v, 0)
      z.set(b[t], HID)
      return z
    })
  }
  return [W.root.d.slice(), ...cur]
}

/** Chu–Liu–Edmonds (scores[d][h]); jedno dziecko korzenia – jak model.mst w Pythonie. */
export function mst(S: number[][]): number[] {
  const n = S.length - 1
  const s = S.map((r, d) => r.map((v, h) => (d === 0 || d === h ? -Infinity : v)))
  const cand = Array.from({ length: n }, (_, k) => k + 1)
    .sort((a, b) => s[b][0] - s[a][0] || a - b)
    .slice(0, 3)
  let best: [number, number[]] | null = null
  for (const r of cand) {
    const t = s.map((x) => x.slice())
    for (let d = 1; d <= n; d++) t[d][0] = -Infinity
    t[r] = t[r].map(() => -Infinity)
    t[r][0] = 0
    const heads = cle(t)
    let tot = 0
    for (let d = 1; d <= n; d++) tot += s[d][heads[d]]
    if (!best || tot > best[0]) best = [tot, heads]
  }
  return best![1]
}
function findCycle(heads: number[]): number[] | null {
  const n = heads.length
  const color = Array(n).fill(0)
  for (let s0 = 1; s0 < n; s0++) {
    const path: number[] = []
    let v = s0
    while (v !== 0 && color[v] === 0) {
      color[v] = 1
      path.push(v)
      v = heads[v]
    }
    if (v !== 0 && color[v] === 1) return path.slice(path.indexOf(v))
    for (const p of path) color[p] = 2
  }
  return null
}
function cle(s: number[][]): number[] {
  const n = s.length
  const heads = [0]
  for (let d = 1; d < n; d++) heads.push(argmax(s[d]))
  const cyc = findCycle(heads)
  if (!cyc) return heads
  const cs = new Set(cyc)
  const rest = Array.from({ length: n }, (_, v) => v).filter((v) => !cs.has(v))
  const idx = new Map(rest.map((v, i) => [v, i]))
  const c = rest.length
  let cycScore = 0
  for (const v of cyc) cycScore += s[v][heads[v]]
  const ns = Array.from({ length: c + 1 }, () => Array(c + 1).fill(-Infinity))
  const enter = new Map<number, number>()
  const leave = new Map<number, number>()
  const maxBy = (arr: number[], f: (x: number) => number) => arr.reduce((b, x) => (f(x) > f(b) ? x : b), arr[0])
  for (const d of rest) {
    for (const h of rest) ns[idx.get(d)!][idx.get(h)!] = s[d][h]
    const hb = maxBy(cyc, (h) => s[d][h])
    ns[idx.get(d)!][c] = s[d][hb]
    leave.set(d, hb)
  }
  for (const h of rest) {
    const dv = maxBy(cyc, (d) => s[d][h] - s[d][heads[d]])
    ns[c][idx.get(h)!] = s[dv][h] - s[dv][heads[dv]] + cycScore
    enter.set(h, dv)
  }
  const sub = cle(ns)
  const out = heads.slice()
  for (const d of rest) {
    if (d === 0) continue
    const hh = sub[idx.get(d)!]
    out[d] = hh === c ? leave.get(d)! : rest[hh]
  }
  const hc = rest[sub[c]]
  const dv = enter.get(hc)!
  out[dv] = hc
  return out
}

const logSoftmax = (z: Float32Array): number[] => {
  let m = -Infinity
  for (const v of z) m = Math.max(m, v)
  let s = 0
  for (const v of z) s += Math.exp(v - m)
  const ls = Math.log(s)
  return Array.from(z, (v) => v - m - ls)
}

export function predict(M: RbModel, forms: string[], tb = 'pdb', withProbs = false): UTok[] {
  if (!forms.length) return []
  const { W, H } = M
  const X = hidden(M, forms, tb)
  const N1 = X.length
  const ad = X.map((x) => relu(affine(W.ad_w, W.ad_b, x)))
  const ah = X.map((x) => relu(affine(W.ah_w, W.ah_b, x)))
  // S[d][h] = ad_d · U · ah_h + ah_h · arc_h
  const U = W.arc_U
  const adU = ad.map((a) => {
    const y = new Float32Array(ARC)
    for (let i = 0; i < ARC; i++) {
      const ai = a[i]
      if (!ai) continue
      const ro = i * ARC
      for (let j = 0; j < ARC; j++) y[j] += ai * U.d[ro + j]
    }
    return y
  })
  const hb = ah.map((h) => h.reduce((s, v, j) => s + v * W.arc_h.d[j], 0))
  const S: number[][] = adU.map((u) =>
    ah.map((h, hi) => {
      let s = hb[hi]
      for (let j = 0; j < ARC; j++) s += u[j] * h[j]
      return s
    }),
  )
  const L = S.map((r) => {
    const m = Math.max(...r)
    const z = Math.log(r.reduce((a, v) => a + Math.exp(v - m), 0))
    return r.map((v) => v - m - z)
  })
  const heads = mst(L)
  const rd = X.map((x) => [...relu(affine(W.rd_w, W.rd_b, x)), 1])
  const rh = X.map((x) => [...relu(affine(W.rh_w, W.rh_b, x)), 1])
  const R = REL + 1
  const nl = H.deprels.length
  const out: UTok[] = []
  for (let i = 1; i < N1; i++) {
    const x = X[i]
    const h = heads[i]
    const rs = new Float32Array(nl)
    for (let l = 0; l < nl; l++) {
      let s = 0
      const lo = l * R * R
      for (let a = 0; a < R; a++) {
        const da = rd[i][a]
        if (!da) continue
        let t = 0
        for (let b = 0; b < R; b++) t += W.rel_U.d[lo + a * R + b] * rh[h][b]
        s += da * t
      }
      rs[l] = s
    }
    let rl = H.deprels[argmax(rs)]
    if (h === 0) rl = 'root'
    else if (rl === 'root') {
      rs[H.deprels.indexOf('root')] = -Infinity
      rl = H.deprels[argmax(rs)]
    }
    const fe: Feats = {}
    const lpf: Record<string, number[]> = {}
    for (const k of FEATS) {
      const z = affine(W[`f_${k}_w`], W[`f_${k}_b`], x)
      const v = H.feats[k][argmax(z)]
      if (v !== '_') fe[k] = v
      if (withProbs) lpf[k] = logSoftmax(z)
    }
    const form = forms[i - 1]
    const zu = affine(W.upos_w, W.upos_b, x)
    out.push({
      ...(withProbs ? { lp: { upos: logSoftmax(zu), feats: lpf } } : {}),
      form,
      lemma: applyRule(form, H.lemmas[argmax(affine(W.lem_w, W.lem_b, x))]),
      upos: H.upos[argmax(zu)],
      feats: fe,
      head: h,
      deprel: rl,
      p: Math.round(Math.exp(L[i][h]) * 1000) / 1000,
    })
  }
  return out
}

/** Tokenizacja jak w UD: słowa, liczby, znaki interpunkcyjne; klityki czasu przeszłego (-em, -ś, -śmy, -ście, by)
 * odcinane tylko, gdy całe słowo nie jest w słowniku modelu, a temat jest (np. „zrobiłem” → „zrobił” + „em”). */
export function tokenize(text: string, vocab?: Map<string, number>): { forms: string[]; sa: boolean[] } {
  const forms: string[] = []
  const sa: boolean[] = []
  const re = /\p{L}[\p{L}\p{M}'’-]*|\d+(?:[.,]\d+)*|[^\s\p{L}\d]/gu
  let m: RegExpExecArray | null
  let last = 0
  const push = (f: string, glued: boolean) => {
    if (forms.length) sa[sa.length - 1] = !glued
    forms.push(f)
    sa.push(true)
  }
  while ((m = re.exec(text))) {
    const w = m[0]
    const glued = m.index === last && forms.length > 0
    last = m.index + w.length
    const parts = vocab ? splitClitic(w, vocab) : [w]
    parts.forEach((p, k) => push(p, k > 0 || glued))
  }
  return { forms, sa }
}
const CLITIC = /^(.+?(?:ł|ła|ło|li|ły))(by)?(em|eś|m|ś|śmy|ście)$/u
function splitClitic(w: string, vocab: Map<string, number>): string[] {
  const lw = w.toLowerCase()
  if (vocab.has(lw)) return [w]
  const m = CLITIC.exec(w)
  if (m) {
    const stem = m[1]
    const pers = m[3]
    // „zrobiłem”: temat „zrobił”, „em” (po spółgłosce) albo „zrobiłam”: „zrobiła” + „m”
    if (vocab.has(stem.toLowerCase()) && !(pers === 'em' && /[aoiy]$/.test(stem)) && !(pers === 'm' && /ł$/.test(stem))) return m[2] ? [stem, m[2], pers] : [stem, pers]
  }
  const b = /^(.+?(?:ł|ła|ło|li|ły))by$/u.exec(w)
  if (b && vocab.has(b[1].toLowerCase())) return [b[1], 'by']
  return [w]
}

export function triples(a: Analysis): Set<string> {
  const out = new Set<string>()
  for (const f of a.frames) {
    for (const g of f.args) out.add(`${f.pred}|${g.q}|${g.i}`)
    if (f.neg) out.add(`${f.pred}|NIE|0`)
  }
  return out
}

// ------------------------------------------------------------------ trasa pytania (osobiste / o fakt, szukany element)
export type Slot = 'person' | 'place' | 'time' | 'reason' | 'manner' | 'thing' | 'number' | 'yesno' | 'none'
export interface Route {
  kind: 'personal' | 'factual' | 'statement'
  slot: Slot
  /** pytajnik i rola w zdaniu, np. „gdzie” → okolicznik miejsca */
  wh?: { word: string; part: string | null; q: string | null }
  /** właściwości Wikidata, których szukamy dla tego slotu (tylko podpowiedź do wyszukiwania) */
  props: string[]
  why: string
}
const WH_SLOT: Record<string, Slot> = {
  kto: 'person', kogo: 'person', komu: 'person', kim: 'person',
  co: 'thing', czego: 'thing', czemu: 'reason', czym: 'thing',
  gdzie: 'place', dokąd: 'place', skąd: 'place',
  kiedy: 'time', ile: 'number', ilu: 'number',
  dlaczego: 'reason', jak: 'manner', jaki: 'thing', jaka: 'thing', jakie: 'thing', który: 'thing', która: 'thing', które: 'thing',
}
const SLOT_PROPS: Record<Slot, string[]> = {
  person: ['P50', 'P170', 'P61', 'P35', 'P6'],
  place: ['P131', 'P276', 'P17', 'P19', 'P20', 'P159'],
  time: ['P569', 'P570', 'P571', 'P577', 'P585', 'P580'],
  number: ['P1082', 'P2046', 'P2044', 'P2048'],
  reason: [], manner: [], thing: [], yesno: [], none: [],
}
const PERSONAL = set('ja ty my wy mnie mi mną cię ci tobie tobą nas nam nami was wam wami mój moja moje twój twoja twoje nasz wasz')
export function routeOf(a: Analysis, text: string): Route {
  const toks = a.tokens
  const isQ = /\?\s*$/.test(text) || toks.some((t) => WH_SLOT[(t.form || '').toLowerCase()] && t.i <= 2)
  const pers = toks.some((t) => PERSONAL.has((t.form || '').toLowerCase()) || ((t.upos === 'VERB' || t.upos === 'AUX') && (t.feats.Person === '1' || t.feats.Person === '2')))
  const w = toks.find((t) => WH_SLOT[(t.form || '').toLowerCase()])
  let slot: Slot = w ? WH_SLOT[(w.form || '').toLowerCase()] : isQ && /^czy\b/i.test(text.trim()) ? 'yesno' : 'none'
  if (w && slot === 'thing' && /^(któr|jak)/i.test(w.form) && toks.some((t) => t.i > w.i && TIME_N.has((t.lemma || '').toLowerCase()))) slot = 'time'
  const kind: Route['kind'] = !isQ ? 'statement' : pers ? 'personal' : 'factual'
  const why = !isQ
    ? 'zdanie oznajmujące (bez pytajnika i znaku zapytania)'
    : pers
      ? 'pytanie o rozmówcę (1. lub 2. osoba: ja/ty/mój/twój…) – nie szukam w Wikipedii'
      : `pytanie o fakt${w ? ` – pytajnik „${w.form}” (${w.part ?? 'część zdania'}${w.q ? `: ${w.q}` : ''})` : ''}`
  return { kind, slot, wh: w ? { word: w.form, part: w.part, q: w.q } : undefined, props: kind === 'factual' ? SLOT_PROPS[slot] : [], why }
}
