// Zadanie węzła przeglądarkowego w trakcie sesji: „strzępki”.
// 1) pewne odpowiedzi grzybni (konsensus ≥ 0,9) → strzępki (baza zlicza potwierdzenia z różnych węzłów),
// 2) gdy model MiniLM jest włączony: osadzenia nazw pojęć → łącza „similar” (cos ≥ 0,86) między różnymi pojęciami.
import { brain } from './brain'
import { truth } from './consensus'
import { addFrags, type NewFrag, type NewLink } from './frags'
import { neural } from './neural'
import { session } from './session'
import { ids, SB_KEY, SB_URL } from './store'

const EVERY = 3 * 60_000

class FragJob {
  private timer?: ReturnType<typeof setInterval>
  private offset = 0
  last?: { at: string; frags: number; links: number; conflicts: number }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), EVERY)
    setTimeout(() => void this.tick(), 20_000)
  }

  private async tick() {
    if (!session.running || !brain.qa) return
    const out = { frags: 0, links: 0, conflicts: 0 }
    const add = (r: { frags: number; links: number; conflicts: number }) => {
      out.frags += r.frags
      out.links += r.links
      out.conflicts += r.conflicts
    }
    // 1) konsensus → strzępki (słowa i fakty)
    const lex = brain.lex
    const fr: NewFrag[] = []
    const ln: NewLink[] = []
    if (lex) {
      const qs = lex.questions
      for (let i = 0; i < qs.length && fr.length < 120; i++) {
        const q = qs[(this.offset + i) % qs.length]
        for (let j = 0; j < lex.taxonomy.length; j++) {
          const t = truth(brain.cons, `${q.id}c${String(j).padStart(3, '0')}`)
          if (t && t[0] === 'tak' && t[1] >= 0.9) {
            const f: NewFrag = { layer: 0, subj: q.word, rel: 'jest', obj: lex.taxonomy[j].pl, lang: q.lang === 'pl' ? 'pl' : 'en', source: 'consensus', ref: `${q.id}c${String(j).padStart(3, '0')}`, hint: t[1] }
            const c: NewFrag = { layer: 1, subj: q.word, rel: 'pojecie', obj: '', lang: f.lang, source: 'link', hint: t[1] }
            fr.push(f, c)
            ln.push({ src: f, dst: c, kind: 'part_of', w: t[1] })
          }
        }
      }
      this.offset = (this.offset + 120) % Math.max(1, qs.length)
    }
    if (fr.length) add(await addFrags(fr, ln).catch(() => ({ frags: 0, links: 0, conflicts: 0 })))
    // 2) MiniLM: podobne pojęcia
    if (neural.status === 'ready') {
      const r = await fetch(`${SB_URL}/rest/v1/myc_frags?select=subj,lang&room=eq.main&layer=eq.1&order=id.desc&limit=64&offset=${(Date.now() / EVERY) % 20 | 0}`, { headers: { apikey: SB_KEY } }).catch(() => undefined)
      const cs = r?.ok ? ((await r.json()) as { subj: string; lang: string }[]) : []
      const E = await neural.embed(cs.map((c) => c.subj)).catch(() => [] as Float32Array[])
      const links: NewLink[] = []
      for (let i = 0; i < E.length; i++)
        for (let j = i + 1; j < E.length; j++) {
          if (cs[i].subj.toLowerCase() === cs[j].subj.toLowerCase()) continue
          const s = E[i].reduce((a, v, k) => a + v * E[j][k], 0)
          if (s >= 0.86) links.push({ src: { layer: 1, subj: cs[i].subj, rel: 'pojecie', obj: '' }, dst: { layer: 1, subj: cs[j].subj, rel: 'pojecie', obj: '' }, kind: 'similar', w: Math.min(1, s) })
        }
      if (links.length) add(await addFrags([], links.slice(0, 200)).catch(() => ({ frags: 0, links: 0, conflicts: 0 })))
    }
    this.last = { at: new Date().toISOString(), ...out }
    if (out.frags || out.links) brain.store.add('myc_growth', { node_id: ids.node, kind: 'browser', agent: 'strzępki', event: 'action', detail: { what: 'fragments', ...out } })
  }
}

export const fragJob = new FragJob()
