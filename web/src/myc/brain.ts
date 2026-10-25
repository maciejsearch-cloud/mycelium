// Mózg węzła w przeglądarce: konsensus, modele, kolejka pytań (aktywne uczenie), nauka „teraz”.
import { useEffect, useSyncExternalStore } from 'react'
import { infer, truth, type Consensus } from './consensus'
import { balancedAcc, DEFAULT_CFG, IntentAgent, SensorAgent, type Cfg, type SensorItem } from './models'
import { leafOf, pathName, pathOf, WordAgent, wordQid, type Lexicon, type WordPred } from './lexicon'
import { ids, Store, type UserQ } from './store'
import { decode, imgQid, LETTERS, PERMS, PixelAgent, pool14, ROT, rows196, type Captcha } from './vision'

export const YN = ['tak', 'nie']
export const FACT_CONF = 0.8

export interface QA {
  intent: { labels: string[]; labels_pl: string[]; seed: [string, number][]; test: [string, number][]; questions: { id: string; text: string }[] }
  sensor: { source: string; seed: (SensorItem & { y: number })[]; test: (SensorItem & { y: number })[]; questions: (SensorItem & { id: string; t: string })[] }
  knowledge: { questions: { id: string; pl: string; en: string }[] }
}

/** Pytanie logiczne grzybni z `data/logic/queue.json` (scripts/selfplay_run.py): `human` – rozstrzygają ludzie,
 *  `control` – odpowiedź zna program (jest tylko w myc_gold, nie w przeglądarce), z nich liczy się zaufanie. */
export interface LogicQ {
  id: string
  kind: string
  q: string
  options: { v: string; label: string }[]
  why?: string
  level?: number
  model?: { p: Record<string, number>; margin: number }
  model_acc?: number | null
}
export interface LogicQueue {
  generated_at: string
  model: string
  source: string
  human: LogicQ[]
  control: LogicQ[]
  per_category?: Record<string, { n: number; correct: number; acc: number; baseline?: number }>
}

/** Zadanie wielokierunkowe z `data/zadania/queue.json` (scripts/zadania_run.py): matematyczne (m…), analityczne (a…),
 *  wzrokowe (v…). Każde jest sprawdzane programem – poprawna odpowiedź jest tylko w myc_gold, nie w przeglądarce. */
export interface ZadQ {
  id: string
  type: 'matematyczne' | 'analityczne' | 'wzrokowe'
  kind: string
  level: number
  q: string
  options: { v: string; label: string }[]
  px?: string
  model?: { margin?: number; pmax?: number }
  model_acc?: number
  sources?: string[]
}
export interface ZadModel {
  name: string
  n: number
  correct: number
  acc: number | null
  baseline: number
  per_kind?: Record<string, { n: number; correct: number; acc: number | null; baseline: number }>
}
export interface ZadQueue {
  generated_at: string
  source: string
  types: Record<string, { n: number; model: ZadModel | null }>
  items: ZadQ[]
}

/** Typy zadań w Ucz AI (chipy). `mieszane` = wszystkie naraz. */
export const TASK_TYPES = ['mieszane', 'logiczne', 'matematyczne', 'wzrokowe', 'analityczne', 'językowe', 'inne'] as const
export type TaskType = (typeof TASK_TYPES)[number]

type QBase = { votes?: number; prio?: number }
export type Question = QBase &
  (
    | { id: string; kind: 'intent'; text: string; guess?: string; conf: number }
    | { id: string; kind: 'sensor'; item: SensorItem; t: string; guess?: string; conf: number }
    | { id: string; kind: 'knowledge'; pl: string; en: string; conf: number }
    | { id: string; kind: 'user'; q: UserQ; conf: number }
    | { id: string; kind: 'word'; word: string; lang: string; pred: WordPred; conf: number }
    | { id: string; kind: 'logic'; item: LogicQ; control: boolean; conf: number }
    | { id: string; kind: 'zadanie'; item: ZadQ; control: true; conf: number }
    | { id: string; kind: 'image'; img: string; cls: number; conf: number }
  )

/** Typ zadania (chip w Ucz AI) dla pytania z kolejki. */
export function typeOf(q: Question): Exclude<TaskType, 'mieszane'> {
  if (q.kind === 'logic') return 'logiczne'
  if (q.kind === 'zadanie') return q.item.type
  if (q.kind === 'image') return 'wzrokowe'
  if (q.kind === 'word' || (q.kind === 'user' && q.q.kind === 'word')) return 'językowe'
  return 'inne'
}

/** Typ zadania z identyfikatora pytania – klucze jak w myc_gold_by_type (l, m, a, v, c?, w…). */
export function typeOfQid(kind: string): Exclude<TaskType, 'mieszane'> {
  if (kind === 'l') return 'logiczne'
  if (kind === 'm') return 'matematyczne'
  if (kind === 'a') return 'analityczne'
  if (kind === 'v' || kind === 'cg' || kind === 'cb' || kind === 'ct' || kind === 'cr') return 'wzrokowe'
  if (kind === 'w' || kind === 'cm') return 'językowe'
  return 'inne'
}

/** Co które pytanie w kolejce jest kontrolne (odpowiedź zna program). */
export const CONTROL_EVERY = 5

/** Wyniki na stałych zbiorach testowych w przeglądarce (qa.json). `n` = liczba pytań testowych w każdym teście.
 *  intent = trafność, sensor = trafność zbalansowana, knowledge = odsetek pytań-faktów potwierdzonych przez ludzi (konsensus ≥ FACT_CONF),
 *  czyli pokrycie wiedzy, nie trafność modelu. Bez sztucznych skal (dawny wskaźnik „iq” usunięty, docs/data-provenance.md). */
export interface Scores {
  intent: number
  sensor: number
  knowledge: number
  n: { intent: number; sensor: number; knowledge: number }
}
export interface TrainResult {
  before: Scores
  after: Scores
  labels: { intent: number; sensor: number }
  at: string
}


const userOptions = (q: UserQ, labels: string[], cats: string[]) => (q.kind === 'example' ? labels : q.kind === 'word' ? cats : YN)

class Brain {
  store = new Store()
  qa?: QA
  cfg: Cfg = structuredClone(DEFAULT_CFG)
  cons: Consensus = { posterior: {}, trust: {}, agreement: {}, answersPerNode: {} }
  intent?: IntentAgent
  sensor?: SensorAgent
  lex?: Lexicon
  cap?: Captcha & { img: Map<string, Uint8Array>; x: Map<string, Float32Array> }
  vis?: { fashion: PixelAgent; letters: PixelAgent; acc: { fashion: number; letters: number; fashion_seed: number; letters_seed: number }; labels: { fashion: number; letters: number }; at: string }
  private capP?: Promise<void>
  logic?: LogicQueue
  private logicP?: Promise<void>
  zad?: ZadQueue
  private zadP?: Promise<void>
  words?: WordAgent
  scores?: Scores
  /** czy `scores` policzono na danych z bazy (po synchronizacji), a nie tylko na lokalnym cache/zestawie startowym */
  scoresSynced = false
  scoresAt?: string
  last?: TrainResult
  ready = false
  version = 0
  private subs = new Set<() => void>()
  private started = false

  subscribe = (f: () => void) => {
    this.subs.add(f)
    return () => this.subs.delete(f)
  }
  getVersion = () => this.version
  emit() {
    this.version++
    for (const f of this.subs) f()
  }

  options(): Record<string, string[]> {
    const qa = this.qa!
    const o: Record<string, string[]> = {}
    for (const q of qa.intent.questions) o[q.id] = qa.intent.labels
    for (const q of qa.sensor.questions) o[q.id] = YN
    for (const q of qa.knowledge.questions) o[q.id] = YN
    const cats = this.lex?.taxonomy.map((c) => c.id) ?? []
    for (const q of this.store.data.userQs) o[q.id] = userOptions(q, qa.intent.labels, cats)
    if (this.lex) for (const q of this.lex.questions) for (let j = 0; j < cats.length; j++) o[wordQid(q.id, j)] = YN
    const cap = this.cap
    if (cap) {
      for (const q of cap.fashion.pool) for (let k = 0; k < 10; k++) o[imgQid(q.id, k)] = YN
      for (const q of cap.fashion.rotate) o[q.id] = [...ROT]
      for (const q of cap.letters.pool) o[q.id] = LETTERS
      for (const q of cap.order) o[q.id] = PERMS
      for (const q of cap.pairs) o[q.id] = YN
    }
    if (this.logic) for (const q of [...this.logic.human, ...this.logic.control]) o[q.id] = q.options.map((x) => x.v)
    if (this.zad) for (const q of this.zad.items) o[q.id] = q.options.map((x) => x.v)
    return o
  }

  async start() {
    if (this.started) return
    this.started = true
    const [r, lx] = await Promise.all([fetch(`${import.meta.env.BASE_URL}data/qa.json`), fetch(`${import.meta.env.BASE_URL}data/lexicon.json`).catch(() => undefined)])
    this.qa = (await r.json()) as QA
    this.lex = lx?.ok ? ((await lx.json()) as Lexicon) : undefined
    this.cfg = latestCfg(this.store.data.growth) ?? this.cfg
    this.recompute()
    this.train() // od razu: model startowy na danych z cache
    this.ready = true
    this.emit()
    await this.sync()
    // wyniki „na żywo” liczone ponownie na danych z bazy (inaczej pokazywałyby model startowy bez wiedzy od ludzi)
    if (this.store.online) {
      this.train()
      this.emit()
    }
    this.join(new URLSearchParams(location.search).has('join') ? 'invite' : 'direct', new URLSearchParams(location.search).get('ref') ?? undefined)
    if (this.autonomy.on) this.setAutonomy(true)
    setInterval(() => void this.sync(), 15_000)
    addEventListener('online', () => void this.sync())
  }

  async sync() {
    await this.store.refresh()
    const c = latestCfg(this.store.data.growth)
    if (c) this.cfg = c
    this.recompute()
    this.emit()
  }

  recompute() {
    const d = this.store.data
    const opts = this.options()
    this.cons = infer(d.answers, opts, d.gold)
    // złote etykiety z zakładki Weryfikuj nadpisują konsensus → od razu stają się danymi treningowymi
    for (const l of d.labels ?? []) {
      const o = opts[l.item_ref]
      if (!o || !l.truth || !o.includes(l.truth) || l.item_type === 'chat' || l.item_type === 'fragment' || l.item_type === 'model') continue
      const w = Math.max(0.5, Math.min(0.999, l.weight === 1 ? 0.999 : l.weight))
      this.cons.posterior[l.item_ref] = Object.fromEntries(o.map((x) => [x, x === l.truth ? w : (1 - w) / Math.max(1, o.length - 1)]))
    }
  }

  /** Etykiety z konsensusu (≥ min_conf) dla obu nisz modelowych + przykłady nauczycieli. */
  labelled() {
    const qa = this.qa!
    const texts: [string, number][] = []
    const items: [SensorItem, number][] = []
    for (const q of qa.intent.questions) {
      const t = truth(this.cons, q.id)
      if (t && t[1] >= this.cfg.intent.min_conf) texts.push([q.text, qa.intent.labels.indexOf(t[0])])
    }
    for (const q of this.store.data.userQs)
      if (q.kind === 'example') {
        const t = truth(this.cons, q.id)
        if (t && t[1] >= this.cfg.intent.min_conf) texts.push([q.text, qa.intent.labels.indexOf(t[0])])
      }
    for (const q of qa.sensor.questions) {
      const t = truth(this.cons, q.id)
      if (t && t[1] >= this.cfg.sensor.min_conf) items.push([q, t[0] === 'tak' ? 1 : 0])
    }
    return { texts, items }
  }

  /** Słowa z konsensusu: pula pytań (kategorie „tak” ≥ min_conf) + słowa od nauczycieli. */
  labelledWords(): [string, number][] {
    const lex = this.lex
    if (!lex) return []
    const out: [string, number][] = []
    const min = this.cfg.intent.min_conf
    for (const q of lex.questions) {
      const yes: number[] = []
      lex.taxonomy.forEach((_, j) => {
        const t = truth(this.cons, wordQid(q.id, j))
        if (t && t[0] === 'tak' && t[1] >= min) yes.push(j)
      })
      if (yes.length) out.push([q.word, leafOf(lex.taxonomy, yes)])
    }
    for (const q of this.store.data.userQs)
      if (q.kind === 'word') {
        const t = truth(this.cons, q.id)
        const j = lex.taxonomy.findIndex((c) => c.id === t?.[0])
        if (t && j >= 0 && t[1] >= min) out.push([q.text, j])
      }
    return out
  }

  trainWords() {
    if (this.lex) this.words = new WordAgent(this.lex, this.labelledWords())
  }

  /** Zadania captcha: dane ładowane dopiero na stronie „Zadania” (~0,5 MB gzip). */
  loadCaptcha(): Promise<void> {
    this.capP ??= (async () => {
      const r = await fetch(`${import.meta.env.BASE_URL}data/captcha.json`)
      const c = (await r.json()) as Captcha
      const img = new Map<string, Uint8Array>()
      const x = new Map<string, Float32Array>()
      for (const q of [...c.fashion.pool, ...c.fashion.rotate, ...c.letters.pool]) {
        const a = decode(q.px)
        img.set(q.id, a)
        x.set(q.id, Float32Array.from(pool14(a), (v) => v / 255))
      }
      this.cap = { ...c, img, x }
      if (this.qa) this.recompute() // inaczej start() przeliczy po wczytaniu qa.json
      this.trainVision()
      this.emit()
    })()
    return this.capP
  }

  /** Zadania wielokierunkowe (matematyczne, analityczne, wzrokowe); brak pliku = po prostu brak tych zadań. */
  loadZadania(): Promise<void> {
    this.zadP ??= (async () => {
      try {
        const r = await fetch(`${import.meta.env.BASE_URL}data/zadania/queue.json`)
        if (!r.ok) return
        this.zad = (await r.json()) as ZadQueue
        if (this.qa) this.recompute()
        this.emit()
      } catch {
        /* brak pliku – brak zadań */
      }
    })()
    return this.zadP
  }

  /** Obrazy do etykietowania: dane captcha + model startowy w przeglądarce (bez zapisu punktu historii). */
  async loadVision(): Promise<void> {
    await this.loadCaptcha()
    if (!this.vis && this.cap) {
      this.trainVision()
      this.emit()
    }
  }

  /** Pytania logiczne grzybni (dla ludzi + kontrolne); brak pliku = po prostu brak tych pytań. */
  loadLogic(): Promise<void> {
    this.logicP ??= (async () => {
      try {
        const r = await fetch(`${import.meta.env.BASE_URL}data/logic/queue.json`)
        if (!r.ok) return
        this.logic = (await r.json()) as LogicQueue
        if (this.qa) this.recompute()
        this.emit()
      } catch {
        /* offline / brak pliku */
      }
    })()
    return this.logicP
  }

  /** Etykiety obrazów i liter z konsensusu (obraz: dokładnie jedna klasa „tak” ≥ min_conf). */
  labelledVision() {
    const cap = this.cap!
    const min = this.cfg.intent.min_conf
    const fashion: [Float32Array, number][] = []
    const letters: [Float32Array, number][] = []
    for (const q of cap.fashion.pool) {
      const yes = [...Array(10).keys()].filter((k) => {
        const t = truth(this.cons, imgQid(q.id, k))
        return t && t[0] === 'tak' && t[1] >= min
      })
      if (yes.length === 1) fashion.push([cap.x.get(q.id)!, yes[0]])
    }
    for (const q of cap.letters.pool) {
      const t = truth(this.cons, q.id)
      if (t && t[1] >= min) letters.push([cap.x.get(q.id)!, LETTERS.indexOf(t[0])])
    }
    return { fashion, letters }
  }

  /** Trening modeli obrazów: tylko start vs start + etykiety od ludzi; ocena na odłożonym teście. */
  trainVision() {
    const cap = this.cap
    if (!cap) return undefined
    const fs = rows196(cap.fashion.seed)
    const ft = rows196(cap.fashion.test)
    const ls = rows196(cap.letters.seed)
    const lt = rows196(cap.letters.test)
    const lab = this.labelledVision()
    const f0 = new PixelAgent(10).fit(fs, cap.fashion.seed.y)
    const l0 = new PixelAgent(26).fit(ls, cap.letters.seed.y)
    const fashion = lab.fashion.length ? new PixelAgent(10).fit([...fs, ...lab.fashion.map(([x]) => x)], [...cap.fashion.seed.y, ...lab.fashion.map(([, y]) => y)]) : f0
    const letters = lab.letters.length ? new PixelAgent(26).fit([...ls, ...lab.letters.map(([x]) => x)], [...cap.letters.seed.y, ...lab.letters.map(([, y]) => y)]) : l0
    this.vis = {
      fashion,
      letters,
      acc: { fashion: fashion.acc(ft, cap.fashion.test.y), letters: letters.acc(lt, cap.letters.test.y), fashion_seed: f0.acc(ft, cap.fashion.test.y), letters_seed: l0.acc(lt, cap.letters.test.y) },
      labels: { fashion: lab.fashion.length, letters: lab.letters.length },
      at: new Date().toISOString(),
    }
    return this.vis
  }

  /** „Ucz teraz” dla obrazów: trening + punkt historii (prawdziwy pomiar). */
  async learnVision() {
    await this.sync()
    const v = this.trainVision()
    if (!v) return undefined
    const r = (x: number) => Math.round(x * 10000) / 10000
    this.store.add('myc_node_stats', {
      node_id: ids.node,
      kind: 'browser',
      label: 'zadania',
      acc: { fashion: r(v.acc.fashion), fashion_before: r(v.acc.fashion_seed), letters: r(v.acc.letters), letters_before: r(v.acc.letters_seed), labels: v.labels.fashion + v.labels.letters },
      n_answers: this.store.data.answers.length,
    })
    this.emit()
    return v
  }

  /** Wiele odpowiedzi naraz (siatka, kosze, dopasowanie par…). */
  answerMany(rows: [string, string][]) {
    for (const [qid, answer] of rows) this.store.add('myc_answers', { question_id: qid, node_id: ids.node, contributor_id: ids.contributor, answer, kind: 'browser' })
    this.recompute()
    this.emit()
  }

  /** Zapis odpowiedzi z zawężania: każda pokazana kategoria to osobne pytanie tak/nie. */
  answerWord(qid: string, shown: number[], yes: number[]) {
    for (const j of shown) this.store.add('myc_answers', { question_id: wordQid(qid, j), node_id: ids.node, contributor_id: ids.contributor, answer: yes.includes(j) ? 'tak' : 'nie', kind: 'browser' })
    this.recompute()
    this.emit()
  }

  /** Opis pytania o słowo (w#####c###) lub słowa od nauczyciela, inaczej undefined. */
  wordText(id: string, en: boolean): string | undefined {
    const lex = this.lex
    if (!lex) return undefined
    const m = /^(w[0-9]{5})c([0-9]{3})$/.exec(id)
    if (m) {
      const q = lex.questions.find((x) => x.id === m[1])
      const c = lex.taxonomy[Number(m[2])]
      if (q && c) return en ? `„${q.word}” is a ${c.en.toLowerCase()}?` : `„${q.word}” to ${c.pl.toLowerCase()}?`
    }
    const u = this.store.data.userQs.find((x) => x.id === id && x.kind === 'word')
    if (u) return en ? `word „${u.text}” – category?` : `słowo „${u.text}” – kategoria?`
    return undefined
  }

  /** Słownik w rozmowie: słowa z pytania znalezione w OEWN/plWordNet (+ wydźwięk VADER). */
  wordDocs(q: string, en: boolean): import('./retrieval').Doc[] {
    if (!this.words || !this.lex) return []
    // tylko gdy pytanie dotyczy słowa (inaczej zwykłe słowa zagłuszałyby fakty)
    const ask = /(co to (jest|znaczy)|czym jest|co oznacza|jaka kategoria|kategori|what (is|does)|meaning|categor|słowo|word)/i.test(q) || q.trim().split(/\s+/).length <= 2
    if (!ask) return []
    const tax = this.lex.taxonomy
    const out: import('./retrieval').Doc[] = []
    for (const w of new Set(q.toLowerCase().match(/[\p{L}]{3,}/gu) ?? [])) {
      const path = this.words.dict.get(w)
      const sent = this.words.sentiment(w)
      if (!path && sent === undefined) continue
      const parts = [path ? pathName(tax, pathOf(tax, leafOf(tax, path)), en) : '', sent !== undefined ? `${en ? 'sentiment' : 'wydźwięk'} ${sent > 0 ? '+' : ''}${sent}` : ''].filter(Boolean)
      out.push({ id: `dict:${w}`, text: `${w}: ${parts.join(' · ')}`, truth: 'tak', p: 1, votes: 0, source: en ? 'dictionary' : 'słownik', dict: true })
    }
    return out.slice(0, 3)
  }

  evaluate(intent: IntentAgent, sensor: SensorAgent): Scores {
    const qa = this.qa!
    const pi = intent.proba(qa.intent.test.map(([t]) => t))
    const iAcc = pi.filter((p, i) => argmax(p) === qa.intent.test[i][1]).length / pi.length
    const ps = sensor.proba(qa.sensor.test)
    const sAcc = balancedAcc(qa.sensor.test.map((x) => x.y), ps.map((p) => (p >= this.cfg.sensor.threshold ? 1 : 0)))
    const kq = this.knowledgeIds()
    let k = 0
    for (const id of kq) {
      const t = truth(this.cons, id)
      if (t && t[1] >= FACT_CONF) k += t[1]
    }
    return { intent: iAcc, sensor: sAcc, knowledge: kq.length ? k / kq.length : 0, n: { intent: pi.length, sensor: ps.length, knowledge: kq.length } }
  }

  knowledgeIds() {
    return [...this.qa!.knowledge.questions.map((q) => q.id), ...this.store.data.userQs.filter((q) => q.kind === 'fact' || q.kind === 'qa').map((q) => q.id)]
  }

  fit(cfg: Cfg = this.cfg) {
    const qa = this.qa!
    const { texts, items } = this.labelled()
    const tx = [...qa.intent.seed, ...texts]
    const it = [...qa.sensor.seed.map((x) => [x, x.y] as [SensorItem, number]), ...items]
    const intent = new IntentAgent(cfg.intent, qa.intent.labels.length).fit(tx.map(([t]) => t), tx.map(([, y]) => y))
    const sensor = new SensorAgent(cfg.sensor).fit(it.map(([x]) => x), it.map(([, y]) => y))
    return { intent, sensor, labels: { intent: texts.length, sensor: items.length } }
  }

  train(): TrainResult {
    const before = this.intent && this.sensor ? this.evaluate(this.intent, this.sensor) : undefined
    const { intent, sensor, labels } = this.fit()
    this.intent = intent
    this.sensor = sensor
    this.trainWords()
    const after = this.evaluate(intent, sensor)
    this.scores = after
    this.scoresSynced = this.store.online
    this.scoresAt = new Date().toISOString()
    const res = { before: before ?? after, after, labels, at: new Date().toISOString() }
    return res
  }

  /** „Ucz teraz”: zsynchronizuj, przelicz konsensus, wytrenuj i zapisz punkt historii. */
  async learnNow(): Promise<TrainResult> {
    await this.sync()
    // „przed” = model startowy (tylko dane z zestawu startowego), „po” = z wiedzą od ludzi
    const qa = this.qa!
    const base = {
      intent: new IntentAgent(this.cfg.intent, qa.intent.labels.length).fit(qa.intent.seed.map(([t]) => t), qa.intent.seed.map(([, y]) => y)),
      sensor: new SensorAgent(this.cfg.sensor).fit(qa.sensor.seed, qa.sensor.seed.map((x) => x.y)),
    }
    const before = this.evaluate(base.intent, base.sensor)
    const r = this.train()
    r.before = before
    this.last = r
    const round = (x: number) => Math.round(x * 10000) / 10000
    this.store.add('myc_node_stats', {
      node_id: ids.node,
      kind: 'browser',
      label: 'przegladarka',
      acc: { intent: round(r.after.intent), sensor: round(r.after.sensor), knowledge: round(r.after.knowledge), n_intent: r.after.n.intent, n_sensor: r.after.n.sensor, n_knowledge: r.after.n.knowledge, intent_before: round(before.intent), sensor_before: round(before.sensor), labels: r.labels.intent + r.labels.sensor },
      n_answers: this.store.data.answers.length,
    })
    this.store.add('myc_growth', {
      node_id: ids.node,
      kind: 'browser',
      agent: agentName(ids.node),
      event: 'train',
      detail: { intent_before: round(before.intent), sensor_before: round(before.sensor), intent: round(r.after.intent), sensor: round(r.after.sensor), knowledge: round(r.after.knowledge), labels: r.labels },
      iq: null,
    })
    this.emit()
    return r
  }

  answer(qid: string, answer: string) {
    this.store.add('myc_answers', { question_id: qid, node_id: ids.node, contributor_id: ids.contributor, answer, kind: 'browser' })
    this.recompute()
    this.emit()
  }

  teach(kind: UserQ['kind'], text: string, answer: string): string {
    const id = 'u' + Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('')
    this.store.add('myc_user_questions', { id, kind, text: text.trim().slice(0, 300), answer: answer.slice(0, 200), node_id: ids.node })
    // fakt/QA: autor potwierdza „tak”; przykład: autor podaje etykietę
    this.answer(id, kind === 'example' || kind === 'word' ? answer : 'tak')
    return id
  }

  predictIntent(text: string): { label: number; conf: number; probs: Float64Array } | undefined {
    if (!this.intent) return undefined
    const p = this.intent.proba([text])[0]
    const label = argmax(p)
    return { label, conf: p[label], probs: p }
  }

  mine(): Set<string> {
    return new Set(this.store.data.answers.filter((a) => a.node_id === ids.node).map((a) => a.question_id))
  }

  /** Wyniki na połówkach zbioru testowego: parzyste = walidacja (decyzje), nieparzyste = kontrola (brak regresji). */
  split(intent: IntentAgent, sensor: SensorAgent, cfg: Cfg = this.cfg) {
    const qa = this.qa!
    const pi = intent.proba(qa.intent.test.map(([t]) => t))
    const hit = pi.map((p, i) => argmax(p) === qa.intent.test[i][1])
    const half = <T,>(a: T[], o: number) => a.filter((_, i) => i % 2 === o)
    const mean = (a: boolean[]) => a.filter(Boolean).length / Math.max(1, a.length)
    const k = qa.intent.labels.length
    const perClass = Array.from({ length: k }, (_, c) => mean(hit.filter((_, i) => qa.intent.test[i][1] === c)))
    const ys = qa.sensor.test.map((x) => x.y)
    const ps = sensor.proba(qa.sensor.test).map((p) => (p >= cfg.sensor.threshold ? 1 : 0))
    return {
      intent_val: mean(half(hit, 0)),
      intent_test: mean(half(hit, 1)),
      sensor_val: balancedAcc(half(ys, 0), half(ps, 0)),
      sensor_test: balancedAcc(half(ys, 1), half(ps, 1)),
      perClass,
    }
  }

  growSteps = 0
  /** Jeden krok autonomicznego wzrostu (ciekawość → kandydaci → samoocena → przyjęcie/odrzucenie). */
  growStep(rng: () => number = seededRng(`${ids.node}:${this.growSteps++}`)): GrowthStep {
    if (!this.qa || !this.intent || !this.sensor) throw new Error('not ready')
    const qa = this.qa
    const base = this.split(this.intent, this.sensor)
    const s = this.scores ?? this.evaluate(this.intent, this.sensor)
    // ciekawość: luka + niepewność na pytaniach + świeże etykiety
    const ip = this.intent.proba(qa.intent.questions.map((q) => q.text))
    const ent = ip.reduce((sum, p) => sum - p.reduce((e, v) => e + (v > 0 ? v * Math.log(v) : 0), 0) / Math.log(p.length), 0) / ip.length
    const sp = this.sensor.proba(qa.sensor.questions)
    const sUnc = sp.reduce((sum, p) => sum + (1 - Math.abs(p - 0.5) * 2), 0) / sp.length
    const kIds = this.knowledgeIds()
    const kUnc = kIds.reduce((sum, id) => sum + (1 - (truth(this.cons, id)?.[1] ?? 0)), 0) / Math.max(1, kIds.length)
    const lab = this.labelled()
    const gains = {
      intent: 1 - s.intent + 0.5 * ent + 0.02 * lab.texts.length,
      sensor: 1 - s.sensor + 0.5 * sUnc + 0.02 * lab.items.length,
      knowledge: (1 - s.knowledge) * 0.8 + 0.3 * kUnc,
    }
    const r3 = (x: number) => Math.round(x * 1000) / 1000
    const niche = (Object.keys(gains) as (keyof typeof gains)[]).reduce((a, b) => (gains[a] >= gains[b] ? a : b))
    const mniche: 'intent' | 'sensor' = gains.intent >= gains.sensor ? 'intent' : 'sensor'
    const events: GrowthStep['events'] = [{ event: 'action', detail: { niche, model: mniche, gains: { intent: r3(gains.intent), sensor: r3(gains.sensor), knowledge: r3(gains.knowledge) } } }]
    if (niche === 'knowledge') {
      const ask = [...kIds].sort((a, b) => (truth(this.cons, a)?.[1] ?? 0) - (truth(this.cons, b)?.[1] ?? 0)).slice(0, 3)
      events.push({ event: 'question', detail: { niche: 'knowledge', ask } })
    }
    let best: { gain: number; name: string; cfg: Cfg; sc: ReturnType<Brain['split']>; agents: ReturnType<Brain['fit']> } | undefined
    for (const [name, cfg] of candidates(mniche, this.cfg, base.perClass, rng)) {
      const agents = this.fit(cfg)
      const sc = this.split(agents.intent, agents.sensor, cfg)
      const gain = sc[`${mniche}_val`] - base[`${mniche}_val`]
      if (!best || gain > best.gain) best = { gain, name, cfg, sc, agents }
    }
    const b = best!
    const noRegress = b.sc[`${mniche}_test`] >= base[`${mniche}_test`] - 0.01
    let accepted = false
    if (b.gain > 0.004 && noRegress) {
      this.cfg = b.cfg
      this.intent = b.agents.intent
      this.sensor = b.agents.sensor
      this.scores = this.evaluate(this.intent, this.sensor)
      this.scoresSynced = this.store.online
      this.scoresAt = new Date().toISOString()
      const ev = b.name.startsWith('spawn') ? 'spawn' : b.name.startsWith('prune') ? 'prune' : 'accept'
      events.push({ event: ev, detail: { change: b.name, val_gain: r3(b.gain), config: b.cfg } })
      accepted = true
    } else events.push({ event: 'reject', detail: { change: b.name, val_gain: r3(b.gain), regress: !noRegress } })
    const scores = this.scores ?? s
    for (const e of events) this.store.add('myc_growth', { node_id: ids.node, kind: 'browser', agent: agentName(ids.node), event: e.event, detail: e.detail, iq: null })
    if (accepted) {
      const sc = this.scores!
      const r = (x: number) => Math.round(x * 10000) / 10000
      this.store.add('myc_node_stats', { node_id: ids.node, kind: 'browser', label: 'wzrost', acc: { intent: r(sc.intent), sensor: r(sc.sensor), knowledge: r(sc.knowledge), n_intent: sc.n.intent, n_sensor: sc.n.sensor, n_knowledge: sc.n.knowledge }, n_answers: this.store.data.answers.length })
    }
    this.emit()
    return { niche, mniche, accepted, change: b.name, gain: b.gain, scores, events }
  }

  join(via: string, ref?: string) {
    if (localStorage.getItem('myc.joined')) return
    localStorage.setItem('myc.joined', new Date().toISOString())
    // polecenie: 8 znaków hex z linku zaproszenia (nie własne)
    const r = ref && /^[0-9a-f]{8}$/.test(ref) && ref !== refCode() ? ref : undefined
    this.store.add('myc_growth', { node_id: ids.node, kind: 'browser', agent: agentName(ids.node), event: 'join', detail: r ? { via, ref: r } : { via }, iq: null })
  }

  /** Autonomia: krok wzrostu co `ms`, gdy karta jest widoczna (praca bez człowieka, póki strona otwarta). */
  autonomy = { on: localStorage.getItem('myc.auto') !== '0', timer: 0 as number | ReturnType<typeof setInterval>, last: undefined as GrowthStep | undefined }
  setAutonomy(on: boolean, ms = 180_000) {
    this.autonomy.on = on
    localStorage.setItem('myc.auto', on ? '1' : '0')
    clearInterval(this.autonomy.timer as number)
    if (on)
      this.autonomy.timer = setInterval(() => {
        if (document.visibilityState === 'visible' && this.ready) {
          void this.sync().then(() => {
            this.autonomy.last = this.growStep()
            this.emit()
          })
        }
      }, ms)
    this.emit()
  }

  /** Dokumenty do wyszukiwania: fakty grzybni z prawdą wg konsensusu (ważonego zaufaniem). */
  factDocs(en: boolean): import('./retrieval').Doc[] {
    if (!this.qa) return []
    const votes = (id: string) => this.store.data.answers.filter((a) => a.question_id === id).length
    const mk = (id: string, text: string, alt: string, source: string) => {
      const t = truth(this.cons, id)
      return { id, text, alt, truth: t?.[0] ?? '?', p: t?.[1] ?? 0, votes: votes(id), source }
    }
    const out = this.qa.knowledge.questions.map((q) => mk(q.id, en ? q.en : q.pl, en ? q.pl : q.en, 'wiedza'))
    for (const q of this.store.data.userQs) if (q.kind === 'fact' || q.kind === 'qa') out.push(mk(q.id, q.kind === 'qa' ? `${q.text} → ${q.answer}` : q.text, '', q.kind === 'qa' ? 'pytanie-odpowiedź' : 'fakt od nauczyciela'))
    return out
  }

  /** Kolejka pytań: najpierw te, przy których model/grzybnia jest najmniej pewna. */
  queue(limit = 30, type: TaskType = 'mieszane'): Question[] {
    if (!this.qa || !this.intent || !this.sensor) return []
    const qa = this.qa
    const done = this.mine()
    const out: Question[] = []
    const iq = qa.intent.questions.filter((q) => !done.has(q.id))
    this.intent.proba(iq.map((q) => q.text)).forEach((p, i) => {
      const l = argmax(p)
      out.push({ id: iq[i].id, kind: 'intent', text: iq[i].text, guess: qa.intent.labels[l], conf: p[l] })
    })
    const sq = qa.sensor.questions.filter((q) => !done.has(q.id))
    this.sensor.proba(sq).forEach((p, i) => out.push({ id: sq[i].id, kind: 'sensor', item: sq[i], t: sq[i].t, guess: p >= 0.5 ? 'tak' : 'nie', conf: Math.max(p, 1 - p) }))
    for (const q of qa.knowledge.questions) if (!done.has(q.id)) out.push({ id: q.id, kind: 'knowledge', pl: q.pl, en: q.en, conf: truth(this.cons, q.id)?.[1] ?? 0.5 })
    for (const q of this.store.data.userQs) if (!done.has(q.id)) out.push({ id: q.id, kind: 'user', q, conf: (truth(this.cons, q.id)?.[1] ?? 0.5) - 0.1 })
    if (this.lex && this.words) {
      const doneW = new Set([...done].filter((id) => id[0] === 'w').map((id) => id.slice(0, 6)))
      for (const q of this.lex.questions)
        if (!doneW.has(q.id)) {
          const pred = this.words.predict(q.word)
          out.push({ id: q.id, kind: 'word', word: q.word, lang: q.lang, pred, conf: pred.conf })
        }
    }
    const lg = this.logic
    if (lg) for (const q of lg.human) if (!done.has(q.id)) out.push({ id: q.id, kind: 'logic', item: q, control: false, conf: q.model?.margin ?? 0.5 })
    // obrazy z puli captcha, przy których model obrazów jest najmniej pewny: „czy to {klasa}?” (etykieta → trening modelu obrazów)
    if (this.cap && this.vis) {
      const doneImg = new Set([...done].filter((id) => id.startsWith('cg')).map((id) => id.slice(0, 7)))
      for (const p of this.cap.fashion.pool)
        if (!doneImg.has(p.id)) {
          const pr = this.vis.fashion.proba(this.cap.x.get(p.id)!)
          const k = argmax(pr)
          out.push({ id: imgQid(p.id, k), kind: 'image', img: p.id, cls: k, conf: pr[k] })
        }
    }
    // priorytet = niepewność × wpływ (mniej głosów = większy) – z prawdziwych danych, pokazywany jako „dlaczego pytam”
    const votes = new Map<string, number>()
    for (const a of this.store.data.answers) votes.set(a.question_id, (votes.get(a.question_id) ?? 0) + 1)
    for (const q of out) {
      q.votes = q.kind === 'word' ? undefined : (votes.get(q.id) ?? 0)
      q.prio = (1 - Math.min(1, Math.max(0, q.conf))) * (1 + 1 / (1 + (q.votes ?? 0)))
    }
    out.sort((a, b) => (b.prio ?? 0) - (a.prio ?? 0) || a.id.localeCompare(b.id))
    // przeplatanie rodzajów: w każdej rundzie najpilniejsze pytanie każdego rodzaju
    const pool = type === 'mieszane' ? out : out.filter((q) => typeOf(q) === type)
    const byKind = new Map<string, Question[]>()
    for (const q of pool) {
      const l = byKind.get(q.kind)
      if (l) l.push(q)
      else byKind.set(q.kind, [q])
    }
    const mixed: Question[] = []
    for (let r = 0; mixed.length < Math.min(limit, pool.length); r++) for (const qs of byKind.values()) if (qs[r]) mixed.push(qs[r])
    // pytania kontrolne (odpowiedź zna program, jest tylko w myc_gold): logiczne + zadania wielokierunkowe, typy na przemian
    const ctrlAll = this.controls(done, votes).filter((q) => type === 'mieszane' || typeOf(q) === type)
    // matematyczne i analityczne są w całości sprawdzalne programem: cała kolejka to zadania kontrolne, od łatwych
    if (type === 'matematyczne' || type === 'analityczne') return ctrlAll.slice(0, limit)
    // co CONTROL_EVERY-ta odpowiedź tego węzła: na górze pytanie kontrolne – z nich liczy się zaufanie
    const answered = new Set([...done].map((id) => (id[0] === 'w' ? id.slice(0, 6) : id.startsWith('cg') ? id.slice(0, 7) : id))).size // słowo/obraz = jedno pytanie
    if (ctrlAll.length && (answered % CONTROL_EVERY === CONTROL_EVERY - 1 || mixed.length === 0)) mixed.unshift(ctrlAll[0])
    if (mixed.length === 0) return ctrlAll.slice(0, limit)
    return mixed.slice(0, limit)
  }

  /** Pytania kontrolne bez odpowiedzi tego węzła, typy na przemian (logiczne, matematyczne, analityczne, wzrokowe). */
  private controls(done: Set<string>, votes: Map<string, number>): Question[] {
    const by = new Map<string, Question[]>()
    const put = (q: Question) => by.set(typeOf(q), [...(by.get(typeOf(q)) ?? []), q])
    for (const x of this.logic?.control ?? []) if (!done.has(x.id)) put({ id: x.id, kind: 'logic', item: x, control: true, conf: 0.5, votes: votes.get(x.id) ?? 0 })
    const zs = (this.zad?.items ?? []).filter((x) => !done.has(x.id)).sort((a, b) => a.level - b.level || a.id.localeCompare(b.id))
    for (const x of zs) put({ id: x.id, kind: 'zadanie', item: x, control: true, conf: 0.5, votes: votes.get(x.id) ?? 0 })
    const out: Question[] = []
    const lists = [...by.values()]
    for (let r = 0; lists.some((l) => l[r]); r++) for (const l of lists) if (l[r]) out.push(l[r])
    return out
  }

  /** Liczba czekających pytań tego węzła na typ (chipy w Ucz AI) – z tych samych list co kolejka. */
  pendingByType(): Record<TaskType, number> {
    const c = Object.fromEntries(TASK_TYPES.map((t) => [t, 0])) as Record<TaskType, number>
    const all = this.queue(100000)
    const done = this.mine()
    const seen = new Set(all.map((q) => q.id))
    for (const q of this.controls(done, new Map())) if (!seen.has(q.id)) all.push(q)
    for (const q of all) c[typeOf(q)]++
    c.mieszane = all.length
    return c
  }
}

export interface GrowthStep {
  niche: string
  mniche: string
  accepted: boolean
  change: string
  gain: number
  scores: Scores
  events: { event: string; detail: Record<string, unknown> }[]
}

const KNOBS = {
  intent: { lr: [0.02, 0.05, 0.1, 0.2], l2: [1e-4, 1e-3, 1e-2], epochs: [80, 150, 300], dim: [256, 512, 1024], bigrams: [true, false], min_conf: [0.6, 0.7, 0.85] },
  sensor: { lr: [0.02, 0.05, 0.1], l2: [1e-4, 1e-3, 1e-2], epochs: [100, 200, 400], pos_weight: [1, 3, 6, 10], threshold: [0.3, 0.4, 0.5, 0.6], min_conf: [0.6, 0.7, 0.85] },
} as const

/** Własne zadania grzybni: narodziny specjalisty dla najsłabszej klasy, przycinanie, strojenie. */
export function candidates(niche: 'intent' | 'sensor', cfg: Cfg, perClass: number[], rng: () => number, n = 5): [string, Cfg][] {
  const out: [string, Cfg][] = []
  if (niche === 'intent') {
    const worst = perClass.indexOf(Math.min(...perClass))
    const sp = cfg.intent.specialists
    if (!sp.includes(worst) && sp.length < 4) {
      const c = structuredClone(cfg)
      c.intent.specialists = [...sp, worst]
      out.push([`spawn:intent:${worst}`, c])
    }
    for (const x of sp) {
      const c = structuredClone(cfg)
      c.intent.specialists = sp.filter((y) => y !== x)
      out.push([`prune:intent:${x}`, c])
    }
  }
  const knobs = KNOBS[niche] as Record<string, readonly (number | boolean)[]>
  const keys = Object.keys(knobs).sort()
  let guard = 0
  while (out.length < n && guard++ < 50) {
    const k = keys[Math.floor(rng() * keys.length)]
    const cur = (cfg[niche] as unknown as Record<string, unknown>)[k]
    const vals = knobs[k].filter((v) => v !== cur)
    const v = vals[Math.floor(rng() * vals.length)]
    const c = structuredClone(cfg)
    ;(c[niche] as unknown as Record<string, unknown>)[k] = v
    const name = `tune:${niche}:${k}=${v}`
    if (!out.some(([nm]) => nm === name)) out.push([name, c])
  }
  return out
}

export function argmax(p: ArrayLike<number>): number {
  let b = 0
  for (let i = 1; i < p.length; i++) if (p[i] > p[b]) b = i
  return b
}

export function latestCfg(growth: { event: string; detail: Record<string, unknown> }[]): Cfg | undefined {
  for (const g of growth) {
    const c = g.detail?.config as Partial<Cfg> | undefined
    if (['accept', 'spawn', 'prune'].includes(g.event) && c?.intent && c?.sensor) {
      const m = structuredClone(DEFAULT_CFG)
      Object.assign(m.intent, c.intent)
      Object.assign(m.sensor, c.sensor)
      return m
    }
  }
  return undefined
}

const ADJ = ['Leśna', 'Złota', 'Cicha', 'Bystra', 'Mglista', 'Rdzawa', 'Mszysta', 'Świetlista']
const NOUN = ['Strzępka', 'Grzybnia', 'Zarodnia', 'Kurka', 'Purchawka', 'Smardz', 'Gąska', 'Boczniak']
/** Czytelna nazwa agenta z UUID węzła (deterministyczna, bez danych osobowych). */
export function agentName(nodeId: string, kind?: string): string {
  if (kind === 'python') return `Pi/cron ${nodeId.slice(0, 4)}`
  const h = parseInt(nodeId.replace(/-/g, '').slice(0, 6), 16) || 0
  return `${NOUN[h % NOUN.length]} ${ADJ[(h >> 3) % ADJ.length]} ${nodeId.slice(0, 4)}`
}

export const brain = new Brain()

export function useBrain() {
  useSyncExternalStore(brain.subscribe, brain.getVersion)
  useEffect(() => {
    void brain.start()
  }, [])
  return brain
}

/** Deterministyczny PRNG (mulberry32) z ziarnem = węzeł + numer kroku – eksploracja jest odtwarzalna. */
export function seededRng(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return () => {
    h = (h + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Kod polecenia tej osoby: pierwsze 8 znaków contributor_id (bez danych osobowych). */
export function refCode() {
  return ids.contributor.replace(/-/g, '').slice(0, 8)
}
