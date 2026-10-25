import pytest

from iot_mycelium.persistent_agent import PersistentAgent


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    """Każdy test ma własny katalog danych – nic nie trafia do data/ w repo."""
    data = tmp_path / "data"
    monkeypatch.setenv("IOT_MYCELIUM_DATA_DIR", str(data))
    PersistentAgent.clear_cache()
    yield data
    PersistentAgent.clear_cache()
