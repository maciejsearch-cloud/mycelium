import numpy as np
import pytest

from iot_mycelium.tasks import CORE_TASKS, TaskFactory
from iot_mycelium.universal_agent import UniversalAgent


@pytest.mark.parametrize("name", CORE_TASKS)
def test_agent_learns_core_task(name):
    task = TaskFactory.get_task(name)
    # Kilka ziaren: mała sieć ReLU czasem utyka (martwe neurony) – wystarczy, że
    # przynajmniej jedno z deterministycznych ziaren nauczy się zadania w 100%.
    accuracies = []
    for seed in range(3):
        agent = UniversalAgent(task, seed=seed)
        result = agent.train(epochs=4000, verbose=False)
        accuracies.append(result["final_accuracy"])
        if result["final_accuracy"] == 1.0:
            break
    assert max(accuracies) == 1.0, f"{name}: {accuracies}"
    assert agent.evaluate(verbose=False)["accuracy"] == 1.0


def test_training_is_deterministic_with_seed():
    task = TaskFactory.get_task("xor")
    r1 = UniversalAgent(task, hidden_dim=6, seed=7).train(epochs=500, verbose=False)
    r2 = UniversalAgent(task, hidden_dim=6, seed=7).train(epochs=500, verbose=False)
    assert r1["final_loss"] == r2["final_loss"]


def test_weight_history_entries_are_snapshots():
    agent = UniversalAgent(TaskFactory.get_task("xor"), hidden_dim=4, seed=0)
    agent.train(epochs=1500, verbose=False)
    assert len(agent.weight_history) >= 2
    # wcześniej wszystkie wpisy wskazywały na tę samą (mutowaną) tablicę
    assert not np.array_equal(agent.weight_history[0]["W1"], agent.weight_history[-1]["W1"])


def test_epochs_trained_reported_correctly():
    agent = UniversalAgent(TaskFactory.get_task("and"), hidden_dim=4, seed=0, optimizer="sgd", activation="relu")
    assert agent.train(epochs=300, verbose=False)["epochs_trained"] == 300
    assert agent.train(epochs=200, verbose=False)["epochs_trained"] == 200
    assert agent.total_epochs_trained == 500


def test_multi_output_task_shapes():
    agent = UniversalAgent(TaskFactory.get_task("binary_decoder"), hidden_dim=8, seed=0)
    agent.train(epochs=2000, verbose=False)
    ev = agent.evaluate(verbose=False)
    assert ev["raw_predictions"].shape == (4, 4)


def test_adam_stops_early_when_task_is_solved():
    agent = UniversalAgent(TaskFactory.get_task("and"), seed=0)
    result = agent.train(epochs=5000, verbose=False)
    assert result["final_accuracy"] == 1.0
    assert result["epochs_trained"] < 5000


# Zadania „trudne”, które przed zmianą (SGD + ReLU, hidden 8, lr 0.3) miały 50–88% dokładności.
HARD_TASKS = ["4bit_parity", "palindrome", "gray_code", "prime_detection", "repeating_pattern", "symmetric_pattern"]


@pytest.mark.parametrize("name", HARD_TASKS)
def test_adam_leaky_relu_solves_hard_tasks(name):
    task = TaskFactory.get_task(name)
    accs = [UniversalAgent(task, seed=s).train(epochs=4000, verbose=False)["final_accuracy"] for s in range(3)]
    assert np.mean(accs) >= 0.95, accs


def test_minibatch_adam_learns():
    task = TaskFactory.get_task("4bit_parity")
    agent = UniversalAgent(task, batch_size=4, learning_rate=0.03, seed=0)
    assert agent.train(epochs=3000, verbose=False)["final_accuracy"] >= 0.95


def test_sgd_relu_matches_previous_behaviour():
    # Ten sam seed i SGD+ReLU -> identyczny wynik jak ręczna implementacja z poprzedniej wersji
    task = TaskFactory.get_task("xor")
    agent = UniversalAgent(task, hidden_dim=4, learning_rate=0.5, seed=3, optimizer="sgd", activation="relu")
    W1, b1, W2, b2 = (agent.W1.copy(), agent.b1.copy(), agent.W2.copy(), agent.b2.copy())
    agent.train(epochs=50, verbose=False, patience=10**9)
    X, y = task.X, task.y
    for _ in range(50):
        z1 = X @ W1 + b1
        a1 = np.maximum(0, z1)
        a2 = 1 / (1 + np.exp(-(a1 @ W2 + b2)))
        d2 = a2 - y
        d1 = d2 @ W2.T * (z1 > 0)
        W2 -= 0.5 * a1.T @ d2
        b2 -= 0.5 * d2.sum(0, keepdims=True)
        W1 -= 0.5 * X.T @ d1
        b1 -= 0.5 * d1.sum(0, keepdims=True)
    assert np.allclose(agent.W1, W1) and np.allclose(agent.W2, W2)


def test_leaky_relu_has_gradient_for_negative_inputs():
    agent = UniversalAgent(TaskFactory.get_task("xor"), seed=0)
    z = np.array([[-2.0, 3.0]])
    assert agent.relu(z).tolist() == [[-0.02, 3.0]]
    assert agent.relu_derivative(z).tolist() == [[0.01, 1.0]]


def test_train_on_subset_and_predict():
    task = TaskFactory.get_task("majority")
    agent = UniversalAgent(task, seed=0)
    agent.train(epochs=2000, verbose=False, X=task.X[:6], y=task.y[:6])
    assert (agent.predict(task.X[:6]) == task.y[:6]).all()
    assert agent.predict(task.X).shape == task.y.shape


def test_invalid_optimizer_rejected():
    with pytest.raises(ValueError):
        UniversalAgent(TaskFactory.get_task("xor"), optimizer="rmsprop")
