// Pomiar rozmówcy czatu na zestawie rozmów (results/rozmowa/*.json): zachowanie (kategorie) i poprawność rozbioru.
// Uruchom: node scripts/rozmowa-eval.mjs [frozen|dev] [--before] [--out plik.json]
//  --before = stan sprzed zmian: w czacie nie było rozmówcy (brak odpowiedzi, relacji i moderacji), a rozbiór to surowy
//             wynik modelu czytany najprostszym ekstraktorem (korzeń, jego cechy, nsubj, „?”).
import { readFileSync, writeFileSync } from 'node:fs'
import { rozmowaEnv } from './shared/rozmowa-env.mjs'

const args = process.argv.slice(2)
const set = args.find((a) => !a.startsWith('--')) ?? 'dev'
const before = args.includes('--before')
const outI = args.indexOf('--out')
const R = new URL('../../results/rozmowa/', import.meta.url).pathname
const data = JSON.parse(readFileSync(`${R}${set === 'frozen' ? 'frozen-v1' : set === 'dev' ? 'dev-v1' : set}.json`, 'utf8'))
const env = await rozmowaEnv()
const { respond: Rp, relations: Rel, moderation: Mod } = env.mods

const WH = { kto: 'kto', kogo: 'kto', kim: 'kto', komu: 'kto', co: 'co', czego: 'co', gdzie: 'gdzie', jak: 'jak', ile: 'ile', kiedy: 'kiedy', dlaczego: 'dlaczego', czemu: 'dlaczego' }
function naive(text) {
  const t = env.rawParse(text)
  const r = t.find((x) => x.head === 0)
  const isV = r && (r.upos === 'VERB' || r.upos === 'AUX')
  const f = (isV && r.feats) || {}
  const s = t.find((x) => r && x.head === t.indexOf(r) + 1 && x.deprel.startsWith('nsubj'))
  const q0 = t.find((x) => !/^\p{P}+$/u.test(x.form))
  const qtype = q0 && WH[q0.form.toLowerCase()] ? WH[q0.form.toLowerCase()] : /\?\s*$/.test(text) ? 'tak/nie' : null
  return {
    pred: isV ? r.lemma : null, person: f.Person ? Number(f.Person) : null, mood: isV ? (f.Mood === 'Imp' ? 'imp' : 'ind') : null,
    tense: isV && f.Mood !== 'Imp' ? (f.Tense === 'Past' ? 'past' : f.Tense === 'Fut' ? 'fut' : 'pres') : null, qtype,
    addressed: t.some((x) => /^grzybni/i.test(x.form)), subj: s ? (s.upos === 'PRON' || s.upos === 'PROPN' ? s.form.toLowerCase() : s.lemma) : null,
  }
}
const FIELDS = ['pred', 'person', 'mood', 'tense', 'qtype', 'addressed', 'subj']
const norm = (v) => (v === undefined ? null : typeof v === 'string' ? v.toLowerCase() : v)

const rows = []
const t0 = Date.now()
for (const it of data.items) {
  const authors = [...new Set(it.seq.map((s) => s[0]))]
  const handles = [...authors, 'Ola', 'Tomek', 'Kuba', 'Ania']
  const rel = {}
  const win = []
  const mods = []
  const history = []
  let last
  let at = Date.parse('2026-11-01T12:00:00Z')
  for (const [who, text] of it.seq) {
    at += 5000
    const u = env.understand(text, { handles })
    const msg = { id: win.length + 1, author: who, text, at, u }
    win.push(msg)
    const prevRel = rel[who]
    if (!before) {
      mods.push(...Mod.moderate(win, msg))
      rel[who] = Rel.applyRel(rel[who], u, new Date(at).toISOString())
    }
    // pamięć czatu (jak RPC myc_rozmowa_recall): po pseudonimie z podmiotu albo po wspólnych lematach treści
    let recall
    if (u.acts.includes('przypomnienie')) {
      const h = handles.find((x) => x.toLowerCase() === (u.subj ?? '').toLowerCase() || u.toks.some((k) => k.f === x))
      const lem = u.content.filter((c) => !['pisać', 'napisać', 'mówić', 'powiedzieć', 'wspominać'].includes(c))
      recall = history.filter((m) => m.author !== who && (h ? m.author === h : m.u.content.some((c) => lem.includes(c)))).map((m) => ({ handle: m.author, at: new Date(m.at).toISOString(), text: m.text }))
    }
    const reply = before ? undefined : Rp.respond(u, { handle: who, rel: prevRel, recall, rnd: () => 0, now: new Date(at), self: {} }, env.lex)
    history.push(msg)
    last = { u, reply, text }
  }
  const lastMods = mods.filter((m) => m.evidence.includes(win.length) || m.kind === 'mute_auto')
  const rule = last.reply?.rule ?? ''
  const okBy = {
    obecnosc: () => rule.startsWith('obecnosc'),
    cialo: () => rule.startsWith('cialo'),
    o_sobie: () => rule.startsWith('o_mnie'),
    stan: () => rule.startsWith('stan'),
    wtracenie: () => !!last.reply && rule.startsWith('wtracenie'),
    zart: () => rule.startsWith('zart'),
    obraza: () => rule === 'obraza' && (rel[it.seq.at(-1)[0]]?.n_insults ?? 0) === 1,
    przeprosiny: () => rule === 'przeprosiny.zgoda',
    pamiec_obrazy: () => (it.seq.some(([, t]) => /przeprasz|sorry|wybacz/i.test(t)) ? rule === 'relacja.zgoda' : rule === 'relacja.uraza'),
    komplement: () => rule === 'komplement',
    przeklenstwo: () => !last.u.acts.includes('obraza') && !mods.length && rule !== 'obraza',
    nekanie: () => mods.some((m) => m.kind === 'propose') && !mods.some((m) => m.kind === 'mute_auto'),
    zalew: () => mods.some((m) => m.kind === 'mute_auto'),
    przypomnienie: () => rule === 'pamiec.trafienie' && it.seq.slice(0, -1).some(([w, t]) => last.reply.text.includes(w) && last.reply.text.includes(t.slice(0, 20))),
    cisza: () => !last.reply,
  }
  const ok = okBy[it.cat]()
  let parse
  if (it.parse) {
    const got = before ? naive(last.text) : { ...Object.fromEntries(FIELDS.map((f) => [f, last.u[f] ?? null])) }
    parse = Object.fromEntries(FIELDS.map((f) => [f, norm(got[f]) === norm(it.parse[f])]))
    parse._got = got
  }
  rows.push({ id: it.id, cat: it.cat, ok, text: last.text, reply: last.reply ? { text: last.reply.text, rule: last.reply.rule, source: last.reply.source } : null, acts: last.u.acts, why: last.u.why, mods: mods.map((m) => m.kind), parse })
}
const byCat = {}
for (const r of rows) (byCat[r.cat] ??= [0, 0]), byCat[r.cat][1]++, r.ok && byCat[r.cat][0]++
const pf = {}
for (const f of FIELDS) {
  const xs = rows.filter((r) => r.parse)
  pf[f] = [xs.filter((r) => r.parse[f]).length, xs.length]
}
const full = rows.filter((r) => r.parse)
const res = {
  set: data.name, mode: before ? 'before' : 'after', at: new Date().toISOString(), model: env.model, ms: Date.now() - t0,
  behaviour: byCat, total: [rows.filter((r) => r.ok).length, rows.length],
  parse_fields: pf, parse_all_fields: [full.filter((r) => FIELDS.every((f) => r.parse[f])).length, full.length], rows,
}
for (const [c, [a, n]] of Object.entries(byCat)) console.log(`${c.padEnd(15)} ${a}/${n}`)
console.log('RAZEM', res.total.join('/'), '| rozbiór pola:', Object.entries(pf).map(([f, [a, n]]) => `${f} ${a}/${n}`).join(', '), '| wszystkie pola', res.parse_all_fields.join('/'))
if (outI >= 0) writeFileSync(args[outI + 1], JSON.stringify(res, null, 1))
if (args.includes('--v')) for (const r of rows) if (!r.ok || (r.parse && !FIELDS.every((f) => r.parse[f]))) console.log(r.ok ? ' ' : '✗', r.id, r.cat, r.text, '→', r.reply?.rule, '|', r.reply?.text?.slice(0, 70), '| acts', r.acts.join(','), r.parse ? '| zle: ' + FIELDS.filter((f) => !r.parse[f]).map((f) => `${f}=${JSON.stringify(r.parse._got[f])}`).join(' ') : '')
