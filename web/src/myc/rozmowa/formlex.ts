// Słownik form dla rozmówcy na bazie leksykonu Morfeusza 2 / SGJP z przeglądarki (morf-lfg.json.gz): analiza formy
// i generowanie formy lematu o danym tagu (np. „nudzić” + 'fin:sg:sec' → „nudzisz”). Indeks odwrotny budowany raz, leniwie.
import type { MorfLex } from '../morf'
import type { FormLex } from './types'

export function formLex(lex: MorfLex, lexAnalyses: (lex: MorfLex, form: string) => [string, string][]): FormLex {
  let rev: Map<string, string> | undefined
  return {
    analyses: (form) => lexAnalyses(lex, form),
    generate(lemma, tagPrefix) {
      if (!rev) {
        rev = new Map()
        for (const f of Object.keys(lex.forms)) for (const [l, t] of lexAnalyses(lex, f)) {
          const parts = t.split(':')
          for (let k = 1; k <= parts.length; k++) {
            const key = l + '\u0000' + parts.slice(0, k).join(':')
            if (!rev.has(key)) rev.set(key, f)
          }
        }
      }
      return rev.get(lemma + '\u0000' + tagPrefix)
    },
  }
}
