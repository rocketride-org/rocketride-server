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
Pipedrive tool node instance.

Composes one mixin per Pipedrive resource group, publishes only the groups the
operator enabled, and adds the generic ``request`` escape hatch that reaches any
v1 endpoint the typed tools do not model.
"""

from __future__ import annotations

from typing import Callable

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input, require_str

from .IGlobal import IGlobal
from .tool_groups import RAW_REQUEST_TOOL
from .tools import (
    ActivitiesMixin,
    CallLogsMixin,
    DealsMixin,
    FieldsMixin,
    FilesMixin,
    FiltersMixin,
    GoalsMixin,
    LeadsMixin,
    MailboxMixin,
    MiscMixin,
    NotesMixin,
    OrganizationsMixin,
    PersonsMixin,
    PipelinesMixin,
    ProductsMixin,
    ProjectsMixin,
    RolesMixin,
    SearchMixin,
    SubscriptionsMixin,
    TeamsMixin,
    UsersMixin,
    WebhooksMixin,
)

_SAFE_METHODS = {'GET', 'HEAD'}
_ALLOWED_METHODS = {'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'}


class IInstance(
    DealsMixin,
    PersonsMixin,
    OrganizationsMixin,
    ActivitiesMixin,
    PipelinesMixin,
    NotesMixin,
    SearchMixin,
    LeadsMixin,
    ProductsMixin,
    FieldsMixin,
    FilesMixin,
    UsersMixin,
    RolesMixin,
    TeamsMixin,
    GoalsMixin,
    FiltersMixin,
    WebhooksMixin,
    SubscriptionsMixin,
    MailboxMixin,
    CallLogsMixin,
    ProjectsMixin,
    MiscMixin,
    IInstanceBase,
):
    IGlobal: IGlobal

    # -----------------------------------------------------------------------
    # Tool publication
    # -----------------------------------------------------------------------

    def _collect_tool_methods(self) -> dict[str, Callable]:
        """Publish only the tools whose group the operator enabled.

        The base implementation returns every ``@tool_function`` on the class,
        which for full Pipedrive coverage is far more than an agent can choose
        between. Filtering here covers both ``tool.query`` (the agent never sees
        a disabled tool) and ``tool.invoke`` (calling one anyway is refused).
        """
        methods = super()._collect_tool_methods()
        enabled = self.IGlobal.tool_groups
        allow_raw = self.IGlobal.allow_raw_request

        published: dict[str, Callable] = {}
        for name, method in methods.items():
            if name == RAW_REQUEST_TOOL:
                if allow_raw:
                    published[name] = method
                continue
            group = getattr(getattr(type(self), name, None), '__pipedrive_group__', None)
            if group is None or group in enabled:
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
                    'description': 'HTTP method. In read-only mode only GET and HEAD are permitted.',
                },
                'path': {
                    'type': 'string',
                    'description': (
                        'Pipedrive API v1 path, relative to the API root and starting with a slash — '
                        'for example "/goals", "/deals/123/followers" or "/organizationRelationships". '
                        'Do not include the host or the /api/v1 prefix.'
                    ),
                },
                'params': {
                    'type': 'object',
                    'description': 'Query-string parameters. The api_token is added automatically.',
                },
                'body': {'type': 'object', 'description': 'JSON request body for POST, PUT and PATCH.'},
            },
        },
        description=(
            'Call any Pipedrive REST API v1 endpoint directly. Use this only for endpoints that have no '
            'dedicated tool here — the typed tools validate their inputs and return compact results, this '
            'one returns the raw API payload. Authentication, rate-limit retries and read-only enforcement '
            'still apply. See https://developers.pipedrive.com/docs/api/v1 for the endpoint reference.'
        ),
    )
    def request(self, args):
        """Call any Pipedrive v1 endpoint directly."""
        args = normalize_tool_input(args, tool_name='tool_pipedrive')
        method = require_str(args, 'method', tool_name='request').upper()
        path = require_str(args, 'path', tool_name='request')

        if method not in _ALLOWED_METHODS:
            raise ValueError(f'request: method must be one of {", ".join(sorted(_ALLOWED_METHODS))}')
        if method not in _SAFE_METHODS:
            self._require_write()

        if '://' in path:
            raise ValueError('request: "path" must be a path such as "/deals", not a full URL')

        params = args.get('params')
        body = args.get('body')
        if params is not None and not isinstance(params, dict):
            raise ValueError('request: "params" must be an object')
        if body is not None and not isinstance(body, dict):
            raise ValueError('request: "body" must be an object')

        return self._call_envelope(method, path, params=params, body=body)
