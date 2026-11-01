import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Card, Kpi, PageHeader } from '../components/ui'
import { L, useI18n } from '../i18n'
import { agentName, CONTROL_EVERY, FACT_CONF, TASK_TYPES, typeOf, useBrain, YN, type Question, type TaskType, type TrainResult } from '../myc/brain'
import { Px } from '../components/Px'
import { TaskTypeStats, TYPE_LABEL } from '../components/TaskTypes'
import { decode } from '../myc/vision'
import { OWNER_PRIOR, PRIOR, truth } from '../myc/consensus'
import type { SensorItem } from '../myc/models'
import { badges } from '../myc/badges'
import { ids, ownerKey } from '../myc/store'
import { CatPicker, ClassifyWord, IntentDrill, WordDrill } from '../components/Pickers'

const pct = (x: number) => `${(x * 100).toFixed(1)}%`

export function Spark({ item, w = 280, h = 64 }: { item: SensorItem; w?: number; h?: number }) {
  const all = [...item.ctx, ...item.seg]
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const n = item.ctx.length * 6 + item.seg.length * 2
  const pt = (v: number, i: number) => `${((i / n) * w).toFixed(1)},${(h - 4 - ((v - lo) / (hi - lo || 1)) * (h - 8)).toFixed(1)}`
  const ctx = item.ctx.map((v, i) => pt(v, i * 6)).join(' ')
  const seg = item.seg.map((v, i) => pt(v, item.ctx.length * 6 + i * 2)).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full max-w-sm" role="img" aria-label="wykres czujnika / sensor chart">
      <polyline points={ctx} fill="none" stroke="#64748b" strokeWidth="1.5" />
      <polyline points={seg} fill="none" stroke="#5eead4" strokeWidth="2.5" />
    </svg>
  )
}

function optionsFor(q: Question, labels: string[]): string[] {
  if (q.kind === 'logic' || q.kind === 'zadanie') return q.item.options.map((o) => o.v)
  if (q.kind === 'image') return YN
  if (q.kind === 'intent') return labels
  if (q.kind === 'user' && q.q.kind === 'example') return labels
  return YN
}

export default function Teach() {
  const b = useBrain()
  const { lang } = useI18n()
  const en = lang === 'en'
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<TrainResult | undefined>(b.last)
  const [skipped, setSkipped] = useState<string[]>([])
  const [type, setType] = useState<TaskType>(() => {
    const t = localStorage.getItem('myc_teach_type') as TaskType | null
    return t && (TASK_TYPES as readonly string[]).includes(t) ? t : 'mieszane'
  })
  const pickType = (t: TaskType) => {
    setType(t)
    localStorage.setItem('myc_teach_type', t)
  }
  const queue = useMemo(() => b.queue(40 + skipped.length, type).filter((q) => !skipped.includes(q.id)), [b, b.version, skipped, type]) // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => (b.ready ? b.pendingByType() : undefined), [b, b.version, b.ready]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (b.ready && counts) badges.set('teach', Math.min(40, counts.mieszane), counts.mieszane >= 40)
  }, [b.ready, counts])
  useEffect(() => void b.loadLogic(), [b])
  useEffect(() => void b.loadZadania(), [b])
  useEffect(() => {
    if (type === 'wzrokowe') void b.loadVision()
  }, [b, type])
  useSyncExternalStore(badges.subscribe, badges.version)
  const verifyWaiting = badges.get('weryfikuj')
  // bieżące pytanie przypięte: synchronizacja głosów innych węzłów zmienia priorytety, ale nie podmienia pytania pod palcem
  const [pin, setPin] = useState<string>()
  const q = (pin ? queue.find((x) => x.id === pin) : undefined) ?? queue[0]
  useEffect(() => {
    if (q && q.id !== pin) setPin(q.id)
  }, [q, pin])
  const qa = b.qa
  const labels = qa?.intent.labels ?? []
  const labelTxt = (l: string) => (en ? l.replace(/_/g, ' ') : (qa?.intent.labels_pl[labels.indexOf(l)] ?? l))
  const opts = q ? optionsFor(q, labels) : []
  const drill = !!q && (q.kind === 'intent' || (q.kind === 'user' && (q.q.kind === 'example' || q.q.kind === 'word')))

  const answer = (a: string) => q && b.answer(q.id, a)
  const skip = () => q && setSkipped((s) => [...s, q.id])

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!q || (e.target as HTMLElement)?.closest('input,textarea,select')) return
      const k = e.key.toLowerCase()
      if (q.kind === 'word' || drill) {
        if (k === 's') skip()
        return
      }
      if (opts === YN) {
        if (k === 't' || k === 'y' || k === '1') answer('tak')
        else if (k === 'n' || k === '2') answer('nie')
      } else if (/^[0-9]$/.test(k)) {
        const i = k === '0' ? 9 : Number(k) - 1
        if (opts[i]) answer(opts[i])
      }
      if (k === 's') skip()
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  })

  const learn = async () => {
    setBusy(true)
    try {
      setRes(await b.learnNow())
    } finally {
      setBusy(false)
    }
  }

  const s = b.scores
  const myCount = b.mine().size
  const facts = Object.keys(b.cons.posterior).filter((id) => (truth(b.cons, id)?.[1] ?? 0) >= FACT_CONF).length
  const nodes = Object.keys(b.cons.answersPerNode).length

  return (
    <>
      <PageHeader title={en ? 'Teach the AI' : 'Ucz AI'}>
        <L
          pl="AI pyta o to, czego jest najmniej pewna. Twoje odpowiedzi trafiają do wspólnej grzybni, ważone zaufaniem do węzła, i od razu uczą modele działające w tej przeglądarce. Nie wpisuj danych osobowych."
          en="The AI asks about what it is least sure of. Your answers go to the shared mycelium, weighted by node trust, and immediately train the models running in this browser. Do not enter personal data."
        />
      </PageHeader>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className={`chip ${b.store.online ? 'border-spore/40 text-spore' : 'border-amber/30 text-amber'}`} data-testid="sync">
          {b.store.online ? (en ? 'synced (Supabase)' : 'zsynchronizowano (Supabase)') : en ? 'offline – saved locally' : 'offline – zapis lokalny'}
        </span>
        <span className="chip text-slate-300" data-testid="node-name">
          {en ? 'this node' : 'ten węzeł'}: {agentName(ids.node)}
        </span>
        {ownerKey.get() && <span className="chip border-violet/40 text-violet">{en ? 'owner key set' : 'klucz właściciela'}</span>}
      </div>
      <div className="grid gap-4 xl:grid-cols-5">
        <Card
          title={en ? 'Pending questions from the mycelium' : 'Oczekujące pytania od grzybni'}
          className="xl:col-span-3"
          right={
            <span className="text-xs text-slate-500" data-testid="queue-count">
              {queue.length}
              {queue.length >= 40 ? '+' : ''} {en ? 'in queue' : 'w kolejce'}
            </span>
          }
        >
          <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label={en ? 'Task type' : 'Typ zadań'} data-testid="task-types">
            {TASK_TYPES.map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={type === t}
                onClick={() => (pickType(t), setPin(undefined))}
                className={`rounded-full border px-2.5 py-1 text-xs ${type === t ? 'border-spore/50 bg-spore/15 text-glow' : 'border-white/10 text-slate-400 hover:text-slate-200'}`}
                data-type={t}
              >
                {en ? TYPE_LABEL[t][1] : TYPE_LABEL[t][0]}
                <span className="ml-1 tabular-nums text-slate-500" data-testid={`type-count-${t}`}>
                  {counts ? counts[t] : '…'}
                  {counts && !b.vis && (t === 'wzrokowe' || t === 'mieszane') ? '+' : ''}
                </span>
              </button>
            ))}
          </div>
          {type === 'językowe' && (
            <p className="mb-3 text-xs text-slate-400" data-testid="lang-links">
              {en ? 'More language tasks: ' : 'Więcej zadań językowych: '}
              <a href="#/weryfikuj" className="text-spore underline">{en ? 'sentence parsing and word meanings in Verify' : 'rozbiór zdania i znaczenia słów w Weryfikuj'}</a>
              {' · '}
              <a href="#/taxonomy" className="text-spore underline">{en ? 'categories' : 'kategorie słów'}</a>
            </p>
          )}
          {type === 'wzrokowe' && !b.vis && <p className="mb-3 text-xs text-slate-500">{en ? 'Loading images and the image model…' : 'Wczytuję obrazy i model obrazów…'}</p>}
          {!b.ready && <div className="h-32 animate-pulse rounded-xl bg-white/5" />}
          {b.ready && !q && (
            <p className="text-sm text-slate-400" data-testid="queue-empty">
              {type === 'mieszane'
                ? en
                  ? 'No more questions – thank you! Add your own in teacher mode.'
                  : 'Brak kolejnych pytań – dziękuję! Dodaj własne w trybie nauczyciela.'
                : en
                  ? `No pending ${TYPE_LABEL[type][1].toLowerCase()} tasks for this node right now. Pick another type or “mixed”.`
                  : `Brak czekających zadań typu „${TYPE_LABEL[type][0].toLowerCase()}” dla tego węzła. Wybierz inny typ albo „mieszane”.`}
            </p>
          )}
          {q && (
            <div data-testid="question" data-qid={q.id} data-kind={q.kind === 'user' ? `user-${q.q.kind}` : q.kind} data-type={typeOf(q)}>
              <div className="mb-2 text-xs uppercase tracking-wider text-slate-500">
                {q.kind === 'logic' && (en ? `Logic question from the mycelium · ${q.item.kind}` : `Pytanie logiczne grzybni · ${q.item.kind}`)}
                {q.kind === 'zadanie' && `${en ? TYPE_LABEL[q.item.type][1] : TYPE_LABEL[q.item.type][0]} · ${q.item.kind}${q.item.type !== 'wzrokowe' ? ` · ${en ? 'level' : 'poziom'} ${q.item.level}` : ''}`}
                {q.kind === 'image' && (en ? 'Image (Fashion-MNIST) · the model is unsure' : 'Obraz (Fashion-MNIST) · model niepewny')}
                {q.kind === 'intent' && (en ? 'What does this person want?' : 'Czego chce ta osoba?')}
                {q.kind === 'sensor' && (en ? 'Machine temperature: is the bold part an anomaly?' : 'Temperatura maszyny: czy pogrubiony fragment to anomalia?')}
                {q.kind === 'knowledge' && (en ? 'True or false?' : 'Prawda czy fałsz?')}
                {q.kind === 'word' && (en ? `Word (${q.lang.toUpperCase()}): which categories fit?` : `Słowo (${q.lang.toUpperCase()}): jakie kategorie pasują?`)}
                {q.kind === 'user' && (q.q.kind === 'example' ? (en ? 'Label this example (from a teacher)' : 'Oznacz przykład (od nauczyciela)') : q.q.kind === 'word' ? (en ? 'Which category is this word? (from a teacher)' : 'Jaka to kategoria słowa? (od nauczyciela)') : en ? 'A teacher says – is it true?' : 'Nauczyciel twierdzi – czy to prawda?')}
              </div>
              <div className="whitespace-pre-line text-lg leading-snug text-slate-100">
                {q.kind === 'logic' && q.item.q}
                {q.kind === 'zadanie' && <ZadBody q={q.item.q} px={q.item.px} sources={q.item.sources} />}
                {q.kind === 'image' && b.cap && (
                  <>
                    <Px px={b.cap.img.get(q.img)} size={140} />
                    <div className="mt-2">{en ? `Is this: ${b.cap.fashion.classes_en[q.cls]}?` : `Czy to jest: ${b.cap.fashion.classes_pl[q.cls]}?`}</div>
                  </>
                )}
                {q.kind === 'intent' && <>„{q.text}”</>}
                {q.kind === 'sensor' && (
                  <>
                    <Spark item={q.item} />
                    <div className="text-xs text-slate-500">{new Date(q.t).toLocaleString(en ? 'en-GB' : 'pl-PL')} · NAB</div>
                  </>
                )}
                {q.kind === 'knowledge' && (en ? q.en : q.pl)}
                {q.kind === 'word' && <WordDrill key={q.id} qid={q.id} word={q.word} onDone={() => undefined} />}
                {q.kind === 'user' && (
                  <>
                    {q.q.kind === 'word' ? `„${q.q.text}”` : q.q.text}
                    {q.q.kind === 'qa' && q.q.answer && <div className="mt-1 text-base text-spore">→ {q.q.answer}</div>}
                  </>
                )}
              </div>
              <Why q={q} labelTxt={labelTxt} />
              {q.kind === 'intent' || (q.kind === 'user' && q.q.kind === 'example') ? (
                <div className="mt-3">
                  <IntentDrill key={q.id} labels={labels} labelTxt={labelTxt} guess={'guess' in q ? q.guess : undefined} onAnswer={answer} />
                </div>
              ) : q.kind === 'user' && q.q.kind === 'word' ? (
                <div className="mt-3">
                  <CatPicker onAnswer={answer} />
                </div>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                {!drill && q.kind !== 'word' && opts.map((o, i) => (
                  <button key={o} onClick={() => answer(o)} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm hover:border-spore/40 hover:bg-spore/10 active:scale-95" data-answer={o}>
                    <kbd className="mr-1.5 text-xs text-slate-500">{opts === YN ? (o === 'tak' ? 'T' : 'N') : i === 9 ? 0 : i + 1}</kbd>
                    {q.kind === 'logic' || q.kind === 'zadanie' ? q.item.options[i].label : opts === YN ? (o === 'tak' ? (en ? 'Yes' : 'Tak') : en ? 'No' : 'Nie') : labelTxt(o)}
                  </button>
                ))}
                <button onClick={skip} className="rounded-xl px-3 py-2 text-sm text-slate-400 hover:text-slate-200">
                  <kbd className="mr-1.5 text-xs text-slate-500">S</kbd>
                  {en ? 'Skip' : 'Pomiń'}
                </button>
              </div>
            </div>
          )}
          <p className="mt-4 border-t border-white/5 pt-3 text-xs leading-relaxed text-slate-500" data-testid="queue-note">
            {(type === 'matematyczne' || type === 'analityczne') &&
              (en ? 'Every task of this type is checked by a program (answer only in the database), from level 1 up. ' : 'Każde zadanie tego typu sprawdza program (odpowiedź tylko w bazie), od poziomu 1 w górę. ')}
            {en
              ? `Order: the most uncertain first (model confidence or vote margin), questions with fewer votes higher. About every ${CONTROL_EVERY}th question has an answer known to the program (control) – your node's trust is computed from those. Answers are weighted by trust; disputed ones go to Verify, approved ones to the knowledge memory and training data (only through the 2000-question gate).`
              : `Kolejność: najpierw najmniej pewne (pewność modelu albo margines głosów), wyżej te z mniejszą liczbą głosów. Co ok. ${CONTROL_EVERY}. pytanie ma odpowiedź znaną programowi (kontrolne) – z nich liczy się zaufanie do Twojego węzła. Odpowiedzi są ważone zaufaniem; sporne trafiają do Weryfikuj, zatwierdzone do pamięci wiedzy i danych treningowych (tylko przez bramkę 2000 pytań).`}
            {verifyWaiting && verifyWaiting.n > 0 && (
              <>
                {' '}
                <a href="#/weryfikuj" className="text-spore underline" data-testid="queue-verify-link">
                  {en ? `${verifyWaiting.n}${verifyWaiting.more ? '+' : ''} waiting in Verify →` : `W Weryfikuj czeka ${verifyWaiting.n}${verifyWaiting.more ? '+' : ''} →`}
                </a>
              </>
            )}
          </p>
        </Card>

        <Card title={en ? 'Learn now' : 'Ucz teraz'} className="xl:col-span-2">
          <p className="text-sm text-slate-400">
            <L pl="Trening w tej przeglądarce na zestawie startowym + etykietach z konsensusu. Wynik na odłożonym zbiorze testowym (prawdziwe dane CLINC150 i NAB)." en="Trains in this browser on the seed set + consensus labels. Scored on a held-out test set (real CLINC150 and NAB data)." />
          </p>
          <button onClick={learn} disabled={busy || !b.ready} className="mt-3 w-full rounded-xl bg-spore/90 px-4 py-2.5 font-medium text-ink hover:bg-spore disabled:opacity-50" data-testid="learn-now">
            {busy ? (en ? 'Training…' : 'Trenuję…') : en ? 'Learn now' : 'Ucz teraz'}
          </button>
          {res && (
            <table className="mt-3 w-full text-sm tabular-nums" data-testid="learn-result">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="text-left font-normal" />
                  <th className="text-right font-normal">{en ? 'seed only' : 'tylko start'}</th>
                  <th className="text-right font-normal">{en ? 'with feedback' : 'z odpowiedziami'}</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    [`${en ? 'Intents (acc.)' : 'Intencje (traf.)'} n=${res.after.n.intent}`, 'intent'],
                    [`${en ? 'Sensor (bal. acc.)' : 'Czujnik (traf. zbal.)'} n=${res.after.n.sensor}`, 'sensor'],
                    [`${en ? 'Facts confirmed by people' : 'Fakty potwierdzone przez ludzi'} n=${res.after.n.knowledge}`, 'knowledge'],
                  ] as const
                ).map(([l, k]) => (
                  <tr key={k}>
                    <td className="py-0.5 text-slate-400">{l}</td>
                    <td className="text-right">{pct(res.before[k])}</td>
                    <td className={`text-right ${res.after[k] > res.before[k] ? 'text-spore' : res.after[k] < res.before[k] ? 'text-rose' : ''}`}>{pct(res.after[k])}</td>
                  </tr>
                ))}
              </tbody>
              <caption className="caption-bottom pt-1 text-left text-xs text-slate-500">
                {en ? 'labels from people' : 'etykiety od ludzi'}: {res.labels.intent + res.labels.sensor} · {new Date(res.at).toLocaleTimeString('pl-PL', { timeZone: 'Europe/Amsterdam' })} (CEST)
              </caption>
            </table>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <TeacherMode labelTxt={labelTxt} />
        <ClassifyWord />
      </div>
      <div className="mt-4">
        <Learned labelTxt={labelTxt} />
      </div>
      <details className="card mt-4" data-testid="teach-numbers">
        <summary className="cursor-pointer text-sm text-slate-300">
          {en ? 'Numbers' : 'Liczby'}: {en ? 'intent test' : 'test intencji'} {s ? pct(s.intent) : '…'} · {en ? 'my answers' : 'moje odpowiedzi'} {myCount} · {en ? 'facts' : 'fakty'} {facts} · {en ? 'nodes' : 'węzły'} {nodes}
        </summary>
        <div className="mt-3">
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            <Kpi
              label={en ? 'Intent test (this browser)' : 'Test intencji (ta przeglądarka)'}
              value={s ? pct(s.intent) : '…'}
              hint={s ? `${en ? 'sensor' : 'czujnik'} ${pct(s.sensor)} (n=${s.n.sensor}) · ${en ? 'facts confirmed' : 'fakty potwierdzone'} ${pct(s.knowledge)} (n=${s.n.knowledge})` : undefined}
              src={s ? (en ? `accuracy on ${s.n.intent} fixed test questions (qa.json), computed in this browser` : `trafność na ${s.n.intent} stałych pytaniach testowych (qa.json), policzona w tej przeglądarce`) : undefined}
            />
            <Kpi label={en ? 'My answers' : 'Moje odpowiedzi'} value={myCount} tone="violet" src={en ? 'your rows in myc_answers' : 'Twoje wiersze w myc_answers'} verif="db" />
            <Kpi label={en ? 'Facts known' : 'Poznane fakty'} value={facts} hint={en ? `consensus ≥ ${FACT_CONF * 100}%` : `konsensus ≥ ${FACT_CONF * 100}%`} tone="amber" src={en ? 'consensus of answers in myc_answers' : 'konsensus odpowiedzi w myc_answers'} verif="db" />
            <Kpi label={en ? 'Answering nodes' : 'Węzły odpowiadające'} value={nodes} src={en ? 'distinct nodes in myc_answers' : 'różne węzły w myc_answers'} verif="db" />
          </div>
        </div>
      </details>
      <TaskTypeStats />
      <OwnerKey />
    </>
  )
}

/** Treść zadania: tekst, tabela „a | b” (z Wikidata) jako prawdziwa tabela, obraz 28×28. */
function ZadBody({ q, px, sources }: { q: string; px?: string; sources?: string[] }) {
  const img = useMemo(() => (px ? decode(px) : undefined), [px])
  const lines = q.split('\n')
  const rows = lines.filter((l) => l.includes(' | '))
  const before = lines.slice(0, lines.findIndex((l) => l.includes(' | ')))
  const after = rows.length ? lines.slice(lines.findIndex((l) => l.includes(' | ')) + rows.length) : lines
  return (
    <>
      {img && <Px px={img} size={140} />}
      {rows.length > 0 && (
        <>
          <div className="text-xs text-slate-500">{before.join(' ')}</div>
          <table className="my-2 w-full table-fixed border-collapse text-sm" data-testid="zad-table">
            <thead>
              <tr>
                {rows[0].split(' | ').map((h) => (
                  <th key={h} className="border-b border-white/10 px-2 py-1 text-left font-normal text-slate-400">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((r) => (
                <tr key={r}>
                  {r.split(' | ').map((c, i) => (
                    <td key={i} className="break-words border-b border-white/5 px-2 py-1 text-slate-200">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div>{after.join('\n')}</div>
      {!!sources?.length && (
        <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-slate-500" data-testid="zad-sources">
          {sources.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer" className="underline hover:text-slate-300">
              {u.split('/').pop()}
            </a>
          ))}
        </div>
      )}
    </>
  )
}

/** „Dlaczego pytam”: niepewność modelu / grzybni, liczba głosów, rodzaj – tylko z prawdziwych danych. */
function Why({ q, labelTxt }: { q: Question; labelTxt: (l: string) => string }) {
  const b = useBrain()
  const en = useI18n().lang === 'en'
  const parts: string[] = []
  if (q.kind === 'logic') {
    const it = q.item
    if (q.control) {
      parts.push(en ? `generated task (${it.kind}, level ${it.level ?? 1})` : `zadanie z generatora (${it.kind}, poziom ${it.level ?? 1})`)
      if (it.model_acc != null) parts.push(en ? `the model solves ${pct(it.model_acc)} of these` : `model rozwiązuje ${pct(it.model_acc)} takich`)
    } else {
      if (it.why) parts.push(it.why)
      const top = Object.entries(it.model?.p ?? {}).sort((x, y) => y[1] - x[1])
      const lab = (v: string) => it.options.find((o) => o.v === v)?.label ?? v
      if (top.length >= 2) parts.push(`${en ? 'model unsure' : 'model niepewny'}: ${lab(top[0][0])} ${pct(top[0][1])} vs ${lab(top[1][0])} ${pct(top[1][1])}`)
    }
  } else if (q.kind === 'zadanie') {
    const it = q.item
    const m = b.zad?.types[it.type]?.model
    if (it.type === 'wzrokowe') {
      parts.push(en ? 'real Fashion-MNIST test image, label known only to the program' : 'prawdziwy obraz z testu Fashion-MNIST, etykietę zna tylko program')
      if (it.model?.pmax != null) parts.push(en ? `start model's confidence on this image: ${pct(it.model.pmax)}` : `pewność modelu startowego na tym obrazie: ${pct(it.model.pmax)}`)
      if (m?.acc != null) parts.push(en ? `it gets ${pct(m.acc)} of ${m.n} such images right` : `trafia ${pct(m.acc)} z ${m.n} takich obrazów`)
    } else {
      parts.push(en ? `checked by a program (${it.kind}, level ${it.level})` : `sprawdzane programem (${it.kind}, poziom ${it.level})`)
      if (it.model_acc != null) parts.push(en ? `${m?.name ?? 'the model'} solves ${pct(it.model_acc)} of these` : `${m?.name ?? 'model'} rozwiązuje ${pct(it.model_acc)} takich`)
    }
  } else if (q.kind === 'image' && b.cap) {
    parts.push(`${en ? 'image model guess' : 'model obrazów zgaduje'}: ${en ? b.cap.fashion.classes_en[q.cls] : b.cap.fashion.classes_pl[q.cls]} (${pct(q.conf)})`)
    parts.push(en ? 'your answer becomes a training label' : 'Twoja odpowiedź staje się etykietą do treningu')
  } else if (q.kind === 'word' && b.lex) {
    parts.push(`${en ? 'AI guess' : 'AI zgaduje'}: ${q.pred.path.map((i) => (en ? b.lex!.taxonomy[i].en : b.lex!.taxonomy[i].pl)).join(' › ')} (${pct(q.conf)})`)
  } else if ('guess' in q && q.guess) {
    parts.push(`${en ? 'AI guess' : 'AI zgaduje'}: ${q.kind === 'intent' ? labelTxt(q.guess) : q.guess === 'tak' ? (en ? 'yes' : 'tak') : en ? 'no' : 'nie'} (${pct(q.conf)})`)
  } else parts.push(`${en ? 'mycelium certainty' : 'pewność grzybni'}: ${pct(Math.max(0, q.conf))}`)
  if (q.votes != null) parts.push(en ? `${q.votes} vote(s) so far` : `głosów dotąd: ${q.votes}`)
  return (
    <div className="mt-2 text-xs text-slate-500" data-testid="why">
      <span className="text-slate-400">{en ? 'Why I ask' : 'Dlaczego pytam'}:</span> {parts.join(' · ')}
    </div>
  )
}

function TeacherMode({ labelTxt }: { labelTxt: (l: string) => string }) {
  const b = useBrain()
  const en = useI18n().lang === 'en'
  const [kind, setKind] = useState<'fact' | 'qa' | 'example' | 'fix'>('fact')
  const [text, setText] = useState('')
  const [ans, setAns] = useState('')
  const [label, setLabel] = useState('')
  const [msg, setMsg] = useState('')
  const labels = b.qa?.intent.labels ?? []
  const pred = kind === 'fix' && text.trim().length > 2 ? b.predictIntent(text) : undefined

  const save = () => {
    const t = text.trim()
    if (t.length < 3) return
    if (kind === 'fact') b.teach('fact', t, 'tak')
    if (kind === 'qa') {
      if (!ans.trim()) return
      b.teach('qa', t, ans.trim())
    }
    if (kind === 'example' || kind === 'fix') {
      const l = label || (pred ? labels[pred.label] : '')
      if (!l) return
      b.teach('example', t, l)
    }
    setText('')
    setAns('')
    setLabel('')
    setMsg(en ? 'Saved – other nodes will verify it. Press “Learn now”.' : 'Zapisano – inne węzły to zweryfikują. Kliknij „Ucz teraz”.')
  }
  const tabs = [
    ['fact', en ? 'Fact' : 'Fakt'],
    ['qa', en ? 'Q&A' : 'Pytanie i odpowiedź'],
    ['example', en ? 'Labelled example' : 'Przykład z etykietą'],
    ['fix', en ? 'Check & correct' : 'Sprawdź i popraw'],
  ] as const
  return (
    <Card title={en ? 'Teacher mode' : 'Tryb nauczyciela'}>
      <div className="mb-3 flex flex-wrap gap-1" role="tablist">
        {tabs.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={kind === k} onClick={() => (setKind(k), setMsg(''))} className={`rounded-lg px-2.5 py-1 text-xs ${kind === k ? 'bg-spore/15 text-glow' : 'text-slate-400 hover:text-slate-200'}`}>
            {l}
          </button>
        ))}
      </div>
      <label className="block text-xs text-slate-400">
        {kind === 'fact' ? (en ? 'A true statement' : 'Prawdziwe zdanie') : kind === 'qa' ? (en ? 'Question' : 'Pytanie') : en ? 'Sentence (English, as a user would say it)' : 'Zdanie (po angielsku, jak powiedziałby użytkownik)'}
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} className="mt-1 w-full rounded-lg border border-white/10 bg-ink/60 px-3 py-2 text-sm text-slate-100" data-testid="teach-text" />
      </label>
      {kind === 'qa' && (
        <label className="mt-2 block text-xs text-slate-400">
          {en ? 'Answer' : 'Odpowiedź'}
          <input value={ans} onChange={(e) => setAns(e.target.value)} maxLength={200} className="mt-1 w-full rounded-lg border border-white/10 bg-ink/60 px-3 py-2 text-sm text-slate-100" />
        </label>
      )}
      {kind === 'fix' && pred && (
        <p className="mt-2 text-sm" data-testid="prediction">
          {en ? 'Model thinks' : 'Model uważa'}: <b className="text-spore">{labelTxt(labels[pred.label])}</b> ({pct(pred.conf)}). {en ? 'Wrong? Pick the right label:' : 'Źle? Wybierz poprawną:'}
        </p>
      )}
      {(kind === 'example' || kind === 'fix') && (
        <select value={label} onChange={(e) => setLabel(e.target.value)} className="mt-2 w-full rounded-lg border border-white/10 bg-ink/60 px-3 py-2 text-sm" aria-label={en ? 'Label' : 'Etykieta'}>
          <option value="">{kind === 'fix' ? (en ? '— model is right —' : '— model ma rację —') : en ? '— choose label —' : '— wybierz etykietę —'}</option>
          {labels.map((l) => (
            <option key={l} value={l}>
              {labelTxt(l)}
            </option>
          ))}
        </select>
      )}
      <button onClick={save} className="mt-3 rounded-xl border border-spore/40 px-4 py-2 text-sm text-spore hover:bg-spore/10" data-testid="teach-save">
        {en ? 'Teach' : 'Naucz'}
      </button>
      {msg && <p className="mt-2 text-xs text-spore">{msg}</p>}
    </Card>
  )
}

function Learned({ labelTxt }: { labelTxt: (l: string) => string }) {
  const b = useBrain()
  const en = useI18n().lang === 'en'
  const qa = b.qa
  if (!qa) return <Card title={en ? 'What it learned' : 'Czego się nauczyła'}>…</Card>
  const text = (id: string): string => {
    const k = qa.knowledge.questions.find((q) => q.id === id)
    if (k) return en ? k.en : k.pl
    const i = qa.intent.questions.find((q) => q.id === id)
    if (i) return `„${i.text}”`
    const u = b.store.data.userQs.find((q) => q.id === id)
    if (u) return u.kind === 'qa' ? `${u.text} → ${u.answer}` : u.text
    return b.wordText(id, en) ?? (en ? `sensor window ${id}` : `okno czujnika ${id}`)
  }
  const rows = Object.keys(b.cons.posterior)
    .map((id) => ({ id, t: truth(b.cons, id)!, n: b.store.data.answers.filter((a) => a.question_id === id).length }))
    .sort((a, b2) => b2.n - a.n || b2.t[1] - a.t[1])
    .slice(0, 12)
  return (
    <Card title={en ? 'What it learned (truth probability)' : 'Czego się nauczyła (prawdopodobieństwo prawdy)'}>
      {rows.length === 0 && <p className="text-sm text-slate-500">{en ? 'no data yet' : 'brak danych jeszcze'}</p>}
      <ul className="space-y-1.5 text-sm" data-testid="learned">
        {rows.map(({ id, t, n }) => (
          <li key={id} className="flex items-start justify-between gap-3">
            <span className="min-w-0 text-slate-300">{text(id)}</span>
            <span className="shrink-0 tabular-nums text-xs">
              <b className={t[1] >= FACT_CONF ? 'text-spore' : 'text-amber'}>{YN.includes(t[0]) ? (t[0] === 'tak' ? (en ? 'true' : 'prawda') : en ? 'false' : 'fałsz') : labelTxt(t[0])}</b> {pct(t[1])} · {n}×
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

// wagi startowe liczone z priorów Beta konsensusu (a / (a + b)), nie wpisane na sztywno
const ownerPct = `${Math.round((100 * OWNER_PRIOR[0]) / (OWNER_PRIOR[0] + OWNER_PRIOR[1]))}%`
const basePct = `${Math.round((100 * PRIOR[0]) / (PRIOR[0] + PRIOR[1]))}%`

function OwnerKey() {
  const en = useI18n().lang === 'en'
  const [v, setV] = useState('')
  const [saved, setSaved] = useState(!!ownerKey.get())
  return (
    <details className="card mt-4 text-sm">
      <summary className="cursor-pointer text-slate-300">{en ? 'Owner key (optional)' : 'Klucz właściciela (opcjonalnie)'}</summary>
      <p className="mt-2 text-xs text-slate-400">
        <L
          pl={`Klucz zostaje tylko w tej przeglądarce. Baza porównuje jego skrót i oznacza Twoje odpowiedzi jako właściciela – startują z wyższą wagą (ok. ${ownerPct} zamiast ${basePct}), ale nadal są sprawdzane pytaniami kontrolnymi.`}
          en={`The key stays in this browser only. The database compares its hash and marks your answers as the owner's – they start with a higher weight (≈${ownerPct} instead of ${basePct}) but are still checked with gold questions.`}
        />
      </p>
      <div className="mt-2 flex gap-2">
        <input type="password" value={v} onChange={(e) => setV(e.target.value)} autoComplete="off" className="w-full rounded-lg border border-white/10 bg-ink/60 px-3 py-2" aria-label={en ? 'Owner key' : 'Klucz właściciela'} />
        <button onClick={() => (ownerKey.set(v), setSaved(!!v.trim()), setV(''))} className="rounded-lg border border-white/10 px-3">
          {en ? 'Save' : 'Zapisz'}
        </button>
      </div>
      {saved && <p className="mt-1 text-xs text-violet">{en ? 'Key saved locally.' : 'Klucz zapisany lokalnie.'}</p>}
    </details>
  )
}
