"""Wiersz poleceń: ``python -m iot_mycelium <komenda>``.

Zastępuje rozproszone skrypty (``main.py``, ``demo_agent.py``,
``demo_agent_fixed.py``, bloki ``__main__`` w modułach).
"""

from __future__ import annotations

import argparse
import asyncio
import subprocess
import sys
from pathlib import Path

from iot_mycelium.paths import data_dir, logs_dir
from iot_mycelium.tasks import CORE_TASKS, TaskFactory
from iot_mycelium.universal_agent import ACTIVATIONS, OPTIMIZERS


def cmd_tasks(_: argparse.Namespace) -> int:
    for key, info in TaskFactory.list_tasks().items():
        task = TaskFactory.get_task(key)
        core = "★" if key in CORE_TASKS else " "
        print(f"{core} {key:<22} {info['difficulty']:<7} {task.input_dim}→{task.output_dim}  {info['description']}")
    print("\n★ = 8 zadań rdzenia (pokryte testami)")
    return 0


def cmd_train(args: argparse.Namespace) -> int:
    from iot_mycelium.universal_agent import UniversalAgent

    task = TaskFactory.get_task(args.task)
    agent = UniversalAgent(
        task,
        hidden_dim=args.hidden,
        learning_rate=args.lr,
        seed=args.seed,
        optimizer=args.optimizer,
        activation=args.activation,
        batch_size=args.batch_size,
    )
    agent.train(epochs=args.epochs, verbose=True, save_interval=max(args.epochs // 5, 1))
    result = agent.evaluate(verbose=True)
    return 0 if result["accuracy"] >= 0.95 else 1


def cmd_evolve(args: argparse.Namespace) -> int:
    from iot_mycelium.auto_evolution import ContinuousEvolutionSystem

    tasks = args.tasks or list(CORE_TASKS)
    system = ContinuousEvolutionSystem(
        task_names=tasks, max_attempts_per_task=args.max_attempts, epoch_scale=args.epoch_scale
    )
    results = system.run_full_evolution(progress_callback=print)
    print(f"\nOpanowane: {len(results['tasks_mastered'])}/{len(tasks)} w {results['total_time']:.1f}s")
    print(f"Zapisano: {results.get('saved_to')}")
    return 0


def cmd_iq(args: argparse.Namespace) -> int:
    from iot_mycelium.iq_calculator import AgentIQCalculator
    from iot_mycelium.universal_agent import UniversalAgent

    agent = UniversalAgent(TaskFactory.get_task(args.task), hidden_dim=args.hidden, seed=args.seed)
    agent.train(epochs=args.epochs, verbose=False)
    iq = AgentIQCalculator(seed=args.seed).calculate_iq(agent)
    print(f"IQ: {iq['total_iq']}/{iq['max_iq']}  etap: {iq['stage']['name']}")
    for name, score in iq["breakdown"].items():
        print(f"  {name:<20} {score}/{iq['max_scores'][name]}")
        for task, d in iq["heldout"].get(name, {}).items():
            print(
                f"      {task:<20} held-out {d['heldout_accuracy']:.2f}  losowo {d['baseline_accuracy']:.2f}"
                f"  → {d['score']:.2f}"
            )
    return 0


def cmd_simulate(args: argparse.Namespace) -> int:
    from iot_mycelium.iot_orchestrator import main as simulate

    asyncio.run(simulate(num_devices=args.devices, duration_seconds=args.duration, epochs=args.epochs))
    return 0


def cmd_demo_xor(args: argparse.Namespace) -> int:
    from iot_mycelium.optimized_agent import OptimizedXORAgent

    agent = OptimizedXORAgent(hidden_dim=args.hidden, learning_rate=0.5)
    agent.train(epochs=args.epochs, save_interval=max(args.epochs // 10, 1))
    out = logs_dir()
    agent.visualize_training(str(out / "optimized_training_curves.png"))
    agent.visualize_network(str(out / "optimized_network_architecture.png"))
    agent.save_training_data(str(data_dir() / "optimized_training_results.json"))
    return 0


def cmd_dashboard(_: argparse.Namespace) -> int:
    script = Path(__file__).resolve().parents[1] / "dashboard.py"
    return subprocess.call([sys.executable, "-m", "streamlit", "run", str(script)])


def cmd_ai_bench(args: argparse.Namespace) -> int:
    import json

    from .ai.orchestrator import Budget, Orchestrator

    budget = Budget.quick() if args.quick else Budget()
    res = Orchestrator(
        tasks=tuple(args.tasks) if args.tasks else Orchestrator().tasks,
        budget=budget,
        synthetic=True if args.synthetic else None,
        fresh_memory=args.fresh_memory,
    ).run(federated=not args.no_federated, on_event=lambda k, d: print(k, d, flush=True))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(res, ensure_ascii=False, default=str))
    from .ai.history import append

    if append(res, out.parent / "ai_history.jsonl"):
        print(f"punkt historii → {out.parent / 'ai_history.jsonl'}")
    print(f"MBS {res['mbs']} (liniowy {res['mbs_linear']}) → {out}")
    return 0


def cmd_ai_serve(args: argparse.Namespace) -> int:
    import uvicorn

    uvicorn.run("iot_mycelium.ai.api:app", host=args.host, port=args.port)
    return 0


def cmd_ai_mqtt(args: argparse.Namespace) -> int:
    from .ai.mqtt import serve

    serve(args.host, args.port, tls=args.tls, rate=args.rate)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="iot_mycelium", description="IoT Agents z pamięcią Mycelium")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("tasks", help="lista zadań").set_defaults(func=cmd_tasks)

    p = sub.add_parser("train", help="trening jednego agenta")
    p.add_argument("task", choices=TaskFactory.task_names())
    p.add_argument("--hidden", type=int, default=16)
    p.add_argument("--lr", type=float, default=0.1)
    p.add_argument("--epochs", type=int, default=4000)
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--optimizer", choices=OPTIMIZERS, default="adam")
    p.add_argument("--activation", choices=ACTIVATIONS, default="leaky_relu")
    p.add_argument("--batch-size", type=int, default=None, help="mini-batch (tylko Adam)")
    p.set_defaults(func=cmd_train)

    p = sub.add_parser("evolve", help="Auto-Evolution (domyślnie 8 zadań rdzenia)")
    p.add_argument("--tasks", nargs="*", choices=TaskFactory.task_names())
    p.add_argument("--max-attempts", type=int, default=12)
    p.add_argument("--epoch-scale", type=float, default=1.0)
    p.set_defaults(func=cmd_evolve)

    p = sub.add_parser("iq", help="IQ agenta wytrenowanego na zadaniu")
    p.add_argument("task", choices=TaskFactory.task_names())
    p.add_argument("--hidden", type=int, default=16)
    p.add_argument("--epochs", type=int, default=3000)
    p.add_argument("--seed", type=int, default=0)
    p.set_defaults(func=cmd_iq)

    p = sub.add_parser("simulate", help="symulacja ruchu IoT (asyncio)")
    p.add_argument("--devices", type=int, default=5)
    p.add_argument("--duration", type=float, default=30.0)
    p.add_argument("--epochs", type=int, default=2000)
    p.set_defaults(func=cmd_simulate)

    p = sub.add_parser("demo-xor", help="demo agenta XOR + wykresy w logs/")
    p.add_argument("--hidden", type=int, default=4)
    p.add_argument("--epochs", type=int, default=20000)
    p.set_defaults(func=cmd_demo_xor)

    sub.add_parser("dashboard", help="uruchom dashboard Streamlit").set_defaults(func=cmd_dashboard)

    p = sub.add_parser("ai-bench", help="benchmark prawdziwego AI (PyTorch, prawdziwe dane, federacja)")
    p.add_argument("--out", default="results/ai_benchmark.json")
    p.add_argument("--tasks", nargs="*")
    p.add_argument("--quick", action="store_true", help="mały budżet (testy/CI)")
    p.add_argument("--synthetic", action="store_true", help="dane syntetyczne zamiast pobierania")
    p.add_argument("--no-federated", action="store_true")
    p.add_argument("--fresh-memory", action="store_true", help="nie używaj zapisanej pamięci wektorowej")
    p.set_defaults(func=cmd_ai_bench)

    p = sub.add_parser("ai-serve", help="API FastAPI (REST + WebSocket)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.set_defaults(func=cmd_ai_serve)

    p = sub.add_parser("ai-mqtt", help="agent prognoz przez MQTT (mosquitto)")
    p.add_argument("--host", default="localhost")
    p.add_argument("--port", type=int, default=1883)
    p.add_argument("--tls", action="store_true", help="TLS do brokera (login: MQTT_USERNAME/MQTT_PASSWORD)")
    p.add_argument("--rate", type=float, default=5.0, help="maks. wiadomości/s na urządzenie")
    p.set_defaults(func=cmd_ai_mqtt)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
