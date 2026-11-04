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

"""The Vector Explorer tools on every vector store node, and the wrapper all store tools run in.

``VectorExplorerTools`` is mixed into ``VectorStoreToolMixin`` (``document_store``),
so every store node that exposes the agent tools (develop's ``search``, ``upsert``,
``delete``, ``objdir``, ``get`` and ``stats``, and ``list_documents``,
``soft_delete`` and ``restore``, all defined on ``VectorStoreToolMixin``) also
answers the explorer's tools: ``dialect``, ``chunks``, ``vectors``, ``sample``,
``project`` and ``neighbors`` (and, from ``vx_tools_ext``, ``recommend`` and
``similarity_matrix``). The explorer tools are listed for external (DAP) callers
only (``audience=('dap',)``). The read tools first run
``vx_write_gate.check_read`` (a connection signed in with a task's public key is
refused with ``READS_PUBLIC``); the write tools run the write gate. The bodies of
``list_documents``, ``soft_delete`` and ``restore`` are the helpers here
(``_vx_list_documents``, ``_vx_trash_write``).

Every tool, new and legacy, runs inside :func:`vectordb_tool`: the input is
normalised, a refusal or failure becomes ``{success: false, code, error}``
(nothing raises past the tool boundary), numpy values become JSON, and an answer
over :data:`MAX_ANSWER_BYTES` is refused with ``LIMIT_EXCEEDED``.

The module also holds small helpers the store hooks share (filters by deleted
state, opaque cursors, document rows); ``document_store`` re-exports them.

See ``docs/development/nodes/vector-tool-contract.md`` section 4.
"""

import base64
import dataclasses
import functools
import json
import math
import re
import threading
import time
from collections import Counter
from typing import TYPE_CHECKING, Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from rocketlib import tool_function, warning

from ..schema import Doc, DocFilter, QuestionText
from . import vx_write_gate
from .errors import StoreError, StoreUnsupported, ToolRefusal
from .vx_defaults import (
    AGENT_WRITE_IDS_MAX,
    VECTOR_ALLOW_WRITES_DEFAULT,
    VECTOR_TOOL_DEFAULTS,
    VECTOR_TOOL_LIMITS,
)
from .vx_types import (
    CLUSTER_LABEL_SOURCES,
    CLUSTER_METHODS,
    CONTROL_OBJECT_ID,
    DELETED_VALUES,
    FILTER_APPLIED_VALUES,
    KEYWORD_MATCHES,
    LISTING_REASONS,
    PROJECTIONS,
    SAMPLE_STRATEGIES,
    SUPPORT_LEVELS,
    DocListFilter,
    DocPage,
    DocumentRow,
    parse_doc_list_filter,
)

if TYPE_CHECKING:  # pragma: no cover
    from .document_store import DocumentStoreBase

Key = Tuple[str, int]

#: ``dialect.contract``.
CONTRACT_VERSION = 'vector/1'

#: Largest answer a store tool returns; a bigger one is refused with LIMIT_EXCEEDED.
MAX_ANSWER_BYTES = 8 * 1024 * 1024

#: The tools that change data (gated by ``vx_write_gate``; ``dialect.write_tools``): the gate's own list.
WRITE_TOOLS = vx_write_gate.WRITE_TOOLS

#: Most rows ``objdir`` scans through ``listDocumentPage`` to fill one answer.
OBJDIR_SCAN_MAX = 10000

#: Documents the sampler lists to build its key space (a scope of more documents is listed whole,
#: up to ``scope_keys_max``; contract section 4.4-B).
SAMPLE_LISTING_MAX = 500

#: Share of the sample's time budget its document listing may use; the listing then stops
#: (``listing.reason: 'budget'``) and the sample is drawn from what it listed.
SAMPLE_LISTING_BUDGET_SHARE = 0.5

#: Pages in a row a document listing may answer without a new document before paging stops.
LISTING_STALE_PAGES = 2

#: Pages a document listing may take beyond the ones its row budget needs.
LISTING_SLACK_PAGES = 8

#: Keys read through ``getVectors`` in one call.
VECTOR_READ_BATCH = 500

#: Most candidate rows one ``getVectors`` call may cover. A driver reads by filter
#: (``objectId IN ... AND chunkId IN ...``), so a batch of keys spanning D documents and
#: C chunk ids can match D x C rows; :func:`vector_batches` keeps D x C at or under this.
VECTOR_PAIR_BUDGET = 2048

#: What one more ``getVectors`` round trip is worth, in candidate rows, when batches are shaped.
VECTOR_TRIP_ROWS = 128

#: Fewest sampled points for which ``sample`` reports outliers (1 % of fewer points is noise).
OUTLIERS_MIN_POINTS = 10

#: Most near-duplicate pairs a sample lists (most similar first); more adds the warning 'duplicates_capped'.
DUPLICATES_MAX = 1000

LIMITS = VECTOR_TOOL_LIMITS
DEFAULTS = VECTOR_TOOL_DEFAULTS


# =============================================================================
# Helpers shared with the store hooks (re-exported by document_store)
# =============================================================================


def deletedFilter(deleted: str, **fields: Any) -> DocFilter:
    """Build a ``DocFilter`` covering ``deleted`` rows (``'active'|'deleted'|'all'``).

    Sets the exact ``deleted`` selector and the legacy ``isDeleted`` flag drivers
    read today (``'active'`` -> False, otherwise True). A store whose ``isDeleted=True``
    means "both" returns deleted and active rows for ``'deleted'``; callers that need
    exactly the deleted ones filter what comes back (see :func:`matchesDeleted`). A
    store that ignores ``deleted`` and reads ``isDeleted=True`` as "deleted rows only"
    returns no active row for ``'all'``; a read that must see every row of a document
    reads ``'active'`` and then ``'deleted'``.
    """
    flt = DocFilter(**fields)
    flt.deleted = deleted
    flt.isDeleted = deleted != 'active'
    return flt


def matchesDeleted(doc: Doc, deleted: str) -> bool:
    """Whether ``doc`` belongs to the ``deleted`` selection (``'active'|'deleted'|'all'``)."""
    is_deleted = bool(metadataValue(doc, 'isDeleted'))
    if deleted == 'active':
        return not is_deleted
    if deleted == 'deleted':
        return is_deleted
    return True


def encodeCursor(state: Dict[str, Any]) -> str:
    """Encode a listing position as an opaque, URL-safe cursor (base64 of compact JSON, unpadded)."""
    raw = json.dumps(state, separators=(',', ':'), sort_keys=True).encode('utf-8')
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def decodeCursor(cursor: str) -> Dict[str, Any]:
    """Decode a cursor made by :func:`encodeCursor`.

    :raises ValueError: When ``cursor`` is not one (not base64, not JSON, or not an object).
    """
    if not isinstance(cursor, str) or not cursor:
        raise ValueError('the cursor is empty')
    try:
        raw = base64.urlsafe_b64decode(cursor + '=' * (-len(cursor) % 4))
        state = json.loads(raw.decode('utf-8'))
    except Exception as exc:
        raise ValueError('the cursor is not one this store issued') from exc
    if not isinstance(state, dict):
        raise ValueError('the cursor is not one this store issued')
    return state


#: Largest offset a default listing cursor may carry.
CURSOR_OFFSET_MAX = 2**31 - 1

#: What a caller sees for a cursor the store did not issue.
INVALID_CURSOR_TEXT = 'cursor must be the next_cursor of a previous page.'


def invalidCursor() -> ToolRefusal:
    """The refusal (``INVALID_INPUT``) a ``listDocumentPage`` hook raises for a cursor it did not issue."""
    return ToolRefusal('INVALID_INPUT', INVALID_CURSOR_TEXT)


def defaultCursorState(cursor: Optional[str]) -> Tuple[int, Optional[str]]:
    """Return ``(offset, first key)`` of a cursor issued by the default ``listDocumentPage``.

    ``(0, None)`` for no cursor. A cursor that does not decode, lacks the offset
    ``o``, carries an offset that is not an integer in ``0..CURSOR_OFFSET_MAX``, or a
    first key ``f`` that is not text raises :func:`invalidCursor`, so a stale or
    edited cursor answers ``INVALID_INPUT`` instead of reaching the backend.
    """
    if cursor is None:
        return 0, None
    try:
        state = decodeCursor(cursor)
    except ValueError:
        raise invalidCursor() from None
    offset = state.get('o')
    first = state.get('f')
    if isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset <= CURSOR_OFFSET_MAX:
        raise invalidCursor()
    if first is not None and not isinstance(first, str):
        raise invalidCursor()
    return offset, first


def metadataValue(doc: Any, name: str) -> Any:
    """Return metadata field or extra ``name`` of ``doc`` (None when absent)."""
    md = getattr(doc, 'metadata', None)
    if md is None:
        return None
    if isinstance(md, Mapping):
        return md.get(name)
    value = getattr(md, name, None)
    if value is None:
        extra = getattr(md, 'model_extra', None) or {}
        value = extra.get(name)
    return value


def _driver_count(value: Any) -> Optional[int]:
    """A count a driver reported: a whole number from zero up, else None (never a made-up count).

    A boolean, a string and a negative number (psycopg2's -1 for a row count it does not know) are
    None, as on develop's ``soft_delete``.
    """
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _int_or_none(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _whole_number(value: Any) -> Optional[int]:
    """A size or count a driver reported: a whole number of 0 or more, else None (never a guess)."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, float):
        return int(value) if value.is_integer() and value >= 0 else None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 and number == value else None


def documentRow(doc: Doc, *, chunks: Optional[int] = None, tables: Optional[int] = None) -> DocumentRow:
    """Build a ``DocumentRow`` from a document's display chunk (chunk 0 where it exists)."""
    point_id = metadataValue(doc, 'pointId')
    ingested = metadataValue(doc, 'ingestedAt')
    return DocumentRow(
        objectId=str(metadataValue(doc, 'objectId')),
        path=str(metadataValue(doc, 'parent') or ''),
        chunks=chunks,
        has_first_chunk=_int_or_none(metadataValue(doc, 'chunkId')) == 0,
        deleted=bool(metadataValue(doc, 'isDeleted')),
        tables=tables,
        nodeId=metadataValue(doc, 'nodeId'),
        size=_int_or_none(metadataValue(doc, 'size')),
        modifyTime=_int_or_none(metadataValue(doc, 'modifyTime')),
        ingestedAt=ingested if isinstance(ingested, str) else None,
        pointId=str(point_id) if point_id is not None else None,
    )


def hasVector(doc: Any) -> bool:
    """Whether ``doc`` carries a non-empty embedding (a list or a numpy row; never truth-tests an array)."""
    embedding = getattr(doc, 'embedding', None)
    if embedding is None:
        return False
    try:
        return len(embedding) > 0
    except TypeError:
        return False


def docKey(doc: Any) -> Optional[Key]:
    """Return ``(objectId, chunkId)`` of ``doc``, or None when either is missing."""
    oid = metadataValue(doc, 'objectId')
    chunk = _int_or_none(metadataValue(doc, 'chunkId'))
    if oid is None or chunk is None:
        return None
    return (str(oid), chunk)


# =============================================================================
# Input normalisation, error text and answer post-processing
# =============================================================================


def normalize_tool_input(input_obj: Any) -> Dict[str, Any]:
    """Normalize a tool-call payload into a plain ``dict``.

    Handles ``None``, plain dicts, pydantic models (``model_dump`` / ``dict``),
    JSON strings, and nested ``input`` wrappers the host may produce. A
    nested ``input`` value of any supported shape (dict, JSON string,
    pydantic model) is re-normalized before merging with any sibling
    ``extras`` in the outer payload so values like ``{'input': '{"query":
    "x"}'}`` or ``{'input': SomeModel(...)}`` are handled correctly.
    """
    if input_obj is None:
        return {}

    # Pydantic (v2 prefers model_dump; fall back to v1 dict())
    if hasattr(input_obj, 'model_dump') and callable(getattr(input_obj, 'model_dump')):
        input_obj = input_obj.model_dump()
    elif hasattr(input_obj, 'dict') and callable(getattr(input_obj, 'dict')):
        try:
            input_obj = input_obj.dict()
        except TypeError:
            # Not a pydantic-style ``dict()`` (e.g. builtin dict) — leave as is.
            pass

    # JSON string
    if isinstance(input_obj, str):
        try:
            parsed = json.loads(input_obj)
            if isinstance(parsed, dict):
                input_obj = parsed
            else:
                warning(f'vectordb tool: JSON input did not parse to a dict (got {type(parsed).__name__})')
                return {}
        except (json.JSONDecodeError, ValueError) as exc:
            warning(f'vectordb tool: malformed JSON input, returning empty dict: {exc}')
            return {}

    if not isinstance(input_obj, dict):
        warning(f'vectordb tool: unexpected input type {type(input_obj).__name__}')
        return {}

    # Unwrap nested ``input`` wrappers the host may produce. Re-run the
    # normalizer on the inner value so string-, model- or dict-wrapped
    # payloads all get the same treatment.
    if 'input' in input_obj:
        inner_raw = input_obj['input']
        extras = {k: v for k, v in input_obj.items() if k != 'input'}
        inner = normalize_tool_input(inner_raw)
        if isinstance(inner, dict):
            input_obj = {**inner, **extras}

    input_obj.pop('security_context', None)
    return input_obj


#: Last labels of DNS names the scrubber treats as host names (``db.internal``, ``x.pinecone.io``);
#: a short list, so file and module names (``postgres.py``, ``ai.common.store``) survive.
_HOST_SUFFIXES = 'com|net|org|io|ai|cloud|internal|localdomain|lan|svc|dev|co|tech|xyz|info|biz'

#: Words that name an identity a backend quotes in its messages (``for user "x"``, ``database "y"``).
_QUOTED_IDENTITIES = 'user|role|database|relation|schema|tenant|keyspace|namespace'

#: ``key=value`` / ``key: value`` pairs whose value is never shown.
_SECRET_KEYS = (
    'password|passwd|pwd|sslpassword|passfile|user|username|role|host|hostaddr|port|dbname|database|tenant'
    '|apikey|api_key|api-key|x-api-key|access_token|token|secret|authorization|sslkey|sslcert|sslrootcert'
)

_SCRUB = (
    # URLs and DSNs: scheme://..., user:password@host[:port][/path], user@host
    (re.compile(r'\b[a-zA-Z][a-zA-Z0-9+.\-]*://[^\s\'"<>]+'), '<url>'),
    (re.compile(r'\b[\w.%+-]+:[^\s@/]*@[\w.\-\[\]:%]+(?:/[^\s\'"<>)]*)?'), '<dsn>'),
    (re.compile(r'\b[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d+)?(?:/[^\s\'"<>)]*)?'), '<dsn>'),
    # credentials
    (re.compile(r'\b(bearer|basic)\s+[\w.~+/=-]+', re.IGNORECASE), r'\1 <redacted>'),
    (
        re.compile(rf'\b({_SECRET_KEYS})\s*[=:]\s*(?:"[^"]*"|\'[^\']*\'|[^\s,;)]+)', re.IGNORECASE),
        r'\1=<redacted>',
    ),
    (
        re.compile(
            r'\b(api[ _-]?key|access[ _-]?key|secret[ _-]?key)\s+'
            r'(?!(?:is|was|not|has|for|missing|invalid|required|expired|rejected|<)\b)[^\s,;)]+',
            re.IGNORECASE,
        ),
        r'\1 <redacted>',
    ),
    (re.compile(r'\bAstraCS:[\w:.+/=-]+'), '<redacted>'),
    (re.compile(r'\bpcsk_[\w-]+'), '<redacted>'),
    # hosts and identities quoted by the backend
    (
        re.compile(r'\b(server at|host name|host|on socket|socket)\s+(?:"[^"]*"|\'[^\']*\')', re.IGNORECASE),
        r'\1 <host>',
    ),
    # bare hyphenated names (container and service names) where a message names a host
    (
        re.compile(
            r'\b(not known:?|failed for|could not resolve|resolve|resolving|(?:on|to|at) server|host|hostname'
            r'|refused(?: by)?:?|connect(?:ing|ion)? to)'
            r'\s+[A-Za-z0-9][\w.]*-[\w.-]*[A-Za-z0-9]',
            re.IGNORECASE,
        ),
        r'\1 <host>',
    ),
    (re.compile(r'\b(grpc|http|https|tcp)\s+\d{2,5}\b', re.IGNORECASE), r'\1 <port>'),
    (re.compile(rf'\b({_QUOTED_IDENTITIES})\s+(?:"[^"]*"|\'[^\']*\'|`[^`]*`)', re.IGNORECASE), r'\1 <redacted>'),
    (re.compile(r'\b(to|for) (tenant|database|keyspace) [\w.-]*\w', re.IGNORECASE), r'\1 \2 <redacted>'),
    # bare addresses, host:port pairs and DNS names
    (re.compile(r'\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b'), '<host>'),
    (re.compile(r'\[[0-9a-fA-F:]{2,}\](?::\d+)?'), '<host>'),
    (re.compile(r'\blocalhost(?::\d+)?\b', re.IGNORECASE), '<host>'),
    (re.compile(r'\b[A-Za-z][\w.-]*:\d{2,5}\b'), '<host>'),
    (
        re.compile(rf'\b(?:[A-Za-z0-9](?:[\w-]*[A-Za-z0-9])?\.)+(?:{_HOST_SUFFIXES})(?![\w-])', re.IGNORECASE),
        '<host>',
    ),
    (re.compile(r'\bport\s+\d+\b', re.IGNORECASE), 'port <port>'),
)


def safe_error_text(error: Any, limit: int = 300) -> str:
    """Return error text fit for a tool answer: at most ``limit`` chars and none of the following.

    URLs, DSNs, credentials (``key=value`` pairs, bearer tokens, API keys), host
    names and addresses, ports, and the user, role, database, schema or tenant
    names a backend quotes in its messages (libpq: ``for user "x"``,
    ``database "y" does not exist``).
    """
    try:
        text = ' '.join(str(error).split())
    except Exception:  # an exception whose message cannot be built
        return ''
    for pattern, replacement in _SCRUB:
        text = pattern.sub(replacement, text)
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + '…'
    return text


#: What a ``STORE_ERROR`` says when the store could not be reached or refused the credentials.
STORE_UNREACHABLE = 'The store could not be reached or refused the credentials; see the engine log.'

#: Connection and credential failures of the client libraries, as ``module.QualName`` of any class in
#: the exception's MRO (the stdlib ones are checked with ``isinstance``).
_UNREACHABLE_CLASSES = frozenset(
    {
        'httpx.ConnectError',
        'httpx.ConnectTimeout',
        'httpcore.ConnectError',
        'httpcore.ConnectTimeout',
        'requests.exceptions.ConnectionError',
        'urllib3.exceptions.NewConnectionError',
        'urllib3.exceptions.MaxRetryError',
        'qdrant_client.http.exceptions.ResponseHandlingException',
        'weaviate.exceptions.WeaviateConnectionError',
        'weaviate.exceptions.WeaviateStartUpError',
        'weaviate.exceptions.AuthenticationFailedError',
        'pinecone.errors.exceptions.UnauthorizedError',
        'pinecone.errors.exceptions.ForbiddenError',
        'pymilvus.exceptions.MilvusUnavailableException',
        'chromadb.errors.AuthorizationError',
        'pymongo.errors.ConnectionFailure',
    }
)

#: Classes that mean a connection failure only as themselves: their subclasses are statement
#: errors (``QueryCanceled``, ``LockNotAvailable``, ...).
_UNREACHABLE_EXACT = frozenset(
    {'psycopg2.OperationalError', 'psycopg2.InterfaceError', 'psycopg.OperationalError', 'psycopg.InterfaceError'}
)

#: gRPC status codes (``StatusCode.value[0]``) that mean the server is unreachable or refused the
#: caller: 14 unavailable, 16 no valid credentials, 7 permission denied.
_UNREACHABLE_GRPC = frozenset({14, 16, 7})


def _qualname(cls: type) -> str:
    return f'{getattr(cls, "__module__", "")}.{getattr(cls, "__qualname__", "")}'


def _http_status(exc: BaseException) -> Optional[int]:
    for owner, attr in ((exc, 'status_code'), (exc, 'status'), (exc, 'http_status')):
        value = getattr(owner, attr, None)
        if isinstance(value, int) and not isinstance(value, bool):
            return value
    value = getattr(getattr(exc, 'response', None), 'status_code', None)
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _unreachable_itself(exc: BaseException) -> bool:
    import socket
    import ssl

    if isinstance(exc, (ConnectionError, socket.gaierror, socket.herror, ssl.SSLError)):
        return True
    if _qualname(type(exc)) in _UNREACHABLE_EXACT:
        return True
    names = {_qualname(cls) for cls in type(exc).__mro__}
    if names & _UNREACHABLE_CLASSES or _http_status(exc) in (401, 403, 407):
        return True
    if 'pymilvus.exceptions.MilvusException' in names:
        return getattr(exc, 'code', None) == 2
    if 'pymongo.errors.OperationFailure' in names:
        return getattr(exc, 'code', None) in (13, 18)
    if 'grpc.RpcError' in names and callable(getattr(exc, 'code', None)):
        value = getattr(exc.code(), 'value', None)
        number = value[0] if isinstance(value, tuple) and value else value
        return number in _UNREACHABLE_GRPC
    return False


def store_unreachable(exc: BaseException) -> bool:
    """Whether ``exc`` (or what caused it) says the store could not be reached or refused the credentials.

    Checks the stdlib connection, DNS and TLS errors, the client libraries' connection and
    authentication classes, HTTP 401/403/407 answers, Milvus code 2, MongoDB auth codes and
    gRPC codes 14, 16 and 7 (:data:`_UNREACHABLE_GRPC`), following ``__cause__`` and an
    unsuppressed ``__context__``.
    """
    pending: List[Optional[BaseException]] = [exc]
    seen: set = set()
    while pending and len(seen) < 8:
        current = pending.pop(0)
        if current is None or id(current) in seen:
            continue
        seen.add(id(current))
        try:
            if _unreachable_itself(current):
                return True
        except Exception:  # an exception whose attributes cannot be read is not a connection failure
            pass
        pending.append(current.__cause__)
        if not current.__suppress_context__:
            pending.append(current.__context__)
    return False


def safe_error(exc: BaseException) -> str:
    """``'<ExceptionType>: <scrubbed message>'`` (just the type when there is no message).

    A connection or credential failure (:func:`store_unreachable`) answers the fixed
    :data:`STORE_UNREACHABLE` sentence instead of its message.
    """
    if store_unreachable(exc):
        return f'{type(exc).__name__}: {STORE_UNREACHABLE}'
    message = safe_error_text(exc)
    return f'{type(exc).__name__}: {message}' if message else type(exc).__name__


def jsonable(value: Any) -> Any:
    """Turn a tool answer into JSON values: numpy to Python, tuples to lists, NaN/inf to None."""
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Mapping):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, (set, frozenset)):
        return [jsonable(v) for v in sorted(value, key=str)]
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return jsonable(dataclasses.asdict(value))
    module = type(value).__module__
    if module == 'numpy' or module.startswith('numpy.'):
        if hasattr(value, 'tolist'):
            return jsonable(value.tolist())
        return jsonable(value.item())
    if hasattr(value, 'model_dump') and callable(value.model_dump):
        return jsonable(value.model_dump())
    if isinstance(value, (bytes, bytearray)):
        return None
    return str(value)


def finish_answer(result: Any) -> Dict[str, Any]:
    """Post-process a tool answer: JSON values, ``success`` first, and the size cap."""
    if not isinstance(result, Mapping):
        result = {'success': True, 'result': result}
    out = jsonable(result)
    out = {'success': out.pop('success', True), **out}
    size = len(json.dumps(out, separators=(',', ':'), allow_nan=False))
    if size > MAX_ANSWER_BYTES:
        return {
            'success': False,
            'code': 'LIMIT_EXCEEDED',
            'error': f'The answer would be {size} bytes; the limit is {MAX_ANSWER_BYTES} bytes. Ask for fewer items.',
        }
    return out


def vectordb_tool(fn: Callable) -> Callable:
    """Run a store tool inside the shared envelope.

    0. the node's outer gate runs first (``_vectordb_surface_refusal`` on
       ``VectorStoreToolMixin``: ``expose_tools``, and ``allow_write`` for a write
       tool); a tool the node does not offer answers its failure object untouched;
    1. the input is normalised (:func:`normalize_tool_input`);
    2. ``StoreUnsupported`` -> ``UNSUPPORTED``; ``ToolRefusal`` -> its code and extra keys;
       ``KeyboardInterrupt``/``SystemExit`` propagate; anything else (any ``BaseException``)
       -> ``STORE_ERROR`` with a scrubbed message;
    3. the answer is post-processed by :func:`finish_answer`; an answer that cannot be
       turned into JSON (a value whose text or ``model_dump`` fails, a cycle) is
       ``STORE_ERROR`` too.

    Applied under ``@tool_function`` so the tool's descriptor is unchanged.
    """

    @functools.wraps(fn)
    def wrapper(self, args: Any = None) -> Dict[str, Any]:
        surface = getattr(self, '_vectordb_surface_refusal', None)
        refused = surface(fn.__name__) if callable(surface) else None
        if refused is not None:
            return refused
        try:
            result = fn(self, normalize_tool_input(args))
        except StoreUnsupported as exc:
            result = {'success': False, 'code': 'UNSUPPORTED', 'error': safe_error_text(exc)}
        except ToolRefusal as exc:
            result = exc.envelope()
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:  # noqa: BLE001 - the tool boundary: nothing escapes it
            result = {'success': False, 'code': 'STORE_ERROR', 'error': safe_error(exc)}
            if store_unreachable(exc):  # the answer carries a fixed sentence; the scrubbed text goes to the log
                try:
                    warning(f'vector store tool {fn.__name__}: {type(exc).__name__}: {safe_error_text(exc)}')
                except Exception:
                    pass
        try:
            return finish_answer(result)
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:  # noqa: BLE001 - the answer itself failed to serialise
            return {'success': False, 'code': 'STORE_ERROR', 'error': safe_error(exc)}

    wrapper.__vectordb_tool__ = True
    return wrapper


# =============================================================================
# Argument parsing
# =============================================================================


def _invalid(message: str) -> ToolRefusal:
    return ToolRefusal('INVALID_INPUT', message)


#: The caveat a ``documents`` answer carries for each ``filter_applied`` (none for ``'server'``).
_FILTER_CAVEATS: Dict[str, str] = {'partial': 'documents_filter_partial', 'none': 'documents_filter_client'}

#: The tool's own cursor key and value for the second phase of an Active listing (the trash's
#: documents that still have a live chunk; see ``_vx_list_documents``).
_TRASH_PHASE_KEY = 'vx_phase'
_TRASH_PHASE = 'trash_live'

#: Live chunks one read may return when telling which trashed documents still have one.
_LIVE_READ_ROWS = 1000

#: How much of the trash is read for its documents with a live chunk: an Active listing asks
#: for at most ``_TRASH_READ_MAX`` rows of the Trash listing in all, and ends with the caveat
#: ``trash_scan_cut`` when that bound stops it; ``stats`` reads the trash only while it holds
#: at most ``_TRASH_READ_MAX`` documents, in at most ``_TRASH_READ_PAGES`` calls (contract
#: section 4.5).
_TRASH_READ_MAX = 1000
_TRASH_READ_PAGES = 8


def _trash_phase_cursor(inner: Optional[str], read: int = 0) -> str:
    """The cursor of the second phase of an Active listing: the driver's trash cursor and the trash documents read."""
    return encodeCursor({_TRASH_PHASE_KEY: _TRASH_PHASE, 'c': inner, 'r': read})


def _doc_list_filter_arg(args: Mapping[str, Any]) -> Optional[DocListFilter]:
    """The ``documents`` call's ``filter``, normalised; None when it sets nothing (contract section 4.4-A)."""
    try:
        return parse_doc_list_filter(args.get('filter'))
    except ValueError as exc:
        raise _invalid(str(exc)) from None


def _filter_outcome(doc_filter: DocListFilter, skipped: Optional[Sequence[str]]) -> Tuple[str, List[str]]:
    """Return ``(filter_applied, filter_ignored)`` for a filtered ``documents`` page.

    ``skipped`` is the page's ``filter_ignored`` when the driver was handed the filter, None
    when it was not (every given key is then left to the app). Only keys the call gave are
    reported, in :data:`DOC_LIST_FILTER_KEYS` order: ``'server'`` when none was skipped,
    ``'none'`` when all were, ``'partial'`` otherwise.
    """
    given = doc_filter.given()
    left = set(given if skipped is None else skipped)
    ignored = [key for key in given if key in left]
    if not ignored:
        return 'server', []
    return ('none' if len(ignored) == len(given) else 'partial'), ignored


def _int_arg(args: Mapping[str, Any], name: str, default: int) -> int:
    value = args.get(name, default)
    if value is None:
        return default
    if isinstance(value, bool):
        raise _invalid(f'{name} must be an integer.')
    try:
        if isinstance(value, float) and not value.is_integer():
            raise ValueError
        return int(value)
    except (TypeError, ValueError):
        raise _invalid(f'{name} must be an integer.') from None


def _clamped(value: int, low: int, high: int, name: str, warnings: List[str]) -> int:
    if value > high:
        warnings.append(f'{name}_clamped')
        return high
    if value < low:
        warnings.append(f'{name}_clamped')
        return low
    return value


def _bool_arg(args: Mapping[str, Any], name: str, default: bool) -> bool:
    value = args.get(name, default)
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    raise _invalid(f'{name} must be true or false.')


def _deleted_arg(args: Mapping[str, Any]) -> str:
    deleted = args.get('deleted', 'active')
    if deleted is None:
        return 'active'
    if deleted not in DELETED_VALUES:
        raise _invalid("deleted must be 'active', 'deleted' or 'all'.")
    return deleted


def _strings_arg(value: Any, name: str, max_n: int) -> List[str]:
    if not isinstance(value, (list, tuple)) or not 1 <= len(value) <= max_n:
        raise _invalid(f'{name} must be a list of 1 to {max_n} strings.')
    out: List[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise _invalid(f'{name} must be a list of 1 to {max_n} strings.')
        text = item.strip()
        if text not in out:
            out.append(text)
    return out


def _gate_ids(value: Any) -> List[str]:
    """The ids a write call names, as text, for the gate (which runs before the input is checked)."""
    if not isinstance(value, (list, tuple)):
        return []
    return [item if isinstance(item, str) else str(item) for item in value]


def _cluster_arg(args: Mapping[str, Any]) -> Optional[Dict[str, Any]]:
    """The ``sample`` call's ``cluster`` (contract section 4.4-C), normalised; None when it asks for none."""
    value = args.get('cluster')
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise _invalid('cluster must be an object such as {"method": "knn-components", "labels": true}.')
    unknown = sorted(str(key) for key in value if key not in ('method', 'labels'))
    if unknown:
        raise _invalid(f'cluster has unknown keys: {", ".join(unknown)}. Known: method, labels.')
    method = value.get('method')
    method = CLUSTER_METHODS[0] if method is None else method
    if method not in CLUSTER_METHODS:
        if method == 'label-propagation':
            raise _invalid("cluster.method 'label-propagation' is reserved and not computed yet; use 'knn-components'.")
        raise _invalid("cluster.method must be 'knn-components'.")
    labels = value.get('labels')
    labels = True if labels is None else labels
    if not isinstance(labels, bool):
        raise _invalid('cluster.labels must be true or false.')
    return {'method': method, 'labels': labels}


def _filter_object_ids(args: Mapping[str, Any]) -> Optional[List[str]]:
    flt = args.get('filter')
    if flt is None:
        return None
    if not isinstance(flt, Mapping):
        raise _invalid('filter must be an object.')
    ids = flt.get('object_ids')
    if ids is None:
        return None
    return _strings_arg(ids, 'filter.object_ids', LIMITS['scope_keys_max'])


def _key_arg(value: Any, name: str) -> Key:
    if (
        not isinstance(value, (list, tuple))
        or len(value) != 2
        or not isinstance(value[0], str)
        or not value[0]
        or isinstance(value[1], bool)
        or not isinstance(value[1], (int, float))
        or float(value[1]) != int(value[1])
    ):
        raise _invalid(f'{name} must be [objectId, chunkId].')
    return (value[0], int(value[1]))


def _keys_arg(value: Any, name: str, max_n: int, min_n: int = 1) -> List[Key]:
    if not isinstance(value, (list, tuple)) or not min_n <= len(value) <= max_n:
        raise _invalid(f'{name} must be a list of {min_n} to {max_n} [objectId, chunkId] keys.')
    keys: List[Key] = []
    for item in value:
        key = _key_arg(item, f'each of {name}')
        if key not in keys:
            keys.append(key)
    return keys


def _vector_arg(value: Any, name: str = 'vector') -> List[float]:
    if not isinstance(value, (list, tuple)) or not value:
        raise _invalid(f'{name} must be a non-empty list of numbers.')
    out: List[float] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(float(item)):
            raise _invalid(f'{name} must be a non-empty list of finite numbers.')
        out.append(float(item))
    return out


def _round(value: Any, dp: int) -> Optional[float]:
    if value is None:
        return None
    number = float(value)
    return round(number, dp) if math.isfinite(number) else None


def _round_list(values: Iterable[Any], dp: int) -> List[Optional[float]]:
    return [_round(v, dp) for v in values]


def _iso(ts: Optional[float]) -> Optional[str]:
    if ts is None:
        return None
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(ts))


# Clocks, patchable in tests.
_wall_clock = time.time
_monotonic = time.monotonic


# =============================================================================
# Per-store explorer state
# =============================================================================


class _VxState:
    """What the explorer tools keep per store: cached counts, samples, the neighbors gate."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.counts: Optional[Dict[str, Any]] = None
        self.counts_as_of: Optional[float] = None
        self.neighbors_busy = threading.Lock()
        self._samples = None

    def samples(self):
        """Return the store's sample cache (created on first use; it needs numpy)."""
        with self.lock:
            if self._samples is None:
                from .vx_sample_cache import SampleCache

                self._samples = SampleCache()
            return self._samples

    def forget_counts(self) -> None:
        with self.lock:
            self.counts = None
            self.counts_as_of = None

    def forget_samples(self) -> None:
        """Drop the cached samples, so no tool serves a point that was removed or moved to the trash."""
        with self.lock:
            samples = self._samples
        if samples is not None:
            samples.clear()


_STATE_LOCK = threading.Lock()


def _vx_state(store: Any) -> _VxState:
    state = getattr(store, '_vx_state', None)
    if state is None:
        with _STATE_LOCK:
            state = getattr(store, '_vx_state', None)
            if state is None:
                state = _VxState()
                store._vx_state = state
    return state


class ListingGuard:
    """Ends a cursor loop over ``listDocumentPage`` that would not end on its own.

    Paging stops when the page has no cursor, when the driver reports
    ``documents_paging_unsupported``, after :data:`LISTING_STALE_PAGES` pages in a row
    that bring no new document (empty pages handed out with a cursor, a backend that
    ignores the cursor), after the pages ``rows_wanted`` needs plus
    :data:`LISTING_SLACK_PAGES`, or once ``budget_s`` seconds have passed.

    After :meth:`stop` returned True, :attr:`reason` says why, in the words of a
    ``sample`` answer's ``listing.reason`` (contract section 4.4-B): ``'complete'``
    (no cursor left), ``'stale'`` (pages without a new document, or a store that says
    it cannot page), ``'pages'`` (the page budget) or ``'budget'`` (the time budget).
    """

    def __init__(self, rows_wanted: int, page_size: int, budget_s: Optional[float] = None) -> None:
        self.max_pages = -(-max(1, int(rows_wanted)) // max(1, int(page_size))) + LISTING_SLACK_PAGES
        self.deadline = None if budget_s is None else _monotonic() + budget_s
        self.pages = 0
        self.stale = 0
        self.reason: Optional[str] = None

    def stop(self, page: Any, new_documents: int) -> bool:
        """Record one page that added ``new_documents``; return whether to stop paging (see :attr:`reason`)."""
        self.pages += 1
        self.stale = 0 if new_documents else self.stale + 1
        cannot_page = 'documents_paging_unsupported' in (page.caveats or ())
        if not page.next_cursor and not cannot_page:
            self.reason = 'complete'
        elif cannot_page or self.stale >= LISTING_STALE_PAGES:
            self.reason = 'stale'
        elif self.pages >= self.max_pages:
            self.reason = 'pages'
        elif self.deadline is not None and _monotonic() > self.deadline:
            self.reason = 'budget'
        else:
            self.reason = None
        return self.reason is not None


def _cross_product(batch: Sequence[Key]) -> int:
    return len({key[0] for key in batch}) * len({key[1] for key in batch})


def _pack_along(keys: Sequence[Key], axis: int) -> List[List[Key]]:
    """Group ``keys`` by one coordinate (0: objectId, 1: chunkId) and pack the groups into batches.

    A group joins the current batch while the batch stays within :data:`VECTOR_READ_BATCH`
    keys and :data:`VECTOR_PAIR_BUDGET` candidate rows, and the candidate rows it adds are
    worth less than another round trip (:data:`VECTOR_TRIP_ROWS`).
    """
    other = 1 - axis
    groups: Dict[Any, List[Key]] = {}
    for key in keys:
        groups.setdefault(key[axis], []).append(key)
    batches: List[List[Key]] = []
    current: List[Key] = []
    firsts: set = set()
    seconds: set = set()
    for value in sorted(groups):
        members = sorted(groups[value], key=lambda key: key[other])
        for start in range(0, len(members), VECTOR_READ_BATCH):
            part = members[start : start + VECTOR_READ_BATCH]
            others = {key[other] for key in part}
            if current:
                before = len(firsts) * len(seconds)
                after = (len(firsts) + (value not in firsts)) * len(seconds | others)
                if (
                    after > VECTOR_PAIR_BUDGET
                    or len(current) + len(part) > VECTOR_READ_BATCH
                    or after - before > len(part) + VECTOR_TRIP_ROWS
                ):
                    batches.append(current)
                    current, firsts, seconds = [], set(), set()
            current.extend(part)
            firsts.add(value)
            seconds |= others
    if current:
        batches.append(current)
    return batches


def vector_batches(keys: Iterable[Key]) -> List[List[Key]]:
    """Split ``keys`` into ``getVectors`` batches that a read by filter answers cheaply.

    Every distinct key lands in exactly one batch of at most :data:`VECTOR_READ_BATCH`
    keys whose objectId x chunkId cross product (the rows an ``objectId IN ... AND
    chunkId IN ...`` filter can match) is at most :data:`VECTOR_PAIR_BUDGET`. Keys are
    grouped by document or by chunk id, whichever covers fewer candidate rows and round
    trips; a block of keys (every chunk of a few documents) is read exactly.
    """
    unique = list(dict.fromkeys((str(key[0]), int(key[1])) for key in keys))
    if not unique:
        return []
    by_document = _pack_along(unique, 0)
    by_chunk = _pack_along(unique, 1)

    def cost(batches: List[List[Key]]) -> int:
        return sum(_cross_product(batch) + VECTOR_TRIP_ROWS for batch in batches)

    return by_document if cost(by_document) <= cost(by_chunk) else by_chunk


def read_vectors(store: Any, keys: Iterable[Key], check: Optional[Callable[[], None]] = None) -> Dict[Key, Doc]:
    """Read ``keys`` through ``store.getVectors`` in :func:`vector_batches`; return ``{key: doc}``.

    Only the keys asked for are kept (a driver may answer a wider candidate set) and only
    rows that carry a vector. ``check`` runs after every batch (a deadline).
    ``StoreUnsupported`` propagates.
    """
    out: Dict[Key, Doc] = {}
    for batch in vector_batches(keys):
        wanted = set(batch)
        for doc in store.getVectors(batch):
            key = docKey(doc)
            if key in wanted and key not in out and hasVector(doc):
                out[key] = doc
        if check is not None:
            check()
    return out


# =============================================================================
# Output schemas (descriptors are listed for DAP callers only)
# =============================================================================

_ENVELOPE = {
    'success': {'type': 'boolean'},
    'code': {'type': 'string'},
    'error': {'type': 'string'},
}

_KEY_SCHEMA = {
    'type': 'array',
    'description': '[objectId, chunkId]',
    'prefixItems': [{'type': 'string'}, {'type': 'integer'}],
    'minItems': 2,
    'maxItems': 2,
}

_DELETED_SCHEMA = {
    'type': 'string',
    'enum': list(DELETED_VALUES),
    'description': "Rows to cover: 'active' (default), 'deleted' or 'all'.",
}


# =============================================================================
# The explorer tools
# =============================================================================


#: ``list_documents`` page size: #2704's 100 by default and 1,000 at most (the app sends its own ``limit``).
LIST_DOCUMENTS_DEFAULT_LIMIT = 100
LIST_DOCUMENTS_MAX_LIMIT = 1000


class VectorExplorerTools:
    """The Vector Explorer's tools; mixed into ``VectorStoreToolMixin``.

    Every method delegates to ``self.IGlobal.store`` (a ``DocumentStoreBase``) and
    its optional hooks. The write tool runs ``vx_write_gate`` first.
    """

    # ------------------------------------------------------------------
    # Plumbing
    # ------------------------------------------------------------------

    def _vx_store(self) -> 'DocumentStoreBase':
        store = getattr(getattr(self, 'IGlobal', None), 'store', None)
        if store is None:
            raise StoreError('The store is not open on this node; start the pipeline and try again.')
        return store

    def _vx_switch(self, name: str, default: bool) -> bool:
        value = getattr(getattr(self, 'IGlobal', None), name, None)
        return value if isinstance(value, bool) else default

    def _vx_outer_writes(self) -> bool:
        """The outer write switch (``allow_write``, see ``VectorStoreToolMixin``); on for a class without one."""
        check = getattr(self, '_vectordb_allow_write', None)
        return bool(check()) if callable(check) else True

    def _vx_allow_writes(self) -> bool:
        """Whether a DAP caller may write: ``allow_write`` and ``allow_writes`` both on."""
        return self._vx_outer_writes() and self._vx_switch('allow_writes', VECTOR_ALLOW_WRITES_DEFAULT)

    @staticmethod
    def _vx_forget_counts(store: Any) -> None:
        _vx_state(store).forget_counts()

    def _vx_provider(self, store: Any) -> Optional[str]:
        inner = getattr(getattr(self, 'IGlobal', None), 'glb', None)
        logical = getattr(inner, 'logicalType', None)
        if isinstance(logical, str) and logical:
            return logical
        provider = getattr(store, 'provider', None)
        return provider if isinstance(provider, str) and provider else None

    def _vx_node_id(self) -> Optional[str]:
        try:
            pipe_type = getattr(getattr(self, 'instance', None), 'pipeType', None)
            if pipe_type is None:
                return None
            node = pipe_type.get('id') if isinstance(pipe_type, Mapping) else getattr(pipe_type, 'id', None)
            if node is None and hasattr(pipe_type, '__getitem__'):
                node = pipe_type['id']
        except Exception:
            return None
        return str(node) if node else None

    @staticmethod
    def _vx_metric(store: Any) -> Optional[str]:
        from .vx_math import normalize_metric

        return normalize_metric(getattr(store, 'similarity', None))

    @staticmethod
    def _vx_load_control(store: Any) -> bool:
        """Load model and dimension from the control record; False when the collection or record is missing."""
        try:
            return bool(store.doesCollectionExist())
        except Exception:
            return False

    @staticmethod
    def _vx_count(fn: Callable[[DocFilter], Optional[int]], flt: DocFilter) -> Optional[int]:
        try:
            value = fn(flt)
        except StoreUnsupported:
            return None
        except Exception as exc:  # a count the store cannot give is reported as unknown
            warning(f'vector store tool: a count failed: {safe_error(exc)}')
            return None
        return _int_or_none(value)

    def _vx_score(self, store: Any) -> Dict[str, Any]:
        info = dict(store.scoreInfo() or {})
        score: Dict[str, Any] = {'formula': str(info.get('formula', 'unknown'))}
        if info.get('range') is not None:
            score['range'] = list(info['range'])
        score['higher_is_better'] = bool(info.get('higher_is_better', True))
        score['floor'] = _round(info.get('floor', 0.2), 5)
        threshold = info.get('threshold', getattr(store, 'threshold_search', None))
        score['threshold'] = _round(threshold, 5) if threshold is not None else None
        return score

    @staticmethod
    def _vx_capabilities(caps: Iterable[str]) -> Dict[str, Any]:
        has = frozenset(caps).__contains__
        vectors = has('getVectors')
        sample = vectors or has('sampleChunks')
        return {
            'describe': True,
            'count': True,
            'count_documents': has('countDocumentsWhere'),
            'documents': True,
            'documents_distinct': has('documents_distinct'),
            'documents_sorted': has('documents_sorted'),
            'chunks': True,
            'vectors': vectors,
            'sample': sample,
            'sample_light': sample,
            'sample_stratified_native': has('sample_stratified_native'),
            'knn_native': has('knnGraph') or has('knn_native'),
            'project': sample,
            'neighbors': vectors,
            'search_vector': True,
            'search_keyword': has('search_keyword'),
            'remove': True,
            'remove_count': has('removeCounted') or has('countChunks'),
            # Every driver implements markDeleted / markActive (they are abstract), so the
            # trash tools work on every store.
            'soft_delete': True,
            # Additive extensions (contract section 4.4): the node computes clusters wherever it
            # samples; a driver declares the other two in VX_DRIVER_CAPABILITIES once it serves them.
            'clusters': sample,
            'documents_filter': has('documents_filter'),
            'recommend_best_score': has('recommend_best_score'),
            'projection': list(PROJECTIONS),
        }

    def _vx_audit(self, action: str, store: Any, object_ids: Sequence[str], rows: Optional[int], decision: Any) -> Dict:
        return {
            'action': action,
            'node': self._vx_node_id(),
            'provider': self._vx_provider(store),
            'collection': store.vxCollectionName() if hasattr(store, 'vxCollectionName') else None,
            'object_ids': list(object_ids),
            'rows': rows,
            'caller': dict(decision.caller),
        }

    def _vx_log_write(self, action: str, object_ids: Sequence[str], rows: Optional[int], origin: str) -> None:
        try:
            from rocketlib import debug

            debug(f'{action} on {self._vx_node_id() or "store"} ({origin}): {rows} rows for {list(object_ids)}')
        except Exception:
            pass

    @staticmethod
    def _vx_document_stored(store: Any, object_id: str) -> bool:
        """Whether any row of ``object_id`` (active or deleted) is stored: one one-row read for an active document.

        Reads the active rows, then (only when none) the deleted ones, never ``'all'``: a
        driver that reads only the legacy ``isDeleted`` flag takes True as "every row" or as
        "deleted rows only" depending on the backend, while False is "active rows" on every
        one, so the pair covers every row whichever reading the driver has.
        """
        for deleted in ('active', 'deleted'):
            for doc in store.get(deletedFilter(deleted, objectIds=[object_id], limit=1, offset=0)):
                if metadataValue(doc, 'objectId') == object_id:
                    return True
        return False

    def _vx_remove(self, store: Any, ids: Sequence[str]) -> Tuple[List[Dict[str, Any]], List[str], Optional[int]]:
        """Remove documents; return ``(removed, not_found, rows)`` with per-document counts where known.

        A driver that counts what it removes (``removeCounted`` overridden) is asked once
        for a single document and counted per document otherwise (for ``not_found``);
        any other driver is counted per document (free when it cannot count) and then
        removed once, so no batch is counted twice. Where no count tells a stored document
        from an unknown id (a single id on a native removal, which may answer None; a
        driver that cannot count), a one-row read decides (a second one for an id with no
        active row; see :meth:`_vx_document_stored`), for up to ``write_ids_max`` ids;
        beyond that an unknown id is reported removed with a null count.
        """
        ids = [oid for oid in ids if oid != CONTROL_OBJECT_ID]
        native = 'removeCounted' in store.capabilities()
        try:
            if native and len(ids) == 1:
                if not self._vx_document_stored(store, ids[0]):
                    return [], list(ids), 0
                rows = _int_or_none(store.removeCounted(list(ids)))
                if rows == 0:
                    return [], list(ids), 0
                return [{'objectId': ids[0], 'chunks_removed': rows}], [], rows
            per: Dict[str, Optional[int]] = {
                oid: self._vx_count(store.countChunks, deletedFilter('all', objectIds=[oid])) for oid in ids
            }
            if len(ids) <= LIMITS['write_ids_max']:
                for oid in ids:
                    if per[oid] is None and not self._vx_document_stored(store, oid):
                        per[oid] = 0
            not_found = [oid for oid in ids if per[oid] == 0]
            targets = [oid for oid in ids if per[oid] != 0]
            known = all(per[oid] is not None for oid in targets)
            rows: Optional[int] = 0
            if targets:
                if native:
                    rows = _int_or_none(store.removeCounted(list(targets)))
                else:
                    store.remove(list(targets))
                    rows = None
                if rows is None and known:
                    rows = sum(per[oid] or 0 for oid in targets)
            if len(targets) == 1 and per[targets[0]] is None:
                per[targets[0]] = rows
            removed = [{'objectId': oid, 'chunks_removed': per[oid]} for oid in targets]
            return removed, not_found, rows
        finally:
            _vx_state(store).forget_counts()

    # ------------------------------------------------------------------
    # dialect
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        output_schema={
            'type': 'object',
            'properties': {
                **_ENVELOPE,
                'dialect': {'type': 'string'},
                'contract': {'type': 'string'},
                'provider': {'type': 'string'},
                'backend': {'type': 'string'},
                'collection': {'type': ['string', 'null']},
                'metric': {'type': ['string', 'null']},
                'model': {'type': ['string', 'null']},
                'dimension': {'type': ['integer', 'null']},
                'capabilities': {'type': 'object'},
                'limits': {'type': 'object'},
                'health': {'type': 'object'},
                'caveats': {'type': 'array', 'items': {'type': 'string'}},
                'size_bytes': {'type': ['integer', 'null'], 'description': 'Storage the collection takes, when known.'},
                'keyword_match': {
                    'type': ['string', 'null'],
                    'enum': [*KEYWORD_MATCHES, None],
                    'description': 'How keyword search matches: text fragments (substring) or whole words (token).',
                },
            },
        },
        description=(
            'Describe this vector store for the Vector Explorer: backend, collection, metric, model, '
            'dimension, index, score scale, write switches, capabilities, limits, health and caveats.'
        ),
        audience=('dap',),
    )
    @vectordb_tool
    def dialect(self, args):
        """Describe the store (the explorer's probe)."""
        vx_write_gate.check_read()
        store = self._vx_store()
        info = store.describe()
        support = getattr(store, 'VX_SUPPORT', 'experimental')
        if support not in SUPPORT_LEVELS:
            support = 'experimental'
        caveats = list(info.caveats)
        if support == 'experimental':
            caveats.append('experimental')
        if info.meta_column is False:
            caveats.append('meta_column_pending')
        limits = dict(LIMITS)
        if info.backend != 'pgvector':
            limits['statement_timeout_ms'] = None
        mismatch = getattr(store, 'modelMismatch', None) if info.collection_exists else None
        capabilities = self._vx_capabilities(store.capabilities())
        # How keyword search matches (contract section 4.4-G): the driver's constant, and only
        # where it searches by keyword at all.
        keyword_match = getattr(type(store), 'VX_KEYWORD_MATCH', None)
        if not capabilities['search_keyword'] or keyword_match not in KEYWORD_MATCHES:
            keyword_match = None
        return {
            'success': True,
            'dialect': 'vector',
            'contract': CONTRACT_VERSION,
            'provider': self._vx_provider(store),
            'backend': info.backend,
            'backend_version': info.backend_version,
            'collection': info.collection,
            'metric': info.metric,
            'model': info.model,
            'dimension': info.dimension,
            'index': info.index,
            'score': self._vx_score(store),
            'support': support,
            'allow_writes': self._vx_allow_writes(),
            'writes_scope': 'tools_source',
            'write_tools': list(WRITE_TOOLS),
            'capabilities': capabilities,
            'limits': limits,
            'health': {
                'collection_exists': info.collection_exists,
                'control_record': info.control_record,
                'model_mismatch': mismatch if isinstance(mismatch, bool) else None,
                'meta_column': info.meta_column,
            },
            'caveats': list(dict.fromkeys(caveats)),
            # Additive keys (contract section 4.4-F/G): null where the driver does not say.
            'size_bytes': _whole_number(getattr(info, 'size_bytes', None)),
            'keyword_match': keyword_match,
        }

    # ------------------------------------------------------------------
    # stats helpers (the legacy ``stats`` tool lives in document_store)
    # ------------------------------------------------------------------

    def _vx_compute_counts(self, store: Any) -> Dict[str, Any]:
        """The filtered figures of ``stats`` (control record excluded); None where the store cannot count."""
        caveats: List[str] = []
        documents = self._vx_count(store.countDocumentsWhere, deletedFilter('active'))
        first = self._vx_count(store.countChunks, deletedFilter('active', chunkIds=[0]))
        without_first: Optional[int] = None
        if documents is None and first is not None:
            documents = first
            caveats.append('documents_by_first_chunk')
        elif documents is not None and first is not None:
            without_first = max(0, documents - first)
        chunks = self._vx_count(store.countChunks, deletedFilter('active'))
        deleted_chunks = self._vx_count(store.countChunks, deletedFilter('deleted'))
        # Documents with a chunk in the trash: the Trash listing's size.
        deleted_documents = self._vx_count(store.countDocumentsWhere, deletedFilter('deleted'))
        if deleted_documents is None and 'documents_by_first_chunk' in caveats:
            deleted_documents = self._vx_count(store.countChunks, deletedFilter('deleted', chunkIds=[0]))
        if 'documents_by_first_chunk' in caveats and deleted_documents:
            # Counted by chunk 0: a document whose chunk 0 is in the trash but a later chunk is
            # live is a document too; the trash is read for them while it is small.
            documents += self._vx_count_live_in_trash(store, deleted_documents) or 0
        tables = self._vx_count(store.countChunks, deletedFilter('active', isTable=True))
        if documents is None and chunks is None and deleted_chunks is None and tables is None:
            caveats.append('no_filtered_count')
        return {
            'documents': documents,
            'documents_without_first_chunk': without_first,
            'chunks': chunks,
            'deleted_chunks': deleted_chunks,
            'deleted_documents': deleted_documents,
            'tables': tables,
            'avg_chunks_per_document': _round(chunks / documents, 5) if chunks is not None and documents else None,
            'caveats': caveats,
        }

    def _vx_count_live_in_trash(self, store: Any, trashed: int) -> Optional[int]:
        """The documents of the trash that still have a live chunk and no live chunk 0.

        None (not counted) when the trash holds more than ``_TRASH_READ_MAX`` documents or
        the read does not end within ``_TRASH_READ_PAGES`` calls or is cut by its bound.
        """
        if trashed > _TRASH_READ_MAX:
            return None
        found, cursor, read = 0, None, 0
        for _ in range(_TRASH_READ_PAGES):
            _page, rows, cursor, read, cut = self._vx_live_in_trash(
                store,
                cursor,
                limit=LIMITS['documents_page'],
                object_ids=None,
                sort='path',
                hook_args={},
                parent=None,
                read=read,
            )
            if cut:
                return None
            found += len(rows)
            if cursor is None:
                return found
        return None

    def _vx_stats(self, store: Any, mode: str) -> Dict[str, Any]:
        """The ``stats`` answer: legacy keys plus the explorer's figures (see the contract, ``stats``).

        ``full`` always recounts. ``quick`` returns the cached figures while they are at most
        ``counts_cached_s`` old; any write to the store drops them (``vxForgetCounts``).
        """
        now = _wall_clock()
        state = _vx_state(store)
        if not store._doesCollectionExist():
            state.forget_counts()
            return {
                'success': True,
                'count': 0,
                'model': '',
                'vector_size': 0,
                'collection_exists': False,
                'documents': None,
                'documents_without_first_chunk': None,
                'chunks': None,
                'deleted_chunks': None,
                'deleted_documents': None,
                'raw_count': None,
                'tables': None,
                'avg_chunks_per_document': None,
                'dimension': None,
                'metric': None,
                'computed_at': _iso(now),
                'counts_as_of': None,
            }
        self._vx_load_control(store)
        count = int(store.count_documents())
        with state.lock:
            cached, as_of = state.counts, state.counts_as_of
        fresh = cached is not None and as_of is not None and now - as_of <= LIMITS['counts_cached_s']
        if mode == 'quick' and fresh:
            figures = cached
        else:
            figures = self._vx_compute_counts(store)
            as_of = now
            with state.lock:
                state.counts, state.counts_as_of = figures, as_of
        vector_size = int(store.vectorSize or 0)
        answer = {
            'success': True,
            'count': count,
            'model': store.modelName or '',
            'vector_size': vector_size,
            'collection_exists': True,
            'documents': figures['documents'],
            'documents_without_first_chunk': figures['documents_without_first_chunk'],
            'chunks': figures['chunks'],
            'deleted_chunks': figures['deleted_chunks'],
            'deleted_documents': figures['deleted_documents'],
            'raw_count': count,
            'tables': figures['tables'],
            'avg_chunks_per_document': figures['avg_chunks_per_document'],
            'dimension': vector_size or None,
            'metric': self._vx_metric(store),
            'computed_at': _iso(now),
            'counts_as_of': _iso(as_of),
        }
        if figures['caveats']:
            answer['caveats'] = list(figures['caveats'])
        return answer

    # ------------------------------------------------------------------
    # list_documents (the tool is VectorStoreToolMixin.list_documents)
    # ------------------------------------------------------------------

    #: The input of ``list_documents`` (the explorer's directory listing; also #2704's callers' forms).
    LIST_DOCUMENTS_INPUT: Dict[str, Any] = {
        'type': 'object',
        'properties': {
            'cursor': {
                'type': ['string', 'null'],
                'description': 'next_cursor of the previous page (null for the first).',
            },
            'limit': {
                'type': 'integer',
                'description': 'Documents per page (default 100, at most 1,000; below 1 is refused).',
            },
            'object_ids': {'type': ['array', 'null'], 'items': {'type': 'string'}},
            'deleted': {
                'description': (
                    "'active' (default), 'deleted' (the trash: documents with a chunk in it) or 'all'; "
                    'true and false stand for deleted and active.'
                ),
                'anyOf': [{'type': 'string', 'enum': ['active', 'deleted', 'all']}, {'type': 'boolean'}],
            },
            'parent': {
                'type': ['string', 'null'],
                'description': 'Only documents stored under exactly this parent path (a page may then hold fewer rows).',
            },
            'sort': {'type': 'string', 'enum': ['path']},
            'filter': {
                'type': ['object', 'null'],
                'description': 'Restrict the listing; the answer says how much of it the store applied.',
                'properties': {
                    'path_prefix': {'type': ['string', 'null']},
                    'file_types': {'type': ['array', 'null'], 'items': {'type': 'string'}},
                    'ingested_after': {'type': ['string', 'null']},
                    'ingested_before': {'type': ['string', 'null']},
                    'min_chunks': {'type': ['integer', 'null']},
                    'max_chunks': {'type': ['integer', 'null']},
                    'has_first_chunk': {'type': ['boolean', 'null']},
                    'has_tables': {'type': ['boolean', 'null']},
                    'path_contains': {'type': ['string', 'null']},
                },
            },
        },
    }

    #: The answer of ``list_documents``.
    LIST_DOCUMENTS_OUTPUT: Dict[str, Any] = {
        'type': 'object',
        'properties': {
            **_ENVELOPE,
            'items': {
                'type': 'array',
                'description': (
                    'One row per document: objectId, path, chunks, has_first_chunk, tables, deleted, nodeId, '
                    'size, modifyTime, ingestedAt, pointId, max_chunk_id, deleted_chunks.'
                ),
                'items': {'type': 'object'},
            },
            'next_cursor': {
                'type': ['string', 'null'],
                'description': 'Pass it as cursor for the next page; null at the end.',
            },
            'total': {
                'type': ['integer', 'null'],
                'description': 'Documents in the whole listing, where the store counts them.',
            },
            'documents': {
                'type': 'array',
                'description': (
                    "The same rows in #2704's shape (object_id, parent, chunk_count), an alias of items "
                    'kept for its callers.'
                ),
                'items': {
                    'type': 'object',
                    'properties': {
                        'object_id': {'type': 'string'},
                        'parent': {'type': ['string', 'null']},
                        'chunk_count': {'type': ['integer', 'null']},
                    },
                },
            },
            'offset': {'type': 'integer', 'description': 'Always 0: the listing pages with cursor.'},
            'has_more': {'type': 'boolean', 'description': 'Whether a page follows (next_cursor is not null).'},
            'counts_exact': {'type': 'boolean'},
            'distinct': {'type': 'boolean'},
            'sorted': {'type': 'boolean'},
            'filter_applied': {'type': 'string', 'enum': list(FILTER_APPLIED_VALUES)},
            'filter_ignored': {'type': 'array', 'items': {'type': 'string'}},
            'caveats': {'type': 'array', 'items': {'type': 'string'}},
        },
    }

    def _vx_list_documents(self, args: Mapping[str, Any]) -> Dict[str, Any]:
        """One page of the document directory (the body of ``list_documents``).

        ``deleted`` also takes #2704's booleans; ``parent`` keeps the documents stored under
        exactly that path (handed to the driver as a ``path_prefix`` where it filters, then
        matched exactly here, so ``total`` is null); an ``offset`` other than 0 is refused,
        since the listing pages with ``cursor``.

        Active means "has a live chunk". A driver that lists by chunk 0 (its page carries
        ``documents_by_first_chunk``) misses a document whose chunk 0 is in the trash but a
        later chunk is live (a ``soft_delete`` during its ingest), so after that driver's
        last Active page the listing goes on through the trash and keeps the documents
        there that still have a live chunk (:meth:`_vx_live_in_trash`); its cursor is this
        tool's own and only an Active listing takes it.
        """
        vx_write_gate.check_read()
        store = self._vx_store()
        warnings: List[str] = []
        offset = args.get('offset')
        if offset is not None and (isinstance(offset, bool) or offset != 0):
            raise _invalid('list_documents pages with cursor: pass the next_cursor of the previous page, not offset.')
        parent = args.get('parent')
        if parent is not None and not isinstance(parent, str):
            raise _invalid('parent must be a string.')
        if isinstance(args.get('deleted'), bool):
            args = {**args, 'deleted': 'deleted' if args['deleted'] else 'active'}
        cursor = args.get('cursor')
        trash_phase, trash_read = False, 0
        if cursor is not None:
            if not isinstance(cursor, str):
                raise invalidCursor()
            try:
                state = decodeCursor(cursor)
            except ValueError:
                raise invalidCursor() from None
            if state.get(_TRASH_PHASE_KEY) is not None:
                # The second phase of an Active listing: the driver's own trash cursor inside.
                inner, trash_read = state.get('c'), state.get('r', 0)
                if (
                    state[_TRASH_PHASE_KEY] != _TRASH_PHASE
                    or (inner is not None and not isinstance(inner, str))
                    or isinstance(trash_read, bool)
                    or not isinstance(trash_read, int)
                    or trash_read < 0
                ):
                    raise invalidCursor()
                trash_phase, cursor = True, inner
        # #2704's page size, kept: 100 by default, at most 1,000; a limit below 1 is refused, not clamped.
        limit = _int_arg(args, 'limit', LIST_DOCUMENTS_DEFAULT_LIMIT)
        if limit < 1:
            raise _invalid('list_documents: limit must be 1 or more.')
        limit = _clamped(limit, 1, LIST_DOCUMENTS_MAX_LIMIT, 'limit', warnings)
        object_ids = args.get('object_ids')
        if object_ids is not None:
            object_ids = _strings_arg(object_ids, 'object_ids', LIMITS['documents_page'])
        deleted = _deleted_arg(args)
        if trash_phase and deleted != 'active':
            raise invalidCursor()
        sort = args.get('sort', 'path') or 'path'
        if sort != 'path':
            raise _invalid("sort must be 'path'.")
        doc_filter = _doc_list_filter_arg(args)
        # Only a driver that declares documents_filter is handed the filter: the others keep
        # the closed keyword-only signature of the first contract and are filtered by the app.
        filters = 'documents_filter' in store.capabilities()
        hook_filter = doc_filter
        if parent is not None and filters and (doc_filter is None or doc_filter.path_prefix is None):
            # The exact parent narrows the driver's listing as a prefix; the exact match is below.
            hook_filter = dataclasses.replace(doc_filter or DocListFilter(), path_prefix=parent)
        hand_over = hook_filter is not None and filters
        hook_args: Dict[str, Any] = {'filter': hook_filter} if hand_over else {}
        listing = {'limit': limit, 'object_ids': object_ids, 'sort': sort, 'hook_args': hook_args, 'parent': parent}
        scan_cut = False
        if trash_phase:
            page, rows, inner_next, read, scan_cut = self._vx_live_in_trash(store, cursor, read=trash_read, **listing)
            next_cursor = _trash_phase_cursor(inner_next, read) if inner_next is not None else None
            total = None
        else:
            page = store.listDocumentPage(
                cursor=cursor, limit=limit, object_ids=object_ids, deleted=deleted, sort=sort, **hook_args
            )
            rows = [
                row
                for row in page.items
                if row.objectId != CONTROL_OBJECT_ID and (parent is None or row.path == parent)
            ]
            next_cursor = page.next_cursor
            total = page.total if parent is None else None
            by_first_chunk = deleted == 'active' and 'documents_by_first_chunk' in page.caveats
            may_hold: Optional[bool] = None
            if by_first_chunk and total is not None:
                # The listing may go on into the trash, past what the driver's total counts.
                may_hold = self._vx_trash_may_hold(store, object_ids)
                if may_hold:
                    total = None
            if (
                by_first_chunk
                and next_cursor is None
                and 'documents_paging_unsupported' not in page.caveats
                and (may_hold if may_hold is not None else self._vx_trash_may_hold(store, object_ids))
            ):
                # The driver's last Active page: the trash may still hold documents with a live chunk.
                # Room left on the page takes them from one page of the trash; a full page hands
                # the trash on to the next call; an empty one reads on now, since a client takes
                # an empty page for the end.
                if len(rows) >= limit:
                    next_cursor = _trash_phase_cursor(None, 0)
                else:
                    room = dict(listing, limit=limit - len(rows)) if rows else listing
                    _trash_page, more, inner_next, read, scan_cut = self._vx_live_in_trash(
                        store, None, single_page=bool(rows), **room
                    )
                    rows = rows + more
                    next_cursor = _trash_phase_cursor(inner_next, read) if inner_next is not None else None
        items = [
            {
                'objectId': row.objectId,
                'path': row.path,
                'chunks': row.chunks,
                'has_first_chunk': row.has_first_chunk,
                'tables': row.tables,
                'deleted': row.deleted,
                'nodeId': row.nodeId,
                'size': row.size,
                'modifyTime': row.modifyTime,
                'ingestedAt': row.ingestedAt,
                'pointId': row.pointId,
                # Per-document health (contract section 4.4-F): from a driver whose rows carry
                # it (pgvector), null for every other driver.
                'max_chunk_id': _whole_number(getattr(row, 'max_chunk_id', None)),
                'deleted_chunks': _whole_number(getattr(row, 'deleted_chunks', None)),
            }
            for row in rows
        ]
        caveats = list(page.caveats)
        if scan_cut:
            caveats.append('trash_scan_cut')
        if not page.sorted and 'documents_unsorted' not in caveats:
            caveats.append('documents_unsorted')
        answer: Dict[str, Any] = {
            'success': True,
            'items': items,
            'next_cursor': next_cursor,
            'total': total,
            'counts_exact': page.counts_exact,
            'distinct': page.distinct,
            'sorted': page.sorted,
            # #2704's answer keys, kept as aliases so its callers read the same answer: the rows in its
            # shape, the offset (always 0 here, the listing pages with cursor) and whether a page follows.
            'documents': [
                {'object_id': item['objectId'], 'parent': item['path'], 'chunk_count': item['chunks']} for item in items
            ],
            'offset': 0,
            'has_more': next_cursor is not None,
        }
        if doc_filter is not None:
            skipped = (getattr(page, 'filter_ignored', None) or ()) if hand_over and hook_filter is doc_filter else None
            if hand_over and hook_filter is not doc_filter:
                # Only the keys the caller gave are reported, so the added path_prefix is not.
                skipped = [key for key in (getattr(page, 'filter_ignored', None) or ()) if key in doc_filter.given()]
            applied, ignored = _filter_outcome(doc_filter, skipped)
            answer['filter_applied'] = applied
            answer['filter_ignored'] = ignored
            caveat = _FILTER_CAVEATS.get(applied)
            if caveat and caveat not in caveats:
                caveats.append(caveat)
        answer['caveats'] = caveats
        if warnings:
            answer['warnings'] = ['limit_clamped']
        return answer

    def _vx_trash_may_hold(self, store: Any, object_ids: Optional[Sequence[str]]) -> bool:
        """Whether the trash may hold a document of the listing (False only when the store counts none)."""
        trashed = self._vx_count(
            store.countChunks, deletedFilter('deleted', objectIds=list(object_ids) if object_ids else None)
        )
        return trashed != 0

    def _vx_live_in_trash(
        self,
        store: Any,
        cursor: Optional[str],
        *,
        limit: int,
        object_ids: Optional[Sequence[str]],
        sort: str,
        hook_args: Mapping[str, Any],
        parent: Optional[str],
        single_page: bool = False,
        read: int = 0,
    ) -> Tuple[DocPage, List[DocumentRow], Optional[str], int, bool]:
        """The documents of the trash that still have a live chunk, as Active rows: ``(page, rows, next, read, cut)``.

        Reads the driver's Trash listing from ``cursor`` (its own cursor), one page and one
        batched read of the page's live chunks at a time, until a page holds such a
        document or the trash ends, so it never answers no rows with a cursor
        (``single_page``: one page, for a caller that has rows of its own). A document
        with a live chunk 0 is left out (the driver's Active pages list it). The rows say
        ``deleted: false`` and ``has_first_chunk: false``, and count the live chunks where
        one read held them all. ``next`` is the driver's cursor for the rest of the trash.

        The bound: ``read`` counts the rows of the Trash listing the listing has asked for
        so far, at most ``_TRASH_READ_MAX`` in all (the pages are cut to fit). When the bound
        stops the read before the trash ends, ``next`` is None and ``cut`` is true.
        """
        passed = set()
        while True:
            if read >= _TRASH_READ_MAX:
                return DocPage([], None, None, False, False, False, []), [], None, read, True
            asked = min(limit, _TRASH_READ_MAX - read)
            page = store.listDocumentPage(
                cursor=cursor, limit=asked, object_ids=object_ids, deleted='deleted', sort=sort, **hook_args
            )
            read += asked
            candidates = [
                row
                for row in page.items
                if row.objectId != CONTROL_OBJECT_ID and (parent is None or row.path == parent)
            ]
            live = self._vx_live_chunks(store, [row.objectId for row in candidates])
            rows = [
                dataclasses.replace(row, deleted=False, has_first_chunk=False, chunks=live[row.objectId], tables=None)
                for row in candidates
                if row.objectId in live
            ]
            following = page.next_cursor
            if 'documents_paging_unsupported' in page.caveats or following == cursor or following in passed:
                following = None
            if following is not None and read >= _TRASH_READ_MAX:
                return page, rows, None, read, True
            if rows or following is None or single_page:
                return page, rows, following, read, False
            passed.add(following)
            cursor = following

    def _vx_live_chunks(self, store: Any, object_ids: Sequence[str]) -> Dict[str, Optional[int]]:
        """The ids among ``object_ids`` with a live chunk but no live chunk 0, each with its live chunk count.

        One count when none of them has a live chunk (a trash page usually); otherwise one
        read of their live chunks (at most ``_LIVE_READ_ROWS``), the count None when it held
        more, and then a one-row read for each id that read did not show.
        """
        ids = [oid for oid in dict.fromkeys(object_ids) if oid != CONTROL_OBJECT_ID]
        if not ids:
            return {}
        if self._vx_count(store.countChunks, deletedFilter('active', objectIds=ids)) == 0:
            return {}
        wanted = set(ids)
        docs = store.get(deletedFilter('active', objectIds=ids, limit=_LIVE_READ_ROWS + 1, offset=0))
        tally: Dict[str, int] = {}
        first: set = set()
        for doc in docs:
            oid = metadataValue(doc, 'objectId')
            if oid in wanted and matchesDeleted(doc, 'active'):
                tally[oid] = tally.get(oid, 0) + 1
                if _int_or_none(metadataValue(doc, 'chunkId')) == 0:
                    first.add(oid)
        if len(docs) <= _LIVE_READ_ROWS:
            return {oid: count for oid, count in tally.items() if oid not in first}
        # More live chunks than one read returns: the documents seen have one; each other id is read once.
        live: Dict[str, Optional[int]] = {oid: None for oid in tally}
        for oid in ids:
            if oid not in live and self._vx_has_live_chunk(store, oid):
                live[oid] = None
        firsts = store.get(deletedFilter('active', objectIds=list(live), chunkIds=[0], limit=2 * len(live), offset=0))
        first |= {metadataValue(doc, 'objectId') for doc in firsts if matchesDeleted(doc, 'active')}
        return {oid: count for oid, count in live.items() if oid not in first}

    # ------------------------------------------------------------------
    # chunks
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['object_id'],
            'properties': {
                'object_id': {'type': 'string'},
                'after_chunk': {'type': 'integer', 'description': 'Return chunks after this chunkId (default -1).'},
                'limit': {'type': 'integer', 'description': 'Chunks per page (default 100, at most 200).'},
                'deleted': _DELETED_SCHEMA,
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                **_ENVELOPE,
                'items': {'type': 'array', 'items': {'type': 'object'}},
                'has_more': {'type': 'boolean'},
                'next_after': {'type': 'integer'},
                'total': {'type': ['integer', 'null']},
            },
        },
        description="Page through one document's chunks in chunk order (text and metadata; never vectors).",
        audience=('dap',),
    )
    @vectordb_tool
    def chunks(self, args):
        """One page of a document's chunks."""
        vx_write_gate.check_read()
        store = self._vx_store()
        object_id = args.get('object_id')
        if not isinstance(object_id, str) or not object_id.strip():
            raise _invalid('object_id is required.')
        object_id = object_id.strip()
        warnings: List[str] = []
        after = _int_arg(args, 'after_chunk', -1)
        if after < -1:
            raise _invalid('after_chunk must be -1 or more.')
        limit = _clamped(_int_arg(args, 'limit', DEFAULTS['chunks_page']), 1, LIMITS['chunks_page'], 'limit', warnings)
        deleted = _deleted_arg(args)
        not_found = ToolRefusal('NOT_FOUND', f"No document with objectId '{object_id}' is stored in this collection.")
        if object_id == CONTROL_OBJECT_ID:
            raise not_found
        page = store.scrollChunks(object_id, after_chunk=after, limit=limit, deleted=deleted)
        if not page.docs and not page.has_more and after == -1:
            # No live chunk: a document whose chunks are all in the trash is told apart.
            if deleted == 'active' and self._vx_in_trash(store, object_id):
                raise self._vx_in_trash_refusal('chunks', object_id)
            raise not_found
        items = []
        for doc in page.docs:
            meta = doc.metadata.model_dump(exclude_none=True) if hasattr(doc.metadata, 'model_dump') else {}
            for key in ('vectorSize', 'modelName'):
                meta.pop(key, None)
            content = doc.page_content or ''
            items.append(
                {
                    'chunkId': _int_or_none(metadataValue(doc, 'chunkId')),
                    'content': content,
                    'length': len(content),
                    'isTable': bool(metadataValue(doc, 'isTable')),
                    'tableId': _int_or_none(metadataValue(doc, 'tableId')) or 0,
                    'isDeleted': bool(metadataValue(doc, 'isDeleted')),
                    'pointId': meta.pop('pointId', None),
                    'metadata': meta,
                }
            )
        answer = {
            'success': True,
            'items': items,
            'has_more': page.has_more,
            'next_after': page.next_after,
            'total': self._vx_count(store.countChunks, deletedFilter(deleted, objectIds=[object_id])),
        }
        if warnings:
            answer['warnings'] = warnings
        return answer

    # ------------------------------------------------------------------
    # vectors
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['keys'],
            'properties': {'keys': {'type': 'array', 'items': _KEY_SCHEMA, 'maxItems': 2}},
        },
        output_schema={
            'type': 'object',
            'properties': {**_ENVELOPE, 'items': {'type': 'array'}, 'model': {'type': ['string', 'null']}},
        },
        description='Return the raw vectors of at most two chunks, by [objectId, chunkId].',
        audience=('dap',),
    )
    @vectordb_tool
    def vectors(self, args):
        """The raw vectors of one or two chunks: the only tool that returns them."""
        vx_write_gate.check_read()
        import numpy as np

        store = self._vx_store()
        keys = _keys_arg(args.get('keys'), 'keys', LIMITS['vectors_keys_max'])
        wanted = [key for key in keys if key[0] != CONTROL_OBJECT_ID]
        found: Dict[Key, Doc] = {}
        if wanted:
            for doc in store.getVectors(wanted):
                key = docKey(doc)
                if key in wanted and doc.embedding is not None and key not in found:
                    found[key] = doc
        if not found:
            raise ToolRefusal('NOT_FOUND', 'None of those chunks is stored in this collection.')
        self._vx_load_control(store)
        items = []
        for key in wanted:
            doc = found.get(key)
            if doc is None:
                continue
            values = np.asarray(doc.embedding, dtype=np.float64)
            items.append(
                {
                    'key': [key[0], key[1]],
                    'pointId': metadataValue(doc, 'pointId'),
                    'dimension': int(values.size),
                    'norm': _round(float(np.linalg.norm(values)), 6),
                    'values': [float(v) for v in values],
                }
            )
        return {'success': True, 'items': items, 'model': store.modelName or None}

    # ------------------------------------------------------------------
    # sample
    # ------------------------------------------------------------------

    def _vx_list_rows(
        self, store: Any, object_ids: Optional[List[str]], deleted: str, limit: int, deadline: float
    ) -> Tuple[List[DocumentRow], Dict[str, Any]]:
        """List up to ``limit`` documents (distinct by objectId), following cursors (:class:`ListingGuard`).

        Returns ``(rows, listing)``, where ``listing`` is the ``sample`` answer's
        ``{"documents", "truncated", "reason"}`` (contract section 4.4-B): ``truncated`` is
        true whenever documents were left when the listing ended (the last page still had a
        cursor, the store said it cannot page, or the row cap left a listed document out),
        and ``reason`` says why it ended (``'cap'`` for the row cap, else
        :attr:`ListingGuard.reason`). The listing may use :data:`SAMPLE_LISTING_BUDGET_SHARE`
        of the sample's time budget; past ``deadline`` the whole sample is ``TIMEOUT``.
        """
        rows: Dict[str, DocumentRow] = {}
        cursor: Optional[str] = None
        page_size = min(LIMITS['documents_page'], limit)
        budget_s = LIMITS['sample_budget_ms'] / 1000.0
        listing_deadline = deadline - budget_s * (1.0 - SAMPLE_LISTING_BUDGET_SHARE)
        guard = ListingGuard(limit, page_size, max(0.0, listing_deadline - _monotonic()))
        reason = 'complete'
        while True:
            page = store.listDocumentPage(
                cursor=cursor,
                limit=page_size,
                object_ids=object_ids,
                deleted=deleted,
                sort='path',
            )
            before = len(rows)
            left_out = False
            for row in page.items:
                if row.objectId == CONTROL_OBJECT_ID or row.objectId in rows:
                    continue
                if len(rows) < limit:
                    rows[row.objectId] = row
                else:
                    left_out = True
            stop = guard.stop(page, len(rows) - before)
            if len(rows) >= limit:
                more = left_out or bool(page.next_cursor) or 'documents_paging_unsupported' in (page.caveats or ())
                reason = 'cap' if more else 'complete'
                break
            if stop:
                reason = guard.reason or 'complete'
                break
            cursor = page.next_cursor
            self._vx_check_deadline(deadline)
        listing = {'documents': len(rows), 'truncated': reason != 'complete', 'reason': reason}
        return list(rows.values()), listing

    @staticmethod
    def _vx_check_deadline(deadline: float) -> None:
        if _monotonic() > deadline:
            raise ToolRefusal('TIMEOUT', f'The sample did not finish within {LIMITS["sample_budget_ms"] // 1000} s.')

    def _vx_collect_sample(
        self,
        store: Any,
        *,
        n: int,
        seed: int,
        strategy: str,
        pinned: List[Key],
        object_ids: Optional[List[str]],
        deleted: str,
        deadline: float,
    ) -> Tuple[List[Doc], str, bool, Dict[str, DocumentRow], Optional[Dict[str, Any]]]:
        """Draw the sample (contract section 2.4).

        Returns ``(docs with vectors, strategy_used, biased, rows, listing)``: ``rows`` are the
        listed documents by objectId; ``listing`` is the answer's ``listing`` object when the
        key space came from the document listing, None when a native sampler drew the sample
        (it lists nothing; its key space is the whole scope). Without a scope the listing
        stops at :data:`SAMPLE_LISTING_MAX` documents; a scope (``filter.object_ids``, at most
        ``scope_keys_max``) is listed whole, so the stratified pick spans every scoped document.
        """
        flt = deletedFilter(deleted, objectIds=object_ids)
        chosen: Dict[Key, Doc] = {}

        def add(doc: Doc) -> bool:
            key = docKey(doc)
            if (
                len(chosen) >= n
                or key is None
                or key[0] == CONTROL_OBJECT_ID
                or key in chosen
                or not hasVector(doc)
                or (object_ids and key[0] not in object_ids)
                or not matchesDeleted(doc, deleted)
            ):
                return False
            chosen[key] = doc
            return True

        readable = False  # becomes True once the store answers getVectors or sampleChunks
        if pinned:
            try:
                fetched = read_vectors(store, pinned)
                for key in pinned:
                    if key in fetched:
                        add(fetched[key])
                readable = True
            except StoreUnsupported:
                pass

        listing: Dict[str, DocumentRow] = {}
        strategy_used = strategy
        biased = False

        # (2) a native sampler answers directly.
        order = {'stratified': ('stratified',), 'random': ('random', 'first'), 'first': ('first', 'random')}[strategy]
        for strat in order:
            try:
                docs, used = store.sampleChunks(
                    n=n - len(chosen), seed=seed, strategy=strat, docFilter=flt, include_keys=list(chosen)
                )
            except StoreUnsupported:
                continue
            for doc in docs:
                add(doc)
            return list(chosen.values()), used if used in SAMPLE_STRATEGIES else strat, False, listing, None

        # (3) / (4) keys from the document listing, read through getVectors.
        listing_max = max(SAMPLE_LISTING_MAX, len(object_ids)) if object_ids else SAMPLE_LISTING_MAX
        rows, listed = self._vx_list_rows(store, object_ids, deleted, listing_max, deadline)
        listing = {row.objectId: row for row in rows}
        from .vx_math import stratified_pick

        if rows and all(row.chunks is not None for row in rows):
            rows_by_doc = {row.objectId: [(row.objectId, c) for c in range(max(0, int(row.chunks)))] for row in rows}
        else:
            rows_by_doc = {row.objectId: [(row.objectId, 0)] for row in rows if row.has_first_chunk}
        keys = [key for key in stratified_pick(rows_by_doc, n, seed, pinned=list(chosen)) if key not in chosen]
        try:
            fetched = read_vectors(store, keys, check=lambda: self._vx_check_deadline(deadline))
            for key in keys:
                if key in fetched:
                    add(fetched[key])
            readable = readable or bool(keys) or 'getVectors' in store.capabilities()
        except StoreUnsupported:
            pass
        strategy_used = 'stratified'

        # Refill every miss (gaps in chunk ids, documents without chunk 0, no counts).
        if len(chosen) < n:
            for strat in ('random', 'first'):
                try:
                    added = self._vx_refill(store, strat, chosen, add, n, seed, flt, deadline)
                except StoreUnsupported:
                    continue
                readable = True
                if added:
                    strategy_used = strat
                    biased = True
                break
        if not readable and not chosen:
            raise StoreUnsupported('sample needs getVectors or sampleChunks, which this store does not support')
        return list(chosen.values()), strategy_used, biased, listing, listed

    def _vx_refill(self, store, strat, chosen, add, n, seed, flt, deadline) -> int:
        added_total = 0
        for attempt in range(3):
            want = n - len(chosen)
            if want <= 0:
                break
            docs, _used = store.sampleChunks(
                n=want + len(chosen), seed=seed + attempt, strategy=strat, docFilter=flt, include_keys=list(chosen)
            )
            added = sum(1 for doc in docs if add(doc))
            added_total += added
            if added == 0:
                break
            self._vx_check_deadline(deadline)
        return added_total

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'n': {
                    'type': 'integer',
                    'description': 'Points wanted (default 1000; at most 2000, 5000 in light mode).',
                },
                'seed': {'type': 'integer'},
                'strategy': {'type': 'string', 'enum': list(SAMPLE_STRATEGIES)},
                'mode': {'type': 'string', 'enum': ['detailed', 'light']},
                'include_keys': {'type': 'array', 'items': _KEY_SCHEMA},
                'filter': {'type': 'object', 'properties': {'object_ids': {'type': ['array', 'null']}}},
                'deleted': _DELETED_SCHEMA,
                'knn_k': {'type': 'integer'},
                'components': {'type': 'integer', 'enum': [2, 3]},
                'duplicate_threshold': {'type': 'number'},
                'include_text': {'type': 'boolean'},
                'cluster': {
                    'type': ['object', 'null'],
                    'description': 'Group the sample by its neighbour graph and label the largest groups.',
                    'properties': {
                        'method': {'type': 'string', 'enum': list(CLUSTER_METHODS)},
                        'labels': {'type': 'boolean'},
                    },
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                **_ENVELOPE,
                'sample_id': {'type': 'string'},
                'n': {'type': 'integer'},
                'points': {'type': 'object'},
                'knn': {'type': 'object'},
                'clusters': {
                    'type': 'object',
                    'description': 'Present when cluster was sent: one group number per point (-1 = noise).',
                    'properties': {
                        'method': {'type': 'string', 'enum': list(CLUSTER_METHODS)},
                        'edge_threshold': {'type': ['number', 'null']},
                        'percentile': {'type': 'integer'},
                        'count': {'type': 'integer'},
                        'noise': {'type': 'integer'},
                        'labels': {'type': 'array', 'items': {'type': 'integer'}},
                        'sizes': {'type': 'array', 'items': {'type': 'integer'}},
                        'keywords': {'type': 'array', 'items': {'type': 'array', 'items': {'type': 'string'}}},
                        'labelled': {'type': 'integer'},
                        'label_source': {'type': ['string', 'null'], 'enum': [*CLUSTER_LABEL_SOURCES, None]},
                        'labelled_from': {'type': 'integer'},
                        'took_ms': {'type': 'object'},
                    },
                },
                'listing': {
                    'type': 'object',
                    'description': 'How the documents the sample was drawn from were listed, and why the listing ended.',
                    'properties': {
                        'documents': {'type': 'integer'},
                        'truncated': {'type': 'boolean'},
                        'reason': {'type': 'string', 'enum': list(LISTING_REASONS)},
                    },
                },
            },
        },
        description=(
            'Draw a sample of chunks and compute, on the node, a PCA layout, the k-nearest-neighbour graph, '
            'density, outliers, near-duplicates and, when asked, labelled clusters. Columnar; never returns vectors.'
        ),
        audience=('dap',),
    )
    @vectordb_tool
    def sample(self, args):
        """A map of the collection: sampled points, positions and the neighbour graph."""
        vx_write_gate.check_read()
        import numpy as np

        from . import vx_cluster, vx_math
        from .vx_sample_cache import SampleEntry, check_light_budget, make_sample_id

        started = _monotonic()
        store = self._vx_store()
        mode = args.get('mode', 'detailed') or 'detailed'
        if mode not in ('detailed', 'light'):
            raise _invalid("mode must be 'detailed' or 'light'.")
        light = mode == 'light'
        max_n = LIMITS['sample_max_light'] if light else LIMITS['sample_max']
        n = _int_arg(args, 'n', LIMITS['sample_default'])
        if n < 1:
            raise _invalid('n must be 1 or more.')
        if n > max_n:
            raise ToolRefusal(
                'LIMIT_EXCEEDED', f'{"Light" if light else "Detailed"} mode is limited to {max_n} points.'
            )
        seed = _int_arg(args, 'seed', 0)
        strategy = args.get('strategy', 'stratified') or 'stratified'
        if strategy not in SAMPLE_STRATEGIES:
            raise _invalid("strategy must be 'stratified', 'random' or 'first'.")
        pinned: List[Key] = []
        if args.get('include_keys') is not None:
            pinned = _keys_arg(args['include_keys'], 'include_keys', LIMITS['project_keys_max'], min_n=0)
            pinned = [key for key in pinned if key[0] != CONTROL_OBJECT_ID][:n]
        object_ids = _filter_object_ids(args)
        deleted = _deleted_arg(args)
        warnings: List[str] = []
        k_max = DEFAULTS['knn_k_max_light'] if light else LIMITS['knn_k_max']
        knn_k = _clamped(
            _int_arg(args, 'knn_k', DEFAULTS['knn_k_max_light'] if light else DEFAULTS['knn_k']),
            1,
            k_max,
            'knn_k',
            warnings,
        )
        components = _int_arg(args, 'components', 3)
        if components not in (2, 3):
            raise _invalid('components must be 2 or 3.')
        threshold = args.get('duplicate_threshold', DEFAULTS['duplicate_threshold'])
        if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not 0 < float(threshold) <= 1:
            raise _invalid('duplicate_threshold must be a number above 0 and at most 1.')
        include_text = False if light else _bool_arg(args, 'include_text', True)
        cluster = _cluster_arg(args)
        dp = 2 if light else 4

        cache = _vx_state(store).samples()
        with cache.exclusive():
            if not store._doesCollectionExist():
                raise ToolRefusal('COLLECTION_MISSING', 'The collection does not exist yet; add a document first.')
            self._vx_load_control(store)
            if light and store.vectorSize:
                check_light_budget(n, int(store.vectorSize))
            deadline = started + LIMITS['sample_budget_ms'] / 1000.0
            docs, strategy_used, biased, listing, listed = self._vx_collect_sample(
                store,
                n=n,
                seed=seed,
                strategy=strategy,
                pinned=pinned,
                object_ids=object_ids,
                deleted=deleted,
                deadline=deadline,
            )

            # One dimension: the collection's, else the most common one drawn.
            lengths = Counter(len(doc.embedding) for doc in docs)
            dimension = (
                int(store.vectorSize) if store.vectorSize in lengths else (lengths.most_common(1) or [(0, 0)])[0][0]
            )
            docs = [doc for doc in docs if len(doc.embedding) == dimension]
            if light and dimension:
                check_light_budget(len(docs), dimension)

            paths: Dict[str, str] = {}
            for doc in docs:
                oid = str(metadataValue(doc, 'objectId'))
                row = listing.get(oid)
                paths.setdefault(oid, row.path if row is not None else str(metadataValue(doc, 'parent') or ''))
            doc_order = sorted(paths, key=lambda oid: (paths[oid], oid))
            doc_index = {oid: i for i, oid in enumerate(doc_order)}
            docs.sort(key=lambda doc: (doc_index[str(metadataValue(doc, 'objectId'))], docKey(doc)[1]))
            keys = [docKey(doc) for doc in docs]

            if doc_order and any(oid not in listing for oid in doc_order):
                try:
                    page = store.listDocumentPage(
                        cursor=None,
                        limit=min(len(doc_order), LIMITS['documents_page']),
                        object_ids=doc_order[: LIMITS['documents_page']],
                        deleted=deleted,
                        sort='path',
                    )
                    for row in page.items:
                        listing.setdefault(row.objectId, row)
                except Exception:
                    pass

            metric = self._vx_metric(store) or 'cosine'
            V = np.asarray([doc.embedding for doc in docs], dtype=np.float32).reshape(len(docs), dimension)
            coords, explained, mean, basis = vx_math.pca(V, components)
            graph = None
            try:
                graph = store.knnGraph(keys, V, metric, knn_k)
            except StoreUnsupported:
                graph = None
            except Exception as exc:  # the node can always compute the graph itself
                warning(
                    f'vector store tool: the store could not build the neighbour graph ({safe_error(exc)}); computing it on the node'
                )
                graph = None
            if graph is None or len(graph.offsets_row) != len(keys) + 1:
                offsets, cols, sims = vx_math.knn(metric, V, knn_k)
                knn_source, graph_k = 'node', max(0, min(knn_k, len(keys) - 1))
            else:
                offsets, cols, sims = graph.offsets_row, graph.cols, graph.sims
                knn_source, graph_k = graph.source if graph.source in ('native', 'node') else 'node', int(graph.k)
            dens = vx_math.density(offsets, sims)
            spread = float(np.ptp(np.asarray(dens, dtype=np.float64))) if len(keys) else 0.0
            # A handful of points, or points all as dense as each other, have no outlier to show.
            outliers = vx_math.outliers(dens, 1.0) if len(keys) >= OUTLIERS_MIN_POINTS and spread > 1e-6 else []
            duplicates = vx_math.duplicates(offsets, cols, sims, float(threshold))
            if len(duplicates) > DUPLICATES_MAX:
                duplicates = duplicates[:DUPLICATES_MAX]
                warnings.append('duplicates_capped')
            self._vx_check_deadline(deadline)
            clusters = None
            if cluster is not None:
                # Computed once, inside the sample's exclusive section, from the graph and the texts the
                # sample already holds; the app folds groups below its own minimum size without a call.
                clusters = vx_cluster.cluster_sample(
                    offsets,
                    cols,
                    sims,
                    [doc.page_content for doc in docs],
                    [paths[key[0]] for key in keys],
                    labels=cluster['labels'],
                    max_components=LIMITS['max_components'],
                    clock=_monotonic,
                )
                self._vx_check_deadline(deadline)

            in_sample = Counter(key[0] for key in keys)
            pinned_set = set(pinned)
            points: Dict[str, Any] = {
                'doc': [doc_index[key[0]] for key in keys],
                'chunk': [key[1] for key in keys],
                'x': _round_list(coords[:, 0] if components >= 1 and len(keys) else [], dp),
                'y': _round_list(coords[:, 1] if len(keys) else [], dp),
            }
            if components == 3:
                points['z'] = _round_list(coords[:, 2] if len(keys) else [], dp)
            points['len'] = [len(doc.page_content or '') for doc in docs]
            if include_text:
                points['snip'] = [vx_math.snippet(doc.page_content, LIMITS['snippet_chars']) for doc in docs]
            points['pinned'] = [1 if key in pinned_set else 0 for key in keys]
            points['table'] = [1 if metadataValue(doc, 'isTable') else 0 for doc in docs]

            sample_id = make_sample_id(seed, keys)
            cache.put(
                SampleEntry(
                    sample_id=sample_id,
                    keys=keys,
                    vectors=V,
                    mean=mean,
                    basis=basis,
                    metric=metric,
                    dimension=dimension,
                    mode=mode,
                    point_ids=[metadataValue(doc, 'pointId') for doc in docs],
                )
            )

        of_filter = {'objectIds': object_ids} if object_ids else {}
        of = {
            'chunks': self._vx_count(store.countChunks, deletedFilter(deleted, **of_filter)),
            'documents': self._vx_count(store.countDocumentsWhere, deletedFilter(deleted, **of_filter)),
        }
        if listed is None:
            # A native sampler drew from the whole scope without listing it: its key space is
            # complete, and spans the documents the store counts (else the ones it drew from).
            documents = of['documents'] if of['documents'] is not None else len(doc_order)
            listed = {'documents': documents, 'truncated': False, 'reason': 'complete'}
        answer = {
            'success': True,
            'sample_id': sample_id,
            'expires_in_s': int(DEFAULTS['sample_cache_ttl_s']),
            'n': len(keys),
            'n_requested': n,
            'mode': mode,
            'of': of,
            'strategy_used': strategy_used,
            'biased': biased,
            'knn_source': knn_source,
            'metric': metric,
            'dimension': dimension,
            'docs': [
                {
                    'i': doc_index[oid],
                    'objectId': oid,
                    'path': paths[oid],
                    'chunks': listing[oid].chunks if oid in listing else None,
                    'in_sample': in_sample[oid],
                }
                for oid in doc_order
            ],
            'points': points,
            'knn': {
                'k': graph_k,
                'offsets_row': [int(v) for v in offsets],
                'cols': [int(v) for v in cols],
                'sims': _round_list(sims, dp),
            },
            'density': _round_list(dens, dp),
            'outliers': outliers,
            'duplicates': [{'a': a, 'b': b, 'sim': _round(s, 4)} for a, b, s in duplicates],
            'pca': {'explained': _round_list(explained, 5)},
            'took_ms': int((_monotonic() - started) * 1000),
        }
        caveats = ['biased_sample'] if biased else []
        if listed['truncated']:
            caveats.append('listing_truncated')
        if caveats:
            answer['caveats'] = caveats
        if clusters is not None:
            answer['clusters'] = clusters
        answer['listing'] = listed
        if warnings:
            answer['warnings'] = warnings
        return answer

    # ------------------------------------------------------------------
    # project
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['sample_id'],
            'properties': {
                'sample_id': {'type': 'string'},
                'vector': {'type': 'array', 'items': {'type': 'number'}},
                'keys': {'type': 'array', 'items': _KEY_SCHEMA},
                'm': {'type': 'integer', 'description': 'Nearest sample points per item (default 10).'},
                'with_similarities': {'type': 'boolean'},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {**_ENVELOPE, 'items': {'type': 'array'}, 'dimension': {'type': 'integer'}},
        },
        description='Place a query vector or stored chunks on a sample drawn by the sample tool.',
        audience=('dap',),
    )
    @vectordb_tool
    def project(self, args):
        """Place a vector, or chunks by key, on a cached sample."""
        vx_write_gate.check_read()
        import numpy as np

        from . import vx_math

        store = self._vx_store()
        sample_id = args.get('sample_id')
        if not isinstance(sample_id, str) or not sample_id:
            raise _invalid('sample_id is required.')
        has_vector = args.get('vector') is not None
        has_keys = args.get('keys') is not None
        if has_vector == has_keys:
            raise _invalid('Give exactly one of vector or keys.')
        warnings: List[str] = []
        m = _clamped(_int_arg(args, 'm', 10), 1, LIMITS['neighbors_k_max'], 'm', warnings)
        with_sims = _bool_arg(args, 'with_similarities', False)
        cache = _vx_state(store).samples()
        with cache.exclusive():
            entry = cache.get(sample_id)
            if entry is None:
                raise ToolRefusal(
                    'SAMPLE_EXPIRED',
                    'The sample is no longer held by the node (it expires after '
                    f'{int(DEFAULTS["sample_cache_ttl_s"])} s or when a newer sample replaces it). Draw the sample again.',
                )
            not_found: List[List[Any]] = []
            if has_vector:
                vector = _vector_arg(args['vector'])
                if len(vector) != entry.dimension:
                    raise ToolRefusal(
                        'DIMENSION_MISMATCH',
                        f'The vector has {len(vector)} values; this sample holds vectors of {entry.dimension}.',
                    )
                rows = [(None, None, np.asarray(vector, dtype=np.float32))]
            else:
                keys = _keys_arg(args['keys'], 'keys', LIMITS['project_keys_max'])
                missing = [key for key in keys if key not in entry.index and key[0] != CONTROL_OBJECT_ID]
                fetched: Dict[Key, Any] = {}
                if missing:
                    try:
                        for key, doc in read_vectors(store, missing).items():
                            if len(doc.embedding) == entry.dimension:
                                fetched[key] = np.asarray(doc.embedding, dtype=np.float32)
                    except StoreUnsupported:
                        pass
                rows = []
                for key in keys:
                    if key in entry.index:
                        idx = entry.index[key]
                        rows.append((key, idx, entry.vectors[idx]))
                    elif key in fetched:
                        rows.append((key, None, fetched[key]))
                    else:
                        not_found.append([key[0], key[1]])
                if not rows:
                    raise ToolRefusal('NOT_FOUND', 'None of those chunks is stored in this collection.')
            Q = np.vstack([row[2] for row in rows]).astype(np.float32)
            coords = vx_math.pca_project(Q, entry.mean, entry.basis)
            S = vx_math.similarity(entry.metric, Q, entry.vectors)
            items = []
            for r, (key, idx, _vec) in enumerate(rows):
                row = S[r].copy()
                if idx is not None:
                    row[idx] = -np.inf
                take = min(m, int(np.isfinite(row).sum()))
                order = np.lexsort((np.arange(row.size), -row))[:take]
                items.append(
                    {
                        'key': [key[0], key[1]] if key is not None else None,
                        'in_sample': idx,
                        'pca': _round_list(coords[r], 4),
                        'neighbors': [{'i': int(i), 'sim': _round(row[i], 4)} for i in order],
                    }
                )
            answer: Dict[str, Any] = {'success': True, 'items': items}
            if has_vector and with_sims:
                answer['similarities'] = _round_list(S[0], 4)
            answer['dimension'] = entry.dimension
        if not_found:
            answer['not_found'] = not_found
        if warnings:
            answer['warnings'] = warnings
        return answer

    # ------------------------------------------------------------------
    # neighbors
    # ------------------------------------------------------------------

    def _vx_vectors_for(self, store: Any, keys: Sequence[Key]) -> Dict[Key, Any]:
        """Vectors for ``keys``: from the latest cached sample where it holds them, else through getVectors."""
        import numpy as np

        out: Dict[Key, Any] = {}
        latest = _vx_state(store).samples().latest()
        if latest is not None:
            for key in keys:
                idx = latest.index.get(key)
                if idx is not None:
                    out[key] = latest.vectors[idx]
        missing = [key for key in keys if key not in out and key[0] != CONTROL_OBJECT_ID]
        if missing:
            try:
                for key, doc in read_vectors(store, missing).items():
                    out[key] = np.asarray(doc.embedding, dtype=np.float32)
            except StoreUnsupported:
                pass
        return out

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'key': _KEY_SCHEMA,
                'vector': {'type': 'array', 'items': {'type': 'number'}},
                'k': {'type': 'integer', 'description': 'Neighbours wanted (default 12, at most 50).'},
                'exclude_self': {'type': 'boolean'},
                'filter': {'type': 'object', 'properties': {'object_ids': {'type': ['array', 'null']}}},
                'scope_keys': {'type': ['array', 'null'], 'items': _KEY_SCHEMA},
            },
        },
        output_schema={
            'type': 'object',
            'properties': {**_ENVELOPE, 'items': {'type': 'array'}, 'scores': {'type': 'array'}},
        },
        description='Find the stored chunks nearest to a chunk or a vector across the whole collection.',
        audience=('dap',),
    )
    @vectordb_tool
    def neighbors(self, args):
        """Nearest chunks of a key or a vector (or its similarities to scope keys)."""
        vx_write_gate.check_read()
        import numpy as np

        from . import vx_math

        store = self._vx_store()
        has_key = args.get('key') is not None
        has_vector = args.get('vector') is not None
        if has_key == has_vector:
            raise _invalid('Give exactly one of key or vector.')
        warnings: List[str] = []
        k = _clamped(_int_arg(args, 'k', DEFAULTS['neighbors_k']), 1, LIMITS['neighbors_k_max'], 'k', warnings)
        exclude_self = _bool_arg(args, 'exclude_self', True)
        object_ids = _filter_object_ids(args)
        scope_keys = None
        if args.get('scope_keys') is not None:
            scope_keys = _keys_arg(args['scope_keys'], 'scope_keys', LIMITS['scope_keys_max'])
        state = _vx_state(store)
        if not state.neighbors_busy.acquire(blocking=False):
            raise ToolRefusal('BUSY', 'Another neighbour search is running on this store; try again when it ends.')
        try:
            if not store._doesCollectionExist():
                raise ToolRefusal('COLLECTION_MISSING', 'The collection does not exist yet; add a document first.')
            self._vx_load_control(store)
            metric = self._vx_metric(store) or 'cosine'
            self_key: Optional[Key] = None
            if has_key:
                self_key = _key_arg(args['key'], 'key')
                vectors = self._vx_vectors_for(store, [self_key]) if self_key[0] != CONTROL_OBJECT_ID else {}
                if self_key not in vectors:
                    raise ToolRefusal('NOT_FOUND', 'That chunk is not stored in this collection.')
                query = np.asarray(vectors[self_key], dtype=np.float32)
            else:
                query = np.asarray(_vector_arg(args['vector']), dtype=np.float32)
                if store.vectorSize and query.size != int(store.vectorSize):
                    raise ToolRefusal(
                        'DIMENSION_MISMATCH',
                        f'The vector has {query.size} values; this collection stores {int(store.vectorSize)}.',
                    )

            if scope_keys is not None:
                found = self._vx_vectors_for(store, scope_keys)
                present = [key for key in scope_keys if key in found]
                scores: Dict[Key, float] = {}
                if present:
                    S = vx_math.similarity(metric, query, np.vstack([found[key] for key in present]))
                    scores = {key: float(S[0, i]) for i, key in enumerate(present)}
                return {'success': True, 'scores': [_round(scores.get(key), 4) for key in scope_keys]}

            flt = deletedFilter('active', objectIds=object_ids, limit=k + (1 if self_key and exclude_self else 0))
            flt.minScore = float('-inf')
            question = QuestionText(
                text='', embedding=[float(v) for v in query], embedding_model=store.modelName or None
            )
            hits = [
                doc for doc in store.searchSemantic(question, flt) if (docKey(doc) or ('', 0))[0] != CONTROL_OBJECT_ID
            ]
            if self_key is not None and exclude_self:
                hits = [doc for doc in hits if docKey(doc) != self_key]
            hit_keys = [docKey(doc) for doc in hits]
            hit_vectors = self._vx_vectors_for(store, [key for key in hit_keys if key is not None])
            floor = float(self._vx_score(store)['floor'] or 0.0)
            items = []
            for doc, key in zip(hits, hit_keys):
                if key is None:
                    continue
                score = doc.score if isinstance(doc.score, (int, float)) else None
                if key in hit_vectors:
                    sim = float(vx_math.similarity(metric, query, hit_vectors[key])[0, 0])
                else:
                    sim = float(score) if score is not None else None
                items.append(
                    {
                        'key': [key[0], key[1]],
                        'sim': _round(sim, 4),
                        'score': _round(score, 4),
                        'below_floor': score is not None and score < floor,
                        'path': str(metadataValue(doc, 'parent') or ''),
                        'chunkId': key[1],
                        'preview': vx_math.snippet(doc.page_content, LIMITS['snippet_chars']),
                    }
                )
            items.sort(key=lambda item: -(item['sim'] if item['sim'] is not None else -math.inf))
            answer = {
                'success': True,
                'items': items[:k],
                'metric': metric,
                'scope': 'collection',
                'k_requested': k,
            }
            if warnings:
                answer['warnings'] = warnings
            return answer
        finally:
            state.neighbors_busy.release()

    # ------------------------------------------------------------------
    # soft_delete and restore (the tools are VectorStoreToolMixin.soft_delete and .restore)
    # ------------------------------------------------------------------

    @staticmethod
    def _vx_write_ids(tool: str, raw: Any, decision: Any) -> List[str]:
        """The distinct, stripped ids of a write call, in request order.

        Callers other than agents send at most ``write_ids_max``, agents at most
        ``AGENT_WRITE_IDS_MAX``.
        """
        if not isinstance(raw, list) or not raw:
            raise _invalid(f'{tool} requires a non-empty "object_ids" array')
        clean = [str(oid).strip() for oid in raw if str(oid).strip()]
        if not clean:
            raise _invalid(f'{tool}: no valid object IDs provided')
        cap = AGENT_WRITE_IDS_MAX if decision.origin == 'agent' else LIMITS['write_ids_max']
        if len(clean) > cap:
            raise _invalid(f'object_ids must be a list of 1 to {cap} strings.')
        return list(dict.fromkeys(clean))

    def _vx_unstored(self, store: Any, ids: Sequence[str]) -> List[str]:
        """The ids among ``ids`` with no chunk stored, in order.

        One count of the stored documents answers for the whole list when it finds all of
        them or none; otherwise each id is counted (a one-row read decides where the store
        cannot count, for up to ``write_ids_max`` ids).
        """
        stored = self._vx_count(store.countDocumentsWhere, deletedFilter('all', objectIds=list(ids)))
        if stored is None:
            stored = 0 if self._vx_count(store.countChunks, deletedFilter('all', objectIds=list(ids))) == 0 else None
        if stored == len(ids):
            return []
        if stored == 0:
            return list(ids)
        per = {oid: self._vx_count(store.countChunks, deletedFilter('all', objectIds=[oid])) for oid in ids}
        if len(ids) <= LIMITS['write_ids_max']:
            for oid in ids:
                if per[oid] is None and not self._vx_document_stored(store, oid):
                    per[oid] = 0
        return [oid for oid in ids if per[oid] == 0]

    def _vx_remove_trashed(self, store: Any, ids: Sequence[str]) -> Tuple[List[str], Optional[int], List[str]]:
        """Permanently delete the trashed chunks of ``ids`` (``delete {deleted_only}``); ``(not_found, rows, raced)``.

        The delete is the driver's ``removeTrashed``: conditional on the trashed state in the same
        store operation, so a chunk a concurrent restore made live is not removed. ``not_found``
        names the ids with nothing stored; ``raced`` the ids that still have chunks afterwards
        (restored while the call ran), which the answer reports as ``kept_live``; ``rows`` is what
        the store actually removed (None where it cannot say).
        """
        ids = [oid for oid in ids if oid != CONTROL_OBJECT_ID]
        try:
            not_found = self._vx_unstored(store, ids)
            targets = [oid for oid in ids if oid not in not_found]
            rows: Optional[int] = 0
            raced: List[str] = []
            if targets:
                rows = _driver_count(store.removeTrashed(list(targets)))
                gone = set(self._vx_unstored(store, targets))
                raced = [oid for oid in targets if oid not in gone]
            return not_found, rows, raced
        finally:
            _vx_state(store).forget_counts()

    def _vx_with_live_chunk(self, store: Any, ids: Sequence[str]) -> List[str]:
        """The ids among ``ids`` that have a chunk out of the trash, in order (``delete {deleted_only}`` keeps them).

        One count answers for the whole list when none of them or all of them has one;
        otherwise each id is checked.
        """
        live = self._vx_count(store.countDocumentsWhere, deletedFilter('active', objectIds=list(ids)))
        if live is None:
            live = 0 if self._vx_count(store.countChunks, deletedFilter('active', objectIds=list(ids))) == 0 else None
        if live == 0:
            return []
        if live == len(ids):
            return list(ids)
        return [oid for oid in ids if self._vx_has_live_chunk(store, oid)]

    def _vx_trash_write(self, tool: str, args: Mapping[str, Any], *, deleted: bool) -> Dict[str, Any]:
        """The body of ``soft_delete`` (``deleted``) and ``restore``: the gate, the ids, one driver call.

        ``moved_chunks`` is what the driver's ``markDeleted`` / ``markActive`` answers: the
        chunks the call moved into or out of the trash (0 for a document already in that
        state), or None where the store cannot count. ``matched_chunks`` keeps #2704's meaning,
        the chunk rows the store holds for the ids in either state (what its UPDATE by object
        id matched); where the store cannot count them it is ``moved_chunks``. ``not_found``
        names the ids with no chunk stored at all; restoring a document that is not in the
        trash moves nothing.
        """
        store = self._vx_store()
        # The gate runs first (on the ids as sent), then the input is checked.
        decision = vx_write_gate.check_write(
            tool, object_ids=_gate_ids(args.get('object_ids')), allow_writes=self._vx_allow_writes()
        )
        ids = self._vx_write_ids(tool, args.get('object_ids'), decision)
        not_found = self._vx_unstored(store, ids)
        targets = [oid for oid in ids if oid not in not_found]
        moved: Optional[int] = 0
        matched: Optional[int] = 0
        if targets:
            moved = _driver_count(store.markDeleted(targets) if deleted else store.markActive(targets))
            matched = self._vx_count(store.countChunks, deletedFilter('all', objectIds=list(targets)))
            if matched is None or (moved is not None and matched < moved):
                matched = moved
        action = f'vector.{tool}'
        self._vx_log_write(action, ids, moved, decision.origin)
        return {
            'success': True,
            'object_ids': ids,
            'matched_chunks': matched,
            'moved_chunks': moved,
            'not_found': not_found,
            'audit': self._vx_audit(action, store, ids, moved, decision),
        }

    def _vx_has_live_chunk(self, store: Any, object_id: str) -> bool:
        """Whether ``object_id`` has a chunk out of the trash (``delete {deleted_only}`` keeps such a document)."""
        live = self._vx_count(store.countChunks, deletedFilter('active', objectIds=[object_id]))
        if live is not None:
            return live > 0
        return any(
            metadataValue(doc, 'objectId') == object_id
            for doc in store.get(deletedFilter('active', objectIds=[object_id], limit=1, offset=0))
        )

    def _vx_in_trash(self, store: Any, object_id: str) -> bool:
        """Whether ``object_id`` has a chunk in the trash (read when it has no live one: then all are there)."""
        if object_id == CONTROL_OBJECT_ID:
            return False
        return any(
            metadataValue(doc, 'objectId') == object_id
            for doc in store.get(deletedFilter('deleted', objectIds=[object_id], limit=1, offset=0))
        )

    @staticmethod
    def _vx_in_trash_refusal(tool: str, object_id: str) -> ToolRefusal:
        return ToolRefusal(
            'IN_TRASH',
            f"{tool}: the document '{object_id}' is in the trash; restore it to read it",
            {'object_id': object_id},
        )


__all__ = [
    'CONTRACT_VERSION',
    'CURSOR_OFFSET_MAX',
    'INVALID_CURSOR_TEXT',
    'MAX_ANSWER_BYTES',
    'VectorExplorerTools',
    'decodeCursor',
    'defaultCursorState',
    'deletedFilter',
    'docKey',
    'documentRow',
    'encodeCursor',
    'finish_answer',
    'hasVector',
    'invalidCursor',
    'jsonable',
    'matchesDeleted',
    'metadataValue',
    'normalize_tool_input',
    'safe_error',
    'safe_error_text',
    'vectordb_tool',
]
