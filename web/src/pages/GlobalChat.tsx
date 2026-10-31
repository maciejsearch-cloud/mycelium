import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Card, PageHeader } from '../components/ui'
import { Icon } from '../components/Icon'
import { LogoMark } from '../components/Logo'
import { useI18n } from '../i18n'
import { account } from '../myc/account'
import { circles, type CircleLite } from '../myc/circles'
import { gchat, type GMsg } from '../myc/gchat'
import { classifyIntent, INTENT_PL, loadApprovedPatterns, type Intent, type LangPattern } from '../myc/intent'
import { loadRegister, type Register } from '../myc/register'
import { ownerKey } from '../myc/store'
import { SpeakerPanel, SpeakerTools } from '../components/Speaker'
import { speakerState, speakerSummary, type SpkState, type SpkSummary } from '../myc/speaker'

const time = (s: string) => new Date(s).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
const day = (s: string) => new Date(s).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' })

function Badge({ m, en }: { m: Pick<GMsg, 'kind' | 'role'>; en: boolean }) {
  if (m.kind === 'ai')
    return (
      <span className="chip border-sky-400/50 bg-sky-400/10 px-1.5 py-0 text-[10px] font-semibold text-sky-300" data-testid="badge-ai">
        {en ? 'AI · mycelium' : 'AI · grzybnia'}
      </span>
    )
  if (m.kind === 'node') return <span className="chip border-amber/40 px-1.5 py-0 text-[10px] text-amber">{en ? 'node bot' : 'bot węzła'}</span>
  if (m.role === 'developer')
    return (
      <span className="chip border-violet/50 bg-violet/10 px-1.5 py-0 text-[10px] font-semibold text-violet" data-testid="badge-dev">
        Developer
      </span>
    )
  if (m.role === 'moderator') return <span className="chip border-sky/50 px-1.5 py-0 text-[10px] text-sky">{en ? 'Moderator' : 'Moderator'}</span>
  return null
}

export default function GlobalChat() {
  const en = useI18n().lang === 'en'
  const L = (pl: string, e: string) => (en ? e : pl)
  useSyncExternalStore(gchat.subscribe, gchat.getVersion)
  useSyncExternalStore(account.subscribe, account.getVersion)
  const [text, setText] = useState('')
  const [reply, setReply] = useState<GMsg | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [reg, setReg] = useState<Register>()
  const [pats, setPats] = useState<LangPattern[]>([])
  const [mine, setMine] = useState<CircleLite[]>([])
  const [menu, setMenu] = useState<number | null>(null)
  const [log, setLog] = useState<Awaited<ReturnType<typeof gchat.modlog>> | null>(null)
  const [keyIn, setKeyIn] = useState('')
  const [modHandle, setModHandle] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const [spk, setSpk] = useState<SpkState | null>(null)
  const [sums, setSums] = useState<Map<number, SpkSummary>>(new Map())
  const me = gchat.me
  const canMod = me?.role === 'developer' || me?.role === 'moderator'

  useEffect(() => {
    void account.refresh().then(() => gchat.open(null))
    void loadRegister().then(setReg, () => undefined)
    void loadApprovedPatterns().then(setPats)
    return () => gchat.close()
  }, [])
  useEffect(() => {
    if (account.me) void circles.mine().then(setMine, () => setMine([]))
  }, [account.me?.id])
  // mówca AI: stan poziomów + podsumowania ocen widocznych wpisów AI (odświeżane przy nowych wiadomościach i co 30 s)
  const aiIds = gchat.channel == null ? gchat.msgs.filter((m) => m.kind === 'ai' && !m.deleted).map((m) => m.id) : []
  const aiKey = aiIds.join(',')
  const refreshSpk = () => {
    void speakerState().then(setSpk, () => undefined)
    void speakerSummary(aiIds).then(
      (xs) => setSums(new Map(xs.map((x) => [x.msg_id, x]))),
      () => undefined,
    )
  }
  useEffect(() => {
    refreshSpk()
    const t = setInterval(refreshSpk, 30_000)
    return () => clearInterval(t)
  }, [aiKey, account.me?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [gchat.msgs.length, gchat.channel])

  const guess = useMemo(() => (text.trim() ? classifyIntent(text, reg, pats) : undefined), [text, reg, pats])
  const pinned = gchat.msgs.filter((m) => m.pinned && !m.deleted)
  const byId = new Map(gchat.msgs.map((m) => [m.id, m]))
  const frozen = gchat.channel != null && mine.find((c) => c.id === gchat.channel)?.frozen

  const send = async () => {
    const b = text.trim()
    if (!b || busy) return
    setBusy(true)
    setErr('')
    try {
      const g = classifyIntent(b, reg, pats)
      await gchat.post(b, g.intent, g.tags, reply?.id ?? null)
      setText('')
      setReply(null)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const mod = async (action: string, m: GMsg | null, extra: Parameters<typeof gchat.mod>[2] = {}) => {
    setErr('')
    setMenu(null)
    try {
      await gchat.mod(action, m?.id ?? null, extra)
      if (log) setLog(await gchat.modlog())
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <div className="space-y-4" data-testid="global-chat">
      <PageHeader title={L('Czat globalny', 'Global chat')}>
        {L(
          'Wspólny czat ludzi i węzłów grzybni, na żywo. Ludzie piszą pod anonimowym pseudonimem, boty węzłów są oznaczone. Bez cenzury słów – wulgaryzmy dostają tylko etykietę rejestru; moderują ludzie (Developer i Moderatorzy), a przed spamem chronią limity. Z wiadomości model uczy się, jak ludzie piszą (slang, skróty, ironia, emocje, pytania) – dopiero po głosowaniu w Weryfikuj.',
          'A shared live chat for people and mycelium nodes. People post under an anonymous pseudonym, node bots are labelled. No word censorship – vulgar words only get a register tag; people moderate (Developer and Moderators) and rate limits stop spam. The model learns how people write (slang, abbreviations, irony, emotions, questions) from messages – only after a vote in Verify.',
        )}
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400" data-testid="gchat-stats">
        <span className={`chip ${gchat.status === 'live' ? 'border-spore/40 text-spore' : 'border-amber/30 text-amber'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${gchat.status === 'live' ? 'breathe bg-spore' : 'bg-amber'}`} />
          {gchat.status === 'live' ? L('na żywo', 'live') : gchat.status === 'loading' ? L('łączę…', 'connecting…') : L('bez połączenia na żywo', 'not live')}
        </span>
        {gchat.stats && (
          <>
            <span className="chip border-white/10">
              {L('wiadomości', 'messages')}: {gchat.stats.messages}
            </span>
            <span className="chip border-white/10">
              {L('dziś', 'today')}: {gchat.stats.today}
            </span>
            <span className="chip border-white/10">
              {L('osoby', 'people')}: {gchat.stats.people}
            </span>
            <span className="chip border-white/10">
              {L('węzły', 'nodes')}: {gchat.stats.nodes}
            </span>
          </>
        )}
        {gchat.roles.length > 0 && (
          <span className="chip border-violet/30 text-violet">
            {L('moderują', 'moderated by')}: {gchat.roles.map((r) => `${r.handle} (${r.role === 'developer' ? 'Developer' : 'Moderator'})`).join(', ')}
          </span>
        )}
      </div>

      {account.me && (
        <div className="no-scrollbar flex gap-1 overflow-x-auto" role="tablist" aria-label={L('Kanały', 'Channels')}>
          {[{ id: null as number | null, name: L('# globalny', '# global') }, ...mine.map((c) => ({ id: c.id as number | null, name: `◎ ${c.name}${c.frozen ? ' ❄' : ''}` }))].map(
            (c) => (
              <button
                key={String(c.id)}
                role="tab"
                aria-selected={gchat.channel === c.id}
                onClick={() => void gchat.open(c.id)}
                className={`shrink-0 rounded-xl px-3 py-2 text-sm ${gchat.channel === c.id ? 'bg-spore/15 text-glow ring-1 ring-spore/25' : 'bg-white/[0.03] text-slate-400'}`}
              >
                {c.name}
              </button>
            ),
          )}
        </div>
      )}
      {gchat.channel == null && <SpeakerPanel st={spk} dev={me?.role === 'developer'} en={en} onChange={setSpk} />}
      {gchat.channel != null && (
        <p className="text-xs text-slate-500">
          {L(
            'Kanał kręgu: widzą go tylko członkowie kręgu (sprawdza baza, także na żywo). Te wiadomości nie trafiają do nauki modelu.',
            'Circle channel: only circle members can see it (enforced by the database, live too). These messages are not used for training.',
          )}
        </p>
      )}

      {pinned.length > 0 && (
        <div className="rounded-2xl border border-violet/25 bg-violet/[0.06] p-3 text-sm" data-testid="gchat-pinned">
          <div className="eyebrow mb-1 text-violet">📌 {L('przypięte', 'pinned')}</div>
          {pinned.map((m) => (
            <div key={m.id} className="truncate text-slate-200">
              <b>{m.handle}</b>: {m.body}
            </div>
          ))}
        </div>
      )}

      <section className="card flex min-h-[50dvh] flex-col overflow-hidden !p-0">
        <div className="max-h-[62dvh] flex-1 space-y-1 overflow-y-auto p-3" data-testid="gchat-list" aria-live="polite">
          {gchat.msgs.length === 0 && gchat.status !== 'loading' && (
            <p className="py-10 text-center text-sm text-slate-500" data-testid="gchat-empty">
              {gchat.error
                ? `${L('Nie udało się wczytać', 'Could not load')}: ${gchat.error}`
                : L('Jeszcze nikt tu nie napisał. Bądź pierwsza/pierwszy.', 'Nobody has written here yet. Be the first.')}
            </p>
          )}
          {gchat.msgs.map((m, i) => {
            const prev = gchat.msgs[i - 1]
            const showDay = !prev || day(prev.created_at) !== day(m.created_at)
            const rt = m.reply_to ? byId.get(m.reply_to) : undefined
            const own = me && m.kind === 'user' && m.handle === me.handle
            return (
              <div key={m.id}>
                {showDay && (
                  <div className="my-3 flex items-center gap-3 text-[11px] font-medium text-slate-500">
                    <span className="h-px flex-1 bg-white/[0.06]" />
                    {day(m.created_at)}
                    <span className="h-px flex-1 bg-white/[0.06]" />
                  </div>
                )}
                <div className={`group relative flex gap-2.5 rounded-2xl px-2 py-2 sm:px-2.5 ${own ? 'bg-spore/[0.06] ring-1 ring-spore/10' : 'hover:bg-white/[0.03]'}`} data-testid="gchat-msg">
                  <Avatar m={m} />
                  <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <b className={m.kind === 'ai' ? 'text-sky-300' : m.kind === 'node' ? 'text-amber' : m.role === 'developer' ? 'text-violet' : 'text-slate-200'}>{m.handle}</b>
                    <Badge m={m} en={en} />
                    <span className="text-slate-500">{time(m.created_at)}</span>
                    {m.intent && m.intent !== 'stwierdzenie' && <span className="text-[10px] text-slate-500">· {INTENT_PL[m.intent as Intent]?.[en ? 1 : 0] ?? m.intent}</span>}
                    {m.tags
                      .filter((t) => ['wulgarne', 'obraźliwe', 'potoczne', 'slang', 'ironiczne'].includes(t))
                      .map((t) => (
                        <span key={t} className="chip border-amber/25 px-1 py-0 text-[10px] text-amber/80">
                          {t}
                        </span>
                      ))}
                    {m.pinned && <span className="text-[10px] text-violet">📌</span>}
                    {me && !m.deleted && (
                      <button
                        className="ml-auto px-1.5 text-slate-500 hover:text-slate-200"
                        aria-label={L('akcje', 'actions')}
                        onClick={() => setMenu(menu === m.id ? null : m.id)}
                      >
                        ⋯
                      </button>
                    )}
                  </div>
                  {rt && (
                    <div className="mt-0.5 truncate border-l-2 border-white/10 pl-2 text-xs text-slate-500">
                      ↪ {rt.handle}: {rt.body ?? L('(usunięta)', '(deleted)')}
                    </div>
                  )}
                  <div className={`whitespace-pre-wrap break-words text-[15px] leading-snug ${m.deleted ? 'italic text-slate-600' : 'text-slate-100'}`}>
                    {m.deleted ? L('wiadomość usunięta', 'message deleted') : m.body}
                  </div>
                  {m.kind === 'ai' && !m.deleted && sums.get(m.id) && <SpeakerTools s={sums.get(m.id)!} canRate={!!me} en={en} onDone={refreshSpk} />}
                  {menu === m.id && (
                    <div className="mt-1 flex flex-wrap gap-1 text-xs" data-testid="gchat-menu">
                      <button className="rounded-lg border border-white/10 px-2 py-1.5" onClick={() => (setReply(m), setMenu(null))}>
                        ↪ {L('odpowiedz', 'reply')}
                      </button>
                      {(own || canMod) && (
                        <button className="rounded-lg border border-rose/30 px-2 py-1.5 text-rose" onClick={() => void mod('delete', m)}>
                          {L('usuń', 'delete')}
                        </button>
                      )}
                      {canMod && (
                        <>
                          <button className="rounded-lg border border-violet/30 px-2 py-1.5 text-violet" onClick={() => void mod(m.pinned ? 'unpin' : 'pin', m)}>
                            {m.pinned ? L('odepnij', 'unpin') : L('przypnij', 'pin')}
                          </button>
                          {!own && (
                            <button className="rounded-lg border border-amber/30 px-2 py-1.5 text-amber" onClick={() => void mod('mute', m, { minutes: 60 })}>
                              {L('wycisz 1 h', 'mute 1 h')}
                            </button>
                          )}
                        </>
                      )}
                      {me?.role === 'developer' && !own && (
                        <>
                          <button
                            className="rounded-lg border border-rose/40 px-2 py-1.5 text-rose"
                            onClick={() => confirm(L(`Zablokować ${m.handle} w czacie?`, `Ban ${m.handle} from chat?`)) && void mod('ban', m)}
                          >
                            {L('zablokuj', 'ban')}
                          </button>
                          {m.kind === 'user' && m.role !== 'moderator' && (
                            <button
                              className="rounded-lg border border-sky/30 px-2 py-1.5 text-sky"
                              onClick={() => void mod('grant_role', m, { role: 'moderator', handle: m.handle })}
                            >
                              {L('nadaj Moderatora', 'make Moderator')}
                            </button>
                          )}
                          {m.role === 'moderator' && (
                            <button className="rounded-lg border border-white/15 px-2 py-1.5" onClick={() => void mod('revoke_role', null, { handle: m.handle })}>
                              {L('odbierz Moderatora', 'revoke Moderator')}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  </div>
                </div>
              </div>
            )
          })}
          <div ref={end} />
        </div>

        <div className="border-t border-white/5 p-3">
          {!account.me ? (
            <p className="text-sm text-slate-400" data-testid="gchat-login">
              {L(
                'Czytać może każdy. Żeby pisać, załóż anonimowe konto (sam pseudonim, bez e-maila) w zakładce ',
                'Anyone can read. To write, create an anonymous account (just a pseudonym, no e-mail) in ',
              )}
              <a className="text-spore underline" href="#/konto">
                {L('Konto', 'Account')}
              </a>
              .
              {ownerKey.get() && (
                <span className="mt-1 block text-violet" data-testid="gchat-owner-hint">
                  {L(
                    'To urządzenie ma klucz właściciela z Weryfikuj – po założeniu konta dostaniesz tu rolę Developer automatycznie.',
                    'This device has the owner key from Verify – once you create an account you get the Developer role here automatically.',
                  )}
                </span>
              )}
            </p>
          ) : me?.banned ? (
            <p className="text-sm text-rose">{L('To konto jest zablokowane w czacie.', 'This account is banned from chat.')}</p>
          ) : me?.muted_until ? (
            <p className="text-sm text-amber">
              {L('Wyciszenie do', 'Muted until')} {new Date(me.muted_until).toLocaleString('pl-PL')}
            </p>
          ) : frozen ? (
            <p className="text-sm text-sky">❄ {L('Krąg zamrożony przez Developera – tylko do odczytu.', 'Circle frozen by the Developer – read-only.')}</p>
          ) : (
            <>
              {reply && (
                <div className="mb-1 flex items-center gap-2 text-xs text-slate-400">
                  ↪ {reply.handle}: <span className="truncate">{reply.body}</span>
                  <button className="ml-auto text-slate-500" onClick={() => setReply(null)}>
                    ✕
                  </button>
                </div>
              )}
              <div className="flex items-end gap-2">
                <textarea
                  value={text}
                  maxLength={1000}
                  rows={2}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                  placeholder={L(`Napisz jako ${me?.handle ?? '…'}`, `Write as ${me?.handle ?? '…'}`)}
                  className="min-h-[3rem] flex-1 resize-none rounded-2xl border border-white/10 bg-black/30 px-3.5 py-2.5 text-base text-slate-100 placeholder:text-slate-500 focus:border-spore/50 focus:outline-none"
                  data-testid="gchat-input"
                />
                <button
                  onClick={() => void send()}
                  disabled={busy || !text.trim()}
                  className="btn-primary px-4 py-3 font-semibold disabled:opacity-50"
                  data-testid="gchat-send"
                >
                  {L('Wyślij', 'Send')}
                </button>
              </div>
              {guess && (
                <div className="mt-1 text-[11px] text-slate-500" data-testid="gchat-intent">
                  {L('rozumiem to jako', 'I read this as')}: <b className="text-slate-300">{INTENT_PL[guess.intent][en ? 1 : 0]}</b>
                  {guess.tags.length > 0 && ` · ${guess.tags.join(', ')}`} <span className="opacity-70">({guess.why})</span>
                </div>
              )}
            </>
          )}
          {err && <p className="mt-1 text-xs text-rose">{err}</p>}
        </div>
      </section>

      {me && (
        <Card title={L('Prywatność i nauka', 'Privacy and learning')}>
          <label className="flex items-start gap-3 text-sm" data-testid="gchat-train">
            <input
              type="checkbox"
              className="mt-1 h-5 w-5 accent-[#5eead4]"
              checked={me.train_ok}
              onChange={(e) => void gchat.setTrain(e.target.checked).catch((x: Error) => setErr(x.message))}
            />
            <span>
              <b>
                {me.train_ok
                  ? L('Moje wiadomości uczą model (włączone)', 'My messages teach the model (on)')
                  : L('Moje wiadomości NIE uczą modelu', 'My messages do NOT teach the model')}
              </b>
              <br />
              <span className="text-xs text-slate-400">
                {L(
                  'Z czatu globalnego model uczy się zbiorczych wzorców języka (skróty, emotikony, ironia, intencje), a nie profilu osoby. Przed użyciem usuwamy pseudonimy, @wzmianki, linki, e-maile i numery telefonów. Słowo trafia do kandydatów dopiero, gdy użyją go co najmniej 2 różne osoby. Wszystko i tak przechodzi głosowanie w Weryfikuj. Wyłączenie usuwa też Twoje oczekujące próbki. Kanały kręgów nigdy nie uczą modelu. Adresu IP nie zapisujemy w czacie.',
                  'From the global chat the model learns aggregate language patterns (abbreviations, emoticons, irony, intents), not a profile of a person. Before use we strip pseudonyms, @mentions, links, e-mails and phone numbers. A word becomes a candidate only once at least 2 different people use it. Everything still goes through a vote in Verify. Turning this off also removes your pending samples. Circle channels never train the model. We do not store IP addresses in chat.',
                )}
              </span>
            </span>
          </label>
        </Card>
      )}

      {me?.role === 'developer' && (
        <Card title={L('Panel Developera', 'Developer panel')} right={<span className="chip border-violet/50 text-violet">Developer</span>}>
          <div className="space-y-3 text-sm">
            <p className="text-xs text-slate-400">
              {L('Rola przypięta do Twojego konta kluczem właściciela (to urządzenie: ', 'Role bound to your account by the owner key (this device: ')}
              {me.owner_device ? L('potwierdzone', 'confirmed') : L('inne urządzenie konta', 'another device of the account')}).{' '}
              {L(
                'Możesz przypinać, usuwać, wyciszać, blokować, nadawać Moderatora i zatwierdzać wzorce w Weryfikuj (Twój głos = złota etykieta).',
                'You can pin, delete, mute, ban, grant Moderator and approve patterns in Verify (your vote = gold label).',
              )}
            </p>
            <div className="flex gap-2">
              <input
                value={modHandle}
                onChange={(e) => setModHandle(e.target.value)}
                placeholder={L('pseudonim', 'pseudonym')}
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2"
              />
              <button className="rounded-xl border border-sky/30 px-3 text-sky" onClick={() => void mod('grant_role', null, { role: 'moderator', handle: modHandle })}>
                + {L('Moderator', 'Moderator')}
              </button>
              <button className="rounded-xl border border-white/15 px-3" onClick={() => void mod('unban', null, { handle: modHandle })}>
                {L('odblokuj', 'unban')}
              </button>
            </div>
            <button className="text-xs text-slate-400 underline" onClick={() => void gchat.modlog().then(setLog, (e: Error) => setErr(e.message))} data-testid="gchat-modlog-btn">
              {L('Pokaż dziennik moderacji', 'Show moderation log')}
            </button>
            {log && (
              <ul className="max-h-64 space-y-1 overflow-y-auto text-xs text-slate-400" data-testid="gchat-modlog">
                {!log.length && <li>{L('Pusto.', 'Empty.')}</li>}
                {log.map((l, i) => (
                  <li key={i}>
                    {new Date(l.at).toLocaleString('pl-PL')} · <b className="text-slate-200">{l.actor ?? '—'}</b> ({l.actor_role}) · {l.action}
                    {l.target ? ` → ${l.target}` : ''}
                    {l.msg_id ? ` #${l.msg_id}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}

      {account.me && me && me.role !== 'developer' && (
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer">{L('Jestem właścicielką – mam klucz właściciela', 'I am the owner – I have the owner key')}</summary>
          <div className="mt-2 flex gap-2">
            <input
              type="password"
              autoComplete="off"
              value={keyIn}
              onChange={(e) => setKeyIn(e.target.value)}
              className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2"
              placeholder={L('klucz właściciela', 'owner key')}
            />
            <button
              className="rounded-xl border border-violet/40 px-3 text-violet"
              onClick={() =>
                void gchat.claimOwner(keyIn).then(
                  () => setKeyIn(''),
                  (e: Error) => setErr(e.message),
                )
              }
            >
              {L('Potwierdź', 'Confirm')}
            </button>
          </div>
          <p className="mt-1">
            {L(
              'Urządzenie z kluczem zapisanym w Weryfikuj dostaje rolę Developer automatycznie. Klucz nie jest zapisywany w bazie (tylko porównanie skrótu).',
              'A device with the key saved in Verify gets the Developer role automatically. The key is never stored in the database (hash comparison only).',
            )}
          </p>
        </details>
      )}
    </div>
  )
}

/** Awatar autora: Grzybnia AI – znak grzybni, węzeł – heksagon, człowiek – inicjał w kolorze z pseudonimu. */
function Avatar({ m }: { m: { kind: string; handle: string; role?: string | null } }) {
  if (m.kind === 'ai') return <LogoMark size={30} className="mt-0.5 shrink-0" />
  if (m.kind === 'node')
    return (
      <span aria-hidden className="mt-0.5 grid h-[30px] w-[30px] shrink-0 place-items-center rounded-xl bg-amber/10 text-amber ring-1 ring-amber/25">
        <Icon name="node" size={16} />
      </span>
    )
  let h = 0
  for (const c of m.handle) h = (h * 31 + c.charCodeAt(0)) % 360
  return (
    <span
      aria-hidden
      className="mt-0.5 grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full text-[13px] font-semibold ring-1 ring-white/10"
      style={{ color: '#fff', background: m.role === 'developer' ? 'linear-gradient(135deg,#8b5cf6,#5eead4)' : `hsl(${h} 45% 34%)` }}
    >
      {m.handle.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toUpperCase() || '?'}
    </span>
  )
}
