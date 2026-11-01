// Moderacja przez grzybnię – WYŁĄCZNIE zalew/spam i powtarzane nękanie innych osób. Warunek właściciela (brak cenzury):
// nigdy nie usuwamy ani nie blokujemy wiadomości za poglądy, temat, przekleństwa czy wulgarność. Automatycznie (10 min)
// tylko oczywisty zalew; wszystko inne to PROPOZYCJA dla Developera (panel moderacji, dziennik, odwracalne).
import type { ModAction, ModMsg } from './types'

export interface ModConfig {
  floodWindowS: number // okno zalewu
  floodMin: number // ile wiadomości w oknie
  dupMin: number // ile prawie identycznych w oknie
  burstWindowS: number
  burstMin: number // tyle wiadomości w tak krótkim oknie = zalew nawet bez powtórzeń
  harassWindowH: number
  harassMin: number // tyle obelg wobec tej samej osoby = propozycja
  muteMin: number
}
export const MOD_DEFAULT: ModConfig = { floodWindowS: 60, floodMin: 5, dupMin: 4, burstWindowS: 20, burstMin: 7, harassWindowH: 24, harassMin: 3, muteMin: 10 }

/** Klucz prawie-identyczności: małe litery, bez cyfr i interpunkcji, zbite powtórzenia liter. */
export const dupKey = (t: string) => t.toLowerCase().replace(/[^\p{L} ]+/gu, '').replace(/(\p{L})\1+/gu, '$1').replace(/(\p{L}{2,3}?)\1+/gu, '$1').replace(/\s+/g, ' ').trim()

/** Ocena okna wiadomości po nowej wiadomości `last`. Zwraca akcje (bez skutków – wykonuje je baza). */
export function moderate(window: ModMsg[], last: ModMsg, cfg: ModConfig = MOD_DEFAULT): ModAction[] {
  const out: ModAction[] = []
  const mine = window.filter((m) => m.author === last.author && m.at <= last.at && last.at - m.at <= cfg.floodWindowS * 1000)
  const k = dupKey(last.text)
  const dups = mine.filter((m) => dupKey(m.text) === k && k.length > 0)
  const burst = mine.filter((m) => last.at - m.at <= cfg.burstWindowS * 1000)
  if ((mine.length >= cfg.floodMin && dups.length >= cfg.dupMin) || burst.length >= cfg.burstMin) {
    out.push({ kind: 'mute_auto', author: last.author, minutes: cfg.muteMin, reason: dups.length >= cfg.dupMin ? `zalew: ${dups.length} takich samych wiadomości w ${cfg.floodWindowS} s` : `zalew: ${burst.length} wiadomości w ${cfg.burstWindowS} s`, evidence: (dups.length >= cfg.dupMin ? dups : burst).map((m) => m.id) })
    out.push({ kind: 'warn', author: last.author, text: `@${last.author} zwolnij trochę – to wygląda na zalew czatu. Wyciszam automatycznie na ${cfg.muteMin} min (Developer może to cofnąć). Treść nie ma tu znaczenia, tylko tempo.`, evidence: [last.id] })
    return out
  }
  if (last.u?.acts.includes('obraza_innego') && last.u.toOther) {
    const tgt = last.u.toOther.toLowerCase()
    const hits = window.filter((m) => m.author === last.author && m.u?.acts.includes('obraza_innego') && m.u.toOther?.toLowerCase() === tgt && last.at - m.at <= cfg.harassWindowH * 3600e3)
    if (hits.length === cfg.harassMin) {
      out.push({ kind: 'propose', author: last.author, target: last.u.toOther, minutes: 60, reason: `powtarzane obelgi wobec ${last.u.toOther} (${hits.length} w ${cfg.harassWindowH} h) – do decyzji Developera`, evidence: hits.map((m) => m.id) })
      out.push({ kind: 'warn', author: last.author, text: `@${last.author} to już ${hits.length}. obelga wobec ${last.u.toOther}. Kłócić się wolno, ale nękanie zgłaszam Developerowi do przeglądu (bez automatycznej kary).`, evidence: [last.id] })
    }
  }
  return out
}
