"""IoT Orchestrator – asynchroniczna symulacja urządzeń IoT z Mycelium Memory."""

from __future__ import annotations

import asyncio
import random
import time
from datetime import datetime
from typing import Any

from iot_mycelium.memory import MyceliumMemory
from iot_mycelium.optimized_agent import OptimizedXORAgent


class IoTOrchestrator:
    """
    Orchestrator symulujący ruch IoT z urządzeń.
    Każde 'kliknięcie' uruchamia nowego agenta, który uczy się z pamięci grzybni.
    """

    def __init__(self, mycelium_path: str | None = None, fusion_alpha: float = 0.7, training_epochs: int = 2000):
        self.mycelium = MyceliumMemory(mycelium_path)
        self.fusion_alpha = fusion_alpha
        self.training_epochs = training_epochs
        self.active_agents = 0
        self.total_agents_spawned = 0
        self.successful_updates = 0

    async def simulate_iot_click(self, device_id: str) -> dict[str, Any]:
        """
        Symuluje pojedyncze kliknięcie z urządzenia IoT.
        Uruchamia agenta, który uczy się i próbuje zaktualizować pamięć.
        """
        agent_id = f"agent_{self.total_agents_spawned:04d}"
        self.total_agents_spawned += 1
        self.active_agents += 1

        timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]

        print(f"\n🔵 [{timestamp}] [IoT Event] Device: {device_id} -> Spawning {agent_id}")

        try:
            # 1. Pobranie wag z grzybni
            shapes = {"W1": (2, 4), "b1": (1, 4), "W2": (4, 1), "b2": (1, 1)}

            mycelium_stats = self.mycelium.get_stats()
            is_empty = mycelium_stats["is_empty"]
            best_loss = mycelium_stats["best_loss"]

            if is_empty:
                print("   🍄 [Mycelium] Grzybnia pusta - generuję losowe wagi")
            else:
                print(f"   🍄 [Mycelium] Pobrano wagi (best_loss={best_loss:.6f}, alpha={self.fusion_alpha})")

            initial_weights = self.mycelium.get_fusion_weights(shapes, alpha=self.fusion_alpha)

            # 2. Tworzenie agenta z wagami z grzybni
            agent = OptimizedXORAgent(hidden_dim=4, learning_rate=0.5, initial_weights=initial_weights)

            # 3. Trening w tle (asyncio.to_thread dla CPU-bound operacji)
            print(f"   🏃 [Training] Rozpoczynam trening w tle ({self.training_epochs} epok)...")

            # KLUCZOWE: asyncio.to_thread() dla CPU-bound operacji
            # Zapobiega blokowaniu event loop
            result = await asyncio.to_thread(self._train_agent_blocking, agent, agent_id)

            # 4. Próba aktualizacji grzybni
            final_loss = result["final_loss"]
            final_accuracy = result["final_accuracy"]
            training_time = result["training_time"]

            weights = {"W1": agent.W1, "b1": agent.b1, "W2": agent.W2, "b2": agent.b2}

            updated = self.mycelium.update_memory(
                weights=weights,
                loss=final_loss,
                metadata={
                    "agent_id": agent_id,
                    "device_id": device_id,
                    "accuracy": final_accuracy,
                    "training_time": training_time,
                    "epochs": self.training_epochs,
                },
            )

            if updated:
                self.successful_updates += 1
                print(f"   ✅ [Mycelium] AKTUALIZACJA! Nowy rekord: {final_loss:.6f} (accuracy={final_accuracy:.3f})")
            else:
                print(f"   ⚪ [Mycelium] Brak aktualizacji (loss={final_loss:.6f} >= best={best_loss:.6f})")

            return {
                "agent_id": agent_id,
                "device_id": device_id,
                "final_loss": final_loss,
                "final_accuracy": final_accuracy,
                "updated_mycelium": updated,
                "training_time": training_time,
            }

        except Exception as e:
            print(f"   ❌ [Error] {agent_id}: {e}")
            raise
        finally:
            self.active_agents -= 1

    def _train_agent_blocking(self, agent: OptimizedXORAgent, agent_id: str) -> dict[str, Any]:
        """
        Blokująca funkcja treningu (CPU-bound).
        Wywoływana przez asyncio.to_thread() aby nie blokować event loop.
        """
        start_time = time.time()

        # Trening bez logowania (silent mode)
        best_accuracy = 0.0
        patience = 2000
        patience_counter = 0

        for epoch in range(self.training_epochs):
            # Forward pass
            z1, a1, z2, a2 = agent.forward_pass(agent.X)

            # Obliczanie metryk
            loss = agent.calculate_loss(agent.y, a2)
            accuracy = agent.calculate_accuracy(agent.y, a2)

            # Zapis historii co 100 epok
            if epoch % 100 == 0:
                agent.loss_history.append(loss)
                agent.accuracy_history.append(accuracy)

            # Early stopping check
            if accuracy > best_accuracy:
                best_accuracy = accuracy
                patience_counter = 0
                best_W1 = agent.W1.copy()
                best_W2 = agent.W2.copy()
                best_b1 = agent.b1.copy()
                best_b2 = agent.b2.copy()
            else:
                patience_counter += 1

            if patience_counter >= patience and accuracy >= 0.95:
                # Przywróć najlepsze wagi
                agent.W1 = best_W1
                agent.W2 = best_W2
                agent.b1 = best_b1
                agent.b2 = best_b2
                break

            # Backward pass
            dW1, db1, dW2, db2 = agent.backward_pass(agent.X, agent.y, z1, a1, a2)

            # Aktualizacja wag
            agent.update_weights(dW1, db1, dW2, db2)

        end_time = time.time()
        training_time = end_time - start_time

        # Finalna ewaluacja
        z1, a1, z2, a2 = agent.forward_pass(agent.X)
        final_loss = agent.calculate_loss(agent.y, a2)
        final_accuracy = agent.calculate_accuracy(agent.y, a2)

        return {"final_loss": final_loss, "final_accuracy": final_accuracy, "training_time": training_time}

    async def simulate_iot_traffic(
        self, num_devices: int = 5, duration_seconds: float = 30.0, click_interval_range: tuple = (0.5, 2.0)
    ):
        """
        Symuluje ruch IoT z wielu urządzeń przez określony czas.

        Args:
            num_devices: Liczba symulowanych urządzeń IoT
            duration_seconds: Czas trwania symulacji
            click_interval_range: Zakres losowych opóźnień między kliknięciami (min, max)
        """
        print("=" * 70)
        print("🌐 IoT ORCHESTRATOR - START SYMULACJI")
        print("=" * 70)
        print(f"Urządzenia IoT: {num_devices}")
        print(f"Czas trwania: {duration_seconds}s")
        print(f"Interwał kliknięć: {click_interval_range[0]}-{click_interval_range[1]}s")
        print(f"Epoki treningu: {self.training_epochs}")
        print(f"Fusion alpha: {self.fusion_alpha}")
        print("=" * 70)

        start_time = asyncio.get_running_loop().time()

        async def device_simulator(device_id: str):
            """Symulator pojedynczego urządzenia IoT"""
            while True:
                current_time = asyncio.get_running_loop().time()
                elapsed = current_time - start_time

                if elapsed >= duration_seconds:
                    break

                # Losowe opóźnienie między kliknięciami
                delay = random.uniform(*click_interval_range)
                await asyncio.sleep(delay)

                # Sprawdź czy jeszcze mamy czas
                if asyncio.get_running_loop().time() - start_time >= duration_seconds:
                    break

                # Symuluj kliknięcie
                try:
                    await self.simulate_iot_click(device_id)
                except Exception as e:
                    print(f"❌ Device {device_id} error: {e}")

        # Uruchom wszystkie urządzenia równolegle
        tasks = [device_simulator(f"device_{i:02d}") for i in range(num_devices)]

        await asyncio.gather(*tasks)

        # Podsumowanie
        print("\n" + "=" * 70)
        print("📊 PODSUMOWANIE SYMULACJI")
        print("=" * 70)

        mycelium_stats = self.mycelium.get_stats()

        print(f"Całkowita liczba agentów: {self.total_agents_spawned}")
        print(f"Udane aktualizacje grzybni: {self.successful_updates}")
        print(f"Współczynnik sukcesu: {self.successful_updates / max(self.total_agents_spawned, 1) * 100:.1f}%")
        print("\nStatystyki Mycelium:")
        print(f"  - Najlepszy loss: {mycelium_stats['best_loss']:.6f}")
        print(f"  - Całkowite aktualizacje: {mycelium_stats['total_updates']}")
        print(f"  - Ostatnia aktualizacja: {mycelium_stats['last_updated']}")
        print("=" * 70)


async def main(num_devices: int = 5, duration_seconds: float = 30.0, epochs: int = 2000) -> None:
    """Symulacja ruchu IoT (domyślnie 5 urządzeń przez 30 s)."""
    orchestrator = IoTOrchestrator(fusion_alpha=0.7, training_epochs=epochs)
    await orchestrator.simulate_iot_traffic(
        num_devices=num_devices,
        duration_seconds=duration_seconds,
        click_interval_range=(0.5, 2.0),
    )
