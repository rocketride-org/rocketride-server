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

"""Sub-account tools: the location record itself, and the task search scoped to it."""

from __future__ import annotations

from typing import Any

from ..gohighlevel_client import paginated
from ..tool_groups import gohighlevel_tool
from ._base import (
    ARR,
    BOOL,
    LIST_OUTPUT,
    PAGING_SKIP_BODY,
    RECORD_OUTPUT,
    STR,
    GoHighLevelToolsBase,
    body_from,
    next_offset,
    passthrough,
    schema,
    skip_body,
)

#: Fields kept from a sub-account record, which is GetLocationByIdSchema.
#:
#: ``companyId`` is the load-bearing one and the reason this tool is worth publishing at all:
#: it is the agency id, ``GET /users/search`` requires it, and nothing else on the surface a
#: sub-account token can reach returns it. The record read here is a different schema from the
#: one ``GET /locations/search`` returns (that one omits companyId, domain, logoUrl, reseller,
#: business, firstName and lastName), but that endpoint is agency-scoped and this node does not
#: offer it, so there is only one shape to model.
_LOCATION_READ_KEYS = (
    'id',
    'companyId',
    'name',
    'domain',
    'email',
    'phone',
    'address',
    'city',
    'state',
    'country',
    'postalCode',
    'website',
    'timezone',
    'firstName',
    'lastName',
    'logoUrl',
    'business',
    'social',
    'settings',
    'reseller',
)

#: Body fields the sub-account task search filters on, all of them optional.
#:
#: ``skip`` and ``limit`` are absent deliberately: this endpoint takes both in the body as
#: numbers rather than in the query as strings, so :func:`skip_body` renders them and this
#: tuple carries only the filters.
_TASK_SEARCH_KEYS = ('contactId', 'assignedTo', 'businessId', 'completed', 'query')

_TASK_SEARCH_PROPS = {
    'contactId': ARR(
        'Contact ids to return tasks for. The vendor names this parameter in the singular and it '
        'takes an array, so pass a list even for one contact.'
    ),
    'assignedTo': ARR('User ids the task is assigned to. Get user ids from user_list_by_location.'),
    'businessId': STR('Id of a business, to return only tasks belonging to it.'),
    'completed': BOOL('Whether to return completed tasks (true) or open ones (false). Omit for both.'),
    'query': STR('Free-text search over the task.'),
}


def _clean_location(location: Any) -> dict:
    """Trim a sub-account record to the fields this node returns."""
    if not isinstance(location, dict):
        return {}
    return {key: location[key] for key in _LOCATION_READ_KEYS if key in location}


class LocationsMixin(GoHighLevelToolsBase):
    """Tools for the ``locations`` group."""

    # -- the sub-account record --------------------------------------------

    @gohighlevel_tool(
        group='locations',
        input_schema=schema(),
        description=(
            'Get the configured sub-account, which GoHighLevel also calls a location. Takes no parameters: the '
            'sub-account id comes from node configuration and the credential can only read that one. Call this to '
            'find the companyId (the agency id) that user_search requires, or to read the sub-account name, '
            'address, timezone and business details before writing records that depend on them. Listing or '
            'searching other sub-accounts is an agency-level operation this node does not offer.'
        ),
        output_schema=RECORD_OUTPUT(
            'The sub-account, trimmed to the fields this node returns. companyId is the agency the sub-account '
            'belongs to, and timezone is an IANA name such as "America/Los_Angeles".'
        ),
    )
    def location_get(self, args):
        args = self._args(args, 'location_get')
        return self._get(f'/locations/{self._location()}', _clean_location, key='location')

    # -- tasks --------------------------------------------------------------

    @gohighlevel_tool(
        group='locations',
        input_schema=schema(**_TASK_SEARCH_PROPS, **PAGING_SKIP_BODY('location_tasks_search')),
        description=(
            'Search tasks across the whole sub-account, optionally narrowed by contact, assignee, business, '
            'completion state or free text. This is the only way to see tasks that are not tied to a contact you '
            'already know: contact_tasks_list needs a contactId. It is read-only, so create, update and complete '
            'go through the contact task tools. Task records come back exactly as GoHighLevel sends them, since '
            'the vendor publishes no schema for them, and this route names the task id _id while the '
            'contact-scoped route names the same field id. Pages by offset: next is the skip value for the '
            'following page.'
        ),
        output_schema=LIST_OUTPUT(
            'Offset for the next page: pass it back as the skip parameter. Null once a page comes back shorter '
            'than the limit asked for, which means there is no next page.',
            items=(
                'The tasks on this page, verbatim. GoHighLevel declares no schema for them; the observed record '
                'carries _id, locationId, title, dueDate, completed, status, statusGroup, contactId, '
                'contactDetails, assignedToUserDetails, businessId, dateAdded and dateUpdated.'
            ),
        ),
    )
    def location_tasks_search(self, args):
        args = self._args(args, 'location_tasks_search')
        body, limit = skip_body(args, 'location_tasks_search')
        body.update(body_from(args, _TASK_SEARCH_KEYS))
        path = f'/locations/{self._location()}/tasks/search'
        _payload, records = self._fetch('POST', path, key='tasks', body=body)
        return paginated(
            [passthrough(record) for record in records],
            next_cursor=next_offset(args.get('skip'), limit, len(records)),
            requested_limit=limit,
        )
