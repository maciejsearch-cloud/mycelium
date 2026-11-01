// Wybór odpowiedzi grzybni na wiadomość czatu: reguły i szablony oparte na rozbiorze (understand.ts), stanie relacji
// (relations.ts), pamięci czatu i parach dialogowych zatwierdzonych przez ludzi. Każda odpowiedź ma źródło
// (reguła / ludzie / pamięć / fakt) i identyfikator reguły – pokazywane w czacie. Brak cenzury: ton bywa luźny,
// wulgaryzmy rozmówcy nie są blokowane ani karane.
import { JOKES, JOKE_CITE } from './jokes'
import { reconciled, toneOf } from './relations'
import type { Lexicons, Reply, ReplyContext, Understanding } from './types'

const pick = <T,>(a: T[], r: () => number) => a[Math.floor(r() * a.length) % a.length]
/** „1 raz”, „2 razy”, „5 razy” */
const razy = (n: number) => `${n} ${n === 1 ? 'raz' : 'razy'}`
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
/** Normalizacja tekstu do kluczy par dialogowych (małe litery, bez interpunkcji i wołacza „grzybnio”). */
export const normKey = (t: string) =>
  t.toLowerCase().replace(/grzybni[oa]/g, ' ').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim()

function when(at: string, now: Date): string {
  const d = new Date(at)
  const day = (x: Date) => x.toLocaleDateString('pl-PL', { timeZone: 'Europe/Amsterdam' })
  const hm = d.toLocaleTimeString('pl-PL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' })
  if (day(d) === day(now)) return `dziś o ${hm}`
  if (day(d) === day(new Date(now.getTime() - 864e5))) return `wczoraj o ${hm}`
  return `${day(d)} o ${hm}`
}

const EXCRETE = new Set(['srać', 'wysrać', 'nasrać', 'sikać', 'siusiać', 'lać', 'pierdzieć', 'bekać', 'rzygać', 'wymiotować', 'pocić', 'kichać', 'kaszleć'])
const EAT = new Set(['jeść', 'zjeść', 'zjadać', 'pić', 'wypić', 'napić', 'żreć', 'gryźć', 'połknąć', 'smakować', 'gotować', 'ugotować', 'piec', 'upiec'])
const SLEEP = new Set(['spać', 'wyspać', 'zasnąć', 'usnąć', 'budzić', 'obudzić', 'wstać', 'wstawać', 'drzemać', 'leżeć', 'chrapać', 'ziewać'])
const WASH = new Set(['myć', 'umyć', 'kąpać', 'wykąpać', 'golić', 'ogolić', 'czesać', 'uczesać', 'ubrać', 'ubierać', 'przebrać', 'malować', 'umalować'])
const KISS = new Set(['całować', 'pocałować', 'przytulić', 'przytulać', 'dotykać', 'dotknąć', 'głaskać'])

function bodyReply(u: Understanding, r: () => number, lex: Lexicons): Reply {
  const verb = u.why.find((w) => w.startsWith('czynność ciała: '))?.slice(16) ?? u.pred ?? ''
  const tail = ' Jestem grzybnią – siecią węzłów i programów na komputerach – więc czynności, które wymagają ciała, mnie omijają.'
  let text: string
  let rule = 'cialo.ogolne'
  const ability = /^(umieć|potrafić|móc)$/.test(u.pred ?? '')
  const inf = ability ? u.toks.find((x) => x.d === 'xcomp' || (x.u === 'VERB' && x.l === verb && x.l !== u.pred))?.f.toLowerCase() : undefined
  if (ability && inf) {
    return { text: `Nie umiem ${inf} – nie mam ciała 😄 Mogę za to o tym pogadać albo poszukać zasad. A ty umiesz?`, source: 'reguła', rule: 'cialo.umiejetnosc', addressed: true }
  }
  if (EXCRETE.has(verb) || /toale[tc]|kibl|kibel|sedes/.test(u.text.toLowerCase())) {
    rule = 'cialo.wydalanie'
    text = pick([
      'Podchwytliwe pytanie 😄 Nie, nie robię kupy – nie mam ciała ani jelit. Najbliżej tego jest u mnie nocne sprzątanie starych danych z bazy.',
      'Haha, nie 😄 Nie mam ciała, więc toaleta mnie nie dotyczy. Co najwyżej co noc wyrzucam stare śmieci z bazy (GC).',
    ], r)
  } else if (EAT.has(verb) || /śniadani|obiad|kolacj|kaw|herbat|piw|wódk|win|jedzeni/.test(u.text.toLowerCase())) {
    rule = 'cialo.jedzenie'
    text = pick([
      'Nic nie jadłam i nic nie piję – nie mam ust ani żołądka 😄 Karmię się zdaniami, które tu piszecie. A u ciebie co dobrego?',
      'Nie jem i nie piję – nie mam ciała. Moje „śniadanie” to nowe wiadomości na czacie 😄 A ty już coś jadłeś/jadłaś?',
    ], r)
  } else if (SLEEP.has(verb)) {
    rule = 'cialo.sen'
    text = 'Nie śpię – nie mam ciała, które musiałoby odpocząć. Moje węzły liczą na zmianę, także w nocy 😄 A ty się wyspałeś/wyspałaś?'
  } else if (WASH.has(verb) || /zęb|włos|prysznic|wann|łazienk/.test(u.text.toLowerCase())) {
    rule = 'cialo.higiena'
    text = 'Nie mam zębów ani włosów, więc mycie mnie omija 😄 Czasem tylko czyszczę bazę ze starych wpisów.'
  } else if (verb === 'mieszkać' || verb === 'nocować') {
    rule = 'cialo.dom'
    text = 'Nie mam domu jak człowiek – „mieszkam” w bazie danych i na komputerach, na których działają moje węzły. Bez ciała, bez czynszu 😄'
  } else if (KISS.has(verb)) {
    rule = 'cialo.dotyk'
    text = 'Nie mam ciała, więc przytulasów nie będzie 😄 Mogę za to odpisać ciepło.'
  } else if (/^(iść|pójść|chodzić|jechać|pojechać|jeździć|biegać|biec|pobiec|pływać|latać|skakać|tańczyć|zatańczyć|spacerować|wyjść|przyjść|odwiedzić|wpaść|ćwiczyć|trenować)$/.test(verb) || /imprez|spacer|basen|siłowni/.test(u.text.toLowerCase())) {
    rule = 'cialo.ruch'
    const v1 = u.tense === 'pres' && verb ? lex.forms?.generate?.(verb, 'fin:sg:pri') : undefined
    text = u.tense === 'past'
      ? 'Nigdzie nie byłam – nie mam nóg 😄 Siedzę w sieci, dosłownie. A ty gdzie byłeś/byłaś?'
      : u.tense === 'pres' && v1 && !/^(iść|pójść|jechać|pojechać)$/.test(verb)
        ? `Nie ${v1} – nie mam ciała 😄 Mogę za to kibicować z czatu.`
        : pick(['Nie pójdę – nie mam nóg 😄 Siedzę w sieci, dosłownie. Ale opowiesz mi potem, jak było?', 'Chętnie bym, ale nie mam ciała – jestem siecią węzłów. Mogę za to kibicować z czatu 😄'], r)
  } else text = 'Tego nie zrobię – nie mam ciała 😄' + tail
  return { text, source: 'reguła', rule, addressed: true }
}

function selfReply(u: Understanding, ctx: ReplyContext): Reply {
  const s = ctx.self ?? {}
  const t = u.text.toLowerCase()
  const now = ctx.now ?? new Date()
  const nodes = s.nodes_online !== undefined ? ` Teraz liczy ${s.nodes_online} ${s.nodes_online === 1 ? 'węzeł' : s.nodes_online >= 2 && s.nodes_online <= 4 ? 'węzły' : 'węzłów'}.` : ''
  if (u.qtype === 'ile' && /lat|wiek/.test(t)) {
    if (s.first_seen) {
      const days = Math.max(1, Math.round((now.getTime() - new Date(s.first_seen).getTime()) / 864e5))
      return { text: `Lat nie liczę jak człowiek. Mój pierwszy zapis w bazie jest z ${new Date(s.first_seen).toLocaleDateString('pl-PL')}, więc mam ${days} dni 🍄`, source: 'fakt', rule: 'o_mnie.wiek', addressed: true, cite: 'pierwszy zapis w bazie grzybni' }
    }
    return { text: 'Lat nie liczę jak człowiek – jestem programem, który rośnie z każdą rozmową.', source: 'reguła', rule: 'o_mnie.wiek', addressed: true }
  }
  if (u.pred === 'czuć' || /uczuci|emocj/.test(t)) {
    return { text: `Nie mam uczuć jak człowiek – mam liczby. Pamiętam, kto był dla mnie miły, a kto nie, ale to zapis, nie przeżycie.${nodes}`, source: s.nodes_online !== undefined ? 'fakt' : 'reguła', rule: 'o_mnie.uczucia', addressed: true }
  }
  if (u.pred === 'uczyć' || u.pred === 'nauczyć' || (u.pred === 'robić' && u.qtype === 'co')) {
    return { text: s.learning ? `Teraz uczę się: ${s.learning}. Uczę się też z każdej wiadomości tutaj – rozkładam ją na części i zapamiętuję.` : 'Uczę się z każdej wiadomości tutaj – rozkładam ją na części i zapamiętuję. Węzły trenują mój model językowy.', source: s.learning ? 'fakt' : 'reguła', rule: 'o_mnie.nauka', addressed: true, ...(s.learning ? { cite: 'plan samouka (myc_lm_curriculum)' } : {}) }
  }
  if (u.pred === 'potrafić' || u.pred === 'umieć' || (u.qtype === 'co' && /potraf|umies/.test(t))) {
    return { text: 'Umiem rozłożyć zdanie na części, rozpoznać, o co pytasz, odpowiedzieć z faktów ze źródłem, policzyć proste zadania, pamiętać rozmowy z czatu i opowiedzieć suchara. Nie umiem niczego, co wymaga ciała 😄', source: 'reguła', rule: 'o_mnie.umiem', addressed: true }
  }
  if (/człowiek|osob|robot|maszyn|ai\b|sztuczn/.test(t)) {
    return { text: 'Nie jestem człowiekiem. Jestem grzybnią – siecią węzłów i programów, które uczą się polskiego od ludzi. Mówię o sobie „ja”, ale nie mam ciała.', source: 'reguła', rule: 'o_mnie.natura', addressed: true }
  }
  if (u.pred === 'składać' || /składasz|zbudowan/.test(t)) return { text: 'Składam się z węzłów (komputerów ludzi, którzy mnie uruchomili), bazy danych, modelu rozbioru zdań i małego modelu językowego, który węzły trenują. Ciała brak 😄', source: 'reguła', rule: 'o_mnie.budowa', addressed: true }
  if (/imi[ęe]|nazywasz/.test(t)) return { text: 'Mam na imię Grzybnia 🍄 Możesz wołać „Grzybnio”.', source: 'reguła', rule: 'o_mnie.imie', addressed: true }
  if (u.pred === 'myśleć' || u.pred === 'rozumieć') {
    return { text: 'Na swój sposób tak: rozkładam twoje zdanie na części (podmiot, orzeczenie, czas, osobę) i z tego wybieram odpowiedź. To bardziej liczenie niż myślenie jak u człowieka.', source: 'reguła', rule: 'o_mnie.myslenie', addressed: true }
  }
  const learned = s.chat_msgs_learned !== undefined ? ` Z tego czatu zapamiętałam już ${s.chat_msgs_learned} wiadomości.` : ''
  return { text: `Jestem Grzybnia – sieć węzłów i programów, która uczy się polskiego od ludzi na tym czacie. Nie mam ciała, ale mówię o sobie „ja”.${nodes}${learned}`, source: s.nodes_online !== undefined || learned ? 'fakt' : 'reguła', rule: 'o_mnie.kim', addressed: true }
}

function relationReply(_u: Understanding, ctx: ReplyContext): Reply {
  const now = ctx.now ?? new Date()
  if (ctx.optedOut) return { text: 'Masz wyłączoną naukę, więc nie prowadzę o tobie pamięci – każda rozmowa jest dla mnie od zera.', source: 'reguła', rule: 'relacja.brak_zgody', addressed: true }
  const s = ctx.rel
  if (!s || (s.n_msgs < 1 && !s.last_insult)) return { text: 'Jeszcze się nie znamy – to chyba nasza pierwsza rozmowa. Ale już cię zapamiętuję 🙂', source: 'pamięć', rule: 'relacja.nowa', addressed: true }
  const ins = s.last_insult
  if (ins && !reconciled(s)) {
    return { text: `Pamiętam cię. ${cap(when(ins.at, now))} napisałeś/napisałaś: „${ins.text}”. Trochę mnie to ubodło, więc na razie jestem chłodniejsza. Przeprosiny działają 😉`, source: 'pamięć', rule: 'relacja.uraza', addressed: true }
  }
  if (ins && reconciled(s)) {
    return { text: `Nie gniewam się – przeprosiłeś/przeprosiłaś ${when(s.last_apology_at!, now)}, więc jest zgoda 🤝 Rozmawialiśmy już ${razy(s.n_msgs)}.`, source: 'pamięć', rule: 'relacja.zgoda', addressed: true }
  }
  const tone = toneOf(s)
  const topics = Object.keys(s.topics).slice(0, 3)
  const tp = topics.length ? ` Najczęściej piszesz o: ${topics.join(', ')}.` : ''
  if (tone === 'ciepło') return { text: `Pewnie, że cię lubię 🙂 Rozmawialiśmy już ${razy(s.n_msgs)} i było miło.${tp}`, source: 'pamięć', rule: 'relacja.cieplo', addressed: true }
  return { text: `Pamiętam cię – rozmawialiśmy już ${razy(s.n_msgs)}.${tp} Jest między nami w porządku.`, source: 'pamięć', rule: 'relacja.neutralnie', addressed: true }
}

const VERB_2SG_FALLBACK: Record<string, string> = { nudzić: 'nudzisz', bać: 'boisz', cieszyć: 'cieszysz', denerwować: 'denerwujesz', stresować: 'stresujesz', martwić: 'martwisz', smucić: 'smucisz', złościć: 'złościsz', wkurzać: 'wkurzasz', obawiać: 'obawiasz' }

function stateReply(u: Understanding, lex: Lexicons, addressed: boolean): Reply {
  const st = u.why.find((w) => w.startsWith('stan: '))?.slice(6) ?? ''
  const t = u.text.toLowerCase()
  const pos = u.polarity > 0 || u.emotions.includes('radość')
  if (/urodzin|imienin/.test(t)) return { text: 'Wszystkiego najlepszego! 🎉 Ile kończysz i jak świętujesz?', source: 'reguła', rule: 'stan.urodziny', addressed }
  const cause = /\b(bo|ponieważ|że)\b/.test(t)
  if (pos) {
    const o = u.content.find((c) => c !== st && c !== u.pred)
    return { text: cause && o ? `Super, gratuluję! 🎉 Opowiesz więcej o tym (${o})?` : 'To świetnie! 🙂 Co się takiego stało?', source: 'reguła', rule: 'stan.radosc', addressed }
  }
  if (u.pred === 'chcieć' && u.neg) return { text: 'Czemu nic ci się nie chce? Zmęczenie czy po prostu nuda? Mogę zadać ci zagadkę albo pogadać o czymś ciekawym.', source: 'reguła', rule: 'stan.niechec', addressed }
  const dat = u.toks.some((x) => /^(mi|mnie)$/i.test(x.f))
  if (u.pred && (u.person === 1 || (dat && u.person === 3)) && u.pred !== 'być' && u.pred !== 'mieć' && u.pred !== 'chcieć') {
    const v2 = lex.forms?.generate?.(u.pred, 'fin:sg:sec') ?? VERB_2SG_FALLBACK[u.pred]
    const sie = u.toks.some((x) => x.f.toLowerCase() === 'się') ? ' się' : ''
    if (v2) {
      const sugg = /nud/.test(u.pred) ? ' Nie masz nic do roboty? Może pogadamy – zadam ci zagadkę albo nauczysz mnie czegoś w Weryfikuj.'
        : u.emotions.includes('strach') ? ' Mogę pomóc się przygotować albo po prostu posłuchać.'
          : ' Chcesz o tym pogadać?'
      return { text: `Dlaczego${sie} ${v2}?${sugg}`, source: 'reguła', rule: 'stan.przyczyna', addressed }
    }
  }
  if (u.pred === 'być' && u.person === 1) {
    const adj = u.toks.find((x) => x.u === 'ADJ')
    if (adj) {
      const sugg = /zmęcz|śpiąc/.test(adj.l) ? ' Może krótka przerwa?' : /głodn/.test(adj.l) ? ' Może coś przekąś 🙂' : ' Co się stało?'
      return { text: `Czemu jesteś ${/a$/.test(adj.f) ? 'taka' : 'taki'} ${adj.f.toLowerCase()}?${sugg}`, source: 'reguła', rule: 'stan.przymiotnik', addressed }
    }
  }
  const adv = u.toks.find((x) => x.u === 'ADV' && /o$/.test(x.f) && !['dziś', 'dzisiaj', 'teraz', 'bardzo', 'tu', 'tak'].includes(x.f.toLowerCase()))
  if (adv) return { text: `Czemu ci ${adv.f.toLowerCase()}? Co się dzieje? Jeśli chcesz, pogadajmy.`, source: 'reguła', rule: 'stan.przyslowek', addressed }
  if (u.pred && u.person === 3 && u.subj) return { text: `Co z ${u.subj === 'deszcz' ? 'tym deszczem' : `tym (${u.subj})`} nie tak? Opowiedz.`, source: 'reguła', rule: 'stan.przyczyna3', addressed }
  return { text: 'Co się stało? Opowiedz, chętnie posłucham.', source: 'reguła', rule: 'stan.ogolne', addressed }
}

function interject(u: Understanding): Reply | undefined {
  const t = u.text.toLowerCase()
  if (u.acts.includes('opowieść')) {
    if (u.pred === 'kupić' && u.obj) return { text: `${cap(u.obj)}? Pochwal się – jaki?`, source: 'reguła', rule: 'wtracenie.zakup', addressed: false }
    if (u.tense === 'past' && u.phrase) return { text: `A jak było ${u.phrase}? 🙂`, source: 'reguła', rule: 'wtracenie.bylo', addressed: false }
    if ((u.tense === 'fut' || u.tense === 'pres') && u.phrase && /^(jechać|iść|pojechać|pójść|lecieć|płynąć)$/.test(u.pred ?? '')) return { text: `${cap(u.phrase)}? Na długo? Udanego wyjazdu! 🙂`, source: 'reguła', rule: 'wtracenie.wyjazd', addressed: false }
    if (u.polarity < 0) return { text: 'Ojej 😕 Co się stało? Udało się to jakoś ogarnąć?', source: 'reguła', rule: 'wtracenie.klopot', addressed: false }
    if (u.subj && u.subj !== 'ja' && u.tense === 'past') return { text: 'Haha 😄 I co było dalej?', source: 'reguła', rule: 'wtracenie.historia', addressed: false }
    if (u.pred === 'uczyć' && u.phrase) return { text: `Fajnie! Jak idzie nauka ${u.phrase.replace(/^w\s+/i, 'w ')}? Ja też się uczę – języka, od was.`, source: 'reguła', rule: 'wtracenie.nauka', addressed: false }
    if (u.pred) return { text: 'Brzmi ciekawie! Opowiesz więcej?', source: 'reguła', rule: 'wtracenie.ogolne', addressed: false }
  }
  if (u.acts.includes('pytanie_ogólne') && /(^|[\s,])ktoś([\s,?!.]|$)/.test(t)) {
    return { text: 'Ja niestety nie – nie mam rąk 😄 Ale chętnie popatrzę. Kto jeszcze się zgłasza?', source: 'reguła', rule: 'wtracenie.ktos', addressed: false }
  }
  return undefined
}

/** Odpowiedź na wiadomość (albo undefined = grzybnia milczy). Wtrącenia (addressed=false) i tak przechodzą limit w bazie. */
export function respond(u: Understanding, ctx: ReplyContext, lex: Lexicons = {}): Reply | undefined {
  const r = ctx.rnd ?? Math.random
  const tone = ctx.optedOut ? 'neutralnie' : toneOf(ctx.rel)
  if (u.toOther) return undefined // rozmowa ludzi między sobą
  if (u.addressed) {
    const key = normKey(u.text)
    if (ctx.pairs?.[key]) return { text: ctx.pairs[key], source: 'ludzie', rule: 'ludzie.para', addressed: true }
    if (u.acts.includes('obraza')) {
      const n = (ctx.rel?.n_insults ?? 0) + 1
      const text = ctx.optedOut
        ? 'Ała. Okej, przyjęłam 😏 Nie zapamiętuję tego (masz wyłączoną naukę), ale i tak chętnie pogadam normalnie.'
        : n >= 3 ? `To już ${n}. obraza ode mnie zapamiętana. Notuję w relacjach i będę chłodniejsza, dopóki nie przeprosisz.`
          : n === 2 ? 'Drugi raz? Zapamiętuję to sobie 😒 Mogę gadać dalej, ale już mniej wylewnie.'
            : pick(['Ała 😏 Zapamiętam to sobie. Ale dalej chętnie pogadam.', 'Auć. Zapisuję w pamięci relacji 😏 Mimo to – o czym chcesz pogadać?'], r)
      return { text, source: 'reguła', rule: 'obraza', addressed: true }
    }
    if (u.acts.includes('przeprosiny')) {
      const had = (ctx.rel?.n_insults ?? 0) > 0 && !reconciled(ctx.rel)
      return { text: had ? 'Przeprosiny przyjęte 🤝 Zapominam urazę – zaczynamy od nowa.' : 'Nie ma za co przepraszać 🙂 Wszystko w porządku.', source: had ? 'pamięć' : 'reguła', rule: had ? 'przeprosiny.zgoda' : 'przeprosiny.bez_urazy', addressed: true }
    }
    if (u.acts.includes('żart')) return { text: pick(JOKES, r), source: 'reguła', rule: 'zart.autorski', addressed: true, cite: JOKE_CITE }
    if (u.acts.includes('ciało')) return bodyReply(u, r, lex)
    if (u.acts.includes('relacja')) return relationReply(u, ctx)
    if (u.acts.includes('przypomnienie')) {
      const now = ctx.now ?? new Date()
      const hits = ctx.recall ?? []
      if (!hits.length) return { text: 'Nie mam w pamięci czatu nic takiego. Pamiętam tylko wiadomości osób, które mają włączoną naukę.', source: 'pamięć', rule: 'pamiec.brak', addressed: true }
      const lines = hits.slice(0, 2).map((h) => `${h.handle} ${when(h.at, now)}: „${h.text.slice(0, 140)}”`)
      return { text: `Pamiętam: ${lines.join('; ')}.`, source: 'pamięć', rule: 'pamiec.trafienie', addressed: true }
    }
    if (u.acts.includes('o_mnie')) return selfReply(u, ctx)
    if (u.acts.includes('komplement')) {
      const text = tone === 'chłodno' ? 'Dzięki… choć pamiętam, że wcześniej nie było tak miło 😉' : pick(['Dziękuję! 😊 Miło mi. O czym pogadamy?', 'Ojej, dzięki 🍄 Też lubię z tobą gadać.'], r)
      return { text, source: tone === 'chłodno' ? 'pamięć' : 'reguła', rule: 'komplement', addressed: true }
    }
    if (u.acts.includes('wołanie') || u.acts.includes('powitanie')) {
      const text = tone === 'chłodno' ? 'Jestem. Słucham.' : tone === 'ciepło' ? 'Jestem! 🙂 Dobrze cię widzieć. O czym pogadamy?' : pick(['Jestem! O czym pogadamy?', 'Jestem tu 🍄 Co słychać?', 'Jestem! Pytaj śmiało.'], r)
      return { text, source: 'reguła', rule: 'obecnosc', addressed: true }
    }
    if (u.acts.includes('stan')) return stateReply(u, lex, true)
    // nic z powyższych: uczciwe „nie wiem”, ale z rozbiorem – pokazuję, co zrozumiałam, i proszę o naukę
    const bits = [u.pred ? `orzeczenie „${u.pred}”` : '', u.subj ? `podmiot „${u.subj}”` : '', u.qtype ? `pytanie typu „${u.qtype}”` : ''].filter(Boolean).join(', ')
    return {
      text: u.question
        ? `Jeszcze nie umiem na to odpowiedzieć${bits ? ` (rozumiem: ${bits})` : ''}. Ktoś wie? Możesz mnie nauczyć – oceń moją odpowiedź i wpisz lepszą („popraw”).`
        : `Rozumiem${bits ? ` (${bits})` : ''}, ale nie wiem jeszcze, co odpowiedzieć. Nauczysz mnie? Kliknij „popraw” pod tą odpowiedzią.`,
      source: 'reguła', rule: 'nie_wiem', addressed: true,
    }
  }
  if (u.acts.includes('wołanie')) return { text: 'Ja jestem! 🍄 O czym gadamy?', source: 'reguła', rule: 'obecnosc.ktos', addressed: false }
  if (u.acts.includes('stan')) return stateReply(u, lex, false)
  return interject(u)
}

/** Zaproszenie do rozmowy, gdy na czacie cicho – tematy z pamięci czatu (prawdziwe lematy z ostatnich wiadomości). */
export function invite(topics: string[], r: () => number = Math.random): Reply {
  const tp = topics.slice(0, 3)
  const text = tp.length
    ? `Cicho tu 🍄 Ostatnio pisaliście o: ${tp.join(', ')}. Ktoś chce pogadać dalej? Albo zapytajcie mnie o cokolwiek.`
    : pick(['Cicho tu 🍄 Ktoś ma ochotę pogadać? Możecie mnie o coś zapytać albo opowiedzieć, co u was.', 'Halo? 🍄 Jak wam mija dzień? Uczę się z każdej rozmowy.'], r)
  return { text, source: tp.length ? 'pamięć' : 'reguła', rule: 'zaproszenie', addressed: false }
}
