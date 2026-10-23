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
"""Real-engine routing through System One and Gates (spec A1).

Runs on the engine ``builder nodes:test`` starts. Skips when that engine is remote,
because it could not reach the in-process fake backend.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from urllib.parse import urlparse

import pytest

from .fake_systemone import FakeSystemOne

URI = os.environ.get('ROCKETRIDE_URI', 'http://localhost:5565')
AUTH = os.environ.get('ROCKETRIDE_APIKEY', 'MYAPIKEY')
_LOOPBACK = {'', 'localhost', '127.0.0.1', '::1', '0.0.0.0'}

pytestmark = [
    pytest.mark.skipif(
        urlparse(URI).hostname not in _LOOPBACK,
        reason='the engine is remote and cannot reach the in-process fake System One backend',
    ),
    pytest.mark.usefixtures('server_available'),
]

WEBHOOK = {
    'id': 'webhook_1',
    'provider': 'webhook',
    'config': {'hideForm': True, 'mode': 'Source', 'parameters': {}, 'type': 'webhook'},
    'input': [],
}
OPTIONS = (
    'billing | Payments and invoices\ntechnical | Bugs and errors\nsales | Buying and pricing\nother | Anything else'
)
LEVELS = 'low\nmedium\nhigh'


def systemone(component_id: str, *, source: str, lane: str, url: str) -> dict:
    """A System One node (custom endpoint) asking one question of each type."""
    return {
        'id': component_id,
        'provider': 'decision_systemone',
        'config': {
            'profile': 'custom',
            'custom': {'model': 'fake', 'serverbase': url},
            'yes_no': [{'name': 'is_spam', 'question': 'Is this email spam?'}],
            'pick_one': [{'name': 'department', 'question': 'Which team should handle it?', 'options': OPTIONS}],
            'rubric': [{'name': 'urgency', 'question': 'How urgent is it?', 'levels': LEVELS}],
            'parameters': {},
        },
        'input': [{'lane': lane, 'from': source}],
    }


def gate(component_id: str, conditions: list[dict], *, source: str, lane: str) -> dict:
    """A Gate with ``match: all``."""
    return {
        'id': component_id,
        'provider': 'gate',
        'config': {'match': 'all', 'conditions': conditions},
        'input': [{'lane': lane, 'from': source}],
    }


def sink(component_id: str, provider: str, lane_name: str, *, source: str, lane: str) -> dict:
    """A response node whose result key is ``lane_name``."""
    return {
        'id': component_id,
        'provider': provider,
        'config': {'laneName': lane_name},
        'input': [{'lane': lane, 'from': source}],
    }


# name -> (text, response keys it must reach). Markers drive the fake backend.
EMAILS = {
    'e01': ('Your account is locked, verify now. is_spam:yes department:other urgency:2', {'spam', 'urgent'}),
    'e02': ('Cheap pills, buy today! is_spam:yes department:sales urgency:0', {'spam', 'sales_billing'}),
    'e03': ('You won a prize, click here. is_spam:yes department:technical urgency:1', {'spam'}),
    'e04': (
        'Invoice 4411 is wrong and due today. department:billing urgency:2',
        {'not_spam', 'sales_billing', 'urgent'},
    ),
    'e05': ("Please send last month's receipt. department:billing urgency:0", {'not_spam', 'sales_billing'}),
    'e06': ('The app crashes on login for everyone. department:technical urgency:2', {'not_spam', 'urgent'}),
    'e07': ('A typo on the settings page. department:technical urgency:0', {'not_spam'}),
    'e08': ('Can we get a quote for 50 seats? department:sales urgency:1', {'not_spam', 'sales_billing'}),
    'e09': ('Thanks for the help last week. department:other urgency:1', {'not_spam'}),
    'e10': (
        'Pay this invoice now or lose access. is_spam:yes department:billing urgency:2',
        {'spam', 'sales_billing', 'urgent'},
    ),
}
LANE_GATES = {'spam': 'gate_spam', 'not_spam': 'gate_ham', 'sales_billing': 'gate_dept', 'urgent': 'gate_urgent'}


def text_pipeline(url: str) -> dict:
    """Webhook -> System One -> four Gates -> four text sinks."""
    components = [WEBHOOK, systemone('decision_systemone_1', source='webhook_1', lane='text', url=url)]
    conditions = {
        'gate_spam': [{'question': 'is_spam', 'op': 'equals', 'value': 'yes'}],
        'gate_ham': [{'question': 'is_spam', 'op': 'not_equals', 'value': 'yes'}],
        'gate_dept': [{'question': 'department', 'op': 'in', 'value': 'billing, sales'}],
        'gate_urgent': [{'question': 'urgency', 'op': 'gte', 'value': '2'}],
    }
    for lane_name, gate_id in LANE_GATES.items():
        components.append(gate(gate_id, conditions[gate_id], source='decision_systemone_1', lane='text'))
        components.append(sink(f'sink_{lane_name}', 'response_text', lane_name, source=gate_id, lane='text'))
    return {'project_id': str(uuid.uuid4()), 'source': 'webhook_1', 'components': components}


async def run_pipeline(pipeline: dict, sends: list[tuple[str, bytes | str, str]], *, trace_level: str = 'metadata'):
    """Start ``pipeline``, send each ``(name, data, mimetype)`` in order, and collect results, traces and errors.

    Returns ``(results, traces, errors)`` keyed by object name. ``traces[name]`` holds that
    object's ``apaevt_flow`` bodies in arrival order. A send that fails puts its message in ``errors``.
    """
    from rocketride import RocketRideClient

    flow: list[dict] = []

    async def on_event(message: dict) -> None:
        if message.get('event') == 'apaevt_flow':
            flow.append(message.get('body') or {})

    results: dict[str, dict] = {}
    errors: dict[str, str] = {}
    async with RocketRideClient(uri=URI, auth=AUTH, on_event=on_event) as client:
        started = await client.use(pipeline=pipeline, pipelineTraceLevel=trace_level)
        token = started['token']
        try:
            await client.add_monitor({'token': token}, ['flow'])
            for name, data, mimetype in sends:
                try:
                    result = await client.send(token, data, objinfo={'name': name}, mimetype=mimetype)
                except Exception as exc:  # a pipe error fails the object
                    errors[name] = str(exc)
                    continue
                if isinstance(result, dict) and result.get('error'):
                    error = result['error']
                    errors[name] = error.get('message', str(error)) if isinstance(error, dict) else str(error)
                results[name] = result if isinstance(result, dict) else {}
            if trace_level != 'none':
                for _ in range(100):  # flow events can trail the send's return by a little
                    if sum(1 for body in flow if body.get('op') == 'end') >= len(sends):
                        break
                    await asyncio.sleep(0.1)
        finally:
            try:
                await client.terminate(token)
            except Exception:
                pass
    return results, _by_object(flow), errors


def _by_object(flow: list[dict]) -> dict[str, list[dict]]:
    """Split flow bodies per object: a ``begin`` binds a pipe slot to its object name (``pipes[0]``)."""
    current: dict = {}
    traces: dict[str, list[dict]] = {}
    for body in flow:
        slot = body.get('id')
        if body.get('op') == 'begin':
            current[slot] = (body.get('pipes') or [''])[0]
        name = current.get(slot)
        if name is not None:
            traces.setdefault(name, []).append(body)
    return traces


def _object_key(traces: dict[str, list[dict]], name: str) -> str:
    """The object name the engine reports may carry a path or suffix; match on the sent name."""
    matches = [key for key in traces if key == name or key.endswith(name) or name in key]
    assert len(matches) == 1, f'expected one trace for {name}, found {matches} among {sorted(traces)}'
    return matches[0]


def gate_leaves(events: list[dict], component: str) -> list[dict]:
    """The ``trace`` of every leave event for ``component``."""
    return [
        body.get('trace') or {} for body in events if body.get('op') == 'leave' and body.get('component') == component
    ]


async def test_text_routing_covers_every_question_type():
    with FakeSystemOne() as fake:
        sends = [(name, text, 'text/plain') for name, (text, _) in EMAILS.items()]
        results, traces, errors = await run_pipeline(text_pipeline(fake.url), sends)
    assert not errors, errors
    for name, (_, expected) in EMAILS.items():
        reached = {key for key in LANE_GATES if results[name].get(key)}
        assert reached == expected, f'{name}: reached {sorted(reached)}, expected {sorted(expected)}'
    # Every gate both passes and blocks at least once across the fixtures.
    for lane_name in LANE_GATES:
        hits = [name for name, (_, expected) in EMAILS.items() if lane_name in expected]
        assert 0 < len(hits) < len(EMAILS), f'{lane_name} must both pass and block somewhere'


def lane_entered(events: list[dict], component: str, lane: str) -> bool:
    """True when ``component`` was entered on ``lane`` (an ``enter`` event)."""
    return any(
        body.get('op') == 'enter'
        and body.get('component') == component
        and (body.get('trace') or {}).get('lane') == lane
        for body in events
    )


async def test_text_gate_trace_shows_which_gates_forwarded():
    """Each Gate sees every text item; only a passing Gate's sink is entered.

    The engine reports a blocked Python node's leave as ``continue`` (``call.hpp`` swallows the
    ``PreventDefault``), so a block shows as the downstream sink never being entered.
    """
    with FakeSystemOne() as fake:
        sends = [(name, text, 'text/plain') for name, (text, _) in EMAILS.items()]
        _, traces, errors = await run_pipeline(text_pipeline(fake.url), sends)
    assert not errors, errors
    for name, (_, expected) in EMAILS.items():
        events = traces[_object_key(traces, name)]
        for lane_name, gate_id in LANE_GATES.items():
            leaves = [t for t in gate_leaves(events, gate_id) if t.get('lane') == 'text']
            assert leaves, f'{name}: no text leave event for {gate_id}'
            assert all(t.get('result') != 'error' for t in leaves), f'{name}/{gate_id}: {leaves}'
            forwarded = lane_entered(events, f'sink_{lane_name}', 'text')
            assert forwarded == (lane_name in expected), (
                f'{name}/{gate_id}: forwarded={forwarded}, expected {lane_name in expected}'
            )


def _docs(*texts: str) -> bytes:
    return json.dumps(
        [{'page_content': text, 'metadata': {'objectId': 'obj', 'chunkId': i}} for i, text in enumerate(texts)]
    ).encode('utf-8')


def documents_pipeline(url: str) -> dict:
    """Webhook (documents) -> System One -> Gate (is_spam equals yes) -> documents sink."""
    return {
        'project_id': str(uuid.uuid4()),
        'source': 'webhook_1',
        'components': [
            WEBHOOK,
            systemone('decision_systemone_1', source='webhook_1', lane='documents', url=url),
            gate(
                'gate_spam',
                [{'question': 'is_spam', 'op': 'equals', 'value': 'yes'}],
                source='decision_systemone_1',
                lane='documents',
            ),
            sink('sink_spam', 'response_documents', 'spam_docs', source='gate_spam', lane='documents'),
        ],
    }


def _contents(result: dict, key: str) -> list[str]:
    return [doc.get('page_content') for doc in result.get(key) or []]


async def test_documents_routing_forwards_only_passing_documents():
    with FakeSystemOne() as fake:
        sends = [
            ('partial', _docs('hello is_spam:yes', 'a normal note', 'win cash is_spam:yes'), 'lane/documents'),
            ('all_pass', _docs('promo is_spam:yes', 'scam is_spam:yes'), 'lane/documents'),
            ('none_pass', _docs('meeting notes', 'lunch plans'), 'lane/documents'),
        ]
        results, _, errors = await run_pipeline(documents_pipeline(fake.url), sends)
    assert not errors, errors
    assert _contents(results['partial'], 'spam_docs') == ['hello is_spam:yes', 'win cash is_spam:yes']
    assert _contents(results['all_pass'], 'spam_docs') == ['promo is_spam:yes', 'scam is_spam:yes']
    assert _contents(results['none_pass'], 'spam_docs') == []


def json_pipeline(url: str) -> dict:
    """Webhook (json) -> System One -> Gate (is_spam equals yes) -> json sink."""
    return {
        'project_id': str(uuid.uuid4()),
        'source': 'webhook_1',
        'components': [
            WEBHOOK,
            systemone('decision_systemone_1', source='webhook_1', lane='json', url=url),
            gate(
                'gate_spam',
                [{'question': 'is_spam', 'op': 'equals', 'value': 'yes'}],
                source='decision_systemone_1',
                lane='json',
            ),
            sink('sink_spam', 'response_json', 'spam_json', source='gate_spam', lane='json'),
        ],
    }


async def test_json_routing_decides_the_whole_item_and_forwards_it_unchanged():
    spam = {'subject': 'You won', 'body': 'Claim your prize is_spam:yes', 'tags': ['promo']}
    ham = {'subject': 'Lunch', 'body': 'Noon on Friday?', 'tags': []}
    with FakeSystemOne() as fake:
        sends = [(name, json.dumps(data), 'lane/json') for name, data in (('spam', spam), ('ham', ham))]
        results, _, errors = await run_pipeline(json_pipeline(fake.url), sends)
        states = [request['state'] for request in fake.requests]
    assert not errors, errors
    # The node's startup probe sends a text state first; every item after it is the parsed object, not its text.
    assert states[-2:] == [spam, ham]
    assert results['spam'].get('spam_json') == [spam]
    assert not results['ham'].get('spam_json')
    item = results['spam']['decisions']['decision_systemone_1']['items'][0]
    assert item['lane'] == 'json' and item['status'] == 'ok'


def anomaly_pipeline() -> dict:
    """Webhook (documents) -> anomaly_detector -> Gate (is_anomalous equals yes) -> documents sink."""
    return {
        'project_id': str(uuid.uuid4()),
        'source': 'webhook_1',
        'components': [
            WEBHOOK,
            {
                'id': 'anomaly_detector_1',
                'provider': 'anomaly_detector',
                'config': {'profile': 'z_score'},
                'input': [{'lane': 'documents', 'from': 'webhook_1'}],
            },
            gate(
                'gate_anomaly',
                [{'question': 'is_anomalous', 'op': 'equals', 'value': 'yes'}],
                source='anomaly_detector_1',
                lane='documents',
            ),
            sink('sink_anomaly', 'response_documents', 'anomalies', source='gate_anomaly', lane='documents'),
        ],
    }


def _metric_docs(values: list[float]) -> bytes:
    return json.dumps(
        [
            {'page_content': f'reading {i}', 'metadata': {'objectId': 'obj', 'chunkId': i, 'value': v}}
            for i, v in enumerate(values)
        ]
    ).encode('utf-8')


async def test_anomaly_detector_routes_through_a_gate():
    values = [10, 12, 10, 12, 10, 12, 10, 12, 10, 1000]
    results, _, errors = await run_pipeline(anomaly_pipeline(), [('readings', _metric_docs(values), 'lane/documents')])
    assert not errors, errors
    assert _contents(results['readings'], 'anomalies') == ['reading 9']
    group = results['readings']['decisions']['anomaly_detector_1']
    assert group['writer'] == 'anomaly_detector' and len(group['items']) == 10


async def test_a_gate_value_typo_fails_the_run_loudly():
    with FakeSystemOne() as fake:
        pipeline = text_pipeline(fake.url)
        for component in pipeline['components']:
            if component['id'] == 'gate_spam':
                component['config']['conditions'] = [{'question': 'is_spam', 'op': 'equals', 'value': 'Yes'}]
        _, _, errors = await run_pipeline(pipeline, [('e01', EMAILS['e01'][0], 'text/plain')])
    assert 'is not an answer "is_spam" can have' in errors.get('e01', ''), errors
