"""REST + WebSocket API Mycelium AI (FastAPI). Frontend w trybie „na żywo” czyta ``/api/snapshot``.

uvicorn iot_mycelium.ai.api:app --port 8000      # albo: python -m iot_mycelium ai-serve
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from collections import deque
from pathlib import Path
from typing import Any

import numpy as np
import torch
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, FiniteFloat

from .datasets import encode_text
from .orchestrator import Budget, Orchestrator, ai_home, load_model
from .vector_memory import VectorMemory

ROOT = Path(__file__).resolve().parents[3]


def results_path() -> Path:
    return Path(os.environ.get("IOT_MYCELIUM_AI_RESULTS", ai_home() / "ai_benchmark.json"))


class IntentIn(BaseModel):
    text: str = Field(min_length=1, max_length=500)


class WindowIn(BaseModel):
    values: list[FiniteFloat] = Field(min_length=2, max_length=512)


MAX_EVENTS = 1000  # ostatnie zdarzenia treningu trzymane dla /ws


class _State:
    def __init__(self) -> None:
        self.models: dict[str, tuple[torch.nn.Module, dict[str, Any]]] = {}
        self.run_lock = threading.Lock()
        self.events: deque[tuple[int, dict[str, Any]]] = deque(maxlen=MAX_EVENTS)
        self.seq = 0
        self.running = False

    def emit(self, event: dict[str, Any]) -> None:
        self.seq += 1
        self.events.append((self.seq, event))

    def model(self, name: str) -> tuple[torch.nn.Module, dict[str, Any]]:
        if name not in self.models:
            got = load_model(name)
            if got is None:
                raise HTTPException(404, f"brak wytrenowanego modelu {name!r} – uruchom ai-bench")
            self.models[name] = got
        return self.models[name]


state = _State()
app = FastAPI(title="Mycelium AI", version="0.3.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get(
        "IOT_MYCELIUM_CORS", "https://maciejsearch-cloud.github.io,http://localhost:5173"
    ).split(","),
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "running": state.running, "results": results_path().exists()}


@app.get("/api/ai/results")
def results() -> dict[str, Any]:
    p = results_path()
    if not p.exists():
        raise HTTPException(404, "brak wyników – uruchom ai-bench")
    return json.loads(p.read_text())


@app.get("/api/snapshot")
def snapshot() -> dict[str, Any]:
    """Nagrany snapshot frontendu z podmienioną sekcją ``ai`` na najświeższe wyniki."""
    snap_p = ROOT / "web" / "public" / "data" / "snapshot.json"
    snap = json.loads(snap_p.read_text()) if snap_p.exists() else {}
    if results_path().exists():
        snap["ai"] = json.loads(results_path().read_text())
    return snap


@app.get("/api/ai/memory")
def memory(limit: int = 20) -> dict[str, Any]:
    mem = VectorMemory(ai_home() / "memory")
    return {"size": len(mem), "records": mem.records()[-max(1, min(limit, 200)) :]}


@app.post("/api/ai/intent")
def intent(body: IntentIn) -> dict[str, Any]:
    model, ck = state.model("intents")
    with torch.no_grad():
        p = torch.softmax(model(torch.from_numpy(encode_text([body.text]))), 1)[0]
    top = torch.topk(p, 3)
    names = ck.get("class_names") or []
    return {
        "text": body.text,
        "top": [
            {"intent": names[i] if i < len(names) else str(i), "p": round(float(v), 4)}
            for v, i in zip(top.values.tolist(), top.indices.tolist())
        ],
    }


@app.post("/api/ai/forecast")
def forecast(body: WindowIn) -> dict[str, Any]:
    model, ck = state.model("sensor_forecast")
    w = ck["input_shape"][0]
    v = np.asarray(body.values[-w:], dtype=np.float32)
    if len(v) < w:
        v = np.pad(v, (w - len(v), 0), mode="edge")
    mu, sd = float(v.mean()), float(v.std()) or 1.0
    with torch.no_grad():
        y = float(model(torch.from_numpy(((v - mu) / sd)[None])).reshape(-1)[0])
    return {"next": y * sd + mu, "window": w}


def _run_bench(quick: bool) -> None:
    try:
        state.running = True
        res = Orchestrator(budget=Budget.quick() if quick else Budget()).run(
            on_event=lambda kind, data: state.emit({"type": kind, **data})
        )
        results_path().parent.mkdir(parents=True, exist_ok=True)
        results_path().write_text(json.dumps(res, ensure_ascii=False, default=str))
        state.models.clear()
    finally:
        state.running = False
        state.run_lock.release()


@app.post("/api/ai/runs", status_code=202)
def start_run(quick: bool = True) -> dict[str, Any]:
    if os.environ.get("IOT_MYCELIUM_ALLOW_RUNS") != "1":
        raise HTTPException(403, "uruchamianie treningu przez API wyłączone (IOT_MYCELIUM_ALLOW_RUNS=1)")
    if not state.run_lock.acquire(blocking=False):
        raise HTTPException(409, "trening już trwa")
    threading.Thread(target=_run_bench, args=(quick,), daemon=True).start()
    return {"started": True, "quick": quick}


@app.websocket("/ws")
async def ws(sock: WebSocket) -> None:
    """Strumień zdarzeń treningu (agent_start / agent_done / federated_done)."""
    await sock.accept()
    sent = state.seq
    try:
        await sock.send_json({"type": "hello", "running": state.running})
        while True:
            for seq, event in list(state.events):
                if seq > sent:
                    await sock.send_json({"seq": seq, **event})
                    sent = seq
            await asyncio.sleep(0.5)
    except WebSocketDisconnect:
        return
