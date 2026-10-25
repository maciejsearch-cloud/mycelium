"""Mycelium AI – prawdziwe modele (PyTorch, CPU) na prawdziwych danych.

Moduły:

- :mod:`datasets` – pobieranie i przygotowanie publicznych zbiorów (UCI HAR, Fashion-MNIST,
  CLINC150, NAB) z syntetycznymi odpowiednikami do testów offline,
- :mod:`models` – architektury (MLP, CNN, tekst, GRU) budowane ze specyfikacji,
- :mod:`training` – trening lokalny i ewaluacja na zbiorach odłożonych,
- :mod:`federated` – uczenie federacyjne (FedAvg/FedProx, ważenie jakością, DP, secure aggregation),
- :mod:`vector_memory` – wspólna pamięć wektorowa doświadczeń agentów,
- :mod:`orchestrator` – warstwa agentowa (wybór zadań, Optuna, neuroewolucja),
- :mod:`score` – złożony wynik benchmarku (Mycelium Benchmark Score, następca „IQ”).

Starsza ścieżka NumPy (``iot_mycelium.universal_agent``) zostaje bez zmian jako legacy.
"""
