// Jawne listy słów rozmówcy (autorskie, GPL-3.0 jak repozytorium). Każda decyzja reguły opiera się na LEMACIE z rozbioru
// (model grzybni + Morfeusz 2), a nie na dopasowaniu napisu – listy mówią tylko, które lematy coś znaczą.
// Emocje i nacechowanie: leksykon Słowosieci (emo.json.gz, CC BY 4.0); tu tylko uzupełnienia, których tam brak.

const S = (s: string) => new Set(s.split(/\s+/).filter(Boolean))

/** Czynności wymagające ciała (lematy czasowników). */
export const BODY_VERBS = S(`
  srać wysrać nasrać sikać siusiać lać sikać pierdzieć bekać rzygać wymiotować pocić kichać kaszleć oddychać ziewać chrapać
  jeść zjeść zjadać pić wypić napić żreć gryźć połknąć smakować gotować ugotować piec upiec
  spać wyspać zasnąć usnąć budzić obudzić wstać wstawać leżeć siedzieć usiąść stać drzemać
  myć umyć kąpać wykąpać golić ogolić czesać uczesać ubrać ubierać przebrać malować umalować
  chodzić iść pójść przyjść wyjść jechać pojechać jeździć biegać biec pobiec pływać latać skakać tańczyć zatańczyć spacerować wędrować
  ćwiczyć trenować chorować zachorować boleć krwawić rosnąć schudnąć przytyć tyć
  całować pocałować przytulić przytulać dotykać dotknąć głaskać kochać_się uprawiać
  mieszkać przeprowadzić nocować odwiedzić wpaść`)
/** Rzeczowniki, które w pytaniu do grzybni zakładają ciało (np. „byłaś w toalecie?”, „idziesz na imprezę?”). */
export const BODY_NOUNS = S(`
  toaleta kibel łazienka sedes prysznic wanna kupa siku śniadanie obiad kolacja jedzenie posiłek kawa herbata piwo wódka wino
  sen łóżko piżama impreza spacer basen siłownia ząb włos ręka noga brzuch głowa ciało twarz`)
/** Czasowniki „zdolności” – pytanie „umiesz pływać?” sprawdza bezokolicznik. */
export const ABILITY_VERBS = S('umieć potrafić móc lubić chcieć')

/** Obelgi (lematy rzeczowników i przymiotników) – samo słowo NIE jest obrazą; obrazą jest skierowanie go do kogoś. */
export const INSULTS = S(`
  głupi głupek głupia głupiec debil debilka idiota idiotka kretyn kretynka matoł baran osioł dureń cymbał tępak tępy
  frajer frajerka zero nieudacznik śmieć złom szmelc gówno badziewie beznadziejny bezużyteczny żałosny
  chujowy gówniany gówniarz kutas chuj fiut cwel pizda szmata dupek palant łajza leszcz ciota ciul pajac głąb
  bezmózgi gamoń ofiara pasożyt kaleka śmierdziel brzydki obrzydliwy`)
/** Obelżywe zwroty wielowyrazowe (w tekście, małymi literami). */
export const INSULT_PHRASES = /\b(do dupy|do bani|do niczego|kupa złomu|ssiesz|ssie)\b/
/** Rdzenie próśb o żart (formy, których lematu model nie zna, np. „rozśmiesz”). */
export const JOKE_STEMS = /(żart|kawał|dowcip|śmieszn|zabawn|rozśmiesz|rozbaw|suchar)/
/** Wyrażenia wrogości (lematy czasowników, z dopełnieniem „ty/grzybnia”). */
export const HOSTILE_VERBS = S('nienawidzić gardzić wkurzać denerwować wypierdalać spierdalać spadać zamknąć odwalić')
/** Formy wulgarne (etykieta rejestru – bez cenzury, nic nie jest blokowane). */
export const VULGAR = S(`
  kurwa kurwić kurde kurczę pierdolić pierdzielić jebać chuj chujowy pizda dupa zajebisty zajebiście wkurwiać wkurwić
  spierdalać wypierdalać kurewski skurwysyn gówno cholera`)
/** Przeprosiny (lematy) i formy nieodmienne. */
export const APOLOGY = S('przepraszać przeprosić wybaczyć wybaczać sorry sory sorki przepraszam wybacz')
/** Komplementy i podziękowania. */
export const PRAISE = S(`
  super świetny mądry fajny genialny kochany wspaniały zajebisty najlepszy dobry sprytny szybki bystry piękny słodki
  niesamowity cudowny mega kozak sztos git spoko ekstra extra wow fantastyczny rewelacyjny
  dzięki dziękować podziękować brawo robota lubić kochać uwielbiać`)
/** Zawołanie / sprawdzenie obecności. */
export const PRESENCE_VERBS = S('być żyć słyszeć odezwać')
export const GREETINGS = S('cześć hej halo siema siemka elo witam witaj dzień dobry hejka joł yo')
/** Prośba o żart. */
export const JOKE_WORDS = S('żart kawał dowcip śmieszny zabawny rozśmieszyć rozbawić rozśmieszać suchar')
/** Pytania o relację z grzybnią (z „mnie/ze mną”). */
export const RELATION_VERBS = S('lubić pamiętać gniewać obrażać kochać nienawidzić znać złościć')
/** Pytania o pamięć czatu: „co pisał X”, „kto pisał o …”. */
export const SAY_VERBS = S('pisać napisać mówić powiedzieć wspominać wspomnieć gadać')
/** Pytania o mnie (grzybnię) – czasowniki w 2. os., gdy nie dotyczą ciała. */
export const SELF_VERBS = S('być mieć czuć uczyć nauczyć potrafić umieć myśleć robić nazywać wiedzieć rozumieć składać działać')

/** Stany i emocje, których brakuje w leksykonie Słowosieci (lemat → [nacechowanie, emocja]). */
export const STATE_EXTRA: Record<string, [number, string]> = {
  bać: [-2, 'strach'],
  obawiać: [-1, 'strach'],
  martwić: [-2, 'strach'],
  niepokoić: [-1, 'strach'],
  stresować: [-1, 'strach'],
  denerwować: [-1, 'złość'],
  wkurzać: [-2, 'złość'],
  wkurwiać: [-2, 'złość'],
  smutno: [-2, 'smutek'],
  nudno: [-2, 'smutek'],
  źle: [-1, 'smutek'],
  słabo: [-1, 'smutek'],
  dobrze: [1, 'radość'],
  głodny: [-1, 'smutek'],
  śpiący: [-1, 'smutek'],
  kochać: [2, 'radość'],
  nienawidzić: [-2, 'złość'],
  urodziny: [2, 'radość'],
  imieniny: [2, 'radość'],
  zimno: [-1, 'smutek'],
  gorąco: [-1, 'złość'],
}

/** Częste imiona (mianownik i wołacz) – do rozpoznania zwrotu do innej osoby na początku wiadomości. */
export const NAMES = S(`
  ola olu ania aniu kasia kasiu basia basiu ewa ewo marta marto magda magdo zosia zosiu julia julio hania haniu asia asiu
  gosia gosiu kinga kingo natalia natalio weronika weroniko agata agato monika moniko ula ulu iza izo ewelina ewelino
  tomek tomku kuba kubo bartek bartku adam adamie piotrek piotrku michał michale marek marku paweł pawle krzysiek krzyśku
  wojtek wojtku janek janku jacek jacku łukasz łukaszu kamil kamilu maciek maćku mateusz mateuszu szymon szymonie filip filipie
  igor igorze dawid dawidzie kacper kacprze damian damianie jarek jarku rafał rafale grzesiek grzesiu kristine kristino`)

/** Formy zwracania się do grzybni: wołacz i inne przypadki (w tokenach, małymi literami). */
export const ME_VOC = /^grzybni(o|uszko|eczko)$/
export const ME_ANY = /^(grzybni(a|o|ę|ą|y|i|e|uszko|eczko)|grzybnia\s*ai)$/
