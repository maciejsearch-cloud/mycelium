// Rozmówca czatu globalnego (01.11.2026): interfejsy. Implementacje: understand.ts (rozbiór wiadomości),
// respond.ts (wybór odpowiedzi), relations.ts (pamięć relacji z osobą), moderation.ts (zalew / nękanie).
// Wszystko tu jest czyste (bez sieci i bazy) – ten sam kod działa w procesie rozmówcy (web/scripts/rozmowa-worker.mjs),
// w pomiarach (web/scripts/rozmowa-eval.mjs) i w przeglądarce (arkusz „rozbiór” wiadomości).
import type { UTok } from '../rozbior'

/** Parser zdań: tokeny UD z lematami i cechami (model rozbioru grzybni + Morfeusz 2). */
export type ParseFn = (forms: string[]) => UTok[]
/** Tokenizator zgodny z modelem (rozbior.tokenize). */
export type TokenizeFn = (text: string) => string[]

export type QType = 'tak/nie' | 'kto' | 'co' | 'gdzie' | 'kiedy' | 'jak' | 'ile' | 'dlaczego' | 'jaki' | 'który' | 'czyj' | 'skąd' | 'dokąd'
export type Mood = 'ind' | 'imp' | 'cond'
export type Tense = 'pres' | 'past' | 'fut'
export type Emotion = 'radość' | 'zaufanie' | 'oczekiwanie' | 'zaskoczenie' | 'smutek' | 'złość' | 'strach' | 'wstręt'

/** Leksykon emocji: lemat → [nacechowanie −2..2, maska emocji]. */
export interface EmoLex {
  meta: { source: string; url: string; license: string; emo: Emotion[]; n: number }
  lem: Record<string, [number, number]>
}

/** Słownik form (Morfeusz 2 / SGJP) – do odmiany w odpowiedziach i do lematyzacji form spoza modelu. */
export interface FormLex {
  /** wszystkie interpretacje formy: [lemat, tag NKJP] */
  analyses(form: string): [string, string][]
  /** forma lematu o tagu zaczynającym się od prefiksu (np. 'fin:sg:sec'), jeśli jest w słowniku */
  generate?(lemma: string, tagPrefix: string): string | undefined
}

export interface Lexicons {
  emo?: EmoLex
  forms?: FormLex
}

/** Jeden token po rozbiorze (zwięzły – zapisywany w bazie). */
export interface MiniTok {
  f: string // forma
  l: string // lemat
  u: string // UPOS
  d: string // relacja zależnościowa
  h: number // nadrzędnik (0 = korzeń)
  x?: string // cechy skrócone: P1/P2/P3, Past/Pres/Fut, Imp/Cnd, przypadek
}

/** Co grzybnia zrozumiała z wiadomości. Każde pole wynika z rozbioru albo z jawnej listy (pole `why`). */
export interface Understanding {
  text: string
  /** wiadomość zwraca się do grzybni (wołacz „grzybnio”, „grzybnia” jako podmiot/temat, odpowiedź na wpis AI) */
  addressed: boolean
  /** zwrot do innej osoby: @pseudonim albo imię na początku – wtedy grzybnia się nie wtrąca */
  toOther?: string
  pred?: string
  person?: 1 | 2 | 3
  mood?: Mood
  tense?: Tense
  neg: boolean
  subj?: string
  obj?: string
  /** fraza przyimkowa / okolicznik skopiowane z wiadomości (do pytań zwrotnych) */
  phrase?: string
  qtype?: QType
  question: boolean
  /** lematy treści (rzeczowniki, czasowniki, przymiotniki) – indeks pamięci czatu */
  content: string[]
  /** suma nacechowania z leksykonu (z negacją) i emocje */
  polarity: number
  emotions: Emotion[]
  /** akty mowy rozpoznane z rozbioru + list */
  acts: Act[]
  /** inne wykryte elementy (np. który czasownik cielesny, która obelga) */
  why: string[]
  conf: number
  toks: MiniTok[]
}

export type Act =
  | 'wołanie' // samo zawołanie / pytanie o obecność
  | 'ciało' // pytanie zakładające ciało grzybni
  | 'o_mnie' // pytanie o grzybnię (kim jesteś, ile masz lat…)
  | 'relacja' // pytanie o relację (lubisz mnie? gniewasz się?)
  | 'stan' // osoba mówi o swoim stanie / emocji
  | 'żart' // prośba o żart
  | 'obraza' // obraza grzybni
  | 'obraza_innego' // obelga skierowana do innej osoby
  | 'przeprosiny'
  | 'komplement'
  | 'wulgaryzm' // przekleństwo (tylko etykieta – bez cenzury)
  | 'przypomnienie' // pytanie o to, co ktoś pisał
  | 'powitanie'
  | 'opowieść' // relacja z własnego życia (do wtrącenia)
  | 'pytanie_ogólne' // pytanie do wszystkich

export type ReplySource = 'reguła' | 'model' | 'fakt' | 'ludzie' | 'pamięć'

export interface Reply {
  text: string
  source: ReplySource
  /** identyfikator reguły (np. 'cialo.czynnosc'), do oceny i statystyk */
  rule: string
  /** odpowiedź na wiadomość skierowaną do grzybni (true) czy wtrącenie (false) */
  addressed: boolean
  /** źródło faktów/żartu (adres, licencja) – pokazywane w interfejsie */
  cite?: string
}

/** Zdarzenie w relacji z osobą (z jednej wiadomości). */
export type RelEvent = 'obraza' | 'przeprosiny' | 'komplement' | 'rozmowa' | 'wrogość_wobec_innych'

/** Stan relacji grzybni z jednym kontem – zwięzły (myc_self_relations). */
export interface RelationState {
  score: number // −10..10; < −2 chłodno, > 2 ciepło
  n_msgs: number
  n_insults: number
  n_apologies: number
  n_compliments: number
  n_hostile_others: number
  last_insult?: { at: string; text: string }
  last_apology_at?: string
  last_compliment_at?: string
  /** ulubione tematy: lemat → liczba wiadomości */
  topics: Record<string, number>
  first_at?: string
}
export type Tone = 'ciepło' | 'neutralnie' | 'chłodno'

/** Kontekst odpowiedzi: stan relacji autora, ostatnie wiadomości, pamięć czatu (wyniki z bazy). */
export interface ReplyContext {
  handle: string
  rel?: RelationState
  /** autor wyłączył naukę – bez pamięci relacji i bez zapisu */
  optedOut?: boolean
  /** fakty o grzybni z bazy (prawdziwe liczby) */
  self?: SelfFacts
  /** odpowiedź z pamięci czatu, gdy wiadomość o nią pyta (wyszukiwanie robi baza) */
  recall?: RecallHit[]
  /** zatwierdzone przez ludzi pary dialogowe (znormalizowane pytanie → odpowiedź) */
  pairs?: Record<string, string>
  /** czy to odpowiedź na wpis grzybni */
  replyToAi?: boolean
  /** strzępki wiedzy z bazy dla pytania o wiedzę (factQuery); undefined = nie szukano */
  facts?: import('./facts').FactRow[]
  /** losowość (dla testów: stała) */
  rnd?: () => number
  now?: Date
}
export interface SelfFacts {
  nodes_online?: number
  lm_version?: string
  first_seen?: string
  chat_msgs_learned?: number
  relations?: number
  learning?: string
}
export interface RecallHit {
  handle: string
  at: string
  text: string
}

/** Wiadomość w oknie moderacji. */
export interface ModMsg {
  id: number
  author: string
  text: string
  at: number // ms
  u?: Understanding
}
export type ModAction =
  | { kind: 'mute_auto'; author: string; minutes: number; reason: string; evidence: number[] }
  | { kind: 'propose'; author: string; target?: string; minutes: number; reason: string; evidence: number[] }
  | { kind: 'warn'; author: string; text: string; evidence: number[] }

/** Interfejs dla SelfModelu (inny moduł): relacje i decyzje – bez danych osobowych w części publicznej. */
export interface SelfRelationsApi {
  /** stan źródła do migawki SelfModelu */
  status(): Promise<{ source: string; available: boolean; rows: number; opted_out_excluded: true; decisions: number }>
  /** moja relacja z grzybnią (zalogowane konto; RLS/RPC) */
  mine(): Promise<RelationState | null>
  /** historia decyzji rozmówcy (moderacja i ich skutki) – kształt jak Decision w SelfModelu */
  decisions(limit?: number): Promise<SelfDecision[]>
}
export interface SelfDecision {
  id: string
  at: string
  kind: string
  choice: Record<string, number>
  reason: string
  outcome: Record<string, unknown> | null
  outcome_pl: string | null
}
