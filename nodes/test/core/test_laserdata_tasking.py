# =============================================================================
# RocketRide Engine
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

"""Unit tests for nodes/src/nodes/core/laserdata_tasking.py (pure Python, no SDK)."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'core'))
import laserdata_tasking as t  # noqa: E402


def test_validate_agent_id_accepts_and_rejects():
    assert t.validate_agent_id(' risk-1 ') == 'risk-1'
    for bad in ('', 'Agent B', 'a' * 65, 'x.y', None):
        with pytest.raises(ValueError, match='agent_id'):
            t.validate_agent_id(bad)


def test_topic_names():
    assert t.inbox_topic('risk') == 'agent.risk.inbox'
    assert t.replies_topic('risk') == 'agent.risk.replies'


def test_normalize_adds_cloud_port():
    assert (
        t.normalize_connection_string('u:p@abc.us-west-1.aws.laserdata.cloud')
        == 'u:p@abc.us-west-1.aws.laserdata.cloud:8090'
    )


def test_normalize_keeps_explicit_port_and_query():
    assert t.normalize_connection_string('u:p@abc.laserdata.cloud:9000') == 'u:p@abc.laserdata.cloud:9000'
    assert t.normalize_connection_string('u:p@abc.laserdata.cloud?tls=true') == 'u:p@abc.laserdata.cloud:8090?tls=true'


def test_normalize_rejects_other_host_without_port():
    with pytest.raises(ValueError, match='port'):
        t.normalize_connection_string('iggy:iggy@localhost')


def test_normalize_blank_passthrough():
    assert t.normalize_connection_string('  ') == ''


def test_make_task_defaults_and_inline_reply_topic():
    env = t.make_task(sender='intake', to='risk', body='check', inline=False)
    assert env.kind == 'task' and env.conversation_id == env.task_id
    assert env.reply_to == 'agent.intake.inbox'
    conv = t.new_id()
    inline = t.make_task(sender='intake', to='risk', body='check', inline=True, conversation_id=conv)
    assert inline.reply_to == 'agent.intake.replies' and inline.conversation_id == conv


def test_make_task_mints_ulid_ids():
    # laser-sdk 0.0.2 rejects a non-ULID Provenance.conversation_id ("invalid ULID"),
    # and conversation_id defaults to task_id, so ids are minted as ULIDs.
    env = t.make_task(sender='intake', to='risk', body='check', inline=False)
    assert re.fullmatch(r'[0-9A-HJKMNP-TV-Z]{26}', env.task_id)
    later = t.new_id()
    assert later > env.task_id or later[:10] == env.task_id[:10]  # time-ordered prefix


def test_make_task_rejects_non_ulid_conversation_id():
    with pytest.raises(ValueError, match='conversation_id'):
        t.make_task(sender='intake', to='risk', body='x', inline=False, conversation_id='conv-1')
    lower = t.new_id().lower()
    assert (
        t.make_task(sender='intake', to='risk', body='x', inline=False, conversation_id=lower).conversation_id
        == lower.upper()
    )


def test_make_task_rejects_self_and_bad_ids():
    with pytest.raises(ValueError, match='itself'):
        t.make_task(sender='risk', to='risk', body='x', inline=False)
    with pytest.raises(ValueError, match='to'):
        t.make_task(sender='risk', to='Risk Desk', body='x', inline=False)


def test_encode_decode_round_trip():
    env = t.make_task(sender='a', to='b', body='hi', inline=False, parent_task_id='p1')
    assert t.decode(json.loads(t.encode(env))) == env


def test_decode_rejects_foreign_records():
    for bad in ({}, {'kind': 'task'}, {'kind': 'other', 'task_id': 'x'}, 'text', None):
        with pytest.raises(ValueError, match='not a tasking envelope'):
            t.decode(bad)


def test_make_reply_keeps_ids_and_routes_back():
    task = t.make_task(sender='a', to='b', body='q', inline=False)
    reply = t.make_reply(task, sender='b', body='answer')
    assert (reply.kind, reply.task_id, reply.conversation_id, reply.to, reply.body) == (
        'reply',
        task.task_id,
        task.conversation_id,
        'a',
        'answer',
    )


def test_record_json_prefers_json_then_payload():
    assert t.record_json(SimpleNamespace(json=lambda: {'a': 1})) == {'a': 1}

    def boom():
        raise ValueError('no json')

    assert t.record_json(SimpleNamespace(json=boom, payload=list(b'{"b": 2}'))) == {'b': 2}


def test_provenance_kwargs():
    env = t.make_task(sender='a', to='b', body='q', inline=False)
    kw = t.provenance_kwargs(env)
    assert kw == {
        'conversation_id': env.conversation_id,
        'agent': 'a',
        'target_agent_id': 'b',
        'idempotency_key': f'task:{env.task_id}',
    }


def test_label_task_and_reply():
    task = t.make_task(sender='a', to='b', body='refund 42', inline=False)
    assert t.label(task) == f'[task {task.task_id} conversation {task.conversation_id} from a] refund 42'
    reply = t.make_reply(task, sender='b', body='ok')
    assert t.label(reply) == f'[reply from b for task {task.task_id} conversation {task.conversation_id}] ok'


def _events(task, *kinds_at):
    return [dict(t.event(k, task, agent='x'), at=at) for k, at in kinds_at]


def test_timeline_done_with_durations():
    task = t.make_task(sender='a', to='b', body='q', inline=False)
    tl = t.build_timeline(_events(task, ('sent', 1000), ('picked_up', 4000), ('replied', 4500)), task_id=task.task_id)
    row = tl['tasks'][0]
    assert (row['status'], row['queue_wait_ms'], row['work_ms'], row['end_to_end_ms'], row['attempts']) == (
        'done',
        3000,
        500,
        3500,
        1,
    )


def test_timeline_counts_redelivery_as_attempts():
    task = t.make_task(sender='a', to='b', body='q', inline=False)
    ev = _events(task, ('sent', 0), ('picked_up', 10), ('picked_up', 900), ('replied', 1000))
    row = t.build_timeline(ev, task_id=task.task_id)['tasks'][0]
    assert (row['status'], row['attempts'], row['queue_wait_ms'], row['work_ms']) == ('done', 2, 10, 100)
    assert len(t.build_timeline(ev, task_id=task.task_id)['tasks']) == 1


def test_timeline_statuses():
    task = t.make_task(sender='a', to='b', body='q', inline=False)
    assert t.build_timeline(_events(task, ('sent', 0)), task_id=task.task_id)['tasks'][0]['status'] == 'queued'
    assert (
        t.build_timeline(_events(task, ('sent', 0), ('picked_up', 5)), task_id=task.task_id)['tasks'][0]['status']
        == 'in_progress'
    )
    assert (
        t.build_timeline(_events(task, ('sent', 0), ('picked_up', 5), ('failed', 6)), task_id=task.task_id)['tasks'][0][
            'status'
        ]
        == 'failed'
    )


def test_timeline_by_conversation_spans_hops_in_send_order():
    first = t.make_task(sender='intake', to='risk', body='q', inline=False)
    second = t.make_task(
        sender='risk',
        to='payment',
        body='pay',
        inline=False,
        conversation_id=first.conversation_id,
        parent_task_id=first.task_id,
    )
    other = t.make_task(sender='x', to='y', body='z', inline=False)
    ev = _events(second, ('sent', 50)) + _events(first, ('sent', 10)) + _events(other, ('sent', 20))
    tl = t.build_timeline(ev, conversation_id=first.conversation_id)
    assert [r['task_id'] for r in tl['tasks']] == [first.task_id, second.task_id]
    assert tl['tasks'][1]['parent_task_id'] == first.task_id


def test_timeline_requires_a_key_and_skips_junk():
    with pytest.raises(ValueError, match='task_id or conversation_id'):
        t.build_timeline([])
    assert t.build_timeline([None, 'x', {'event': 'sent'}], task_id='nope') == {
        'task_id': 'nope',
        'conversation_id': None,
        'tasks': [],
    }
