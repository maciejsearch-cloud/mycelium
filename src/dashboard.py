"""Punkt wejścia dla ``streamlit run src/dashboard.py`` (lokalnie i na Streamlit Cloud).

Dodaje ``src/`` do ``sys.path``, więc działa również bez ``pip install -e .``.
Właściwy kod jest w ``iot_mycelium/dashboard.py``.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from iot_mycelium.dashboard import main  # noqa: E402

main()
