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
# a size threshold (plus a slow daily backstop), and uploads each sealed
# segment as an immutable store object. A small CONTROL FILE per stream is the
# time/seq -> segment routing table, the spooled/uploaded location ledger, and
# the chapters (tracks) cache that powers the UI activity bar.
#
# Design invariants (see the run-logging plan):
#   * Every store object is written exactly once and never modified.
#   * State flips to 'uploaded' BEFORE any spool delete (ordering invariant).
#   * Spool deletes are lease-deferred so readers never lose a file mid-read.
#   * Recovery is STORE-SIDE ONLY: the spool is ephemeral (K8s container);
#     stale spool dirs are deleted at startup, never salvaged.
#   * No tokens in paths or log content — identity is projectId.source.runKind.
# =============================================================================

import os
import re
import json
import time
import shutil
import asyncio
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
)

if TYPE_CHECKING:
    from ai.account.store import IStore

# =============================================================================
# CONSTANTS
# =============================================================================

# Control-file schema version (first field of the control file).
LOG_SCHEMA_VERSION = 1

# Event types recorded into the log. Everything else is dropped at append.
# 'apaevt_status_update' is additionally rate-limited (sampled) — see append().
LOGGED_EVENT_TYPES = frozenset(
    {
        'output',
        'apaevt_flow',
        'apaevt_status_error',
        'apaevt_status_warning',
        'apaevt_status_update',
        'apaevt_exit',
        'apaevt_log_lifecycle',
    }
)

# How often the background worker checks the backstop seal and drains uploads.
_WORKER_INTERVAL_SECONDS = 60.0

# Spool root default — under the system temp dir unless overridden via env.
# K8s deployments get an emptyDir here; local/dev servers a temp folder.
_SPOOL_ROOT_ENV = 'RR_LOG_SPOOL_ROOT'


def default_spool_root() -> str:
    """Resolve the spool root directory (env override or system temp)."""
    import tempfile

    return os.environ.get(_SPOOL_ROOT_ENV) or os.path.join(tempfile.gettempdir(), 'rocketride-runlog-spool')


# =============================================================================
# IDENTITY / PATH HELPERS
# =============================================================================


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


def control_store_path(client_id: str, stream: str) -> str:
    """Store path of a stream's control file (user-scoped, token-free)."""
    return f'users/{client_id}/logs/{stream}.json'


def segment_store_path(client_id: str, stream: str, segment_id: int) -> str:
    """Store path of one sealed segment object."""
    return f'users/{client_id}/logs/{stream}.{segment_id:06d}.jsonl'


def segment_basename(stream: str, segment_id: int) -> str:
    """Segment basename — IDENTICAL in spool and store (path-prefix swap)."""
    return f'{stream}.{segment_id:06d}.jsonl'


def spool_dir(spool_root: str, client_id: str, stream: str) -> str:
    """Local spool directory for one stream."""
    return os.path.join(spool_root, _sanitize(client_id), stream)


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

# Registry of ACTIVE writers by (client_id, stream) — lets rrext_log's delete
# coordinate with a live stream (route the mutation through the writer's lock)
# and lets L5 compose reads with a live in-memory tail.
WRITERS: Dict[str, 'RunLogWriter'] = {}


def writer_key(client_id: str, stream: str) -> str:
    """Registry key for an active writer."""
    return f'{client_id}/{stream}'


# =============================================================================
# STARTUP HYGIENE
# =============================================================================


def sweep_spool_root(spool_root: Optional[str] = None) -> None:
    """
    Delete ALL stale spool directories at supervisor startup.

    Recovery is store-side only (the spool is ephemeral in K8s and its
    contents are unrecoverable state), so anything left by a previous process
    is deleted, never salvaged. This prevents disk leaks on long-lived dev
    machines where — unlike K8s — the filesystem survives restarts.

    Args:
        spool_root: Override root (tests); defaults to default_spool_root().
    """
    root = spool_root or default_spool_root()
    if os.path.isdir(root):
        shutil.rmtree(root, ignore_errors=True)
    os.makedirs(root, exist_ok=True)


# =============================================================================
# EVENT SHAPING
# =============================================================================


def truncate_event(message: Dict[str, Any], max_bytes: int = CONST_LOG_EVENT_PAYLOAD_BYTES) -> Dict[str, Any]:
    """
    Cap an event's serialized size, preserving metadata + timestamps.

    Oversized payload carriers (trace data, output text) are replaced with a
    truncation marker; the event's identity fields (event, seq, eventTime,
    op/component/ids) always survive so timing analysis works on truncated
    bodies. The original is never mutated.

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
        store: 'IStore',
        client_id: str,
        project_id: str,
        source: str,
        run_kind: str,
        stamp: Any,
        raise_seq_floor: Any,
        *,
        spool_root: Optional[str] = None,
        debug: Any = None,
    ) -> None:
        """
        Bind the writer to a task identity and its stamping callbacks.

        Args:
            store: Raw IStore backend (fs/S3/Azure/memory).
            client_id: Owning user id (store scoping only — never in names).
            project_id: Pipeline project id.
            source: Source component id.
            run_kind: 'dev' or 'deploy' — separate continua per kind.
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

        # Identity-derived names/paths.
        self._stream = stream_name(project_id, source, run_kind)
        self._spool_root = spool_root or default_spool_root()
        self._dir = spool_dir(self._spool_root, client_id, self._stream)

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
        'uploaded' entries against the store, lift the task's seq floor to
        lastSeq + 1 (belt-and-suspenders over the epoch-us seed), then append
        the run-begin lifecycle marker and its chapter entry.

        Args:
            trigger: What started the run ('manual', 'scheduled', ...).
            user: Display identity of the run owner (never a token).
            pipeline_hash: Hash/version of the pipeline config for the header.
            trace_level: The run's pipeline trace level.
        """
        async with self._lock:
            # Fresh spool dir for this process (recovery never reads spool).
            os.makedirs(self._dir, exist_ok=True)

            # ---- Load or initialize the control file -----------------------
            self._control = await self._load_control()

            # Belt-and-suspenders: the next issued seq must exceed anything
            # this stream has ever recorded. The epoch-us seed normally wins;
            # if it does not (backward clock step), raise_seq_floor makes
            # lastSeq + 1 win and we record the anomaly in the stream itself.
            last_seq = int(self._control.get('lastSeq', 0))
            if last_seq:
                clock_seed = int(time.time() * 1_000_000)
                self._raise_seq_floor(last_seq + 1)
                if clock_seed <= last_seq:
                    self._append_line(
                        self._stamp(
                            _lifecycle_event(
                                'clock-anomaly',
                                detail=f'epoch-us seed {clock_seed} <= persisted lastSeq {last_seq}; '
                                f'continuing from lastSeq + 1',
                            )
                        )
                    )

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
            self._append_line(begin)
            self._active_has_chapter_start = True

            # Chapter entry: completed at end_run.
            chapters: List[Dict[str, Any]] = self._control.setdefault('chapters', [])
            chapters.append(
                {'beginTime': begin['eventTime'], 'beginSeq': begin['seq'], 'endTime': None, 'outcome': None}
            )
            del chapters[:-CONST_LOG_CHAPTERS]

            self._control['completed'] = False
            self._open = True
            await self._write_control()

            # Register as the stream's live writer (delete coordination + L5
            # live-tail composition).
            WRITERS[writer_key(self._client_id, self._stream)] = self

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
            raw = await self._store.read_file(control_store_path(self._client_id, self._stream))
            control = json.loads(raw)
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
            spool_path = os.path.join(self._dir, segment_basename(self._stream, int(seg['id'])))
            if os.path.exists(spool_path):
                kept.append(seg)
                self._upload_queue.append(int(seg['id']))
            else:
                lost += 1
        control['segments'] = kept
        if lost:
            self._debug(f'run-log {self._stream}: dropped {lost} spooled segment(s) lost with a previous process')

        active = control.get('active')
        if active is not None:
            active_path = os.path.join(self._dir, segment_basename(self._stream, int(active.get('id', 0))))
            if not os.path.exists(active_path):
                control.pop('active', None)
        return control

    # =========================================================================
    # APPEND PATH
    # =========================================================================

    def append(self, message: Dict[str, Any]) -> None:
        """
        Append one stamped event to the active segment (synchronous, cheap).

        Filters to LOGGED_EVENT_TYPES, samples status snapshots, caps payload
        size, writes one JSONL line to the local spool, and triggers a seal
        when the size threshold is crossed. Never blocks on the store — all
        store traffic happens in the background worker.

        Args:
            message: A stamped DAP event message (header eventTime + seq).
        """
        if not self._open:
            return

        event_type = message.get('event', '')
        if event_type not in LOGGED_EVENT_TYPES:
            return

        # Status snapshots are sampled: at most one per interval keeps coarse
        # post-hoc metrics without bloating the log.
        if event_type == 'apaevt_status_update':
            now = message.get('eventTime') or time.time()
            if now - self._last_status_logged < CONST_LOG_STATUS_SAMPLE_SECONDS:
                return
            self._last_status_logged = now

        self._append_line(truncate_event(message))

    def _append_line(self, message: Dict[str, Any]) -> None:
        """Serialize one event and append it to the active spool segment."""
        # Lazily open the active segment on first line. Seal-or-continue: a
        # later run in the SAME process reopens the previous run's unsealed
        # active file (same id) and restores its descriptor, so the shared
        # segment keeps one coherent start time/seq across runs.
        if self._active_file is None:
            seg_id = int(self._control.get('nextSegmentId', 0))
            self._active_path = os.path.join(self._dir, segment_basename(self._stream, seg_id))
            # Line-buffered: every appended event reaches the OS immediately,
            # so rrext_log reads of the ACTIVE segment are current to the
            # last event — gap-free live composition (store + spool + active)
            # without any separate in-memory tail structure.
            self._active_file = open(self._active_path, 'a', encoding='utf-8', buffering=1)
            self._active_bytes = os.path.getsize(self._active_path)
            resumed = self._control.get('active') if self._active_bytes > 0 else None
            if resumed and int(resumed.get('id', -1)) == seg_id:
                self._active_start_time = resumed.get('startTime')
                self._active_start_seq = resumed.get('seq')
                self._active_has_chapter_start = bool(resumed.get('chapterStart'))
            else:
                self._active_start_time = float(message.get('eventTime') or time.time())
                self._active_start_seq = int(message.get('seq') or 0)

        line = json.dumps(message, separators=(',', ':'), default=str) + '\n'
        self._active_file.write(line)
        self._active_bytes += len(line)

        # Track stream bookkeeping.
        self._control['lastSeq'] = max(int(self._control.get('lastSeq', 0)), int(message.get('seq') or 0))
        self._control['endTime'] = float(message.get('eventTime') or time.time())
        if self._control.get('startTime') is None:
            self._control['startTime'] = self._control['endTime']
        if message.get('event') == 'apaevt_log_lifecycle' and message.get('body', {}).get('action') == 'run-begin':
            self._active_has_chapter_start = True

        # Size seal: cut at the line boundary just crossed.
        if self._active_bytes >= CONST_LOG_SEGMENT_BYTES:
            self._seal_active()

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

        # Control entry — Rod's exact shape (+ id/state ledger fields).
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
            LEASES.delete(os.path.join(self._dir, segment_basename(self._stream, seg_id)))

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
            await self._store.delete_file(segment_store_path(self._client_id, self._stream, seg_id))
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
            path = os.path.join(self._dir, segment_basename(self._stream, seg_id))
            try:
                with open(path, 'rb') as f:
                    data = f.read()
                await self._store.write_bytes(segment_store_path(self._client_id, self._stream, seg_id), data)
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

    async def end_run(self, outcome: str, exit_message: str = '') -> None:
        """
        Complete the current run: end marker, chapter completion, flush.

        Seal-or-continue: the active segment is NOT force-sealed — small runs
        share segments (that is the point of the continuum). The tail stays
        spool-only until the next size/backstop seal; its loss window is the
        accepted crash semantics.

        Args:
            outcome: 'ok' | 'error' | 'cancelled'.
            exit_message: Optional human detail for the end marker.
        """
        async with self._lock:
            if not self._open:
                return

            end = self._stamp(_lifecycle_event('run-end', outcome=outcome, detail=exit_message))
            self._append_line(end)

            # Complete the newest open chapter.
            for chapter in reversed(self._control.get('chapters', [])):
                if chapter.get('endTime') is None:
                    chapter['endTime'] = end['eventTime']
                    chapter['outcome'] = outcome
                    break

            self._control['completed'] = True
            self._open = False

            # Close the active file HANDLE but keep the file + its control
            # descriptor: seal-or-continue means the tail stays readable (the
            # reader treats 'active' as a virtual segment) and the next run
            # in this process reopens/continues it.
            if self._active_file is not None:
                self._active_file.flush()
                self._active_file.close()
                self._active_file = None
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
        WRITERS.pop(writer_key(self._client_id, self._stream), None)

    def note_restart(self) -> None:
        """
        Record a mid-run engine restart in the stream.

        A restart is NOT a new run: the chapter continues and the seq base is
        already re-anchored by the task's in-memory counter — this marker
        just makes the restart visible on replay.
        """
        if self._open:
            self._append_line(self._stamp(_lifecycle_event('restart')))

    # =========================================================================
    # CONTROL FILE
    # =========================================================================

    async def _write_control(self) -> None:
        """Persist the control file to the store (single-writer, whole-object)."""
        # Keep the ACTIVE (unsealed) segment visible to readers: seal-or-
        # continue means a completed run's tail (incl. its run-end marker)
        # can live in the active spool file for a long time — the reader
        # includes this descriptor as a virtual segment so the tail is
        # readable the moment it is written. The active spool copy still
        # dies with the container (accepted crash-loss window).
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
            await self._store.write_file(
                control_store_path(self._client_id, self._stream),
                json.dumps(self._control, separators=(',', ':'), default=str),
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
        store: 'IStore',
        client_id: str,
        project_id: str,
        source: str,
        run_kind: str,
        *,
        spool_root: Optional[str] = None,
    ) -> None:
        """
        Bind the reader to a stream identity.

        Args:
            store: Raw IStore backend.
            client_id: Owning user id (store scoping — caller-authenticated).
            project_id: Pipeline project id.
            source: Source component id.
            run_kind: 'dev' or 'deploy'.
            spool_root: Override spool root (tests).
        """
        self._store = store
        self._client_id = client_id
        self._stream = stream_name(project_id, source, run_kind)
        self._spool_root = spool_root or default_spool_root()
        self._dir = spool_dir(self._spool_root, client_id, self._stream)

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
        writer = WRITERS.get(writer_key(self._client_id, self._stream))
        if writer is not None:
            return writer._control
        try:
            raw = await self._store.read_file(control_store_path(self._client_id, self._stream))
        except Exception as exc:
            raise FileNotFoundError(f'No run log for stream {self._stream}') from exc
        return json.loads(raw)

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
            for line in await self._read_segment_lines(int(seg['id'])):
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue

                seq = int(msg.get('seq') or 0)
                etime = float(msg.get('eventTime') or 0)

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
        spool_path = os.path.join(self._dir, segment_basename(self._stream, seg_id))
        if os.path.exists(spool_path):
            LEASES.acquire(spool_path)
            try:
                with open(spool_path, encoding='utf-8') as f:
                    return [line for line in f if line.strip()]
            except OSError:
                pass  # fall through to the store copy
            finally:
                LEASES.release(spool_path)

        try:
            data = await self._store.read_file(segment_store_path(self._client_id, self._stream, seg_id))
        except Exception:
            return []
        return [line for line in data.splitlines() if line.strip()]

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
        writer = WRITERS.get(writer_key(self._client_id, self._stream))
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
                    await self._store.delete_file(segment_store_path(self._client_id, self._stream, seg_id))
                except Exception:
                    pass
            LEASES.delete(os.path.join(self._dir, segment_basename(self._stream, seg_id)))
            control['horizonSeq'] = max(int(control.get('horizonSeq', 0)), int(seg.get('seq') or 0))

        control['segments'] = [seg for seg in segments if seg not in to_drop]

        if delete_all:
            control['chapters'] = []
            control['startTime'] = None
            try:
                await self._store.delete_file(control_store_path(self._client_id, self._stream))
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
                    await self._store.write_file(
                        control_store_path(self._client_id, self._stream),
                        json.dumps(control, separators=(',', ':'), default=str),
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
