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

"""Opportunity tools: the opportunity record plus its status, its followers and the two searches."""

from __future__ import annotations

from typing import Any

from ..gohighlevel_client import paginated, split_custom_fields
from ..tool_groups import gohighlevel_tool
from ._base import (
    ARR,
    BOOL,
    CUSTOM_FIELDS_DESC,
    ENUM,
    EXTRA,
    LIST_OUTPUT,
    MIXED_ARR,
    NUM,
    PAGING_SEARCH_AFTER_PAGE,
    PAGING_START_AFTER,
    RECORD_OUTPUT,
    STR,
    GoHighLevelToolsBase,
    body_from,
    bool_params,
    flag_result,
    follower_result,
    params_from,
    require_id,
    require_text,
    schema,
    search_after_cursor,
    search_after_page_body,
    start_after_cursor,
    start_after_params,
    upsert_result,
)

#: Fields kept from an opportunity record.
#:
#: The tuple is the union of what the spec declares and what a live search actually returned,
#: because the two disagree: ``pipelineStageUId``, ``relations``, ``forecastProbability`` and
#: ``effectiveProbability`` came back on a real record and appear in no response schema, and
#: the vendor's own docs repo carries a standing pile of "API field missing" bugs, so the live
#: capture wins.
#:
#: ``notes``, ``tasks``, ``calendarEvents`` and ``followers`` are declared ``any[][]`` in both
#: the spec and the official SDK, which describes no field at all, so they are kept and passed
#: through rather than projected. ``indexVersion`` is left out: it is declared a string, its
#: own example is the integer 1, and it means nothing to an agent.
_OPPORTUNITY_READ_KEYS = (
    'id',
    'name',
    'locationId',
    'contactId',
    'contact',
    'pipelineId',
    'pipelineStageId',
    'pipelineStageUId',
    'status',
    'lostReasonId',
    'monetaryValue',
    'assignedTo',
    'source',
    'followers',
    'relations',
    'notes',
    'tasks',
    'calendarEvents',
    'forecastProbability',
    'effectiveProbability',
    'lastStatusChangeAt',
    'lastStageChangeAt',
    'lastActionDate',
    'createdAt',
    'updatedAt',
    'externalObjectId',
)

#: Body fields shared by opportunity_create and opportunity_update.
#:
#: ``locationId`` is absent: the node supplies it from config on create, and the update body
#: has no such property at all. ``contactId`` is absent too, because it is create-only (see
#: :data:`_CREATE_ONLY_KEYS`).
_OPPORTUNITY_WRITE_KEYS = (
    'pipelineId',
    'pipelineStageId',
    'name',
    'status',
    'monetaryValue',
    'assignedTo',
    'customFields',
)

#: Fields CreateDto declares and UpdateOpportunityDto does not.
#:
#: An opportunity is attached to its contact when it is created and the contact cannot be
#: changed afterwards: the update body declares no ``contactId``, and GoHighLevel answers an
#: undeclared property with a 422 rather than ignoring it. Offering it on opportunity_update
#: would show the agent a parameter whose only outcome is a hard vendor error. This is the
#: same create-versus-update policy the contacts module follows.
_CREATE_ONLY_KEYS = ('contactId',)

#: The status values that mean something on a write.
#:
#: The spec's enum carries a fifth value, ``all``, on create, update, upsert and the status
#: write. ``all`` is a search filter rather than a state an opportunity can be in, so it is
#: offered on opportunity_search and withheld from every write.
_WRITE_STATUSES = ('open', 'won', 'lost', 'abandoned')
_SEARCH_STATUSES = ('open', 'won', 'lost', 'abandoned', 'all')

_STATUS_DESC = (
    'Stage of the deal: "open" while it is live, then "won", "lost" or "abandoned". Pass a lostReasonId '
    'alongside "lost" when the sub-account has lost reasons configured; lost_reason_list returns them. Only '
    'opportunity_status_update and opportunity_upsert take lostReasonId, so use one of those to record a '
    'lost reason.'
)

_CUSTOM_FIELDS_WRITE = MIXED_ARR(
    f'Custom field values to set on the opportunity. {CUSTOM_FIELDS_DESC} Opportunity custom fields are '
    'defined on the sub-account rather than on the pipeline, and they are the ones custom_field_list '
    'reports against the opportunity model.'
)

_OPPORTUNITY_WRITE_PROPS = {
    'pipelineId': STR('Id of the pipeline the opportunity sits in. Get pipeline ids from pipeline_list.'),
    'pipelineStageId': STR(
        'Id of the stage within that pipeline. Stage ids are carried inside the stages array on the records '
        'pipeline_list returns; there is no endpoint that lists stages on their own.'
    ),
    'name': STR('Name of the opportunity, for example "Website redesign".'),
    'status': ENUM(_STATUS_DESC, _WRITE_STATUSES),
    'monetaryValue': NUM('Value of the deal, as a number in the sub-account currency.'),
    'assignedTo': STR('Id of the user the opportunity is assigned to. Get user ids from user_list_by_location.'),
    'customFields': _CUSTOM_FIELDS_WRITE,
    'extra': EXTRA(),
}

#: Body keys and schema properties for opportunity_create only.
_OPPORTUNITY_CREATE_KEYS = _OPPORTUNITY_WRITE_KEYS + _CREATE_ONLY_KEYS
_OPPORTUNITY_CREATE_PROPS = {
    **_OPPORTUNITY_WRITE_PROPS,
    'contactId': STR(
        'Id of the contact the opportunity belongs to. Required, and it cannot be changed afterwards: '
        'opportunity_update does not accept it. Get contact ids from contact_search.'
    ),
}

#: Body keys and schema properties for opportunity_upsert.
#:
#: A different set again, and not a subset of either write. UpsertOpportunityDto declares no
#: ``contactId`` and no ``customFields``, and it declares three follower fields the other
#: writes do not have. It also declares ``monetaryValue`` as an object while create and update
#: declare the same field a number; the number is what the other two take and what the spec's
#: own example shows, so it is typed as one here.
_OPPORTUNITY_UPSERT_KEYS = (
    'id',
    'pipelineId',
    'pipelineStageId',
    'name',
    'status',
    'monetaryValue',
    'assignedTo',
    'lostReasonId',
    'followers',
    'isRemoveAllFollowers',
    'followersActionType',
)

_OPPORTUNITY_UPSERT_PROPS = {
    'id': STR(
        'Id of an existing opportunity to update. Omit it to create one. This is the only field that '
        'identifies an existing record: the upsert body declares no contactId.'
    ),
    'pipelineId': _OPPORTUNITY_WRITE_PROPS['pipelineId'],
    'pipelineStageId': _OPPORTUNITY_WRITE_PROPS['pipelineStageId'],
    'name': _OPPORTUNITY_WRITE_PROPS['name'],
    'status': ENUM(_STATUS_DESC, _WRITE_STATUSES),
    'monetaryValue': _OPPORTUNITY_WRITE_PROPS['monetaryValue'],
    'assignedTo': _OPPORTUNITY_WRITE_PROPS['assignedTo'],
    'lostReasonId': STR('Id of the reason the deal was lost. Get lost reason ids from lost_reason_list.'),
    'followers': ARR(
        'Ids to add or remove as followers, according to followersActionType. Leave it out to touch no '
        'followers: this tool then sends an empty list, which the endpoint requires. GoHighLevel labels this '
        'field contactId here and user ids everywhere else, so prefer opportunity_followers_add, which is '
        'unambiguous.'
    ),
    'isRemoveAllFollowers': BOOL(
        'Whether to strip every follower off the opportunity. Defaults to false, which is what is sent when '
        'this is omitted.'
    ),
    'followersActionType': ENUM('What to do with the ids in followers. Defaults to "add".', ('add', 'remove')),
    'extra': EXTRA(),
}

#: What an opportunity read returns for custom fields, stated once because several tools
#: return one. The direction mismatch is real and it is not the same one contacts have:
#: opportunities write ``field_value`` and read ``fieldValue``.
_OPPORTUNITY_CUSTOM_FIELDS_READ = (
    'Custom field values come back as one object keyed by field id, or verbatim when GoHighLevel sends '
    'them in a shape this node does not recognise. Neither is the array shape opportunity_create and '
    'opportunity_update take, and the value is spelled fieldValue on the way out and field_value on the '
    'way in, so a record from a read cannot be sent back unchanged.'
)

_OPPORTUNITY_RECORD_OUTPUT = RECORD_OUTPUT(
    f'The opportunity, trimmed to the fields this node returns. {_OPPORTUNITY_CUSTOM_FIELDS_READ}'
)

_OPPORTUNITY_ITEMS = 'The opportunities on this page, each trimmed to the fields this node returns.'

_FOLLOWERS_SHAPE = (
    'GoHighLevel types the followers array on the opportunity record as an array of arrays, which '
    'describes no field, so treat whatever comes back as opaque.'
)


def _clean_opportunity(opportunity: Any) -> dict:
    """Trim an opportunity record and project its custom fields into a dict keyed by field id.

    The projection is a best effort rather than a filter, exactly as on contacts: a value in a
    shape the projection does not recognise is handed back as it arrived, because losing data
    silently is worse than returning a shape the agent has to look at.
    """
    if not isinstance(opportunity, dict):
        return {}
    out = {key: opportunity[key] for key in _OPPORTUNITY_READ_KEYS if key in opportunity}
    raw = opportunity.get('customFields')
    if raw is not None:
        custom = split_custom_fields(raw)
        out['customFields'] = custom or raw
    return out


def _opportunity_total(payload: Any) -> Any:
    """Total matching records for a search, under whichever key that route reports it.

    The two searches sit on one path and answer differently: the GET puts the count in
    ``meta.total`` and the POST puts it at the root under ``total`` with no ``meta`` at all.
    """
    if not isinstance(payload, dict):
        return None
    meta = payload.get('meta')
    if isinstance(meta, dict) and meta.get('total') is not None:
        return meta['total']
    return payload.get('total')


def _search_cursor(payload: Any, records: Any) -> dict | None:
    """Style A cursor for GET /opportunities/search, from ``meta`` first and the records second.

    This endpoint reports the pair in ``meta`` while the contacts list carries it on each
    record, and both have been observed, so both are read. ``meta.nextPageUrl`` is never
    followed: its documented example leaks a localhost address.
    """
    meta = payload.get('meta') if isinstance(payload, dict) else None
    if isinstance(meta, dict):
        after = meta.get('startAfter')
        after_id = meta.get('startAfterId')
        if after is not None and after_id is not None:
            return {'startAfter': after, 'startAfterId': after_id}
    return start_after_cursor(records)


def _upsert_result(payload: Any) -> dict:
    """Upsert response: the opportunity, plus whether it was created rather than updated."""
    return upsert_result(payload, 'opportunity', _clean_opportunity)


class OpportunitiesMixin(GoHighLevelToolsBase):
    """Tools for the ``opportunities`` group."""

    # -- searching ---------------------------------------------------------

    @gohighlevel_tool(
        group='opportunities',
        input_schema=schema(
            **PAGING_START_AFTER('opportunity_search'),
            q=STR('Free-text search across the opportunity and its contact, for example an email address.'),
            pipeline_id=STR('Return only opportunities in this pipeline. Get pipeline ids from pipeline_list.'),
            pipeline_stage_id=STR('Return only opportunities sitting in this stage of that pipeline.'),
            contact_id=STR('Return only opportunities belonging to this contact.'),
            status=ENUM(
                'Return only opportunities in this state. "all" means every state, which is also what '
                'omitting this does.',
                _SEARCH_STATUSES,
            ),
            assigned_to=STR('Return only opportunities assigned to this user id.'),
            campaignId=STR('Return only opportunities attributed to this campaign id.'),
            id=STR('Return only the opportunity with this id. opportunity_get is the direct way to fetch one.'),
            order=STR('Sort order, for example "added_asc". GoHighLevel publishes no list of the values it takes.'),
            date=STR('Start of the date range to search, formatted mm-dd-yyyy, which is what this endpoint takes.'),
            endDate=STR('End of the date range to search, formatted mm-dd-yyyy.'),
            country=STR('2-letter country code to filter on, for example "US".'),
            getTasks=BOOL('Whether to include the tasks on each opportunity.'),
            getNotes=BOOL('Whether to include the notes on each opportunity.'),
            getCalendarEvents=BOOL('Whether to include the calendar events on each opportunity.'),
        ),
        description=(
            'Find opportunities in the configured sub-account, filtered by pipeline, stage, contact, status, '
            'assignee or free text. This is the way to list opportunities: GoHighLevel has no plain list '
            'endpoint for them. Use it to answer "what is in this stage", "what is this contact working on" '
            'and "which deals did we win". Returns opportunities under items, each carrying its pipelineId and '
            'pipelineStageId, which pipeline_list turns into names. next holds {"startAfter", "startAfterId"}: '
            'pass those two values back as the startAfter and startAfterId parameters, and ask for another page '
            'only while has_more is true. Prefer this over opportunity_search_advanced unless you need the '
            'unread-conversation counts only that one returns.'
        ),
        output_schema=LIST_OUTPUT(
            'Cursor for the next page: an object holding startAfter and startAfterId. Pass both back as the '
            'startAfter and startAfterId parameters. Null when there is no next page.',
            items=_OPPORTUNITY_ITEMS,
        ),
    )
    def opportunity_search(self, args):
        args = self._args(args, 'opportunity_search')
        params, limit = start_after_params(args, 'opportunity_search')
        params.update(
            params_from(
                args,
                (
                    'q',
                    'pipeline_id',
                    'pipeline_stage_id',
                    'contact_id',
                    'status',
                    'assigned_to',
                    'campaignId',
                    'id',
                    'order',
                    'date',
                    'endDate',
                    'country',
                ),
            )
        )
        params.update(bool_params(args, ('getTasks', 'getNotes', 'getCalendarEvents')))
        # snake_case, and the only endpoint on this surface that spells it that way. The
        # camelCase form is live-confirmed to fail: 422 "property locationId should not exist".
        params['location_id'] = self._location()
        payload, records = self._fetch('GET', '/opportunities/search', key='opportunities', params=params)
        return paginated(
            [_clean_opportunity(record) for record in records],
            total=_opportunity_total(payload),
            next_cursor=_search_cursor(payload, records),
            requested_limit=limit,
        )

    @gohighlevel_tool(
        group='opportunities',
        input_schema=schema(
            **PAGING_SEARCH_AFTER_PAGE('opportunity_search_advanced'),
            query=STR('Free-text search across the opportunity and its contact. Sent as an empty string when omitted.'),
            includeNotes=BOOL('Whether to include the notes on each opportunity.'),
            includeTasks=BOOL('Whether to include the tasks on each opportunity.'),
            includeCalendarEvents=BOOL('Whether to include the calendar events on each opportunity.'),
            includeUnreadConversations=BOOL('Whether to include the unread conversation counts on each opportunity.'),
        ),
        description=(
            'Search opportunities in the configured sub-account by free text, and optionally pull their notes, '
            'tasks, calendar events and unread conversation counts back in the same call. Use opportunity_search '
            'instead for anything else: this one cannot filter by pipeline, stage, contact, status or assignee, '
            'and the unread conversation counts are the only thing it returns that the other does not. It does '
            'report total, which the other only sometimes does. Returns opportunities under items. next holds an '
            'opaque searchAfter value to pass back unchanged, and another page should be asked for only while '
            'has_more is true.'
        ),
        output_schema=LIST_OUTPUT(
            'Cursor for the next page: the opaque searchAfter value carried by the last record of this page. '
            'Pass it back unchanged as the searchAfter parameter. Null when there is no next page.',
            items=_OPPORTUNITY_ITEMS,
        ),
    )
    def opportunity_search_advanced(self, args):
        args = self._args(args, 'opportunity_search_advanced')
        body, limit = search_after_page_body(args, 'opportunity_search_advanced')
        # This body declares all six of its fields required, so five of them are always sent
        # with a harmless value. "page" is the exception: the vendor documents it 1-based on
        # the GET form of this path and 0-based on the v3 spec for the same path, so a default
        # would silently skip or repeat the first page under one of the two readings. It is
        # sent only when the agent asks for it, and searchAfter is the cursor to prefer.
        body['locationId'] = self._location()
        body.setdefault('searchAfter', [])
        body['query'] = args.get('query') or ''
        body['additionalDetails'] = {
            'notes': bool(args.get('includeNotes')),
            'tasks': bool(args.get('includeTasks')),
            'calendarEvents': bool(args.get('includeCalendarEvents')),
            'unReadConversations': bool(args.get('includeUnreadConversations')),
        }
        payload, records = self._fetch('POST', '/opportunities/search', key='opportunities', body=body)
        return paginated(
            [_clean_opportunity(record) for record in records],
            total=_opportunity_total(payload),
            next_cursor=search_after_cursor(records),
            requested_limit=limit,
        )

    # -- the opportunity record --------------------------------------------

    @gohighlevel_tool(
        group='opportunities',
        input_schema=schema(required=['opportunityId'], opportunityId=STR('Id of the opportunity.')),
        description=(
            'Get one opportunity by id. The record carries its followers inline, and that is the only way to '
            f'read them: GoHighLevel has no endpoint that lists an opportunity followers. {_FOLLOWERS_SHAPE} '
            f'{_OPPORTUNITY_CUSTOM_FIELDS_READ}'
        ),
        output_schema=_OPPORTUNITY_RECORD_OUTPUT,
    )
    def opportunity_get(self, args):
        args = self._args(args, 'opportunity_get')
        opportunity_id = require_id(args, 'opportunityId', 'opportunity_get')
        return self._get(f'/opportunities/{opportunity_id}', _clean_opportunity, key='opportunity')

    @gohighlevel_tool(
        group='opportunities',
        writes=True,
        input_schema=schema(
            required=['pipelineId', 'name', 'status', 'contactId'],
            **_OPPORTUNITY_CREATE_PROPS,
        ),
        description=(
            'Create an opportunity in the configured sub-account, against a pipeline and a contact. All four of '
            'pipelineId, name, status and contactId are required: get the pipeline id from pipeline_list and the '
            'contact id from contact_search, and open is the status a new deal normally starts in. The contact '
            'cannot be changed afterwards. Pass pipelineStageId to place the deal in a specific stage, otherwise '
            'GoHighLevel puts it in the first one.'
        ),
        output_schema=_OPPORTUNITY_RECORD_OUTPUT,
    )
    def opportunity_create(self, args):
        args = self._args(args, 'opportunity_create')
        require_id(args, 'pipelineId', 'opportunity_create')
        require_id(args, 'contactId', 'opportunity_create')
        require_text(args, 'name', 'opportunity_create')
        require_text(args, 'status', 'opportunity_create')
        body = body_from(args, _OPPORTUNITY_CREATE_KEYS, tool='opportunity_create')
        body['locationId'] = self._location()
        # The trailing slash is load-bearing: the path is registered as /opportunities/.
        return self._write('POST', '/opportunities/', _clean_opportunity, key='opportunity', body=body)

    @gohighlevel_tool(
        group='opportunities',
        writes=True,
        input_schema=schema(
            required=['opportunityId'],
            opportunityId=STR('Id of the opportunity to update.'),
            **_OPPORTUNITY_WRITE_PROPS,
        ),
        description=(
            'Update an opportunity. Only the fields you pass are changed. This is also how a deal is moved '
            'between stages and between pipelines: pass pipelineStageId, and pipelineId too when the stage '
            'belongs to a different pipeline. There is no separate stage endpoint. Sending customFields replaces '
            'only the fields you name. The contact an opportunity belongs to cannot be changed, so this tool '
            'takes no contactId even though opportunity_create requires one. Use opportunity_status_update when '
            'the status is all you are changing, since that one takes a lost reason with it.'
        ),
        output_schema=_OPPORTUNITY_RECORD_OUTPUT,
    )
    def opportunity_update(self, args):
        args = self._args(args, 'opportunity_update')
        opportunity_id = require_id(args, 'opportunityId', 'opportunity_update')
        body = body_from(args, _OPPORTUNITY_WRITE_KEYS, tool='opportunity_update')
        return self._write('PUT', f'/opportunities/{opportunity_id}', _clean_opportunity, key='opportunity', body=body)

    @gohighlevel_tool(
        group='opportunities',
        writes=True,
        input_schema=schema(required=['opportunityId'], opportunityId=STR('Id of the opportunity to delete.')),
        description=(
            'Delete an opportunity by id. Prefer opportunity_status_update with "lost" or "abandoned" when the '
            'deal simply did not close: that keeps the record and its history, and a delete does not.'
        ),
        output_schema=RECORD_OUTPUT(
            'Whether the delete succeeded, under deleted, with the raw GoHighLevel response under data.'
        ),
    )
    def opportunity_delete(self, args):
        args = self._args(args, 'opportunity_delete')
        opportunity_id = require_id(args, 'opportunityId', 'opportunity_delete')
        return self._delete(f'/opportunities/{opportunity_id}')

    @gohighlevel_tool(
        group='opportunities',
        writes=True,
        input_schema=schema(required=['pipelineId'], **_OPPORTUNITY_UPSERT_PROPS),
        description=(
            'Update an opportunity when you pass its id, or create one when you do not. Returns the opportunity '
            'plus new, which is true when one was created. Reach for opportunity_create and opportunity_update '
            'first: this endpoint takes no contactId, so an opportunity it creates is not attached to anyone, '
            'and it takes no customFields either. It is worth using when you hold an id that may or may not '
            'still exist, or when you want to set followers in the same call as the rest of the record.'
        ),
        output_schema=RECORD_OUTPUT(
            'The opportunity under opportunity, trimmed to the fields this node returns, plus new, which is '
            'true when an opportunity was created rather than updated.'
        ),
    )
    def opportunity_upsert(self, args):
        args = self._args(args, 'opportunity_upsert')
        require_id(args, 'pipelineId', 'opportunity_upsert')
        body = body_from(args, _OPPORTUNITY_UPSERT_KEYS, tool='opportunity_upsert')
        # The upsert body declares its three follower fields required, so all three are always
        # sent. The defaults are the no-op combination: an empty add that removes nothing.
        body.setdefault('followers', [])
        body.setdefault('isRemoveAllFollowers', False)
        body.setdefault('followersActionType', 'add')
        body['locationId'] = self._location()
        return self._write('POST', '/opportunities/upsert', _upsert_result, body=body)

    # -- status ------------------------------------------------------------

    @gohighlevel_tool(
        group='opportunities',
        writes=True,
        input_schema=schema(
            required=['opportunityId', 'status'],
            opportunityId=STR('Id of the opportunity.'),
            status=ENUM(_STATUS_DESC, _WRITE_STATUSES),
            lostReasonId=STR(
                'Id of the reason the deal was lost, which goes with a status of "lost". Get lost reason ids '
                'from lost_reason_list.'
            ),
        ),
        description=(
            'Move an opportunity to won, lost, abandoned or back to open. This is the tool for closing a deal, '
            'because it is the only one that takes a lost reason with the status. It answers with a flag rather '
            'than the record, so call opportunity_get afterwards if you need the updated opportunity.'
        ),
        output_schema=RECORD_OUTPUT('ok is true when GoHighLevel reported the status change as successful.'),
    )
    def opportunity_status_update(self, args):
        args = self._args(args, 'opportunity_status_update')
        opportunity_id = require_id(args, 'opportunityId', 'opportunity_status_update')
        require_text(args, 'status', 'opportunity_status_update')
        body = body_from(args, ('status', 'lostReasonId'))
        return self._write('PUT', f'/opportunities/{opportunity_id}/status', flag_result, body=body)

    # -- followers ---------------------------------------------------------

    @gohighlevel_tool(
        group='opportunities',
        writes=True,
        input_schema=schema(
            required=['opportunityId', 'followers'],
            opportunityId=STR('Id of the opportunity.'),
            followers=ARR('User ids to add as followers. Get user ids from user_list_by_location.'),
        ),
        description=(
            'Add users as followers of an opportunity, so they are notified as it moves. There is no endpoint '
            'that lists an opportunity followers, so read the followers array on the record opportunity_get '
            f'returns. {_FOLLOWERS_SHAPE}'
        ),
        output_schema=RECORD_OUTPUT(
            'The opportunity whole follower list after the change, under followers, plus followersAdded when '
            'GoHighLevel reports which ids it added.'
        ),
    )
    def opportunity_followers_add(self, args):
        args = self._args(args, 'opportunity_followers_add')
        opportunity_id = require_id(args, 'opportunityId', 'opportunity_followers_add')
        body = body_from(args, ('followers',))
        return self._write('POST', f'/opportunities/{opportunity_id}/followers', follower_result, body=body)

    @gohighlevel_tool(
        group='opportunities',
        writes=True,
        input_schema=schema(
            required=['opportunityId', 'followers'],
            opportunityId=STR('Id of the opportunity.'),
            followers=ARR('User ids to remove as followers.'),
            isRemoveAllFollowers=BOOL(
                'Whether to strip every follower off the opportunity instead of only the ids listed in followers.'
            ),
        ),
        description=(
            'Remove followers from an opportunity, by user id, or clear them all with isRemoveAllFollowers. '
            'Returns the followers the opportunity still has.'
        ),
        output_schema=RECORD_OUTPUT(
            'The opportunity whole follower list after the change, under followers, plus followersRemoved when '
            'GoHighLevel reports which ids it removed.'
        ),
    )
    def opportunity_followers_remove(self, args):
        args = self._args(args, 'opportunity_followers_remove')
        opportunity_id = require_id(args, 'opportunityId', 'opportunity_followers_remove')
        body = body_from(args, ('followers',))
        params = bool_params(args, ('isRemoveAllFollowers',))
        return self._write(
            'DELETE',
            f'/opportunities/{opportunity_id}/followers',
            follower_result,
            body=body,
            params=params,
        )
