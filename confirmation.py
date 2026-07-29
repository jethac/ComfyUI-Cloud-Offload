"""One-time browser decisions for paid Cloud Offload rental confirmation."""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any


class ConfirmationError(RuntimeError):
    """A confirmation request was invalid, cancelled, or not answered."""


@dataclass
class _PendingConfirmation:
    report: dict[str, Any]
    partition_id: str
    event: threading.Event = field(default_factory=threading.Event)
    decision: dict[str, Any] | None = None


class ConfirmationBroker:
    """Join one worker thread to one browser response without storing reports."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._pending: dict[str, _PendingConfirmation] = {}

    def open(self, report: dict[str, Any], partition_id: str) -> str:
        confirmation_id = str(uuid.uuid4())
        with self._lock:
            self._pending[confirmation_id] = _PendingConfirmation(
                report=report,
                partition_id=str(partition_id or ""),
            )
        return confirmation_id

    def resolve(self, confirmation_id: str, decision: dict[str, Any]) -> bool:
        with self._lock:
            pending = self._pending.get(str(confirmation_id))
            if pending is None or pending.event.is_set():
                return False
            normalized = self._validated_decision(pending.report, decision)
            pending.decision = normalized
            pending.event.set()
            return True

    def wait(
        self,
        confirmation_id: str,
        *,
        cancellation_event: threading.Event | None = None,
        timeout_seconds: float = 300,
    ) -> dict[str, Any]:
        key = str(confirmation_id)
        deadline = time.monotonic() + max(1.0, float(timeout_seconds))
        try:
            while True:
                with self._lock:
                    pending = self._pending.get(key)
                if pending is None:
                    raise ConfirmationError("Rental confirmation is no longer active")
                if pending.event.wait(0.1):
                    if pending.decision is None:
                        raise ConfirmationError("Rental confirmation returned no decision")
                    return pending.decision
                if cancellation_event is not None and cancellation_event.is_set():
                    raise ConfirmationError("Cloud partition was cancelled before rental")
                if time.monotonic() >= deadline:
                    raise ConfirmationError("Rental confirmation timed out before launch")
        finally:
            with self._lock:
                self._pending.pop(key, None)

    def discard(self, confirmation_id: str) -> None:
        with self._lock:
            self._pending.pop(str(confirmation_id), None)

    @staticmethod
    def _validated_decision(
        report: dict[str, Any], decision: dict[str, Any]
    ) -> dict[str, Any]:
        if not isinstance(decision, dict):
            raise ConfirmationError("Rental confirmation decision must be an object")
        action = str(decision.get("action") or "").strip().lower()
        if action not in {"start_now", "countdown_elapsed", "cancel"}:
            raise ConfirmationError("Rental confirmation action is not supported")
        if action == "cancel":
            return {"action": "cancel", "dont_show_again": False}
        candidate_ids = {
            str(item.get("candidate_id") or "")
            for item in report.get("candidates") or []
            if item.get("candidate_id")
        }
        candidate_id = str(decision.get("candidate_id") or "")
        if candidate_id not in candidate_ids:
            raise ConfirmationError(
                "The selected GPU is not in the current preflight report"
            )
        return {
            "action": action,
            "candidate_id": candidate_id,
            "dont_show_again": bool(decision.get("dont_show_again")),
        }


confirmation_broker = ConfirmationBroker()
