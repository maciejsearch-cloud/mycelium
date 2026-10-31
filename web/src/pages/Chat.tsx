import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Card, PageHeader } from '../components/ui'
import { Icon } from '../components/Icon'
import { LogoMark } from '../components/Logo'
import { L, useI18n } from '../i18n'
import { FACT_CONF, useBrain } from '../myc/brain'
import { chatConsent, convId, logExchange } from '../myc/chatlog'
import { loadRegister, reaction as detectReaction, type Register } from '../myc/register'
import { classifyIntent, loadApprovedPatterns, type LangPattern } from '../myc/intent'
import { addMeaning, bestMeaning, meaningRoom, meaningsOf } from '../myc/meanings'
import { ids, SB_KEY, SB_URL } from '../myc/store'
import { defineTarget, detectLang, glosow, reply, smallTalk, type DialogState, type Reply, type Used } from '../myc/dialog'
import { pathName, pathOf, leafOf } from '../myc/lexicon'
import { glossFor, neural, useNeural } from '../myc/neural'
import { askLang, defineFor } from '../myc/plgloss'
import { groundQuestion, groundedSentence, NUMERIC_Q, numbersIn, propFor, ungroundedNumbers, UNSURE, type Grounded } from '../myc/ground'
import { Index, type Doc } from '../myc/retrieval'
import { fragText, fromDefinition, fromGrounded, learn, relName, subjectsIn, threads, type Thread } from '../myc/frags'
import { mesh, type MeshView } from '../mesh/mesh'
import { logAnswer, trainConsent, type ASource } from '../myc/answers'
import { Knowledge, fromFactDocs, loadKnowledge, type KItem } from '../myc/knowledge'
import { intentOf, isFactual, NO_SOURCE, registerIn } from '../myc/sourced'
import { wikiAnswer } from '../myc/wiki'
import { personalQ } from '../myc/person'
import RozbiorTable from '../components/RozbiorTable'
import { ensureRozbior, understand } from '../myc/rozbiorLive'
import { localReply, localWarm, meshReply, type ChatMsg } from '../mesh/client'
import { LOCAL_MB, localLM, type LocalView } from '../mesh/local'
import { MODEL, SHARDS } from '../mesh/qwen'

type Turn = {
  role: 'user' | 'assistant'
  text: string
  /** dokładna treść wysłana do modelu / wygenerowana przez model (historia = wspólny początek pamięci K/V) */
  sent?: string
  pending?: string
  mode?: 'lite' | 'mesh' | 'local'
  used?: Used[]
  ask?: Used
  offer?: Reply['offer']
  act?: string
  saved?: boolean
  ms?: number
  stats?: string
  lite?: string
}

/** Stały prompt systemowy modelu grzybni (bez faktów – te są w treści pytania), wspólny dla węzłów i przeglądarki. */
const sysPrompt = (en: boolean) =>
  en
    ? 'You are Mycelium AI, a helpful assistant running on a mycelium of volunteer browsers. Answer in English, briefly and kindly. When the message lists facts verified by the mycelium, use them – they override your own knowledge. If you are not sure, say so.'
    : 'Jesteś Mycelium AI, pomocnym asystentem działającym na grzybni przeglądarek wolontariuszy. Odpowiadaj po polsku, krótko i życzliwie. Gdy wiadomość zawiera fakty sprawdzone przez grzybnię, korzystaj z nich – są ważniejsze niż Twoja wiedza. Jeśli nie masz pewności, powiedz to.'

const truthTxt = (d: Doc & { url?: string }, en: boolean) =>
  d.dict
    ? d.url
      ? en
        ? 'source'
        : 'źródło'
      : en
        ? 'dictionary'
        : 'słownik'
    : d.votes === 0
      ? en
        ? 'unverified'
        : 'niezweryfikowane'
      : d.truth === 'tak'
        ? en
          ? 'true'
          : 'prawda'
        : d.truth === 'nie'
          ? en
            ? 'false'
            : 'fałsz'
          : d.truth

const dstate: DialogState = { turns: 0 }
// słowa pytania o znaczenie – nie są pytanym słowem
const ASK_WORDS = new Set('jest czym oznacza znaczy jaka jaki jakie kategoria kategorii słowo slowo what does mean meaning the word category kind'.split(' '))

// częste krótkie słowa, które nie są „nieznanym słowem” do wyjaśnienia
const COMMON = new Set('tak nie dobra dobrze okej spoko jasne aha hmm super fajnie czemu serio może moze pewnie chyba wiem ok yes no yeah nope sure fine cool nice'.split(' '))
const flagPrev = (turn: number) =>
  fetch(`${SB_URL}/rest/v1/rpc/myc_chat_flag`, {
    method: 'POST',
    headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_node: ids.node, p_conv: convId, p_turn: turn }),
  }).catch(() => undefined)

const relevantUsed = (d: Used) => d.score >= 1 && (d.cover ?? 1) >= 0.5

/** Odpowiedź „po nitce do kłębka”: najpewniejsze strzępki i ich droga do pojęć i tematów, z numerami. */
function threadReply(th: Thread[], en: boolean): string {
  const lines = th.slice(0, 3).map((x) => {
    const f = x.start
    const head = `${f.subj} – ${relName(f.rel, en)} – ${f.obj} [#${f.id}${f.status === 'verified' ? (en ? ', verified' : ', zweryfikowany') : ''}]`
    const tail = x.path.map((p) => `${p.frag.subj} [#${p.frag.id}]`).join(' → ')
    return tail ? `${head}\n   ↳ ${tail}` : head
  })
  return `${en ? 'From the mycelium fragments (thread to ball):' : 'Ze strzępków grzybni (po nitce do kłębka):'}\n${lines.join('\n')}`
}

export default function Chat() {
  const b = useBrain()
  const en = useI18n().lang === 'en'
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [consent, setConsent] = useState(chatConsent.get())
  const [train, setTrain] = useState(trainConsent.get())
  const [kItems, setKItems] = useState<KItem[] | undefined>()
  const endRef = useRef<HTMLDivElement>(null)
  const docs = useMemo(() => b.factDocs(en), [b, b.version, en]) // eslint-disable-line react-hooks/exhaustive-deps
  const index = useMemo(() => new Index(docs), [docs])
  // pamięć wiedzy: zatwierdzone znaczenia, zweryfikowane strzępki i poprawki z Weryfikuj + fakty z konsensusu
  const know = useMemo(() => new Knowledge([...(kItems ?? []), ...fromFactDocs(docs, FACT_CONF)]), [kItems, docs])
  useEffect(() => {
    loadKnowledge(undefined, meaningRoom()).then(setKItems, () => setKItems([]))
  }, [])
  const answered = b.mine()
  const nn = useNeural()
  useSyncExternalStore(mesh.subscribe, mesh.getVersion)
  const mv = mesh.view
  useSyncExternalStore(localLM.subscribe, localLM.getVersion)
  const lv = localLM.view
  // model w przeglądarce gotowy → od razu policz stały prompt systemowy (pierwsze pytanie liczy już tylko siebie)
  useEffect(() => {
    if (lv.status === 'ready') void localWarm(sysPrompt(en))
  }, [lv.status, en])
  const [busy, setBusy] = useState(false)
  const [reg, setReg] = useState<Register | undefined>()
  const [pats, setPats] = useState<LangPattern[]>([])
  useEffect(() => {
    void mesh.connect().catch(() => undefined)
    // model grzybni w przeglądarce – tylko gdy użytkownik raz go włączył (ok. 1 GB, potem z pamięci podręcznej)
    if (localLM.auto) void localLM.start(false)
    loadRegister().then(setReg, () => undefined)
    void loadApprovedPatterns().then(setPats)
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [turns])

  const send = async () => {
    const q = input.trim()
    if (!q || busy) return
    setInput('')
    const t0 = performance.now()
    void ensureRozbior()
    // rozbiór zdania (gdy model już wczytany): pytanie w 1./2. osobie („gdzie mieszkasz?”) = osobiste, bez Wikipedii
    const und = detectLang(q) !== 'en' ? understand(q) : undefined
    const rbPersonal = und?.route.kind === 'personal'
    const lex = b.lex
    // modele grzybni (gdy włączone): wyszukiwanie semantyczne, intencja, kategoria nieznanego słowa
    let sem: Map<string, number> | undefined
    let nIntent: { label: string; conf: number } | undefined
    let nWord: Doc | undefined
    if (nn.status === 'ready') {
      setBusy(true)
      try {
        sem = new Map((await neural.semantic(q, docs, 8)).map((x) => [x.id, x.sim]))
        // model intencji (MiniLM-L6) zna tylko angielski
        if (detectLang(q) !== 'pl') nIntent = await neural.intent(q)
        const ws = (q.toLowerCase().match(/[\p{L}]{3,}/gu) ?? []).filter((x) => !ASK_WORDS.has(x))
        const w = ws.length <= 2 ? ws.find((x) => !b.words?.dict.has(x)) : undefined
        if (w && lex && !b.wordDocs(q, en).length) {
          const p = await neural.word(w, '')
          if (p) {
            const c = neural.wordCat(lex.taxonomy, p)
            nWord = {
              id: `model:${w}`,
              text: `${w}: ${pathName(lex.taxonomy, c.path, en)} (${en ? 'mycelium model' : 'model grzybni'} v${neural.versions.words?.version}, ${Math.round(c.conf * 100)}%)${p.gloss ? ` — ${p.gloss}` : ''}`,
              truth: '?',
              p: c.conf,
              votes: 0,
              source: en ? 'model (not dictionary)' : 'model (nie słownik)',
              dict: true,
            }
          }
        }
      } catch {
        /* model niedostępny – zostaje BM25 */
      }
      setBusy(false)
    }
    // „co to jest X?” – definicja z Wikisłownika (bez modelu; do 4 s, potem bez definicji)
    const target = defineTarget(q)
    let define: { word: string; gloss: string; lang?: 'pl' | 'en'; source?: string } | undefined
    if (target) {
      setBusy(true)
      const d = await Promise.race([defineFor(target, askLang(q), glossFor), new Promise<undefined>((res) => setTimeout(() => res(undefined), 4000))])
      define = {
        word: target,
        gloss: d?.gloss ?? '',
        lang: d?.lang,
        source: d?.source,
      }
      setBusy(false)
    }
    if (define?.gloss) learn(fromDefinition(define.word, define.gloss, define.lang ?? 'pl'))
    // liczby i encje (np. liczba ludności) – z Wikidata, z kontekstem poprzednich wypowiedzi (do 5 s)
    const qEn = detectLang(q) === 'en'
    let wd: Grounded | undefined
    // pytanie osobiste („Ile mam lat?”) nie jest pytaniem o encję z Wikidata – odpowiada dialog uczciwym „nie znam Cię”
    if (propFor(q) && !personalQ(q) && !rbPersonal) {
      setBusy(true)
      const hist = turns.slice(-4).map((t) => t.text)
      wd = await Promise.race([groundQuestion(q, hist, qEn ? 'en' : 'pl').catch(() => undefined), new Promise<undefined>((res) => setTimeout(() => res(undefined), 5000))])
      setBusy(false)
    }
    if (wd) learn(fromGrounded(wd))
    // strzępki grzybni: nici od faktów o encjach z pytania w górę warstw (do 2,5 s)
    let th: Thread[] = []
    if (!wd) {
      setBusy(true)
      th = await Promise.race([
        threads(subjectsIn(q))
          .then((x) => x.threads)
          .catch(() => [] as Thread[]),
        new Promise<Thread[]>((res) => setTimeout(() => res([]), 2500)),
      ])
      setBusy(false)
    }
    const thUsed: Used[] = th.slice(0, 3).map((x) => ({
      id: `frag:${x.start.id}`,
      text: [fragText(x.start, en), ...x.path.map((p) => fragText(p.frag, en))].join(' → '),
      truth: 'tak',
      p: x.start.trust,
      votes: x.start.n_support ?? 1,
      source: `${en ? 'fragments' : 'strzępki'} #${[x.start.id, ...x.path.map((p) => p.frag.id)].join(' → #')} (${x.start.source})`,
      dict: true,
      score: 50,
    }))
    const wdUsed: Used | undefined = wd && {
      id: `wd:${wd.qid}:${wd.prop}`,
      text: `${wd.label} – ${wd.name[qEn ? 1 : 0]}: ${wd.value}${wd.asOf ? ` (${wd.asOf})` : ''}`,
      truth: 'tak',
      p: 1,
      votes: 0,
      source: `Wikidata ${wd.qid}`,
      url: `https://www.wikidata.org/wiki/${wd.qid}`,
      dict: true,
      score: 99,
    }
    const numericQ = NUMERIC_Q.test(q)
    const search = (s: string, k: number): Used[] => {
      const bm = index.search(s, Math.max(k, 8))
      if (!sem || s !== q) return bm.slice(0, k)
      // hybryda: BM25 + premia za podobieństwo znaczenia (działa też między polskim i angielskim)
      const bonus = (id: string) => Math.max(0, ((sem!.get(id) ?? 0) - 0.45) * 6)
      const byId = new Map<string, Used>(bm.map((d) => [d.id, { ...d, score: d.score + bonus(d.id), sim: sem!.get(d.id) }]))
      for (const d of docs)
        if (sem.has(d.id) && !byId.has(d.id))
          byId.set(d.id, {
            ...d,
            score: bonus(d.id),
            cover: 0,
            sim: sem.get(d.id),
          })
      return [...byId.values()].sort((a, b2) => b2.score - a.score).slice(0, k)
    }
    // rozumienie: krótka reakcja (niezgoda/obelga/frustracja), znaczenia z czatu, znane słowa (rejestr bez cenzury – tylko etykieta)
    // + klasyfikator intencji: zatwierdzona w Weryfikuj próbka „niezgody” z czatu globalnego też jest reakcją na moją odpowiedź
    const ik = classifyIntent(q, reg, pats)
    const rx =
      detectReaction(q, reg) ??
      (ik.intent === 'niezgoda' && ik.why.startsWith('wzorzec')
        ? {
            kind: 'disagree' as const,
            word: q.trim().split(/\s+/)[0] ?? q,
            reg: [],
          }
        : undefined)
    const qWords = (q.toLowerCase().match(/[\p{L}]+/gu) ?? []).filter((w) => !ASK_WORDS.has(w))
    const knownSync = (w: string) => COMMON.has(w) || !!reg?.byForm.has(w) || !!b.words?.dict.get(w) || b.wordDocs(w, en).length > 0
    const cand =
      target ?? (!rx && !/\?\s*$/.test(q) && qWords.length <= 3 && !smallTalk(q) ? (dstate.askWord ? undefined : qWords.find((w) => w.length >= 3 && !knownSync(w))) : undefined)
    const known = new Set<string>()
    let meaning: Parameters<typeof reply>[2]['meaning']
    if (cand) {
      setBusy(true)
      const [ms, dd] = await Promise.all([
        Promise.race([meaningsOf(cand), new Promise<[]>((res) => setTimeout(() => res([]), 2500))]),
        target
          ? Promise.resolve(undefined)
          : Promise.race([defineFor(cand, 'pl', glossFor).catch(() => undefined), new Promise<undefined>((res) => setTimeout(() => res(undefined), 3000))]),
      ])
      setBusy(false)
      const m = bestMeaning(ms)
      if (m && m.status !== 'rejected')
        meaning = {
          word: m.word,
          meaning: m.meaning,
          register: m.register,
          status: m.status as 'pending' | 'approved',
          votes: m.n_votes,
          posterior: m.posterior,
        }
      // słowo z Wikisłownika jest znane – odpowiadamy definicją ze źródła
      if (dd?.gloss) {
        known.add(cand)
        define = {
          word: cand,
          gloss: dd.gloss,
          lang: dd.lang,
          source: dd.source,
        }
      }
    }
    const r = reply(define && !target && known.size ? `co to jest ${define.word}?` : q, dstate, {
      reaction: rx,
      meaning,
      knownWord: (w) => known.has(w) || knownSync(w),
      logged: chatConsent.get(),
      en,
      define,
      search,
      wordDocs: (s) => {
        const d = b.wordDocs(s, en)
        return d.length || !nWord ? d : [nWord]
      },
      wordCat: (w) => {
        if (!b.words || !lex) return undefined
        const known = b.words.dict.get(w.toLowerCase())
        if (known) return [pathName(lex.taxonomy, pathOf(lex.taxonomy, leafOf(lex.taxonomy, known)), en), 1, true]
        const p = b.words.predict(w)
        return [pathName(lex.taxonomy, p.path, en), p.conf, false]
      },
      sentiment: (w) => b.words?.sentiment(w),
      intent: (s) => {
        if (nIntent && s === q) return nIntent
        const p = b.predictIntent(s)
        const qa = b.qa
        if (!p || !qa) return undefined
        return {
          label: (en ? qa.intent.labels : qa.intent.labels_pl)[p.label],
          conf: p.conf,
        }
      },
      nFacts: docs.filter((d) => d.votes > 0).length,
      nWords: lex?.words.length ?? 0,
    })
    const ask = r.used.filter((d) => !d.dict && d.p < FACT_CONF && !answered.has(d.id)).sort((x, y) => x.p - y.p)[0]
    const ms = performance.now() - t0
    // 'word' = definicja ze słownika/Wikisłownika: sprawdzone źródło ma pierwszeństwo przed zgadywaniem małego modelu
    const simple = ['greet', 'thanks', 'bye', 'math', 'time', 'name', 'teach', 'answer', 'word', 'reaction', 'meaning', 'askword', 'clarify', 'aboutme'].includes(r.act)
    if (!['reaction', 'meaning', 'askword', 'clarify', 'greet', 'thanks', 'bye', 'aboutme'].includes(r.act)) dstate.lastQ = q
    // reakcja na poprzednią odpowiedź: oznacz ją (jeśli zapisana za zgodą) do przeglądu w Weryfikuj
    if (r.reaction && chatConsent.get() && dstate.turns > 1) void flagPrev(dstate.turns - 1)
    // wyjaśnienie znaczenia → oczekujące (głosowanie); czat nie używa go przed zatwierdzeniem
    let pending: string | undefined
    if (r.meaning) {
      pending = await addMeaning(r.meaning.word, r.meaning.meaning, r.meaning.register, r.meaning.example, convId, qEn ? 'en' : 'pl').then(
        (x) => (en ? `saved #${x.id} · waiting for a vote` : `zapisane #${x.id} · czeka na głosowanie`),
        (e) => (en ? 'not saved: ' : 'nie zapisano: ') + String((e as Error).message).slice(0, 60),
      )
    }
    // etykiety do Weryfikuj (każda odpowiedź czatu trafia tam na żywo, bez danych osobowych; rezygnacja = nic)
    const firstKnown = qWords.find((w) => b.words?.dict.has(w))
    const catPath = firstKnown && lex && b.words ? pathName(lex.taxonomy, pathOf(lex.taxonomy, leafOf(lex.taxonomy, b.words.dict.get(firstKnown)!)), false) : undefined
    const labels = {
      // klasyfikator intencji czatu globalnego (myc/intent.ts) uzupełnia reguły rozmowy: emocja/niezgoda/ironia/powitanie
      intent: rx
        ? intentOf(r.act, q, rx)
        : ik.intent === 'emocja' || ik.intent === 'niezgoda'
          ? ik.intent
          : ik.intent === 'powitanie'
            ? ('rozmowa' as const)
            : intentOf(r.act, q, rx),
      register:
        ik.intent === 'ironia'
          ? ('ironiczne' as const)
          : ik.tags.includes('slang') && registerIn(q, rx, (w) => reg?.byForm.get(w)?.reg) === 'neutralne'
            ? ('slang' as const)
            : registerIn(q, rx, (w) => reg?.byForm.get(w)?.reg),
      topic: catPath?.split(' › ')[0],
      category: catPath,
    }
    const srcOf = (us: Used[] | undefined): ASource[] =>
      (us ?? [])
        .filter((d) => !d.id.startsWith('model:') && (d.dict || d.votes > 0))
        .map((d) => ({
          kind: d.id.split(':')[0],
          title: d.source,
          url: d.url,
          votes: d.votes || undefined,
        }))
    const logA = (text: string, act: string, mode: 'lite' | 'mesh' | 'local', us: Used[] | undefined, conf?: number) =>
      void logAnswer({
        question: q,
        answer: text,
        sources: srcOf(us),
        conf,
        act,
        mode,
        name: dstate.name,
        ...labels,
      }).catch(() => undefined)
    const sayLite = (text: string, act: string, us: Used[] | undefined, conf?: number, extra: Partial<Turn> = {}) => {
      setTurns((ts) => [
        ...ts,
        { role: 'user', text: q },
        {
          role: 'assistant',
          text,
          mode: 'lite',
          used: us,
          act,
          ms: performance.now() - t0,
          ...extra,
        },
      ])
      void logExchange(dstate.turns, q, text, act, 'lite', en ? 'en' : 'pl')
      logA(text, act, 'lite', us, conf)
    }
    // pytanie o fakt: tylko źródło (Wikidata → pamięć wiedzy → pewny fakt z konsensusu → Wikipedia) albo uczciwe „nie wiem”
    const top = r.used[0]
    const sureFact = r.act === 'fact' && !!top && top.votes > 0 && top.p >= FACT_CONF
    // pewny fakt z konsensusu Weryfikuj (głosy ≥ próg) – odpowiedź deterministyczna z tym źródłem, bez modelu
    if (!wd && sureFact && isFactual(q, r.act)) {
      sayLite(r.text, 'fact', r.used, top.p)
      return
    }
    const factual = !wd && isFactual(q, r.act) && !sureFact && !rbPersonal
    if (factual) {
      const kh = know.search(q, 3)[0]
      if (kh) {
        const when = kh.approvedAt ? new Date(kh.approvedAt).toLocaleDateString(en ? 'en-GB' : 'pl-PL') : ''
        const text =
          kh.kind === 'seed'
            ? en
              ? `From the mycelium's starter facts (open source, not yet voted on): ${kh.text}.\nSource: ${kh.source}`
              : `Z faktów startowych grzybni (otwarte źródło, jeszcze bez głosów): ${kh.text}.\nŹródło: ${kh.source}`
            : en
              ? `From the mycelium's knowledge memory (approved): ${kh.text}.\nProvenance: ${kh.source}${when ? `, approved ${when}` : ''}, ${kh.votes} votes.`
              : `Z pamięci wiedzy grzybni (zatwierdzone): ${kh.text}.\nPochodzenie: ${kh.source}${when ? `, zatwierdzone ${when}` : ''}, ${glosow(kh.votes)}.`
        dstate.open = undefined
        sayLite(
          text,
          'knowledge',
          [
            {
              id: kh.id,
              text: kh.text,
              truth: kh.false ? 'nie' : 'tak',
              p: kh.trust,
              votes: kh.votes,
              source: kh.source,
              dict: true,
              score: kh.score,
            },
          ],
          kh.trust,
        )
        return
      }
      setBusy(true)
      const wh = await Promise.race([wikiAnswer(q).catch(() => undefined), new Promise<undefined>((res) => setTimeout(() => res(undefined), 6000))])
      setBusy(false)
      if (wh) {
        const text = en
          ? `According to Wikipedia (article “${wh.title}”): ${wh.text}\nSource: ${wh.url}`
          : `Według Wikipedii (artykuł „${wh.title}”): ${wh.text}\nŹródło: ${wh.url}`
        dstate.open = undefined
        // niepotwierdzone fakty grzybni zostają na liście źródeł jako powiązane (ze swoim stanem głosowania)
        const rel = r.act === 'fact' ? r.used.slice(0, 2) : []
        sayLite(
          text,
          'wikipedia',
          [
            {
              id: `wiki:${wh.title}`,
              text: wh.text,
              truth: 'tak',
              p: wh.cover,
              votes: 0,
              source: `Wikipedia: ${wh.title} (CC BY-SA)`,
              url: wh.url,
              dict: true,
              score: 99,
            },
            ...rel,
          ],
          wh.cover,
        )
        return
      }
      if (r.act === 'unknown') {
        dstate.open = q
        const text = NO_SOURCE(en, dstate.name ? `, ${dstate.name}` : '')
        sayLite(text, 'nosource', [], 0)
        return
      }
    }
    if (wd && wdUsed) {
      const text = groundedSentence(wd, qEn)
      setTurns((ts) => [
        ...ts,
        { role: 'user', text: q },
        {
          role: 'assistant',
          text,
          mode: 'lite',
          used: [wdUsed],
          act: 'wikidata',
          ms: performance.now() - t0,
        },
      ])
      void logExchange(dstate.turns, q, text, 'wikidata', 'lite', en ? 'en' : 'pl')
      logA(text, 'wikidata', 'lite', [wdUsed], 1)
      return
    }
    // generowanie: najpierw węzły z całym modelem, inaczej model grzybni w tej przeglądarce (gdy wczytany)
    const viaNode = mesh.view.full
    const gen = viaNode || localLM.view.status === 'ready'
    if (th.length && !gen && (r.act === 'unknown' || (!simple && !r.used.some(relevantUsed)))) {
      const text = threadReply(th, en)
      setTurns((ts) => [
        ...ts,
        { role: 'user', text: q },
        {
          role: 'assistant',
          text,
          mode: 'lite',
          used: thUsed,
          act: 'fragments',
          ms,
        },
      ])
      void logExchange(dstate.turns, q, text, 'fragments', 'lite', en ? 'en' : 'pl')
      logA(text, 'fragments', 'lite', thUsed)
      return
    }
    if (!gen || simple || rbPersonal || personalQ(q)) {
      setTurns((ts) => [
        ...ts,
        { role: 'user', text: q },
        {
          role: 'assistant',
          text: r.text,
          mode: 'lite',
          used: simple && r.act !== 'word' ? r.used : [...r.used, ...thUsed],
          ask,
          offer: r.offer,
          act: r.act,
          ms,
          pending,
        },
      ])
      void logExchange(dstate.turns, q, r.text, r.act, 'lite', en ? 'en' : 'pl')
      logA(r.text, r.act, 'lite', simple && r.act !== 'word' ? r.used : [...r.used, ...thUsed], r.act === 'fact' ? top?.p : r.act === 'unknown' ? 0 : undefined)
      return
    }
    // pełny model na węzłach grzybni
    const facts = [...(wdUsed ? [wdUsed] : []), ...thUsed.slice(0, 2), ...r.used.filter((d) => d.dict || d.votes > 0)].slice(0, 5)
    // stały prompt systemowy (bez faktów) – węzły i przeglądarka trzymają jego pamięć K/V, więc liczą tylko nowe pytanie;
    // fakty z bazy idą w treści tego pytania (a w historii zostaje dokładnie to, co wysłano – wspólny początek się zgadza)
    const sys = sysPrompt(en)
    const ftxt = facts.length
      ? (en ? 'Facts verified by the mycelium (use them, they override your own knowledge):\n' : 'Fakty sprawdzone przez grzybnię (korzystaj z nich, są ważniejsze niż Twoja wiedza):\n') +
        facts.map((d) => `- ${d.text} (${truthTxt(d, en)})`).join('\n') +
        (en ? '\n\nQuestion: ' : '\n\nPytanie: ')
      : ''
    const sent = ftxt + q
    const hist: ChatMsg[] = turns.slice(-6).map((t) => ({ role: t.role, content: t.sent ?? t.text }))
    const msgs: ChatMsg[] = [{ role: 'system', content: sys }, ...hist, { role: 'user', content: sent }]
    setBusy(true)
    setTurns((ts) => [
      ...ts,
      { role: 'user', text: q, sent },
      {
        role: 'assistant',
        text: '',
        mode: viaNode ? 'mesh' : 'local',
        used: facts.length ? (facts as Used[]) : undefined,
        ask,
        act: viaNode ? 'mesh' : 'local',
        lite: r.text,
      },
    ])
    const upd = (f: (t: Turn) => Turn) =>
      setTurns((ts) => {
        const c = [...ts]
        c[c.length - 1] = f(c[c.length - 1])
        return c
      })
    const genReply = viaNode
      ? meshReply(msgs, (text) => upd((t) => ({ ...t, text })))
      : localReply(msgs, (text) => upd((t) => ({ ...t, text }))).then((x) => ({
          ...x,
          mode: 'local' as const,
          route: [] as { node: string }[],
          retries: 0,
        }))
    genReply
      .then((res) => {
        const st =
          res.mode === 'local'
            ? `${res.tokens.length} tok · ${res.tps.toFixed(2)} tok/s · ${en ? 'first token' : 'pierwszy token'} ${(res.firstMs / 1000).toFixed(1)} s · ${en ? 'total' : 'razem'} ${((performance.now() - t0) / 1000).toFixed(1)} s · prompt ${res.promptTokens} tok${res.reused ? ` (${res.reused} ${en ? 'from KV cache' : 'z pamięci K/V'})` : ''} · ${en ? 'in this browser' : 'w tej przeglądarce'} (${localLM.view.backend ?? '?'}${localLM.view.backend === 'wasm' ? ` · ${localLM.view.threads ?? 1} ${en ? 'threads' : 'wątk.'}` : ''})`
            : `${res.tokens.length} tok · ${res.tps.toFixed(2)} tok/s · ${en ? 'first token' : 'pierwszy token'} ${(res.firstMs / 1000).toFixed(1)} s · prompt ${res.promptTokens} tok${res.reused ? ` (${res.reused} ${en ? 'from KV cache' : 'z pamięci K/V'})` : ''} · ${res.mode === 'full' ? (en ? 'whole model on 1 node' : 'cały model na 1 węźle') : `${new Set(res.route.map((x) => x.node)).size} ${en ? 'nodes' : 'węzłów'}`}${res.retries ? ` · failover ×${res.retries}` : ''}`
        // walidacja: liczby w odpowiedzi muszą pochodzić ze źródła (Wikidata / fakty grzybni)
        const srcNums = [...(wd?.nums ?? []), ...facts.flatMap((d) => numbersIn(d.text))]
        const bad = ungroundedNumbers(res.text, q, srcNums)
        let text = res.text
        let check = ''
        if (bad.length && (wd || numericQ)) {
          const fix = qEn ? '(The mycelium model gave a different number – corrected from the source.)' : '(Model grzybni podał inną liczbę – poprawiłam według źródła.)'
          text = wd ? `${groundedSentence(wd, qEn)}\n${fix}` : UNSURE(qEn)
          check = qEn ? ' · unverified number replaced' : ' · niepotwierdzona liczba zastąpiona'
        } else if (wd) text = `${res.text}\n${qEn ? 'Source' : 'Źródło'}: Wikidata ${wd.qid}.`
        else if (thUsed.length)
          text = `${res.text}\n${en ? 'Fragments used' : 'Użyte strzępki'}: ${thUsed
            .slice(0, 2)
            .map((d) => d.source.replace(/^\S+ /, ''))
            .join('; ')}`
        else if (!facts.length) {
          text = `${res.text}\n${en ? '(No source: this is only the small model’s answer and may be untrue.)' : '(Bez źródła: to tylko odpowiedź małego modelu i może być nieprawdziwa.)'}`
          check = en ? ' · no source' : ' · bez źródła'
        }
        upd((t) => ({ ...t, text: text || t.text, sent: res.text, stats: st + check }))
        const md = viaNode ? 'mesh' : 'local'
        void logExchange(dstate.turns, q, text || r.text, md, md, en ? 'en' : 'pl')
        logA(text || r.text, md, md, facts as Used[])
      })
      .catch((e) => {
        upd((t) => ({
          ...t,
          mode: 'lite',
          act: r.act,
          text: r.text,
          offer: r.offer,
          used: r.used,
          stats: `${viaNode ? (en ? 'mycelium model unavailable' : 'model grzybni niedostępny') : en ? 'model in this browser failed' : 'model w przeglądarce zawiódł'}: ${String((e as Error).message ?? e).slice(0, 80)}`,
        }))
        void logExchange(dstate.turns, q, r.text, r.act, 'lite', en ? 'en' : 'pl')
        logA(r.text, r.act, 'lite', r.used)
      })
      .finally(() => setBusy(false))
  }

  const save = (i: number) => {
    const t = turns[i]
    if (!t.offer || t.saved) return
    if (t.offer.kind === 'qa') b.teach('qa', t.offer.text, t.offer.answer)
    else b.teach('fact', t.offer.text, 'tak')
    setTurns((ts) => ts.map((x, j) => (j === i ? { ...x, saved: true } : x)))
  }

  return (
    <>
      <PageHeader title={en ? 'Conversation' : 'Rozmowa'}>
        <L
          pl="Rozmawiaj jak z człowiekiem: pytaj, proś o pomoc, wklej tekst do przeczytania, ucz. Czat zawsze odpowiada. Gdy online są fragmenty całego modelu (co najmniej 3 węzły modelu), odpowiada Qwen2.5-0.5B rozłożony na węzły grzybni. Inaczej działa tryb lekki – w Twojej przeglądarce, bez pobierania modelu i bez chmury: fakty potwierdzone głosowaniem, słowniki, Wikisłownik, kalkulator, czytanie tekstu. Gdy czegoś nie wie, mówi „nie wiem, naucz mnie”."
          en="Talk like with a person: ask, ask for help, paste text to read, teach. The chat always replies. When shards of the whole model are online (at least 3 model nodes), Qwen2.5-0.5B split across mycelium nodes answers. Otherwise lightweight mode runs – in your browser, no model download, no cloud: vote-confirmed facts, dictionaries, Wiktionary, a calculator, text reading. When it doesn't know, it says “I don't know, teach me”."
        />
      </PageHeader>
      {!mv.full && <LocalCard lv={lv} en={en} />}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="chat-mode">
          {mv.full ? (
            <span className="chip border-spore/40 text-spore">{en ? 'mycelium model online · lightweight mode as fallback' : 'model grzybni online · tryb lekki jako zapas'}</span>
          ) : lv.status === 'ready' ? (
            <span className="chip border-spore/40 text-spore">
              {en ? `no model nodes · mycelium model LM v${lv.version} runs in this browser` : `brak węzłów modelu · model grzybni LM v${lv.version} działa w tej przeglądarce`}
            </span>
          ) : (
            <span className="chip border-amber/30 text-amber">{en ? 'lightweight mode · in this browser' : 'tryb lekki · w tej przeglądarce'}</span>
          )}
          <span className="text-slate-400">
            {en ? 'Knowledge' : 'Wiedza'}: {docs.filter((d) => d.votes > 0).length} {en ? 'voted facts' : 'faktów z głosowania'} · {b.lex?.words.length ?? 0}{' '}
            {en ? 'dictionary words' : 'słów w słowniku'}
          </span>
          <span data-testid="neural">
            {nn.status === 'ready' ? (
              <span className="chip border-spore/30 text-spore">
                {en ? 'mycelium models on' : 'modele grzybni włączone'}: {en ? 'intent' : 'intencje'} v{nn.versions.intent?.version ?? '–'} · {en ? 'words' : 'słowa'} v
                {nn.versions.words?.version ?? '–'} · {en ? 'semantic search' : 'wyszukiwanie semantyczne'}
              </span>
            ) : nn.status === 'loading' ? (
              <span className="text-xs text-slate-400">
                {en ? 'Loading models' : 'Ładuję modele'}… {Math.round(nn.progress * 100)}%
              </span>
            ) : (
              <button onClick={() => void neural.enable()} className="rounded-lg border border-spore/40 px-2 py-1 text-xs text-spore" title={nn.error}>
                {nn.status === 'error'
                  ? en
                    ? 'Models failed – retry'
                    : 'Modele nie wczytały się – ponów'
                  : en
                    ? 'Use mycelium models (~140 MB download, once)'
                    : 'Użyj modeli grzybni (~140 MB, jednorazowo)'}
              </button>
            )}
          </span>
          <label className="ml-auto flex items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => {
                chatConsent.set(e.target.checked)
                setConsent(e.target.checked)
              }}
              data-testid="chat-consent"
            />
            {en ? 'Save my chats anonymously as training data (do not paste private data)' : 'Zapisuj moje rozmowy anonimowo jako dane do nauki (nie wklejaj danych prywatnych)'}
          </label>
          <label className="flex w-full items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={train}
              onChange={(e) => {
                trainConsent.set(e.target.checked)
                setTrain(e.target.checked)
              }}
              data-testid="train-consent"
            />
            {en
              ? 'Send each answer to Verify for review (question without e-mails, links, phone numbers or names; untick = nothing is sent)'
              : 'Wysyłaj każdą odpowiedź do sprawdzenia w Weryfikuj (pytanie bez e-maili, linków, telefonów i imion; odznacz = nic nie jest wysyłane)'}
            <span className="ml-auto text-slate-500" data-testid="knowledge-count">
              {en ? 'Knowledge memory' : 'Pamięć wiedzy'}: {kItems === undefined ? '…' : know.items.length} {en ? 'approved entries' : 'zatwierdzonych wpisów'}
            </span>
          </label>
        </div>
      </Card>

      <MeshCard mv={mv} en={en} />

      <Card>
        <div className="max-h-[60vh] min-h-48 space-y-3 overflow-y-auto pr-1" data-testid="chat-log">
          {turns.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <LogoMark size={52} className="logo-live drop-shadow-[0_0_24px_rgb(94_234_212/0.3)]" />
              <p className="max-w-md text-sm text-slate-400">
                {en
                  ? 'Say hi, ask “Is Riga the capital of Latvia?”, “what is a wombat?”, “what is 15% of 240?”, or paste a paragraph.'
                  : 'Przywitaj się, zapytaj „Czy Ryga jest stolicą Łotwy?”, „co to jest wombat?”, „ile to 15% z 240?” albo wklej akapit tekstu.'}
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {(en ? ['Is Riga the capital of Latvia?', 'what is a wombat?', 'what is 15% of 240?'] : ['Czy Ryga jest stolicą Łotwy?', 'co to jest wombat?', 'ile to 15% z 240?']).map((q) => (
                  <button key={q} type="button" onClick={() => setInput(q)} className="chip border-spore/25 px-3 py-1.5 text-slate-200 hover:border-spore/50 hover:bg-spore/10">
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={t.role === 'user' ? 'ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-gradient-to-br from-spore/20 to-sky/10 px-3.5 py-2.5 text-sm text-slate-50 ring-1 ring-spore/20' : 'max-w-[95%] rounded-2xl rounded-bl-md bg-white/[0.03] px-3.5 py-2.5 ring-1 ring-white/[0.06]'}>
              {t.role === 'user' && (
                <>
                  {t.text}
                  {detectLang(t.text) !== 'en' && <RozbiorTable text={t.text} en={en} />}
                </>
              )}
              {t.role === 'assistant' && (
                <>
                  <div className="mb-1 text-xs" data-testid="answer-path" data-path={t.mode === 'mesh' ? 'node' : 'browser'}>
                    <span className={`chip mr-2 ${t.mode === 'mesh' ? 'border-spore/40 text-spore' : 'border-sky-400/40 text-sky-300'}`}>
                      {t.mode === 'mesh' ? (en ? 'answered by: node' : 'odpowiada: węzeł') : en ? 'answered by: browser' : 'odpowiada: przeglądarka'}
                    </span>
                    {t.mode === 'local' ? (
                      <span className="chip border-spore/40 text-spore" data-testid="local-label">
                        {en
                          ? `mycelium model LM v${lv.version ?? '?'} · ${MODEL.id.split('/')[1]} + LoRA in this browser`
                          : `model grzybni LM v${lv.version ?? '?'} · ${MODEL.id.split('/')[1]} + LoRA w tej przeglądarce`}
                      </span>
                    ) : t.mode === 'mesh' ? (
                      <span className="chip border-spore/40 text-spore" data-testid="mesh-label">
                        {en ? `mycelium model · ${MODEL.id.split('/')[1]} on nodes` : `model grzybni · ${MODEL.id.split('/')[1]} na węzłach`}
                      </span>
                    ) : (
                      <span className="chip border-amber/30 text-amber" data-testid="lite-label">
                        {en ? 'lightweight mode' : 'tryb lekki'}
                      </span>
                    )}
                    <span className="ml-2 text-slate-500" data-testid="turn-stats">
                      {t.stats ?? `${t.act} · ${t.ms !== undefined ? `${t.ms.toFixed(1)} ms` : ''}`}
                    </span>
                    {t.pending && (
                      <span className="chip ml-2 border-violet/40 text-violet" data-testid="meaning-pending">
                        {t.pending}
                      </span>
                    )}
                  </div>
                  <div className="whitespace-pre-wrap text-[0.95rem] leading-relaxed text-slate-100" data-testid="reply">
                    {t.text ||
                      (busy && i === turns.length - 1
                        ? t.mode === 'local'
                          ? en
                            ? 'the mycelium is thinking in this browser…'
                            : 'grzybnia myśli w tej przeglądarce…'
                          : en
                            ? 'the mycelium is thinking… (prefill through all nodes)'
                            : 'grzybnia myśli… (przejście przez wszystkie węzły)'
                        : '')}
                  </div>
                  {t.used && t.used.length > 0 && (
                    <details className="mt-1 text-xs text-slate-400">
                      <summary className="cursor-pointer">{en ? `Sources (${t.used.length})` : `Źródła (${t.used.length})`}</summary>
                      <ol className="mt-1 space-y-0.5" data-testid="used-facts">
                        {t.used.map((d, j) => (
                          <li key={d.id}>
                            [{j + 1}] {d.text} — <b className={d.p >= FACT_CONF ? 'text-spore' : 'text-amber'}>{truthTxt(d, en)}</b>
                            {d.votes > 0 && ` ${Math.round(d.p * 100)}%`} · {d.votes} {en ? 'votes' : 'głosów'} ·{' '}
                            {d.url ? (
                              <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-spore underline" data-testid="source-link">
                                {d.source}
                              </a>
                            ) : (
                              d.source
                            )}
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                  {t.offer && (
                    <button
                      disabled={t.saved}
                      onClick={() => save(i)}
                      className="mt-2 rounded-full border border-violet/40 px-3 py-1 text-xs font-medium text-violet hover:bg-violet/10 disabled:opacity-60"
                      data-testid="chat-save"
                    >
                      {t.saved
                        ? en
                          ? '✓ saved – waiting for votes'
                          : '✓ zapisane – czeka na głosy'
                        : t.offer.kind === 'qa'
                          ? en
                            ? 'Save this answer to verify'
                            : 'Zapisz tę odpowiedź do weryfikacji'
                          : en
                            ? 'Save as a fact to verify'
                            : 'Zapisz jako fakt do weryfikacji'}
                    </button>
                  )}
                  {t.ask && !answered.has(t.ask.id) && (
                    <div className="mt-2 rounded-xl border border-violet/30 p-2 text-sm" data-testid="chat-question">
                      <span className="text-violet">{en ? 'Help me learn – is this true?' : 'Pomóż mi się nauczyć – czy to prawda?'}</span> {t.ask.text}
                      <div className="mt-1 flex gap-2">
                        <button className="rounded-lg border border-white/10 px-3 py-1 hover:border-spore/40" onClick={() => b.answer(t.ask!.id, 'tak')}>
                          {en ? 'Yes' : 'Tak'}
                        </button>
                        <button className="rounded-lg border border-white/10 px-3 py-1 hover:border-rose/40" onClick={() => b.answer(t.ask!.id, 'nie')}>
                          {en ? 'No' : 'Nie'}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
          <div ref={endRef} />
        </div>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
        >
          <textarea
            value={input}
            rows={input.length > 80 ? 4 : 1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            maxLength={4000}
            placeholder={en ? 'Type a message… (Shift+Enter = new line)' : 'Napisz wiadomość… (Shift+Enter = nowa linia)'}
            className="w-full resize-y rounded-2xl border border-white/10 bg-black/30 px-3.5 py-2.5 text-[0.95rem] placeholder:text-slate-500"
            data-testid="chat-input"
          />
          <button disabled={busy} className="btn-primary shrink-0 px-4 font-semibold disabled:opacity-50" data-testid="chat-send">
            {en ? 'Send' : 'Wyślij'} <Icon name="arrow" size={15} />
          </button>
        </form>
      </Card>
    </>
  )
}

function MeshCard({ mv, en }: { mv: MeshView; en: boolean }) {
  const [cap, setCap] = useState(2)
  const local = mv.local
  const serving = !!local && local.cap > 0 && Object.keys(local.shards).length > 0
  return (
    <Card className="mb-4" title={en ? 'The mycelium as one language model' : 'Grzybnia jako jeden model językowy'}>
      <p className="mb-2 text-xs text-slate-400">
        {en
          ? `${MODEL.id} (${MODEL.license}) cut into ${SHARDS.length} fragments: 8 × 3 layers (~90 MB) and 4 parts of the vocabulary (~68 MB). Each node downloads only its fragments straight from Hugging Face; a reply flows through the nodes (WebRTC). The full model needs all ${SHARDS.length} fragments online – at least ${Math.ceil(SHARDS.length / 4)} nodes holding 4 fragments each (or ${Math.ceil(SHARDS.length / 2)} with 2). Until then, the lightweight mode answers.`
          : `${MODEL.id} (${MODEL.license}) pocięty na ${SHARDS.length} fragmentów: 8 × 3 warstwy (~90 MB) i 4 części słownika (~68 MB). Każdy węzeł pobiera tylko swoje fragmenty prosto z Hugging Face; odpowiedź płynie przez węzły (WebRTC). Pełny model wymaga wszystkich ${SHARDS.length} fragmentów online – co najmniej ${Math.ceil(SHARDS.length / 4)} węzłów po 4 fragmenty (albo ${Math.ceil(SHARDS.length / 2)} po 2). Do tego czasu odpowiada tryb lekki.`}
      </p>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-sm" data-testid="mesh-status" data-ready={mv.ready} data-full={mv.full ? '1' : '0'}>
        <span className={mv.connected ? 'text-spore' : 'text-slate-500'}>{mv.connected ? (en ? '● connected' : '● połączono') : en ? '○ connecting…' : '○ łączenie…'}</span>
        <span>
          {en ? 'fragments online' : 'fragmenty online'}:{' '}
          <b className="tabular-nums">
            {mv.ready}/{mv.total}
          </b>
        </span>
        <span>
          {en ? 'model nodes' : 'węzły modelu'}: <b className="tabular-nums">{mv.nodes}</b>
        </span>
        {mv.tps !== undefined && (
          <span>
            {en ? 'last reply' : 'ostatnia odpowiedź'}: <b className="tabular-nums">{mv.tps.toFixed(2)} tok/s</b>
          </span>
        )}
        {local && (
          <span className="text-slate-400">
            {en ? 'this browser serves' : 'ta przeglądarka obsłużyła'} {mv.served} {en ? 'requests' : 'żądań'} · {local.backend}
          </span>
        )}
      </div>
      <div className="mb-2 grid grid-cols-6 gap-1 sm:grid-cols-12" data-testid="mesh-shards">
        {SHARDS.map((s) => {
          const hs = mv.shards[s] ?? []
          const ready = hs.filter((h) => h.state === 'ready').length
          const loading = hs.length - ready
          const mine = local?.shards[s]
          return (
            <div
              key={s}
              title={hs.map((h) => `${h.node.slice(0, 6)} ${h.state} ${h.link}`).join('\n')}
              className={`rounded-lg border px-1 py-1 text-center text-xs ${ready ? 'border-spore/50 text-spore' : loading ? 'border-amber/40 text-amber' : 'border-white/10 text-slate-500'}`}
            >
              <div className="font-mono">{s}</div>
              <div className="tabular-nums">
                {ready}
                {loading ? `+${loading}` : ''}
              </div>
              {mine && mine.state === 'loading' && <div className="tabular-nums text-[10px]">{Math.round(mine.loaded / 1e6)} MB</div>}
            </div>
          )
        })}
      </div>
      {mv.lastRoute && (
        <p className="mb-2 font-mono text-[11px] text-slate-400" data-testid="mesh-route">
          {en ? 'route' : 'trasa'}: {mv.lastRoute.map((r) => `${r.shard}@${r.node.slice(0, 4)}${r.link === 'relay' ? '*' : ''}`).join(' → ')}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {!serving ? (
          <>
            <select
              value={cap}
              onChange={(e) => setCap(Number(e.target.value))}
              className="rounded-lg border border-white/10 bg-ink/60 px-2 py-1 text-sm"
              aria-label={en ? 'Fragments' : 'Fragmenty'}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n} {en ? 'fragment(s)' : n === 1 ? 'fragment' : 'fragmenty'} (~{n * 90} MB, RAM ~{n * 180} MB)
                </option>
              ))}
            </select>
            <button className="rounded-xl bg-spore/90 px-3 py-1.5 font-medium text-ink hover:bg-spore" onClick={() => void mesh.serve(cap)} data-testid="mesh-join">
              {en ? 'Become a model node' : 'Zostań węzłem modelu'}
            </button>
            <span className="text-xs text-slate-500">
              {en ? 'downloads only your fragments, works while this tab is open' : 'pobiera tylko Twoje fragmenty, działa, gdy karta jest otwarta'}
            </span>
          </>
        ) : (
          <button className="rounded-xl border border-white/10 px-3 py-1.5 text-sm hover:border-rose/40" onClick={() => mesh.stop()} data-testid="mesh-leave">
            {en ? 'Stop being a model node' : 'Przestań być węzłem modelu'}
          </button>
        )}
      </div>
    </Card>
  )
}

function LocalCard({ lv, en }: { lv: LocalView; en: boolean }) {
  const mb = (b: number) => Math.round(b / 1e6)
  return (
    <Card className="mb-4">
      <div data-testid="local-lm" data-status={lv.status}>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <b>{en ? 'Mycelium model in this browser' : 'Model grzybni w tej przeglądarce'}</b>
          {lv.status === 'ready' ? (
            <>
              <span className="chip border-spore/40 text-spore" data-testid="local-ready">
                LM v{lv.version ?? '?'} · {lv.backend}
                {lv.backend === 'wasm' ? ` · ${lv.threads ?? 1} ${en ? (lv.threads === 1 ? 'thread' : 'threads') : 'wątk.'}` : ''} · {en ? 'ready' : 'gotowy'}
                {lv.loadMs ? ` · ${(lv.loadMs / 1000).toFixed(0)} s` : ''}
                {lv.warmMs ? ` · prompt ${(lv.warmMs / 1000).toFixed(1)} s` : ''}
              </span>
              <button className="text-xs text-slate-400 underline" onClick={() => localLM.forget()}>
                {en ? 'turn off and free disk' : 'wyłącz i zwolnij dysk'}
              </button>
            </>
          ) : lv.status === 'loading' ? (
            <span className="tabular-nums text-slate-300" data-testid="local-progress">
              {en ? 'loading' : 'wczytuję'} {lv.shards}/12 · {mb(lv.loaded)} / ~{LOCAL_MB} MB
            </span>
          ) : (
            <button className="rounded-xl bg-spore/90 px-3 py-1.5 font-medium text-ink hover:bg-spore" onClick={() => void localLM.start()} data-testid="local-start">
              {lv.status === 'error' ? (en ? 'Retry' : 'Ponów') : en ? `Run it here (~${LOCAL_MB} MB once)` : `Uruchom tutaj (~${LOCAL_MB} MB jednorazowo)`}
            </button>
          )}
          {lv.err && <span className="text-xs text-rose">{lv.err}</span>}
        </div>
        <p className="mt-1 text-xs text-slate-400">
          {en
            ? `No node holds the whole model right now, so the chat can generate in your browser: ${MODEL.id} (${MODEL.license}) with the latest verified mycelium adapter (LoRA${lv.acc !== undefined ? `, test ${(lv.acc * 100).toFixed(2)}%` : ''}${lv.ppl ? `, perplexity ${Number(lv.ppl).toFixed(2)}` : ''}). Weights come straight from Hugging Face, are kept in the browser cache and need ~0.6 GB of RAM – best on a computer. This browser does not become a node. Facts still come only from sources, otherwise “I don't know”.`
            : `Żaden węzeł nie ma teraz całego modelu, więc czat może generować w Twojej przeglądarce: ${MODEL.id} (${MODEL.license}) z najnowszym zweryfikowanym adapterem grzybni (LoRA${lv.acc !== undefined ? `, test ${(lv.acc * 100).toFixed(2)}%` : ''}${lv.ppl ? `, perpleksja ${Number(lv.ppl).toFixed(2)}` : ''}). Wagi pobierane prosto z Hugging Face, zostają w pamięci przeglądarki, potrzeba ok. 0,6 GB RAM – najlepiej na komputerze. Przeglądarka nie staje się węzłem. Fakty dalej tylko ze źródeł, inaczej „nie wiem”.`}
        </p>
      </div>
    </Card>
  )
}
