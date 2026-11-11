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

"""Tenki Sandbox tool node: config, and the one session every call of the pipeline shares, with its recovery."""

from __future__ import annotations

import re
import threading
import time
import urllib.parse
import uuid

from ai.common.config import Config
from ai.common.utils import config_int
from rocketlib import IGlobalBase, OPEN_MODE, debug, warning

from tenki import (
    Client,
    CommandTimeoutError,
    FileNotFoundError as TenkiFileNotFoundError,
    InvalidStateError,
    PermissionDeniedError,
    QuotaExceededError,
    Sandbox,
    SandboxError,
    SessionNotFoundError,
    SessionTerminatedError,
    TemplateRuntimeFailedError,
    WaitReadyFailedError,
)

from .sdk_shims import bound_file_calls, stop_keeping_output

# The deadline of every control-plane and file call; git clones share it, so it never drops below the exec timeout.
_MIN_RPC_TIMEOUT_SECS = 60
_READY_WAIT_SECS = 180  # the SDK's own readiness budget
# Measured 2026-10-05 and 2026-10-09: after a pause Tenki refuses a resume for up to about 48 s ("paused source is still
# being torn down", "snapshot not yet durable"), so a refused resume is asked again while the session still waits.
_RESUME_RETRY_SECS = 120
_RESUME_RETRY_PAUSE_SECS = 5
_WARM_UP_TIMEOUT_SECS = 10
_WARM_UP_WAIT_SECS = 40
# How long endGlobal waits for a call holding the session lock before it closes the session anyway.
_END_LOCK_WAIT_SECS = 10
# Given an empty endpoint the SDK reads TENKI_API_ENDPOINT / TENKI_API_URL, so the default is passed explicitly.
_DEFAULT_BASE_URL = 'https://api.tenki.cloud'
# USER_SHUTDOWN is not in Tenki's documented lifecycle, but it is in the protocol.
_GONE_STATES = frozenset({'TERMINATING', 'TERMINATED', 'USER_SHUTDOWN'})
_SHUTTING_DOWN = 'tool_tenki: the pipeline is shutting down, so no sandbox session is used'
TOOL_GROUPS = frozenset({'execution', 'filesystem', 'git'})


class SessionUnavailableError(SandboxError):
    """No usable session could be had; a SandboxError, so every tool returns it to the agent as an error result."""


class SessionEndedError(SandboxError):
    """The session ended, and the call is one a fresh, empty session could not serve."""

    def __init__(self) -> None:
        super().__init__(
            'the sandbox session has ended, so its files are gone; the next command or file write '
            'starts a fresh, empty sandbox'
        )


class CommandNotStartedError(SandboxError):
    """The sandbox never confirmed a command's start, so it was cancelled (not the command timing out)."""


# Measured on a paused session: "failed to read vsock CONNECT response ... failed to connect to vsock at
# .../rootfs.img.vsock: connect: no such file or directory", which the SDK classes as a missing file.
_VM_LINK_DOWN = re.compile(r'failed to (?:connect to|read) vsock')


def about_the_vm_link(error: Exception) -> bool:
    """Whether a "no such file" error is about Tenki's socket to the VM rather than a path inside it."""
    return isinstance(error, TenkiFileNotFoundError) and _VM_LINK_DOWN.search(str(error)) is not None


def _may_be_paused(error: Exception) -> bool:
    """Whether a failure says too little to rule out a paused or ended session, so the session's state is read."""
    # The SDK maps every unattributed NOT_FOUND and FAILED_PRECONDITION to the first two classes, and a pause has been
    # measured to arrive as an unclassified error, as a vsock "missing file" and as a start that never came.
    return (
        isinstance(error, (SessionNotFoundError, SessionTerminatedError, InvalidStateError, CommandNotStartedError))
        or type(error) is SandboxError
        or about_the_vm_link(error)
        or (isinstance(error, (RuntimeError, TimeoutError)) and not isinstance(error, SandboxError))
    )


def _names(raw, field: str) -> list[str]:
    """The distinct, non-empty entries of a list setting given as a list or a comma-separated string."""
    # Any other shape is refused: an allowlist misread as empty would leave the sandbox's network open.
    if raw is None:
        return []
    if isinstance(raw, str):
        raw = raw.split(',')
    if not isinstance(raw, (list, tuple)):
        raise ValueError(
            f'tenki.{field} must be a list of names, or one comma-separated string, not a {type(raw).__name__}'
        )
    names = []
    for position, entry in enumerate(raw, 1):
        if not isinstance(entry, str):
            raise ValueError(f'tenki.{field}: entry {position} is a {type(entry).__name__}, not text')
        name = entry.strip()
        if name and name not in names:
            names.append(name)
    return names


# Tenki's rule (measured 2026-10-09): RFC 1123 hostname labels, optionally after one leading "*.".
_DOMAIN = re.compile(r'^(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$')
_MAX_DOMAINS = 256
_MAX_DOMAIN_CHARS = 253


def _allowed_domains(raw) -> list[str]:
    """The outbound allowlist, lowercase and without a trailing dot as Tenki stores it; any refused entry raises."""
    domains, refused, positions = [], [], []
    for position, name in enumerate(_names(raw, 'allow_domains'), 1):
        domain = name.lower().rstrip('.')
        # ASCII is checked before lowercasing could make it so (the Kelvin sign lowercases to "k").
        if not name.isascii() or len(domain) > _MAX_DOMAIN_CHARS or not _DOMAIN.match(domain):
            # An entry with an "@" may be a URL that carries credentials: say where it is, not what it says.
            refused.append(f'entry {position} (not shown: it may hold a credential)' if '@' in name else name)
            positions.append(str(position))
        elif domain not in domains:
            domains.append(domain)
    if refused:
        # The rule before any entry: the engine cuts a startup error at its first asterisk.
        one = len(positions) == 1
        raise ValueError(
            f'tenki.allow_domains has {"an entry" if one else "entries"} Tenki refuses '
            f'({"entry" if one else "entries"} {", ".join(positions)}). Use bare hostnames such as pypi.org, '
            'optionally starting with one wildcard label (an asterisk and a dot), with no scheme, path or port. '
            f'Refused: {", ".join(refused)}'
        )
    if len(domains) > _MAX_DOMAINS:
        raise ValueError(f'tenki.allow_domains lists {len(domains)} hosts, and Tenki accepts up to {_MAX_DOMAINS}')
    return domains


def _secret_settings(cfg) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """The secret policies to attach and the outbound allowlist; policies without an allowlist raise."""
    policies = tuple(_names(cfg.get('secret_policies'), 'secret_policies'))
    domains = tuple(_allowed_domains(cfg.get('allow_domains')))
    if policies and not domains:
        raise ValueError(
            'tenki.secret_policies is set but tenki.allow_domains is empty. With no allowlist a sandbox can '
            'reach any host on any port, and one that can use a secret must not: list the hosts it needs in '
            'tenki.allow_domains (github.com, for example).'
        )
    return policies, domains


# The name Tenki reads after "secrets://" (tenki 1.4.1); any other name would never be substituted.
_SECRET_NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_-]{0,127}')
# How GitHub, GitLab and Slack tokens begin: no secret's name does.
_TOKEN_PREFIXES = ('ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'glpat-', 'xoxb-', 'xoxp-')
# How Tenki, Anthropic, OpenAI and AWS keys begin, but names can too (tk_github_basic), so length and a digit decide.
_SHARED_PREFIXES = ('tk_', 'sk-', 'AKIA')


def _looks_like_a_credential(value: str) -> bool:
    """Whether ``value`` reads as an issued token rather than a secret's name."""
    if value.startswith(_TOKEN_PREFIXES):
        return True
    return value.startswith(_SHARED_PREFIXES) and len(value) >= 20 and any(c.isdigit() for c in value)


# The characters git leaves as they are when it normalizes a URL's path, so the node and git read one prefix.
_PREFIX_PATH = re.compile(r'/[A-Za-z0-9._~/-]*')
_DEFAULT_GIT_AUTH_URL = 'https://github.com/'


def _git_auth_url(raw: str) -> str:
    """The private-repository prefix as git matches it: lowercase https scheme and host, ending in a slash."""
    # The slash keeps https://github.com/acme from also covering https://github.com/acme-evil.
    parsed = urllib.parse.urlsplit(raw)
    try:
        port = parsed.port
    except ValueError:
        port = -1
    host = parsed.hostname or ''
    path = parsed.path or '/'
    segments = path.split('/')
    if (
        not raw.isascii()
        or any(character.isspace() for character in raw)
        or parsed.scheme.lower() != 'https'
        or '@' in parsed.netloc
        or port is not None
        or '?' in raw
        or '#' in raw
        or not host
        or host.startswith('*')
        or not _DOMAIN.match(host)
        or not _PREFIX_PATH.fullmatch(path)
        or '.' in segments
        or '..' in segments
    ):
        raise ValueError(
            'tenki.git_auth_url must be an https URL with a host and, optionally, a path, such as '
            'https://github.com/acme/, with no credentials, port, query or fragment (the value is not shown: '
            'it may hold a credential)'
        )
    return f'https://{host}{path if path.endswith("/") else path + "/"}'


def _git_auth_settings(cfg, policies: tuple[str, ...], domains: tuple[str, ...]) -> tuple[str, str]:
    """The URL prefix git_clone authenticates under and the Tenki secret it names, or ('', '') when off."""
    secret = cfg.get('git_auth_secret')
    if secret is None or (isinstance(secret, str) and not secret.strip()):
        return '', ''
    if isinstance(secret, str) and _looks_like_a_credential(secret.strip()):
        raise ValueError(
            'tenki.git_auth_secret looks like a credential value (it begins the way issued tokens do), not the name '
            'of a Tenki secret. The node never holds a secret value: create the secret in Tenki '
            'and put its name here. If this is the name of a secret, rename the secret.'
        )
    if not isinstance(secret, str) or not _SECRET_NAME.fullmatch(secret.strip()):
        raise ValueError(
            'tenki.git_auth_secret must be the name of a Tenki secret, as a placeholder names it: a letter or '
            'underscore, then up to 127 letters, digits, underscores and hyphens'
        )
    raw = cfg.get('git_auth_url')
    if raw is not None and not isinstance(raw, str):
        raise ValueError('tenki.git_auth_url must be a URL such as https://github.com/acme/')
    prefix = _git_auth_url((raw or '').strip() or _DEFAULT_GIT_AUTH_URL)
    if not policies:
        raise ValueError(
            'tenki.git_auth_secret is set but tenki.secret_policies is empty. Tenki adds the secret only to '
            'requests an attached policy allows: name the policy that covers the repositories under '
            f'{prefix} in tenki.secret_policies.'
        )
    host = urllib.parse.urlsplit(prefix).hostname
    # Tenki documents that a wildcard entry matches exactly one label: *.example.com covers api.example.com only.
    if not any(
        domain == host or (domain.startswith('*.') and host.partition('.')[2] == domain[2:]) for domain in domains
    ):
        raise ValueError(
            f'tenki.git_auth_url is on {host}, which tenki.allow_domains does not list, so the sandbox could '
            f'not reach it: add {host} to tenki.allow_domains.'
        )
    return prefix, secret.strip()


def _outlives_the_session(exec_timeout_secs: int, max_duration_minutes: int) -> str | None:
    """The warning for a command allowed to run as long as the session lives, or None."""
    if exec_timeout_secs < max_duration_minutes * 60:
        return None
    return (
        f'tool_tenki: exec_timeout_secs ({exec_timeout_secs}s) is not shorter than max_duration_minutes '
        f'({max_duration_minutes} min). Tenki pauses the session at max_duration and the pause cuts a running '
        'command off, so a command that needs the full execution timeout can never finish. Raise '
        'max_duration_minutes or lower exec_timeout_secs.'
    )


# The characters measured to work in a session name (rocketride-tool-tenki-<hex>).
_LABEL = re.compile(r'[a-z0-9][a-z0-9-]{0,31}')


def _label(cfg) -> str:
    """``tenki.label``, stamped on the session's name and metadata to tell several instances' sessions apart."""
    label = str(cfg.get('label') or '').strip()
    if label and not _LABEL.fullmatch(label):
        # The rule before the value: the engine cuts a startup error at its first asterisk.
        raise ValueError(
            'tenki.label must be 1 to 32 lowercase letters, digits or "-", starting with a letter or digit, or be '
            f'left empty; it is {label!r}'
        )
    return label


def _tool_groups(raw) -> tuple[frozenset, list[str]]:
    """The tool groups to publish (all when none is named) and the named ones this node does not have."""
    names = {name.lower() for name in _names(raw, 'toolGroups')}
    unknown = sorted(names - TOOL_GROUPS - {'all', '*'})
    if not names or names & {'all', '*'}:
        return TOOL_GROUPS, unknown
    if not names & TOOL_GROUPS:
        # Not every group: a typo must not publish more than the operator asked for.
        raise ValueError(
            f'tenki.toolGroups matched no known tool group: {", ".join(sorted(names))}. Valid groups: '
            f'{", ".join(sorted(TOOL_GROUPS))}, or "all". Leave the field empty for every group.'
        )
    return frozenset(names & TOOL_GROUPS), unknown


def _size(cfg, key: str, lo: int, hi: int) -> int:
    """A sizing field clamped to the SDK's range, or 0 when unset, which leaves it to Tenki or the image."""
    value = config_int(cfg, key, 0)
    return min(max(value, lo), hi) if value else 0


def _exec_limits(cfg) -> tuple[int, int]:
    """``exec_timeout_secs`` and ``max_duration_minutes``, clamped."""
    return (
        config_int(cfg, 'exec_timeout_secs', 120, min_value=1, max_value=1200),
        config_int(cfg, 'max_duration_minutes', 60, min_value=1, max_value=1440),
    )


class IGlobal(IGlobalBase):
    """Global state for tool_tenki."""

    client: Client | None = None
    session: Sandbox | None = None
    # Guards creating, warming up, recovering and dropping the session: agents send tool calls in parallel.
    _session_lock: threading.Lock | None = None
    # How many resumes the node has done, so a call that failed in the same pause as another sees that the other
    # already resumed the session. Changed under the lock.
    _resumes: int = 0
    # The (session id, resume count) of the pause whose resume budget was spent, so calls queued behind it ask once
    # instead of each waiting out a budget of their own under the lock.
    _given_up: tuple | None = None
    # The session the no-op command has run on since its create or last resume (see _warm_up).
    _warm_id: str | None = None
    # Set as endGlobal starts: no session is created, resumed or used after that.
    _ending: bool = False
    # Unique to this pipeline run and put on each of its sessions, so endGlobal can close any left running.
    _run_tag: str = ''
    _create_attempted: bool = False
    _secrets_refusal_logged: bool = False
    _quota_refusal_logged: bool = False
    # One lock per file path (see path_lock).
    # shortcut: kept for the pipeline's life, about 150 bytes a path; drop unheld ones if pipelines change millions.
    path_locks: dict | None = None

    rpc_timeout_secs: int = 120
    image: str = ''
    label: str = ''
    secret_policies: tuple[str, ...] = ()
    allow_domains: tuple[str, ...] = ()
    git_auth_url: str = ''
    git_auth_secret: str = ''
    # 0 means not sent (see _size).
    cpu_cores: int = 0
    memory_mb: int = 0
    disk_size_gb: int = 0
    max_duration_minutes: int = 60
    pause_retention_hours: int = 24
    exec_timeout_secs: int = 120
    max_output_chars: int = 50000
    tool_groups: frozenset = TOOL_GROUPS

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return
        self._session_lock = threading.Lock()
        self.path_locks = {}
        self._ending = self._create_attempted = False
        self._warm_id = None
        self._run_tag = f'run-{uuid.uuid4().hex[:12]}'

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        apikey = str(cfg.get('apikey') or '').strip()
        # Given an empty key the SDK falls back to TENKI_AUTH_TOKEN / TENKI_API_KEY, letting the engine host's
        # environment decide which workspace is billed.
        if not apikey:
            raise Exception('tool_tenki: apikey is required')
        self.tool_groups, unknown = _tool_groups(cfg.get('toolGroups'))
        if unknown:
            warning(
                f'tool_tenki: ignoring unknown tool group(s): {", ".join(unknown)}. '
                f'Publishing: {", ".join(sorted(self.tool_groups))}'
            )
        self.image = str(cfg.get('image') or '').strip()
        self.label = _label(cfg)
        self.secret_policies, self.allow_domains = _secret_settings(cfg)
        self.git_auth_url, self.git_auth_secret = _git_auth_settings(cfg, self.secret_policies, self.allow_domains)
        self.cpu_cores = _size(cfg, 'cpu_cores', 1, 16)
        memory_mb = _size(cfg, 'memory_mb', 512, 65536)
        self.memory_mb = memory_mb - memory_mb % 2  # Tenki requires an even size; both bounds are even
        self.disk_size_gb = _size(cfg, 'disk_size_gb', 5, 100)
        self.exec_timeout_secs, self.max_duration_minutes = _exec_limits(cfg)
        # Tenki refuses 0 and accepted a minute to a year (measured 2026-10-09); its own default is seven days.
        self.pause_retention_hours = config_int(cfg, 'pause_retention_hours', 24, min_value=1, max_value=8760)
        self.max_output_chars = config_int(cfg, 'max_output_chars', 50000, min_value=1000, max_value=1000000)
        outlives = _outlives_the_session(self.exec_timeout_secs, self.max_duration_minutes)
        if outlives:
            warning(outlives)
        self.rpc_timeout_secs = max(self.exec_timeout_secs, _MIN_RPC_TIMEOUT_SECS)
        base_url = str(cfg.get('base_url') or '').strip() or _DEFAULT_BASE_URL
        self.client = Client(auth_token=apikey, base_url=base_url, timeout=self.rpc_timeout_secs)

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = str(cfg.get('apikey') or '').strip()
            if not apikey:
                warning('apikey is required')
            elif not apikey.startswith('tk_'):
                warning('apikey must be a Tenki workspace API key, which starts with tk_')
            outlives = _outlives_the_session(*_exec_limits(cfg))
            if outlives:
                warning(outlives)
            try:
                unknown = _tool_groups(cfg.get('toolGroups'))[1]
            except ValueError as e:
                warning(f'The pipeline will fail to start: {e}')
            else:
                if unknown:
                    warning(f'unknown tool group(s): {", ".join(unknown)}')
            for check in (lambda: _label(cfg), lambda: _git_auth_settings(cfg, *_secret_settings(cfg))):
                try:
                    check()
                except ValueError as e:
                    warning(f'The pipeline will fail to start: {e}')
        except Exception as e:
            warning(str(e))

    def path_lock(self, path: str) -> threading.Lock:
        """The lock for one normalized path (dict.setdefault is atomic, so concurrent callers get the same one)."""
        return self.path_locks.setdefault(path, threading.Lock())

    def call_with_session(self, fn, events: list, *, replace: bool = True, once=None):
        """``fn(session)``, retried once after a recovery; ``events`` gets created, resumed, replaced or ended."""
        try:
            return self._call(fn, events, replace, once)
        except SandboxError:
            raise  # including the SDK errors that are also a plain RuntimeError or TimeoutError (tenki 1.4.1)
        except (RuntimeError, TimeoutError) as e:
            # A few SDK failures are plain exceptions (Sandbox.start when the data plane is unreachable).
            warning(f'tool_tenki: sandbox call failed with {type(e).__name__}: {e}')
            raise SessionUnavailableError(str(e)) from e

    def _call(self, fn, events: list, replace: bool, once):
        """Each event is what this call saw; once ``once.done``, its stop_on recoveries or a failed one end the call."""
        session = self._get_session(events)
        resumes = self._resumes
        try:
            resumes = self._warm(session)
            return fn(session)
        except Exception as error:
            if not _may_be_paused(error):
                raise
            try:
                event = self._recover(session, resumes, replace)
            except SessionEndedError:
                events.append('ended')
                raise
            except (SandboxError, RuntimeError, TimeoutError) as failure:
                if once is not None and once.done:
                    raise once.error(failure) from failure
                if isinstance(failure, CommandTimeoutError):
                    # The look at the session ran past its deadline: not this call's own timeout.
                    raise SessionUnavailableError(
                        f'the call failed, and recovering the sandbox ran past the deadline: {failure}'
                    ) from failure
                raise
            if once is not None and once.done and (event is None or event in once.stop_on):
                if event is not None:
                    # A dropped session is not replaced for a call that stops here.
                    events.append('ended' if event == 'replaced' else event)
                raise once.error(event or error) from error
            if event is None:
                raise error
            events.append(event)
        if event == 'replaced':
            session = self._get_session([])
        self._warm(session)
        return fn(session)

    def _get_session(self, events: list) -> Sandbox:
        """The shared session, created on first use."""
        with self._session_lock:
            if self._ending:
                raise SessionUnavailableError(_SHUTTING_DOWN)
            if self.session is None:
                session = self._create_session()
                if self._ending:
                    # endGlobal stopped waiting for this create, so nothing else would close the session.
                    self._close(session, 'the session created during shutdown')
                    raise SessionUnavailableError(_SHUTTING_DOWN)
                self.session = session
                debug(f'tool_tenki: created session {session.id}')
                events.append('created')
            return self.session

    def _warm(self, session: Sandbox) -> int:
        """Run the no-op command on ``session`` once per create or resume; return the resume count."""
        with self._session_lock:
            if self._ending:
                raise SessionUnavailableError(_SHUTTING_DOWN)
            if self.session is session and self._warm_id != session.id:
                self._warm_up(session)
                self._warm_id = session.id
                self._given_up = None  # it runs, however it got there, so a later pause gets a budget of its own
            return self._resumes

    @staticmethod
    def _warm_up(session: Sandbox) -> None:
        """Run ``true`` with a bounded start and wait, so the data plane is marked serving."""
        # Before a file call the SDK otherwise checks the data plane with a request of its own that has no deadline
        # (ensure_serving); a command's first answer marks the plane serving without that check.
        process = session.start('true', timeout=_WARM_UP_TIMEOUT_SECS)
        try:
            try:
                process.close_stdin()
            except SandboxError:
                raise
            except TimeoutError as e:
                process.kill()
                raise CommandNotStartedError(
                    "the sandbox did not start the node's first command in time, so it was cancelled"
                ) from e
            try:
                process.wait(timeout=_WARM_UP_WAIT_SECS)
            except SandboxError:
                raise
            except TimeoutError as e:
                raise SandboxError("the sandbox did not finish the node's first command in time") from e
        finally:
            stop_keeping_output(process)

    def _recover(self, session: Sandbox, resumes: int, replace: bool) -> str | None:
        """Resume or drop a failed call's session by its real state: 'resumed', 'replaced', or None (another cause)."""
        with self._session_lock:
            if self.session is not session:
                return self._replaced(replace)  # another call dropped it
            if self._resumes != resumes:
                return 'resumed'  # another call resumed it while this one failed
            state = self._state(session)
            if state in ('RUNNING', 'RESUMING') and self._given_up == (session.id, resumes):
                return self._wait_resumed(session, replace)  # the ask given up on was carried out after all
            if state == 'PAUSED':
                # A pause keeps memory and /home/tenki, so a paused session is resumed, never replaced.
                spent = self._given_up == (session.id, resumes)
                state = self._resume(session, 0 if spent else _RESUME_RETRY_SECS)
                if state == 'RUNNING':
                    return self._wait_resumed(session, replace)
            if state is None or state in _GONE_STATES:
                return self._drop(session, state, replace)
            return None

    def _resume(self, session: Sandbox, budget: float) -> str | None:
        """Ask Tenki to resume ``session`` until it takes; return 'RUNNING', or the gone state (None: unknown)."""
        self._warm_id = None  # a resume replaces the SDK's data-plane connection
        deadline = time.monotonic() + budget
        while True:
            if self._ending:
                raise SessionUnavailableError(_SHUTTING_DOWN)
            try:
                session.resume()
                return 'RUNNING'
            except SandboxError as e:
                refusal = e
            # A refusal does not say whether it is temporary, so the state decides.
            try:
                state = self._state(session)
            except SandboxError:
                raise refusal
            if state == 'RUNNING' or state is None or state in _GONE_STATES:
                return state
            if state not in ('PAUSED', 'RESUMING') or time.monotonic() + _RESUME_RETRY_PAUSE_SECS >= deadline:
                self._given_up = (session.id, self._resumes)
                warning(
                    f'tool_tenki: resume of {session.id} refused ({type(refusal).__name__}: {refusal}) and the '
                    f'session is {state}, so it is not asked again'
                )
                raise refusal
            debug(f'tool_tenki: resume of {session.id} refused ({refusal}); it is still {state}, asking again')
            time.sleep(_RESUME_RETRY_PAUSE_SECS)

    def _wait_resumed(self, session: Sandbox, replace: bool) -> str:
        """Wait until a resumed session runs, and return 'resumed'."""
        self._resumes += 1
        try:
            session.wait_ready(timeout=_READY_WAIT_SECS)
        except SandboxError:
            raise
        except (RuntimeError, TimeoutError) as e:
            # The SDK's plain errors for "went terminal while waiting" and "never got to RUNNING".
            if session.state in _GONE_STATES:
                return self._drop(session, session.state, replace)
            raise SessionUnavailableError(f'session {session.id} did not finish resuming: {e}') from e
        if self._ending:
            raise SessionUnavailableError(_SHUTTING_DOWN)
        debug(f'tool_tenki: resumed paused session {session.id}')
        return 'resumed'

    @staticmethod
    def _state(session: Sandbox) -> str | None:
        """The session's state now, or None if Tenki no longer knows it."""
        try:
            return session.refresh().state
        except SessionNotFoundError:
            return None

    def _drop(self, session: Sandbox, state: str | None, replace: bool) -> str:
        """Forget an ended session so the next call creates a fresh one."""
        # Closed even when reported not found: that report can be wrong, and a running VM would bill on.
        try:
            session.close_if_open()
        except Exception as e:
            debug(f'tool_tenki: could not close dropped session {session.id}: {e}')
        self.session = None
        warning(f'tool_tenki: session {session.id} is {state or "gone"}; the next call starts a new, empty session')
        return self._replaced(replace)

    @staticmethod
    def _replaced(replace: bool) -> str:
        if not replace:
            raise SessionEndedError()
        return 'replaced'

    @staticmethod
    def _close(session: Sandbox, what: str) -> None:
        try:
            session.close()
        except Exception as e:
            warning(f'tool_tenki: could not close {what}: {e}')

    def _create_session(self) -> Sandbox:
        sizing = {'cpu_cores': self.cpu_cores, 'memory_mb': self.memory_mb, 'disk_size_gb': self.disk_size_gb}
        create_kwargs = {
            # Only what was set: with an image Tenki keeps the image's disk unless one is sent (tenki 1.4.1).
            **{key: value for key, value in sizing.items() if value},
            # Tenki has no idle timeout, so this is what stops a session nothing closes (an engine crash): Tenki
            # pauses it then. sticky stays False: a sticky session discards max_duration.
            'max_duration': self.max_duration_minutes * 60,
            'pause_retention': self.pause_retention_hours * 3600,
            'allow_inbound': False,
            # Explicit: with outbound off Tenki ignores allow_domains, so a changed SDK default would change both.
            'allow_outbound': True,
            'name': f'rocketride-tool-tenki-{self.label + "-" if self.label else ""}{uuid.uuid4().hex[:8]}',
            'tags': ['rocketride', self._run_tag],
            'metadata': {
                'created_by': 'rocketride',
                'node': 'tool_tenki',
                **({'label': self.label} if self.label else {}),
            },
        }
        if self.image:
            create_kwargs['image'] = self.image
        # Policy names only: never secret_files or secret_overrides, which would put the value inside the VM.
        if self.secret_policies:
            create_kwargs['secret_policies'] = list(self.secret_policies)
        if self.allow_domains:
            create_kwargs['allow_domains'] = list(self.allow_domains)
        self._create_attempted = True
        try:
            session = self.client.create(**create_kwargs)
        except PermissionDeniedError as e:
            # Measured (tenki 1.4.0): "API key requires Secrets access; ..." for a key created without it.
            if not self.secret_policies or 'Secrets access' not in str(e):
                raise
            if not self._secrets_refusal_logged:
                self._secrets_refusal_logged = True
                warning(
                    'tool_tenki: Tenki refused to attach tenki.secret_policies: the API key needs Secrets access, '
                    f'which is chosen when the key is created ({e})'
                )
            raise SessionUnavailableError(
                f'Tenki refused to attach the secret policies named in tenki.secret_policies: {e}. The Tenki '
                'API key this pipeline uses needs Secrets access, which only its operator can grant; '
                'repeating the call will not help.'
            ) from e
        except QuotaExceededError as e:
            # Measured 2026-10-11: "max concurrent jobs reached (limit: 5)", a limit of the whole workspace.
            if not self._quota_refusal_logged:
                self._quota_refusal_logged = True
                warning(
                    f"tool_tenki: Tenki refused to create a sandbox session at the workspace's limit ({e}). Every "
                    'running session in the workspace counts against it, whichever pipeline started it.'
                )
            raise SessionUnavailableError(
                f'Tenki refused to create a sandbox session: {e}. That is a limit of the Tenki workspace this '
                'pipeline uses, not of this call: a call works again once another session in the workspace has '
                'ended, and the operator can raise the limit with Tenki.'
            ) from e
        except (WaitReadyFailedError, TemplateRuntimeFailedError) as e:
            self._close_left_running(e)
            raise
        except SandboxError:
            raise
        except (RuntimeError, TimeoutError) as e:
            # The readiness wait's plain error for a new sandbox that went straight to a terminal state.
            raise SessionUnavailableError(f'the new sandbox session did not start: {e}') from e
        try:
            bound_file_calls(session, self.rpc_timeout_secs)
        except AttributeError as e:
            # An SDK whose file API changed shape: its file calls could hang for good, so the session is not used.
            message = (
                'tool_tenki cannot put a deadline on file calls with this version of the Tenki SDK, '
                'so the new sandbox session was closed without being used'
            )
            warning(f'tool_tenki: {message} ({e})')
            self._close(session, 'that session')
            raise SessionUnavailableError(message) from e
        return session

    def _close_left_running(self, error: Exception) -> None:
        """Close the sandbox a failed create left running, so it stops billing."""
        # WaitReadyFailedError carries the live handle; TemplateRuntimeFailedError only the info record, or nothing.
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

    def _close_tagged_sessions(self) -> None:
        """Close any session of this run's tag still running: a failed drop or create the node holds no handle for."""
        if not self._run_tag or not self._create_attempted:
            return  # nothing can carry the tag, and an unused node shuts down without the network
        try:
            leftover = self.client.list(tags=[self._run_tag])
        except Exception as e:
            warning(f"tool_tenki: could not list this run's sessions to clean up: {e}")
            return
        for sandbox in leftover:
            if getattr(sandbox, 'state', '') in _GONE_STATES:
                continue  # almost always the session closed just before, still listed while it terminates
            try:
                sandbox.close_if_open()
                warning(f'tool_tenki: closed session {getattr(sandbox, "id", "?")}, which shutdown had left running')
            except Exception as e:
                warning(f'tool_tenki: could not close leftover session {getattr(sandbox, "id", "?")}: {e}')

    def endGlobal(self) -> None:
        # First, so that no call creates, resumes or uses a session after the close below.
        self._ending = True
        # An unclosed session bills until max_duration. A call holding the lock (a create, say) gets a short while to
        # finish; a resume is not waited out. The client stays open then: closing its channel would cancel a create in
        # flight, and a create that finishes later closes its own session through it.
        lock = self._session_lock
        locked = lock is not None and lock.acquire(timeout=_END_LOCK_WAIT_SECS)
        try:
            session, self.session = self.session, None
            if session is not None:
                self._close(session, 'the session')
        finally:
            if locked:
                lock.release()
        if self.client is not None:
            self._close_tagged_sessions()
            if locked or lock is None:
                try:
                    self.client.close()
                except Exception as e:
                    warning(f'tool_tenki: client close failed: {e}')
                finally:
                    self.client = None
