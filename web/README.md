# Mycelium AI – frontend

React 19 + Vite + TypeScript + Tailwind 4. Opis i komendy: główny `README.md`, sekcja „Frontend”.

- `npm run dev` / `npm run build` – generują `public/data/progress.json` z gita (`scripts/gen-progress.mjs`)
- `public/data/snapshot.json` – nagrane wyniki z `python scripts/export_frontend_data.py`
- `npm run e2e` – Playwright (desktop + mobile) na zbudowanej wersji, w tym budżet wydajności
- `BASE=/demo/mycelium/ npm run build` – wersja pod GitHub Pages
