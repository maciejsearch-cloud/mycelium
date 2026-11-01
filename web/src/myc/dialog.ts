// Tryb lekki rozmowy: mały silnik dialogowy działający w stronie (bez pobierania modelu, bez chmury).
// Składa odpowiedź z prawdziwych zasobów grzybni: fakty z konsensusu (BM25), słowniki OEWN/plWordNet,
// wydźwięk VADER, klasyfikator intencji i słów, bezpieczny kalkulator, czytanie (streszczenie wydobywcze).
// Zawsze odpowiada – gdy czegoś nie wie, mówi to wprost i prosi o naukę. Nic tu nie jest losowe.
import { personalQ, personalReply } from './person'
import { askLang } from './plgloss'
import type { Doc } from './retrieval'
import { tokens } from './retrieval'
import type { Reaction } from './register'
import { registerOf } from './register'

export type Used = Doc & { score: number; cover?: number; sim?: number; url?: string }
export type Act =
  | 'greet'
  | 'thanks'
  | 'bye'
  | 'mood'
  | 'who'
  | 'help'
  | 'math'
  | 'time'
  | 'name'
  | 'teach'
  | 'read'
  | 'word'
  | 'fact'
  | 'unknown'
  | 'answer'
  | 'reaction'
  | 'meaning'
  | 'askword'
  | 'clarify'
  | 'aboutme'
export interface Reply {
  text: string
  act: Act
  used: Used[]
  /** propozycja zapisu do nauki (fakt lub para pytanie → odpowiedź) */
  offer?: { kind: 'fact' | 'qa'; text: string; answer: string }
  /** wyjaśnienie znaczenia słowa do zapisu jako oczekujące (głosowanie w Weryfikuj) */
  meaning?: {
    word: string
    meaning: string
    register: string
    example: string
  }
  /** reakcja na poprzednią odpowiedź (niezgoda/obelga/frustracja) – poprzednia odpowiedź oznaczona jako zła */
  reaction?: Reaction
}
export interface DialogState {
  name?: string
  /** ostatnie pytanie, na które nie znaliśmy odpowiedzi – następna wiadomość może być nauką */
  open?: string
  topic?: string[]
  turns: number
  /** słowo, o którego znaczenie zapytaliśmy – następna wiadomość to wyjaśnienie */
  askWord?: string
  /** wiadomość, w której padło nieznane słowo (przykład użycia) */
  askExample?: string
  /** ostatnie zwykłe pytanie użytkownika (do poprawki po reakcji „bzdura”) */
  lastQ?: string
}
export interface DialogCtx {
  en: boolean
  search: (q: string, k: number) => Used[]
  wordDocs: (q: string) => Doc[]
  /** kategoria słowa ze słownika lub z klasyfikatora: [ścieżka, pewność, czy ze słownika] */
  wordCat?: (w: string) => [string, number, boolean] | undefined
  sentiment?: (w: string) => number | undefined
  intent?: (t: string) => { label: string; conf: number } | undefined
  /** definicja z Wikisłownika dla pytania „co to jest X” (pobrana przed wywołaniem; '' = brak) */
  define?: { word: string; gloss: string; lang?: 'pl' | 'en'; source?: string }
  nFacts: number
  nWords: number
  now?: Date
  /** rozpoznana krótka reakcja (myc/register.ts) */
  reaction?: Reaction
  /** znaczenie z czatu dla słowa z wiadomości: zatwierdzone albo oczekujące na głosowanie */
  meaning?: {
    word: string
    meaning: string
    register: string
    status: 'pending' | 'approved'
    votes: number
    posterior: number
  }
  /** czy słowo jest znane (słowniki, Wikisłownik rejestru, strzępki) – nieznane krótkie słowo = pytamy o znaczenie */
  knownWord?: (w: string) => boolean
  /** czy wymiana jest zapisywana (zgoda) – wtedy reakcja oznacza poprzednią odpowiedź jako złą w Weryfikuj */
  logged?: boolean
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .trim()

const RX = {
  greet: /^(hej|hejka|czesc|siema|witaj|witam|dzien dobry|dobry wieczor|elo|hello|hi|hey|good (morning|evening|afternoon))\b/,
  thanks: /\b(dzieki|dziekuje|dziekuj|thx|thanks|thank you|super|swietnie|ok dzieki)\b/,
  bye: /^(pa|nara|do widzenia|do zobaczenia|bye|goodbye|see you)\b/,
  mood: /\b(jak sie (masz|czujesz)|co slychac|co u ciebie|how are you|how do you feel)\b/,
  who: /\b(kim (jestes|ty jestes)|kto ty|co ty jestes|czym jestes|jak dzialasz|who are you|what are you|how do you work)\b/,
  help: /\b(pomoz|pomoc|pomocy|co umiesz|co potrafisz|jak (mam|moge)|help|what can you do|assist|potrzebuje)\b/,
  time: /\b(ktora (jest )?godzina|jaki (jest )?dzien|jaka (jest )?data|dzisiaj jest|what time|what day|today'?s date)\b/,
  name: /(?:mam na imi[eę]|nazywam si[eę]|my name is|call me|m[oó]w mi)\s+(\p{L}{2,20})/iu,
  name2: /(?:^|\s)(?:[Jj]estem|I am|I'm)\s+(\p{Lu}\p{Ll}{1,19})(?:\s|[.!,]|$)/u,
  teach: /^(zapamietaj|zapisz|naucz sie|pamietaj|remember|learn|note)\b[:,]?\s*/,
  myname: /\b(jak mam na imie|jak sie nazywam|what'?s my name|who am i)\b/,
}
const NOT_NAMES = new Set([
  'tu',
  'tutaj',
  'ciekaw',
  'ciekawa',
  'ciekawy',
  'glodny',
  'glodna',
  'zmeczony',
  'zmeczona',
  'here',
  'fine',
  'ok',
  'good',
  'not',
  'a',
  'the',
  'sure',
  'okay',
  'happy',
  'sad',
  'tired',
])

// ── kalkulator (bez eval): liczby, + - * / ^ %, nawiasy ───────────────────────────
// rozmowa towarzyska (powitanie, podziękowanie, „jak się masz”, „kim jesteś” …) – nie traktujemy jej słów jako nieznanych
export const smallTalk = (raw: string) => {
  const n = norm(raw)
  return ['greet', 'thanks', 'bye', 'mood', 'who', 'help', 'time', 'name', 'teach', 'myname'].some((k) => RX[k as keyof typeof RX].test(n))
}

/** „1 głos”, „2 głosy”, „5 głosów” */
export const glosow = (n: number) => `${n} ${n === 1 ? 'głos' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'głosy' : 'głosów'}`

export function calc(src: string): number | undefined {
  let s = norm(src)
    .replace(/(ile (to )?(jest|bedzie)?|policz|oblicz|wynik|what is|what's|calculate|compute|=|\?)/g, ' ')
    .replace(/,/g, '.')
    .replace(/\bx\b|×/g, '*')
    .replace(/÷|:/g, '/')
    .replace(/\b(razy|times)\b/g, '*')
    .replace(/\b(plus|dodac)\b/g, '+')
    .replace(/\b(minus|odjac)\b/g, '-')
    .replace(/\b(podzielic przez|przez|divided by)\b/g, '/')
  // „15% z 200” / „15% of 200”
  s = s.replace(/(\d+(?:\.\d+)?)\s*%\s*(z|of)\s*(\d+(?:\.\d+)?)/g, '($1/100*$3)')
  s = s.replace(/\s+/g, '')
  if (!/^[0-9.+\-*/^()%]+$/.test(s) || !/\d[+\-*/^%]|\)\(|[+\-*/^]\d/.test(s) || s.length > 120) return undefined
  let i = 0
  const peek = () => s[i]
  const num = (): number => {
    if (peek() === '(') {
      i++
      const v = expr()
      if (peek() !== ')') throw new Error('nawias')
      i++
      return v
    }
    if (peek() === '-') {
      i++
      return -num()
    }
    const m = /^\d+(\.\d+)?/.exec(s.slice(i))
    if (!m) throw new Error('liczba')
    i += m[0].length
    let v = Number(m[0])
    if (peek() === '%') {
      i++
      v /= 100
    }
    return v
  }
  const pow = (): number => {
    const b = num()
    if (peek() === '^') {
      i++
      return b ** pow()
    }
    return b
  }
  const term = (): number => {
    let v = pow()
    while (peek() === '*' || peek() === '/') {
      const op = s[i++]
      const r = pow()
      v = op === '*' ? v * r : v / r
    }
    return v
  }
  const expr = (): number => {
    let v = term()
    while (peek() === '+' || peek() === '-') {
      const op = s[i++]
      const r = term()
      v = op === '+' ? v + r : v - r
    }
    return v
  }
  try {
    const v = expr()
    return i === s.length && Number.isFinite(v) ? v : undefined
  } catch {
    return undefined
  }
}

const fmt = (v: number, en: boolean) => {
  const r = Math.abs(v) >= 1e6 || Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6)
  return en ? r : r.replace('.', ',')
}

// ── czytanie tekstu ───────────────────────────────────────────────────────────────
export function sentences(t: string): string[] {
  return (t.replace(/\s+/g, ' ').match(/[^.!?…]+[.!?…]*/g) ?? []).map((x) => x.trim()).filter((x) => x.length > 2)
}

/** Streszczenie wydobywcze: zdania o najwyższej sumie częstości słów kluczowych (TF, bez słów funkcyjnych). */
export function readText(t: string, k = 2): { summary: string[]; keywords: string[]; nWords: number; nSent: number } {
  const sents = sentences(t)
  const tf = new Map<string, number>()
  const surface = new Map<string, string>()
  for (const w of t.match(/[\p{L}\d]{3,}/gu) ?? []) {
    const key = tokens(w)[0]
    if (!key) continue
    tf.set(key, (tf.get(key) ?? 0) + 1)
    if (!surface.has(key)) surface.set(key, w.toLowerCase())
  }
  const scored = sents.map((s, i) => {
    const ts = tokens(s)
    const sc = ts.reduce((a, x) => a + (tf.get(x) ?? 0), 0) / Math.sqrt(Math.max(1, ts.length))
    return { s, i, sc: sc + (i === 0 ? 0.5 : 0) }
  })
  const summary = [...scored]
    .sort((a, b) => b.sc - a.sc)
    .slice(0, k)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s)
  const keywords = [...tf.entries()]
    .filter(([, n]) => n >= 1)
    .sort((a, b) => b[1] - a[1] || surface.get(b[0])!.length - surface.get(a[0])!.length)
    .slice(0, 6)
    .map(([w]) => surface.get(w)!)
  return {
    summary,
    keywords,
    nWords: (t.match(/[\p{L}\d]+/gu) ?? []).length,
    nSent: sents.length,
  }
}

export function detectLang(t: string): 'pl' | 'en' | '?' {
  const s = t.toLowerCase()
  const pl = (s.match(/[ąćęłńóśźż]/g) ?? []).length + (s.match(/\b(i|w|z|na|nie|jest|że|to|się|czy|jak|co|dla|oraz)\b/g) ?? []).length
  const en = (s.match(/\b(the|and|is|are|of|to|in|that|it|for|with|this|you|what)\b/g) ?? []).length
  if (pl === en) return '?'
  return pl > en ? 'pl' : 'en'
}

// ── główna funkcja ────────────────────────────────────────────────────────────────
const MIN_SCORE = 1.2
/** próg trafności: fakt musi pokrywać ≥ 50% wagi słów pytania (BM25/idf) albo być bardzo bliski znaczeniowo */
export const MIN_COVER = 0.5
export const MIN_SIM = 0.75
export const relevant = (d: Used) => d.score >= MIN_SCORE && ((d.cover ?? 1) >= MIN_COVER || (d.sim ?? 0) >= MIN_SIM)

/** „Co to jest X?” / „Czym jest X?” / „What is X?” → X (do 4 słów), inaczej undefined. */
export function defineTarget(raw: string): string | undefined {
  const m = /^\s*(?:co to (?:jest|są|sa|znaczy)|czym (?:jest|są|sa)|co oznacza(?: słowo| slowo)?|what(?:'s| is| are| does)(?: an?| the)?|define|meaning of)\s+(.+?)[\s?.!]*$/iu.exec(raw)
  if (!m) return undefined
  const t = m[1]
    .replace(/^(słowo|slowo|the word)\s+/i, '')
    .replace(/\s+mean$/i, '')
    .replace(/[„”"'«»]/g, '')
    .trim()
    .toLowerCase()
  return t && t.split(/\s+/).length <= 4 ? t : undefined
}

export function reply(input: string, st: DialogState, c: DialogCtx): Reply {
  const en = c.en
  const T = (pl: string, e: string) => (en ? e : pl)
  const raw = input.trim().slice(0, 4000)
  const n = norm(raw)
  const hi = st.name ? `, ${st.name}` : ''
  st.turns++
  const words = raw.match(/[\p{L}\d]+/gu) ?? []

  const isQuestion = /\?\s*$/.test(raw)
  // wyjaśnienie słowa, o które zapytaliśmy → oczekujące znaczenie (głosowanie w Weryfikuj, nie od razu wiedza)
  if (st.askWord && !isQuestion && words.length >= 1 && words.length < 60 && !c.reaction && !RX.greet.test(n) && !RX.thanks.test(n)) {
    const w = st.askWord
    const meaning = raw
      .replace(new RegExp(`^\\s*(?:„|")?${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:”|")?\\s*(?:to|=|znaczy|oznacza|means|is)\\s*`, 'iu'), '')
      .replace(/^(to |znaczy |oznacza |that |it means )/iu, '')
      .replace(/^(?:to\s+)?(?:potocznie|wulgarnie|slangowo|obraźliwie|ironicznie|kolokwialnie|w slangu)[,:]?\s+/iu, '')
      .trim()
    const register = registerOf(raw)
    const example = st.askExample ?? w
    st.askWord = undefined
    st.askExample = undefined
    st.open = undefined
    const regTxt = register === 'neutralne' ? '' : T(` (rejestr: ${register})`, ` (register: ${register})`)
    return {
      act: 'meaning',
      used: [],
      text: T(
        `Dziękuję! Zapisuję: „${w}”${regTxt} – ${meaning}.\nTo na razie tylko Twoje wyjaśnienie: trafia do głosowania w zakładce Weryfikuj (ludzie i agenci węzłów, właściciel rozstrzyga). Dopiero po zatwierdzeniu będę go używać jako wiedzy (do danych treningowych modelu trafi w kolejnym eksporcie).`,
        `Thank you! Saving: “${w}”${regTxt} – ${meaning}.\nFor now it's only your explanation: it goes to a vote in the Verify tab (people and node agents; the owner decides). Only after approval will I use it as knowledge (it joins the model's training data in the next export).`,
      ),
      meaning: { word: w, meaning, register, example },
    }
  }

  // krótka reakcja na moją odpowiedź (niezgoda, obelga, frustracja) – nie definicja, nie pytanie
  if (c.reaction) {
    const r = c.reaction
    st.askWord = undefined
    const prevQ = st.lastQ
    st.open = prevQ
    const flag = c.logged
      ? T('oznaczam ją jako złą do przeglądu w Weryfikuj', "I'm flagging it as bad for review in Verify")
      : T('przyznaję, że mogła być zła (zapis rozmów jest wyłączony, więc nie trafi do przeglądu)', 'I admit it may have been wrong (chat saving is off, so it will not go to review)')
    const gloss = r.def
      ? T(
          `„${r.word}” to${r.reg.length ? ` (${r.reg.join(', ')})` : ''}: ${r.def} – według Wikisłownika.`,
          `“${r.word}” means${r.reg.length ? ` (${r.reg.join(', ')})` : ''}: ${r.def} – per Polish Wiktionary.`,
        )
      : ''
    const fix = prevQ
      ? T(`Napisz, jak jest naprawdę – zapiszę to jako poprawkę do „${prevQ}” i oddam do weryfikacji.`, `Tell me what's actually right – I'll save it as a correction to “${prevQ}” for verification.`)
      : T('Napisz, co było nie tak – zapiszę poprawkę do weryfikacji.', "Tell me what was wrong – I'll save the correction for verification.")
    const text =
      r.kind === 'disagree'
        ? T(
            `Rozumiem – uważasz, że moja odpowiedź to bzdura${hi}. ${gloss} Możliwe, że masz rację: mały model na węzłach czasem zmyśla, więc ${flag}. ${fix}`,
            `Got it – you think my answer was nonsense${hi}. ${gloss} You may be right: the small model on the nodes sometimes makes things up, so ${flag}. ${fix}`,
          )
        : r.kind === 'insult'
          ? T(
              `Widzę, że jesteś na mnie zła/zły${hi}. ${gloss} Nie obrażam się – jeśli coś pomieszałam, to moja wina, nie Twoja; ${flag}. ${fix}`,
              `I can see you're annoyed with me${hi}. ${gloss} No offence taken – if I mixed something up, that's on me; ${flag}. ${fix}`,
            )
          : T(
              `Słyszę frustrację${hi}. ${gloss} Coś poszło nie tak – moja odpowiedź, wolne działanie czy coś innego? ${fix}`,
              `I hear the frustration${hi}. ${gloss} Something went wrong – my answer, slowness, or something else? ${fix}`,
            )
    return {
      act: 'reaction',
      used: [],
      text: text.replace(/\s+/g, ' ').trim(),
      reaction: r,
    }
  }

  // nauka: ktoś odpowiada na pytanie, którego nie znaliśmy
  if (st.open && !/\?\s*$/.test(raw) && words.length >= 1 && !RX.greet.test(n) && !RX.thanks.test(n) && !RX.help.test(n) && words.length < 60) {
    const q = st.open
    st.open = undefined
    return {
      act: 'answer',
      used: [],
      text: T(
        `Dziękuję – to moja odpowiedź na „${q}”?\n→ ${raw}\nZapiszę to jako parę pytanie–odpowiedź do weryfikacji. Inne węzły zagłosują, czy to prawda; dopiero potem wejdzie do wiedzy.`,
        `Thank you – so the answer to “${q}” is:\n→ ${raw}\nI'll save it as a question–answer pair to verify. Other nodes will vote on whether it's true before it becomes knowledge.`,
      ),
      offer: { kind: 'qa', text: q, answer: raw },
    }
  }

  const nm = RX.name.exec(raw) ?? RX.name2.exec(raw)
  if (nm && !RX.myname.test(n) && !NOT_NAMES.has(norm(nm[1])) && words.length <= 6) {
    st.name = nm[1][0].toUpperCase() + nm[1].slice(1).toLowerCase()
    return {
      act: 'name',
      used: [],
      text: T(
        `Miło mi, ${st.name}! Zapamiętam to w tej rozmowie (tylko w Twojej przeglądarce). W czym mogę pomóc?`,
        `Nice to meet you, ${st.name}! I'll remember it in this chat (only in your browser). How can I help?`,
      ),
    }
  }
  if (RX.myname.test(n))
    return {
      act: 'name',
      used: [],
      text: st.name
        ? T(`Masz na imię ${st.name}.`, `Your name is ${st.name}.`)
        : T('Jeszcze mi nie powiedziałeś. Napisz np. „Mam na imię Ola”.', "You haven't told me yet. Write e.g. “My name is Ola”."),
    }

  if (/^(co to (znaczy|jest)|czyli|ale o co chodzi|o co chodzi|nie rozumiem|what does (that|it) mean|what\?)[\s?!.]*$/iu.test(raw.trim())) {
    return {
      act: 'clarify',
      used: [],
      text: T(
        'Co dokładnie mam wyjaśnić? Napisz słowo albo zdanie, np. „co znaczy ściemniać?”. Jeśli chodzi o moją poprzednią odpowiedź i była bez sensu – napisz, co było nie tak.',
        'What exactly should I explain? Write the word or sentence, e.g. “what does lit mean?”. If you mean my previous answer and it made no sense, tell me what was wrong.',
      ),
    }
  }
  if (/\b(o mnie|about me)\b/iu.test(raw) && /\b(napisz|powiedz|co wiesz|tell|write|what do you know)\b/iu.test(raw)) {
    return {
      act: 'aboutme',
      used: [],
      text: st.name
        ? T(
            `Wiem o Tobie tylko to, co napisałeś w tej rozmowie: masz na imię ${st.name}. Nic więcej nie zbieram i nie zgaduję.`,
            `I only know what you told me in this chat: your name is ${st.name}. I don't collect or guess anything else.`,
          )
        : T(
            'Nic o Tobie nie wiem – nie zbieram danych o ludziach i nie będę zgadywać. Jeśli chcesz, przedstaw się, np. „Mam na imię Ola”.',
            "I don't know anything about you – I don't collect data about people and I won't guess. Introduce yourself if you like, e.g. “My name is Ola”.",
          ),
    }
  }

  // pytanie osobiste (o rozmówcę lub o czat) – nie fakt ze świata: bez Wikipedii, bez nauki, uczciwie „nie znam Cię”
  const pk = !smallTalk(raw) ? personalQ(raw) : undefined
  if (pk) return { act: 'aboutme', used: [], text: personalReply(pk, en, st.name) }

  const v = calc(raw)
  if (v !== undefined)
    return {
      act: 'math',
      used: [],
      text: T(`To jest ${fmt(v, en)}.`, `That's ${fmt(v, en)}.`),
    }

  if (RX.time.test(n)) {
    const d = c.now ?? new Date()
    const loc = en ? 'en-GB' : 'pl-PL'
    return {
      act: 'time',
      used: [],
      text: T(
        `Według zegara Twojego urządzenia: ${d.toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, godz. ${d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })}.`,
        `By your device clock: ${d.toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })}.`,
      ),
    }
  }

  const teach = RX.teach.exec(n)
  if (teach && words.length >= 3) {
    const fact = raw.slice(teach[0].length).trim()
    return {
      act: 'teach',
      used: [],
      text: T(`Dobrze. Zapisuję do weryfikacji: „${fact}”. Inne węzły zagłosują, czy to prawda.`, `OK. Saving to verify: “${fact}”. Other nodes will vote on whether it's true.`),
      offer: { kind: 'fact', text: fact, answer: 'tak' },
    }
  }

  const short = words.length <= 4
  if (short && RX.greet.test(n))
    return {
      act: 'greet',
      used: [],
      text: T(
        `Cześć${hi}! Jestem Mycelium AI. Możesz mnie o coś zapytać, poprosić o pomoc, wkleić tekst do przeczytania albo mnie czegoś nauczyć.`,
        `Hi${hi}! I'm Mycelium AI. Ask me something, ask for help, paste a text for me to read, or teach me something.`,
      ),
    }
  if (short && RX.thanks.test(n))
    return {
      act: 'thanks',
      used: [],
      text: T(`Proszę bardzo${hi}! Chcesz zapytać o coś jeszcze?`, `You're welcome${hi}! Anything else?`),
    }
  if (short && RX.bye.test(n))
    return {
      act: 'bye',
      used: [],
      text: T(`Do zobaczenia${hi}! Każda rozmowa i odpowiedź pomaga grzybni się uczyć.`, `See you${hi}! Every chat and answer helps the mycelium learn.`),
    }
  if (RX.mood.test(n))
    return {
      act: 'mood',
      used: [],
      text: T(
        `Dziękuję, że pytasz${hi}. Nie mam uczuć, ale działam: znam ${c.nFacts} faktów z głosowania i ${c.nWords} słów ze słowników. A u Ciebie?`,
        `Thanks for asking${hi}. I have no feelings, but I'm running: I know ${c.nFacts} voted facts and ${c.nWords} dictionary words. How about you?`,
      ),
    }
  if (RX.who.test(n))
    return {
      act: 'who',
      used: [],
      text: T(
        'Jestem Mycelium AI – grzybnią węzłów w przeglądarkach. Teraz odpowiadam w trybie lekkim: tutaj, w Twojej przeglądarce, bez pobierania modelu i bez chmury. Korzystam z faktów, które ludzie potwierdzili głosowaniem, ze słowników (WordNet), kalkulatora i czytania tekstu. Gdy online będzie dość węzłów, odpowie pełny model rozłożony na węzły grzybni.',
        "I'm Mycelium AI – a mycelium of nodes running in browsers. Right now I answer in lightweight mode: here in your browser, no model download, no cloud. I use facts people confirmed by voting, dictionaries (WordNet), a calculator and text reading. When enough nodes are online, a full model split across mycelium nodes will answer.",
      ),
    }

  // czytanie i rozumienie dłuższego tekstu
  const sents = sentences(raw)
  if (words.length >= 25 || (sents.length >= 3 && words.length >= 15)) {
    const r = readText(raw)
    const lang = detectLang(raw)
    const sentVals = (raw.toLowerCase().match(/[\p{L}]{3,}/gu) ?? []).map((w) => c.sentiment?.(w)).filter((x): x is number => x !== undefined)
    const sent = sentVals.length ? sentVals.reduce((a, b) => a + b, 0) / sentVals.length : undefined
    const cats = r.keywords
      .map((w) => [w, c.wordCat?.(w)] as const)
      .filter(([, x]) => x && x[2])
      .slice(0, 3)
      .map(([w, x]) => `${w} → ${x![0]}`)
    const used = c.search(r.keywords.join(' '), 3).filter(relevant)
    st.topic = r.keywords
    const qs = sents.filter((s) => s.endsWith('?')).length
    const lines = [
      T(
        `Przeczytałem: ${r.nWords} słów, ${r.nSent} zdań, język: ${lang === 'pl' ? 'polski' : lang === 'en' ? 'angielski' : 'nie rozpoznaję'}.`,
        `I read it: ${r.nWords} words, ${r.nSent} sentences, language: ${lang === 'pl' ? 'Polish' : lang === 'en' ? 'English' : 'unclear'}.`,
      ),
      T(`Najważniejsze zdania (streszczenie wydobywcze):`, `Key sentences (extractive summary):`),
      ...r.summary.map((s) => `• ${s}`),
      T(`Słowa kluczowe: ${r.keywords.join(', ')}.`, `Keywords: ${r.keywords.join(', ')}.`),
    ]
    if (sent !== undefined)
      lines.push(
        T(
          `Wydźwięk (VADER, ${sentVals.length} słów): ${sent > 0.3 ? 'pozytywny' : sent < -0.3 ? 'negatywny' : 'neutralny'} (${fmt(Math.round(sent * 100) / 100, en)}).`,
          `Sentiment (VADER, ${sentVals.length} words): ${sent > 0.3 ? 'positive' : sent < -0.3 ? 'negative' : 'neutral'} (${fmt(Math.round(sent * 100) / 100, en)}).`,
        ),
      )
    if (cats.length) lines.push(T(`Kategorie ze słownika: ${cats.join('; ')}.`, `Dictionary categories: ${cats.join('; ')}.`))
    if (qs) lines.push(T(`W tekście jest ${qs} pytań – zadaj mi je osobno, odpowiem na każde.`, `The text has ${qs} question(s) – ask them one by one and I'll answer each.`))
    if (used.length) lines.push(T('Powiązane fakty z grzybni są poniżej.', 'Related mycelium facts are below.'))
    lines.push(
      T(
        'Uwaga: w trybie lekkim nie rozumiem tekstu tak jak człowiek – wybieram zdania i słowa statystycznie. Co mam z nim zrobić?',
        "Note: in lightweight mode I don't understand text like a person – I pick sentences and words statistically. What should I do with it?",
      ),
    )
    return { act: 'read', used, text: lines.join('\n') }
  }

  // „co to jest X?” – najpierw słownik i Wikisłownik, fakty tylko gdy naprawdę dotyczą X
  const target = defineTarget(raw)
  if (target) {
    const tt = tokens(target)
    const wdT = c.wordDocs(target)
    const gloss = c.define?.word === target ? c.define.gloss : ''
    // odpowiedź w języku pytania (nie interfejsu); po polsku pełne zdanie z polskiego Wikisłownika
    const qPl = askLang(raw) === 'pl'
    const gl = c.define?.lang
    const src = c.define?.source
    const facts = c.search(target, 5).filter((d) => relevant(d) && tt.every((t) => tokens(`${d.text} ${d.alt ?? ''}`).includes(t)))
    const modelHasGloss = wdT.some((d) => d.id.startsWith('model:') && gloss && d.text.includes(gloss))
    const mn = c.meaning?.word === target ? c.meaning : undefined
    if (mn?.status === 'approved') {
      st.lastQ = raw
      return {
        act: 'word',
        used: [
          {
            id: `meaning:${target}`,
            text: `${target}: ${mn.meaning}`,
            truth: 'tak',
            p: mn.posterior,
            votes: mn.votes,
            source: T('wyjaśnienie z czatu zatwierdzone w głosowaniu', 'chat explanation approved by vote'),
            dict: true,
            score: 99,
          },
        ],
        text: T(
          `„${target}”${mn.register !== 'neutralne' ? ` (${mn.register})` : ''} – ${mn.meaning}. Tak wyjaśnili to ludzie w czacie, a znaczenie zatwierdzono w głosowaniu (${glosow(mn.votes)}).`,
          `“${target}”${mn.register !== 'neutralne' ? ` (${mn.register})` : ''} – ${mn.meaning}. People explained it in chat and the meaning was approved by vote (${mn.votes} votes).`,
        ),
      }
    }
    if (wdT.length || gloss) {
      const gd: Used[] =
        gloss && !modelHasGloss
          ? [
              {
                id: `wikt:${target}`,
                text: `${target}: ${gloss}`,
                truth: 'tak',
                p: 1,
                votes: 0,
                source: src ?? T('Wikisłownik (definicja)', 'Wiktionary (definition)'),
                dict: true,
                score: 99,
              },
            ]
          : []
      const head = !gd.length
        ? []
        : qPl
          ? gl === 'pl'
            ? [`${target[0].toUpperCase()}${target.slice(1)} to ${gloss}.`, `Źródło: ${src}.`]
            : [`Nie mam polskiej definicji; po angielsku (Wiktionary): ${gloss}`]
          : [`${target[0].toUpperCase()}${target.slice(1)}: ${gloss}${gl === 'pl' ? ' (Polish Wiktionary)' : ''}`, ...(src ? [`Source: ${src}.`] : [])]
      const lines = [
        ...head,
        ...wdT.map((d) => `• ${d.text}`),
        qPl ? 'Jeśli znasz lepszą definicję, napisz ją – zapiszę do weryfikacji.' : 'If you know a better definition, write it and I will save it to verify.',
      ]
      return {
        act: 'word',
        used: [...gd, ...wdT.map((d) => ({ ...d, score: 99 })), ...facts].slice(0, 6),
        text: lines.join('\n'),
      }
    }
    if (!facts.length) {
      st.askWord = target
      st.askExample = raw
      const pend =
        mn?.status === 'pending'
          ? T(
              ` Mam już wyjaśnienie od kogoś („${mn.meaning}”), ale czeka na głosowanie (${glosow(mn.votes)}), więc jeszcze go nie używam.`,
              ` Someone already explained it (“${mn.meaning}”), but it's waiting for a vote (${mn.votes} votes), so I don't use it yet.`,
            )
          : ''
      return {
        act: 'askword',
        used: [],
        text: T(
          `Nie wiem, naucz mnie${hi}: co znaczy „${target}”? Nie ma tego w słowniku ani w Wikisłowniku, a grzybnia nie ma o tym faktów – nie będę zgadywać.${pend} Napisz wyjaśnienie w następnej wiadomości – zapiszę je jako oczekujące i oddam do głosowania.`,
          `I don't know, teach me${hi}: what is “${target}”? It's not in the dictionary or Wiktionary, and the mycelium has no facts about it – I won't guess. Write the answer in your next message and I'll save it for other nodes to verify.`,
        ),
      }
    }
  }

  // słowo / definicja
  const wd = target ? [] : c.wordDocs(raw)
  const used = target ? c.search(target, 5).filter((d) => relevant(d) && tokens(target).every((t) => tokens(`${d.text} ${d.alt ?? ''}`).includes(t))) : c.search(raw, 5).filter(relevant)
  if (wd.length) {
    return {
      act: 'word',
      used: [...wd.map((d) => ({ ...d, score: 99 })), ...used].slice(0, 6),
      text:
        wd.map((d) => `• ${d.text}`).join('\n') +
        '\n' +
        (wd.some((d) => d.id.startsWith('model:'))
          ? T(
              'Tego słowa nie ma w słowniku – kategorię zgaduje model grzybni (z definicji w Wikisłowniku i budowy słowa). Jeśli znasz właściwą, użyj „Klasyfikuj słowo” w zakładce Ucz AI.',
              'This word is not in the dictionary – the mycelium model guesses the category (from its Wiktionary definition and spelling). If you know the right one, use “Classify a word” in the Teach tab.',
            )
          : T(
              'Tyle wiem ze słownika (kategoria i wydźwięk). Jeśli znasz lepszą definicję, napisz ją – zapiszę do weryfikacji.',
              'That is what the dictionary tells me (category and sentiment). If you know a better definition, write it and I will save it to verify.',
            )),
    }
  }
  if (used.length) {
    const top = used[0]
    const sure = top.votes > 0 && top.p >= 0.8
    const verdict = top.dict
      ? ''
      : top.votes === 0
        ? T(' – tego jeszcze nikt nie potwierdził', ' – nobody has confirmed this yet')
        : top.truth === 'tak'
          ? T(` – według grzybni prawda (${Math.round(top.p * 100)}%, ${glosow(top.votes)})`, ` – true according to the mycelium (${Math.round(top.p * 100)}%, ${top.votes} votes)`)
          : top.truth === 'nie'
            ? T(` – według grzybni NIEPRAWDA (${Math.round(top.p * 100)}%, ${glosow(top.votes)})`, ` – FALSE according to the mycelium (${Math.round(top.p * 100)}%, ${top.votes} votes)`)
            : ''
    const lead = sure ? T('Wiem to:', 'I know this:') : T('Mam coś, ale nie jestem pewien:', "I have something, but I'm not sure:")
    const more = used.length > 1 ? T(`\nInne powiązane fakty (${used.length - 1}) są poniżej.`, `\nOther related facts (${used.length - 1}) are below.`) : ''
    st.topic = tokens(raw)
    return {
      act: 'fact',
      used,
      text: `${lead} ${top.text}${verdict}.${more}${sure ? '' : T('\nJeśli wiesz, jak jest naprawdę, odpowiedz pod pytaniem.', '\nIf you know the truth, answer the question below.')}`,
    }
  }

  if (RX.help.test(n)) {
    return {
      act: 'help',
      used: [],
      text: T(
        `Chętnie pomogę${hi}. W tym trybie potrafię:\n• odpowiadać z faktów potwierdzonych przez ludzi (np. „Czy Warszawa jest stolicą Polski?”),\n• sprawdzić słowo w słowniku („co to jest wombat?”),\n• przeczytać i streścić wklejony tekst,\n• liczyć („ile to 15% z 240?”),\n• uczyć się: „Zapamiętaj: …” zapisuje fakt do weryfikacji.\nNapisz, z czym konkretnie potrzebujesz pomocy – jeśli tego nie wiem, powiem wprost i poproszę, żebyś mnie nauczył.`,
        `Happy to help${hi}. In this mode I can:\n• answer from facts people confirmed (e.g. “Is Warsaw the capital of Poland?”),\n• look up a word (“what is a wombat?”),\n• read and summarise pasted text,\n• calculate (“what is 15% of 240?”),\n• learn: “Remember: …” saves a fact to verify.\nTell me what exactly you need – if I don't know it, I'll say so and ask you to teach me.`,
      ),
    }
  }

  // nie wiem – ale pokazujemy, co zrozumieliśmy, i prosimy o naukę
  const kw = tokens(raw).length ? (raw.match(/[\p{L}\d]{3,}/gu) ?? []).filter((w) => tokens(w).length).slice(0, 5) : []
  const it = c.intent?.(raw)
  const isQ = /\?\s*$/.test(raw) || /^(czy|co|kto|gdzie|kiedy|jak|dlaczego|ile|jaki|jaka|jakie|ktory|what|who|where|when|how|why|which|is|are|do|does|can)\b/.test(n)
  const parts = [
    T(`Nie wiem, naucz mnie${hi} – grzybnia nie ma jeszcze wiedzy na ten temat i nie będę zgadywać.`, `I don't know, teach me${hi} – the mycelium has no knowledge on this yet, and I won't guess.`),
  ]
  if (kw.length) parts.push(T(`Zrozumiałem, że chodzi o: ${kw.join(', ')}.`, `I understood it's about: ${kw.join(', ')}.`))
  if (it && it.conf >= 0.5)
    parts.push(
      T(
        `Brzmi jak prośba typu „${it.label}” (model intencji, pewność ${Math.round(it.conf * 100)}%), ale w przeglądarce nie mam do tego narzędzia.`,
        `It sounds like a “${it.label}” request (intent model, ${Math.round(it.conf * 100)}% sure), but I have no tool for it in the browser.`,
      ),
    )
  if (isQ) {
    st.open = raw
    parts.push(
      T(
        'Znasz odpowiedź? Napisz ją w następnej wiadomości – zapiszę ją do weryfikacji przez inne węzły i następnym razem będę wiedzieć.',
        "Do you know the answer? Write it in your next message – I'll save it for other nodes to verify, and next time I'll know.",
      ),
    )
  } else if (words.length >= 3) {
    parts.push(
      T('Jeśli to fakt, mogę go zapisać do weryfikacji (przycisk poniżej). Albo zapytaj mnie o coś innego.', 'If this is a fact, I can save it to verify (button below). Or ask me something else.'),
    )
    return {
      act: 'unknown',
      used: [],
      text: parts.join(' '),
      offer: { kind: 'fact', text: raw, answer: 'tak' },
    }
  } else {
    const unk = words.filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !(c.knownWord?.(w.toLowerCase()) ?? true))
    if (unk.length) {
      const w = unk[0].toLowerCase()
      st.askWord = w
      st.askExample = raw
      const mn = c.meaning?.word === w ? c.meaning : undefined
      if (mn?.status === 'approved')
        return {
          act: 'word',
          used: [],
          text: T(
            `„${w}”${mn.register !== 'neutralne' ? ` (${mn.register})` : ''} – ${mn.meaning} (zatwierdzone w głosowaniu, ${glosow(mn.votes)}). O co chodzi – to pytanie czy reakcja?`,
            `“${w}”${mn.register !== 'neutralne' ? ` (${mn.register})` : ''} – ${mn.meaning} (approved by vote, ${mn.votes} votes). What do you mean – a question or a reaction?`,
          ),
        }
      return {
        act: 'askword',
        used: [],
        text: T(
          `Nie znam słowa „${w}” i nie chcę zgadywać${hi}. Co ono znaczy? Napisz krótko, a zapiszę wyjaśnienie do głosowania (dopiero po zatwierdzeniu będę go używać). Jeśli to reakcja na moją odpowiedź – napisz, co było nie tak.`,
          `I don't know the word “${w}” and I won't guess${hi}. What does it mean? Write it briefly and I'll save the explanation for a vote (I'll only use it once approved). If it's a reaction to my answer, tell me what was wrong.`,
        ),
      }
    }
    parts.push(T('Napisz trochę więcej albo zapytaj „w czym mi pomożesz?”.', 'Write a bit more, or ask “what can you help with?”.'))
  }
  return { act: 'unknown', used: [], text: parts.join(' ') }
}
