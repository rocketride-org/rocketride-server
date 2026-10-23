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
pipeline may never invoke the tool) and is closed in ``endGlobal`` when the
engine runs node teardown at all (see the note below). Tool logic
lives on IInstance via @tool_function, and every tool reaches the session
through ``call_with_session``, which owns recovery.

Three things differ from tool_daytona and shape this file:

* Tenki has no ephemeral flag and no idle timeout: the SDK's idle-timeout
  option never paused anything (Tenki's changelog of 2026-09-18 removed it as
  having "never had any effect"), so an unused session bills compute until
  it is closed or ``max_duration`` runs out. Tenki then pauses it and keeps
  its state (changelog of 2026-09-11) rather than ending it. ``endGlobal``
  closes a session promptly, but teardown is not reached after an engine
  crash, and engines before the fix in #2396 skipped it for chat- and
  webhook-sourced tasks (measured on engine 3.3.0, #2300). ``max_duration``
  is the backstop for both, which is why the README asks operators to size it.
* A create whose readiness wait fails can leave a live, billing sandbox that
  nothing references, so the create path closes it explicitly.
* Recovery follows the session's actual state, not the exception alone: a
  paused session is resumed (its memory and files survive), a terminated one
  is replaced, and anything else is surfaced.

Tenancy: the session belongs to the pipeline, not to a user. Every caller of a
running pipeline (every conversation of a team-deployed one, for example)
shares it, with its files and installed packages. Nothing secret is placed in
the VM: its user has passwordless sudo, so no command run there could be kept
from reading it.
"""

from __future__ import annotations

import re
import threading
import time
import urllib.parse
import uuid
from contextlib import nullcontext

from ai.common.config import Config
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

from .file_deadline import bound_file_calls
from .output_sink import stop_keeping_output
from .tool_groups import DEFAULT_GROUPS, normalize_groups, unknown_groups

# The deadline for every control-plane call (create, refresh, resume, close, and git operations) and
# for every file call. Git clones share it, so it never drops below the execution timeout, and the
# floor keeps a small execution timeout from starving session creation.
_MIN_RPC_TIMEOUT_SECS = 60

# How long recovery waits for a resumed session to run again: the SDK's own readiness budget.
_READY_WAIT_SECS = 180

# How long recovery keeps asking for a resume Tenki refuses while the session still waits to be resumed,
# and the pause between asks. Measured on 2026-10-05 ("paused source is still being torn down"), from the
# first ask until the resumed session had run a command: at most 17.7, 32.8 and 48.2 s, so the refusals
# themselves lasted less. On 2026-10-09 refusals ("snapshot not yet durable on a reachable host") lasted at
# least 32.6 s; their end was not seen. 120 is more than twice the longest complete window, and on its own
# under the 300 s that agent_rocketride allows one tool call by default on develop; the whole first call
# after a pause can still run past that when a long refusal meets a slow readiness wait. Within one call no
# ask starts that would begin after the budget; a call that queued behind it and arrives soon after the
# budget is spent asks once more (see _resume). So a call waits about one ask and one look at the state
# longer than the budget, and a call queued behind it about one of each more.
_RESUME_RETRY_SECS = 120
_RESUME_RETRY_PAUSE_SECS = 5

# The no-op command run on a session before its first use after a create or a resume (see _warm_up): its own
# execution timeout, and how long the node waits for its result after the start.
_WARM_UP_TIMEOUT_SECS = 10
_WARM_UP_WAIT_SECS = 40

# Given an empty endpoint the SDK resolves one from TENKI_API_ENDPOINT / TENKI_API_URL,
# so the public default is passed explicitly rather than left to the host's environment.
_DEFAULT_BASE_URL = 'https://api.tenki.cloud'

# States in which a session is treated as unable to serve another call. USER_SHUTDOWN is
# not in Tenki's documented lifecycle, but it is in the protocol, and a session that has
# shut down is handled like a terminated one.
_GONE_STATES = frozenset({'TERMINATING', 'TERMINATED', 'USER_SHUTDOWN'})
# A refused resume is a wait, not a failure, while the session still reads one of these: the refusal is
# temporary by the session's state, whatever the error's class or text.
_STILL_RESUMABLE_STATES = frozenset({'PAUSED', 'RESUMING'})
# What _state_after_refusal returns when Tenki no longer knows the session (None means unreadable).
_NOT_FOUND = 'NOT_FOUND'

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


class SessionUnavailableError(SandboxError):
    """No usable session could be had: it could not be created or resumed, or could not be reached.

    The SDK reports some of these as a plain RuntimeError or TimeoutError rather than as one of its
    own errors. This is a SandboxError, so each tool's error handling returns it to the agent as an
    error result, as it does every other sandbox failure, instead of letting it out of the tool.
    """


class ResumeNotConfirmedError(SessionUnavailableError):
    """A resumed session did not run the node's no-op command, so the call failed and no one was told "resumed".

    The resume is left for the first later call whose no-op command runs (see ``_confirm_resume``).
    """


class CommandNotStartedError(CommandTimeoutError):
    """The sandbox never confirmed that a command had started, so the command was cancelled.

    That is what a command sent to a paused session looks like when no error names the pause, so it
    is one of the failures that prompt a look at the session's state. The node treats the command as
    not run and, if the session turns out to have been paused, runs it after the resume.
    """


# How Tenki's host words a failure to reach a VM's socket, in both forms measured. Matched as a phrase
# rather than as the bare word "vsock", which a file or folder the agent named could contain: the
# SDK builds stat's own "no such file" message from the path it was asked for.
_VM_LINK_DOWN = re.compile(r'failed to (?:connect to|read) vsock')


def about_the_vm_link(error: Exception) -> bool:
    """Whether a "no such file" error is about Tenki's own socket to the VM, not a path inside it.

    The SDK classes any error whose text contains "no such file or directory" as a missing file.
    Measured on a session Tenki had paused, a read failed with "failed to read vsock CONNECT
    response ... failed to connect to vsock at ... rootfs.img.vsock: connect: no such file or
    directory": the missing thing is the paused VM's socket on Tenki's host. Passing that on as
    "no such file: <the agent's path>" would tell the agent a file was gone when it was not.
    """
    return isinstance(error, TenkiFileNotFoundError) and _VM_LINK_DOWN.search(str(error)) is not None


def _may_hide_a_pause(error: SandboxError) -> bool:
    """Whether a failed call says too little about the session to be reported without a look at it.

    Tenki does not always name a pause. Measured on real sessions it had paused: a file read came
    back as an infrastructure error the SDK has no class for ("dial guest-agent stream ... failed to
    connect to vsock"), or as one the SDK mistakes for a missing file (see ``about_the_vm_link``),
    and a command simply never started. Any other error the SDK did classify, such as a file that
    really is missing, is an answer in its own right and costs no extra call.
    """
    return type(error) is SandboxError or isinstance(error, CommandNotStartedError) or about_the_vm_link(error)


# What Tenki's create accepts in an outbound allowlist (measured 2026-10-09 against its documented rule,
# "hostnames ... without a URL scheme, path, or port", with one leading wildcard): RFC 1123 hostname labels
# of 1 to 63 letters, digits and inner hyphens, any number of them, optionally after a single leading
# "*.". So "localhost" and "10.0.0.1" are accepted and "under_score.example.com" is not, as by Tenki.
_DOMAIN = re.compile(r'^(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$')


#: The most domains Tenki documents that it accepts in one allowlist, and the longest name DNS allows.
_MAX_DOMAINS = 256
_MAX_DOMAIN_CHARS = 253


def _names(raw, field: str) -> list[str]:
    """The distinct, non-empty entries of a list setting, given as a list or a comma-separated string.

    Anything else is refused rather than read as "nothing configured" or turned into text: an
    allowlist typed in the wrong shape would otherwise start the sandbox with every destination
    open, and an entry such as ``None`` would reach Tenki as a name nobody typed.

    Raises:
        ValueError: If the setting is not a list or a string, or holds an entry that is not text.
    """
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


def _allowed_domains(raw) -> list[str]:
    """The configured outbound allowlist, normalized as Tenki does: lowercase, without a trailing dot.

    The rule is Tenki's (see ``_DOMAIN``), checked here so that a mistake stops the pipeline at startup
    rather than failing every create later. An entry outside it stops the pipeline instead of being
    dropped: had every entry been dropped, the empty list left would mean no allowlist at all, opening
    outbound traffic wider than the operator asked for.

    The message says which entries by position and how to fix them before it quotes any entry: the
    engine passes a startup failure to the client as ``>EXIT*code*message`` and keeps the message only
    up to its first asterisk, which a wildcard entry would put early (measured on 3.3.0 and develop).

    Raises:
        ValueError: Naming every entry Tenki refuses, or for more entries than Tenki takes.
    """
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
        which = (
            f'entry {positions[0]}'
            if len(positions) == 1
            else f'entries {", ".join(positions[:-1])} and {positions[-1]}'
        )
        raise ValueError(
            f'tenki.allow_domains has {"an entry" if len(positions) == 1 else "entries"} Tenki refuses ({which}). Use '
            'bare hostnames such as pypi.org, optionally starting with one wildcard label (an asterisk and a dot), '
            f'with no scheme, path or port. Refused: {", ".join(refused)}'
        )
    if len(domains) > _MAX_DOMAINS:
        raise ValueError(f'tenki.allow_domains lists {len(domains)} hosts, and Tenki accepts up to {_MAX_DOMAINS}')
    return domains


def _secret_settings(cfg) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """The secret policies to attach and the outbound allowlist, which are only valid together.

    A policy decides which requests Tenki puts a credential into. It does not decide where the
    sandbox may send what those requests return, so policies without an allowlist would hand an
    agent a usable credential and every destination to carry the results to. That combination
    stops the pipeline rather than starting it open.

    Raises:
        ValueError: For a setting the node does not accept, or for policies without an allowlist.
    """
    policies = tuple(_names(cfg.get('secret_policies'), 'secret_policies'))
    domains = tuple(_allowed_domains(cfg.get('allow_domains')))
    if policies and not domains:
        raise ValueError(
            'tenki.secret_policies is set but tenki.allow_domains is empty. With no allowlist a sandbox can '
            'reach any host on any port, and one that can use a secret must not: list the hosts it needs in '
            'tenki.allow_domains (github.com, for example).'
        )
    return policies, domains


#: The name Tenki reads after "secrets://" in a placeholder (tenki 1.4.1): a letter or underscore, then up to 127
#: letters, digits, underscores and hyphens. A name outside it would never be substituted.
_SECRET_NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_-]{0,127}')

#: How credential values begin, as issued by GitHub, GitLab and Slack: prefixes no one gives a secret's name, so a
#: value where the name belongs that begins with one is refused whatever follows. The refusal never repeats the value.
_TOKEN_PREFIXES = (
    'ghp_',
    'gho_',
    'ghu_',
    'ghs_',
    'ghr_',
    'github_pat_',
    'glpat-',
    'xoxb-',
    'xoxp-',
)
#: How credential values begin, as issued by Tenki, Anthropic and OpenAI, and AWS, but names can too (tk_github_basic,
#: sk-shared-github, AKIA_LEGACY_POLICY): a value beginning with one is refused only with an issued token's length and
#: digits (see _looks_like_a_credential).
_SHARED_PREFIXES = ('tk_', 'sk-', 'AKIA')


def _looks_like_a_credential(value: str) -> bool:
    """Whether ``value`` reads as an issued token rather than a name.

    A prefix only tokens carry is enough. For a prefix names share, the value must also be at least 20 characters long
    and carry a digit: issued tokens are long and random, so they do; names such as ``tk_github_basic`` do not.
    """
    if value.startswith(_TOKEN_PREFIXES):
        return True
    return value.startswith(_SHARED_PREFIXES) and len(value) >= 20 and any(c.isdigit() for c in value)


#: The path a private-repository prefix may have: slashes and URL characters that git leaves as they are when it
#: normalizes a URL, so that the node and git read the same prefix.
_PREFIX_PATH = re.compile(r'/[A-Za-z0-9._~/-]*')

_DEFAULT_GIT_AUTH_URL = 'https://github.com/'


def _git_auth_url(raw: str) -> str:
    """The private-repository prefix, normalized as git matches it: lowercase scheme and host, ending in a slash.

    git applies an ``http.<url>.*`` setting to a URL with the same scheme, host and port whose path is under
    <url>'s on a segment boundary, so the slash keeps https://github.com/acme from also covering
    https://github.com/acme-evil. The entry is not quoted in the error: it may carry a credential.

    Raises:
        ValueError: For anything but a plain https URL with a host and an optional path.
    """
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
    """The URL prefix git_clone authenticates under and the Tenki secret it names there, or ('', '') when off.

    git_clone puts ``Authorization: Basic secrets://<secret>`` on clones under the prefix, and Tenki's proxy puts
    the secret's value in its place, outside the VM, when an attached policy allows the request. Without a policy
    Tenki refuses every such request, and without the prefix's host on the allowlist the sandbox cannot reach it,
    so either gap stops the pipeline rather than failing every private clone later.

    Raises:
        ValueError: For a secret name Tenki would not read, a prefix the node does not accept, no secret
            policies, or a prefix whose host the allowlist does not cover.
    """
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
    """The warning for a command allowed to run as long as the session lives, or None.

    Tenki pauses a session at max_duration and the pause cuts a running command off, so such a command
    can never finish. One that starts late in a session's period can be cut off too; this is the case
    that holds every time.
    """
    if exec_timeout_secs < max_duration_minutes * 60:
        return None
    return (
        f'tool_tenki: exec_timeout_secs ({exec_timeout_secs}s) is not shorter than max_duration_minutes '
        f'({max_duration_minutes} min). Tenki pauses the session at max_duration and the pause cuts a running '
        'command off, so a command that needs the full execution timeout can never finish. Raise '
        'max_duration_minutes or lower exec_timeout_secs.'
    )


#: What a label may look like: it is put into the session's name and metadata, so it is kept to the characters a
#: session name already uses (measured: Tenki accepts rocketride-tool-tenki-<hex>), and short enough to read.
_LABEL = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,31}')


def _label(cfg) -> str:
    """The configured ``tenki.label``, stripped, or '' when none was set.

    Several instances of this node in one pipeline each create their own session, and nothing the engine
    hands a node says which instance it is. The label is the operator's name for the instance; it is stamped
    on the session (name and metadata) so the sessions can be told apart in Tenki's console or by anything
    that lists them. A value that could be refused there would only surface on the first tool call, as a
    failed create, so it is refused here, where the config is read.

    Raises:
        ValueError: For a label that is not 1 to 32 characters of letters, digits, ``_`` and ``-``, starting
            with a letter or digit.
    """
    label = str(cfg.get('label') or '').strip()
    if label and not _LABEL.fullmatch(label):
        raise ValueError(
            f'tenki.label {label!r} is not a label Tenki can carry: use 1 to 32 letters, digits, "_" or "-", '
            'starting with a letter or digit, or leave the field empty.'
        )
    return label


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
    # Serialises edit_file's read-modify-write per session: a wave agent may send two edits of one file in the same wave, and
    # without this the later write dropped the earlier edit while both calls reported success (measured 2026-10-12).
    _edit_lock: threading.Lock | None = None
    # How the most recent recovery went, 'resumed' or 'replaced'. A call that retries after a
    # concurrent call did the recovering reports this, since it did not see the recovery itself.
    last_recovery: str = ''
    # The epoch at which a session was last dropped. A call that captured an earlier epoch had its
    # own session replaced, so its files are gone no matter what a later recovery wrote to
    # last_recovery; comparing epochs keeps 'resumed' from reassuring it about a session it never ran on.
    last_replacement_epoch: int = -1
    # Set as endGlobal starts. No session may be created after that: nothing would close it.
    _ending: bool = False
    # A tag unique to this pipeline run, set in beginGlobal. Every session created here carries it,
    # so endGlobal can find and close any this run left running, without touching another run's.
    _run_tag: str = ''
    # Set once this run asks Tenki for a session, whether or not the create succeeds: only then can a
    # session carrying the run's tag exist for endGlobal to look for.
    _create_attempted: bool = False
    # When, on time.monotonic(), asking again for a refused resume stops. Read and written under the
    # session lock. It is one budget for every call waiting on the same resume, not one each: see _resume.
    _resume_retry_until: float | None = None
    # The id of the session the node has run its no-op command on since that session was created or last
    # resumed (see _warm_up). Read without the lock as a fast path; written under it.
    _warm: str | None = None
    # A session whose resume Tenki accepted but which did not come up within the wait, so the call that
    # asked could not say "resumed". The next call to find the session running says it instead (see
    # call_with_session). Under the lock.
    _resume_unreported: Sandbox | None = None
    # Set once the job log has said that the key lacks Secrets access, so later refused calls do not repeat it.
    _secrets_refusal_logged: bool = False
    # Set once the job log has said that Tenki refused a create at the workspace's limit, so later refusals do not
    # repeat it.
    _quota_refusal_logged: bool = False

    rpc_timeout_secs: int = 120
    image: str = ''
    # The operator's name for this instance, stamped on its sessions (see _label). Empty when none was set.
    label: str = ''
    # Tenki request policies to attach, by name. As Tenki documents it, it holds the secret values and
    # substitutes them outside the VM, into requests a policy allows; the node sends nothing but the names.
    secret_policies: tuple[str, ...] = ()
    # Hostnames the sandbox may reach. Empty means no allowlist: outbound traffic is unrestricted.
    allow_domains: tuple[str, ...] = ()
    # Private repositories git_clone authenticates to: the URL prefix they are under, and the name of the Tenki
    # secret holding the HTTP Basic credential for them. Both empty when the operator set no secret.
    git_auth_url: str = ''
    git_auth_secret: str = ''
    cpu_cores: int = 2
    memory_mb: int = 4096
    disk_size_gb: int = 5
    max_duration_minutes: int = 60
    pause_retention_hours: int = 24
    exec_timeout_secs: int = 120
    max_output_chars: int = 50000
    tool_groups: frozenset = DEFAULT_GROUPS

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        self._session_lock = threading.Lock()
        self._edit_lock = threading.Lock()
        self._ending = False
        self._create_attempted = False
        self._resume_retry_until = None
        self._warm = None
        self._run_tag = f'run-{uuid.uuid4().hex[:12]}'

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
        self.label = _label(cfg)
        self.secret_policies, self.allow_domains = _secret_settings(cfg)
        self.git_auth_url, self.git_auth_secret = _git_auth_settings(cfg, self.secret_policies, self.allow_domains)
        self.cpu_cores = _int_or(cfg.get('cpu_cores'), 2, lo=1, hi=16)
        # Tenki rejects odd memory sizes (they must align to 2 MiB). Rounding down stays in
        # range because both bounds are even.
        memory_mb = _int_or(cfg.get('memory_mb'), 4096, lo=512, hi=65536)
        self.memory_mb = memory_mb - memory_mb % 2
        # The SDK refuses a disk under 5 GB before sending the request.
        self.disk_size_gb = _int_or(cfg.get('disk_size_gb'), 5, lo=5, hi=100)
        # Pipelines saved before the idle-timeout field was retired may still carry it; it is not
        # read, so it never reaches Tenki, which ignored it anyway.
        self.max_duration_minutes = _int_or(cfg.get('max_duration_minutes'), 60, lo=1, hi=1440)
        # How long Tenki keeps a paused session's state. Tenki refuses 0 and accepted every value tried from a
        # minute to a year (measured 2026-10-09); its own default is seven days.
        self.pause_retention_hours = _int_or(cfg.get('pause_retention_hours'), 24, lo=1, hi=8760)
        self.exec_timeout_secs = _int_or(cfg.get('exec_timeout_secs'), 120, lo=1, hi=1200)
        self.max_output_chars = _int_or(cfg.get('max_output_chars'), 50000, lo=1000, hi=1000000)

        outlives = _outlives_the_session(self.exec_timeout_secs, self.max_duration_minutes)
        if outlives:
            warning(outlives)
        self.rpc_timeout_secs = max(self.exec_timeout_secs, _MIN_RPC_TIMEOUT_SECS)
        # Without a deadline, a half-open connection would hang create, refresh, resume and close,
        # all of which run under the session lock, and endGlobal behind them while the VM bills.
        # The client applies it to those calls only; each session's file calls get it in _create_session.
        self.client = Client(auth_token=apikey, base_url=base_url, timeout=self.rpc_timeout_secs)

    def get_session(self, on_event=None) -> Sandbox:
        """Return the shared session, creating it on first use.

        ``on_event``, if given, is called with 'created' when this call is the one that created it.
        """
        session = self.session
        if session is None:
            with self._session_lock:
                if self._ending:
                    raise SessionUnavailableError(
                        'tool_tenki: the pipeline is shutting down, so no new sandbox session is created'
                    )
                if self.session is None:
                    self.session = self._create_session()
                    debug(f'tool_tenki: created session {getattr(self.session, "id", "?")}')
                    if on_event is not None:
                        on_event('created')
                session = self.session
        return session

    def _ensure_warm(self, session: Sandbox) -> None:
        """Run the no-op command on ``session`` if it has not run since the session was created or resumed."""
        if self._warm == session.id:
            return
        with self._session_lock:
            if self._warm == session.id:
                return
            if self._ending:
                raise SessionUnavailableError(
                    'tool_tenki: the pipeline is shutting down, so the sandbox session is not used'
                )
            self._warm_up(session)
            self._warm = session.id

    def _warm_up(self, session: Sandbox) -> None:
        """Run one bounded no-op command, so the SDK's unbounded check of the data plane never runs.

        Before a file call the SDK checks a session's data plane with a request of its own that has no
        deadline (``ensure_serving``), unless the plane is already marked as serving. Tenki usually marks
        it at create and on the credential renewal after a resume (measured), but not always, and a
        command's first answer marks it in every case, without that check. So the node runs ``true``
        first, with a start the SDK bounds at 30 seconds and a result it waits for at most
        ``_WARM_UP_WAIT_SECS``. Called with the session lock held.
        """
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
            # Nothing reads this command's output after this; a late start or a stalled run must not grow the engine.
            stop_keeping_output(process)

    def _create_session(self) -> Sandbox:
        create_kwargs = {
            'cpu_cores': self.cpu_cores,
            'memory_mb': self.memory_mb,
            'disk_size_gb': self.disk_size_gb,
            # Tenki has no ephemeral flag and no idle timeout, so this is the one thing that
            # stops the compute of a session whose pipeline never reached endGlobal (a crashed
            # engine, or one that skips teardown): Tenki pauses it when this runs out. The SDK
            # takes seconds. sticky stays at its default of False: a sticky session discards
            # max_duration.
            'max_duration': self.max_duration_minutes * 60,
            # Without it, a paused session left behind (an engine crash) holds its code and files for
            # Tenki's default of seven days. The SDK takes seconds.
            'pause_retention': self.pause_retention_hours * 3600,
            # Inbound exposure can only be set at create time, and no tool this node
            # publishes uses it, so sessions are created closed to inbound traffic.
            'allow_inbound': False,
            # Outbound stays on, said here rather than left to the SDK's default: with it off, Tenki
            # ignores allow_domains and the sandbox reaches nothing, so a changed default would quietly
            # change both. Where it may go is decided by allow_domains below.
            'allow_outbound': True,
            # So that a session a crashed engine left behind can be recognised in Tenki's console
            # and listed by tag. The suffix keeps names distinct in case the service requires it.
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
        # Sent only when set, so an unconfigured node makes exactly the request it always has. Policy
        # names are all that is sent about secrets: never a value, and never secret_files or
        # secret_overrides, which would put the real value inside the VM.
        if self.secret_policies:
            create_kwargs['secret_policies'] = list(self.secret_policies)
        if self.allow_domains:
            create_kwargs['allow_domains'] = list(self.allow_domains)
        self._create_attempted = True
        try:
            session = self.client.create(**create_kwargs)
        except PermissionDeniedError as e:
            if not self.secret_policies or 'Secrets access' not in str(e):
                raise
            # What Tenki answers when the API key was created without Secrets access (measured with
            # tenki 1.4.0: "API key requires Secrets access; ..."). No sandbox is left behind, and
            # nothing an agent does can change the key, so the operator is told in the log as well as
            # the agent in its result. Any other refusal is reported as it is.
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
            # Measured on 2026-10-11: past the workspace's limit on sessions running at once, Tenki refuses the create
            # with "max concurrent jobs reached (limit: 5)" and leaves nothing running. That limit belongs to the
            # workspace, so the operator is told in the log, and the agent learns whose limit it is and when a call
            # can work again; the next call asks for a session again.
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
            # Before the plain catch below: since tenki 1.4.1 two SDK errors are also a RuntimeError or a
            # TimeoutError, and an SDK error is reported as itself.
            raise
        except (RuntimeError, TimeoutError) as e:
            # The SDK re-raises its readiness wait's own plain RuntimeError when the new sandbox went
            # straight to a terminal state. There is nothing left running to close.
            raise SessionUnavailableError(f'the new sandbox session did not start: {e}') from e
        try:
            # The client's deadline does not reach a session's file calls (see file_deadline).
            bound_file_calls(session, self.rpc_timeout_secs)
        except AttributeError as e:
            # Only an SDK whose file API changed shape gets here. Its file calls could hang for good,
            # so the session is closed rather than used, and not left billing.
            message = (
                'tool_tenki cannot put a deadline on file calls with this version of the Tenki SDK, '
                'so the new sandbox session was closed without being used'
            )
            warning(f'tool_tenki: {message} ({e})')
            try:
                session.close()
            except Exception as close_error:
                warning(f'tool_tenki: could not close that session: {close_error}')
            raise SessionUnavailableError(message) from e
        return session

    def _close_left_running(self, error: Exception) -> None:
        """Close the sandbox a failed create left running, so it stops billing.

        Tenki admits the sandbox before the readiness wait, so this failure can leave a
        live session that nothing references, and scope-based cleanup cannot catch it
        because create never returned. ``WaitReadyFailedError`` carries the live handle.
        ``TemplateRuntimeFailedError`` raised by the create call itself carries only the
        session's info record (or nothing), so the handle is fetched by id first. A close
        that fails is only logged: the create error is what the caller needs, and
        max_duration still stops the session's compute.
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

    def call_with_session(self, call, *, replace: bool = True, on_event=None):
        """Return ``call(session)``, recovering the session once if it stopped being usable.

        A lifecycle error only prompts a look at the session's state (see
        ``recover_session``), and so does a failure that says too little to rule a pause out (see
        ``_may_hide_a_pause``). The call is retried once, on the recovered session, when that state
        explains the failure; every other error propagates unchanged. Whether a retry may repeat the
        call is the tool's to decide: ``on_event`` may raise to stop it.

        ``replace=False`` is for calls that only look at existing state (reading, listing or
        deleting files). If the session turns out to have ended, a fresh, empty one could not
        serve them, so ``SessionEndedError`` is raised instead of creating a session for nothing.

        ``on_event``, if given, is told how the session changed during the call, so the tool can say so in
        its result: 'created' (this call started the session), 'resumed' or 'replaced' (before the retry),
        or 'ended' (just before ``SessionEndedError``).
        """
        epoch = self.session_epoch
        try:
            session = self.get_session(on_event)
            try:
                self._ensure_warm(session)
                # Read again now that this call holds a warm session: the warm-up may have waited on the session
                # lock behind another call's recovery, and a failure of this call's own after that must not be
                # taken for that recovery (which would retry the call, or tell the agent its files were gone).
                # Only while the session is still the one this call holds: once another call has dropped it, the
                # earlier epoch is what tells recover_session that this session ended under the call.
                current = self.session_epoch
                if self.session is session:
                    epoch = current
                self._report_late_resume(session, on_event)
                return call(session)
            except _LIFECYCLE_ERRORS:
                recovery = self._recover(session, epoch, replace, on_event)
                if not recovery:
                    raise
            except SandboxError as e:
                if not _may_hide_a_pause(e):
                    raise
                recovery = self._recover(session, epoch, replace, on_event)
                if not recovery:
                    raise
            if recovery == 'resumed':
                # "resumed" is told only once a command has run on the resumed session.
                self._confirm_resume(session)
                # This result says it (or the tool stops here and its error does); a resume left unreported
                # must not be said again by the next call. Claimed after the no-op command, so that a notice
                # another call left meanwhile is claimed too, and before on_event, which may raise.
                self._report_late_resume(session, None)
            if on_event is not None:
                on_event(recovery)
            session = self.get_session()
            self._ensure_warm(session)
            return call(session)
        except SandboxError:
            # An SDK error is reported as itself, including the two that are also a plain RuntimeError or
            # TimeoutError since tenki 1.4.1. Only a plain one is wrapped below.
            raise
        except (RuntimeError, TimeoutError) as e:
            # The SDK raises a few failures as plain exceptions rather than its own errors (Sandbox.start
            # does when the data plane cannot be reached), which a tool's SandboxError handling would let
            # out of the tool. Logged as well: these are rare, and worth an operator's attention.
            warning(f'tool_tenki: sandbox call failed with {type(e).__name__}: {e}')
            raise SessionUnavailableError(str(e)) from e

    def _confirm_resume(self, session: Sandbox) -> None:
        """Run the no-op command on a session this call saw resumed, before the call is told "resumed".

        A session reads RUNNING after a resume (or after a refused one, see ``_resume``) before it is known to run
        commands. If the no-op command fails, the call fails with ``ResumeNotConfirmedError`` and the resume is
        left for the first later call whose no-op command runs, as for a resume that came up late. Run before
        the tool hears of the resume, so a tool that stops its retry there (a started command, a sent change)
        reports the resume only once the session has run a command.
        """
        try:
            self._ensure_warm(session)
        except (SandboxError, RuntimeError, TimeoutError) as e:
            if self._ending:
                raise
            with self._session_lock:
                # Not when another call's no-op command has run on it meanwhile: that call says "resumed".
                if self.session is session and self._warm != session.id:
                    self._resume_unreported = session
            raise ResumeNotConfirmedError(
                f'the sandbox did not answer after the pause: {e}. The next call that reaches it says whether it resumed'
            ) from e

    def _report_late_resume(self, session: Sandbox, on_event) -> None:
        """Say "resumed" for a resume an earlier call asked for but could not see come up (see recover_session).

        Told to one call, normally the first whose no-op command has run, so the session does run, and before the
        call itself does anything, so no tool's retry rule is involved. (A call that passed the no-op check just
        before another call's recovery recorded the resume can be the one to claim it.)
        """
        if self._resume_unreported is not session:
            return
        with self._session_lock:
            claimed = self._resume_unreported is session
            if claimed:
                self._resume_unreported = None
        if claimed and on_event is not None:
            on_event('resumed')

    def _recover(self, session: Sandbox, epoch: int, replace: bool, on_event) -> str | None:
        """``recover_session``, telling ``on_event`` when the session turned out to have ended.

        The look at the session is itself a call with a deadline. Running past it says nothing about the
        call that failed, so it is reported for what it is, not as that call's timeout.
        """
        try:
            return self.recover_session(session, epoch, replace=replace)
        except SessionEndedError:
            if on_event is not None:
                on_event('ended')
            raise
        except CommandTimeoutError as e:
            raise SessionUnavailableError(
                f'the call failed, and recovering the sandbox (resuming it, checking its state or waiting for it to run) '
                f'ran past the deadline: {e}'
            ) from e

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
        * Paused (by Tenki when the session reaches max_duration or the workspace runs out of
          credit, or by hand in Tenki's console or CLI): resume it and wait until it runs.
          Never replace it, since a pause preserves the agent's memory and files.
        * Any other state (running, starting, pausing): the failure had another cause, so
          it is surfaced.

        A resume Tenki accepts changes the session (memory and /home/tenki kept, /tmp cleared) even when
        the session then does not come up within the wait. The call that asked keeps its own error, and
        the session is recorded in ``_resume_unreported`` so that the next call to find it running says
        "resumed". The epoch moves only once the session runs, so calls waiting on this lock look at the
        session again rather than retrying, one after another, on one that may not run yet.
        """
        with self._session_lock:
            if self.session is not session or self.session_epoch != epoch:
                # A concurrent call already dealt with this session. If it dropped it, retrying
                # would create a fresh session, which a caller passing replace=False cannot use,
                # and which the replacement may already have been created for, so the test is the
                # epoch rather than self.session still being None.
                if self.session is None or self.last_replacement_epoch > epoch:
                    if not replace:
                        raise SessionEndedError()
                    return 'replaced'
                return self.last_recovery or None
            try:
                state = session.refresh().state
            except SessionNotFoundError:
                state = None
            if state is None or state in _GONE_STATES:
                return self._drop_session(session, state, replace=replace)
            if state == 'PAUSED':
                gone = self._resume(session)
                if gone is not None:
                    # Refused, and the session turned out to be gone: dropped like any ended session.
                    return self._drop_session(session, None if gone == _NOT_FOUND else gone, replace=replace)
                # A resume drops the SDK's data-plane connection, so the no-op command runs again first.
                self._warm = None
                self._resume_unreported = session
                if self._ending:
                    # The ask was on its way when shutdown began. endGlobal is waiting on this lock
                    # to close the session, so it is not made to wait for the VM to come up first.
                    raise SessionUnavailableError(
                        'tool_tenki: the pipeline is shutting down, so the resumed sandbox session is not waited for'
                    )
                try:
                    session.wait_ready(timeout=_READY_WAIT_SECS)
                except SandboxError:
                    raise
                except (RuntimeError, TimeoutError) as e:
                    # The SDK's plain errors for "went terminal while waiting" and "never got to
                    # RUNNING". A session terminated mid-resume is as gone as any other. One merely
                    # slow to come up keeps its files, so it is not dropped.
                    if session.state in _GONE_STATES:
                        return self._drop_session(session, session.state, replace=replace)
                    raise SessionUnavailableError(f'session {session.id} did not finish resuming: {e}') from e
                # This call retries and says "resumed" itself.
                self._resume_unreported = None
                self.session_epoch += 1
                self.last_recovery = 'resumed'
                debug(f'tool_tenki: resumed paused session {session.id}')
                return 'resumed'
            return None

    def _resume(self, session: Sandbox) -> str | None:
        """Ask Tenki to resume ``session``, again for as long as the session still waits to be resumed.

        For a while after a pause Tenki refuses a resume, and the refusal does not say whether it is
        temporary: measured, "paused source is still being torn down, retry shortly" as the SDK's
        catch-all class, and "snapshot not yet durable on a reachable host" as one of its specific ones. So
        after a refusal the node reads the session's state. Still PAUSED or RESUMING, it asks again.
        RUNNING, the resume took after all (an earlier ask Tenki answered with an error, or another
        client), so it counts as accepted. Gone (terminated, or unknown to Tenki), the wait ends and
        the session is returned for dropping. Any other state, or one that cannot be read, ends the
        wait and the refusal is raised. The error's class and text never decide the outcome. Within one
        call, no ask starts that would begin after ``_RESUME_RETRY_SECS``, so that a call never waits on
        Tenki without bound (a call that arrives soon after a spent budget asks once: see below). A
        refusal that will not go away while the session stays PAUSED (a suspended workspace, say) is
        therefore reported only at the end of that budget. If the session still reads RESUMING then, a
        resume is under way that this call cannot wait out: the next call to find the session running
        is told "resumed" (see ``_resume_unreported``), and the budget ends.

        Returns None when the resume was accepted, or the gone state (``_NOT_FOUND`` for unknown to Tenki).

        Called with the session lock held, as a resume must be: parallel calls wait for this one.
        They share its budget. A call that reaches this point while a spent budget is still recent
        asks once and reports, instead of starting a wait of its own behind the last, which would
        add up to minutes across a wave of calls, with ``endGlobal`` waiting on the same lock. For the
        same reason no new ask starts once the pipeline is shutting down: ``endGlobal`` closes the
        session, and a resume would only start a VM for it to end. An ask already on its way is
        not interrupted.

        The budget belongs to one pause. It ends when the resume takes, when a refusal is followed by
        a state that ends the wait or by RESUMING at the end of the budget, and when the session is
        dropped. One case is left: a spent budget is
        still shared for its own length afterwards, so a session resumed from outside the node and
        paused again within that time gets a single ask.
        """
        now = time.monotonic()
        if self._resume_retry_until is None or now >= self._resume_retry_until + _RESUME_RETRY_SECS:
            self._resume_retry_until = now + _RESUME_RETRY_SECS
        while True:
            if self._ending:
                raise SessionUnavailableError(
                    'tool_tenki: the pipeline is shutting down, so the paused sandbox session is not resumed'
                )
            try:
                session.resume()
            except SandboxError as e:
                refused = f'{type(e).__name__}: {e}'
                state = self._state_after_refusal(session)
                if state == 'RUNNING':
                    debug(f'tool_tenki: resume of {session.id} refused ({refused}), but it is running')
                    self._resume_retry_until = None
                    return None
                if state == _NOT_FOUND or state in _GONE_STATES:
                    # Not a wait. What is left of the budget must not be all that a later pause gets.
                    self._resume_retry_until = None
                    warning(
                        f'tool_tenki: resume of {session.id} refused ({refused}); the session is '
                        f'{"unknown to Tenki" if state == _NOT_FOUND else state}, so it is not asked again and is dropped'
                    )
                    return state
                if state not in _STILL_RESUMABLE_STATES:
                    self._resume_retry_until = None
                    warning(
                        f'tool_tenki: resume of {session.id} refused ({refused}); the session is '
                        f'{state or "unreadable"}, so it is not asked again'
                    )
                    raise
                if time.monotonic() + _RESUME_RETRY_PAUSE_SECS < self._resume_retry_until:
                    debug(f'tool_tenki: resume of {session.id} refused ({refused}); it is still {state}, asking again')
                    time.sleep(_RESUME_RETRY_PAUSE_SECS)
                    continue
                # The next ask would start after the budget, so this refusal is the last.
                if state == 'RESUMING':
                    # A resume under way that this call cannot wait out: a new start for this session, which the
                    # next call to find it running is told about, and which a later pause gets a whole budget for.
                    self._warm = None
                    self._resume_unreported = session
                    self._resume_retry_until = None
                warning(
                    f'tool_tenki: resume of {session.id} refused ({refused}) and still {state} at the end of the '
                    f'{_RESUME_RETRY_SECS} second budget, so it is not asked again'
                )
                raise
            else:
                self._resume_retry_until = None
                return None

    @staticmethod
    def _state_after_refusal(session: Sandbox) -> str | None:
        """The session's state after a refused resume: ``_NOT_FOUND`` if Tenki no longer knows it, None if it cannot be read."""
        try:
            return session.refresh().state
        except SessionNotFoundError:
            return _NOT_FOUND
        except SandboxError:
            return None

    def _drop_session(self, session: Sandbox, state: str | None, *, replace: bool) -> str:
        """Forget a session that has ended, so the next ``get_session`` creates a fresh one.

        Called with the session lock held. Returns 'replaced', or raises ``SessionEndedError`` for a
        caller passing ``replace=False``, whom a fresh, empty session could not serve.
        """
        # Close it even when the service reported it not-found (state None): that report can be
        # wrong, and a still-running VM would otherwise bill until max_duration. A close that fails
        # here is expected when the session really is gone, so it is only logged.
        try:
            session.close_if_open()
        except Exception as e:
            debug(f'tool_tenki: could not close dropped session {session.id}: {e}')
        self.session = None
        self._resume_unreported = None
        self.session_epoch += 1
        self.last_replacement_epoch = self.session_epoch
        self.last_recovery = 'replaced'
        self._resume_retry_until = None
        # A warning rather than debug output: the next call pays for a new VM and starts empty.
        warning(f'tool_tenki: session {session.id} is {state or "gone"}; the next call starts a new, empty session')
        if not replace:
            raise SessionEndedError()
        return 'replaced'

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = str((cfg.get('apikey') or '')).strip()
            if not apikey:
                warning('apikey is required')
            elif not apikey.startswith('tk_'):
                warning('apikey must be a Tenki workspace API key, which starts with tk_')
            outlives = _outlives_the_session(
                _int_or(cfg.get('exec_timeout_secs'), 120, lo=1, hi=1200),
                _int_or(cfg.get('max_duration_minutes'), 60, lo=1, hi=1440),
            )
            if outlives:
                warning(outlives)
            unknown = unknown_groups(cfg.get('toolGroups'))
            if unknown:
                warning(f'unknown tool group(s): {", ".join(unknown)}')
            try:
                normalize_groups(cfg.get('toolGroups'))
            except ValueError:
                warning('toolGroups matches no known group, so the pipeline will fail to start')
            try:
                _git_auth_settings(cfg, *_secret_settings(cfg))
            except ValueError as e:
                warning(f'The pipeline will fail to start: {e}')
            try:
                _label(cfg)
            except ValueError as e:
                warning(f'The pipeline will fail to start: {e}')
        except Exception as e:
            warning(str(e))

    def _close_tagged_sessions(self) -> None:
        """Close any still-running session carrying this run's tag.

        The scoped close above handles the session the node is holding. This catches the ones it is
        not: a session dropped in recovery whose close did not take, or a create that raced the RPC
        deadline and left a VM the node never got a handle for. The unique run tag keeps the sweep to
        this run's own sessions. Best-effort: listing needs the network, and max_duration is the
        final backstop.
        """
        if not self._run_tag:
            return
        if not self._create_attempted:
            # Nothing can carry the tag, and an unused node then shuts down without the network.
            return
        try:
            leftover = self.client.list(tags=[self._run_tag])
        except Exception as e:
            warning(f"tool_tenki: could not list this run's sessions to clean up: {e}")
            return
        for sandbox in leftover:
            if getattr(sandbox, 'state', '') in ('TERMINATING', 'TERMINATED'):
                # Already on its way out, and almost always the session the close above just ended:
                # terminating takes a moment, so a list right after still returns it. Reporting a
                # close here would fire on every clean shutdown and bury the case below.
                continue
            try:
                sandbox.close_if_open()
                # A warning, not debug: something escaped the scoped close and was still billing.
                warning(f'tool_tenki: closed session {getattr(sandbox, "id", "?")}, which shutdown had left running')
            except Exception as e:
                warning(f'tool_tenki: could not close leftover session {getattr(sandbox, "id", "?")}: {e}')

    def endGlobal(self) -> None:
        # First, so that no tool call can create a session after the close below.
        self._ending = True
        # Load-bearing for Tenki: a session left open keeps billing compute until max_duration
        # pauses it, since nothing pauses an idle session sooner. Taking the lock lets a
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
            self._close_tagged_sessions()
            try:
                self.client.close()
            except Exception as e:
                warning(f'tool_tenki: client close failed: {e}')
            finally:
                self.client = None
