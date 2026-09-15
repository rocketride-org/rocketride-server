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
Unit tests for the 'rocketride otel' CLI command.

These tests exercise argument parsing, command registration, the
missing-extra guard (exit code 2 with the install hint, before any
connection attempt), and the wiring from parsed args through OtelConfig to
run_bridge. The RocketRide client and the bridge loop are faked, so no
server and no 'rocketride[otel]' extra are required.
"""

import argparse
import importlib
import importlib.util
import signal
from types import SimpleNamespace

import pytest

from rocketride.cli.commands import otel as otel_module
from rocketride.cli.commands.otel import run_otel

# Importable without the 'otel' extra: setup.py keeps all otel imports lazy.
from rocketride.otelbridge.setup import OtelNotInstalledError

HAS_OTEL_SDK = (
    importlib.util.find_spec('opentelemetry') is not None and importlib.util.find_spec('opentelemetry.sdk') is not None
)
try:
    HAS_GRPC_EXPORTER = importlib.util.find_spec('opentelemetry.exporter.otlp.proto.grpc') is not None
except (ImportError, ValueError):
    HAS_GRPC_EXPORTER = False

# The rocketride.cli package re-exports the main() FUNCTION under the name
# 'main', shadowing the main module; import the module explicitly.
cli_main = importlib.import_module('rocketride.cli.main')


class FakeCli:
    """Minimal CLI context for constructing commands directly."""

    def __init__(self):
        self.uri = 'http://localhost:5565'

    def is_cancelled(self):
        return True


class FakeClient:
    """Connection recorder; the guard must exit before any connect call."""

    def __init__(self):
        self.connect_calls = 0
        self._caller_on_event = None

    def is_connected(self):
        return False

    async def connect(self):
        self.connect_calls += 1

    async def add_monitor(self, key, types):
        pass

    async def disconnect(self):
        pass


def make_args(**overrides):
    """Build a parsed-args namespace with the otel command's attributes."""
    base = dict(
        command='otel',
        uri='http://localhost:5565',
        apikey='',
        token=None,
        endpoint=None,
        protocol='http',
        service_name=None,
        headers=None,
        include_content=False,
        no_metrics=False,
        insecure=False,
        trace_level=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


@pytest.fixture
def cli_parser():
    """The CLI's root parser, restoring any SIGINT handler that is disturbed."""
    previous = signal.getsignal(signal.SIGINT)
    try:
        yield cli_main.setup_parser()
    finally:
        signal.signal(signal.SIGINT, previous)


# =========================================================================
# REGISTRATION AND ARGUMENT PARSING
# =========================================================================


class TestOtelParser:
    def test_command_is_exported(self):
        from rocketride.cli import commands

        assert 'run_otel' in commands.__all__
        assert commands.run_otel is run_otel

    def test_otel_is_registered_exactly_once_alongside_validate(self, cli_parser):
        # The command table must carry both the upstream 'validate' verb and
        # this PR's 'otel' verb, each registered exactly once.
        subparsers = next(a for a in cli_parser._actions if isinstance(a, argparse._SubParsersAction))
        names = [choice.dest for choice in subparsers._choices_actions]
        assert names.count('otel') == 1
        assert names.count('validate') == 1

    def test_otel_has_no_shared_json_option_but_validate_does(self, cli_parser):
        # `otel` emits no JSON result, so it must not advertise --json;
        # `validate` keeps the shared --json [FILE] envelope.
        with pytest.raises(SystemExit):
            cli_parser.parse_args(['otel', '--json'])
        assert cli_parser.parse_args(['validate', 'a.pipe', '--json']).json == '-'

    def test_defaults(self, cli_parser):
        args = cli_parser.parse_args(['otel'])
        assert args.command == 'otel'
        assert args.endpoint is None
        assert args.protocol == 'http'
        assert args.service_name is None
        assert args.headers is None
        assert args.include_content is False
        assert args.no_metrics is False
        assert args.insecure is False
        assert args.trace_level is None

    def test_all_flags_parse(self, cli_parser):
        args = cli_parser.parse_args(
            [
                'otel',
                '--endpoint',
                'http://collector:4318',
                '--protocol',
                'grpc',
                '--service-name',
                'my-engine',
                '--headers',
                'x-api-key=abc,Langsmith-Project=proj',
                '--include-content',
                '--no-metrics',
                '--insecure',
                '--trace-level',
                'summary',
                '--uri',
                'http://server:5565',
                '--apikey',
                'KEY',
            ]
        )
        assert args.endpoint == 'http://collector:4318'
        assert args.protocol == 'grpc'
        assert args.service_name == 'my-engine'
        assert args.headers == 'x-api-key=abc,Langsmith-Project=proj'
        assert args.include_content is True
        assert args.no_metrics is True
        assert args.insecure is True
        assert args.trace_level == 'summary'
        assert args.uri == 'http://server:5565'
        assert args.apikey == 'KEY'

    def test_invalid_protocol_rejected(self, cli_parser):
        with pytest.raises(SystemExit):
            cli_parser.parse_args(['otel', '--protocol', 'carrier-pigeon'])

    def test_invalid_trace_level_rejected(self, cli_parser):
        with pytest.raises(SystemExit):
            cli_parser.parse_args(['otel', '--trace-level', 'verbose'])


# =========================================================================
# MISSING-EXTRA GUARD
# =========================================================================


class TestMissingExtraGuard:
    async def test_exits_2_with_hint_before_connecting(self, monkeypatch, capsys):
        monkeypatch.setattr(otel_module, '_otel_available', lambda: False)
        client = FakeClient()

        exit_code = await run_otel(make_args(), client)

        assert exit_code == 2
        err = capsys.readouterr().err
        assert "pip install 'rocketride[otel]'" in err
        # Guard must fire before any connection attempt
        assert client.connect_calls == 0

    def test_otel_available_reflects_find_spec(self, monkeypatch):
        import importlib.util

        monkeypatch.setattr(importlib.util, 'find_spec', lambda name: None)
        assert otel_module._otel_available() is False

    def test_otel_available_handles_import_machinery_errors(self, monkeypatch):
        import importlib.util

        def raising_find_spec(name):
            raise ModuleNotFoundError(name)

        monkeypatch.setattr(importlib.util, 'find_spec', raising_find_spec)
        assert otel_module._otel_available() is False


# =========================================================================
# EXECUTION WIRING
# =========================================================================


class TestOtelExecute:
    async def test_passes_config_built_from_args_to_run_bridge(self, monkeypatch, capsys):
        monkeypatch.setattr(otel_module, '_otel_available', lambda: True)
        recorded = {}

        async def fake_run_bridge(client, config):
            recorded['client'] = client
            recorded['config'] = config
            return 0

        monkeypatch.setattr(otel_module, 'run_bridge', fake_run_bridge)
        client = FakeClient()
        args = make_args(
            endpoint='https://collector:4318',
            service_name='my-engine',
            headers='x-api-key=abc',
            include_content=True,
            no_metrics=True,
        )

        exit_code = await run_otel(args, client)

        assert exit_code == 0
        assert recorded['client'] is client
        config = recorded['config']
        assert config.endpoint == 'https://collector:4318'
        assert config.service_name == 'my-engine'
        assert config.headers == {'x-api-key': 'abc'}
        assert config.include_content is True
        assert config.no_metrics is True
        out = capsys.readouterr().out
        assert 'OpenTelemetry bridge starting' in out

    async def test_trace_level_prints_informational_note(self, monkeypatch, capsys):
        monkeypatch.setattr(otel_module, '_otel_available', lambda: True)

        async def fake_run_bridge(client, config):
            return 0

        monkeypatch.setattr(otel_module, 'run_bridge', fake_run_bridge)

        await run_otel(make_args(trace_level='summary'), FakeClient())

        out = capsys.readouterr().out
        assert 'informational only' in out
        assert 'pipelineTraceLevel' in out
        assert "pipelineTraceLevel='summary'" in out

    async def test_trace_level_none_says_tracing_stays_disabled(self, monkeypatch, capsys):
        # 'none' must not be described as a level that emits FLOW events.
        monkeypatch.setattr(otel_module, '_otel_available', lambda: True)

        async def fake_run_bridge(client, config):
            return 0

        monkeypatch.setattr(otel_module, 'run_bridge', fake_run_bridge)

        await run_otel(make_args(trace_level='none'), FakeClient())

        out = capsys.readouterr().out
        assert 'informational only' in out
        assert 'flow tracing stays disabled' in out
        assert 'to emit FLOW events at that level' not in out

    @pytest.mark.parametrize('exc_type', [OtelNotInstalledError, ImportError])
    async def test_missing_dependency_from_bridge_exits_2(self, monkeypatch, capsys, exc_type):
        # OtelNotInstalledError is what build_providers actually raises for
        # --protocol grpc without opentelemetry-exporter-otlp-proto-grpc;
        # a raw ImportError from a lazy import must map the same way.
        monkeypatch.setattr(otel_module, '_otel_available', lambda: True)

        async def fake_run_bridge(client, config):
            raise exc_type('--protocol grpc requires: pip install opentelemetry-exporter-otlp-proto-grpc')

        monkeypatch.setattr(otel_module, 'run_bridge', fake_run_bridge)

        exit_code = await run_otel(make_args(protocol='grpc'), FakeClient())

        assert exit_code == 2
        assert 'opentelemetry-exporter-otlp-proto-grpc' in capsys.readouterr().err

    @pytest.mark.skipif(not HAS_OTEL_SDK, reason="requires the 'otel' extra")
    @pytest.mark.skipif(HAS_GRPC_EXPORTER, reason='OTLP gRPC exporter is installed')
    async def test_real_grpc_protocol_without_exporter_exits_2(self, capsys):
        # Nothing faked: the real run_bridge -> build_providers path must
        # surface the missing gRPC exporter as exit code 2 with the hint.
        exit_code = await run_otel(make_args(protocol='grpc'), FakeClient())

        assert exit_code == 2
        assert 'opentelemetry-exporter-otlp-proto-grpc' in capsys.readouterr().err

    async def test_unexpected_error_exits_1(self, monkeypatch, capsys):
        monkeypatch.setattr(otel_module, '_otel_available', lambda: True)

        async def fake_run_bridge(client, config):
            raise RuntimeError('exporter blew up')

        monkeypatch.setattr(otel_module, 'run_bridge', fake_run_bridge)

        exit_code = await run_otel(make_args(), FakeClient())

        assert exit_code == 1
        assert 'exporter blew up' in capsys.readouterr().err

    async def test_bridge_exit_code_propagates(self, monkeypatch):
        monkeypatch.setattr(otel_module, '_otel_available', lambda: True)

        async def fake_run_bridge(client, config):
            return 2

        monkeypatch.setattr(otel_module, 'run_bridge', fake_run_bridge)

        assert await run_otel(make_args(), FakeClient()) == 2


# =========================================================================
# END-TO-END CLI ROUTING (parser -> _dispatch -> run_otel)
# =========================================================================


class TestCliRouting:
    async def test_dispatch_routes_bare_otel_without_requiring_a_token(self, monkeypatch):
        # 'otel' takes no token and no positional argument: bare `rocketride
        # otel` must parse and route straight through to run_otel.
        monkeypatch.delenv('ROCKETRIDE_TOKEN', raising=False)
        recorded = {}

        async def fake_run_otel(args, client=None):
            recorded['args'] = args
            recorded['client'] = client
            return 7

        # _dispatch imports run_otel from the module on each call, so the
        # patch has to land on the module attribute.
        monkeypatch.setattr(otel_module, 'run_otel', fake_run_otel)

        parser = cli_main.setup_parser()
        args = parser.parse_args(['otel'])
        assert not hasattr(args, 'token')

        exit_code = await cli_main._dispatch(args)

        # The command ran (returning our sentinel), with no client handed in:
        # run_otel builds its own so the missing-extra guard can refuse first.
        assert exit_code == 7
        assert recorded['args'].uri
        assert recorded['client'] is None

    async def test_cli_client_is_built_from_args_and_left_unconnected(self, monkeypatch):
        # The CLI hands run_otel no client, so run_otel builds one from
        # --uri/--apikey and passes it to the bridge WITHOUT connecting:
        # connecting (and reconnecting) is the bridge's job.
        monkeypatch.setattr(otel_module, '_otel_available', lambda: True)
        created = {}
        recorded = {}

        class FakeRRClient:
            def __init__(self, uri, auth=''):
                created['uri'] = uri
                created['auth'] = auth
                self.connect_calls = 0

            def is_connected(self):
                return False

            async def connect(self):
                self.connect_calls += 1

            async def disconnect(self):
                created['disconnected'] = True

        async def fake_run_bridge(client, config):
            recorded['client'] = client
            return 0

        monkeypatch.setattr('rocketride.RocketRideClient', FakeRRClient)
        monkeypatch.setattr(otel_module, 'run_bridge', fake_run_bridge)

        parser = cli_main.setup_parser()
        args = parser.parse_args(['otel', '--uri', 'http://server:5565', '--apikey', 'KEY'])

        assert await cli_main._dispatch(args) == 0
        assert created['uri'] == 'http://server:5565'
        assert created['auth'] == 'KEY'
        assert recorded['client'].connect_calls == 0
        # A client this command created is a client this command closes
        assert created['disconnected'] is True

    async def test_injected_client_is_not_disconnected_by_the_command(self, monkeypatch):
        # A caller-supplied client (embedded use, tests) stays the caller's.
        monkeypatch.setattr(otel_module, '_otel_available', lambda: True)

        async def fake_run_bridge(client, config):
            return 0

        monkeypatch.setattr(otel_module, 'run_bridge', fake_run_bridge)

        class TrackingClient(FakeClient):
            def __init__(self):
                super().__init__()
                self.disconnect_calls = 0

            async def disconnect(self):
                self.disconnect_calls += 1

        client = TrackingClient()
        assert await run_otel(make_args(), client) == 0
        assert client.disconnect_calls == 0


# =========================================================================
# TRANSPORT SECURITY AND STDOUT REDACTION (CodeRabbit round 2)
# =========================================================================


class TestOtelTransportSecurity:
    async def test_startup_line_redacts_endpoint_credentials(self, monkeypatch, capsys):
        """Regression: no userinfo or signed query value may reach stdout."""
        monkeypatch.setattr(otel_module, '_otel_available', lambda: True)

        async def fake_run_bridge(client, config):
            return 0

        monkeypatch.setattr(otel_module, 'run_bridge', fake_run_bridge)
        args = make_args(endpoint='https://svcuser:sup3rs3cret@collector.example:4318/v1/traces?sig=DEADBEEF')

        assert await run_otel(args, FakeClient()) == 0

        captured = capsys.readouterr()
        combined = captured.out + captured.err
        assert 'sup3rs3cret' not in combined
        assert 'svcuser' not in combined
        assert 'DEADBEEF' not in combined
        assert 'https://collector.example:4318/v1/traces' in captured.out

    async def test_startup_line_redacts_env_endpoint(self, monkeypatch, capsys):
        monkeypatch.setattr(otel_module, '_otel_available', lambda: True)
        monkeypatch.setenv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://u:p4ssw0rd@collector.example:4318')
        monkeypatch.delenv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', raising=False)

        async def fake_run_bridge(client, config):
            return 0

        monkeypatch.setattr(otel_module, 'run_bridge', fake_run_bridge)

        assert await run_otel(make_args(), FakeClient()) == 0

        captured = capsys.readouterr()
        assert 'p4ssw0rd' not in captured.out + captured.err
        assert 'https://collector.example:4318' in captured.out

    async def test_cleartext_credentials_refused_with_exit_2(self, monkeypatch, capsys):
        monkeypatch.setattr(otel_module, '_otel_available', lambda: True)
        monkeypatch.delenv('OTEL_EXPORTER_OTLP_HEADERS', raising=False)
        called = []

        async def fake_run_bridge(client, config):
            called.append(config)
            return 0

        monkeypatch.setattr(otel_module, 'run_bridge', fake_run_bridge)
        args = make_args(endpoint='http://collector.example:4318', headers='x-api-key=abc')

        assert await run_otel(args, FakeClient()) == 2

        assert called == [], 'the bridge must not connect before the transport is validated'
        err = capsys.readouterr().err
        assert 'cleartext' in err
        assert 'x-api-key' in err
        assert 'abc' not in err  # the header VALUE never appears

    async def test_insecure_flag_allows_cleartext_and_warns(self, monkeypatch, capsys):
        monkeypatch.setattr(otel_module, '_otel_available', lambda: True)
        monkeypatch.delenv('OTEL_EXPORTER_OTLP_HEADERS', raising=False)

        async def fake_run_bridge(client, config):
            return 0

        monkeypatch.setattr(otel_module, 'run_bridge', fake_run_bridge)
        args = make_args(endpoint='http://collector.example:4318', headers='x-api-key=abc', insecure=True)

        assert await run_otel(args, FakeClient()) == 0

        assert 'WARNING: --insecure' in capsys.readouterr().err

    async def test_loopback_cleartext_still_works(self, monkeypatch, capsys):
        monkeypatch.setattr(otel_module, '_otel_available', lambda: True)
        monkeypatch.delenv('OTEL_EXPORTER_OTLP_HEADERS', raising=False)

        async def fake_run_bridge(client, config):
            return 0

        monkeypatch.setattr(otel_module, 'run_bridge', fake_run_bridge)
        args = make_args(endpoint='http://localhost:4318', headers='Authorization=Basic abc')

        assert await run_otel(args, FakeClient()) == 0
