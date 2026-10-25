import numpy as np
import pytest

from iot_mycelium.tasks import CORE_TASKS, TASK_REGISTRY, TaskFactory


@pytest.mark.parametrize("name", TaskFactory.task_names())
def test_every_registered_task_builds(name):
    task = TaskFactory.get_task(name)
    assert task.X.shape == (len(task.y), task.input_dim)
    assert task.y.shape[1] == task.output_dim
    assert set(np.unique(task.y)) <= {0.0, 1.0}
    # brak sprzecznych przykładów (to samo wejście -> różne etykiety)
    seen = {}
    for x, y in zip(map(tuple, task.X), map(tuple, task.y)):
        assert seen.setdefault(x, y) == y, f"{name}: sprzeczne etykiety dla {x}"


def test_list_tasks_matches_registry():
    assert list(TaskFactory.list_tasks()) == list(TASK_REGISTRY)
    assert len(TASK_REGISTRY) == 32
    assert set(CORE_TASKS) <= set(TASK_REGISTRY)


def test_unknown_task_raises():
    with pytest.raises(ValueError, match="Unknown task"):
        TaskFactory.get_task("nope")


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("xor", [0, 1, 1, 0]),
        ("and", [0, 0, 0, 1]),
        ("or", [0, 1, 1, 1]),
        ("nand", [1, 1, 1, 0]),
        ("nor", [1, 0, 0, 0]),
        ("xnor", [1, 0, 0, 1]),
        ("3bit_parity", [0, 1, 1, 0, 1, 0, 0, 1]),
        ("majority", [0, 0, 0, 1, 0, 1, 1, 1]),
    ],
)
def test_core_truth_tables(name, expected):
    assert TaskFactory.get_task(name).y.ravel().astype(int).tolist() == expected


def test_boolean_expression_matches_description():
    task = TaskFactory.get_task("boolean_expression")
    for (a, b, c, d), (y,) in zip(task.X.astype(int), task.y.astype(int)):
        assert y == int((a and b) or (c and not d))
