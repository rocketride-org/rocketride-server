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

"""The protocol-1 edge translator: the wire spellings a 1.x SDK still uses.

A connection that logged in without ``protocol`` speaks protocol 1 (plan 11.3).
It differs from protocol 2 only in how one field is spelled. Read against the
1.6 SDKs, the slot of a pipe is ``pipe_id`` there and ``pipeId`` here in three
places, and ``WIRE_FIELDS`` lists them: the message kind, the name the server
uses, the name the 1.x client uses.

1. The arguments of the data operations ``write``, ``close`` and ``tool``.
2. The body of the ``open`` response.
3. The body of an SSE event. The same events are also read back from the run
   log, so ``WIRE_CARRIERS`` lists where stored events ride inside a response.

The ``set_events`` pipe filter is ``pipeId`` in a 1.6 SDK already, and a flow
event names its slot ``id`` in both generations, so neither is translated.

- ``decode`` runs on a message the client sent. It RENAMES the old name to the
  new one, so every handler reads one spelling.
- ``encode`` runs on a message the server sends. It ADDS the old name beside
  the new one and never renames, so a reader of either generation finds the
  field it looks for.

Both functions are pure: they return the message they were given when nothing
applies, and a copy otherwise. An event body is shared by every connection it
fans out to, so it is never changed in place.

This module imports nothing from the server. ``TaskConn`` is its only caller:
``on_receive`` runs ``decode`` and ``send`` runs ``encode`` on a protocol-1
connection, and nothing below the connection knows protocol 1 exists.
"""

import json
from typing import Any, Dict, List, Optional, Tuple

# ==== The tables =================================================================

# (message kind, new name, old name). A kind is ``<type>:<name>``: the DAP
# message type, then the command of a request or response, or the event name
# of an event. The fields of a request are its ``arguments``; the fields of a
# response or an event are its ``body``.
WIRE_FIELDS: Tuple[Tuple[str, str, str], ...] = (
    # Data operations: the slot named by write, close and tool
    ('request:rrext_process', 'pipeId', 'pipe_id'),
    # Data operations: the slot the open response answers with
    ('response:rrext_process', 'pipeId', 'pipe_id'),
    # A node's real-time message, addressed to the slot that produced it
    ('event:apaevt_sse', 'pipeId', 'pipe_id'),
)

# (message kind, body key, form). Where whole messages ride inside the body of
# another message; each carried message is encoded by the ``WIRE_FIELDS`` rows
# of its own kind. Form ``list`` is a list of messages; form ``jsonl`` is text
# holding one JSON message per line.
WIRE_CARRIERS: Tuple[Tuple[str, str, str], ...] = (
    # Run log, the read subcommand: a page of stored events
    ('response:rrext_log', 'events', 'list'),
    # Run log, the segment subcommand: a chunk of a stored segment
    ('response:rrext_log', 'data', 'jsonl'),
)

# The event names with a row of their own, quoted as they appear in a stored
# line. A line naming none of them is passed on without being parsed.
_CARRIED_EVENTS: Tuple[str, ...] = tuple(
    json.dumps(kind.split(':', 1)[1]) for kind, _new, _old in WIRE_FIELDS if kind.startswith('event:')
)

# ==== Helpers ====================================================================


def _kind(message: Dict[str, Any]) -> str:
    """
    Name a message the way ``WIRE_FIELDS`` does.

    Args:
        message: A DAP message.

    Returns:
        str: ``<type>:<command>`` for a request or response, ``<type>:<event>``
        for an event.
    """
    message_type = message.get('type', '')
    name = message.get('event', '') if message_type == 'event' else message.get('command', '')
    return f'{message_type}:{name}'


def _add_old_names(message: Any) -> Any:
    """
    Add the old names beside the new ones in one message's own body.

    Args:
        message: A DAP response or event; anything else is returned as it came.

    Returns:
        Any: The same object when no listed field is present, otherwise a copy
        of the message whose ``body`` carries both names.
    """
    if not isinstance(message, dict):
        return message
    body = message.get('body')
    if message.get('type') not in ('response', 'event') or not isinstance(body, dict):
        return message

    kind = _kind(message)
    added = None
    for row_kind, new_name, old_name in WIRE_FIELDS:
        if row_kind != kind or new_name not in body or old_name in body:
            continue
        if added is None:
            added = dict(body)
        added[old_name] = body[new_name]

    if added is None:
        return message
    return {**message, 'body': added}


def _encode_list(messages: Any) -> Optional[List[Any]]:
    """
    Encode a list of carried messages.

    Args:
        messages: The value of a ``list`` carrier.

    Returns:
        Optional[List[Any]]: A new list when a message in it changed, else None.
    """
    if not isinstance(messages, list):
        return None
    encoded = [_add_old_names(message) for message in messages]
    if all(new is old for new, old in zip(encoded, messages)):
        return None
    return encoded


def _encode_jsonl(text: Any) -> Optional[str]:
    """
    Encode text that carries one JSON message per line.

    Only a line that names a listed event is parsed, and only a line that
    changed is written again, in the compact form the run log stores. Every
    other line is passed on exactly as it was.

    Args:
        text: The value of a ``jsonl`` carrier.

    Returns:
        Optional[str]: The new text when a line in it changed, else None.
    """
    if not isinstance(text, str) or not any(name in text for name in _CARRIED_EVENTS):
        return None

    lines = text.split('\n')
    changed = False
    for index, line in enumerate(lines):
        if not any(name in line for name in _CARRIED_EVENTS):
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        encoded = _add_old_names(message)
        if encoded is not message:
            lines[index] = json.dumps(encoded, separators=(',', ':'))
            changed = True

    return '\n'.join(lines) if changed else None


_CARRIER_FORMS = {'list': _encode_list, 'jsonl': _encode_jsonl}


# ==== The codec ==================================================================


def decode(request: Dict[str, Any]) -> Dict[str, Any]:
    """
    Rename the protocol-1 spellings in a request to the server's own.

    A request that already carries the new name keeps its value and loses the
    old name, so a handler never sees both.

    Args:
        request: A DAP message received from a protocol-1 client.

    Returns:
        Dict[str, Any]: The same message when it holds no old name, otherwise a
        copy whose ``arguments`` use the new names.
    """
    arguments = request.get('arguments')
    if request.get('type') != 'request' or not isinstance(arguments, dict):
        return request

    kind = _kind(request)
    renamed = None
    for row_kind, new_name, old_name in WIRE_FIELDS:
        if row_kind != kind or old_name not in arguments:
            continue
        if renamed is None:
            renamed = dict(arguments)
        value = renamed.pop(old_name)
        renamed.setdefault(new_name, value)

    if renamed is None:
        return request
    return {**request, 'arguments': renamed}


def encode(message: Dict[str, Any]) -> Dict[str, Any]:
    """
    Add the protocol-1 spellings beside the server's own in an outbound message.

    The new name stays: only a missing old name is added. That is done for the
    message's own body (``WIRE_FIELDS``) and for each message its body carries
    (``WIRE_CARRIERS``). Nothing handed in is changed: a carried list, a carried
    message and its body are each copied when, and only when, they change.

    Args:
        message: A DAP response or event about to be sent to a protocol-1 client.

    Returns:
        Dict[str, Any]: The same message when no listed field is present,
        otherwise a copy whose ``body`` carries both names.
    """
    encoded = _add_old_names(message)
    body = encoded.get('body')
    if encoded.get('type') not in ('response', 'event') or not isinstance(body, dict):
        return encoded

    kind = _kind(encoded)
    carried = None
    for row_kind, key, form in WIRE_CARRIERS:
        if row_kind != kind or key not in body:
            continue
        value = _CARRIER_FORMS[form](body[key])
        if value is None:
            continue
        if carried is None:
            carried = dict(body)
        carried[key] = value

    if carried is None:
        return encoded
    return {**encoded, 'body': carried}
