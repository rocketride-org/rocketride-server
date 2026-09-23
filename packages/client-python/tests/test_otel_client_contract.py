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
Contract tests binding the OTel bridge to the REAL RocketRideClient.

test_otel_bridge.py and test_otel_cli.py each define their own ``FakeClient``.
That is the right shape for exercising the run loop's branches, but it leaves
the bridge's single point of coupling to the SDK untested: the bridge receives
events by assigning its dispatcher to the PRIVATE attribute
``RocketRideClient._caller_on_event`` (``bridge.CLIENT_EVENT_HOOK``), which
``EventMixin.__init__`` creates and ``EventMixin.on_event`` awaits.

Nothing public pins that name. Were the SDK to rename or drop it, the bridge
would keep starting, keep subscribing, keep logging "reconnected" — and export
nothing, forever, because assigning an unknown attribute to a Python object
succeeds silently. A fake client that defines the attribute itself cannot
detect that; it would happily keep passing. So these tests use the real client.

Only the WebSocket transport is replaced (see :func:`offline_client`):
``RocketRideClient`` is constructed normally, and the SDK's own ``add_monitor``
bookkeeping, ``on_event`` dispatch, ``FlowSpanMapper``, ``MetricsMapper`` and
the OpenTelemetry SDK span/metric pipeline all run for real.

Covered here:
    - The private hook exists on a real client, is where the public
      ``on_event=`` constructor kwarg lands, and is what the SDK's dispatch
      actually awaits (three tests that fail on a rename)
    - run_bridge end to end on a real client: events pushed through the real
      ``EventMixin.on_event`` reach the mappers, and the hook is restored
    - The wildcard monitor subscription as the real SDK encodes it, including
      the ``_monitor_keys`` entry the bridge relies on for replay-on-reconnect
    - Full fixture replay producing real exported spans and metric points
    - Opt-in export against a live OTLP collector (skipped unless
      ROCKETRIDE_OTEL_TEST_ENDPOINT is set — no collector is started here)

The OpenTelemetry SDK is a required dependency of this file, as it is of
test_otel_mapper.py: a missing install must fail collection rather than
silently drop coverage.
"""

import asyncio
import json
import os
from pathlib import Path

import pytest
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from rocketride import RocketRideClient
from rocketride.otelbridge.bridge import CLIENT_EVENT_HOOK, MONITOR_KEY, MONITOR_TYPES, run_bridge
from rocketride.otelbridge.config import OtelConfig
from rocketride.otelbridge.mapper import FlowSpanMapper, MetricsMapper

FIXTURE_PATH = Path(__file__).parent / 'fixtures' / 'otel_bridge_events.json'

# Opt-in live export. Set to a collector's OTLP/HTTP base URL, e.g.
#   ROCKETRIDE_OTEL_TEST_ENDPOINT=http://localhost:4318 python -m pytest ...
# Same shape as RocketRideClient_test.py's `requires_llm`: the test is skipped,
# never self-provisioned, when the environment is absent.
ENV_LIVE_ENDPOINT = 'ROCKETRIDE_OTEL_TEST_ENDPOINT'
requires_otlp_collector = pytest.mark.skipif(
    not os.environ.get(ENV_LIVE_ENDPOINT),
    reason=f'Skipped: no OTLP collector configured (set {ENV_LIVE_ENDPOINT} to its base URL)',
)


# =========================================================================
# HELPERS
# =========================================================================


def offline_client(**kwargs) -> RocketRideClient:
    """
    A real RocketRideClient with only its transport stubbed out.

    ``connect``/``disconnect`` never run and the socket is never opened; what
    remains real is everything the bridge touches: the ``_caller_on_event``
    hook created by ``EventMixin.__init__``, ``EventMixin.on_event``'s dispatch
    to it, and ``add_monitor``'s reference-counting bookkeeping. ``call`` is
    recorded rather than sent, so the wildcard subscription can be asserted at
    the DAP-command level.
    """
    client = RocketRideClient(uri='http://localhost:5565', auth='TESTKEY', **kwargs)
    client.calls = []

    async def fake_call(command, **call_kwargs):
        client.calls.append((command, call_kwargs))
        return {}

    client.call = fake_call
    client.is_connected = lambda: True
    return client


def event_envelope(event: str, body: dict, seq: int = 0) -> dict:
    """One DAP event envelope in the shape the SDK receives off the socket."""
    return {'type': 'event', 'event': event, 'seq': seq, 'body': body}


class RecordingMapper:
    """Span-mapper stand-in used where the assertion is about routing, not spans."""

    def __init__(self):
        self.events = []
        self.closed = False

    def handle_event(self, event_name, body):
        self.events.append((event_name, body))

    def close_all(self):
        self.closed = True


class RecordingMetrics:
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


async def _bridge_session(client, config=None, mapper=None, metrics=None):
    """
    Run run_bridge against ``client`` and yield control once it is subscribed.

    Returns (task, stop_event, mapper, metrics). The caller drives events
    through the REAL ``client.on_event`` and then sets the stop event.
    """
    mapper = mapper if mapper is not None else RecordingMapper()
    metrics = metrics if metrics is not None else RecordingMetrics()
    stop_event = asyncio.Event()
    task = asyncio.ensure_future(
        run_bridge(
            client,
            config or OtelConfig(),
            lambda: mapper,
            lambda: metrics,
            stop_event=stop_event,
            install_signal_handlers=False,
            poll_interval=0.01,
        )
    )
    await _wait_until(lambda: any(command == 'rrext_monitor' for command, _ in client.calls))
    return task, stop_event, mapper, metrics


# =========================================================================
# THE PRIVATE HOOK: three ways an SDK rename must break a test
# =========================================================================


class TestPrivateEventHookContract:
    """
    The bridge's only coupling to SDK internals, pinned from three angles.

    If ``EventMixin`` renames or drops ``_caller_on_event``, or stops awaiting
    it, at least one of these fails with a message naming the attribute —
    instead of the bridge going quiet in production.
    """

    def test_real_client_defines_the_private_hook_the_bridge_writes(self):
        client = offline_client()
        # `in vars(...)` deliberately, not hasattr: hasattr would also be true
        # of an attribute that only ever existed because the bridge set it.
        assert CLIENT_EVENT_HOOK in vars(client), (
            f'RocketRideClient no longer defines {CLIENT_EVENT_HOOK!r}; '
            f'rocketride.otelbridge.bridge installs its event dispatcher on that attribute '
            f'and would silently receive nothing. Update CLIENT_EVENT_HOOK in bridge.py.'
        )

    def test_public_on_event_kwarg_lands_on_the_private_hook(self):
        """The hook is the storage behind the documented ``on_event=`` kwarg."""

        async def handler(message):  # pragma: no cover - never invoked here
            pass

        client = offline_client(on_event=handler)
        assert vars(client)[CLIENT_EVENT_HOOK] is handler

    async def test_sdk_dispatch_awaits_whatever_the_private_hook_holds(self):
        """``EventMixin.on_event`` must call through the hook, not a captured ref."""
        client = offline_client()
        seen = []

        async def handler(message):
            seen.append(message['event'])

        # Installed by assignment AFTER construction, exactly as run_bridge does.
        setattr(client, CLIENT_EVENT_HOOK, handler)
        await client.on_event(event_envelope('apaevt_flow', {'id': 0, 'op': 'begin'}))

        assert seen == ['apaevt_flow'], (
            f'the SDK no longer dispatches events through {CLIENT_EVENT_HOOK!r}; '
            f'the OTel bridge attaches there and would export nothing.'
        )


# =========================================================================
# run_bridge ON A REAL CLIENT
# =========================================================================


class TestBridgeAgainstRealClient:
    """End to end with only the socket faked: real client, real SDK dispatch."""

    async def test_events_reach_the_mappers_through_the_real_sdk_dispatch(self):
        client = offline_client()
        task, stop_event, mapper, metrics = await _bridge_session(client)

        # Pushed through EventMixin.on_event — the SDK's own code path — not
        # through a fake's hand-rolled emit().
        await client.on_event(event_envelope('apaevt_flow', {'id': 0, 'op': 'begin'}, seq=1))
        await client.on_event(event_envelope('apaevt_task', {'action': 'running'}, seq=2))
        await client.on_event(event_envelope('apaevt_sse', {'pipe_id': 0, 'type': 'thinking'}, seq=3))
        await client.on_event(event_envelope('apaevt_status_update', {'state': 3}, seq=4))
        # An event the bridge does not consume must not reach either mapper.
        await client.on_event(event_envelope('apaevt_status_upload', {'action': 'write'}, seq=5))

        stop_event.set()
        assert await task == 0

        assert [name for name, _ in mapper.events] == ['apaevt_flow', 'apaevt_task', 'apaevt_sse']
        assert metrics.statuses == [{'state': 3}]
        assert mapper.closed is True

    async def test_hook_is_restored_on_the_real_client_after_shutdown(self):
        """A bridge run must leave the real client's hook exactly as it found it."""
        client = offline_client()
        assert vars(client)[CLIENT_EVENT_HOOK] is None

        task, stop_event, _, _ = await _bridge_session(client)
        assert vars(client)[CLIENT_EVENT_HOOK] is not None  # dispatcher attached

        stop_event.set()
        assert await task == 0
        assert vars(client)[CLIENT_EVENT_HOOK] is None

    async def test_wildcard_subscription_as_the_real_sdk_encodes_it(self):
        """The documented ingester scope, asserted at the DAP-command level."""
        client = offline_client()
        task, stop_event, _, _ = await _bridge_session(client)
        stop_event.set()
        assert await task == 0

        monitor_calls = [kwargs for command, kwargs in client.calls if command == 'rrext_monitor']
        assert len(monitor_calls) == 1
        assert monitor_calls[0]['token'] == MONITOR_KEY['token'] == '*'
        assert monitor_calls[0]['types'] == list(MONITOR_TYPES)

        # The bridge subscribes exactly once and leans on the SDK to replay the
        # subscription after a reconnect. That replay reads _monitor_keys, so
        # the entry has to survive the call — assert it rather than trusting it.
        assert client._monitor_keys, 'the SDK kept no monitor entry to replay on reconnect'
        recorded = next(iter(client._monitor_keys.values()))
        assert sorted(recorded) == sorted(MONITOR_TYPES)

    async def test_fixture_replay_exports_real_spans_and_metrics(self):
        """
        The recorded wire fixture, driven through every real layer.

        Real client -> real EventMixin.on_event -> run_bridge dispatcher ->
        real FlowSpanMapper/MetricsMapper -> real OpenTelemetry TracerProvider
        and MeterProvider. The span count matches
        test_otel_mapper.test_full_fixture_replay_produces_coherent_span_forest,
        which feeds the same records to the mappers directly: the bridge must
        not add, drop or reorder anything on the way.
        """
        exporter = InMemorySpanExporter()
        tracer_provider = TracerProvider()
        tracer_provider.add_span_processor(SimpleSpanProcessor(exporter))
        reader = InMemoryMetricReader()
        meter_provider = MeterProvider(metric_readers=[reader])

        mapper = FlowSpanMapper(tracer_provider.get_tracer('contract-test'))
        metrics = MetricsMapper(meter_provider.get_meter('contract-test'))

        client = offline_client()
        task, stop_event, _, _ = await _bridge_session(client, mapper=mapper, metrics=metrics)

        records = json.loads(FIXTURE_PATH.read_text(encoding='utf-8'))
        assert len(records) == 24
        for seq, record in enumerate(records):
            await client.on_event(event_envelope(record['event'], record['body'], seq=seq))

        stop_event.set()
        assert await task == 0

        spans = exporter.get_finished_spans()
        assert mapper.open_span_count() == 0  # run_bridge's close_all() ran
        assert len(spans) == 10
        assert all(span.end_time is not None for span in spans)
        assert [span for span in spans if span.name.startswith('task ')]

        metric_names = {
            metric.name
            for resource_metric in reader.get_metrics_data().resource_metrics
            for scope_metric in resource_metric.scope_metrics
            for metric in scope_metric.metrics
        }
        assert metric_names, 'status events produced no metric points'


# =========================================================================
# OPT-IN: export against a live OTLP collector
# =========================================================================


@requires_otlp_collector
class TestLiveOtlpCollector:
    """
    Export to a real collector. Skipped unless ROCKETRIDE_OTEL_TEST_ENDPOINT is
    set; this suite starts no collector of its own.

    The OTLP/HTTP exporter is fire-and-forget over a background batch
    processor, so a bad endpoint cannot be detected by a return value. What is
    asserted is what the bridge itself depends on: build_providers yields a
    usable tracer against the configured endpoint, and the shutdown it returns
    completes without raising after real spans have been handed to it.
    """

    async def test_fixture_replay_flushes_to_the_configured_collector(self):
        from rocketride.otelbridge.setup import build_providers

        config = OtelConfig(
            endpoint=os.environ[ENV_LIVE_ENDPOINT],
            service_name='rocketride-otel-contract-test',
        )
        tracer, meter, shutdown = build_providers(config, with_tracer=True, with_meter=True)

        mapper = FlowSpanMapper(tracer)
        metrics = MetricsMapper(meter)
        client = offline_client()
        task, stop_event, _, _ = await _bridge_session(client, mapper=mapper, metrics=metrics)

        records = json.loads(FIXTURE_PATH.read_text(encoding='utf-8'))
        for seq, record in enumerate(records):
            await client.on_event(event_envelope(record['event'], record['body'], seq=seq))

        stop_event.set()
        assert await task == 0
        assert mapper.open_span_count() == 0

        # run_bridge only shuts down providers it built itself; these are ours.
        shutdown()
