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
Configuration for the RocketRide OpenTelemetry bridge.

This module provides the OtelConfig dataclass consumed by the bridge run loop
(``rocketride.otelbridge.bridge``) and the OTLP provider setup
(``rocketride.otelbridge.setup``). Configuration is resolved with the
precedence: explicit CLI arguments > standard ``OTEL_*`` environment
variables > built-in defaults.

Endpoint and header ENVIRONMENT variables are deliberately NOT resolved here.
Only the explicit CLI flags (``--endpoint``, ``--headers``) become constructor
arguments of the OTLP exporters; everything else is left to the OpenTelemetry
SDK so its spec-defined precedence survives intact:

    - OTEL_EXPORTER_OTLP_ENDPOINT / _TRACES_ENDPOINT / _METRICS_ENDPOINT:
      pre-reading the generic variable here and handing it to both exporters
      would turn it into an explicit endpoint that silently overrides the
      signal-specific ones, inverting the OTLP spec order. Left unset, the
      SDK treats the generic variable as a base URL (appending ``/v1/traces``
      / ``/v1/metrics``), uses the signal-specific variables verbatim and in
      preference to it, and falls back to ``http://localhost:4318``
      (http/protobuf) or ``localhost:4317`` (gRPC).
    - OTEL_EXPORTER_OTLP_HEADERS / _TRACES_HEADERS / _METRICS_HEADERS:
      comma-separated ``key=value`` pairs sent with every OTLP export request
      (e.g. ``Authorization=Basic <b64>`` for Langfuse or
      ``x-api-key=<key>,Langsmith-Project=<proj>`` for LangSmith), resolved by
      the SDK for the same reason. An explicit ``--headers`` overrides them.

The one environment variable read here is OTEL_SERVICE_NAME, which has no
signal-specific counterpart and no SDK-side CLI equivalent.

The variables above ARE read back — read-only, never forwarded — by
:func:`validate_transport_security`, which refuses to start the bridge when
credential-bearing OTLP headers would be shipped in cleartext to a
non-loopback ``http://`` (or insecure gRPC) collector. ``--insecure`` /
``ROCKETRIDE_OTEL_ALLOW_INSECURE=1`` is the explicit opt-out.

This module intentionally imports nothing from ``opentelemetry`` so it is
importable without the ``rocketride[otel]`` extra installed.

Components:
    OtelConfig: Bridge configuration dataclass with from_args_env resolution
    parse_headers: Parser for comma-separated ``key=value`` header strings
    redact_endpoint: Strip credentials/query values from an endpoint for display
    validate_transport_security: Cleartext-credential guard for OTLP exports
    InsecureTransportError: Raised by the guard
"""

import ipaddress
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Tuple
from urllib.parse import urlsplit

# Built-in defaults (OTLP over HTTP/protobuf; endpoint defaults are the
# OTLP exporters' own, so signal-specific OTEL_EXPORTER_OTLP_*_ENDPOINT
# environment variables stay effective when no endpoint is given here)
DEFAULT_PROTOCOL = 'http'
DEFAULT_SERVICE_NAME = 'rocketride-engine'

# The OTLP SDK's own fallbacks, mirrored here for the transport-security
# check and the CLI's startup line only; they are never passed to an exporter.
DEFAULT_HTTP_ENDPOINT = 'http://localhost:4318'
DEFAULT_GRPC_ENDPOINT = 'localhost:4317'

# Standard OpenTelemetry environment variable names. Endpoint and header
# variables are resolved by the SDK exporters (see from_args_env) and only
# READ here for the transport-security check and the CLI's startup line.
ENV_OTLP_ENDPOINT = 'OTEL_EXPORTER_OTLP_ENDPOINT'
ENV_OTLP_TRACES_ENDPOINT = 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'
ENV_OTLP_METRICS_ENDPOINT = 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'
ENV_OTLP_HEADERS = 'OTEL_EXPORTER_OTLP_HEADERS'
ENV_OTLP_TRACES_HEADERS = 'OTEL_EXPORTER_OTLP_TRACES_HEADERS'
ENV_OTLP_METRICS_HEADERS = 'OTEL_EXPORTER_OTLP_METRICS_HEADERS'
ENV_OTLP_INSECURE = 'OTEL_EXPORTER_OTLP_INSECURE'
ENV_OTLP_TRACES_INSECURE = 'OTEL_EXPORTER_OTLP_TRACES_INSECURE'
ENV_OTLP_METRICS_INSECURE = 'OTEL_EXPORTER_OTLP_METRICS_INSECURE'
ENV_SERVICE_NAME = 'OTEL_SERVICE_NAME'

# Opt-out for the cleartext-credential guard (equivalent to --insecure).
ENV_ALLOW_INSECURE = 'ROCKETRIDE_OTEL_ALLOW_INSECURE'

# Signals the bridge exports, with their endpoint/insecure env variables.
_SIGNALS: Tuple[Tuple[str, str, str], ...] = (
    ('traces', ENV_OTLP_TRACES_ENDPOINT, ENV_OTLP_TRACES_INSECURE),
    ('metrics', ENV_OTLP_METRICS_ENDPOINT, ENV_OTLP_METRICS_INSECURE),
)

# Substrings that mark a header name as credential-bearing. Matched
# case-insensitively against the header NAME only; values are never inspected,
# logged or echoed. Non-secret routing headers (e.g. 'Langsmith-Project')
# deliberately do not match.
CREDENTIAL_HEADER_HINTS = (
    'auth',
    'api-key',
    'apikey',
    'api_key',
    'token',
    'secret',
    'password',
    'passwd',
    'cookie',
    'credential',
    'signature',
)

# Values accepted as "true" for the boolean env vars read here.
_TRUTHY = ('1', 'true', 'yes', 'on')


def parse_headers(headers_str: Optional[str]) -> Dict[str, str]:
    """
    Parse a comma-separated ``key=value`` header string into a dict.

    Follows the OTEL_EXPORTER_OTLP_HEADERS wire format: pairs are separated
    by commas and each pair is split on the FIRST ``=`` only, so values that
    themselves contain ``=`` (e.g. base64 padding in
    ``Authorization=Basic cGs6c2s=``) survive intact. Whitespace around keys
    and values is stripped; empty pairs and pairs without ``=`` are skipped.
    Values are passed through verbatim (no URL decoding).

    Args:
        headers_str: Raw header string, e.g. ``'a=1,x-api-key=abc'``.
            None or empty returns an empty dict.

    Returns:
        Dict[str, str]: Parsed header name/value pairs.
    """
    headers: Dict[str, str] = {}
    if not headers_str:
        return headers

    for pair in headers_str.split(','):
        pair = pair.strip()
        if not pair or '=' not in pair:
            continue
        key, value = pair.split('=', 1)
        key = key.strip()
        if key:
            headers[key] = value.strip()

    return headers


@dataclass
class OtelConfig:
    """
    Configuration for the OpenTelemetry bridge.

    Attributes:
        endpoint: OTLP endpoint base URL, or None to defer to the OTLP
            exporters' own environment/default semantics (including the
            signal-specific ``OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`` /
            ``OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`` variables). When set,
            signal paths (``/v1/traces``, ``/v1/metrics``) are appended by
            the exporter setup.
        protocol: OTLP transport, ``'http'`` (http/protobuf, default) or
            ``'grpc'`` (requires the optional grpc exporter package).
        service_name: Value for the ``service.name`` resource attribute.
        include_content: When True, pipeline payload content (trace data,
            lane payloads, results) is included in span attributes/events,
            subject to the mapper's size cap. Default False: no payload
            content reaches any span.
        no_metrics: When True, only traces are exported; apaevt_status_update
            snapshots are not mapped to OTel metrics.
        headers: Explicit extra headers sent with every OTLP export request
            (from ``--headers``). When empty, the exporters receive no
            explicit headers and the OTel SDK resolves the standard
            ``OTEL_EXPORTER_OTLP_*HEADERS`` environment variables itself.
        allow_insecure: When True, credential-bearing OTLP headers may be
            exported over cleartext transport to a non-loopback collector
            (from ``--insecure`` or ``ROCKETRIDE_OTEL_ALLOW_INSECURE``).
            Default False: :func:`validate_transport_security` refuses.
    """

    endpoint: Optional[str] = None
    protocol: str = DEFAULT_PROTOCOL
    service_name: str = DEFAULT_SERVICE_NAME
    include_content: bool = False
    no_metrics: bool = False
    headers: Dict[str, str] = field(default_factory=dict)
    allow_insecure: bool = False

    @classmethod
    def from_args_env(cls, args: Any, env: Optional[Mapping[str, str]] = None) -> 'OtelConfig':
        """
        Build an OtelConfig from parsed CLI arguments and the environment.

        Resolution precedence for each field: CLI argument (when present and
        non-empty) > standard ``OTEL_*`` environment variable > default.
        Missing attributes on ``args`` are treated as absent, so partial
        namespaces (e.g. in tests) work. Endpoint and headers are resolved
        from ``--endpoint`` / ``--headers`` only; their environment variables
        are left to the OTel SDK exporters so the signal-specific
        ``OTEL_EXPORTER_OTLP_TRACES_*`` / ``_METRICS_*`` variables keep their
        spec-defined precedence over the generic ones.

        Args:
            args: Parsed argparse namespace (or any object with optional
                ``endpoint``, ``protocol``, ``service_name``, ``headers``,
                ``include_content`` and ``no_metrics`` attributes).
            env: Environment mapping override; defaults to ``os.environ``.

        Returns:
            OtelConfig: Fully resolved bridge configuration.
        """
        environ: Mapping[str, str] = os.environ if env is None else env

        # Only an explicit --endpoint becomes a constructor endpoint. Reading
        # OTEL_EXPORTER_OTLP_ENDPOINT here and handing it to BOTH exporters
        # would make it an explicit endpoint that silently overrides the
        # signal-specific OTEL_EXPORTER_OTLP_TRACES/METRICS_ENDPOINT, i.e. the
        # exact inversion of the OTLP spec order that was already fixed for the
        # header variables. Left None, the SDK resolves all three itself (and
        # still appends /v1/traces to the generic base URL).
        endpoint = getattr(args, 'endpoint', None) or None
        protocol = getattr(args, 'protocol', None) or DEFAULT_PROTOCOL
        service_name = getattr(args, 'service_name', None) or environ.get(ENV_SERVICE_NAME) or DEFAULT_SERVICE_NAME

        # Only explicit --headers become constructor headers. When the flag is
        # absent, headers stays empty and the exporters are built with NO
        # explicit header set, so the OTel SDK resolves the environment itself
        # with its documented precedence: signal-specific
        # OTEL_EXPORTER_OTLP_TRACES_HEADERS / OTEL_EXPORTER_OTLP_METRICS_HEADERS
        # first, then the generic OTEL_EXPORTER_OTLP_HEADERS. Pre-parsing the
        # generic variable here would turn it into an explicit header set that
        # silently overrides the signal-specific variables.
        headers = parse_headers(getattr(args, 'headers', None))

        return cls(
            endpoint=endpoint,
            protocol=protocol,
            service_name=service_name,
            include_content=bool(getattr(args, 'include_content', False)),
            no_metrics=bool(getattr(args, 'no_metrics', False)),
            headers=headers,
            allow_insecure=bool(getattr(args, 'insecure', False)) or _is_truthy(environ.get(ENV_ALLOW_INSECURE)),
        )


def _is_truthy(value: Optional[str]) -> bool:
    """Return True for the standard truthy spellings of a boolean env var."""
    return bool(value) and value.strip().lower() in _TRUTHY


def _split(endpoint: str) -> Any:
    """
    Split an OTLP endpoint with ``urlsplit``, tolerating the scheme-less gRPC form.

    ``localhost:4317`` (a legal OTLP gRPC endpoint) is not a URL, so it is
    given a ``//`` authority prefix before splitting; that keeps ``hostname``
    and ``port`` meaningful while leaving ``scheme`` empty, which is exactly
    what the insecure-transport check needs to distinguish it from
    ``http://localhost:4317``.
    """
    raw = (endpoint or '').strip()
    if '://' not in raw:
        raw = '//' + raw
    return urlsplit(raw)


def redact_endpoint(endpoint: Optional[str]) -> str:
    """
    Return an OTLP endpoint safe to print, with every credential carrier gone.

    Userinfo (``https://user:pass@host``), the query string (signed URLs put
    their signature there) and the fragment are removed; scheme, host, port
    and path are kept because the ingest path is the part operators actually
    verify (``/api/public/otel`` for Langfuse, ``/otel`` for LangSmith).

    Args:
        endpoint: Raw endpoint, possibly None.

    Returns:
        str: ``''`` for a falsy endpoint, otherwise the redacted endpoint.
    """
    if not endpoint:
        return ''
    parts = _split(endpoint)
    host = parts.hostname or ''
    if ':' in host:  # IPv6 literal
        host = f'[{host}]'
    authority = host
    try:
        port = parts.port
    except ValueError:  # malformed port: drop it rather than echo it back
        port = None
    if port is not None:
        authority = f'{authority}:{port}'
    prefix = f'{parts.scheme}://' if parts.scheme else ''
    redacted = f'{prefix}{authority}{parts.path}'
    if parts.query or parts.fragment:
        redacted += '?<redacted>'
    return redacted or '<redacted>'


def _is_loopback(endpoint: str) -> bool:
    """True when the endpoint's host is loopback (or absent, i.e. the SDK default)."""
    host = (_split(endpoint).hostname or '').lower()
    if not host:
        return True
    if host == 'localhost' or host.endswith('.localhost'):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def effective_endpoint(config: Any, environ: Mapping[str, str], signal: str) -> str:
    """
    Resolve the endpoint the SDK will actually use for one signal.

    Mirrors the OTLP exporter contract (explicit endpoint > signal-specific
    env var > generic env var > protocol default) for the two things the
    bridge itself must know: what to print at startup and what to security
    check. Nothing resolved here is ever passed to an exporter.

    Args:
        config: Object with ``endpoint`` and ``protocol`` attributes.
        environ: Environment mapping to read.
        signal: ``'traces'`` or ``'metrics'``.

    Returns:
        str: The effective endpoint for that signal.
    """
    explicit = getattr(config, 'endpoint', None)
    if explicit:
        return explicit
    signal_env = ENV_OTLP_TRACES_ENDPOINT if signal == 'traces' else ENV_OTLP_METRICS_ENDPOINT
    return (
        environ.get(signal_env)
        or environ.get(ENV_OTLP_ENDPOINT)
        or (DEFAULT_GRPC_ENDPOINT if getattr(config, 'protocol', DEFAULT_PROTOCOL) == 'grpc' else DEFAULT_HTTP_ENDPOINT)
    )


def _is_cleartext(config: Any, environ: Mapping[str, str], signal: str, endpoint: str) -> bool:
    """True when this signal's exports travel unencrypted."""
    scheme = _split(endpoint).scheme.lower()
    if scheme == 'https':
        return False
    if scheme == 'http':
        return True
    if getattr(config, 'protocol', DEFAULT_PROTOCOL) != 'grpc':
        # http/protobuf endpoints always carry a scheme; a scheme-less one is
        # rejected by the exporter itself, so nothing to decide here.
        return False
    # Scheme-less gRPC: the SDK builds a TLS channel unless OTEL_EXPORTER_
    # OTLP[_<SIGNAL>]_INSECURE says otherwise.
    signal_env = ENV_OTLP_TRACES_INSECURE if signal == 'traces' else ENV_OTLP_METRICS_INSECURE
    return _is_truthy(environ.get(signal_env) or environ.get(ENV_OTLP_INSECURE))


def credential_header_names(config: Any, environ: Mapping[str, str]) -> List[str]:
    """
    Return the sorted names of credential-bearing OTLP headers in effect.

    Covers explicit ``--headers`` and all three header environment variables
    (which the bridge otherwise leaves to the SDK). Only NAMES are returned:
    values never leave this module.

    Args:
        config: Object with a ``headers`` mapping attribute.
        environ: Environment mapping to read.

    Returns:
        List[str]: Sorted credential-looking header names, possibly empty.
    """
    names = set(getattr(config, 'headers', None) or {})
    for var in (ENV_OTLP_HEADERS, ENV_OTLP_TRACES_HEADERS, ENV_OTLP_METRICS_HEADERS):
        names.update(parse_headers(environ.get(var)))
    return sorted(name for name in names if any(hint in name.lower() for hint in CREDENTIAL_HEADER_HINTS))


class InsecureTransportError(RuntimeError):
    """Raised when OTLP credentials would be exported over cleartext transport."""


def validate_transport_security(config: Any, env: Optional[Mapping[str, str]] = None) -> None:
    """
    Refuse to export credential-bearing OTLP headers in cleartext.

    OTLP exporters send configured headers verbatim to whatever endpoint they
    are given, with no TLS requirement of their own (CWE-319): a collector
    URL that is plaintext ``http://`` — or a gRPC endpoint with
    ``OTEL_EXPORTER_OTLP_INSECURE`` set — puts an ``Authorization`` or
    ``x-api-key`` value on the wire in the clear. Loopback endpoints are
    exempt (the local-collector development case), and ``--insecure`` /
    ``ROCKETRIDE_OTEL_ALLOW_INSECURE=1`` is the explicit opt-out for
    trusted-network deployments.

    Both signals are checked, since their endpoints can differ; metrics are
    skipped when ``config.no_metrics`` is set.

    Args:
        config: Resolved :class:`OtelConfig` (or compatible object).
        env: Environment mapping override; defaults to ``os.environ``.

    Raises:
        InsecureTransportError: A credential header would be exported to a
            non-loopback cleartext endpoint without an explicit opt-in.
    """
    environ: Mapping[str, str] = os.environ if env is None else env
    if getattr(config, 'allow_insecure', False):
        return

    credentials = credential_header_names(config, environ)
    if not credentials:
        return

    offenders: List[str] = []
    for signal, _endpoint_env, _insecure_env in _SIGNALS:
        if signal == 'metrics' and getattr(config, 'no_metrics', False):
            continue
        endpoint = effective_endpoint(config, environ, signal)
        if _is_loopback(endpoint):
            continue
        if _is_cleartext(config, environ, signal, endpoint):
            offenders.append(f'{signal} -> {redact_endpoint(endpoint)}')

    if not offenders:
        return

    raise InsecureTransportError(
        'refusing to export OTLP credentials in cleartext: '
        + '; '.join(offenders)
        + f' (credential headers: {", ".join(credentials)}). '
        'Use an https:// collector endpoint, or pass --insecure '
        f'(or set {ENV_ALLOW_INSECURE}=1) if the network is trusted.'
    )
