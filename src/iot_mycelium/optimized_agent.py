"""Zoptymalizowany agent XOR z monitoringiem CPU/RAM i wykresami matplotlib.

Używany przez symulację IoT (``iot_orchestrator``) i demo ``python -m iot_mycelium demo-xor``.
"""

from __future__ import annotations

import json
import time
from datetime import datetime
from typing import Any

import numpy as np
import psutil


def _pyplot():
    """Import matplotlib dopiero przy rysowaniu (backend Agg = działa bez ekranu)."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    return plt


class OptimizedXORAgent:
    """Zoptymalizowany agent XOR z lepszymi parametrami treningu"""

    def __init__(
        self, hidden_dim: int = 4, learning_rate: float = 0.5, initial_weights: dict[str, np.ndarray] | None = None
    ):
        self.hidden_dim = hidden_dim
        self.learning_rate = learning_rate
        self.input_dim = 2
        self.output_dim = 1

        # Dane treningowe XOR
        self.X = np.array([[0, 0], [0, 1], [1, 0], [1, 1]])
        self.y = np.array([[0], [1], [1], [0]])

        # Inicjalizacja wag - użyj initial_weights jeśli podano, w przeciwnym razie Xavier
        if initial_weights is not None:
            self.W1 = initial_weights["W1"].copy()
            self.b1 = initial_weights["b1"].copy()
            self.W2 = initial_weights["W2"].copy()
            self.b2 = initial_weights["b2"].copy()
        else:
            # Lepsza inicjalizacja wag (Xavier/Glorot)
            np.random.seed(42)
            limit1 = np.sqrt(6 / (self.input_dim + hidden_dim))
            limit2 = np.sqrt(6 / (hidden_dim + self.output_dim))

            self.W1 = np.random.uniform(-limit1, limit1, (self.input_dim, hidden_dim))
            self.b1 = np.zeros((1, hidden_dim))
            self.W2 = np.random.uniform(-limit2, limit2, (hidden_dim, self.output_dim))
            self.b2 = np.zeros((1, self.output_dim))

        # Historia treningu
        self.loss_history: list[float] = []
        self.accuracy_history: list[float] = []
        self.system_metrics: list[dict[str, Any]] = []
        self.weight_history: list[dict[str, np.ndarray]] = []

    def relu(self, z: np.ndarray) -> np.ndarray:
        return np.maximum(0, z)

    def relu_derivative(self, z: np.ndarray) -> np.ndarray:
        return np.where(z > 0, 1.0, 0.0)

    def sigmoid(self, z: np.ndarray) -> np.ndarray:
        # Stabilizacja numeryczna
        z = np.clip(z, -500, 500)
        return 1 / (1 + np.exp(-z))

    def sigmoid_derivative(self, a: np.ndarray) -> np.ndarray:
        return a * (1 - a)

    def get_system_metrics(self) -> dict[str, float]:
        """Pobiera metryki systemowe"""
        cpu_percent = psutil.cpu_percent(interval=None)
        memory = psutil.virtual_memory()
        process = psutil.Process()

        return {
            "cpu_percent": cpu_percent,
            "memory_percent": memory.percent,
            "memory_used_gb": memory.used / (1024**3),
            "process_memory_mb": process.memory_info().rss / (1024**2),
        }

    def forward_pass(self, X: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """Propagacja w przód"""
        z1 = X @ self.W1 + self.b1
        a1 = self.relu(z1)
        z2 = a1 @ self.W2 + self.b2
        a2 = self.sigmoid(z2)
        return z1, a1, z2, a2

    def calculate_loss(self, y_true: np.ndarray, y_pred: np.ndarray) -> float:
        """Binary cross-entropy loss (lepsza dla klasyfikacji)"""
        # Stabilizacja numeryczna
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
        """Propagacja wsteczna z binary cross-entropy"""
        # Dla binary cross-entropy + sigmoid: dL/dz2 = a2 - y
        d2 = a2 - y
        dW2 = a1.T @ d2
        db2 = np.sum(d2, axis=0, keepdims=True)

        d1 = d2 @ self.W2.T * self.relu_derivative(z1)
        dW1 = X.T @ d1
        db1 = np.sum(d1, axis=0, keepdims=True)

        return dW1, db1, dW2, db2

    def update_weights(self, dW1: np.ndarray, db1: np.ndarray, dW2: np.ndarray, db2: np.ndarray):
        """Aktualizacja wag"""
        self.W2 -= self.learning_rate * dW2
        self.b2 -= self.learning_rate * db2
        self.W1 -= self.learning_rate * dW1
        self.b1 -= self.learning_rate * db1

    def train(self, epochs: int = 20000, save_interval: int = 1000):
        """Trening agenta z monitoringiem"""
        print("=== START TRENINGU - agent zaczyna jako 'dziecko' ===")
        print(f"Epoki: {epochs}, Learning rate: {self.learning_rate}")
        print(f"Architektura: {self.input_dim}→{self.hidden_dim}→{self.output_dim}")
        print("Ulepszona inicjalizacja wag + Binary Cross-Entropy Loss")

        start_time = time.time()
        best_accuracy = 0.0
        patience = 2000  # Early stopping
        patience_counter = 0

        for epoch in range(epochs):
            # Forward pass
            z1, a1, z2, a2 = self.forward_pass(self.X)

            # Obliczanie metryk
            loss = self.calculate_loss(self.y, a2)
            accuracy = self.calculate_accuracy(self.y, a2)

            # Zapis historii
            if epoch % 100 == 0:
                self.loss_history.append(loss)
                self.accuracy_history.append(accuracy)
                self.system_metrics.append(self.get_system_metrics())

            # Zapis wag co save_interval
            if epoch % save_interval == 0:
                self.weight_history.append(
                    {"epoch": epoch, "W1": self.W1.copy(), "W2": self.W2.copy(), "loss": loss, "accuracy": accuracy}
                )

                metrics = self.get_system_metrics()
                print(
                    f"Epoch {epoch:5d} | Loss: {loss:.6f} | Acc: {accuracy:.3f} | CPU: {metrics['cpu_percent']:.1f}% | RAM: {metrics['memory_percent']:.1f}%"
                )

            # Early stopping check
            if accuracy > best_accuracy:
                best_accuracy = accuracy
                patience_counter = 0
                # Zapis najlepszych wag
                best_W1 = self.W1.copy()
                best_W2 = self.W2.copy()
                best_b1 = self.b1.copy()
                best_b2 = self.b2.copy()
            else:
                patience_counter += 1

            if patience_counter >= patience and accuracy >= 0.95:
                print(f"\nEarly stopping at epoch {epoch} - accuracy {accuracy:.3f}")
                # Przywróć najlepsze wagi
                self.W1 = best_W1
                self.W2 = best_W2
                self.b1 = best_b1
                self.b2 = best_b2
                break

            # Backward pass
            dW1, db1, dW2, db2 = self.backward_pass(self.X, self.y, z1, a1, a2)

            # Aktualizacja wag
            self.update_weights(dW1, db1, dW2, db2)

        end_time = time.time()
        print(f"\n=== TRENING ZAKOŃCZONY w {end_time - start_time:.2f}s ===")

        # Finalna ewaluacja
        self.evaluate()

    def evaluate(self):
        """Finalna ewaluacja agenta"""
        print("\n=== EWALUACJA KOŃCOWA ===")
        z1, a1, z2, a2 = self.forward_pass(self.X)

        print("Wejścia:")
        print(self.X)
        print("\nPredykcje (surowe):")
        print(np.round(a2, 4))
        print("\nPredykcje (binarne):")
        predictions = (a2 > 0.5).astype(int)
        print(predictions)
        print("\nOczekiwane:")
        print(self.y)

        final_accuracy = self.calculate_accuracy(self.y, a2)
        final_loss = self.calculate_loss(self.y, a2)
        print(f"\nFinalna dokładność: {final_accuracy:.3f}")
        print(f"Finalna strata: {final_loss:.6f}")

        if final_accuracy >= 0.95:
            print("✅ Agent nauczył się logiki XOR!")
        elif final_accuracy >= 0.75:
            print("⚠️  Agent częściowo nauczył się logiki XOR")
        else:
            print("❌ Agent potrzebuje więcej treningu")

    def visualize_training(self, save_path: str | None = None):
        """Wizualizacja procesu treningu"""
        plt = _pyplot()
        fig, axes = plt.subplots(2, 2, figsize=(15, 10))
        fig.suptitle("XOR Agent - Zoptymalizowany Proces Treningu", fontsize=16)

        # Loss curve
        axes[0, 0].plot(self.loss_history, "b-", linewidth=2)
        axes[0, 0].set_title("Krzywa straty (Binary Cross-Entropy)")
        axes[0, 0].set_xlabel("Krok (x100)")
        axes[0, 0].set_ylabel("Loss")
        axes[0, 0].grid(True, alpha=0.3)

        # Accuracy curve
        axes[0, 1].plot(self.accuracy_history, "g-", linewidth=2)
        axes[0, 1].set_title("Dokładność")
        axes[0, 1].set_xlabel("Krok (x100)")
        axes[0, 1].set_ylabel("Accuracy")
        axes[0, 1].set_ylim(0, 1.1)
        axes[0, 1].grid(True, alpha=0.3)

        # CPU usage
        cpu_values = [m["cpu_percent"] for m in self.system_metrics]
        axes[1, 0].plot(cpu_values, "r-", linewidth=2)
        axes[1, 0].set_title("Wykorzystanie CPU")
        axes[1, 0].set_xlabel("Krok (x100)")
        axes[1, 0].set_ylabel("CPU %")
        axes[1, 0].grid(True, alpha=0.3)

        # Memory usage
        memory_values = [m["memory_percent"] for m in self.system_metrics]
        axes[1, 1].plot(memory_values, "m-", linewidth=2)
        axes[1, 1].set_title("Wykorzystanie RAM")
        axes[1, 1].set_xlabel("Krok (x100)")
        axes[1, 1].set_ylabel("Memory %")
        axes[1, 1].grid(True, alpha=0.3)

        plt.tight_layout()

        if save_path:
            plt.savefig(save_path, dpi=150, bbox_inches="tight")
            print(f"Wizualizacja zapisana w: {save_path}")
        plt.close(fig)

    def visualize_network(self, save_path: str | None = None):
        """Wizualizacja architektury sieci"""
        plt = _pyplot()
        fig, ax = plt.subplots(1, 1, figsize=(12, 8))

        # Pozycje neuronów (dowolna liczba neuronów ukrytych – wcześniej na sztywno 4)
        input_pos = np.array([[1, 2], [1, 4]])
        hidden_ys = np.linspace(0.5, 4.5, self.hidden_dim + 2)[1:-1]
        hidden_pos = np.array([[3, y] for y in hidden_ys])
        output_pos = np.array([[5, 3]])

        # Rysowanie neuronów
        for pos in input_pos:
            circle = plt.Circle(pos, 0.3, color="lightblue", ec="black", linewidth=2)
            ax.add_patch(circle)

        for pos in hidden_pos:
            circle = plt.Circle(pos, 0.3, color="lightgreen", ec="black", linewidth=2)
            ax.add_patch(circle)

        circle = plt.Circle(output_pos[0], 0.3, color="lightcoral", ec="black", linewidth=2)
        ax.add_patch(circle)

        # Rysowanie wag (grubość linii = siła połączenia)
        # Wejście -> ukryte
        for i, in_pos in enumerate(input_pos):
            for j, hid_pos in enumerate(hidden_pos):
                weight = self.W1[i, j]
                linewidth = abs(weight) * 3  # Mniejsze skalowanie dla lepszej widoczności
                color = "red" if weight > 0 else "blue"
                alpha = min(abs(weight) * 2, 1.0)  # Mniejsze skalowanie alpha
                ax.plot([in_pos[0], hid_pos[0]], [in_pos[1], hid_pos[1]], color=color, linewidth=linewidth, alpha=alpha)

        # Ukryte -> wyjście
        for j, hid_pos in enumerate(hidden_pos):
            weight = self.W2[j, 0]
            linewidth = abs(weight) * 3
            color = "red" if weight > 0 else "blue"
            alpha = min(abs(weight) * 2, 1.0)
            ax.plot(
                [hid_pos[0], output_pos[0, 0]],
                [hid_pos[1], output_pos[0, 1]],
                color=color,
                linewidth=linewidth,
                alpha=alpha,
            )

        # Etykiety
        ax.text(0.5, 2, "X₁", fontsize=14, ha="center", va="center")
        ax.text(0.5, 4, "X₂", fontsize=14, ha="center", va="center")
        ax.text(3, 0.1, "Hidden Layer", fontsize=12, ha="center")
        ax.text(5.5, 3, "Y", fontsize=14, ha="center", va="center")

        # Tytuł i formatowanie
        ax.set_title(f"Zoptymalizowana Sieć XOR (2→{self.hidden_dim}→1)", fontsize=16)
        ax.set_xlim(0, 6)
        ax.set_ylim(0, 5)
        ax.set_aspect("equal")
        ax.axis("off")

        # Legenda wag
        ax.plot([], [], "r-", linewidth=3, label="Waga dodatnia")
        ax.plot([], [], "b-", linewidth=3, label="Waga ujemna")
        ax.legend(loc="upper right")

        plt.tight_layout()

        if save_path:
            plt.savefig(save_path, dpi=150, bbox_inches="tight")
            print(f"Wizualizacja sieci zapisana w: {save_path}")
        plt.close(fig)

    def save_training_data(self, filepath: str):
        """Zapisuje dane treningowe do JSON"""
        data = {
            "timestamp": datetime.now().isoformat(),
            "architecture": {
                "input_dim": self.input_dim,
                "hidden_dim": self.hidden_dim,
                "output_dim": self.output_dim,
                "learning_rate": self.learning_rate,
            },
            "final_weights": {
                "W1": self.W1.tolist(),
                "b1": self.b1.tolist(),
                "W2": self.W2.tolist(),
                "b2": self.b2.tolist(),
            },
            "training_history": {
                "loss_history": self.loss_history,
                "accuracy_history": self.accuracy_history,
                "system_metrics": self.system_metrics,
            },
            "final_metrics": {
                "final_loss": self.loss_history[-1] if self.loss_history else None,
                "final_accuracy": self.accuracy_history[-1] if self.accuracy_history else None,
            },
        }

        with open(filepath, "w") as f:
            json.dump(data, f, indent=2)

        print(f"Dane treningowe zapisane w: {filepath}")
