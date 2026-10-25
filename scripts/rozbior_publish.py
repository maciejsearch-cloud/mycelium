"""Zgłoszenie wersji modelu rozbioru jako kandydata (np. v0 wytrenowanej centralnie na train UD).

Liczy role-F1 / UPOS / cechy / LAS na teście UD (numpy – ten sam kod co węzły i weryfikator), wysyła plik do
Storage i wywołuje myc_rb_propose. Publikacja dopiero po niezależnym przeliczeniu (inny węzeł z innego IP albo
zaufany weryfikator CI: workflow „Weryfikacja kandydatów”). Wynik oceny → results/rozbior/v{N}-eval.json.

    python scripts/rozbior_publish.py --model rb-v0.bin --node <uuid węzła>
"""

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from iot_mycelium.mesh.lmwork import Supa  # noqa: E402
from iot_mycelium.mesh.rbwork import slim  # noqa: E402
from iot_mycelium.rozbior import model, zbior  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--node", required=True, help="uuid węzła zgłaszającego")
    ap.add_argument("--dry", action="store_true", help="tylko ocena, bez wysyłania")
    a = ap.parse_args()
    body = Path(a.model).read_bytes()
    H, W = model.load(body)
    meta = json.loads((zbior.DATA / "meta.json").read_text())
    gate = zbior.gate_sha(meta, (zbior.DATA / "parity.json").read_bytes())
    test = zbior.local("test-")
    t0 = time.perf_counter()
    m = zbior.evaluate(H, W, test)
    ms = int((time.perf_counter() - t0) * 1000)
    print(json.dumps({k: v for k, v in m.items() if k not in ("per_q", "per_feat")}, ensure_ascii=False))
    print(f"ocena {ms / 1000:.0f} s, odcisk bramki {gate[:12]}")
    sb = Supa()
    rows = sb.rpc("myc_rb_list", {"p_limit": 5}) or []
    pub = [r for r in rows if r["status"] == "published"]
    cur = max(pub, key=lambda r: r["version"]) if pub else None
    v = cur["version"] + 1 if cur else 0
    out = ROOT / "results" / "rozbior" / f"v{v}-eval.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {
                "file": Path(a.model).name,
                "sha256": hashlib.sha256(body).hexdigest(),
                "gate_sha": gate,
                "ms": ms,
                "test": m,
            },
            ensure_ascii=False,
            indent=1,
        )
    )
    if a.dry:
        return 0
    path = f"rozbior/v{v}-{hashlib.sha256(body).hexdigest()[:8]}.bin"
    sb.upload(path, body)
    r = sb.rpc(
        "myc_rb_propose",
        {"p_node": a.node, "p_path": path, "p_parent": cur["version"] if cur else None, "p_f1": m["role_f1"], "p_upos": m["upos"],
         "p_feats": m["feats"], "p_las": m["las"], "p_metrics": slim(m), "p_eval_n": len(test), "p_eval_sha": gate,
         "p_updates": [], "p_ms": ms},
    )  # fmt: skip
    print(path, r)
    return 0 if r and r.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
