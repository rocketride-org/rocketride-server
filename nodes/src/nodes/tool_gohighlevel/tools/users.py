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

"""User tools: reading the staff users of the configured sub-account, to resolve user ids."""

from __future__ import annotations

from typing import Any

from ..gohighlevel_client import paginated
from ..tool_groups import gohighlevel_tool
from ._base import (
    BOOL,
    LIST_OUTPUT,
    PAGING_SKIP_TEXT,
    RECORD_OUTPUT,
    STR,
    GoHighLevelToolsBase,
    bool_params,
    next_offset,
    params_from,
    record_of,
    require_id,
    schema,
    skip_text_params,
)

#: Fields kept from a user record on a listing.
#:
#: ``UserSchema`` declares thirteen fields and two of them are large: ``permissions`` is a flat
#: map of 38 booleans and ``scopes`` is a long OAuth scope string. A page of 25 users would
#: carry roughly a thousand keys of it, so a listing keeps identity plus role and the two big
#: fields are read one user at a time through user_get. That is the whole reason there are two
#: projections in this module rather than one.
_USER_LIST_KEYS = (
    'id',
    'name',
    'firstName',
    'lastName',
    'email',
    'phone',
    'extension',
    'roles',
    'deleted',
)

#: Fields kept from a single user record, which is every field ``UserSchema`` declares.
_USER_READ_KEYS = _USER_LIST_KEYS + (
    'permissions',
    'scopes',
    'lcPhone',
    'platformLanguage',
)

#: Query parameters GET /users/search accepts beyond paging and the two ids this node supplies.
#: ``enabled2waySync`` is absent here because it is a boolean and goes through
#: :func:`bool_params` instead.
_USER_SEARCH_KEYS = ('query', 'type', 'role', 'ids', 'sort', 'sortDirection')

_USER_RECORD_OUTPUT = RECORD_OUTPUT(
    'The user, trimmed to the fields this node returns, including the permissions map and the scopes string.'
)

_USER_ITEMS = (
    'The users on this page. Each carries identity and role only: call user_get for the permissions map and '
    'the scopes string.'
)

#: Said by both list tools, because the id these tools exist to produce is used in four places.
_USER_ID_USES = (
    'The id is what assignedTo on a contact, followers on a contact, assignedTo on a task and assignedUserId '
    'on an appointment all take.'
)


def _clean_user(user: Any) -> dict:
    """Trim a user record to every field this node returns, for a single-record read."""
    if not isinstance(user, dict):
        return {}
    return {key: user[key] for key in _USER_READ_KEYS if key in user}


def _clean_user_summary(user: Any) -> dict:
    """Trim a user record to identity and role, for a listing."""
    if not isinstance(user, dict):
        return {}
    return {key: user[key] for key in _USER_LIST_KEYS if key in user}


def _user_total(payload: Any) -> Any:
    """Total matching users, which only GET /users/search reports and only as ``count``."""
    if isinstance(payload, dict):
        return payload.get('count')
    return None


class UsersMixin(GoHighLevelToolsBase):
    """Tools for the ``users`` group.

    Read-only. GoHighLevel does publish user create, update and delete, but they provision
    staff accounts and write ``password``, ``permissions`` and ``scopes``, and their spec
    declares no ``userId`` path parameter, which has already broken the vendor's own SDK.
    None of that belongs behind an agent tool, so this group offers three reads.
    """

    # -- companyId ---------------------------------------------------------

    def _company_id(self, args: dict, tool: str) -> str:
        """Agency id GET /users/search requires, from the argument or from the sub-account record.

        This is the asymmetry that makes the users group awkward, and it is live-confirmed in
        both directions: ``GET /users/search`` rejects a request with no ``companyId`` as
        ``401 E01 - Unauthorized request``, wording that reads like a credential failure and is
        really a missing parameter, while its sibling ``GET /users/`` rejects the same value
        outright with ``property companyId should not exist``.

        The node has no companyId setting, and a Private Integration Token is opaque so nothing
        can be derived from it, which leaves one source: the sub-account record carries the
        agency it belongs to. Reading it costs a request against a measured 25-request/10s
        budget, so the tool takes an override for an agent that already has the value. Nothing
        is cached here: this mixin is composed into a node instance whose lifetime is not this
        module's to assume.
        """
        supplied = args.get('companyId')
        if isinstance(supplied, str) and supplied.strip():
            return supplied.strip()
        location = self._location()
        record = record_of(self._call('GET', f'/locations/{location}'), 'location')
        company = record.get('companyId') if isinstance(record, dict) else None
        if isinstance(company, str) and company.strip():
            return company.strip()
        raise ValueError(
            f'{tool}: GoHighLevel requires a companyId here and the sub-account record for {location} did not '
            f'carry one. Pass companyId, or use user_list_by_location, which needs no companyId.'
        )

    # -- reads -------------------------------------------------------------

    @gohighlevel_tool(
        group='users',
        input_schema=schema(
            **PAGING_SKIP_TEXT('user_search'),
            query=STR('Free-text search matched against the user full name, email or phone.'),
            type=STR('Account type to filter on, for example "agency" or "account".'),
            role=STR('Role to filter on, for example "admin" or "user".'),
            ids=STR('Specific user ids to return, as one comma-separated string rather than an array.'),
            sort=STR('Field to sort on, for example "dateAdded". Sorting is by first and last name by default.'),
            sortDirection=STR('Sort direction, "asc" or "desc".'),
            enabled2waySync=BOOL('Whether to return only users with two-way sync enabled, or only those without.'),
            companyId=STR(
                'Agency id. Omit it: the node reads it from the sub-account record. Pass it only to save that '
                'extra request when you already have the value.'
            ),
        ),
        description=(
            'Find users of the configured sub-account by name, email, phone or role. This is the only user read '
            f'that can filter or page, so prefer it over user_list_by_location when you know anything about the '
            f'user you want. {_USER_ID_USES} Each result carries identity and role only, so call user_get for a '
            'user permissions and scopes. Omitting companyId costs one extra request, because GoHighLevel '
            'requires an agency id here that this node has to read off the sub-account first. Returns users '
            'under items, and next is the skip value for the following page.'
        ),
        output_schema=LIST_OUTPUT(
            'Offset for the next page: pass it back as the skip parameter. Null once a page comes back shorter '
            'than the limit asked for, which means there is no next page.',
            items=_USER_ITEMS,
        ),
    )
    def user_search(self, args):
        args = self._args(args, 'user_search')
        params, limit = skip_text_params(args, 'user_search')
        params.update(params_from(args, _USER_SEARCH_KEYS))
        params.update(bool_params(args, ('enabled2waySync',)))
        params['companyId'] = self._company_id(args, 'user_search')
        # Both ids are sent. companyId is required by the endpoint and locationId is the
        # optional narrowing that keeps the result inside the sub-account this node is
        # configured for, rather than returning every user in the agency.
        params['locationId'] = self._location()
        payload, records = self._fetch('GET', '/users/search', key='users', params=params)
        return paginated(
            [_clean_user_summary(record) for record in records],
            total=_user_total(payload),
            next_cursor=next_offset(args.get('skip'), limit, len(records)),
            requested_limit=limit,
        )

    @gohighlevel_tool(
        group='users',
        input_schema=schema(),
        description=(
            'List every user of the configured sub-account in one response. There is no paging and no filtering: '
            f'the whole list comes back at once, so next is always null. {_USER_ID_USES} Each user carries '
            'identity and role only, so call user_get for a user permissions and scopes. Prefer user_search when '
            'you want to narrow by name, email or role, and use this one to see everybody.'
        ),
        output_schema=LIST_OUTPUT(
            'Always null: this endpoint returns every user in one response, so there is no next page.',
            items=_USER_ITEMS,
        ),
    )
    def user_list_by_location(self, args):
        args = self._args(args, 'user_list_by_location')
        # The trailing slash is load-bearing, and so is the absence of companyId: this endpoint
        # rejects it with "property companyId should not exist", which is the exact opposite of
        # what its sibling GET /users/search demands. Both were confirmed live.
        return self._list('/users/', key='users', cleaner=_clean_user_summary, params={'locationId': self._location()})

    @gohighlevel_tool(
        group='users',
        input_schema=schema(required=['userId'], userId=STR('Id of the user.')),
        description=(
            'Get one user by id, including the permissions map and the scopes string that the two list tools '
            'leave out. Get user ids from user_search or user_list_by_location. This tool is not scoped to the '
            'configured sub-account: it answers for any user the token can see.'
        ),
        output_schema=_USER_RECORD_OUTPUT,
    )
    def user_get(self, args):
        args = self._args(args, 'user_get')
        user_id = require_id(args, 'userId', 'user_get')
        # The user arrives bare rather than under a "user" key, so no envelope key is named.
        return self._get(f'/users/{user_id}', _clean_user)
