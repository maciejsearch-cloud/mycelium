// Mówca AI w czacie globalnym: narzędzia pod wpisem (ocena, kategoria, etykiety, szyk słów dotykiem, poprawka/odpowiedź)
// i panel poziomów z trafnością (plus sterowanie dla Developera). Liczby wyłącznie z bazy; brak ocen = „brak ocen”.
import { useState } from 'react'
import { bare, LEVEL_NAME, speakerAdmin, speakerRate, SPK_CATS, SPK_TASKS, type SpkState, type SpkSummary } from '../myc/speaker'

const btn = 'rounded-lg border px-2 py-1.5 text-xs'

export function SpeakerTools({ s, canRate, en, onDone }: { s: SpkSummary; canRate: boolean; en: boolean; onDone: () => void }) {
  const L = (pl: string, e: string) => (en ? e : pl)
  const [open, setOpen] = useState(false)
  const [order, setOrder] = useState<number[]>([])
  const [fixed, setFixed] = useState('')
  const [labels, setLabels] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const mine = s.mine
  const send = async (v: Parameters<typeof speakerRate>[1]) => {
    setBusy(true)
    setErr('')
    try {
      await speakerRate(s.msg_id, v)
      onDone()
    } catch (e) {
      setErr((e as Error).message)
    }
    setBusy(false)
  }
  const isQ = s.tokens[s.tokens.length - 1]?.endsWith('?')
  return (
    <div className="mt-1 text-xs" data-testid="spk-tools">
      <div className="flex flex-wrap items-center gap-1.5 text-slate-400">
        <span className="chip border-sky-400/40 px-1.5 py-0 text-[10px] text-sky-300" title={L('sposób powstania wpisu', 'how the post was made')}>
          {LEVEL_NAME[s.level]?.[en ? 1 : 0]} · {s.how}
        </span>
        <span data-testid="spk-score">
          👍 {s.sense} · 👎 {s.nonsense}
          {s.category ? ` · ${s.category}` : ''}
          {s.task_type ? ` · ${s.task_type}` : ''}
          {s.labels?.length ? ` · #${s.labels.join(' #')}` : ''}
        </span>
        {canRate && (
          <>
            <button
              disabled={busy}
              className={`${btn} ${mine?.sense === 1 ? 'border-spore bg-spore/15 text-spore' : 'border-white/10'}`}
              onClick={() => void send({ sense: 1 })}
              data-testid="spk-sense"
            >
              {L('sensowne', 'makes sense')}
            </button>
            <button
              disabled={busy}
              className={`${btn} ${mine?.sense === -1 ? 'border-rose bg-rose/15 text-rose' : 'border-white/10'}`}
              onClick={() => void send({ sense: -1 })}
              data-testid="spk-nonsense"
            >
              {L('bez sensu', 'nonsense')}
            </button>
            <button className={`${btn} border-white/10`} onClick={() => setOpen(!open)} data-testid="spk-more">
              {open ? L('zwiń', 'less') : L('popraw / opisz', 'fix / describe')}
            </button>
          </>
        )}
      </div>
      {s.fixes?.length || s.answers?.length ? (
        <div className="mt-0.5 text-[11px] text-slate-500">
          {s.fixes?.length ? `${L('poprawki', 'fixes')}: ${s.fixes.map((f) => `„${f.t}” ×${f.n}`).join(', ')}` : ''}
          {s.answers?.length ? ` ${L('odpowiedzi', 'answers')}: ${s.answers.map((f) => `„${f.t}” ×${f.n}`).join(', ')}` : ''}
        </div>
      ) : null}
      {open && canRate && (
        <div className="mt-2 space-y-2 rounded-xl border border-white/10 p-2" data-testid="spk-panel">
          <div className="flex flex-wrap gap-1">
            {SPK_CATS.map((c) => (
              <button key={c} className={`${btn} ${mine?.category === c ? 'border-spore text-spore' : 'border-white/10'}`} onClick={() => void send({ category: c })}>
                {c}
              </button>
            ))}
            <select
              className="rounded-lg border border-white/10 bg-black/30 px-2 py-1.5"
              value={mine?.task_type ?? ''}
              onChange={(e) => e.target.value && void send({ task: e.target.value })}
              data-testid="spk-task"
            >
              <option value="">{L('typ zadania…', 'task type…')}</option>
              {SPK_TASKS.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="mb-1 text-slate-400">{L('Ułóż słowa we właściwej kolejności (stuknij po kolei):', 'Put the words in the right order (tap in turn):')}</div>
            <div className="flex flex-wrap gap-1" data-testid="spk-words">
              {s.tokens.map((t, i) =>
                order.includes(i + 1) ? null : (
                  <button key={i} className={`${btn} border-white/15 text-sm`} onClick={() => setOrder([...order, i + 1])}>
                    {bare(t)}
                  </button>
                ),
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="spk-order">
              <span className="text-slate-500">→</span>
              {order.map((o, k) => (
                <button key={k} className={`${btn} border-spore/40 text-sm text-spore`} onClick={() => setOrder(order.filter((x) => x !== o))}>
                  {bare(s.tokens[o - 1])}
                </button>
              ))}
              {order.length === s.tokens.length && (
                <button
                  disabled={busy}
                  className={`${btn} border-spore bg-spore/15 text-spore`}
                  onClick={() => void send({ order }).then(() => setOrder([]))}
                  data-testid="spk-order-send"
                >
                  {L('zapisz szyk', 'save order')}
                </button>
              )}
              {order.length > 0 && (
                <button className="text-slate-500 underline" onClick={() => setOrder([])}>
                  {L('od nowa', 'reset')}
                </button>
              )}
            </div>
          </div>
          <div className="flex gap-1">
            <input
              value={fixed}
              onChange={(e) => setFixed(e.target.value)}
              maxLength={200}
              placeholder={isQ ? L('poprawione pytanie albo odpowiedź…', 'corrected question or answer…') : L('poprawione zdanie…', 'corrected sentence…')}
              className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm"
              data-testid="spk-fixed"
            />
            <button
              disabled={busy || !fixed.trim()}
              className={`${btn} border-white/15`}
              onClick={() => void send({ fixed: fixed.trim() }).then(() => setFixed(''))}
              data-testid="spk-fixed-send"
            >
              {L('poprawka', 'fix')}
            </button>
            {isQ && (
              <button
                disabled={busy || !fixed.trim()}
                className={`${btn} border-white/15`}
                onClick={() => void send({ answer: fixed.trim() }).then(() => setFixed(''))}
                data-testid="spk-answer-send"
              >
                {L('odpowiedź', 'answer')}
              </button>
            )}
          </div>
          <div className="flex gap-1">
            <input
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              maxLength={130}
              placeholder={L('etykiety po przecinku (np. szyk, osoba, wiek)', 'labels, comma-separated')}
              className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm"
            />
            <button
              disabled={busy || !labels.trim()}
              className={`${btn} border-white/15`}
              onClick={() =>
                void send({
                  labels: labels
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean)
                    .slice(0, 5),
                }).then(() => setLabels(''))
              }
            >
              {L('etykiety', 'labels')}
            </button>
          </div>
          {mine && !mine.train_ok && (
            <p className="text-amber">
              {L('Masz wyłączoną naukę – Twoje oceny są zapisane, ale nie uczą modelu.', 'Learning is off for you – your ratings are saved but do not train the model.')}
            </p>
          )}
        </div>
      )}
      {err && <p className="text-rose">{err}</p>}
    </div>
  )
}

export function SpeakerPanel({ st, dev, en, onChange }: { st: SpkState | null; dev: boolean; en: boolean; onChange: (s: SpkState) => void }) {
  const L = (pl: string, e: string) => (en ? e : pl)
  const [err, setErr] = useState('')
  const [iv, setIv] = useState('')
  if (!st) return null
  const act = (a: Parameters<typeof speakerAdmin>[0], v?: number) => {
    if ((a === 'purge' || a === 'remove') && !confirm(L('Usunąć wszystkie wpisy Grzybni AI z czatu?', 'Delete all Mycelium AI posts from the chat?'))) return
    speakerAdmin(a, v).then(onChange, (e: Error) => setErr(e.message))
  }
  return (
    <details className="rounded-2xl border border-sky-400/20 bg-sky-400/[0.04] p-3 text-sm" data-testid="spk-state" data-level={st.level} open>
      <summary className="cursor-pointer">
        <b className="text-sky-300">Grzybnia AI</b> {L('mówi sama', 'speaks on its own')} · {L('poziom', 'level')}{' '}
        <b data-testid="spk-level">{LEVEL_NAME[st.level]?.[en ? 1 : 0]}</b> ·{' '}
        {st.enabled ? (
          L(`co ${Math.round(st.interval_s / 60)} min`, `every ${Math.round(st.interval_s / 60)} min`)
        ) : (
          <span className="text-amber">{L('wstrzymana', 'paused')}</span>
        )}
      </summary>
      <p className="mt-1 text-xs text-slate-400">
        {L(
          'Wpisy układa generator programu nauczania w bazie (bez węzłów): na początku losowe słowa, potem coraz częściej formy, które ocenicie jako sensowne, i Wasze poprawki. Poziom rośnie, gdy ≥ 20 ocenionych wpisów poziomu ma ≥ 70% „sensowne”. Do nauki trafia tylko konsensus (≥ 2 osoby z tą samą poprawką) od osób z włączoną nauką.',
          'Posts are composed by a curriculum generator in the database (no nodes): random words at first, then more and more of the forms you rate as sensible and your corrections. The level goes up when ≥ 20 rated posts of the level are ≥ 70% “makes sense”. Only consensus (≥ 2 people with the same fix) from people with learning on is used for training.',
        )}
      </p>
      <table className="mt-2 w-full text-xs tabular-nums" data-testid="spk-levels">
        <thead className="text-slate-500">
          <tr>
            <th className="text-left">{L('poziom', 'level')}</th>
            <th className="text-right">{L('wpisy', 'posts')}</th>
            <th className="text-right">{L('ocenione', 'rated')}</th>
            <th className="text-right">{L('trafność', 'accuracy')}</th>
          </tr>
        </thead>
        <tbody>
          {st.levels.map((l) => (
            <tr key={l.level} className={l.level === st.level ? 'text-sky-300' : 'text-slate-400'}>
              <td>{LEVEL_NAME[l.level]?.[en ? 1 : 0]}</td>
              <td className="text-right">{l.posts}</td>
              <td className="text-right">{l.rated}</td>
              <td className="text-right">{l.rated ? `${Math.round((l.acc ?? 0) * 100)}% (${l.sensible}/${l.rated})` : L('brak ocen', 'no ratings')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[11px] text-slate-500">
        {L('Ocen', 'Ratings')}: {st.votes} · {L('w danych do nauki (konsensus)', 'in training data (consensus)')}: {st.sft} · {L('form od ludzi', 'forms from people')}:{' '}
        {st.forms_people}
      </p>
      {dev && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs" data-testid="spk-admin">
          <span className="chip border-violet/50 text-violet">Developer</span>
          <button className={`${btn} border-white/15`} onClick={() => act(st.enabled ? 'pause' : 'resume')}>
            {st.enabled ? L('wstrzymaj', 'pause') : L('wznów', 'resume')}
          </button>
          <input
            value={iv}
            onChange={(e) => setIv(e.target.value)}
            inputMode="numeric"
            placeholder={L('co ile min', 'every N min')}
            className="w-24 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5"
          />
          <button className={`${btn} border-white/15`} onClick={() => Number(iv) >= 1 && Number(iv) <= 60 && act('interval', Math.round(Number(iv) * 60))}>
            {L('ustaw odstęp', 'set interval')}
          </button>
          <select className="rounded-lg border border-white/10 bg-black/30 px-2 py-1.5" value={st.level} onChange={(e) => act('level', Number(e.target.value))}>
            {LEVEL_NAME.map((n, i) => (
              <option key={i} value={i}>
                {n[en ? 1 : 0]}
              </option>
            ))}
          </select>
          <button className={`${btn} border-rose/30 text-rose`} onClick={() => act('purge')}>
            {L('usuń wpisy AI', 'delete AI posts')}
          </button>
          <button className={`${btn} border-rose/50 text-rose`} onClick={() => act('remove')}>
            {L('wyłącz i usuń mówcę', 'turn off and delete speaker')}
          </button>
          {err && <span className="text-rose">{err}</span>}
        </div>
      )}
    </details>
  )
}
