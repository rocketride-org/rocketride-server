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
FileStore - General-purpose binary file system interface for RocketRide.

Provides directory-like semantics (read, write, delete, list_dir, mkdir, stat)
over the flat key-value IStore backends (Filesystem, S3, Azure). Each FileStore
instance is scoped to a single account via client_id.

Supports handle-based I/O for streaming reads and writes (handles are owned
by the bound context's conn_id):
    handle = await fs.open_write(path)
    await fs.write_chunk(handle, chunk1)
    await fs.write_chunk(handle, chunk2)
    await fs.close_write(handle)

Usage:
    from ai.account.store import Store

    fs = Store.file_store(ctx)  # the handler's RequestContext

    await fs.write('data/input.csv', b'col1,col2\\n1,2\\n')
    data = await fs.read('data/input.csv')
    entries = await fs.list_dir('data/')
    shared = await fs.list_dir('@Development/reports')
"""

import json
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import PurePosixPath
from typing import Any, NamedTuple, Optional

from .models import RequestContext, resolve_task_permissions, team_id_of_name
from .roots import (
    KIND_CONTROL,
    KIND_ME,
    KIND_NONE,
    KIND_ORG,
    KIND_PUBLIC,
    KIND_SPEC,
    KIND_TEAM,
    KIND_USER,
    Root,
    format_root,
    parse_root,
    team_name_key,
)
from .store import IStore, StorageError

# Sentinel file used to represent empty directories on object stores
DIR_MARKER = '.dirmarker'

# Maximum bytes a single read_chunk call may return
MAX_CHUNK_SIZE = 4_194_304  # 4 MB

# Maximum bytes the convenience read() method will materialize in memory.
# Larger files must use the streaming handle API (open_read + read_chunk).
MAX_READ_SIZE = 100 * 1024 * 1024  # 100 MB

# Maximum open handles per connection (DoS bound). Only enforced when the
# ctx conn_id is non-empty — '' means "unowned", used by tests.
MAX_HANDLES_PER_CONNECTION = 64

# Generation of the /task/fetch claim (issue #1767). v1 carried the WIRE
# path and the handler re-resolved it; v2 carries the RESOLVED physical path
# and the handler serves it verbatim. Tokens outlive a deploy, so both meet
# at every upgrade — BUMP THIS whenever a claim's meaning changes, and the
# handler will refuse the older generation instead of misreading it.
FETCH_CLAIM_VERSION = 2

# Characters forbidden inside any single path segment. ':' blocks Windows
# drive-letter syntax (C:\...) from leaking through after the '\\' -> '/'
# conversion in _validate_path.
_INVALID_SEGMENT_CHARS = frozenset('*?<>|":\x00')


def mint_directory_url(dir_path: str, entry_file: str, expires_in: int = 86400, sub: str = 'system') -> str:
    """
    Mint a signed DIRECTORY-capability fetch URL for a multi-file bundle.

    Module Federation remotes are multi-file: ``remoteEntry.js`` fetches its
    async chunks RELATIVE to its own URL, so a single-file query-token URL
    (``/task/fetch?token=...``) cannot serve one — the chunk requests would
    resolve tokenless against ``/task/fetch/``. This mints the path-embedded
    form instead: ``{base}/task/fetch/{token}/{entry_file}``, whose token
    authorizes the whole ``dir_path`` directory. Every relative chunk request
    then inherits the token naturally
    (``/task/fetch/{token}/static/js/async/...``).

    The caller is responsible for AUTHORIZING ``dir_path`` before minting —
    like ``FileStore.get_url``, the signed JWT is the capability and the
    fetch handler serves it verbatim. Bundle directories are immutable, so
    the default expiry is generous (24h); manifest deliveries re-mint on
    every login/account push.

    Args:
        dir_path:   RESOLVED physical store path of the bundle directory
                    (e.g. ``marketplace/apps/<id>/<ver>``, no trailing slash).
        entry_file: File within the directory the URL should address
                    (e.g. ``remoteEntry.js``).
        expires_in: Token validity in seconds (default 24 hours).
        sub:        Audit-trail subject baked into the claim.

    Returns:
        Absolute URL to ``entry_file`` inside the signed directory.

    Raises:
        ValueError:   If ``expires_in`` is not positive.
        RuntimeError: If ``RR_BASE_URL`` is not configured.
    """
    import os
    import time

    import jwt

    from ai.constants import CONST_DEFAULT_SIGNING_KEY

    if expires_in <= 0:
        raise ValueError('expires_in must be positive')

    # Unset falls back to the self-describing development default so a fresh
    # install works out of the box; production replaces it via .env/.config.
    signing_key = os.environ.get('RR_SIGNING_KEY', '') or CONST_DEFAULT_SIGNING_KEY

    # Directory claim: `dir` (not `path`) so the fetch handler knows the
    # capability covers a subtree, gated by the same claim generation.
    payload = {
        'sub': sub,
        'dir': dir_path.rstrip('/'),
        'v': FETCH_CLAIM_VERSION,
        'exp': int(time.time()) + expires_in,
    }
    token = jwt.encode(payload, signing_key, algorithm='HS256')

    base_url = os.environ.get('RR_BASE_URL')
    if not base_url:
        raise RuntimeError(
            'RR_BASE_URL is not set — configure it in .env or ensure'
            ' the web server has started before generating fetch URLs'
        )
    return f'{base_url}/task/fetch/{token}/{entry_file}'


# =============================================================================
# SCOPE GRAMMAR + PERMISSION POLICY
#
# The storage layer is the security boundary: every path of every operation
# is authorized HERE, at the single point where it resolves, against the
# RequestContext the FileStore was constructed with (the same per-request
# identity every on_* handler carries — see models.RequestContext).
#
# Store paths open with an optional ROOT, the first part before the first
# '/', which says whose tree is meant (plan 2.5). The grammar is read by
# ``roots.parse_root`` alone; this module only decides which roots are
# storage places and who may resolve them:
#   <rest>               → users/<client_id>/files/<rest>   (the caller's own)
#   @me/<rest>           → users/<client_id>/files/<rest>   (the same tree)
#   @<team>/<rest>       → teams/<teamId>/files/<rest>      (a team, by name,
#                          from the caller's own membership, ignoring case)
#   @org/<rest>          → orgs/<myOrgId>/files/<rest>      (the caller's
#                          active org; org.admin only)
#   =team/<tid>/<rest>   → teams/<tid>/files/<rest>         (a team, by id)
#   =org/<oid>/<rest>    → orgs/<oid>/files/<rest>          (an org, by id)
#   =user/<uid>/<rest>   → users/<uid>/files/<rest>         (a user, by id:
#                          sys.admin and internal subsystems only)
# '@spec', '@public' and '=control/<id>' are roots of the grammar but no
# storage places, and are refused. '@' itself is a virtual listing served by
# cmd_store (one entry per root the caller can open), never resolved here.
# Names on the wire, ids on disk; name resolution consults ONLY the caller's
# own membership. Unknown, foreign, permission-less, and ambiguous references
# deny with ONE identical message (no existence leak). Under any root the
# first entry name may not start with '=' or '@' (so a root can never be
# shadowed by a real file).
# =============================================================================

# SYSTEM-OWNED subtrees: written by the engine, served by their own domain
# APIs (rrext_log today, rrext_deploy later). Through the FILE API they are
# fully reserved — a user could corrupt them, and they can contain
# information the user must not see raw — so only internal identities and
# sys.admin sessions may touch them (sys.admin: anything). Everyone else:
# invisible in listings (cmd_store filters) and denied on access.
SYSTEM_TREES = frozenset({'.logs', '.deployments'})

# Everything outside the system trees requires the file-storage permission.
_DEFAULT_PERMISSION = 'task.store'

# The uniform denial for scoped paths — identical for unknown, foreign,
# permission-less, and ambiguous references so nothing leaks existence.
_DENIED = 'Access denied for scoped path'

# The physical top directory of each id root's tree.
_PHYSICAL_ROOTS = {KIND_TEAM: 'teams', KIND_ORG: 'orgs', KIND_USER: 'users'}


def _audit_crossing(ctx: 'RequestContext', client_id: str, target: str) -> None:
    """Record a sys.admin ``=id`` cross-boundary storage resolution.

    These are the ONLY resolutions where the storage boundary is crossed
    rather than enforced (the platform support capability), so each one is
    traced server-side with actor, connection, and target scope. Trace-only —
    the wire response never distinguishes a crossing from an ordinary resolve,
    preserving the uniform-denial / no-oracle posture.
    """
    from rocketlib import debug

    debug(f'AUDIT storage crossing (sys.admin): client={client_id} conn={getattr(ctx, "conn_id", None)} -> {target}')


def _system_tree(rest: str) -> 'Optional[str]':
    """Return the system-tree name when ``rest`` enters one, else None."""
    first = rest.split('/', 1)[0] if rest else ''
    return first if first in SYSTEM_TREES else None


def normalize_path(path: str) -> str:
    """Validate and normalize a user-provided wire path — THE normalization.

    Every consumer that makes a decision about a wire path (the resolver
    below via ``FileStore._validate_path``, cmd_store's scope-root filter)
    must run this SAME routine first, so no two components can ever disagree
    about which location a spelling addresses ('@me//x', '@me/./x' and
    '\\@me\\x' all normalize to '@me/x' — deciding on the raw spelling
    while resolving the normalized one is a filter bypass).

    Rules: backslashes become '/', leading slashes drop, '..' and control /
    reserved characters raise, empty and '.' segments collapse away.

    Raises:
        ValueError: On path traversal or invalid characters.
    """
    path = path.replace('\\', '/')

    if path.startswith('/'):
        path = path.lstrip('/')

    parts = path.split('/')
    if '..' in parts:
        raise ValueError(f'Path traversal not allowed: {path}')

    for part in parts:
        if part and any(c in _INVALID_SEGMENT_CHARS or ord(c) < 0x20 for c in part):
            raise ValueError(f'Path contains invalid characters: {path}')

    normalized = str(PurePosixPath(path)) if path else ''
    if normalized == '.':
        normalized = ''

    return normalized


def parse_scope(normalized: str) -> Root:
    """Split a NORMALIZED path into its storage root and the rest.

    Must be fed the output of ``_validate_path``: normalizing first is what
    defeats the ``\\=team\\x``, ``/=team/x``, ``./@me/x`` bypass family (all
    of those normalize INTO the root grammar and are parsed there, never
    around it). The grammar itself is ``roots.parse_root``; this function
    only refuses the roots that are not storage places.

    Kinds returned (``Root.kind``, with ``by_id`` and ``ref``):
      - ``none``                    the caller's own tree (a plain path)
      - ``me``                      the caller's own tree (``@me/``)
      - ``team`` by name or by id   ``@<team>/`` or ``=team/<tid>/``
      - ``org`` by word or by id    ``@org/`` or ``=org/<oid>/``
      - ``user`` by id              ``=user/<uid>/``

    Raises:
        ValueError: The path is not in the root grammar (bare ``@``, the
            retired ``@/User``, ``@/Team/<ref>`` and ``@/Org`` spellings, an
            unknown ``=`` kind, a first entry starting with ``@`` or ``=``),
            or its root is no storage place (``@spec``, ``@public``,
            ``=control/<id>``).
    """
    root = parse_root(normalized)
    if root.kind in (KIND_SPEC, KIND_PUBLIC, KIND_CONTROL):
        raise ValueError(f'{format_root(root.kind, root.ref, root.by_id)} is not a storage place')
    return root


def _team_ids(account_info) -> 'set[str]':
    """The caller's own team ids, from the session membership list."""
    org = getattr(account_info, 'organization', None) or {}
    return {t['id'] for t in (org.get('teams', []) if isinstance(org, dict) else []) if t.get('id')}


def validate_storage_root(root: str) -> str:
    """Validate an engine storage anchor and return it normalized.

    The anchor is built by trusted server code (``storage_root_for``) from
    identifiers that came in with a request, so validate shape defensively:
    a physical path of the form ``users|teams|orgs/<id>/files[/<subtree>]``
    built from path-safe segments. Anything else raises ValueError.
    """
    if not isinstance(root, str) or not root:
        raise ValueError('storage root must be a non-empty string')
    segments = root.strip('/').split('/')
    if len(segments) < 3 or segments[0] not in ('users', 'teams', 'orgs') or segments[2] != 'files':
        raise ValueError(f'Invalid storage root: {root!r} (expected users|teams|orgs/<id>/files[/...])')
    for segment in segments[1:]:
        if not segment or segment in ('.', '..') or '\\' in segment or segment.startswith(('@', '=')):
            raise ValueError(f'Invalid storage root segment: {segment!r}')
    return '/'.join(segments)


def storage_root_for(owner_kind: str, user_id: str, team_id: str, project_id: str, org_id: str = '') -> str:
    """The storage anchor of a control's owner: where its nodes' plain paths resolve (plan 2.5, 5.7).

    A TEAM-owned run (a @team deploy) anchors in a task-specific subtree of
    TEAM storage, so teammates can watch and replay it and two deployments
    never share working storage; an ORG-owned run anchors the same way in the
    org's tree; a USER-owned run (an interactive run, a personal @me deploy)
    anchors in the owner's whole user tree, private and never colliding with
    the team's run of the same project. Node-level paths are identical in all.

    Args:
        owner_kind: ``'team'``, ``'org'`` or ``'user'``.
        user_id: The owning (or launching) user.
        team_id: The owning team of a team-owned run.
        project_id: The pipeline's short id.
        org_id: The owning org of an org-owned run.

    Returns:
        The validated root.

    Raises:
        ValueError: There is no owner to anchor in (an anonymous run), an
            identifier is not a path-safe segment, or the owner kind is
            unknown.
    """
    if owner_kind == 'team':
        if not team_id or not project_id:
            raise ValueError('team-owned runs require a team_id and a project_id for their storage anchor')
        return validate_storage_root(f'teams/{team_id}/files/tasks/{project_id}')
    if owner_kind == 'org':
        if not org_id or not project_id:
            raise ValueError('org-owned runs require an org_id and a project_id for their storage anchor')
        return validate_storage_root(f'orgs/{org_id}/files/tasks/{project_id}')
    if owner_kind != 'user':
        raise ValueError(f'Unknown owner kind for a storage anchor: {owner_kind!r}')
    if not user_id:
        raise ValueError('a run with no owner has no storage anchor')
    return validate_storage_root(f'users/{user_id}/files')


def _resolve_team_name(account_info, name: str) -> str:
    """Resolve a team display name to its id — caller's own org ONLY.

    Names match ignoring case (``models.team_id_of_name``, by the key the
    teams table is unique on) and must name exactly one of the caller's teams
    (fail closed on a duplicate). Unknown or ambiguous names raise the SAME
    uniform error — and a foreign org's names are inexpressible by
    construction, since the only dictionary consulted is the caller's own
    membership list.
    """
    team_id = team_id_of_name(account_info, name)
    if not team_id:
        raise PermissionError(_DENIED)
    return team_id


class DeclaredRoot(NamedTuple):
    """
    One root a pipeline declared (``"roots": ["@Development/kb"]``), resolved through its run's owner (plan 2.5).

    ``self.files`` admits a rooted path only under a declared root: the same
    tree (a team by the name it was declared by, ignoring case, or by its id;
    the org as ``@org`` or by its id) and the declared path or below it.

    Attributes:
        kind: ``team`` or ``org``.
        ref_id: The team or org id the root resolved to.
        name_key: The casefolded team name it was declared by ('' when by id, or the org).
        rest: The path under the tree the declaration names ('' for the whole tree).
        physical: The tree's physical root (``teams/<tid>/files``, ``orgs/<oid>/files``).
        text: The declaration as written, for messages.
    """

    kind: str
    ref_id: str
    name_key: str
    rest: str
    physical: str
    text: str

    def admits(self, root: Root, rest: str) -> bool:
        """Whether a parsed node path (``root`` and its ``rest``) is under this declaration."""
        if root.kind != self.kind:
            return False
        if root.by_id:
            if root.ref != self.ref_id:
                return False
        elif self.kind == KIND_TEAM and (not self.name_key or team_name_key(root.ref) != self.name_key):
            return False
        return not self.rest or rest == self.rest or rest.startswith(self.rest + '/')


def declared_roots(
    roots: Any,
    *,
    owner_kind: str,
    owner_id: str,
    org_id: str,
    account_info: Any = None,
) -> 'tuple[DeclaredRoot, ...]':
    """
    Resolve a pipeline's declared ``roots`` through the run's OWNER, refusing what the owner could not reach (plan 2.5).

    Called when a control starts. Each entry is a storage path whose first
    segment is a team or org root (``@Development/kb``, ``=team/<tid>/kb``,
    ``@org/shared``). The owner reaches what it could reach in a session: a
    USER its own tree (no declaration needed), the teams where it holds
    ``task.store`` and the org with ``org.admin``, judged on its own session
    (``account_info``); a TEAM its own tree; the ORG the org tree. ``@me/``
    and ``=user/`` are never declarable, and neither are the store words.

    Args:
        roots: The spec's ``roots`` value (absent: None or empty).
        owner_kind: ``user``, ``team`` or ``org``.
        owner_id: The owning user, team or org id.
        org_id: The run's org.
        account_info: The session a team NAME resolves through and, for a
            user owner, whose reach is judged: the caller of the run (a user
            owner is its caller). None for a run with no caller.

    Returns:
        The resolved declarations, in the spec's order.

    Raises:
        ValueError: ``roots`` is not a list of non-empty strings, or an entry
            is outside the grammar or names no team or org tree.
        PermissionError: The owner could not reach an entry (the start is
            refused, naming it).
    """
    if roots is None or roots == []:
        return ()
    if not isinstance(roots, list) or not all(isinstance(entry, str) and entry for entry in roots):
        raise ValueError('"roots" must be a list of storage paths such as "@Development/kb"')
    out = []
    for text in roots:
        root = parse_scope(normalize_path(text))
        rest = root.rest
        if root.kind not in (KIND_TEAM, KIND_ORG):
            raise ValueError(
                f'roots: {text!r} names no team or org tree (declare @<team>/..., =team/<tid>/... or @org/...)'
            )
        if _system_tree(rest):
            raise PermissionError(f'roots: {text!r} enters a system tree')
        refused = PermissionError(f"roots: {text!r} is outside what this run's owner may reach")

        # The org tree: the run's own org, for an org owner or an org admin
        if root.kind == KIND_ORG:
            if root.by_id and root.ref != org_id:
                raise refused
            if owner_kind == KIND_USER:
                org = getattr(account_info, 'organization', None) or {}
                if str(org.get('id') or '') != org_id or 'org.admin' not in (org.get('permissions') or []):
                    raise refused
            elif owner_kind != KIND_ORG:
                raise refused
            out.append(DeclaredRoot(KIND_ORG, org_id, '', rest, f'orgs/{org_id}/files', text))
            continue

        # A team tree: by id, or by name through the owner's session
        team_id = root.ref if root.by_id else (team_id_of_name(account_info, root.ref) if account_info else '')
        if not team_id:
            raise refused
        if owner_kind == KIND_USER:
            if account_info is None or 'task.store' not in resolve_task_permissions(account_info, team_id):
                raise refused
        elif owner_kind != KIND_TEAM or team_id != owner_id:
            raise refused
        name_key = '' if root.by_id else team_name_key(root.ref)
        out.append(DeclaredRoot(KIND_TEAM, team_id, name_key, rest, f'teams/{team_id}/files', text))
    return tuple(out)


def resolve_scope(
    ctx: RequestContext,
    client_id: str,
    normalized: str,
    engine_root: 'Optional[str]' = None,
    declared: 'tuple[DeclaredRoot, ...]' = (),
) -> 'tuple[str, str, str]':
    """Authorize and resolve a normalized path to its physical scope root.

    THE enforcement point: called for every path of every operation, against
    the bound RequestContext. Returns ``(kind, scope_root, rest)`` — kind is
    whose tree resolved ('own'/'team'/'org'/'user'), returned so callers
    never re-parse a path this function already parsed.

    Who may resolve what (plan 2.5):
      - ``ctx.source == 'engine'`` (a node's ``self.files``): plain paths
        land in the run's storage anchor; a team or org root only under a
        root the pipeline DECLARED (``declared``, resolved through the run's
        owner when its control started); every other root (``@me/`` and
        ``=user/`` always) and every system tree is rejected — an
        LLM-generated path can never reach a root nobody declared.
      - ``'internal'`` sysPermission (trusted subsystems: the run-log writer,
        the deploy commands): they hold ids, so they write ``=`` roots,
        resolved by id with no checks, system trees included. A team name or
        ``@org/`` means nothing to them and is refused.
      - sys.admin sessions: everything, system trees included; a team of
        their own org by name, any team, org or user by id. Every non-member
        or foreign crossing is audited.
      - ordinary sessions: the OWN tree (plain paths and ``@me/``) is
        unconditional — ownership is the authorization, no team or org grant
        consulted; ``@<team>/`` and ``=team/<tid>/`` as a member holding
        ``task.store``; ``@org/`` and ``=org/<oid>/`` in their own org with
        ``org.admin``; ``=user/<uid>/`` never. SYSTEM TREES ARE FULLY DENIED —
        logs/deployments are reachable only through their domain APIs
        (rrext_log / rrext_deploy), never the file API.

    Raises:
        PermissionError: Identity may not touch the addressed location (or
            the reference is unknown/foreign/ambiguous — uniform message).
        ValueError: The path is not in the root grammar, or its root is no
            storage place.
    """
    root = parse_scope(normalized)
    rest = root.rest
    own = root.kind in (KIND_NONE, KIND_ME)

    # -- Engine (a node's self.files): most restricted — plain paths, no system trees
    # Every path is relative to the binding owner's storage anchor (chroot
    # semantics, storage_root_for): the owner's whole tree for dev runs, a
    # task-specific team subtree for deploy runs — so node-level paths are
    # identical in both modes and can never leave the anchor.
    if ctx.source == 'engine':
        if _system_tree(rest):
            raise PermissionError(f'{_system_tree(rest)}/ is not available in the engine context')
        if root.kind == KIND_NONE:
            return ('own', engine_root or f'users/{client_id}/files', rest)
        match = next((entry for entry in declared if entry.admits(root, rest)), None)
        if match is None:
            raise PermissionError(
                f'{format_root(root.kind, root.ref, root.by_id)}/ is not a root this pipeline declares '
                '(list it in the pipeline\'s "roots")'
            )
        return (root.kind, match.physical, rest)

    account_info = ctx.account_info
    if account_info is None:
        raise PermissionError('Not authenticated')

    sys_perms = account_info.sysPermissions or []
    is_internal = 'internal' in sys_perms
    is_sys_admin = 'sys.admin' in sys_perms

    # -- Internal subsystems: mechanical, ids only, no checks ----------------
    # Deliberately BEFORE the system-tree gate below (intent, not
    # fall-through): the run-log writer and the domain APIs (rrext_log,
    # rrext_deploy) write .logs/.deployments through exactly this identity —
    # pinned by test_internal_identity_writes_logs.
    if is_internal:
        if own:
            return ('own', f'users/{client_id}/files', rest)
        if not root.by_id:
            raise PermissionError(_DENIED)  # internal has no name dictionary and no org context
        return (root.kind, f'{_PHYSICAL_ROOTS[root.kind]}/{root.ref}/files', rest)

    # -- System trees: sys.admin may do anything, everyone else nothing ------
    # (Checked before scope resolution so the denial is uniform and early.)
    if _system_tree(rest) and not is_sys_admin:
        raise PermissionError(f'{_system_tree(rest)}/ is system-owned (use its API)')

    # -- Own namespace: plain paths and @me/<rest> ---------------------------
    # Ownership IS the authorization: this branch resolves to the caller's
    # own users/<id>/files tree by construction, so an authenticated
    # identity needs no team- or org-carried permission. Personal storage
    # must survive every org/team context switch — routing it through the
    # active org's team grants denied users their own files whenever an
    # org switch landed them somewhere they hold no team membership.
    if own:
        return ('own', f'users/{client_id}/files', rest)

    # -- =user/<uid>: the support spelling — sys.admin only, always audited --
    if root.kind == KIND_USER:
        if not is_sys_admin:
            raise PermissionError(_DENIED)
        _audit_crossing(ctx, client_id, f'users/{root.ref}')
        return ('user', f'users/{root.ref}/files', rest)

    # -- @org and =org/<oid>: MY org with org.admin; another org for sys.admin
    if root.kind == KIND_ORG:
        org = account_info.organization if isinstance(account_info.organization, dict) else {}
        if root.by_id and root.ref != org.get('id'):
            if not is_sys_admin:
                raise PermissionError(_DENIED)
            _audit_crossing(ctx, client_id, f'orgs/{root.ref}')
            return ('org', f'orgs/{root.ref}/files', rest)
        if not org.get('id'):
            raise PermissionError(_DENIED)
        if 'org.admin' not in (org.get('permissions') or []) and not is_sys_admin:
            raise PermissionError(_DENIED)
        return ('org', f'orgs/{org["id"]}/files', rest)

    # -- @<team> and =team/<tid> ---------------------------------------------
    # (parse_scope let only none/me/user/org/team through, so this is a team.)
    if root.kind != KIND_TEAM:
        raise ValueError(f'Unknown storage root kind: {root.kind!r}')
    if root.by_id:
        if root.ref in _team_ids(account_info):
            team_id = root.ref
        elif is_sys_admin:
            # A team the caller is NOT a member of — a boundary crossing,
            # unlike the member resolution above (which crosses nothing).
            _audit_crossing(ctx, client_id, f'teams/{root.ref}')
            team_id = root.ref
        else:
            raise PermissionError(_DENIED)
    else:
        team_id = _resolve_team_name(account_info, root.ref)

    if is_sys_admin:
        return ('team', f'teams/{team_id}/files', rest)

    perms = resolve_task_permissions(account_info, team_id)
    if _DEFAULT_PERMISSION not in perms:
        raise PermissionError(_DENIED)
    return ('team', f'teams/{team_id}/files', rest)


def _sanitize_download_name(name: str) -> str:
    """
    Make a filename safe to embed in a ``Content-Disposition`` header value.

    Strips characters that could break out of the quoted ``filename="..."``
    token or inject header content (CR/LF, double quotes, backslashes, control
    chars) and falls back to a default if nothing usable remains.

    Args:
        name: The caller-supplied download filename.

    Returns:
        A sanitized, quote-safe ASCII-ish filename.
    """
    # Drop CR/LF (header injection), quotes/backslashes (quoting), and control chars.
    cleaned = ''.join(c for c in name if c >= ' ' and c not in '"\\\r\n').strip()
    return cleaned or 'download'


class FileHandleMode(Enum):
    """Mode for an open file handle."""

    READ = 'r'
    WRITE = 'w'


@dataclass
class FileHandle:
    """Tracks an open file handle and its backend-specific context."""

    handle_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    path: str = ''
    mode: FileHandleMode = FileHandleMode.READ
    # The owning ctx.conn_id ('' = unowned) — scopes handles per connection
    # for ownership checks, the DoS cap, and disconnect cleanup.
    connection_id: str = ''
    context: Any = None
    bytes_written: int = 0
    closed: bool = False


class FileStore:
    """
    General-purpose binary file system interface built on top of IStore.

    THE STORAGE SECURITY BOUNDARY: every path of every operation resolves —
    and is AUTHORIZED — in one place (``_full_path`` → ``resolve_scope``),
    against the ``RequestContext`` bound at construction — the SAME
    per-request identity the DAP handlers carry, so identity flows wire →
    handler → store unchanged. Plain paths scope to
    ``users/<client_id>/files/`` exactly as before; the ``@<team>/``, ``=team/<tid>/`` and
    ``@org/`` roots resolve to ``teams/<id>/files/`` /
    ``orgs/<id>/files/`` with the policy table deciding the required
    access rule per subtree (system trees are internal/sys.admin only).

    Instances are cheap per-consumer wrappers constructed via
    ``Store.file_store(ctx)`` — identity is NEVER cached across
    sessions (concurrent sessions of one user can carry different permission
    envelopes, e.g. PAT-scoped). The write-lock set and open-handle registry
    are SHARED on the owning Store so two instances addressing the same
    physical file still exclude each other; both are single-process guards
    only — cross-node consistency is the backend's whole-object atomicity.

    Handle-based operations (open_write/read, write_chunk/read_chunk, close)
    allow streaming large files without buffering everything in memory.
    Each handle is tagged with a connection_id so it can be cleaned up when
    the owning connection terminates.
    """

    def __init__(
        self,
        owner,
        client_id: str,
        ctx: RequestContext,
        root: 'Optional[str]' = None,
        declared: 'tuple[DeclaredRoot, ...]' = (),
    ):
        """Bind this instance to its owning Store, account, and identity.

        Args:
            owner: The Store wrapper providing the IStore backend and the
                   SHARED write-lock/handle registries.
            client_id: Account id for plain-path scoping.
            ctx: REQUIRED per-request identity (the handler's ctx, or
                 RequestContext.internal()/engine() for server subsystems) —
                 omission is a TypeError, not a silently-unauthorized store.
            root: ENGINE contexts only — the storage anchor of the binding's
                  owner (``storage_root_for``); every plain path a node's
                  ``self.files`` speaks resolves relative to it (chroot
                  semantics), so dev and deploy runs use identical
                  node-level paths. Validated by ``validate_storage_root``;
                  forbidden for other identities (their anchor is their own
                  namespace).
            declared: ENGINE contexts only — the roots the binding's pipeline
                  declared, resolved through its owner (``declared_roots``):
                  the team and org paths ``self.files`` admits beyond the anchor.
        """
        if not client_id:
            raise ValueError('client_id is required')
        if '/' in client_id or '\\' in client_id:
            raise ValueError('client_id must not contain path separators')
        if client_id in ('.', '..'):
            raise ValueError('client_id must not be "." or ".."')
        if not isinstance(ctx, RequestContext):
            raise TypeError('ctx must be a RequestContext')
        if root is not None:
            if ctx.source != 'engine':
                raise ValueError('storage root overrides exist for engine contexts only')
            root = validate_storage_root(root)
        if declared and ctx.source != 'engine':
            raise ValueError('declared roots exist for engine contexts only')
        self._owner = owner
        self._store: IStore = owner._store
        self._client_id = client_id
        self._ctx = ctx
        self._root = root
        self._declared = tuple(declared)

    # Shared single-process guards live on the owning Store so every
    # FileStore instance — regardless of which user or identity constructed
    # it — coordinates on the same physical paths.
    @property
    def _handles(self) -> 'dict[str, FileHandle]':
        """The Store-wide open-handle registry."""
        return self._owner._shared_handles

    @property
    def _write_locks(self) -> 'set[str]':
        """The Store-wide set of physical paths open for writing."""
        return self._owner._shared_write_locks

    # =========================================================================
    # Handle-Based Write Operations
    # =========================================================================

    async def open_write(self, path: str) -> str:
        """
        Open a file for writing. The handle is owned by the bound context's
        conn_id (cleanup on disconnect; ownership-checked on use).

        Args:
            path: Relative path within the account store.

        Returns:
            Handle ID string.

        Raises:
            StorageError: If the path is already open for writing.
        """
        connection_id = self._ctx.conn_id
        full_path = self._full_path(path)
        if full_path in self._write_locks:
            raise StorageError(f'File already open for writing: {path}')
        if connection_id and self._count_handles_for(connection_id) >= MAX_HANDLES_PER_CONNECTION:
            raise StorageError(f'Too many open handles for connection {connection_id}')

        # Acquire lock before awaiting to prevent races at suspension points
        self._write_locks.add(full_path)
        try:
            result = await self._store.open_write(full_path)
        except BaseException:
            # Catch BaseException so asyncio.CancelledError (BaseException
            # subclass since Python 3.8) still releases the lock on cancel.
            self._write_locks.discard(full_path)
            raise

        handle = FileHandle(
            path=full_path,
            mode=FileHandleMode.WRITE,
            connection_id=connection_id,
            context=result['context'],
        )
        self._handles[handle.handle_id] = handle
        return handle.handle_id

    async def write_chunk(self, handle_id: str, data: bytes) -> int:
        """
        Write data to an open write handle (ownership checked via the ctx).

        Args:
            handle_id: Handle returned by open_write.
            data: Bytes to append.

        Returns:
            Number of bytes written.
        """
        handle = self._get_handle(handle_id, FileHandleMode.WRITE)
        written = await self._store.write_chunk(handle.path, handle.context, data)
        handle.bytes_written += written
        return written

    async def close_write(self, handle_id: str) -> None:
        """Close a write handle, committing the data."""
        handle = self._get_handle(handle_id, FileHandleMode.WRITE)
        try:
            await self._store.close_write(handle.path, handle.context)
        except StorageError as e:
            # Enrich the error with bytes-written so callers can assess damage
            raise StorageError(f'Close failed after {handle.bytes_written} bytes; file state indeterminate: {e}') from e
        finally:
            self._release_handle(handle)

    # =========================================================================
    # Handle-Based Read Operations
    # =========================================================================

    async def open_read(self, path: str) -> dict:
        """
        Open a file for reading. The handle is owned by the bound context's
        conn_id (cleanup on disconnect; ownership-checked on use).

        Args:
            path: Relative path within the account store.

        Returns:
            Dict with 'handle' (str) and 'size' (int).
        """
        connection_id = self._ctx.conn_id
        full_path = self._full_path(path)
        if connection_id and self._count_handles_for(connection_id) >= MAX_HANDLES_PER_CONNECTION:
            raise StorageError(f'Too many open handles for connection {connection_id}')
        result = await self._store.open_read(full_path)
        handle = FileHandle(
            path=full_path,
            mode=FileHandleMode.READ,
            connection_id=connection_id,
            context=result['context'],
        )
        self._handles[handle.handle_id] = handle
        return {'handle': handle.handle_id, 'size': result['size']}

    async def read_chunk(self, handle_id: str, offset: int, length: int = MAX_CHUNK_SIZE) -> bytes:
        """
        Read data from an open read handle.

        Args:
            handle_id: Handle returned by open_read.
            offset: Byte offset to read from.
            length: Max bytes to read (default 4 MB, capped at MAX_CHUNK_SIZE).

        Returns:
            Bytes read. Empty bytes indicates EOF.
        """
        if offset < 0:
            raise StorageError(f'Offset must be non-negative, got {offset}')
        if length <= 0:
            raise StorageError(f'Read length must be positive, got {length}')
        length = min(length, MAX_CHUNK_SIZE)
        handle = self._get_handle(handle_id, FileHandleMode.READ)
        return await self._store.read_chunk(handle.path, handle.context, offset, length)

    async def close_read(self, handle_id: str) -> None:
        """Close a read handle."""
        handle = self._get_handle(handle_id, FileHandleMode.READ)
        try:
            await self._store.close_read(handle.path, handle.context)
        finally:
            self._release_handle(handle)

    # =========================================================================
    # Connection Cleanup
    # =========================================================================

    async def close_all_handles(self) -> None:
        """
        Force-close all handles owned by this instance's connection.

        Store.close_all_handles(conn_id) is the disconnect-time cleanup that
        covers every instance; this is the per-view convenience.
        """
        conn_id = self._ctx.conn_id
        handles_to_close = [h for h in self._handles.values() if h.connection_id == conn_id]
        for handle in handles_to_close:
            await self._force_close_handle(handle.handle_id)

    # =========================================================================
    # Convenience Methods (fire-and-forget, use handles internally)
    # =========================================================================

    async def read(self, path: str, max_size: int = MAX_READ_SIZE) -> bytes:
        """
        Read file contents as raw bytes.

        This convenience method materializes the entire file in memory.
        For files larger than ``max_size`` use the streaming handle API
        (``open_read`` + ``read_chunk`` + ``close_read``).

        Args:
            path: Relative path within the account store.
            max_size: Maximum file size in bytes (default 100 MB). Files
                exceeding this are rejected to prevent OOM.

        Returns:
            Raw bytes of the file.

        Raises:
            StorageError: If the file does not exist, exceeds max_size, or
                read fails.
        """
        info = await self.open_read(path)
        # Fail fast if the backend reports a size larger than the cap
        if info.get('size', 0) > max_size:
            await self.close_read(info['handle'])
            raise StorageError(
                f'File exceeds max_size ({info["size"]} > {max_size}); use the streaming handle API for large files'
            )
        try:
            chunks = []
            offset = 0
            while True:
                chunk = await self.read_chunk(info['handle'], offset)
                if not chunk:
                    break
                chunks.append(chunk)
                offset += len(chunk)
            return b''.join(chunks)
        finally:
            await self.close_read(info['handle'])

    async def write(self, path: str, data: bytes) -> None:
        """
        Write raw bytes to a file.

        Args:
            path: Relative path within the account store.
            data: Raw bytes to write.

        Raises:
            StorageError: If write fails.
        """
        handle_id = await self.open_write(path)
        try:
            await self.write_chunk(handle_id, data)
            await self.close_write(handle_id)
        except Exception:
            await self._force_close_handle(handle_id)
            raise

    async def put_json(self, path: str, value: Any) -> int:
        """
        Write a JSON value to a file in ONE operation.

        The handle API (open_write / write_chunk / close_write) spreads a
        write across several round trips, and a handle that never reaches
        close_write is still COMMITTED by disconnect cleanup — so a client
        that dies between open and write replaces the file with whatever it
        had buffered, which is nothing. That is how a workspace file became
        zero bytes on a browser reload.

        This has no such window: one request, one backend write, no
        intermediate state anything could commit on its behalf. A request
        that never arrives leaves the file exactly as it was.

        Deliberately NOT a temp-file-then-rename: object stores have no
        rename (a move is copy + delete — more round trips, no atomicity,
        and stray objects), while their PUT already replaces an object
        atomically. The single write is both the simplest and the most
        atomic thing every backend can offer.

        Args:
            path: Relative path within the account store.
            value: Any JSON-serialisable value.

        Returns:
            Number of bytes written.

        Raises:
            StorageError: If the value is not serialisable, exceeds
                MAX_CHUNK_SIZE, or the write fails.
        """
        try:
            # allow_nan=False: NaN/Infinity would serialize to text the
            # browser's JSON.parse rejects, making the file unreadable.
            payload = json.dumps(value, indent=2, allow_nan=False).encode('utf-8')
        except (TypeError, ValueError) as exc:
            raise StorageError(f'Value is not JSON-serialisable for {path}: {exc}') from exc

        # One message carries the whole document, so it is bounded by the
        # same chunk ceiling a single fs_write is.
        if len(payload) > MAX_CHUNK_SIZE:
            raise StorageError(f'JSON payload for {path} exceeds {MAX_CHUNK_SIZE} bytes; use the streaming handle API')

        # Go through the raw store operation, not self.write(): the handle
        # API registers a committable handle that disconnect cleanup would
        # commit mid-write — the exact window this method exists to close.
        # The shared write lock is held for the whole backend write.
        full_path = self._full_path(path)
        if full_path in self._write_locks:
            raise StorageError(f'File already open for writing: {path}')
        self._write_locks.add(full_path)
        try:
            await self._store.write_bytes(full_path, payload)
        finally:
            self._write_locks.discard(full_path)
        return len(payload)

    async def get_json(self, path: str) -> Any:
        """
        Read a file and parse it as JSON — the counterpart to ``put_json``,
        in one operation rather than open / read / close.

        Args:
            path: Relative path within the account store.

        Returns:
            The parsed value.

        Raises:
            StorageError: If the file is missing, unreadable, or not valid
                JSON.
        """
        raw = await self.read(path)
        try:
            return json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise StorageError(f'File is not valid JSON: {path}: {exc}') from exc

    async def delete(self, path: str) -> None:
        """
        Delete a file.

        Args:
            path: Relative path within the account store.

        Raises:
            StorageError: If file does not exist, delete fails, or file is open for writing.
        """
        full_path, kind, rest = self._resolve(path)
        # Root guard: deleting a root — the caller's own account root
        # included — is never meaningful; reject uniformly like rmdir/rename.
        if not rest:
            raise StorageError('Cannot delete a scope root')
        if full_path in self._write_locks:
            raise StorageError(f'Cannot delete file while it is open for writing: {path}')
        await self._store.delete_file(full_path)

    async def list_dir(self, path: str = '') -> dict:
        """
        List immediate children of a directory.

        Args:
            path: Relative directory path (default: account root).

        Returns:
            Dict with keys: entries (list of {name, type, size?, modified?}), count.
            File entries include size (bytes) and modified (epoch timestamp).
        """
        prefix = self._full_path(path)
        if not prefix.endswith('/'):
            prefix += '/'

        all_files = await self._store.list_files(prefix)

        # Track entries; for files, keep the full path for mtime lookup
        entries_map: dict[str, dict] = {}
        for file_path in all_files:
            relative = file_path[len(prefix) :]
            if not relative:
                continue

            parts = relative.split('/')
            name = parts[0]

            if name == DIR_MARKER:
                continue

            if len(parts) == 1:
                if name not in entries_map:
                    entries_map[name] = {'type': 'file', 'full_path': file_path}
            else:
                entries_map[name] = {'type': 'dir'}

        entries = []
        for name in sorted(entries_map):
            meta = entries_map[name]
            entry: dict = {'name': name, 'type': meta['type']}
            if meta['type'] == 'file':
                try:
                    file_info = await self._store.get_file_info(meta['full_path'])
                    entry['size'] = file_info['size']
                    entry['modified'] = file_info['modified']
                except StorageError:
                    pass
            entries.append(entry)

        return {'entries': entries, 'count': len(entries)}

    async def mkdir(self, path: str) -> None:
        """
        Create a directory.

        Writes a zero-length .dirmarker sentinel file for object store
        compatibility.

        Args:
            path: Relative directory path.
        """
        marker_path = self._full_path(path.rstrip('/') + '/' + DIR_MARKER)
        await self._store.write_bytes(marker_path, b'')

    async def rmdir(self, path: str, recursive: bool = False) -> None:
        """
        Remove a directory.

        Args:
            path: Relative directory path. Must be non-empty — an empty/root
                path is rejected to prevent accidental account wipes.
            recursive: If True, delete all contents recursively (default: False).

        Raises:
            StorageError: If the directory is not empty and recursive is False,
                any file under the prefix is currently open, or one or more
                backend deletes fail (partial-failure errors are aggregated).
        """
        # Reject empty/root paths up front: _full_path('') resolves to the
        # account root, and list_files on that prefix would enumerate every
        # file owned by the account — a single bad caller could wipe the store.
        validated = self._validate_path(path)
        if not validated:
            raise StorageError('rmdir requires a non-empty path')

        # Scope-root guard: NO root — '@<team>', '=team/<tid>', '@org', or the
        # caller's own account root — may be the rmdir target; each would
        # wipe a whole file area. Universal (not kind-conditional) like the
        # delete/rename guards, so it holds even if a future normalization
        # change lets an own-root spelling slip past the empty-path check.
        _full, kind, rest = self._resolve(validated)
        if not rest:
            raise StorageError('rmdir cannot target a scope root')

        full_prefix = self._full_path(validated.rstrip('/') + '/')

        # Refuse if any open handle or write-lock lives under this prefix;
        # otherwise the writer's next write_chunk/close would reference a
        # deleted backend path with undefined behavior.
        self._assert_no_active_handles_under(full_prefix)

        # Only the keys under the directory itself: the S3 and Azure backends
        # build the listing prefix with normpath, which drops the trailing '/',
        # so 'kb/' would also list 'kbx/...' and the loop below would delete it
        # (and _full_path normalizes the separator away too, so it is restored)
        directory = full_prefix.rstrip('/') + '/'
        all_files = [f for f in await self._store.list_files(full_prefix) if f.startswith(directory)]

        # Ignore the dirmarker sentinel when checking emptiness
        non_marker = [f for f in all_files if not f.endswith('/' + DIR_MARKER)]

        if not recursive and non_marker:
            raise StorageError(f'Directory not empty: {path}')

        # Collect per-file failures so a partial rmdir is visible to callers
        # rather than silently reported as success.
        errors: list[str] = []
        for f in all_files:
            try:
                await self._store.delete_file(f)
            except StorageError as e:
                errors.append(f'{f}: {e}')
        if errors:
            raise StorageError(f'rmdir partial failure ({len(errors)} file(s)): {"; ".join(errors)}')

    async def rename(self, old_path: str, new_path: str, overwrite: bool = False) -> None:
        """
        Rename a file or directory.

        Files and directories alike ride the backend's native move primitive
        (server-side on object stores — no bytes pass through this process);
        a directory moves as one native move per file under its prefix.

        A directory rename is therefore NOT atomic: with no atomic backend
        primitive to ride, a mid-loop backend failure leaves the tree split
        between both paths. That case is reported, never swallowed — every
        file is attempted and the survivors are named in the raised error
        (the same partial-failure contract ``rmdir`` carries).

        Args:
            old_path: Current relative path within the account store.
            new_path: New relative path within the account store.
            overwrite: When False (default) the call fails if the destination
                already exists. Pass True to replace the destination.

        Raises:
            StorageError: If old_path does not exist, is open for reading or
                writing, the destination already exists without ``overwrite``,
                or the operation fails — including a partial directory rename,
                whose message lists the files left under ``old_path``.
        """
        old_full, old_kind, old_rest = self._resolve(old_path)
        new_full, new_kind, new_rest = self._resolve(new_path)
        # Root guard: NO root — the caller's own account root included — may
        # be source or destination. An empty old_rest would make dir_prefix
        # the whole account/scope tree and the copy loop below a whole-store
        # move (mirror of the rmdir root protection).
        if not old_rest or not new_rest:
            raise StorageError('rename cannot target a scope root')

        # Listing a prefix also returns the file at that path; counting it would send every
        # plain file down the directory branch. Same test stat() uses.
        dir_prefix = old_full.rstrip('/') + '/'
        listed = await self._store.list_files(dir_prefix)
        all_files = [f for f in listed if f != old_full and f.startswith(dir_prefix)]

        # stat()'s 'both': neither branch covers it, and the directory one would move the
        # children and leave the file, reporting success.
        if all_files and old_full in listed:
            raise StorageError(f'Cannot rename {old_path!r}: it is both a file and a directory')

        if all_files:
            # Directory rename: refuse if any source file is open, then check
            # destination collision before starting the copy loop.
            self._assert_no_active_handles_under(dir_prefix)
            new_dir_prefix = new_full.rstrip('/') + '/'
            self._assert_no_active_handles_under(new_dir_prefix)
            if not overwrite:
                existing = await self._store.list_files(new_dir_prefix)
                if existing:
                    raise StorageError(f'Destination already exists: {new_path}')
            # No backend offers an atomic directory move, and rolling completed
            # moves back is itself fallible — a failed reverse move would only
            # scatter the tree further. Take rmdir's contract instead: attempt
            # EVERY file, then name the ones that stayed behind, so a directory
            # split across both paths is visible to the caller rather than
            # hidden behind whichever file failed first.
            errors: list[str] = []
            for file_path in all_files:
                relative_to_old = file_path[len(dir_prefix) :]
                new_file_path = new_dir_prefix + relative_to_old
                # Native move per file — no whole-file buffering in this
                # process, and each destination is untouched until its new
                # content is in place (same guarantee as the file branch).
                try:
                    await self._store.move_file(file_path, new_file_path)
                except StorageError as e:
                    errors.append(f'{file_path}: {e}')
            if errors:
                raise StorageError(
                    f'rename partial failure ({len(errors)} of {len(all_files)} file(s) still under {old_path}): '
                    f'{"; ".join(errors)}'
                )
        else:
            # File rename: check both source and destination locks, then
            # check destination existence unless overwrite was requested.
            if old_full in self._write_locks:
                raise StorageError(f'Cannot rename file while it is open for writing: {old_path}')
            if new_full in self._write_locks:
                raise StorageError(f'Cannot rename onto file that is open for writing: {new_path}')
            if not overwrite:
                dest_exists = False
                try:
                    info = await self._store.get_file_info(new_full)
                    dest_exists = bool(info)
                except StorageError:
                    # get_file_info raises when the key does not exist — good,
                    # destination is clear and rename can proceed.
                    pass
                if dest_exists:
                    raise StorageError(f'Destination already exists: {new_path}')
            # Native move — the destination is untouched until the new content is in place.
            await self._store.move_file(old_full, new_full)

    async def stat(self, path: str) -> dict:
        """
        Get file or directory metadata.

        Args:
            path: Relative path within the account store.

        Returns:
            Dict with keys: exists, type (``'file'``, ``'dir'``, or ``'both'``
            when a file and a same-named directory co-exist on an object store),
            size (bytes, files only), modified (epoch timestamp, files only).
        """
        full_path = self._full_path(path)

        # Check for directory children under path/
        dir_prefix = full_path.rstrip('/') + '/'
        files = await self._store.list_files(dir_prefix)
        is_dir = any(f != full_path and f.startswith(dir_prefix) for f in files)

        # Check for a file at the exact path
        file_info = None
        try:
            file_info = await self._store.get_file_info(full_path)
        except StorageError:
            pass

        # On object stores both a key "foo" and keys "foo/*" can co-exist;
        # surface that rather than silently shadowing the file.
        if is_dir and file_info:
            return {'exists': True, 'type': 'both', 'size': file_info['size'], 'modified': file_info['modified']}
        if is_dir:
            return {'exists': True, 'type': 'dir'}
        if file_info:
            return {'exists': True, 'type': 'file', 'size': file_info['size'], 'modified': file_info['modified']}

        return {'exists': False}

    # =========================================================================
    # Private Methods
    # =========================================================================

    def _get_handle(self, handle_id: str, expected_mode: FileHandleMode) -> FileHandle:
        """Look up a handle and validate its state and ownership (via ctx)."""
        handle = self._handles.get(handle_id)
        if handle is None:
            raise StorageError(f'Invalid handle: {handle_id}')
        if handle.closed:
            raise StorageError(f'Handle already closed: {handle_id}')
        if handle.mode != expected_mode:
            raise StorageError(f'Wrong handle mode: expected {expected_mode.value}, got {handle.mode.value}')
        # STRICT ownership: the registry is Store-wide (every identity in the
        # process), so a lenient empty-conn_id bypass would let any default
        # RequestContext reach another connection's live handle. Fail closed —
        # only the exact owning conn_id (including '' == '' for unowned
        # test contexts) may touch a handle.
        if handle.connection_id != self._ctx.conn_id:
            raise StorageError('Handle belongs to another connection')
        return handle

    def _release_handle(self, handle: FileHandle) -> None:
        """Remove a handle from the registry and release any write lock."""
        handle.closed = True
        self._handles.pop(handle.handle_id, None)
        if handle.mode == FileHandleMode.WRITE:
            self._write_locks.discard(handle.path)

    def _count_handles_for(self, connection_id: str) -> int:
        """Count currently-open handles owned by ``connection_id`` (for the DoS cap)."""
        return sum(1 for h in self._handles.values() if h.connection_id == connection_id)

    def _assert_no_active_handles_under(self, prefix: str) -> None:
        """
        Refuse mutating operations (rmdir, rename) when any file under ``prefix``
        is currently held by a write lock or an open handle.

        Keeps the operation consistent with open writers/readers: otherwise a
        rmdir/rename would pull the rug out from under an in-flight handle,
        leading to undefined backend behavior.
        """
        for locked in self._write_locks:
            if locked == prefix.rstrip('/') or locked.startswith(prefix):
                raise StorageError(f'Cannot modify: file open for writing under {prefix}')
        for handle in self._handles.values():
            if handle.path == prefix.rstrip('/') or handle.path.startswith(prefix):
                raise StorageError(f'Cannot modify: handle open under {prefix}')

    async def _force_close_handle(self, handle_id: str) -> None:
        """Force-close a handle, committing any written data. Best-effort.

        Delegates to the owning Store's single per-handle teardown sequence
        (shared with disconnect-time Store.close_all_handles).
        """
        await self._owner._teardown_handle(self._handles.get(handle_id))

    @staticmethod
    def _validate_path(path: str) -> str:
        """Validate and normalize a user-provided path (module normalize_path)."""
        return normalize_path(path)

    async def get_url(self, path: str, expires_in: int = 3600, download_name: Optional[str] = None) -> str:
        """
        Get a direct HTTP URL for accessing the file.

        Cloud backends (S3, Azure) return a presigned/SAS URL directly.
        The local filesystem backend generates a JWT-signed URL pointing at
        the server's ``/task/fetch`` endpoint.

        Args:
            path: Relative path within the account store.
            expires_in: URL validity in seconds (default 1 hour, max 1 hour).
            download_name: If provided, the URL forces a browser download with
                this filename via ``Content-Disposition: attachment``. This is
                the only way to control the download filename for cross-origin
                cloud URLs, where the ``<a download>`` attribute is ignored.
                When ``None`` (default) the URL is served inline, so media
                viewers can stream it.

        Returns:
            A direct HTTP(S) URL to the file.

        Raises:
            ValueError: If ``expires_in`` is not positive.
            RuntimeError: If ``RR_BASE_URL`` is not configured and the
                backend requires a locally-signed URL.
        """
        import os

        if expires_in <= 0:
            raise ValueError('expires_in must be positive')
        expires_in = min(expires_in, 3600)

        # Build the Content-Disposition header the backend should bake into the
        # URL. Sanitize the filename so it cannot inject header/quote characters.
        content_disposition = None
        if download_name:
            safe_name = _sanitize_download_name(download_name)
            content_disposition = f'attachment; filename="{safe_name}"'

        full_path = self._full_path(path)
        url = await self._store.get_url(full_path, expires_in, content_disposition=content_disposition)
        if url is not None:
            return url

        # Local filesystem backend — generate a JWT-signed fetch URL
        import time
        import jwt

        from ai.constants import CONST_DEFAULT_SIGNING_KEY

        # Unset falls back to the self-describing development default so a
        # fresh install works out of the box; production replaces it via
        # .env/.config.
        signing_key = os.environ.get('RR_SIGNING_KEY', '') or CONST_DEFAULT_SIGNING_KEY

        # The claim carries the RESOLVED physical store path, not the wire
        # spelling: authorization already ran above (_full_path under THIS
        # session's identity), and the signed JWT is the capability. The
        # fetch handler serves the claim verbatim — it re-resolves nothing,
        # because its internal identity has no name dictionary and no org
        # context, so a name-based '@<team>' or '@org' wire path
        # could never resolve there (it would 500 instead of serving).
        payload = {
            'sub': self._client_id,
            'path': full_path,
            'v': FETCH_CLAIM_VERSION,
            'exp': int(time.time()) + expires_in,
        }
        # Carry the download filename in the signed claim so /task/fetch can set
        # Content-Disposition: attachment (else it serves the file inline).
        if download_name:
            payload['download_name'] = _sanitize_download_name(download_name)
        token = jwt.encode(payload, signing_key, algorithm='HS256')

        # This was set by the main web server at startup
        base_url = os.environ.get('RR_BASE_URL')
        if not base_url:
            raise RuntimeError(
                'RR_BASE_URL is not set — configure it in .env or ensure'
                ' the web server has started before generating fetch URLs'
            )
        return f'{base_url}/task/fetch?token={token}'

    def _resolve(self, path: str) -> 'tuple[str, str, str]':
        """Normalize, authorize, and resolve a path for one operation class.

        THE single resolver+authorizer: normalization happens FIRST (via
        ``_validate_path`` — the one normalizer, which is what defeats the
        ``\\=team\\x`` / ``/=team/x`` / ``./@me/x`` bypass family),
        then ``resolve_scope`` maps the scope grammar to the
        physical root and enforces the policy-required permission for the
        bound identity.

        Returns:
            (full_physical_path, scope_kind, rest) — scope_kind/rest let
            mutating callers (rmdir/rename) apply scope-root guards.
        """
        validated = self._validate_path(path)
        # resolve_scope hands back the kind it parsed — no second parse; the
        # scope-root guards key off (kind, rest).
        kind, scope_root, rest = resolve_scope(
            self._ctx, self._client_id, validated, engine_root=self._root, declared=self._declared
        )
        full = f'{scope_root}/{rest}' if rest else scope_root
        return full, kind, rest

    def _full_path(self, path: str) -> str:
        """Authorize + resolve ``path`` to its full physical storage path."""
        full, _kind, _rest = self._resolve(path)
        return full


__all__ = [
    'DeclaredRoot',
    'FileStore',
    'FileHandle',
    'FileHandleMode',
    'MAX_CHUNK_SIZE',
    'MAX_READ_SIZE',
    'MAX_HANDLES_PER_CONNECTION',
    'FETCH_CLAIM_VERSION',
    'DIR_MARKER',
]
