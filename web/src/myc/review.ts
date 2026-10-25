// Zakładka „Weryfikuj”: kolejka prawdziwych pozycji do sprawdzenia + zapis decyzji przez RPC.
// Kolejkę liczy przeglądarka z tych samych danych co konsensus (odpowiedzi, nauczyciele, strzępki),
// rozmowy dochodzą tylko z kluczem właściciela (myc_review_chats). Zapis sprawdza baza (skrót klucza, limiter).
import { truth } from './consensus'
import { wordQid } from './lexicon'
import { LETTERS, PERMS, ROT } from './vision'
import { ids, ownerKey } from './store'
import { conflictFrags, fragRpc, recentFrags, relName, type Frag } from './frags'
import type { brain as BrainT } from './brain'
import { latestTaxo, type TaxoVersion, pathLabel, pathOfWord, taxoInputs, taxoQuality } from './taxo'
import { seedOf, seedPath, seedSrc, taxoSeed, type Seed } from './seed'

type Brain = typeof BrainT
export type ItemType = 'answer' | 'word' | 'captcha' | 'teach' | 'chat' | 'fragment' | 'model' | 'category' | 'image' | 'ocr'
export type Verdict = 'approve' | 'reject' | 'correct' | 'skip'

export interface ReviewItem {
  type: ItemType
  ref: string
  kind: string
  title: string
  ai: string
  aiLabel: string
  conf: number
  reason: string
  /** sporne: węzły się nie zgadzają, strzępki są sprzeczne albo ktoś dał 👎 */
  disputed?: boolean
  options?: { value: string; label: string }[]
  /** dowody: głosy, źródła, sąsiednie wartości */
  evidence: string[]
  img?: string
  frag?: { subj: string; rel: string; obj?: string; lang?: string }
  /** proponowana poprawka (np. etykieta ze zbioru danych) */
  suggest?: string
  /** słowo w taksonomii: indeks słowa (kandydaci liczeni przez model przy otwarciu karty) */
  taxo?: { i: number; suspect: boolean }
  free?: boolean
  priority: number
}

export interface Who {
  room: 'main' | 'e2e' | null
  reviewer: 'owner' | 'contrib' | null
  weight: number | null
}

const room = () => (localStorage.getItem('myc.reviewRoom') === 'e2e' ? 'e2e' : 'main')
export const reviewRoom = room

export const whoami = (key = ownerKey.get()) => fragRpc<Who>('myc_review_whoami', { p_key: key || null, p_node: ids.node })

export function submit(item: ReviewItem, verdict: Verdict, truthVal?: string) {
  // grupa taksonomii: wpisany tekst = nowa nazwa (wybrane opcje mają już prefiks merge:/split)
  if (item.type === 'category' && item.kind === 'cluster' && verdict === 'correct' && truthVal && !/^(merge:|split$|name:)/.test(truthVal)) truthVal = `name:${truthVal}`
  let frag = item.frag && (verdict === 'approve' || verdict === 'correct') ? { ...item.frag, obj: verdict === 'correct' ? fragObj(item, truthVal) : item.frag.obj, wrong_obj: verdict === 'correct' ? item.frag.obj : undefined } : undefined
  if (item.type === 'category' && verdict === 'correct') {
    const tgt = truthVal?.startsWith('own:') ? truthVal.slice(4).split('|')[0].trim() : item.options?.find((o) => o.value === truthVal)?.label.split(' › ').pop()
    frag = item.kind === 'word' && item.frag && tgt ? { ...item.frag, obj: tgt, wrong_obj: item.frag.obj } : undefined
  }
  return fragRpc<{ id: number; frag?: number }>('myc_review_submit', {
    p_key: ownerKey.get() || null,
    p_node: ids.node,
    p_contrib: ids.contributor,
    p_item: { type: item.type, ref: item.ref, kind: item.kind, ai: item.ai, conf: Math.round(item.conf * 1000) / 1000, verdict, truth: truthVal, frag },
  })
}
export const undo = (id: number) => fragRpc<{ undone: number }>('myc_review_undo', { p_key: ownerKey.get() || null, p_node: ids.node, p_id: id })

export interface ReviewStat {
  day: string
  item_type: string
  kind: string
  n: number
  ai_ok: number
  ai_wrong: number
  skipped: number
  owner: number
}
export interface LogRow {
  id: number
  item_type: string
  item_ref: string
  kind: string | null
  ai_answer: string | null
  verdict: Verdict
  truth: string | null
  before: Record<string, unknown>
  after: Record<string, unknown>
  reviewer: string
  created_at: string
  undone_at: string | null
  undone_reason: string | null
}
export const reviewStats = () => fragRpc<ReviewStat[]>('myc_review_stats', { p_room: room() })
export const reviewLog = (limit = 60) => fragRpc<LogRow[]>('myc_review_log', { p_key: ownerKey.get() || null, p_limit: limit })
interface ChatRow {
  id: number
  user_text: string
  reply: string
  act: string
  mode: string
  lang: string
  feedback: number | null
  created_at: string
}
const reviewChats = () => fragRpc<ChatRow[]>('myc_review_chats', { p_key: ownerKey.get() || null, p_limit: 60 })

/** Obiekt strzępka po poprawce: dla pytań tak/nie zmienia się sens, nie słowo. */
function fragObj(item: ReviewItem, t?: string) {
  if (!item.frag) return t
  if (item.type === 'fragment' || item.type === 'model' || item.free) return t
  return item.frag.obj
}

export const TYPE_LABEL: Record<string, [string, string]> = {
  answer: ['Odpowiedzi węzłów', 'Node answers'],
  word: ['Słowa i kategorie', 'Words & categories'],
  captcha: ['Captcha (obrazy, litery)', 'Captcha (images, letters)'],
  teach: ['Wpisy nauczycieli', 'Teacher entries'],
  chat: ['Rozmowy', 'Chats'],
  fragment: ['Strzępki wiedzy', 'Knowledge fragments'],
  model: ['Błędy modelu', 'Model mistakes'],
  category: ['Kategorie (taksonomia)', 'Categories (taxonomy)'],
  image: ['Obrazy (obrót, rozpoznanie)', 'Images (rotation, recognition)'],
  ocr: ['Odczyt tekstu', 'Text reading'],
}

const pct = (x: number) => `${Math.round(x * 100)}%`

/** Prawdziwa kolejka: spory i niska pewność konsensusu, wpisy nauczycieli, błędy modelu na zbiorze testowym,
 *  sprzeczne/niepewne strzępki i (z kluczem) rozmowy bez odpowiedzi. Bez pozycji już rozstrzygniętych. */
export async function buildQueue(b: Brain, en: boolean, opts: { owner: boolean; room?: 'main' | 'e2e' } = { owner: false }): Promise<{ items: ReviewItem[]; counts: Record<string, number> }> {
  const rm = opts.room ?? room()
  const d = b.store.data
  const done = new Set((d.labels ?? []).map((l) => `${l.item_type}|${l.item_ref}`))
  const items: ReviewItem[] = []
  const yn = (v: string) => (v === 'tak' ? (en ? 'yes' : 'tak') : v === 'nie' ? (en ? 'no' : 'nie') : v)
  const YN = [
    { value: 'tak', label: en ? 'yes' : 'tak' },
    { value: 'nie', label: en ? 'no' : 'nie' },
  ]
  if (rm === 'main' && b.qa) {
    const qa = b.qa
    // głosy na pytanie
    const votes = new Map<string, Map<string, number>>()
    for (const a of d.answers) {
      const m = votes.get(a.question_id) ?? new Map<string, number>()
      m.set(a.answer, (m.get(a.answer) ?? 0) + 1)
      votes.set(a.question_id, m)
    }
    const plLbl = (l: string) => qa.intent.labels_pl[qa.intent.labels.indexOf(l)] ?? l
    const intentLbl = (l: string) => (en ? l : plLbl(l))
    const intentOpts = qa.intent.labels.map((l) => ({ value: l, label: intentLbl(l) }))
    const intentQ = new Map(qa.intent.questions.map((q) => [q.id, q.text]))
    const knowQ = new Map(qa.knowledge.questions.map((q) => [q.id, en ? q.en : q.pl]))
    const lexQ = new Map((b.lex?.questions ?? []).map((q) => [q.id, q]))
    const cats = b.lex?.taxonomy ?? []
    const userQ = new Map(d.userQs.map((q) => [q.id, q]))
    const cap = b.cap
    const pairQ = new Map((cap?.pairs ?? []).map((p) => [p.id, p]))
    const fashion = cap ? (en ? cap.fashion.classes_en : cap.fashion.classes_pl) : []
    for (const [qid, m] of votes) {
      const t = truth(b.cons, qid)
      if (!t || done.has(`answer|${qid}`) || done.has(`word|${qid}`) || done.has(`captcha|${qid}`) || done.has(`teach|${qid}`)) continue
      const nVotes = [...m.values()].reduce((s, v) => s + v, 0)
      const disputed = m.size > 1
      if (!disputed && t[1] >= 0.8) continue
      const ev = [`${en ? 'votes' : 'głosy'}: ${[...m.entries()].sort((a, c) => c[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', ')}`, `${en ? 'consensus' : 'konsensus'} ${pct(t[1])} (Dawid-Skene)`]
      const reason = disputed ? (en ? 'nodes disagree' : 'spór węzłów') : en ? `low confidence (${nVotes} vote)` : `niska pewność (${nVotes} głos)`
      const pr = (disputed ? 0.8 : 0.4) + (1 - t[1]) * 0.2
      let it: Omit<ReviewItem, 'evidence' | 'reason' | 'priority' | 'conf' | 'ref'> | undefined
      const k0 = qid[0]
      if (k0 === 'i' && intentQ.has(qid)) it = { type: 'answer', kind: 'intent', title: intentQ.get(qid)!, ai: t[0], aiLabel: intentLbl(t[0]), options: intentOpts, frag: { subj: intentQ.get(qid)!, rel: 'intencja', obj: plLbl(t[0]), lang: 'en' } }
      else if (k0 === 'k' && knowQ.has(qid)) it = { type: 'answer', kind: 'knowledge', title: knowQ.get(qid)!, ai: t[0], aiLabel: yn(t[0]), options: YN, frag: { subj: knowQ.get(qid)!, rel: 'prawdziwe', obj: t[0] } }
      else if (k0 === 's') {
        const sq = qa.sensor.questions.find((q) => q.id === qid)
        if (sq) it = { type: 'answer', kind: 'sensor', title: en ? `Sensor (${sq.t}): is this segment an anomaly?` : `Czujnik (${sq.t}): czy ten odcinek to anomalia?`, ai: t[0], aiLabel: yn(t[0]), options: YN, img: `spark:${sq.seg.join(',')}` }
      } else if (k0 === 'w') {
        const mm = /^(w(?:\d{5}|[a-z]\d{4}))c(\d{3})$/.exec(qid)
        const w = mm && lexQ.get(mm[1])
        const c = mm && cats[Number(mm[2])]
        if (w && c) it = { type: 'word', kind: 'word', title: en ? `Is “${w.word}” a ${c.en}?` : `Czy „${w.word}” to ${c.pl}?`, ai: t[0], aiLabel: yn(t[0]), options: YN, frag: t[0] === 'tak' ? { subj: w.word, rel: 'jest', obj: c.pl, lang: w.lang } : undefined }
      } else if (k0 === 'u' && userQ.has(qid)) {
        const u = userQ.get(qid)!
        const o = u.kind === 'example' ? intentOpts : u.kind === 'word' ? cats.map((c) => ({ value: c.id, label: en ? c.en : c.pl })) : YN
        const lab = o.find((x) => x.value === t[0])?.label ?? t[0]
        it = { type: 'teach', kind: u.kind, title: u.kind === 'qa' && u.answer ? `${u.text} → ${u.answer}` : u.text, ai: t[0], aiLabel: lab, options: o, frag: u.kind === 'fact' ? { subj: u.text, rel: 'prawdziwe', obj: t[0] } : u.kind === 'example' ? { subj: u.text, rel: 'intencja', obj: plLbl(t[0]) } : undefined }
      } else if (qid.startsWith('cg') && cap) {
        const mm = /^(cg(?:\d{5}|[a-z]\d{4}))k(\d)$/.exec(qid)
        if (mm) it = { type: 'captcha', kind: 'image', title: en ? `Does the image show: ${fashion[Number(mm[2])]}?` : `Czy obraz przedstawia: ${fashion[Number(mm[2])]}?`, ai: t[0], aiLabel: yn(t[0]), options: YN, img: mm[1], frag: t[0] === 'tak' ? { subj: `obraz ${mm[1]}`, rel: 'przedstawia', obj: cap.fashion.classes_pl[Number(mm[2])] } : undefined }
      } else if (qid.startsWith('ct') && cap) it = { type: 'captcha', kind: 'letter', title: en ? 'Which letter is it?' : 'Jaka to litera?', ai: t[0], aiLabel: t[0], options: LETTERS.map((l) => ({ value: l, label: l })), img: qid }
      else if (qid.startsWith('cr') && cap) it = { type: 'captcha', kind: 'rotate', title: en ? 'How is the image rotated?' : 'Jak obrócony jest obraz?', ai: t[0], aiLabel: t[0], options: ROT.map((r) => ({ value: r, label: r })), img: qid }
      else if (qid.startsWith('cm') && pairQ.has(qid)) {
        const p = pairQ.get(qid)!
        it = { type: 'captcha', kind: 'pair', title: `„${p.pl}” = “${p.en}”?`, ai: t[0], aiLabel: yn(t[0]), options: YN, frag: t[0] === 'tak' ? { subj: p.pl, rel: 'tlumaczenie', obj: p.en } : undefined }
      } else if (qid.startsWith('co') && cap) {
        const o = cap.order.find((x) => x.id === qid)
        if (o) it = { type: 'captcha', kind: 'order', title: (en ? 'Chronological order: ' : 'Kolejność w czasie: ') + o.items.map((x, i) => `${'abcd'[i]}) ${en ? x.en : x.pl}`).join('; '), ai: t[0], aiLabel: t[0], options: PERMS.map((p) => ({ value: p, label: p })) }
      }
      else if (k0 === 'l' && b.logic) {
        // pytania logiczne grzybni tylko dla ludzi (kontrolne mają odpowiedź w myc_gold – tu ich nie pokazujemy)
        const lq = b.logic.human.find((x) => x.id === qid)
        if (lq) {
          const lab = (v: string) => lq.options.find((o) => o.v === v)?.label ?? v
          it = { type: 'answer', kind: 'logic', title: lq.q, ai: t[0], aiLabel: lab(t[0]), options: lq.options.map((o) => ({ value: o.v, label: o.label })), frag: { subj: lq.q.slice(0, 160), rel: 'odpowiedz', obj: lab(t[0]) } }
          if (lq.model) ev.push(`${en ? 'LM (logits)' : 'LM (logity)'}: ${Object.entries(lq.model.p).sort((a, c) => c[1] - a[1]).slice(0, 2).map(([k, v]) => `${lab(k)} ${pct(v)}`).join(' vs ')}`)
        }
      }
      if (it) items.push({ ...it, ref: qid, conf: t[1], reason, disputed, evidence: ev, priority: pr })
    }
    // wpisy nauczycieli bez żadnego głosu (np. świeże) – czy to prawda?
    for (const u of d.userQs)
      if (!votes.has(u.id) && !u.owner && !done.has(`teach|${u.id}`) && (u.kind === 'fact' || u.kind === 'qa'))
        items.push({ type: 'teach', ref: u.id, kind: u.kind, title: u.kind === 'qa' && u.answer ? `${u.text} → ${u.answer}` : u.text, ai: 'tak', aiLabel: yn('tak'), conf: 0.5, reason: en ? 'new teacher entry' : 'nowy wpis nauczyciela', options: YN, evidence: [en ? 'no votes yet' : 'brak głosów'], frag: { subj: u.text, rel: 'prawdziwe', obj: 'tak' }, priority: 0.7 })
    // błędy modelu intencji na zbiorze testowym (CLINC150) – „gdzie się myli”
    let nModel = 0
    for (let i = 0; i < qa.intent.test.length && nModel < 15; i++) {
      const [text, y] = qa.intent.test[i]
      const p = b.predictIntent(text)
      if (!p || p.label === y || done.has(`model|intent:${i}`)) continue
      nModel++
      items.push({ type: 'model', ref: `intent:${i}`, kind: 'intent', title: text, ai: qa.intent.labels[p.label], aiLabel: intentLbl(qa.intent.labels[p.label]), conf: p.conf, reason: en ? 'model mistake on test set' : 'błąd modelu na zbiorze testowym', options: intentOpts, evidence: [`${en ? 'dataset label (CLINC150)' : 'etykieta zbioru (CLINC150)'}: ${intentLbl(qa.intent.labels[y])}`, `${en ? 'model confidence' : 'pewność modelu'} ${pct(p.conf)}`], suggest: qa.intent.labels[y], frag: { subj: text, rel: 'intencja', obj: plLbl(qa.intent.labels[y]), lang: 'en' }, priority: 0.6 })
    }
    void wordQid
    items.push(...(await taxoItems(en, done).catch(() => [] as ReviewItem[])))
  }
  // strzępki: sprzeczności (ta sama encja i relacja, różne wartości) i niepewne nowe
  const [conf, recent] = await Promise.all([conflictFrags(rm, 60).catch(() => [] as Frag[]), recentFrags(rm, 30).catch(() => [] as Frag[])])
  const groups = new Map<string, Frag[]>()
  for (const f of conf) groups.set(`${f.subj.toLowerCase()}|${f.rel}`, [...(groups.get(`${f.subj.toLowerCase()}|${f.rel}`) ?? []), f])
  for (const f of [...conf, ...recent.filter((r) => r.status === 'active' && r.trust < 0.85)]) {
    if (done.has(`fragment|${f.id}`) || items.some((x) => x.type === 'fragment' && x.ref === String(f.id))) continue
    const sib = groups.get(`${f.subj.toLowerCase()}|${f.rel}`) ?? []
    items.push({
      type: 'fragment',
      ref: String(f.id),
      kind: f.rel,
      title: `${f.subj} – ${relName(f.rel, en)} – ?`,
      ai: f.obj,
      aiLabel: f.obj,
      conf: f.trust,
      disputed: f.status === 'conflict',
      reason: f.status === 'conflict' ? (en ? 'contradicting fragments' : 'sprzeczne strzępki') : en ? 'uncertain fragment' : 'niepewny strzępek',
      options: sib.length > 1 ? sib.map((s) => ({ value: s.obj, label: `${s.obj} (#${s.id}, ${s.source})` })) : undefined,
      free: true,
      evidence: [`#${f.id} · ${en ? 'source' : 'źródło'}: ${f.source}${f.source_ref ? ` (${f.source_ref})` : ''} · ${en ? 'trust' : 'zaufanie'} ${pct(f.trust)} · ${f.n_support ?? 1}× ${en ? 'confirmed' : 'potwierdzeń'}`, ...sib.filter((s) => s.id !== f.id).map((s) => `${en ? 'conflicts with' : 'sprzeczny z'} #${s.id}: ${s.obj} (${s.source}, ${pct(s.trust)})`)],
      priority: f.status === 'conflict' ? 0.95 : 0.5 - f.trust * 0.2,
    })
  }
  // rozmowy (tylko właścicielka): bez odpowiedzi, „nie wiem”, oznaczone 👎
  if (opts.owner && rm === 'main')
    for (const c of await reviewChats().catch(() => [] as ChatRow[]))
      items.push({ type: 'chat', ref: `chat:${c.id}`, kind: c.act, title: c.user_text, ai: c.reply.slice(0, 300), aiLabel: c.reply, conf: c.act === 'unknown' ? 0 : 0.3, disputed: c.feedback === -1, reason: c.feedback === -1 ? (en ? 'flagged 👎' : 'oznaczone 👎') : c.act === 'unknown' ? (en ? 'no answer' : 'brak odpowiedzi') : en ? 'unsure reply' : 'niepewna odpowiedź', free: true, evidence: [`${c.mode} · ${c.lang} · ${new Date(c.created_at).toLocaleString(en ? 'en-GB' : 'pl-PL', { timeZone: 'Europe/Amsterdam' })}`], priority: 0.9 })
  items.sort((a, c) => c.priority - a.priority || a.ref.localeCompare(c.ref))
  const counts: Record<string, number> = {}
  for (const i of items) counts[i.type] = (counts[i.type] ?? 0) + 1
  return { items, counts }
}

/** Wersja taksonomii, z której zbudowano ostatnią kolejkę (dla wyboru kategorii na karcie). */
export const taxoCtx: { v?: TaxoVersion; seed?: Seed } = {}

/** Taksonomia: słowa z najmniejszym marginesem przypisania i nowe kategorie (nazwa nadana przez AI). */
async function taxoItems(en: boolean, done: Set<string>): Promise<ReviewItem[]> {
  const [t, inp, qual, seed] = await Promise.all([latestTaxo(), taxoInputs(), taxoQuality(), taxoSeed()])
  if (!t) return []
  const suspect = new Set(qual?.suspect ?? [])
  const bad = new Set(t.cur.bad ?? [])
  const { cur, row } = t
  taxoCtx.v = cur
  taxoCtx.seed = seed
  const v = cur.version
  const ev = new Set(inp.eval)
  const out: ReviewItem[] = []
  const N = cur.nodes
  const seedLbl = en ? 'seed (source: WordNet/Wikidata)' : 'seed (źródło: WordNet/Wikidata)'
  // słowa: najmniejszy margin (między najlepszą a drugą grupą), poza stałym zbiorem oceny
  const order = cur.margin
    .map((m, i) => [m, i] as const)
    .filter(([, i]) => !ev.has(i) && !bad.has(i) && !done.has(`category|tw:${i}`))
    // podejrzane nie-słowa (bez częstości, Wikisłownika i Wikipedii) na koniec kolejki
    .sort((a, b) => Number(suspect.has(a[1])) - Number(suspect.has(b[1])) || a[0] - b[0])
  for (const [m, i] of order.slice(0, 20)) {
    const [w, lang] = inp.words[i]
    const path = pathOfWord(cur, i)
    const named = path.filter((n) => !n.hidden)
    const g = inp.taxonomy[inp.gold[i]]
    const own = cur.own?.[String(i)]
    const sus = suspect.has(i)
    const sc = seed ? seedOf(seed, i) : -1
    const sp = seed && sc >= 0 ? seedPath(seed, sc, en) : ''
    // „AI mówi”: tylko nazwane kategorie (seed / człowiek); grupy automatyczne nie mają nazw do pokazania
    const aiLabel = own
      ? `${named.length ? `${pathLabel(named, en)} › ` : ''}${own}`
      : named.length
        ? pathLabel(named, en)
        : sp
          ? `${sp} · ${seedLbl}`
          : en
            ? 'no named category yet (sources disagree) – pick one'
            : 'brak nazwanej kategorii (źródła się nie zgadzają) – wybierz'
    const last = named[named.length - 1]
    const q = qual
      ? `${en ? 'frequency' : 'częstość'} (wordfreq) ${qual.zipf[i] ? `zipf ${qual.zipf[i]}` : en ? 'none' : 'brak'} · ${en ? 'Wiktionary' : 'Wikisłownik'}: ${qual.wiktionary[i] ? (en ? 'yes' : 'jest') : en ? 'no' : 'brak'}${qual.wiki_hits[String(i)] != null ? ` · Wikipedia: ${qual.wiki_hits[String(i)]} ${en ? 'hits' : 'trafień'}` : ''}`
      : ''
    out.push({
      type: 'category',
      ref: `tw:${i}`,
      kind: 'word',
      title: en ? `Where does “${w}” belong?` : `Gdzie pasuje „${w}”?`,
      ai: last ? `c:${v}:${last.id}` : sc >= 0 ? `s:${sc}` : '',
      aiLabel,
      conf: Math.min(1, m * 5),
      reason: sus ? (en ? 'suspected non-word (dictionary error?)' : 'podejrzane nie-słowo (błąd słownika?)') : en ? 'uncertain grouping (small margin)' : 'niepewne przypisanie (mały margines)',
      options: [],
      evidence: [
        `${lang.toUpperCase()} · ${en ? 'margin' : 'margines'} ${m.toFixed(3)} · v${v}`,
        sp ? `seed: ${sp} (${seedSrc(seed!.cats[sc], en)}, ${en ? 'medium trust' : 'zaufanie średnie'})` : `seed: ${en ? 'sources disagree – no category' : 'źródła się nie zgadzają – bez kategorii'}`,
        `WordNet: ${en ? g.en : g.pl}`,
        ...(q ? [q] : []),
      ],
      frag: { subj: w, rel: 'jest', obj: last ? last.name_pl : sc >= 0 && seed ? seed.cats[sc].pl : '', lang },
      taxo: { i, suspect: sus },
      priority: sus ? 0.05 : 0.55 - m,
    })
  }
  // kategorie seed w tej wersji: czy nazwa i grupa są dobre (głosowanie – zaufanie seed jest tylko średnie)
  const cats = N.filter((n) => n.src === 'seed' && n.lvl >= 1 && !done.has(`category|tc:${v}:${n.id}`))
  for (const c of cats.slice(0, 6)) {
    const sc = c.seed != null && seed ? seed.cats[c.seed] : undefined
    out.push({
      type: 'category',
      ref: `tc:${v}:${c.id}`,
      kind: 'cluster',
      title: en ? `Category “${c.name_en}” (${c.n} words) – good name and grouping?` : `Kategoria „${c.name_pl}” (${c.n} słów) – dobra nazwa i grupa?`,
      ai: c.name_pl,
      aiLabel: `${c.top.slice(0, 8).map((j) => inp.words[j][0]).join(', ')}…`,
      conf: c.cov,
      reason: seedLbl,
      options: [{ value: 'split', label: en ? '✂ split it' : '✂ podziel' }],
      free: true,
      evidence: [
        `${en ? 'path' : 'ścieżka'}: ${pathLabel(pathOfWord(cur, c.top[0]).filter((n) => n.lvl <= c.lvl), en)}`,
        sc ? `${en ? 'name from' : 'nazwa z'}: ${seedSrc(sc, en)}${sc.qid ? ` · Wikidata ${sc.qid}` : ''}${sc.plwiki_cat ? ` · ${sc.plwiki_cat}` : ''}` : '',
        `v${v} · ${en ? 'accuracy' : 'trafność'} ${pct(row.acc ?? 0)}`,
        en ? 'type a better name, or pick split' : 'wpisz lepszą nazwę albo wybierz podział',
      ].filter(Boolean),
      frag: { subj: c.name_pl, rel: 'pojecie', obj: '' },
      priority: 0.4,
    })
  }
  return out
}
