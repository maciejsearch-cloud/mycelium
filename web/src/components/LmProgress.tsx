import { useEffect, useState } from "react";
import { L, useI18n } from "../i18n";
import { SB_KEY, SB_URL } from "../myc/store";
import { ago, Empty, fmtTime, TimeChart, type Point } from "./TimeChart";
import { Card, Kpi } from "./ui";

type V = {
  model?: string;
  version: number;
  acc: number;
  meta?: {
    ppl?: number;
    correct?: number;
    ppl_prev?: number;
    server_lr?: number;
    eval_version?: number;
    eval_n?: number;
    rebased?: {
      prev_acc: number;
      prev_ppl?: number;
      prev_eval_n?: number;
      at: string;
    }[];
  };
  n_updates: number;
  samples: number;
  created_at: string;
  verifiers?: { trusted?: boolean; ppl?: number; acc?: number }[];
};
type C = {
  model?: string;
  version: number;
  status: string;
  acc_claimed: number;
  verified_acc: number | null;
  meta?: { ppl?: number };
  reason: string | null;
  created_at: string;
  verifiers?: { trusted?: boolean }[] | null;
};
type ES = { n: number; sha: string; version?: number };
type R = {
  model?: string;
  node_id: string;
  samples: number;
  created_at: string;
};

const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const get = <T,>(q: string) =>
  fetch(`${SB_URL}/rest/v1/${q}`, { headers: H }).then((r) =>
    r.ok
      ? (r.json() as Promise<T>)
      : Promise.reject(new Error(String(r.status))),
  );

/** Model językowy grzybni: perpleksja i trafność każdej opublikowanej wersji (prawdziwe wiersze myc_models, model = 'lm'). */
export function LmProgress({ detail = false }: { detail?: boolean }) {
  const { lang } = useI18n();
  const en = lang === "en";
  const [vs, setVs] = useState<V[] | undefined>();
  const [cs, setCs] = useState<C[] | undefined>();
  const [rs, setRs] = useState<R[] | undefined>();
  const [es, setEs] = useState<ES | undefined>();
  useEffect(() => {
    const load = () => {
      get<V[]>(
        "myc_models?model=eq.lm&select=model,version,acc,meta,n_updates,samples,created_at,verifiers&order=version",
      ).then(
        (r) => setVs(r.filter((x) => x.model === "lm")),
        () => setVs([]),
      );
      get<C[]>(
        "myc_candidates?model=eq.lm&select=model,version,status,acc_claimed,verified_acc,meta,reason,created_at,verifiers&order=id.desc&limit=8",
      ).then(
        (r) => setCs(r.filter((x) => x.model === "lm")),
        () => setCs([]),
      );
      get<ES[]>("myc_eval_sets?model=eq.lm&select=n,sha,version").then(
        (r) => setEs(r[0]),
        () => setEs(undefined),
      );
      get<R[]>(
        "myc_results?model=eq.lm&kind=eq.train&select=model,node_id,samples,created_at&order=id.desc&limit=5000",
      ).then(
        (r) => setRs(r.filter((x) => x.model === "lm")),
        () => setRs([]),
      );
    };
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  const last = vs?.at(-1);
  // wyniki z różnych zbiorów testowych nie są porównywalne: osobna seria na każdą wersję zbioru (s1 = 250, s2 = 2000 pytań)
  const ev = (v: V) => v.meta?.eval_version ?? 1;
  const pts: Point[] = [];
  const accPts: Point[] = [];
  for (const v of vs ?? []) {
    const t = Date.parse(v.created_at);
    const old = v.meta?.rebased?.[0];
    if (old) {
      pts.push({ t, ppl1: old.prev_ppl ?? null });
      accPts.push({ t, acc1: +(old.prev_acc * 100).toFixed(2) });
    }
    pts.push({
      t: old ? Date.parse(old.at) : t,
      [`ppl${ev(v)}`]: v.meta?.ppl ?? null,
    });
    accPts.push({
      t: old ? Date.parse(old.at) : t,
      [`acc${ev(v)}`]: +(v.acc * 100).toFixed(2),
    });
  }
  pts.sort((a, b) => a.t - b.t);
  accPts.sort((a, b) => a.t - b.t);
  const setName = (k: number) =>
    en
      ? `test set v${k} (${k === 1 ? 250 : (es?.n ?? 2000)} q.)`
      : `zbiór v${k} (${k === 1 ? 250 : (es?.n ?? 2000)} pyt.)`;
  const tokens = (rs ?? []).reduce((a, r) => a + r.samples, 0);
  const nodes = new Set((rs ?? []).map((r) => r.node_id)).size;
  const st = {
    pending: en ? "waiting for independent check" : "czeka na niezależną ocenę",
    published: en ? "published" : "opublikowany",
    rejected: en ? "rejected" : "odrzucony",
    expired: en ? "expired" : "wygasł",
  } as Record<string, string>;
  return (
    <Card
      title={
        en
          ? "Mycelium language model (trained on nodes)"
          : "Model językowy grzybni (trenowany na węzłach)"
      }
      className="mt-4"
    >
      <div data-testid="lm-progress">
        <p className="mb-3 text-xs text-slate-400">
          <L
            pl="Węzły trenują adapter LoRA (rank 4, 368 640 parametrów) modelu Qwen2.5-0.5B na polskiej Wikipedii (CC BY-SA 4.0): akapity i pytania „Co to jest…?”. Agregator uśrednia adaptery (FedAvg), a nowa wersja powstaje dopiero, gdy inny węzeł albo zaufany weryfikator przeliczy stały test: perpleksja na 192 odłożonych akapitach nie może wzrosnąć, a trafność wyboru definicji (2000 pytań, 1 z 4; do 24.10 – 250) nie może spaść. Czat grzybni używa najnowszej wersji."
            en="Nodes train a LoRA adapter (rank 4, 368,640 parameters) of Qwen2.5-0.5B on Polish Wikipedia (CC BY-SA 4.0): paragraphs and “What is…?” questions. The aggregator averages adapters (FedAvg); a new version exists only after another node or the trusted verifier recomputes the fixed test: perplexity on 192 held-out paragraphs must not rise and definition-choice accuracy (2000 questions, 1 of 4; 250 until 24 Oct) must not drop. The mycelium chat uses the latest version."
          />
        </p>
        <p
          className="mb-3 text-xs text-slate-400 tabular-nums"
          data-testid="lm-evalset"
        >
          {en ? "Fixed test set" : "Stały zbiór testowy"}:{" "}
          {es
            ? `${en ? "version" : "wersja"} ${es.version ?? 1} · ${es.n} ${en ? "questions" : "pytań"} + 192 ${en ? "paragraphs" : "akapity"} · SHA-256 ${es.sha.slice(0, 12)}…`
            : "…"}
          {last?.meta?.rebased?.length
            ? ` · ${en ? `v${last.version} re-scored on it by the independent verifier` : `v${last.version} przeliczona na nim przez niezależnego weryfikatora`} (${en ? "was" : "było"} ${(last.meta.rebased[0].prev_acc * 100).toFixed(1)}% / ${last.meta.rebased[0].prev_ppl?.toFixed(2)} ${en ? "on 250 q." : "na 250 pyt."})`
            : ""}
        </p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi
            label={en ? "Version" : "Wersja"}
            value={vs ? (last ? `v${last.version}` : "—") : "…"}
            hint={last ? ago(last.created_at, lang) : ""}
          />
          <Kpi
            label={
              en ? "Perplexity (lower = better)" : "Perpleksja (mniej = lepiej)"
            }
            value={vs ? (last?.meta?.ppl?.toFixed(2) ?? "—") : "…"}
            hint={
              es
                ? `${en ? "set" : "zbiór"} v${last ? ev(last) : (es.version ?? 1)}`
                : ""
            }
            tone="violet"
          />
          <Kpi
            label={en ? "Definition accuracy" : "Trafność definicji"}
            value={vs ? (last ? `${(last.acc * 100).toFixed(1)}%` : "—") : "…"}
            hint={`${last?.meta?.correct ?? "—"}/${last?.meta?.eval_n ?? (last && ev(last) === 1 ? 250 : "—")} · ${en ? "chance 25%" : "losowo 25%"}`}
            tone="amber"
            src={
              last?.meta?.rebased?.length
                ? en
                  ? "myc_models, recomputed by the trusted verifier"
                  : "myc_models, przeliczone przez zaufanego weryfikatora"
                : "myc_models"
            }
            verif={last ? "verified" : undefined}
          />
          <Kpi
            label={en ? "Tokens trained" : "Wytrenowane tokeny"}
            value={rs ? tokens.toLocaleString(lang) : "…"}
            hint={rs ? `${nodes} ${en ? "nodes" : "węzłów"}` : ""}
            src={
              en
                ? "sum of samples reported with LM training results"
                : "suma próbek zgłoszonych z wynikami treningu LM"
            }
            verif="self"
          />
        </div>
        <div className="mt-3 grid gap-4 xl:grid-cols-2">
          <div>
            <div className="mb-1 text-xs text-slate-400">
              {en
                ? "Perplexity per version (fixed held-out set)"
                : "Perpleksja w kolejnych wersjach (stały zbiór odłożony)"}
            </div>
            <TimeChart
              data={pts}
              series={[
                { key: "ppl1", name: setName(1), color: "#64748b" },
                { key: "ppl2", name: setName(2), color: "#a78bfa" },
              ]}
              domain={["auto", "auto"]}
            />
          </div>
          <div>
            <div className="mb-1 text-xs text-slate-400">
              {en
                ? "Definition-choice accuracy per version (%)"
                : "Trafność wyboru definicji w kolejnych wersjach (%)"}
            </div>
            <TimeChart
              data={accPts}
              series={[
                { key: "acc1", name: setName(1), color: "#64748b" },
                { key: "acc2", name: setName(2), color: "#fbbf24" },
              ]}
              unit="%"
              domain={["auto", "auto"]}
            />
          </div>
        </div>
        <div
          className="mt-3 text-xs text-slate-500"
          data-testid="lm-candidates"
        >
          <div className="text-slate-400">
            {en ? "Latest candidates" : "Ostatni kandydaci"}
          </div>
          {cs && !cs.length && <Empty h="h-10" />}
          <ul className="mt-1 space-y-0.5">
            {(cs ?? []).map((c, i) => (
              <li key={i} className="tabular-nums">
                {ago(c.created_at, lang)} · v{c.version}:{" "}
                {en ? "perplexity" : "perpleksja"}{" "}
                {c.meta?.ppl?.toFixed(2) ?? "—"}, {en ? "accuracy" : "trafność"}{" "}
                {(c.acc_claimed * 100).toFixed(1)}% · {st[c.status] ?? c.status}
                {c.verifiers?.some((v) => v.trusted) ? " (CI)" : ""}
                {c.reason ? ` · ${c.reason}` : ""}
              </li>
            ))}
          </ul>
        </div>
        {detail && (
          <div
            className="mt-3 border-t border-white/5 pt-2 text-xs text-slate-400"
            data-testid="lm-verify"
          >
            <div className="font-semibold text-slate-300">
              {en ? "Recompute it yourself" : "Przelicz samodzielnie"}
            </div>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-ink/60 p-2 text-[11px]">
              {`pip install torch websockets --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple\ncurl -LO ${location.origin}${import.meta.env.BASE_URL}node/mycelium-node.pyz\npython3 mycelium-node.pyz --verify-lm --version ${last?.version ?? 0}`}
            </pre>
            <p className="mt-1">
              {en
                ? "Downloads the base weights (SHA-256 checked), the adapter of that version from public Storage (SHA-256 prefix in the file name) and the fixed test eval.bin (SHA-256 must match myc_eval_sets), then prints perplexity and accuracy to compare with the table below."
                : "Pobiera wagi bazowe (sprawdzana SHA-256), adapter tej wersji z publicznego Storage (początek SHA-256 w nazwie pliku) i stały test eval.bin (SHA-256 musi się zgadzać z myc_eval_sets), a potem wypisuje perpleksję i trafność do porównania z tabelą poniżej."}
            </p>
            {vs && vs.length > 0 && (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left" data-testid="lm-versions">
                  <thead>
                    <tr className="text-slate-500">
                      <th>{en ? "version" : "wersja"}</th>
                      <th>{en ? "perplexity" : "perpleksja"}</th>
                      <th>{en ? "accuracy" : "trafność"}</th>
                      <th>{en ? "test set" : "zbiór"}</th>
                      <th>{en ? "updates" : "aktualizacje"}</th>
                      <th>{en ? "verified by" : "sprawdzili"}</th>
                      <th>{en ? "published" : "opublikowana"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...vs]
                      .reverse()
                      .slice(0, 30)
                      .map((v) => (
                        <tr
                          key={v.version}
                          className="border-t border-white/5 tabular-nums"
                        >
                          <td>v{v.version}</td>
                          <td>{v.meta?.ppl?.toFixed(3) ?? "—"}</td>
                          <td>{(v.acc * 100).toFixed(1)}%</td>
                          <td>
                            v{ev(v)} (
                            {v.meta?.eval_n ?? (ev(v) === 1 ? 250 : "—")})
                          </td>
                          <td>{v.n_updates}</td>
                          <td>
                            {(v.verifiers ?? [])
                              .map((x) =>
                                x.trusted ? "CI" : en ? "node" : "węzeł",
                              )
                              .join(", ") || "—"}
                          </td>
                          <td>{fmtTime(v.created_at, lang)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
