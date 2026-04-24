# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Structured observability for flow drivers.

Every driver invocation emits a `span` with lifecycle events (`start`,
`decision`, `dispatch`, `emit`, `end`, `error`). The Python Director
from discussion #680 will consume the same shape — `flow_base` sets
the precedent so no downstream migration is needed.
"""

from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Optional

_logger = logging.getLogger('rocketride.flow')


class FlowTrace:
    """Emits structured events tied to a single flow driver invocation."""

    def __init__(
        self,
        node_id: str,
        driver_name: str,
        logger: Optional[logging.Logger] = None,
    ) -> None:
        """Wire the trace to a node / driver identity and a logger."""
        self.node_id = node_id
        self.driver_name = driver_name
        self._log = logger or _logger

    @asynccontextmanager
    async def span(self, chunk: Any) -> AsyncIterator['FlowTrace']:
        """Lifecycle wrapper: emits `start` and `end` (or `error`) events."""
        run_id = uuid.uuid4().hex
        self._emit('start', run_id, {'chunk_type': type(chunk).__name__})
        t0 = time.monotonic()
        try:
            yield self
        except Exception as exc:
            self._emit(
                'error',
                run_id,
                {
                    'duration_s': round(time.monotonic() - t0, 6),
                    'error_type': type(exc).__name__,
                    'error_msg': str(exc),
                },
            )
            raise
        else:
            self._emit('end', run_id, {'duration_s': round(time.monotonic() - t0, 6)})

    def decision(self, run_id: str, decision: str, **fields: Any) -> None:
        self._emit('decision', run_id, {'decision': decision, **fields})

    def dispatch(self, run_id: str, **fields: Any) -> None:
        self._emit('dispatch', run_id, fields)

    def emit_event(self, run_id: str, **fields: Any) -> None:
        self._emit('emit', run_id, fields)

    def error(self, run_id: str, message: str, **fields: Any) -> None:
        """Surface a recoverable error (fail-closed decision, bad config).

        Distinct from the `span`-level `error` event which is emitted when
        the async context manager sees an uncaught exception. This one is
        for errors the driver *handled* (e.g. SandboxError caught and
        routed to ELSE) but which the user still needs to see in the UI.

        ``message`` is stored under ``error_message`` in the LogRecord
        extras because ``message`` itself is reserved by Python's logging
        machinery — using it raises `KeyError` at record-creation time.
        """
        self._emit('error', run_id, {'error_message': message, **fields})

    def _emit(self, event: str, run_id: str, fields: dict) -> None:
        self._log.info(
            'flow.%s node=%s driver=%s run_id=%s %s',
            event,
            self.node_id,
            self.driver_name,
            run_id,
            ' '.join(f'{k}={v!r}' for k, v in fields.items()),
            extra={
                'flow_event': event,
                'flow_node_id': self.node_id,
                'flow_driver': self.driver_name,
                'flow_run_id': run_id,
                **fields,
            },
        )
