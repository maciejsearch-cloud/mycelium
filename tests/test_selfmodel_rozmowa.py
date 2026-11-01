"""Interfejs relacji/decyzji rozmówcy dla SelfModelu – bez sieci (RPC podstawiony)."""

from iot_mycelium.selfmodel import rozmowa


def test_decisions_shape():
    rows = [
        {
            "id": "rozmowa-3",
            "at": "2026-11-01T12:00:00+00:00",
            "kind": "moderacja-mute_auto",
            "choice": {"minutes": 10, "evidence": 5},
            "reason": "zalew: 5 wiadomości w 60 s",
            "outcome": {"status": "reverted", "decided_at": "2026-11-01T12:05:00+00:00"},
            "outcome_pl": "cofnięta przez Developera",
        }
    ]
    ds = rozmowa.moderation_decisions(lambda fn, a: rows if fn == "myc_self_rel_decisions" else None)
    assert len(ds) == 1 and ds[0].choice == {"minutes": 10, "evidence": 5}
    assert ds[0].outcome_pl == "cofnięta przez Developera" and ds[0].kind.startswith("moderacja-")


def test_network_errors_are_honest():
    def boom(fn, a):
        raise OSError("offline")

    assert rozmowa.moderation_decisions(boom) == []
    assert rozmowa.relations_status(boom)["available"] is False
