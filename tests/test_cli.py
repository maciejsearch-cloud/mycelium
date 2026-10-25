import pytest

from iot_mycelium.cli import main


def test_tasks(capsys):
    assert main(["tasks"]) == 0
    assert "3bit_parity" in capsys.readouterr().out


def test_train_xor():
    assert main(["train", "xor", "--epochs", "3000", "--seed", "0"]) == 0


def test_evolve_and_iq(isolated_data_dir):
    assert main(["evolve", "--tasks", "and", "or", "--max-attempts", "2", "--epoch-scale", "0.25"]) == 0
    assert list((isolated_data_dir / "evolution").glob("*.json"))
    assert main(["iq", "and", "--epochs", "1000"]) == 0


def test_demo_xor_writes_plots(isolated_data_dir, monkeypatch):
    monkeypatch.setenv("MPLBACKEND", "Agg")
    assert main(["demo-xor", "--epochs", "1500"]) == 0
    logs = isolated_data_dir.parent / "logs"
    assert (logs / "optimized_training_curves.png").exists()
    assert (logs / "optimized_network_architecture.png").exists()


@pytest.mark.slow
def test_simulation_updates_mycelium(isolated_data_dir):
    from iot_mycelium.memory import MyceliumMemory

    assert main(["simulate", "--devices", "2", "--duration", "2", "--epochs", "300"]) == 0
    assert not MyceliumMemory().is_empty()
