# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Async façade over the engine's sync `instance.invoke()` control-plane.

The engine's `IFilterInstance.invoke(param, component_id)` is sync —
changing it would require touching C++/Python bindings. Instead we
wrap it in a `ThreadPoolExecutor` so `flow_*` drivers can `await` it
and compose with `asyncio.gather()` natively.

When the engine eventually exposes a real async entry point, only this
file needs to change.
"""

from __future__ import annotations

import asyncio
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Optional

_DEFAULT_WORKERS = max(4, min(32, (os.cpu_count() or 4) * 4))


class AsyncInvoker:
    """Awaits `instance.invoke()` from async code via a shared thread pool.

    `sync_invoke` is any callable with the shape
    ``(param, component_id=str) -> Any`` — typically the bound method
    ``self.instance.invoke`` from an `IInstanceBase` subclass.

    The executor is shared by default so N concurrent drivers reuse
    the same pool. Pass `executor=...` to isolate a driver if needed.
    """

    _shared_executor: Optional[ThreadPoolExecutor] = None

    def __init__(
        self,
        sync_invoke: Callable[..., Any],
        *,
        executor: Optional[ThreadPoolExecutor] = None,
    ) -> None:
        """Wrap `sync_invoke` so it can be awaited from async code."""
        self._sync_invoke = sync_invoke
        self._executor = executor or self._get_shared_executor()

    @classmethod
    def _get_shared_executor(cls) -> ThreadPoolExecutor:
        if cls._shared_executor is None:
            cls._shared_executor = ThreadPoolExecutor(
                max_workers=_DEFAULT_WORKERS,
                thread_name_prefix='flow-invoker',
            )
        return cls._shared_executor

    async def invoke(self, param: Any, *, component_id: str = '') -> Any:
        """Await a call into `instance.invoke(param, component_id=...)`."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._executor,
            lambda: self._sync_invoke(param, component_id=component_id),
        )
