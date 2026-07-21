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

        # Drop segments whose bytes died in a previous process's spool.
        kept = [seg for seg in control.get('segments', []) if seg.get('state') == 'uploaded']
        lost = len(control.get('segments', [])) - len(kept)
        control['segments'] = kept
        if lost:
            self._debug(f'run-log {self._stream}: dropped {lost} spooled segment(s) lost with a previous process')
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
        # Lazily open the active segment on first line.
        if self._active_file is None:
            seg_id = int(self._control.get('nextSegmentId', 0))
            self._active_path = os.path.join(self._dir, segment_basename(self._stream, seg_id))
            self._active_file = open(self._active_path, 'a', encoding='utf-8')
            self._active_bytes = os.path.getsize(self._active_path)
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

            if self._active_file is not None:
                self._active_file.flush()
            await self._drain_uploads()
            await self._write_control()

        if self._worker:
            self._worker.cancel()
            try:
                await self._worker
            except asyncio.CancelledError:
                pass
            self._worker = None

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
        try:
            await self._store.write_file(
                control_store_path(self._client_id, self._stream),
                json.dumps(self._control, separators=(',', ':'), default=str),
            )
        except Exception as e:
            self._debug(f'run-log {self._stream}: control write failed: {e}')


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
