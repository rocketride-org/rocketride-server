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
Tenki Sandbox tool node - global (shared) state.

Reads the Tenki workspace API key, the sandbox sizing and the published tool
groups from config and creates a Tenki client. The session itself is created
lazily on the first tool call (creating one costs money and time, and a
pipeline may never invoke the tool) and is closed in ``endGlobal``. Tool logic
lives on IInstance via @tool_function, and every tool reaches the session
through ``call_with_session``, which owns recovery.

Three things differ from tool_daytona and shape this file:

* An idle Tenki session is paused, not deleted, and there is no ephemeral
  flag. ``endGlobal`` is what stops a session, and ``max_duration`` is the
  server-side backstop for a pipeline that never gets there.
* A create whose readiness wait fails can leave a live, billing sandbox that
  nothing references, so the create path closes it explicitly.
* Recovery follows the session's actual state, not the exception alone: a
  paused session is resumed (its memory and files survive), a terminated one
  is replaced, and anything else is surfaced.

Tenancy: the session belongs to the pipeline, not to a user. Every caller of a
running pipeline (every conversation of a team-deployed one, for example)
shares it, with its files, installed packages and GitHub token.
"""

from __future__ import annotations

import threading
import uuid
from contextlib import nullcontext

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, debug, warning

from tenki import (
    Client,
    InvalidStateError,
    Sandbox,
    SessionNotFoundError,
    SessionTerminatedError,
    TemplateRuntimeFailedError,
    WaitReadyFailedError,
)

from .tool_groups import DEFAULT_GROUPS, normalize_groups, unknown_groups

# The deadline for every control-plane call: create, refresh, resume, close, and git operations.
# Git clones share it, so it never drops below the execution timeout, and the floor keeps a small
# execution timeout from starving session creation.
_MIN_RPC_TIMEOUT_SECS = 60

# How long recovery waits for a resumed session to run again: the SDK's own readiness budget.
_READY_WAIT_SECS = 180

# Given an empty endpoint the SDK resolves one from TENKI_API_ENDPOINT / TENKI_API_URL,
# so the public default is passed explicitly rather than left to the host's environment.
_DEFAULT_BASE_URL = 'https://api.tenki.cloud'

# States in which a session is treated as unable to serve another call. USER_SHUTDOWN is
# not in Tenki's documented lifecycle, but it is in the protocol, and a session that has
# shut down is handled like a terminated one.
_GONE_STATES = frozenset({'TERMINATING', 'TERMINATED', 'USER_SHUTDOWN'})

# Errors that can mean the session itself stopped being usable. Each is only a hint:
# the SDK maps every NOT_FOUND it cannot attribute to SessionNotFoundError and every
# unrecognised FAILED_PRECONDITION to InvalidStateError, so a healthy session can raise
# either. recover_session checks the real state before acting on one.
_LIFECYCLE_ERRORS = (SessionNotFoundError, SessionTerminatedError, InvalidStateError)


class SessionEndedError(Exception):
    """The session has ended, and the call was one a fresh, empty session could not serve."""

    def __init__(self) -> None:
        super().__init__(
            'the sandbox session has ended, so its files are gone; the next command or file write '
            'starts a fresh, empty sandbox'
        )


def _int_or(value, default: int, *, lo: int, hi: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(n, hi))


class IGlobal(IGlobalBase):
    """Global state for tool_tenki."""

    client: Client | None = None
    session: Sandbox | None = None  # created lazily, closed in endGlobal
    # Bumped under the lock whenever the session is resumed or dropped. A call that
    # failed against the old state compares it to decide that a concurrent call has
    # already recovered the session, and retries instead of re-checking a session that
    # is healthy by now and misreporting its own failure as unrelated.
    session_epoch: int = 0
    # Guards session creation and recovery: agents issue parallel tool calls (e.g.
    # deepagent's asyncio.gather fan-out), and an unsynchronized check-then-act would
    # create two billed sessions and orphan one, or resume one session several times.
    _session_lock: threading.Lock | None = None
    # How the most recent recovery went, 'resumed' or 'replaced'. A call that retries after a
    # concurrent call did the recovering reports this, since it did not see the recovery itself.
    last_recovery: str = ''
    # Set as endGlobal starts. No session may be created after that: nothing would close it.
    _ending: bool = False
    rpc_timeout_secs: int = 120
    image: str = ''
    github_token: str = ''
    cpu_cores: int = 2
    memory_mb: int = 4096
    disk_size_gb: int = 5
    idle_timeout_minutes: int = 5
    max_duration_minutes: int = 60
    exec_timeout_secs: int = 120
    max_output_chars: int = 50000
    tool_groups: frozenset = DEFAULT_GROUPS

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        self._session_lock = threading.Lock()
        self._ending = False

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        apikey = str((cfg.get('apikey') or '')).strip()

        # Checked here rather than left to the SDK: given an empty token it falls back to
        # TENKI_AUTH_TOKEN / TENKI_API_KEY, which would let a key in the engine host's
        # environment silently decide which workspace gets billed.
        if not apikey:
            raise Exception('tool_tenki: apikey is required')

        # A value naming only unknown groups raises in normalize_groups rather than falling back
        # to the defaults. A partially unknown one narrows to the names that matched, which is
        # what the operator asked for minus the typo, so it runs; the dropped names go to the
        # job log, because the editor warning in validateConfig never reaches a deployed pipeline.
        self.tool_groups = normalize_groups(cfg.get('toolGroups'))
        dropped = unknown_groups(cfg.get('toolGroups'))
        if dropped:
            warning(
                f'tool_tenki: ignoring unknown tool group(s): {", ".join(dropped)}. '
                f'Publishing: {", ".join(sorted(self.tool_groups))}'
            )

        base_url = str((cfg.get('base_url') or '')).strip() or _DEFAULT_BASE_URL
        self.image = str((cfg.get('image') or '')).strip()
        self.github_token = str((cfg.get('github_token') or '')).strip()
        self.cpu_cores = _int_or(cfg.get('cpu_cores'), 2, lo=1, hi=16)
        # Tenki rejects odd memory sizes (they must align to 2 MiB). Rounding down stays in
        # range because both bounds are even.
        memory_mb = _int_or(cfg.get('memory_mb'), 4096, lo=512, hi=65536)
        self.memory_mb = memory_mb - memory_mb % 2
        # The SDK refuses a disk under 5 GB before sending the request.
        self.disk_size_gb = _int_or(cfg.get('disk_size_gb'), 5, lo=5, hi=100)
        self.idle_timeout_minutes = _int_or(cfg.get('idle_timeout_minutes'), 5, lo=1, hi=120)
        self.max_duration_minutes = _int_or(cfg.get('max_duration_minutes'), 60, lo=1, hi=1440)
        self.exec_timeout_secs = _int_or(cfg.get('exec_timeout_secs'), 120, lo=1, hi=1200)
        self.max_output_chars = _int_or(cfg.get('max_output_chars'), 50000, lo=1000, hi=1000000)

        self.rpc_timeout_secs = max(self.exec_timeout_secs, _MIN_RPC_TIMEOUT_SECS)
        # Without a deadline, a half-open connection would hang create, refresh, resume and close,
        # all of which run under the session lock, and endGlobal behind them while the VM bills.
        self.client = Client(auth_token=apikey, base_url=base_url, timeout=self.rpc_timeout_secs)

    def get_session(self) -> Sandbox:
        """Return the shared session, creating it on first use."""
        session = self.session
        if session is None:
            with self._session_lock:
                if self._ending:
                    raise RuntimeError(
                        'tool_tenki: the pipeline is shutting down, so no new sandbox session is created'
                    )
                if self.session is None:
                    self.session = self._create_session()
                    debug(f'tool_tenki: created session {getattr(self.session, "id", "?")}')
                session = self.session
        return session

    def _create_session(self) -> Sandbox:
        create_kwargs = {
            'cpu_cores': self.cpu_cores,
            'memory_mb': self.memory_mb,
            'disk_size_gb': self.disk_size_gb,
            'idle_timeout_minutes': self.idle_timeout_minutes,
            # Tenki has no ephemeral flag and its idle timeout only pauses, so this is what
            # ends a session whose pipeline never reached endGlobal (a crashed engine). The
            # SDK takes seconds. sticky stays at its default of False: a sticky session
            # discards max_duration and is never paused for idling.
            'max_duration': self.max_duration_minutes * 60,
            # Inbound exposure can only be set at create time, and no tool this node
            # publishes uses it, so sessions are created closed to inbound traffic.
            'allow_inbound': False,
            # So that a session a crashed engine left behind can be recognised in Tenki's console
            # and listed by tag. The suffix keeps names distinct in case the service requires it.
            'name': f'rocketride-tool-tenki-{uuid.uuid4().hex[:8]}',
            'tags': ['rocketride'],
            'metadata': {'created_by': 'rocketride', 'node': 'tool_tenki'},
        }
        if self.image:
            create_kwargs['image'] = self.image
        if self.github_token:
            # Lets git clone private repositories. Tenki hands it to the VM as the GH_TOKEN and
            # GIT_TOKEN environment variables, where any command the agent runs can read it; the
            # config field warns about exactly that.
            create_kwargs['github_token'] = self.github_token
        try:
            return self.client.create(**create_kwargs)
        except (WaitReadyFailedError, TemplateRuntimeFailedError) as e:
            self._close_left_running(e)
            raise

    def _close_left_running(self, error: Exception) -> None:
        """Close the sandbox a failed create left running, so it stops billing.

        Tenki admits the sandbox before the readiness wait, so this failure can leave a
        live session that nothing references, and scope-based cleanup cannot catch it
        because create never returned. ``WaitReadyFailedError`` carries the live handle.
        ``TemplateRuntimeFailedError`` raised by the create call itself carries only the
        session's info record (or nothing), so the handle is fetched by id first. A close
        that fails is only logged: the create error is what the caller needs, and
        max_duration still ends the session.
        """
        carried = getattr(error, 'sandbox', None)
        if carried is None:
            return
        try:
            if callable(getattr(carried, 'close', None)):
                carried.close()
            elif getattr(carried, 'id', '') and getattr(carried, 'state', '') not in _GONE_STATES:
                self.client.get(carried.id).close()
        except Exception as e:
            warning(f'tool_tenki: could not close the sandbox a failed create left running: {e}')

    def call_with_session(self, call, *, replace: bool = True, on_recovery=None):
        """Return ``call(session)``, recovering the session once if it stopped being usable.

        A lifecycle error only prompts a look at the session's state (see
        ``recover_session``). The call is retried once, on the recovered session, when that
        state explains the failure; every other error propagates unchanged.

        ``replace=False`` is for calls that only look at existing state (reading, listing or
        deleting files). If the session turns out to have ended, a fresh, empty one could not
        serve them, so ``SessionEndedError`` is raised instead of creating a session for nothing.

        ``on_recovery``, if given, is called with 'resumed' or 'replaced' before the retry, so the tool
        can tell the agent that its call ran on a resumed session, or on a fresh and empty one.
        """
        epoch = self.session_epoch
        session = self.get_session()
        try:
            return call(session)
        except _LIFECYCLE_ERRORS:
            recovery = self.recover_session(session, epoch, replace=replace)
            if not recovery:
                raise
        if on_recovery is not None:
            on_recovery(recovery)
        return call(self.get_session())

    def recover_session(self, session: Sandbox, epoch: int, *, replace: bool = True) -> str | None:
        """Bring a session that failed a call back to a usable state.

        Returns how it was recovered, 'resumed' or 'replaced', when the call should be retried, and
        None when the failure had another cause. Decided by the session's real state, because the
        error that led here is only a hint:

        * Already recovered by a concurrent call (a different session or epoch): retry.
        * Unknown to the service, or in a gone state: forget it (closing it first unless the
          service already did), so the next ``get_session`` creates a fresh one. Its files
          are lost either way. With ``replace=False`` the caller is not retried on that fresh
          session: ``SessionEndedError`` is raised instead.
        * Paused by Tenki's idle timeout: resume it and wait until it runs. Never replace
          it, since a pause preserves the agent's memory and files.
        * Any other state (running, starting, pausing): the failure had another cause, so
          it is surfaced.
        """
        with self._session_lock:
            if self.session is not session or self.session_epoch != epoch:
                # A concurrent call already dealt with this session. If it dropped it, retrying
                # would create a fresh session, which a caller passing replace=False cannot use.
                if self.session is None and not replace:
                    raise SessionEndedError()
                return self.last_recovery or None
            try:
                state = session.refresh().state
            except SessionNotFoundError:
                state = None
            if state is None or state in _GONE_STATES:
                if state is not None:
                    try:
                        session.close_if_open()
                    except Exception as e:
                        warning(f'tool_tenki: could not close session {session.id}: {e}')
                self.session = None
                self.session_epoch += 1
                self.last_recovery = 'replaced'
                # A warning rather than debug output: the next call pays for a new VM and starts empty.
                warning(
                    f'tool_tenki: session {session.id} is {state or "gone"}; the next call starts a new, empty session'
                )
                if not replace:
                    raise SessionEndedError()
                return 'replaced'
            if state == 'PAUSED':
                session.resume()
                session.wait_ready(timeout=_READY_WAIT_SECS)
                self.session_epoch += 1
                self.last_recovery = 'resumed'
                debug(f'tool_tenki: resumed paused session {session.id}')
                return 'resumed'
            return None

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = str((cfg.get('apikey') or '')).strip()
            if not apikey:
                warning('apikey is required')
            elif not apikey.startswith('tk_'):
                warning('apikey must be a Tenki workspace API key, which starts with tk_')
            unknown = unknown_groups(cfg.get('toolGroups'))
            if unknown:
                warning(f'unknown tool group(s): {", ".join(unknown)}')
            try:
                normalize_groups(cfg.get('toolGroups'))
            except ValueError:
                warning('toolGroups matches no known group, so the pipeline will fail to start')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        # First, so that no tool call can create a session after the close below.
        self._ending = True
        # Load-bearing for Tenki: a session left open keeps billing until its idle timeout
        # pauses it, then holds storage until max_duration ends it. Taking the lock lets a
        # create still in flight finish first, so the session it produces is closed too.
        with self._session_lock or nullcontext():
            if self.session is not None:
                try:
                    self.session.close()
                except Exception as e:
                    warning(f'tool_tenki: session close failed: {e}')
                finally:
                    self.session = None
        if self.client is not None:
            try:
                self.client.close()
            except Exception as e:
                warning(f'tool_tenki: client close failed: {e}')
            finally:
                self.client = None
        self.github_token = ''
