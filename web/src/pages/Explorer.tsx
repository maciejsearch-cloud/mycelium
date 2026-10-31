import { useCallback, useEffect, useState } from 'react'
import { Card, Kpi, PageHeader, Src } from '../components/ui'
import { useI18n } from '../i18n'
import * as W from '../myc/wallet'
import { TestBanner, TxStatus } from './Wallet'

const input = 'w-full rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-base text-slate-100 placeholder:text-slate-500 focus:border-spore/50 focus:outline-none'
const btn2 = 'rounded-xl border border-white/15 px-4 py-2.5 text-sm text-slate-200 disabled:opacity-50'
const tz = (s: string, en: boolean) => new Date(s).toLocaleString(en ? 'en-GB' : 'pl-PL', { timeZone: 'Europe/Amsterdam', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const nf = (x: number | null | undefined, d = 0) => (x == null ? '—' : x.toLocaleString('pl-PL', { maximumFractionDigits: d }))

function BlockRow({ b, att, names, en }: { b: W.Block; att: W.Attest[]; names: Map<string, string>; en: boolean }) {
  const L = (pl: string, e: string) => (en ? e : pl)
  const [open, setOpen] = useState(false)
  const [txs, setTxs] = useState<W.Tx[] | null>(null)
  const [checked, setChecked] = useState<string>('')
  const good = att.filter((a) => a.ok && a.matches && a.eligible)
  useEffect(() => {
    if (open && !txs) void W.blockTxs(b.height).then(setTxs, () => setTxs([]))
  }, [open, txs, b.height])
  return (
    <li className="py-3" data-testid={`block-${b.height}`}>
      <button className="flex w-full flex-wrap items-center justify-between gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <div className="min-w-0">
          <div className="font-medium text-slate-100">
            {L('Blok', 'Block')} #{b.height} · {b.n_tx} tx
          </div>
          <div className="font-mono text-[11px] text-slate-500">{b.hash.slice(0, 24)}… · {tz(b.created_at, en)}</div>
        </div>
        {b.final_at ? (
          <span className="chip border-spore/40 text-spore" data-testid="block-final">
            ✓ {L('ostateczny', 'final')} · {good.length} {L('węzły', 'nodes')} · {Math.max(0, Math.round((+new Date(b.final_at) - +new Date(b.created_at)) / 1000))} s
          </span>
        ) : b.disputed ? (
          <span className="chip border-rose/40 text-rose">{L('sporny', 'disputed')}</span>
        ) : (
          <span className="chip border-amber/30 text-amber">
            {good.length}/2 {L('poświadczeń', 'attestations')}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-3 space-y-3 rounded-xl bg-black/20 p-3 text-xs">
          <dl className="grid gap-1 font-mono text-[11px] text-slate-400">
            <div>
              <dt className="inline text-slate-500">prev: </dt>
              <dd className="inline break-all">{b.prev_hash}</dd>
            </div>
            <div>
              <dt className="inline text-slate-500">merkle: </dt>
              <dd className="inline break-all">{b.merkle_root}</dd>
            </div>
            <div>
              <dt className="inline text-slate-500">hash: </dt>
              <dd className="inline break-all">{b.hash}</dd>
            </div>
          </dl>
          <div>
            <div className="mb-1 font-semibold text-slate-300">{L('Poświadczenia węzłów', 'Node attestations')}</div>
            {att.length === 0 ? (
              <p className="text-slate-500">{L('Jeszcze żaden węzeł nie sprawdził tego bloku.', 'No node has checked this block yet.')}</p>
            ) : (
              <ul className="space-y-1">
                {att.map((a) => (
                  <li key={a.node_id} className="flex flex-wrap justify-between gap-2">
                    <span className="font-mono">{a.node_id.slice(0, 8)}</span>
                    <span className={a.ok && a.matches ? 'text-spore' : 'text-rose'}>
                      {a.ok ? (a.matches ? L('poprawny', 'valid') : L('inny skrót!', 'hash mismatch!')) : `${L('odrzucił', 'rejected')}: ${a.reason}`}
                    </span>
                    <span className="text-slate-400">
                      {a.n_sig} {L('podpisów', 'signatures')} · {a.ms} ms · {a.backend}
                      {!a.eligible && ` · ${L('nieuprawniony (< 3 przyjęte wyniki AI)', 'not eligible (< 3 accepted AI results)')}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-300">{L('Transakcje', 'Transactions')}</span>
              {txs && txs.some((t) => t.kind === 'transfer') && (
                <button
                  className="text-spore underline"
                  onClick={() => {
                    const tr = txs.filter((t) => t.kind === 'transfer')
                    const t0 = performance.now()
                    const ok = tr.filter(W.verifyTx).length
                    setChecked(L(`${ok}/${tr.length} podpisów poprawnych (sprawdzone w tej przeglądarce, ${Math.round(performance.now() - t0)} ms)`, `${ok}/${tr.length} signatures valid (checked in this browser, ${Math.round(performance.now() - t0)} ms)`))
                  }}
                >
                  {L('Sprawdź podpisy tutaj', 'Verify signatures here')}
                </button>
              )}
            </div>
            {checked && <p className="mb-1 text-spore">{checked}</p>}
            {!txs ? (
              <p className="text-slate-500">{L('Wczytuję…', 'Loading…')}</p>
            ) : (
              <TxList txs={txs} names={names} en={en} />
            )}
          </div>
        </div>
      )}
    </li>
  )
}

function TxList({ txs, names, en, blocks }: { txs: W.Tx[]; names: Map<string, string>; en: boolean; blocks?: Map<number, W.Block> }) {
  const who = (p: string | null) => (p ? (names.get(p) ? '@' + names.get(p) : W.shortPub(p)) : '')
  return (
    <ul className="divide-y divide-white/[0.05]">
      {txs.map((t) => (
        <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
          <span className="min-w-0 text-slate-300">
            #{t.id} · {t.kind === 'mint' ? `${W.mintLabel(t.memo, en)} → ${who(t.to_pub)}` : `${who(t.from_pub)} → ${who(t.to_pub)}${t.memo ? ` „${t.memo}”` : ''}`}
          </span>
          <span className="flex items-center gap-2">
            {blocks && <TxStatus t={t} blocks={blocks} en={en} />}
            <span className="font-mono tabular-nums text-slate-200">{W.fmtMyc(t.amount, en)}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

export default function Explorer() {
  const en = useI18n().lang === 'en'
  const L = (pl: string, e: string) => (en ? e : pl)
  const [st, setSt] = useState<W.Stats | null>(null)
  const [bl, setBl] = useState<W.Block[] | null>(null)
  const [att, setAtt] = useState<W.Attest[]>([])
  const [pending, setPending] = useState<W.Tx[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [err, setErr] = useState('')
  const [addr, setAddr] = useState(() => sessionStorage.getItem('myc.explorerAddr') ?? '')
  const [view, setView] = useState<{ pub: string; handle: string | null; bal: number; nonce: number; txs: W.Tx[]; blocks: Map<number, W.Block> } | null>(null)

  const load = useCallback(async () => {
    try {
      const [s, b, p] = await Promise.all([W.stats(), W.blocks(20), W.pendingTxs()])
      setSt(s)
      setBl(b)
      setPending(p)
      if (b.length) setAtt(await W.attests(b[b.length - 1].height, b[0].height))
      const pubs = p.flatMap((t) => [t.from_pub, t.to_pub]).filter((x): x is string => !!x)
      if (pubs.length) {
        const d = await W.dir(pubs)
        setNames((m) => new Map([...m, ...d.map((x) => [x.pub, x.handle] as [string, string])]))
      }
      setErr('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 15_000)
    return () => clearInterval(t)
  }, [load])

  const lookup = useCallback(
    async (a: string) => {
      try {
        const t = await W.resolveTarget(a)
        const [b, txs] = await Promise.all([W.balanceOf(t.pub), W.history(t.pub, 50)])
        const d = await W.dir(txs.flatMap((x) => [x.from_pub, x.to_pub]).filter((x): x is string => !!x))
        setNames((m) => new Map([...m, ...d.map((x) => [x.pub, x.handle] as [string, string])]))
        const hs = [...new Set(txs.map((x) => x.block).filter((x): x is number => x != null))]
        const bs = hs.length ? await W.rest<W.Block[]>(`myc_wallet_blocks?select=*&height=in.(${hs.join(',')})`) : []
        setView({ pub: t.pub, handle: t.handle, bal: b?.balance ?? 0, nonce: b?.nonce ?? 0, txs, blocks: new Map(bs.map((x) => [x.height, x])) })
        setErr('')
      } catch (e) {
        setView(null)
        setErr(e instanceof Error ? (e.message === 'no-target' ? L('Nie ma portfela o takim pseudonimie.', 'No wallet with that handle.') : e.message) : String(e))
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [en],
  )
  useEffect(() => {
    if (addr) {
      void lookup(addr)
      sessionStorage.removeItem('myc.explorerAddr')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-4" data-testid="explorer-page">
      <PageHeader title={L('Eksplorator sieci', 'Network explorer')}>
        {L(
          'Publiczna księga MYC-test: bloki, transakcje i węzły, które je sprawdziły. Blok jest ostateczny, gdy co najmniej 2 niezależne węzły z przyjętą pracą AI przeliczą wszystkie podpisy, łańcuch skrótów, salda i korzeń Merkle i podpiszą ten sam skrót.',
          'The public MYC-test ledger: blocks, transactions and the nodes that checked them. A block is final when at least 2 independent nodes with accepted AI work recompute every signature, the hash chain, balances and the Merkle root, and sign the same hash.',
        )}
      </PageHeader>
      <TestBanner en={en} />
      {err && (
        <div role="alert" className="card border-rose/30 text-sm text-rose">
          {err}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={L('Bloki', 'Blocks')} value={nf(st?.height)} hint={st ? L(`ostateczne do #${st.final_height ?? 0}`, `final up to #${st.final_height ?? 0}`) : ''} testid="exp-height" />
        <Kpi label={L('Transakcje', 'Transactions')} value={nf(st?.tx)} hint={st ? L(`${st.pending_tx} czeka na blok`, `${st.pending_tx} waiting for a block`) : ''} tone="sky" />
        <Kpi
          label={L('Weryfikacja węzłów', 'Node verification')}
          value={st?.verify_tx_per_s != null ? `${nf(st.verify_tx_per_s, 1)} tx/s` : '—'}
          hint={L('podpisy / czas sprawdzania, 24 h', 'signatures / checking time, 24 h')}
          tone="violet"
          src={L('zgłaszane przez węzły przy poświadczeniu (ms, liczba podpisów)', 'reported by nodes with each attestation (ms, signature count)')}
          verif="self"
        />
        <Kpi
          label={L('Czas do ostateczności', 'Time to finality')}
          value={st?.finality_s_median != null ? `${nf(st.finality_s_median, 0)} s` : '—'}
          hint={L('mediana, 7 dni (od utworzenia bloku)', 'median, 7 days (from block creation)')}
          tone="amber"
          src={L('znaczniki czasu bloków w bazie', 'block timestamps in the database')}
          verif="db"
        />
      </div>
      <p className="text-xs text-slate-500">
        {L('Portfele', 'Wallets')}: {nf(st?.wallets)} · {L('wyemitowane (test)', 'issued (test)')}: {W.fmtMyc(st?.supply, en)} MYC-test · {L('walidatory (24 h)', 'validators (24 h)')}: {nf(st?.validators)}
      </p>

      <Card title={L('Sprawdź adres', 'Look up an address')}>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input className={`${input} font-mono text-sm`} value={addr} onChange={(e) => setAddr(e.target.value)} placeholder={L('@pseudonim albo adres', '@handle or address')} spellCheck={false} data-testid="exp-addr" />
          <button className={btn2} disabled={!addr.trim()} onClick={() => void lookup(addr)} data-testid="exp-lookup">
            {L('Szukaj', 'Search')}
          </button>
        </div>
        {view && (
          <div className="mt-3 text-sm" data-testid="exp-addr-view">
            <p className="break-all font-mono text-xs text-slate-400">{view.pub}</p>
            <p className="mt-1 text-slate-200">
              {view.handle ? `@${view.handle} · ` : ''}
              {L('saldo', 'balance')}: <b>{W.fmtMyc(view.bal, en)} MYC-test</b> · {L('przelewy wysłane', 'transfers sent')}: {view.nonce}
            </p>
            {view.txs.length === 0 ? <p className="mt-2 text-slate-500">{L('Brak transakcji.', 'No transactions.')}</p> : <TxList txs={view.txs} names={names} en={en} blocks={view.blocks} />}
          </div>
        )}
      </Card>

      {pending.length > 0 && (
        <Card title={L('Czeka na blok', 'Waiting for a block')}>
          <TxList txs={pending} names={names} en={en} />
          <p className="mt-2 text-xs text-slate-500">{L('Bloki powstają co minutę (pg_cron), gdy są nowe transakcje.', 'Blocks are made every minute (pg_cron) when there are new transactions.')}</p>
        </Card>
      )}

      <Card title={L('Ostatnie bloki', 'Latest blocks')}>
        {bl === null ? (
          <p className="text-sm text-slate-400">{L('Wczytuję…', 'Loading…')}</p>
        ) : bl.length === 0 ? (
          <p className="text-sm text-slate-400" data-testid="exp-empty">
            {L('Jeszcze nie ma bloków. Pierwszy powstanie minutę po pierwszej transakcji (np. odbiorze z kranu w zakładce Portfel).', 'No blocks yet. The first one appears a minute after the first transaction (e.g. a faucet claim in the Wallet tab).')}
          </p>
        ) : (
          <ul className="divide-y divide-white/[0.06]">
            {bl.map((b) => (
              <BlockRow key={b.height} b={b} att={att.filter((a) => a.height === b.height)} names={names} en={en} />
            ))}
          </ul>
        )}
        <Src v="db">{L('myc_wallet_blocks i myc_wallet_attest (publiczny odczyt), odświeżane co 15 s', 'myc_wallet_blocks and myc_wallet_attest (public read), refreshed every 15 s')}</Src>
      </Card>

      <Card title={L('Węzły walidujące (7 dni)', 'Validating nodes (7 days)')}>
        {!st || st.by_node.length === 0 ? (
          <p className="text-sm text-slate-400">{L('Żaden węzeł jeszcze nie poświadczył bloku.', 'No node has attested a block yet.')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr>
                  <th className="py-1 pr-3">{L('Węzeł', 'Node')}</th>
                  <th className="py-1 pr-3">{L('Bloki', 'Blocks')}</th>
                  <th className="py-1 pr-3">{L('Podpisy', 'Signatures')}</th>
                  <th className="py-1 pr-3">tx/s</th>
                  <th className="py-1">{L('Uprawniony', 'Eligible')}</th>
                </tr>
              </thead>
              <tbody>
                {st.by_node.map((n) => (
                  <tr key={n.node_id} className="border-t border-white/[0.05]">
                    <td className="py-1.5 pr-3 font-mono">{n.node_id.slice(0, 8)}</td>
                    <td className="py-1.5 pr-3">{n.blocks}</td>
                    <td className="py-1.5 pr-3">{n.sigs}</td>
                    <td className="py-1.5 pr-3">{n.ms > 0 ? nf((n.sigs * 1000) / n.ms, 0) : '—'}</td>
                    <td className="py-1.5">{n.eligible ? '✓' : L('nie (< 3 przyjęte wyniki AI)', 'no (< 3 accepted AI results)')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
