import { useEffect, useState, useSyncExternalStore } from 'react'
import { useI18n } from '../i18n'
import { circles, SPEC_PL, type Circle, type CircleLite, type Spec, type Trust } from '../myc/circles'
import { gchat } from '../myc/gchat'
import { Bar, Card } from './ui'

const input = 'w-full rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-base text-slate-100 placeholder:text-slate-500 focus:border-spore/50 focus:outline-none'
const btn = 'rounded-xl bg-spore px-4 py-3 text-base font-semibold text-ink disabled:opacity-50'
const btn2 = 'rounded-xl border border-white/15 px-3 py-2.5 text-sm text-slate-200 disabled:opacity-50'
const pct = (x: number) => `${Math.round(x * 100)}%`

/** Konto → Kręgi: krąg znajomych (zaproszenie kodem), zaufanie z prawdziwego wkładu, poręczenia, kanał kręgu w czacie. */
export function Circles() {
  const en = useI18n().lang === 'en'
  const L = (pl: string, e: string) => (en ? e : pl)
  useSyncExternalStore(gchat.subscribe, gchat.getVersion)
  const [mine, setMine] = useState<CircleLite[] | undefined>()
  const [open, setOpen] = useState<Circle | null>(null)
  const [trust, setTrust] = useState<Trust | null>(null)
  const [name, setName] = useState('')
  const [about, setAbout] = useState('')
  const [code, setCode] = useState('')
  const [invite, setInvite] = useState<{ id: number; code: string } | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [vh, setVh] = useState('')
  const [stake, setStake] = useState(0.1)
  const dev = gchat.me?.role === 'developer'

  const reload = async (id?: number) => {
    setMine(await circles.mine().catch(() => []))
    setTrust(await circles.trustMe().catch(() => null))
    if (id) setOpen(await circles.get(id).catch(() => null))
  }
  useEffect(() => {
    void reload()
    void gchat.refreshMe()
  }, [])
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true)
    setErr('')
    try {
      await f()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const admin = (action: string, handle?: string | null, value?: string | null) =>
    run(async () => {
      if (!open) return
      const r = await circles.admin(open.id, action, handle, value)
      if (r.invite) setInvite({ id: open.id, code: r.invite })
      await reload(open.id)
    })
  const canAdmin = open && (open.my_role === 'owner' || open.my_role === 'admin' || dev)

  return (
    <Card title={L('Kręgi', 'Circles')} right={trust && <span className="chip border-spore/30 text-spore" data-testid="my-trust">{L('moje zaufanie', 'my trust')}: {pct(trust.trust)}</span>}>
      <div className="space-y-4 text-sm" data-testid="circles">
        <p className="text-xs text-slate-400">
          {L(
            'Krąg to mała grupa znajomych z własnym kanałem w czacie. Zaufanie liczy serwer wyłącznie ze zweryfikowanego wkładu – zatwierdzone punkty, zgodność ze złotymi etykietami, dni aktywności węzłów, poświadczenia świadka – nigdy z deklaracji. Nowe konto zaczyna nisko, zaufanie maleje bez aktywności i spada za odrzucony wkład i kłamliwe głosy. Polecenia nie podnoszą zaufania.',
            'A circle is a small group of friends with its own chat channel. Trust is computed by the server only from verified contribution – approved points, agreement with gold labels, node activity days, witness attestations – never self-reported. New accounts start low, trust decays with inactivity and drops for rejected work and lying votes. Referrals do not raise trust.',
          )}
        </p>

        {trust && (
          <details className="rounded-xl border border-white/10 p-3" data-testid="trust-detail">
            <summary className="cursor-pointer text-slate-300">{L('Skąd moje zaufanie?', 'Where does my trust come from?')}</summary>
            <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-400 tabular-nums">
              <li>{L('zatwierdzone punkty', 'approved points')}: {trust.approved}</li>
              <li>{L('odrzucone', 'rejected')}: {trust.rejected}</li>
              <li>{L('złote etykiety', 'gold labels')}: {trust.gold_ok}/{trust.gold_n}</li>
              <li>{L('dni aktywności (30)', 'active days (30)')}: {trust.active_days_30}</li>
              <li>{L('poświadczenia świadka', 'witness attestations')}: {trust.witness_30}</li>
              <li>{L('głosy błędne/trafne', 'wrong/right votes')}: {trust.wrong_votes}/{trust.right_votes}</li>
              <li>{L('wygaszanie', 'decay')}: ×{trust.decay}</li>
              <li>{L('kara', 'penalty')}: {pct(trust.penalty)}</li>
              <li>{L('w poręczeniach', 'staked in vouches')}: −{trust.stake_out}</li>
              <li>{L('premia z poręczenia', 'vouch bonus')}: +{trust.vouch_bonus}</li>
            </ul>
            {trust.new_account && <p className="mt-1 text-xs text-amber">{L('Konto młodsze niż 7 dni: maks. 30%.', 'Account younger than 7 days: max 30%.')}</p>}
          </details>
        )}

        {mine && mine.length === 0 && <p className="text-slate-500">{L('Nie należysz jeszcze do żadnego kręgu.', 'You are not in any circle yet.')}</p>}
        <ul className="space-y-2">
          {(mine ?? []).map((c) => (
            <li key={c.id}>
              <button className={`w-full rounded-xl border p-3 text-left ${open?.id === c.id ? 'border-spore/40 bg-spore/[0.06]' : 'border-white/10'}`} onClick={() => void run(async () => setOpen(await circles.get(c.id)))} data-testid="circle-row">
                <div className="flex items-center gap-2">
                  <b className="text-slate-100">◎ {c.name}</b>
                  <span className="text-xs text-slate-500">{c.role === 'owner' ? L('właściciel', 'owner') : c.role === 'admin' ? 'admin' : L('członek', 'member')}</span>
                  {c.frozen && <span className="chip border-sky/40 text-sky">❄ {L('zamrożony', 'frozen')}</span>}
                  <span className="ml-auto text-xs tabular-nums text-slate-400">
                    {c.members}/{c.max_size}
                  </span>
                </div>
                {c.about && <div className="mt-0.5 text-xs text-slate-500">{c.about}</div>}
              </button>
            </li>
          ))}
        </ul>

        {invite && (
          <div className="rounded-xl border border-spore/40 bg-spore/10 p-3" data-testid="circle-invite">
            <div className="text-xs text-slate-300">{L('Kod zaproszenia (pokazany raz – w bazie tylko skrót; możesz go wymienić):', 'Invite code (shown once – only its hash is stored; you can rotate it):')}</div>
            <div className="mt-1 select-all font-mono text-xl text-spore">{invite.code}</div>
            <button className={`${btn2} mt-2`} onClick={() => void navigator.clipboard.writeText(invite.code).catch(() => undefined)}>
              {L('Kopiuj', 'Copy')}
            </button>
          </div>
        )}

        {open && (
          <div className="space-y-3 rounded-2xl border border-white/10 p-3" data-testid="circle-detail">
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-base text-slate-100">◎ {open.name}</b>
              {open.spec && <span className="chip border-violet/30 text-violet">{SPEC_PL[open.spec][en ? 1 : 0]}</span>}
              {open.frozen && <span className="chip border-sky/40 text-sky">❄ {open.frozen_reason ?? L('zamrożony', 'frozen')}</span>}
              <a className="ml-auto text-xs text-spore underline" href="#/czat" onClick={() => setTimeout(() => void gchat.open(open.id), 300)}>
                {L('kanał kręgu w czacie →', 'circle channel in chat →')}
              </a>
            </div>
            <ul className="space-y-2">
              {open.members.map((m) => (
                <li key={m.handle} className="rounded-xl bg-white/[0.03] p-2" data-testid="circle-member">
                  <div className="flex items-center gap-2">
                    <span className={m.me ? 'text-spore' : 'text-slate-200'}>{m.handle}</span>
                    <span className="text-[11px] text-slate-500">{m.role === 'owner' ? L('właściciel', 'owner') : m.role === 'admin' ? 'admin' : L('członek', 'member')}</span>
                    {m.new && <span className="text-[11px] text-amber">{L('nowe konto', 'new account')}</span>}
                    {m.vouched_by && <span className="text-[11px] text-violet">{L('poręcza', 'vouched by')} {m.vouched_by}</span>}
                    <span className="ml-auto text-xs tabular-nums text-slate-400">{pct(m.trust)}</span>
                  </div>
                  <div className="mt-1">
                    <Bar value={m.trust} />
                  </div>
                  {canAdmin && !m.me && (
                    <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
                      {m.role === 'member' && (
                        <button className="rounded-lg border border-white/10 px-2 py-1" onClick={() => void admin('promote', m.handle)}>
                          + admin
                        </button>
                      )}
                      {m.role === 'admin' && (
                        <button className="rounded-lg border border-white/10 px-2 py-1" onClick={() => void admin('demote', m.handle)}>
                          − admin
                        </button>
                      )}
                      {m.role !== 'owner' && (
                        <button className="rounded-lg border border-rose/30 px-2 py-1 text-rose" onClick={() => confirm(L(`Usunąć ${m.handle} z kręgu?`, `Remove ${m.handle}?`)) && void admin('kick', m.handle)}>
                          {L('usuń', 'remove')}
                        </button>
                      )}
                      {dev && m.vouched_by && (
                        <button className="rounded-lg border border-rose/40 px-2 py-1 text-rose" onClick={() => void admin('slash_vouch', m.handle, prompt(L('Powód (oszustwo)?', 'Reason (cheating)?')) ?? undefined)}>
                          {L('odbierz stawkę poręczyciela', 'slash voucher stake')}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>

            {!open.frozen && (
              <div className="space-y-2 rounded-xl border border-violet/20 p-3" data-testid="vouch-form">
                <div className="text-slate-300">{L('Poręcz za nowicjusza', 'Vouch for a newcomer')}</div>
                <p className="text-xs text-slate-500">
                  {L(
                    'Stawiasz część swojego zaufania (2–20%, maks. ⅓ tego, co masz). Nowicjusz dostaje połowę jako premię. Po 14 dniach, gdy sam zdobędzie zaufanie, stawka wraca. Jeśli oszukiwał (ban, większość wkładu odrzucona, kłamliwe głosy) – tracisz ją na stałe. Wymaga zaufania ≥ 35% i konta starszego niż 14 dni; maks. 3 aktywne poręczenia; wycofać się nie można.',
                    'You stake part of your trust (2–20%, max ⅓ of yours). The newcomer gets half as a bonus. After 14 days, once they earn trust themselves, the stake returns. If they cheated (ban, most work rejected, lying votes) you lose it for good. Requires trust ≥ 35% and an account older than 14 days; max 3 active vouches; no withdrawing.',
                  )}
                </p>
                <div className="flex gap-2">
                  <select className={`${input} py-2`} value={vh} onChange={(e) => setVh(e.target.value)} data-testid="vouch-who">
                    <option value="">{L('kto?', 'who?')}</option>
                    {open.members.filter((m) => !m.me && !m.vouched_by).map((m) => (
                      <option key={m.handle}>{m.handle}</option>
                    ))}
                  </select>
                  <select className={`${input} w-24 py-2`} value={stake} onChange={(e) => setStake(Number(e.target.value))}>
                    {[0.05, 0.1, 0.15, 0.2].map((s) => (
                      <option key={s} value={s}>
                        {pct(s)}
                      </option>
                    ))}
                  </select>
                  <button className={btn2} disabled={busy || !vh} onClick={() => void run(async () => (await circles.vouch(open.id, vh, stake), await reload(open.id)))}>
                    {L('Poręcz', 'Vouch')}
                  </button>
                </div>
              </div>
            )}
            {open.vouches.length > 0 && (
              <ul className="text-xs text-slate-400">
                {open.vouches.map((v, i) => (
                  <li key={i}>
                    {v.voucher} → {v.newcomer}: {pct(v.stake)} · {v.status === 'active' ? L('aktywne', 'active') : v.status === 'released' ? L('zwrócone', 'released') : L('utracone', 'slashed')}
                    {v.reason ? ` (${v.reason})` : ''}
                  </li>
                ))}
              </ul>
            )}

            {canAdmin && (
              <div className="flex flex-wrap gap-2">
                {!open.frozen && (
                  <button className={btn2} onClick={() => void admin('rotate_invite')} data-testid="rotate-invite">
                    {open.invite_at ? L('Nowy kod zaproszenia', 'New invite code') : L('Utwórz kod zaproszenia', 'Create invite code')}
                  </button>
                )}
                <select className={`${btn2} bg-transparent`} value={open.spec ?? ''} onChange={(e) => void admin('set_spec', null, e.target.value || null)} aria-label={L('specjalizacja', 'specialisation')}>
                  <option value="">{L('bez specjalizacji', 'no specialisation')}</option>
                  {(Object.keys(SPEC_PL) as Spec[]).map((s) => (
                    <option key={s} value={s}>
                      {SPEC_PL[s][en ? 1 : 0]}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {dev && (
              <button className={`${btn2} border-sky/40 text-sky`} onClick={() => void admin(open.frozen ? 'unfreeze' : 'freeze', null, open.frozen ? null : prompt(L('Powód zamrożenia?', 'Freeze reason?')))} data-testid="freeze">
                {open.frozen ? L('Odmroź krąg (Developer)', 'Unfreeze circle (Developer)') : L('Zamroź krąg (Developer)', 'Freeze circle (Developer)')}
              </button>
            )}
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer">{L('Dziennik kręgu', 'Circle log')}</summary>
              <ul className="mt-1 space-y-0.5">
                {open.log.map((l, i) => (
                  <li key={i}>
                    {new Date(l.at).toLocaleString('pl-PL')} · {l.actor ?? L('system', 'system')} · {l.action}
                    {l.target && l.target !== l.actor ? ` → ${l.target}` : ''}
                  </li>
                ))}
              </ul>
            </details>
            <button className="text-xs text-rose underline" onClick={() => confirm(L('Opuścić krąg?', 'Leave circle?')) && void run(async () => (await circles.leave(open.id), setOpen(null), await reload()))}>
              {L('Opuść krąg', 'Leave circle')}
            </button>
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault()
              void run(async () => {
                const r = await circles.join(code)
                setCode('')
                await reload(r.id)
              })
            }}
          >
            <div className="text-slate-300">{L('Dołącz kodem', 'Join with a code')}</div>
            <input className={`${input} font-mono uppercase`} value={code} onChange={(e) => setCode(e.target.value)} placeholder="KRG-XXXX-XXXX-XXXX" maxLength={20} spellCheck={false} autoComplete="off" data-testid="circle-code" />
            <button className={btn2} disabled={busy || code.trim().length < 10}>
              {L('Dołącz', 'Join')}
            </button>
          </form>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault()
              void run(async () => {
                const r = await circles.create(name, about, 30)
                setInvite({ id: r.id, code: r.invite })
                setName('')
                setAbout('')
                await reload(r.id)
              })
            }}
          >
            <div className="text-slate-300">{L('Załóż krąg', 'Create a circle')}</div>
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder={L('nazwa (3–40 znaków)', 'name (3–40 chars)')} maxLength={40} data-testid="circle-name" />
            <input className={input} value={about} onChange={(e) => setAbout(e.target.value)} placeholder={L('opis (opcjonalnie)', 'description (optional)')} maxLength={200} />
            <button className={btn} disabled={busy || name.trim().length < 3} data-testid="circle-create">
              {L('Załóż', 'Create')}
            </button>
          </form>
        </div>
        {err && <p className="text-xs text-rose" data-testid="circle-err">{err}</p>}
      </div>
    </Card>
  )
}
