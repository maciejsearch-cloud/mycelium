// Modele neuronowe grzybni w interfejsie (na żądanie, ~140 MB pobrania przy pierwszym użyciu):
// intencje (MiniLM-L6 + MLP z ostatniej wersji globalnej), kategorie słów (MiniLM-L12 wielojęzyczny + MLP + kNN)
// i wyszukiwanie semantyczne faktów (kosinus osadzeń L12) łączone z BM25 w Rozmowie.
import { useSyncExternalStore } from 'react'
import { archOf, type DataMeta } from '../compute/specs'
import { pathOf, type Cat } from './lexicon'
import { SB_KEY, SB_URL } from './store'

type Status = 'off' | 'loading' | 'ready' | 'error'
type Row = {
  model: string
  version: number
  path: string
  acc: number
  meta: { arch?: { id: string } | string }
}
const LSK = 'myc.neural'
const WORD_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'

/** Definicja z angielskiego Wikisłownika (jak scripts/fetch_glosses.py: do 2 definicji, najpierw rzeczownik). */
export async function glossFor(word: string, lang: 'en' | 'pl' | ''): Promise<string> {
  try {
    // najpierw sprawdź, czy hasło istnieje (API akcji zwraca 200 także dla braku) – bez błędów 404 w konsoli
    const ex = await fetch(`https://en.wiktionary.org/w/api.php?action=query&format=json&formatversion=2&origin=*&titles=${encodeURIComponent(word)}`)
    if (!ex.ok) return ''
    const pg = ((await ex.json()) as { query?: { pages?: { missing?: boolean }[] } }).query?.pages?.[0]
    if (!pg || pg.missing) return ''
    const r = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`)
    if (!r.ok) return ''
    const d = (await r.json()) as Record<string, { partOfSpeech?: string; definitions?: { definition?: string }[] }[]>
    const keys = lang === 'en' ? ['en'] : lang === 'pl' ? ['pl', 'other'] : ['en', 'pl', 'other']
    for (const nounOnly of [true, false]) {
      const out: string[] = []
      for (const k of keys)
        for (const e of d[k] ?? []) {
          if (nounOnly && e.partOfSpeech !== 'Noun') continue
          for (const df of e.definitions ?? []) {
            const t = (df.definition ?? '')
              .replace(/<[^>]+>/g, '')
              .trim()
              .replace(/\s+/g, ' ')
            if (t) out.push(t.slice(0, 160))
          }
        }
      if (out.length) return out.slice(0, 2).join('; ')
    }
  } catch {
    /* brak sieci – bez definicji */
  }
  return ''
}

class Neural {
  status: Status = 'off'
  error = ''
  progress = 0
  versions: Partial<Record<'intent' | 'words', { version: number; acc: number }>> = {}
  private w?: Worker
  private rid = 0
  private wait = new Map<number, [(v: unknown) => void, (e: Error) => void]>()
  private intentLabels: string[] = []
  private facts?: { key: string; E: Float32Array[]; ids: string[] }
  private v = 0
  private subs = new Set<() => void>()
  subscribe = (f: () => void) => (this.subs.add(f), () => void this.subs.delete(f))
  getVersion = () => this.v
  private emit() {
    this.v++
    for (const f of this.subs) f()
  }
  get wanted() {
    return localStorage.getItem(LSK) === '1'
  }
  private call<T>(op: string, a: Record<string, unknown>): Promise<T> {
    const rid = ++this.rid
    return new Promise<T>((res, rej) => {
      this.wait.set(rid, [res as (v: unknown) => void, rej])
      this.w!.postMessage({ rid, op, ...a })
    })
  }
  /** Pobieranie modeli bywa przerywane – ponawiamy (pliki już pobrane zostają w pamięci podręcznej przeglądarki). */
  private async retry<T>(f: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await f()
      } catch (e) {
        if (i >= 3) throw e
        await new Promise((r) => setTimeout(r, 1500 * 2 ** i))
      }
    }
  }
  /** Włącz (zgoda użytkownika na pobranie). Ładuje ostatnie wersje zgodne z architekturą danych tej strony. */
  async enable(): Promise<void> {
    if (this.status === 'loading' || this.status === 'ready') return
    localStorage.setItem(LSK, '1')
    this.status = 'loading'
    this.error = ''
    this.emit()
    try {
      this.w ??= new Worker(new URL('./neural.worker.ts', import.meta.url), {
        type: 'module',
      })
      this.w.onmessage = (e: MessageEvent) => {
        const d = e.data
        if (d.type === 'progress') {
          this.progress = d.total ? d.loaded / d.total : 0
          this.emit()
          return
        }
        const p = this.wait.get(d.rid)
        if (!p) return
        this.wait.delete(d.rid)
        if (d.ok) p[0](d.out)
        else p[1](new Error(d.error))
      }
      const md = (await (await fetch(`${import.meta.env.BASE_URL}data/ml/meta.json`)).json()) as Record<string, DataMeta>
      const r = await fetch(`${SB_URL}/rest/v1/myc_models?select=model,version,path,acc,meta&model=in.(intent,words)&order=version.desc&limit=60`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } })
      if (!r.ok) throw new Error(`myc_models: HTTP ${r.status}`)
      const rows = (await r.json()) as Row[]
      this.intentLabels = (md.intent as DataMeta & { labels?: string[] }).labels ?? []
      for (const m of ['intent', 'words'] as const) {
        const row = rows.find((x) => x.model === m && archOf(x.meta) === archOf(md[m]))
        if (!row) continue
        const url = `${SB_URL}/storage/v1/object/public/myc-models/${row.path}`
        await this.retry(() => this.call('load', { model: m, version: row.version, url }))
        this.versions[m] = { version: row.version, acc: row.acc }
      }
      // osadzenia do wyszukiwania (ten sam model co słowa; ładowany zawsze)
      await this.retry(() => this.call('embed', { model: WORD_MODEL, texts: ['ok'] }))
      this.status = 'ready'
    } catch (e) {
      this.status = 'error'
      this.error = (e as Error).message
    }
    this.emit()
  }
  async intent(text: string): Promise<{ label: string; conf: number } | undefined> {
    const labels = this.intentLabels
    if (this.status !== 'ready' || !this.versions.intent) return undefined
    const r = await this.call<{ probs: Float32Array[] }>('intent', {
      texts: [text],
    })
    const p = r.probs[0]
    let k = 0
    for (let i = 1; i < p.length; i++) if (p[i] > p[k]) k = i
    return { label: (labels[k] ?? String(k)).replace(/_/g, ' '), conf: p[k] }
  }
  /** Kategoria słowa: rozkład korzeni z modelu + sąsiedzi ze słownika (liście). */
  async word(word: string, lang: 'en' | 'pl' | '') {
    if (this.status !== 'ready' || !this.versions.words) return undefined
    const gloss = await glossFor(word, lang)
    const r = await this.call<{
      probs: Float32Array
      neighbours: { i: number; leaf: number; sim: number }[]
    }>('word', { word, lang, gloss })
    return { ...r, gloss }
  }
  /** Korzeń z modelu, liść z głosowania sąsiadów (ważonego podobieństwem) w obrębie tego korzenia. */
  wordCat(
    tax: Cat[],
    r: {
      probs: Float32Array | number[]
      neighbours: { leaf: number; sim: number }[]
    },
  ) {
    const probs = Array.from(r.probs)
    const order = [...probs.keys()].sort((a, b) => probs[b] - probs[a])
    const root = order[0]
    const votes = new Map<number, number>()
    for (const n of r.neighbours) if (pathOf(tax, n.leaf)[0] === root) votes.set(n.leaf, (votes.get(n.leaf) ?? 0) + Math.max(0, n.sim))
    const tot = [...votes.values()].reduce((a, b) => a + b, 0)
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]
    const leaf = best && best[1] / tot >= 0.5 ? best[0] : root
    return {
      root,
      leaf,
      path: pathOf(tax, leaf),
      conf: probs[root],
      leafShare: best && tot ? best[1] / tot : 0,
      top: order.slice(0, 3).map((i) => [i, probs[i]] as [number, number]),
    }
  }
  /** Osadzenia MiniLM (wielojęzyczne, znormalizowane) – np. do łączenia podobnych pojęć w strzępkach. */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.status !== 'ready' || !texts.length) return []
    return this.call<Float32Array[]>('embed', { model: WORD_MODEL, texts })
  }
  /** Kosinus osadzeń zapytania z faktami (osadzenia faktów liczone raz, w tle). */
  async semantic(q: string, docs: { id: string; text: string }[], k = 5): Promise<{ id: string; sim: number }[]> {
    if (this.status !== 'ready' || !docs.length) return []
    const key = `${docs.length}:${docs[0].id}:${docs[docs.length - 1].id}`
    if (this.facts?.key !== key) {
      const E: Float32Array[] = []
      for (let i = 0; i < docs.length; i += 64)
        E.push(
          ...(await this.call<Float32Array[]>('embed', {
            model: WORD_MODEL,
            texts: docs.slice(i, i + 64).map((d) => d.text),
          })),
        )
      this.facts = { key, E, ids: docs.map((d) => d.id) }
    }
    const [qe] = await this.call<Float32Array[]>('embed', {
      model: WORD_MODEL,
      texts: [q],
    })
    const f = this.facts
    return f.E.map((e, i) => ({
      id: f.ids[i],
      sim: e.reduce((s, v, j) => s + v * qe[j], 0),
    }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, k)
  }
}

export const neural = new Neural()
if (neural.wanted) void neural.enable()
export function useNeural() {
  useSyncExternalStore(neural.subscribe, neural.getVersion)
  return neural
}
