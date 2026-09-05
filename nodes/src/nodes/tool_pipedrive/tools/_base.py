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
Shared plumbing for the Pipedrive tool mixins.

Holds the credential/base-URL accessors, the read-only gate, the offset-pagination
helper, and the small schema builders every group module uses so the 250-plus tool
definitions stay readable.
"""

from __future__ import annotations

from typing import Any, Iterable
from urllib.parse import quote

from ai.common.utils import normalize_tool_input, require_int, require_str

from ..pipedrive_client import MAX_LIMIT, call, call_envelope, paginated

TOOL_NAME = 'tool_pipedrive'

#: Appended to the description of every tool that writes custom fields.
EXTRA_DESC = (
    'Any additional Pipedrive API fields to send verbatim, including custom fields keyed by '
    'their 40-character field key (get those from the *_field_list tools). Merged into the '
    'request body after the typed parameters.'
)

#: Appended to the description of every field that carries a TIME OF DAY.
#:
#: WHY EVERY SUCH FIELD SAYS THIS. Pipedrive takes and returns these in UTC and
#: displays them in each viewer's own timezone. The API validates none of them,
#: so a local wall-clock time sent here is not rejected — it is stored, and it
#: reads as a real time from then on. A meeting asked for at 12:30 in California
#: and written as "12:30" came back to the person who asked for it as 05:30.
#:
#: The hour also moves the DATE. 20:00 Pacific on a Wednesday is 03:00 UTC on the
#: Thursday, so a converted time and an unconverted date is a booking on the
#: wrong day — take both from the same rendering or neither.
#:
#: A pure DATE with no time (`expected_close_date`, a goal's period) names no
#: instant and needs none of this. A DURATION is a length, not a time of day, and
#: converting one is a corruption rather than a correction.
#:
#: `tool_gohighlevel` already states its own zones this way
#: (`appointments._APPOINTMENT_TIMEZONE_DESC`, `contact_tasks._DUE_DATE_DESC`) —
#: which is the convention, and which Pipedrive was the one node not following.
#: The two CRMs want different formats, so the shared rule is that a node names
#: the zone of its own time fields, not that any one zone is right.
UTC_TIME_DESC = (
    'Pipedrive reads and returns this in UTC, and shows it to each viewer in their own '
    'timezone - so send the UTC value, not the local wall-clock one, and convert it back '
    'before reporting it to a person. The datetime tool returns utc_date and utc_time '
    'beside date and time for exactly this: write those, and never shift an hour yourself. '
    'Converting can move the date as well as the time; take both from the same rendering.'
)


# ---------------------------------------------------------------------------
# Schema builders
# ---------------------------------------------------------------------------


def passthrough(value: Any) -> Any:
    """Response cleaner that returns the payload untouched.

    Used for endpoints whose payload is already small, or whose shape varies
    (some return a bare list of ids), where ``dict`` would raise.
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


def EXTRA() -> dict:
    return OBJ(EXTRA_DESC)


#: Offset-pagination properties, spread into list-tool schemas.
def PAGING(max_limit: int = MAX_LIMIT) -> dict:
    """Offset-paging schema. ``max_limit`` overrides the ceiling for endpoints
    that document a smaller one than the shared default (``/files`` caps at 100).
    """
    return {
        'start': INT('Pagination offset, 0-based (default 0). Pass the next_start value from a previous call.'),
        'limit': INT(f'Number of records to return (1-{max_limit}, default 100).'),
    }


def PAGING_V2() -> dict:
    """Cursor paging for the v2 search endpoints.

    v2 dropped the numeric offset: there is no ``start``, only an opaque
    ``cursor`` echoed back from the previous page. This schema is rendered
    verbatim into the agent's tool prompt, so advertising ``start`` here would
    invite calls Pipedrive silently ignores.
    """
    return {
        'cursor': STR('Pagination cursor from a previous call (its next_cursor). Omit for the first page.'),
        'limit': INT(f'Number of records to return (1-{MAX_LIMIT}, default 100).'),
    }


# ---------------------------------------------------------------------------
# Mixin base
# ---------------------------------------------------------------------------


class PipedriveToolsBase:
    """Credential access, request helpers, and the read-only gate.

    Every group mixin inherits from this; ``IInstance`` supplies ``IGlobal``.
    """

    # -- credentials ------------------------------------------------------

    def _token(self) -> str:
        return self.IGlobal.token

    def _base(self) -> str:
        return self.IGlobal.base_url

    def _base_v2(self) -> str:
        """The ``/api/v2`` base. Search tools only — see ``BASE_URL_V2``."""
        return self.IGlobal.base_url_v2

    def _require_write(self) -> None:
        if self.IGlobal.read_only:
            raise ValueError('This operation is not permitted: the node is configured in read-only mode')

    # -- requests ---------------------------------------------------------

    def _call(self, method: str, path: str, **kwargs: Any) -> Any:
        return call(self._token(), method, path, base_url=self._base(), **kwargs)

    def _call_envelope(self, method: str, path: str, **kwargs: Any) -> Any:
        return call_envelope(self._token(), method, path, base_url=self._base(), **kwargs)

    def _call_envelope_v2(self, method: str, path: str, **kwargs: Any) -> Any:
        """Same as :meth:`_call_envelope` but against ``/api/v2``.

        Only the search tools use this. Everything else stays on v1, which still
        routes normally — a blanket swap would break the many endpoints that have
        no v2 equivalent yet.
        """
        return call_envelope(self._token(), method, path, base_url=self._base_v2(), **kwargs)

    def _list(self, path: str, args: dict, cleaner, *, extra: dict | None = None, max_limit: int = MAX_LIMIT) -> dict:
        """GET a collection with offset pagination and return cleaned items + cursor."""
        params = paging_params(args, max_limit)
        if extra:
            params.update(extra)
        envelope = self._call_envelope('GET', path, params=params)
        data = envelope.get('data') if isinstance(envelope, dict) else None
        items = [cleaner(item) for item in (data or [])]
        return paginated(envelope, items)

    def _get(self, path: str, cleaner, *, params: dict | None = None) -> dict:
        return cleaner(self._call('GET', path, params=params))

    def _write(self, method: str, path: str, cleaner, *, body: dict | None = None, params: dict | None = None) -> dict:
        self._require_write()
        return cleaner(self._call(method, path, body=body, params=params))

    def _delete(self, path: str, *, params: dict | None = None) -> dict:
        self._require_write()
        data = self._call('DELETE', path, params=params)
        return {'deleted': True, 'data': data}

    def _delete_bulk(self, path: str, args: dict, tool: str, *, extra_key: str | None = None) -> dict:
        """Delete several records in one call: ``DELETE path?ids=1,2,3``.

        The write gate runs before the argument check on purpose — a read-only
        node should say so rather than complain about arguments it would never
        act on. ``ids`` is also marked required in each caller's schema, so the
        guard here only catches a malformed list that passed validation.

        ``extra`` is merged *before* ``ids`` is assigned: a pass-through of
        ``{'ids': '2,3'}`` must not quietly replace the list that was validated
        and delete a different set of records.
        """
        self._require_write()
        ids = args.get('ids')
        if not isinstance(ids, list) or not ids:
            raise ValueError(f'{tool}: "ids" must be a non-empty array of ids')
        params: dict = {}
        if extra_key and isinstance(args.get(extra_key), dict):
            params.update(args[extra_key])
        params['ids'] = ','.join(str(int(i)) for i in ids)
        return {'deleted': True, 'data': self._call('DELETE', path, params=params)}


# ---------------------------------------------------------------------------
# Argument helpers
# ---------------------------------------------------------------------------


def args_of(args: Any) -> dict:
    """Normalise agent-supplied tool input to a plain dict."""
    return normalize_tool_input(args, tool_name=TOOL_NAME)


def paging_params(args: dict, max_limit: int = MAX_LIMIT) -> dict:
    """Clamp start/limit to what Pipedrive's v1 offset pagination accepts."""
    params: dict = {}
    if args.get('start') is not None:
        params['start'] = max(0, int(args['start']))
    if args.get('limit') is not None:
        params['limit'] = max(1, min(int(args['limit']), max_limit))
    return params


def paging_params_v2(args: dict) -> dict:
    """Clamp limit and pass through the v2 cursor.

    ``cursor`` is opaque: it is echoed back exactly as Pipedrive issued it, never
    parsed or clamped. ``start`` is deliberately not emitted — v2 has no offset
    parameter, and sending one would be ignored rather than rejected, which reads
    as a silently truncated result set.
    """
    params: dict = {}
    cursor = args.get('cursor')
    if cursor is not None and str(cursor).strip():
        params['cursor'] = str(cursor).strip()
    if args.get('limit') is not None:
        params['limit'] = max(1, min(int(args['limit']), MAX_LIMIT))
    return params


def body_from(args: dict, keys: Iterable[str], *, extra_key: str = 'extra') -> dict:
    """Collect the provided typed keys into a request body, then merge ``extra``.

    Keys absent from ``args`` are omitted entirely so a PUT never blanks a field
    the agent did not mention. ``extra`` carries custom fields and any parameter
    this node does not model explicitly.
    """
    body = {k: args[k] for k in keys if args.get(k) is not None}
    extra = args.get(extra_key)
    if isinstance(extra, dict):
        body.update(extra)
    return body


def params_from(args: dict, keys: Iterable[str]) -> dict:
    """Collect the provided keys into a query-parameter dict."""
    return {k: args[k] for k in keys if args.get(k) is not None}


def require_id(args: dict, key: str, tool: str) -> int:
    return require_int(args, key, tool_name=tool)


def require_text(args: dict, key: str, tool: str) -> str:
    return require_str(args, key, tool_name=tool)


def path_segment(value: Any) -> str:
    """URL-encode an agent-supplied id before it is interpolated into a path.

    Numeric ids are safe because :func:`require_id` coerces them, but uuids,
    permission-set ids and channel ids arrive as free-form strings straight from
    the model. A value carrying ``/``, ``?`` or ``#`` would silently retarget the
    request at a different Pipedrive endpoint — for the delete tools, an
    unintended destructive one.

    ``.`` and ``..`` are rejected rather than encoded: they contain no character
    :func:`quote` escapes, so ``/notes/{id}/comments/..`` would survive encoding
    intact and resolve to the parent resource.
    """
    segment = str(value)
    if segment.strip() in ('.', '..'):
        raise ValueError(f'invalid id {segment!r}: "." and ".." address another resource')
    return quote(segment, safe='')
