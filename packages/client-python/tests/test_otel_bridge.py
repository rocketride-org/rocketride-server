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
Unit tests for the OpenTelemetry bridge run loop and configuration.

These tests use in-process fakes for the client and the mappers, so they run
without the 'rocketride[otel]' extra installed and without a live server
(unlike the integration tests that use the shared conftest client fixture).

Covered here:
    - OtelConfig precedence: CLI args > OTEL_* env vars > defaults
    - --headers parsing (first-'=' split, whitespace, padding); the header
      env vars are deferred to the SDK exporters, never parsed into config
    - run_bridge event routing (task/flow/sse -> mapper, status -> metrics)
    - Wildcard monitor subscription (token '*', TASK/SUMMARY/FLOW/SSE)
    - Startup connection / subscription failure -> exit code 2
    - Reconnect loop with capped backoff (no hand-rolled resubscription)
    - Shutdown order: close_all() before exporter shutdown_fn()
    - --no-metrics: metrics factory never invoked, status events dropped
    - Dispatcher isolation: a raising mapper does not kill the bridge
    - Replay of the recorded wire fixture (tests/fixtures/otel_bridge_events.json)
"""

import asyncio
import sys
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from rocketride.otelbridge.bridge import MONITOR_TYPES, run_bridge
from rocketride.otelbridge.config import (
    DEFAULT_PROTOCOL,
    DEFAULT_SERVICE_NAME,
    ENV_OTLP_ENDPOINT,
    ENV_OTLP_HEADERS,
    ENV_SERVICE_NAME,
    InsecureTransportError,
    OtelConfig,
    effective_endpoint,
    parse_headers,
    redact_endpoint,
    validate_transport_security,
)

FIXTURE_PATH = Path(__file__).parent / 'fixtures' / 'otel_bridge_events.json'


# =========================================================================
# FAKES
# =========================================================================


class FakeClient:
    """Minimal stand-in for RocketRideClient as seen by run_bridge."""

    def __init__(self, connected: bool = False, connect_failures: int = 0):
        self._connected = connected
        self.connect_failures = connect_failures
        self.connect_calls = 0
        self.monitor_calls = []
        self._caller_on_event = None

    def is_connected(self) -> bool:
        return self._connected

    async def connect(self):
        self.connect_calls += 1
        if self.connect_failures > 0:
            self.connect_failures -= 1
            raise ConnectionError('connection refused')
        self._connected = True

    async def add_monitor(self, key, types):
        self.monitor_calls.append((dict(key), list(types)))

    async def emit(self, event: str, body: dict):
        """Deliver one DAP event envelope to the attached handler."""
        handler = self._caller_on_event
        if handler is not None:
            await handler({'type': 'event', 'event': event, 'seq': 0, 'body': body})


class FakeMapper:
    """Records handle_event/close_all calls; optional shared order log."""

    def __init__(self, order_log=None):
        self.events = []
        self.closed = False
        self._order_log = order_log

    def handle_event(self, event_name, body):
        self.events.append((event_name, body))

    def close_all(self):
        self.closed = True
        if self._order_log is not None:
            self._order_log.append('close_all')


class FakeMetrics:
    """Records handle_status calls."""

    def __init__(self):
        self.statuses = []

    def handle_status(self, body):
        self.statuses.append(body)


async def _wait_until(predicate, timeout: float = 2.0):
    """Poll until predicate() is truthy or fail the test after timeout."""
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            pytest.fail('timed out waiting for condition')
        await asyncio.sleep(0.005)


def _start_bridge(client, config=None, mapper=None, metrics=None, **kwargs):
    """Start run_bridge as a task; returns (task, stop_event, mapper, metrics)."""
    config = config or OtelConfig()
    mapper = mapper if mapper is not None else FakeMapper()
    metrics = metrics if metrics is not None else FakeMetrics()
    stop_event = kwargs.pop('stop_event', asyncio.Event())
    task = asyncio.ensure_future(
        run_bridge(
            client,
            config,
            lambda: mapper,
            lambda: metrics,
            stop_event=stop_event,
            poll_interval=kwargs.pop('poll_interval', 0.01),
            **kwargs,
        )
    )
    return task, stop_event, mapper, metrics


# =========================================================================
# CONFIG: precedence and header parsing
# =========================================================================


class TestOtelConfig:
    def test_defaults_when_no_args_no_env(self):
        config = OtelConfig.from_args_env(SimpleNamespace(), env={})
        # endpoint stays None so the OTLP exporters' own env/default
        # semantics apply (http://localhost:4318 for http, 4317 for grpc).
        assert config.endpoint is None
        assert config.protocol == DEFAULT_PROTOCOL == 'http'
        assert config.service_name == DEFAULT_SERVICE_NAME == 'rocketride-engine'
        assert config.include_content is False
        assert config.no_metrics is False
        assert config.headers == {}

    def test_signal_specific_env_left_to_the_sdk_exporters(self):
        # OTEL_EXPORTER_OTLP_TRACES/METRICS_ENDPOINT must reach the SDK
        # exporters: the bridge keeps endpoint None rather than clobbering
        # them with a hardcoded default (the exporters read them directly;
        # see test_otel_setup.py for the exporter-level proof).
        env = {'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT': 'http://traces.example:4318/v1/traces'}
        config = OtelConfig.from_args_env(SimpleNamespace(), env=env)
        assert config.endpoint is None

    def test_env_used_when_args_absent(self, monkeypatch):
        # OTEL_SERVICE_NAME is the ONE env var resolved here; the endpoint
        # variables are left to the SDK exporters (see the test below).
        monkeypatch.setenv(ENV_SERVICE_NAME, 'env-service')
        config = OtelConfig.from_args_env(SimpleNamespace())
        assert config.service_name == 'env-service'

    def test_generic_endpoint_env_left_to_the_sdk_exporters(self, monkeypatch):
        # OTEL_EXPORTER_OTLP_ENDPOINT must NOT be pre-read into an explicit
        # exporter endpoint: that would silently override the signal-specific
        # OTEL_EXPORTER_OTLP_TRACES/METRICS_ENDPOINT, inverting the OTLP spec
        # order exactly as pre-parsing the header variable once did.
        monkeypatch.setenv(ENV_OTLP_ENDPOINT, 'https://generic.example:4318')
        monkeypatch.setenv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'https://traces.example:4318/v1/traces')
        config = OtelConfig.from_args_env(SimpleNamespace())
        assert config.endpoint is None
        # The SDK's resolution order is mirrored (read-only) for the startup
        # line and the transport-security check: signal-specific wins.
        assert effective_endpoint(config, os.environ, 'traces') == 'https://traces.example:4318/v1/traces'
        assert effective_endpoint(config, os.environ, 'metrics') == 'https://generic.example:4318'

    def test_explicit_endpoint_arg_still_wins(self):
        config = OtelConfig.from_args_env(
            SimpleNamespace(endpoint='https://args.example:4318'),
            env={ENV_OTLP_ENDPOINT: 'https://env.example:4318'},
        )
        assert config.endpoint == 'https://args.example:4318'

    def test_header_env_vars_left_to_the_sdk_exporters(self):
        # OTEL_EXPORTER_OTLP_HEADERS must NOT be pre-parsed into explicit
        # exporter headers: an explicit header set would silently override the
        # signal-specific OTEL_EXPORTER_OTLP_TRACES/METRICS_HEADERS variables,
        # whose precedence the SDK exporters resolve themselves (see
        # test_otel_setup.py for the exporter-level proof).
        env = {
            ENV_OTLP_HEADERS: 'x-api-key=generic',
            'OTEL_EXPORTER_OTLP_TRACES_HEADERS': 'x-api-key=traces-specific',
        }
        config = OtelConfig.from_args_env(SimpleNamespace(), env=env)
        assert config.headers == {}

    def test_args_override_env(self):
        env = {
            ENV_OTLP_ENDPOINT: 'https://env.example:4318',  # noqa: RUF100 - ignored by design
            ENV_OTLP_HEADERS: 'a=env',
            ENV_SERVICE_NAME: 'env-service',
        }
        args = SimpleNamespace(
            endpoint='https://args.example:4318',
            protocol='grpc',
            service_name='args-service',
            headers='x-api-key=key123,Langsmith-Project=proj',
            include_content=True,
            no_metrics=True,
        )
        config = OtelConfig.from_args_env(args, env=env)
        assert config.endpoint == 'https://args.example:4318'
        assert config.protocol == 'grpc'
        assert config.service_name == 'args-service'
        assert config.headers == {'x-api-key': 'key123', 'Langsmith-Project': 'proj'}
        assert config.include_content is True
        assert config.no_metrics is True

    def test_header_value_keeps_base64_padding(self):
        # Basic auth values end in '=' padding; split must be on the FIRST '='
        headers = parse_headers('Authorization=Basic cGstbGY6c2stbGY=,x-api-key=k')
        assert headers == {'Authorization': 'Basic cGstbGY6c2stbGY=', 'x-api-key': 'k'}

    def test_header_parsing_edge_cases(self):
        assert parse_headers(None) == {}
        assert parse_headers('') == {}
        assert parse_headers(' a = 1 , , no-equals , b=2, =nokey ') == {'a': '1', 'b': '2'}


# =========================================================================
# BRIDGE: subscription, routing, resilience, shutdown
# =========================================================================


class TestRunBridge:
    async def test_subscribes_wildcard_and_routes_events(self):
        client = FakeClient(connected=True)
        task, stop_event, mapper, metrics = _start_bridge(client)
        await _wait_until(lambda: client.monitor_calls)

        await client.emit('apaevt_task', {'action': 'begin', 'projectId': 'p', 'source': 's'})
        await client.emit('apaevt_flow', {'id': 0, 'op': 'begin', 'pipes': ['x'], 'component': 'x'})
        await client.emit('apaevt_sse', {'pipe_id': 1, 'type': 'thinking'})
        await client.emit('apaevt_status_update', {'state': 3})
        await client.emit('apaevt_unrelated', {'ignored': True})

        stop_event.set()
        assert await task == 0

        # Wildcard token scope with the four monitor event types, exactly once
        assert client.monitor_calls == [({'token': '*'}, list(MONITOR_TYPES))]
        assert list(MONITOR_TYPES) == ['TASK', 'SUMMARY', 'FLOW', 'SSE']

        # task/flow/sse -> span mapper; status -> metrics; unrelated dropped
        assert [name for name, _ in mapper.events] == ['apaevt_task', 'apaevt_flow', 'apaevt_sse']
        assert metrics.statuses == [{'state': 3}]
        assert mapper.closed is True

    async def test_startup_connect_failure_returns_2(self, capsys):
        client = FakeClient(connected=False, connect_failures=99)
        exit_code = await run_bridge(client, OtelConfig(), lambda: FakeMapper(), lambda: FakeMetrics())
        assert exit_code == 2
        assert client.connect_calls == 1  # no retry storm at startup
        assert client.monitor_calls == []
        assert 'unable to connect' in capsys.readouterr().err

    async def test_subscription_failure_returns_2(self, capsys):
        class FailingMonitorClient(FakeClient):
            async def add_monitor(self, key, types):
                raise RuntimeError('subscribe denied')

        client = FailingMonitorClient(connected=True)
        exit_code = await run_bridge(client, OtelConfig(), lambda: FakeMapper(), lambda: FakeMetrics())
        assert exit_code == 2
        assert 'monitor subscription failed' in capsys.readouterr().err

    async def test_reconnects_with_backoff_without_resubscribing(self):
        client = FakeClient(connected=True)
        task, stop_event, mapper, metrics = _start_bridge(client, initial_backoff=0.01, max_backoff=0.02)
        await _wait_until(lambda: client.monitor_calls)

        # Simulate a dropped connection whose first two reconnects fail
        client._connected = False
        client.connect_failures = 2
        await _wait_until(lambda: client.is_connected())

        stop_event.set()
        assert await task == 0

        # Two failed attempts + one success
        assert client.connect_calls == 3
        # The SDK owns resubscription (EventMixin replays monitors on
        # reconnect); the bridge must not hand-roll a second add_monitor.
        assert len(client.monitor_calls) == 1

    async def test_shutdown_closes_spans_before_flushing_exporters(self):
        order = []
        client = FakeClient(connected=True)
        mapper = FakeMapper(order_log=order)
        task, stop_event, _, _ = _start_bridge(client, mapper=mapper, shutdown_fn=lambda: order.append('shutdown'))
        await _wait_until(lambda: client.monitor_calls)

        stop_event.set()
        assert await task == 0
        assert order == ['close_all', 'shutdown']

    async def test_no_metrics_never_builds_metrics_and_drops_status(self):
        invoked = []
        client = FakeClient(connected=True)
        mapper = FakeMapper()

        def metrics_factory():
            invoked.append(True)
            return FakeMetrics()

        stop_event = asyncio.Event()
        task = asyncio.ensure_future(
            run_bridge(
                client,
                OtelConfig(no_metrics=True),
                lambda: mapper,
                metrics_factory,
                stop_event=stop_event,
                poll_interval=0.01,
            )
        )
        await _wait_until(lambda: client.monitor_calls)

        await client.emit('apaevt_status_update', {'state': 3})
        await client.emit('apaevt_flow', {'id': 0, 'op': 'begin'})

        stop_event.set()
        assert await task == 0
        assert invoked == []  # metrics factory must not be called
        assert [name for name, _ in mapper.events] == ['apaevt_flow']

    async def test_mapper_exception_is_logged_not_fatal(self, capsys):
        class ExplodingMapper(FakeMapper):
            def handle_event(self, event_name, body):
                super().handle_event(event_name, body)
                raise ValueError('mapper boom')

        client = FakeClient(connected=True)
        mapper = ExplodingMapper()
        task, stop_event, _, metrics = _start_bridge(client, mapper=mapper)
        await _wait_until(lambda: client.monitor_calls)

        # Both events are still delivered despite the first one raising
        await client.emit('apaevt_flow', {'id': 0, 'op': 'begin'})
        await client.emit('apaevt_flow', {'id': 0, 'op': 'end'})
        await client.emit('apaevt_status_update', {'state': 3})

        stop_event.set()
        assert await task == 0
        assert len(mapper.events) == 2
        assert metrics.statuses == [{'state': 3}]
        assert 'mapper boom' in capsys.readouterr().err

    async def test_chains_and_restores_previous_event_handler(self):
        client = FakeClient(connected=True)
        seen = []

        async def previous_handler(message):
            seen.append(message['event'])

        client._caller_on_event = previous_handler
        task, stop_event, mapper, _ = _start_bridge(client)
        await _wait_until(lambda: client.monitor_calls)

        await client.emit('apaevt_flow', {'id': 0, 'op': 'begin'})

        stop_event.set()
        assert await task == 0
        # The pre-existing handler kept receiving events while bridged...
        assert seen == ['apaevt_flow']
        # ...and is restored once the bridge exits
        assert client._caller_on_event is previous_handler

    async def test_fixture_replay_routes_all_recorded_events(self):
        records = json.loads(FIXTURE_PATH.read_text(encoding='utf-8'))
        assert len(records) == 24

        client = FakeClient(connected=True)
        task, stop_event, mapper, metrics = _start_bridge(client)
        await _wait_until(lambda: client.monitor_calls)

        for record in records:
            await client.emit(record['event'], record['body'])

        stop_event.set()
        assert await task == 0

        expected_span_events = [r['event'] for r in records if r['event'] != 'apaevt_status_update']
        expected_status_count = sum(1 for r in records if r['event'] == 'apaevt_status_update')

        assert [name for name, _ in mapper.events] == expected_span_events
        assert len(metrics.statuses) == expected_status_count
        assert len(mapper.events) + len(metrics.statuses) == 24


# =========================================================================
# TRANSPORT SECURITY: cleartext-credential guard and endpoint redaction
# =========================================================================


class TestRedactEndpoint:
    def test_strips_userinfo_and_query(self):
        redacted = redact_endpoint('https://user:s3cr3t@collector.example:4318/v1/traces?sig=abc123#frag')
        assert 's3cr3t' not in redacted
        assert 'user' not in redacted
        assert 'abc123' not in redacted
        assert 'frag' not in redacted
        assert redacted == 'https://collector.example:4318/v1/traces?<redacted>'

    def test_keeps_scheme_host_port_and_ingest_path(self):
        assert redact_endpoint('https://cloud.langfuse.com/api/public/otel') == (
            'https://cloud.langfuse.com/api/public/otel'
        )

    def test_handles_scheme_less_grpc_endpoint(self):
        assert redact_endpoint('localhost:4317') == 'localhost:4317'

    def test_empty_endpoint_is_empty_string(self):
        assert redact_endpoint(None) == ''
        assert redact_endpoint('') == ''


class TestValidateTransportSecurity:
    def _config(self, **overrides):
        base = dict(endpoint=None, protocol='http', headers={}, no_metrics=False, allow_insecure=False)
        base.update(overrides)
        return SimpleNamespace(**base)

    def test_credential_header_over_remote_http_is_refused(self):
        config = self._config(endpoint='http://collector.example:4318', headers={'x-api-key': 'k'})
        with pytest.raises(InsecureTransportError) as excinfo:
            validate_transport_security(config, env={})
        message = str(excinfo.value)
        assert 'x-api-key' in message  # names only...
        assert 'k' not in message.split('credential headers:')[0]  # ...never values

    def test_loopback_http_is_allowed(self):
        for host in ('localhost', '127.0.0.1', '[::1]', 'jaeger.localhost'):
            config = self._config(endpoint=f'http://{host}:4318', headers={'Authorization': 'Basic x'})
            validate_transport_security(config, env={})

    def test_https_is_allowed(self):
        config = self._config(endpoint='https://collector.example:4318', headers={'x-api-key': 'k'})
        validate_transport_security(config, env={})

    def test_non_credential_headers_over_http_are_allowed(self):
        config = self._config(endpoint='http://collector.example:4318', headers={'Langsmith-Project': 'p'})
        validate_transport_security(config, env={})

    def test_env_headers_are_checked_too(self):
        # The bridge does not FORWARD these (the SDK does), but it must still
        # see them to decide whether the transport is safe.
        config = self._config(endpoint='http://collector.example:4318')
        for var in (
            'OTEL_EXPORTER_OTLP_HEADERS',
            'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
            'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
        ):
            with pytest.raises(InsecureTransportError):
                validate_transport_security(config, env={var: 'Authorization=Basic cGs6c2s='})

    def test_signal_specific_env_endpoint_is_checked(self):
        config = self._config(headers={'x-api-key': 'k'})
        with pytest.raises(InsecureTransportError) as excinfo:
            validate_transport_security(
                config, env={'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT': 'http://remote:4318/v1/traces'}
            )
        assert 'traces' in str(excinfo.value)

    def test_metrics_endpoint_ignored_when_metrics_disabled(self):
        config = self._config(headers={'x-api-key': 'k'}, no_metrics=True)
        env = {
            'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT': 'https://secure:4318/v1/traces',
            'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT': 'http://remote:4318/v1/metrics',
        }
        validate_transport_security(config, env=env)
        with pytest.raises(InsecureTransportError):
            validate_transport_security(self._config(headers={'x-api-key': 'k'}), env=env)

    def test_default_endpoint_is_loopback_and_allowed(self):
        config = self._config(headers={'x-api-key': 'k'})
        validate_transport_security(config, env={})

    def test_scheme_less_grpc_is_tls_unless_insecure_env_says_otherwise(self):
        config = self._config(endpoint='collector.example:4317', protocol='grpc', headers={'x-api-key': 'k'})
        validate_transport_security(config, env={})
        with pytest.raises(InsecureTransportError):
            validate_transport_security(config, env={'OTEL_EXPORTER_OTLP_INSECURE': 'true'})

    def test_allow_insecure_opt_out(self):
        config = self._config(endpoint='http://collector.example:4318', headers={'x-api-key': 'k'}, allow_insecure=True)
        validate_transport_security(config, env={})

    def test_allow_insecure_resolved_from_flag_and_env(self):
        args = SimpleNamespace(insecure=True)
        assert OtelConfig.from_args_env(args, env={}).allow_insecure is True
        assert OtelConfig.from_args_env(SimpleNamespace(), env={'ROCKETRIDE_OTEL_ALLOW_INSECURE': '1'}).allow_insecure
        assert OtelConfig.from_args_env(SimpleNamespace(), env={}).allow_insecure is False


# =========================================================================
# SIGNAL OWNERSHIP
# =========================================================================


class TestSignalOwnership:
    @pytest.mark.skipif(
        sys.platform == 'win32',
        reason='asyncio loop signal handlers are not supported on Windows (ProactorEventLoop)',
    )
    async def test_pre_existing_loop_signal_handler_is_not_stolen(self):
        import signal as signal_module

        loop = asyncio.get_running_loop()
        loop.add_signal_handler(signal_module.SIGTERM, lambda: None)
        embedder_handle = loop._signal_handlers[signal_module.SIGTERM]
        try:
            stop_event = asyncio.Event()
            client = FakeClient(connected=True)
            mapper = FakeMapper()
            task = asyncio.create_task(
                run_bridge(
                    client,
                    OtelConfig(),
                    mapper_factory=lambda: mapper,
                    metrics_factory=lambda: FakeMetrics(),
                    stop_event=stop_event,
                    poll_interval=0.01,
                )
            )
            await asyncio.sleep(0.05)
            stop_event.set()
            assert await task == 0
            # The embedder's callback survived the bridge's whole lifecycle:
            # never replaced during the run, never removed on cleanup.
            assert loop._signal_handlers.get(signal_module.SIGTERM) is embedder_handle
        finally:
            loop.remove_signal_handler(signal_module.SIGTERM)

    async def test_install_signal_handlers_false_registers_nothing(self):
        import signal as signal_module

        loop = asyncio.get_running_loop()
        before = dict(getattr(loop, '_signal_handlers', {}))
        stop_event = asyncio.Event()
        task = asyncio.create_task(
            run_bridge(
                FakeClient(connected=True),
                OtelConfig(),
                mapper_factory=lambda: FakeMapper(),
                metrics_factory=lambda: FakeMetrics(),
                stop_event=stop_event,
                install_signal_handlers=False,
                poll_interval=0.01,
            )
        )
        await asyncio.sleep(0.05)
        assert signal_module.SIGINT not in getattr(loop, '_signal_handlers', {})
        stop_event.set()
        assert await task == 0
        assert dict(getattr(loop, '_signal_handlers', {})) == before
