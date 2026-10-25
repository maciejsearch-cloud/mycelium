"""Architektury PyTorch budowane z opisu :class:`ModelSpec` (łatwe do mutowania w neuroewolucji)."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
from typing import Any

import torch
from torch import nn

from iot_mycelium.ai.datasets import TEXT_BUCKETS, TaskData

ARCHS = ("mlp", "cnn", "text", "gru")
ACTIVATIONS: dict[str, type[nn.Module]] = {
    "relu": nn.ReLU,
    "gelu": nn.GELU,
    "leaky_relu": nn.LeakyReLU,
    "tanh": nn.Tanh,
}


@dataclass(frozen=True)
class ModelSpec:
    """Opis architektury. ``hidden`` = szerokości warstw w pełni połączonych."""

    arch: str = "mlp"
    hidden: tuple[int, ...] = (128,)
    activation: str = "relu"
    dropout: float = 0.1
    channels: tuple[int, ...] = (16, 32)  # cnn
    emb_dim: int = 64  # text
    rnn_hidden: int = 32  # gru

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["hidden"] = list(self.hidden)
        d["channels"] = list(self.channels)
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ModelSpec:
        d = dict(d)
        d["hidden"] = tuple(d.get("hidden", ()))
        d["channels"] = tuple(d.get("channels", (16, 32)))
        return cls(**d)

    def with_(self, **kw: Any) -> ModelSpec:
        return replace(self, **kw)

    def label(self) -> str:
        core = {"cnn": f"cnn{list(self.channels)}", "text": f"emb{self.emb_dim}", "gru": f"gru{self.rnn_hidden}"}.get(
            self.arch, "mlp"
        )
        return f"{core}-{'x'.join(map(str, self.hidden)) or 'linear'}-{self.activation}-d{self.dropout:g}"


DEFAULT_SPECS: dict[str, ModelSpec] = {
    "har": ModelSpec("mlp", (256, 128), "relu", 0.2),
    "fashion_mnist": ModelSpec("cnn", (128,), "relu", 0.25, channels=(16, 32)),
    "intents": ModelSpec("text", (256,), "relu", 0.2, emb_dim=96),
    "sensor_forecast": ModelSpec("mlp", (64, 32), "gelu", 0.0),
}


def _mlp(in_dim: int, hidden: tuple[int, ...], out_dim: int, act: str, dropout: float) -> nn.Sequential:
    layers: list[nn.Module] = []
    d = in_dim
    for h in hidden:
        layers += [nn.Linear(d, h), ACTIVATIONS[act]()]
        if dropout > 0:
            layers.append(nn.Dropout(dropout))
        d = h
    layers.append(nn.Linear(d, out_dim))
    return nn.Sequential(*layers)


class CNN(nn.Module):
    def __init__(self, spec: ModelSpec, in_shape: tuple[int, ...], out_dim: int):
        super().__init__()
        c, h, w = in_shape
        blocks: list[nn.Module] = []
        for ch in spec.channels:
            blocks += [
                nn.Conv2d(c, ch, 3, padding=1),
                nn.BatchNorm2d(ch),
                ACTIVATIONS[spec.activation](),
                nn.MaxPool2d(2),
            ]
            c, h, w = ch, h // 2, w // 2
        self.features = nn.Sequential(*blocks)
        self.head = _mlp(c * h * w, spec.hidden, out_dim, spec.activation, spec.dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.head(self.features(x).flatten(1))


class TextClassifier(nn.Module):
    """Średnia z osadzeń haszowanych n-gramów (fastText-like) + MLP."""

    def __init__(self, spec: ModelSpec, out_dim: int, buckets: int = TEXT_BUCKETS):
        super().__init__()
        self.emb = nn.Embedding(buckets, spec.emb_dim, padding_idx=0)
        self.head = _mlp(spec.emb_dim, spec.hidden, out_dim, spec.activation, spec.dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        mask = (x > 0).unsqueeze(-1).float()
        pooled = (self.emb(x) * mask).sum(1) / mask.sum(1).clamp(min=1.0)
        return self.head(pooled)


class GRUForecaster(nn.Module):
    def __init__(self, spec: ModelSpec):
        super().__init__()
        self.rnn = nn.GRU(1, spec.rnn_hidden, batch_first=True)
        self.head = _mlp(spec.rnn_hidden, spec.hidden, 1, spec.activation, spec.dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out, _ = self.rnn(x.unsqueeze(-1))
        return self.head(out[:, -1])


class Forecaster(nn.Module):
    """MLP na oknie + połączenie rezydualne z ostatnim odczytem (model uczy się zmiany)."""

    def __init__(self, spec: ModelSpec, window: int):
        super().__init__()
        self.net = _mlp(window, spec.hidden, 1, spec.activation, spec.dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x) + x[:, -1:]


def build_model(spec: ModelSpec, task: TaskData, seed: int | None = 0) -> nn.Module:
    if seed is not None:
        torch.manual_seed(seed)
    out = task.n_classes if task.kind == "classification" else 1
    if spec.arch == "cnn":
        if task.input_kind != "image":
            raise ValueError("cnn wymaga obrazów")
        return CNN(spec, task.input_shape, out)
    if spec.arch == "text":
        return TextClassifier(spec, out)
    if spec.arch == "gru":
        if task.kind != "forecasting":
            raise ValueError("gru obsługuje szeregi czasowe")
        return GRUForecaster(spec)
    if task.kind == "forecasting":
        return Forecaster(spec, task.input_shape[0])
    return nn.Sequential(
        nn.Flatten(), _mlp(int(torch.tensor(task.input_shape).prod()), spec.hidden, out, spec.activation, spec.dropout)
    )


def compatible_archs(task: TaskData) -> tuple[str, ...]:
    if task.input_kind == "image":
        return ("cnn", "mlp")
    if task.input_kind == "text":
        return ("text",)
    if task.kind == "forecasting":
        return ("mlp", "gru")
    return ("mlp",)


def count_params(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters())


def model_bytes(model: nn.Module) -> int:
    return sum(t.numel() * t.element_size() for t in model.state_dict().values())


def default_spec(task_name: str) -> ModelSpec:
    return DEFAULT_SPECS.get(task_name, ModelSpec())


__all__ = [
    "ARCHS",
    "DEFAULT_SPECS",
    "ModelSpec",
    "build_model",
    "compatible_archs",
    "count_params",
    "default_spec",
    "field",
    "model_bytes",
]
