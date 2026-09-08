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
    shared = await fs.list_dir('@/Team/Development/reports')
"""

import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import PurePosixPath
from typing import Any, Optional

from .models import RequestContext, resolve_task_permissions
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
        ValueError:   If ``expires_in`` is not positive or the signing key
                      is not configured.
        RuntimeError: If ``RR_BASE_URL`` is not configured.
    """
    import os
    import time

    import jwt

    if expires_in <= 0:
        raise ValueError('expires_in must be positive')

    signing_key = os.environ.get('RR_SIGNING_KEY', '')
    if not signing_key:
        raise ValueError('RR_SIGNING_KEY not configured — cannot generate fetch URL')

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
# Scope grammar (wire paths) — the JOINED filesystem rooted at '@':
#   <rest>                   → users/<client_id>/files/<rest>  (simple mode)
#   @/User/<rest>            → users/<client_id>/files/<rest>  (same tree,
#                              joined-mode spelling — @/User is implicitly ME)
#   @/Team/<ref>/<rest>      → teams/<teamId>/files/<rest>     (ref required:
#                              a display name from my membership, or =<id>)
#   @/Org/<rest>             → orgs/<myOrgId>/files/<rest>     (implicitly MY
#                              org — org.admin only)
#   @/User/=<uid>/<rest>, @/Org/=<oid>/<rest> → cross-boundary id references,
#                              sys.admin/internal only (support access).
# '@' itself is a virtual mount listing served by cmd_store, never resolved
# here; its children compose by ordinary path joining (listing '@' returns
# 'User'/'Team'/'Org', join gives '@/Team', and so on down the tree). The
# spellings are case-exact and alias-free — one location, one path string.
# @/User and @/Org take no name reference — each caller has exactly one of
# both, so a '='-free next segment is already the path; @/Team keeps its
# mandatory reference (N teams). Names on the wire, ids on disk; name
# resolution consults ONLY the caller's own membership. Unknown, foreign,
# permission-less, and ambiguous references deny with ONE identical message
# (no existence leak). Top-of-scope entry names may not start with '=' (so
# id references can never be shadowed by real files) or '@' (grammar room).
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
    about which location a spelling addresses ('@//User', '@/./User' and
    '\\@\\User' all normalize to '@/User' — deciding on the raw spelling
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


def parse_scope(normalized: str) -> 'tuple[str, Optional[str], str]':
    """Split a NORMALIZED path into (scope_kind, scope_ref, rest).

    Must be fed the output of ``_validate_path`` — normalizing first is what
    defeats the ``\\@\\Team\\...``, ``/@/Team/...``, ``./@/Team/...`` bypass
    family (all of those normalize INTO the ``@`` grammar and are parsed
    here, never around it).

    Grammar v3 — the joined filesystem rooted at '@'. Scope references:
      bare segment  = display NAME, resolved through the caller's own
                      membership (the canonical, round-trippable spelling)
      ``=<id>``     = literal id, stripped and used as-is (scripts and
                      cross-boundary sys.admin access) — ids can never
                      collide with names by construction.
    @/Team takes a MANDATORY reference (a caller has N teams); @/User and
    @/Org take NONE (a caller has exactly one of each — they are implicitly
    "me" / "my org"), so their next segment is already the path UNLESS it
    starts with '=' (a cross-boundary id reference, sys.admin/internal).
    Spellings are case-exact ('@/team' is an error, not an alias).

    Kinds:
      - no leading '@'            -> ('own',  None, path) (caller's namespace)
      - '@/User[/rest]'           -> ('user', None, rest) (alias of own tree)
      - '@/User/=<uid>[/rest]'    -> ('user', '=uid', rest)
      - '@/Team/<ref>[/rest]'     -> ('team', ref,  rest)
      - '@/Org[/rest]'            -> ('org',  None, rest) (caller's own org)
      - '@/Org/=<oid>[/rest]'     -> ('org',  '=oid', rest)
      - bare '@' (a virtual mount listing owned by cmd_store), any other
        '@*' first segment, an unknown '@/<Child>', or '@/Team' without a
        reference -> ValueError.
    To keep id references unshadowable, the FIRST rest segment of any scope
    may not start with '=' -> ValueError (such names cannot be created, so
    they never appear in listings either).
    """
    if not normalized.startswith('@'):
        kind, ref, rest = 'own', None, normalized
    else:
        parts = normalized.split('/')
        if parts[0] != '@':
            # '@team', '@foo', ... — the whole '@*' family stays reserved.
            raise ValueError(f'Reserved path segment: {parts[0]!r} (the joined filesystem lives under @/)')
        if len(parts) < 2:
            raise ValueError("Reserved path segment: '@' is the virtual mount root (list it, not resolve it)")
        child = parts[1]
        if child not in ('User', 'Team', 'Org'):
            raise ValueError(f'Unknown scope {child!r} (only @/User, @/Team and @/Org exist — case-exact)')
        if child == 'Team':
            # N teams — the reference segment is mandatory.
            if len(parts) < 3 or not parts[2]:
                raise ValueError('@/Team/ requires a reference segment')
            kind, ref, rest = 'team', parts[2], '/'.join(parts[3:])
        elif len(parts) >= 3 and parts[2].startswith('='):
            # @/User/@/Org with an explicit cross-boundary id reference.
            kind, ref, rest = child.lower(), parts[2], '/'.join(parts[3:])
        else:
            # @/User/@/Org implicit self — everything after is already path.
            kind, ref, rest = child.lower(), None, '/'.join(parts[2:])

    # Reserve the '=' and '@' sigils at the top of every scope: a real entry
    # named '=x' would shadow (or be shadowed by) an id reference and become
    # unaddressable/ambiguous, and '@*' is grammar room (a plain path can
    # never start with '@' — it parses as scope grammar above — but a scoped
    # rest could smuggle one in). Denied on creation => never listed either.
    first = rest.split('/', 1)[0] if rest else ''
    if first.startswith('='):
        raise ValueError("Names starting with '=' are reserved for id references")
    if first.startswith('@'):
        raise ValueError("Names starting with '@' are reserved (scope grammar)")
    return (kind, ref, rest)


def _split_ref(ref: str) -> 'tuple[bool, str]':
    """Split a scope reference into (is_id, value) per the ``=`` rule.

    ``=<id>`` means literal id: strip the sigil, then VALIDATE the id as a
    path-safe segment — ``=..`` / ``=.`` / ``=`` would otherwise traverse out
    of the scope tree when embedded into the physical path (slashes are
    already impossible post-normalization).
    """
    if not ref.startswith('='):
        return (False, ref)
    ident = ref[1:]
    if not ident or ident in ('.', '..'):
        raise ValueError(f'Invalid id reference: {ref!r}')
    return (True, ident)


def _team_ids(account_info) -> 'set[str]':
    """The caller's own team ids, from the session membership list."""
    org = getattr(account_info, 'organization', None) or {}
    return {t['id'] for t in (org.get('teams', []) if isinstance(org, dict) else []) if t.get('id')}


def validate_storage_root(root: str) -> str:
    """Validate a task-file storage anchor and return it normalized.

    The anchor is produced by trusted server code (``_build_task``) and
    carried in the task file — but the subprocess feeds it back to us, so
    validate shape defensively: a physical path of the form
    ``users|teams|orgs/<id>/files[/<subtree>]`` built from path-safe
    segments. Anything else raises ValueError.
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


def _resolve_team_name(account_info, name: str) -> str:
    """Resolve a team display name to its id — caller's own org ONLY.

    Names are case-sensitive and must be unique among the caller's teams
    (per-org uniqueness is DB-enforced, but fail closed anyway). Unknown or
    ambiguous names raise the SAME uniform error — and a foreign org's names
    are inexpressible by construction, since the only dictionary consulted is
    the caller's own membership list.
    """
    org = getattr(account_info, 'organization', None) or {}
    teams = org.get('teams', []) if isinstance(org, dict) else []
    matches = [t for t in teams if t.get('name') == name]
    if len(matches) == 1 and matches[0].get('id'):
        return matches[0]['id']
    raise PermissionError(_DENIED)


def resolve_scope(
    ctx: RequestContext,
    client_id: str,
    normalized: str,
    engine_root: 'Optional[str]' = None,
) -> 'tuple[str, str, str]':
    """Authorize and resolve a normalized path to its physical scope root.

    THE enforcement point: called for every path of every operation, against
    the bound RequestContext. Returns ``(kind, scope_root, rest)`` — kind is
    the parsed scope kind ('own'/'user'/'team'/'org'), returned so callers
    never re-parse a path this function already parsed.

    Identity handling:
      - ``ctx.source == 'engine'`` (subprocess tool nodes): plain paths only;
        every ``@`` spelling (including the harmless-looking ``@/User`` alias)
        and every system tree is rejected — LLM-generated paths can never
        wander out of the task owner's namespace.
      - ``'internal'`` sysPermission (trusted subsystems): mechanical, id
        (``=``) references only, no checks — system trees included (the
        run-log writer and the domain APIs act through this identity).
      - sys.admin sessions: full access everywhere, system trees included;
        team names still resolve in their OWN org only, ``=id`` references
        cross boundaries mechanically (the platform support capability).
      - ordinary sessions: ``@/User/<rest>`` is an alias of the own tree;
        team references (name or ``=id``) resolve strictly within their own
        membership; ``@/Org`` (implicitly their one org) needs ``org.admin``;
        ``task.store`` required elsewhere; SYSTEM TREES ARE FULLY DENIED —
        logs/deployments are reachable only through their domain APIs
        (rrext_log / rrext_deploy), never the file API.

    Raises:
        PermissionError: Identity may not touch the addressed location (or
            the reference is unknown/foreign/ambiguous — uniform message).
        ValueError: Malformed scope grammar or id reference.
    """
    kind, ref, rest = parse_scope(normalized)

    # -- Engine subprocess: most restricted — plain paths, no system trees ---
    # Every path is relative to the task's storage anchor (chroot
    # semantics): the task file's storage.root — the owner's whole tree for
    # dev runs, a task-specific team subtree for deploy runs — so node-level
    # paths are identical in both modes and can never leave the anchor.
    if ctx.source == 'engine':
        if kind != 'own':
            raise PermissionError('Scoped (@) paths are not available in the engine context')
        if _system_tree(rest):
            raise PermissionError(f'{_system_tree(rest)}/ is not available in the engine context')
        return (kind, engine_root or f'users/{client_id}/files', rest)

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
        if kind == 'own' or (kind == 'user' and ref is None):
            return (kind, f'users/{client_id}/files', rest)
        if ref is None:
            raise PermissionError(_DENIED)  # internal has no org context
        is_id, value = _split_ref(ref)
        if not is_id:
            raise PermissionError(_DENIED)  # internal has no name dictionary
        root = {'team': 'teams', 'org': 'orgs', 'user': 'users'}[kind]
        return (kind, f'{root}/{value}/files', rest)

    # -- System trees: sys.admin may do anything, everyone else nothing ------
    # (Checked before scope resolution so the denial is uniform and early.)
    if _system_tree(rest) and not is_sys_admin:
        raise PermissionError(f'{_system_tree(rest)}/ is system-owned (use its API)')

    # -- Own namespace: plain paths and their joined-mode alias @/User/<rest> -
    if kind == 'own' or (kind == 'user' and ref is None):
        if is_sys_admin:
            return (kind, f'users/{client_id}/files', rest)
        # The caller's OWN tree must not hinge on the defaultTeam pointer —
        # an unset or stale defaultTeam would deny a user their own storage.
        # The file-storage permission is granted when ANY membership carries
        # it (org.admin implies it via full team permissions).
        org = account_info.organization if isinstance(account_info.organization, dict) else {}
        if not any(
            _DEFAULT_PERMISSION in resolve_task_permissions(account_info, team['id'])
            for team in org.get('teams', [])
            if team.get('id')
        ):
            raise PermissionError(f'Permission {_DEFAULT_PERMISSION!r} denied')
        return (kind, f'users/{client_id}/files', rest)

    # -- @/Org: implicitly MY org — org.admin only; =id crosses for sys.admin -
    if kind == 'org':
        org = account_info.organization if isinstance(account_info.organization, dict) else {}
        if ref is not None:
            value = _split_ref(ref)[1]  # parse guarantees the '=' form here
            if value != org.get('id'):
                if is_sys_admin:
                    _audit_crossing(ctx, client_id, f'orgs/{value}')
                    return (kind, f'orgs/{value}/files', rest)
                raise PermissionError(_DENIED)
        if not org.get('id'):
            raise PermissionError(_DENIED)
        if 'org.admin' not in (org.get('permissions') or []) and not is_sys_admin:
            raise PermissionError(_DENIED)
        return (kind, f'orgs/{org["id"]}/files', rest)

    is_id, value = _split_ref(ref)

    # -- @/User/=<uid>: cross-boundary support spelling — sys.admin only -----
    if kind == 'user':
        if not is_sys_admin:
            raise PermissionError(_DENIED)
        _audit_crossing(ctx, client_id, f'users/{value}')
        return (kind, f'users/{value}/files', rest)

    # -- @/Team -----------------------------------------------------------------
    if is_id:
        if value in _team_ids(account_info):
            team_id = value
        elif is_sys_admin:
            # A team the caller is NOT a member of — a boundary crossing,
            # unlike the member resolution above (which crosses nothing).
            _audit_crossing(ctx, client_id, f'teams/{value}')
            team_id = value
        else:
            raise PermissionError(_DENIED)
    else:
        team_id = _resolve_team_name(account_info, ref)

    if is_sys_admin:
        return (kind, f'teams/{team_id}/files', rest)

    perms = resolve_task_permissions(account_info, team_id)
    if _DEFAULT_PERMISSION not in perms:
        raise PermissionError(_DENIED)
    return (kind, f'teams/{team_id}/files', rest)


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
    ``users/<client_id>/files/`` exactly as before; the ``@/Team/<ref>/`` and
    ``@/Org/`` grammar resolves to ``teams/<id>/files/`` /
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

    def __init__(self, owner, client_id: str, ctx: RequestContext, root: 'Optional[str]' = None):
        """Bind this instance to its owning Store, account, and identity.

        Args:
            owner: The Store wrapper providing the IStore backend and the
                   SHARED write-lock/handle registries.
            client_id: Account id for plain-path scoping.
            ctx: REQUIRED per-request identity (the handler's ctx, or
                 RequestContext.internal()/engine() for server subsystems) —
                 omission is a TypeError, not a silently-unauthorized store.
            root: ENGINE contexts only — the storage anchor from the task
                  file's ``storage.root``; every plain path the subprocess
                  speaks resolves relative to it (chroot semantics), so dev
                  and deploy runs use identical node-level paths. Validated
                  by ``validate_storage_root``; forbidden for other
                  identities (their anchor is their own namespace).
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
        self._owner = owner
        self._store: IStore = owner._store
        self._client_id = client_id
        self._ctx = ctx
        self._root = root

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

        # Scope-root guard: NO root — '@/Team/<ref>', '@/Org', or the
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

        all_files = await self._store.list_files(full_prefix)

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

        On object stores there is no native rename, so this is implemented as
        copy + delete.  For directories every file under the old prefix is
        copied to the new prefix and then deleted.

        Args:
            old_path: Current relative path within the account store.
            new_path: New relative path within the account store.
            overwrite: When False (default) the call fails if the destination
                already exists. Pass True to replace the destination.

        Raises:
            StorageError: If old_path does not exist, is open for reading or
                writing, the destination already exists without ``overwrite``,
                or the operation fails.
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
            for file_path in all_files:
                relative_to_old = file_path[len(dir_prefix) :]
                new_file_path = new_dir_prefix + relative_to_old
                data = await self._store.read_bytes(file_path)
                await self._store.write_bytes(new_file_path, data)
                await self._store.delete_file(file_path)
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
            ValueError: If ``expires_in`` is not positive, or if
                ``RR_SIGNING_KEY`` is not set and the backend requires a
                locally-signed URL.
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

        signing_key = os.environ.get('RR_SIGNING_KEY', '')
        if not signing_key:
            raise ValueError('RR_SIGNING_KEY not configured — cannot generate fetch URL')

        # The claim carries the RESOLVED physical store path, not the wire
        # spelling: authorization already ran above (_full_path under THIS
        # session's identity), and the signed JWT is the capability. The
        # fetch handler serves the claim verbatim — it re-resolves nothing,
        # because its internal identity has no name dictionary and no org
        # context, so a name-based '@/Team/<name>' or '@/Org' wire path
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
        ``\\@\\Team\\...`` / ``/@/Team/...`` / ``./@/Team/...`` bypass family),
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
        kind, scope_root, rest = resolve_scope(self._ctx, self._client_id, validated, engine_root=self._root)
        full = f'{scope_root}/{rest}' if rest else scope_root
        return full, kind, rest

    def _full_path(self, path: str) -> str:
        """Authorize + resolve ``path`` to its full physical storage path."""
        full, _kind, _rest = self._resolve(path)
        return full


__all__ = [
    'FileStore',
    'FileHandle',
    'FileHandleMode',
    'MAX_CHUNK_SIZE',
    'MAX_READ_SIZE',
    'MAX_HANDLES_PER_CONNECTION',
    'FETCH_CLAIM_VERSION',
    'DIR_MARKER',
]
