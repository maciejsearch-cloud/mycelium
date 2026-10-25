"""Streamlit Dashboard – trening, Auto-Evolution, IQ i podgląd grzybni w zakładkach."""

from __future__ import annotations

import time
from typing import Any

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from iot_mycelium.auto_evolution import ContinuousEvolutionSystem, load_evolution_history
from iot_mycelium.iq_calculator import AgentIQCalculator
from iot_mycelium.memory import MyceliumMemory
from iot_mycelium.network_visualizer import NetworkVisualizer
from iot_mycelium.persistent_agent import get_persistent_agent, list_all_agents
from iot_mycelium.tasks import CORE_TASKS, TaskFactory

CSS = """
<style>
  .main-header { font-size: 2.6rem; font-weight: 700; text-align: center; margin-bottom: 0.5rem; }
  .success-box { background:#d4edda; border-left:4px solid #28a745; padding:1rem; margin:1rem 0; }
  .warning-box { background:#fff3cd; border-left:4px solid #ffc107; padding:1rem; margin:1rem 0; }
</style>
"""


# --------------------------------------------------------------------- logika
def train_agent_sync(task_name: str, hidden_dim: int, learning_rate: float, epochs: int, alpha: float) -> dict:
    """Trening persistent agenta (kontynuuje od zapisanych wag)."""
    try:
        persistent = get_persistent_agent(task_name, hidden_dim, learning_rate, alpha=alpha)
        results = persistent.continue_training(epochs=epochs)
        results.update(persistent.get_learning_stats())
        results["task_name"] = task_name
        results["hidden_dim"] = hidden_dim
        results["agent"] = persistent.agent
        results["persistent_agent"] = persistent
        return results
    except Exception as exc:
        return {"error": str(exc), "task_name": task_name, "agent": None}


def calculate_agent_iq(agent: Any, seed: int | None = 0) -> dict:
    return AgentIQCalculator(seed=seed).calculate_iq(agent)


def mycelium() -> MyceliumMemory:
    return MyceliumMemory()


# ------------------------------------------------------------------- wykresy
def _line(y: list[float], title: str, color: str, y_range: list[float] | None = None) -> go.Figure:
    fig = go.Figure(go.Scatter(y=y, mode="lines", line=dict(color=color, width=2)))
    fig.update_layout(title=title, xaxis_title="Krok (x10 epok)", height=320, margin=dict(t=50, b=40))
    if y_range:
        fig.update_yaxes(range=y_range)
    return fig


# --------------------------------------------------------------------- zakładki
def render_training_tab(task_name: str) -> None:
    res = st.session_state.get("last_training")
    if not res:
        st.info("Ustaw parametry w panelu bocznym i kliknij **🏃 Trenuj Agenta**.")
        return
    if res.get("error"):
        st.error(f"Błąd treningu: {res['error']}")
        return

    agent = res["agent"]
    task = agent.task
    st.subheader(f"Wyniki: {res['task_name'].upper()} ({task.input_dim}→{res['hidden_dim']}→{task.output_dim})")
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Dokładność", f"{res['final_accuracy']:.3f}")
    c2.metric("Loss", f"{res['final_loss']:.6f}")
    c3.metric("Czas", f"{res['training_time']:.2f}s")
    c4.metric("Aktualizacja grzybni", "✅ TAK" if res["updated_mycelium"] else "⚪ NIE")

    if res["final_accuracy"] >= 0.95:
        st.markdown(
            f'<div class="success-box"><strong>✅ Sukces!</strong> Agent nauczył się zadania '
            f"<strong>{res['task_name'].upper()}</strong> ({res['final_accuracy']:.1%}).</div>",
            unsafe_allow_html=True,
        )
    else:
        st.markdown(
            f'<div class="warning-box"><strong>⚠️ Uwaga!</strong> Tylko {res["final_accuracy"]:.1%} dokładności. '
            "Trenuj dalej (agent pamięta postęp), zwiększ epoki lub neurony ukryte.</div>",
            unsafe_allow_html=True,
        )

    c1, c2 = st.columns(2)
    c1.plotly_chart(_line(agent.loss_history, "Krzywa straty", "#ff6b6b"), width="stretch")
    c2.plotly_chart(_line(agent.accuracy_history, "Dokładność", "#51cf66", [0, 1.05]), width="stretch")

    st.markdown("### 🎯 Predykcje")
    ev = agent.evaluate(verbose=False)
    df = pd.DataFrame(
        {
            "Wejście": [str([round(v, 2) for v in x]) for x in agent.X.tolist()],
            "Oczekiwane": [str(r) for r in agent.y.astype(int).tolist()],
            "Predykcja (raw)": [str(np.round(r, 3).tolist()) for r in ev["raw_predictions"]],
            "Predykcja": [str(r) for r in ev["predictions"].tolist()],
            "Poprawne": (ev["predictions"] == agent.y).all(axis=1).tolist(),
        }
    )
    st.dataframe(df, width="stretch", hide_index=True)

    stats = res["persistent_agent"].get_learning_stats()
    st.markdown("### 📊 Statystyki uczenia (wszystkie sesje)")
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("🎓 Sesje", stats["total_sessions"])
    c2.metric("⏱️ Łączny czas", f"{stats['total_time']:.1f}s")
    c3.metric("🔁 Łącznie epok", stats["total_epochs"])
    c4.metric("Trend", stats["improvement_trend"])
    sessions = res["persistent_agent"].training_sessions
    if len(sessions) > 1:
        fig = go.Figure(
            go.Scatter(
                x=list(range(1, len(sessions) + 1)),
                y=[s["final_accuracy"] for s in sessions],
                mode="lines+markers",
            )
        )
        fig.update_layout(title="Dokładność w kolejnych sesjach", xaxis_title="Sesja", height=280)
        st.plotly_chart(fig, width="stretch")

    st.markdown("### 🧠 Sieć neuronowa")
    viz = NetworkVisualizer(task.input_dim, res["hidden_dim"], task.output_dim)
    c1, c2 = st.columns(2)
    if agent.activation_history:
        c1.plotly_chart(
            viz.create_network_plot(agent.get_weights(), agent.activation_history[-1], title="Aktualne wagi"),
            width="stretch",
        )
    if len(agent.weight_history) > 1:
        c2.plotly_chart(viz.create_weight_evolution_plot(agent.weight_history, "Ewolucja wag"), width="stretch")
    if agent.activation_history:
        st.plotly_chart(
            viz.create_activation_heatmap(agent.activation_history[-1], "Aktywacje neuronów"), width="stretch"
        )


def render_evolution_tab() -> None:
    st.markdown(
        "**Auto-Evolution** przeszukuje siatkę (neurony ukryte × learning rate) dla każdego zadania, "
        "aż agent osiągnie próg mistrzostwa. Agenci pamiętają postęp między uruchomieniami."
    )
    all_tasks = TaskFactory.task_names()
    c1, c2, c3 = st.columns([3, 1, 1])
    selected = c1.multiselect("Zadania", all_tasks, default=list(CORE_TASKS), key="evo_tasks")
    max_attempts = c2.number_input("Max prób / zadanie", 1, 50, 6, key="evo_attempts")
    scale = c3.selectbox("Tempo", [0.25, 0.5, 1.0], index=1, format_func=lambda v: f"{v:g}× epok", key="evo_scale")
    threshold = st.slider("Próg mistrzostwa (accuracy)", 0.8, 1.0, 0.98, 0.01, key="evo_threshold")

    if st.button("🚀 Start Auto-Evolution", type="primary", disabled=not selected, key="evo_start"):
        system = ContinuousEvolutionSystem(
            task_names=selected,
            mastery_threshold=threshold,
            max_attempts_per_task=int(max_attempts),
            epoch_scale=float(scale),
        )
        progress = st.progress(0.0, "Start…")
        with st.status("🤖 Auto-Evolution w toku…", expanded=True) as status:
            done = {"n": 0}

            def callback(message: str) -> None:
                if message.startswith(("✅", "❌")):
                    done["n"] += 1
                    progress.progress(done["n"] / len(selected), message)
                st.write(message)

            results = system.run_full_evolution(progress_callback=callback)
            status.update(label="✅ Auto-Evolution zakończone", state="complete", expanded=False)
        st.session_state["evolution_results"] = results
        st.session_state["evolution_summary"] = system.get_optimization_summary()

    results = st.session_state.get("evolution_results")
    if results:
        n_ok, n_all = len(results["tasks_mastered"]), len(results["evolution_log"])
        c1, c2, c3, c4 = st.columns(4)
        c1.metric("🎯 Opanowane", f"{n_ok}/{n_all}")
        c2.metric("⏱️ Czas", f"{results['total_time']:.1f}s")
        c3.metric("🎓 Próby", results["total_sessions"])
        c4.metric("📈 Sukces", f"{(n_ok / n_all * 100) if n_all else 0:.0f}%")
        rows = [
            {
                "Zadanie": log["task_name"],
                "Opanowane": log["success"],
                "Najlepsza dokładność": round(log["best_accuracy"], 3),
                "Próby": len(log["attempts"]),
                "Hidden": (log["optimal_params"] or {}).get("hidden_dim"),
                "LR": (log["optimal_params"] or {}).get("learning_rate"),
                "Epoki": (log["optimal_params"] or {}).get("epochs"),
                "Czas [s]": round(log["total_time"], 1),
            }
            for log in results["evolution_log"]
        ]
        st.dataframe(pd.DataFrame(rows), width="stretch", hide_index=True)

    history = load_evolution_history(limit=10)
    if history:
        with st.expander(f"📜 Historia przebiegów ({len(history)})"):
            st.dataframe(
                pd.DataFrame(
                    [
                        {
                            "Start": h.get("start_time", "")[:19],
                            "Opanowane": len(h.get("tasks_mastered", [])),
                            "Zadania": len(h.get("evolution_log", [])),
                            "Czas [s]": round(h.get("total_time", 0.0), 1),
                        }
                        for h in history
                    ]
                ),
                width="stretch",
                hide_index=True,
            )


def render_iq_tab() -> None:
    res = st.session_state.get("last_training")
    if not res or res.get("error"):
        st.info("Najpierw wytrenuj agenta w zakładce **Trening**, potem zmierz jego IQ.")
        return
    st.markdown(f"Agent: **{res['task_name'].upper()}** (hidden={res['hidden_dim']})")
    st.caption(
        "IQ mierzy UOGÓLNIANIE: agent o tej konfiguracji uczy się części tabeli prawdy i zgaduje "
        "pominięte wiersze (k-fold). Punkty = dokładność ponad poziom losowy. Umowna skala (max 110 pkt)."
    )
    if st.button("🧠 Oblicz IQ", type="primary", key="iq_button"):
        with st.spinner("Liczę IQ (walidacja krzyżowa na 11 zadaniach)…"):
            st.session_state["iq_results"] = calculate_agent_iq(res["agent"])
            st.session_state["iq_for"] = res["task_name"]
    iq = st.session_state.get("iq_results")
    if not iq:
        return
    c1, c2, c3 = st.columns(3)
    c1.metric("🧠 IQ", f"{iq['total_iq']}/{iq['max_iq']}")
    c2.metric("🎯 Etap", iq["stage"]["name"].upper())
    c3.metric("📈 Do następnego etapu", iq["next_stage_requirements"].get("needed_iq", 0))
    st.progress(float(iq["evolution_progress"]), f"Ogólny postęp: {iq['evolution_progress'] * 100:.1f}%")
    st.progress(float(iq["stage"]["progress"]), f"Postęp w etapie: {iq['stage']['progress'] * 100:.1f}%")
    fig = go.Figure(
        go.Bar(
            x=list(iq["breakdown"]),
            y=list(iq["breakdown"].values()),
            text=[f"{v}/{iq['max_scores'][k]}" for k, v in iq["breakdown"].items()],
            marker_color="#51cf66",
        )
    )
    fig.add_trace(go.Bar(x=list(iq["max_scores"]), y=list(iq["max_scores"].values()), opacity=0.2, name="max"))
    fig.update_layout(barmode="overlay", showlegend=False, title="Wyniki testów", height=320)
    st.plotly_chart(fig, width="stretch")
    rows = [
        {
            "Test": group,
            "Zadanie": task,
            "Dokładność (odłożone)": round(d["heldout_accuracy"], 3),
            "Poziom losowy": round(d["baseline_accuracy"], 3),
            "Wynik ponad losowy": round(d["score"], 3),
        }
        for group, tasks in iq.get("heldout", {}).items()
        for task, d in tasks.items()
    ]
    if rows:
        st.markdown("### Dane odłożone (held-out)")
        st.dataframe(pd.DataFrame(rows), width="stretch", hide_index=True)


def render_mycelium_tab(stats: dict, metadata: dict) -> None:
    myc = mycelium()
    if stats["is_empty"]:
        st.info("🍄 Grzybnia jest pusta. Wytrenuj pierwszego agenta!")
    else:
        st.markdown(
            "Każdy kształt sieci (wejścia × neurony ukryte × wyjścia) ma **własny slot**: "
            "agenci tej samej architektury dzielą się wagami, inne architektury nie kasują sobie pamięci."
        )
        c1, c2, c3 = st.columns(3)
        c1.metric("🧩 Sloty", stats["slots"])
        c2.metric("📉 Najlepszy loss (wszystkie sloty)", f"{stats['best_loss']:.6f}")
        c3.metric("🔄 Aktualizacje łącznie", stats["total_updates"])
        slots = pd.DataFrame(myc.list_slots())
        slots["best_loss"] = slots["best_loss"].map(lambda v: f"{v:.6f}")
        st.dataframe(
            slots.rename(
                columns={
                    "signature": "Kształt",
                    "best_loss": "Najlepszy loss",
                    "total_updates": "Aktualizacje",
                    "task_name": "Zadanie",
                    "accuracy": "Dokładność",
                    "best_agent_id": "Najlepszy agent",
                    "last_updated": "Ostatnia aktualizacja",
                }
            ),
            width="stretch",
            hide_index=True,
        )
        with st.expander("Metadane ostatniej aktualizacji"):
            st.json(
                {k: metadata.get(k) for k in ("last_slot", "best_agent_id", "task_name", "accuracy", "last_updated")}
            )
    st.caption(f"Plik pamięci: `{myc.memory_path}`")


def render_tasks_tab() -> None:
    rows = []
    for key, info in TaskFactory.list_tasks().items():
        task = TaskFactory.get_task(key)
        rows.append(
            {
                "Klucz": key,
                "Rdzeń": key in CORE_TASKS,
                "Kategoria": info["category"],
                "Trudność": info["difficulty"],
                "Wymiary": f"{task.input_dim}→{task.output_dim}",
                "Przykłady": len(task.X),
                "Opis": info["description"],
            }
        )
    st.markdown(f"### 📋 Zadania ({len(rows)})")
    st.dataframe(pd.DataFrame(rows), width="stretch", hide_index=True)

    agents = list_all_agents()
    st.markdown(f"### 💾 Zapisani agenci ({len(agents)})")
    if agents:
        st.dataframe(pd.DataFrame(agents.values()), width="stretch", hide_index=True)
    else:
        st.caption("Brak zapisanych agentów.")


# ------------------------------------------------------------------------ main
def main() -> None:
    st.set_page_config(page_title="IoT Agents Dashboard", page_icon="🍄", layout="wide")
    st.markdown(CSS, unsafe_allow_html=True)
    st.markdown('<h1 class="main-header">🍄 IoT Agents Dashboard</h1>', unsafe_allow_html=True)

    tasks_info = TaskFactory.list_tasks()
    with st.sidebar:
        st.header("⚙️ Konfiguracja")
        task_name = st.selectbox(
            "Wybierz zadanie",
            list(tasks_info),
            format_func=lambda x: f"{x.upper()} ({tasks_info[x]['difficulty']})",
            key="task",
        )
        st.info(f"**Opis:** {tasks_info[task_name]['description']}")
        st.subheader("Parametry treningu")
        hidden_dim = st.select_slider("Neurony ukryte", [2, 4, 8, 16, 32, 64], 16, key="hidden")
        learning_rate = st.select_slider("Learning rate (Adam)", [0.003, 0.01, 0.03, 0.1, 0.3], 0.1, key="lr")
        epochs = st.slider("Epoki", 500, 20000, 3000, 500, key="epochs")
        st.subheader("Mycelium Memory")
        alpha = st.slider(
            "Alpha (fusion)",
            0.0,
            1.0,
            0.7,
            0.1,
            key="alpha",
            help="Dotyczy nowych agentów: 0.0 = tylko losowe wagi, 1.0 = tylko wagi z grzybni",
        )
        train_clicked = st.button("🏃 Trenuj Agenta", type="primary", width="stretch", key="train")
        if st.button("🔄 Reset Grzybni", width="stretch", key="reset"):
            mycelium().reset()
            st.toast("✅ Grzybnia zresetowana")

    if train_clicked:
        with st.spinner(f"🏃 Trenuję agenta na zadaniu {task_name.upper()}…"):
            started = time.time()
            st.session_state["last_training"] = train_agent_sync(task_name, hidden_dim, learning_rate, epochs, alpha)
            st.session_state["last_training"]["wall_time"] = time.time() - started
            st.session_state.pop("iq_results", None)

    # Nagłówek wypełniamy na końcu, żeby pokazywał stan PO treningu / ewolucji w zakładkach.
    header = st.container()

    tabs = st.tabs(["🏃 Trening", "🤖 Auto-Evolution", "🧠 IQ", "🍄 Mycelium", "📋 Zadania i agenci"])
    with tabs[0]:
        render_training_tab(task_name)
    with tabs[1]:
        render_evolution_tab()
    with tabs[2]:
        render_iq_tab()
    with tabs[3]:
        mycelium_tab = st.container()
    with tabs[4]:
        render_tasks_tab()

    myc = mycelium()
    stats, metadata = myc.get_stats(), myc.get_metadata()
    with header:
        c1, c2, c3 = st.columns(3)
        c1.metric("🍄 Status grzybni", "Pusta" if stats["is_empty"] else "Aktywna")
        c2.metric("📉 Najlepszy loss", "N/A" if stats["is_empty"] else f"{stats['best_loss']:.6f}")
        c3.metric("🔄 Aktualizacje / sloty", f"{stats['total_updates']} / {stats['slots']}")
    with mycelium_tab:
        render_mycelium_tab(stats, metadata)

    st.markdown("---")
    st.caption("🤖 IoT Agents Project | Mycelium Memory Architecture | Python + NumPy")


if __name__ == "__main__":
    main()
