from iot_mycelium.iq_calculator import AgentIQCalculator, MemoryTest, kfold_heldout
from iot_mycelium.tasks import TaskFactory
from iot_mycelium.universal_agent import UniversalAgent


def _trained(name="xor"):
    agent = UniversalAgent(TaskFactory.get_task(name), seed=0)
    agent.train(epochs=3000, verbose=False)
    return agent


def test_iq_structure_and_bounds():
    calc = AgentIQCalculator(seed=0)
    iq = calc.calculate_iq(_trained())
    assert set(iq["breakdown"]) == set(calc.tests)
    assert iq["max_iq"] == 110
    assert 0 <= iq["total_iq"] <= iq["max_iq"]
    for name, score in iq["breakdown"].items():
        assert 0 <= score <= iq["max_scores"][name]
    assert iq["stage"]["name"] in calc.evolution_stages
    assert 0.0 <= iq["evolution_progress"] <= 1.0
    for group in iq["heldout"].values():
        for d in group.values():
            assert 0.0 <= d["heldout_accuracy"] <= 1.0 and 0.0 <= d["score"] <= 1.0


def test_trained_agent_scores_higher_than_untrained():
    calc = AgentIQCalculator(seed=0)
    untrained = UniversalAgent(TaskFactory.get_task("xor"), seed=0)
    assert calc.calculate_iq(_trained())["total_iq"] > calc.calculate_iq(untrained)["total_iq"]


def test_heldout_scores_generalisation_not_memorisation():
    cfg = {"hidden_dim": 16, "learning_rate": 0.1, "optimizer": "adam", "activation": "leaky_relu"}
    # greater_than (A > B) da się uogólnić z części przykładów
    gt = kfold_heldout("greater_than", cfg, seed=0)
    assert gt["heldout_accuracy"] >= 0.9 and gt["score"] > 0.5
    # parzystość 4-bitowa: z brakujących wierszy nie da się wywnioskować wyniku –
    # mimo że agent uczy się jej na 100% na całej tabeli, na danych odłożonych wypada słabo
    parity = kfold_heldout("4bit_parity", cfg, seed=0)
    assert parity["heldout_accuracy"] <= 0.6
    assert 0.0 <= parity["score"] <= 0.25


def test_heldout_never_sees_test_rows(monkeypatch):
    seen = []
    original = UniversalAgent.train

    def spy(self, *args, X=None, y=None, **kwargs):
        seen.append(len(X))
        return original(self, *args, X=X, y=y, **kwargs)

    monkeypatch.setattr(UniversalAgent, "train", spy)
    kfold_heldout("greater_than", {"hidden_dim": 8}, k=4, epochs=50, repeats=1)
    assert seen == [12, 12, 12, 12]  # 16 przykładów, w każdym foldzie 4 odłożone


def test_memory_test_rewards_retention():
    agent = _trained()
    assert MemoryTest().evaluate(agent) == 10
    agent.accuracy_history.append(0.5)  # „zapomniał” połowę
    assert MemoryTest().evaluate(agent) == 5


def test_stage_boundaries():
    calc = AgentIQCalculator()
    assert calc.determine_stage(0)["name"] == "foundation"
    assert calc.determine_stage(51)["name"] == "patterns"
    assert calc.get_next_stage_requirements(40)["needed_iq"] == 11
    assert calc.get_next_stage_requirements(170)["next_stage"] == "max"
