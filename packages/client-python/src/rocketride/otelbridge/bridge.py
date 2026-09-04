# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Run loop for the RocketRide OpenTelemetry bridge.

This module connects a RocketRideClient to the engine's WebSocket monitor
protocol and forwards the event stream to the OTel mappers:

    - apaevt_task / apaevt_flow / apaevt_sse  -> FlowSpanMapper.handle_event
    - apaevt_status_update                    -> MetricsMapper.handle_status

The bridge subscribes with the wildcard monitor key ``{'token': '*'}`` (the
documented scope for an ingestion service) for the TASK, SUMMARY, FLOW and
SSE event types. Monitor subscriptions are per-connection and not durable,
but the SDK's EventMixin replays every ``add_monitor`` subscription on each
(re)connect, so the bridge subscribes exactly once and relies on the SDK
for resubscription. Reconnection after a connection loss uses capped
exponential backoff.

Lifecycle:
    - Startup connection failure -> clean stderr message, exit code 2
    - SIGINT/SIGTERM -> close all open spans, flush exporters, exit code 0

The event dispatcher wraps every mapper call in its own try/except because
the SDK swallows exceptions raised by user event handlers; without local
logging, mapper failures would be invisible.

This module imports ``opentelemetry`` only lazily (via the mapper/setup
modules) so it is importable without the ``rocketride[otel]`` extra.

Components:
    run_bridge: Async entry point running the bridge until stopped
"""

import asyncio
import signal
import sys
from typing import Any, Callable, Dict, Optional

from .config import OtelConfig

# Wildcard monitor subscription: all tasks visible to this API key
MONITOR_KEY: Dict[str, str] = {'token': '*'}

# Event types the bridge consumes (case-insensitive on the server)
MONITOR_TYPES = ('TASK', 'SUMMARY', 'FLOW', 'SSE')

# Events routed to FlowSpanMapper.handle_event
_SPAN_EVENTS = ('apaevt_task', 'apaevt_flow', 'apaevt_sse')

# Event routed to MetricsMapper.handle_status
_STATUS_EVENT = 'apaevt_status_update'


def _log(message: str) -> None:
    """Write a bridge diagnostic line to stderr (never stdout)."""
    print(f'otel-bridge: {message}', file=sys.stderr)


def _loop_owns_signal(loop: Any, sig: int) -> bool:
    """
    True when the running loop already has an asyncio callback for ``sig``.

    ``loop.add_signal_handler`` replaces any existing callback and asyncio
    exposes no way to read one back, so the only way not to steal an
    embedder's SIGINT/SIGTERM is to look at the loop's own registry. The
    attribute is private, hence the defensive access: when it is missing
    (a non-CPython or non-Unix loop) the answer is "unknown", and the caller
    falls back to the previous behaviour of registering its own handler.
    """
    handlers = getattr(loop, '_signal_handlers', None)
    try:
        return bool(handlers) and sig in handlers
    except TypeError:  # pragma: no cover - unexpected registry type
        return False


async def _wait_for_stop(stop_event: asyncio.Event, timeout: float) -> None:
    """Wait until stop_event is set or timeout elapses, whichever is first."""
    try:
        await asyncio.wait_for(stop_event.wait(), timeout)
    except asyncio.TimeoutError:
        pass


async def run_bridge(
    client: Any,
    config: OtelConfig,
    mapper_factory: Optional[Callable[[], Any]] = None,
    metrics_factory: Optional[Callable[[], Any]] = None,
    *,
    shutdown_fn: Optional[Callable[[], None]] = None,
    stop_event: Optional[asyncio.Event] = None,
    install_signal_handlers: bool = True,
    initial_backoff: float = 1.0,
    max_backoff: float = 30.0,
    poll_interval: float = 0.5,
) -> int:
    """
    Run the OpenTelemetry bridge until interrupted.

    Subscribes to the engine's monitor event stream and dispatches events to
    the span and metrics mappers, reconnecting with capped exponential
    backoff on connection loss. When no factories are provided, the OTLP
    providers are built from ``config`` via
    :func:`rocketride.otelbridge.setup.build_providers` (this is the only
    point that imports ``opentelemetry`` and therefore requires the
    ``rocketride[otel]`` extra).

    Args:
        client: RocketRideClient (or compatible) instance. May already be
            connected; otherwise the bridge connects it.
        config: Resolved bridge configuration.
        mapper_factory: Optional zero-arg factory returning a span mapper
            with ``handle_event(event_name, body)`` and ``close_all()``.
            Injectable for tests; defaults to FlowSpanMapper on the real
            OTLP tracer.
        metrics_factory: Optional zero-arg factory returning a metrics
            mapper with ``handle_status(body)``. Ignored (never called)
            when ``config.no_metrics`` is set; defaults to MetricsMapper
            on the real OTLP meter.
        shutdown_fn: Optional callable flushing/shutting down exporters at
            exit. Defaults to the shutdown function returned by
            ``build_providers`` when providers are built here.
        stop_event: Optional externally controlled stop signal (used by
            tests); created internally when absent. SIGINT/SIGTERM set it.
        install_signal_handlers: When True (the CLI's case), SIGINT/SIGTERM
            are wired to ``stop_event``. Pass False when embedding the bridge
            in an application that owns process signals; a signal the running
            loop already has a callback for is left alone either way, because
            ``loop.add_signal_handler`` REPLACES rather than chains and the
            previous asyncio callback cannot be restored afterwards.
        initial_backoff: First reconnect delay in seconds.
        max_backoff: Reconnect delay cap in seconds.
        poll_interval: Connection health poll interval in seconds.

    Returns:
        int: 0 on graceful shutdown (signal or stop_event), 2 when the
        startup connection or the initial monitor subscription fails.

    Shutdown order:
        1. Signal handlers this call installed are removed (previous
           process-level handlers restored; handlers owned by someone else
           were never touched)
        2. Event dispatcher detached from the client
        3. ``mapper.close_all()`` — open spans are ended
        4. ``shutdown_fn()`` — exporters flush pending telemetry
    """
    # ---------------------------------------------------------------------
    # Build mappers (and OTLP providers when no factories are injected)
    # ---------------------------------------------------------------------
    mapper = mapper_factory() if mapper_factory is not None else None
    metrics = None
    if not config.no_metrics and metrics_factory is not None:
        metrics = metrics_factory()

    needs_tracer = mapper is None
    needs_meter = metrics is None and not config.no_metrics

    if needs_tracer or needs_meter:
        # Lazy imports: these modules require the 'rocketride[otel]' extra
        from .mapper import FlowSpanMapper, MetricsMapper
        from .setup import build_providers

        tracer, meter, provider_shutdown = build_providers(config)
        if shutdown_fn is None:
            shutdown_fn = provider_shutdown
        if needs_tracer:
            mapper = FlowSpanMapper(tracer, include_content=config.include_content)
        if needs_meter:
            metrics = MetricsMapper(meter)

    if stop_event is None:
        stop_event = asyncio.Event()

    # ---------------------------------------------------------------------
    # Attach the event dispatcher, chaining any pre-existing handler
    # ---------------------------------------------------------------------
    previous_handler = getattr(client, '_caller_on_event', None)

    async def _dispatch(message: Dict[str, Any]) -> None:
        """Route one monitor event to the mappers, logging (not raising) failures."""
        event_name = message.get('event', '')
        body = message.get('body') or {}

        # The SDK swallows handler exceptions, so log locally or lose them.
        try:
            if event_name == _STATUS_EVENT:
                if metrics is not None:
                    metrics.handle_status(body)
            elif event_name in _SPAN_EVENTS:
                mapper.handle_event(event_name, body)
        except Exception as exc:
            _log(f'error handling {event_name}: {exc}')

        # Preserve any handler installed before the bridge (e.g. CLI forwarding)
        if previous_handler is not None:
            try:
                await previous_handler(message)
            except Exception as exc:
                _log(f'error in chained event handler for {event_name}: {exc}')

    client._caller_on_event = _dispatch

    # ---------------------------------------------------------------------
    # Signal handling: SIGINT/SIGTERM trigger a graceful stop
    # ---------------------------------------------------------------------
    loop = asyncio.get_running_loop()
    registered_signals = []
    previous_signal_handlers: Dict[int, Any] = {}
    if install_signal_handlers:
        for sig in (signal.SIGINT, signal.SIGTERM):
            if _loop_owns_signal(loop, sig):
                # An embedding application already registered an asyncio
                # callback for this signal. add_signal_handler would REPLACE
                # it and there is no API to restore it on exit, so leave the
                # signal to its owner: the bridge still stops via stop_event
                # or the caller's KeyboardInterrupt path.
                _log(f'signal {sig} already handled by the running loop; leaving it to its owner')
                continue
            try:
                previous_signal_handlers[sig] = signal.getsignal(sig)
                loop.add_signal_handler(sig, stop_event.set)
                registered_signals.append(sig)
            except (NotImplementedError, RuntimeError, ValueError, OSError):
                # Not supported on this platform/thread; Ctrl+C falls back to
                # KeyboardInterrupt handling in the caller.
                previous_signal_handlers.pop(sig, None)

    try:
        # -----------------------------------------------------------------
        # Startup: connect and subscribe once. The SDK resubscribes all
        # add_monitor keys automatically on every reconnect.
        # -----------------------------------------------------------------
        if not client.is_connected():
            try:
                await client.connect()
            except Exception as exc:
                _log(f'unable to connect to RocketRide server: {exc}')
                return 2

        try:
            await client.add_monitor(dict(MONITOR_KEY), list(MONITOR_TYPES))
        except Exception as exc:
            _log(f'monitor subscription failed: {exc}')
            return 2

        # -----------------------------------------------------------------
        # Main loop: watch connection health, reconnect with capped backoff
        # -----------------------------------------------------------------
        backoff = initial_backoff
        was_connected = True
        while not stop_event.is_set():
            if client.is_connected():
                if not was_connected:
                    _log('reconnected')
                    was_connected = True
                backoff = initial_backoff
                await _wait_for_stop(stop_event, poll_interval)
            else:
                was_connected = False
                try:
                    await client.connect()
                except Exception as exc:
                    _log(f'reconnect failed, retrying in {backoff:.0f}s: {exc}')
                    await _wait_for_stop(stop_event, backoff)
                    backoff = min(backoff * 2, max_backoff)

        return 0

    finally:
        # Remove signal handlers and restore whatever was installed before
        for sig in registered_signals:
            try:
                loop.remove_signal_handler(sig)
                previous = previous_signal_handlers.get(sig)
                if previous is not None:
                    signal.signal(sig, previous)
            except (NotImplementedError, RuntimeError, ValueError, OSError):
                pass

        # Detach the dispatcher, restoring any chained handler
        client._caller_on_event = previous_handler

        # Close open spans first, then flush exporters
        try:
            mapper.close_all()
        except Exception as exc:
            _log(f'error closing spans: {exc}')

        if shutdown_fn is not None:
            try:
                shutdown_fn()
            except Exception as exc:
                _log(f'error during exporter shutdown: {exc}')
