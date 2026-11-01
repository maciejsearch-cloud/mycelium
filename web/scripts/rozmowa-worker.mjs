// Proces rozmówcy grzybni (czat globalny): co 2 s pobiera nowe wiadomości ludzi (RPC myc_rozmowa_pending), rozumie je
// (model rozbioru LFG + Morfeusz 2 + Słowosieć emo), wybiera odpowiedź regułami (web/src/myc/rozmowa), liczy relację
// i moderację zalewu, a wynik zapisuje RPC myc_rozmowa_submit (baza pilnuje limitów wtrąceń i zgody na naukę).
// Klucz rozmówcy: plik z MYC_ROZMOWA_KEY_FILE (domyślnie /workspace/projects/myc-nodes/rozmowa.key), nigdy w logu.
// Uruchom: node scripts/rozmowa-worker.mjs [--once]
import { readFileSync } from 'node:fs'
import { rozmowaEnv } from './shared/rozmowa-env.mjs'

const SB_URL = 'https://agortpieeygmcttjwjfx.supabase.co'
const SB_KEY = 'sb_publishable_O6NCXONs9ZOb13j_od4mnw_KqJlH98P' // klucz publiczny (ten sam co w web/src/myc/store.ts)
const KEY = readFileSync(process.env.MYC_ROZMOWA_KEY_FILE ?? '/workspace/projects/myc-nodes/rozmowa.key', 'utf8').trim()
const VERSION = 'rozmowa-worker-2'
const once = process.argv.includes('--once')
const log = (...a) => console.log(new Date().toISOString(), ...a)

async function rpc(fn, body) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

const env = await rozmowaEnv()
const { respond: Rp, relations: Rel, moderation: Mod, learn: Ln } = env.mods
log('start', VERSION, 'model', env.model.file, 'emo', env.lex.emo.meta.n)
const win = [] // okno moderacji (ostatnie 24 h)
const SAY = new Set(['pisać', 'napisać', 'mówić', 'powiedzieć', 'wspominać', 'wspomnieć', 'gadać'])

function compact(u) {
  const { text: _t, ...rest } = u
  return { v: 1, model: env.model.file, ...rest, toks: u.toks.slice(0, 40) }
}

async function handle(m, ctx) {
  const t0 = Date.now()
  const handles = [...new Set(ctx.recent.filter((x) => x.kind === 'user').map((x) => x.handle))]
  const u = env.understand(m.body, { handles, replyToAi: m.reply_to_ai })
  let recall
  if (u.acts.includes('przypomnienie')) {
    const h = handles.find((x) => x.toLowerCase() === (u.subj ?? '').toLowerCase() || u.toks.some((k) => k.f.toLowerCase() === x.toLowerCase()))
    const lem = u.content.filter((c) => !SAY.has(c) && !handles.some((x) => x.toLowerCase() === c.toLowerCase()))
    recall = (h || lem.length) ? await rpc('myc_rozmowa_recall', { p_key: KEY, p_handle: h ?? null, p_lemmas: h ? null : lem, p_before: m.id, p_limit: 3 }) : []
  }
  const relPrev = m.train_ok ? m.rel ?? undefined : undefined
  const relNew = m.train_ok ? Rel.applyRel(relPrev, u, m.at) : null
  const reply = ctx.cfg.enabled ? Rp.respond(u, { handle: m.handle, rel: relPrev, optedOut: !m.train_ok, self: ctx.self, recall, pairs: ctx.pairs, replyToAi: m.reply_to_ai }, env.lex) : undefined
  const mm = { id: m.id, author: m.author, text: m.body, at: Date.parse(m.at), u }
  win.push(mm)
  while (win.length && Date.now() - win[0].at > 24 * 3600e3) win.shift()
  const mods = Mod.moderate(win, mm, { ...Mod.MOD_DEFAULT, muteMin: ctx.cfg.mute_flood_min })
  const res = await rpc('myc_rozmowa_submit', {
    p_key: KEY, p_msg: m.id, p_parse: compact(u), p_rel: relNew, p_events: Rel.relEvents(u).filter((e) => e !== 'rozmowa'),
    p_reply: reply ?? null, p_mod: mods,
  })
  // nauka z czatu: tylko za zgodą (baza sprawdza ją ponownie); błąd nauki nie blokuje rozmowy
  let learned = '-'
  if (m.train_ok) {
    const q = Ln.curriculumQuestion(u)
    const fact = Ln.factProposal(u, handles)
    if (q || fact) learned = JSON.stringify(await rpc('myc_rozmowa_learn', { p_key: KEY, p_msg: m.id, p_q: q ? { ...q, conf: u.conf } : null, p_fact: fact }).catch((e) => ({ error: String(e.message).slice(0, 80) })))
  }
  log('msg', m.id, `learn=${learned}`, `acts=${u.acts.join(',') || '-'}`, `rule=${reply?.rule ?? '-'}`, `mods=${mods.map((x) => x.kind).join(',') || '-'}`, `parse_ms=${Date.now() - t0}`, JSON.stringify(res))
}

async function maybeInvite(p) {
  const c = p.cfg
  if (!c.enabled) return
  const lu = p.last_user_at ? Date.parse(p.last_user_at) : 0
  const li = c.last_invite_at ? Date.parse(c.last_invite_at) : 0
  if (!lu || Date.now() - lu < c.invite_quiet_min * 60e3 || Date.now() - li < c.invite_every_min * 60e3) return
  const lem = {}
  for (const x of p.recent.filter((r) => r.kind === 'user').slice(-15)) for (const l of env.understand(x.body ?? '').content) lem[l] = (lem[l] ?? 0) + 1
  const topics = Object.entries(lem).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 3)
  const r = await rpc('myc_rozmowa_invite', { p_key: KEY, p_reply: Rp.invite(topics) })
  log('invite', JSON.stringify(r))
}

let delay = 2000
for (;;) {
  try {
    const p = await rpc('myc_rozmowa_pending', { p_key: KEY, p_version: VERSION, p_limit: 20 })
    for (const m of p.msgs) {
      try {
        await handle(m, p)
      } catch (e) {
        log('błąd wiadomości', m.id, String(e.message ?? e))
        await rpc('myc_rozmowa_submit', { p_key: KEY, p_msg: m.id, p_parse: null }).catch(() => {})
      }
    }
    if (!p.msgs.length) await maybeInvite(p)
    delay = 2000
  } catch (e) {
    log('błąd', String(e.message ?? e))
    delay = Math.min(delay * 2, 60000)
  }
  if (once) break
  await new Promise((r) => setTimeout(r, delay))
}
