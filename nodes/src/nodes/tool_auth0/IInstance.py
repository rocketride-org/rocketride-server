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

import ipaddress
import re

from ai.common.utils import normalize_tool_input
from rocketlib import IInstanceBase, tool_function

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
_EXPLANATIONS = {
    'f': 'Login failed.',
    'fp': 'Login failed because the password was invalid.',
    'fu': 'Login failed because the username was invalid.',
    'limit_wc': 'Brute-force protection blocked attempts to an account.',
    'limit_sul': 'Login attempts were temporarily limited for the account.',
    'limit_mu': 'Login attempts were blocked by IP-based protection.',
}
_GENERIC = 'No specific diagnostic is available for this event type.'


def _input(args, name):
    try:
        value = normalize_tool_input(args, tool_name=name)
    except Exception:
        raise Auth0Error('INVALID_INPUT', 'Tool input must be an object.') from None
    if not isinstance(value, dict):
        raise Auth0Error('INVALID_INPUT', 'Tool input must be an object.')
    return value


def _identifier(args, key):
    value = args.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > 300 or value in ('.', '..'):
        raise Auth0Error('INVALID_INPUT', f'{key} must be a nonempty string of at most 300 characters.')
    return value


def _limit(args, maximum):
    value = args.get('limit', 10)
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise Auth0Error('INVALID_INPUT', f'limit must be an integer between 1 and {maximum}.')
    return value


def _run(operation):
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


def _object(value):
    if not isinstance(value, dict):
        raise Auth0Error('API_ERROR', 'Auth0 returned an invalid response.')
    return value


def _list(value):
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise Auth0Error('API_ERROR', 'Auth0 returned an invalid response.')
    return value


def _text(value):
    return value if isinstance(value, str) else None


def _log_text(value):
    """Drop suspect log fields instead of exposing addresses or credentials."""
    if not isinstance(value, str) or len(value) > 300 or any(ord(char) < 32 for char in value):
        return None
    if re.search(r'(?i)\b(?:bearer|password|secret|token)\b', value):
        return None
    for part in re.findall(r'[0-9A-Fa-f:.]+', value):
        try:
            ipaddress.ip_address(part.strip('.'))
        except ValueError:
            continue
        return None
    return value


def _user(value):
    return {
        'user_id': _text(value.get('user_id')),
        'email': _text(value.get('email')),
        'name': _text(value.get('name')),
        'email_verified': value.get('email_verified') if isinstance(value.get('email_verified'), bool) else None,
    }


def _event(value):
    event_type = _log_text(value.get('type'))
    return {
        'log_id': _log_text(value.get('log_id') or value.get('_id')),
        'date': _log_text(value.get('date')),
        'type': event_type,
        'description': _EXPLANATIONS.get(event_type, _GENERIC),
        'connection': _log_text(value.get('connection')),
        'client_name': _log_text(value.get('client_name')),
    }


def _blocks(client, user_id):
    data = _object(
        client.request('get_user_blocks', identifier=user_id, params={'consider_brute_force_enablement': 'true'})
    )
    # An unexpected response must not be mistaken for an unblocked account.
    if 'blocked_for' not in data:
        raise Auth0Error('API_ERROR', 'Auth0 returned an invalid block response.')
    entries = _list(data['blocked_for'])
    return [
        {
            'identifier': '[REDACTED]' if item.get('identifier') is not None else None,
            'connection': _log_text(item.get('connection')),
        }
        for item in entries
    ]


def _schema(required, properties):
    return {'type': 'object', 'required': required, 'properties': properties, 'additionalProperties': False}


def _output(properties):
    return {'type': 'object', 'properties': {**_ERROR, **properties}}


class IInstance(IInstanceBase):
    """Expose only the six approved Auth0 sign-in tools."""

    @tool_function(
        input_schema=_schema(
            ['email'],
            {
                'email': {'type': 'string', 'maxLength': 254},
                'limit': {'type': 'integer', 'minimum': 1, 'maximum': 20, 'default': 10},
            },
        ),
        output_schema=_output({'users': {'type': 'array', 'items': _USER}, 'count': {'type': 'integer'}}),
        description='Find users by exact email, ignoring case. Requires read:users.',
    )
    def search_users(self, args):
        """Return matching users and count using read:users."""

        def op():
            data = _input(args, 'search_users')
            email = data.get('email')
            # Restrict to unquoted ASCII mailboxes; reject query syntax and ambiguous address forms.
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
            # Quoted Lucene term with metacharacters escaped; no user-supplied query is accepted.
            escaped = re.sub(r'([+\-!(){}\[\]^"~*?:\\/]|&&|\|\|)', r'\\\1', email)
            users = _list(
                self.IGlobal.client.request(
                    'search_users',
                    params={'q': f'email:"{escaped}"', 'search_engine': 'v3', 'page': 0, 'per_page': 100},
                )
            )
            matches = [
                _user(user)
                for user in users
                if isinstance(user.get('email'), str) and user['email'].casefold() == email.casefold()
            ][:limit]
            return {'users': matches, 'count': len(matches)}

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
        description='Get sign-in profile and administrative block state; requires read:users.',
    )
    def get_user(self, args):
        """Return a sign-in profile using read:users."""

        def op():
            user_id = _identifier(_input(args, 'get_user'), 'user_id')
            data = _object(self.IGlobal.client.request('get_user', identifier=user_id))
            if 'blocked' in data and not isinstance(data['blocked'], bool):
                raise Auth0Error('API_ERROR', 'Auth0 returned an invalid user response.')
            identities = data.get('identities') if isinstance(data.get('identities'), list) else []
            connections = [
                item['connection']
                for item in identities
                if isinstance(item, dict) and isinstance(item.get('connection'), str)
            ]
            count = data.get('logins_count')
            return {
                **_user(data),
                'blocked': data.get('blocked') is True,
                'last_login': _text(data.get('last_login')),
                'logins_count': count if isinstance(count, int) and not isinstance(count, bool) else None,
                'connections': connections,
            }

        return _run(op)

    @tool_function(
        input_schema=_schema(
            ['user_id'], {'user_id': _ID, 'limit': {'type': 'integer', 'minimum': 1, 'maximum': 50, 'default': 10}}
        ),
        output_schema=_output({'events': {'type': 'array', 'items': _EVENT}, 'count': {'type': 'integer'}}),
        description='Get recent sanitized user authentication events; configure read:logs_users and read:logs.',
    )
    def get_user_logs(self, args):
        """Return sanitized events and count using read:logs_users and read:logs."""

        def op():
            data = _input(args, 'get_user_logs')
            user_id, limit = _identifier(data, 'user_id'), _limit(data, 50)
            events = _list(
                self.IGlobal.client.request(
                    'get_user_logs', identifier=user_id, params={'page': 0, 'per_page': limit, 'sort': 'date:-1'}
                )
            )
            result = [_event(item) for item in events[:limit]]
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
            log_id = _identifier(_input(args, 'get_log_event'), 'log_id')
            data = _object(self.IGlobal.client.request('get_log_event', identifier=log_id))
            event = _event(data)
            return {**event, 'user_id': _log_text(data.get('user_id')), 'diagnostics': event['description']}

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
            user_id = _identifier(_input(args, 'get_user_blocks'), 'user_id')
            blocks = _blocks(self.IGlobal.client, user_id)
            return {'has_blocks': bool(blocks), 'block_count': len(blocks), 'blocks': blocks}

        return _run(op)

    @tool_function(
        input_schema=_schema(['user_id'], {'user_id': _ID}),
        output_schema=_output(
            {
                'user_id': {'type': 'string'},
                'unblocked': {'type': 'boolean'},
                'had_blocks': {'type': 'boolean'},
                'message': {'type': 'string'},
            }
        ),
        description='Clear brute-force blocks using separately enabled write credentials; requires update:users.',
    )
    def unblock_user(self, args):
        """Return the unblock outcome using enabled write credentials and update:users."""

        def op():
            user_id = _identifier(_input(args, 'unblock_user'), 'user_id')
            client = self.IGlobal.client
            if not client.writes_enabled:
                raise Auth0Error('WRITE_DISABLED', 'Auth0 writes are disabled.')
            if not _blocks(client, user_id):
                return {
                    'user_id': user_id,
                    'unblocked': False,
                    'had_blocks': False,
                    'message': 'No brute-force blocks were present at the time of the check.',
                }
            client.request('unblock_user', identifier=user_id)
            return {
                'user_id': user_id,
                'unblocked': True,
                'had_blocks': True,
                'message': 'Auth0 accepted the unblock request; blocks were present before the request.',
            }

        return _run(op)
