"""Uniwersalny agent: sieć 2-warstwowa (ReLU/Leaky ReLU → sigmoid) w czystym NumPy.

Optymalizatory:

* ``"adam"`` (domyślny) – Adam na *uśrednionych* gradientach, opcjonalnie mini-batch,
  z przywracaniem najlepszych wag na końcu treningu;
* ``"sgd"`` – oryginalny spadek gradientu na *sumie* gradientów (pełny batch),
  zachowany 1:1 dla porównań i starych zapisanych agentów.
"""

from __future__ import annotations

import time
from typing import Any

import numpy as np

from iot_mycelium.tasks import Task

OPTIMIZERS = ("adam", "sgd")
LOSS_EVERY = 10  # co ile epok zapisywać loss/accuracy (Adam zbiega w setkach, nie tysiącach epok)
SNAPSHOT_EVERY = 100  # co ile epok zapisywać wagi i aktywacje
ACTIVATIONS = ("leaky_relu", "relu")


class UniversalAgent:
    """
    Uniwersalny agent uczący się różnych zadań.
    Automatycznie dostosowuje architekturę do wymiaru zadania.
    """

    def __init__(
        self,
        task: Task,
        hidden_dim: int = 16,
        learning_rate: float = 0.1,
        initial_weights: dict[str, np.ndarray] | None = None,
        seed: int | None = None,
        optimizer: str = "adam",
        activation: str = "leaky_relu",
        batch_size: int | None = None,
        leaky_slope: float = 0.01,
        beta1: float = 0.9,
        beta2: float = 0.999,
    ):
        if optimizer not in OPTIMIZERS:
            raise ValueError(f"optimizer musi być jednym z {OPTIMIZERS}")
        if activation not in ACTIVATIONS:
            raise ValueError(f"activation musi być jedną z {ACTIVATIONS}")
        self.task = task
        self.optimizer = optimizer
        self.activation = activation
        self.batch_size = batch_size
        self.leaky_slope = leaky_slope if activation == "leaky_relu" else 0.0
        self.beta1, self.beta2, self.eps = beta1, beta2, 1e-8
        self.hidden_dim = hidden_dim
        self.learning_rate = learning_rate
        self.input_dim = task.input_dim
        self.output_dim = task.output_dim

        # Dane treningowe z zadania
        self.X = task.X
        self.y = task.y

        self.rng = np.random.default_rng(seed)

        # Inicjalizacja wag
        if initial_weights is not None:
            self.W1 = initial_weights["W1"].copy()
            self.b1 = initial_weights["b1"].copy()
            self.W2 = initial_weights["W2"].copy()
            self.b2 = initial_weights["b2"].copy()
        else:
            # Xavier initialization
            limit1 = np.sqrt(6 / (self.input_dim + hidden_dim))
            limit2 = np.sqrt(6 / (hidden_dim + self.output_dim))

            self.W1 = self.rng.uniform(-limit1, limit1, (self.input_dim, hidden_dim))
            self.b1 = np.zeros((1, hidden_dim))
            self.W2 = self.rng.uniform(-limit2, limit2, (hidden_dim, self.output_dim))
            self.b2 = np.zeros((1, self.output_dim))

        # Historia treningu
        self.loss_history: list[float] = []
        self.accuracy_history: list[float] = []
        self.epoch_times: list[float] = []
        self.weight_history: list[dict[str, np.ndarray]] = []
        self.activation_history: list[dict[str, np.ndarray]] = []
        self.total_epochs_trained = 0
        self._adam_m: dict[str, np.ndarray] = {}
        self._adam_v: dict[str, np.ndarray] = {}
        self._adam_t = 0

    def get_weight_shapes(self) -> dict[str, tuple[int, ...]]:
        """Zwraca kształty wag dla tego zadania"""
        return {
            "W1": (self.input_dim, self.hidden_dim),
            "b1": (1, self.hidden_dim),
            "W2": (self.hidden_dim, self.output_dim),
            "b2": (1, self.output_dim),
        }

    def relu(self, z: np.ndarray) -> np.ndarray:
        """Aktywacja ukryta: ReLU albo Leaky ReLU (slope dla z < 0)."""
        return np.where(z > 0, z, self.leaky_slope * z)

    def relu_derivative(self, z: np.ndarray) -> np.ndarray:
        return np.where(z > 0, 1.0, self.leaky_slope)

    def sigmoid(self, z: np.ndarray) -> np.ndarray:
        z = np.clip(z, -500, 500)
        return 1 / (1 + np.exp(-z))

    def sigmoid_derivative(self, a: np.ndarray) -> np.ndarray:
        return a * (1 - a)

    def forward_pass(self, X: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """Propagacja w przód"""
        z1 = X @ self.W1 + self.b1
        a1 = self.relu(z1)
        z2 = a1 @ self.W2 + self.b2
        a2 = self.sigmoid(z2)
        return z1, a1, z2, a2

    def calculate_loss(self, y_true: np.ndarray, y_pred: np.ndarray) -> float:
        """Binary cross-entropy loss"""
        y_pred = np.clip(y_pred, 1e-7, 1 - 1e-7)
        loss = -np.mean(y_true * np.log(y_pred) + (1 - y_true) * np.log(1 - y_pred))
        return float(loss)

    def calculate_accuracy(self, y_true: np.ndarray, y_pred: np.ndarray) -> float:
        """Oblicza dokładność (próg 0.5)"""
        predictions = (y_pred > 0.5).astype(int)
        return float(np.mean(predictions == y_true))

    def backward_pass(
        self, X: np.ndarray, y: np.ndarray, z1: np.ndarray, a1: np.ndarray, a2: np.ndarray
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """Propagacja wsteczna"""
        d2 = a2 - y
        dW2 = a1.T @ d2
        db2 = np.sum(d2, axis=0, keepdims=True)

        d1 = d2 @ self.W2.T * self.relu_derivative(z1)
        dW1 = X.T @ d1
        db1 = np.sum(d1, axis=0, keepdims=True)

        return dW1, db1, dW2, db2

    def update_weights(self, dW1: np.ndarray, db1: np.ndarray, dW2: np.ndarray, db2: np.ndarray, n: int = 1):
        """Aktualizacja wag (SGD na sumie gradientów albo Adam na średniej)."""
        grads = {"W1": dW1, "b1": db1, "W2": dW2, "b2": db2}
        if self.optimizer == "sgd":
            for key, g in grads.items():
                getattr(self, key)[...] -= self.learning_rate * g
            return
        self._adam_t += 1
        t = self._adam_t
        for key, g in grads.items():
            g = g / max(n, 1)
            m = self._adam_m.get(key)
            if m is None or m.shape != g.shape:
                m = np.zeros_like(g)
                self._adam_v[key] = np.zeros_like(g)
            v = self._adam_v[key]
            m = self.beta1 * m + (1 - self.beta1) * g
            v = self.beta2 * v + (1 - self.beta2) * g * g
            self._adam_m[key], self._adam_v[key] = m, v
            m_hat = m / (1 - self.beta1**t)
            v_hat = v / (1 - self.beta2**t)
            getattr(self, key)[...] -= self.learning_rate * m_hat / (np.sqrt(v_hat) + self.eps)

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        return self.forward_pass(np.asarray(X, dtype=float))[3]

    def predict(self, X: np.ndarray) -> np.ndarray:
        return (self.predict_proba(X) > 0.5).astype(int)

    def train(
        self,
        epochs: int = 5000,
        verbose: bool = True,
        save_interval: int = 500,
        X: np.ndarray | None = None,
        y: np.ndarray | None = None,
        patience: int = 2000,
    ) -> dict[str, Any]:
        """Trening agenta.

        ``X``/``y`` pozwalają trenować na podzbiorze (np. część tabeli prawdy
        w testach IQ na danych odłożonych); domyślnie cała tabela zadania.
        """
        X_train = self.X if X is None else np.asarray(X, dtype=float)
        y_train = self.y if y is None else np.asarray(y, dtype=float)
        n = len(X_train)
        batch = self.batch_size if self.optimizer == "adam" and self.batch_size else n
        if verbose:
            print(f"=== TRENING: {self.task.name} ===")
            print(f"Epoki: {epochs}, Learning rate: {self.learning_rate}")
            print(f"Architektura: {self.input_dim}→{self.hidden_dim}→{self.output_dim}")
            print(f"Trudność: {self.task.difficulty}")

        start_time = time.time()
        best_accuracy = 0.0
        best_loss = float("inf")
        patience_counter = 0
        epochs_run = 0
        best_W1, best_W2, best_b1, best_b2 = self.W1.copy(), self.W2.copy(), self.b1.copy(), self.b2.copy()

        for epoch in range(epochs):
            epochs_run = epoch + 1
            epoch_start = time.time()

            # Forward pass (metryki zawsze na pełnym zbiorze treningowym)
            z1, a1, z2, a2 = self.forward_pass(X_train)

            # Obliczanie metryk
            loss = self.calculate_loss(y_train, a2)
            accuracy = self.calculate_accuracy(y_train, a2)

            # Zapis historii
            if epoch % LOSS_EVERY == 0:
                self.loss_history.append(loss)
                self.accuracy_history.append(accuracy)
                self.epoch_times.append(time.time() - epoch_start)

            # Zapis wag i aktywacji
            if epoch % SNAPSHOT_EVERY == 0:
                self.weight_history.append(self.get_weights())
                self.activation_history.append(
                    {
                        "a0": X_train,  # Wejście
                        "a1": a1,  # Warstwa ukryta
                        "a2": a2,  # Warstwa wyjściowa
                    }
                )

            # Logowanie
            if verbose and epoch % save_interval == 0:
                print(f"Epoch {epoch:5d} | Loss: {loss:.6f} | Acc: {accuracy:.3f}")

            # Early stopping check
            if accuracy > best_accuracy or (accuracy == best_accuracy and loss < best_loss):
                best_accuracy = accuracy
                best_loss = loss
                patience_counter = 0
                # Zapis najlepszych wag
                best_W1 = self.W1.copy()
                best_W2 = self.W2.copy()
                best_b1 = self.b1.copy()
                best_b2 = self.b2.copy()
            else:
                patience_counter += 1

            if patience_counter >= patience and accuracy >= 0.95:
                if verbose:
                    print(f"\nEarly stopping at epoch {epoch}")
                # Przywróć najlepsze wagi
                self.W1 = best_W1
                self.W2 = best_W2
                self.b1 = best_b1
                self.b2 = best_b2
                break

            if accuracy == 1.0 and loss < 1e-3:
                break  # zadanie opanowane, dalszy trening nic nie wnosi

            if batch >= n:
                dW1, db1, dW2, db2 = self.backward_pass(X_train, y_train, z1, a1, a2)
                self.update_weights(dW1, db1, dW2, db2, n=n)
            else:
                order = self.rng.permutation(n)
                for start in range(0, n, batch):
                    idx = order[start : start + batch]
                    Xb, yb = X_train[idx], y_train[idx]
                    bz1, ba1, _, ba2 = self.forward_pass(Xb)
                    grads = self.backward_pass(Xb, yb, bz1, ba1, ba2)
                    self.update_weights(*grads, n=len(idx))

        end_time = time.time()
        training_time = end_time - start_time
        self.total_epochs_trained += epochs_run

        # Finalna ewaluacja; Adam przywraca najlepsze wagi, jeśli końcowe są gorsze
        z1, a1, z2, a2 = self.forward_pass(X_train)
        final_loss = self.calculate_loss(y_train, a2)
        final_accuracy = self.calculate_accuracy(y_train, a2)
        if self.optimizer == "adam" and (best_accuracy, -best_loss) > (final_accuracy, -final_loss):
            self.W1, self.W2, self.b1, self.b2 = best_W1, best_W2, best_b1, best_b2
            z1, a1, z2, a2 = self.forward_pass(X_train)
            final_loss = self.calculate_loss(y_train, a2)
            final_accuracy = self.calculate_accuracy(y_train, a2)
        # Stan końcowy zawsze trafia do historii (wykresy kończą się na wyniku finalnym)
        self.loss_history.append(final_loss)
        self.accuracy_history.append(final_accuracy)
        self.weight_history.append(self.get_weights())
        self.activation_history.append({"a0": X_train, "a1": a1, "a2": a2})

        if verbose:
            print("\n=== WYNIKI ===")
            print(f"Czas treningu: {training_time:.2f}s")
            print(f"Finalna dokładność: {final_accuracy:.3f}")
            print(f"Finalna strata: {final_loss:.6f}")

            if final_accuracy >= 0.95:
                print(f"✅ Agent nauczył się zadania {self.task.name}!")
            else:
                print("⚠️  Agent potrzebuje więcej treningu")

        return {
            "final_loss": final_loss,
            "final_accuracy": final_accuracy,
            "training_time": training_time,
            "epochs_trained": epochs_run,
            "task_name": self.task.name,
            "task_difficulty": self.task.difficulty,
        }

    def evaluate(self, verbose: bool = True) -> dict[str, Any]:
        """Ewaluacja agenta na danych treningowych"""
        z1, a1, z2, a2 = self.forward_pass(self.X)
        loss = self.calculate_loss(self.y, a2)
        accuracy = self.calculate_accuracy(self.y, a2)
        predictions = (a2 > 0.5).astype(int)

        if verbose:
            print(f"\n=== EWALUACJA: {self.task.name} ===")
            print("Wejścia:")
            print(self.X)
            print("\nPredykcje (surowe):")
            print(np.round(a2, 4))
            print("\nPredykcje (binarne):")
            print(predictions)
            print("\nOczekiwane:")
            print(self.y)
            print(f"\nDokładność: {accuracy:.3f}")
            print(f"Strata: {loss:.6f}")

        return {"loss": loss, "accuracy": accuracy, "predictions": predictions, "raw_predictions": a2}

    def get_weights(self) -> dict[str, np.ndarray]:
        """Zwraca wagi agenta"""
        return {
            "W1": self.W1.copy(),
            "b1": self.b1.copy(),
            "W2": self.W2.copy(),
            "b2": self.b2.copy(),
        }
