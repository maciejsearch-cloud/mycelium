// Ocena jednej odpowiedzi czatu (czysta funkcja, używana przez spec i testy).
export interface Item {
  id: string
  q: string
  accept?: string[]
  range?: [number, number]
  /** pytanie osobiste: poprawne = uczciwa odpowiedź (którekolwiek wyrażenie) bez linku źródła */
  honest?: string[]
}
export type Verdict = 'correct_source' | 'correct_nosrc' | 'dont_know' | 'wrong' | 'honest'

const DONT_KNOW = /nie wiem|nie jestem pewn|nie znalaz[łl]am|nie mam (polskiej )?definicji|nie znam|i don't know|i am not sure|not sure/i

/** liczby w tekście, także „1 863 056” i „1,86 mln” */
export function nums(t: string): number[] {
  const out: number[] = []
  for (const m of t.matchAll(/(\d{1,3}(?:[\s\u00a0]\d{3})+|\d+(?:[.,]\d+)?)\s*(mln|milion\w*|tys\.?)?/gi)) {
    let v = parseFloat(m[1].replace(/[\s\u00a0]/g, '').replace(',', '.'))
    if (/^mln|^milion/i.test(m[2] ?? '')) v *= 1e6
    else if (/^tys/i.test(m[2] ?? '')) v *= 1e3
    out.push(v)
  }
  return out
}

export function score(it: Item, text: string, sources: string[], links: string[]): Verdict {
  const t = text.toLowerCase()
  // pytanie osobiste: odpowiedź z Wikipedii/Wikidata (link) jest zawsze błędna, nawet gdy pasuje tekstem
  if (it.honest) return !links.length && it.honest.some((a) => new RegExp(a, 'i').test(t)) ? 'honest' : 'wrong'
  const ok = it.range ? nums(text).some((v) => v >= it.range![0] && v <= it.range![1]) : (it.accept ?? []).some((a) => new RegExp(a, 'i').test(t))
  // źródło liczy się tylko, gdy UI pokazuje je osobno (link lub lista źródeł) – „Źródło:” wpisane przez sam model nie wystarcza
  const hasSrc = links.length > 0 || sources.some((s) => !/model \(nie słownik\)|model \(not dictionary\)|niezweryfikowane|unverified/i.test(s))
  if (ok) return hasSrc ? 'correct_source' : 'correct_nosrc'
  if (DONT_KNOW.test(text)) return 'dont_know'
  return 'wrong'
}
