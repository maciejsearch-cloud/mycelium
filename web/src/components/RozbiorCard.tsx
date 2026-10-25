// Rozbiór zdań (warstwa rozumienia): wersje modelu z bramki role-F1, wynik reguł na parserze spaCy (nagrany),
// zbiory UD z podziałami i licencje (strona uznania autorstwa dla tej warstwy).
import { useEffect, useState } from 'react'
import { Card, Src } from './ui'
import { approvedParses, rbList, type RbRow } from '../myc/rozbiorLive'

interface Meta {
  sources: Record<string, { name: string; url: string; license: string; authors: string; rev: string | null }>
  splits: Record<string, { sents: number; toks: number; roles: number }>
  eval_n: number
}
interface Wyniki {
  generated_at: string
  baseline: { name: string; license: string; test: Record<string, number> }
  trained?: { file: string; test: Record<string, number> }
  votes?: { generated_at: string; used: number; leak: number; test: Record<string, number>; before: Record<string, number> }
  morf?: { license: string; coverage_browser: number; full: Record<string, number>; browser: Record<string, number> }
  variants?: Record<string, { default: boolean; license: string; note_pl: string; note_en: string; test: Record<string, number>; morf: Record<string, number>; sha256: string }>
  withdrawn?: { file: string; sha256: string; reason_pl: string; reason_en: string; test: Record<string, number> }[]
}
const p1 = (x: number | null | undefined) => (x == null ? '–' : `${(x * 100).toFixed(1)}%`)
const nf = (x: number) => x.toLocaleString('pl-PL')
const VOTES_MIN = 50 // = glosy.MIN_PARSES

export function RozbiorCard({ en }: { en: boolean }) {
  const [rows, setRows] = useState<RbRow[] | null | undefined>()
  const [meta, setMeta] = useState<Meta | null>()
  const [wy, setWy] = useState<Wyniki | null>()
  const [approved, setApproved] = useState<number | null | undefined>()
  useEffect(() => {
    rbList(50).then(setRows, () => setRows(null))
    approvedParses().then(setApproved, () => setApproved(null))
    const base = import.meta.env.BASE_URL
    fetch(`${base}data/rozbior/meta.json`).then((r) => (r.ok ? r.json() : null)).then(setMeta, () => setMeta(null))
    fetch(`${base}data/rozbior/wyniki.json`).then((r) => (r.ok ? r.json() : null)).then(setWy, () => setWy(null))
  }, [])
  return (
    <Card className="mt-4" title={en ? 'Sentence understanding (Polish parsing) – versions, data and licences' : 'Rozumienie zdań (rozbiór po polsku) – wersje, dane i licencje'}>
      <div className="space-y-3 text-sm" data-testid="rozbior-card">
        <p className="text-xs text-slate-400">
          {en
            ? 'role-F1 = agreement of (predicate, question, argument) triples – who/what, whom, to whom, with whom, where, when, why, negation – with the gold UD trees of the test split (never used for training). A version is published only when an independent verifier recomputes a higher role-F1.'
            : 'role-F1 = zgodność trójek (orzeczenie, pytanie, wyraz) – KTO/CO, KOGO/CO, KOMU, Z KIM, GDZIE, KIEDY, DLACZEGO, przeczenie – ze złotymi drzewami UD z podziału test (nigdy do treningu). Wersja jest publikowana dopiero, gdy niezależny weryfikator przeliczy wyższe role-F1.'}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums" data-testid="rozbior-versions">
            <thead className="text-slate-500">
              <tr>
                <th className="text-left font-normal">{en ? 'version' : 'wersja'}</th>
                <th className="text-left font-normal">status</th>
                <th className="text-right font-normal">role-F1</th>
                <th className="text-right font-normal">{en ? 'verified' : 'przeliczone'}</th>
                <th className="text-right font-normal">UPOS</th>
                <th className="text-right font-normal">{en ? 'feats' : 'cechy'}</th>
                <th className="text-right font-normal">LAS</th>
                <th className="text-right font-normal">{en ? 'tokens trained' : 'tokeny treningu'}</th>
              </tr>
            </thead>
            <tbody>
              {wy && (
                <tr className="border-t border-slate-800 text-slate-400">
                  <td>{wy.baseline.name}</td>
                  <td>{en ? 'baseline (recorded)' : 'punkt odniesienia (nagrany)'}</td>
                  <td className="text-right">{p1(wy.baseline.test.role_f1)}</td>
                  <td className="text-right">–</td>
                  <td className="text-right">{p1(wy.baseline.test.upos)}</td>
                  <td className="text-right">{p1(wy.baseline.test.feats)}</td>
                  <td className="text-right">{p1(wy.baseline.test.las)}</td>
                  <td className="text-right">–</td>
                </tr>
              )}
              {wy?.morf &&
                (
                  [
                    ['full', en ? 'PDB + Morfeusz 2 (nodes)' : 'PDB + Morfeusz 2 (węzły)'],
                    ['browser', en ? 'PDB + Morfeusz lexicon (browser)' : 'PDB + leksykon Morfeusza (przeglądarka)'],
                  ] as const
                ).map(([k, name]) => (
                  <tr key={k} className="border-t border-slate-800" data-testid={`rb-morf-${k}`}>
                    <td>{name}</td>
                    <td>{en ? 'measured on test' : 'zmierzone na teście'}</td>
                    <td className="text-right">{p1(wy.morf![k].role_f1)}</td>
                    <td className="text-right">–</td>
                    <td className="text-right">{p1(wy.morf![k].upos)}</td>
                    <td className="text-right">{p1(wy.morf![k].feats)}</td>
                    <td className="text-right">{p1(wy.morf![k].las)}</td>
                    <td className="text-right">–</td>
                  </tr>
                ))}
              {Object.entries(wy?.variants ?? {}).map(([k, v]) => (
                <tr key={k} className="border-t border-slate-800" data-testid={`rb-variant-${k}`}>
                  <td>
                    {k.toUpperCase()} + Morfeusz · <span className="text-violet">{v.license}</span>
                  </td>
                  <td>{v.default ? (en ? 'default model' : 'model domyślny') : en ? 'alternative (switch in chat)' : 'wariant (przełącznik w rozmowie)'} – {en ? v.note_en : v.note_pl}</td>
                  <td className="text-right">{p1(v.morf.role_f1)}</td>
                  <td className="text-right">–</td>
                  <td className="text-right">{p1(v.morf.upos)}</td>
                  <td className="text-right">{p1(v.morf.feats)}</td>
                  <td className="text-right">{p1(v.morf.las)}</td>
                  <td className="text-right">–</td>
                </tr>
              ))}
              {(wy?.withdrawn ?? []).map((w) => (
                <tr key={w.sha256} className="border-t border-slate-800 text-slate-500" data-testid="rb-withdrawn">
                  <td>{w.file}</td>
                  <td>{en ? w.reason_en : w.reason_pl}</td>
                  <td className="text-right">{p1(w.test.role_f1)}</td>
                  <td className="text-right">–</td>
                  <td className="text-right">{p1(w.test.upos)}</td>
                  <td className="text-right">{p1(w.test.feats)}</td>
                  <td className="text-right">{p1(w.test.las)}</td>
                  <td className="text-right">–</td>
                </tr>
              ))}
              {(rows ?? []).map((r) => (
                <tr key={r.id} className="border-t border-slate-800">
                  <td>v{r.version}</td>
                  <td className={r.status === 'published' ? 'text-spore' : r.status === 'rejected' ? 'text-rose-300' : 'text-amber'}>
                    {r.status}
                    {r.reason ? ` (${r.reason})` : ''}
                  </td>
                  <td className="text-right">{p1(r.f1)}</td>
                  <td className="text-right">{p1(r.verify_f1)}</td>
                  <td className="text-right">{p1(r.upos)}</td>
                  <td className="text-right">{p1(r.feats)}</td>
                  <td className="text-right">{p1(r.las)}</td>
                  <td className="text-right">{r.n_tok ? nf(r.n_tok) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows && !rows.length && <p className="mt-1 text-xs text-slate-500">{en ? 'No model version proposed yet.' : 'Nie zgłoszono jeszcze żadnej wersji modelu.'}</p>}
          {rows === null && <p className="mt-1 text-xs text-rose-300">{en ? 'versions unavailable (database)' : 'wersje niedostępne (baza)'}</p>}
        </div>
        {wy && (
          <Src v="recorded">
            {en ? 'Baseline' : 'Punkt odniesienia'}: {wy.baseline.name} ({wy.baseline.license}) + {en ? 'the same rules' : 'te same reguły'}, {en ? 'run' : 'przebieg'} {wy.generated_at.slice(0, 10)}, UD test n={nf(meta?.eval_n ?? 0)} {en ? 'sentences' : 'zdań'}. {en ? 'Versions: database myc_rb_models (live).' : 'Wersje: baza myc_rb_models (na żywo).'}
            {wy.morf &&
              (en
                ? ` Lemma accuracy: PDB ${p1(wy.trained?.test.lemma)}, + Morfeusz ${p1(wy.morf.full.lemma)}, browser lexicon ${p1(wy.morf.browser.lemma)} (knows ${p1(wy.morf.coverage_browser)} of test words); spaCy ${p1(wy.baseline.test.lemma)}. Morfeusz 2 / SGJP: ${wy.morf.license}.`
                : ` Trafność lematu: PDB ${p1(wy.trained?.test.lemma)}, + Morfeusz ${p1(wy.morf.full.lemma)}, leksykon w przeglądarce ${p1(wy.morf.browser.lemma)} (zna ${p1(wy.morf.coverage_browser)} słów testu); spaCy ${p1(wy.baseline.test.lemma)}. Morfeusz 2 / SGJP: ${wy.morf.license}.`)}
          </Src>
        )}
        <div className="text-xs text-slate-400" data-testid="rozbior-votes">
          <span className="text-slate-500">{en ? 'Training on approved parses: ' : 'Trening na zatwierdzonych rozbiorach: '}</span>
          {approved === undefined && '…'}
          {approved === null && <span className="text-rose-300">{en ? 'count unavailable (database)' : 'licznik niedostępny (baza)'}</span>}
          {typeof approved === 'number' &&
            (en
              ? `${nf(approved)} approved in Verify (live); training starts at ${VOTES_MIN}. `
              : `${nf(approved)} zatwierdzonych w Weryfikuj (na żywo); trening od ${VOTES_MIN}. `)}
          {wy?.votes
            ? en
              ? `Last run ${wy.votes.generated_at.slice(0, 10)}: ${wy.votes.used} sentences, role-F1 on UD test ${p1(wy.votes.before.role_f1)} → ${p1(wy.votes.test.role_f1)}.`
              : `Ostatni przebieg ${wy.votes.generated_at.slice(0, 10)}: ${wy.votes.used} zdań, role-F1 na teście UD ${p1(wy.votes.before.role_f1)} → ${p1(wy.votes.test.role_f1)}.`
            : en
              ? 'The model has not been trained on votes yet – nothing to compare.'
              : 'Model nie był jeszcze douczany na głosach – nie ma czego porównać.'}{' '}
          {en
            ? 'Only what voters checked is used (heads, relations, corrected UPOS); lemmas and features are never learned from votes; sentences overlapping UD dev/test are dropped.'
            : 'Używamy tylko tego, co sprawdzili głosujący (nadrzędniki, relacje, poprawione UPOS); lematów i cech nigdy nie uczymy z głosów; zdania pokrywające się z UD dev/test są odrzucane.'}
        </div>
        {meta && (
          <div data-testid="rozbior-data">
            <div className="mb-1 text-xs text-slate-500">{en ? 'Data (official UD splits)' : 'Dane (oficjalne podziały UD)'}</div>
            <table className="w-full text-xs tabular-nums">
              <thead className="text-slate-500">
                <tr>
                  <th className="text-left font-normal">{en ? 'split' : 'podział'}</th>
                  <th className="text-right font-normal">{en ? 'sentences' : 'zdania'}</th>
                  <th className="text-right font-normal">{en ? 'tokens' : 'tokeny'}</th>
                  <th className="text-right font-normal">{en ? 'roles' : 'role'}</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(meta.splits).map(([k, v]) => (
                  <tr key={k} className="border-t border-slate-800">
                    <td>{k}</td>
                    <td className="text-right">{nf(v.sents)}</td>
                    <td className="text-right">{nf(v.toks)}</td>
                    <td className="text-right">{nf(v.roles)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="mt-2 space-y-1 text-xs text-slate-400" data-testid="rozbior-licences">
              {Object.entries(meta.sources).map(([k, s]) => (
                <li key={k}>
                  <a className="text-spore underline" href={s.url} target="_blank" rel="noopener noreferrer">
                    {s.name}
                  </a>{' '}
                  – {s.authors} – <b>{s.license}</b>
                  {s.rev ? ` · rev ${s.rev}` : ''}
                </li>
              ))}
              <li>
                <a className="text-spore underline" href="https://zil.ipipan.waw.pl/Walenty" target="_blank" rel="noopener noreferrer">
                  Walenty
                </a>{' '}
                – {en ? 'valence dictionary of Polish (IPI PAN), 2021-07-12, verified schemata' : 'słownik walencyjny języka polskiego (IPI PAN), 2021-07-12, schematy zweryfikowane'} – <b>CC BY-SA 4.0</b>
              </li>
              <li>
                spaCy pl_core_news_sm 3.8.0 – <b>GPL-3.0</b> – {en ? 'baseline only (not shipped)' : 'tylko punkt odniesienia (nie jest dystrybuowany)'}
              </li>
              <li className="text-amber">
                {en
                  ? 'UD Polish-PDB is CC BY-NC-SA 4.0 (non-commercial, share-alike): the model weights trained on it inherit these terms; LFG is GPL-3.0.'
                  : 'UD Polish-PDB ma licencję CC BY-NC-SA 4.0 (niekomercyjnie, na tych samych warunkach): wagi modelu uczone na nim dziedziczą te warunki; LFG – GPL-3.0.'}
              </li>
            </ul>
          </div>
        )}
      </div>
    </Card>
  )
}
