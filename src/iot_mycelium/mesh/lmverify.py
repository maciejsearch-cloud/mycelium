"""Niezależna ocena modelu językowego grzybni – powtarzalna przez każdego.

    mycelium-node --verify-lm                 # oczekujący kandydaci (+ bazowa wersja po zmianie zbioru testowego)
    mycelium-node --verify-lm --version 3     # opublikowana wersja: porównaj z liczbami zapisanymi w bazie
    MYC_LM_VERIFIER_KEY=… mycelium-node --verify-lm --post   # zaufany weryfikator (CI): zgłoś wynik do bazy

Równolegle na k maszynach (CI): każda liczy swój odłamek pytań, ostatni krok składa i zgłasza wynik:
    mycelium-node --verify-lm --shard 0/6 --json part0.json      # … --shard 5/6
    mycelium-node --verify-lm --combine part*.json --post

Liczy to samo co węzły: perpleksję na odłożonych akapitach i trafność wyboru definicji (1 z 4) na stałym
pliku eval.bin (SHA-256 musi się zgadzać z bazą). Wagi bazowe: Qwen2.5-0.5B-Instruct (SHA-256 sprawdzana).
Po zmianie zbioru testowego (nowa wersja w myc_eval_sets) najpierw przelicza bieżącą opublikowaną wersję
– to nowy punkt odniesienia bramki (myc_rebase_lm); do tego czasu kandydaci czekają.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import torch

from . import lm
from .lmwork import Data, Supa
from .qwen import Qwen, ensure_weights


def _amx() -> bool:
    try:
        with open("/proc/cpuinfo") as f:
            return "amx_bf16" in f.read()
    except OSError:
        return False


def _todo(sb: Supa, version: int | None, es: dict) -> list[dict]:
    if version is not None:
        rows = sb.get(f"myc_models?model=eq.lm&version=eq.{version}&select=version,path,acc,meta")
        return [{"kind": "version", **r} for r in rows]
    todo = []
    cur = sb.get("myc_models?model=eq.lm&order=version.desc&limit=1&select=version,path,acc,meta")
    if cur and (cur[0].get("meta") or {}).get("eval_sha") != es["sha"]:
        todo.append({"kind": "rebase", **cur[0]})
    todo += [
        {"kind": "candidate", **r}
        for r in sb.get("myc_candidates?model=eq.lm&status=eq.pending&select=id,version,path,acc_claimed,meta,eval_sha")
    ]
    return todo


def _key(r: dict) -> str:
    return f"{r['kind']}:{r.get('id', r['version'])}"


def _post(sb: Supa, r: dict, e: dict, backend: str) -> dict:
    key = os.environ.get("MYC_LM_VERIFIER_KEY", "")
    if not key:
        raise SystemExit("brak MYC_LM_VERIFIER_KEY")
    if r["kind"] == "rebase":
        return sb.rpc(
            "myc_rebase_lm",
            {
                "p_key": key,
                "p_version": r["version"],
                "p_acc": e["acc"],
                "p_ppl": e["ppl"],
                "p_correct": e["correct"],
                "p_sha": e["eval_sha"],
                "p_n": e["n"],
                "p_backend": backend,
            },
        )
    return sb.rpc(
        "myc_reeval_trusted_lm",
        {
            "p_key": key,
            "p_candidate": r["id"],
            "p_acc": e["acc"],
            "p_ppl": e["ppl"],
            "p_sha": e["eval_sha"],
            "p_n": e["n"],
            "p_backend": backend,
        },
    )


def _record(r: dict, e: dict, s: float) -> dict:
    rec = {
        "kind": r["kind"],
        "version": r["version"],
        "path": r["path"],
        "acc": e["acc"],
        "ppl": e["ppl"],
        "correct": e["correct"],
        "n": e["n"],
        "eval_sha256": e["eval_sha"],
        "s": s,
    }
    if r["kind"] in ("version", "rebase"):
        rec.update(acc_stored=r["acc"], ppl_stored=(r.get("meta") or {}).get("ppl"))
    else:
        rec.update(acc_claimed=r["acc_claimed"], ppl_claimed=(r.get("meta") or {}).get("ppl"), candidate=r["id"])
    return rec


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="mycelium-node --verify-lm")
    ap.add_argument("--version", type=int, help="oceń opublikowaną wersję")
    ap.add_argument("--post", action="store_true", help="zgłoś wynik (wymaga MYC_LM_VERIFIER_KEY)")
    ap.add_argument("--threads", type=int, default=os.cpu_count() or 2)
    ap.add_argument("--json", help="zapisz wyniki do pliku JSON")
    ap.add_argument("--shard", help="i/k: policz tylko odłamek i z k (wynik częściowy do --combine)")
    ap.add_argument("--combine", nargs="+", metavar="PLIK", help="złóż wyniki odłamków i (z --post) zgłoś")
    ap.add_argument(
        "--dtype",
        choices=["auto", "bf16", "f32"],
        default="auto",
        help="auto: bf16 tylko z AMX (szybkie), inaczej f32 (bf16 bez AMX jest wielokrotnie wolniejsze)",
    )
    a = ap.parse_args(argv)
    sb = Supa()
    if a.combine:
        parts: dict[str, list] = {}
        for fn in a.combine:
            with open(fn) as f:
                for p in json.load(f):
                    parts.setdefault(p["key"], []).append(p)
        out = []
        for k, ps in parts.items():
            r = ps[0]["row"]
            try:
                e = lm.combine([p["part"] for p in ps])
            except ValueError as err:  # np. kandydat pojawił się w trakcie – policzy go następny przebieg
                print(f"{k}: pominięto ({err})")
                continue
            rec = _record(r, e, round(max(p["s"] for p in ps), 1))
            if a.post and r["kind"] != "version":
                rec["db"] = _post(sb, r, e, ps[0]["backend"] + f"-x{len(ps)}")
            print(json.dumps(rec, ensure_ascii=False), flush=True)
            out.append(rec)
        if a.json:
            with open(a.json, "w") as f:
                json.dump(out, f, ensure_ascii=False, indent=1)
        return 0
    data = Data()
    es = sb.get("myc_eval_sets?model=eq.lm&select=n,sha")[0]
    todo = _todo(sb, a.version, es)
    if not todo:
        print("brak kandydatów modelu językowego do oceny" if a.version is None else "nie ma takiej wersji")
        if a.json:
            with open(a.json, "w") as f:
                json.dump([], f)
        return 0
    eb = data.eval_bytes()
    if lm.sha256(eb) != es["sha"]:
        print(f"eval.bin: SHA-256 {lm.sha256(eb)} ≠ baza {es['sha']}")
        return 2
    shard = None
    if a.shard:
        i, k = (int(x) for x in a.shard.split("/"))
        if not 0 <= i < k:
            ap.error("--shard i/k: 0 ≤ i < k")
        shard = (i, k)
    torch.set_num_threads(a.threads)
    dt = a.dtype if a.dtype != "auto" else ("bf16" if _amx() else "f32")
    backend = f"torch-{dt}"
    print(f"obliczenia: {dt}, {a.threads} wątków, odłamek {a.shard or 'całość'}", flush=True)
    m = Qwen(ensure_weights(), torch.bfloat16 if dt == "bf16" else torch.float32)
    out = []
    for r in todo:
        b = sb.public(r["path"])
        if not r["path"].endswith(f"-{lm.sha256(b)[:8]}.bin"):
            print(f"{r['path']}: suma pliku nie zgadza się ze ścieżką")
            continue
        t0 = time.perf_counter()
        e = lm.evaluate(m, lm.Lora.from_bytes(b).roundtrip(), eb, shard=shard)
        s = round(time.perf_counter() - t0, 1)
        if shard:
            rec = {"key": _key(r), "row": r, "part": e, "s": s, "backend": backend}
            print(f"{_key(r)} odłamek {a.shard}: {e['correct']}/{e['n_part']} trafnych, {s} s", flush=True)
        else:
            rec = _record(r, e, s)
            rec["adapter_sha256"] = lm.sha256(b)
            if a.post and r["kind"] != "version":
                rec["db"] = _post(sb, r, e, backend)
            print(json.dumps(rec, ensure_ascii=False), flush=True)
        out.append(rec)
    if a.json:
        with open(a.json, "w") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
