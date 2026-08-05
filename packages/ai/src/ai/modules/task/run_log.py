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

# =============================================================================
# RUN LOG — per-task JSONL event continuum (writer + shared plumbing)
#
# ONE continuous log per task identity (projectId.source.runKind): runs are
# chapters (lifecycle marker events) inside the stream, never separate files.
# The supervisor appends stamped events to a local SPOOL segment, seals it at
# a size threshold (plus a slow daily backstop) AND at every run end, and
# uploads each sealed segment as an immutable store object — so a finished
# run is fully durable in the store immediately. A small CONTROL FILE per
# stream is the time/seq -> segment routing table, the spooled/uploaded
# location ledger, and the chapters (tracks) cache that powers the UI
# activity bar.
#
# Design invariants (see the run-logging plan):
#   * Every store object is written exactly once and never modified.
#   * State flips to 'uploaded' BEFORE any spool delete (ordering invariant).
#   * Spool deletes are lease-deferred so readers never lose a file mid-read.
#   * Recovery is STORE-SIDE ONLY: the spool is ephemeral (K8s container);
#     stale spool files are deleted at startup, never salvaged.
#   * No tokens in paths or log content — identity is projectId.source.runKind.
# =============================================================================

import os
import re
import json
import time
import shutil
import asyncio
from collections import deque
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from ai.constants import (
    CONST_LOG_SEGMENT_BYTES,
    CONST_LOG_BACKSTOP_SEAL_SECONDS,
    CONST_LOG_SEGMENTS,
    CONST_LOG_CHAPTERS,
    CONST_LOG_EVENT_PAYLOAD_BYTES,
    CONST_LOG_HISTORY_SECONDS_DEV,
    CONST_LOG_HISTORY_SECONDS_DEPLOY,
    CONST_LOG_STATUS_SAMPLE_SECONDS,
    CONST_LOG_READ_MAX_EVENTS,
    CONST_LOG_READ_MAX_BYTES,
    CONST_LOG_SEGMENT_FETCH_BYTES,
    CONST_LOG_KF_CLOSED_TRACES,
    CONST_LOG_KF_SCROLLBACK_LINES,
    CONST_LOG_KF_SCROLLBACK_LINE_CHARS,
    CONST_LOG_KF_OPEN_CEILING,
)

if TYPE_CHECKING:
    from ai.account.file_store import FileStore

# =============================================================================
# CONSTANTS
# =============================================================================

# Control-file schema version (first field of the control file).
# v2: segments open with a keyframe preamble and interior events may carry
# same-segment delta bodies (see SEGMENT CODEC below).
LOG_SCHEMA_VERSION = 2

# How often the background worker checks the backstop seal and drains uploads.
_WORKER_INTERVAL_SECONDS = 60.0

# Spool root default — the system temp dir itself unless overridden via env
# (flat spool files directly in $TEMP, no nesting). K8s deployments point
# the env override at an emptyDir.
_SPOOL_ROOT_ENV = 'RR_LOG_SPOOL_ROOT'


def default_spool_root() -> str:
    """Resolve the spool root directory (env override or system temp)."""
    import tempfile

    return os.environ.get(_SPOOL_ROOT_ENV) or tempfile.gettempdir()


# =============================================================================
# IDENTITY / PATH HELPERS
# =============================================================================
#
# Store paths are RELATIVE — they go through the account FileStore, which
# scopes everything under users/<clientId>/files/ itself (the userId never
# appears in log paths; the logs land in the user's visible file area):
#     .logs/{projectId}/{source}.{runKind}.{segmentId:06d}.jsonl
#     .logs/{projectId}/{source}.{runKind}.json            (control)
# Spool files are FLAT in the spool root and DO carry the userId (one shared
# temp dir serves every user on the host):
#     {userId}.{projectId}.{source}.{runKind}.{segmentId:06d}.jsonl


def _sanitize(part: str) -> str:
    """
    Sanitize one identity component for use in file/object names.

    Keeps [A-Za-z0-9_-]; everything else becomes '_'. Defensive: source ids
    are engine config ids and normally already safe.
    """
    return re.sub(r'[^A-Za-z0-9_\-]', '_', part or '')


def stream_name(project_id: str, source: str, run_kind: str) -> str:
    """Build the stream's base name: '{projectId}.{source}.{runKind}'."""
    return f'{_sanitize(project_id)}.{_sanitize(source)}.{_sanitize(run_kind)}'


def control_store_path(project_id: str, source: str, run_kind: str) -> str:
    """FileStore-relative path of a stream's control file (per stream)."""
    return f'.logs/{_sanitize(project_id)}/{_sanitize(source)}.{_sanitize(run_kind)}.json'


def segment_store_path(project_id: str, source: str, run_kind: str, segment_id: int) -> str:
    """FileStore-relative path of one sealed segment object."""
    return f'.logs/{_sanitize(project_id)}/{_sanitize(source)}.{_sanitize(run_kind)}.{segment_id:06d}.jsonl'


# Spool filename pattern (startup sweep) — 6-digit segment id + our runKind
# token; anchored so the sweep can NEVER touch anything but our own files in
# the shared temp dir.
_SPOOL_FILE_RE = re.compile(r'^[A-Za-z0-9_\-]+(?:\.[A-Za-z0-9_\-]+)*\.(?:dev|deploy)\.\d{6}\.jsonl$')


def spool_path(spool_root: str, scope_id: str, stream: str, segment_id: int) -> str:
    """Flat local spool file for one segment: '{scopeId}.{stream}.{id}.jsonl'.

    The scope id (owner user id for dev, team id for deploy — see
    scope_paths) qualifies the flat name so equal streams in different
    scopes never collide on one host.
    """
    return os.path.join(spool_root, f'{_sanitize(scope_id)}.{stream}.{segment_id:06d}.jsonl')


def scope_paths(run_kind: str, client_id: str, team_id: str) -> 'tuple[str, str]':
    """The continuum's scope: (store path prefix, scope id) — ONE helper.

    Dev runs live in the OWNER's user tree ('' prefix: the FileStore's
    client anchor). Deploy runs live in the TEAM tree so teammates can
    watch/replay — the prefix is the internal-identity scope grammar
    ('@/Team/=<id>/'), resolved by the store to teams/<id>/files/.

    The scope id qualifies SPOOL filenames and the writer registry so the
    same stream name in two scopes (Staging vs Production deploying one
    project) can never collide on one host.

    Both RunLogWriter and RunLogReader derive their paths from this single
    function — writer and reader cannot disagree about where a stream lives.

    Raises:
        ValueError: A deploy run without a team has no valid scope, or the
            team id is not usable as a path segment.
    """
    if run_kind == 'deploy':
        if not team_id:
            raise ValueError('deploy continua are team-scoped: team_id is required')
        # team_id is embedded into the store's id-reference grammar below —
        # reject anything that could escape the '=<id>' segment (same rule
        # the deployment backend applies to path-segment ids). Upstream
        # callers validate membership, so this is defense in depth.
        if '/' in team_id or '\\' in team_id or team_id in ('.', '..') or team_id.startswith(('@', '=', '.')):
            raise ValueError(f'team_id contains invalid characters: {team_id!r}')
        return (f'@/Team/={team_id}/', team_id)
    return ('', client_id)


def history_seconds(run_kind: str) -> int:
    """Retention age for a stream by run kind (dev shorter than deploy)."""
    return CONST_LOG_HISTORY_SECONDS_DEPLOY if run_kind == 'deploy' else CONST_LOG_HISTORY_SECONDS_DEV


# =============================================================================
# SEGMENT LEASES — deferred deletes under concurrent readers
# =============================================================================


class SegmentLeases:
    """
    In-process read leases over spool segment files.

    Readers acquire a lease around file access; deleters route every spool
    delete through release-time processing: if a file is leased, its delete is
    DEFERRED (never skipped) and executed when the last lease drops. One
    process serves all reads (the one-code-path decision), so a dict +
    asyncio-safe discipline is sufficient — no file locks.
    """

    def __init__(self) -> None:
        """Initialize empty lease and deferred-delete tables."""
        # path -> active lease count
        self._leases: Dict[str, int] = {}
        # paths whose delete was requested while leased
        self._pending_delete: set = set()

    def acquire(self, path: str) -> None:
        """Take a read lease on ``path``."""
        self._leases[path] = self._leases.get(path, 0) + 1

    def release(self, path: str) -> None:
        """Drop a read lease; execute a deferred delete at refcount zero."""
        count = self._leases.get(path, 0) - 1
        if count > 0:
            self._leases[path] = count
            return
        self._leases.pop(path, None)
        if path in self._pending_delete:
            self._pending_delete.discard(path)
            _try_remove(path)

    def delete(self, path: str) -> None:
        """Delete ``path`` now, or defer until its last lease drops."""
        if self._leases.get(path, 0) > 0:
            self._pending_delete.add(path)
            return
        _try_remove(path)


def _try_remove(path: str) -> None:
    """Remove a file, ignoring races where it is already gone."""
    try:
        os.remove(path)
    except OSError:
        pass


# Module-wide lease table — shared by the writer's janitor and (L3+) readers.
LEASES = SegmentLeases()

# Registry of ACTIVE writers by (scope_id, stream) — lets rrext_log's delete
# coordinate with a live stream (route the mutation through the writer's lock)
# and lets L5 compose reads with a live in-memory tail.
WRITERS: Dict[str, 'RunLogWriter'] = {}


def writer_key(scope_id: str, stream: str) -> str:
    """Registry key for an active writer (scope-qualified — see scope_paths)."""
    return f'{scope_id}/{stream}'


# =============================================================================
# STARTUP HYGIENE
# =============================================================================


def sweep_spool_root(spool_root: Optional[str] = None) -> None:
    """
    Delete stale spool FILES at supervisor startup.

    Recovery is store-side only (the spool is ephemeral in K8s and its
    contents are unrecoverable state), so anything left by a previous process
    is deleted, never salvaged. This prevents disk leaks on long-lived dev
    machines where — unlike K8s — the filesystem survives restarts.

    The spool root is the SHARED system temp dir by default, so the sweep is
    strictly pattern-anchored: only files matching our own
    '{userId}.{stream}.{segId}.jsonl' naming are ever touched.

    Args:
        spool_root: Override root (tests); defaults to default_spool_root().
    """
    root = spool_root or default_spool_root()
    os.makedirs(root, exist_ok=True)
    try:
        for name in os.listdir(root):
            if _SPOOL_FILE_RE.match(name) and os.path.isfile(os.path.join(root, name)):
                _try_remove(os.path.join(root, name))
    except OSError:
        pass

    # Legacy cleanup: the previous layout nested everything under a
    # dedicated subdirectory — remove it wholesale if it still exists.
    legacy = os.path.join(root, 'rocketride-runlog-spool')
    if os.path.isdir(legacy):
        shutil.rmtree(legacy, ignore_errors=True)


# =============================================================================
# EVENT SHAPING
# =============================================================================


def truncate_event(message: Dict[str, Any], max_bytes: int = CONST_LOG_EVENT_PAYLOAD_BYTES) -> Dict[str, Any]:
    """
    Cap an event's serialized size, preserving metadata + timestamps.

    Oversized payload carriers (trace data, output text) are replaced with a
    truncation marker; the event's identity fields (event, body.logSeq,
    body.eventTime, op/component/ids) always survive so timing analysis
    works on truncated bodies. The original is never mutated.

    Args:
        message: Stamped event message.
        max_bytes: Serialized-size cap.

    Returns:
        The original message if within the cap, else a truncated copy.
    """
    line = json.dumps(message, separators=(',', ':'), default=str)
    if len(line) <= max_bytes:
        return message

    # Deep-copy via JSON round trip (cheap at these sizes) then blank the
    # known payload carriers with a marker recording the original length.
    clipped = json.loads(line)
    body = clipped.get('body')
    if isinstance(body, dict):
        # Trace/flow payloads: body.trace.data is the large carrier.
        trace = body.get('trace')
        if isinstance(trace, dict) and 'data' in trace:
            trace['data'] = {'__truncated': True, '__originalBytes': len(line)}
        # Output events: the output text itself is the carrier.
        if 'output' in body and isinstance(body['output'], str):
            body['output'] = body['output'][:1024] + '…[truncated]'
        # Status snapshots: notes/pipeflow can balloon.
        if 'pipeflow' in body:
            body['pipeflow'] = {'__truncated': True}
    clipped['__truncated'] = True
    return clipped


# =============================================================================
# SEGMENT CODEC (DVR v2: keyframes + same-segment deltas)
# =============================================================================
# Segments are self-contained containers (video-codec model): each opens with
# a `{"type":"keyframe"}` preamble line carrying accumulated state (full
# status base, byPipe, open-frame summaries with touched-segment lists,
# recently-closed summaries, console scrollback), and interior events may
# carry DELTA bodies whose base is guaranteed to live in the SAME segment:
#   - status deltas reference the previous status (or the keyframe base);
#   - trace LEAVE deltas reference their paired ENTER — leaves whose enter
#     landed in an earlier segment are stored FULL (rare; keeps every segment
#     decodable from its own keyframe alone).
# The decoder below is the reference implementation shared by the server's
# ranged read (its "full events" contract) — the SDK sessions mirror it.

# The codec's reference implementation lives in the CLIENT SDK package as an
# INTERNAL module (rocketride._log_codec — the encoding is storage plumbing,
# never public SDK surface) so one Python module serves three consumers: this
# writer, the server's ranged read, and the SDK's event-stream session. The
# names are re-exported here for ai-side consumers/tests.
from rocketride._log_codec import (  # noqa: E402  (import placed with its section)
    DELTA_KEY as DELTA_KEY,
    DELETED_KEY as DELETED_KEY,
    SegmentDecoder as SegmentDecoder,
    apply_shallow_delta as apply_shallow_delta,
    shallow_delta as shallow_delta,
)


# =============================================================================
# RUN LOG WRITER
# =============================================================================


class RunLogWriter:
    """
    Append-only writer for one task identity's event continuum.

    Lifecycle (per run): ``await open(...)`` at subprocess start ->
    ``append(msg)`` per stamped event -> ``await end_run(outcome)`` at task
    termination. The stream (control file + sealed segments) outlives the
    run; a subsequent run re-opens the same stream and continues it.

    All store objects are immutable; the only mutable artifact is the control
    file, rewritten on seal/upload transitions (single writer: this class).
    """

    def __init__(
        self,
        store: 'FileStore',
        client_id: str,
        project_id: str,
        source: str,
        run_kind: str,
        stamp: Any,
        raise_seq_floor: Any,
        *,
        team_id: str = '',
        spool_root: Optional[str] = None,
        debug: Any = None,
    ) -> None:
        """
        Bind the writer to a task identity and its stamping callbacks.

        Args:
            store: The account-scoped FileStore (Store.get_file_store) — all
                store paths here are relative ('.logs/…'); the FileStore puts
                them under the calling user itself.
            client_id: Owning user id (spool filenames + writer registry —
                never in store paths; the FileStore owns that scoping).
            project_id: Pipeline project id.
            source: Source component id.
            run_kind: 'dev' or 'deploy' — separate continua per kind.
            team_id: REQUIRED for deploy runs — the continuum then lives in
                the team's tree (teammates watch/replay); ignored for dev.
            stamp: Callable(message, *, event_time=None) -> message; the
                task's stamp_log_event (synthetic events go through it too).
            raise_seq_floor: Callable(int); the task's raise_log_seq_floor —
                lifts the continuum seq to control.lastSeq + 1 on open.
            spool_root: Override spool root (tests).
            debug: Optional debug-message callable.
        """
        self._store = store
        self._client_id = client_id
        self._project_id = project_id
        self._source = source
        self._run_kind = run_kind
        self._stamp = stamp
        self._raise_seq_floor = raise_seq_floor
        self._debug = debug or (lambda _msg: None)

        # Identity-derived names/paths. Deploy continua live in the TEAM
        # tree (scope prefix); the scope id qualifies spool + registry.
        self._scope_prefix, self._scope_id = scope_paths(run_kind, client_id, team_id)
        self._stream = stream_name(project_id, source, run_kind)
        self._spool_root = spool_root or default_spool_root()

        # Control state (authoritative in-memory; persisted to the store).
        self._control: Dict[str, Any] = {}

        # Active segment state.
        self._active_path: Optional[str] = None
        self._active_file = None
        self._active_bytes = 0
        self._active_start_time: Optional[float] = None
        self._active_start_seq: Optional[int] = None
        self._active_has_chapter_start = False

        # Status sampling + lifecycle.
        self._last_status_logged = 0.0
        self._open = False
        self._lock = asyncio.Lock()
        self._worker: Optional[asyncio.Task] = None
        self._upload_queue: List[int] = []

        # ---- Keyframe/delta state (DVR v2 codec) ----------------------------
        # The running accumulated state serialized into each new segment's
        # keyframe, and the delta bases for interior encoding. Payloads are
        # kept AS WRITTEN (post-truncation) so every delta base equals the
        # bytes a reader has in hand.
        # Last status body as written (delta base). None => next status full.
        self._kf_prev_status: Optional[Dict[str, Any]] = None
        # Per pipe id: list of open frames
        # {'component','doc','enterTime','enterSeq','seg','data'}.
        self._kf_open: Dict[Any, List[Dict[str, Any]]] = {}
        # Per pipe id: doc name, call count, touched segment ids, begin time.
        self._kf_docs: Dict[Any, Dict[str, Any]] = {}
        # Recently-closed trace summaries (keyframe display seed).
        self._kf_closed: deque = deque(maxlen=CONST_LOG_KF_CLOSED_TRACES)
        # Console scrollback (terminal semantics; resets at run begin).
        self._kf_console: deque = deque(maxlen=CONST_LOG_KF_SCROLLBACK_LINES)
        # Current pipeflow byPipe map.
        self._kf_by_pipe: Dict[Any, Any] = {}
        # Current chapter context {beginSeq, beginTime} (None before first run).
        self._kf_chapter: Optional[Dict[str, Any]] = None
        # False when this process resumed an existing stream: the open-frame
        # state before the crash/restart is unknown, and the FIRST keyframe
        # this process writes says so.
        self._kf_complete = True

    # -------------------------------------------------------------------------
    # PATHS
    # -------------------------------------------------------------------------

    def _spool_path(self, seg_id: int) -> str:
        """Flat spool file for one of this stream's segments (scope-qualified)."""
        return spool_path(self._spool_root, self._scope_id, self._stream, seg_id)

    def _control_path(self) -> str:
        """Store path of this stream's control file (scope prefix applied)."""
        return self._scope_prefix + control_store_path(self._project_id, self._source, self._run_kind)

    def _segment_path(self, seg_id: int) -> str:
        """Store path of one sealed segment (scope prefix applied)."""
        return self._scope_prefix + segment_store_path(self._project_id, self._source, self._run_kind, seg_id)

    # =========================================================================
    # OPEN / RECOVERY
    # =========================================================================

    async def open(
        self,
        *,
        trigger: str,
        user: str,
        pipeline_hash: str,
        trace_level: Optional[str],
    ) -> None:
        """
        Open (or re-open) the stream for a new run.

        Store-side recovery: load the control file if it exists, verify its
        'uploaded' entries against the store, lift the task's logSeq floor to
        lastSeq + 1 (the continuum continues exactly where the recorded
        stream left off; a fresh stream starts at 1), then append the
        run-begin lifecycle marker and its chapter entry.

        Args:
            trigger: What started the run ('manual', 'scheduled', ...).
            user: Display identity of the run owner (never a token).
            pipeline_hash: Hash/version of the pipeline config for the header.
            trace_level: The run's pipeline trace level.
        """
        async with self._lock:
            # Ensure the spool root exists (a custom RR_LOG_SPOOL_ROOT may
            # not; the default system temp dir always does).
            os.makedirs(self._spool_root, exist_ok=True)

            # ---- Load or initialize the control file -----------------------
            self._control = await self._load_control()

            # Seed the continuum from the catalog: the next issued logSeq is
            # control.lastSeq + 1 (a fresh stream starts at 1 — the task's
            # counter initializes there). A crash's unpersisted tail may
            # re-issue values; accepted — the crash also drops every
            # websocket, so clients reconnect with fresh sessions and fresh
            # live buckets, and nothing stale survives to collide.
            last_seq = int(self._control.get('lastSeq', 0))
            if last_seq:
                # This process resumed an existing stream: whatever open-frame
                # state existed before is unknown, and the first keyframe this
                # process writes must say so.
                self._kf_complete = False
                self._raise_seq_floor(last_seq + 1)

            # ---- Run-begin marker (doubles as chapter header) --------------
            begin = self._stamp(
                _lifecycle_event(
                    'run-begin',
                    schemaVer=LOG_SCHEMA_VERSION,
                    projectId=self._project_id,
                    source=self._source,
                    runKind=self._run_kind,
                    trigger=trigger,
                    user=user,
                    pipelineHash=pipeline_hash,
                    traceLevel=trace_level,
                )
            )
            self._append_event(begin)
            self._active_has_chapter_start = True

            # Chapter entry: completed at end_run. Before appending, close any
            # DANGLING chapter (endTime null): a killed/crashed run never wrote
            # its run-end, and leaving it open would make consumers treat it as
            # still live and merge it with the next run. Its end is the
            # stream's last recorded activity (capped at this run's begin) —
            # the honest completion the dead process never wrote (self-healing
            # on every open).
            chapters: List[Dict[str, Any]] = self._control.setdefault('chapters', [])
            stream_last = float(self._control.get('endTime') or begin['body']['eventTime'])
            for chapter in chapters:
                if chapter.get('endTime') is None:
                    dangling_end = min(stream_last, begin['body']['eventTime'])
                    # Never end a chapter before it began (clock edge cases).
                    chapter['endTime'] = max(dangling_end, float(chapter.get('beginTime') or 0))
                    chapter['outcome'] = 'interrupted'
            chapters.append(
                {
                    'beginTime': begin['body']['eventTime'],
                    'beginSeq': begin['body']['logSeq'],
                    'endTime': None,
                    'outcome': None,
                    # Whether THIS run recorded traces — None/'none' lets the
                    # UI say "tracing was off" instead of "no data yet".
                    'traceLevel': trace_level,
                }
            )
            del chapters[:-CONST_LOG_CHAPTERS]

            self._control['completed'] = False
            self._open = True
            await self._write_control()

            # Register as the stream's live writer (delete coordination + L5
            # live-tail composition).
            WRITERS[writer_key(self._scope_id, self._stream)] = self

            # Background worker: backstop seal + upload drain + retention.
            self._worker = asyncio.create_task(self._worker_loop())

    async def _load_control(self) -> Dict[str, Any]:
        """
        Load the stream's control file from the store, or initialize one.

        'spooled' entries from a previous process are dropped (their spool
        died with the container — the accepted loss window); 'uploaded'
        entries are trusted (the ordering invariant guarantees the object
        landed before the state flipped).
        """
        try:
            raw = await self._store.read(self._control_path())
            control = json.loads(raw.decode('utf-8') if isinstance(raw, (bytes, bytearray)) else raw)
        except Exception:
            # First run of this stream (or unreadable control — rebuildable
            # state, so start fresh; segments without a control entry are
            # collected by the age sweep).
            return {
                'schemaVer': LOG_SCHEMA_VERSION,
                'projectId': self._project_id,
                'source': self._source,
                'runKind': self._run_kind,
                'startTime': None,
                'endTime': None,
                'lastSeq': 0,
                'nextSegmentId': 0,
                'horizonSeq': 0,
                'segments': [],
                'chapters': [],
                'completed': True,
            }

        # One rule for same-process reopen AND cross-container recovery:
        # trust the filesystem. 'uploaded' entries are always kept (the
        # ordering invariant guarantees the object landed). 'spooled'
        # entries are kept — and re-queued for upload — when their spool
        # file still exists (same-process continue); dropped when it died
        # with a previous container (the accepted loss window). The active
        # descriptor follows the same rule.
        kept: List[Dict[str, Any]] = []
        lost = 0
        for seg in control.get('segments', []):
            if seg.get('state') == 'uploaded':
                kept.append(seg)
                continue
            seg_spool = self._spool_path(int(seg['id']))
            if os.path.exists(seg_spool):
                kept.append(seg)
                self._upload_queue.append(int(seg['id']))
            else:
                lost += 1
        control['segments'] = kept
        if lost:
            self._debug(f'run-log {self._stream}: dropped {lost} spooled segment(s) lost with a previous process')

        active = control.get('active')
        if active is not None:
            if not os.path.exists(self._spool_path(int(active.get('id', 0)))):
                control.pop('active', None)
        return control

    # =========================================================================
    # APPEND PATH
    # =========================================================================

    @property
    def chapter_begin_seq(self):
        """
        The current chapter's begin seq — the run-begin marker's continuum
        seq, i.e. the run's PERMANENT chapter identity. None before the
        first run begins.
        """
        return (self._kf_chapter or {}).get('beginSeq')

    def append(self, message: Dict[str, Any]) -> None:
        """
        Append one stamped event to the active segment (synchronous, cheap).

        This is a LOG: every event delivered to clients is recorded — there
        is deliberately NO type filter. Status snapshots are rate-limited
        (sampled), payloads are capped, one JSONL line goes to the local
        spool, and a seal triggers when the size threshold is crossed. Never
        blocks on the store — all store traffic happens in the background
        worker.

        Args:
            message: A stamped DAP event message (body eventTime + logSeq).
        """
        if not self._open:
            return

        event_type = message.get('event', '')

        # Status snapshots are sampled: at most one per interval keeps coarse
        # post-hoc metrics without bloating the log. The task's FINAL zeroed
        # snapshot (body.final) always lands — it is the stream's last word
        # on utilization and must never be sampled away.
        if event_type == 'apaevt_status_update':
            now = (message.get('body') or {}).get('eventTime') or time.time()
            if not message.get('body', {}).get('final'):
                if now - self._last_status_logged < CONST_LOG_STATUS_SAMPLE_SECONDS:
                    return
            self._last_status_logged = now

        self._append_event(truncate_event(message))

    def _append_event(self, message: Dict[str, Any]) -> None:
        """
        Encode + write + state-track one full event (the v2 codec pipeline).

        Order matters: the segment (and its keyframe) must exist BEFORE the
        event is processed — the keyframe is the state at the segment's
        START, so it must not include this event's own state mutation.
        """
        # 1. Ensure the active segment exists; a fresh segment gets its
        #    keyframe written from the CURRENT (pre-event) state.
        self._ensure_active(message)

        # 2. Encode against the state (delta bodies where a same-segment base
        #    exists) and update the state machine. Codec failures must never
        #    break logging: fall back to the full event.
        seg_id = int(self._control.get('nextSegmentId', 0))
        try:
            encoded = self._kf_process(message, seg_id)
        except Exception as e:
            self._debug(f'run-log {self._stream}: codec error ({e}); event stored full')
            encoded = message

        # 3. Write the (possibly delta-encoded) line.
        self._append_line(encoded)

    def _ensure_active(self, message: Dict[str, Any]) -> None:
        """Lazily open the active segment; write its keyframe when fresh."""
        if self._active_file is not None:
            return

        # Seal-or-continue: a later run in the SAME process reopens the
        # previous run's unsealed active file (same id) and restores its
        # descriptor, so the shared segment keeps one coherent start
        # time/seq across runs.
        seg_id = int(self._control.get('nextSegmentId', 0))
        self._active_path = self._spool_path(seg_id)
        # Line-buffered: every appended event reaches the OS immediately,
        # so rrext_log reads of the ACTIVE segment are current to the
        # last event — gap-free live composition (store + spool + active)
        # without any separate in-memory tail structure.
        # newline='\n' pins the on-disk line ending on every platform:
        # segments are a byte-exact wire/storage format (raw segment
        # fetch, downloads), so Windows' \r\n translation must not leak
        # into them.
        self._active_file = open(self._active_path, 'a', encoding='utf-8', buffering=1, newline='\n')
        self._active_bytes = os.path.getsize(self._active_path)
        resumed = self._control.get('active') if self._active_bytes > 0 else None
        if resumed and int(resumed.get('id', -1)) == seg_id:
            self._active_start_time = resumed.get('startTime')
            self._active_start_seq = resumed.get('seq')
            self._active_has_chapter_start = bool(resumed.get('chapterStart'))
        else:
            self._active_start_time = float((message.get('body') or {}).get('eventTime') or time.time())
            self._active_start_seq = int((message.get('body') or {}).get('logSeq') or 0)

        # A BRAND-NEW segment opens with its keyframe preamble — the
        # accumulated state at this boundary, making the segment fold
        # standalone. A resumed active file already has content (its
        # keyframe was written when it was born).
        if self._active_bytes == 0:
            line = json.dumps(self._keyframe_dict(), separators=(',', ':'), default=str) + '\n'
            self._active_file.write(line)
            self._active_bytes += len(line)
            # After the first keyframe this process writes, its state IS the
            # continuous truth again.
            self._kf_complete = True

    def _append_line(self, message: Dict[str, Any]) -> None:
        """Serialize one encoded line, append it, and run the seal check."""
        line = json.dumps(message, separators=(',', ':'), default=str) + '\n'
        self._active_file.write(line)
        self._active_bytes += len(line)

        # Track stream bookkeeping.
        body_stamps = message.get('body') or {}
        self._control['lastSeq'] = max(int(self._control.get('lastSeq', 0)), int(body_stamps.get('logSeq') or 0))
        self._control['endTime'] = float(body_stamps.get('eventTime') or time.time())
        if self._control.get('startTime') is None:
            self._control['startTime'] = self._control['endTime']
        if message.get('event') == 'apaevt_log_lifecycle' and message.get('body', {}).get('action') == 'run-begin':
            self._active_has_chapter_start = True

        # Size seal AFTER the write (write-then-check): checking before would
        # loop forever on any event larger than the segment target — an
        # oversized event yields an oversized single-event segment instead.
        if self._active_bytes >= CONST_LOG_SEGMENT_BYTES:
            self._seal_active()

    # =========================================================================
    # KEYFRAME / DELTA STATE MACHINE (the v2 codec, writer side)
    # =========================================================================

    def _keyframe_dict(self) -> Dict[str, Any]:
        """
        Build the keyframe preamble from the current accumulated state.

        Everything in the keyframe is COMPACT (summaries + touched-segment
        lists); full payloads live only in segment interiors. The console
        block IS the terminal's scrollback at this boundary.
        """
        open_frames: List[Dict[str, Any]] = []
        partial = False
        for pid, stack in self._kf_open.items():
            doc_info = self._kf_docs.get(pid, {})
            touched = sorted(doc_info.get('touched', ()))
            for frame in stack:
                if len(open_frames) >= CONST_LOG_KF_OPEN_CEILING:
                    partial = True
                    break
                open_frames.append(
                    {
                        'id': pid,
                        'component': frame.get('component'),
                        'doc': doc_info.get('doc'),
                        'enterTime': frame.get('enterTime'),
                        'enterSeq': frame.get('enterSeq'),
                        'touched': touched,
                    }
                )

        return {
            'type': 'keyframe',
            'ver': LOG_SCHEMA_VERSION,
            'complete': self._kf_complete,
            'partial': partial,
            'chapter': self._kf_chapter,
            'status': self._kf_prev_status or {},
            'byPipe': self._kf_by_pipe,
            'openFrames': open_frames,
            'closedRecent': list(self._kf_closed),
            'console': {
                'lines': list(self._kf_console),
                'truncated': len(self._kf_console) == self._kf_console.maxlen,
            },
        }

    def _kf_process(self, msg: Dict[str, Any], seg_id: int) -> Dict[str, Any]:
        """
        Encode one event against the state machine and update the state.

        Deltas are emitted ONLY when the base lives in the SAME segment
        (status: previous status or the keyframe base; leave: its paired
        enter written into this segment) — every segment stays decodable
        from its own keyframe alone. State stores payloads AS WRITTEN so
        delta bases equal the bytes a reader holds.

        Args:
            msg: The full (already truncated) event.
            seg_id: The segment this event is being written into.

        Returns:
            The event to write — delta-encoded where a base exists.
        """
        event = msg.get('event')
        body = msg.get('body')

        # ---- Lifecycle: run boundaries reset the accumulated state ----------
        if event == 'apaevt_log_lifecycle' and isinstance(body, dict):
            if body.get('action') == 'run-begin':
                self._kf_chapter = {'beginSeq': body.get('logSeq'), 'beginTime': body.get('eventTime')}
                self._kf_open.clear()
                self._kf_docs.clear()
                self._kf_closed.clear()
                self._kf_console.clear()
                self._kf_by_pipe = {}
            return msg

        # ---- Status: delta against the previous snapshot --------------------
        if event == 'apaevt_status_update' and isinstance(body, dict):
            prev = self._kf_prev_status
            self._kf_prev_status = body
            if prev is None:
                return msg
            encoded = dict(msg)
            encoded['body'] = {DELTA_KEY: shallow_delta(prev, body)}
            return encoded

        # ---- Flow: open/close frames, leave deltas, touched tracking --------
        if event == 'apaevt_flow' and isinstance(body, dict):
            op = body.get('op')
            pid = body.get('id')
            component = body.get('component')
            trace = body.get('trace') or {}
            data = trace.get('data')
            etime = float(body.get('eventTime') or 0)

            doc_info = self._kf_docs.get(pid)
            if doc_info is not None:
                doc_info.setdefault('touched', set()).add(seg_id)

            if op == 'begin':
                self._kf_docs[pid] = {
                    'doc': component,
                    'calls': 0,
                    'beginTime': etime,
                    # Begin-event continuum seq — the trace's PERMANENT identity
                    # (slot ids recycle; the seq never does).
                    'beginSeq': body.get('logSeq'),
                    'touched': {seg_id},
                }
                self._kf_open[pid] = []
                self._kf_by_pipe[pid] = body.get('pipes') or []
                return msg

            if op == 'enter':
                self._kf_by_pipe[pid] = body.get('pipes') or []
                if doc_info is not None:
                    doc_info['calls'] = int(doc_info.get('calls', 0)) + 1
                self._kf_open.setdefault(pid, []).append(
                    {
                        'component': component,
                        'enterTime': etime,
                        'enterSeq': body.get('logSeq'),
                        'seg': seg_id,
                        'data': data,
                    }
                )
                return msg

            if op == 'leave':
                self._kf_by_pipe[pid] = body.get('pipes') or []
                stack = self._kf_open.get(pid) or []
                match_idx = next(
                    (i for i in range(len(stack) - 1, -1, -1) if stack[i].get('component') == component), None
                )
                frame = stack.pop(match_idx) if match_idx is not None else None
                # Same-segment base only: a cross-boundary leave stores full.
                if (
                    frame is not None
                    and frame.get('seg') == seg_id
                    and isinstance(data, dict)
                    and isinstance(frame.get('data'), dict)
                ):
                    encoded = dict(msg)
                    new_trace = dict(trace)
                    new_trace['data'] = {DELTA_KEY: shallow_delta(frame['data'], data)}
                    new_body = dict(body)
                    new_body['trace'] = new_trace
                    encoded['body'] = new_body
                    return encoded
                return msg

            if op == 'end':
                info = self._kf_docs.pop(pid, None)
                self._kf_open.pop(pid, None)
                self._kf_by_pipe.pop(pid, None)
                if info is not None:
                    self._kf_closed.append(
                        {
                            'doc': info.get('doc'),
                            'id': pid,
                            'beginSeq': info.get('beginSeq'),
                            'beginTime': info.get('beginTime'),
                            'elapsed': max(0.0, etime - float(info.get('beginTime') or etime)),
                            'calls': info.get('calls', 0),
                            'touched': sorted(info.get('touched', ())),
                        }
                    )
                return msg

            return msg

        # ---- SSE: node narration belongs to its trace — keep the touched
        # list truthful so a sparse (touched-based) walk never skips a
        # segment whose only activity for the trace is SSE messages.
        if event == 'apaevt_sse' and isinstance(body, dict):
            sse_doc = self._kf_docs.get(body.get('pipe_id'))
            if sse_doc is not None:
                sse_doc.setdefault('touched', set()).add(seg_id)
            return msg

        # ---- Console: roll the scrollback -----------------------------------
        if event == 'output' and isinstance(body, dict):
            for line in str(body.get('output', '')).splitlines():
                self._kf_console.append(line[:CONST_LOG_KF_SCROLLBACK_LINE_CHARS])
            return msg

        return msg

    # =========================================================================
    # SEAL / UPLOAD / RETENTION
    # =========================================================================

    def _seal_active(self) -> None:
        """
        Seal the active segment: close it, record its control entry
        ('spooled'), queue its upload, and run retention.
        """
        if self._active_file is None:
            return

        self._active_file.close()
        self._active_file = None

        seg_id = int(self._control.get('nextSegmentId', 0))
        self._control['nextSegmentId'] = seg_id + 1

        # Control entry — the agreed shape (+ id/state ledger fields).
        self._control.setdefault('segments', []).append(
            {
                'startTime': self._active_start_time,
                'endTime': self._control.get('endTime'),
                'chapterStart': self._active_has_chapter_start,
                'seq': self._active_start_seq,
                'id': seg_id,
                'state': 'spooled',
            }
        )
        self._active_path = None
        self._active_bytes = 0
        self._active_start_time = None
        self._active_start_seq = None
        self._active_has_chapter_start = False

        self._upload_queue.append(seg_id)
        self._apply_retention()

    def _apply_retention(self) -> None:
        """
        Evict segments beyond the ring size or older than the history age.

        Eviction deletes the store object AND any spool copy (lease-deferred)
        and advances the horizon; chapters that fell wholly off the horizon
        are trimmed with them.
        """
        segments: List[Dict[str, Any]] = self._control.get('segments', [])
        cutoff = time.time() - history_seconds(self._run_kind)

        while segments and (len(segments) > CONST_LOG_SEGMENTS or (segments[0].get('endTime') or 0) < cutoff):
            evicted = segments.pop(0)
            seg_id = int(evicted['id'])

            # Store object (only exists once uploaded).
            if evicted.get('state') == 'uploaded':
                asyncio.get_event_loop().create_task(self._delete_store_segment(seg_id))

            # Spool copy — routed through the lease table (deferred delete).
            LEASES.delete(self._spool_path(seg_id))

            # Horizon bookkeeping + chapter trim.
            self._control['horizonSeq'] = max(int(self._control.get('horizonSeq', 0)), int(evicted.get('seq') or 0))
            horizon_time = evicted.get('endTime') or 0
            self._control['chapters'] = [
                ch for ch in self._control.get('chapters', []) if (ch.get('endTime') or time.time()) >= horizon_time
            ]
            self._control['startTime'] = segments[0].get('startTime') if segments else None

    async def _delete_store_segment(self, seg_id: int) -> None:
        """Delete one evicted segment object from the store (best-effort)."""
        try:
            await self._store.delete(self._segment_path(seg_id))
        except Exception as e:
            self._debug(f'run-log {self._stream}: failed deleting evicted segment {seg_id}: {e}')

    async def _drain_uploads(self) -> None:
        """
        Upload queued sealed segments (oldest first).

        Ordering invariant: the store object is fully written, THEN the
        control entry flips to 'uploaded' (persisted), THEN the spool copy is
        deleted via the lease table. A crash between any two steps leaves a
        state reconciliation can resolve.
        """
        while self._upload_queue:
            seg_id = self._upload_queue[0]
            path = self._spool_path(seg_id)
            try:
                with open(path, 'rb') as f:
                    data = f.read()
                await self._store.write(self._segment_path(seg_id), data)
            except Exception as e:
                # Leave it queued — reads still serve from the spool copy.
                self._debug(f'run-log {self._stream}: upload of segment {seg_id} failed (will retry): {e}')
                return

            # Flip state BEFORE delete (never the other order).
            for seg in self._control.get('segments', []):
                if seg.get('id') == seg_id:
                    seg['state'] = 'uploaded'
                    break
            await self._write_control()
            LEASES.delete(path)
            self._upload_queue.pop(0)

    def _maybe_backstop_seal(self) -> bool:
        """
        Seal a non-empty active segment older than the backstop age.

        The slow time backstop caps host-loss tail-at-risk and store lag for
        low-volume long-lived streams at <= 1 object/day; fast streams seal
        on size long before this fires.

        Returns:
            True if a seal happened.
        """
        if (
            self._active_file is not None
            and self._active_start_time is not None
            and time.time() - self._active_start_time >= CONST_LOG_BACKSTOP_SEAL_SECONDS
        ):
            self._active_file.flush()
            self._seal_active()
            return True
        return False

    async def _worker_loop(self) -> None:
        """Background worker: backstop seal, upload drain, control flush."""
        try:
            while self._open:
                await asyncio.sleep(_WORKER_INTERVAL_SECONDS)
                async with self._lock:
                    if not self._maybe_backstop_seal() and self._active_file is not None:
                        self._active_file.flush()
                    await self._drain_uploads()
                    await self._write_control()
        except asyncio.CancelledError:
            return
        except Exception as e:
            self._debug(f'run-log {self._stream}: worker error: {e}')

    # =========================================================================
    # RUN END / CLOSE
    # =========================================================================

    async def end_run(self, outcome: str, exit_message: str = '', reason: 'str | None' = None) -> None:
        """
        Complete the current run: end marker, chapter completion, SEAL, upload.

        The active segment is force-sealed at run end (supersedes the
        earlier seal-or-continue design): the store then holds
        the run's complete history the moment the task finishes, and the
        crash-loss window shrinks to "mid-run only". The cost — one store
        object per run even for small runs — is accepted; the continuum
        (chapters over one stream, ring + age retention) is unchanged, runs
        simply no longer share a segment file.

        Args:
            outcome: 'ok' | 'error' | 'cancelled'.
            exit_message: Optional human detail for the end marker.
            reason: WHY a requested stop happened ('user' | 'ttl'); kept on
                the end marker and the chapter so the audit stays honest —
                a ttl expiry arrives here as outcome 'ok', reason 'ttl'.
        """
        async with self._lock:
            if not self._open:
                return

            end = self._stamp(
                _lifecycle_event(
                    'run-end', outcome=outcome, detail=exit_message, **({'reason': reason} if reason else {})
                )
            )
            self._append_event(end)

            # Complete the newest open chapter.
            for chapter in reversed(self._control.get('chapters', [])):
                if chapter.get('endTime') is None:
                    chapter['endTime'] = end['body']['eventTime']
                    chapter['outcome'] = outcome
                    if reason:
                        chapter['reason'] = reason
                    break

            self._control['completed'] = True
            self._open = False

            # Seal (closes the handle, records the 'spooled' control entry,
            # queues the upload) and push it to the store NOW — the reader
            # serves the finished run from durable segments, no active tail.
            self._seal_active()
            await self._drain_uploads()
            await self._write_control()

        if self._worker:
            self._worker.cancel()
            try:
                await self._worker
            except asyncio.CancelledError:
                pass
            self._worker = None

        # Deregister as the stream's live writer.
        WRITERS.pop(writer_key(self._scope_id, self._stream), None)

    def note_restart(self) -> None:
        """
        Record a mid-run engine restart in the stream.

        A restart is NOT a new run: the chapter continues and the seq base is
        already re-anchored by the task's in-memory counter — this marker
        just makes the restart visible on replay.
        """
        if self._open:
            self._append_event(self._stamp(_lifecycle_event('restart')))

    # =========================================================================
    # CONTROL FILE
    # =========================================================================

    async def _write_control(self) -> None:
        """Persist the control file to the store (single-writer, whole-object)."""
        # Keep the ACTIVE (unsealed) segment visible to readers while a run
        # is executing: the reader includes this descriptor as a virtual
        # segment so the live tail is readable the moment it is written.
        # Runs force-seal at end_run, so after a run finishes there is no
        # active descriptor — only mid-run state lives here, and only that
        # mid-run tail dies with the container (accepted crash-loss window).
        if self._active_path is not None:
            self._control['active'] = {
                'id': int(self._control.get('nextSegmentId', 0)),
                'startTime': self._active_start_time,
                'endTime': self._control.get('endTime'),
                'chapterStart': self._active_has_chapter_start,
                'seq': self._active_start_seq,
            }
        else:
            self._control.pop('active', None)

        try:
            await self._store.write(
                self._control_path(),
                json.dumps(self._control, separators=(',', ':'), default=str).encode('utf-8'),
            )
        except Exception as e:
            self._debug(f'run-log {self._stream}: control write failed: {e}')


# =============================================================================
# RUN LOG READER — rrext_log's one code path over the continuum
# =============================================================================


class RunLogReader:
    """
    Ranged reader over one stream's continuum (chapters / read / delete).

    Serves EaaS-side reads for `rrext_log`: routes seq/time ranges to
    segments via the control file, then resolves each segment from the SPOOL
    (lease-guarded, preferred when present) or the STORE by its ledger
    state. v1 composes sealed/spooled segments only — the live in-memory
    tail joins in L5. Works equally for completed streams (no writer) and
    live ones (sealed history readable while the run continues).
    """

    def __init__(
        self,
        store: 'FileStore',
        client_id: str,
        project_id: str,
        source: str,
        run_kind: str,
        *,
        team_id: str = '',
        spool_root: Optional[str] = None,
    ) -> None:
        """
        Bind the reader to a stream identity.

        Args:
            store: The CALLER's account-scoped FileStore — store paths are
                relative ('.logs/…'); scoping to the authenticated user is
                the FileStore's job, never built from input here.
            client_id: Caller's user id (spool filenames + writer registry).
            project_id: Pipeline project id.
            source: Source component id.
            run_kind: 'dev' or 'deploy'.
            team_id: REQUIRED for deploy streams — reads the TEAM continuum
                (the command layer verifies team permissions first).
            spool_root: Override spool root (tests).
        """
        self._store = store
        self._client_id = client_id
        self._project_id = project_id
        self._source = source
        self._run_kind = run_kind
        # Same single scope helper as the writer — they cannot diverge.
        self._scope_prefix, self._scope_id = scope_paths(run_kind, client_id, team_id)
        self._stream = stream_name(project_id, source, run_kind)
        self._spool_root = spool_root or default_spool_root()

    def _spool_path(self, seg_id: int) -> str:
        """Flat spool file for one of this stream's segments (scope-qualified)."""
        return spool_path(self._spool_root, self._scope_id, self._stream, seg_id)

    def _control_path(self) -> str:
        """Store path of this stream's control file (scope prefix applied)."""
        return self._scope_prefix + control_store_path(self._project_id, self._source, self._run_kind)

    def _segment_path(self, seg_id: int) -> str:
        """Store path of one sealed segment (scope prefix applied)."""
        return self._scope_prefix + segment_store_path(self._project_id, self._source, self._run_kind, seg_id)

    # -------------------------------------------------------------------------
    # CONTROL ACCESS
    # -------------------------------------------------------------------------

    async def _load_control(self) -> Dict[str, Any]:
        """
        Load the stream's control state.

        Prefers the LIVE writer's in-memory control when one is registered
        (fresher than the store copy by up to a seal interval); falls back
        to the store copy for completed / other-run streams.

        Raises:
            FileNotFoundError: If the stream has no control (never logged).
        """
        writer = WRITERS.get(writer_key(self._scope_id, self._stream))
        if writer is not None:
            return writer._control
        try:
            raw = await self._store.read(self._control_path())
        except Exception as exc:
            raise FileNotFoundError(f'No run log for stream {self._stream}') from exc
        return json.loads(raw.decode('utf-8') if isinstance(raw, (bytes, bytearray)) else raw)

    async def chapters(self) -> Dict[str, Any]:
        """
        Return the stream's chapters (tracks) + activity-bar metadata.

        Returns:
            Dict with 'chapters' (beginTime/beginSeq/endTime/outcome each),
            'segments' (startTime/endTime/chapterStart only — the activity
            spans), 'startTime', 'endTime', 'horizonSeq', 'completed'.
        """
        control = await self._load_control()
        spans = [
            {
                # id + seq make the spans directly addressable by the raw
                # segment fetch (the DVR session's cache key + routing).
                'id': seg.get('id'),
                'seq': seg.get('seq'),
                'startTime': seg.get('startTime'),
                'endTime': seg.get('endTime'),
                'chapterStart': seg.get('chapterStart', False),
            }
            for seg in self._routable_segments(control)
        ]
        return {
            'chapters': control.get('chapters', []),
            'segments': spans,
            'startTime': control.get('startTime'),
            'endTime': control.get('endTime'),
            'horizonSeq': control.get('horizonSeq', 0),
            'completed': control.get('completed', True),
        }

    @staticmethod
    def _routable_segments(control: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Sealed segments plus the ACTIVE descriptor as a virtual segment.

        Seal-or-continue keeps a completed run's tail in the unsealed active
        file; including it here makes the tail readable the moment it is
        written (its endTime rides the stream's endTime).
        """
        segments = list(control.get('segments', []))
        active = control.get('active')
        if active is not None:
            segments.append(
                {
                    'startTime': active.get('startTime'),
                    'endTime': control.get('endTime'),
                    'chapterStart': active.get('chapterStart', False),
                    'seq': active.get('seq'),
                    'id': active.get('id'),
                    'state': 'spooled',
                }
            )
        return segments

    # -------------------------------------------------------------------------
    # RANGED READ
    # -------------------------------------------------------------------------

    async def read(
        self,
        *,
        from_seq: Optional[int] = None,
        to_seq: Optional[int] = None,
        from_time: Optional[float] = None,
        to_time: Optional[float] = None,
        to_segment: Optional[int] = None,
        cursor: Optional[int] = None,
        max_events: int = CONST_LOG_READ_MAX_EVENTS,
        max_bytes: int = CONST_LOG_READ_MAX_BYTES,
        types: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        Read a seq/time range of events from the continuum, paged.

        Query forms (matching the plan): seq range, time range, time-to-now
        (omit the upper bound), time-to-segment. ``cursor`` (a seq) continues
        a previous page and overrides ``from_seq``/``from_time``.

        Args:
            from_seq / to_seq: Inclusive seq bounds.
            from_time / to_time: Inclusive eventTime bounds (epoch seconds).
            to_segment: Read up to and including this segment id.
            cursor: Continuation seq from a previous page's 'nextSeq'.
            max_events / max_bytes: Page limits (clamped to server defaults).
            types: Optional event-type filter (server-side, saves bandwidth).

        Returns:
            Dict with 'events' (list), optional 'nextSeq' (continuation),
            and optional 'truncatedAtSeq' (the request reached below the
            retention horizon — the first available seq).
        """
        control = await self._load_control()
        segments: List[Dict[str, Any]] = self._routable_segments(control)

        # Clamp page limits: callers may lower, never raise.
        max_events = min(int(max_events or CONST_LOG_READ_MAX_EVENTS), CONST_LOG_READ_MAX_EVENTS)
        max_bytes = min(int(max_bytes or CONST_LOG_READ_MAX_BYTES), CONST_LOG_READ_MAX_BYTES)

        # Effective lower bound: the cursor wins.
        if cursor is not None:
            from_seq = int(cursor)
            from_time = None

        # Horizon honesty: a request reaching below the retained window is
        # answered from the first available seq, flagged for the timeline.
        truncated_at: Optional[int] = None
        horizon_seq = int(control.get('horizonSeq', 0))
        if horizon_seq and from_seq is not None and from_seq < horizon_seq:
            truncated_at = horizon_seq
        first_time = segments[0].get('startTime') if segments else None
        if first_time is not None and from_time is not None and from_time < first_time:
            truncated_at = truncated_at or int(segments[0].get('seq') or 0)

        # Route: keep segments that can intersect the requested range.
        wanted: List[Dict[str, Any]] = []
        for seg in segments:
            if to_segment is not None and int(seg['id']) > int(to_segment):
                continue
            if (
                from_seq is not None
                and (seg.get('endTime') is not None)
                and self._seg_last_seq(seg, segments) < from_seq
            ):
                continue
            if to_seq is not None and int(seg.get('seq') or 0) > to_seq:
                continue
            if from_time is not None and (seg.get('endTime') or 0) < from_time:
                continue
            if to_time is not None and (seg.get('startTime') or 0) > to_time:
                continue
            wanted.append(seg)

        events: List[Dict[str, Any]] = []
        used_bytes = 0
        next_seq: Optional[int] = None

        for seg in wanted:
            # Per-segment decoder: keyframe seeds the delta bases; every line
            # is decoded (state building needs them all) BEFORE range filters,
            # so a page that starts mid-segment still reconstructs correctly.
            decoder = SegmentDecoder()
            for line in await self._read_segment_lines(int(seg['id'])):
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # Keyframe preambles are container metadata, not events.
                if msg.get('type') == 'keyframe':
                    decoder.seed(msg)
                    continue
                msg = decoder.decode(msg)

                # Continuum stamps: in the body on current recordings;
                # legacy v2 segments carried them at the header (and the
                # continuum under the header name 'seq', pre-DAP-fix). The
                # legacy values are CANONICALIZED INTO the body here, so every
                # event read() returns satisfies the body-stamp contract —
                # consumers never carry a header fallback of their own.
                mbody = msg.get('body')
                if not isinstance(mbody, dict):
                    mbody = {}
                    msg['body'] = mbody
                if 'logSeq' not in mbody and isinstance(msg.get('seq'), int):
                    mbody['logSeq'] = msg['seq']
                if 'eventTime' not in mbody and isinstance(msg.get('eventTime'), (int, float)):
                    mbody['eventTime'] = msg['eventTime']
                seq = int(mbody.get('logSeq') or 0)
                etime = float(mbody.get('eventTime') or 0)

                # Range filters.
                if from_seq is not None and seq < from_seq:
                    continue
                if to_seq is not None and seq > to_seq:
                    return {'events': events, **({'truncatedAtSeq': truncated_at} if truncated_at else {})}
                if from_time is not None and etime < from_time:
                    continue
                if to_time is not None and etime > to_time:
                    return {'events': events, **({'truncatedAtSeq': truncated_at} if truncated_at else {})}
                if types and msg.get('event') not in types:
                    continue

                # Page limits: report the continuation point and stop.
                if len(events) >= max_events or used_bytes + len(line) > max_bytes:
                    next_seq = seq
                    result: Dict[str, Any] = {'events': events, 'nextSeq': next_seq}
                    if truncated_at:
                        result['truncatedAtSeq'] = truncated_at
                    return result

                events.append(msg)
                used_bytes += len(line)

        result = {'events': events}
        if truncated_at:
            result['truncatedAtSeq'] = truncated_at
        return result

    @staticmethod
    def _seg_last_seq(seg: Dict[str, Any], segments: List[Dict[str, Any]]) -> int:
        """
        Upper seq bound of a segment: the next segment's first seq (or +inf).

        The control file stores each segment's FIRST seq; a segment's last
        seq is bounded by its successor's first.
        """
        idx = segments.index(seg)
        if idx + 1 < len(segments):
            return int(segments[idx + 1].get('seq') or 0) - 1
        return 2**62

    async def _read_segment_lines(self, seg_id: int) -> List[str]:
        """
        Read the JSONL lines of one segment — spool first, store fallback.

        The spool copy is preferred when present (faster, and the only copy
        while 'spooled'); access is lease-guarded so the uploader's deferred
        delete can never pull the file mid-read — and the lease is held ONLY
        for the duration of the file read (deterministic release; a lazy
        generator would leave releases to garbage-collection timing when a
        page limit stops iteration mid-segment). Any local failure falls
        back to the store — the bytes are identical by construction.

        Args:
            seg_id: Segment number within this stream.

        Returns:
            The segment's non-empty lines (a segment is bounded at 16 MB,
            so whole-segment reads are the page ceiling by design).
        """
        local_path = self._spool_path(seg_id)
        if os.path.exists(local_path):
            LEASES.acquire(local_path)
            try:
                with open(local_path, encoding='utf-8') as f:
                    return [line for line in f if line.strip()]
            except OSError:
                pass  # fall through to the store copy
            finally:
                LEASES.release(local_path)

        try:
            raw = await self._store.read(self._segment_path(seg_id))
        except Exception:
            return []
        text = raw.decode('utf-8') if isinstance(raw, (bytes, bytearray)) else str(raw)
        return [line for line in text.splitlines() if line.strip()]

    # -------------------------------------------------------------------------
    # RAW SEGMENT FETCH (DVR v2 bulk path)
    # -------------------------------------------------------------------------

    async def segment_raw(self, seg_id: int, *, offset: int = 0, max_bytes: int = 0) -> Dict[str, Any]:
        """
        Fetch one segment's raw JSONL bytes, chunked by byte offset.

        The DVR v2 bulk path: the server does NO line scanning, filtering, or
        JSON parsing — it hands over the immutable segment content (spool
        first with the read lease, store fallback; the active segment is
        served up to its current length, the live subscription covers growth
        past that). Chunks are WHOLE-LINE ALIGNED: each response ends on a
        newline boundary so the client can parse every chunk standalone; a
        single line larger than the chunk ceiling is returned whole (jumbo
        events yield jumbo chunks rather than split lines).

        Args:
            seg_id: Segment number within this stream.
            offset: Byte offset to continue from (0 = start).
            max_bytes: Caller's chunk ceiling (clamped to the server ceiling;
                0 = server default).

        Returns:
            Dict with 'segment', 'offset', 'data' (raw JSONL text), 'size'
            (total segment bytes), 'nextOffset' (None when exhausted), and
            'final'.

        Raises:
            FileNotFoundError: When the segment exists in neither location.
        """
        limit = int(max_bytes) if max_bytes else CONST_LOG_SEGMENT_FETCH_BYTES
        limit = max(1, min(limit, CONST_LOG_SEGMENT_FETCH_BYTES))
        offset = max(0, int(offset))

        raw = await self._segment_bytes(seg_id)
        size = len(raw)

        # Slice the requested window, then align the cut to the LAST newline
        # inside the window (whole-line chunks). If no newline fits, extend
        # to the line's end — a jumbo line ships whole rather than split.
        chunk = raw[offset : offset + limit]
        if offset + len(chunk) < size:
            cut = chunk.rfind(b'\n')
            if cut >= 0:
                chunk = chunk[: cut + 1]
            else:
                line_end = raw.find(b'\n', offset + limit)
                chunk = raw[offset:] if line_end < 0 else raw[offset : line_end + 1]

        next_offset = offset + len(chunk)
        final = next_offset >= size
        return {
            'segment': seg_id,
            'offset': offset,
            'data': chunk.decode('utf-8'),
            'size': size,
            'nextOffset': None if final else next_offset,
            'final': final,
        }

    async def _segment_bytes(self, seg_id: int) -> bytes:
        """
        Read one segment's raw bytes — spool first (lease-guarded), store
        fallback. Mirrors _read_segment_lines but WITHOUT any line handling.

        Raises:
            FileNotFoundError: When the segment exists in neither location.
        """
        local_path = self._spool_path(seg_id)
        if os.path.exists(local_path):
            LEASES.acquire(local_path)
            try:
                with open(local_path, 'rb') as f:
                    return f.read()
            except OSError:
                pass  # fall through to the store copy
            finally:
                LEASES.release(local_path)

        try:
            raw = await self._store.read(self._segment_path(seg_id))
        except Exception as e:
            raise FileNotFoundError(f'segment {seg_id} not found in spool or store') from e
        return raw if isinstance(raw, (bytes, bytearray)) else str(raw).encode('utf-8')

    # -------------------------------------------------------------------------
    # DELETE
    # -------------------------------------------------------------------------

    async def delete(self, *, before_time: Optional[float] = None, delete_all: bool = False) -> Dict[str, Any]:
        """
        Delete log data for this stream.

        ``before_time``: drop segments wholly older (endTime < before_time),
        trim chapters, advance the horizon. ``delete_all``: remove every
        segment and the control file. Both honor the ordering + lease
        disciplines and delete BOTH locations. When the stream has a LIVE
        writer, the mutation routes through the writer's lock so it never
        races the seal/upload path.

        Args:
            before_time: Epoch-seconds cutoff (exclusive).
            delete_all: Remove the entire stream.

        Returns:
            Dict with 'deletedSegments' count.
        """
        writer = WRITERS.get(writer_key(self._scope_id, self._stream))
        if writer is not None:
            async with writer._lock:
                return await self._delete_locked(writer._control, before_time, delete_all, writer)
        control = await self._load_control()
        return await self._delete_locked(control, before_time, delete_all, None)

    async def _delete_locked(
        self,
        control: Dict[str, Any],
        before_time: Optional[float],
        delete_all: bool,
        writer: Optional['RunLogWriter'],
    ) -> Dict[str, Any]:
        """Perform the delete against a held control state (see delete())."""
        segments: List[Dict[str, Any]] = control.get('segments', [])
        to_drop: List[Dict[str, Any]] = []

        if delete_all:
            to_drop = list(segments)
        elif before_time is not None:
            to_drop = [seg for seg in segments if (seg.get('endTime') or 0) < before_time]

        for seg in to_drop:
            seg_id = int(seg['id'])
            if seg.get('state') == 'uploaded':
                try:
                    await self._store.delete(self._segment_path(seg_id))
                except Exception:
                    pass
            LEASES.delete(self._spool_path(seg_id))
            control['horizonSeq'] = max(int(control.get('horizonSeq', 0)), int(seg.get('seq') or 0))

        control['segments'] = [seg for seg in segments if seg not in to_drop]

        if delete_all:
            control['chapters'] = []
            control['startTime'] = None
            try:
                await self._store.delete(self._control_path())
            except Exception:
                pass
            # A live writer keeps running: its next control write recreates a
            # fresh-but-empty ledger for the ongoing run.
        else:
            cutoff = before_time or 0
            control['chapters'] = [
                ch for ch in control.get('chapters', []) if (ch.get('endTime') or time.time()) >= cutoff
            ]
            control['startTime'] = control['segments'][0].get('startTime') if control['segments'] else None
            if writer is not None:
                await writer._write_control()
            else:
                try:
                    await self._store.write(
                        self._control_path(),
                        json.dumps(control, separators=(',', ':'), default=str).encode('utf-8'),
                    )
                except Exception:
                    pass

        return {'deletedSegments': len(to_drop)}


# =============================================================================
# INTERNAL HELPERS
# =============================================================================


def _lifecycle_event(action: str, **fields: Any) -> Dict[str, Any]:
    """
    Build a synthetic lifecycle event (unstamped — callers stamp it).

    Args:
        action: 'run-begin' | 'run-end' | 'restart' | 'clock-anomaly' | ...
        **fields: Additional body fields (never tokens/credentials).

    Returns:
        An event message dict ready for stamp_log_event.
    """
    return {'type': 'event', 'event': 'apaevt_log_lifecycle', 'body': {'action': action, **fields}}
