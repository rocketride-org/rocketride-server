# Copyright 2026 Aparavi Software AG. MIT License.
"""MCP Apps (io.modelcontextprotocol/ui): embedded widget resources.

Widgets are single-file HTML bundles built by ``builder mcp-widgets:build``
from the vite workspace embedded at ``apps/`` next to this module, straight
into ``apps/dist/`` (the ai:build syncDir carries only that dist into the
server dist — the workspace's sources and node_modules are excluded). Each widget is served as
a ``ui://`` resource with the profile mimeType; tools opt in by registering
with ``ui_resource_uri`` (see tooling.py). Hosts without the UI extension see
the plain JSON tool results, unchanged.

The dropper widget's upload door lives here too (plan 3.7): ``POST
/mcp/upload/{nonce}``. The widget runs in the host's sandbox and holds no
platform credential, so the request carries none -- the one-time nonce
``run_dropper_pipe`` minted is the whole authorization. The route redeems
it against the session's task tracker and forwards the bytes INTO that task
over the caller's own engine client (open -> write -> close on the caller's
control, which is what the SDK's ``send`` is), so ``spend.check`` bills the
caller exactly as a DAP call would. This is the ONE HTTP door the DAP-only
rule admits (plan 3.5), scoped to the MCP app surface; identical on OSS.
"""

import asyncio
import logging
import uuid
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import mcp.types as types
from fastapi.responses import JSONResponse, Response
from starlette.datastructures import UploadFile
from starlette.requests import Request

from ai.web.response import ResultError, ResultSuccess, error, exception, formatException

from . import identity
from .registry import TaskRegistry

logger = logging.getLogger(__name__)

UI_MIME_TYPE = 'text/html;profile=mcp-app'
UI_EXTENSION_ID = 'io.modelcontextprotocol/ui'

PIPELINES_TABLE_URI = 'ui://rocketride/pipelines-table.html'
DROPPER_URI = 'ui://rocketride/dropper.html'
TRACE_VIEWER_URI = 'ui://rocketride/trace-viewer.html'

_APPS_DIST = Path(__file__).parent / 'apps' / 'dist'


@dataclass(frozen=True)
class AppSpec:
    uri: str
    filename: str
    title: str
    needs_engine_origin: bool = False


APPS: List[AppSpec] = [
    AppSpec(
        uri=PIPELINES_TABLE_URI,
        filename='pipelines-table.html',
        title='Running pipelines',
    ),
    AppSpec(
        uri=DROPPER_URI,
        filename='dropper.html',
        title='Drop files',
        needs_engine_origin=True,
    ),
    AppSpec(
        uri=TRACE_VIEWER_URI,
        filename='trace-viewer.html',
        title='Pipeline trace',
    ),
]


def extension_capability() -> dict:
    return {'mimeTypes': [UI_MIME_TYPE]}


def available_apps(apps_dir: Optional[Path] = None) -> List[AppSpec]:
    """Specs whose built HTML bundle actually exists on disk."""
    base = apps_dir if apps_dir is not None else _APPS_DIST
    return [spec for spec in APPS if (base / spec.filename).is_file()]


def list_ui_resources(
    apps_dir: Optional[Path] = None, engine_origin: Optional[str] = None, mcp_origin: Optional[str] = None
) -> List[types.Resource]:
    """List the widget resources, stamping the dropper's CSP ``connectDomains``.

    The dropper uploads to ``/mcp/upload/{nonce}`` on THIS server
    (``mcp_origin``); the engine origin stays listed (plan 3.7). The two are
    one origin on an engine that mounts its own MCP module and differ when
    ``rocketride_uri`` names another engine -- deduplicated, order kept.
    """
    out = []
    for spec in available_apps(apps_dir):
        meta = None
        domains = [origin for origin in (engine_origin, mcp_origin) if origin]
        if spec.needs_engine_origin and domains:
            meta = {'ui': {'csp': {'connectDomains': list(dict.fromkeys(domains))}}}
        out.append(types.Resource(uri=spec.uri, name=spec.title, mime_type=UI_MIME_TYPE, meta=meta))
    return out


# Widget bundles are static after the build; cache reads per path with the
# mtime in the value, so the request path skips repeated blocking file I/O
# while a rebuilt bundle still invalidates naturally. Bounded by the number
# of specs (one entry per widget path).
_HTML_CACHE: dict = {}


def read_ui_resource(uri: str, apps_dir: Optional[Path] = None) -> Optional[str]:
    """Return the widget HTML for ``uri``, or None if unknown/not built."""
    base = apps_dir if apps_dir is not None else _APPS_DIST
    for spec in APPS:
        if spec.uri == uri:
            path = base / spec.filename
            try:
                mtime_ns = path.stat().st_mtime_ns
            except OSError:
                continue
            cached = _HTML_CACHE.get(str(path))
            if cached is None or cached[0] != mtime_ns:
                cached = (mtime_ns, path.read_text(encoding='utf-8'))
                _HTML_CACHE[str(path)] = cached
            return cached[1]
    return None


# ----------------------------------------------------------------------------
# Upload route: POST /mcp/upload/{nonce}
# ----------------------------------------------------------------------------

# The one public descendant of /mcp. It is registered AHEAD of the MCP Mount
# (Starlette matches routes in order), so a request to it never reaches
# handle_mcp -- and it is listed public because the widget sends no
# credential: AuthMiddleware would otherwise answer 401 before the nonce is
# ever looked at. See __init__.initModule step 4.
UPLOAD_PATH = '/mcp/upload/{nonce}'

# A query-string credential is refused outright on this door, as the task
# data door and auth.authorize refuse it: the nonce IS the authorization and
# nothing else may ride the URL.
_REFUSED_QUERY_NAMES = frozenset({'auth', 'token'})

# Hard cap on one upload request, enforced BEFORE anything is buffered: the
# declared Content-Length is checked first, then the body is counted as it
# streams in and cut off at the cap (a chunked or under-declared body cannot
# get past it). The route holds a whole request in memory to forward it,
# and a nonce holder could otherwise send any size and each accepted upload
# mints the next link. The task data door streams and carries no cap of its
# own, so the value is this module's.
MAX_UPLOAD_BYTES = 100 * 1024 * 1024


class UploadTooLarge(Exception):
    """The request body exceeds ``MAX_UPLOAD_BYTES`` (answered 413)."""


def upload_url(base_url: str, nonce: str) -> str:
    """Compose the widget's upload URL for ``nonce`` on THIS MCP server's origin.

    Args:
        base_url: The MCP server's own public origin (``identity.MCP_ORIGIN``,
            resolved once by ``__init__._resolve_mcp_origin``) -- the only
            server holding the nonce, so never the engine origin.
        nonce: A nonce from ``TaskRegistry.issue_upload_nonce``.

    Returns:
        str: ``{origin}/mcp/upload/{nonce}``; the nonce is the only
            URL-carried value and it is single-use.
    """
    return f'{str(base_url).rstrip("/")}{UPLOAD_PATH.format(nonce=nonce)}'


def _mime_of(request: Request) -> str:
    """The request's media type, parameters stripped and lower-cased."""
    return (request.headers.get('content-type') or 'application/octet-stream').split(';')[0].strip().lower()


def _filename_of(request: Request) -> str:
    """The ``Content-Disposition`` filename of a raw-body upload, else a generated one."""
    disposition = request.headers.get('content-disposition') or ''
    for part in disposition.split(';'):
        name, sep, value = part.strip().partition('=')
        if sep and name.strip().lower() == 'filename':
            value = value.strip().strip('"')
            if value:
                return value
    return f'content-{uuid.uuid4()}'


def _capped(request: Request) -> Request:
    """The same request, with its body counted and cut off at ``MAX_UPLOAD_BYTES``.

    Wraps the ASGI ``receive`` so BOTH read paths (``body()`` for a raw
    upload, ``form()`` for multipart, which spools every file part) stop
    before the cap is exceeded instead of buffering first and measuring
    after. ``Content-Length`` is checked by the caller beforehand; this is
    the guard for bodies that declare nothing or lie.
    """
    seen = 0

    async def receive() -> Any:
        nonlocal seen
        message = await request.receive()
        if message.get('type') == 'http.request':
            seen += len(message.get('body') or b'')
            if seen > MAX_UPLOAD_BYTES:
                raise UploadTooLarge(seen)
        return message

    return Request(request.scope, receive)


def _too_large(mcp_origin: str, nonce: Optional[str]) -> Response:
    """The 413 envelope, carrying the link to retry with once the upload is split.

    ``nonce`` is the one still live for the task: the unspent one when the
    declared length was refused before any read, a fresh one when the body
    was cut off mid-stream (that request spent its nonce); ``None`` when the
    task has left the tracker and there is nothing further to authorize.
    """
    message = f'the upload exceeds the {MAX_UPLOAD_BYTES} byte limit of this door; split it into smaller uploads'
    content = ResultError(error={'error': message}).model_dump(exclude_none=True)
    if nonce:
        content['upload_url'] = upload_url(mcp_origin, nonce)
    return JSONResponse(content=content, status_code=413)


def _declared_too_large(request: Request) -> bool:
    """True when ``Content-Length`` already exceeds the cap (refused before any read)."""
    try:
        return int(request.headers.get('content-length') or 0) > MAX_UPLOAD_BYTES
    except ValueError:  # a malformed header is left to the body counter
        return False


def _allocate_keys(keys: List[str]) -> List[str]:
    """One result key per submitted field, in submission order.

    A field name that appears once keeps its name; a repeated name gets the
    task data door's ``_0``, ``_1`` suffixes -- allocated against the WHOLE
    submitted namespace, so ``file``, ``file``, ``file_0`` becomes ``file_1``,
    ``file_2``, ``file_0`` and no generated key can shadow a submitted one
    (the result map would otherwise silently drop an object).
    """
    counts = Counter(keys)
    taken = set(keys)
    out: List[str] = []
    next_index: Dict[str, int] = {}
    for key in keys:
        if counts[key] == 1:
            out.append(key)
            continue
        index = next_index.get(key, 0)
        while f'{key}_{index}' in taken:
            index += 1
        candidate = f'{key}_{index}'
        taken.add(candidate)
        next_index[key] = index + 1
        out.append(candidate)
    return out


async def _parts_of(request: Request) -> List[Tuple[str, str, bytes, str]]:
    """Split the request into ``(unique_key, filename, payload, mimetype)`` parts.

    Multipart bodies yield one part per field in submission order -- a file
    field under its filename and content type, a string field as
    ``text/plain`` -- keyed by ``_allocate_keys`` the way the task data door
    keys them, so the widget's result map reads the same. Any other body is a
    single raw object. The body is read through ``_capped`` on both paths.

    Raises:
        UploadTooLarge: the body passed ``MAX_UPLOAD_BYTES`` while streaming in.
    """
    capped = _capped(request)
    if _mime_of(request) != 'multipart/form-data':
        body = await capped.body()
        return [('content', _filename_of(request), body, _mime_of(request))]

    form = await capped.form()
    items = list(form.multi_items())
    parts: List[Tuple[str, str, bytes, str]] = []
    for unique_key, (key, value) in zip(_allocate_keys([key for key, _ in items]), items):
        if isinstance(value, UploadFile):
            payload = await value.read()
            parts.append(
                (unique_key, value.filename or unique_key, payload, value.content_type or 'application/octet-stream')
            )
        else:
            parts.append((unique_key, f'{unique_key}-{uuid.uuid4()}', str(value).encode('utf-8'), 'text/plain'))
    return parts


async def _forward_part(client: Any, control_id: str, part: Tuple[str, str, bytes, str]) -> Tuple[str, Any]:
    """Send one part into the run on the caller's control; an exception is the result.

    The data OPEN names the CONTROL ID (plan section 1), the run the nonce
    was minted for -- never the address, which a later run would answer.
    """
    unique_key, filename, payload, mimetype = part
    try:
        outcome = await client.send(
            control_id, payload, objinfo={'name': filename, 'size': len(payload)}, mimetype=mimetype
        )
    except Exception as exc:  # noqa: BLE001 - reported per object, as the task data door does
        return unique_key, exc
    return unique_key, outcome


async def _forward_upload(client: Any, control_id: str, request: Request) -> Dict[str, Any]:
    """Forward every part of ``request`` into the run ``control_id`` and build the result map.

    The map is the shape the widget renders -- ``{objectsRequested,
    objectsCompleted, resultTypes, objects}`` -- with each object's pipe
    result under its field key, ``status: 'OK'`` stamped on success and the
    formatted exception on failure. Parts are sent concurrently, as the task
    data door sends them.
    """
    parts = await _parts_of(request)
    result: Dict[str, Any] = {
        'objectsRequested': len(parts),
        'objectsCompleted': 0,
        'resultTypes': {},
        'objects': {},
    }
    for unique_key, outcome in await asyncio.gather(*(_forward_part(client, control_id, part) for part in parts)):
        if isinstance(outcome, Exception):
            result['objects'][unique_key] = formatException(outcome).model_dump()
            continue
        outcome = dict(outcome) if isinstance(outcome, dict) else {'result': outcome}
        result['resultTypes'].update(outcome.pop('result_types', None) or {})
        outcome['status'] = 'OK'
        result['objects'][unique_key] = outcome
        result['objectsCompleted'] += 1
    return result


async def handle_upload(
    request: Request, engine_factory: Callable[[], Any], tasks: TaskRegistry, mcp_origin: str
) -> Response:
    """Serve ``POST /mcp/upload/{nonce}``.

    Steps:

    1. Refuse a URL-carried credential (400): the nonce is the authorization.
       Refuse a declared body over ``MAX_UPLOAD_BYTES`` (413). Both before the
       nonce is touched, so a refused request does not spend it.
    2. Redeem the nonce (404 when unknown, already used, or its task is no
       longer tracked -- the three are indistinguishable on purpose).
    3. Bind the credential the nonce was minted under and build the caller's
       engine client through the same factory a tool call uses, so the
       upload is the caller's on the wire and in the ledger. The client is
       closed when the request ends, exactly as ``handle_mcp`` closes its
       per-request clients.
    4. Forward the parts (open -> write -> close per object, via ``send``);
       a body that passes the cap while streaming in is answered 413 (the
       nonce it rode is spent, as any answered request spends it).
    5. Answer the standard engine envelope ``{status: 'OK', data}`` plus the
       NEXT ``upload_url`` on this server's origin: the redeemed nonce is
       spent, and the widget's "drop more files" needs a fresh one. No next
       URL is issued once the task has left the tracker or a fresh launch has
       taken its address over (the control id the nonce was minted for must
       still be the one tracked there; a ``use_existing`` re-add keeps it).

    Args:
        request: The incoming request; ``nonce`` is its path parameter.
        engine_factory: ``__init__._make_engine_factory``'s closure.
        tasks: The server's task tracker, where the nonce was minted.
        mcp_origin: This server's own public origin, for the next link.

    Returns:
        Response: A JSON envelope; errors use the engine's error envelope.
    """
    # 1. no credential rides this URL
    refused = _REFUSED_QUERY_NAMES.intersection(request.query_params.keys())
    if refused:
        return error(
            f'{sorted(refused)[0]!r} is not a parameter on this door: the nonce in the path is the only '
            'authorization and no credential rides the URL',
            httpStatus=400,
        )
    nonce = str(request.path_params.get('nonce') or '')
    if _declared_too_large(request):
        return _too_large(mcp_origin, nonce)  # the nonce is untouched: the same link retries

    # 2. one nonce, one upload
    bound = tasks.consume_upload_nonce(nonce)
    if bound is None:
        return error(
            'unknown or already used upload nonce; call run_dropper_pipe again for a fresh upload_url',
            httpStatus=404,
        )
    address, instance, caller_auth = bound['token'], bound['instance'], bound['caller_auth']

    # 3. the caller's own engine client, 4. forward
    auth_token = identity.CALLER_AUTH.set(caller_auth)
    bucket: list = []
    clients_token = identity.REQUEST_CLIENTS.set(bucket)
    try:
        client = engine_factory()
        try:
            data = await _forward_upload(client, instance, request)
        except UploadTooLarge:
            # this request spent its nonce; while the SAME instance is still
            # tracked, hand out the next link with the refusal. A fresh launch
            # that took the address over meanwhile gets no link: it would carry
            # this request's caller into a run that is not theirs
            try:
                return _too_large(mcp_origin, tasks.issue_upload_nonce(address, caller_auth, instance=instance))
            except KeyError:
                return _too_large(mcp_origin, None)
        except Exception as exc:  # noqa: BLE001 - the body could not be read or split; same envelope as the door
            return exception(exc)
    finally:
        try:
            for per_request in bucket:
                try:
                    await per_request.close()
                except Exception:  # noqa: BLE001 - one failed close must not skip the rest
                    logger.exception('failed to close the upload route engine client')
        finally:
            identity.REQUEST_CLIENTS.reset(clients_token)
            identity.CALLER_AUTH.reset(auth_token)

    # 5. the envelope and the next nonce -- bound to the instance the redeemed
    # nonce named: none when that instance left the tracker or a fresh launch
    # replaced it while the upload ran
    content = ResultSuccess(data=data).model_dump(exclude_none=True)
    try:
        content['upload_url'] = upload_url(
            mcp_origin, tasks.issue_upload_nonce(address, caller_auth, instance=instance)
        )
    except KeyError:
        pass
    return JSONResponse(content=content)


def register_upload_route(server: Any, engine_factory: Callable[[], Any], tasks: TaskRegistry, mcp_origin: str) -> None:
    """Register ``POST /mcp/upload/{nonce}`` as a public route on ``server``.

    Public because the widget carries no credential; the nonce is checked by
    ``handle_upload`` itself. Must run BEFORE the MCP Mount is appended so the
    router reaches this route first.

    Args:
        server: The WebServer (or test double) exposing ``add_route``.
        engine_factory: The module's engine-client factory.
        tasks: The module's task tracker.
        mcp_origin: This server's own public origin (the rotated link's base).
    """

    async def mcp_upload(request: Request) -> Response:
        return await handle_upload(request, engine_factory, tasks, mcp_origin)

    server.add_route(UPLOAD_PATH, mcp_upload, ['POST'], public=True)
