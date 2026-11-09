# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
The public pages contract: the ``publicPages`` + ``site`` manifest sections.

A published platform app declares the pages it serves on the app origin and,
from the app owning ``/``, the site facts the SEO files carry:

    "publicPages": [{"path": "/pricing", "title": "...", "description": "...",
                     "listed": true, "snapshot": "pages/pricing.html",
                     "data": ["plans"]}],
    "site": {"title": "...", "blurb": "...", "docsUrl": "https://.../llms.txt",
             "redirects": [{"from": "/terms", "to": "/legal/terms"}]}

``check_manifest`` is the single validator: the publish gate refuses on any
error it reports, and the aggregate builder re-runs it on every published
manifest (seeded platform rows never pass the gate) and keeps only the pages
it returns.

Both sections are optional and append-only. Keys this engine does not know are
ignored, never rejected, so an older engine still accepts a newer manifest; a
page keeps its unknown keys in ``Page.extra`` for the layers that serve them.

Privilege. There is no app-level privilege flag in the platform (``sys.app``
is a USER permission: the app reviewer). The unforgeable platform-app fact the
code already guarantees is the developer namespace: an org may deploy or
publish only ids inside its own developer id, and the platform org holds
``rocketride`` (see ``app_deploy._assert_owns_namespace``). So privileged = an
id in that namespace. may-claim-root additionally requires the id to be listed
in ``RR_PUBLIC_ROOT_APPS`` (deployment config, default the home app): a
non-root platform app gets no root-mounted pages.
"""

import re
from dataclasses import dataclass, field, replace
from types import MappingProxyType
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

from .settings import public_root_apps

# The platform org's developer id: the namespace that makes an app a platform
# (privileged) app. Matches the OSS account's fixed developerId and the SaaS
# platform org's claim.
PLATFORM_DEVELOPER_ID = 'rocketride'

# Paths no page may claim, segment-aware: every root route the engine serves
# outside its public pages, and the three crawler files. test_reserved_routes
# fails when a registered root route is missing here. /ping, /use, /shutdown,
# /remote and /pipe belong to other server configurations.
RESERVED_PREFIXES = (
    '/.well-known',
    '/api',
    '/apps',
    '/auth',
    '/chat',
    '/client',
    '/docs',
    '/dropper',
    '/llms.txt',
    '/mcp',
    '/openapi.json',
    '/ping',
    '/pipe',
    '/redoc',
    '/remote',
    '/robots.txt',
    '/services',
    '/shell',
    '/shutdown',
    '/sitemap.xml',
    '/status',
    '/task',
    '/use',
    '/version',
    '/webhook',
)

# A page's ``data`` entries name the server data a page binds: ``plans`` (the
# declaring app's plans), ``plans:<appId>`` (a named app's plans) and
# ``app:<appId>`` (one named app). The whole grammar is accepted here, so an
# engine that does not serve a source yet still publishes a manifest naming it.
DATA_FORMS = ('plans', 'plans:<appId>', 'app:<appId>')
_APP_ID = r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}'
_DATA_ENTRY = re.compile(rf'plans|plans:{_APP_ID}|app:{_APP_ID}')

# Patterns are applied with fullmatch: ``$`` would also match before a trailing
# newline.
_SEGMENT = re.compile(r'[a-z0-9\-._~]+')
_SNAPSHOT = re.compile(r'[A-Za-z0-9_\-.]+(?:/[A-Za-z0-9_\-.]+)*\.html')
# A real URL percent-encodes < > " ' and `; raw, they could break out of the HTML attribute a URL lands in.
_HTTPS_URL = re.compile(r'https://[^\s/?#<>"\'`]+[^\s<>"\'`]*')
_MAX_TITLE = 300
_MAX_DESCRIPTION = 1000
_MAX_REDIRECTS = 100

# The page keys this engine validates; every other key lands in ``Page.extra``.
_PAGE_KEYS = frozenset({'path', 'title', 'description', 'listed', 'snapshot', 'data'})


@dataclass(frozen=True)
class Page:
    """One public page claim: the aggregate's unit.

    ``data`` holds the raw ``data`` entries; ``extra`` the page's unknown
    keys, read-only. ``dist_dir`` (the version's servable store tree, where
    snapshots live) and ``published_at`` (the production binding's time) are
    filled by the aggregate loader; ``head_title`` is set only by the legacy
    adapter (empty = use ``title``).
    """

    path: str
    app_id: str
    title: str
    description: str = ''
    listed: bool = True
    snapshot: str = ''
    data: Tuple[str, ...] = ()
    dist_dir: str = ''
    published_at: Optional[float] = None
    head_title: str = ''
    # Out of the hash (a mapping is not hashable), still compared.
    extra: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}), hash=False)


def is_privileged(app_id: str) -> bool:
    """Whether ``app_id`` is a platform app (inside the platform developer namespace)."""
    return app_id == PLATFORM_DEVELOPER_ID or app_id.startswith(PLATFORM_DEVELOPER_ID + '.')


def may_claim_root(app_id: str) -> bool:
    """Whether ``app_id`` may mount pages on the root origin's path space."""
    return is_privileged(app_id) and app_id in public_root_apps()


def path_error(path: Any) -> Optional[str]:
    """Why ``path`` breaks the page-path grammar, or None when it is valid.

    One exact path: absolute, lowercase, no query or fragment, no empty or dot
    segments, no trailing slash (except ``/``). Wildcard pages are not
    supported.
    """
    if not isinstance(path, str):
        return 'must be a string'
    if '*' in path:
        return 'wildcard pages are not supported'
    if not path.startswith('/'):
        return 'must be absolute (start with "/")'
    if path == '/':
        return None
    if path != path.lower():
        return 'must be lowercase'
    if '?' in path:
        return 'must not carry a query'
    if '#' in path:
        return 'must not carry a fragment'
    if path.endswith('/'):
        return 'must not end with a trailing slash'
    for seg in path[1:].split('/'):
        if seg == '':
            return 'must not contain an empty segment ("//")'
        if seg in ('.', '..'):
            return 'must not contain a dot segment'
        if not _SEGMENT.fullmatch(seg):
            return 'contains characters outside [a-z0-9-._~]'
    return None


def _reserved_error(path: str) -> Optional[str]:
    """Why ``path`` falls under a reserved prefix (segment-aware), or None."""
    for prefix in RESERVED_PREFIXES:
        if path == prefix or path.startswith(prefix + '/'):
            return f'is under the reserved prefix {prefix!r}'
    return None


def _snapshot_error(snapshot: Any) -> Optional[str]:
    """Why ``snapshot`` is not a relative ``.html`` path inside the artifact, or None."""
    if not isinstance(snapshot, str) or not _SNAPSHOT.fullmatch(snapshot):
        return 'must be a relative path inside the artifact ending in .html (e.g. "pages/pricing.html")'
    if any(seg in ('.', '..') for seg in snapshot.split('/')):
        return 'must not contain dot segments'
    return None


# A lone surrogate (half a UTF-16 pair: the JSON escape a string cut through an
# emoji leaves) has no UTF-8 encoding, so any response carrying it fails: no
# validated text or URL may hold one.
_SURROGATE = re.compile(r'[\ud800-\udfff]')


def _surrogate_error(value: Any) -> Optional[str]:
    """Why a string value cannot be served as UTF-8 (a lone surrogate), or None."""
    if isinstance(value, str) and _SURROGATE.search(value):
        return 'contains a lone surrogate (U+D800 to U+DFFF), which UTF-8 cannot carry; fix the text encoding'
    return None


def _https_url_error(value: Any) -> Optional[str]:
    """Why ``value`` is not an absolute ``https://`` URL that UTF-8 can carry, or None."""
    err = _surrogate_error(value)
    if err:
        return err
    if not isinstance(value, str) or not _HTTPS_URL.fullmatch(value):
        return 'must be an absolute https:// URL'
    return None


def _page_path_error(path: Any, root: bool, live_conflict: Optional[Callable[[str], Optional[str]]]) -> Optional[str]:
    """Why ``path`` cannot be this app's page, or None: grammar, root privilege, reserved prefix, live route."""
    err = path_error(path)
    if err:
        return err
    if not root:
        return 'root-mounted pages need the may-claim-root privilege (the app id listed in RR_PUBLIC_ROOT_APPS)'
    err = _reserved_error(path)
    if err:
        return f'{err}; choose another path'
    if live_conflict is not None:
        conflict = live_conflict(path)
        if conflict:
            return f'collides with the live server route {conflict}; choose another path'
    return None


def _page_text_error(raw: Dict[str, Any]) -> Optional[str]:
    """Why the page's ``title`` or ``description`` is invalid, as ``<field>: <why>``, or None."""
    title = raw.get('title')
    if not isinstance(title, str) or not title.strip() or len(title) > _MAX_TITLE:
        return f'title: required, a non-empty string of at most {_MAX_TITLE} characters'
    description = raw.get('description', '')
    if not isinstance(description, str) or len(description) > _MAX_DESCRIPTION:
        return f'description: must be a string of at most {_MAX_DESCRIPTION} characters'
    for key, value in (('title', title), ('description', description)):
        err = _surrogate_error(value)
        if err:
            return f'{key}: {err}'
    return None


def _page_data_error(data: Any) -> Optional[str]:
    """Why the page's ``data`` entries are invalid, or None: known forms only, each source once."""
    if not isinstance(data, list) or not all(isinstance(d, str) for d in data):
        return 'must be a list of data-source names'
    for entry in data:
        if not _DATA_ENTRY.fullmatch(entry):
            return f'unknown data source {entry!r}; known forms: {", ".join(DATA_FORMS)}'
    sources = [entry.split(':', 1)[0] for entry in data]
    for name in dict.fromkeys(sources):
        if sources.count(name) > 1:
            return f'{name!r} appears more than once; a page binds each source once'
    return None


def _check_page(
    i: int, raw: Any, root: bool, live_conflict: Optional[Callable[[str], Optional[str]]]
) -> Tuple[Optional[Page], Optional[str]]:
    """One ``publicPages`` entry as a ``Page``, or the first thing wrong with it, field by field."""
    where = f'publicPages[{i}]'
    if not isinstance(raw, dict):
        return None, f'{where}: must be an object'
    path = raw.get('path')
    err = _page_path_error(path, root, live_conflict)
    if err:
        return None, f'{where}.path {path!r}: {err}'
    err = _page_text_error(raw)
    if err:
        return None, f'{where}.{err}'
    listed = raw.get('listed', True)
    if not isinstance(listed, bool):
        return None, f'{where}.listed: must be true or false'
    data = raw.get('data', [])
    err = _page_data_error(data)
    if err:
        return None, f'{where}.data: {err}'
    snapshot = raw.get('snapshot', '')
    if snapshot != '':
        err = _snapshot_error(snapshot)
        if err:
            return None, f'{where}.snapshot {snapshot!r}: {err}'
    page = Page(
        path=path,
        app_id='',
        title=raw['title'],
        description=raw.get('description', ''),
        listed=listed,
        snapshot=snapshot,
        data=tuple(data),
        extra=MappingProxyType({k: v for k, v in raw.items() if k not in _PAGE_KEYS}),
    )
    return page, None


def _check_site(raw: Any) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """The root owner's validated ``site`` block, or the first thing wrong with it."""
    if not isinstance(raw, dict):
        return None, 'site: must be an object'
    out: Dict[str, Any] = {}
    for key in ('title', 'blurb'):
        if key in raw:
            if not isinstance(raw[key], str) or len(raw[key]) > _MAX_DESCRIPTION:
                return None, f'site.{key}: must be a string of at most {_MAX_DESCRIPTION} characters'
            err = _surrogate_error(raw[key])
            if err:
                return None, f'site.{key}: {err}'
            out[key] = raw[key]
    if 'docsUrl' in raw:
        err = _https_url_error(raw['docsUrl'])
        if err:
            return None, f'site.docsUrl: {err}'
        out['docsUrl'] = raw['docsUrl']
    return out, None


def _with_slash_twin(path: str) -> Tuple[str, ...]:
    """``path`` and its trailing-slash twin (``/x`` and ``/x/``); ``/`` has none.

    A redirect source decides both forms' fate: the twin of a page already
    301s to the page, and the twin of a real route is the router's 307.
    """
    if path == '/':
        return (path,)
    return path, (path[:-1] if path.endswith('/') else path + '/')


def _redirect_source_error(
    source: Any, pages: List[Page], live_conflict: Optional[Callable[[str], Optional[str]]]
) -> Optional[str]:
    """Why ``source`` cannot be a redirect's ``from``, or None.

    One exact path in the page grammar, except that a trailing slash is
    allowed (old URLs carry them); not reserved, and neither it nor its slash
    twin is a live route or a page of this manifest.
    """
    if not isinstance(source, str):
        return 'must be a string'
    if '//' in source:
        return 'must not contain an empty segment ("//")'
    err = path_error(source[:-1] if len(source) > 1 and source.endswith('/') else source) or _reserved_error(source)
    if err:
        return err
    paths = {p.path for p in pages}
    for candidate in _with_slash_twin(source):
        which = '' if candidate == source else f'its slash twin {candidate!r} '
        if candidate in paths:
            return f'{which}is a publicPages path (a URL is a page or a redirect, not both)'
        conflict = live_conflict(candidate) if live_conflict else None
        if conflict:
            return f'{which}collides with the live server route {conflict}'
    return None


def _check_redirects(
    raw: Any, pages: List[Page], live_conflict: Optional[Callable[[str], Optional[str]]]
) -> Tuple[Dict[str, str], List[str]]:
    """``site.redirects`` as ``({from: to}, errors)``; a bad entry drops only itself.

    ``to`` must be the exact path of one of this manifest's own pages, so a
    redirect never points at a URL that may 404.
    """
    if not isinstance(raw, list) or len(raw) > _MAX_REDIRECTS:
        return {}, [f'site.redirects: must be a list of at most {_MAX_REDIRECTS} {{"from", "to"}} objects']
    targets = {p.path for p in pages}
    out: Dict[str, str] = {}
    errors: List[str] = []
    for i, entry in enumerate(raw):
        where = f'site.redirects[{i}]'
        if not isinstance(entry, dict):
            errors.append(f'{where}: must be an object {{"from": "/old", "to": "/new"}}')
            continue
        source, target = entry.get('from'), entry.get('to')
        err = _redirect_source_error(source, pages, live_conflict)
        if err is None and source in out:
            err = 'duplicate redirect source in this manifest'
        if err:
            errors.append(f'{where}.from {source!r}: {err}; choose another path or drop the entry')
            continue
        if not isinstance(target, str) or target not in targets:
            errors.append(f"{where}.to {target!r}: must be the exact path of one of this manifest's publicPages")
            continue
        out[source] = target
    return out, errors


def check_manifest(
    app_id: str,
    manifest: Mapping[str, Any],
    live_conflict: Optional[Callable[[str], Optional[str]]] = None,
) -> Tuple[List[Page], Optional[Dict[str, Any]], List[str]]:
    """Validate one manifest's ``publicPages`` + ``site``.

    Args:
        app_id: The publishing app's id (privilege derives from it).
        manifest: The app manifest (``metadata.manifest`` or the build-emitted
            ``app-manifest.json``).
        live_conflict: Optional ``path -> description`` of a live server
            route the path would collide with (None = no collision).

    Returns:
        ``(pages, site, errors)``: the valid pages (stamped with ``app_id``),
        the validated site block (None when absent or invalid; its
        ``redirects``, when declared, maps each valid ``from`` to its ``to``),
        and one actionable message per problem. A manifest without either
        section returns ``([], None, [])``, and so does a non-platform app's
        manifest without ``publicPages``: its ``site`` is ignored.
    """
    raw_pages = manifest.get('publicPages')
    raw_site = manifest.get('site')
    if raw_pages is None and raw_site is None:
        return [], None, []
    if not is_privileged(app_id):
        # A non-platform app owns no '/' page, so its site can never take
        # effect, and 'site' is a generic key a store manifest may already
        # carry: ignore it rather than refuse the publish.
        if raw_pages is None:
            return [], None, []
        return (
            [],
            None,
            [
                f'publicPages is a platform capability: {app_id} is not a platform app '
                f'(not in the {PLATFORM_DEVELOPER_ID!r} developer namespace); remove the section'
            ],
        )
    root = may_claim_root(app_id)
    errors: List[str] = []
    pages: List[Page] = []
    seen = set()
    if raw_pages is not None and not isinstance(raw_pages, list):
        errors.append('publicPages: must be a list of page objects')
        raw_pages = []
    for i, raw in enumerate(raw_pages or []):
        page, err = _check_page(i, raw, root, live_conflict)
        if err:
            errors.append(err)
            continue
        if page.path in seen:
            errors.append(f'publicPages[{i}].path {page.path!r}: duplicate path in this manifest')
            continue
        seen.add(page.path)
        pages.append(replace(page, app_id=app_id))
    site = None
    if raw_site is not None:
        if '/' not in seen:
            errors.append("site: honored only from the app owning '/'; declare the '/' page or drop site")
        else:
            site, err = _check_site(raw_site)
            if err:
                errors.append(err)
            if isinstance(raw_site, dict) and 'redirects' in raw_site:
                redirects, redirect_errors = _check_redirects(raw_site['redirects'], pages, live_conflict)
                errors.extend(redirect_errors)
                if site is not None:
                    site['redirects'] = redirects
    return pages, site, errors
