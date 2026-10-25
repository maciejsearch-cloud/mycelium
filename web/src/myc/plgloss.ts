// Definicje z polskiego Wikisłownika (pl.wiktionary.org, CC BY-SA): sekcja „język polski”, pierwsze znaczenie
// podstawowe – pomijamy znaczenia potoczne, slangowe, przenośne, dawne, gwarowe itp. Czysty kod (testy w Node).

/** Kwalifikatory znaczeń, których nie podajemy jako pierwszej definicji. */
const SKIP = /\{\{(pot|posp|slang|środ|żart|wulg|obraź|pogard|przen|daw|przest|gw|reg|książk|poet|iron|zdrobn|zgrub|euf|neol|rzad|lekcew|ekspr|dziec|młodz|internet|hist)\b/i

/** Wikitekst → zwykły tekst: linki [[a|b]] → b, szablony usunięte, kursywa zdjęta. */
export function cleanWiki(s: string): string {
  return s
    .replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/g, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\{\{zob\|([^}|]*)[^}]*\}\}/g, 'zob. $1')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/''+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,;:.\s]+|[,;:\s]+$/g, '')
}

export interface PlSense {
  /** numer znaczenia, np. 1.1 */
  n: string
  /** część mowy z nagłówka, np. „rzeczownik, rodzaj męskozwierzęcy” */
  pos: string
  text: string
  skipped: boolean
}

/** Znaczenia polskie z wikitekstu strony (tylko sekcja {{język polski}}). */
export function plSenses(wikitext: string): PlSense[] {
  const sec = /==\s*[^=\n]*\(\{\{język polski\}\}\)\s*==([\s\S]*?)(?=\n==\s*[^=]|$)/.exec(wikitext)?.[1]
  if (!sec) return []
  const zn = /\{\{znaczenia\}\}([\s\S]*?)(?=\n\{\{[a-ząćęłńóśźż ]+\}\}\s*\n|$)/.exec(sec)?.[1] ?? ''
  const out: PlSense[] = []
  let pos = ''
  for (const line of zn.split('\n')) {
    const h = /^''(.+)''\s*$/.exec(line.trim())
    if (h) {
      pos = cleanWiki(h[1])
      continue
    }
    const m = /^:\s*\((\d+\.\d+)\)\s*(.+)$/.exec(line.trim())
    if (!m) continue
    const text = cleanWiki(m[2])
    if (text) out.push({ n: m[1], pos, text, skipped: SKIP.test(m[2]) })
  }
  return out
}

/** Znaczenie podstawowe: pierwsze bez kwalifikatora potocznego/slangowego; najpierw rzeczowniki. */
export function primarySense(ss: PlSense[]): PlSense | undefined {
  const ok = ss.filter((s) => !s.skipped && !/^zob\./.test(s.text))
  return ok.find((s) => /rzeczownik/.test(s.pos)) ?? ok[0]
}

/** Pobiera definicję z pl.wiktionary (bez błędów 404: API parse zwraca 200 z polem error). */
export async function plGloss(word: string): Promise<{ gloss: string; sense: string; pos: string } | undefined> {
  for (const w of [...new Set([word, word.toLowerCase()])]) {
    const r = await fetch(`https://pl.wiktionary.org/w/api.php?action=parse&format=json&formatversion=2&origin=*&redirects=1&prop=wikitext&page=${encodeURIComponent(w)}`)
    if (!r.ok) continue
    const d = (await r.json()) as { parse?: { wikitext?: string } }
    const s = primarySense(plSenses(d.parse?.wikitext ?? ''))
    if (s) return { gloss: s.text, sense: s.n, pos: s.pos }
  }
  return undefined
}

export interface Definition {
  gloss: string
  lang: 'pl' | 'en'
  source: string
}
/** Język pytania o definicję: angielskie „what is / define / meaning of”, inaczej polski. */
export const askLang = (q: string): 'pl' | 'en' => (/^\s*(what|define|meaning)\b/i.test(q) ? 'en' : 'pl')

/** Definicja w języku pytania: po polsku najpierw polski Wikisłownik (znaczenie podstawowe), potem angielski jako zapas. */
export async function defineFor(word: string, lang: 'pl' | 'en', enGloss: (w: string, l: 'en' | 'pl' | '') => Promise<string>): Promise<Definition | undefined> {
  if (lang === 'pl') {
    const p = await plGloss(word).catch(() => undefined)
    if (p) return { gloss: p.gloss, lang: 'pl', source: `Wikisłownik, znaczenie ${p.sense}${p.pos ? ` (${p.pos.split(',')[0]})` : ''}` }
  }
  const e = await enGloss(word, 'en').catch(() => '')
  return e ? { gloss: e, lang: 'en', source: 'Wiktionary (en)' } : undefined
}
