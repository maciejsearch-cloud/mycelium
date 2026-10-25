// „Jak zrozumiałem zdanie”: części mowy (kolor), cechy, części zdania z pytaniami, przydawki (do czego), zdania składowe,
// ramy orzeczeń i oczekiwania Walentego. Model: opublikowana (niezależnie zweryfikowana) wersja rozbioru z grzybni.
import { useEffect, useState } from 'react'
import { POS_PL } from '../myc/rozbior'
import { RB_LICENCE, ensureRozbior, logParse, setRbVariant, understand, useRozbior } from '../myc/rozbiorLive'
import { trainConsent } from '../myc/answers'

export const POS_COLOR: Record<string, string> = {
  NOUN: 'bg-sky-500/20 text-sky-200 border-sky-400/40',
  PROPN: 'bg-sky-500/30 text-sky-100 border-sky-300/50',
  VERB: 'bg-rose-500/20 text-rose-200 border-rose-400/40',
  AUX: 'bg-rose-500/10 text-rose-200 border-rose-400/30',
  ADJ: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/40',
  ADV: 'bg-amber-500/20 text-amber-200 border-amber-400/40',
  PRON: 'bg-violet-500/20 text-violet-200 border-violet-400/40',
  DET: 'bg-violet-500/10 text-violet-200 border-violet-400/30',
  NUM: 'bg-orange-500/20 text-orange-200 border-orange-400/40',
  ADP: 'bg-slate-500/30 text-slate-200 border-slate-400/40',
  CCONJ: 'bg-teal-500/20 text-teal-200 border-teal-400/40',
  SCONJ: 'bg-teal-500/30 text-teal-100 border-teal-300/50',
  PART: 'bg-fuchsia-500/20 text-fuchsia-200 border-fuchsia-400/40',
  INTJ: 'bg-pink-500/20 text-pink-200 border-pink-400/40',
}
const ASP: Record<string, string> = { Imp: 'niedokonany', Perf: 'dokonany' }
const TENSE: Record<string, string> = { Past: 'czas przeszły', Pres: 'czas teraźniejszy', Fut: 'czas przyszły' }
const MOOD: Record<string, string> = { Ind: 'oznajmujący', Imp: 'rozkazujący', Cnd: 'przypuszczający' }
const VOICE: Record<string, string> = { Act: 'strona czynna', Pass: 'strona bierna' }
const pl = (m: Record<string, string>, v: string | null | undefined) => (v ? (m[v] ?? v) : undefined)
const pct = (x: number | null | undefined) => (x == null ? '–' : `${(x * 100).toFixed(1)}%`)
const KIND: Record<string, string> = { personal: 'pytanie osobiste (o rozmówcę)', factual: 'pytanie o fakt', statement: 'zdanie oznajmujące' }

export default function RozbiorTable({ text, en }: { text: string; en: boolean }) {
  const s = useRozbior()
  const [open, setOpen] = useState(false)
  const [logged, setLogged] = useState<number | 'no' | undefined>()
  useEffect(() => {
    if (open) void ensureRozbior()
  }, [open])
  const u = s.status === 'ready' ? understand(text) : undefined
  useEffect(() => {
    if (!open || !u || logged !== undefined) return
    if (!trainConsent.get()) return setLogged('no')
    logParse(u).then(
      (id) => setLogged(id ?? 'no'),
      () => setLogged('no'),
    )
  }, [open, u, logged])
  const T = u?.a.tokens ?? []
  const form = (i: number | null | undefined) => (i ? T[i - 1]?.form : undefined)
  return (
    <details className="mt-1 whitespace-normal text-left text-xs text-slate-300" data-testid="rozbior" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer text-slate-400">{en ? 'How I understood the sentence' : 'Jak zrozumiałem zdanie'}</summary>
      {s.status === 'loading' && <p className="mt-1 text-slate-500">{en ? 'loading the parsing model (~4 MB)…' : 'wczytuję model rozbioru (ok. 4 MB)…'}</p>}
      {s.status === 'none' && (
        <p className="mt-1 text-slate-500" data-testid="rozbior-empty">
          {en ? 'No verified parsing model is published yet – nothing to show.' : 'Nie ma jeszcze opublikowanego (zweryfikowanego) modelu rozbioru – nie pokazuję zgadywania.'}
        </p>
      )}
      {s.status === 'error' && <p className="mt-1 text-rose-300">{(en ? 'model not loaded: ' : 'nie wczytano modelu: ') + s.error}</p>}
      {u && (
        <div className="mt-1 space-y-2 rounded-lg border border-slate-700/60 bg-slate-900/60 p-2" data-testid="rozbior-table">
          <p data-testid="rozbior-route">
            <b>{en ? 'Route' : 'Trasa'}:</b> {KIND[u.route.kind]}
            {u.route.wh && ` · ${en ? 'asked slot' : 'pytane miejsce'}: „${u.route.wh.word}” (${u.route.wh.part ?? '–'}${u.route.wh.q ? `, ${u.route.wh.q}` : ''})`}
            {u.route.props.length > 0 && ` → Wikidata ${u.route.props.join(', ')}`}
            <span className="block text-slate-500">{u.route.why}</span>
          </p>
          {/* telefon: karta na słowo (bez przewijania w poziomie); od sm: tabela */}
          <ol className="space-y-1 sm:hidden" data-testid="rozbior-cards">
            {T.filter((t) => t.upos !== 'PUNCT').map((t) => (
              <li key={t.i} className="rounded-md border border-slate-800 bg-slate-950/40 px-2 py-1" data-testid="rozbior-row">
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <span className="text-slate-500">{t.i}.</span>
                  <b className="text-sm text-slate-100">{t.form}</b>
                  {t.lemma && t.lemma.toLowerCase() !== t.form.toLowerCase() && <span className="text-[10px] text-slate-500">({t.lemma})</span>}
                  <span className={`chip whitespace-nowrap ${POS_COLOR[t.upos] ?? 'border-slate-600 text-slate-300'}`}>{POS_PL[t.upos] ?? t.upos}</span>
                </div>
                {t.part && (
                  <div>
                    <b className="text-slate-100">{t.part}</b>
                    {t.okol && ` ${t.okol}`}
                    {t.q && <span className="text-spore"> · {t.q}?</span>}
                    {t.of && t.part === 'przydawka' && <span className="text-slate-400"> → {form(t.of)}</span>}
                  </div>
                )}
                {t.cechy.length > 0 && <div className="text-[11px] leading-snug text-slate-400">{t.cechy.join(', ')}</div>}
              </li>
            ))}
          </ol>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full border-collapse">
              <thead className="text-slate-500">
                <tr>
                  <th className="pr-2 text-left font-normal">#</th>
                  <th className="pr-2 text-left font-normal">{en ? 'word' : 'słowo'}</th>
                  <th className="pr-2 text-left font-normal">{en ? 'part of speech' : 'część mowy'}</th>
                  <th className="pr-2 text-left font-normal">{en ? 'sentence part · question' : 'część zdania · pytanie'}</th>
                  <th className="pr-2 text-left font-normal">{en ? 'morphology' : 'cechy'}</th>
                </tr>
              </thead>
              <tbody>
                {T.map((t) => (
                  <tr key={t.i} className="border-t border-slate-800 align-top">
                    <td className="pr-2 text-slate-500">{t.i}</td>
                    <td className="pr-2 font-medium text-slate-100">
                      {t.form}
                      {t.lemma && t.lemma.toLowerCase() !== t.form.toLowerCase() && <span className="block text-[10px] text-slate-500">{t.lemma}</span>}
                    </td>
                    <td className="pr-2">
                      {t.upos !== 'PUNCT' && <span className={`chip whitespace-nowrap ${POS_COLOR[t.upos] ?? 'border-slate-600 text-slate-300'}`}>{POS_PL[t.upos] ?? t.upos}</span>}
                    </td>
                    <td className="pr-2">
                      {t.part && <b className="text-slate-100">{t.part}</b>}
                      {t.okol && ` ${t.okol}`}
                      {t.q && <span className="text-spore"> · {t.q}?</span>}
                      {t.of && t.part === 'przydawka' && <span className="text-slate-400"> → {form(t.of)}</span>}
                    </td>
                    <td className="pr-2 text-slate-400">{t.cechy.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {u.a.frames.length > 0 && (
            <ul className="space-y-0.5" data-testid="rozbior-frames">
              {u.a.frames.map((f) => (
                <li key={f.pred}>
                  <b className="text-rose-200">ORZECZENIE</b> {f.words.map((w) => form(w)).join(' ')} ({[f.kind, en ? f.aspect : pl(ASP, f.aspect), en ? f.tense : pl(TENSE, f.tense), en ? f.mood : pl(MOOD, f.mood), en ? f.voice : pl(VOICE, f.voice)].filter(Boolean).join(', ')}){f.neg && ' · NIE'}
                  {f.args.map((g, k) => (
                    <span key={k}>
                      {' '}
                      · <span className="text-spore">{g.q ?? g.part}</span> {T.slice(g.span[0] - 1, g.span[1]).map((x) => x.form).join(' ')}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          )}
          {u.a.clauses.length > 1 && (
            <p data-testid="rozbior-clauses">
              <b>{en ? 'Clauses' : 'Zdania składowe'}:</b>{' '}
              {u.a.clauses.map((c) => `${c.id + 1}. „${form(c.head)}” – ${c.type}${c.conj ? ` (spójnik „${c.conj}”)` : ''}`).join(' · ')}
            </p>
          )}
          {u.valence && (
            <p className="text-slate-400" data-testid="rozbior-walenty">
              {en ? 'Walenty expects' : 'Walenty: czasownik oczekuje'}: {u.valence.slice(0, 2).map((s) => s.join(' + ')).join(' | ')}
            </p>
          )}
          <p className="text-[10px] text-slate-500" data-testid="rozbior-prov">
            {s.variant === 'pdb' ? `${en ? 'Model' : 'Model'} v${s.row?.version}` : en ? 'Model LFG (static file)' : 'Model LFG (plik statyczny)'} · role-F1 {pct(s.row?.verify_f1 ?? s.row?.f1)} {s.variant === 'pdb' ? (en ? 'verified on' : 'zweryfikowane na') : en ? 'measured on' : 'zmierzone na'} UD test (n={s.row?.eval_n ?? '–'} {en ? 'sentences' : 'zdań'}) · UPOS {pct(s.row?.upos)} · {en ? 'confidence' : 'pewność'} {pct(u.conf)} · {u.ms.toFixed(0)} ms ·{' '}
            <span data-testid="rozbior-licence">
              {en ? 'weights' : 'wagi'}: {RB_LICENCE[s.variant].data} ({RB_LICENCE[s.variant].licence}
              {s.variant === 'pdb' ? (en ? ', non-commercial' : ', niekomercyjnie') : ''})
            </span>
            {' '}· Walenty (CC BY-SA 4.0, {en ? 'questions only' : 'tylko pytania'}) ·{' '}
            <button
              type="button"
              className="underline"
              data-testid="rozbior-variant"
              onClick={() => setRbVariant(s.variant === 'pdb' ? 'lfg' : 'pdb')}
            >
              {s.variant === 'pdb' ? (en ? 'use the GPL-3.0 model (LFG, no NC limit)' : 'użyj modelu GPL-3.0 (LFG, bez ograniczenia NC)') : en ? 'back to the default model (PDB)' : 'wróć do modelu domyślnego (PDB)'}
            </button>
            {u.morf && (en ? ' · lemmas & features: Morfeusz 2 / SGJP (BSD-2)' : ' · lematy i cechy: Morfeusz 2 / SGJP (BSD-2)')}
            {typeof logged === 'number' && ` · ${en ? `saved #${logged} for correction in Verify` : `zapisany #${logged} do poprawy w Weryfikuj`}`}
          </p>
        </div>
      )}
    </details>
  )
}
