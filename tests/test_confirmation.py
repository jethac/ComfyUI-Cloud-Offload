import threading

import pytest

from confirmation import ConfirmationBroker, ConfirmationError


def report():
    return {
        "candidates": [
            {"candidate_id": "gpu-1"},
            {"candidate_id": "gpu-2"},
        ]
    }


def test_one_time_confirmation_returns_validated_browser_decision():
    broker = ConfirmationBroker()
    confirmation_id = broker.open(report(), "part-1")

    assert broker.resolve(
        confirmation_id,
        {
            "action": "start_now",
            "candidate_id": "gpu-2",
            "dont_show_again": True,
        },
    )
    assert broker.wait(confirmation_id) == {
        "action": "start_now",
        "candidate_id": "gpu-2",
        "dont_show_again": True,
    }
    assert broker.resolve(
        confirmation_id, {"action": "cancel"}
    ) is False


def test_confirmation_rejects_a_candidate_outside_the_safe_report():
    broker = ConfirmationBroker()
    confirmation_id = broker.open(report(), "part-1")

    with pytest.raises(ConfirmationError, match="not in the current preflight"):
        broker.resolve(
            confirmation_id,
            {"action": "start_now", "candidate_id": "gpu-3"},
        )

    broker.discard(confirmation_id)


def test_cancellation_stops_a_waiting_confirmation_before_rental():
    broker = ConfirmationBroker()
    confirmation_id = broker.open(report(), "part-1")
    cancellation = threading.Event()
    cancellation.set()

    with pytest.raises(ConfirmationError, match="cancelled before rental"):
        broker.wait(confirmation_id, cancellation_event=cancellation)
