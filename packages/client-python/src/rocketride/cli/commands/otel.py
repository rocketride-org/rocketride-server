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
``otel`` — export live pipeline traces and metrics over OTLP.

Exports live pipeline traces and metrics to any OpenTelemetry collector over
OTLP through the RocketRide CLI. Use this command to observe pipeline
executions in backends such as Jaeger, Grafana Tempo, Datadog, Langfuse, or
LangSmith without any engine or server changes: the bridge is a pure consumer
of the engine's documented WebSocket monitor protocol.

The command subscribes to the TASK, SUMMARY, FLOW, and SSE monitor event
types with the wildcard token scope and maps them to OTel spans (pipeline
flow) and metrics (task status snapshots), exporting both over the same OTLP
endpoint.

Trace level: the bridge can only observe runs; it cannot change the trace
level of a run it did not start. Pipeline FLOW spans appear only for runs
started with the ``pipelineTraceLevel`` execute argument, e.g.
``client.use(pipelineTraceLevel='summary')``. Without it, the bridge still
exports task lifecycle spans and status metrics.

This command does not route through the shared ``Output`` channel or
``run_cli_command``: it is a long-running foreground bridge whose output is a
startup banner plus operational notes, it emits no JSON result, and its
documented exit codes (0 graceful stop, 1 unexpected failure, 2 missing extra
/ insecure transport / startup connection failure) do not match the shared
runner's catch-all mapping to 1. It also owns its client's lifecycle so that
the dependency guard can refuse BEFORE anything connects.

Key Features:
    - OTLP export of pipeline flow spans and task status metrics
    - Wildcard monitor subscription covering all tasks for the API key
    - Standard OTEL_EXPORTER_OTLP_ENDPOINT/_HEADERS/OTEL_SERVICE_NAME support
      (with no endpoint configured at all, the exporters' own env semantics
      apply, including OTEL_EXPORTER_OTLP_TRACES/METRICS_ENDPOINT)
    - Privacy by default: payload content excluded unless --include-content
    - Automatic reconnection with capped exponential backoff
    - Graceful shutdown on SIGINT/SIGTERM (spans closed, exporters flushed),
      leaving any signal handler the running loop already owns in place

Usage:
    rocketride otel --apikey <key>
    rocketride otel --endpoint http://localhost:4318 --service-name my-engine
    rocketride otel --headers 'Langsmith-Project=my-project' --no-metrics
    rocketride otel --include-content --apikey <key>

Secrets (collector auth values) are best passed via OTEL_EXPORTER_OTLP_HEADERS
rather than --headers: command-line arguments land in shell history and are
visible in process listings.

Transport security: when any credential-bearing OTLP header is configured
(from --headers or the OTEL_EXPORTER_OTLP_*HEADERS variables) and the
effective collector endpoint is a NON-loopback cleartext one, the bridge
refuses to start with exit code 2. Pass --insecure (or set
ROCKETRIDE_OTEL_ALLOW_INSECURE=1) to override on a trusted network.

Requires the optional OpenTelemetry dependencies:
    pip install 'rocketride[otel]'
"""

import importlib.util
import os
import sys

from ...otelbridge.bridge import run_bridge
from ...otelbridge.config import (
    DEFAULT_GRPC_ENDPOINT,
    DEFAULT_HTTP_ENDPOINT,
    InsecureTransportError,
    OtelConfig,
    effective_endpoint,
    redact_endpoint,
    validate_transport_security,
)

# Safe without the 'otel' extra: setup.py keeps all opentelemetry imports lazy.
from ...otelbridge.setup import OtelNotInstalledError

# Exact install hint for the missing-extra error path (contract: exit code 2)
OTEL_INSTALL_HINT = "pip install 'rocketride[otel]'"


def _otel_available() -> bool:
    """
    Check whether the optional OpenTelemetry SDK is installed.

    Probes for the ``opentelemetry`` and ``opentelemetry.sdk`` modules
    without importing them, so the check itself never pays import cost and
    never fails on a partially installed distribution.

    Returns:
        bool: True when the 'rocketride[otel]' extra appears importable.
    """
    try:
        return (
            importlib.util.find_spec('opentelemetry') is not None
            and importlib.util.find_spec('opentelemetry.sdk') is not None
        )
    except (ImportError, ValueError):
        return False


def _endpoint_display(config: OtelConfig) -> str:
    """
    Render the effective OTLP endpoint for the startup line, redacted.

    Never prints ``config.endpoint`` (or an environment endpoint) as
    given: userinfo and query strings are stripped by
    :func:`~rocketride.otelbridge.config.redact_endpoint` so no credential
    or URL signature reaches stdout.

    Args:
        config: Resolved bridge configuration.

    Returns:
        str: Redacted endpoint, annotated with where it came from.
    """
    if config.endpoint:
        return redact_endpoint(config.endpoint)
    resolved = effective_endpoint(config, os.environ, 'traces')
    sdk_default = DEFAULT_GRPC_ENDPOINT if config.protocol == 'grpc' else DEFAULT_HTTP_ENDPOINT
    if resolved == sdk_default:
        return f'exporter default ({sdk_default})'
    return f'{redact_endpoint(resolved)} (from OTEL_EXPORTER_OTLP_*ENDPOINT)'


def _make_client(args):
    """
    Build an UNCONNECTED client for the bridge to own.

    The bridge connects (and reconnects) the client itself, so nothing here
    may touch the network: the missing-extra guard and the transport-security
    check must both be able to refuse before a single socket is opened.

    Args:
        args: Parsed argparse namespace (uri, apikey).

    Returns:
        An unconnected RocketRideClient.
    """
    from rocketride import RocketRideClient

    return RocketRideClient(args.uri, auth=getattr(args, 'apikey', '') or '')


async def run_otel(args, client=None) -> int:
    """
    Execute the OpenTelemetry bridge command.

    Verifies the optional OpenTelemetry dependencies are installed,
    resolves the exporter configuration, and runs the bridge loop until
    interrupted.

    Args:
        args: Parsed argparse namespace (endpoint, protocol, service_name,
            headers, include_content, insecure, no_metrics, trace_level,
            uri, apikey).
        client: RocketRideClient for server communication, connected by the
            bridge if not already connected. Built from ``args`` when
            omitted (the CLI's case); injectable for tests.

    Returns:
        Exit code: 0 for graceful shutdown, 1 for unexpected errors,
        2 when dependencies are missing or the startup connection fails

    Process Flow:
        1. Guard: missing 'rocketride[otel]' extra -> exit 2 with hint
           (before any connection attempt)
        2. Resolve OtelConfig (CLI args > OTEL_* env vars > defaults)
        3. Print the effective bridge configuration
        4. Run the bridge loop (connect, subscribe, dispatch, reconnect)
        5. Graceful shutdown on SIGINT/SIGTERM: spans closed, exporters
           flushed, exit 0
    """
    # Dependency guard MUST run before any connection attempt
    if not _otel_available():
        print(
            f"Error: 'rocketride otel' requires the OpenTelemetry extra. Install it with: {OTEL_INSTALL_HINT}",
            file=sys.stderr,
        )
        return 2

    # Resolve configuration: CLI args > OTEL_* env vars > defaults
    config = OtelConfig.from_args_env(args)

    # --trace-level is documentation-surface only: the monitor protocol
    # has no way to change the trace level of runs the bridge didn't start
    trace_level = getattr(args, 'trace_level', None)
    if trace_level == 'none':
        # 'none' disables flow tracing, so "emit FLOW events at that
        # level" would be nonsense for it.
        print(
            "Note: --trace-level=none is informational only. 'none' means flow tracing stays "
            'disabled: runs started without a pipelineTraceLevel (or with '
            "pipelineTraceLevel='none') emit no FLOW events, so only task lifecycle spans "
            'and metrics are exported.'
        )
    elif trace_level:
        print(
            f'Note: --trace-level={trace_level} is informational only. The bridge cannot change the '
            f'trace level of runs it did not start; start runs with '
            f"pipelineTraceLevel='{trace_level}' (e.g. client.use(pipelineTraceLevel='{trace_level}')) "
            f'to emit FLOW events at that level.'
        )

    # Refuse to ship collector credentials in cleartext before the
    # endpoint is echoed or a single span is exported.
    try:
        validate_transport_security(config)
    except InsecureTransportError as e:
        print(f'Error: {e}', file=sys.stderr)
        return 2

    # Show the effective configuration before entering the run loop.
    # ALWAYS redacted: an endpoint can carry userinfo credentials
    # (https://user:pass@host) or a signed query string, and this line
    # goes to stdout, which operators pipe into logs.
    endpoint_display = _endpoint_display(config)
    print(f'OpenTelemetry bridge starting (endpoint: {endpoint_display}, protocol: {config.protocol})')
    print(f'  service.name: {config.service_name}')
    print(f'  metrics: {"disabled" if config.no_metrics else "enabled"}')
    print(f'  payload content: {"included (size-capped)" if config.include_content else "excluded"}')
    print("  FLOW spans require runs started with pipelineTraceLevel (e.g. client.use(pipelineTraceLevel='summary'))")
    if config.allow_insecure:
        print(
            '  WARNING: --insecure is set; OTLP credentials may be exported over cleartext transport',
            file=sys.stderr,
        )

    # Built only now: everything that can refuse has already refused, so the
    # guard and the transport check still run before anything connects.
    owns_client = client is None
    if owns_client:
        client = _make_client(args)

    try:
        # Run the bridge until stopped (returns 0) or startup fails (2)
        return await run_bridge(client, config)

    except InsecureTransportError as e:
        # Re-checked inside build_providers; the environment could have
        # been read differently there (e.g. embedded use).
        print(f'Error: {e}', file=sys.stderr)
        return 2

    except (ImportError, OtelNotInstalledError) as e:
        # Missing optional dependency surfaced after the guard, e.g.
        # --protocol grpc without the OTLP gRPC exporter package
        # (build_providers raises OtelNotInstalledError for that path).
        print(f'Error: {e}', file=sys.stderr)
        return 2

    except KeyboardInterrupt:
        # Fallback when signal handlers could not be installed
        print('\nStopping OpenTelemetry bridge...')
        return 0

    except Exception as e:
        print(f'Error: OpenTelemetry bridge failed: {e}', file=sys.stderr)
        return 1

    finally:
        # Only a client this function created is this function's to close.
        if owns_client:
            try:
                await client.disconnect()
            except Exception:  # noqa: BLE001
                pass
