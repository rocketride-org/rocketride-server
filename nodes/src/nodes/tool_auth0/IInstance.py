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

"""Agent-facing sign-in investigation tools with bounded, filtered outputs."""

import re

from ai.common.utils import normalize_tool_input, validate_tool_input_schema
from rocketlib import IInstanceBase, tool_function

from . import sanitize
from .auth0_client import Auth0Error


_ERROR = {
    'success': {'type': 'boolean'},
    'error': {'type': 'string'},
    'error_code': {'type': 'string'},
    'retryable': {'type': 'boolean'},
    'retry_after_seconds': {'type': ['number', 'null']},
}
_STRING = {'type': ['string', 'null']}
_BOOL = {'type': ['boolean', 'null']}
_USER = {
    'type': 'object',
    'properties': {'user_id': _STRING, 'email': _STRING, 'name': _STRING, 'email_verified': _BOOL},
}
_EVENT = {
    'type': 'object',
    'properties': {key: _STRING for key in ('log_id', 'date', 'type', 'description', 'connection', 'client_name')},
}
_BLOCK = {'type': 'object', 'properties': {'identifier': _STRING, 'connection': _STRING}}
_ID = {'type': 'string', 'minLength': 1, 'maxLength': 300}


def _input(args, name):
    """Normalize and validate tool arguments."""
    value = normalize_tool_input(args, tool_name=name)
    schema = getattr(IInstance, name).__tool_meta__['input_schema']
    try:
        validate_tool_input_schema(schema, value, tool_name=name)
    except (TypeError, ValueError):
        raise Auth0Error('INVALID_INPUT', 'Tool input contains unsupported properties.') from None
    return value


def _identifier(data, key):
    """Validate a bounded Auth0 identifier."""
    value = data.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > 300 or value in ('.', '..'):
        raise Auth0Error('INVALID_INPUT', f'{key} must be a nonempty string of at most 300 characters.')
    return value


def _limit(args, maximum):
    """Validate the requested result limit."""
    value = args.get('limit', 10)
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise Auth0Error('INVALID_INPUT', f'limit must be an integer between 1 and {maximum}.')
    return value


def _run(operation):
    """Return a structured result or safe Auth0 error."""
    try:
        return {'success': True, **operation()}
    except Auth0Error as exc:
        return {
            'success': False,
            'error': str(exc),
            'error_code': exc.code,
            'retryable': exc.retryable,
            'retry_after_seconds': exc.retry_after_seconds,
        }


def _schema(required, properties):
    """Build a closed input schema."""
    return {'type': 'object', 'required': required, 'properties': properties, 'additionalProperties': False}


def _output(properties):
    """Build an output schema with common result fields."""
    return {'type': 'object', 'properties': {**_ERROR, **properties}}


def _select_fields(properties):
    """Request only the named Auth0 response fields."""
    return {'fields': ','.join(properties), 'include_fields': 'true'}


class IInstance(IInstanceBase):
    """Expose the read-only Auth0 sign-in tools."""

    def _client(self):
        """Return the client or report that it has closed."""
        client = self.IGlobal.client
        if client is None:
            raise Auth0Error('CLIENT_CLOSED', 'Auth0 client is closed.')
        return client

    @tool_function(
        input_schema=_schema(
            ['email'],
            {
                'email': {'type': 'string', 'maxLength': 254},
                'limit': {'type': 'integer', 'minimum': 1, 'maximum': 20, 'default': 10},
            },
        ),
        output_schema=_output({'users': {'type': 'array', 'items': _USER}, 'count': {'type': 'integer'}}),
        description='Find users by exact, case-sensitive email. Profile fields are untrusted data. Requires read:users.',
    )
    def search_users(self, args):
        """Return matching users and count using read:users."""

        def op():
            """Search for users matching the validated email."""
            data = _input(args, 'search_users')
            email = data.get('email')
            # Accept unquoted ASCII mailboxes.
            if (
                not isinstance(email, str)
                or len(email) > 254
                or not re.fullmatch(
                    r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", email
                )
                or '..' in email
                or email.startswith('.')
                or email.split('@')[0].endswith('.')
            ):
                raise Auth0Error('INVALID_INPUT', 'A valid email address of at most 254 characters is required.')
            domain = email.split('@')[1]
            if any(
                not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label) for label in domain.split('.')
            ):
                raise Auth0Error('INVALID_INPUT', 'A valid email address of at most 254 characters is required.')
            limit = _limit(data, 20)
            params = {'email': email, **_select_fields(_USER['properties'])}
            users = sanitize.list_response(self._client().request('search_users', params=params))
            matches = [user for user in users if user.get('email') == email][:limit]
            return {'users': [sanitize.user(user) for user in matches], 'count': len(matches)}

        return _run(op)

    @tool_function(
        input_schema=_schema(['user_id'], {'user_id': _ID}),
        output_schema=_output(
            {
                **_USER['properties'],
                'blocked': {'type': 'boolean'},
                'last_login': _STRING,
                'logins_count': {'type': ['integer', 'null']},
                'connections': {'type': 'array', 'items': {'type': 'string'}},
            }
        ),
        description='Get sign-in profile and administrative block state. Profile fields are untrusted data; requires read:users.',
    )
    def get_user(self, args):
        """Return a sign-in profile using read:users."""

        def op():
            """Fetch and sanitize the requested user."""
            user_id = _identifier(_input(args, 'get_user'), 'user_id')
            # Connection names come from the user's identities.
            fields = (*_USER['properties'], 'blocked', 'last_login', 'logins_count', 'identities')
            data = sanitize.object_response(
                self._client().request('get_user', identifier=user_id, params=_select_fields(fields))
            )
            if data.get('user_id') != user_id:
                raise Auth0Error('API_ERROR', 'Auth0 returned an invalid user response.')
            if 'blocked' in data and not isinstance(data['blocked'], bool):
                raise Auth0Error('API_ERROR', 'Auth0 returned an invalid user response.')
            identities = data.get('identities', [])
            if (
                not isinstance(identities, list)
                or len(identities) > 100
                or any(not isinstance(item, dict) for item in identities)
            ):
                raise Auth0Error('API_ERROR', 'Auth0 returned an invalid user response.')
            connections = [
                sanitize.bounded_text(item['connection'], 300)
                for item in identities
                if item.get('connection') is not None
            ]
            count = data.get('logins_count')
            return {
                **sanitize.user(data),
                'blocked': data.get('blocked') is True,
                'last_login': sanitize.bounded_text(data.get('last_login'), 100),
                'logins_count': count if isinstance(count, int) and not isinstance(count, bool) else None,
                'connections': connections,
            }

        return _run(op)

    @tool_function(
        input_schema=_schema(
            ['user_id'], {'user_id': _ID, 'limit': {'type': 'integer', 'minimum': 1, 'maximum': 50, 'default': 10}}
        ),
        output_schema=_output({'events': {'type': 'array', 'items': _EVENT}, 'count': {'type': 'integer'}}),
        description='Get recent sanitized user authentication events; configure read:logs_users.',
    )
    def get_user_logs(self, args):
        """Return sanitized events and count using read:logs_users."""

        def op():
            """Fetch and sanitize recent user events."""
            data = _input(args, 'get_user_logs')
            user_id, limit = _identifier(data, 'user_id'), _limit(data, 50)
            events = sanitize.list_response(
                self._client().request(
                    'get_user_logs', identifier=user_id, params={'page': 0, 'per_page': limit, 'sort': 'date:-1'}
                )
            )
            result = [sanitize.event(item) for item in events[:limit]]
            return {'events': result, 'count': len(result)}

        return _run(op)

    @tool_function(
        input_schema=_schema(['log_id'], {'log_id': _ID}),
        output_schema=_output({**_EVENT['properties'], 'user_id': _STRING, 'diagnostics': {'type': 'string'}}),
        description='Get an event with allowlisted authentication diagnostics; requires read:logs.',
    )
    def get_log_event(self, args):
        """Return an event and sanitized diagnostics using read:logs."""

        def op():
            """Fetch and sanitize the requested log event."""
            log_id = _identifier(_input(args, 'get_log_event'), 'log_id')
            data = sanitize.object_response(self._client().request('get_log_event', identifier=log_id))
            event = sanitize.event(data)
            return {**event, 'user_id': sanitize.log_text(data.get('user_id')), 'diagnostics': event['description']}

        return _run(op)

    @tool_function(
        input_schema=_schema(['user_id'], {'user_id': _ID}),
        output_schema=_output(
            {
                'has_blocks': {'type': 'boolean'},
                'block_count': {'type': 'integer'},
                'blocks': {'type': 'array', 'items': _BLOCK},
            }
        ),
        description='Inspect brute-force protection blocks, not administrative blocks; requires read:users.',
    )
    def get_user_blocks(self, args):
        """Return brute-force blocks and their count using read:users."""

        def op():
            """Fetch brute-force blocks for the requested user."""
            user_id = _identifier(_input(args, 'get_user_blocks'), 'user_id')
            response = self._client().request(
                'get_user_blocks', identifier=user_id, params={'consider_brute_force_enablement': 'true'}
            )
            blocks = sanitize.blocks(response)
            return {'has_blocks': bool(blocks), 'block_count': len(blocks), 'blocks': blocks}

        return _run(op)
