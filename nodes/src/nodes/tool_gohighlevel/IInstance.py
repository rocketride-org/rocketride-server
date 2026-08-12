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
GoHighLevel tool node instance.

Composes one mixin per GoHighLevel resource group, publishes only the tools the
operator enabled, and adds the generic ``request`` escape hatch that reaches any
v2 endpoint the typed tools do not model.

Publication is filtered twice here, in one pass. The group stamp decides which
resource areas an agent sees at all, and the write stamp removes the tools a
read-only node could never run. Both are stamped by ``@gohighlevel_tool``, so
there is no registry to keep in sync with the tool definitions.
"""

from __future__ import annotations

import posixpath
import re

from typing import Callable

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import require_str

from .gohighlevel_client import redact_payload
from .IGlobal import IGlobal
from .tool_groups import RAW_REQUEST_TOOL
from .tools._base import OBJ
from .tools import (
    AppointmentNotesMixin,
    AppointmentsMixin,
    BusinessesMixin,
    CalendarGroupsMixin,
    CalendarsMixin,
    ContactNotesMixin,
    ContactTasksMixin,
    ContactsMixin,
    ConversationsMixin,
    CustomFieldsMixin,
    CustomValuesMixin,
    LocationTagsMixin,
    LocationsMixin,
    MessagesMixin,
    OpportunitiesMixin,
    PipelinesMixin,
    UsersMixin,
)

#: Methods the ``request`` tool accepts without write permission.
#:
#: GET only, deliberately narrower than the conventional safe set. The read-only config
#: field tells the operator that the request tool accepts GET in that mode, and HEAD is
#: not documented on a single GoHighLevel operation, so there is nothing to gain by
#: quietly widening the promise.
_SAFE_METHODS = {'GET'}
_ALLOWED_METHODS = {'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'}


class IInstance(
    AppointmentNotesMixin,
    AppointmentsMixin,
    BusinessesMixin,
    CalendarGroupsMixin,
    CalendarsMixin,
    ContactNotesMixin,
    ContactTasksMixin,
    ContactsMixin,
    ConversationsMixin,
    CustomFieldsMixin,
    CustomValuesMixin,
    LocationTagsMixin,
    LocationsMixin,
    MessagesMixin,
    OpportunitiesMixin,
    PipelinesMixin,
    UsersMixin,
    IInstanceBase,
):
    IGlobal: IGlobal

    # -----------------------------------------------------------------------
    # Tool publication
    # -----------------------------------------------------------------------

    def _collect_tool_methods(self) -> dict[str, Callable]:
        """Publish only the tools this node's configuration allows an agent to run.

        The base implementation returns every ``@tool_function`` on the class, which for
        full GoHighLevel coverage is far more than an agent can choose between. Two filters
        run here, and both cover ``tool.query`` (the agent never sees the tool) as well as
        ``tool.invoke`` (calling it anyway is refused):

        1. The resource group, against ``gohighlevel.toolGroups``.
        2. The write stamp, when ``gohighlevel.readOnly`` is on. This is a deliberate
           deviation from tool_pipedrive, which publishes its write tools in read-only mode
           and refuses them at invoke time. An agent cannot tell in advance that a published
           tool is blocked, so it spends a turn finding out, and roughly 40 tools it can only
           ever fail on are 40 tools' worth of wasted context.
           ``GoHighLevelToolsBase._require_write`` still guards invoke, both as defence in
           depth and because the raw ``request`` tool carries no stamp at all.
        """
        methods = super()._collect_tool_methods()
        enabled = self.IGlobal.tool_groups
        allow_raw = self.IGlobal.allow_raw_request
        read_only = self.IGlobal.read_only

        published: dict[str, Callable] = {}
        for name, method in methods.items():
            if name == RAW_REQUEST_TOOL:
                # Gated by its own config switch rather than by a group. It stays published
                # in read-only mode because it is still a working read tool there.
                if allow_raw:
                    published[name] = method
                continue
            declared = getattr(type(self), name, None)
            group = getattr(declared, '__gohighlevel_group__', None)
            if group is not None and group not in enabled:
                continue
            if read_only and getattr(declared, '__gohighlevel_writes__', False):
                continue
            published[name] = method
        return published

    # -----------------------------------------------------------------------
    # Escape hatch
    # -----------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['method', 'path'],
            'properties': {
                'method': {
                    'type': 'string',
                    'enum': sorted(_ALLOWED_METHODS),
                    'description': 'HTTP method. In read-only mode only GET is permitted.',
                },
                'path': {
                    'type': 'string',
                    'description': (
                        'Path relative to the API root, starting with a slash: for example "/contacts/", '
                        '"/opportunities/pipelines" or "/locations/<locationId>/customValues". Do not include '
                        'the host. A trailing slash is load-bearing on several endpoints, and so is casing: '
                        'GoHighLevel answers a mis-cased path with 401 rather than 404, so copy the path from '
                        'the API reference exactly.'
                    ),
                },
                'params': {
                    'type': 'object',
                    'description': (
                        'Query-string parameters. The sub-account id is not added for you here: most endpoints '
                        'want it as locationId, and GET /opportunities/search spells it location_id.'
                    ),
                },
                'body': {
                    'type': 'object',
                    'description': (
                        'JSON request body for POST, PUT and PATCH, and for the few DELETE endpoints that require one.'
                    ),
                },
                'version': {
                    'type': 'string',
                    'description': (
                        'Value for the Version header, which every GoHighLevel operation requires. It defaults '
                        'to the value derived from the path, which is 2021-04-15 for /calendars and '
                        '/conversations and 2021-07-28 for everything else. Set it only when the endpoint you '
                        'are calling documents a different value.'
                    ),
                },
            },
        },
        description=(
            'Call any GoHighLevel v2 endpoint at https://services.leadconnectorhq.com directly, by method and '
            'path. Use this only for endpoints that have no dedicated tool here: the typed tools validate their '
            'input, put the sub-account id wherever the endpoint wants it and return a compact result, while '
            'this one sends what you give it and returns the raw response body. The Authorization and Version '
            'headers are added automatically, so do not pass them. Rate-limit retries and read-only enforcement '
            'apply here too.'
        ),
        output_schema=OBJ(
            'The raw GoHighLevel response body, exactly as the endpoint returned it. Unlike the typed tools '
            'this is not projected through a key allowlist, so the shape is whatever that endpoint documents.'
        ),
    )
    def request(self, args):
        """Call any GoHighLevel v2 endpoint directly."""
        args = self._args(args, 'request')
        method = require_str(args, 'method', tool_name='request').upper()
        path = require_str(args, 'path', tool_name='request')

        if method not in _ALLOWED_METHODS:
            raise ValueError(f'request: method must be one of {", ".join(sorted(_ALLOWED_METHODS))}')
        if method not in _SAFE_METHODS:
            self._require_write()
            # The message-send surface is an explicit opt-in group because a bad send
            # cannot be recalled, and this tool must not be a way around that: without
            # the group, a write under /conversations/messages (message_send and both
            # schedule cancels) is refused. GET stays open, reading messages is default.
            # Compared against the path the request will actually carry, not the spelling
            # given: requests resolves dot segments before sending, so `./conversations
            # /messages` reaches the send endpoint while matching no prefix. Collapse slash
            # runs first (normpath keeps a leading '//'), resolve the dots, then compare
            # case-insensitively.
            normalized = posixpath.normpath(re.sub(r'/+', '/', '/' + path)).lstrip('/').lower()
            if 'message_sending' not in self.IGlobal.tool_groups and normalized.startswith('conversations/messages'):
                raise ValueError(
                    'This operation is not permitted: writes under /conversations/messages require the '
                    'message_sending tool group'
                )

        if '://' in path:
            raise ValueError('request: "path" must be a path such as "/contacts/", not a full URL')

        params = args.get('params')
        body = args.get('body')
        version = args.get('version')
        if params is not None and not isinstance(params, dict):
            raise ValueError('request: "params" must be an object')
        if body is not None and not isinstance(body, dict):
            raise ValueError('request: "body" must be an object')
        if version is not None and not isinstance(version, str):
            raise ValueError('request: "version" must be a string such as "2021-07-28"')

        payload = self._call_envelope(method, path, params=params, body=body, version=version or None)
        # The only tool that returns a response this node has not projected through a key
        # allowlist, so it is the one place a payload could echo the credential back.
        return redact_payload(payload, self._token())
