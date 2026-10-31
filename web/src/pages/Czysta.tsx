// Zakładka „Czysta grzybnia”: odpowiada tylko to, czego grzybnia nauczyła się sama albo co zatwierdzili ludzie –
// bez modelu językowego, bez Wikipedii/Wikidata, bez zewnętrznych modeli (docs/czysta-grzybnia.md).
import { useEffect, useMemo, useState } from 'react'
import { Card, Kpi, PageHeader, Src, Bar } from '../components/ui'
import { POS_COLOR } from '../components/RozbiorTable'
import { POS_PL, type Analysis } from '../myc/rozbior'
import { ensureRozbior, parseSentence, approvedParses, useRozbior, RB_LICENCE } from '../myc/rozbiorLive'
import { FACT_CONF, useBrain } from '../myc/brain'
import { logAnswer, scrub, trainConsent, voteAnswer } from '../myc/answers'
import { speakerState, type SpkState } from '../myc/speaker'
import { ANT, DROP_LEM, Q_PL, Q_WORDS, SQUARE, WRAP } from '../myc/czysta'
import { answerPure, buildKB, fromDocs, loadHumanRows, looksLikeRule, HUMAN_SOURCES, type PureAnswer, type PureKB } from '../myc/czystaWiedza'
import { LEARN_RULES } from '../myc/czystaZasady'
import { useI18n } from '../i18n'

interface Wyniki {
  when: string
  model: string
  logic: { n: number; correct: number; abstain: number; acc: number; per_category: Record<string, { n: number; correct: number; abstain: number; acc: number }> }
  chat_facts: { n: number; correct: number; abstain: number; wrong: number }
  python_same: boolean | null
}
const pct = (x: number) => `${(x * 100).toFixed(1).replace('.', ',')}%`
const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Amsterdam' }) : '–')
const SRC_PL: Record<string, string> = { logika: 'rozumowanie z ról zdania', para: 'para pytanie → odpowiedź od ludzi', fakt: 'fakt zatwierdzony przez ludzi', brak: 'nie wiem' }

/** przykłady wejścia (nie dane) – po jednym na każdy rodzaj rozumowania */
const EXAMPLES = [
  'Jeśli pada deszcz, to ulica jest mokra. Ulica nie jest mokra. Czy pada deszcz?',
  'Wszystkie wróble są ptakami. Kazik jest wróblem. Czy Kazik jest ptakiem?',
  'Niektóre koty są czarne. Czy wszystkie koty są czarne?',
  'Ala dała Adamowi książkę. Komu Ala dała książkę?',
  'Ewa napisała list. Czy Ewa skończyła tę czynność?',
  'Jaka jest stolica Polski?',
]

export default function Czysta() {
  const b = useBrain()
  const rb = useRozbior()
  const { lang } = useI18n()
  const en = lang === 'en'
  const [rows, setRows] = useState<Awaited<ReturnType<typeof loadHumanRows>> | undefined>()
  const [rowsErr, setRowsErr] = useState<string>()
  const [q, setQ] = useState('')
  const [res, setRes] = useState<PureAnswer>()
  const [askN, setAskN] = useState(0)
  const [logged, setLogged] = useState<number | 'optout' | 'rate' | 'err' | undefined>()
  const [fb, setFb] = useState<string>()
  const [corr, setCorr] = useState('')
  const [fact, setFact] = useState('')
  const [factMsg, setFactMsg] = useState<string>()
  const [consent, setConsent] = useState(trainConsent.get())
  const [wyniki, setWyniki] = useState<Wyniki | null | undefined>()
  const [parsesOk, setParsesOk] = useState<number | null | undefined>()
  const [spk, setSpk] = useState<SpkState | null | undefined>()

  useEffect(() => {
    void ensureRozbior()
    loadHumanRows().then(setRows, (e: Error) => setRowsErr(e.message))
    fetch(`${import.meta.env.BASE_URL}data/czysta/wyniki.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Wyniki>) : null))
      .then(setWyniki, () => setWyniki(null))
    approvedParses().then(setParsesOk, () => setParsesOk(null))
    speakerState().then(setSpk, () => setSpk(null))
  }, [])
  const docs = useMemo(() => fromDocs(b.factDocs(false), FACT_CONF), [b, b.version]) // eslint-disable-line react-hooks/exhaustive-deps
  const kb: PureKB | undefined = useMemo(() => (rows ? buildKB(rows, docs) : undefined), [rows, docs])
  const nRules = kb ? kb.facts.filter((f) => looksLikeRule(f.text)).length : 0
  const lastAt = kb ? [...kb.facts, ...kb.qa].map((x) => x.at ?? '').sort().pop() : undefined

  const ask = (text: string) => {
    if (!text.trim() || rb.status !== 'ready') return
    const r = answerPure(text, parseSentence, kb)
    setRes(r)
    setAskN((n) => n + 1)
    setFb(undefined)
    setCorr('')
    setLogged(undefined)
    if (!trainConsent.get()) return setLogged('optout')
    const answer = r.answer ?? `nie wiem, bo ${r.missing[0] ?? 'brakuje danych'}`
    logAnswer({
      question: r.input,
      answer: answer.slice(0, 2000),
      sources: r.used.slice(0, 8).map((u) => ({ kind: 'fakt', title: ('text' in u ? u.text : `${u.q} → ${u.a}`).slice(0, 200) })),
      conf: r.conf,
      topic: r.method ?? 'brak',
      category: 'czysta grzybnia',
      intent: 'pytanie',
      register: 'neutralne',
      act: 'czysta',
      mode: 'lite',
    }).then(
      (x) => setLogged(x.logged ? x.id : x.reason === 'rate' ? 'rate' : 'optout'),
      () => setLogged('err'),
    )
  }
  const vote = async (v: 'confirm' | 'disagree' | 'correct') => {
    if (!res) return
    if (!trainConsent.get()) return setFb('Nauka wyłączona na tym urządzeniu – nic nie zapisuję.')
    if (v === 'correct' && !corr.trim()) return setFb('Wpisz poprawną odpowiedź.')
    const asPair = () => {
      b.teach('qa', res.input, scrub(corr.trim()).slice(0, 200))
      setFb('Poprawka trafiła do Ucz AI jako para „pytanie → odpowiedź”. Stanie się wiedzą, gdy zatwierdzą ją inni (konsensus ≥ 80%).')
    }
    if (typeof logged !== 'number') return v === 'correct' ? asPair() : setFb('Ta odpowiedź nie jest zapisana w Weryfikuj (nauka wyłączona albo limit) – głos nie ma do czego trafić.')
    try {
      const r = await voteAnswer(logged, v, v === 'correct' ? scrub(corr.trim()).slice(0, 600) : undefined)
      if (r.ok) setFb(r.voter === 'owner' ? 'Zapisane – głos właścicielki rozstrzyga od razu.' : `Zapisane w Weryfikuj (głosów: ${r.votes ?? 1}). Decyzja zapada przy ≥ 3 głosach i pewności ≥ 95%.`)
      else if (r.reason === 'own') {
        if (v === 'correct') asPair()
        else setFb('Na odpowiedź na własne pytanie nie głosujesz – czeka w Weryfikuj na ocenę innych osób.')
      }
      else setFb(`Nie zapisano (${r.reason ?? 'błąd'}).`)
    } catch (e) {
      setFb(`Nie zapisano: ${(e as Error).message}`)
    }
  }
  const addFact = () => {
    const t = scrub(fact.trim())
    if (t.length < 6) return setFactMsg('Za krótkie – napisz pełne zdanie.')
    if (/\?\s*$/.test(t)) return setFactMsg('Fakt albo reguła to zdanie oznajmujące (bez „?”).')
    if (!trainConsent.get()) return setFactMsg('Nauka wyłączona na tym urządzeniu – nic nie zapisuję.')
    b.teach('fact', t.replace(/([^.!])$/, '$1.'), 'tak')
    setFact('')
    setFactMsg(`Dodane do Ucz AI → Weryfikuj jako ${looksLikeRule(t) ? 'reguła' : 'fakt'}. Czysta grzybnia użyje go, gdy konsensus da ≥ ${Math.round(FACT_CONF * 100)}%.`)
  }

  return (
    <>
      <PageHeader title={en ? 'Pure mycelium' : 'Czysta grzybnia'}>
        {en
          ? 'Only what the mycelium learned itself or what people approved answers here – no language model, no Wikipedia/Wikidata, no external model. Every answer shows its reasoning.'
          : 'Tu odpowiada wyłącznie to, czego grzybnia nauczyła się sama albo co zatwierdzili ludzie – bez modelu językowego, bez Wikipedii i Wikidata, bez żadnego zewnętrznego modelu. Każda odpowiedź pokazuje tok rozumowania.'}
      </PageHeader>
      <div className="mb-4 flex flex-wrap gap-1.5 text-[11px]" data-testid="czysta-chips">
        <span className="chip border-spore/30 text-spore">bez modelu językowego</span>
        <span className="chip border-spore/30 text-spore">bez Wikipedii / Wikidata</span>
        <span className="chip border-spore/30 text-spore">wiedza tylko od ludzi</span>
        <span className="chip border-amber/30 text-amber">słownik odmiany: Morfeusz 2 / SGJP + Walenty</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="min-w-0 space-y-4">
          <Card title="Zapytaj">
            <form
              onSubmit={(e) => {
                e.preventDefault()
                ask(q)
              }}
            >
              <textarea
                data-testid="czysta-input"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    ask(q)
                  }
                }}
                rows={3}
                placeholder="Np. przesłanki i pytanie: „Jeśli pada deszcz, to ulica jest mokra. Pada deszcz. Czy ulica jest mokra?”"
                className="w-full resize-y rounded-xl border border-white/10 bg-ink/40 px-3 py-2.5 text-base text-slate-100 placeholder:text-slate-500 sm:text-sm"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button type="submit" className="btn-primary min-h-11" data-testid="czysta-ask" disabled={rb.status !== 'ready'}>
                  Zapytaj
                </button>
                <span className="text-xs text-slate-500" data-testid="czysta-model">
                  {rb.status === 'ready' && rb.row
                    ? `rozbiór: model grzybni ${rb.variant === 'pdb' ? `v${rb.row.version}` : 'LFG'} (${RB_LICENCE[rb.variant].data}, ${RB_LICENCE[rb.variant].licence})`
                    : rb.status === 'none'
                      ? 'brak opublikowanego modelu rozbioru – czysta grzybnia nie może odpowiadać'
                      : rb.status === 'error'
                        ? `model rozbioru nie wczytany: ${rb.error}`
                        : 'wczytuję model rozbioru (ok. 4 MB)…'}
                </span>
              </div>
            </form>
            <div className="no-scrollbar -mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
              {EXAMPLES.map((x) => (
                <button key={x} type="button" className="chip shrink-0 whitespace-nowrap text-slate-300 hover:border-spore/40" onClick={() => (setQ(x), ask(x))}>
                  {x.length > 46 ? x.slice(0, 44) + '…' : x}
                </button>
              ))}
            </div>
          </Card>

          {res && <AnswerCard n={askN} r={res} logged={logged} fb={fb} corr={corr} setCorr={setCorr} vote={vote} />}

          <Card title="Naucz ją faktu albo reguły">
            <p className="mb-2 text-sm text-slate-400">
              Jedno zdanie oznajmujące. Reguły piszesz zwykłym zdaniem: „Jeśli …, to …”, „Wszystkie X są Y”, „Żaden X nie …”. Trafia do <b>Ucz AI → Weryfikuj</b>; czysta grzybnia użyje go dopiero po zatwierdzeniu przez innych.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                data-testid="czysta-fact"
                value={fact}
                onChange={(e) => setFact(e.target.value)}
                placeholder="Np. Jeśli woda ma poniżej zera stopni, to woda zamarza."
                className="min-h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-ink/40 px-3 text-base text-slate-100 placeholder:text-slate-500 sm:text-sm"
              />
              <button type="button" className="btn-ghost min-h-11" onClick={addFact} data-testid="czysta-fact-add">
                Dodaj do Weryfikuj
              </button>
            </div>
            {factMsg && <p className="mt-2 text-sm text-slate-300" data-testid="czysta-fact-msg">{factMsg}</p>}
            <label className="mt-3 flex items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => {
                  trainConsent.set(e.target.checked)
                  setConsent(e.target.checked)
                }}
              />
              Używaj moich pytań, ocen i faktów do nauki (to urządzenie; bez danych osobowych – e-maile, telefony, imiona są wycinane)
            </label>
          </Card>
        </div>

        <aside className="min-w-0 space-y-4">
          <Stats kb={kb} rowsErr={rowsErr} nRules={nRules} lastAt={lastAt} parsesOk={parsesOk} spk={spk} />
        </aside>
      </div>

      <Scores w={wyniki} />
      <Explain kb={kb} />
    </>
  )
}

function AnswerCard({ n, r, logged, fb, corr, setCorr, vote }: { n: number; r: PureAnswer; logged: number | 'optout' | 'rate' | 'err' | undefined; fb?: string; corr: string; setCorr: (s: string) => void; vote: (v: 'confirm' | 'disagree' | 'correct') => void }) {
  const known = r.answer != null
  return (
    <section className="card card-glow fade-up" data-testid="czysta-result" data-n={n} data-source={r.source}>
      <div className="eyebrow mb-1">Odpowiedź</div>
      <p className={`font-display text-2xl font-semibold ${known ? 'text-glow' : 'text-amber'}`} data-testid="czysta-answer">
        {known ? r.answer : 'nie wiem'}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
        <span className={`chip ${known ? 'border-spore/30 text-spore' : 'border-amber/30 text-amber'}`} data-testid="czysta-source">
          {SRC_PL[r.source]}
        </span>
        {r.method && <span className="chip text-slate-300">{r.method}</span>}
        <span className="text-slate-500">{r.ms.toFixed(0)} ms</span>
      </div>
      {known && (
        <div className="mt-2 max-w-xs">
          <div className="mb-1 text-[11px] text-slate-400">pewność {pct(r.conf)} (pewność rozbioru{r.used.length ? ' × zgoda ludzi' : ''})</div>
          <Bar value={r.conf} />
        </div>
      )}
      {!known && (
        <div className="mt-2 rounded-xl border border-amber/20 bg-amber/[0.06] p-3 text-sm text-slate-200" data-testid="czysta-why">
          <b>Nie wiem, bo:</b>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {[...new Set(r.missing)].map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <details className="mt-3" open>
        <summary className="cursor-pointer text-sm font-medium text-slate-200">Tok rozumowania ({r.trace.length} kroków)</summary>
        <ol className="mt-2 space-y-1 text-sm" data-testid="czysta-trace">
          {r.trace.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className={`chip h-fit shrink-0 text-[10px] ${s.kind === 'brak' ? 'border-amber/30 text-amber' : s.kind === 'wniosek' ? 'border-spore/30 text-spore' : 'text-slate-400'}`}>{s.kind}</span>
              <span className="min-w-0 break-words text-slate-300">{s.text}</span>
            </li>
          ))}
        </ol>
      </details>

      {r.used.length > 0 && (
        <div className="mt-3 text-sm">
          <div className="eyebrow mb-1">Użyta wiedza (zatwierdzona przez ludzi)</div>
          <ul className="space-y-1">
            {r.used.map((u) => (
              <li key={u.id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-1">
                <span className="text-slate-200">{'text' in u ? `${u.text}${u.truth === 'nie' ? ' – NIEPRAWDA' : ''}` : `${u.q} → ${u.a}`}</span>
                <Src>
                  {u.source} · pewność {pct(u.p)}
                </Src>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium text-slate-200">Rozbiór zdań (kto / co / komu / gdzie / jak)</summary>
        <div className="mt-2 space-y-3">
          {r.parses.map((p, k) => (
            <ParseTable key={k} s={p.s} a={p.a} conf={p.conf} />
          ))}
        </div>
      </details>

      <div className="mt-4 border-t border-white/[0.06] pt-3">
        <div className="eyebrow mb-2">Oceń albo popraw</div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost min-h-11" onClick={() => vote('confirm')} data-testid="czysta-ok">
            ✓ Dobrze
          </button>
          <button type="button" className="btn-ghost min-h-11" onClick={() => vote('disagree')} data-testid="czysta-bad">
            ✗ Źle
          </button>
        </div>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input value={corr} onChange={(e) => setCorr(e.target.value)} placeholder="Poprawna odpowiedź" className="min-h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-ink/40 px-3 text-base sm:text-sm" />
          <button type="button" className="btn-ghost min-h-11" onClick={() => vote('correct')}>
            Popraw
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500" data-testid="czysta-logged">
          {logged === undefined
            ? 'zapisuję w Weryfikuj…'
            : logged === 'optout'
              ? 'Nauka wyłączona na tym urządzeniu – pytanie i odpowiedź nie są nigdzie zapisane.'
              : logged === 'rate'
                ? 'Limit 10 zapisów na minutę – ta odpowiedź nie trafiła do Weryfikuj.'
                : logged === 'err'
                  ? 'Nie udało się zapisać w Weryfikuj (baza nie odpowiada).'
                  : `Odpowiedź #${logged} czeka w Weryfikuj na ocenę ludzi (bez danych osobowych).`}
        </p>
        {fb && <p className="mt-1 text-sm text-slate-200" data-testid="czysta-fb">{fb}</p>}
      </div>
    </section>
  )
}

function ParseTable({ s, a, conf }: { s: string; a: Analysis; conf: number }) {
  const T = a.tokens.filter((t) => t.upos !== 'PUNCT')
  const head = (i: number) => (i ? a.tokens[i - 1]?.form : 'KORZEŃ')
  return (
    <div className="rounded-xl border border-white/[0.06] bg-ink/30 p-2" data-testid="czysta-parse">
      <p className="mb-1 text-xs text-slate-400">
        „{s}” · pewność {pct(conf)}
      </p>
      <ol className="space-y-1 sm:hidden">
        {T.map((t) => (
          <li key={t.i} className="rounded-md border border-white/[0.05] px-2 py-1 text-xs">
            <b className="text-slate-100">{t.form}</b> {t.lemma && t.lemma.toLowerCase() !== t.form.toLowerCase() && <span className="text-slate-500">({t.lemma})</span>}{' '}
            <span className={`chip ${POS_COLOR[t.upos] ?? ''}`}>{POS_PL[t.upos] ?? t.upos}</span>
            <div className="text-slate-300">
              {t.part ?? '–'}
              {t.q && <span className="text-spore"> · {t.q.toLowerCase()}?</span>} <span className="text-slate-500">→ {head(t.head)}</span>
            </div>
          </li>
        ))}
      </ol>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-left text-xs">
          <thead className="text-slate-500">
            <tr>
              <th className="py-1 pr-2">słowo</th>
              <th className="pr-2">lemat</th>
              <th className="pr-2">część mowy</th>
              <th className="pr-2">część zdania</th>
              <th className="pr-2">pytanie</th>
              <th>zależy od</th>
            </tr>
          </thead>
          <tbody>
            {T.map((t) => (
              <tr key={t.i} className="border-t border-white/[0.04]">
                <td className="py-1 pr-2 font-medium text-slate-100">{t.form}</td>
                <td className="pr-2 text-slate-400">{t.lemma}</td>
                <td className="pr-2">
                  <span className={`chip ${POS_COLOR[t.upos] ?? ''}`}>{POS_PL[t.upos] ?? t.upos}</span>
                </td>
                <td className="pr-2 text-slate-300">{t.part ?? '–'}</td>
                <td className="pr-2 text-spore">{t.q ? `${t.q.toLowerCase()}?` : ''}</td>
                <td className="text-slate-500">{head(t.head)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Stats({ kb, rowsErr, nRules, lastAt, parsesOk, spk }: { kb?: PureKB; rowsErr?: string; nRules: number; lastAt?: string; parsesOk?: number | null; spk?: SpkState | null }) {
  if (rowsErr) return <Card title="Stan wiedzy"><p className="text-sm text-rose">Nie udało się wczytać wiedzy: {rowsErr}</p></Card>
  if (!kb) return <Card title="Stan wiedzy"><div className="skeleton h-40 rounded-xl" aria-busy /></Card>
  const nf = kb.facts.length - nRules
  return (
    <>
      <div className="grid grid-cols-2 gap-3" data-testid="czysta-stats">
        <Kpi label="Fakty" value={nf} tone="spore" hint="zatwierdzone przez ludzi" testid="czysta-n-facts" />
        <Kpi label="Reguły" value={nRules} tone="violet" hint="„jeśli…”, „wszystkie…”" testid="czysta-n-rules" />
        <Kpi label="Pary pyt.→odp." value={kb.qa.length} tone="sky" hint="poprawki i Ucz AI" />
        <Kpi label="Rozbiory" value={parsesOk == null ? '–' : parsesOk} tone="amber" hint="zatwierdzone w Weryfikuj" />
      </div>
      <Card>
        <ul className="space-y-1 text-xs text-slate-400">
          <li>
            Ostatnia zmiana wiedzy: <b className="text-slate-200">{fmt(lastAt)}</b>
          </li>
          <li>
            Formy mówcy ocenione przez ludzi: <b className="text-slate-200">{spk ? spk.forms_people : '–'}</b>
            {spk && ` (poziom L${spk.level}, ocen: ${spk.votes})`}
          </li>
          <li>
            Pominięte wpisy z innych źródeł (Wikidata, Wikisłownik, WordNet…): <b className="text-slate-200">{kb.skipped}</b>
          </li>
        </ul>
        {kb.facts.length + kb.qa.length === 0 && <p className="mt-2 text-sm text-amber">Nie ma jeszcze żadnej wiedzy zatwierdzonej przez ludzi – czysta grzybnia umie tylko rozumować na przesłankach podanych w pytaniu.</p>}
        <Src v="db">
          na żywo z bazy: myc_frags (źródło {HUMAN_SOURCES.join(' / ')}), myc_meanings, Ucz AI + konsensus w przeglądarce; wczytano {fmt(kb.loadedAt)}
        </Src>
      </Card>
    </>
  )
}

function Scores({ w }: { w: Wyniki | null | undefined }) {
  return (
    <Card title="Wyniki pomiaru (prawdziwe zadania)" className="mt-4">
      {w === undefined && <div className="skeleton h-24 rounded-xl" />}
      {w === null && <p className="text-sm text-slate-400">Brak pomiaru – nic nie pokazuję.</p>}
      {w && (
        <div data-testid="czysta-scores">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="eyebrow">320 zadań logicznych</div>
              <div className="font-display text-2xl text-spore">{pct(w.logic.acc)}</div>
              <div className="text-xs text-slate-400">
                {w.logic.correct}/{w.logic.n} trafnych, {w.logic.abstain} × „nie wiem”, reszta błędna
              </div>
            </div>
            <div>
              <div className="eyebrow">40 pytań o fakty (chat_facts_v1)</div>
              <div className="font-display text-2xl text-amber">
                {w.chat_facts.correct}/{w.chat_facts.n}
              </div>
              <div className="text-xs text-slate-400">
                {w.chat_facts.abstain} × „nie wiem”, {w.chat_facts.wrong} błędnych – grzybnia zna tylko fakty, które ludzie jej zatwierdzili
              </div>
            </div>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1 pr-2">typ zadania</th>
                  <th className="pr-2">trafne</th>
                  <th className="pr-2">„nie wiem”</th>
                  <th className="w-1/3">trafność</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(w.logic.per_category)
                  .sort((a, b) => b[1].acc - a[1].acc)
                  .map(([k, v]) => (
                    <tr key={k} className="border-t border-white/[0.04]">
                      <td className="py-1 pr-2 text-slate-200">{k}</td>
                      <td className="pr-2 tabular-nums">
                        {v.correct}/{v.n}
                      </td>
                      <td className="pr-2 tabular-nums text-slate-400">{v.abstain}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <Bar value={v.acc} tone={v.acc >= 0.7 ? 'spore' : v.acc > 0 ? 'amber' : 'rose'} />
                          <span className="w-12 shrink-0 text-right tabular-nums">{pct(v.acc)}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <Src v="recorded">
            pomiar {fmt(w.when)}, model rozbioru {w.model}; ten sam kod co na stronie (scripts/czysta_eval.py){w.python_same ? '; odpowiedzi identyczne z rozumującym w Pythonie' : ''}
          </Src>
        </div>
      )}
    </Card>
  )
}

function Explain({ kb }: { kb?: PureKB }) {
  const sq = Object.entries(SQUARE)
  return (
    <section className="mt-4 space-y-4" data-testid="czysta-explain">
      <Card title="Jak ona rozumuje – krok po kroku">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-300">
          <li>
            <b>Wejście i normalizacja.</b> Zbędne spacje znikają, cudzysłów "…" zamienia się na „…”, a pytanie zaczynające się od słowa pytającego dostaje „?”. Tekst dzieli się na zdania po . ? ! (poza cudzysłowem). Zdania-polecenia („Odpowiedz…”, „Podaj…”, „Wybierz…”) są pomijane.
          </li>
          <li>
            <b>Rozbiór na role.</b> Każde zdanie przechodzi przez <i>model rozbioru wytrenowany przez grzybnię</i> (mała sieć BiLSTM uczona od zera na ręcznie oznaczonym korpusie UD Polish-PDB, wersja wybrana i niezależnie sprawdzona na teście). Model podaje część mowy, cechy (przypadek, rodzaj, liczba, aspekt), lemat i drzewo zależności. Słownik Morfeusza 2 / SGJP i schematy Walentego służą <b>tylko jako słownik</b>: wybierają lemat i przypadek spośród form, które słownik zna – nie generują odpowiedzi.
          </li>
          <li>
            <b>Pytania przypadków.</b> Z drzewa powstają części zdania (podmiot, orzeczenie, dopełnienie, okolicznik, przydawka) i pytania: kto/co, kogo/czego, komu/czemu, kim/czym, gdzie, kiedy, jak.
          </li>
          <li>
            <b>Literały.</b> Zdanie składowe zamienia się na zbiór tematów słów treści (lemat bez końcowej samogłoski, 5 liter) i biegunowość. Odrzucane są spójniki, przyimki, partykuły, interpunkcja i słowa: {[...DROP_LEM].join(', ')}. „nie” przy orzeczeniu odwraca biegunowość; {[...WRAP].map((w) => `„${w}”`).join(', ')} to opakowania („nieprawda, że X” = nie-X).
          </li>
          <li>
            <b>Reguły jeśli–to.</b> Zdanie okolicznikowe ze spójnikiem podrzędnym (rozpoznanym przez model, nie z listy: działa „jeśli”, „gdy”, „o ile”…) staje się poprzednikiem A, zdanie nadrzędne – następnikiem B: reguła A → B. Wnioskowanie: <b>modus ponens</b> (A i A→B ⇒ B) oraz <b>modus tollens</b> (nie-B i A→B ⇒ nie-A), powtarzane do 10 razy (łańcuchy). Gdy ani pytanie, ani jego przeczenie nie wynika – „nie wiadomo” (np. błąd afirmacji następnika).
          </li>
          <li>
            <b>Kwantyfikatory i sylogizmy.</b> Słowa {Q_WORDS.map(([k, v]) => `„${k}…” → ${Q_PL[v]}`).join('; ')}. „Wszystkie X są Y” (orzecznik rzeczownikowy) daje zawieranie klas X ⊂ Y; fakt o X przenosi się na Y. Przeciwieństwa: tylko para {Object.entries(ANT).map(([a, b]) => `${a}/${b}`)[0]}.
          </li>
          <li>
            <b>Przeczenie, zgodność, sprzeczność.</b> „Kto?” → podmiot w mianowniku; przy przestawionym szyku rozstrzyga zgoda rodzaju orzeczenia z podmiotem (dał/dała). „Komu?” → rzeczownik w celowniku. Dwa zdania w cudzysłowie są sprzeczne, gdy to ten sam literał z przeciwną biegunowością albo kwantyfikatory się wykluczają. Aspekt dokonany orzeczenia = czynność skończona („przerwać” = nieskończona). „wcześniej niż” i liczby przy imionach dają porządek (pierwszy/ostatni, najwyższy/najniższy).
          </li>
          <li>
            <b>Wiedza od ludzi.</b> Gdy przesłanek w pytaniu brak: (a) para pytanie → odpowiedź o tych samych słowach treści, (b) fakt o tych samych słowach (prawda/NIEPRAWDA wg ludzi) dla „Czy…?”, (c) reguły i fakty z wiedzy jako przesłanki rozumowania, (d) dla pytań otwartych fakt zawierający wszystkie słowa pytania – odpowiedzią są pozostałe słowa faktu.
          </li>
          <li>
            <b>Złożenie odpowiedzi.</b> Krótka odpowiedź (tak / nie / nie wiadomo / imię / słowa faktu), źródło, metoda, pewność (średnia pewność łuków rozbioru × zgoda ludzi) i pełny ślad. Gdy nic nie pasuje – „nie wiem, bo …” z listą braków. <b>Nie zgaduje.</b>
          </li>
        </ol>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Kwadrat logiczny (z kodu)">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1 text-left">przesłanka \ pytanie</th>
                  {(['all', 'some', 'none', 'notall'] as const).map((k) => (
                    <th key={k} className="px-1">
                      {Q_PL[k]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(['all', 'some', 'none', 'notall'] as const).map((p) => (
                  <tr key={p} className="border-t border-white/[0.04]">
                    <td className="py-1 text-slate-300">{Q_PL[p]}</td>
                    {(['all', 'some', 'none', 'notall'] as const).map((k) => (
                      <td key={k} className="px-1 text-center text-slate-200">
                        {sq.find(([x]) => x === `${p}|${k}`)?.[1]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Czego NIE ma (uczciwie)">
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
            <li>arytmetyki – nie liczy („ile to 2 + 2?”), zadania tekstowe i liczebniki: 0%</li>
            <li>analogii i ciągów – nie ma reguł na „A ma się do B jak…” ani na następny wyraz ciągu</li>
            <li>wiedzy o świecie poza tym, co zatwierdzili ludzie (stąd niski wynik na pytaniach o fakty)</li>
            <li>synonimów i przeciwieństw poza parą mały/duży – „mokra” i „wilgotna” to dla niej różne słowa</li>
            <li>„lub”, „i” między zdaniami, przyczyny („bo”) i czasu jako osobnej logiki</li>
            <li>swobodnej rozmowy – nie układa zdań, tylko krótkie odpowiedzi</li>
            <li>reguły pisane ze znajomością szablonów ćwiczeń; na przeformułowanych pytaniach wynik spada</li>
          </ul>
        </Card>
      </div>

      <Card title="Jak się uczy (progi z kodu)">
        <ul className="space-y-2 text-sm">
          {LEARN_RULES.map((r) => (
            <li key={r.what} className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2">
              <span className="text-slate-300">{r.what}: </span>
              <b className="text-slate-100">{r.value}</b>
              <Src>{r.file}</Src>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-slate-500">Model rozbioru uczą węzły na korpusie UD; nowa wersja trafia na stronę dopiero, gdy niezależny weryfikator potwierdzi wynik na teście. Zatwierdzone w Weryfikuj rozbiory (kafelek „Rozbiory”) są zbierane do przyszłego treningu.</p>
      </Card>

      <Card title="Jak ją uczyć logicznie – praktycznie">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="eyebrow mb-1 text-spore">Dobre fakty i reguły</div>
            <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
              <li>Jedno zdanie = jedna myśl: „Woda zamarza w zerze stopni.”</li>
              <li>Reguła jako „Jeśli A, to B.” z tymi samymi słowami co fakty: „Jeśli pada deszcz, to ulica jest mokra.” + „Pada deszcz.”</li>
              <li>Klasy przez „Wszystkie X są Y.”: „Wszystkie wróble są ptakami.”</li>
              <li>Wykluczenia przez „Żaden X nie …”: „Żaden ssak nie ma skrzeli.”</li>
              <li>Pytania otwarte uczysz faktem z odpowiedzią: „Stolica Polski to Warszawa.” → „Jaka jest stolica Polski?”</li>
              <li>Używaj stale tych samych słów (ona nie zna synonimów).</li>
            </ul>
          </div>
          <div>
            <div className="eyebrow mb-1 text-rose">Czego unikać</div>
            <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
              <li>Kilku myśli w jednym zdaniu („Ala ma kota i psa, a Ewa…”).</li>
              <li>Pytań zamiast faktów („Czym jest kot?” jako fakt).</li>
              <li>Zaimków bez nazwy („On to zrobił.”) – nie wie, kto to „on”.</li>
              <li>Opinii i żartów jako faktów – inni je odrzucą, a głos się liczy w zaufaniu.</li>
              <li>Danych osobowych – są wycinane, a i tak nie służą nauce.</li>
            </ul>
          </div>
        </div>
        <div className="eyebrow mb-1 mt-4">Jak sprawdzić postęp</div>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
          <li>Zadaj to samo pytanie po zatwierdzeniu faktu – w śladzie zobaczysz „fakt” i źródło.</li>
          <li>Kafelki u góry: liczba faktów, reguł i par rośnie tylko po zatwierdzeniu w Weryfikuj.</li>
          <li>Tabela wyników: trafność na 320 zadaniach logicznych i 40 pytaniach o fakty, liczona tym samym kodem.</li>
          <li>Odpowiedzi tej zakładki trafiają do Weryfikuj z kategorią „czysta grzybnia” – tam widać oceny innych.</li>
        </ul>
        {kb && kb.facts.length > 0 && (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-slate-300">Przykłady wiedzy, którą już ma ({Math.min(8, kb.facts.length)} z {kb.facts.length})</summary>
            <ul className="mt-1 list-disc pl-5 text-slate-400">
              {kb.facts.slice(0, 8).map((f) => (
                <li key={f.id}>
                  {f.text}
                  {f.truth === 'nie' ? ' – NIEPRAWDA' : ''} <span className="text-slate-600">({f.source})</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>
    </section>
  )
}
