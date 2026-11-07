import { useEffect, useState } from 'react'
import { SB_KEY, SB_URL } from '../myc/store'
import { ago } from './TimeChart'
import { Card, Kpi } from './ui'

// Bitcoin Puzzle #71 (docs/puzzle71.md): liczby wyłącznie z podpisanych raportów węzłów (myc_p71_stats) i z publicznych
// eksploratorów (saldo). Brak raportów = pusty stan, nic nie jest szacowane „na zapas”.
type Stats = {
  keys_done: string
  chunks_done: number
  chunks_open: number
  chunks_disputed: number
  rechecks_ok: number
  rechecks_bad: number
  nodes_total: number
  nodes_live: number
  rate_live: number
  nodes: { node: string; rate: number; pct: number | null; backend: string | null; keys: string; chunks: number; live: boolean; first_at: string }[]
  first_at: string | null
  at: string
}
type Chain = { balance_sat: number; tx_count: number; mempool_spent_sat?: number; src: string; at: string | null }

export const P71_ADDR = '1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU'
const SPACE = 2 ** 70
const YEAR = 365.25 * 86400
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }

async function chainLive(): Promise<Chain> {
  for (const [src, url] of [
    ['mempool.space', `https://mempool.space/api/address/${P71_ADDR}`],
    ['blockstream.info', `https://blockstream.info/api/address/${P71_ADDR}`],
  ] as const) {
    try {
      const r = await fetch(url)
      if (!r.ok) continue
      const d = await r.json()
      return { balance_sat: d.chain_stats.funded_txo_sum - d.chain_stats.spent_txo_sum, tx_count: d.chain_stats.tx_count, mempool_spent_sat: d.mempool_stats.spent_txo_sum, src, at: new Date().toISOString() }
    } catch {
      /* następne źródło */
    }
  }
  const r = await fetch(`${import.meta.env.BASE_URL}data/p71-chain.json`)
  const d = await r.json()
  return { balance_sat: d.balance_sat, tx_count: d.tx_count, src: `${d.sources.join(' + ')} (snapshot)`, at: d.fetched_at }
}

const fmt = (n: number, en: boolean, d = 0) => n.toLocaleString(en ? 'en-GB' : 'pl-PL', { maximumFractionDigits: d })
const sci = (x: number, en = false) => {
  if (x === 0) return '0'
  const e = Math.floor(Math.log10(x))
  if (e >= -2 && e < 6) return fmt(x, en, 2)
  return `${fmt(x / 10 ** e, en, 2)}·10^${e}`
}
const rateTxt = (r: number, en: boolean) => (r >= 1e6 ? `${fmt(r / 1e6, en, 2)} ${en ? 'M keys/s' : 'mln kluczy/s'}` : `${fmt(r / 1e3, en, 1)} ${en ? 'k keys/s' : 'tys. kluczy/s'}`)

export const SPLIT: [number, string, string][] = [
  [40, 'rozwój projektu (serwery, sprzęt, praca)', 'project development (servers, hardware, work)'],
  [30, 'użytkownicy – proporcjonalnie do zweryfikowanej pracy przy zagadce (podpisane raporty)', 'users – in proportion to verified puzzle work (signed reports)'],
  [15, 'odkup MYC (rezerwa do czasu prawdziwego tokena)', 'MYC buy-back (held in reserve until a real token exists)'],
  [15, 'pula płynności MYC (rezerwa do czasu prawdziwej puli)', 'MYC liquidity pool (held in reserve until a real pool exists)'],
]

export default function Puzzle71({ en }: { en: boolean }) {
  const [s, setS] = useState<Stats | null | undefined>()
  const [c, setC] = useState<Chain | null | undefined>()
  useEffect(() => {
    const load = () =>
      fetch(`${SB_URL}/rest/v1/rpc/myc_p71_stats`, { method: 'POST', headers: H, body: '{}' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then(setS, () => setS(null))
    load()
    chainLive().then(setC, () => setC(null))
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [])

  const keys = s ? Number(s.keys_done) : 0
  const rate = s?.rate_live ?? 0
  const fullYears = rate > 0 ? SPACE / rate / YEAR : null
  const pYear = rate > 0 ? (rate * YEAR) / SPACE : null
  const btc = c ? c.balance_sat / 1e8 : null
  return (
    <Card title={en ? 'Puzzle 71 – searching for a Bitcoin key (≈10% of node power)' : 'Puzzle 71 – szukanie klucza Bitcoin (≈10% mocy węzłów)'} className="mb-4">
      <div data-testid="p71">
        <p className="mb-3 text-sm text-slate-300">
          {en
            ? `A public puzzle from 2015: the private key of address ${P71_ADDR} is somewhere among 2^70 ≈ 1.18·10^21 keys. Nodes check random, non-overlapping chunks of 2^32 keys and sign every report. We search ourselves – no third-party service and no cut for anyone else.`
            : `Publiczna zagadka z 2015 r.: klucz prywatny adresu ${P71_ADDR} leży gdzieś wśród 2^70 ≈ 1,18·10^21 kluczy. Węzły sprawdzają losowe, nienakładające się paczki po 2^32 kluczy i podpisują każdy raport. Szukamy sami – bez zewnętrznej usługi i bez prowizji dla nikogo.`}
        </p>
        <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label={en ? 'Speed now' : 'Szybkość teraz'} value={s === undefined ? '…' : s && rate > 0 ? rateTxt(rate, en) : '—'} hint={s ? `${en ? 'nodes reporting (15 min)' : 'węzły raportujące (15 min)'}: ${s.nodes_live}` : undefined} src="myc_p71_nodes.rate" verif="self" />
          <Kpi label={en ? 'Keys checked' : 'Sprawdzone klucze'} value={s === undefined ? '…' : s ? sci(keys, en) : '—'} hint={s ? `${s.chunks_done} ${en ? 'chunks of 2^32' : 'paczek po 2^32'}${s.chunks_open ? ` · ${s.chunks_open} ${en ? 'in progress' : 'w toku'}` : ''}` : undefined} tone="sky" src="myc_p71_chunks" verif="self" />
          <Kpi label={en ? 'Share of the space covered' : 'Przejrzana część przestrzeni'} value={s === undefined ? '…' : s ? `${sci((keys / SPACE) * 100, en)} %` : '—'} hint={en ? 'of 2^70 keys' : 'z 2^70 kluczy'} tone="violet" src="keys / 2^70" verif="self" />
          <Kpi label={en ? 'Balance on the address' : 'Saldo na adresie'} value={c === undefined ? '…' : btc != null ? `${fmt(btc, en, 3)} BTC` : '—'} hint={c ? `${btc != null ? fmt(btc, en, 8) + ' BTC · ' : ''}${c.src}${c.at ? ' · ' + ago(c.at, en ? 'en' : 'pl') : ''}${c.mempool_spent_sat ? (en ? ' · SPEND IN MEMPOOL' : ' · WYDATEK W MEMPOOLU') : ''}` : en ? 'explorer unavailable' : 'eksplorator niedostępny'} tone="amber" src="mempool.space / blockstream.info" verif="verified" />
        </div>
        <div className="mb-3 rounded-xl border border-amber-300/20 bg-amber-300/5 p-3 text-sm text-amber-100" data-testid="p71-odds">
          <b>{en ? 'Honest odds: ' : 'Uczciwe szanse: '}</b>
          {fullYears != null && pYear != null
            ? en
              ? `at the current ${rateTxt(rate, en)}, checking the whole space would take ≈${sci(fullYears, en)} years (on average half of that to find the key). Chance of finding it within a year: ≈1 in ${sci(1 / pYear, en)}. Others search with far more power (GPU farms), so even that is optimistic.`
              : `przy obecnych ${rateTxt(rate, en)} przejrzenie całej przestrzeni zajęłoby ≈${sci(fullYears, en)} lat (średnio połowę tego do znalezienia klucza). Szansa na znalezienie w ciągu roku: ≈1 do ${sci(1 / pYear, en)}. Szukają też inni, z dużo większą mocą (farmy GPU), więc i to jest optymistyczne.`
            : en
              ? 'no node is reporting speed right now, so there is no estimate. For scale: at 1 million keys/s the whole space takes ≈37 million years.'
              : 'żaden węzeł nie raportuje teraz szybkości, więc nie ma szacunku. Dla skali: przy 1 mln kluczy/s cała przestrzeń to ≈37 mln lat.'}{' '}
          {en ? 'This is not an investment and not a promise of any payout.' : 'To nie jest inwestycja ani obietnica wypłaty.'}
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <div>
            <p className="mb-1 text-xs text-slate-400">{en ? 'If the key is ever found – split after fees (published in advance)' : 'Jeśli klucz kiedyś się znajdzie – podział po opłatach (ogłoszony z góry)'}</p>
            <ul className="space-y-1 text-sm" data-testid="p71-split">
              {SPLIT.map(([p, pl, enT]) => (
                <li key={p + pl} className="flex gap-2">
                  <span className="w-10 shrink-0 text-right font-mono text-spore">{p}%</span>
                  <span className="text-slate-200">{en ? enT : pl}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-slate-400">
              {en
                ? 'MYC is currently a test token with no value and no market. The buy-back and liquidity parts are held in reserve until a real MYC token and pool exist. The claim is made manually by the project owner via a private transaction (the found key is encrypted to the owner and never published).'
                : 'MYC jest dziś tokenem testowym bez wartości i bez rynku. Części na odkup i pulę płynności czekają w rezerwie, aż powstanie prawdziwy token MYC i pula. Odbiór robi ręcznie właściciel projektu prywatną transakcją (znaleziony klucz jest szyfrowany do właściciela i nigdy nie jest publikowany).'}
            </p>
          </div>
          <div>
            <p className="mb-1 text-xs text-slate-400">{en ? 'Participating nodes (signed reports)' : 'Węzły biorące udział (podpisane raporty)'}</p>
            {s === undefined ? (
              <p className="text-sm text-slate-500">…</p>
            ) : !s || !s.nodes.length ? (
              <p className="text-sm text-slate-400" data-testid="p71-empty">
                {s === null ? (en ? 'Could not load puzzle statistics.' : 'Nie udało się wczytać statystyk zagadki.') : en ? 'No node has reported puzzle work yet.' : 'Żaden węzeł nie zgłosił jeszcze pracy przy zagadce.'}
              </p>
            ) : (
              <ul className="space-y-1 text-xs">
                {s.nodes.map((n) => (
                  <li key={n.node} className="flex items-center justify-between gap-2 rounded-lg border border-white/10 px-2 py-1">
                    <span className="font-mono text-slate-100">{n.node}</span>
                    <span className={n.live ? 'text-spore' : 'text-slate-500'}>{n.live && n.rate > 0 ? rateTxt(n.rate, en) : en ? 'idle' : 'nie liczy'}</span>
                    <span className="text-slate-400">
                      {sci(Number(n.keys), en)} {en ? 'keys' : 'kluczy'} · {n.backend ?? '—'} · {n.pct ?? '—'}%
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {s && (s.rechecks_ok > 0 || s.rechecks_bad > 0) && (
              <p className="mt-2 text-xs text-slate-400">
                {en ? 'Cross-checks by another node' : 'Przeliczenia przez inny węzeł'}: {s.rechecks_ok} {en ? 'match' : 'zgodnych'}, {s.rechecks_bad} {en ? 'mismatch' : 'niezgodnych'}
              </p>
            )}
            <p className="mt-2 text-xs text-slate-400">
              {en
                ? 'Volunteer PC nodes: off by default; turn on in the node panel (Passive tab → Puzzle #71). It uses one lowest-priority thread, at most 10% of the node’s threads.'
                : 'Węzły ochotników (PC): domyślnie wyłączone; włączasz w panelu węzła (zakładka Pasywny → Puzzle #71). Zajmuje jeden wątek o najniższym priorytecie, maks. 10% wątków węzła.'}
            </p>
          </div>
        </div>
      </div>
    </Card>
  )
}
