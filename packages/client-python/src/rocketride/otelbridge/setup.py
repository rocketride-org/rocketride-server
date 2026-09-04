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
OpenTelemetry provider construction for the RocketRide OTel bridge.

This module builds the TracerProvider / MeterProvider pair (with OTLP
exporters) that the ``rocketride otel`` bridge feeds. ALL imports of the
``opentelemetry`` packages are lazy (function-local): importing this module
never requires the 'otel' extra, and a missing extra surfaces as
:class:`OtelNotInstalledError` with the exact install command.

Endpoint semantics (matching the OTLP exporter spec):
    - ``config.endpoint`` set: treated as a BASE url; the per-signal paths
      ``/v1/traces`` / ``/v1/metrics`` are appended unless already present,
      so pasting Langfuse's ``https://<host>/api/public/otel`` or LangSmith's
      ``https://api.smith.langchain.com/otel`` just works (http protocol).
    - ``config.endpoint`` unset: the exporters are constructed without an
      explicit endpoint so the standard ``OTEL_EXPORTER_OTLP_ENDPOINT`` /
      ``OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`` / ``OTEL_EXPORTER_OTLP_HEADERS``
      environment variables (and the localhost:4318 default) apply.
    - ``protocol='grpc'``: requires the optional
      ``opentelemetry-exporter-otlp-proto-grpc`` package (not part of the
      'otel' extra); gRPC endpoints are used verbatim (no per-signal path).

Transport security:
    - ``build_providers`` runs
      :func:`~rocketride.otelbridge.config.validate_transport_security` first,
      so credential-bearing OTLP headers are never exported in cleartext to a
      non-loopback collector without an explicit ``--insecure`` opt-in.
    - The HTTP exporters are given a session that does NOT follow redirects.
      ``requests`` drops ``Authorization`` only when the redirect changes
      host, so a 3xx from a collector would otherwise replay custom
      credential headers (``x-api-key`` and friends) to the redirect target,
      including on an https -> http downgrade to the same host.
"""

import logging
from typing import Any, Callable, Dict, Optional, Tuple

# InsecureTransportError is re-exported here: build_providers raises it, so
# callers importing this module should not need to reach into .config.
from .config import InsecureTransportError as InsecureTransportError
from .config import validate_transport_security

logger = logging.getLogger(__name__)

_INSTALL_HINT = "pip install 'rocketride[otel]'"
_GRPC_INSTALL_HINT = 'pip install opentelemetry-exporter-otlp-proto-grpc'

# Instrumentation scope name for tracer/meter lookups.
SCOPE_NAME = 'rocketride.otelbridge'


class OtelNotInstalledError(RuntimeError):
    """Raised when an OpenTelemetry dependency needed by the bridge is missing."""


def missing_otel_message() -> str:
    """Return the user-facing message for a missing 'otel' extra."""
    return f"The 'rocketride otel' bridge requires the OpenTelemetry SDK. Install it with: {_INSTALL_HINT}"


def _resolve_endpoint(base: str, signal_path: str) -> str:
    """
    Append a per-signal OTLP path to a base endpoint unless already present.

    Args:
        base: User-supplied base URL (e.g. ``http://localhost:4318`` or
            ``https://cloud.langfuse.com/api/public/otel``).
        signal_path: Signal path without leading slash (``v1/traces``).
    """
    trimmed = base.rstrip('/')
    if trimmed.endswith('/' + signal_path):
        return trimmed
    return f'{trimmed}/{signal_path}'


def _build_resource(config: Any) -> Any:
    """Build the OTel Resource carrying service.name (+ service.version when known)."""
    from opentelemetry.sdk.resources import Resource

    attributes: Dict[str, Any] = {'service.name': config.service_name}
    try:
        from importlib.metadata import version

        attributes['service.version'] = version('rocketride')
    except Exception:  # noqa: BLE001 - version is best-effort metadata only
        pass
    return Resource.create(attributes)


def _exporter_headers(config: Any) -> Optional[Dict[str, str]]:
    """Return explicit headers, or None so OTEL_EXPORTER_OTLP_HEADERS applies."""
    headers = getattr(config, 'headers', None)
    return dict(headers) if headers else None


def _no_redirect_session() -> Any:
    """
    Build a ``requests`` session that never follows redirects.

    OTLP/HTTP exporters post through ``Session.post``, which follows 3xx by
    default. ``requests`` strips ``Authorization`` on a cross-HOST redirect
    only: arbitrary credential headers (``x-api-key``, project auth values)
    are replayed to the redirect target, and an https -> http downgrade to
    the SAME host keeps even ``Authorization``. A collector has no reason to
    redirect telemetry, so refusing to follow is both safe and lossless: a
    3xx now surfaces as an export failure instead of a silent credential
    leak.
    """
    import requests

    class _NoRedirectSession(requests.Session):
        """Session pinned to the configured endpoint (no 3xx following)."""

        def send(self, request, **kwargs):  # type: ignore[override]
            kwargs['allow_redirects'] = False
            return super().send(request, **kwargs)

    return _NoRedirectSession()


def _http_exporter_kwargs(exporter_cls: Any) -> Dict[str, Any]:
    """Extra kwargs for an OTLP/HTTP exporter: a non-redirecting session when supported."""
    import inspect

    try:
        supported = 'session' in inspect.signature(exporter_cls.__init__).parameters
    except (TypeError, ValueError):  # pragma: no cover - C-implemented __init__
        supported = False
    if not supported:  # pragma: no cover - exporter older than the 'session' kwarg
        logger.debug('OTLP HTTP exporter %s takes no session=; redirects stay enabled', exporter_cls.__name__)
        return {}
    return {'session': _no_redirect_session()}


def _build_span_exporter(config: Any) -> Any:
    """Build the OTLP span exporter for config.protocol ('http' or 'grpc')."""
    protocol = getattr(config, 'protocol', 'http') or 'http'
    headers = _exporter_headers(config)
    if protocol == 'grpc':
        try:
            from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
        except ImportError as exc:
            raise OtelNotInstalledError(
                f'--protocol grpc requires the OTLP gRPC exporter. Install it with: {_GRPC_INSTALL_HINT}'
            ) from exc
        if config.endpoint:
            return OTLPSpanExporter(endpoint=config.endpoint, headers=headers)
        return OTLPSpanExporter(headers=headers)

    try:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    except ImportError as exc:
        # A partial install (opentelemetry-api/sdk present as someone else's
        # transitive dependency, exporter absent) must give the same friendly
        # hint as a missing extra, not a raw ModuleNotFoundError.
        raise OtelNotInstalledError(_INSTALL_HINT) from exc

    extra = _http_exporter_kwargs(OTLPSpanExporter)
    if config.endpoint:
        return OTLPSpanExporter(endpoint=_resolve_endpoint(config.endpoint, 'v1/traces'), headers=headers, **extra)
    return OTLPSpanExporter(headers=headers, **extra)


def _build_metric_exporter(config: Any) -> Any:
    """Build the OTLP metric exporter for config.protocol ('http' or 'grpc')."""
    protocol = getattr(config, 'protocol', 'http') or 'http'
    headers = _exporter_headers(config)
    if protocol == 'grpc':
        try:
            from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
        except ImportError as exc:
            raise OtelNotInstalledError(
                f'--protocol grpc requires the OTLP gRPC exporter. Install it with: {_GRPC_INSTALL_HINT}'
            ) from exc
        if config.endpoint:
            return OTLPMetricExporter(endpoint=config.endpoint, headers=headers)
        return OTLPMetricExporter(headers=headers)

    try:
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    except ImportError as exc:
        raise OtelNotInstalledError(_INSTALL_HINT) from exc

    extra = _http_exporter_kwargs(OTLPMetricExporter)
    if config.endpoint:
        return OTLPMetricExporter(endpoint=_resolve_endpoint(config.endpoint, 'v1/metrics'), headers=headers, **extra)
    return OTLPMetricExporter(headers=headers, **extra)


def build_providers(config: Any) -> Tuple[Any, Any, Callable[[], None]]:
    """
    Build (tracer, meter, shutdown_fn) from an OtelConfig.

    The providers are kept local (the global OpenTelemetry tracer/meter
    providers are never touched) so tests and embedders stay isolated.
    ``shutdown_fn`` flushes and shuts down both providers; call it once on
    exit (SIGINT/SIGTERM handling lives in the bridge loop).

    Args:
        config: An object with ``endpoint``, ``protocol``, ``service_name``,
            ``include_content``, ``no_metrics`` and ``headers`` attributes
            (see ``rocketride.otelbridge.config.OtelConfig``).

    Raises:
        OtelNotInstalledError: The 'otel' extra (or the gRPC exporter for
            ``protocol='grpc'``) is not installed.
        InsecureTransportError: Credential-bearing OTLP headers would be
            exported in cleartext to a non-loopback collector and
            ``config.allow_insecure`` is not set.
    """
    # Fail before anything is constructed: no exporter, no worker thread and
    # no credential on the wire until the transport is known to be safe.
    validate_transport_security(config)

    try:
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError as exc:
        raise OtelNotInstalledError(missing_otel_message()) from exc

    resource = _build_resource(config)

    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(BatchSpanProcessor(_build_span_exporter(config)))
    tracer = tracer_provider.get_tracer(SCOPE_NAME)

    # From here on the BatchSpanProcessor worker thread is running, and the
    # caller has no handle to stop it until this function returns `shutdown`.
    # Any failure while building the metric half (a missing gRPC exporter, a
    # rejected endpoint) must therefore take the tracer provider down with it
    # rather than leak the thread behind a "startup failed" message.
    try:
        if getattr(config, 'no_metrics', False):
            meter_provider = MeterProvider(resource=resource, metric_readers=[])
        else:
            reader = PeriodicExportingMetricReader(_build_metric_exporter(config))
            meter_provider = MeterProvider(resource=resource, metric_readers=[reader])
        meter = meter_provider.get_meter(SCOPE_NAME)
    except BaseException:
        try:
            tracer_provider.shutdown()
        except Exception as exc:  # noqa: BLE001 - cleanup must not mask the original error
            logger.debug('tracer provider shutdown failed while unwinding metric setup: %s', exc)
        raise

    def shutdown() -> None:
        """Flush pending telemetry and shut down both providers.

        try/finally: a tracer-provider shutdown failure (e.g. an exporter
        raising during the final flush) must not lose the metrics flush.
        """
        try:
            tracer_provider.shutdown()
        finally:
            meter_provider.shutdown()

    return tracer, meter, shutdown
