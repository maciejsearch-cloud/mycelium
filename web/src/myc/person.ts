// Pytania osobiste: o rozmówcę („Ile mam lat?”, „Gdzie mieszkam?”) albo o sam czat („Ile masz lat?”).
// To nie są pytania o fakt ze świata – nie szukamy ich w Wikipedii (wcześniej „Ile mam lat?” dostawało film „Znów mam 17 lat”).
// Odpowiedź: uczciwe „nie wiem, nie znam Cię” – chyba że wiemy to z kontekstu (imię podane w tej rozmowie).

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .trim()

// grzecznościowe wstępy, które nie czynią pytania osobistym: „powiedz mi, kto…”, „czy wiesz, gdzie…”, „możesz mi powiedzieć…”
const POLITE = /^(a |no |hej,? |prosze,? |czy |(ty )?wiesz,? |powiedz( mi)?,? |wytlumacz( mi)?,? |wyjasnij( mi)?,? |(czy )?(mozesz|moglbys|moglabys|umiesz) mi powiedziec,? |do you know,? |can you tell me,? |tell me,? )+/

const ME_PL =
  /\b(ja|mnie|mi|mna|moj|moja|moje|mojego|mojej|moim|moich|moimi|mojemu|mam|jestem|mieszkam|lubie|pracuje|urodzilem|urodzilam|studiuje|chodze|waze|zarabiam|czuje|potrzebuje|zrobilem|zrobilam|bylem|bylam|powinienem|powinnam|chce|wierze|kocham|nazywam)\b/
const YOU_PL =
  /\b(ty|ciebie|cie|tobie|toba|twoj|twoja|twoje|twojego|twojej|twoim|twoich|masz|jestes|mieszkasz|lubisz|myslisz|nazywasz|urodzilas|urodziles|pracujesz|czujesz|wazysz|zarabiasz|chcesz|kochasz|wierzysz)\b/
const ME_EN = /\b(am i|do i|did i|have i|my|me|mine|myself)\b/
const YOU_EN = /\b(are you|do you|did you|have you|your|yours|yourself)\b/
// „Jak mam ugotować jajko?” / „Co mam zrobić…” – prośba o radę (bezokolicznik), nie pytanie o rozmówcę
const ADVICE = /\b(jak|co|czy|gdzie|kiedy|ile) (mam|powinienem|powinnam|moge) \p{L}+(c|sc)\b/u

const QSTART = /^(czy|co|kto|kogo|komu|kim|czym|gdzie|kiedy|jak|jaki|jaka|jakie|jakiego|jakiej|ktory|ktora|ktore|ile|ilu|dlaczego|czemu|skad|what|who|where|when|how|why|which|is|are|do|does|did|am)\b/

/** 'me' = pytanie o rozmówcę, 'you' = pytanie o czat, undefined = nie osobiste. */
export function personalQ(raw: string): 'me' | 'you' | undefined {
  let n = norm(raw).replace(/[„”"«»]/g, '')
  if (!(/\?\s*$/.test(n) || QSTART.test(n))) return undefined
  n = n.replace(POLITE, '').replace(/[?!.,;:]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!n || ADVICE.test(n)) return undefined
  if (ME_PL.test(n) || ME_EN.test(n)) return 'me'
  if (YOU_PL.test(n) || YOU_EN.test(n)) return 'you'
  return undefined
}

export function personalReply(kind: 'me' | 'you', en: boolean, name?: string): string {
  const hi = name ? `, ${name}` : ''
  if (kind === 'you')
    return en
      ? "That's a question about me: I'm Mycelium AI, a program running in volunteers' browsers. I have no age, home or body, so I won't answer it from Wikipedia about someone else. Ask “who are you?” to hear how I work."
      : 'To pytanie o mnie: jestem Mycelium AI – programem działającym w przeglądarkach wolontariuszy. Nie mam wieku, domu ani ciała, więc nie odpowiem na to z Wikipedii o kimś innym. Zapytaj „kim jesteś?”, a opowiem, jak działam.'
  return en
    ? `I don't know${hi} – I don't know you. I don't collect data about people and I won't guess or look you up in Wikipedia. ${name ? `All I know is what you told me in this chat: your name is ${name}.` : 'If you like, tell me your name (e.g. “My name is Ola”) – I keep it only in this chat.'}`
    : `Nie wiem${hi} – nie znam Cię. Nie zbieram danych o ludziach i nie będę zgadywać ani szukać Cię w Wikipedii. ${name ? `Wiem tylko to, co napisałeś w tej rozmowie: masz na imię ${name}.` : 'Jeśli chcesz, przedstaw się (np. „Mam na imię Ola”) – zapamiętam to tylko w tej rozmowie.'}`
}
