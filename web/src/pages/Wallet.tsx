import QRCode from 'qrcode'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Card, Kpi, PageHeader, Src } from '../components/ui'
import { useI18n } from '../i18n'
import { account } from '../myc/account'
import * as W from '../myc/wallet'

const input = 'w-full rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-base text-slate-100 placeholder:text-slate-500 focus:border-spore/50 focus:outline-none'
const btn = 'rounded-xl bg-spore px-4 py-3 text-base font-semibold text-ink disabled:opacity-50'
const btn2 = 'rounded-xl border border-white/15 px-4 py-3 text-sm text-slate-200 disabled:opacity-50'

const ERR: Record<string, [string, string]> = {
  'bad-pass': ['Złe hasło portfela.', 'Wrong wallet passphrase.'],
  locked: ['Portfel jest zablokowany – wpisz hasło.', 'Wallet is locked – enter your passphrase.'],
  'bad-backup': ['Zły kod kopii zapasowej (sprawdź literówki).', 'Invalid backup code (check for typos).'],
  'no-target': ['Nie ma portfela o takim pseudonimie.', 'No wallet with that handle.'],
  'bad-memo': ['Notatka: do 64 znaków (litery, cyfry, spacja, . , : ! ? # _ + -).', 'Memo: up to 64 chars (letters, digits, space, . , : ! ? # _ + -).'],
  'no-session': ['Sesja konta wygasła – zaloguj się kodem odzyskiwania w zakładce Konto.', 'Account session expired – sign in with your recovery code in Account.'],
  'rate limit': ['Za dużo prób – spróbuj za minutę.', 'Too many attempts – try again in a minute.'],
}

/** Etykieta „tokeny testowe” – widoczna wszędzie, gdzie pada kwota. */
export function TestBanner({ en }: { en: boolean }) {
  return (
    <div className="card border-amber/30 bg-amber/[0.06] text-sm leading-relaxed text-amber" data-testid="myc-test-banner" role="note">
      <b>MYC-test = {en ? 'test tokens with NO value' : 'tokeny testowe BEZ ŻADNEJ WARTOŚCI'}.</b>{' '}
      {en
        ? 'They cannot be bought, sold, traded or withdrawn and will never be exchanged for money. They exist only to test the Mycelium network: transfers, tips and block validation by nodes.'
        : 'Nie da się ich kupić, sprzedać, wymienić ani wypłacić i nigdy nie zostaną zamienione na pieniądze. Służą tylko do testowania sieci Mycelium: przelewów, napiwków i walidacji bloków przez węzły.'}
    </div>
  )
}

export function TxStatus({ t, blocks, en }: { t: W.Tx; blocks: Map<number, W.Block>; en: boolean }) {
  if (t.block == null) return <span className="chip border-white/15 text-slate-400">{en ? 'waiting for block' : 'czeka na blok'}</span>
  const b = blocks.get(t.block)
  if (b?.final_at)
    return (
      <span className="chip border-spore/40 text-spore" title={en ? 'attested by ≥ 2 independent nodes' : 'poświadczony przez ≥ 2 niezależne węzły'}>
        ✓ {en ? 'final' : 'ostateczny'} · #{t.block}
      </span>
    )
  if (b?.disputed) return <span className="chip border-rose/40 text-rose">{en ? 'disputed' : 'sporny'} · #{t.block}</span>
  return <span className="chip border-amber/30 text-amber">#{t.block} · {en ? 'awaiting 2 nodes' : 'czeka na 2 węzły'}</span>
}

export default function WalletPage() {
  const en = useI18n().lang === 'en'
  const L = (pl: string, e: string) => (en ? e : pl)
  useSyncExternalStore(account.subscribe, account.getVersion)
  useSyncExternalStore(W.walletEvents.subscribe, W.walletEvents.version)
  const me = account.me
  const acc = me?.id ?? ''
  const [wm, setWm] = useState<W.WalletMe | null | undefined>(undefined)
  const [local, setLocal] = useState<{ pub: string } | null | undefined>(undefined)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  const [busy, setBusy] = useState(false)
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [mode, setMode] = useState<'new' | 'restore'>('new')
  const [backupIn, setBackupIn] = useState('')
  const [ack, setAck] = useState(false)
  const [qr, setQr] = useState('')
  const [backup, setBackup] = useState('')
  const [hist, setHist] = useState<W.Tx[] | null>(null)
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [blks, setBlks] = useState<Map<number, W.Block>>(new Map())
  const draft = (() => {
    try {
      return JSON.parse(sessionStorage.getItem('myc.walletDraft') ?? '{}') as { to?: string; memo?: string; amount?: string }
    } catch {
      return {}
    }
  })()
  const [to, setTo] = useState(draft.to ?? '')
  const [amount, setAmount] = useState(draft.amount ?? '')
  const [memo, setMemo] = useState(draft.memo ?? '')
  const [target, setTarget] = useState<{ pub: string; handle: string | null } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => void account.refresh(), [])
  useEffect(() => sessionStorage.removeItem('myc.walletDraft'), [])

  const load = useCallback(async () => {
    if (!acc) return
    try {
      const [m, st] = await Promise.all([W.walletMe(), W.storedKey(acc)])
      setWm(m)
      setLocal(st ? { pub: st.pub } : null)
      if (m?.pub) {
        const h = await W.history(m.pub)
        setHist(h)
        const pubs = h.flatMap((t) => [t.from_pub, t.to_pub]).filter((x): x is string => !!x)
        const d = await W.dir(pubs)
        setNames(new Map(d.map((x) => [x.pub, x.handle])))
        const hs = [...new Set(h.map((t) => t.block).filter((x): x is number => x != null))]
        if (hs.length) {
          const bs = await W.rest<W.Block[]>(`myc_wallet_blocks?select=*&height=in.(${hs.join(',')})`)
          setBlks(new Map(bs.map((b) => [b.height, b])))
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [acc])
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 20_000)
    return () => clearInterval(t)
  }, [load])
  useEffect(() => {
    if (wm?.pub) void QRCode.toDataURL(`myc-test:${wm.pub}`, { margin: 1, width: 200, color: { dark: '#0b1215', light: '#e2e8f0' } }).then(setQr, () => setQr(''))
  }, [wm?.pub])

  const run = async (f: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    setErr('')
    setOk('')
    try {
      await f()
      if (done) setOk(done)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const errText = err ? (Object.entries(ERR).find(([k]) => err.includes(k))?.[1][en ? 1 : 0] ?? err) : ''
  const unlocked = acc ? W.isUnlocked(acc) : false
  const passOk = pass.length >= 10 && pass === pass2
  const amt = W.parseAmount(amount)
  const keyMismatch = wm?.pub && local && local.pub !== wm.pub

  if (me === undefined) return <div className="card text-sm text-slate-400">{L('Sprawdzam konto…', 'Checking account…')}</div>

  return (
    <div className="space-y-4" data-testid="wallet-page">
      <PageHeader title="Mycelium Wallet">
        {L(
          'Twój portfel w sieci Mycelium. Klucz prywatny powstaje i zostaje w tej przeglądarce (zaszyfrowany Twoim hasłem) – serwer zna tylko adres publiczny. Przelewy podpisujesz na urządzeniu, a węzły grzybni niezależnie sprawdzają każdy podpis i zamykają bloki.',
          'Your wallet on the Mycelium network. The private key is created and kept in this browser (encrypted with your passphrase) – the server only knows your public address. You sign transfers on your device, and mycelium nodes independently check every signature and seal the blocks.',
        )}
      </PageHeader>
      <TestBanner en={en} />

      {errText && (
        <div role="alert" className="card border-rose/30 text-sm text-rose" data-testid="wallet-error">
          {errText}
        </div>
      )}
      {ok && (
        <div role="status" className="card border-spore/30 text-sm text-spore" data-testid="wallet-ok">
          {ok}
        </div>
      )}

      {!me && (
        <Card title={L('Najpierw konto', 'Account first')}>
          <p className="text-sm text-slate-300">
            {L('Portfel należy do anonimowego konta Mycelium (sam pseudonim, bez e-maila).', 'The wallet belongs to an anonymous Mycelium account (just a handle, no email).')}
          </p>
          <a href="#/konto" className={`${btn} mt-3 inline-block`}>
            {L('Załóż konto', 'Create account')}
          </a>
        </Card>
      )}

      {me && wm !== undefined && local !== undefined && (!wm?.pub || !local || keyMismatch) && (
        <Card title={wm?.pub ? L('Portfel jest na innym urządzeniu', 'Wallet is on another device') : L('Utwórz portfel', 'Create wallet')}>
          {wm?.pub && (
            <p className="mb-3 text-sm text-slate-300">
              {L(
                `Konto ma portfel ${W.shortPub(wm.pub)}, ale jego klucza nie ma w tej przeglądarce. Przywróć go kodem kopii zapasowej. Możesz też utworzyć nowy adres – saldo starego zostaje na starym adresie (dostęp tylko z jego kluczem).`,
                `This account has wallet ${W.shortPub(wm.pub)}, but its key is not in this browser. Restore it with the backup code. You can also create a new address – the old balance stays on the old address (accessible only with its key).`,
              )}
            </p>
          )}
          <div className="mb-3 flex gap-2">
            <button className={mode === 'new' ? btn : btn2} onClick={() => setMode('new')} data-testid="wallet-mode-new">
              {L('Nowy klucz', 'New key')}
            </button>
            <button className={mode === 'restore' ? btn : btn2} onClick={() => setMode('restore')} data-testid="wallet-mode-restore">
              {L('Przywróć z kodu', 'Restore from code')}
            </button>
          </div>
          {mode === 'restore' && (
            <textarea
              className={`${input} mb-2 font-mono text-sm`}
              rows={3}
              value={backupIn}
              onChange={(e) => setBackupIn(e.target.value)}
              placeholder="MYCW1-XXXXX-XXXXX-…"
              spellCheck={false}
              autoComplete="off"
              data-testid="wallet-backup-in"
            />
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <input className={input} type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={L('Hasło portfela (min. 10 znaków)', 'Wallet passphrase (min. 10 chars)')} data-testid="wallet-pass" />
            <input className={input} type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} placeholder={L('Powtórz hasło', 'Repeat passphrase')} data-testid="wallet-pass2" />
          </div>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-relaxed text-slate-400">
            <li>{L('Hasło szyfruje klucz na tym urządzeniu. Nie wysyłamy go nigdzie i nie da się go odzyskać.', 'The passphrase encrypts the key on this device. It is never sent anywhere and cannot be recovered.')}</li>
            <li>{L('Po utworzeniu zapisz kod kopii zapasowej (przycisk niżej). Bez niego utrata urządzenia = utrata tokenów testowych.', 'After creating, save the backup code (button below). Without it, losing the device = losing the test tokens.')}</li>
            <li>{L('Nikomu nie podawaj kodu kopii – kto go zna, przejmuje portfel. Mycelium nigdy o niego nie poprosi.', 'Never share the backup code – whoever has it controls the wallet. Mycelium will never ask for it.')}</li>
          </ul>
          <label className="mt-3 flex items-start gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1" data-testid="wallet-ack" />
            {L('Rozumiem: MYC-test nie ma wartości, a klucz jest tylko u mnie.', 'I understand: MYC-test has no value and the key is only with me.')}
          </label>
          <button
            className={`${btn} mt-3 w-full sm:w-auto`}
            disabled={busy || !passOk || !ack || (mode === 'restore' && !backupIn.trim())}
            data-testid="wallet-create"
            onClick={() =>
              run(async () => {
                const seed = mode === 'restore' ? await W.seedFromBackup(backupIn) : undefined
                await W.createWallet(acc, pass, seed)
                setPass('')
                setPass2('')
                setBackupIn('')
              }, mode === 'restore' ? L('Portfel przywrócony.', 'Wallet restored.') : L('Portfel utworzony. Teraz zapisz kod kopii zapasowej.', 'Wallet created. Now save the backup code.'))
            }
          >
            {busy ? L('Szyfruję…', 'Encrypting…') : mode === 'restore' ? L('Przywróć portfel', 'Restore wallet') : L('Utwórz portfel', 'Create wallet')}
          </button>
          {pass && pass2 && pass !== pass2 && <p className="mt-2 text-xs text-rose">{L('Hasła się różnią.', 'Passphrases differ.')}</p>}
        </Card>
      )}

      {me && wm?.pub && local && !keyMismatch && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Kpi
              label={L('Saldo (MYC-test)', 'Balance (MYC-test)')}
              value={W.fmtMyc(wm.balance, en)}
              hint={wm.pending_in ? L(`w tym ${W.fmtMyc(wm.pending_in, en)} czeka na blok`, `incl. ${W.fmtMyc(wm.pending_in, en)} waiting for a block`) : L('tokeny testowe, bez wartości', 'test tokens, no value')}
              src={L('księga MYC-test w bazie (myc_wallet_bal), co 20 s', 'MYC-test ledger in the database (myc_wallet_bal), every 20 s')}
              verif="db"
              testid="wallet-balance"
            />
            <Kpi label={L('Wysłane przelewy', 'Transfers sent')} value={wm.nonce ?? 0} hint={L('nonce = licznik podpisanych przelewów', 'nonce = count of signed transfers')} tone="sky" />
            <div className="card">
              <div className="eyebrow">{L('Kran', 'Faucet')}</div>
              <p className="mt-2 text-xs text-slate-400">{L('10,00 MYC-test raz na 20 h na konto', '10.00 MYC-test once per 20 h per account')}</p>
              <button className={`${btn} mt-3 w-full`} disabled={busy || (!!wm.faucet_next && new Date(wm.faucet_next) > new Date())} data-testid="wallet-faucet" onClick={() => run(() => W.faucet(), L('Kran: +10,00 MYC-test', 'Faucet: +10.00 MYC-test'))}>
                {wm.faucet_next && new Date(wm.faucet_next) > new Date()
                  ? L(`Następny: ${new Date(wm.faucet_next).toLocaleString('pl-PL', { timeZone: 'Europe/Amsterdam', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`, `Next: ${new Date(wm.faucet_next).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`)
                  : L('Odbierz 10,00', 'Claim 10.00')}
              </button>
            </div>
          </div>

          <Card title={L('Twój adres (klucz publiczny)', 'Your address (public key)')}>
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
              {qr && <img src={qr} alt={L('Kod QR adresu', 'Address QR code')} width={160} height={160} className="rounded-xl" data-testid="wallet-qr" />}
              <div className="min-w-0 flex-1">
                <p className="break-all font-mono text-sm text-slate-200" data-testid="wallet-pub">
                  {wm.pub}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {L('Pseudonim', 'Handle')}: <b className="text-slate-200">@{me.handle}</b> · {L('można wysyłać na adres albo na pseudonim', 'you can send to the address or the handle')}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    className={btn2}
                    onClick={async () => {
                      await navigator.clipboard.writeText(wm.pub ?? '').catch(() => undefined)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    }}
                  >
                    {copied ? L('Skopiowano', 'Copied') : L('Kopiuj adres', 'Copy address')}
                  </button>
                  <a className={btn2} href={`#/eksplorator`} onClick={() => sessionStorage.setItem('myc.explorerAddr', wm.pub ?? '')}>
                    {L('Zobacz w eksploratorze', 'View in explorer')}
                  </a>
                </div>
              </div>
            </div>
          </Card>

          {!unlocked ? (
            <Card title={L('Odblokuj, aby wysyłać', 'Unlock to send')}>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input className={input} type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={L('Hasło portfela', 'Wallet passphrase')} data-testid="wallet-unlock-pass" />
                <button className={btn} disabled={busy || !pass} data-testid="wallet-unlock" onClick={() => run(async () => (await W.unlock(acc, pass), setPass('')))}>
                  {busy ? L('Sprawdzam…', 'Checking…') : L('Odblokuj', 'Unlock')}
                </button>
              </div>
              <p className="mt-2 text-xs text-slate-500">{L('Klucz zostaje odblokowany tylko w tej karcie, na 5 minut.', 'The key stays unlocked only in this tab, for 5 minutes.')}</p>
            </Card>
          ) : (
            <Card
              title={L('Wyślij MYC-test', 'Send MYC-test')}
              right={
                <button className="text-xs text-slate-400 underline" onClick={() => W.lock()} data-testid="wallet-lock">
                  {L('Zablokuj', 'Lock')}
                </button>
              }
            >
              <div className="grid gap-2">
                <input
                  className={`${input} font-mono text-sm`}
                  value={to}
                  onChange={(e) => (setTo(e.target.value), setTarget(null))}
                  onBlur={() => to.trim() && void W.resolveTarget(to).then(setTarget, (e: Error) => (setTarget(null), setErr(e.message)))}
                  placeholder={L('@pseudonim albo adres (64 znaki hex)', '@handle or address (64 hex chars)')}
                  spellCheck={false}
                  autoComplete="off"
                  data-testid="wallet-to"
                />
                {target && (
                  <p className="text-xs text-slate-400" data-testid="wallet-target">
                    {L('Odbiorca', 'Recipient')}: {target.handle ? <b className="text-slate-200">@{target.handle}</b> : L('adres bez pseudonimu', 'address without handle')} · <span className="font-mono">{W.shortPub(target.pub)}</span>
                  </p>
                )}
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <input className={input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={L('Kwota, np. 1,50', 'Amount, e.g. 1.50')} data-testid="wallet-amount" />
                  <span className="self-center text-sm text-slate-400">MYC-test</span>
                </div>
                <input className={input} value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={64} placeholder={L('Notatka (opcjonalnie, publiczna)', 'Memo (optional, public)')} data-testid="wallet-memo" />
                <button
                  className={btn}
                  disabled={busy || !to.trim() || !amt || amt > (wm.balance ?? 0)}
                  data-testid="wallet-send"
                  onClick={() =>
                    run(async () => {
                      const t = target ?? (await W.resolveTarget(to))
                      setTarget(t)
                      const r = await W.send(acc, wm.pub!, t.pub, amt!, memo)
                      setAmount('')
                      setMemo('')
                      setOk(L(`Wysłano (transakcja #${r.id}). Trafi do bloku w ciągu ok. minuty, potem węzły go poświadczą.`, `Sent (transaction #${r.id}). It joins a block within about a minute, then nodes attest it.`))
                    })
                  }
                >
                  {busy ? L('Podpisuję…', 'Signing…') : L('Podpisz i wyślij', 'Sign and send')}
                </button>
                {amt != null && amt > (wm.balance ?? 0) && <p className="text-xs text-rose">{L('Za mało środków.', 'Insufficient balance.')}</p>}
              </div>
              <p className="mt-2 text-xs text-slate-500">{L('Podpis Ed25519 powstaje w tej przeglądarce. Serwer i węzły sprawdzają podpis, numer kolejny (nonce) i saldo – powtórka ani podwójne wydanie nie przejdą.', 'The Ed25519 signature is made in this browser. The server and nodes check the signature, sequence number (nonce) and balance – replays and double-spends are rejected.')}</p>
            </Card>
          )}

          <Card title={L('Kopia zapasowa', 'Backup')}>
            {backup ? (
              <div>
                <p className="break-all rounded-xl bg-black/40 p-3 font-mono text-sm text-amber" data-testid="wallet-backup">
                  {backup}
                </p>
                <p className="mt-2 text-xs text-rose">{L('Zapisz na papierze albo w menedżerze haseł. Kto zna ten kod, ma Twój portfel. Nie wysyłaj go nikomu.', 'Write it on paper or in a password manager. Whoever knows this code owns your wallet. Never send it to anyone.')}</p>
                <button className={`${btn2} mt-2`} onClick={() => setBackup('')}>
                  {L('Ukryj', 'Hide')}
                </button>
              </div>
            ) : (
              <button className={btn2} disabled={!unlocked} data-testid="wallet-show-backup" onClick={() => run(async () => setBackup(await W.revealBackup(acc)))}>
                {unlocked ? L('Pokaż kod kopii zapasowej', 'Show backup code') : L('Odblokuj portfel, aby zobaczyć kod', 'Unlock the wallet to see the code')}
              </button>
            )}
          </Card>

          <Card title={L('Historia', 'History')}>
            {hist === null ? (
              <p className="text-sm text-slate-400">{L('Wczytuję…', 'Loading…')}</p>
            ) : hist.length === 0 ? (
              <p className="text-sm text-slate-400" data-testid="wallet-history-empty">
                {L('Brak transakcji. Odbierz 10,00 z kranu albo poproś kogoś o przelew na @' + me.handle + '.', 'No transactions yet. Claim 10.00 from the faucet or ask someone to send to @' + me.handle + '.')}
              </p>
            ) : (
              <ul className="divide-y divide-white/[0.06]" data-testid="wallet-history">
                {hist.map((t) => {
                  const inc = t.to_pub === wm.pub
                  const other = inc ? t.from_pub : t.to_pub
                  return (
                    <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                      <div className="min-w-0">
                        <div className="text-slate-200">
                          {t.kind === 'mint' ? W.mintLabel(t.memo, en) : inc ? L('Od', 'From') + ' ' + (names.get(other!) ? '@' + names.get(other!) : W.shortPub(other!)) : L('Do', 'To') + ' ' + (names.get(other!) ? '@' + names.get(other!) : W.shortPub(other!))}
                        </div>
                        <div className="text-xs text-slate-500">
                          #{t.id} · {new Date(t.created_at).toLocaleString(en ? 'en-GB' : 'pl-PL', { timeZone: 'Europe/Amsterdam', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                          {t.kind === 'transfer' && t.memo ? ` · „${t.memo}”` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <TxStatus t={t} blocks={blks} en={en} />
                        <span className={`font-mono tabular-nums ${inc ? 'text-spore' : 'text-rose'}`}>
                          {inc ? '+' : '−'}
                          {W.fmtMyc(t.amount, en)}
                        </span>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
            <Src v="db">{L('publiczna księga MYC-test (myc_wallet_tx); status bloku z poświadczeń węzłów', 'public MYC-test ledger (myc_wallet_tx); block status from node attestations')}</Src>
          </Card>

          <details className="card text-sm text-slate-300">
            <summary className="cursor-pointer text-slate-200">{L('To urządzenie', 'This device')}</summary>
            <p className="mt-2 text-xs text-slate-400">{L('Usunięcie klucza z tej przeglądarki nie usuwa portfela ani salda. Bez kodu kopii zapasowej nie odzyskasz dostępu.', 'Removing the key from this browser does not delete the wallet or balance. Without the backup code you cannot regain access.')}</p>
            <button
              className={`${btn2} mt-2 border-rose/30 text-rose`}
              onClick={() => {
                if (confirm(L('Usunąć zaszyfrowany klucz z tej przeglądarki?', 'Remove the encrypted key from this browser?'))) void run(() => W.forgetKey(acc))
              }}
            >
              {L('Usuń klucz z tej przeglądarki', 'Remove key from this browser')}
            </button>
          </details>
        </>
      )}
    </div>
  )
}
