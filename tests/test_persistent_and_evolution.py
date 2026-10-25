import json

from iot_mycelium.auto_evolution import AutoEvolutionSystem, ContinuousEvolutionSystem, load_evolution_history
from iot_mycelium.persistent_agent import PersistentAgent, get_persistent_agent, list_all_agents


def test_persistent_agent_survives_restart(isolated_data_dir):
    agent = get_persistent_agent("xor", 8, 0.3)
    first = agent.continue_training(epochs=500)
    assert agent.save_path.exists()
    assert agent.save_path.is_relative_to(isolated_data_dir)
    w_before = agent.agent.get_weights()["W1"]

    PersistentAgent.clear_cache()  # symulacja nowego procesu
    reloaded = get_persistent_agent("xor", 8, 0.3)
    assert reloaded is not agent
    assert len(reloaded.training_sessions) == 1
    assert reloaded.total_epochs == first["epochs_trained"]
    assert (reloaded.agent.get_weights()["W1"] == w_before).all()

    reloaded.continue_training(epochs=300)
    assert reloaded.get_learning_stats()["total_sessions"] == 2


def test_list_all_agents_parses_task_names_with_underscores():
    get_persistent_agent("3bit_parity", 6, 0.2).continue_training(epochs=200)
    agents = list_all_agents()
    assert agents["3bit_parity_6_0.2"]["task_name"] == "3bit_parity"
    assert agents["3bit_parity_6_0.2"]["hidden_dim"] == 6


def test_evolve_step_trains_and_reports():
    system = ContinuousEvolutionSystem(task_names=["and"], epoch_scale=0.5)
    step = system.evolve_step("and", attempt=1)
    assert step["task_name"] == "and"
    assert 0.0 <= step["final_accuracy"] <= 1.0
    assert step["epochs"] >= system.MIN_EPOCHS
    assert "error" not in step


def test_evolve_step_error_does_not_crash(monkeypatch):
    import iot_mycelium.auto_evolution as evo

    def boom(*_a, **_k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(evo, "get_persistent_agent", boom)
    step = ContinuousEvolutionSystem(task_names=["and"]).evolve_step("and")
    assert step["success"] is False and step["error"] == "disk full"


def test_full_evolution_masters_easy_tasks_and_saves(isolated_data_dir):
    system = ContinuousEvolutionSystem(task_names=["and", "or", "xor"], max_attempts_per_task=6, epoch_scale=0.5)
    messages = []
    results = system.run_full_evolution(progress_callback=messages.append)
    assert set(results["tasks_mastered"]) == {"and", "or", "xor"}
    assert results["total_sessions"] >= 3
    assert messages
    with open(results["saved_to"]) as f:
        saved = json.load(f)
    assert saved["tasks_mastered"] == results["tasks_mastered"]
    assert load_evolution_history()[0]["start_time"] == results["start_time"]
    summary = system.get_optimization_summary()
    assert set(summary) == {"and", "or", "xor"}
    assert summary["xor"]["optimal_params"]["hidden_dim"] in system.strategy_for("xor")["hidden_dims"]


def test_backwards_compatible_alias():
    assert AutoEvolutionSystem is ContinuousEvolutionSystem


def test_training_other_architecture_keeps_previous_slot():
    from iot_mycelium.memory import MyceliumMemory

    xor = get_persistent_agent("xor", 16, 0.1)
    xor.continue_training(epochs=500)
    xor_shapes = xor.agent.get_weight_shapes()
    loss_before = MyceliumMemory().get_best_loss(xor_shapes)
    get_persistent_agent("majority", 16, 0.1).continue_training(epochs=500)  # wejście 3 → inny kształt
    mem = MyceliumMemory()
    assert mem.get_best_loss(xor_shapes) == loss_before
    assert mem.get_stats()["slots"] == 2
