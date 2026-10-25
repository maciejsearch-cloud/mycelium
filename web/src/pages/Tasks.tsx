// Zadania w stylu captcha: każde daje prawdziwe dane do treningu, ukryte pytania kontrolne pilnują wiarygodności.
import { useEffect, useMemo, useState, type PointerEvent as RPE } from 'react'
import { Card, Kpi, PageHeader } from '../components/ui'
import { TimeChart, type Point } from '../components/TimeChart'
import { L, useI18n } from '../i18n'
import { useBrain } from '../myc/brain'
import { imgQid, LETTERS, ROT, taskKind } from '../myc/vision'
import { Px } from '../components/Px'

type TaskId = 'cg' | 'cb' | 'ct' | 'co' | 'cr' | 'cm'
const TASKS: { id: TaskId; pl: string; en: string; icon: string }[] = [
  { id: 'cg', pl: 'Zaznacz obrazki', en: 'Select images', icon: '▦' },
  { id: 'cb', pl: 'Przeciągnij do koszy', en: 'Drag into bins', icon: '⇲' },
  { id: 'ct', pl: 'Przepisz litery', en: 'Transcribe letters', icon: '✍' },
  { id: 'co', pl: 'Ustaw kolejność', en: 'Put in order', icon: '⇅' },
  { id: 'cr', pl: 'Obróć prosto', en: 'Rotate upright', icon: '⟳' },
  { id: 'cm', pl: 'Dopasuj pary', en: 'Match pairs', icon: '⇄' },
]
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const shuffle = <T,>(a: T[], seed: number) => {
  const o = [...a]
  let s = seed || 1
  for (let i = o.length - 1; i > 0; i--) {
    s = (s * 16807) % 2147483647
    const j = s % (i + 1)
    ;[o[i], o[j]] = [o[j], o[i]]
  }
  return o
}

export default function Tasks() {
  const b = useBrain()
  const en = useI18n().lang === 'en'
  const [task, setTask] = useState<TaskId>('cg')
  const [round, setRound] = useState(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void b.loadCaptcha()
  }, [b])
  const next = () => setRound((r) => r + 1)
  const done = b.mine()
  const v = b.vis

  return (
    <>
      <PageHeader title={en ? 'Tasks' : 'Zadania'}>
        <L
          pl="Krótkie zadania jak w captcha. Każda odpowiedź to prawdziwa etykieta dla modeli (obrazy Fashion-MNIST, odręczne litery EMNIST, pary słów z plWordNet i WordNetu). Część zadań to ukryte pytania kontrolne – na nich grzybnia mierzy wiarygodność węzła."
          en="Short captcha-style tasks. Every answer is a real label for the models (Fashion-MNIST images, EMNIST handwritten letters, word pairs from plWordNet and WordNet). Some are hidden gold questions – the mycelium uses them to measure node reliability."
        />
      </PageHeader>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Kpi label={en ? 'Images model' : 'Model obrazów'} value={v ? pct(v.acc.fashion) : '…'} hint={v ? `${en ? 'seed only' : 'tylko start'} ${pct(v.acc.fashion_seed)} · ${v.labels.fashion} ${en ? 'labels from people' : 'etykiet od ludzi'}` : ''} src={en ? 'accuracy on the fixed Fashion-MNIST test sample, computed in this browser' : 'trafność na stałej próbce testowej Fashion-MNIST, policzona w tej przeglądarce'} />
        <Kpi label={en ? 'Letters model' : 'Model liter'} value={v ? pct(v.acc.letters) : '…'} hint={v ? `${en ? 'seed only' : 'tylko start'} ${pct(v.acc.letters_seed)} · ${v.labels.letters} ${en ? 'labels' : 'etykiet'}` : ''} tone="violet" src={en ? 'accuracy on the fixed EMNIST letters test sample, computed in this browser' : 'trafność na stałej próbce testowej liter EMNIST, policzona w tej przeglądarce'} />
        <Kpi label={en ? 'My task answers' : 'Moje odpowiedzi w zadaniach'} value={[...done].filter((q) => q[0] === 'c').length} tone="amber" src={en ? 'your answers in myc_answers' : 'Twoje odpowiedzi w myc_answers'} verif="db" />
        <div className="flex items-stretch">
          <button
            onClick={async () => {
              setBusy(true)
              await b.learnVision()
              setBusy(false)
            }}
            disabled={busy || !b.cap}
            className="w-full rounded-2xl bg-spore/90 px-4 py-2.5 font-medium text-ink hover:bg-spore disabled:opacity-50"
            data-testid="learn-vision"
          >
            {busy ? (en ? 'Training…' : 'Trenuję…') : en ? 'Learn now (images)' : 'Ucz teraz (obrazy)'}
          </button>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5" role="tablist">
        {TASKS.map((t) => (
          <button key={t.id} role="tab" aria-selected={task === t.id} onClick={() => setTask(t.id)} className={`rounded-xl px-3 py-1.5 text-sm ${task === t.id ? 'bg-spore/15 text-glow ring-1 ring-spore/30' : 'text-slate-400 hover:bg-white/5'}`} data-task={t.id}>
            <span aria-hidden className="mr-1">
              {t.icon}
            </span>
            {en ? t.en : t.pl}
          </button>
        ))}
      </div>
      <div className="mt-3 grid gap-4 xl:grid-cols-5">
        <Card title={TASKS.find((t) => t.id === task)![en ? 'en' : 'pl']} className="xl:col-span-3">
          {!b.cap ? (
            <div className="h-48 animate-pulse rounded-xl bg-white/5" />
          ) : (
            <div data-testid="task" data-task={task} key={`${task}-${round}`}>
              {task === 'cg' && <Grid seed={round} onDone={next} />}
              {task === 'cb' && <Bins seed={round} onDone={next} />}
              {task === 'ct' && <Transcribe onDone={next} />}
              {task === 'co' && <Order onDone={next} />}
              {task === 'cr' && <Rotate onDone={next} />}
              {task === 'cm' && <Match seed={round} onDone={next} />}
            </div>
          )}
        </Card>
        <TaskStats />
      </div>
    </>
  )
}

function useFresh() {
  const b = useBrain()
  const done = b.mine()
  return { b, done }
}

function Submit({ onClick, disabled, label }: { onClick: () => void; disabled?: boolean; label?: string }) {
  const en = useI18n().lang === 'en'
  return (
    <button onClick={onClick} disabled={disabled} className="mt-3 rounded-xl bg-spore/90 px-4 py-2 text-sm font-medium text-ink hover:bg-spore disabled:opacity-40" data-testid="task-submit">
      {label ?? (en ? 'Submit' : 'Zatwierdź')}
    </button>
  )
}

/** Siatka 3×3: zaznacz wszystkie obrazki z daną klasą (aktywne uczenie: połowa to najpewniejsze trafienia modelu). */
function Grid({ seed, onDone }: { seed: number; onDone: () => void }) {
  const { b, done } = useFresh()
  const en = useI18n().lang === 'en'
  const cap = b.cap!
  // klasa docelowa: ta z największą liczbą jeszcze nieocenionych obrazków (aktywne uczenie), remis – kolejna wg ziarna
  const [target] = useState(() => {
    const left = Array.from({ length: 10 }, (_, c) => cap.fashion.pool.filter((q) => !done.has(imgQid(q.id, c))).length)
    return Array.from({ length: 10 }, (_, i) => (seed + i) % 10).reduce((a, c) => (left[c] > left[a] ? c : a))
  })
  const items = useMemo(() => {
    const free = cap.fashion.pool.filter((q) => !done.has(imgQid(q.id, target)))
    const m = b.vis?.fashion
    const scored = free.map((q) => ({ q, p: m ? m.proba(cap.x.get(q.id)!)[target] : 0 })) // bez modelu: brak rankingu, kolejność z ziarna.sort((x, y) => y.p - x.p)
    return shuffle([...scored.slice(0, 4), ...shuffle(scored.slice(4), seed + 3).slice(0, 5)].map((s) => s.q), seed + 1)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [sel, setSel] = useState<string[]>([])
  if (!items.length) return <p className="text-sm text-slate-400">{en ? 'All images done – thank you!' : 'Wszystkie obrazki zrobione – dziękuję!'}</p>
  const name = en ? cap.fashion.classes_en[target] : cap.fashion.classes_pl[target]
  return (
    <div>
      <p className="text-slate-200">
        {en ? 'Select all images with: ' : 'Zaznacz wszystkie obrazki, na których jest: '}
        <b className="text-glow" data-testid="target">{name}</b>
      </p>
      <div className="mt-3 grid w-fit grid-cols-3 gap-2">
        {items.map((q) => (
          <button key={q.id} onClick={() => setSel((s) => (s.includes(q.id) ? s.filter((x) => x !== q.id) : [...s, q.id]))} aria-pressed={sel.includes(q.id)} className={`relative rounded-xl p-1 ring-2 ${sel.includes(q.id) ? 'ring-spore' : 'ring-transparent hover:ring-white/20'}`} data-img={q.id}>
            <Px px={cap.img.get(q.id)} size={88} />
            {sel.includes(q.id) && <span className="absolute right-1 top-1 rounded-full bg-spore px-1.5 text-xs text-ink">✓</span>}
          </button>
        ))}
      </div>
      <Submit
        onClick={() => {
          b.answerMany(items.map((q) => [imgQid(q.id, target), sel.includes(q.id) ? 'tak' : 'nie']))
          onDone()
        }}
        label={sel.length ? undefined : en ? 'None of them' : 'Żaden'}
      />
    </div>
  )
}

/** Przeciąganie (mysz/dotyk) albo dotknij obrazek, potem kosz. */
function Bins({ seed, onDone }: { seed: number; onDone: () => void }) {
  const { b, done } = useFresh()
  const en = useI18n().lang === 'en'
  const cap = b.cap!
  const { items, bins } = useMemo(() => {
    const free = cap.fashion.pool.filter((q) => !done.has(imgQid(q.id, 0)) && !done.has(imgQid(q.id, 5)))
    const its = shuffle(free, seed + 11).slice(0, 4)
    const m = b.vis?.fashion
    const votes = new Array(10).fill(0)
    for (const q of its) if (m) {
      const p = m.proba(cap.x.get(q.id)!)
      votes[p.indexOf(Math.max(...p))]++
    }
    const bs = [...votes.keys()].sort((x, y) => votes[y] - votes[x] || x - y).slice(0, 3)
    return { items: its, bins: bs }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [place, setPlace] = useState<Record<string, number>>({})
  const [pick, setPick] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null)
  const drop = (id: string, bin: number) => setPlace((p) => ({ ...p, [id]: bin }))
  const onUp = (e: RPE) => {
    if (!drag) return
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-bin]') as HTMLElement | null
    if (el) drop(drag.id, Number(el.dataset.bin))
    setDrag(null)
  }
  if (!items.length) return <p className="text-sm text-slate-400">{en ? 'All done!' : 'Wszystko zrobione!'}</p>
  const cls = (k: number) => (k < 0 ? (en ? 'none of these' : 'żadne z tych') : en ? cap.fashion.classes_en[k] : cap.fashion.classes_pl[k])
  const loose = items.filter((q) => place[q.id] === undefined)
  const img = (id: string) => (
    <div
      key={id}
      onPointerDown={(e) => {
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
        setDrag({ id, x: e.clientX, y: e.clientY })
        setPick(id)
      }}
      onPointerMove={(e) => drag && setDrag({ ...drag, x: e.clientX, y: e.clientY })}
      onPointerUp={onUp}
      className={`cursor-grab touch-none rounded-lg p-0.5 ring-2 ${pick === id ? 'ring-spore' : 'ring-transparent'}`}
      data-img={id}
    >
      <Px px={cap.img.get(id)} size={64} />
    </div>
  )
  return (
    <div>
      <p className="text-slate-200">{en ? 'Drag each image into the right bin (or tap the image, then the bin).' : 'Przeciągnij każdy obrazek do właściwego kosza (albo dotknij obrazek, potem kosz).'}</p>
      <div className="mt-3 flex min-h-20 flex-wrap gap-2 rounded-xl border border-dashed border-white/10 p-2">{loose.map((q) => img(q.id))}</div>
      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        {[...bins, -1].map((k) => (
          <div key={k} data-bin={k} onClick={() => pick && (drop(pick, k), setPick(null))} className="min-h-24 rounded-xl border border-white/10 bg-white/5 p-2">
            <div className="mb-1 text-xs font-medium text-slate-300">{cls(k)}</div>
            <div className="flex flex-wrap gap-1">{items.filter((q) => place[q.id] === k).map((q) => img(q.id))}</div>
          </div>
        ))}
      </div>
      {drag && (
        <div className="pointer-events-none fixed z-50 opacity-80" style={{ left: drag.x - 32, top: drag.y - 32 }}>
          <Px px={cap.img.get(drag.id)} size={64} />
        </div>
      )}
      <Submit
        disabled={loose.length > 0}
        onClick={() => {
          b.answerMany(items.flatMap((q) => bins.map((k) => [imgQid(q.id, k), place[q.id] === k ? 'tak' : 'nie'] as [string, string])))
          onDone()
        }}
      />
    </div>
  )
}

/** Przepisz 4 odręczne litery (EMNIST). */
function Transcribe({ onDone }: { onDone: () => void }) {
  const { b, done } = useFresh()
  const en = useI18n().lang === 'en'
  const cap = b.cap!
  const items = useMemo(() => shuffle(cap.letters.pool.filter((q) => !done.has(q.id)), Date.now() % 9973).slice(0, 4), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [t, setT] = useState('')
  const val = t.toLowerCase().replace(/[^a-z]/g, '')
  if (!items.length) return <p className="text-sm text-slate-400">{en ? 'All letters done!' : 'Wszystkie litery zrobione!'}</p>
  const send = () => {
    if (val.length !== items.length) return
    b.answerMany(items.map((q, i) => [q.id, val[i]]))
    onDone()
  }
  return (
    <div>
      <p className="text-slate-200">{en ? 'Type the handwritten letters (a–z, in order):' : 'Przepisz odręczne litery (a–z, po kolei):'}</p>
      <div className="mt-3 flex gap-1">
        {items.map((q) => (
          <Px key={q.id} px={cap.img.get(q.id)} size={72} />
        ))}
      </div>
      <input value={t} onChange={(e) => setT(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} maxLength={8} autoCapitalize="none" autoComplete="off" className="mt-3 w-40 rounded-lg border border-white/10 bg-ink/60 px-3 py-2 font-mono text-lg tracking-[0.5em] text-slate-100" aria-label={en ? 'Letters' : 'Litery'} data-testid="transcribe-input" />
      <Submit onClick={send} disabled={val.length !== items.length} />
      <p className="mt-1 text-xs text-slate-500">{en ? 'Unsure? Type your best guess – several people answer each letter.' : 'Nie masz pewności? Wpisz najlepszy strzał – każdą literę ocenia kilka osób.'}</p>
    </div>
  )
}

/** Kolejność 4 wydarzeń od najstarszego (strzałki lub przeciąganie). */
function Order({ onDone }: { onDone: () => void }) {
  const { b, done } = useFresh()
  const en = useI18n().lang === 'en'
  const cap = b.cap!
  const q = useMemo(() => shuffle(cap.order.filter((x) => !done.has(x.id)), Date.now() % 7919)[0], []) // eslint-disable-line react-hooks/exhaustive-deps
  const [ord, setOrd] = useState([0, 1, 2, 3])
  const [dragI, setDragI] = useState<number | null>(null)
  if (!q) return <p className="text-sm text-slate-400">{en ? 'All done!' : 'Wszystko zrobione!'}</p>
  const move = (i: number, d: number) => setOrd((o) => {
    const j = i + d
    if (j < 0 || j >= o.length) return o
    const c = [...o]
    ;[c[i], c[j]] = [c[j], c[i]]
    return c
  })
  return (
    <div>
      <p className="text-slate-200">{en ? 'Order from the earliest to the latest:' : 'Ustaw od najwcześniejszego do najpóźniejszego:'}</p>
      <ol className="mt-3 space-y-1.5">
        {ord.map((k, i) => (
          <li
            key={k}
            draggable
            onDragStart={() => setDragI(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => dragI !== null && (move(dragI, i - dragI), setDragI(null))}
            className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm"
            data-item={'abcd'[k]}
          >
            <span className="w-5 text-slate-500">{i + 1}.</span>
            <span className="flex-1 text-slate-100">{en ? q.items[k].en : q.items[k].pl}</span>
            <button onClick={() => move(i, -1)} aria-label={en ? 'up' : 'w górę'} className="rounded px-2 text-slate-400 hover:text-glow" data-up={i}>
              ↑
            </button>
            <button onClick={() => move(i, 1)} aria-label={en ? 'down' : 'w dół'} className="rounded px-2 text-slate-400 hover:text-glow">
              ↓
            </button>
          </li>
        ))}
      </ol>
      <Submit
        onClick={() => {
          b.answerMany([[q.id, ord.map((k) => 'abcd'[k]).join('')]])
          onDone()
        }}
      />
    </div>
  )
}

/** Obróć obrazek, aż będzie prosto. */
function Rotate({ onDone }: { onDone: () => void }) {
  const { b, done } = useFresh()
  const en = useI18n().lang === 'en'
  const cap = b.cap!
  const q = useMemo(() => shuffle(cap.fashion.rotate.filter((x) => !done.has(x.id)), Date.now() % 6151)[0], []) // eslint-disable-line react-hooks/exhaustive-deps
  const [r, setR] = useState(0)
  if (!q) return <p className="text-sm text-slate-400">{en ? 'All done!' : 'Wszystko zrobione!'}</p>
  return (
    <div>
      <p className="text-slate-200">{en ? 'Rotate the picture until it is upright:' : 'Obracaj obrazek, aż będzie prosto:'}</p>
      <div className="mt-3 flex items-center gap-3">
        <button onClick={() => setR((x) => (x + 3) % 4)} className="rounded-xl border border-white/10 px-3 py-2 text-lg" aria-label={en ? 'rotate left' : 'obróć w lewo'} data-testid="rot-left">
          ⟲
        </button>
        <Px px={cap.img.get(q.id)} size={140} rot={r} />
        <button onClick={() => setR((x) => (x + 1) % 4)} className="rounded-xl border border-white/10 px-3 py-2 text-lg" aria-label={en ? 'rotate right' : 'obróć w prawo'} data-testid="rot-right">
          ⟳
        </button>
      </div>
      <Submit
        onClick={() => {
          b.answerMany([[q.id, ROT[r]]])
          onDone()
        }}
      />
    </div>
  )
}

/** Dopasuj polskie słowa do angielskich (pary z plWordNet ↔ OEWN, część niepewna). */
function Match({ seed, onDone }: { seed: number; onDone: () => void }) {
  const { b, done } = useFresh()
  const en = useI18n().lang === 'en'
  const cap = b.cap!
  const items = useMemo(() => shuffle(cap.pairs.filter((x) => !done.has(x.id)), seed + 29 + (Date.now() % 997)).slice(0, 4), []) // eslint-disable-line react-hooks/exhaustive-deps
  const right = useMemo(() => shuffle(items.map((x) => x.id), seed + 5), [items, seed])
  const [left, setLeft] = useState<string | null>(null)
  const [pairs, setPairs] = useState<Record<string, string>>({})
  if (!items.length) return <p className="text-sm text-slate-400">{en ? 'All done!' : 'Wszystko zrobione!'}</p>
  const used = new Set(Object.values(pairs))
  const color = (id: string) => ['bg-spore/20', 'bg-violet/20', 'bg-amber/20', 'bg-rose/20'][items.findIndex((x) => x.id === id) % 4]
  return (
    <div>
      <p className="text-slate-200">{en ? 'Tap a Polish word, then its English translation. Leave out pairs that do not fit.' : 'Dotknij polskie słowo, potem jego angielskie tłumaczenie. Słowa bez pary zostaw.'}</p>
      <div className="mt-3 grid max-w-md grid-cols-2 gap-2">
        <div className="space-y-1.5">
          {items.map((x) => (
            <button key={x.id} onClick={() => setLeft(x.id)} className={`w-full rounded-xl border px-3 py-2 text-left text-sm ${left === x.id ? 'border-spore' : 'border-white/10'} ${pairs[x.id] ? color(x.id) : ''}`} data-pl={x.id}>
              {x.pl}
            </button>
          ))}
        </div>
        <div className="space-y-1.5">
          {right.map((id) => {
            const owner = Object.keys(pairs).find((k) => pairs[k] === id)
            return (
              <button
                key={id}
                onClick={() => left && setPairs((p) => ({ ...Object.fromEntries(Object.entries(p).filter(([k, v]) => k !== left && v !== id)), [left]: id }))}
                className={`w-full rounded-xl border border-white/10 px-3 py-2 text-left text-sm ${owner ? color(owner) : used.has(id) ? '' : ''}`}
                data-en={id}
              >
                {items.find((x) => x.id === id)!.en}
              </button>
            )
          })}
        </div>
      </div>
      <Submit
        onClick={() => {
          b.answerMany(items.map((x) => [x.id, pairs[x.id] === x.id ? 'tak' : 'nie']))
          onDone()
        }}
      />
    </div>
  )
}

const KIND_NAMES: Record<string, [string, string]> = {
  cg: ['obrazki / kosze', 'images / bins'],
  ct: ['litery', 'letters'],
  co: ['kolejność', 'order'],
  cr: ['obrót', 'rotation'],
  cm: ['pary słów', 'word pairs'],
  w: ['słowa', 'words'],
}
const COLORS: Record<string, string> = { cg: '#5eead4', ct: '#a78bfa', co: '#fbbf24', cr: '#fb7185', cm: '#38bdf8', w: '#a3e635' }

/** Statystyki per rodzaj zadania: odpowiedzi dziennie (z bazy) i trafność na pytaniach kontrolnych. */
function TaskStats() {
  const b = useBrain()
  const en = useI18n().lang === 'en'
  const d = b.store.data
  const kinds = Object.keys(KIND_NAMES)
  const day = (t: string) => new Date(new Date(t).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' })).getTime()
  const perDay = new Map<number, Record<string, number>>()
  for (const a of d.answers) {
    const k = taskKind(a.question_id)
    if (!kinds.includes(k) || !a.created_at) continue
    const t = day(a.created_at)
    const r = perDay.get(t) ?? {}
    r[k] = (r[k] ?? 0) + 1
    perDay.set(t, r)
  }
  const counts: Point[] = [...perDay].map(([t, r]) => ({ t, ...r }))
  const goldPts = new Map<number, Record<string, number>>()
  for (const g of d.goldByType ?? []) {
    if (!kinds.includes(g.kind) || !g.n) continue
    const t = new Date(g.day).getTime()
    goldPts.set(t, { ...(goldPts.get(t) ?? {}), [g.kind]: (100 * g.correct) / g.n })
  }
  const gold: Point[] = [...goldPts].map(([t, r]) => ({ t, ...r }))
  const series = kinds.map((k) => ({ key: k, name: KIND_NAMES[k][en ? 1 : 0], color: COLORS[k] }))
  const tot = (k: string) => d.answers.filter((a) => taskKind(a.question_id) === k).length
  return (
    <Card title={en ? 'Task statistics (real data)' : 'Statystyki zadań (prawdziwe dane)'} className="xl:col-span-2">
      <div className="mb-2 flex flex-wrap gap-2 text-xs" data-testid="task-totals">
        {kinds.map((k) => (
          <span key={k} className="chip" style={{ color: COLORS[k] }}>
            {KIND_NAMES[k][en ? 1 : 0]}: {tot(k)}
          </span>
        ))}
      </div>
      <div className="text-xs text-slate-400">{en ? 'Answers per day' : 'Odpowiedzi dziennie'}</div>
      <TimeChart data={counts} series={series} h="h-40" />
      <div className="mt-3 text-xs text-slate-400">{en ? 'Gold-question accuracy per day (%)' : 'Trafność na pytaniach kontrolnych dziennie (%)'}</div>
      <TimeChart data={gold} series={series} unit="%" domain={[0, 100]} h="h-40" />
      <p className="mt-2 text-xs text-slate-500">{LETTERS.length} {en ? 'letter classes' : 'klas liter'} · Fashion-MNIST 10 · EMNIST · plWordNet/OEWN</p>
    </Card>
  )
}
