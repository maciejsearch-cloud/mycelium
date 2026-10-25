# 🍄 IoT Agents – Mycelium Memory

[![CI](https://github.com/maciejsearch-cloud/mycelium/actions/workflows/ci.yml/badge.svg)](https://github.com/maciejsearch-cloud/mycelium/actions/workflows/ci.yml)

## Koncept
Aplikacja IoT, w której użytkownicy za kliknięcie raz na X czasu uruchamiają losowego agenta ML,
który uczy się i zbiera dane. Agenci mają wspólną pamięć na wzór grzybni (mycelium network):
najlepsze wagi trafiają do wspólnej pamięci, a każdy nowy agent startuje z mieszanki
„wagi z grzybni + losowe wagi”.

Wszystko jest napisane w **czystym NumPy** (ręczny forward/backpropagation, bez PyTorch/TF).

## 🚀 Szybki start

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"

streamlit run src/dashboard.py        # dashboard → http://localhost:8501
pytest                                # testy
ruff check src tests                  # lint
```

Samo uruchomienie dashboardu (np. na Streamlit Cloud) wymaga tylko `pip install -r requirements.txt`.

### Wiersz poleceń

```bash
python -m iot_mycelium tasks                      # lista 32 zadań (★ = 8 zadań rdzenia)
python -m iot_mycelium train xor --seed 0         # trening jednego agenta
python -m iot_mycelium evolve                     # Auto-Evolution na 8 zadaniach rdzenia
python -m iot_mycelium evolve --tasks 4bit_parity palindrome --max-attempts 12
python -m iot_mycelium iq xor                     # IQ agenta
python -m iot_mycelium simulate --devices 5 --duration 30   # symulacja ruchu IoT (asyncio)
python -m iot_mycelium demo-xor                   # demo XOR + wykresy w logs/
python -m iot_mycelium dashboard                  # to samo co streamlit run
```

(Po `pip install -e .` dostępna jest też komenda `iot-mycelium …`.)

## 📊 Dashboard (Streamlit)

Zakładki:

| Zakładka | Co robi |
|---|---|
| 🏃 **Trening** | trening *persistent* agenta (pamięta postęp między sesjami), krzywe loss/accuracy, tabela predykcji, statystyki sesji, wizualizacja sieci, ewolucja wag, heatmapa aktywacji |
| 🤖 **Auto-Evolution** | automatyczne przeszukiwanie (neurony × learning rate) dla wybranych zadań, pasek postępu, tabela wyników, historia przebiegów |
| 🧠 **IQ** | umowne „IQ” wytrenowanego agenta (5 testów, max 110 pkt) i etap ewolucji |
| 🍄 **Mycelium** | stan wspólnej pamięci: najlepszy loss, metadane, liczba aktualizacji |
| 📋 **Zadania i agenci** | wszystkie 32 zadania i lista zapisanych agentów |

W panelu bocznym: zadanie, neurony ukryte, learning rate, epoki, *alpha* (udział wag z grzybni
dla nowych agentów) oraz reset grzybni.

## 📁 Struktura projektu

```
mycelium/
├── src/
│   ├── dashboard.py              # punkt wejścia: streamlit run src/dashboard.py
│   └── iot_mycelium/             # pakiet
│       ├── tasks.py              # Task + rejestr 32 zadań (generowanych z funkcji prawdy)
│       ├── universal_agent.py    # sieć 2-warstwowa ReLU→sigmoid, BCE, early stopping
│       ├── memory.py             # MyceliumMemory – wspólna pamięć (FileLock, zapis atomowy)
│       ├── persistent_agent.py   # agent zapisywany na dysku (data/agents/*.pkl)
│       ├── auto_evolution.py     # ContinuousEvolutionSystem
│       ├── iq_calculator.py      # AgentIQCalculator
│       ├── network_visualizer.py # wykresy Plotly sieci
│       ├── optimized_agent.py    # agent XOR z monitoringiem CPU/RAM (symulacja IoT, demo)
│       ├── iot_orchestrator.py   # asynchroniczna symulacja urządzeń IoT
│       ├── paths.py              # ścieżki data/ i logs/ (IOT_MYCELIUM_DATA_DIR)
│       ├── dashboard.py          # kod dashboardu
│       └── cli.py, __main__.py   # python -m iot_mycelium …
├── tests/                        # pytest (103 testy, w tym dashboard przez AppTest)
├── benchmarks/task_accuracy.py   # dokładność na 32 zadaniach
├── docs/research_findings.md
├── .github/workflows/ci.yml      # ruff + pytest (Python 3.11–3.13)
├── .streamlit/config.toml
├── pyproject.toml                # zależności, ruff, pytest
├── requirements.txt              # zależności uruchomieniowe (Streamlit Cloud)
└── DEPLOYMENT.md                 # wdrożenie na Streamlit Community Cloud
```

Dane (`data/mycelium_memory.json`, `data/agents/`, `data/evolution/`) i wykresy (`logs/`) są
tworzone automatycznie i nie trafiają do gita.

## ✅ Funkcjonalności

### 🍄 Mycelium Memory
- **Osobny slot na każdy kształt sieci** (np. `W1=2x16;W2=16x1;b1=1x16;b2=1x1`): agenci tej samej
  architektury dzielą się wagami, a trening innej architektury nie kasuje cudzych slotów
  (pliki w starym formacie v1 są migrowane automatycznie)
- Thread-safe i process-safe: cały cykl *odczyt → porównanie → zapis* pod jedną blokadą `FileLock`
  (testowane wieloma wątkami i procesami)
- Zapis atomowy (plik tymczasowy + `os.replace`), odporność na uszkodzony plik
- Fusion weights: `W = W_grzybni·α + W_losowe·(1−α)`
- Aktualizacja slotu tylko przy lepszym loss w tym slocie; reset całości albo jednego slotu

### 🤖 Agenci i zadania
- 32 zadania w 5 kategoriach (logika, arytmetyka, wzorce, sekwencje, złożona logika),
  w tym zadania z wieloma wyjściami (dekoder 2→4, kod Graya, liczba jedynek)
- 8 zadań rdzenia (XOR, AND, OR, NAND, NOR, XNOR, 3-bit Parity, Majority) – testy sprawdzają,
  że agent uczy się każdego w 100%
- Domyślnie **Adam + Leaky ReLU** (hidden 16, lr 0.1), opcjonalny mini-batch (`batch_size`);
  oryginalne SGD + ReLU dostępne przez `optimizer="sgd", activation="relu"`
- Xavier initialization, BCE, early stopping, przywracanie najlepszych wag, deterministyczne ziarno (`seed`)
- Benchmark wszystkich zadań: `python benchmarks/task_accuracy.py` (średnio 99,3%, 31/32 zadań ≥ 95%)
- Persistent agent: wagi, historia i sesje zapisywane między uruchomieniami

### 🤖 Auto-Evolution
- Siatka (hidden_dim × learning_rate) per zadanie, liczba epok zależna od parametrów
- Pojedynczy krok (`evolve_step`) albo pełny przebieg; błąd jednej próby nie zatrzymuje całości
- Wyniki zapisywane w `data/evolution/*.json`

### 🧠 IQ Calculator (na danych odłożonych)
- 4 testy **uogólniania** (k-fold, 2 losowania podziału): agent o konfiguracji badanego agenta uczy się
  części tabeli prawdy i przewiduje pominięte wiersze – logika (30), wzorce (30), matematyka (20), sekwencje (20)
- Punkty = dokładność ponad poziom klasy większościowej, `max(0, (acc − base) / (1 − base))`
- Pamięć (10): czy agent utrzymał najlepszą osiągniętą dokładność
- Etapy: foundation → patterns → language → reasoning → emotional
- To umowna skala do porównywania agentów, nie psychometryczne IQ. Funkcje typu parzystość
  z natury nie dają się uogólnić z części przykładów, więc wyniki są celowo „surowe”

### 🌐 Symulacja IoT
- Wiele urządzeń jako korutyny asyncio, trening w `asyncio.to_thread`, wspólna grzybnia

## Stack
**Python 3.11+**, NumPy 2, Streamlit, Plotly, pandas, filelock, matplotlib, psutil;
dev: pytest, ruff.

## Plusy i minusy podejścia Python + NumPy

**✅ Zalety:** pełna kontrola nad matematyką, wartość edukacyjna, minimalne zależności,
łatwe debugowanie forward/backprop, przenośność.

**❌ Wady:** brak GPU i autograd, ręczne implementacje, trudniej o zaawansowane architektury.

## 🔮 Plan rozwoju
Aktualna lista w opisie PR-ów / issues. Najbliższe pomysły:
- trwały zapis danych na Streamlit Cloud (Supabase / S3)
- prawdziwe API IoT (FastAPI + MQTT) zamiast symulacji
- fibonacci_mod2 (jedno wejście liczbowe, okres 3) – nadal ~85–95%; kodowanie binarne lub głębsza sieć

## 📦 Deployment
Instrukcja dla Streamlit Community Cloud: [`DEPLOYMENT.md`](DEPLOYMENT.md) (plik startowy: `src/dashboard.py`).

## 🖥️ Frontend (React)

Nowoczesny panel w `web/` (React 19 + Vite + TypeScript + Tailwind, wykresy Recharts):
przegląd z animowanym grafem grzybni, benchmarki, auto-ewolucja, krzywe uczenia, sloty i agenci,
strona „Postępy projektu” (fazy + scalone PR-y, generowane z gita przy buildzie).

```bash
python scripts/export_frontend_data.py      # prawdziwe przebiegi → web/public/data/snapshot.json
cd web && npm ci && npm run dev             # http://localhost:5173
npm run build && npm run e2e                # build + testy Playwright (desktop i mobile, budżet wydajności)
```

Bez backendu działa w **trybie nagranym** (dane z `snapshot.json`); po ustawieniu `VITE_API_URL`
najpierw próbuje żywego API. Demo: https://maciejsearch-cloud.github.io/demo/mycelium/


## Faza 3 – prawdziwe AI (PyTorch, CPU)

```bash
pip install -e ".[dev,ai]" --extra-index-url https://download.pytorch.org/whl/cpu
python -m iot_mycelium ai-bench --out results/ai_benchmark.json   # ~3–5 min na 8 CPU, dane pobierane raz
python scripts/export_frontend_data.py --ai-only                  # wyniki → frontend
python -m iot_mycelium ai-serve                                   # FastAPI: /api/health, /api/snapshot, /api/ai/*, /ws
python -m iot_mycelium ai-mqtt --host localhost                   # mosquitto: mycelium/sensors/<id> → mycelium/forecast/<id>
```

| moduł | co robi |
|---|---|
| `ai/datasets.py` | UCI HAR, Fashion-MNIST, CLINC150, NAB + syntetyczne odpowiedniki (CI) |
| `ai/models.py`, `ai/training.py` | MLP / CNN / tekst (fastText-like) / GRU, AdamW, ewaluacja na teście |
| `ai/federated.py` | FedAvg, FedProx, ważenie jakością, DP (obcinanie + szum Gaussa, bez formalnego ε), secure aggregation (maski parami) |
| `ai/vector_memory.py` | wspólna pamięć wektorowa doświadczeń (kosinus, zapis na dysk) |
| `ai/orchestrator.py` | agent na zadanie: baseline liniowy, Optuna z ciepłym startem z pamięci, wybór modelu tylko na walidacji |
| `ai/api.py`, `ai/mqtt.py` | REST + WebSocket, predykcja intencji i prognozy czujnika, most MQTT |

Wyniki ostatniego przebiegu: `results/ai_benchmark.json` (zakładka „Prawdziwe AI” na stronie).

## 🖥️ Stały węzeł grzybni (bez przeglądarki)

Węzeł trzyma cały Qwen2.5-0.5B na CPU (PyTorch, ~2 GB RAM) i odpowiada w czacie strumieniem tokenów (~11 tok/s na 3 wątkach).

```bash
python -m venv .venv && .venv/bin/pip install -e . && .venv/bin/python -m iot_mycelium.node --join --name moj-wezel --threads 2
```

Jako usługa z restartem po awarii (`nice -n 10`, logi w `logs/`): `scripts/nodes/start.sh` uruchamia nadzorców `scripts/nodes/supervise.sh <nazwa> <wątki>` (przerwa między restartami rośnie do 5 min). Zatrzymanie: utwórz plik `STOP` obok skryptów. Start przy uruchomieniu: `@reboot …/start.sh` w crontab.

### Węzeł jednym poleceniem (publiczny artefakt, bez źródeł repozytorium)

`scripts/build_node_pyz.py` buduje samodzielny plik `mycelium-node.pyz` (tylko kod węzła `iot_mycelium.mesh`), publikowany na stronie demo pod `/demo/mycelium/node/` razem z sumą SHA-256:

```bash
pip install torch websockets --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple \
  && curl -LO https://maciejsearch-cloud.github.io/demo/mycelium/node/mycelium-node.pyz \
  && python3 mycelium-node.pyz --join --name moj-wezel --threads 2
```

Docker (bez własnego obrazu – oficjalny `python:3.12-slim`): polecenie jest na stronie „Zostań węzłem”.

## Licencja

Kod: [MIT](LICENSE). Dane, pliki pochodne i wagi modeli mają licencje swoich źródeł – zob.
[DATA-LICENSES.md](DATA-LICENSES.md) i [`licenses.json`](licenses.json). W szczególności domyślny model rozbioru
(uczony na UD Polish-PDB) jest na CC BY-NC-SA 4.0 (niekomercyjnie), a wariant LFG – na GPL-3.0.
Odpowiedzi kontrolne (gold) nie są w repozytorium; są tylko w bazie i losowane z tajnego ziarna (`MYC_GOLD_SEED`).
