// Strażnik opisu czystej grzybni: progi pokazane na stronie (myc/czystaZasady.ts) muszą istnieć w kodzie i SQL.
import { readFileSync } from 'node:fs'
const root = new URL('../../', import.meta.url).pathname
const has = (file, re, what) => {
  if (!re.test(readFileSync(root + file, 'utf8'))) {
    console.error(`czysta-check: w ${file} nie ma „${what}” – zaktualizuj web/src/myc/czystaZasady.ts i docs/czysta-grzybnia.md`)
    process.exitCode = 1
  }
}
has('supabase/myc_answers.sql', /nv >= 3 and post >= 0\.95/, 'nv >= 3 and post >= 0.95')
has('supabase/myc_answers.sql', /nv >= 3 and post <= 0\.05/, 'nv >= 3 and post <= 0.05')
has('supabase/myc_answers.sql', /best_w >= ln\(0\.9 \/ 0\.1\)/, 'best_w >= ln(0.9 / 0.1)')
has('supabase/myc_answers.sql', /\(coalesce\(c, 0\) \+ 3\)::real \/ \(coalesce\(n, 0\) \+ 4\), 0\.55\), case when p_agent then 0\.7 else 0\.9/, 'waga głosu (c+3)/(n+4), 0.55–0.9')
has('supabase/myc_speaker.sql', /a\.rated >= 20 and a\.acc >= 0\.7/, 'awans: rated >= 20, acc >= 0.7')
has('supabase/myc_speaker.sql', /n_top >= 2 and n_top \* 3 >= n_tot \* 2/, 'forma wyuczona: ≥ 2 osoby, ≥ 2/3')
has('web/src/myc/consensus.ts', /const GOLD_WEIGHT = 2\b/, 'GOLD_WEIGHT = 2')
// port rozumującego: stałe identyczne z Pythonem
const py = readFileSync(root + 'src/iot_mycelium/rozbior/logika.py', 'utf8')
const tsx = readFileSync(root + 'web/src/myc/czysta.ts', 'utf8')
for (const w of ['nieprawda', 'okazać', 'przerwać', 'wcześnie', 'najwyższy', 'nie wszys', 'niektór', 'żadn']) {
  if (!py.includes(w) || !tsx.includes(w)) {
    console.error(`czysta-check: słowo „${w}” musi być w logika.py i czysta.ts`)
    process.exitCode = 1
  }
}
// szablony pytań o relacje: TS = SQL = Python
{
  const ts = readFileSync(root + 'web/src/myc/czystaRelacje.ts', 'utf8')
  const sql = readFileSync(root + 'supabase/myc_rel.sql', 'utf8')
  const rp = readFileSync(root + 'src/iot_mycelium/mesh/relacje.py', 'utf8')
  const kinds = [...ts.matchAll(/^ {2}(\p{L}+): \{\n {4}label: .*\n {4}question: '([^']+)'/gmu)]
  if (kinds.length !== 6) {
    console.error(`czysta-check: oczekiwano 6 rodzajów relacji w czystaRelacje.ts, jest ${kinds.length}`)
    process.exitCode = 1
  }
  for (const [, k, q] of kinds) {
    const [pre, post] = q.split('{w}')
    if (!sql.includes(`when '${k}' then '${pre}' || p_word || '${post}'`) || !rp.includes(`"${k}": "${q}"`)) {
      console.error(`czysta-check: szablon pytania „${k}” różni się między czystaRelacje.ts, myc_rel.sql i relacje.py`)
      process.exitCode = 1
    }
  }
}
// rozumujący nie wczytuje tabeli relacji z generatora ćwiczeń (to byłoby uczenie pod test)
for (const f of ['web/src/myc/czystaLiczby.ts', 'web/src/myc/czystaWiedza.ts', 'web/src/myc/czystaRelacje.ts']) {
  if (/źrebię|kocię|szczenię|siekiera|nożyczki/.test(readFileSync(root + f, 'utf8'))) {
    console.error(`czysta-check: ${f} zawiera słowa z tabeli relacji ćwiczeń (selfplay.REL)`)
    process.exitCode = 1
  }
}
// pytania o relacje nie używają słownictwa testów analogii: lista z relacje.py w SQL, filtr w propozycjach i w mówcy
{
  const sql = readFileSync(root + 'supabase/myc_rel.sql', 'utf8')
  const banned = readFileSync(root + 'supabase/myc_rel_banned.sql', 'utf8')
  const ts = readFileSync(root + 'web/src/myc/czystaRelacje.ts', 'utf8')
  const words = [...banned.matchAll(/'(\p{L}+)'/gu)].map((m) => m[1])
  for (const w of ['lis', 'nora', 'norze', 'pędzel', 'kopiec']) if (!words.includes(w)) (console.error(`czysta-check: „${w}” brak w myc_rel_banned.sql`), (process.exitCode = 1))
  if ((sql.match(/myc_rel_has_banned\(/g) ?? []).length < 4) (console.error('czysta-check: myc_rel.sql musi filtrować słowa testu w propozycji, mówcy i wycofaniu'), (process.exitCode = 1))
  if (!ts.includes('retired_at=is.null')) (console.error('czysta-check: czystaRelacje.ts musi pomijać wycofane pytania'), (process.exitCode = 1))
  for (const w of words) if (new RegExp(`(?<!\\p{L})${w}(?!\\p{L})`, 'iu').test(ts.replace(/^.*Przykłady celowo.*$/m, '')) && w.length > 3) (console.error(`czysta-check: słowo testu „${w}” w czystaRelacje.ts`), (process.exitCode = 1))
}
if (!process.exitCode) console.log('czysta-check: progi i stałe zgodne z kodem')
