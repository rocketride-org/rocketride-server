from __future__ import annotations

import threading
from dataclasses import dataclass, field
from enum import Enum
from time import monotonic
from typing import Dict, Optional


class TaskState(str, Enum):
    """Lifecycle states for a pipeline task."""
    STARTING     = "starting"
    INITIALIZING = "initializing"
    RUNNING      = "running"
    COMPLETED    = "completed"
    FAILED       = "failed"


_TERMINAL = frozenset({TaskState.COMPLETED, TaskState.FAILED})


@dataclass
class TaskRecord:
    """Snapshot of one task's tracked state. All times are monotonic seconds."""
    task_id:     str
    status:      TaskState
    start_time:  float
    end_time:    Optional[float]
    last_update: float

    @property
    def is_terminal(self) -> bool:
        return self.status in _TERMINAL

    @property
    def elapsed_seconds(self) -> float:
        end = self.end_time if self.end_time is not None else monotonic()
        return round(end - self.start_time, 4)

    def to_dict(self) -> dict:
        return {
            "task_id":         self.task_id,
            "status":          self.status.value,
            "start_time":      self.start_time,
            "end_time":        self.end_time,
            "last_update":     self.last_update,
            "elapsed_seconds": self.elapsed_seconds,
        }


class TaskTracker:
    """
    Thread-safe registry of TaskRecord entries keyed by task_id.

    Lifecycle call order (happy path):
        on_starting() -> on_initializing() -> on_running() -> on_completed()

    On error:
        on_starting() -> on_initializing() -> on_failed()

    Usage:
        from .task_tracker import tracker
        tracker.on_starting(self.id)
    """

    def __init__(self) -> None:
        self._lock    = threading.Lock()
        self._records: Dict[str, TaskRecord] = {}

    # ------------------------------------------------------------------
    # Lifecycle hooks
    # ------------------------------------------------------------------

    def on_starting(self, task_id: str) -> None:
        """Task received - execution environment about to be set up."""
        self._set(task_id, TaskState.STARTING, is_start=True)

    def on_initializing(self, task_id: str) -> None:
        """Environment ready - subprocess about to be spawned."""
        self._set(task_id, TaskState.INITIALIZING)

    def on_running(self, task_id: str) -> None:
        """Subprocess confirmed alive."""
        self._set(task_id, TaskState.RUNNING)

    def on_completed(self, task_id: str) -> None:
        """Task terminated cleanly."""
        self._set(task_id, TaskState.COMPLETED, is_end=True)

    def on_failed(self, task_id: str) -> None:
        """Task terminated with an error."""
        self._set(task_id, TaskState.FAILED, is_end=True)

    # ------------------------------------------------------------------
    # Query helpers
    # ------------------------------------------------------------------

    def get(self, task_id: str) -> Optional[TaskRecord]:
        """Return the current record, or None if task_id is unknown."""
        with self._lock:
            return self._records.get(task_id)

    def snapshot(self) -> Dict[str, dict]:
        """Return a serialisable copy of every tracked task."""
        with self._lock:
            return {tid: rec.to_dict() for tid, rec in self._records.items()}

    def active_ids(self) -> list:
        """IDs of tasks not yet in a terminal state."""
        with self._lock:
            return [
                tid for tid, rec in self._records.items()
                if not rec.is_terminal
            ]

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _set(
        self,
        task_id:  str,
        state:    TaskState,
        *,
        is_start: bool = False,
        is_end:   bool = False,
    ) -> None:
        now = monotonic()
        with self._lock:
            existing   = self._records.get(task_id)
            start_time = now if (is_start or existing is None) else existing.start_time
            end_time   = now if is_end else (existing.end_time if existing else None)
            self._records[task_id] = TaskRecord(
                task_id=task_id,
                status=state,
                start_time=start_time,
                end_time=end_time,
                last_update=now,
            )


# Module-level singleton - import this directly in task_engine.py
tracker = TaskTracker()
