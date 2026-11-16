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
Supabase Messaging tools: Realtime broadcast and Queues.

* ``broadcast`` posts to the Realtime REST endpoint
  (``POST /realtime/v1/api/broadcast``), which needs no websocket.
* The queue tools call the ``pgmq_public`` wrapper functions (``send``,
  ``read``, ``pop``, ``archive``, ``delete``) through supabase-py's RPC on the
  ``pgmq_public`` schema. That schema exists only after the project owner
  turns on "Expose Queues via PostgREST"; a missing schema is reported with
  that instruction instead of PostgREST's raw error.

Every queue tool needs the write level, including ``queue_read``: reading a
message hides it from other readers for the visibility timeout, so it changes
what other workers see.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

from ai.common.utils import optional_bool, optional_int, require_int, require_str
from rocketlib import tool_function

from .. import supabase_client as sc
from ..IInstance import WRITE, SupabaseInstanceBase, requires_access
from .IGlobal import IGlobal

QUEUE_SCHEMA = 'pgmq_public'
BROADCAST_PATH = '/realtime/v1/api/broadcast'

# pgmq builds table names from the queue name (q_<name>, a_<name>) and refuses
# names of 48 characters or more; the dashboard allows letters, digits, '_' and '-'.
_QUEUE_NAME = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_-]{0,46}$')
_MAX_NAME_LEN = 255  # channel and event names

DEFAULT_READ_COUNT = 1
DEFAULT_VISIBILITY_SECONDS = 30

EXPOSE_QUEUES_HINT = (
    'Queues are not reachable through the API: the pgmq_public schema is not exposed. '
    "In the Supabase dashboard open Integrations -> Queues -> Settings and turn on 'Expose Queues via PostgREST' "
    '(self-hosted Supabase: add pgmq_public to the exposed schemas).'
)

_QUEUE_PROPERTY = {
    'type': 'string',
    'description': 'Queue name as created in Integrations -> Queues (letters, digits, "_" or "-", at most 47 characters).',
}
_MESSAGE_ID_PROPERTY = {'type': 'integer', 'minimum': 1, 'description': 'msg_id returned by queue_send or queue_read.'}
_MESSAGE_RECORD = {
    'type': 'object',
    'properties': {
        'msg_id': {'type': 'integer'},
        'read_ct': {'type': 'integer', 'description': 'How many times the message has been read.'},
        'enqueued_at': {'type': 'string'},
        'vt': {'type': 'string', 'description': 'Time the message becomes visible to readers again.'},
        'message': {'description': 'The message body (JSON).'},
    },
}
# queue_read leaves an oversized body out (see _bounded_message); queue_pop cannot, the message is gone.
_READ_MESSAGE_RECORD = {
    'type': 'object',
    'properties': {
        **_MESSAGE_RECORD['properties'],
        'message': {'description': "The message body (JSON). Null when it is above the node's Max payload size."},
        'message_bytes': {'type': 'integer', 'description': 'Size of the omitted body (only when message_omitted).'},
        'message_omitted': {
            'type': 'boolean',
            'description': "True when the body was above the node's Max payload size and is not returned.",
        },
    },
}


class IInstance(SupabaseInstanceBase):
    """Agent tools for Supabase Realtime broadcast and Queues."""

    IGlobal: IGlobal

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _queue_arg(self, args: Dict[str, Any], tool_name: str) -> str:
        """Required queue name, in the form pgmq accepts."""
        name = require_str(args, 'queue', tool_name=tool_name)
        if not _QUEUE_NAME.fullmatch(name):
            raise ValueError(
                f'{tool_name}: "queue" must be 1 to 47 letters, digits, "_" or "-" '
                f'(the name shown in Integrations -> Queues), got {name!r}'
            )
        return name

    def _check_size(self, value: Any, key: str, tool_name: str) -> None:
        """Refuse a payload above the configured size before it is sent."""
        self._check_json_size(
            value, key, tool_name=tool_name, limit_kb=self.IGlobal.max_payload_kb, setting='Max payload size'
        )

    def _bounded_message(self, record: Any) -> Any:
        """Return a read message, without its body when the body is above Max payload size.

        queue_send refuses such bodies, but other producers can write any size
        into pgmq. Returning them would push megabytes into the agent's
        context; the msg_id stays so the agent can archive or delete it.
        """
        if not isinstance(record, dict) or 'message' not in record:
            return record
        size = self._json_size(record['message'])
        if size <= self.IGlobal.max_payload_kb * 1024:
            return record
        return {**record, 'message': None, 'message_bytes': size, 'message_omitted': True}

    def _rpc(self, function: str, params: Dict[str, Any]) -> Any:
        """Call pgmq_public.<function> and translate the setup errors a user can fix."""
        queue = params.get('queue_name', '')
        try:
            return self._client().schema(QUEUE_SCHEMA).rpc(function, params).execute().data
        except Exception as e:
            mapped = _queue_error(e, function, queue)
            if mapped is None:
                raise
            raise mapped from None

    # ------------------------------------------------------------------
    # Realtime
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'channel': {
                    'type': 'string',
                    'description': 'Realtime channel (topic) name the clients subscribed to, e.g. "room-1".',
                },
                'event': {'type': 'string', 'description': 'Event name the clients listen for, e.g. "new-order".'},
                'payload': {'type': 'object', 'description': 'JSON object delivered to subscribers. Default {}.'},
                'private': {
                    'type': 'boolean',
                    'description': 'Send on a private channel (clients need Realtime authorization). Default false.',
                },
            },
            'required': ['channel', 'event'],
        },
        output_schema={
            'type': 'object',
            'properties': {
                'ok': {'type': 'boolean'},
                'channel': {'type': 'string'},
                'event': {'type': 'string'},
                'private': {'type': 'boolean'},
            },
        },
        description=(
            'Send one Supabase Realtime broadcast message to everyone subscribed to a channel. '
            'Arguments: channel, event, payload (JSON object, optional), private (optional, default false). '
            'Needs the write access level. Returns ok, channel, event and private once Supabase accepts the '
            "message; it does not confirm that any client received it. The payload is limited by the node's "
            'Max payload size.'
        ),
    )
    @requires_access(WRITE)
    def broadcast(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Post one message to a Realtime channel through the REST endpoint."""
        tool = self._tool('broadcast')
        channel = self._bounded_str(args, 'channel', tool_name=tool, max_len=_MAX_NAME_LEN)
        event = self._bounded_str(args, 'event', tool_name=tool, max_len=_MAX_NAME_LEN)
        payload = self._dict_arg(args, 'payload', default={}, tool_name=tool)
        private = optional_bool(args, 'private', default=False, tool_name=tool)
        self._check_size(payload, 'payload', tool)
        message = {'topic': channel, 'event': event, 'payload': payload, 'private': private}
        # Realtime answers 202 Accepted with an empty body; 4xx/5xx raise SupabaseError.
        self._api().request('POST', BROADCAST_PATH, json={'messages': [message]}, what='Realtime broadcast')
        return {'ok': True, 'channel': channel, 'event': event, 'private': private}

    # ------------------------------------------------------------------
    # Queues
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'queue': _QUEUE_PROPERTY,
                'message': {'description': 'Message body: any JSON value, usually an object.'},
                'delay_seconds': {
                    'type': 'integer',
                    'minimum': 0,
                    'description': (
                        "Seconds before the message becomes readable. Default 0; at most the node's Max delay. "
                        'A larger value is refused (not lowered): a shorter delay would deliver the message early.'
                    ),
                },
            },
            'required': ['queue', 'message'],
        },
        output_schema={
            'type': 'object',
            'properties': {'queue': {'type': 'string'}, 'message_id': {'type': 'integer'}},
        },
        description=(
            'Add a message to a Supabase queue (pgmq). Arguments: queue, message (JSON), delay_seconds (optional). '
            "Needs the write access level. Returns queue and message_id. The message is limited by the node's "
            "Max payload size. A delay_seconds above the node's Max delay is refused (not lowered), because a "
            'shorter delay would deliver the message early.'
        ),
    )
    @requires_access(WRITE)
    def queue_send(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Send one message to a queue (pgmq_public.send)."""
        tool = self._tool('queue_send')
        queue = self._queue_arg(args, tool)
        if args.get('message') is None:
            raise ValueError(f'{tool}: "message" is required (any JSON value)')
        message = args['message']
        self._check_size(message, 'message', tool)
        # Refused, not lowered: a shorter delay would deliver the message earlier than asked.
        delay = optional_int(args, 'delay_seconds', default=0, lo=0, hi=self.IGlobal.max_delay_seconds, tool_name=tool)
        data = self._rpc('send', {'queue_name': queue, 'message': message, 'sleep_seconds': delay})
        return {'queue': queue, 'message_id': _first_scalar(data)}

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'queue': _QUEUE_PROPERTY,
                'count': {
                    'type': 'integer',
                    'minimum': 1,
                    'description': "How many messages to read. Default 1; capped at the node's Max messages per read.",
                },
                'visibility_seconds': {
                    'type': 'integer',
                    'minimum': 0,
                    'description': (
                        "Seconds the messages stay hidden from other readers. Default 30; at most the node's "
                        'Max visibility timeout. A larger value is refused (not lowered): a shorter timeout would '
                        'hand the messages to other readers. Delete or archive a message before then, or it is '
                        'delivered again.'
                    ),
                },
            },
            'required': ['queue'],
        },
        output_schema={
            'type': 'object',
            'properties': {
                'queue': {'type': 'string'},
                'messages': {'type': 'array', 'items': _READ_MESSAGE_RECORD},
                'count': {'type': 'integer'},
                'count_capped_to': {
                    'type': 'integer',
                    'description': 'Present when the requested count was above the cap.',
                },
            },
        },
        description=(
            'Read messages from a Supabase queue (pgmq) without removing them. Read messages are hidden from '
            'other readers for visibility_seconds, then delivered again unless you call queue_delete or '
            'queue_archive. Arguments: queue, count (optional, default 1), visibility_seconds (optional, default 30). '
            'Needs the write access level (reading hides messages from other readers). Returns queue, messages '
            "(msg_id, read_ct, enqueued_at, vt, message) and count; count is capped at the node's Max messages per "
            "read and count_capped_to is set when it was lowered. A visibility_seconds above the node's Max "
            'visibility timeout is refused (not lowered), because a shorter timeout would hand the messages to other '
            "readers. A message body larger than the node's Max payload size is not returned: its message is null, "
            'message_bytes gives its size and message_omitted is true; use its msg_id to archive or delete it. '
            'An empty list means the queue has no visible messages.'
        ),
    )
    @requires_access(WRITE)
    def queue_read(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Read up to count messages and hide them for visibility_seconds (pgmq_public.read)."""
        tool = self._tool('queue_read')
        queue = self._queue_arg(args, tool)
        cap = self.IGlobal.max_read_count
        requested = optional_int(args, 'count', default=DEFAULT_READ_COUNT, lo=1, tool_name=tool)
        # A count above the cap is clamped (page-size style) and the answer says so.
        count = min(requested, cap)
        max_vt = self.IGlobal.max_visibility_seconds
        # Refused, not lowered: a shorter visibility timeout would hand the
        # messages to other readers while this caller still works on them.
        visibility = optional_int(
            args,
            'visibility_seconds',
            default=min(DEFAULT_VISIBILITY_SECONDS, max_vt),
            lo=0,
            hi=max_vt,
            tool_name=tool,
        )
        data = self._rpc('read', {'queue_name': queue, 'sleep_seconds': visibility, 'n': count})
        # Queue bodies are the user's own data, returned as stored (like a file
        # from Storage). Only the configured secret key is masked, by the decorator.
        messages = [self._bounded_message(m) for m in sc.to_plain(_as_list(data))]
        out: Dict[str, Any] = {'queue': queue, 'messages': messages, 'count': len(messages)}
        if requested > count:
            out['count_capped_to'] = count
        return out

    @tool_function(
        input_schema={'type': 'object', 'properties': {'queue': _QUEUE_PROPERTY}, 'required': ['queue']},
        output_schema={'type': 'object', 'properties': {'queue': {'type': 'string'}, 'message': _MESSAGE_RECORD}},
        description=(
            'Take the next message off a Supabase queue (pgmq) and delete it in the same step. Use it when the '
            'work does not need a retry if it fails. Arguments: queue. Needs the write access level. Returns queue '
            'and message (msg_id, read_ct, enqueued_at, vt, message), or message null when the queue is empty.'
        ),
    )
    @requires_access(WRITE)
    def queue_pop(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Read and delete the next message in one step (pgmq_public.pop)."""
        queue = self._queue_arg(args, self._tool('queue_pop'))
        rows = _as_list(self._rpc('pop', {'queue_name': queue}))
        # The body is returned whole even above Max payload size: pop has
        # already deleted the message, so leaving the body out would lose it.
        return {'queue': queue, 'message': sc.to_plain(rows[0]) if rows else None}

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {'queue': _QUEUE_PROPERTY, 'message_id': _MESSAGE_ID_PROPERTY},
            'required': ['queue', 'message_id'],
        },
        output_schema={
            'type': 'object',
            'properties': {'queue': {'type': 'string'}, 'message_id': {'type': 'integer'}, 'ok': {'type': 'boolean'}},
        },
        description=(
            'Move a message from a Supabase queue (pgmq) to its archive table, so it is kept but never delivered '
            'again. Arguments: queue, message_id. Needs the write access level. Returns queue, message_id and ok '
            '(false when no message with that id is in the queue).'
        ),
    )
    @requires_access(WRITE)
    def queue_archive(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Move a message to the queue's archive table (pgmq_public.archive)."""
        return self._remove(args, 'archive', tool_name=self._tool('queue_archive'))

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {'queue': _QUEUE_PROPERTY, 'message_id': _MESSAGE_ID_PROPERTY},
            'required': ['queue', 'message_id'],
        },
        output_schema={
            'type': 'object',
            'properties': {'queue': {'type': 'string'}, 'message_id': {'type': 'integer'}, 'ok': {'type': 'boolean'}},
        },
        description=(
            'Delete a message from a Supabase queue (pgmq) for good, usually after the work it describes is done. '
            'Arguments: queue, message_id. Needs the write access level. Returns queue, message_id and ok '
            '(false when no message with that id is in the queue).'
        ),
    )
    @requires_access(WRITE)
    def queue_delete(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Delete a message for good (pgmq_public.delete)."""
        return self._remove(args, 'delete', tool_name=self._tool('queue_delete'))

    def _remove(self, args: Dict[str, Any], function: str, *, tool_name: str) -> Dict[str, Any]:
        """Archive or delete one message by id (pgmq_public.archive / delete)."""
        queue = self._queue_arg(args, tool_name)
        message_id = require_int(args, 'message_id', lo=1, tool_name=tool_name)
        data = self._rpc(function, {'queue_name': queue, 'message_id': message_id})
        return {'queue': queue, 'message_id': message_id, 'ok': _first_scalar(data) is True}


# =============================================================================
# Result and error shaping
# =============================================================================


def _as_list(data: Any) -> List[Any]:
    """PostgREST returns a set-returning function as a list; a single row may come back bare."""
    if data is None:
        return []
    return list(data) if isinstance(data, list) else [data]


def _first_scalar(data: Any) -> Any:
    """First value of a scalar-returning RPC (``send`` -> [id], ``delete`` -> true)."""
    rows = _as_list(data)
    return rows[0] if rows else None


def _queue_error(exc: BaseException, function: str, queue: str) -> Any:
    """Return a SupabaseError for the queue setup problems a user can fix, else None.

    PostgREST errors (postgrest.APIError) carry ``code`` and ``message``:
    PGRST106 = schema not exposed, PGRST202 = function not in the schema
    cache, 42501 = permission denied, 42P01 = table (queue) does not exist.
    """
    code = str(getattr(exc, 'code', '') or '')
    message = getattr(exc, 'message', None)
    text = (message if isinstance(message, str) else str(exc)).lower()
    if code == 'PGRST106' or ('invalid schema' in text and QUEUE_SCHEMA in text):
        return sc.SupabaseError(EXPOSE_QUEUES_HINT, status=406)
    if code == 'PGRST202':
        return sc.SupabaseError(
            f'The function {QUEUE_SCHEMA}.{function} was not found. {EXPOSE_QUEUES_HINT}', status=404
        )
    if code == '42501':
        return sc.SupabaseError(
            f'Permission denied on queue {queue!r}. Open the queue in Integrations -> Queues, then its '
            'settings, and give the service_role role Select, Insert, Update and Delete.',
            status=403,
        )
    if code == '42P01':
        return sc.SupabaseError(
            f'Queue {queue!r} does not exist. Create it in Integrations -> Queues (Create queue).', status=404
        )
    return None
