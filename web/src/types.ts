export type Snapshot = {
  generated_at: string
  machine: { python: string; cpu: number }
  ai?: AiResults | null
}
export type Commit = { sha: string; date: string; author: string; subject: string; pr: number | null }
export type Phase = { id: number; title: string; status: 'done' | 'in_progress' | 'planned'; pr?: number; items: string[] }
export type Stage = { id: string; title: string; status: 'done' | 'in_progress' | 'planned'; items: { t: string; done: boolean }[] }
export type Progress = { generated_at: string; repo: string; phases: Phase[]; stages?: Stage[]; merged_prs: Commit[]; main_commits: Commit[]; branch: string; branch_commits: Commit[] }

export type Metrics = { accuracy?: number; macro_f1?: number; rmse?: number; mae?: number; naive_rmse?: number; score: number; n?: number; worst_score?: number }
export type AiAgent = {
  agent: string
  task: string
  summary: { n_train: number; n_val: number; n_test: number; n_classes: number; input_shape: number[]; kind: string; synthetic: boolean; title_pl?: string; title_en?: string; source?: string; url?: string; license?: string }
  linear: Metrics
  selected: 'tuned' | 'linear'
  model: { spec: string; n_params: number; bytes: number }
  val: Metrics
  test: Metrics
  losses: number[]
  train_seconds: number
  tuning: { best_val: number; trials: { n: number; val: number }[]; warm_start: { from: string; similarity: number } | null; warm_rank: number | null }
  seconds: number
}
export type FedRun = { test: Metrics; history: { round: number; val: number }[]; clients: number[]; seconds: number; comm_mb: number }
export type FedCompare = { task: string; spec: string; config: { n_clients: number; rounds: number; partition: string }; local: { test: Metrics; seconds: number }; fedavg: FedRun; fedprox: FedRun; fed_private: FedRun; centralized: { test: Metrics; seconds: number } }
export type AiResults = {
  generated_at: string
  git: string | null
  machine: { python: string; torch: string; cpu: number; device?: string }
  task_info?: Record<string, { title_pl?: string; title_en?: string; source?: string; url?: string; license?: string }>
  synthetic: boolean
  mbs: number
  mbs_linear: number
  agents: AiAgent[]
  federated: FedCompare[]
  memory: { size: number; records: { task: string; spec: string; val: number; test: number; agent: string }[] }
  seconds: number
  history?: { t: string; git: string | null; mbs: number; mbs_linear: number | null; scores: Record<string, number> }[]
}
