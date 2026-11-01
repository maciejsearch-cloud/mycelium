import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { SB_KEY, SB_URL } from '../myc/store'
import { ago } from './TimeChart'
import { Card, Src } from './ui'

// SelfModel – co grzybnia wie o sobie (myc_self_model, scripts/selfmodel_run.py, docs/selfmodel.md): twierdzenia
// z liczbą, przedziałem 95% i n, kontrola twierdzeń z kolejnym pomiarem, kalibracja pewności i historia decyzji.
// Tylko prawdziwa migawka z bazy; brak migawki = pusty stan. scope='czysta' pokazuje wyłącznie czystą grzybnię.
type Claim = { id: string; kind: string; domain: string; text_pl: string; text_en: string; n: number; source: string }
type Check = { claim_id: string; verdict: string; detail_pl: string; detail_en: string; n: number }
type Decision = { id: string; at: string; choice: Record<string, number>; reason: string; outcome_pl: string | null; outcome_en: string | null }
type Rel = { lo: number; n: number; conf: number; acc: number }
type Snap = {
  at: string
  claims: Claim[]
  checks: Check[]
  decisions: Decision[]
  calibration: {
    params?: { T: number; n_fit: number; fit_source: string }
    lm_definicje?: { ece_raw: number; ece_cal: number; conf_raw: number; conf_cal: number; n_held_out: number; correct: number; n: number; reliability_raw: Rel[] }
    domains?: Record<string, { ece_raw: number; ece_cal: number; n_held_out: number; correct: number; params: { T: number } }>
  }
  relations?: { source: string; available: boolean; public_rows: number } | null
}
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
const VERDICT: Record<string, [string, string, string]> = {
  zgodne: ['zgodne', 'consistent', 'text-spore'],
  niezgodne: ['niezgodne', 'inconsistent', 'text-rose'],
  brak_nowych_danych: ['brak nowych danych', 'no new evidence', 'text-slate-400'],
  za_malo_danych: ['za mało danych', 'not enough data', 'text-amber'],
}

export function SelfModel({ scope = 'all' }: { scope?: 'all' | 'czysta' }) {
  const { lang } = useI18n()
  const en = lang === 'en' && scope === 'all'
  const [snap, setSnap] = useState<Snap | null | undefined>()
  useEffect(() => {
    const load = () =>
      fetch(`${SB_URL}/rest/v1/myc_self_model?select=id,at,snapshot&order=id.desc&limit=1`, { headers: H })
        .then((r) => (r.ok ? (r.json() as Promise<{ snapshot: Snap }[]>) : Promise.reject(new Error(String(r.status)))))
        .then((rows) => setSnap(rows[0]?.snapshot ?? null), () => setSnap(null))
    load()
    const t = setInterval(load, 300_000)
    return () => clearInterval(t)
  }, [])
  const mine = (d: string) => (scope === 'czysta' ? d.startsWith('czysta/') : true)
  const claims = (snap?.claims ?? []).filter((c) => mine(c.domain) && (scope === 'all' || c.kind !== 'stan'))
  const ids = new Set(claims.map((c) => c.id))
  const checks = (snap?.checks ?? []).filter((c) => mine(c.claim_id.split(':')[1] ?? '') || ids.has(c.claim_id))
  const count = (v: string) => checks.filter((c) => c.verdict === v).length
  const cal = snap?.calibration
  const t = (pl: string, e: string) => (en ? e : pl)
  return (
    <Card title={t('Co grzybnia wie o sobie (SelfModel)', 'What the mycelium knows about itself (SelfModel)')} className="mb-4">
      <div data-testid="selfmodel">
        {snap === undefined ? (
          <p className="text-sm text-slate-500">…</p>
        ) : snap === null ? (
          <p className="text-sm text-slate-400" data-testid="selfmodel-empty">
            {t('Brak migawki – pojawi się po pierwszym samodzielnym pomiarze (scripts/selfmodel_run.py, co rundę samouka).', 'No snapshot yet – it appears after the first self-measurement (scripts/selfmodel_run.py, every self-study round).')}
          </p>
        ) : (
          <>
            <p className="mb-3 text-xs text-slate-400">
              {t('Migawka', 'Snapshot')} · {ago(snap.at, lang)} · {t('każde zdanie ma liczbę, przedział 95% i liczność próby', 'every statement carries a number, a 95% interval and the sample size')}
            </p>
            <ul className="space-y-2" data-testid="selfmodel-claims">
              {claims.map((c) => (
                <li key={c.id} className="rounded-xl border border-white/10 p-3 text-sm text-slate-200">
                  {en ? c.text_en : c.text_pl}
                  <span className="ml-1 text-xs text-slate-500">[{c.source}{c.n ? `, n=${c.n}` : ''}]</span>
                </li>
              ))}
            </ul>
            {scope === 'all' && cal?.params && cal.lm_definicje && (
              <div className="mt-3 rounded-xl border border-white/10 p-3 text-sm text-slate-300" data-testid="selfmodel-calibration">
                <div className="font-medium text-slate-100">{t('Kalibracja pewności modelu językowego', 'Language-model confidence calibration')}</div>
                <p className="mt-1">
                  {t('Temperatura', 'Temperature')} T = {cal.params.T} ({t('dopasowana na', 'fitted on')} {cal.params.n_fit} {t('pytaniach', 'questions')}: {cal.params.fit_source}).{' '}
                  {t('Na odłożonych', 'On the held-out')} {cal.lm_definicje.n_held_out}: ECE {cal.lm_definicje.ece_raw.toFixed(3)} → {cal.lm_definicje.ece_cal.toFixed(3)};{' '}
                  {t('średnia pewność', 'mean confidence')} {(cal.lm_definicje.conf_raw * 100).toFixed(1)}% → {(cal.lm_definicje.conf_cal * 100).toFixed(1)}%.
                </p>
                <div className="mt-2 flex items-end gap-1" aria-label={t('pewność a trafność (przed kalibracją)', 'confidence vs accuracy (uncalibrated)')}>
                  {cal.lm_definicje.reliability_raw.map((b) => (
                    <div key={b.lo} className="flex flex-1 flex-col items-center gap-0.5 text-[10px] text-slate-500" title={`${t('pewność', 'confidence')} ${(b.conf * 100).toFixed(0)}% · ${t('trafność', 'accuracy')} ${(b.acc * 100).toFixed(0)}% · n=${b.n}`}>
                      <div className="flex h-16 w-full items-end gap-px">
                        <div className="w-1/2 rounded-t bg-amber/60" style={{ height: `${b.conf * 100}%` }} />
                        <div className="w-1/2 rounded-t bg-spore/70" style={{ height: `${b.acc * 100}%` }} />
                      </div>
                      <span>{Math.round(b.lo * 100)}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-slate-500">{t('żółty: deklarowana pewność (surowa), zielony: rzeczywista trafność; oś: przedział pewności w %', 'amber: stated (raw) confidence, green: real accuracy; axis: confidence bin in %')}</p>
                {cal.domains && (
                  <table className="mt-2 w-full text-xs" data-testid="selfmodel-domains">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="text-left font-normal">{t('domena', 'domain')}</th>
                        <th className="text-right font-normal">T</th>
                        <th className="text-right font-normal">ECE {t('przed → po', 'before → after')}</th>
                        <th className="text-right font-normal">{t('odłożone', 'held out')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(cal.domains).map(([d, r]) => (
                        <tr key={d}>
                          <td>{d.replace('lm/', '')}</td>
                          <td className="text-right">{r.params.T}</td>
                          <td className="text-right">{r.ece_raw.toFixed(3)} → {r.ece_cal.toFixed(3)}</td>
                          <td className="text-right">{r.correct}/{r.n_held_out}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="mt-1 text-[11px] text-slate-500">{t('Temperatura osobno w każdej domenie: dopasowana na parzystych pytaniach, sprawdzona na nieparzystych. T = 10 to granica siatki – pewność modelu nie niesie tam informacji.', 'Separate temperature per domain: fitted on even questions, checked on odd ones. T = 10 is the grid limit – there the model’s confidence carries no information.')}</p>
              </div>
            )}
            <div className="mt-3 rounded-xl border border-white/10 p-3 text-sm" data-testid="selfmodel-checks">
              <div className="font-medium text-slate-100">
                {t('Kontrola spójności: twierdzenia kontra pomiar', 'Self-consistency: claims vs measurement')} ·{' '}
                {Object.keys(VERDICT).map((v) => `${VERDICT[v][en ? 1 : 0]} ${count(v)}`).join(' · ')}
              </div>
              {!checks.length ? (
                <p className="mt-1 text-slate-400">{t('Brak kontroli – potrzebna druga migawka albo dane z pewnością.', 'No checks yet – needs a second snapshot or confidence data.')}</p>
              ) : (
                <ul className="mt-1 space-y-1 text-xs">
                  {checks.map((c, i) => (
                    <li key={c.claim_id + i}>
                      <span className={VERDICT[c.verdict]?.[2] ?? ''}>{VERDICT[c.verdict]?.[en ? 1 : 0] ?? c.verdict}</span> · <span className="text-slate-400">{c.claim_id}</span> – {en ? c.detail_en : c.detail_pl}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {scope === 'all' && (
              <div className="mt-3 rounded-xl border border-white/10 p-3 text-sm" data-testid="selfmodel-decisions">
                <div className="font-medium text-slate-100">{t('Moje decyzje i ich skutki (plany samouka)', 'My decisions and their outcomes (self-study plans)')}</div>
                {!snap.decisions.length ? (
                  <p className="mt-1 text-slate-400">{t('Brak decyzji.', 'No decisions yet.')}</p>
                ) : (
                  <ul className="mt-1 space-y-1 text-xs text-slate-300">
                    {[...snap.decisions].reverse().slice(0, 6).map((d) => (
                      <li key={d.id}>
                        <span className="text-slate-100">#{d.id.replace('plan-', '')}</span> {Object.entries(d.choice).map(([k, v]) => `${k} ${v}`).join(', ')} – {d.reason || '—'}
                        <span className="text-slate-500"> → {(en ? d.outcome_en : d.outcome_pl) ?? t('skutek jeszcze nie zmierzony', 'outcome not measured yet')}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="mt-3 rounded-xl border border-dashed border-white/10 p-3 text-xs text-slate-400" data-testid="selfmodel-relations">
              {t('Relacje z ludźmi', 'Relations with people')}:{' '}
              {snap.relations?.available
                ? t(`pamięć relacji jest prowadzona (${snap.relations.source}); treść widzi tylko osoba, której dotyczy.`, `relationship memory is kept (${snap.relations.source}); only the person concerned can see its content.`)
                : t('pamięć relacji jeszcze nie istnieje.', 'relationship memory does not exist yet.')}
            </div>
            <Src v="db" en={en} className="mt-2">
              {t('myc_self_model (zapis tylko właściciel, odczyt publiczny); źródła: myc_lm_curriculum, stały test LM, testy szkolne', 'myc_self_model (owner-only write, public read); sources: myc_lm_curriculum, fixed LM test, school tests')}
            </Src>
          </>
        )}
      </div>
    </Card>
  )
}
