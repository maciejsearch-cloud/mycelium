"""Network Visualizer – interaktywne wykresy Plotly sieci neuronowej."""

from __future__ import annotations

import numpy as np
import plotly.graph_objects as go
from plotly.subplots import make_subplots


class NetworkVisualizer:
    """Klasa do wizualizacji sieci neuronowej"""

    def __init__(self, input_dim: int, hidden_dim: int, output_dim: int):
        self.input_dim = input_dim
        self.hidden_dim = hidden_dim
        self.output_dim = output_dim

        # Pozycje neuronów dla wizualizacji
        self.positions = self._calculate_positions()

    def _calculate_positions(self):
        """Oblicza pozycje neuronów dla 2-warstwowej sieci"""
        positions = {}

        # Warstwa wejściowa
        for i in range(self.input_dim):
            positions[f"input_{i}"] = (0, i - self.input_dim / 2 + 0.5)

        # Warstwa ukryta
        for i in range(self.hidden_dim):
            positions[f"hidden_{i}"] = (2, i - self.hidden_dim / 2 + 0.5)

        # Warstwa wyjściowa
        for i in range(self.output_dim):
            positions[f"output_{i}"] = (4, i - self.output_dim / 2 + 0.5)

        return positions

    def create_network_plot(self, weights: dict, activations: dict | None = None, title: str = "Sieć Neuronowa"):
        """
        Tworzy interaktywny wykres sieci neuronowej

        Args:
            weights: {'W1': array, 'W2': array} - wagi sieci
            activations: {'a1': array, 'a2': array} - aktywacje neuronów
            title: Tytuł wykresu
        """
        fig = go.Figure()

        # Dodaj neurony jako punkty
        for node_name, (x, y) in self.positions.items():
            # Określ kolor neuronu na podstawie aktywacji
            color = "lightblue"
            size = 20

            if activations:
                if "input_" in node_name and "a0" in activations:
                    idx = int(node_name.split("_")[1])
                    activation = activations["a0"][0, idx] if idx < activations["a0"].shape[1] else 0
                    alpha = max(0.1, min(1.0, abs(activation)))  # Ogranicz alpha do 0.1-1.0
                    alpha_rounded = round(alpha, 3)  # Zaokrągl do 3 miejsc po przecinku
                    color = f"rgba(0, 123, 255, {alpha_rounded})"
                    size = 15 + abs(activation) * 15
                elif "hidden_" in node_name and "a1" in activations:
                    idx = int(node_name.split("_")[1])
                    activation = activations["a1"][0, idx] if idx < activations["a1"].shape[1] else 0
                    alpha = max(0.1, min(1.0, abs(activation)))  # Ogranicz alpha do 0.1-1.0
                    alpha_rounded = round(alpha, 3)  # Zaokrągl do 3 miejsc po przecinku
                    color = f"rgba(40, 167, 69, {alpha_rounded})"
                    size = 15 + abs(activation) * 15
                elif "output_" in node_name and "a2" in activations:
                    idx = int(node_name.split("_")[1])
                    activation = activations["a2"][0, idx] if idx < activations["a2"].shape[1] else 0
                    alpha = max(0.1, min(1.0, abs(activation)))  # Ogranicz alpha do 0.1-1.0
                    alpha_rounded = round(alpha, 3)  # Zaokrągl do 3 miejsc po przecinku
                    color = f"rgba(255, 193, 7, {alpha_rounded})"
                    size = 15 + abs(activation) * 15

            # Dodaj neuron
            fig.add_trace(
                go.Scatter(
                    x=[x],
                    y=[y],
                    mode="markers+text",
                    marker=dict(size=size, color=color, line=dict(width=2, color="black")),
                    text=[node_name.split("_")[0].upper()],
                    textposition="middle center",
                    name=node_name,
                    showlegend=False,
                )
            )

        # Dodaj połączenia (wagi)
        # Warstwa 1 -> Warstwa ukryta
        if "W1" in weights:
            W1 = weights["W1"]
            for i in range(self.input_dim):
                for j in range(self.hidden_dim):
                    weight = W1[i, j]
                    start_pos = self.positions[f"input_{i}"]
                    end_pos = self.positions[f"hidden_{j}"]

                    # Grubość linii = siła wagi
                    width = abs(weight) * 3
                    color = "red" if weight < 0 else "green"
                    opacity = min(abs(weight), 1.0)

                    fig.add_trace(
                        go.Scatter(
                            x=[start_pos[0], end_pos[0]],
                            y=[start_pos[1], end_pos[1]],
                            mode="lines",
                            line=dict(width=width, color=color),
                            opacity=opacity,
                            showlegend=False,
                            hoverinfo="text",
                            hovertext=f"W1[{i},{j}] = {weight:.3f}",
                        )
                    )

        # Warstwa ukryta -> Warstwa wyjściowa
        if "W2" in weights:
            W2 = weights["W2"]
            for i in range(self.hidden_dim):
                for j in range(self.output_dim):
                    weight = W2[i, j]
                    start_pos = self.positions[f"hidden_{i}"]
                    end_pos = self.positions[f"output_{j}"]

                    # Grubość linii = siła wagi
                    width = abs(weight) * 3
                    color = "red" if weight < 0 else "green"
                    opacity = min(abs(weight), 1.0)

                    fig.add_trace(
                        go.Scatter(
                            x=[start_pos[0], end_pos[0]],
                            y=[start_pos[1], end_pos[1]],
                            mode="lines",
                            line=dict(width=width, color=color),
                            opacity=opacity,
                            showlegend=False,
                            hoverinfo="text",
                            hovertext=f"W2[{i},{j}] = {weight:.3f}",
                        )
                    )

        # Ustawienia layout
        fig.update_layout(
            title=title,
            xaxis=dict(showgrid=False, zeroline=False, showticklabels=False),
            yaxis=dict(showgrid=False, zeroline=False, showticklabels=False),
            showlegend=False,
            hovermode="closest",
            height=420,
        )

        # Dodaj etykiety warstw
        fig.add_annotation(
            x=0, y=self.input_dim / 2 + 0.5, text="WARSTWA WEJŚCIOWA", showarrow=False, font=dict(size=12, color="blue")
        )
        fig.add_annotation(
            x=2, y=self.hidden_dim / 2 + 0.5, text="WARSTWA UKRYTA", showarrow=False, font=dict(size=12, color="green")
        )
        fig.add_annotation(
            x=4,
            y=self.output_dim / 2 + 0.5,
            text="WARSTWA WYJŚCIOWA",
            showarrow=False,
            font=dict(size=12, color="orange"),
        )

        return fig

    def create_weight_evolution_plot(self, weight_history: list, title: str = "Ewolucja Wag"):
        """
        Tworzy wykres ewolucji wag w czasie

        Args:
            weight_history: Lista słowników z wagami w czasie
            title: Tytuł wykresu
        """
        if not weight_history:
            return go.Figure()

        fig = make_subplots(
            rows=2,
            cols=2,
            subplot_titles=("W1 - średnia", "W1 - odchylenie", "W2 - średnia", "W2 - odchylenie"),
            specs=[[{"secondary_y": False}, {"secondary_y": False}], [{"secondary_y": False}, {"secondary_y": False}]],
        )

        epochs = list(range(len(weight_history)))

        # W1 statystyki
        w1_means = [np.mean(np.abs(w["W1"])) for w in weight_history]
        w1_stds = [np.std(w["W1"]) for w in weight_history]

        # W2 statystyki
        w2_means = [np.mean(np.abs(w["W2"])) for w in weight_history]
        w2_stds = [np.std(w["W2"]) for w in weight_history]

        # Wykresy
        fig.add_trace(go.Scatter(x=epochs, y=w1_means, name="W1 średnia", line=dict(color="blue")), row=1, col=1)
        fig.add_trace(go.Scatter(x=epochs, y=w1_stds, name="W1 odchylenie", line=dict(color="red")), row=1, col=2)
        fig.add_trace(go.Scatter(x=epochs, y=w2_means, name="W2 średnia", line=dict(color="green")), row=2, col=1)
        fig.add_trace(go.Scatter(x=epochs, y=w2_stds, name="W2 odchylenie", line=dict(color="orange")), row=2, col=2)

        fig.update_layout(title=title, height=600, showlegend=False)

        # Ustawienia osi
        for i in range(1, 3):
            for j in range(1, 3):
                fig.update_xaxes(title_text="Epoka", row=i, col=j)
                fig.update_yaxes(title_text="Wartość", row=i, col=j)

        return fig

    def create_activation_heatmap(self, activations: dict, title: str = "Aktywacje Neuronów"):
        """
        Tworzy heatmap aktywacji neuronów

        Args:
            activations: {'a0': array, 'a1': array, 'a2': array}
            title: Tytuł wykresu
        """
        fig = make_subplots(
            rows=1,
            cols=3,
            subplot_titles=("Wejście", "Ukryta", "Wyjście"),
            specs=[[{"type": "heatmap"}, {"type": "heatmap"}, {"type": "heatmap"}]],
        )

        # Warstwa wejściowa
        if "a0" in activations:
            fig.add_trace(go.Heatmap(z=activations["a0"], colorscale="Blues", name="Wejście"), row=1, col=1)

        # Warstwa ukryta
        if "a1" in activations:
            fig.add_trace(go.Heatmap(z=activations["a1"], colorscale="Greens", name="Ukryta"), row=1, col=2)

        # Warstwa wyjściowa
        if "a2" in activations:
            fig.add_trace(go.Heatmap(z=activations["a2"], colorscale="Oranges", name="Wyjście"), row=1, col=3)

        fig.update_layout(title=title, height=300, showlegend=False)

        return fig
