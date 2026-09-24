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

"""
Shared task format for agent-to-agent tasking over LaserData.

Imported by the LaserData tool node (writes tasks, reads events) and the
Listener node's LaserData adapter (reads tasks, writes replies and events), so
writer and reader cannot drift. Pure Python: no laser-sdk import; SDK objects
are handled duck-typed.
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional

DEFAULT_STREAM = 'rocketride-memory'
EVENTS_TOPIC = 'agent.events'
MAX_WAIT_SECS = 120
_CLOUD_SUFFIX = '.laserdata.cloud'
_CLOUD_PORT = 8090
_AGENT_ID = re.compile(r'^[a-z0-9_-]{1,64}$')
_KINDS = ('task', 'reply')
_CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
_ULID = re.compile(r'^[0-9A-HJKMNP-TV-Z]{26}$')


def validate_agent_id(value: Any, *, field: str = 'agent_id') -> str:
    """Return the stripped id, or raise ValueError naming the field and the rule."""
    text = value.strip() if isinstance(value, str) else ''
    if not _AGENT_ID.match(text):
        raise ValueError(f'{field} must be 1-64 lowercase letters, digits, "-" or "_" (agent_id rule), got {value!r}')
    return text


def inbox_topic(agent_id: str) -> str:
    """Topic the agent's Listener consumes."""
    return f'agent.{agent_id}.inbox'


def replies_topic(agent_id: str) -> str:
    """Topic for inline-wait replies; no Listener reads it."""
    return f'agent.{agent_id}.replies'


def normalize_connection_string(value: Any) -> str:
    """Append :8090 to a *.laserdata.cloud host without a port; reject other hosts without one."""
    text = str(value or '').strip()
    if not text:
        return ''
    base, sep, query = text.partition('?')
    hostport = base.rsplit('@', 1)[-1]
    if ':' in hostport:
        return text
    if hostport.endswith(_CLOUD_SUFFIX):
        return f'{base}:{_CLOUD_PORT}{sep}{query}'
    raise ValueError(f'laserdata: connection string host "{hostport}" has no port; use host:port, e.g. {hostport}:8090')


@dataclass
class Envelope:
    """One task or reply record as carried on an inbox topic."""

    kind: str
    task_id: str
    conversation_id: str
    parent_task_id: Optional[str]
    sender: str
    to: str
    reply_to: str
    body: str
    sent_at: int


def _now_ms() -> int:
    return int(time.time() * 1000)


def new_id() -> str:
    """Mint a ULID (26 chars, Crockford base32, time-ordered).

    laser-sdk rejects a ``Provenance.conversation_id`` that is not a ULID, and
    a task's conversation id defaults to its task id, so both are ULIDs.
    """
    n = (_now_ms() << 80) | int.from_bytes(os.urandom(10), 'big')
    return ''.join(_CROCKFORD[(n >> (5 * i)) & 31] for i in range(25, -1, -1))


def _validate_ulid(value: str, *, field: str) -> str:
    """Return the upper-cased ULID, or raise ValueError naming the field."""
    text = str(value).strip().upper()
    if not _ULID.match(text):
        raise ValueError(f'{field} must be a 26-character ULID (e.g. one from a task label), got {value!r}')
    return text


def make_task(
    *,
    sender: str,
    to: str,
    body: str,
    inline: bool,
    conversation_id: Optional[str] = None,
    parent_task_id: Optional[str] = None,
) -> Envelope:
    """Build a new task envelope; inline tasks reply to the sender's replies topic."""
    sender = validate_agent_id(sender)
    to = validate_agent_id(to, field='to')
    if to == sender:
        raise ValueError(f'laserdata: an agent cannot send a task to itself ({sender!r})')
    task_id = new_id()
    return Envelope(
        kind='task',
        task_id=task_id,
        conversation_id=_validate_ulid(conversation_id, field='conversation_id') if conversation_id else task_id,
        parent_task_id=parent_task_id or None,
        sender=sender,
        to=to,
        reply_to=replies_topic(sender) if inline else inbox_topic(sender),
        body=body,
        sent_at=_now_ms(),
    )


def make_reply(task: Envelope, *, sender: str, body: str) -> Envelope:
    """Build the reply to ``task``, addressed back to its sender."""
    return Envelope(
        kind='reply',
        task_id=task.task_id,
        conversation_id=task.conversation_id,
        parent_task_id=task.parent_task_id,
        sender=sender,
        to=task.sender,
        reply_to=task.reply_to,
        body=body,
        sent_at=_now_ms(),
    )


def encode(env: Envelope) -> bytes:
    """Serialize an envelope as UTF-8 JSON bytes."""
    return json.dumps(asdict(env)).encode('utf-8')


def decode(data: Any) -> Envelope:
    """Parse a record dict into an Envelope, or raise ValueError for anything else."""
    if not isinstance(data, dict) or data.get('kind') not in _KINDS or not data.get('task_id'):
        raise ValueError(f'laserdata: record is not a tasking envelope: {str(data)[:200]!r}')
    try:
        return Envelope(**{f: data.get(f) for f in Envelope.__dataclass_fields__})
    except TypeError as exc:
        raise ValueError(f'laserdata: record is not a tasking envelope: {exc}') from None


def record_json(record: Any) -> Any:
    """Decode an SDK message/record body: ``.json()`` first, raw payload bytes as fallback."""
    try:
        return record.json()
    except Exception:
        return json.loads(bytes(record.payload).decode('utf-8'))


def provenance_kwargs(env: Envelope) -> Dict[str, str]:
    """Keyword arguments for ``laser_sdk.Provenance`` stamped on the task record."""
    return {
        'conversation_id': env.conversation_id,
        'agent': env.sender,
        'target_agent_id': env.to,
        'idempotency_key': f'{env.kind}:{env.task_id}',
    }


def label(env: Envelope) -> str:
    """Text handed to the receiving pipeline, so the agent can tell inputs apart."""
    if env.kind == 'reply':
        return f'[reply from {env.sender} for task {env.task_id} conversation {env.conversation_id}] {env.body}'
    return f'[task {env.task_id} conversation {env.conversation_id} from {env.sender}] {env.body}'


def event(kind: str, env: Envelope, *, agent: str, detail: str = '') -> Dict[str, Any]:
    """One record for the events topic."""
    return {
        'event': kind,
        'task_id': env.task_id,
        'conversation_id': env.conversation_id,
        'parent_task_id': env.parent_task_id,
        'sender': env.sender,
        'to': env.to,
        'agent': agent,
        'at': _now_ms(),
        'detail': detail,
    }


def _diff(a: Optional[int], b: Optional[int]) -> Optional[int]:
    return b - a if a is not None and b is not None else None


def build_timeline(
    events: List[Any], *, task_id: Optional[str] = None, conversation_id: Optional[str] = None
) -> Dict[str, Any]:
    """Fold events into per-task rows for one task or one whole conversation."""
    if not task_id and not conversation_id:
        raise ValueError('laserdata.trace: pass task_id or conversation_id')
    rows: Dict[str, Dict[str, Any]] = {}
    for ev in events:
        if not isinstance(ev, dict) or not ev.get('task_id') or not isinstance(ev.get('at'), int):
            continue
        if task_id and ev['task_id'] != task_id:
            continue
        if conversation_id and ev.get('conversation_id') != conversation_id:
            continue
        row = rows.setdefault(
            ev['task_id'],
            {
                'task_id': ev['task_id'],
                'conversation_id': ev.get('conversation_id'),
                'parent_task_id': ev.get('parent_task_id'),
                'from': ev.get('sender'),
                'to': ev.get('to'),
                'sent_at': None,
                'picked_up_at': None,
                'replied_at': None,
                'attempts': 0,
                '_last_pickup': None,
                '_last': None,
                'detail': '',
            },
        )
        kind, at = ev.get('event'), ev['at']
        if kind == 'sent':
            row['sent_at'] = at
        elif kind == 'picked_up':
            row['attempts'] += 1
            row['picked_up_at'] = at if row['picked_up_at'] is None else min(row['picked_up_at'], at)
            row['_last_pickup'] = at if row['_last_pickup'] is None else max(row['_last_pickup'], at)
        elif kind == 'replied':
            row['replied_at'] = at
        elif kind == 'failed':
            row['detail'] = ev.get('detail') or ''
        if kind in ('picked_up', 'replied', 'failed') and (row['_last'] is None or at >= row['_last'][1]):
            row['_last'] = (kind, at)
    out = []
    for row in rows.values():
        last = row.pop('_last')
        last_pickup = row.pop('_last_pickup')
        if row['replied_at'] is not None:
            row['status'] = 'done'
        elif last and last[0] == 'failed':
            row['status'] = 'failed'
        elif row['attempts']:
            row['status'] = 'in_progress'
        else:
            row['status'] = 'queued'
        row['queue_wait_ms'] = _diff(row['sent_at'], row['picked_up_at'])
        row['work_ms'] = _diff(last_pickup, row['replied_at'])
        row['end_to_end_ms'] = _diff(row['sent_at'], row['replied_at'])
        out.append(row)
    out.sort(key=lambda r: (r['sent_at'] is None, r['sent_at'] or 0))
    return {'task_id': task_id, 'conversation_id': conversation_id, 'tasks': out}
