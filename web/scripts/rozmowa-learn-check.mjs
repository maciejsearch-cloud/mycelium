// Nauka z czatu (web/src/myc/rozmowa/learn.ts): co trafia do programu nauczania mówcy i do Weryfikuj – a co nie
// (osoby, obelgi, oceny, pytania do grzybni o ciało). Uruchom: node scripts/rozmowa-learn-check.mjs
import { rozmowaEnv } from './shared/rozmowa-env.mjs'

const env = await rozmowaEnv()
const L = env.mods.learn
const handles = ['Ola', 'Marek']
const cases = [
  ['Kot jest zwierzęciem.', null, { subj: 'kot', obj: 'zwierzę' }],
  ['Wieloryb to ssak', null, { subj: 'wieloryb', obj: 'ssak' }],
  ['Warszawa jest stolicą Polski', null, { obj: 'stolica Polski' }],
  ['kto to?', { level: 0, text: 'kto to?' }, null],
  ['co dziś robicie?', { level: 1, text: 'co dziś robicie?' }, null],
  ['Ola jest głupia', null, null],
  ['Marek jest idiotą', null, null],
  ['Mój brat jest lekarzem', null, null],
  ['Pomidor jest czerwony', null, null],
  ['Polska nie jest wyspą', null, null],
  ['Grzybnio, srałaś dziś?', null, null],
  ['ty debilu, jesteś głupi?', null, null],
  ['Kasia, idziesz jutro?', null, null],
  ['jaka jest stolica Francji?', null, null],
]
let bad = 0
for (const [t, q, f] of cases) {
  const u = env.understand(t, { handles })
  const gq = L.curriculumQuestion(u)
  const gf = L.factProposal(u, handles)
  const okQ = q === null ? gq === null : gq && gq.level === q.level && gq.text === q.text
  const okF = f === null ? gf === null : gf && Object.entries(f).every(([k, v]) => gf[k] === v)
  if (!okQ || !okF) {
    bad++
    console.log('✗', t, JSON.stringify(gq), JSON.stringify(gf))
  }
}
console.log(`rozmowa-learn-check: ${cases.length - bad}/${cases.length}`)
process.exit(bad ? 1 : 0)
