// Odpowiedzi ze źródłem: czy pytanie jest faktograficzne, etykiety do Weryfikuj i teksty odpowiedzi.
// Zasada: na pytanie o fakt czat odpowiada TYLKO z zatwierdzonej wiedzy grzybni albo ze zdania źródła (Wikidata,
// Wikisłownik, Wikipedia) z linkiem. Bez źródła mówi uczciwie „nie wiem” i proponuje naukę – nie zgaduje.
import type { Reaction } from './register'
import { contentWords } from './wiki'
import { personalQ } from './person'
import type { AIntent, ARegister } from './answers'

const QSTART = /^\s*(czy|co|kto|kogo|komu|kim|czym|gdzie|kiedy|jak|jaki|jaka|jakie|jakiego|jakiej|którym|który|która|które|ile|ilu|dlaczego|czemu|na jakim|w jakim|w którym|z jakiego|what|who|where|when|how|why|which|is|are|does|did)\b/i

export const isQuestion = (q: string) => /\?\s*$/.test(q) || QSTART.test(q)

/** Pytanie o fakt: pytanie z treścią (nie rozmowa), na które mały silnik nie miał pewnej odpowiedzi. */
export function isFactual(q: string, act: string): boolean {
  return ['unknown', 'fact'].includes(act) && isQuestion(q) && !personalQ(q) && contentWords(q).length > 0 && q.length < 300
}

export function intentOf(act: string, q: string, rx?: Reaction): AIntent {
  if (rx) return rx.kind === 'disagree' ? 'niezgoda' : 'emocja'
  if (['teach', 'meaning', 'answer'].includes(act)) return 'nauka'
  if (['greet', 'thanks', 'bye', 'mood', 'name', 'aboutme', 'who'].includes(act)) return 'rozmowa'
  if (act === 'reaction') return 'emocja'
  return isQuestion(q) ? 'pytanie' : 'polecenie'
}

export function registerIn(q: string, rx: Reaction | undefined, regOf: (w: string) => string[] | undefined): ARegister {
  const all = [...(rx?.reg ?? []), ...(q.toLowerCase().match(/[\p{L}]+/gu) ?? []).flatMap((w) => regOf(w) ?? [])]
  for (const r of ['wulgarne', 'obraźliwe', 'ironiczne', 'potoczne'] as const) if (all.includes(r)) return r
  return 'neutralne'
}

export const NO_SOURCE = (en: boolean, hi: string) =>
  en
    ? `I don't know, teach me${hi} – I checked the mycelium's knowledge memory, Wikidata and Wikipedia and found no source that confirms an answer, so I won't guess. Do you know it? Write the answer in your next message – it goes to a vote in Verify.`
    : `Nie wiem, naucz mnie${hi} – sprawdziłam pamięć wiedzy grzybni, Wikidata i Wikipedię i nie znalazłam źródła, które potwierdza odpowiedź, więc nie zgaduję. Znasz odpowiedź? Napisz ją w następnej wiadomości – trafi do głosowania w Weryfikuj.`
