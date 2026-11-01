# Wagi Qwen int8 (opt-in)

Węzeł może pobrać mniejszy plik wag Qwen2.5-0.5B-Instruct: `--weights int8`
albo `MYC_WEIGHTS=int8`. Domyślnie nadal **bf16 z Hugging Face** – działające
węzły nic nie zmieniają.

| | bf16 (HF) | int8 (wydanie `qwen-int8-v1`) |
|---|---|---|
| plik | 988,1 MB | 539,8 MB |
| pobranie na boxie | ~29 s (34 MB/s) | ~8 s (64,7 MB/s) |
| perpleksja (192 akapity, 15 168 tokenów) | 30,13 | 30,44 (+1,0%) |
| trafność, 2000 pytań (eval sha 9bebb6f4…) | 714 | 713 |

Pomiar: `lm.evaluate` na tych samych wagach bazowych + LoRA v4, ta sama ścieżka
kodu, 01.11.2026.

## Format `mycelium-int8-v1`

- MLP gate/up/down i `embed_tokens`: I8 + `<nazwa>.scale` (F32, jedna skala na
  wiersz, absmax/127, zaokrąglenie floor(x/s+0,5) – jak `quantRows` w przeglądarce).
- Attention q/k/v/o, normy i biasy: bf16 bez zmian.
- Przy wczytaniu wagi są dekwantyzowane do f32 (`qwen_int8.load_dequant`).
- Plik: <https://github.com/maciejsearch-cloud/mycelium/releases/tag/qwen-int8-v1>,
  SHA-256 `b68be1b17d4b0b52c03d6f3a6375b3e9cd0c752673d11850d21620196dbf47de`
  (stała w kodzie; zła suma → plik usuwany, powrót do bf16). Licencja Qwen
  (Apache-2.0) dołączona do wydania.
- Odtworzenie: `python -m iot_mycelium.mesh.qwen_int8 <bf16.safetensors> <out>`
  (deterministyczne, ta sama suma).

## Bramka

Weryfikator (`lmverify`) zawsze liczy na f32 z wag bf16 – int8 nie wpływa na
publikację wersji. Węzeł int8 trenuje LoRA na minimalnie innej bazie; jego
wkład i tak przechodzi przez bramkę f32. Etykieta backendu w obecności: `-int8w`.

## Przeglądarka – jeszcze nie

Zasoby wydań GitHuba nie mają nagłówka `Access-Control-Allow-Origin`
(sprawdzone dla github.com i release-assets.githubusercontent.com), więc
przeglądarka nie może ich pobrać. Możliwe drogi: lustro na Hugging Face
(CORS jest), kawałki na Pages demo (limit rozmiaru repo) albo Supabase Storage
(limit 500 MB – odpada). Do decyzji właściciela.
