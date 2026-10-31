// Kandydaci programu nauczania mówcy (poziomy L0 i L1) sprawdzeni modelem rozbioru zdań (wariant LFG, GPL-3.0).
// Wylicza wszystkie zestawy słów, które generator w bazie składa losowo (supabase/myc_speaker.sql), parsuje je i zostawia
// tylko te, w których: jeden korzeń, słowo pytające na początku, zaimek-podmiot zgadza się z czasownikiem w osobie
// i liczbie, bez powtórzeń słów, średnia pewność modelu ≥ 0,75. To ocena MODELU (nie ludzi) – w bazie trafia do osobnej
// tabeli, a wpisy z niej mają sposób powstania „rozbiór”; o sensie dalej decydują oceny ludzi.
// Uruchom: node scripts/speaker-candidates.mjs  → supabase/myc_speaker_cands.sql + results/speaker/candidates.json
import ts from 'typescript'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'

const here = new URL('.', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'rb-'))
writeFileSync(join(dir, 'rozbior.mjs'), ts.transpileModule(readFileSync(join(here, '../src/myc/rozbior.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText)
for (const n of ['rozbior', 'morf']) writeFileSync(join(dir, `${n}.mjs`), ts.transpileModule(readFileSync(join(here, `../src/myc/${n}.ts`), 'utf8').replace("from './rozbior'", "from './rozbior.mjs'"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText)
const rb = await import(join(dir, 'rozbior.mjs'))
const { lexAnalyses } = await import(join(dir, 'morf.mjs'))
// leksykon Morfeusza 2 / SGJP z wariantu LFG (ten sam, którego używa przeglądarka)
const lex = JSON.parse(gunzipSync(readFileSync(join(here, '../public/data/rozbior/morf-lfg.json.gz'))).toString())
const PERS = { pri: '1', sec: '2', ter: '3' }
const mdir = join(here, '../public/data/rozbior/models')
const mf = readdirSync(mdir).find((x) => x.startsWith('rb-lfg-'))
const buf = readFileSync(join(mdir, mf))
const M = rb.loadModel(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
const sha = createHash('sha256').update(buf).digest('hex').slice(0, 8)

// te same listy słów co w myc_spk_generate
const PRON = ['ja', 'ty', 'on', 'ona', 'my', 'wy', 'oni', 'to']
const QW0 = ['kto', 'co', 'ile', 'gdzie', 'jak', 'kiedy', 'czy']
const QT = {
  ile: ['ja', 'ty', 'mam', 'masz', 'ma', 'lat', 'dni', 'jest'],
  kto: ['ja', 'ty', 'jest', 'jestem', 'jesteś', 'tam', 'to', 'mówi'],
  gdzie: ['ja', 'ty', 'jestem', 'jesteś', 'mieszkasz', 'mieszkam', 'jest', 'dom'],
  jak: ['ty', 'masz', 'mam', 'na', 'imię', 'się', 'czujesz', 'czuję'],
  co: ['ty', 'ja', 'robisz', 'robię', 'lubisz', 'to', 'jest', 'masz'],
  czy: ['ty', 'ja', 'jesteś', 'jestem', 'lubisz', 'masz', 'tu', 'grzybnia'],
}
const perms = (a, k) => (k === 0 ? [[]] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)], k - 1).map((r) => [x, ...r])))
const cands = []
for (const q of QW0) for (const p of PRON) cands.push({ level: 0, words: [q, p] }, { level: 0, words: [p, q] })
for (const [q, ws] of Object.entries(QT)) for (let k = 1; k <= 3; k++) for (const r of perms(ws, k)) cands.push({ level: 1, words: [q, ...r] }, { level: 1, words: [...r, q] })

const WH = new Set([...QW0])
function judge(words) {
  const text = words.join(' ') + '?'
  const { forms } = rb.tokenize(text, M.wv)
  const t = rb.predict(M, forms, 'lfg', true)
  const roots = t.filter((x) => x.head === 0)
  const why = []
  if (roots.length !== 1) why.push('korzenie')
  if (!WH.has(words[0])) why.push('szyk')
  if (new Set(words).size !== words.length) why.push('powtórzenie')
  for (const s of t.filter((x) => x.deprel === 'nsubj' && x.feats?.Person)) {
    const v = t[s.head - 1]
    if (v?.feats?.VerbForm === 'Fin' && (v.feats.Person !== s.feats.Person || v.feats.Number !== s.feats.Number)) why.push('zgoda')
  }
  // czasownik = rozbiór tak mówi albo słowo ma w leksykonie formę osobową (fin) – model bywa pewny złego tagu w dziwnym szyku
  const finOf = (w) => lexAnalyses(lex, w).filter(([, tag]) => tag.startsWith('fin:'))
  const verbs = t.filter((x) => x.upos === 'VERB' || x.upos === 'AUX' || x.feats?.VerbForm || finOf(x.form).length)
  // osoba/liczba z leksykonu: zaimek osobowy w mianowniku a forma osobowa czasownika
  const fin = verbs.length === 1 ? finOf(verbs[0].form) : []
  for (const x of t) {
    const pr = lexAnalyses(lex, x.form).filter(([, tag]) => /^ppron(12|3):\w+:nom/.test(tag))
    if (!pr.length || !fin.length || x === verbs[0]) continue
    const ok = pr.some(([, a]) => fin.some(([, f]) => a.split(':')[1] === f.split(':')[1] && a.split(':').at(-1) === f.split(':')[2]))
    if (!ok) why.push('zgoda')
  }
  if (verbs.length > 1) why.push('dwa-czasowniki')
  if (words.length >= 3 && verbs.length !== 1) why.push('bez-czasownika')
  // osoba czasownika a wszystkie zaimki osobowe i rzeczowniki w mianowniku (nie tylko oznaczone jako podmiot)
  const v = verbs[0]
  if (v?.feats?.Person)
    for (const x of t)
      if (x !== v && x.feats?.Case === 'Nom' && ((x.upos === 'PRON' && x.feats?.Person) || x.upos === 'NOUN') && ((x.feats.Person ?? '3') !== v.feats.Person || x.feats.Number !== v.feats.Number)) why.push('zgoda')
  // przyimek tuż przed swoim rzeczownikiem; „się” tylko przy czasowniku
  t.forEach((x, i) => {
    if ((x.deprel === 'case' || x.upos === 'ADP') && x.head !== i + 2) why.push('przyimek')
    if (x.form === 'się' && !(t[x.head - 1]?.upos === 'VERB')) why.push('się')
  })
  // reguły z leksykonu (generyczne, bez list zdań):
  const an = t.map((x) => lexAnalyses(lex, x.form).map(([, tag]) => tag))
  // „się” stoi tuż przy czasowniku
  t.forEach((x, i) => { if (x.form === 'się' && !verbs.some((v) => Math.abs(t.indexOf(v) - i) === 1)) why.push('się') })
  // przyimek: następne słowo ma formę w przypadku, którego przyimek wymaga
  t.forEach((x, i) => {
    const cases = an[i].filter((g) => g.startsWith('prep:')).map((g) => g.split(':')[1])
    if (cases.length && !(an[i + 1] || []).some((g) => cases.some((c) => g.split(':').includes(c)))) why.push('przyimek')
  })
  // najwyżej jedno samodzielne rzeczowne (rzeczownik bez przyimka lub zaimek osobowy w mianowniku)
  const nomi = t.filter((x, i) => !(an[i - 1] || []).some((g) => g.startsWith('prep:')) && an[i].length && (an[i].every((g) => g.startsWith('subst:')) || an[i].some((g) => /^ppron(12|3):\w+:nom/.test(g))))
  if (nomi.length > 1) why.push('dwa-rzeczowniki')
  const conf = t.reduce((a, x) => a + (x.p ?? 0), 0) / t.length
  if (conf < 0.75) why.push('pewność')
  return { text, ok: why.length === 0, why: [...new Set(why)], conf: Math.round(conf * 1000) / 1000, root: roots[0]?.form }
}
const res = cands.map((c) => ({ level: c.level, ...judge(c.words) }))
const ok = res.filter((r) => r.ok)
const stat = (lv) => {
  const a = res.filter((r) => r.level === lv)
  const reasons = {}
  for (const r of a) for (const w of r.why) reasons[w] = (reasons[w] ?? 0) + 1
  return { all: a.length, ok: a.filter((r) => r.ok).length, reasons }
}
const summary = { model: mf, sha, at: new Date().toISOString(), L0: stat(0), L1: stat(1) }
console.log(JSON.stringify(summary))
mkdirSync(join(here, '../../results/speaker'), { recursive: true })
writeFileSync(join(here, '../../results/speaker/candidates.json'), JSON.stringify({ summary, ok, sample_rejected: res.filter((r) => !r.ok).slice(0, 60) }, null, 1))
const esc = (s) => s.replace(/'/g, "''")
const sql = [
  `-- Wygenerowane: node web/scripts/speaker-candidates.mjs (model rozbioru ${mf}, GPL-3.0). Nie edytować ręcznie.`,
  `delete from public.myc_speaker_cands where model <> '${sha}';`,
  `insert into public.myc_speaker_cands (level, text, conf, model) values`,
  ok.map((r) => `(${r.level}, '${esc(r.text)}', ${r.conf}, '${sha}')`).join(',\n') + `\non conflict (level, text) do update set conf = excluded.conf, model = excluded.model;`,
].join('\n')
writeFileSync(join(here, '../../supabase/myc_speaker_cands_data.sql'), sql + '\n')
