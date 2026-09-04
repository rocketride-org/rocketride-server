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
RocketRide AI Configuration Constants.

Global configuration values for metrics, billing, and system tuning.
"""

import logging
import os

_log = logging.getLogger(__name__)


def _env_int(name: str, default: int, *, minimum: int = None, maximum: int = None) -> int:
    """
    Read an integer from the environment, defensively.

    Operators set these in a Dockerfile, a Helm values file or a shell — all
    places where a typo is silent. Anything unparseable or out of range falls
    back to the default WITH A WARNING rather than crashing the server at
    import time or, worse, silently launching a wildly wrong number of
    subprocesses.

    Args:
        name: Environment variable name.
        default: Value used when unset, empty, unparseable, or out of range.
        minimum: Lowest accepted value, if any.
        maximum: Highest accepted value, if any.

    Returns:
        int: The parsed value, or ``default``.
    """
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default

    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        _log.warning('Ignoring invalid %s=%r (not an integer); using %d', name, raw, default)
        return default

    if minimum is not None and value < minimum:
        _log.warning('Ignoring out-of-range %s=%r (minimum %d); using %d', name, raw, minimum, default)
        return default

    if maximum is not None and value > maximum:
        _log.warning('Ignoring out-of-range %s=%r (maximum %d); using %d', name, raw, maximum, default)
        return default

    return value


# =============================================================================
# Metrics Sampling and Reporting Intervals
# =============================================================================
CONST_METRICS_SAMPLE_INTERVAL = 0.25  # seconds between metric samples (250ms)
CONST_BILLING_REPORT_INTERVAL = 15.0  # 5 * 60.0  # seconds between billing reports (5 minutes)
CONST_METRICS_STOP_TIMEOUT = 5.0  # seconds to wait for metrics monitoring to stop gracefully

# =============================================================================
# Billing API Configuration
# =============================================================================
CONST_BILLING_API_TIMEOUT = 10.0  # seconds timeout for HTTP requests to billing API

# Billing rates are loaded from the metrics_conversions DB table at startup
# and cached in Account._billing_rates. See Account.get_billing_rates().
# Admins manage rates via the Billing Rates page in the admin UI.

# =============================================================================
# Task Engine Configuration
# =============================================================================
CONST_DEFAULT_MAX_THREADS = 64  # default thread pool size for task execution
CONST_CANCEL_WAIT_TIMEOUT_SECONDS = 5  # seconds to wait for graceful task cancellation
CONST_STATUS_UPDATE_FREQ = 1.0  # seconds between status broadcast updates
CONST_MAX_READY_TIME = 5 * 60  # seconds to wait for task to become ready
CONST_READY_POLL_INTERVAL = 0.250  # seconds between readiness checks
CONST_SUBPROCESS_BUFFER_LIMIT = 16 * 1024 * 1024  # bytes for subprocess stdin/stdout/stderr buffers (16MB)
CONST_STATUS_UPDATE_CANCEL_TIMEOUT = 2.0  # seconds to wait for status update task cancellation
CONST_DEFAULT_TTL = 15 * 60  # default time-to-live for idle tasks in seconds (15 minutes)
CONST_TTL_CHECK = 60  # check for tasks to kill every 60 seconds

# =============================================================================
# Task Replicas and Per-Replica BLAS/OMP Threads
# =============================================================================
# ONE task = one engine subprocess = one model copy behind one lock, so a
# single task runs one inference at a time no matter how large `threads` is
# (`threads` is admission width / the engine's component pool, NOT inference
# parallelism). `replicas` is the throughput lever: N subprocesses behind ONE
# token, inputs round-robined across them.
CONST_MAX_REPLICAS = 32  # hard ceiling on replicas per task (requests are clamped)

# Server-wide default replica count, overridable per request.
CONST_DEFAULT_REPLICAS = _env_int('ROCKETRIDE_TASK_REPLICAS', 1, minimum=1, maximum=CONST_MAX_REPLICAS)

# Server-wide default per-replica BLAS/OMP thread count. 0 means "auto":
# cpu_count // replicas when replicas > 1, and inject nothing at all when
# replicas == 1 (preserving the pre-replica behavior exactly).
CONST_DEFAULT_TORCH_THREADS = _env_int('ROCKETRIDE_TORCH_THREADS', 0, minimum=0)

# The six variables every BLAS/OMP stack in the engine reads. They must be set
# TOGETHER — pinning only OMP still lets MKL or OpenBLAS spawn cpu_count
# threads per replica, and N replicas × cpu_count threads thrashes the box.
CONST_TORCH_THREAD_ENV_VARS = (
    'OMP_NUM_THREADS',
    'MKL_NUM_THREADS',
    'OPENBLAS_NUM_THREADS',
    'VECLIB_MAXIMUM_THREADS',
    'NUMEXPR_NUM_THREADS',
    'TORCH_NUM_THREADS',
)

# =============================================================================
# Run Logging (per-task JSONL event continuum) Configuration
# =============================================================================
# Run-analytics slowest-completions list: the status body keeps this many
# of the run's slowest completions (insert-sorted, slowest first).
CONST_ANALYTICS_SLOWEST_DOCS = 10

# Sealed-segment size: the active spool segment seals at this many bytes
# (on a line boundary) and uploads as one immutable store object.
CONST_LOG_SEGMENT_BYTES = 16 * 1024 * 1024  # 16 MB

# Backstop seal: seal a non-empty active segment older than this many seconds
# even if under the size threshold (caps host-loss tail + store lag for
# low-volume long-lived streams at <= 1 object/day).
CONST_LOG_BACKSTOP_SEAL_SECONDS = 24 * 60 * 60  # 24 hours

# Ring size: fixed length of the control file's segments array; the oldest
# segment is evicted (store + spool) when the ring is full.
CONST_LOG_SEGMENTS = 64  # 64 x 16 MB = 1 GB retained per stream

# Chapters cap: newest-N run chapters kept in the control file (in addition
# to horizon trimming) so the control file stays small under rapid dev runs.
CONST_LOG_CHAPTERS = 512

# Per-event payload cap: larger event payload fields are truncated with a
# marker before logging (metadata + timestamps always survive).
CONST_LOG_EVENT_PAYLOAD_BYTES = 64 * 1024  # 64 KB

# Stream history age per run kind (seconds): segments wholly older than this
# are evicted even if the ring is not full.
CONST_LOG_HISTORY_SECONDS_DEV = 7 * 24 * 60 * 60  # 7 days
CONST_LOG_HISTORY_SECONDS_DEPLOY = 30 * 24 * 60 * 60  # 30 days

# Status-event sampling: at most one apaevt_status_update is logged per this
# many seconds (coarse post-hoc metrics without bloating the log).
CONST_LOG_STATUS_SAMPLE_SECONDS = 5.0

# rrext_log read paging defaults (callers may lower, never raise).
CONST_LOG_READ_MAX_EVENTS = 2000
CONST_LOG_READ_MAX_BYTES = 4 * 1024 * 1024  # 4 MB

# rrext_log segment raw-fetch chunk ceiling: whole-line-aligned raw JSONL bytes
# per response. Sized well under the transport's 4 MB message budget because
# the chunk rides JSON-escaped inside the DAP envelope.
CONST_LOG_SEGMENT_FETCH_BYTES = 2 * 1024 * 1024  # 2 MB

# Segment keyframe bounds (DVR v2). The keyframe carries accumulated state so
# every segment folds standalone: recently-closed trace summaries, the console
# scrollback (terminal semantics — display truth at any position), and a
# sanity ceiling on open-frame entries (leak armor only; real concurrency is
# bounded by threadCount).
CONST_LOG_KF_CLOSED_TRACES = 50
CONST_LOG_KF_SCROLLBACK_LINES = 2000
CONST_LOG_KF_SCROLLBACK_LINE_CHARS = 400
CONST_LOG_KF_OPEN_CEILING = 4096

# =============================================================================
# Task Server Configuration
# =============================================================================
CONST_CLEANUP_DELAY_TIME = 5 * 60  # seconds grace period to keep completed tasks (5 minutes)
CONST_CLEANUP_SLEEP_TIME = 1 * 60  # seconds between cleanup scans (1 minute)

# =============================================================================
# Web Server Configuration
# =============================================================================
CONST_AUTH_PENDING_TIMEOUT = 600  # seconds before an OAuth-pending connection is dropped (10 minutes)
CONST_MAX_PENDING_OAUTH_STATES = 500  # global cap on simultaneous OAuth state nonces
CONST_MAX_UNAUTHED_CONNS_PER_IP = 10  # max unauthenticated WebSocket connections per client IP
CONST_MAX_UNAUTHED_IPS = 10_000  # global cap on distinct IPs holding unauthenticated slots
CONST_AUTH_MAX_ATTEMPTS_PER_CONN = 5  # max rrext_account_authenticate calls per connection
CONST_DEFAULT_WEB_PORT = 5565  # default web server port
CONST_DEFAULT_WEB_HOST = 'localhost'  # default bind address (localhost only; use 0.0.0.0 in Docker/K8s)
CONST_WEB_WS_MAX_SIZE = 250 * 1024 * 1024  # maximum WebSocket message size in bytes (250MB)

# =============================================================================
# Data Connection Configuration
# =============================================================================
CONST_DATA_PIPE_TIMEOUT = 60.0  # seconds of inactivity before pipe is considered zombie
CONST_DATA_SHUTDOWN_TIMEOUT = 30.0  # seconds to wait for data connection shutdown
CONST_DATA_OPEN_TARGET_WAIT = 5.0  # seconds `_open` waits for source to bind `state.target`

# =============================================================================
# HTTP/Stream Configuration
# =============================================================================
CONST_HTTP_CHUNK_SIZE = 64 * 1024  # bytes per chunk for streaming data (64KB)

# =============================================================================
# Chat/LLM Retry Configuration
# =============================================================================
CONST_CHAT_MAX_RETRIES = 5  # maximum network/API retry attempts
CONST_CHAT_BASE_DELAY = 1.0  # base delay in seconds for exponential backoff
CONST_CHAT_MAX_DELAY = 60.0  # maximum delay in seconds between retries

# =============================================================================
# Transport/DAP Configuration
# =============================================================================
CONST_TRANSPORT_PROCESS_WAIT_TIMEOUT = 5.0  # seconds to wait for process termination

# =============================================================================
# Model Server Configuration
# =============================================================================
CONST_MODEL_SERVER_PORT = 5590  # default model server port
CONST_MODEL_SERVER_HOST = 'localhost'  # default bind address (localhost only; use 0.0.0.0 in Docker/K8s)
CONST_SCALE_UP_DRAIN_TIME_S = 30  # scale up if estimated drain time exceeds this (seconds)
CONST_SCALE_UP_DELAY_S = 15  # ...sustained for this long before acting (seconds)
CONST_SCALE_DOWN_DRAIN_TIME_S = 2  # scale down if drain time below this (seconds)
CONST_SCALE_DOWN_DELAY_S = 300  # ...sustained for this long (5 min)
CONST_REPLICA_MANAGER_INTERVAL_S = 10  # seconds between auto-scaling checks
