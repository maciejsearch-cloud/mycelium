import QRCode from 'qrcode'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Circles } from '../components/Circles'
import { Card, Kpi, PageHeader } from '../components/ui'
import { useI18n } from '../i18n'
import { account, pendingRef, solanaAddrOk } from '../myc/account'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const short = (id: string) => id.replace(/-/g, '').slice(0, 8)
const n1 = (x: number | undefined) => (x ?? 0).toLocaleString('pl-PL', { maximumFractionDigits: 1 })
const input = 'w-full rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-base text-slate-100 placeholder:text-slate-500 focus:border-spore/50 focus:outline-none'
const btn = 'rounded-xl bg-spore px-4 py-3 text-base font-semibold text-ink disabled:opacity-50'
const btn2 = 'rounded-xl border border-white/15 px-4 py-3 text-sm text-slate-200 disabled:opacity-50'

const ERR: Record<string, [string, string]> = {
  'no-session': ['Sesja wygasła – zaloguj się kodem odzyskiwania.', 'Session expired – sign in with your recovery code.'],
  'node-taken': ['Ten węzeł jest już przypisany do konta.', 'This node is already linked to an account.'],
  'rate limit': ['Za dużo prób – spróbuj za minutę.', 'Too many attempts – try again in a minute.'],
}

export default function AccountPage() {
  const en = useI18n().lang === 'en'
  const L = (pl: string, e: string) => (en ? e : pl)
  useSyncExternalStore(account.subscribe, account.getVersion)
  const me = account.me
  const [busy, setBusy] = useState(false)
  const [handle, setHandle] = useState('')
  const [code, setCode] = useState('')
  const [shown, setShown] = useState('')
  const [friend, setFriend] = useState(pendingRef())
  const [wallet, setWallet] = useState('')
  const [nodeId, setNodeId] = useState('')
  const [qr, setQr] = useState('')
  const [copied, setCopied] = useState('')
  const [editing, setEditing] = useState(false)
  const room = localStorage.getItem('myc.accountRoom') === 'e2e' ? 'e2e' : 'main' // tylko testy e2e

  useEffect(() => void account.refresh(), [])
  const base = location.origin + import.meta.env.BASE_URL
  const invite = me ? `${base}?join=1&ref=${me.ref_code}#/konto` : ''
  useEffect(() => {
    if (invite) void QRCode.toDataURL(invite, { margin: 1, width: 180, color: { dark: '#0b1215', light: '#e2e8f0' } }).then(setQr, () => setQr(''))
  }, [invite])
  useEffect(() => setWallet(me?.wallet_sol ?? ''), [me?.wallet_sol])

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true)
    try {
      return await f()
    } finally {
      setBusy(false)
    }
  }
  const copy = async (what: string, txt: string) => {
    await navigator.clipboard.writeText(txt).catch(() => undefined)
    setCopied(what)
    setTimeout(() => setCopied(''), 1500)
  }
  const err = account.error
  const errText = err ? (Object.entries(ERR).find(([k]) => err.includes(k))?.[1][en ? 1 : 0] ?? err) : ''
  const walletBad = wallet.trim() !== '' && !solanaAddrOk(wallet)

  return (
    <div className="space-y-4" data-testid="account-page">
      <PageHeader title={L('Konto', 'Account')}>
        {L(
          'Anonimowe konto: bez e-maila, imienia i hasła. Widzisz i zmieniasz tylko swoje dane; publicznie widać jedynie pseudonim i zbiorcze liczby. Konto przeniesiesz na inne urządzenie kodem odzyskiwania.',
          'Anonymous account: no email, name or password. Only you can see and change your data; publicly only your handle and aggregate numbers are visible. Move the account to another device with a recovery code.',
        )}
      </PageHeader>

      {errText && (
        <div role="alert" className="card border-rose/30 text-sm text-rose" data-testid="account-error">
          {errText}
        </div>
      )}

      {me === undefined && <div className="card text-sm text-slate-400">{L('Sprawdzam…', 'Checking…')}</div>}

      {me === null && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title={L('Załóż anonimowe konto', 'Create an anonymous account')}>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                void act(() => account.create(handle, room))
              }}
            >
              <label className="block text-sm text-slate-300">
                {L('Pseudonim (3–24 znaki: litery, cyfry, _ . -)', 'Handle (3–24 chars: letters, digits, _ . -)')}
                <input data-testid="handle-input" className={`${input} mt-1`} value={handle} onChange={(e) => setHandle(e.target.value)} maxLength={24} autoComplete="off" placeholder={L('np. grzyb_42', 'e.g. spore_42')} />
              </label>
              {pendingRef() && (
                <p className="text-xs text-slate-400">
                  {L('Polecenie od kodu', 'Referred by code')} <span className="font-mono text-spore">{pendingRef()}</span>
                </p>
              )}
              <button data-testid="create-account" className={`${btn} w-full`} disabled={busy || !/^[\p{L}\p{N}_.-]{3,24}$/u.test(handle.trim())}>
                {L('Utwórz konto', 'Create account')}
              </button>
              <p className="text-xs text-slate-500">
                {L(
                  'Nie podajesz żadnych danych osobowych. Twoje dotychczasowe ID wkładu i węzeł tej przeglądarki zostaną przypisane do konta.',
                  'No personal data is required. Your existing contribution ID and this browser’s node are linked to the account.',
                )}
              </p>
            </form>
          </Card>
          <Card title={L('Mam już konto (kod odzyskiwania)', 'I already have an account (recovery code)')}>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                void act(() => account.recover(code))
              }}
            >
              <input data-testid="recover-input" className={`${input} font-mono`} value={code} onChange={(e) => setCode(e.target.value)} placeholder="MYC-XXXXXX-XXXXXX-XXXXXX-XXXXXX" autoComplete="off" spellCheck={false} />
              <button data-testid="recover-account" className={`${btn2} w-full`} disabled={busy || code.trim().length < 20}>
                {L('Zaloguj kodem', 'Sign in with code')}
              </button>
            </form>
          </Card>
        </div>
      )}

      {me && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label={L('Pseudonim', 'Handle')} value={<span data-testid="account-handle" className="break-all text-xl">{me.handle}</span>} hint={`ID ${short(me.id)}${me.room !== 'main' ? ` · ${me.room}` : ''}`} />
            <Kpi label={L('Punkty zatwierdzone', 'Approved points')} value={n1(me.points.approved)} hint={`${L('oczekujące', 'pending')} ${n1(me.points.pending)}`} src={L('z bazy (Twoje konto)', 'database (your account)')} verif="db" />
            <Kpi label={L('Polecone osoby', 'Referred people')} value={me.referrals} hint={`${L('liczy się', 'counted')}: ${me.referrals_qualified}`} tone="violet" src={L('liczone po stronie serwera', 'counted server-side')} verif="db" />
            <Kpi label={L('Urządzenia · węzły', 'Devices · nodes')} value={`${me.devices} · ${me.nodes.length}`} tone="amber" src={L('z bazy (Twoje konto)', 'database (your account)')} verif="db" />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Card title={L('Profil', 'Profile')}>
              {editing ? (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void act(() => account.setHandle(handle)).then(() => setEditing(false))
                  }}
                >
                  <input className={input} value={handle} onChange={(e) => setHandle(e.target.value)} maxLength={24} />
                  <button className={btn} disabled={busy}>
                    OK
                  </button>
                </form>
              ) : (
                <button className={btn2} onClick={() => (setHandle(me.handle), setEditing(true))}>
                  {L('Zmień pseudonim', 'Change handle')}
                </button>
              )}
              <div className="mt-4 text-sm text-slate-300">{L('Węzły przypisane do konta', 'Nodes linked to the account')}</div>
              <ul className="mt-1 flex flex-wrap gap-1 font-mono text-xs text-slate-400">
                {me.nodes.map((n) => (
                  <li key={n} className="rounded-lg bg-white/5 px-2 py-1">
                    {short(n)}
                  </li>
                ))}
              </ul>
              <form
                className="mt-3 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void act(() => account.linkNode(nodeId)).then(() => setNodeId(''))
                }}
              >
                <input className={`${input} font-mono text-sm`} value={nodeId} onChange={(e) => setNodeId(e.target.value)} placeholder={L('ID węzła PC (strona 127.0.0.1:8765)', 'PC node ID (page 127.0.0.1:8765)')} spellCheck={false} />
                <button className={btn2} disabled={busy || !UUID.test(nodeId.trim())}>
                  {L('Dodaj', 'Add')}
                </button>
              </form>
            </Card>

            <Card title={L('Kod odzyskiwania', 'Recovery code')}>
              <p className="text-sm text-slate-400">
                {me.has_recovery
                  ? L('Kod jest ustawiony. Nowy kod unieważnia poprzedni.', 'A code is set. A new code invalidates the old one.')
                  : L('Bez kodu konto istnieje tylko na tym urządzeniu. Utwórz kod i zapisz go w bezpiecznym miejscu.', 'Without a code the account exists only on this device. Create a code and keep it somewhere safe.')}
              </p>
              {shown && (
                <div className="mt-3 rounded-xl border border-amber/40 bg-amber/10 p-3">
                  <div className="text-xs text-amber">{L('Pokazujemy go tylko raz – zapisz teraz. Kto ma ten kod, ma dostęp do konta.', 'Shown only once – save it now. Anyone with this code can access the account.')}</div>
                  <div data-testid="recovery-code" className="mt-2 select-all break-all font-mono text-lg text-slate-50">
                    {shown}
                  </div>
                  <button className={`${btn2} mt-2`} onClick={() => void copy('rc', shown)}>
                    {copied === 'rc' ? L('Skopiowano', 'Copied') : L('Kopiuj', 'Copy')}
                  </button>
                </div>
              )}
              <button data-testid="new-recovery" className={`${btn2} mt-3`} disabled={busy} onClick={() => void act(async () => setShown((await account.newRecovery()) ?? ''))}>
                {me.has_recovery ? L('Utwórz nowy kod', 'Create a new code') : L('Utwórz kod odzyskiwania', 'Create recovery code')}
              </button>
            </Card>
          </div>

          <Card title={L('Znajomi i polecenia', 'Friends and referrals')}>
            <div className="grid gap-4 md:grid-cols-[auto_1fr]" data-testid="referral-card">
              {qr && <img src={qr} alt={L('Kod QR z Twoim linkiem', 'QR code with your link')} width={180} height={180} className="rounded-xl" />}
              <div className="min-w-0 space-y-3 text-sm">
                <div>
                  <div className="text-slate-400">{L('Twój kod', 'Your code')}</div>
                  <div data-testid="ref-code" className="font-mono text-2xl text-spore">
                    {me.ref_code}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className={btn2} onClick={() => void copy('link', invite)}>
                    {copied === 'link' ? L('Skopiowano', 'Copied') : L('Kopiuj link', 'Copy link')}
                  </button>
                  {'share' in navigator && (
                    <button className={btn2} onClick={() => void navigator.share({ title: 'Mycelium AI', url: invite }).catch(() => undefined)}>
                      {L('Udostępnij', 'Share')}
                    </button>
                  )}
                </div>
                <p className="text-xs text-slate-400">
                  {L(
                    `Polecenie zapisuje serwer: jedno na konto, w ciągu 30 dni od założenia, bez pętli i samopoleceń. Liczy się dopiero, gdy polecona osoba ma co najmniej 10 zatwierdzonych punktów prawdziwego wkładu. Polecone: ${me.referrals}, liczone: ${me.referrals_qualified}.`,
                    `Referrals are recorded server-side: one per account, within 30 days of signup, no loops or self-referrals. A referral counts only once the referred person has at least 10 approved points of real contribution. Referred: ${me.referrals}, counted: ${me.referrals_qualified}.`,
                  )}
                </p>
                {me.referred_by ? (
                  <p className="text-slate-300">
                    {L('Poleca Cię', 'Referred by')}: <span className="text-spore">{me.referred_by}</span>
                  </p>
                ) : me.can_refer ? (
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void act(() => account.refer(friend))
                    }}
                  >
                    <input data-testid="friend-code" className={`${input} font-mono`} value={friend} onChange={(e) => setFriend(e.target.value)} placeholder={L('kod znajomego (8 znaków)', 'friend’s code (8 chars)')} maxLength={8} spellCheck={false} />
                    <button data-testid="add-friend" className={btn2} disabled={busy || !/^[0-9a-f]{8}$/i.test(friend.trim())}>
                      {L('Dodaj', 'Add')}
                    </button>
                  </form>
                ) : null}
              </div>
            </div>
          </Card>

          <Circles />

          <Card title={L('Nagrody krypto – planowane, nieaktywne', 'Crypto rewards – planned, not active')}>
            <div className="space-y-3 text-sm">
              <p className="text-slate-400">
                {L(
                  'Nie ma tokena ani wypłat i niczego nie obiecujemy. Serwer tylko księguje punkty za prawdziwy wkład: najpierw „oczekujące”, a „zatwierdzone” dopiero po weryfikacji (bramka modelu, niezależni weryfikatorzy, konsensus). Analiza prawna (m.in. MiCA) jeszcze trwa.',
                  'There is no token and no payouts, and nothing is promised. The server only ledgers points for real contribution: first “pending”, then “approved” only after verification (model gate, independent verifiers, consensus). Legal review (incl. MiCA) is still pending.',
                )}
              </p>
              <dl className="grid grid-cols-3 gap-2 text-center" data-testid="points">
                {(['pending', 'approved', 'rejected'] as const).map((k) => (
                  <div key={k} className="rounded-xl bg-white/5 p-2">
                    <dt className="text-xs text-slate-500">{{ pending: L('oczekujące', 'pending'), approved: L('zatwierdzone', 'approved'), rejected: L('odrzucone', 'rejected') }[k]}</dt>
                    <dd className="text-lg tabular-nums text-slate-100">{n1(me.points[k])}</dd>
                  </div>
                ))}
              </dl>
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void act(() => account.setWallet(wallet))
                }}
              >
                <label className="block text-slate-300">
                  {L('Publiczny adres portfela Solana (opcjonalnie)', 'Public Solana wallet address (optional)')}
                  <input data-testid="wallet-input" className={`${input} mt-1 font-mono text-sm`} value={wallet} onChange={(e) => setWallet(e.target.value)} spellCheck={false} autoComplete="off" />
                </label>
                <p className="rounded-xl border border-rose/30 bg-rose/10 p-2 text-xs text-rose">
                  {L(
                    'Tylko publiczny adres. NIGDY nie wpisuj klucza prywatnego ani frazy odzyskiwania (seed) – nikt z Mycelium AI nigdy o nie nie poprosi.',
                    'Public address only. NEVER enter a private key or seed phrase – nobody from Mycelium AI will ever ask for them.',
                  )}
                </p>
                {walletBad && <p className="text-xs text-rose">{L('To nie wygląda na publiczny adres Solana.', 'This does not look like a public Solana address.')}</p>}
                <button className={btn2} disabled={busy || walletBad || wallet.trim() === (me.wallet_sol ?? '')}>
                  {wallet.trim() ? L('Zapisz adres', 'Save address') : L('Usuń adres', 'Remove address')}
                </button>
              </form>
            </div>
          </Card>

          <div className="flex flex-wrap gap-2">
            <button
              className={btn2}
              disabled={busy}
              onClick={() => {
                if (!me.has_recovery && me.devices <= 1 && !confirm(L('Bez kodu odzyskiwania stracisz dostęp do konta. Wylogować mimo to?', 'Without a recovery code you will lose access. Sign out anyway?'))) return
                void act(() => account.logout(!me.has_recovery && me.devices <= 1))
              }}
            >
              {L('Wyloguj to urządzenie', 'Sign out this device')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
