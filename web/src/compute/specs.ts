// Wspólne definicje modeli rozproszonego treningu (bez TF.js – używane też w wątku głównym).
export type ModelId = 'fashion' | 'har' | 'intent' | 'words'
export const MODELS: ModelId[] = ['fashion', 'har', 'intent', 'words']
export interface DataMeta {
  format: 'dense-u8' | 'dense-i8' | 'sparse'
  dim: number
  shape?: number[]
  classes: number
  shards: number
  val: number
  test: number
  source: string
  labels?: string[]
  arch?: { id: string; layers: { t: 'conv' | 'pool' | 'flatten' | 'drop' | 'dense' | 'bn'; f?: number; same?: boolean; relu?: boolean; r?: number; u?: number }[] }
  augment?: boolean
  emb?: { model: string; scale: number; pooling: string; dtype: string; trigrams?: number; lang?: string[]; gloss?: string }
}
/** Id architektury danych/modelu; wersje bez „arch” w meta to pierwotne modele v1. */
export const archOf = (x?: { arch?: { id: string } | string }) => (typeof x?.arch === 'string' ? x.arch : x?.arch?.id) ?? 'v1'
export interface Hyper {
  lr: number
  epochs: number
  batch: number
  mu: number // FedProx (0 = FedAvg)
  frac: number // top-k udział przesyłanych współrzędnych
}
export const DEFAULT_HP: Record<ModelId, Hyper> = {
  // dostrajanie modeli z węzła nasiennego: mniejsze lr (bramka i tak odrzuci wersję gorszą od bieżącej)
  fashion: { lr: 0.0005, epochs: 2, batch: 32, mu: 0.01, frac: 0.5 },
  har: { lr: 0.0005, epochs: 3, batch: 32, mu: 0.01, frac: 0.25 },
  intent: { lr: 0.001, epochs: 3, batch: 32, mu: 0.01, frac: 0.25 },
  words: { lr: 0.001, epochs: 3, batch: 32, mu: 0.01, frac: 0.25 },
}
// liczba zadań treningowych na rundę (wersję)
export const ROUND_TRAIN: Record<ModelId, number> = { fashion: 12, har: 4, intent: 6, words: 6 }
export const TITLES: Record<ModelId, { pl: string; en: string; arch: string }> = {
  fashion: { pl: 'Ubrania (Fashion-MNIST)', en: 'Clothing (Fashion-MNIST)', arch: 'CNN 3×conv + dense, augmentacja (przesunięcia, odbicia)' },
  har: { pl: 'Aktywność z czujników (UCI HAR)', en: 'Activity from sensors (UCI HAR)', arch: 'MLP 561-256-128-6' },
  intent: { pl: 'Intencje w tekście (CLINC150)', en: 'Text intents (CLINC150)', arch: 'osadzenia MiniLM-L6 (384) → MLP 256 → 150' },
  words: { pl: 'Kategorie słów (słowniki)', en: 'Word categories (dictionaries)', arch: 'wielojęzyczny MiniLM-L12 + trigramy → MLP 192 → 31' },
}
/** Tytuł także dla modelu językowego ('lm'), który nie jest trenowany w przeglądarce (tylko węzły PC). */
export const titleOf = (m: string) => TITLES[m as ModelId] ?? { pl: 'Model językowy (LoRA Qwen2.5-0.5B)', en: 'Language model (LoRA Qwen2.5-0.5B)', arch: 'adapter LoRA r=4 (qkv, o) · polska Wikipedia' }
export type Backend = 'webgpu' | 'webgl' | 'wasm' | 'cpu'
export interface BackendInfo {
  backend: Backend
  device: string
  simd?: boolean
  threads?: boolean
  error?: string
}
export interface JobMsg {
  id: number
  model: ModelId
  version: number
  kind: 'train' | 'eval' | 'hparam' | 'label' | 'verify' | 'reeval'
  params: Record<string, unknown>
}
export interface JobOut {
  payload?: string
  metrics: Record<string, number | string | null>
  samples: number
  flops: number
  ms: number
  busy: number
}
