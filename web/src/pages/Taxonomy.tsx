import { useEffect, useMemo, useState } from 'react'
import { ago, TimeChart, type Point } from '../components/TimeChart'
import { Card, Kpi, PageHeader } from '../components/ui'
import { useI18n } from '../i18n'
import { taxoSeed, type Seed } from '../myc/seed'
import { LEVEL, nodeName, pathLabel, taxoInputs, taxoList, taxoVersion, type TaxoInputs, type TaxoNode, type TaxoRow, type TaxoVersion } from '../myc/taxo'

const pct = (x?: number | null) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`)

export default function Taxonomy() {
  const { lang } = useI18n()
  const en = lang === 'en'
  const [rows, setRows] = useState<TaxoRow[] | undefined>()
  const [cur, setCur] = useState<TaxoVersion | undefined>()
  const [inp, setInp] = useState<TaxoInputs | undefined>()
  const [err, setErr] = useState('')
  useEffect(() => {
    const load = () =>
      taxoList()
        .then(async (r) => {
          setRows(r)
          const pub = r.filter((x) => x.status === 'published' && x.path).sort((a, b) => b.version! - a.version!)
          if (pub[0]) setCur(await taxoVersion(pub[0].path!))
        })
        .catch((e) => setErr(String(e.message)))
    void load()
    void taxoInputs().then(setInp).catch(() => undefined)
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [])
  const pub = useMemo(() => (rows ?? []).filter((r) => r.status === 'published').sort((a, b) => a.version! - b.version!), [rows])
  const last = pub[pub.length - 1]
  const first = pub[0]
  const pts: Point[] = pub.map((r) => ({ t: Date.parse(r.decided_at ?? r.created_at), acc: (r.acc ?? 0) * 100, nmi: (r.nmi ?? 0) * 100, purity: (r.purity ?? 0) * 100 }))
  const pending = (rows ?? []).find((r) => r.status === 'pending')
  const attempts = rows ?? []
  return (
    <div className="space-y-4" data-testid="taxonomy-page">
      <PageHeader title={en ? 'Self-organising word taxonomy' : 'Samoorganizująca się taksonomia słów'}>
        {en
          ? 'Nodes group dictionary words by themselves – no labels: multilingual MiniLM embeddings plus nearest WordNet/plWordNet hypernyms. Recursive clustering builds topics → categories → subcategories → fragments; branches split only when it truly improves cohesion and tiny groups merge. Each version is checked independently and published only if it is not worse on a fixed evaluation set (2,174 words, WordNet gold categories). Your corrections in Verify (move, rename, merge, split) shape the next version.'
          : 'Węzły same grupują słowa ze słowników – bez etykiet: wielojęzyczne osadzenia MiniLM i najbliższe hiperonimy z WordNetu/plWordNetu. Rekurencyjne grupowanie buduje tematy → kategorie → podkategorie → strzępki; gałąź dzieli się tylko, gdy naprawdę poprawia spójność, a za małe grupy się łączą. Każda wersja jest niezależnie sprawdzana i publikowana tylko, gdy nie jest gorsza na stałym zbiorze oceny (2174 słowa, złote kategorie WordNetu). Twoje poprawki w Weryfikuj (przenieś, zmień nazwę, połącz, podziel) kształtują następną wersję.'}
      </PageHeader>
      {err && <div className="card text-sm text-rose">{err}</div>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi label={en ? 'Version' : 'Wersja'} value={<span data-testid="taxo-version">{last ? `v${last.version}` : '—'}</span>} hint={last ? ago(last.decided_at ?? last.created_at, lang) : en ? 'none published yet' : 'jeszcze brak opublikowanej'} src={'RPC myc_tax_list'} verif="db" />
        <Kpi label={en ? 'Accuracy (held-out)' : 'Trafność (odłożone)'} value={<span data-testid="taxo-acc">{pct(last?.acc)}</span>} hint={first && last && first !== last ? `v${first.version}: ${pct(first.acc)}` : undefined} tone="amber" src={en ? 'held-out words, recorded at publication' : 'odłożone słowa, zapisane przy publikacji'} verif="db" />
        <Kpi label="NMI" value={pct(last?.nmi)} hint={en ? 'categories vs WordNet' : 'kategorie vs WordNet'} tone="violet" src={en ? 'vs WordNet categories, recorded at publication' : 'względem kategorii WordNet, zapisane przy publikacji'} verif="db" />
        <Kpi label={en ? 'Groups' : 'Grupy'} value={last?.metrics.n_nodes ?? '—'} hint={last?.metrics.by_level ? Object.entries(last.metrics.by_level).map(([k, v]) => `${v} ${k}`).join(' · ') : undefined} src={en ? 'from the published version' : 'z opublikowanej wersji'} verif="db" />
      </div>
      <Card title={en ? 'Quality per published version (real, recomputed by the verifier)' : 'Jakość kolejnych wersji (prawdziwe, przeliczone przez weryfikatora)'}>
        <TimeChart
          data={pts}
          unit="%"
          domain={[0, 100]}
          series={[
            { key: 'acc', name: en ? 'accuracy' : 'trafność', color: '#fbbf24' },
            { key: 'nmi', name: 'NMI', color: '#a78bfa' },
            { key: 'purity', name: en ? 'purity' : 'czystość', color: '#5eead4' },
          ]}
        />
        <p className="mt-2 text-xs text-slate-500">
          {en
            ? 'Accuracy: each leaf group takes the majority WordNet category of its words outside the evaluation set; it is then checked on the 2,174 evaluation words. Random guessing ≈ 3%. Embeddings alone (no hypernyms) reach ≈ 21%.'
            : 'Trafność: każda grupa-liść dostaje większościową kategorię WordNetu swoich słów spoza zbioru oceny; sprawdzamy ją na 2174 słowach oceny. Losowo ≈ 3%. Same osadzenia (bez hiperonimów) dają ≈ 21%.'}
        </p>
      </Card>
      {pending && (
        <div className="card text-sm text-amber" data-testid="taxo-pending">
          {en ? 'Candidate' : 'Kandydat'} v{pending.version}: {pct(pending.acc)} · {en ? 'waiting for an independent check' : 'czeka na niezależne sprawdzenie'} ({ago(pending.created_at, lang)})
        </div>
      )}
      <Card title={en ? 'Tree (latest version)' : 'Drzewo (najnowsza wersja)'}>
        {cur && inp ? <Tree v={cur} inp={inp} en={en} /> : <p className="text-sm text-slate-500">{rows && !pub.length ? (en ? 'No published version yet – nodes are computing.' : 'Jeszcze brak opublikowanej wersji – węzły liczą.') : '…'}</p>}
      </Card>
      <SeedCard en={en} />
      <Card title={en ? 'Node attempts (all, including rejected)' : 'Próby węzłów (wszystkie, także odrzucone)'}>
        {attempts.length === 0 ? (
          <p className="text-sm text-slate-500">{en ? 'No attempts yet.' : 'Jeszcze brak prób.'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="taxo-attempts">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1 pr-2">{en ? 'when' : 'kiedy'}</th>
                  <th className="pr-2">{en ? 'version' : 'wersja'}</th>
                  <th className="pr-2">{en ? 'accuracy' : 'trafność'}</th>
                  <th className="pr-2">NMI</th>
                  <th className="pr-2">{en ? 'settings' : 'ustawienia'}</th>
                  <th className="pr-2">{en ? 'node' : 'węzeł'}</th>
                  <th>{en ? 'result' : 'wynik'}</th>
                </tr>
              </thead>
              <tbody>
                {attempts.slice(0, 30).map((r) => (
                  <tr key={r.id} className="border-t border-white/5">
                    <td className="py-1 pr-2 text-slate-400">{ago(r.created_at, lang)}</td>
                    <td className="pr-2">{r.version != null ? `v${r.version}` : '—'}</td>
                    <td className="pr-2 tabular-nums">{pct(r.acc)}</td>
                    <td className="pr-2 tabular-nums">{pct(r.nmi)}</td>
                    <td className="pr-2 text-slate-400">β={r.params.beta} k={r.params.k1} min={r.params.min}{(r.params as { seed?: number }).seed ? ' · seed' : ''}{r.n_corr ? ` · ${r.n_corr} ${en ? 'fixes' : 'poprawek'}` : ''}</td>
                    <td className="pr-2 font-mono text-slate-500">{r.proposer.slice(0, 8)}</td>
                    <td className={r.status === 'published' ? 'text-spore' : r.status === 'pending' ? 'text-amber' : 'text-rose'}>
                      {r.status === 'published' ? `✓ ${r.verifier ?? ''}` : r.status === 'pending' ? (en ? 'pending' : 'czeka') : r.reason ?? r.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {inp && <p className="text-xs text-slate-500">{(en ? 'Sources: ' : 'Źródła: ') + inp.sources.join(' · ')}</p>}
    </div>
  )
}

function Tree({ v, inp, en }: { v: TaxoVersion; inp: TaxoInputs; en: boolean }) {
  const kids = useMemo(() => {
    const m = new Map<number, TaxoNode[]>()
    for (const n of v.nodes) m.set(n.p, [...(m.get(n.p) ?? []), n])
    for (const a of m.values()) a.sort((x, y) => y.n - x.n)
    return m
  }, [v])
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [q, setQ] = useState('')
  const hit = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (s.length < 2) return undefined
    const i = inp.words.findIndex(([w]) => w === s)
    if (i < 0) return null
    const path: TaxoNode[] = []
    for (let x = v.leaf[i]; x >= 0; x = v.nodes[x].p) path.unshift(v.nodes[x])
    return { i, path }
  }, [q, inp, v])
  const toggle = (id: number) => setOpen((o) => new Set(o.has(id) ? [...o].filter((x) => x !== id) : [...o, id]))
  const row = (n: TaxoNode, depth: number) => {
    const ch = kids.get(n.id) ?? []
    const isOpen = open.has(n.id)
    return (
      <li key={n.id} data-testid={`taxo-node-${n.lvl}`}>
        <button onClick={() => ch.length && toggle(n.id)} className="flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/5" style={{ paddingLeft: 8 + depth * 14 }}>
          <span className="w-3 text-slate-500">{ch.length ? (isOpen ? '▾' : '▸') : '·'}</span>
          <span className={n.lvl === 0 ? 'font-medium text-glow' : 'text-slate-200'}>{nodeName(n, en)}</span>
          <span className="text-[11px] text-slate-500">
            {LEVEL[Math.min(n.lvl, 3)][en ? 1 : 0]} · {n.n} · {n.src === 'owner' ? (en ? 'name: owner' : 'nazwa: właściciel') : n.src === 'seed' ? `${en ? 'name: seed' : 'nazwa: seed'} (${n.label_src === 'wikidata+wordnet' ? 'Wikidata + WordNet' : n.label_src === 'korekta' ? (en ? 'fixed by hand' : 'poprawiona ręcznie') : 'plWordNet'})` : n.hidden ? (en ? 'internal group, no name' : 'grupa wewnętrzna, bez nazwy') : n.src === 'hyper' ? `${en ? 'hypernym' : 'hiperonim'} ${Math.round(n.cov * 100)}%` : en ? 'name guessed' : 'nazwa zgadnięta'}
          </span>
        </button>
        {(isOpen || !ch.length) && n.lvl > 0 && <div className="pb-1 text-xs text-slate-400" style={{ paddingLeft: 30 + depth * 14 }}>{n.top.map((j) => inp.words[j][0]).join(', ')}</div>}
        {isOpen && ch.length > 0 && <ul>{ch.map((c) => row(c, depth + 1))}</ul>}
      </li>
    )
  }
  return (
    <div className="space-y-2">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={en ? 'find a word, e.g. wombat or jeż' : 'znajdź słowo, np. wombat albo jeż'} className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-base" data-testid="taxo-search" />
      {hit === null && <p className="text-xs text-slate-500">{en ? 'not in the dictionary' : 'nie ma w słowniku'}</p>}
      {hit && (
        <p className="text-sm" data-testid="taxo-hit">
          {pathLabel(hit.path, en)} <span className="text-xs text-slate-500">({en ? 'WordNet' : 'WordNet'}: {en ? inp.taxonomy[inp.gold[hit.i]].en : inp.taxonomy[inp.gold[hit.i]].pl})</span>
        </p>
      )}
      <ul className="max-h-[32rem] overflow-y-auto text-sm">{(kids.get(-1) ?? []).map((n) => row(n, 0))}</ul>
    </div>
  )
}

/** Drzewo startowe (seed) – liczby z pliku i źródła z licencjami (strona uznania autorstwa). */
function SeedCard({ en }: { en: boolean }) {
  const [seed, setSeed] = useState<Seed | null>()
  const [facts, setFacts] = useState<{ n: number; by: Record<string, number>; built: string; licences: Record<string, string>; excluded: Record<string, number> } | null>()
  useEffect(() => {
    void taxoSeed().then((x) => setSeed(x ?? null))
    void fetch(`${import.meta.env.BASE_URL}data/seed/facts.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setFacts(d ? { n: d.facts.length, by: d.by_rel, built: d.built, licences: d.licences, excluded: d.excluded } : null))
      .catch(() => setFacts(null))
  }, [])
  return (
    <Card title={en ? 'Starter categories and facts (seed) – sources and licences' : 'Kategorie i fakty startowe (seed) – źródła i licencje'}>
      <div className="space-y-2 text-sm" data-testid="seed-card">
        {seed === undefined ? (
          <p className="text-slate-500">…</p>
        ) : seed === null ? (
          <p className="text-slate-500">{en ? 'no data' : 'brak danych'}</p>
        ) : (
          <p>
            <span data-testid="seed-cats">{seed.cats.length}</span> {en ? 'categories with Polish names' : 'kategorii z polskimi nazwami'} ({seed.cats.filter((c) => c.label_src === 'wikidata+wordnet').length} Wikidata + WordNet, {seed.cats.filter((c) => c.label_src === 'plwordnet').length} plWordNet, {seed.cats.filter((c) => c.label_src === 'korekta').length} {en ? 'fixed by hand' : 'poprawionych ręcznie'}) · <span data-testid="seed-mapped">{seed.stats.mapped}</span> {en ? 'words mapped where all their main senses agree' : 'słów przypisanych tam, gdzie wszystkie główne znaczenia się zgadzają'} · {en ? 'medium trust, votable in Verify' : 'zaufanie średnie, można głosować w Weryfikuj'} · {en ? 'built' : 'zbudowano'} {seed.built.slice(0, 10)}
          </p>
        )}
        {facts === undefined ? null : facts === null ? (
          <p className="text-slate-500">{en ? 'facts: no data' : 'fakty: brak danych'}</p>
        ) : (
          <p>
            <span data-testid="seed-facts">{facts.n}</span> {en ? 'starter facts with source links' : 'faktów startowych z linkami do źródeł'} ({Object.entries(facts.by).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ')}) · {en ? 'excluded as overlapping the LM gate / chat benchmark' : 'wykluczone (pokrywały się z bramką LM / testem czatu)'}: {facts.excluded.gate_hash + facts.excluded.gate_8gram + facts.excluded.chat_facts_v1} · {en ? 'not human-approved – trust from the source' : 'niezatwierdzone przez ludzi – zaufanie ze źródła'}
          </p>
        )}
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-400" data-testid="attribution">
          {(seed?.sources ?? []).map((s) => (
            <li key={s.name}>
              <a className="underline" href={s.url} target="_blank" rel="noreferrer">
                {s.name}
              </a>{' '}
              – {s.licence}
            </li>
          ))}
          <li>
            <a className="underline" href="https://www.wikidata.org/" target="_blank" rel="noreferrer">
              Wikidata
            </a>{' '}
            ({en ? 'facts' : 'fakty'}) – CC0 1.0
          </li>
          <li>
            <a className="underline" href="https://pl.wiktionary.org/" target="_blank" rel="noreferrer">
              {en ? 'Polish Wiktionary' : 'Wikisłownik'}
            </a>{' '}
            ({en ? 'definitions, authors of Wiktionary' : 'definicje, autorzy Wikisłownika'}) – <a className="underline" href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA 4.0</a>
          </li>
        </ul>
      </div>
    </Card>
  )
}
