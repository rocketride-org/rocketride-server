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
Supabase Auth: agent tools.

Eight tools over the project's users. Reads (``list_users``, ``get_user``,
``verify_user``) need the ``read`` access level, changes (``create_user``,
``invite_user``, ``generate_link``, ``update_user``) need ``write``, and
``delete_user`` needs ``admin``.

Users are returned through an allow-list of fields (:data:`USER_FIELDS`), so
password hashes, confirmation/recovery tokens and the ``action_link`` that
GoTrue puts on some user objects never reach the agent. ``generate_link``
returns the link itself (that is the point of the tool) and nothing else
secret: not the email OTP, not the hashed token.

``verify_user`` takes a user's access token per call and passes it to
``client.auth.get_user(jwt)``, which sends it for that one request only. The
token is never stored, logged or echoed.
"""

from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from rocketlib import tool_function

from ai.common.utils import int_arg, optional_bool, optional_int, optional_str, require_str

from ..IInstance import ADMIN, READ, WRITE, SupabaseInstanceBase, requires_access
from .IGlobal import IGlobal

#: Fields of a user returned by get_user / create_user / invite_user / update_user.
USER_FIELDS = (
    'id',
    'email',
    'phone',
    'role',
    'created_at',
    'updated_at',
    'last_sign_in_at',
    'email_confirmed_at',
    'phone_confirmed_at',
    'confirmed_at',
    'invited_at',
    'banned_until',
    'deleted_at',
    'is_anonymous',
    'user_metadata',
    'app_metadata',
)

#: Fields of each user in a list_users page (kept small: a page can hold many users).
USER_LIST_FIELDS = ('id', 'email', 'phone', 'created_at', 'last_sign_in_at', 'email_confirmed_at', 'banned_until')

#: generate_link types this tool supports (the email-change types need a second address; not exposed).
LINK_TYPES = ('signup', 'magiclink', 'recovery', 'invite')

# A Supabase access token is a JWT of a few KB. Anything far larger is not a
# token and is refused before it is sent anywhere.
_MAX_TOKEN_LENGTH = 16384
_MAX_EMAIL_LENGTH = 320
# redirect_to URLs, phone numbers and ban durations: far below this in practice.
_MAX_TEXT_LENGTH = 2048

# GoTrue answers an invalid, expired or revoked token (or one whose user was
# deleted) with one of these statuses / error codes. Anything else (network
# failure, 5xx) is a real error and is raised, not reported as "not valid".
_INVALID_TOKEN_STATUSES = (401, 403, 404)
_INVALID_TOKEN_CODES = ('bad_jwt', 'no_authorization', 'session_not_found', 'session_expired', 'user_not_found')

_USER_SCHEMA = {
    'type': 'object',
    'description': 'A user: id, email, phone, timestamps, ban state, user_metadata and app_metadata. Never a password or token.',
}


def _pick(user: Any, fields: tuple) -> Dict[str, Any]:
    """Allow-listed, JSON-safe copy of a supabase-py user (or None -> {})."""
    plain = SupabaseInstanceBase._output(user)
    if not isinstance(plain, dict):
        return {}
    return {key: plain[key] for key in fields if key in plain}


def _user_of(response: Any) -> Any:
    """supabase-py returns UserResponse(user=User) for most admin calls; unwrap it."""
    return getattr(response, 'user', response)


class IInstance(SupabaseInstanceBase):
    """Node instance exposing Supabase Auth user management as agent tools."""

    IGlobal: IGlobal

    # ------------------------------------------------------------------
    # Argument helpers
    # ------------------------------------------------------------------

    def _user_id(self, args: Dict[str, Any], tool_name: str) -> str:
        """Required ``user_id``, checked to be a UUID so a typo fails here with a clear message."""
        user_id = require_str(args, 'user_id', tool_name=tool_name)
        try:
            return str(uuid.UUID(user_id))
        except ValueError:
            raise ValueError(f'{tool_name}: "user_id" must be a user id (a UUID)') from None

    def _email(self, args: Dict[str, Any], tool_name: str, *, required: bool = True) -> Optional[str]:
        """``email`` as a trimmed address; GoTrue does the full validation."""
        email = self._bounded_str(args, 'email', tool_name=tool_name, max_len=_MAX_EMAIL_LENGTH, required=required)
        if email is None:
            return None
        if '@' not in email or any(ch.isspace() for ch in email):
            raise ValueError(f'{tool_name}: "email" must be an email address')
        return email

    def _password(self, args: Dict[str, Any], tool_name: str) -> Optional[str]:
        """Optional password. Not stripped: whitespace is valid in a password."""
        value = optional_str(args, 'password', tool_name=tool_name)
        if value is None or value == '':
            return None
        return value

    # ------------------------------------------------------------------
    # Read tools
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'page': {'type': 'integer', 'minimum': 1, 'description': 'Page number, starting at 1. Default 1.'},
                'per_page': {
                    'type': 'integer',
                    'minimum': 1,
                    'description': 'Users per page. Default and maximum: the node page size (50 unless changed).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'users': {
                    'type': 'array',
                    'items': {'type': 'object'},
                    'description': 'id, email, phone, created_at, last_sign_in_at, email_confirmed_at, banned_until.',
                },
                'page': {'type': 'integer'},
                'per_page': {'type': 'integer'},
                'count': {'type': 'integer', 'description': 'Users on this page.'},
                'more_may_exist': {
                    'type': 'boolean',
                    'description': 'True when the page is full: call again with page + 1.',
                },
            },
        },
        description=(
            'List the project users, one page at a time. Arguments: page (default 1), per_page '
            '(default and maximum: the node page size, 50 unless changed; larger values are lowered). '
            'Needs the read access level. Returns users (id, email, phone, created_at, last_sign_in_at, '
            'email_confirmed_at, banned_until), page, per_page, count, and more_may_exist (true when the '
            'page is full, so ask for the next page).'
        ),
    )
    @requires_access(READ)
    def list_users(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """One page of users."""
        tool = self._tool('list_users')
        page = optional_int(args, 'page', default=1, lo=1, tool_name=tool)
        limit = self.IGlobal.page_size
        per_page = int_arg(args, 'per_page', default=limit, lo=1, hi=limit, tool_name=tool)
        users = self._client().auth.admin.list_users(page=page, per_page=per_page) or []
        rows: List[Dict[str, Any]] = [_pick(u, USER_LIST_FIELDS) for u in users]
        return {
            'users': rows,
            'page': page,
            'per_page': per_page,
            'count': len(rows),
            'more_may_exist': len(rows) >= per_page,
        }

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['user_id'],
            'properties': {'user_id': {'type': 'string', 'description': 'The user id (a UUID).'}},
        },
        output_schema=_USER_SCHEMA,
        description=(
            'Get one user by id. Arguments: user_id (UUID). Needs the read access level. Returns the user: '
            'id, email, phone, role, created_at, updated_at, last_sign_in_at, email_confirmed_at, '
            'phone_confirmed_at, confirmed_at, invited_at, banned_until, deleted_at, is_anonymous, '
            'user_metadata, app_metadata. Fails if no user has that id.'
        ),
    )
    @requires_access(READ)
    def get_user(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """One user by id."""
        user_id = self._user_id(args, self._tool('get_user'))
        return _pick(_user_of(self._client().auth.admin.get_user_by_id(user_id)), USER_FIELDS)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['access_token'],
            'properties': {
                'access_token': {
                    'type': 'string',
                    'description': 'The access token (JWT) a signed-in Supabase user holds. A leading "Bearer " is allowed.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'valid': {'type': 'boolean'},
                'user': {'type': 'object', 'description': 'id and email, when valid.'},
                'reason': {'type': 'string', 'description': 'Why the token was refused, when not valid.'},
            },
        },
        description=(
            'Check who a signed-in user is from their login token. Arguments: access_token (the JWT a '
            'Supabase user holds). Needs the read access level. Returns {"valid": true, "user": {"id", '
            '"email"}} when Supabase accepts the token, or {"valid": false, "reason": ...} when the token '
            'is invalid, expired or its user no longer exists. The token is never stored or returned.'
        ),
    )
    @requires_access(READ)
    def verify_user(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Validate a user's access token with Supabase Auth."""
        tool = self._tool('verify_user')
        token = require_str(args, 'access_token', tool_name=tool)
        # Callers often copy the whole Authorization header value.
        if token[:7].lower() == 'bearer ':
            token = token[7:].strip()
        if (
            not token
            or token.lower() == 'bearer'
            or len(token) > _MAX_TOKEN_LENGTH
            or any(ch.isspace() for ch in token)
        ):
            raise ValueError(f'{tool}: "access_token" must be a single access token (a JWT)')

        try:
            # A NON-empty jwt makes supabase-py stateless here: the token is
            # sent for this request only and never becomes the client's session.
            response = self._client().auth.get_user(token)
        except Exception as e:
            status = getattr(e, 'status', None)
            code = getattr(e, 'code', None)
            if status in _INVALID_TOKEN_STATUSES or code in _INVALID_TOKEN_CODES:
                reason = (
                    'Supabase did not accept the token: it is invalid, expired or revoked, or its user no longer exists'
                )
                return {'valid': False, 'reason': f'{reason} ({code or f"HTTP {status}"})'}
            # Not an answer about the token (network, 5xx): a real failure.
            raise
        user = _user_of(response) if response is not None else None
        if user is None:
            return {'valid': False, 'reason': 'Supabase returned no user for the token'}
        return {'valid': True, 'user': _pick(user, ('id', 'email'))}

    # ------------------------------------------------------------------
    # Write tools
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['email'],
            'properties': {
                'email': {'type': 'string', 'description': 'Email address of the new user.'},
                'password': {
                    'type': 'string',
                    'description': 'Optional password. Without one the user signs in by magic link or a later recovery link.',
                },
                'email_confirm': {
                    'type': 'boolean',
                    'description': 'Mark the email as already confirmed. Default false.',
                },
                'user_metadata': {'type': 'object', 'description': 'Optional profile data stored on the user.'},
            },
        },
        output_schema=_USER_SCHEMA,
        description=(
            'Create a user. Sends no email. Arguments: email, password (optional), email_confirm (optional, '
            'default false: true marks the address as confirmed), user_metadata (optional object). Needs the '
            'write access level. Returns the new user (same fields as get_user); the password is never returned.'
        ),
    )
    @requires_access(WRITE)
    def create_user(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Create a user with the admin API."""
        tool = self._tool('create_user')
        attributes: Dict[str, Any] = {'email': self._email(args, tool)}
        password = self._password(args, tool)
        if password is not None:
            attributes['password'] = password
        email_confirm = optional_bool(args, 'email_confirm', default=None, tool_name=tool)
        if email_confirm is not None:
            attributes['email_confirm'] = email_confirm
        metadata = self._dict_arg(args, 'user_metadata', tool_name=tool)
        if metadata is not None:
            attributes['user_metadata'] = metadata
        return _pick(_user_of(self._client().auth.admin.create_user(attributes)), USER_FIELDS)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['email'],
            'properties': {
                'email': {'type': 'string', 'description': 'Address to invite.'},
                'redirect_to': {
                    'type': 'string',
                    'description': 'Optional URL the invite link opens after sign-up. Must be in the project redirect allow list.',
                },
            },
        },
        output_schema=_USER_SCHEMA,
        description=(
            'Invite a user by email: Supabase creates the user and emails them an invite link. Arguments: '
            'email, redirect_to (optional URL from the project redirect allow list). Needs the write access '
            "level. Returns the invited user (same fields as get_user). Supabase's built-in email service "
            'only delivers to members of the project team unless custom SMTP is set up.'
        ),
    )
    @requires_access(WRITE)
    def invite_user(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Invite a user by email."""
        tool = self._tool('invite_user')
        email = self._email(args, tool)
        options: Dict[str, Any] = {}
        redirect_to = self._bounded_str(args, 'redirect_to', tool_name=tool, max_len=_MAX_TEXT_LENGTH, required=False)
        if redirect_to is not None:
            options['redirect_to'] = redirect_to
        response = self._client().auth.admin.invite_user_by_email(email, options or None)
        return _pick(_user_of(response), USER_FIELDS)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['type', 'email'],
            'properties': {
                'type': {
                    'type': 'string',
                    'enum': list(LINK_TYPES),
                    'description': 'signup, magiclink, recovery (password reset) or invite.',
                },
                'email': {'type': 'string', 'description': 'The user the link is for.'},
                'password': {
                    'type': 'string',
                    'description': 'Only for type signup, where Supabase requires it: the new user password.',
                },
                'redirect_to': {
                    'type': 'string',
                    'description': 'Optional URL the link opens afterwards. Must be in the project redirect allow list.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'type': {'type': 'string'},
                'email': {'type': 'string'},
                'user_id': {'type': 'string'},
                'link': {'type': 'string', 'description': 'The action link to send to the user.'},
            },
        },
        description=(
            'Generate a sign-in link without sending any email, for you to deliver yourself. Arguments: type '
            '(signup, magiclink, recovery or invite), email, password (only for signup, where Supabase '
            'requires it), redirect_to (optional). Needs the write access level. Returns type, email, user_id '
            'and link. Anyone holding the link can use it once, so only give it to the user it is for.'
        ),
    )
    @requires_access(WRITE)
    def generate_link(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Generate an action link; return the link and nothing else secret."""
        tool = self._tool('generate_link')
        link_type = require_str(args, 'type', tool_name=tool)
        if link_type not in LINK_TYPES:
            raise ValueError(f'{tool}: "type" must be one of {list(LINK_TYPES)}')
        email = self._email(args, tool)
        params: Dict[str, Any] = {'type': link_type, 'email': email}
        password = self._password(args, tool)
        if link_type == 'signup':
            if password is None:
                raise ValueError(f'{tool}: "password" is required when type is signup')
            params['password'] = password
        elif password is not None:
            raise ValueError(f'{tool}: "password" is only used when type is signup')
        redirect_to = self._bounded_str(args, 'redirect_to', tool_name=tool, max_len=_MAX_TEXT_LENGTH, required=False)
        if redirect_to is not None:
            params['options'] = {'redirect_to': redirect_to}

        response = self._client().auth.admin.generate_link(params)
        properties = self._output(getattr(response, 'properties', None))
        link = properties.get('action_link') if isinstance(properties, dict) else None
        if not isinstance(link, str) or not link:
            raise RuntimeError(f'{tool}: Supabase returned no link')
        user = _pick(getattr(response, 'user', None), ('id',))
        # Only the link: email_otp and hashed_token are deliberately left out.
        return {'type': link_type, 'email': email, 'user_id': user.get('id'), 'link': link}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['user_id'],
            'properties': {
                'user_id': {'type': 'string', 'description': 'The user id (a UUID).'},
                'email': {'type': 'string', 'description': 'New email address.'},
                'phone': {'type': 'string', 'description': 'New phone number.'},
                'password': {'type': 'string', 'description': 'New password.'},
                'email_confirm': {'type': 'boolean', 'description': 'true marks the email as confirmed.'},
                'phone_confirm': {'type': 'boolean', 'description': 'true marks the phone as confirmed.'},
                'user_metadata': {
                    'type': 'object',
                    'description': 'Profile data to merge into the user metadata (top-level keys given are set).',
                },
                'ban_duration': {
                    'type': 'string',
                    'description': 'Block sign-in for a duration such as "24h" or "876000h"; "none" lifts a ban.',
                },
            },
        },
        output_schema=_USER_SCHEMA,
        description=(
            'Change a user. Arguments: user_id (UUID) and at least one of email, phone, password, '
            'email_confirm, phone_confirm, user_metadata, ban_duration ("24h" bans for a day, "none" lifts a '
            'ban). Needs the write access level. Returns the updated user (same fields as get_user); the '
            'password is never returned. Role and app_metadata cannot be changed with this tool.'
        ),
    )
    @requires_access(WRITE)
    def update_user(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Change a user with the admin API (``update_user_by_id``: no session needed)."""
        tool = self._tool('update_user')
        user_id = self._user_id(args, tool)
        attributes: Dict[str, Any] = {}
        email = self._email(args, tool, required=False)
        if email is not None:
            attributes['email'] = email
        for key in ('phone', 'ban_duration'):
            value = self._bounded_str(args, key, tool_name=tool, max_len=_MAX_TEXT_LENGTH, required=False)
            if value is not None:
                attributes[key] = value
        password = self._password(args, tool)
        if password is not None:
            attributes['password'] = password
        for key in ('email_confirm', 'phone_confirm'):
            value = optional_bool(args, key, default=None, tool_name=tool)
            if value is not None:
                attributes[key] = value
        metadata = self._dict_arg(args, 'user_metadata', tool_name=tool)
        if metadata is not None:
            attributes['user_metadata'] = metadata
        if not attributes:
            raise ValueError(
                f'{tool}: give at least one field to change (email, phone, password, email_confirm, '
                'phone_confirm, user_metadata, ban_duration)'
            )
        response = self._client().auth.admin.update_user_by_id(user_id, attributes)
        return _pick(_user_of(response), USER_FIELDS)

    # ------------------------------------------------------------------
    # Admin tools
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['user_id'],
            'properties': {
                'user_id': {'type': 'string', 'description': 'The user id (a UUID).'},
                'soft_delete': {
                    'type': 'boolean',
                    'description': 'true keeps the user row but anonymises it and blocks sign-in. Default false (permanent).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'deleted': {'type': 'boolean'},
                'user_id': {'type': 'string'},
                'soft_delete': {'type': 'boolean'},
            },
        },
        description=(
            'Delete a user. Arguments: user_id (UUID), soft_delete (optional, default false: the user is '
            'removed permanently; true anonymises the user and blocks sign-in instead). Needs the admin '
            'access level. Returns {"deleted": true, "user_id", "soft_delete"}. Fails if no user has that id.'
        ),
    )
    @requires_access(ADMIN)
    def delete_user(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Delete a user."""
        tool = self._tool('delete_user')
        user_id = self._user_id(args, tool)
        soft = optional_bool(args, 'soft_delete', default=False, tool_name=tool)
        self._client().auth.admin.delete_user(user_id, should_soft_delete=soft)
        return {'deleted': True, 'user_id': user_id, 'soft_delete': soft}
