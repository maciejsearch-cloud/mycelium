// Odpowiedzi ze źródła: polska Wikipedia (pl.wikipedia.org, CC BY-SA, publiczne API z origin=*; host już w CSP).
// Odpowiedź jest WYDOBYWCZA – zdanie przepisane dosłownie ze wstępu artykułu, z linkiem. Nic tu nie jest generowane:
// gdy żadne zdanie nie pokrywa pytania wystarczająco, zwracamy undefined i czat mówi uczciwie „nie wiem”.

export interface WikiHit {
  title: string
  url: string
  /** 1–2 zdania dosłownie ze wstępu artykułu */
  text: string
  /** udział słów treści pytania obecnych w tytule + zdaniu (0–1) */
  cover: number
}

const strip = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')

/** Słowa pytające i funkcyjne – nie są treścią pytania. */
const QWORDS = new Set(
  (
    'kto co czym czego kim komu jaki jaka jakie jakiego jakiej jakim ktory ktora ktore ktorego ktorej ktorym gdzie kiedy ile ilu dlaczego czemu jak czy ' +
    'jest sa byl byla bylo byli to ten ta te tego tej tym w we na o z ze do od po za dla przez pod nad i a oraz lub albo sie nazywa nazywal ' +
    'roku rok mial miala mialo moze mozna znaczy oznacza prosze powiedz wiesz the a an is are was what who when where which how'
  ).split(' '),
)

/** Typ oczekiwanej odpowiedzi (z pytajnika). */
export type AnsType = 'person' | 'year' | 'number' | 'place' | 'symbol' | 'any'
/** atrybuty mierzalne: „Jaka jest powierzchnia/wysokość…” → odpowiedzią jest liczba */
const MEASURE = /\b(powierzchni\w*|wysokos\w*|dlugos\w*|glebokos\w*|odleglos\w*|szerokos\w*|mas[aey]|wag[ai]|temperatur\w*|populacj\w*|ludnos\w*|liczb[aey] (mieszkancow|ludnosci)|predkos\w*|area|height|length|population)\b/
export function ansType(q: string): AnsType {
  const n = strip(q)
  if (/^\s*(kto|kogo|komu|kim|who)\b/.test(n)) return 'person'
  if (/\b(kiedy|w ktorym roku|ktorego roku|w jakim roku|when|what year)\b/.test(n)) return 'year'
  if (/\b(ile|ilu|how many|how much)\b/.test(n) || MEASURE.test(n)) return 'number'
  if (/\b(gdzie|w jakim miescie|w jakim kraju|na jakim kontynencie|where)\b/.test(n)) return 'place'
  // „Jaki jest symbol chemiczny złota?” → odpowiedzią jest symbol (Au); „Jaki pierwiastek ma symbol Fe?” – symbol jest w pytaniu
  if (/\bsymbol\w*\b/.test(n) && !symbolsIn(q).length) return 'symbol'
  return 'any'
}

/** Symbole (Fe, Au, H, Po) w oryginalnym tekście: 1–2 litery, pierwsza wielka, nie pierwsze słowo zdania. */
export function symbolsIn(t: string): string[] {
  const ws = t.match(/[\p{L}\d][\p{L}\d-]*/gu) ?? []
  return ws.filter((w, i) => i > 0 && /^\p{Lu}\p{Ll}?$/u.test(w) && !/^(I|W|Z|O|A|U)$/.test(w)).map((w) => strip(w))
}

// czasowniki relacji w czasie teraźniejszym („leży”, „znajduje się”) – relacja, nie encja
const VERBS_PRES = new Set('lezy leza znajduje znajduja plynie plyna nalezy naleza graniczy obowiazuje mieszka mieszkaja wynosi nosi slynie uzywa uzywaja rzadzi rzadza'.split(' '))
// „-eł” to prawie zawsze rzeczownik („Wawel”, „hotel”), nie czas przeszły
const isVerb = (w: string) => VERBS_PRES.has(w) || (/(l|la|lo|li|ly|lem|las|uje|ują|iła|ał|ął)$/.test(w) && !/el$/.test(w) && w.length > 3)
/** Nazwy z wielkiej litery w pytaniu (nie pierwsze słowo) – to encje, nigdy czasowniki („Wawel”, „Wisły”). */
const namesIn = (q: string) => new Set((q.match(/[\p{L}\d][\p{L}\d-]*/gu) ?? []).filter((w, i) => i > 0 && /^\p{Lu}/u.test(w)).map(strip))
const verbIn = (q: string) => {
  const names = namesIn(q)
  return (w: string) => !names.has(w) && isVerb(w)
}
/** liczebniki porządkowe → cyfra („pierwszym prezydentem” ~ „1. prezydent”) */
const ORD: [RegExp, string][] = [[/^pierwsz/, '1'], [/^drug/, '2'], [/^trzec/, '3'], [/^czwart/, '4'], [/^piat/, '5']]
const ordDigit = (w: string) => ORD.find(([re]) => re.test(w))?.[1]
/** Słowo typu odpowiedzi tuż po zaimku pytajnym („W jakim MIEŚCIE”, „Na jakim KONTYNENCIE”, „Jaki PIERWIASTEK”) –
 *  nazywa kategorię odpowiedzi, a nie encję, więc w drugim podejściu nie musi stać w zdaniu. */
export function typeNouns(q: string): string[] {
  const ws = strip(q).match(/[a-z0-9]+/g) ?? []
  const out: string[] = []
  ws.forEach((w, i) => {
    const nx = ws[i + 1]
    if (/^(jaki|jaka|jakie|jakim|jakiej|jakiego|ktory|ktora|ktore|ktorym|ktorej|ktorego)$/.test(w) && nx && !QWORDS.has(nx) && nx.length > 2) out.push(stem4(nx))
  })
  // „symbol Fe” – symbol jest podany, „symbol” to relacja
  if (symbolsIn(q).length && /\bsymbol\w*/.test(strip(q))) out.push('symb')
  return out
}

/** Rdzenie słów treści pytania (4 pierwsze litery bez ogonków – prosta obsługa odmiany). */
export function contentStems(q: string): string[] {
  const ws = (strip(q).match(/[a-z0-9]+/g) ?? []).filter((w) => !QWORDS.has(w) && (w.length > 2 || /^\d+$/.test(w)))
  return [...new Set([...ws.map(stem4), ...symbolsIn(q)])]
}
/** rdzeń: 4 litery; stopień najwyższy („najwyższy”) – 7 liter, żeby nie mylić z „najwybitniejszy” */
const stem4 = (w: string) => (/^\d+$/.test(w) ? w : w.startsWith('naj') ? w.slice(0, 7) : w.slice(0, 4))
/** Rdzenie wymagane (bez czasowników typu „napisał”, „odkrył” – relacja, nie encja). */
export function requiredStems(q: string): string[] {
  const v = verbIn(q)
  const ws = (strip(q).match(/[a-z0-9]+/g) ?? []).filter((w) => !QWORDS.has(w) && (w.length > 2 || /^\d+$/.test(w)) && !v(w))
  // symbol z pytania („Fe”) jest wymagany dosłownie – bez niego „pierwiastek” pasował do „Pierwiastkowanie”
  return [...new Set([...ws.map(stem4), ...symbolsIn(q)])]
}
/** Słowa treści w oryginalnej formie (do zapytania wyszukiwarki). */
export function contentWords(q: string): string[] {
  const sym = new Set(symbolsIn(q))
  return (q.match(/[\p{L}\d][\p{L}\d-]*/gu) ?? []).filter((w) => !QWORDS.has(strip(w)) && (w.length > 2 || /^\d+$/.test(w) || sym.has(strip(w))))
}

// „1. prezydent” (liczebnik porządkowy zapisany cyfrą) → słowo „ord1”, które pasuje do „pierwszy”
const wordsOf = (s: string) => strip(s.replace(/(^|[^\d.])(\d)\.\s+(?=\p{Ll})/gu, '$1ord$2 ')).match(/[a-z0-9]+/g) ?? []
/** rdzeń pasuje do słowa: wspólny przedrostek ≥ 3 litery (pan ~ pana, tade ~ tadeusz) */
const stemIn = (stem: string, ws: string[]): boolean =>
  (ORD_STEM.has(stem) && ws.includes(ORD_STEM.get(stem)!)) ||
  ws.some((w) =>
    stem.startsWith('naj') ? w.startsWith(stem) : (/^\d+$/.test(stem) || stem.length <= 2 ? w === stem : w.slice(0, 4) === stem || (w.length >= 3 && stem.startsWith(w)) || (stem.length >= 3 && w.startsWith(stem)) || (stem.length >= 4 && w.length >= 4 && w.slice(0, 3) === stem.slice(0, 3))))

/** Zdania tekstu (bez dzielenia na skrótach typu „ur.”, „m.in.”, „n.p.m.”, inicjałach i liczbach porządkowych). */
export function sentencesOf(t: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const part of t.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[\p{Lu}„"(])/u)) {
    cur = cur ? `${cur} ${part}` : part
    // wewnątrz nawiasu (np. „niem. Weichsel”) nie dzielimy
    if ((cur.match(/\(/g) ?? []).length > (cur.match(/\)/g) ?? []).length) continue
    if (/(\b(ur|zm|m\.in|tzw|np|ok|godz|św|im|pw|wł|r|w|ang|łac|gr|n\.p\.m|p\.n\.e|n\.e|tj|dr|prof|ks|gen|płk|ul|al|pl)|\b\p{Lu}|\d)\.$/u.test(cur)) continue
    out.push(cur.trim())
    cur = ''
  }
  if (cur.trim()) out.push(cur.trim())
  return out.filter((s) => s.length > 15)
}

/** Czy zdanie zawiera odpowiedź oczekiwanego typu (czego nie ma w pytaniu ani w tytule)? */
export function hasAnswer(type: AnsType, sent: string, q: string, title: string): boolean {
  if (type === 'any') return true
  const known = new Set([...wordsOf(q), ...wordsOf(title)])
  // symbol: 1–2 litery z wielkiej (Au) spoza pytania i tytułu, w nawiasie albo po słowie „symbol”
  if (type === 'symbol') return /(\(|symbol\w*\s+)\p{Lu}\p{Ll}?\b/u.test(sent) && symbolsIn(sent).some((x) => !known.has(x))
  // tytuł artykułu spoza pytania (np. „Alexander Fleming” dla „Kto odkrył penicylinę?”) jest odpowiedzią typu osoba/miejsce –
  // ale tylko tytuł wyglądający jak nazwa własna (bez liczb: „Apollo 11” to misja, nie osoba)
  if ((type === 'person' || type === 'place') && /^\p{Lu}\p{Ll}{2,}/u.test(title) && !/\d/.test(title) && !wordsOf(title).some((w) => stemIn(w.slice(0, 4), wordsOf(q)))) return true
  if (type === 'year') return (sent.match(/\b\d{4}\b/g) ?? []).some((y) => !known.has(y))
  if (type === 'number') return (sent.match(/\d[\d\s\u00a0.,]*/g) ?? []).some((x) => !known.has(x.replace(/\D/g, '')))
  // osoba / miejsce: wyraz z wielkiej litery spoza pytania i tytułu (nie na początku zdania)
  // (nie skrót w nawiasie typu „(Po, łac. …)” i nie skrót „łac.”/„ang.”: imię/nazwa ma ≥ 3 litery)
  const ws = sent.replace(/\([^)]*\)/g, ' ').match(/[\p{L}][\p{L}-]*/gu) ?? []
  return ws.some((w, i) => i > 0 && /^\p{Lu}\p{Ll}{2,}/u.test(w) && !known.has(strip(w)) && !stemIn(strip(w).slice(0, 4), [...known]))
}

/** Najlepsze zdania wstępu dla pytania. Warunek: każdy wymagany rdzeń pytania jest w tytule albo w zdaniu,
 *  a zdanie zawiera odpowiedź oczekiwanego typu. Inaczej undefined (brak potwierdzenia → „nie wiem”). */
export function bestSentences(q: string, title: string, extract: string, relax = false): { text: string; cover: number; prox: number; relaxed?: boolean } | undefined {
  // najpierw ściśle; potem (tylko w artykule o samej encji z pytania – „Egipt”, „Wawel”) bez słowa typu odpowiedzi
  // („mieście”, „kontynencie”), z mniejszym pokryciem
  const strict = bestSentencesReq(q, title, extract, [])
  if (strict || !relax) return strict
  const tn = typeNouns(q)
  if (!tn.length) return undefined
  const rel = bestSentencesReq(q, title, extract, tn)
  return rel && { ...rel, relaxed: true }
}

function bestSentencesReq(q: string, title: string, extract: string, drop: string[]): { text: string; cover: number; prox: number } | undefined {
  // pytanie o symbol: samo słowo „symbol” wyraża odpowiedź („Złoto (Au, …)”), nie musi stać w zdaniu
  const req0 = ansType(q) === 'symbol' ? requiredStems(q).filter((x) => x !== 'symb') : requiredStems(q)
  const req = req0.filter((x) => !drop.includes(x))
  const all = contentStems(q)
  if (!req.length) return undefined
  // sama krótka końcówka („lat”, „mam”) to za mało treści, żeby szukać – potrzebne słowo ≥ 4 litery, liczba albo symbol
  if (!req.some((x) => x.length >= 4 || /^\d+$/.test(x) || symbolsIn(q).includes(x))) return undefined
  // listy i spisy nie odpowiadają na pytanie o jedną rzecz („Lista najwybitniejszych szczytów…” ≠ „najwyższy szczyt”)
  if (/^(lista|spis|wykaz|kategoria|indeks)\b/i.test(title)) return undefined
  const tw = wordsOf(title)
  const type = ansType(q)
  // tytuł tylko częściowo z pytania (lista, artykuł poboczny) → każdy wymagany rdzeń musi być w samym zdaniu
  const tws = tw.filter((w) => !/^\d+$/.test(w) || w.length === 4)
  const prec = tws.length ? tws.filter((w) => stemIn(stem4(w), wordsOf(q))).length / tws.length : 0
  const loose = prec === 1 || prec === 0
  const sents = sentencesOf(extract).slice(0, 10)
  // artykuł-lista w przebraniu („Korona Gór Polski – lista 28 szczytów…”) nie odpowiada na pytanie o jedną rzecz
  if (sents[0] && /\s[–-]\s(\p{L}+\s)?(lista|spis|wykaz|zestawienie)\b/iu.test(sents[0].slice(0, 200))) return undefined
  const najQ = wordsOf(q).filter((w) => w.startsWith('naj') && w.length >= 7)
  // liczebnik porządkowy z rzeczownikiem („pierwszym królem”) musi stać razem w zdaniu („pierwszym królem”, „1. król”) –
  // inaczej „pierwsza misja … Królestw” udawało odpowiedź na „pierwszy król Marsa”
  const qw = wordsOf(q)
  const oi = qw.findIndex((w) => ordDigit(w))
  const ordPair = oi >= 0 && qw[oi + 1] && !QWORDS.has(qw[oi + 1]) ? { o: ordDigit(qw[oi])!, stem: qw[oi].slice(0, 5), noun: stem4(qw[oi + 1]) } : undefined
  const pairIn = (sw: string[]) =>
    !ordPair || sw.some((w, j) => (w === `ord${ordPair.o}` || w.startsWith(ordPair.stem)) && [sw[j + 1], sw[j + 2]].some((n) => n && n.slice(0, 4) === ordPair.noun))
  let best: { text: string; cover: number; i: number; prox: number } | undefined
  sents.forEach((s, i) => {
    const sw = wordsOf(s)
    if (!req.every((x) => stemIn(x, sw) || (loose && stemIn(x, tw)))) return
    // stopień najwyższy musi być w samym zdaniu (tytuł listy „najwybitniejszych…” nie odpowiada na „najwyższy”)
    if (!req.filter((x) => x.startsWith('naj')).every((x) => stemIn(x, sw))) return
    // … i w tej samej liczbie: „najwyższy szczyt” (jeden) ≠ „z najwyższych szczytów” (wiele)
    if (najQ.some((qw) => !sw.some((w) => w.startsWith(qw.slice(0, 7)) && PLURAL.test(w) === PLURAL.test(qw)))) return
    if (!pairIn(sw)) return
    if (!hasAnswer(type, s, q, title)) return
    // pokrycie: wymagane rdzenie są już spełnione (1), czasowniki relacji („napisał”) dokładają połowę wagi – remis → wcześniejsze zdanie
    const cover = 0.5 + (0.5 * all.filter((x) => stemIn(x, sw) || stemIn(x, tw)).length) / all.length
    const prox = phraseProx(q, s)
    if (!best || cover > best.cover || (cover === best.cover && prox > best.prox)) best = { text: s, cover, i, prox }
  })
  if (!best) return undefined
  const b: { text: string; cover: number; i: number; prox: number } = best
  const text = b.i > 0 && sents[0] && sents[0].length < 300 ? `${sents[0]} … ${b.text}` : b.text
  return { text: text.length > 600 ? `${text.slice(0, 597)}…` : text, cover: b.cover, prox: b.prox }
}

const PLURAL = /(ych|ich|ymi|imi)$/

/** Bliskość frazy: udział par kolejnych słów treści pytania (bez słów pytających, łącznika i przyimków), które w zdaniu
 *  też stoją obok siebie jako słowa treści. „pierwszą kobietą w kosmosie” ~ „Pierwsza kobieta w kosmosie” = 1, a
 *  „Pierwsza kobieta, która dowodziła … Kosmiczną” = 1/2; „najdłuższa rzeka w Polsce” ~ „najdłuższa rzeka Polski” = 1,
 *  a „najdłuższa rzeka w Gminie Dobra” = 1/2 – zdanie, które powtarza frazę pytania, odpowiada na nie dokładniej. */
export function phraseProx(q: string, sent: string): number {
  const content = (t: string) => wordsOf(t).filter((w) => !QWORDS.has(w)).map((w) => w.slice(0, 4))
  const qs = content(q)
  if (qs.length < 2) return 0
  const ss = content(sent)
  const pairs = new Set(ss.slice(1).map((w, i) => `${ss[i]} ${w}`))
  let n = 0
  for (let i = 1; i < qs.length; i++) if (pairs.has(`${qs[i - 1]} ${qs[i]}`)) n++
  return n / (qs.length - 1)
}
const ORD_STEM = new Map(ORD.map(([re, d]) => [re.source.slice(1, 5), `ord${d}`]))

/** Tytuł bez dopowiedzenia w nawiasie: „Lalka (powieść)” → „Lalka”. */
const baseTitle = (t: string) => t.replace(/\s*\([^)]*\)\s*$/, '')
/** Dopowiedzenie o adaptacji / pobocznym znaczeniu – gdy pytanie o nie nie pyta, artykuł główny ma pierwszeństwo. */
const SIDE = /\((serial|film|ekranizacja|opera|musical|album|singel|piosenka|gra|komiks|przedsiębiorstwo|klub|statek|okręt|zespół|program)/i

/** Kandydaci na tytuł artykułu wprost z pytania: nazwy z wielkiej litery i cytaty („Lalkę” → Lalka, „Wawel”, „Fe”). */
export function titleGuesses(q: string): string[] {
  const out: string[] = []
  for (const m of q.matchAll(/[„"]([^”"]+)[”"]/g)) out.push(m[1])
  // wielowyrazowe nazwy („Mount Everest”, „Stanów Zjednoczonych”) przed pojedynczymi wyrazami
  for (const m of q.matchAll(/(?<=\s)\p{Lu}[\p{L}-]+(?:\s+\p{Lu}[\p{L}-]+)+/gu)) out.push(m[0])
  const ws = q.match(/[\p{L}\d][\p{L}\d-]*/gu) ?? []
  ws.forEach((w, i) => {
    if (i > 0 && /^\p{Lu}/u.test(w)) out.push(w)
  })
  // biernik l.p. rzeczowników żeńskich („Lalkę”) → mianownik („Lalka”)
  const all = out.flatMap((t) => (/ę$/.test(t) ? [t.replace(/ę$/, 'a'), t] : [t]))
  return [...new Set(all)].filter((t) => t.length >= 2).slice(0, 3)
}

export const MIN_WIKI_COVER = 0.5

type Get = (url: string) => Promise<unknown>
const getJson: Get = async (url) => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Wikipedia ${r.status}`)
  return r.json()
}
const API = 'https://pl.wikipedia.org/w/api.php'
const resolveT = (rs: { from: string; to: string }[] | undefined, t: string) => rs?.find((r) => r.from === t)?.to ?? t
const qs = (o: Record<string, string>) => new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...o }).toString()
export const wikiUrl = (title: string) => `https://pl.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`

/** Szuka w polskiej Wikipedii artykułu i zdania wstępu, które odpowiada na pytanie. undefined = brak potwierdzenia. */
export async function wikiAnswer(q: string, get: Get = getJson): Promise<WikiHit | undefined> {
  const words = contentWords(q)
  if (!words.length) return undefined
  // dwa zapytania: same encje (bez czasowników – „mur berliński”) i całe pytanie; tytuły z obu, encje najpierw
  const v = verbIn(q)
  const reqW = words.filter((w) => !v(strip(w)))
  const search = async (t: string, n = 3) =>
    (((await get(`${API}?${qs({ action: 'query', list: 'search', srsearch: t, srlimit: String(n), srprop: '' })}`)) as { query?: { search?: { title: string }[] } }).query?.search ?? []).map((x) => x.title)
  // trzecie zapytanie: liczebnik porządkowy jako cyfra („pierwszym prezydentem” → „1. prezydent”) – tak piszą wstępy biogramów
  // (rzeczownik po liczebniku w mianowniku: „prezydentem” → „prezydent”, „królem” → „król”, „kobietą” → „kobieta”)
  const oi = reqW.findIndex((w) => ordDigit(strip(w)))
  const ordQ = oi < 0 ? '' : reqW.map((w, i) => (i === oi ? `${ordDigit(strip(w))}.` : i === oi + 1 ? w.replace(/(?<=\p{L}{3})em$/u, '').replace(/ą$/u, 'a') : w)).join(' ')
  const lists = await Promise.all([...[...new Set([reqW.join(' '), words.join(' ')])].filter(Boolean).map((t) => search(t)), ...(ordQ ? [search(ordQ, 5)] : [])])
  // tytuły wprost z pytania („Wawel”, „Lalka”) idą pierwsze – wyszukiwarka pełnotekstowa potrafi je zgubić
  const guesses = titleGuesses(q)
  const titles = [...new Set([...guesses, ...lists.flat()])].slice(0, 10)
  if (!titles.length) return undefined
  const ex = (await get(`${API}?${qs({ action: 'query', prop: 'extracts|pageprops', exintro: '1', explaintext: '1', exlimit: '10', ppprop: 'disambiguation', redirects: '1', titles: titles.join('|') })}`)) as {
    query?: { pages?: { title: string; extract?: string; pageprops?: { disambiguation?: string }; missing?: boolean }[]; redirects?: { from: string; to: string }[]; normalized?: { from: string; to: string }[] }
  }
  const pages = new Map((ex.query?.pages ?? []).map((p) => [p.title, p]))
  // „Fe” → przekierowanie „Żelazo”: szukamy strony pod tytułem docelowym
  for (const n of [...(ex.query?.normalized ?? []), ...(ex.query?.redirects ?? [])]) {
    const p = pages.get(n.to) ?? pages.get(resolveT(ex.query?.redirects, n.to))
    if (p && !pages.has(n.from)) pages.set(n.from, p)
  }
  const seen = new Set<string>()
  // strony, na które prowadzą tytuły z pytania (po przekierowaniu) – artykuły o samej encji
  const guessed = new Set(guesses.map((g) => pages.get(g)?.title).filter((t): t is string => !!t))
  const cands: { hit: WikiHit; score: number; own: boolean; prec: number; n: number }[] = []
  const searchTitles = [...new Set(lists.flat())]
  for (const t of titles) {
    const p = pages.get(t)
    if (!p || p.missing || p.pageprops?.disambiguation !== undefined || !p.extract || seen.has(p.title)) continue
    seen.add(p.title)
    const own = guessed.has(p.title)
    const b = bestSentences(q, p.title, p.extract, own)
    if (!b || b.cover < MIN_WIKI_COVER) continue
    // artykuł, którego tytuł w całości wynika z pytania („Pan Tadeusz”), wygrywa z pobocznym („XIII Księga Pana Tadeusza”);
    // dopowiedzenie w nawiasie („Lalka (powieść)”) nie liczy się do tytułu; adaptacja („(serial …)”), o którą nie pytano, traci;
    // wyższa pozycja w wyszukiwarce wygrywa remis
    const tws = wordsOf(baseTitle(p.title)).filter((w) => !/^\d+$/.test(w) || w.length === 4)
    const prec = tws.length ? tws.filter((w) => stemIn(w.slice(0, 4), wordsOf(q))).length / tws.length : 0
    const sw = p.title.match(SIDE)?.[1]
    const side = sw && !strip(q).includes(strip(sw).slice(0, 5)) ? 0.3 : 0
    // tytuł w całości z pytania i dłuższy jest dokładniejszy („Polska w Unii Europejskiej” > „Polska”)
    const spec = prec === 1 ? 0.1 * Math.min(tws.length, 4) : 0
    // pozycja w wyszukiwarce (tytuły z pytania stoją na 0): najlepsza pozycja w którymkolwiek zapytaniu – nie miejsce
    // na sklejonej liście (3. wynik drugiego zapytania nie jest „5.”, bo pierwsze zapytanie dało 2 inne tytuły)
    const ranks = lists.map((l) => l.indexOf(t)).filter((x) => x >= 0)
    const r = ranks.length ? Math.min(...ranks) : Math.max(0, searchTitles.indexOf(t))
    // zdanie powtarzające frazę pytania wygrywa z tymi samymi słowami rozrzuconymi po zdaniu (Tierieszkowa > Whitson
    // dla „pierwszą kobietą w kosmosie”) – waga 0,3 przeważa kilka pozycji wyszukiwarki, nie przeważa tytułu z pytania
    const score = b.cover + 0.5 * prec + spec - side - r * 0.05 - (b.relaxed ? 0.25 : 0) + 0.3 * b.prox
    cands.push({ hit: { title: p.title, url: wikiUrl(p.title), text: b.text, cover: b.cover }, score, own, prec, n: tws.length })
  }
  // artykuł o samej encji z pytania („Wawel”) wygrywa z artykułem o czymś innym, co ją tylko zawiera („Willa Mały Wawel w Krakowie”) –
  // chyba że inny tytuł w całości pochodzi z pytania i jest od niej dokładniejszy („Polska w Unii Europejskiej” > „Polska”)
  for (const c of cands) {
    if (c.own && !cands.some((o) => !o.own && o.prec === 1 && o.n > c.n)) c.score += 0.3
  }
  cands.sort((a, b) => b.score - a.score)
  return cands[0]?.hit
}
