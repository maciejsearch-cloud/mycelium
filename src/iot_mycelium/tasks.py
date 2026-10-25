"""Definicje zadań uczenia dla agentów.

Jeden rejestr zamiast trzech plików (``task_base.py``, ``tasks.py``,
``extended_tasks.py``). Poprzednia wersja ``TaskFactory.get_task`` odwoływała się
do ~22 metod, które nie istniały, więc *każde* wywołanie kończyło się
``AttributeError`` – dlatego trening, Auto-Evolution i IQ w dashboardzie nie działały.

Zadania są generowane z funkcji prawdy, więc etykiety zawsze zgadzają się z opisem.
"""

from __future__ import annotations

import itertools
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np


@dataclass
class Task:
    """Definicja zadania uczenia."""

    name: str
    X: np.ndarray
    y: np.ndarray
    input_dim: int
    output_dim: int
    description: str
    difficulty: str  # 'easy' | 'medium' | 'hard'
    key: str = ""
    category: str = ""
    tags: tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        self.X = np.asarray(self.X, dtype=float)
        self.y = np.asarray(self.y, dtype=float)
        if self.X.ndim != 2 or self.y.ndim != 2:
            raise ValueError(f"{self.name}: X i y muszą być 2D")
        if len(self.X) != len(self.y):
            raise ValueError(f"{self.name}: różna liczba przykładów X/y")
        if self.X.shape[1] != self.input_dim or self.y.shape[1] != self.output_dim:
            raise ValueError(f"{self.name}: wymiary nie zgadzają się z input_dim/output_dim")
        if not np.isin(self.y, (0.0, 1.0)).all():
            raise ValueError(f"{self.name}: etykiety muszą być 0/1 (wyjście sigmoid)")


def _bits(n: int) -> list[tuple[int, ...]]:
    return list(itertools.product((0, 1), repeat=n))


def _truth_table(n: int, fn: Callable[..., int | Sequence[int]]) -> tuple[np.ndarray, np.ndarray]:
    rows = _bits(n)
    X = np.array(rows)
    ys = [fn(*r) for r in rows]
    y = np.array([list(v) if isinstance(v, (list, tuple)) else [v] for v in ys])
    return X, y


def _to_bits(value: int, width: int) -> list[int]:
    return [(value >> i) & 1 for i in reversed(range(width))]


def _numbers(values: Sequence[int], fn: Callable[[int], int]) -> tuple[np.ndarray, np.ndarray]:
    """Zadania na liczbach: wejście znormalizowane do [0, 1] (stabilniejszy trening)."""
    arr = np.array(values, dtype=float)
    X = (arr / arr.max()).reshape(-1, 1)
    y = np.array([[fn(v)] for v in values])
    return X, y


@dataclass(frozen=True)
class TaskSpec:
    key: str
    name: str
    difficulty: str
    description: str
    category: str
    build: Callable[[], tuple[np.ndarray, np.ndarray]]


def _is_prime(n: int) -> int:
    return int(n > 1 and all(n % d for d in range(2, int(n**0.5) + 1)))


def _fib_mod2(n: int) -> int:
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a % 2


def _state_machine() -> tuple[np.ndarray, np.ndarray]:
    # Przerzutnik T z resetem: (stan, wejście, reset) -> następny stan
    return _truth_table(3, lambda s, t, r: 0 if r else s ^ t)


def _monotonic() -> tuple[np.ndarray, np.ndarray]:
    rows = list(itertools.product(range(3), repeat=3))
    X = np.array(rows, dtype=float) / 2.0
    y = np.array([[int((a < b < c) or (a > b > c))] for a, b, c in rows])
    return X, y


def _greater_than() -> tuple[np.ndarray, np.ndarray]:
    rows = list(itertools.product(range(4), repeat=2))
    X = np.array(rows, dtype=float) / 3.0
    y = np.array([[int(a > b)] for a, b in rows])
    return X, y


_SPECS: list[TaskSpec] = [
    # --- Logiczne: podstawowe (8 zadań „rdzenia” z README) ---
    TaskSpec(
        "xor",
        "XOR",
        "medium",
        "Exclusive OR - klasyczny problem nieliniowy",
        "logic",
        lambda: _truth_table(2, lambda a, b: a ^ b),
    ),
    TaskSpec(
        "and",
        "AND",
        "easy",
        "Logical AND - prosty problem liniowy",
        "logic",
        lambda: _truth_table(2, lambda a, b: a & b),
    ),
    TaskSpec(
        "or", "OR", "easy", "Logical OR - prosty problem liniowy", "logic", lambda: _truth_table(2, lambda a, b: a | b)
    ),
    TaskSpec(
        "nand",
        "NAND",
        "easy",
        "Logical NAND - negacja koniunkcji",
        "logic",
        lambda: _truth_table(2, lambda a, b: 1 - (a & b)),
    ),
    TaskSpec(
        "nor",
        "NOR",
        "easy",
        "Logical NOR - negacja alternatywy",
        "logic",
        lambda: _truth_table(2, lambda a, b: 1 - (a | b)),
    ),
    TaskSpec(
        "xnor",
        "XNOR",
        "medium",
        "Logical XNOR - równoważność",
        "logic",
        lambda: _truth_table(2, lambda a, b: 1 - (a ^ b)),
    ),
    TaskSpec(
        "3bit_parity",
        "3-bit Parity",
        "medium",
        "Parity 3-bit - sprawdzanie parzystości",
        "logic",
        lambda: _truth_table(3, lambda a, b, c: a ^ b ^ c),
    ),
    TaskSpec(
        "majority",
        "Majority Vote",
        "medium",
        "Majority - głosowanie większościowe",
        "logic",
        lambda: _truth_table(3, lambda a, b, c: int(a + b + c >= 2)),
    ),
    # --- Logiczne: zaawansowane ---
    TaskSpec(
        "4bit_parity",
        "4-bit Parity",
        "hard",
        "Parity 4-bit - trudne parzystości",
        "logic",
        lambda: _truth_table(4, lambda a, b, c, d: a ^ b ^ c ^ d),
    ),
    TaskSpec(
        "minority",
        "Minority",
        "medium",
        "Minority - głosowanie mniejszościowe",
        "logic",
        lambda: _truth_table(3, lambda a, b, c: int(a + b + c <= 1)),
    ),
    TaskSpec(
        "implication",
        "Implication",
        "medium",
        "Implication - implikacja logiczna A → B",
        "logic",
        lambda: _truth_table(2, lambda a, b: int((not a) or b)),
    ),
    TaskSpec(
        "equivalence",
        "Equivalence",
        "medium",
        "Equivalence - równoważność logiczna A ↔ B",
        "logic",
        lambda: _truth_table(2, lambda a, b: int(a == b)),
    ),
    # --- Arytmetyczne ---
    TaskSpec(
        "addition_mod2",
        "Addition Mod 2",
        "medium",
        "Addition mod 2 - dodawanie modulo 2",
        "arithmetic",
        lambda: _truth_table(2, lambda a, b: (a + b) % 2),
    ),
    TaskSpec(
        "subtraction_mod2",
        "Subtraction Mod 2",
        "medium",
        "Subtraction mod 2 - odejmowanie modulo 2",
        "arithmetic",
        lambda: _truth_table(2, lambda a, b: (a - b) % 2),
    ),
    TaskSpec(
        "multiplication_mod2",
        "Multiplication Mod 2",
        "medium",
        "Multiplication mod 2 - mnożenie modulo 2",
        "arithmetic",
        lambda: _truth_table(2, lambda a, b: (a * b) % 2),
    ),
    TaskSpec(
        "is_even",
        "Is Even",
        "easy",
        "Is even - parzystość liczby 0-7 (wejście 3-bitowe)",
        "arithmetic",
        lambda: _truth_table(3, lambda a, b, c: 1 - c),
    ),
    TaskSpec(
        "is_power_of_two",
        "Is Power of Two",
        "hard",
        "Is power of two - potęga dwójki (1-16)",
        "arithmetic",
        lambda: _numbers(range(1, 17), lambda n: int(n & (n - 1) == 0)),
    ),
    TaskSpec("greater_than", "Greater Than", "medium", "Greater than - czy A > B (0-3)", "arithmetic", _greater_than),
    # --- Rozpoznawanie wzorców ---
    TaskSpec(
        "alternating_pattern",
        "Alternating Pattern",
        "medium",
        "Alternating pattern - 010 / 101 w 3 bitach",
        "pattern",
        lambda: _truth_table(3, lambda a, b, c: int(a != b and b != c)),
    ),
    TaskSpec(
        "repeating_pattern",
        "Repeating Pattern",
        "medium",
        "Repeating pattern - 4 bity to dwa razy ten sam 2-bitowy wzór",
        "pattern",
        lambda: _truth_table(4, lambda a, b, c, d: int(a == c and b == d)),
    ),
    TaskSpec(
        "symmetric_pattern",
        "Symmetric Pattern",
        "medium",
        "Symmetric pattern - 4 bity symetryczne (abba)",
        "pattern",
        lambda: _truth_table(4, lambda a, b, c, d: int(a == d and b == c)),
    ),
    TaskSpec(
        "palindrome",
        "Palindrome",
        "hard",
        "Palindrome - 5-bitowe palindromy",
        "pattern",
        lambda: _truth_table(5, lambda a, b, c, d, e: int(a == e and b == d)),
    ),
    TaskSpec(
        "monotonic_sequence",
        "Monotonic Sequence",
        "medium",
        "Monotonic sequence - ściśle rosnący lub malejący ciąg 3 liczb",
        "pattern",
        _monotonic,
    ),
    # --- Sekwencje ---
    TaskSpec(
        "fibonacci_mod2",
        "Fibonacci Mod 2",
        "hard",
        "Fibonacci mod 2 - F(n) mod 2 dla n=0..15",
        "sequence",
        lambda: _numbers(range(16), _fib_mod2),
    ),
    TaskSpec(
        "prime_detection",
        "Prime Detection",
        "hard",
        "Prime detection - liczby pierwsze 0-15 (4 bity)",
        "sequence",
        lambda: _truth_table(4, lambda *b: _is_prime(int("".join(map(str, b)), 2))),
    ),
    TaskSpec(
        "count_ones",
        "Count Ones",
        "medium",
        "Count ones - liczba jedynek w 3 bitach (wynik 2-bitowy)",
        "sequence",
        lambda: _truth_table(3, lambda *b: _to_bits(sum(b), 2)),
    ),
    TaskSpec(
        "hamming_weight",
        "Hamming Weight",
        "medium",
        "Hamming weight - czy waga Hamminga 4 bitów ≥ 2",
        "sequence",
        lambda: _truth_table(4, lambda *b: int(sum(b) >= 2)),
    ),
    TaskSpec(
        "gray_code",
        "Gray Code",
        "hard",
        "Gray code - konwersja 3 bitów na kod Graya",
        "sequence",
        lambda: _truth_table(3, lambda *b: _to_bits((v := int("".join(map(str, b)), 2)) ^ (v >> 1), 3)),
    ),
    # --- Złożona logika ---
    TaskSpec(
        "boolean_expression",
        "Boolean Expression",
        "hard",
        "Boolean expression - (A AND B) OR (C AND NOT D)",
        "complex",
        lambda: _truth_table(4, lambda a, b, c, d: int((a and b) or (c and not d))),
    ),
    TaskSpec(
        "circuit_simulation",
        "Circuit Simulation",
        "hard",
        "Circuit simulation - (A XOR B) OR (B AND C)",
        "complex",
        lambda: _truth_table(3, lambda a, b, c: int((a ^ b) or (b and c))),
    ),
    TaskSpec(
        "state_machine",
        "State Machine",
        "hard",
        "State machine - przerzutnik T z resetem (stan, wejście, reset)",
        "complex",
        _state_machine,
    ),
    TaskSpec(
        "binary_decoder",
        "Binary Decoder",
        "medium",
        "Binary decoder - dekoder 2-na-4",
        "complex",
        lambda: _truth_table(2, lambda a, b: _to_bits(1 << (3 - (2 * a + b)), 4)),
    ),
]

TASK_REGISTRY: dict[str, TaskSpec] = {spec.key: spec for spec in _SPECS}

#: Osiem zadań „rdzenia” – opisane w README i pokryte testami.
CORE_TASKS: tuple[str, ...] = ("xor", "and", "or", "nand", "nor", "xnor", "3bit_parity", "majority")


class TaskFactory:
    """Fabryka zadań uczenia (API zgodne z poprzednią wersją)."""

    @staticmethod
    def get_task(task_name: str) -> Task:
        spec = TASK_REGISTRY.get(task_name)
        if spec is None:
            raise ValueError(f"Unknown task: {task_name}. Available: {list(TASK_REGISTRY)}")
        X, y = spec.build()
        return Task(
            name=spec.name,
            X=X,
            y=y,
            input_dim=X.shape[1],
            output_dim=y.shape[1],
            description=spec.description,
            difficulty=spec.difficulty,
            key=spec.key,
            category=spec.category,
        )

    @staticmethod
    def list_tasks() -> dict[str, dict[str, Any]]:
        return {
            spec.key: {"difficulty": spec.difficulty, "description": spec.description, "category": spec.category}
            for spec in _SPECS
        }

    @staticmethod
    def task_names() -> list[str]:
        return list(TASK_REGISTRY)
