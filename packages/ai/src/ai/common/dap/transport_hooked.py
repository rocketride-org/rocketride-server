"""
A ``TransportWebSocket`` that reports the moment its socket stops receiving.

The SDK transport waits for every in-flight message handler before it reports
a disconnect, so a long handler delays the notice by its whole run time. The
task's data channel needs to know about the close at once — to tell the engine
to reconnect and to fail its own pending requests — so this subclass adds one
hook, ``on_closing``, fired when the receive loop exits and before the drain.
"""

from typing import Awaitable, Callable, Optional

from rocketride.core import TransportWebSocket


class TransportWebSocketHooked(TransportWebSocket):
    """``TransportWebSocket`` with an ``on_closing`` hook ahead of the handler drain."""

    def __init__(self, *args, on_closing: Optional[Callable[[], Awaitable[None]]] = None, **kwargs) -> None:
        """Create the transport.

        Args:
            *args: Passed to ``TransportWebSocket``.
            on_closing: Awaited once, as soon as the receive loop has exited.
            **kwargs: Passed to ``TransportWebSocket``.
        """
        super().__init__(*args, **kwargs)
        self._on_closing = on_closing

    async def _receive_loop(self) -> None:
        """Run the SDK receive loop, then fire ``on_closing`` before the caller drains handlers."""
        try:
            await super()._receive_loop()
        finally:
            hook, self._on_closing = self._on_closing, None
            if hook is not None:
                await hook()
