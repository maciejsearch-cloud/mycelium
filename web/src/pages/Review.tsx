import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { badges } from '../myc/badges'
import { TimeChart, type Point, ago } from '../components/TimeChart'
import { Card, Kpi, PageHeader } from '../components/ui'
import { MeaningVotes } from '../components/MeaningVotes'
import { PatternVotes } from '../components/PatternVotes'
import { AnswerVotes } from '../components/AnswerVotes'
import { ParseVotes } from '../components/ParseVotes'
import { useI18n } from '../i18n'
import { useBrain } from '../myc/brain'
import { ownerKey } from '../myc/store'
import { CategoryPicker } from '../components/CategoryPicker'
import { inConf, type IConf, type IState } from '../myc/inbox'
import { buildQueue, reviewLog, reviewRoom, reviewStats, submit, taxoCtx, TYPE_LABEL, undo, whoami, type LogRow, type ReviewItem, type ReviewStat, type Verdict, type Who } from '../myc/review'

const pct = (x: number) => `${Math.round(x * 100)}%`
const TODAY = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' })

export default function Review() {
  const b = useBrain()
  const en = useI18n().lang === 'en'
  const [who, setWho] = useState<Who | undefined>()
  const [keyIn, setKeyIn] = useState('')
  const [st, setSt] = useState<IState>('czeka')
  const [cf, setCf] = useState<IConf>('all')
  const [ext, setExt] = useState({ czat: 0, znaczenia: 0, wzorce: 0, rozbior: 0 })
  const onCzat = useCallback((n: number) => setExt((x) => ({ ...x, czat: n })), [])
  const onZn = useCallback((n: number) => setExt((x) => ({ ...x, znaczenia: n })), [])
  const onWz = useCallback((n: number) => setExt((x) => ({ ...x, wzorce: n })), [])
  const onRb = useCallback((n: number) => setExt((x) => ({ ...x, rozbior: n })), [])
  const [queue, setQueue] = useState<ReviewItem[] | undefined>()
  const [filter, setFilter] = useState<string>('all')
  const [stats, setStats] = useState<ReviewStat[]>([])
  const [log, setLog] = useState<LogRow[]>([])
  const [last, setLast] = useState<{ id: number; item: ReviewItem; verdict: Verdict } | undefined>()
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const owner = who?.reviewer === 'owner'
  const canWrite = !!who?.reviewer
  const room = reviewRoom()

  useEffect(() => {
    void b.loadCaptcha().catch(() => undefined)
    void b.loadLogic()
  }, [b])
  const refreshWho = useCallback(() => whoami().then(setWho).catch(() => setWho({ room: null, reviewer: null, weight: null })), [])
  useEffect(() => void refreshWho(), [refreshWho])
  const reload = useCallback(async () => {
    const q = await buildQueue(b, en, { owner, room })
    setQueue(q.items)
    void reviewStats().then(setStats).catch(() => undefined)
    if (owner) void reviewLog().then(setLog).catch(() => undefined)
  }, [b, en, owner, room])
  // kolejka przelicza się, gdy dojdą dane (konsensus, captcha) – nie przy każdej synchronizacji
  const ready = b.ready && !!b.qa
  const capReady = !!b.cap
  const logicReady = !!b.logic
  const synced = b.store.online
  useEffect(() => {
    if (ready && who) void reload()
  }, [ready, capReady, logicReady, synced, who, reload])

  const totalWaiting = (queue?.length ?? 0) + (st === 'czeka' && cf === 'all' ? ext.czat + ext.znaczenia + ext.wzorce + ext.rozbior : 0)
  useEffect(() => {
    if (queue && st === 'czeka' && cf === 'all') badges.set('weryfikuj', totalWaiting)
  }, [queue, st, cf, totalWaiting])
  // jedna skrzynka: stan (czeka/sporne/zatwierdzone) i pewność AI zawężają wszystko, rodzaj wybiera sekcję
  const typeOf = (i: ReviewItem) => (i.kind === 'logic' ? 'logic' : i.type)
  const base = useMemo(() => (st === 'zatwierdzone' ? [] : (queue ?? []).filter((i) => (st !== 'sporne' || i.disputed) && inConf(i.conf, cf))), [queue, st, cf])
  const counts = useMemo(() => {
    const c: Record<string, number> = { ...ext }
    for (const i of base) c[typeOf(i)] = (c[typeOf(i)] ?? 0) + 1
    return c
  }, [base, ext])
  const shown = useMemo(() => base.filter((i) => filter === 'all' || typeOf(i) === filter), [base, filter])
  const showQueue = st !== 'zatwierdzone' && !EXT.includes(filter)
  const cur = shown[0]

  const decide = async (item: ReviewItem, verdict: Verdict, truthVal?: string) => {
    if (!canWrite || busy) return
    setBusy(true)
    setErr('')
    try {
      const r = await submit(item, verdict, truthVal)
      setLast({ id: r.id, item, verdict })
      // decyzja o strzępku rozstrzyga też rodzeństwo w sprzeczności (ta sama encja i relacja)
      setQueue((q) => (q ?? []).filter((x) => !(x.type === item.type && (x.ref === item.ref || (item.type === 'fragment' && verdict !== 'skip' && x.title === item.title)))))
      if (navigator.vibrate) navigator.vibrate(15)
      // ponowna nauka: etykiety → konsensus → modele; sprzeczne strzępki wracają do kolejki
      void b.sync().then(() => {
        if (verdict !== 'skip') b.train()
        if (item.type === 'fragment') void reload()
      })
      void reviewStats().then(setStats).catch(() => undefined)
      if (owner) void reviewLog().then(setLog).catch(() => undefined)
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }
  const doUndo = async () => {
    if (!last) return
    setBusy(true)
    try {
      await undo(last.id)
      setQueue((q) => [last.item, ...(q ?? [])])
      setLast(undefined)
      await b.sync()
      void reviewStats().then(setStats)
      if (owner) void reviewLog().then(setLog)
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const today = stats.filter((s) => s.day === TODAY()).reduce((n, s) => n + s.n - s.skipped, 0)
  const ok = stats.reduce((n, s) => n + s.ai_ok, 0)
  const wrong = stats.reduce((n, s) => n + s.ai_wrong, 0)

  return (
    <div className="mx-auto max-w-xl space-y-4" data-testid="review-page">
      <PageHeader title={en ? 'Verify' : 'Weryfikuj'}>
        {en
          ? 'Check what the mycelium learned: approve, reject or correct. Your decisions become gold labels – they change trust weights, training data and knowledge fragments right away.'
          : 'Sprawdzaj, czego nauczyła się grzybnia: zatwierdzaj, odrzucaj albo poprawiaj. Twoje decyzje są złotymi etykietami – od razu zmieniają wagi zaufania, dane treningowe i strzępki wiedzy.'}
      </PageHeader>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2" data-testid="review-mode">
          <span className={`chip ${owner ? 'border-spore/40 text-spore' : canWrite ? 'border-violet/40 text-violet' : 'border-amber/30 text-amber'}`}>
            {owner ? (en ? 'Owner' : 'Właścicielka') : canWrite ? (en ? `Trusted contributor (weight ${pct(who!.weight!)})` : `Zaufany współtwórca (waga ${pct(who!.weight!)})`) : en ? 'Read-only' : 'Tylko podgląd'}
            {room === 'e2e' && ' · e2e'}
          </span>
          {ownerKey.get() ? (
            <button className="text-xs text-slate-500 underline" onClick={() => (ownerKey.set(''), void refreshWho())}>
              {en ? 'forget key on this device' : 'zapomnij klucz na tym urządzeniu'}
            </button>
          ) : null}
        </div>
        {!owner && (
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              ownerKey.set(keyIn)
              setKeyIn('')
              void refreshWho()
            }}
          >
            <input type="password" autoComplete="current-password" value={keyIn} onChange={(e) => setKeyIn(e.target.value)} placeholder={en ? 'Owner key (once per device)' : 'Klucz właściciela (raz na urządzeniu)'} className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-base" data-testid="owner-key" />
            <button className="rounded-xl bg-spore/20 px-4 py-3 text-spore ring-1 ring-spore/30" data-testid="owner-key-save">
              OK
            </button>
          </form>
        )}
        {!canWrite && who && (
          <p className="mt-2 text-xs text-slate-500">
            {en ? 'Without the key you can browse. Nodes with ≥85% on control questions (≥30 answers) can review as trusted contributors.' : 'Bez klucza możesz przeglądać. Węzły z ≥85% trafności na pytaniach kontrolnych (≥30 odpowiedzi) mogą weryfikować jako zaufani współtwórcy.'}
          </p>
        )}
      </Card>

      <Card>
        <div className="space-y-3" data-testid="inbox-filters">
          <ChipRow label={en ? 'State' : 'Stan'} testid="state" value={st} onPick={(v) => setSt(v as IState)} items={[
            ['czeka', en ? 'Waiting' : 'Czeka'],
            ['sporne', en ? 'Disputed' : 'Sporne'],
            ['zatwierdzone', en ? 'Decided' : 'Zatwierdzone'],
          ]} />
          {st !== 'zatwierdzone' && (
            <ChipRow label={en ? 'Type' : 'Rodzaj'} testid="type" value={filter} onPick={setFilter} items={[
              ['all', `${en ? 'All' : 'Wszystko'} ${Object.values(counts).reduce((n, v) => n + v, 0)}`],
              ...[...EXT, 'logic', ...Object.keys(TYPE_LABEL)].filter((t) => (counts[t] ?? 0) > 0 || t === filter).map((t) => [t, `${KIND_LABEL[t]?.[en ? 1 : 0] ?? TYPE_LABEL[t][en ? 1 : 0]} ${counts[t] ?? 0}`] as [string, string]),
            ]} />
          )}
          <ChipRow label={en ? 'AI confidence' : 'Pewność AI'} testid="conf" value={cf} onPick={(v) => setCf(v as IConf)} items={[
            ['all', en ? 'any' : 'dowolna'],
            ['low', en ? 'low <50%' : 'niska <50%'],
            ['mid', '50–80%'],
            ['high', en ? 'high ≥80%' : 'wysoka ≥80%'],
          ]} />
          <p className="text-xs text-slate-500" data-testid="inbox-note">
            {st === 'sporne'
              ? en ? 'Disputed: nodes disagree, fragments contradict, a 👎 on a chat, or people’s votes still between 20% and 80%.' : 'Sporne: węzły się nie zgadzają, strzępki są sprzeczne, rozmowa dostała 👎 albo głosy ludzi wciąż między 20% a 80%.'
              : st === 'zatwierdzone'
                ? en ? 'Decided: confirmed chat answers, where the AI was wrong, and (owner) the decision log.' : 'Zatwierdzone: potwierdzone odpowiedzi czatu, gdzie AI się myliło i (dla właścicielki) dziennik decyzji.'
                : en ? 'Everything waiting for people, most urgent first.' : 'Wszystko, co czeka na ludzi – najpilniejsze najpierw.'}
            {cf !== 'all' && (en ? ' Meanings and patterns have no AI confidence – hidden under this filter.' : ' Znaczenia i wzorce nie mają pewności AI – przy tym filtrze są ukryte.')}
          </p>
        </div>
      </Card>

      {err && <div className="card border-rose/30 text-sm text-rose">{err}</div>}
      {last && (
        <div className="card flex items-center justify-between gap-2 text-sm" data-testid="undo-bar">
          <span className="text-slate-300">
            {en ? 'Saved' : 'Zapisano'}: {verdictLabel(last.verdict, en)} · {last.item.title.slice(0, 40)}
          </span>
          <button onClick={doUndo} disabled={busy} className="rounded-xl bg-white/10 px-4 py-2 text-slate-100" data-testid="undo">
            {en ? 'Undo' : 'Cofnij'}
          </button>
        </div>
      )}

      {showQueue && (
        <>
          {!queue && <div className="card h-64 animate-pulse" />}
          {queue && !cur && (filter === 'all' || !EXT.includes(filter)) && (
            <div className="card text-center text-sm text-slate-400" data-testid="queue-empty">
              {en ? 'Nothing to review for these filters. New items appear when nodes disagree, the model errs or fragments contradict.' : 'Nic do sprawdzenia w tych filtrach. Nowe pozycje pojawią się, gdy węzły się nie zgodzą, model się pomyli albo strzępki będą sprzeczne.'}
            </div>
          )}
          {cur && <ItemCard key={`${cur.type}|${cur.ref}`} item={cur} en={en} canWrite={canWrite && !busy} onDecide={decide} b={b} />}
          {shown.length > 1 && (
            <p className="text-center text-xs text-slate-500">
              {en ? `next: ${shown.length - 1} more` : `dalej: jeszcze ${shown.length - 1}`}
            </p>
          )}
        </>
      )}
      <div hidden={st === 'zatwierdzone' || !(filter === 'all' || filter === 'czat')}>
        <AnswerVotes state={st === 'zatwierdzone' ? 'czeka' : st} conf={cf} onCount={onCzat} />
      </div>
      <div hidden={!(filter === 'all' || filter === 'znaczenia')}>
        <MeaningVotes state={st} conf={cf} onCount={onZn} />
      </div>
      <div hidden={!(filter === 'all' || filter === 'wzorce')}>
        <PatternVotes state={st} conf={cf} onCount={onWz} />
      </div>
      <div hidden={!(filter === 'all' || filter === 'rozbior')}>
        <ParseVotes state={st} conf={cf} onCount={onRb} room={room === 'e2e' ? 'e2e' : 'main'} />
      </div>
      {st === 'zatwierdzone' && (
        <>
          <AnswerVotes state="zatwierdzone" conf={cf} />
          <Mistakes stats={stats} log={log} en={en} owner={owner} />
          <Log log={log} en={en} owner={owner} />
        </>
      )}

      <details className="card" data-testid="review-numbers">
        <summary className="cursor-pointer text-sm text-slate-300">{en ? 'Numbers' : 'Liczby'}</summary>
        <div className="mt-3">
          <div className="grid grid-cols-3 gap-2">
            <Kpi label={en ? 'Queue' : 'W kolejce'} value={<span data-testid="queue-size">{queue ? queue.length : '…'}</span>} src={en ? 'built in this browser from database rows' : 'zbudowana w tej przeglądarce z wierszy bazy'} verif="db" />
            <Kpi label={en ? 'Today' : 'Dziś'} value={<span data-testid="reviewed-today">{today}</span>} tone="violet" src={en ? 'your reviews today (this device)' : 'Twoje oceny dziś (to urządzenie)'} />
            <Kpi label={en ? 'AI right' : 'AI miało rację'} value={ok + wrong ? pct(ok / (ok + wrong)) : '—'} hint={`${ok}/${ok + wrong}`} tone="amber" src={en ? 'share of reviewed items where the AI guess was confirmed by people' : 'odsetek ocenionych pozycji, w których ludzie potwierdzili odpowiedź AI'} verif="db" />
          </div>

        </div>
      </details>
    </div>
  )
}

const EXT = ['czat', 'znaczenia', 'wzorce', 'rozbior']
const KIND_LABEL: Record<string, [string, string]> = {
  czat: ['Odpowiedzi czatu', 'Chat answers'],
  znaczenia: ['Znaczenia z czatu', 'Meanings'],
  wzorce: ['Wzorce pisania', 'Writing patterns'],
  rozbior: ['Rozbiór zdania', 'Sentence parsing'],
  logic: ['Logika', 'Logic'],
}

function ChipRow({ label, testid, value, onPick, items }: { label: string; testid: string; value: string; onPick: (v: string) => void; items: [string, string][] }) {
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
        {items.map(([id, l]) => (
          <button key={id} aria-pressed={value === id} onClick={() => onPick(id)} className={`rounded-full border px-3 py-2 text-sm ${value === id ? 'border-spore/50 bg-spore/15 text-glow' : 'border-white/10 bg-white/5 text-slate-300'}`} data-testid={`${testid}-${id}`}>
            {l}
          </button>
        ))}
      </div>
    </div>
  )
}

const verdictLabel = (v: string, en: boolean) =>
  ({ approve: en ? 'approved' : 'zatwierdzone', reject: en ? 'rejected' : 'odrzucone', correct: en ? 'corrected' : 'poprawione', skip: en ? 'skipped' : 'pominięte' })[v] ?? v

function ItemCard({ item, en, canWrite, onDecide, b }: { item: ReviewItem; en: boolean; canWrite: boolean; onDecide: (i: ReviewItem, v: Verdict, t?: string) => void; b: ReturnType<typeof useBrain> }) {
  const tx = item.taxo && taxoCtx.v ? { ...item.taxo, v: taxoCtx.v } : undefined
  // słowa w taksonomii: od razu pokazujemy kategorie ocenione przez model
  const [edit, setEdit] = useState(!!tx)
  const [val, setVal] = useState(tx ? '' : (item.suggest ?? (item.options?.find((o) => o.value !== item.ai)?.value ?? '')))
  const [valLabel, setValLabel] = useState('')
  const [dx, setDx] = useState(0)
  const start = useRef<number | null>(null)
  const [drag, setDrag] = useState(false)
  const yn = item.options?.length === 2 && item.options[0].value === 'tak'
  const onUp = () => {
    if (start.current === null) return
    start.current = null
    setDrag(false)
    if (canWrite && dx > 90) onDecide(item, 'approve')
    else if (canWrite && dx < -90) onDecide(item, 'reject', yn ? (item.ai === 'tak' ? 'nie' : 'tak') : undefined)
    setDx(0)
  }
  return (
    <section
      className="card touch-pan-y select-none space-y-3"
      style={{ transform: `translateX(${dx}px) rotate(${dx / 40}deg)`, transition: drag ? 'none' : 'transform .2s' }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('button,input,select,textarea')) return
        start.current = e.clientX
        setDrag(true)
      }}
      onPointerMove={(e) => start.current !== null && setDx(e.clientX - start.current)}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      data-testid="review-item"
      data-type={item.type}
      data-ref={item.ref}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="chip text-slate-300">{TYPE_LABEL[item.type][en ? 1 : 0]}</span>
        <span className="chip border-amber/30 text-amber">{item.reason}</span>
      </div>
      {item.img && <Picture id={item.img} b={b} />}
      <h2 className="text-lg font-medium leading-snug text-slate-50" data-testid="review-title">
        {item.title}
      </h2>
      <div className="rounded-xl bg-black/30 p-3">
        <div className="text-xs uppercase tracking-wider text-slate-500">{en ? 'AI says' : 'AI mówi'}</div>
        <div className="mt-1 whitespace-pre-wrap text-base text-glow" data-testid="review-ai">
          {item.aiLabel}
        </div>
        <div className="mt-1 text-xs text-slate-500">
          {en ? 'confidence' : 'pewność'} {pct(item.conf)}
        </div>
      </div>
      {item.evidence.length > 0 && (
        <ul className="space-y-1 text-xs text-slate-400" data-testid="review-evidence">
          {item.evidence.map((e, i) => (
            <li key={i}>• {e}</li>
          ))}
        </ul>
      )}
      {edit && (
        <div className="space-y-2">
          {tx ? (
            <CategoryPicker
              v={tx.v}
              seed={taxoCtx.seed}
              i={tx.i}
              en={en}
              value={val}
              onPick={(value, label) => {
                setVal(value)
                setValLabel(label)
              }}
            />
          ) : item.options && !item.free ? (
            <div className="grid grid-cols-2 gap-2" data-testid="correct-options">
              {item.options.map((o) => (
                <button key={o.value} onClick={() => setVal(o.value)} className={`rounded-xl px-3 py-3 text-sm ${val === o.value ? 'bg-amber/20 text-amber ring-1 ring-amber/40' : 'bg-white/5 text-slate-300'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          ) : (
            <>
              {item.options && (
                <div className="flex flex-wrap gap-2">
                  {item.options.map((o) => (
                    <button key={o.value} onClick={() => setVal(o.value)} className="chip text-slate-300">
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
              <textarea value={val} onChange={(e) => setVal(e.target.value)} rows={item.type === 'chat' ? 4 : 2} className="w-full rounded-xl border border-white/10 bg-black/30 p-3 text-base" placeholder={en ? 'correct answer' : 'poprawna odpowiedź'} data-testid="correct-input" />
            </>
          )}
          {tx && valLabel && (
            <p className="text-xs text-slate-400" data-testid="picked">
              {en ? 'chosen' : 'wybrano'}: <span className="text-amber">{valLabel}</span>
            </p>
          )}
          <button
            disabled={!canWrite || !val.trim()}
            onClick={() => {
              // etykieta wybranej kategorii trafia do fragmentu wiedzy (submit szuka jej w options)
              onDecide(tx && valLabel ? { ...item, options: [...(item.options ?? []).filter((o) => o.value !== val), { value: val, label: valLabel }] } : item, 'correct', val.trim())
            }} className="w-full rounded-2xl bg-amber/25 py-4 text-base font-medium text-amber ring-1 ring-amber/40 disabled:opacity-40" data-testid="correct-save">
            {en ? 'Save correction' : 'Zapisz poprawkę'}
          </button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button disabled={!canWrite} onClick={() => onDecide(item, 'approve')} className="rounded-2xl bg-spore/20 py-4 text-base font-medium text-spore ring-1 ring-spore/40 disabled:opacity-40" data-testid="btn-approve">
          ✓ {en ? 'Approve' : 'Zatwierdź'}
        </button>
        <button disabled={!canWrite} onClick={() => onDecide(item, 'reject', yn ? (item.ai === 'tak' ? 'nie' : 'tak') : undefined)} className="rounded-2xl bg-rose/15 py-4 text-base font-medium text-rose ring-1 ring-rose/40 disabled:opacity-40" data-testid="btn-reject">
          ✕ {en ? 'Reject' : 'Odrzuć'}
        </button>
        <button disabled={!canWrite} onClick={() => setEdit((e) => !e)} className="rounded-2xl bg-amber/10 py-4 text-base font-medium text-amber ring-1 ring-amber/30 disabled:opacity-40" data-testid="btn-correct">
          ✎ {en ? 'Correct' : 'Popraw'}
        </button>
        <button disabled={!canWrite} onClick={() => onDecide(item, 'skip')} className="rounded-2xl bg-white/5 py-4 text-base text-slate-300 ring-1 ring-white/10 disabled:opacity-40" data-testid="btn-skip">
          ↷ {en ? 'Skip' : 'Pomiń'}
        </button>
      </div>
      {tx && (
        <button disabled={!canWrite} onClick={() => onDecide(item, 'reject', 'notword')} className={`w-full rounded-2xl py-3 text-sm ring-1 disabled:opacity-40 ${tx.suspect ? 'bg-rose/15 text-rose ring-rose/40' : 'bg-white/5 text-slate-400 ring-white/10'}`} data-testid="btn-notword">
          ⚠ {en ? 'Not a word / dictionary error' : 'To nie jest słowo / błąd w słowniku'}
        </button>
      )}
      <p className="text-center text-[11px] text-slate-500">{en ? 'swipe right = approve · left = reject' : 'przesuń w prawo = zatwierdź · w lewo = odrzuć'}</p>
    </section>
  )
}

/** Obraz z zadania captcha (28×28 z prawdziwego zbioru) albo wykres odcinka czujnika. */
function Picture({ id, b }: { id: string; b: ReturnType<typeof useBrain> }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const spark = id.startsWith('spark:') ? id.slice(6).split(',').map(Number) : undefined
  useEffect(() => {
    const px = b.cap?.img.get(id)
    const c = ref.current
    if (!px || !c) return
    const ctx = c.getContext('2d')!
    const im = ctx.createImageData(28, 28)
    for (let i = 0; i < 784; i++) {
      const v = px[i]
      im.data.set([v, v, v, 255], i * 4)
    }
    ctx.putImageData(im, 0, 0)
  }, [id, b.cap])
  if (spark) {
    const lo = Math.min(...spark)
    const hi = Math.max(...spark)
    const pts = spark.map((v, i) => `${(i / (spark.length - 1)) * 300},${80 - ((v - lo) / (hi - lo || 1)) * 76 - 2}`).join(' ')
    return (
      <svg viewBox="0 0 300 80" className="h-24 w-full rounded-xl bg-black/30">
        <polyline points={pts} fill="none" stroke="#5eead4" strokeWidth="2" />
      </svg>
    )
  }
  return <canvas ref={ref} width={28} height={28} className="mx-auto h-40 w-40 rounded-xl bg-black [image-rendering:pixelated]" data-testid="review-img" />
}

function Mistakes({ stats, log, en, owner }: { stats: ReviewStat[]; log: LogRow[]; en: boolean; owner: boolean }) {
  const byType = new Map<string, { ok: number; wrong: number; n: number }>()
  for (const s of stats) {
    const k = s.item_type
    const v = byType.get(k) ?? { ok: 0, wrong: 0, n: 0 }
    v.ok += s.ai_ok
    v.wrong += s.ai_wrong
    v.n += s.n
    byType.set(k, v)
  }
  const days = [...new Set(stats.map((s) => s.day))].sort()
  let cumOk = 0
  let cumWrong = 0
  const pts: Point[] = days.map((d) => {
    const ss = stats.filter((s) => s.day === d)
    const o = ss.reduce((n, s) => n + s.ai_ok, 0)
    const w = ss.reduce((n, s) => n + s.ai_wrong, 0)
    cumOk += o
    cumWrong += w
    return { t: Date.parse(`${d}T12:00:00`), day: o + w ? (o / (o + w)) * 100 : null, cum: cumOk + cumWrong ? (cumOk / (cumOk + cumWrong)) * 100 : null, wrong: w }
  })
  const fixes = log.filter((l) => l.verdict === 'correct' || l.verdict === 'reject')
  return (
    <div className="space-y-4" data-testid="mistakes">
      <Card title={en ? 'Where the AI was wrong (by type)' : 'Gdzie AI się myliło (wg rodzaju)'}>
        {byType.size === 0 ? (
          <p className="text-sm text-slate-500">{en ? 'No reviewed items yet.' : 'Jeszcze nic nie sprawdzono.'}</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {[...byType.entries()]
              .sort((a, c) => c[1].wrong - a[1].wrong)
              .map(([k, v]) => (
                <li key={k} className="flex items-center justify-between gap-2" data-testid="mistake-row">
                  <span className="text-slate-300">{TYPE_LABEL[k]?.[en ? 1 : 0] ?? k}</span>
                  <span className="tabular-nums text-slate-400">
                    <span className="text-rose">{v.wrong}</span> {en ? 'wrong' : 'błędów'} · <span className="text-spore">{v.ok}</span> ok
                  </span>
                </li>
              ))}
          </ul>
        )}
      </Card>
      <Card title={en ? 'AI accuracy vs your corrections over time' : 'Trafność AI wobec Twoich poprawek w czasie'}>
        <TimeChart
          data={pts}
          unit="%"
          domain={[0, 100]}
          series={[
            { key: 'day', name: en ? 'that day' : 'danego dnia', color: '#fbbf24' },
            { key: 'cum', name: en ? 'cumulative' : 'narastająco', color: '#5eead4' },
          ]}
        />
      </Card>
      {owner && fixes.length > 0 && (
        <Card title={en ? 'Latest corrections' : 'Ostatnie poprawki'}>
          <ul className="space-y-2 text-sm">
            {fixes.slice(0, 20).map((l) => (
              <li key={l.id} className="rounded-xl bg-black/20 p-2">
                <div className="text-xs text-slate-500">
                  {TYPE_LABEL[l.item_type]?.[en ? 1 : 0]} · {l.item_ref}
                </div>
                <div>
                  <span className="text-rose line-through">{l.ai_answer}</span> → <span className="text-spore">{l.truth ?? (en ? '(rejected)' : '(odrzucone)')}</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function Log({ log, en, owner }: { log: LogRow[]; en: boolean; owner: boolean }) {
  const { lang } = useI18n()
  if (!owner) return <div className="card text-sm text-slate-400">{en ? 'The full audit log (who, when, before → after) is visible with the owner key.' : 'Pełny dziennik (kto, kiedy, przed → po) widać z kluczem właściciela.'}</div>
  if (!log.length) return <div className="card text-sm text-slate-500">{en ? 'No decisions yet.' : 'Jeszcze brak decyzji.'}</div>
  return (
    <ul className="space-y-2" data-testid="review-log">
      {log.map((l) => (
        <li key={l.id} className={`card text-sm ${l.undone_at ? 'opacity-50' : ''}`}>
          <div className="flex justify-between text-xs text-slate-500">
            <span>
              #{l.id} · {l.reviewer} · {TYPE_LABEL[l.item_type]?.[en ? 1 : 0]}
            </span>
            <span>{ago(l.created_at, lang)}</span>
          </div>
          <div className="mt-1">
            {verdictLabel(l.verdict, en)}: <span className="text-slate-400">{l.ai_answer}</span>
            {l.truth && l.truth !== l.ai_answer && (
              <>
                {' '}
                → <span className="text-spore">{l.truth}</span>
              </>
            )}
            {l.undone_at && <span className="ml-2 text-amber">({l.undone_reason === 'undo' ? (en ? 'undone' : 'cofnięte') : en ? 'superseded' : 'zastąpione'})</span>}
          </div>
          {Object.keys(l.before).length > 0 && <div className="mt-1 truncate text-[11px] text-slate-500">{en ? 'before' : 'przed'}: {JSON.stringify(l.before)}</div>}
        </li>
      ))}
    </ul>
  )
}
