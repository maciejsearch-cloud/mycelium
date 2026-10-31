# System wyglądu (31.10.2026)

- **Motywy:** ciemny domyślnie, jasny przełącznikiem (słońce/księżyc w menu; `localStorage myc.theme`, atrybut `data-theme` na `<html>`).
  Jasny motyw przemapowuje zmienne kolorów Tailwinda v4 (`--color-slate-*`, `white`, `black`, barwy marki i jasne odcienie sky/rose/violet/teal…)
  w `web/src/index.css`, więc nie wymaga osobnych klas na stronach. Panel `.night` (mapa grzybni) zostaje ciemny w obu motywach.
- **Paleta:** ink `#03080a`, moss, bark, line; akcenty spore (turkus), sky, violet, amber, rose. W jasnym motywie barwy marki są ciemniejsze (kontrast tekstu ≥ 4,5:1).
- **Typografia:** nagłówki i liczby – Space Grotesk (OFL, własny hosting, `public/fonts`, ~41 KB, latin + latin-ext); tekst – czcionka systemowa.
- **Ikony:** `web/src/components/Icon.tsx` – jeden zestaw ścieżek SVG (obrys 1.75), bez biblioteki.
- **Elementy:** `.card`, `.card-glow`, `.card-hover`, `.chip`, `.eyebrow`, `.btn-primary`, `.btn-ghost`, `.seg`, `PageHeader`, `Kpi`, `Card` (`components/ui.tsx`).
- **Ruch:** dryfujące strzępki w tle, wejście kart, pulsowanie aktywnych węzłów – wszystko wyłączone przy `prefers-reduced-motion: reduce`.
- **Fokus:** widoczny pierścień `:focus-visible` w obu motywach; na ekranach dotykowych pola mają ≥ 44 px wysokości i 16 px tekstu.
