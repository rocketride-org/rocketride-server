# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""OpenTelemetry tracing configuration for RocketRide Server.

Provides a configurable TracerProvider driven by environment variables:

  OTEL_SERVICE_NAME          — service name (default: ``rocketride``)
  OTEL_EXPORTER_TYPE         — ``otlp``, ``console``, or ``none`` (default: ``none``)
  OTEL_EXPORTER_OTLP_ENDPOINT — OTLP collector endpoint (default: ``http://localhost:4317``)

Call ``setup_tracing(app)`` once during application startup to wire
everything up, including automatic FastAPI instrumentation.
"""

import os
import threading
from typing import Optional

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter
from opentelemetry.sdk.resources import Resource

__all__ = [
    'setup_tracing',
    'get_tracer',
    'shutdown_tracing',
]

# Module-level tracer provider reference so we can shut it down cleanly.
_tracer_provider: Optional[TracerProvider] = None
_setup_lock = threading.Lock()


def setup_tracing(app=None) -> TracerProvider:
    """Initialise the OpenTelemetry TracerProvider and optionally instrument a FastAPI app.

    Thread-safe: concurrent callers will block until the first caller
    finishes initialisation, then return the already-configured provider.
    Subsequent calls with an ``app`` argument will still instrument the
    app even when the provider was already created (so callers that
    first init without an app can later pass one).

    Args:
        app: A FastAPI application instance.  When provided the
            ``opentelemetry-instrumentation-fastapi`` instrumentor will
            automatically create spans for every inbound request.

    Returns:
        The configured ``TracerProvider``.
    """
    global _tracer_provider

    with _setup_lock:
        if _tracer_provider is None:
            service_name = os.environ.get('OTEL_SERVICE_NAME', 'rocketride')
            exporter_type = os.environ.get('OTEL_EXPORTER_TYPE', 'none').lower()

            resource = Resource.create({'service.name': service_name})
            provider = TracerProvider(resource=resource)

            # Attach an exporter based on configuration.
            if exporter_type == 'otlp':
                from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

                endpoint = os.environ.get('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://localhost:4317')
                exporter = OTLPSpanExporter(endpoint=endpoint)
                provider.add_span_processor(BatchSpanProcessor(exporter))
            elif exporter_type == 'console':
                provider.add_span_processor(BatchSpanProcessor(ConsoleSpanExporter()))
            # else: 'none' — no exporter, tracing is effectively a no-op.

            trace.set_tracer_provider(provider)
            _tracer_provider = provider

        provider = _tracer_provider

    # Auto-instrument FastAPI if an app is provided (idempotent: skip if
    # the app was already instrumented to avoid double-wrapping).
    if app is not None:
        if not getattr(app.state, '_otel_instrumented', False):
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

            FastAPIInstrumentor.instrument_app(app)
            app.state._otel_instrumented = True

    return provider


def get_tracer(name: str = 'rocketride') -> trace.Tracer:
    """Return a tracer bound to the global TracerProvider.

    Args:
        name: Logical name for the tracer (usually the module or subsystem).

    Returns:
        An OpenTelemetry ``Tracer`` instance.
    """
    return trace.get_tracer(name)


def shutdown_tracing() -> None:
    """Flush pending spans and shut down the tracer provider.

    Safe to call even if ``setup_tracing`` was never invoked.
    """
    global _tracer_provider
    if _tracer_provider is not None:
        _tracer_provider.shutdown()
        _tracer_provider = None
