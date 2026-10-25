"""Węzeł nasienny (PyTorch, CPU): trenuje ulepszoną architekturę na TYCH SAMYCH odłamkach treningowych co przeglądarki
(web/public/data/ml), mierzy na walidacji i stałym teście, eksportuje wagi w układzie TF.js (płaski float32).

Użycie: python scripts/seed_train.py fashion --arch cnn3 --epochs 30 --out /tmp/fashion.bin
Bez danych syntetycznych: tylko odłamki z export_ml_shards.py / export_embeddings.py.
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

ROOT = Path(__file__).resolve().parents[1]
ML = Path(os.environ.get("MYC_OUT", ROOT / "web" / "public" / "data" / "ml"))


def load(m: str, md: dict, part: str) -> tuple[np.ndarray, np.ndarray]:
    u = (ML / m / f"{part}.bin").read_bytes()
    if md["format"] == "sparse":
        xs, ys, o = [], [], 0
        while o < len(u):
            y, n = struct.unpack_from("<HH", u, o)
            idx = struct.unpack_from(f"<{n}H", u, o + 4)
            v = np.zeros(md["dim"], np.float32)
            v[list(idx)] = 1
            xs.append(v)
            ys.append(y)
            o += 4 + 2 * n
        return np.stack(xs), np.array(ys)
    rec = md["dim"] + 1
    a = np.frombuffer(u, np.uint8).reshape(-1, rec)
    x = a[:, : md["dim"]]
    x = x.astype(np.float32) / 255 if md["format"] == "dense-u8" else x.view(np.int8).astype(np.float32) / 127
    return x, a[:, md["dim"]].astype(np.int64)


class TfSeq(nn.Module):
    """Sekwencja warstw odpowiadająca budowie modelu w engine.worker.ts (te same kształty i kolejność wag)."""

    def __init__(self, layers: list, in_shape: list[int]):
        super().__init__()
        self.spec = layers
        mods, c, h, w, flat = [], in_shape[-1], in_shape[0], in_shape[1] if len(in_shape) > 1 else 0, None
        self.image = len(in_shape) == 3
        if not self.image:
            flat = in_shape[0]
        for L in layers:
            t = L["t"]
            if t == "conv":
                pad = 1 if L.get("same") else 0
                mods.append(nn.Conv2d(c, L["f"], 3, padding=pad))
                c, h, w = L["f"], h + 2 * pad - 2, w + 2 * pad - 2
            elif t == "pool":
                mods.append(nn.MaxPool2d(2))
                h, w = h // 2, w // 2
            elif t == "bn":
                mods.append(
                    nn.BatchNorm2d(c, eps=1e-3, momentum=0.01)
                    if flat is None
                    else nn.BatchNorm1d(flat, eps=1e-3, momentum=0.01)
                )
            elif t == "flatten":
                mods.append(nn.Flatten())
                flat = c * h * w
            elif t == "drop":
                mods.append(nn.Dropout(L["r"]))
            elif t == "dense":
                mods.append(nn.Linear(flat, L["u"]))
                flat = L["u"]
            else:
                raise ValueError(t)
        self.mods = nn.ModuleList(mods)

    def forward(self, x):
        if self.image:
            x = x.view(-1, 28, 28, 1).permute(0, 3, 1, 2)
        for L, mod in zip(self.spec, self.mods, strict=True):
            x = x.permute(0, 2, 3, 1).flatten(1) if L["t"] == "flatten" else mod(x)  # flatten: NHWC jak w TF.js
            if L.get("relu"):
                x = F.relu(x)
        return x

    def tf_flat(self) -> np.ndarray:
        out = []
        for L, mod in zip(self.spec, self.mods, strict=True):
            if L["t"] == "conv":
                out += [mod.weight.detach().permute(2, 3, 1, 0).numpy(), mod.bias.detach().numpy()]
            elif L["t"] == "dense":
                out += [mod.weight.detach().T.numpy(), mod.bias.detach().numpy()]
            elif L["t"] == "bn":
                out += [
                    mod.weight.detach().numpy(),
                    mod.bias.detach().numpy(),
                    mod.running_mean.numpy(),
                    mod.running_var.numpy(),
                ]
        return np.concatenate([o.astype(np.float32).ravel() for o in out])


def augment(x: torch.Tensor) -> torch.Tensor:
    # przesunięcie o ±2 px (pad + losowe wycięcie) i odbicie poziome – te same co w przeglądarce
    n = x.shape[0]
    img = F.pad(x.view(n, 1, 28, 28), (2, 2, 2, 2))
    dx, dy = torch.randint(0, 5, (2,))
    img = img[:, :, dy : dy + 28, dx : dx + 28]
    flip = torch.rand(n) < 0.5
    img[flip] = img[flip].flip(-1)
    return img.reshape(n, 784)


def acc(model, x, y) -> float:
    model.eval()
    with torch.no_grad():
        return float((model(torch.from_numpy(x)).argmax(1).numpy() == y).mean())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--wd", type=float, default=1e-4)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--smooth", type=float, default=0.1)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    torch.manual_seed(a.seed)
    meta = json.loads((ML / "meta.json").read_text())
    md = meta[a.model]
    arch = md["arch"]
    parts = [load(a.model, md, f"train-{i:02d}") for i in range(md["shards"])]
    xtr, ytr = np.concatenate([p[0] for p in parts]), np.concatenate([p[1] for p in parts])
    xv, yv = load(a.model, md, "val")
    xt, yt = load(a.model, md, "test")
    model = TfSeq(arch["layers"], md.get("shape") or [md["dim"]])
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=a.wd)
    steps = a.epochs * ((len(xtr) + a.batch - 1) // a.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=steps, pct_start=0.15)
    X, Y = torch.from_numpy(xtr), torch.from_numpy(ytr)
    best = (-1.0, None, 0)
    t0 = time.time()
    for ep in range(a.epochs):
        model.train()
        p = torch.randperm(len(X))
        for i in range(0, len(X), a.batch):
            b = p[i : i + a.batch]
            xb = augment(X[b]) if a.model == "fashion" else X[b]
            loss = F.cross_entropy(model(xb), Y[b], label_smoothing=a.smooth)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
        v = acc(model, xv, yv)
        if v >= best[0]:
            best = (v, {k: t.clone() for k, t in model.state_dict().items()}, ep)
        print(f"ep {ep + 1} loss {loss.item():.3f} val {v:.4f} ({time.time() - t0:.0f}s)", flush=True)
    model.load_state_dict(best[1])
    v, t = acc(model, xv, yv), acc(model, xt, yt)
    flat = model.tf_flat()
    print(
        json.dumps(
            {
                "model": a.model,
                "arch": arch["id"],
                "val": round(v, 4),
                "test": round(t, 4),
                "best_epoch": best[2] + 1,
                "params": int(flat.size),
                "train_n": int(len(X)),
            }
        )
    )
    if a.out:
        a.out.write_bytes(flat.tobytes())


if __name__ == "__main__":
    main()
