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
Shared plumbing for the GoHighLevel tool mixins.

Holds the credential and location accessors, the read-only gate, the ``Version`` resolver,
the pagination builders and the small schema helpers every group module uses, so the tool
definitions themselves stay readable.

Three things here differ from the Pipedrive node this was ported from, and each is forced by
the API rather than chosen:

1. Record ids are opaque strings of roughly 20 to 24 characters, not integers, so
   :func:`require_id` validates a non-empty string. An integer check would reject every real
   GoHighLevel id.
2. There is no single pagination style. The one ``PAGING()`` builder became ten, one per
   style in the design brief, each paired with a function that turns the agent-supplied
   arguments into the query or body fragment that style actually sends. GoHighLevel ignores
   an unrecognised pagination parameter instead of rejecting it, so mixing styles re-fetches
   page one forever rather than failing. A tool picks one style and stays on it. Each of the
   ten renderers returns ``(fragment, limit)``: the page size travels back to the tool so it
   can be handed to :func:`paginated` as ``requested_limit``, which is what keeps ``has_more``
   honest.
3. Unknown properties are rejected with a 422, so a hallucinated parameter name is a hard
   API failure carrying vendor wording the agent cannot act on. :func:`args_of` validates the
   argument names against the schema the agent was shown and names the valid ones instead.
"""

from __future__ import annotations

from typing import Any, Iterable

from ai.common.utils import normalize_tool_input, require_str, validate_tool_input_schema

from ..gohighlevel_client import (
    DEFAULT_PAGE_LIMIT,
    PAGE_MINIMUMS,
    call,
    call_envelope,
    clamp_limit,
    normalize_success,
    page_limit,
    paginated,
    version_for,
)

TOOL_NAME = 'tool_gohighlevel'

#: Guidance for writing custom fields, in terms of this node's own input and output rather
#: than GoHighLevel's wire shape. Defined once because every module that writes custom fields
#: needs the same sentence, and because the direction mismatch it describes is the easiest way
#: for an agent to get a write rejected: read tools here return a map, write tools take an
#: array, and the two are not interchangeable.
CUSTOM_FIELDS_DESC = (
    'The value is an array of {"id": "<field id>", "field_value": <value>} objects, never an object '
    'map: GoHighLevel rejects a map. Get field ids from custom_field_list. Read tools in this node '
    'return custom fields the other way round, as one object keyed by field id '
    '({"<field id>": <value>}), so convert that object back into the array form before sending it: '
    'a record from a get tool cannot be passed here unchanged.'
)

#: Appended to the description of every tool that takes the ``extra`` escape hatch.
EXTRA_DESC = (
    'Any additional GoHighLevel API fields to send verbatim, merged into the request body after '
    f'the typed parameters. Custom fields go here under customFields. {CUSTOM_FIELDS_DESC} '
    'Do not send tags here. On update and upsert GoHighLevel replaces every tag on the record '
    'instead of adding to the ones already on it, which is why these tools have no tags '
    'parameter, and sending tags in extra is rejected before the request goes out. Use '
    'contact_tags_add and contact_tags_remove to change tags.'
)

#: Keys the ``extra`` escape hatch must never carry, mapped to what to do instead.
#:
#: ``extra`` exists so an agent can reach a field the typed schema does not cover, but a field
#: a tool deliberately refuses is not such a field. ``tags`` is destructive on update and
#: upsert: GoHighLevel replaces the whole tag array rather than appending to it, so one call
#: carrying tags wipes every tag the agent did not list. The tools advertise that they cannot
#: touch tags, so the guarantee is enforced here rather than merely requested in prose.
EXTRA_FORBIDDEN: dict[str, str] = {
    'tags': (
        'GoHighLevel replaces every tag on the record rather than adding to them, so sending tags '
        'on an update or upsert deletes the ones you did not list. Use contact_tags_add and '
        'contact_tags_remove instead.'
    ),
}


# ---------------------------------------------------------------------------
# Schema builders
# ---------------------------------------------------------------------------


def passthrough(value: Any) -> Any:
    """Response cleaner that returns the payload untouched.

    Used for endpoints whose payload is already small, or whose shape varies (several
    calendar routes answer a bare list and free-slots answers a map keyed by date), where
    ``dict`` would raise.
    """
    return value


def schema(*, required: Iterable[str] = (), **properties: dict) -> dict:
    """Build a tool input schema from keyword properties."""
    out: dict = {'type': 'object', 'properties': properties}
    required = list(required)
    if required:
        out['required'] = required
    return out


def INT(description: str) -> dict:
    return {'type': 'integer', 'description': description}


def NUM(description: str) -> dict:
    return {'type': 'number', 'description': description}


def STR(description: str) -> dict:
    return {'type': 'string', 'description': description}


def BOOL(description: str) -> dict:
    return {'type': 'boolean', 'description': description}


def OBJ(description: str) -> dict:
    return {'type': 'object', 'description': description}


def ENUM(description: str, values: Iterable[Any]) -> dict:
    return {'type': 'string', 'enum': list(values), 'description': description}


def ARR(description: str, item_type: str = 'string') -> dict:
    return {'type': 'array', 'items': {'type': item_type}, 'description': description}


def MIXED_ARR(description: str) -> dict:
    """Array property with no declared item type.

    The cursor arrays are heterogeneous: ``startAfter`` and ``searchAfter`` are both
    ``[epoch_milliseconds, id]``, so declaring string items would invite the agent to
    stringify the timestamp.
    """
    return {'type': 'array', 'description': description}


def EXTRA() -> dict:
    return OBJ(EXTRA_DESC)


# ---------------------------------------------------------------------------
# Output schemas
#
# ``gohighlevel_tool(output_schema=...)`` reaches ``tool_function``, which emits it as
# ``outputSchema`` on the published descriptor, so this is the one channel that tells an agent
# what comes back without it having to call the tool first. Every list tool returns the
# :func:`paginated` envelope, which is this node's own invention rather than anything
# GoHighLevel sends, so an agent has no way to guess it. Pass one of these on every tool.
# ---------------------------------------------------------------------------


def LIST_OUTPUT(next_description: str, *, items: str = 'The records on this page.') -> dict:
    """Output schema for a tool that returns the :func:`paginated` envelope.

    ``next_description`` says what the cursor is for this one endpoint and how to send it back,
    because there is no shared answer: it is a ``{"startAfter", "startAfterId"}`` pair on the
    contacts list, an opaque array on the searches, an integer offset on the offset styles and
    null on the endpoints that return everything at once.
    """
    return {
        'type': 'object',
        'properties': {
            'items': {'type': 'array', 'items': {'type': 'object'}, 'description': items},
            'count': INT('How many records are in items. This is the page, not the whole result.'),
            'total': {
                'description': (
                    'Total matching records, when GoHighLevel reports one. Most endpoints report none '
                    'and leave this null, so null means unknown rather than zero.'
                )
            },
            'next': {'description': next_description},
            'has_more': BOOL('Whether another page is expected. Ask for the next page only while this is true.'),
        },
        'required': ['items', 'count', 'has_more'],
    }


def RECORD_OUTPUT(description: str = 'The record, trimmed to the fields this node returns.') -> dict:
    """Output schema for a tool that returns one record."""
    return OBJ(description)


# ---------------------------------------------------------------------------
# Argument helpers
# ---------------------------------------------------------------------------


def args_of(args: Any, input_schema: dict | None = None, tool: str = '') -> dict:
    """Normalise agent-supplied tool input to a plain dict, and reject undeclared parameters.

    Pass ``input_schema`` and ``tool`` to get the name check. It is worth having here in a way
    it was not on the Pipedrive node: GoHighLevel answers 422 for a property it does not know,
    with wording like ``property locationId should not exist``, which reads to an agent as a
    server fault rather than as its own mistake. Validating locally turns that into a message
    naming the parameters this tool accepts.

    In a tool body prefer :meth:`GoHighLevelToolsBase._args`, which looks the schema up from
    the decorated method so the two can never drift apart.
    """
    out = normalize_tool_input(args, tool_name=TOOL_NAME)
    if input_schema:
        validate_tool_input_schema(input_schema, out, tool_name=tool or TOOL_NAME)
    return out


def body_from(
    args: dict,
    keys: Iterable[str],
    *,
    extra_key: str = 'extra',
    tool: str = '',
    forbidden: dict[str, str] | None = None,
) -> dict:
    """Collect the provided typed keys into a request body, then merge ``extra``.

    Keys absent from ``args`` are omitted entirely so a PUT never blanks a field the agent did
    not mention, and so nothing undeclared reaches the API: GoHighLevel rejects an unknown
    property with a 422 rather than ignoring it.

    ``extra`` is merged verbatim, which is the point of it, so it is also a way around every
    field a tool deliberately leaves out. :data:`EXTRA_FORBIDDEN` names the fields where that
    is destructive rather than merely undeclared, and they raise here with the safe tool named.
    Pass ``forbidden={}`` on a tool that genuinely owns one of those fields.
    """
    body = {k: args[k] for k in keys if args.get(k) is not None}
    extra = args.get(extra_key)
    if not isinstance(extra, dict):
        return body
    blocked = EXTRA_FORBIDDEN if forbidden is None else forbidden
    for key, reason in blocked.items():
        if key in extra:
            label = f'{tool}: ' if tool else ''
            raise ValueError(f'{label}"{key}" cannot be sent through "{extra_key}". {reason}')
    body.update(extra)
    return body


def params_from(args: dict, keys: Iterable[str]) -> dict:
    """Collect the provided keys into a query-parameter dict."""
    return {k: args[k] for k in keys if args.get(k) is not None}


def bool_params(args: dict, keys: Iterable[str]) -> dict:
    """Render the supplied boolean arguments as the lowercase strings the query string needs.

    ``requests`` renders a Python ``True`` into a query string as ``True``, and GoHighLevel
    validates query parameters strictly enough to answer 422 for a value it does not
    recognise, so the capitalised form cannot be sent. ``False`` is sent rather than dropped,
    because dropping it would silently mean "no filter" instead of "only the records where
    this is false". Anything that is not a real boolean is dropped rather than coerced:
    guessing at ``"yes"`` would send a filter the agent did not ask for, and Python truthiness
    would render the string ``"false"`` as ``'true'``.
    """
    out: dict = {}
    for key in keys:
        value = args.get(key)
        if isinstance(value, bool):
            out[key] = 'true' if value else 'false'
    return out


def require_id(args: dict, key: str, tool: str) -> str:
    """Read a required record id.

    GoHighLevel ids are opaque strings of roughly 20 to 24 characters, so this is a string
    check. The Pipedrive node validates ids as integers, which would reject every real id
    here.
    """
    return require_str(args, key, tool_name=tool)


def require_text(args: dict, key: str, tool: str) -> str:
    return require_str(args, key, tool_name=tool)


# ---------------------------------------------------------------------------
# Pagination
#
# Ten styles, one section per style, lettered as in the design brief. Each style is a schema
# builder that supplies the properties an agent sees, plus the function that renders those
# arguments into the query or body fragment the endpoint accepts. The page size is per
# endpoint (20 for appointment notes, 100 for contacts, 500 for the message export), so every
# builder takes the tool name and reads its own ceiling.
#
# The parameter names below are the ones the API actually takes, which are not uniform: the
# contacts list pages on startAfter plus startAfterId, POST /contacts/search calls the same
# idea searchAfter and calls the page size pageLimit rather than limit, and
# GET /opportunities/search takes the sub-account as location_id in snake case while every
# other endpoint on this surface spells it locationId. An unrecognised pagination parameter is
# ignored rather than rejected, so getting a name wrong re-fetches page one forever.
#
# Every renderer returns ``(fragment, limit)`` and always sends a limit, even when the agent
# supplied none. Both halves matter. Sending it makes the page size a number the tool knows
# instead of an undocumented server default, and returning it lets the tool pass
# ``requested_limit=`` to paginated(), which is the only way has_more can be right: these
# cursors are carried on the records rather than on the response root, so a cursor exists on
# the last page too and cursor presence alone claims another page on every listing that fits
# in one.
# ---------------------------------------------------------------------------


def _limit(tool: str, note: str = '') -> dict:
    """Limit property whose stated range is the one this endpoint actually accepts."""
    floor = PAGE_MINIMUMS.get(tool, 1)
    ceiling = page_limit(tool)
    sent = max(floor, min(DEFAULT_PAGE_LIMIT, ceiling))
    text = f'Number of records to return ({floor}-{ceiling}). {sent} is sent when this is omitted.'
    return INT(f'{text} {note}' if note else text)


def _int_arg(args: dict, key: str, floor: int = 0) -> int | None:
    """Read one pagination argument as an int, or None when it is absent or unusable."""
    value = args.get(key)
    if value is None:
        return None
    try:
        return max(floor, int(value))
    except (TypeError, ValueError):
        return None


# -- style A: twin cursor (GET /contacts/, GET /opportunities/search) -------


def PAGING_START_AFTER(tool: str) -> dict:
    """Style A schema properties: the ``startAfter`` plus ``startAfterId`` twin cursor."""
    return {
        'startAfter': INT('Cursor: the startAfter value from the previous call, which is epoch milliseconds.'),
        'startAfterId': STR('Cursor: the startAfterId value from the previous call, which is a record id.'),
        'limit': _limit(tool),
    }


def start_after_params(args: dict, tool: str) -> tuple[dict, int]:
    """Style A query parameters, plus the page size sent.

    ``startAfter`` and ``startAfterId`` are the names both endpoints on this style take, and
    both must be sent together. This builder covers paging only: on
    ``GET /opportunities/search`` the tool supplies the sub-account itself as ``location_id``,
    in snake case, because that endpoint rejects the camelCase ``locationId`` with a 422.
    """
    limit = clamp_limit(tool, args.get('limit'))
    params = params_from(args, ('startAfter', 'startAfterId'))
    params['limit'] = limit
    return params, limit


# -- style B: body cursor (POST /contacts/search) ---------------------------


def PAGING_SEARCH_AFTER(tool: str) -> dict:
    """Style B schema properties: the ``searchAfter`` body cursor."""
    return {
        'searchAfter': MIXED_ARR(
            'Cursor: the next value from the previous call, passed back unchanged. GoHighLevel puts '
            'it on the last record of the page rather than on the response root, and this node '
            'surfaces it under next.'
        ),
        'limit': _limit(tool, 'Sent to the API as pageLimit, which is what this endpoint calls it.'),
    }


def search_after_body(args: dict, tool: str) -> tuple[dict, int]:
    """Style B body fragment, plus the page size sent.

    ``POST /contacts/search`` names the cursor ``searchAfter`` and the page size ``pageLimit``.
    It does not accept ``limit``, and it ignores ``startAfter``.
    """
    limit = clamp_limit(tool, args.get('limit'))
    body = params_from(args, ('searchAfter',))
    body['pageLimit'] = limit
    return body, limit


# -- style C: body cursor plus page number (POST /opportunities/search) -----


def PAGING_SEARCH_AFTER_PAGE(tool: str) -> dict:
    """Style C schema properties: the ``searchAfter`` body cursor alongside a page number."""
    return {
        'searchAfter': MIXED_ARR('Cursor: the next value from the previous call.'),
        'page': INT(
            'Page number. GoHighLevel documents this as 1-based on the v2 GET form of this path '
            'and 0-based on the v3 spec for the same path, so prefer searchAfter for deep paging.'
        ),
        'limit': _limit(tool),
    }


def search_after_page_body(args: dict, tool: str) -> tuple[dict, int]:
    """Style C body fragment, plus the page size sent.

    ``POST /opportunities/search`` takes ``searchAfter`` with ``limit``, not ``pageLimit``.
    """
    limit = clamp_limit(tool, args.get('limit'))
    body = params_from(args, ('searchAfter',))
    page = _int_arg(args, 'page')
    if page is not None:
        body['page'] = page
    body['limit'] = limit
    return body, limit


# -- style D: offset, declared as strings (GET /businesses/, GET /users/search) --


def PAGING_SKIP_TEXT(tool: str) -> dict:
    """Style D schema properties: ``skip`` plus ``limit``, which this endpoint types as strings."""
    return {
        'skip': INT('Number of records to skip, 0-based (default 0).'),
        'limit': _limit(tool),
    }


def skip_text_params(args: dict, tool: str) -> tuple[dict, int]:
    """Style D query parameters, plus the page size sent.

    Both values are stringified because the endpoint declares them as strings. The returned
    limit stays an int, since it is compared against a record count rather than sent.
    """
    limit = clamp_limit(tool, args.get('limit'))
    params: dict = {'limit': str(limit)}
    skip = _int_arg(args, 'skip')
    if skip is not None:
        params['skip'] = str(skip)
    return params, limit


# -- style E: offset in the body as numbers (POST /locations/{id}/tasks/search) --


def PAGING_SKIP_BODY(tool: str) -> dict:
    """Style E schema properties: ``skip`` plus ``limit`` sent in the body as numbers."""
    return {
        'skip': INT('Number of records to skip, 0-based (default 0).'),
        'limit': _limit(tool),
    }


def skip_body(args: dict, tool: str) -> tuple[dict, int]:
    """Style E body fragment, plus the page size sent. Both go on the body as numbers."""
    limit = clamp_limit(tool, args.get('limit'))
    body: dict = {'limit': limit}
    skip = _int_arg(args, 'skip')
    if skip is not None:
        body['skip'] = skip
    return body, limit


# -- style F: offset, both required (GET /calendars/appointments/{id}/notes) --


def PAGING_OFFSET(tool: str) -> dict:
    """Style F schema properties: ``limit`` plus ``offset``, both required by the endpoint."""
    return {
        'offset': INT('Number of records to skip, 0-based. Required by this endpoint, sent as 0 when omitted.'),
        'limit': _limit(tool, 'Required by this endpoint and capped low, so it is always sent.'),
    }


def offset_params(args: dict, tool: str) -> tuple[dict, int]:
    """Style F query parameters, plus the page size sent.

    Both are declared required with no server-side default, so both are always sent.
    """
    limit = clamp_limit(tool, args.get('limit'))
    return {'offset': _int_arg(args, 'offset') or 0, 'limit': limit}, limit


# -- style G: optional skip offset (calendar notifications, schedules, resources) --


def PAGING_SKIP(tool: str) -> dict:
    """Style G schema properties: optional ``skip`` plus ``limit`` query parameters."""
    return {
        'skip': INT('Number of records to skip, 0-based (default 0).'),
        'limit': _limit(tool),
    }


def skip_params(args: dict, tool: str) -> tuple[dict, int]:
    """Style G query parameters, plus the page size sent."""
    limit = clamp_limit(tool, args.get('limit'))
    params: dict = {'limit': limit}
    skip = _int_arg(args, 'skip')
    if skip is not None:
        params['skip'] = skip
    return params, limit


# -- style H: keyset on the last message (GET /conversations/{id}/messages) --


def PAGING_LAST_MESSAGE_ID(tool: str) -> dict:
    """Style H schema properties: the ``lastMessageId`` keyset cursor."""
    return {
        'lastMessageId': STR('Cursor: the next value from the previous call, which is the id of its last message.'),
        'limit': _limit(tool),
    }


def last_message_id_params(args: dict, tool: str) -> tuple[dict, int]:
    """Style H query parameters, plus the page size sent."""
    limit = clamp_limit(tool, args.get('limit'))
    params = params_from(args, ('lastMessageId',))
    params['limit'] = limit
    return params, limit


# -- style I: date cursor (GET /conversations/search) -----------------------


def PAGING_START_AFTER_DATE(tool: str) -> dict:
    """Style I schema properties: the ``startAfterDate`` cursor.

    The response carries no cursor field, so the value is the sort value of the last record on
    the previous page and the tool derives it from that record.
    """
    return {
        'startAfterDate': STR('Cursor: the next value from the previous call, taken from its last record.'),
        'limit': _limit(tool),
    }


def start_after_date_params(args: dict, tool: str) -> tuple[dict, int]:
    """Style I query parameters, plus the page size sent."""
    limit = clamp_limit(tool, args.get('limit'))
    params = params_from(args, ('startAfterDate',))
    params['limit'] = limit
    return params, limit


# -- style J: opaque cursor (GET /conversations/messages/export) ------------


def PAGING_CURSOR(tool: str) -> dict:
    """Style J schema properties: the opaque ``cursor`` token."""
    return {
        'cursor': STR('Cursor: the next value from the previous call. It is opaque, so pass it back unchanged.'),
        'limit': _limit(tool),
    }


def cursor_params(args: dict, tool: str) -> tuple[dict, int]:
    """Style J query parameters, plus the page size sent."""
    limit = clamp_limit(tool, args.get('limit'))
    params = params_from(args, ('cursor',))
    params['limit'] = limit
    return params, limit


# ---------------------------------------------------------------------------
# Response helpers
# ---------------------------------------------------------------------------


def items_of(payload: Any, key: str) -> list:
    """Records out of a response, under the envelope key that endpoint happens to use.

    GoHighLevel has no shared envelope: every endpoint names its own top-level key and a few
    calendar routes answer a bare array, so the key is hardcoded per tool and a list payload
    is handed back untouched.
    """
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        value = payload.get(key)
        if isinstance(value, list):
            return value
    return []


def record_of(payload: Any, key: str | tuple[str, ...] = '') -> Any:
    """Single record out of a response, unwrapping the envelope key when there is one.

    ``GET /contacts/{contactId}`` answers ``{"contact": {...}}`` while
    ``POST /calendars/events/appointments`` answers the appointment bare, so the key is
    applied only when the payload actually carries it.

    Several keys may be named, and they are tried in order. That is not tidiness. On
    ``GET /calendars/events/appointments/{eventId}`` the published spec declares ``event`` and
    the live API answers ``appointment``, so a tool that names either one alone hands the whole
    envelope to its cleaner, the cleaner matches none of the fields it looks for, and the tool
    returns an empty record with no error at all. Name every key there is evidence for, and
    take the evidence from the spec or from a live capture rather than from the resource name.
    """
    if not isinstance(payload, dict):
        return payload
    for name in (key,) if isinstance(key, str) else key:
        if name and isinstance(payload.get(name), dict):
            return payload[name]
    return payload


def start_after_cursor(records: Iterable[Any]) -> dict | None:
    """Style A cursor: the ``startAfter`` pair carried by the last record of a page.

    Read it from the records rather than from ``meta.nextPageUrl``, whose documented example
    leaks a localhost address.
    """
    for record in reversed(list(records or [])):
        if not isinstance(record, dict):
            continue
        pair = record.get('startAfter')
        if isinstance(pair, (list, tuple)) and len(pair) >= 2:
            return {'startAfter': pair[0], 'startAfterId': pair[1]}
    return None


def search_after_cursor(records: Iterable[Any]) -> Any:
    """Styles B and C cursor: the ``searchAfter`` value on the last element of the page.

    It sits on the last array element, not on the response root.
    """
    for record in reversed(list(records or [])):
        if isinstance(record, dict) and record.get('searchAfter') is not None:
            return record['searchAfter']
    return None


def next_cursor_of(payload: Any) -> Any:
    """Style J cursor: ``nextCursor``, which is absent as often as it is null at the end."""
    if not isinstance(payload, dict):
        return None
    return payload.get('nextCursor')


def next_offset(current: Any, limit: int, count: int) -> int | None:
    """Next offset for an offset-paged style, or None when the page came back short."""
    if count < limit:
        return None
    try:
        start = max(0, int(current or 0))
    except (TypeError, ValueError):
        start = 0
    return start + count


def total_of(payload: Any) -> Any:
    """Top-level ``total`` of a response, for the few routes that report one.

    Returns None rather than a synthesised number anywhere it is absent: null means unknown,
    not zero.
    """
    return payload.get('total') if isinstance(payload, dict) else None


def follower_result(payload: Any) -> dict:
    """Followers reported back by a follower write, plus the delta when the API states one."""
    if not isinstance(payload, dict):
        return {'followers': []}
    out: dict = {'followers': payload.get('followers') or []}
    for key in ('followersAdded', 'followersRemoved'):
        if key in payload:
            out[key] = payload[key] or []
    return out


def flag_result(payload: Any) -> dict:
    """Outcome of a call whose whole answer is a success flag.

    The flag is spelled ``succeded`` (one "e"), ``succeeded`` or ``success`` depending on the
    endpoint, so it is read through normalize_success rather than by name: reading one
    spelling would return None on the others, and a successful call would report as a failure.
    """
    return {'ok': normalize_success(payload)}


def upsert_result(payload: Any, key: str, cleaner) -> dict:
    """Upsert response: the record under ``key``, plus whether it was created rather than updated."""
    if not isinstance(payload, dict):
        return {key: cleaner(payload), 'new': None}
    return {key: cleaner(payload.get(key)), 'new': payload.get('new')}


# ---------------------------------------------------------------------------
# Mixin base
# ---------------------------------------------------------------------------


class GoHighLevelToolsBase:
    """Credential access, request helpers, and the read-only gate.

    Every group mixin inherits from this; ``IInstance`` supplies ``IGlobal``.
    """

    # -- credentials and scope --------------------------------------------

    def _token(self) -> str:
        return self.IGlobal.token

    def _location(self) -> str:
        """Configured sub-account id.

        Nearly every operation needs it, but it cannot be injected centrally: it goes to the
        query string, to a snake_case query string (``GET /opportunities/search`` takes
        ``location_id`` and rejects ``locationId`` with a 422), to the request body, or to the
        path, depending on the operation. Each tool places it itself.
        """
        return self.IGlobal.location_id

    def _require_write(self) -> None:
        if self.IGlobal.read_only:
            raise ValueError('This operation is not permitted: the node is configured in read-only mode')

    # -- version ----------------------------------------------------------

    def _version_for(self, path: str, version: str | None = None) -> str:
        """Value of the ``Version`` header for a path, with an optional per-call override.

        /calendars and /conversations are on 2021-04-15 and everything else is on 2021-07-28,
        which :func:`version_for` derives from the path. A mixin covering a path that map does
        not classify declares a module-level constant and passes ``version=`` at the call
        site. Do not put such an override on the class: ``IInstance`` composes every mixin
        into a single type, so a class attribute set by one mixin would silently apply to all
        of them.
        """
        return version or version_for(path)

    # -- requests ---------------------------------------------------------

    def _call(self, method: str, path: str, *, version: str | None = None, **kwargs: Any) -> Any:
        return call(self._token(), method, path, version=self._version_for(path, version), **kwargs)

    def _call_envelope(self, method: str, path: str, *, version: str | None = None, **kwargs: Any) -> Any:
        return call_envelope(self._token(), method, path, version=self._version_for(path, version), **kwargs)

    def _fetch(
        self,
        method: str,
        path: str,
        *,
        key: str,
        params: dict | None = None,
        body: dict | None = None,
    ) -> tuple[Any, list]:
        """Issue a list request and return the parsed payload together with its raw records.

        Cursor extraction differs by style and several cursors live on the records rather than
        on the payload, so a tool that pages takes the raw records from here, cleans them, and
        assembles its own :func:`paginated` result.
        """
        payload = self._call(method, path, params=params, body=body)
        return payload, items_of(payload, key)

    def _list(self, path: str, *, key: str, cleaner, params: dict | None = None, total_key: str = '') -> dict:
        """GET a collection that answers with everything in one response.

        This covers the unpaginated style only, which is most of the calendar and location
        surface. A paginated tool calls :meth:`_fetch` and builds its own cursor, because no
        single helper can serve ten pagination styles without guessing.
        """
        payload, records = self._fetch('GET', path, key=key, params=params)
        total = payload.get(total_key) if total_key and isinstance(payload, dict) else None
        return paginated([cleaner(record) for record in records], total=total)

    def _get(self, path: str, cleaner, *, key: str | tuple[str, ...] = '', params: dict | None = None) -> dict:
        return cleaner(record_of(self._call('GET', path, params=params), key))

    def _write(
        self,
        method: str,
        path: str,
        cleaner,
        *,
        key: str | tuple[str, ...] = '',
        body: dict | None = None,
        params: dict | None = None,
    ) -> dict:
        self._require_write()
        return cleaner(record_of(self._call(method, path, body=body, params=params), key))

    def _delete(self, path: str, *, body: dict | None = None, params: dict | None = None) -> dict:
        """DELETE a record and report the outcome.

        ``body`` is not vestigial: five operations on this surface declare a required JSON
        body on a DELETE. The success flag is spelled three different ways across the API, so
        it is read through :func:`normalize_success` rather than by name, and the raw payload
        stays reachable under ``data``.
        """
        self._require_write()
        payload = self._call('DELETE', path, body=body, params=params)
        return {'deleted': normalize_success(payload), 'data': payload}

    # -- arguments --------------------------------------------------------

    def _args(self, args: Any, tool: str) -> dict:
        """Normalise tool input and reject parameters the named tool does not declare.

        The schema comes from the ``@gohighlevel_tool`` decorator on that method, so the
        allowed set can never drift from the one the agent was shown. Prefer this over the
        bare :func:`args_of` inside a tool body.
        """
        return args_of(args, _declared_schema(type(self), tool), tool)


def _declared_schema(owner: type, tool: str) -> dict | None:
    """Input schema a decorated tool method declares, or None when it declares none.

    Raises when ``tool`` names no method at all. The distinction matters: ``tool`` is a
    hand-typed literal repeated at several call sites per tool, and a lookup that returned
    None for a name that does not exist would turn the undeclared-parameter guard off without
    a word. That guard is the reason a hallucinated parameter comes back as a message naming
    the parameters this tool takes instead of a GoHighLevel 422 saying a property should not
    exist, so losing it silently is worse than losing it loudly. Failing here makes a typo a
    hard error on the first invoke of that tool.
    """
    if not hasattr(owner, tool):
        raise ValueError(
            f'{tool}: no such tool method on {owner.__name__}. The name passed to _args must match the '
            f'method name exactly, otherwise the undeclared-parameter check is skipped.'
        )
    meta = getattr(getattr(owner, tool), '__tool_meta__', None)
    if isinstance(meta, dict) and isinstance(meta.get('input_schema'), dict):
        return meta['input_schema']
    return None
