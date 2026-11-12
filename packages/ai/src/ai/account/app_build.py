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

"""The app BUILD WORKER — compiles a deployed app's source into its servable
``dist/`` tree.

An app deploy (``rrext_deploy add``, kind:'app') lands SOURCE in the store:
``.deployments/<app_id>/v<N>-<sha8>/bundle/`` (the retained transport zip)
and ``.../source/`` (unpacked, for review browsing). This worker turns that
into ``.../dist/`` — the tree entry minting serves — and tracks the whole
lifecycle in the rail row's ``metadata.build`` (the row IS the job record;
no job table exists). Deploy is the ONLY trigger; there is no developer-side
manual kick (immutable source + pinned platform bundler reproduce the same
result, so re-running a failed user build is pointless — sys.app ops
re-kicks arrive with the admin surface).

The store (S3-backed in production) is the system of record only — the
toolchain never touches it. Each job:

  MATERIALIZE  one store fetch of the retained zip -> local scratch
               workspace; the server's OWN shell/rocketride tgzs placed at
               the override paths; platform overrides FORCED into the
               scratch workspace yaml (or a minimal one generated when the
               pack carried none); the canonical rsbuild config emitted
               OUTSIDE the app dir so user devDep toolchains can never
               capture its imports
  INSTALL      pnpm install --no-frozen-lockfile --ignore-scripts
               --ignore-pnpmfile --prefer-offline (package-manager version
               switching off), filtered to the packed importers —
               devDependencies INCLUDED (the user's @types feed the
               typecheck gate); post-install lockfile drift diff
  TYPECHECK    the PLATFORM's baked tsc over the user's tsconfig and @types
  BUNDLE       the PLATFORM's rsbuild + Module Federation (the artifact
               format is a runtime contract with the shell — never the
               user's bundler)
  HARVEST      dist tree + manifest-referenced assets (icon/readme) ->
               store dist/; full output -> build.log
  FINALIZE     metadata.build ok|failed (review state is NEVER touched — a
               failed build stays 'private' on the rail), deploy event,
               account refresh for the deployer

The build executes NO developer-controlled code (#1021): lifecycle scripts
and pnpmfiles are ignored, .npmrc files are removed and pnpm-workspace.yaml
is reduced to an allowlist, a shipped node_modules is refused, the rsbuild
config and the tsc are the platform's, every auto-loaded postcss/babel
config is neutralized, .env files keep only PUBLIC_ entries, and the
bundler refuses any loader outside the platform toolchain and any module
outside the job directory or the toolchain. What the type checker can still
READ while it compiles is bounded only by the process sandbox (an infra
concern, not this module); the typecheck runs with incremental and
composite off, so tsconfig cannot make it write build-info files.
"""

import asyncio
import glob
import json
import os
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any, Dict, List, Optional, Tuple

from rocketlib import debug, error

from ai.account.deployment_backend import artifact_content_dir

# =============================================================================
# CONFIGURATION — env knobs, phase timeouts, toolchain pins
# =============================================================================

# How many builds run concurrently. Builds are memory-hungry (rspack peaks
# at 1-2 GB) against a pod limit shared with the engine — default serial.
_CONCURRENCY = max(1, int(os.environ.get('RR_BUILD_CONCURRENCY', '1') or 1))

# Per-phase timeouts (seconds), each generous and individually overridable —
# a hung registry fails as "install timeout" instead of eating the bundler's
# budget. Tree-killed on expiry.
_PHASE_TIMEOUTS = {
    'materialize': int(os.environ.get('RR_BUILD_TIMEOUT_MATERIALIZE_SECONDS', '600') or 600),
    'install': int(os.environ.get('RR_BUILD_TIMEOUT_INSTALL_SECONDS', '900') or 900),
    'typecheck': int(os.environ.get('RR_BUILD_TIMEOUT_TYPECHECK_SECONDS', '600') or 600),
    'bundle': int(os.environ.get('RR_BUILD_TIMEOUT_BUNDLE_SECONDS', '900') or 900),
    'harvest': int(os.environ.get('RR_BUILD_TIMEOUT_HARVEST_SECONDS', '600') or 600),
}

# Bounded retry for INFRA-flavored failures only (store IO, spawn errors).
# A nonzero tsc/rsbuild exit is the USER's to fix — immutable source under a
# pinned toolchain reproduces identically, so retrying it is pointless.
_MAX_ATTEMPTS = 2

# Bounds on the failure tail appended to build.log and the captured
# subprocess output (head+tail truncation). Error detail lives ONLY in the
# log file beside the version's artifacts — metadata.build carries status/
# phase/timestamps, never error text.
_MAX_ERRORS = 50
_MAX_ERROR_CHARS = 2000
_MAX_LOG_CAPTURE = 64 * 1024  # per end (head + tail)
_SUBPROCESS_BUFFER = 16 * 1024 * 1024  # mirrors CONST_SUBPROCESS_BUFFER_LIMIT

# Bounds on the HARVESTED dist/ tree. The source zip is quota'd at receipt,
# but the bundler's OUTPUT has no natural bound and the raw store write path
# enforces no quota — a pathological build must fail reasoned at harvest,
# never fill the store. Generous headroom over any legitimate app bundle.
_HARVEST_MAX_FILES = 4000
_HARVEST_MAX_FILE_BYTES = 64 * 1024 * 1024
_HARVEST_MAX_TOTAL_BYTES = 512 * 1024 * 1024

# Scratch dirs older than this are orphans (a crashed process's leftovers).
# The startup sweep deletes ONLY past this age: the scratch root is shared
# host temp, and a second engine process may be mid-build in its own dir —
# a live job's dir is always younger than the bar.
_SCRATCH_TTL_SECONDS = 24 * 3600

# The platform toolchain pins — kept in LOCKSTEP with the app scaffold
# (apps/shared/src/modules/appdev/templates.ts packageJson): the baked env
# these produce is the bundler the store's artifact contract is built with.
_TOOLCHAIN_PINS = {
    '@rsbuild/core': '~2.0.11',
    '@rsbuild/plugin-react': '~2.0.1',
    '@module-federation/rsbuild-plugin': '2.5.1',
    'typescript': '^5.3.0',
    'react-refresh': '^0.14.2',
    '@types/node': '^20.19.41',
    '@types/react': '^18.2.0',
    '@types/react-dom': '^18.2.0',
}

# The two platform packages, pinned via FORCED overrides in the scratch
# workspace yaml — never registry installs, always THIS server's artifacts,
# regardless of how (or whether) the user's workspace referenced them.
_SHELL_REL = '.rocketride/shell/shell.tgz'
_ROCKETRIDE_REL = '.rocketride/client/rocketride.tgz'

# Auto-loaded config files rsbuild would execute from the project tree —
# neutralized at materialize (user JS must never run). Content by extension.
_NEUTRALIZED_CONFIGS = (
    # Every name postcss-load-config (rsbuild 2) searches — the JSON/YAML
    # forms load plugins BY NAME, so they are code too.
    '.postcssrc',
    '.postcssrc.json',
    '.postcssrc.yaml',
    '.postcssrc.yml',
    '.postcssrc.js',
    '.postcssrc.cjs',
    '.postcssrc.mjs',
    '.postcssrc.ts',
    '.postcssrc.cts',
    '.postcssrc.mts',
    'postcss.config.js',
    'postcss.config.cjs',
    'postcss.config.mjs',
    'postcss.config.ts',
    'postcss.config.cts',
    'postcss.config.mts',
    'babel.config.js',
    'babel.config.cjs',
    'babel.config.mjs',
    'babel.config.json',
    'babel.config.ts',
    'babel.config.cts',
    'babel.config.mts',
    '.babelrc',
    '.babelrc.js',
    '.babelrc.cjs',
    '.babelrc.mjs',
    '.babelrc.json',
)

# package.json keys REMOVED from every manifest: the loaders read postcss/
# babel as config (plugins by name); `pnpm` carries pnpm settings (hooks,
# patches, overrides, ...) that are developer configuration; `browserslist`
# steers the transpiler's target resolution (the platform sets its own).
_NEUTRALIZED_PACKAGE_KEYS = ('postcss', 'babel', 'pnpm', 'browserslist')

# Dependency tables whose specs are checked for link:/file: escapes.
_DEPENDENCY_TABLES = (
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'overrides',
    'resolutions',
)

# The browser targets of the generated rsbuild config; any developer
# browserslist (file or package.json key) is removed.
_BROWSERSLIST_DEFAULT = ('chrome >= 107', 'edge >= 107', 'firefox >= 104', 'safari >= 16')

# Developer configuration files REMOVED from the tree before install: .npmrc
# can redirect pnpm's modules/store dirs (into the shared toolchain env) and
# name a pnpmfile; pnpmfiles are code. --ignore-pnpmfile is the second lock.
# .swcrc configures the SWC transpiler (plugins load by path) and the
# browserslist files steer target resolution.
_REMOVED_CONFIG_FILES = ('.npmrc', '.pnpmfile.cjs', '.pnpmfile.mjs', '.swcrc', '.browserslistrc', 'browserslist')

# The pnpm-workspace.yaml keys that survive into the scratch workspace —
# workspace layout and resolution only. Everything else (pnpm 10 accepts
# any setting here: pnpmfile, configDependencies, modulesDir, storeDir,
# nodeOptions, ...) is dropped.
_WORKSPACE_YAML_KEYS = (
    'packages',
    'catalog',
    'catalogs',
    'overrides',
    'peerDependencyRules',
    'allowedDeprecatedVersions',
    'autoInstallPeers',
    'strictPeerDependencies',
    'dedupePeerDependents',
    'resolutionMode',
    'linkWorkspacePackages',
    'preferWorkspacePackages',
    'injectWorkspacePackages',
    'ignoredOptionalDependencies',
    'supportedArchitectures',
    'neverBuiltDependencies',
    'ignoredBuiltDependencies',
)

# rsbuild copies the app dir's .env files into its OWN process env; only
# PUBLIC_ entries are meant for the bundle, so only those survive.
_ENV_PUBLIC_LINE = re.compile(r'^\s*(?:export\s+)?PUBLIC_[A-Za-z0-9_]*\s*=(.*)$')


def _scratch_root() -> str:
    """The local scratch root builds materialize under (k8s: the emptyDir).

    Resolved to its FINAL (long) form: on Windows ``tempfile.gettempdir()``
    is routinely the 8.3 SHORT spelling (``RODCHR~1``), and pnpm resolves
    ``--filter ./path`` against the literal cwd while enumerating workspace
    projects at their long paths — short vs long never compares equal, so
    the filter silently matches NOTHING (exit 0, nothing installed).
    """
    return os.path.realpath(os.environ.get('RR_BUILD_SCRATCH_ROOT') or tempfile.gettempdir())


def _engine_dir() -> str:
    """The engine's install dir — static client tgzs and the env cache live here."""
    return os.path.dirname(os.path.realpath(sys.executable))


def _rmtree(path: str) -> None:
    r"""Best-effort recursive delete for scratch trees, with two guarantees
    the plain ``shutil.rmtree(ignore_errors=True)`` call could not give:

    - Deletes past Windows' 260-char MAX_PATH via the extended-length
      (``\\?\``) spelling. Scratch entries routinely cross the ceiling
      (pnpm's ``.pnpm`` store names plus module-federation's dist depth
      measured ~290 chars with NO include roots), and a plain unlink then
      fails with a misleading WinError 3 that ``ignore_errors`` swallowed —
      the lingering ``app-build-*`` temp dirs.
    - NEVER follows links. pnpm materializes node_modules through junctions
      and hard links into its global store; walking through one would
      destroy the linked target. A link ROOT is removed as a link in place;
      links inside the tree are removed as links by ``shutil.rmtree``'s own
      no-descend contract (hard links just drop one name, never content).
    """
    try:
        st_res = os.stat(path, follow_symlinks=False)
        reparse = os.name == 'nt' and bool(getattr(st_res, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)
        if stat.S_ISLNK(st_res.st_mode) or reparse:
            # The root itself is a link/junction — remove the LINK, never
            # its target (directory links need rmdir, file symlinks unlink).
            if reparse or stat.S_ISDIR(st_res.st_mode):
                os.rmdir(path)
            else:
                os.unlink(path)
            return
    except OSError:
        return  # already gone (or unstatable) — nothing to clean
    target = path
    if os.name == 'nt' and not path.startswith('\\\\?\\'):
        target = ('\\\\?\\UNC\\' + path[2:]) if path.startswith('\\\\') else ('\\\\?\\' + path)
    shutil.rmtree(target, ignore_errors=True)


def _scrub_paths(text: str, roots: List[str]) -> str:
    """Strip caller-exposing filesystem detail from build-log text.

    The build runs in a server-local scratch dir whose ABSOLUTE path leaks
    host layout (user name, temp root, process id) into every tool line.
    The log is served to the developer, so before it is written each given
    root collapses to ``<build>`` (both separator spellings), then any
    surviving ``<drive>:\\Users\\<name>`` prefix collapses to ``<home>`` —
    workspace-relative paths stay readable, the host stays undescribed.
    """
    for root in roots:
        if not root:
            continue
        for variant in dict.fromkeys((root, root.replace('\\', '/'), root.replace('/', '\\'))):
            text = text.replace(variant, '<build>')
    return re.sub(r'[A-Za-z]:[\\/][Uu]sers[\\/][^\\/\s:;"\')\]]+', '<home>', text)


class BuildFailure(Exception):
    """A build phase failed for USER-visible reasons (no infra retry).

    Carries the phase and the bounded error rows appended to build.log's
    failure tail (never the DB — metadata.build holds no error text).
    """

    def __init__(self, phase: str, message: str, errors: Optional[List[Dict[str, str]]] = None):
        super().__init__(message)
        self.phase = phase
        self.errors = errors or [{'phase': phase, 'message': message[:_MAX_ERROR_CHARS]}]


class BuildInfraFailure(Exception):
    """A build phase failed for PLATFORM reasons (retried up to the cap)."""

    def __init__(self, phase: str, message: str):
        super().__init__(message)
        self.phase = phase


# =============================================================================
# SUBPROCESS EXECUTION — the one seam every external tool runs through
# =============================================================================


def _build_env() -> Dict[str, str]:
    """The scrubbed environment build subprocesses run in.

    WHITELIST copy — no DB DSNs, brokers, tokens, or RR secrets ever reach a
    build (the engine-child scrub posture). ``CI`` is deliberately absent:
    pnpm auto-enables --frozen-lockfile under CI-like environments, which
    would resurrect the missing-importer failure the non-frozen install
    design exists to avoid.
    """
    keep = (
        'PATH',
        'HOME',
        'USERPROFILE',
        'APPDATA',
        'LOCALAPPDATA',
        'TEMP',
        'TMP',
        'SYSTEMROOT',
        'SystemRoot',
        'COMSPEC',
        'ComSpec',
        'WINDIR',
        'LANG',
        'LC_ALL',
        'SHELL',
    )
    env = {key: os.environ[key] for key in keep if key in os.environ}
    env['NO_COLOR'] = '1'
    return env


def _truncated(text: str) -> str:
    """Head+tail truncation of captured output (the sandbox posture)."""
    if len(text) <= 2 * _MAX_LOG_CAPTURE:
        return text
    return text[:_MAX_LOG_CAPTURE] + '\n... [output truncated] ...\n' + text[-_MAX_LOG_CAPTURE:]


def _kill_tree(proc: Any) -> None:
    """Best-effort kill of a timed-out subprocess AND its children.

    rsbuild/pnpm spawn worker children; killing only the parent leaks them.
    Windows: taskkill /T walks the tree. POSIX: the child runs in its own
    session (start_new_session), so the process group is killable whole.
    """
    try:
        if os.name == 'nt':
            subprocess.run(
                ['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                capture_output=True,
                timeout=30,
            )
        else:
            import signal

            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass  # already gone


async def _exec(argv: List[str], cwd: str, timeout: int, on_line: Any = None) -> Tuple[int, str]:
    """Run one toolchain command; ``(exit_code, combined_output)``.

    THE seam every external tool runs through (tests patch it). Windows
    package-manager shims (.cmd) are routed through cmd.exe — CreateProcess
    does not reliably exec batch files directly.

    ``on_line`` (optional async callable) receives each output line AS IT
    ARRIVES — the live build feed. Output is read incrementally either way;
    the returned transcript keeps the same head+tail truncation as before.
    The timeout is the OVERALL phase deadline, enforced across every read.

    Raises:
        BuildInfraFailure: The command could not be SPAWNED (missing binary,
            OS error) — platform trouble, not the user's code.
        asyncio.TimeoutError: The phase timeout expired (tree-killed first).
    """
    if os.name == 'nt' and argv and argv[0].lower().endswith(('.cmd', '.bat')):
        argv = [os.environ.get('COMSPEC', 'cmd.exe'), '/d', '/c', *argv]
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=cwd,
            env=_build_env(),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_SUBPROCESS_BUFFER,
            start_new_session=(os.name != 'nt'),
        )
    except Exception as exc:
        raise BuildInfraFailure('spawn', f'could not start {argv[0]!r}: {exc}')
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    chunks: List[str] = []
    assert proc.stdout is not None
    try:
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise asyncio.TimeoutError()
            try:
                raw = await asyncio.wait_for(proc.stdout.readline(), timeout=remaining)
            except (asyncio.LimitOverrunError, ValueError):
                # A single line larger than the stream limit: drain a bounded
                # chunk instead — the transcript keeps flowing, the feed just
                # sees it as one oversized "line".
                raw = await asyncio.wait_for(proc.stdout.read(64 * 1024), timeout=max(1.0, deadline - loop.time()))
            if not raw:
                break  # EOF — the process is finishing
            text = raw.decode('utf-8', errors='replace')
            chunks.append(text)
            if on_line is not None:
                await on_line(text.rstrip('\r\n'))
        await asyncio.wait_for(proc.wait(), timeout=max(1.0, deadline - loop.time()))
    except BaseException:
        # EVERY abnormal exit from the read loop kills the tree — not just
        # the timeout. The reachable non-timeout case is cancellation
        # (worker shutdown): without the reap the pnpm/rsbuild child keeps
        # running unawaited while its job directory is torn down under it.
        _kill_tree(proc)
        raise
    return int(proc.returncode or 0), _truncated(''.join(chunks))


# =============================================================================
# TOOLCHAIN — node/pnpm discovery + the baked (or bootstrapped) env
# =============================================================================


def _find_node() -> Optional[str]:
    """The node binary (RR_BUILD_NODE override, else PATH)."""
    return os.environ.get('RR_BUILD_NODE') or shutil.which('node')


def _find_pnpm() -> Optional[str]:
    """The pnpm binary (RR_BUILD_PNPM override, else PATH)."""
    return os.environ.get('RR_BUILD_PNPM') or shutil.which('pnpm')


def _env_dir() -> str:
    """The toolchain env home (image: pre-baked read-only; dev: a cache).

    realpath'd like every worker path — pnpm path handling must never see
    a Windows 8.3 short spelling (see _scratch_root).
    """
    return os.path.realpath(os.environ.get('RR_BUILD_ENV_DIR') or os.path.join(_engine_dir(), 'cache', 'app-build-env'))


# Single-flight for the env bootstrap: with RR_BUILD_CONCURRENCY > 1 two
# jobs can both miss the .ready marker and run pnpm install into the SAME
# env dir concurrently — corrupting node_modules. The marker only protects
# across process restarts; this lock protects within one process.
_ENV_BOOTSTRAP_LOCK = asyncio.Lock()


async def _ensure_toolchain_env(on_line: Any = None) -> str:
    """The installed toolchain env dir, bootstrapping it once when absent.

    The image ships it pre-baked (RR_BUILD_ENV_DIR, read-only layer); dev/OSS
    machines install the pinned set ONCE into a local cache on first build
    (network is available there) and reuse it until the PINS change. The
    `.ready` marker records the pins it was built with: a marker whose pins
    no longer match the current set re-bootstraps (a platform upgrade must
    refresh the cached env, never serve stale tools), and a half-installed
    env from a killed bootstrap re-installs the same way.

    Raises:
        BuildInfraFailure: No pnpm to bootstrap with, or the install failed.
    """
    async with _ENV_BOOTSTRAP_LOCK:
        return await _ensure_toolchain_env_locked(on_line)


async def _ensure_toolchain_env_locked(on_line: Any = None) -> str:
    """The bootstrap body — callers hold _ENV_BOOTSTRAP_LOCK (single-flight).

    The marker re-check runs INSIDE the lock: the loser of a concurrent
    first-build race finds the winner's finished env and returns without a
    second install.
    """
    env_dir = _env_dir()
    marker = os.path.join(env_dir, '.ready')
    if os.path.isfile(marker) and os.path.isdir(os.path.join(env_dir, 'node_modules')):
        try:
            with open(marker, 'r', encoding='utf-8') as handle:
                recorded = json.load(handle).get('pins')
        except Exception:
            recorded = None
        if recorded == _TOOLCHAIN_PINS:
            return env_dir
        debug(f'[app_build] toolchain env pins changed — re-bootstrapping {env_dir}')
    pnpm = _find_pnpm()
    if not pnpm:
        raise BuildInfraFailure(
            'materialize', 'server build toolchain unavailable: pnpm not found (RR_BUILD_PNPM/PATH)'
        )
    os.makedirs(env_dir, exist_ok=True)
    # A plain single-package install of the pinned toolchain set — flat
    # enough to resolve upward from any scratch workspace linked to it.
    with open(os.path.join(env_dir, 'package.json'), 'w', encoding='utf-8') as handle:
        json.dump(
            {'name': 'rocketride-app-build-env', 'private': True, 'devDependencies': dict(_TOOLCHAIN_PINS)},
            handle,
            indent=1,
        )
    debug(f'[app_build] bootstrapping toolchain env at {env_dir}')
    # --ignore-workspace is LOAD-BEARING: the default env dir can live inside
    # a checked-out repo (dist/server/cache on a dev machine), and pnpm walks
    # UP from cwd looking for a pnpm-workspace.yaml — without the flag it
    # finds the REPO's workspace, "successfully" installs THAT, and leaves
    # this env with no node_modules at all (exit 0, nothing here).
    code, out = await _exec(
        [pnpm, 'install', '--ignore-workspace', '--ignore-scripts', '--prefer-offline'],
        env_dir,
        _PHASE_TIMEOUTS['install'],
        on_line=on_line,
    )
    if code != 0:
        raise BuildInfraFailure('materialize', f'toolchain env bootstrap failed (pnpm exit {code}): {out[-2000:]}')
    # Trust nothing: exit 0 with no node_modules (a workspace-context install,
    # a broken pnpm) must fail REASONED here, never crash a job downstream.
    if not os.path.isdir(os.path.join(env_dir, 'node_modules')):
        raise BuildInfraFailure(
            'materialize', f'toolchain env bootstrap produced no node_modules at {env_dir} — pnpm output: {out[-1000:]}'
        )
    with open(marker, 'w', encoding='utf-8') as handle:
        handle.write(json.dumps({'pins': _TOOLCHAIN_PINS, 'at': time.time()}))
    return env_dir


def _resolve_bin(base_dir: str, package: str, preferred: 'tuple[str, ...]') -> Optional[str]:
    """A package's node-runnable bin script under ``base_dir/node_modules``.

    Reads the package's ``bin`` field and returns the first preferred entry
    (absolute path), so invocation is always ``node <script>`` — never a
    shell shim.
    """
    pkg_dir = os.path.join(base_dir, 'node_modules', *package.split('/'))
    pkg_json = os.path.join(pkg_dir, 'package.json')
    if not os.path.isfile(pkg_json):
        return None
    try:
        with open(pkg_json, 'r', encoding='utf-8') as handle:
            manifest = json.load(handle)
    except Exception:
        return None
    bins = manifest.get('bin')
    if isinstance(bins, str):
        return os.path.join(pkg_dir, bins)
    if isinstance(bins, dict):
        for name in preferred:
            if bins.get(name):
                return os.path.join(pkg_dir, str(bins[name]))
    return None


def _installed_version(base_dir: str, package: str) -> str:
    """The installed version string of one env package ('' when absent)."""
    pkg_json = os.path.join(base_dir, 'node_modules', *package.split('/'), 'package.json')
    try:
        with open(pkg_json, 'r', encoding='utf-8') as handle:
            return str(json.load(handle).get('version') or '')
    except Exception:
        return ''


def _resolve_platform_tsc(env_dir: str) -> Optional[str]:
    """The PLATFORM's tsc script from the baked toolchain env — never the
    developer's: whatever pnpm installed as ``typescript`` in the developer
    tree (an ``npm:``/``file:`` alias, a lockfile tarball) is developer code.
    """
    return _resolve_bin(env_dir, 'typescript', ('tsc',))


# =============================================================================
# MATERIALIZE HELPERS — workspace yaml surgery, config emission, tgz placement
# =============================================================================


def _patched_workspace_yaml(
    source_text: Optional[str], app_root: str, include_roots: List[str], dropped: Optional[List[str]] = None
) -> str:
    """The scratch workspace yaml: the user's, with platform overrides FORCED.

    The ONE deliberate edit of transported workspace truth — the platform's
    packages are the platform's to pin, unconditionally: `overrides.shell`
    and `overrides.rocketride` point at the server's placed tgzs whatever
    the user's yaml said (a dev tgz override, the in-repo `workspace:*`, or
    nothing). Only _WORKSPACE_YAML_KEYS survive (dropped names are appended
    to ``dropped``), and ``packages`` may not reach outside the tree. A pack with NO workspace
    yaml gets the minimal fallback: the packed importers + the same two
    overrides (synthesis only where the user had no workspace truth).

    Raises:
        BuildFailure: The yaml is unparseable, ``packages`` is not a list of
            safe strings, a dependency spec escapes the tree, or it aliases
            the ``typescript`` package name (the alias guard — the typecheck
            gate always runs the platform's baked typescript, never an
            arbitrary package wearing the name).
    """
    import yaml

    if source_text is not None:
        try:
            data = yaml.safe_load(source_text)
        except Exception as exc:
            raise BuildFailure('materialize', f'pnpm-workspace.yaml is not valid YAML: {exc}')
        data = data if isinstance(data, dict) else {}
        for key in [k for k in data if k not in _WORKSPACE_YAML_KEYS]:
            data.pop(key)
            if dropped is not None:
                dropped.append(str(key))
        if 'packages' in data:
            packages = data['packages']
            if not isinstance(packages, list) or not all(isinstance(entry, str) for entry in packages):
                raise BuildFailure('materialize', 'pnpm-workspace.yaml packages must be a list of strings')
            for entry in packages:
                glob_path = entry.lstrip('!').replace('\\', '/')
                if glob_path.startswith('/') or ':' in glob_path or '{' in glob_path or '..' in glob_path.split('/'):
                    raise BuildFailure(
                        'materialize',
                        f'pnpm-workspace.yaml packages entry {entry!r} reaches outside the source tree',
                    )
        for table in ('overrides', 'catalog'):
            _refuse_unsafe_specs(data.get(table), f'pnpm-workspace.yaml {table}')
        catalogs = data.get('catalogs')
        for named in catalogs.values() if isinstance(catalogs, dict) else ():
            _refuse_unsafe_specs(named, 'pnpm-workspace.yaml catalogs')
    else:
        packages = [app_root or '.'] + [inc for inc in include_roots if inc]
        data = {'packages': packages}
    overrides = data.get('overrides')
    overrides = dict(overrides) if isinstance(overrides, dict) else {}
    # The alias guard parses each selector the way pnpm does: an override
    # key may scope by parent (`app>typescript`) and version-qualify the
    # target (`typescript@5`, `@scope/name@1`), and EVERY spelling whose
    # target package is `typescript` would swap the binary the typecheck
    # gate executes — an exact-key check misses all but the bare name.
    for selector in overrides:
        if _override_target(str(selector)) == 'typescript':
            raise BuildFailure(
                'materialize',
                f'pnpm-workspace.yaml override {selector!r} targets the "typescript" package — the '
                'typecheck gate always runs the platform typescript; aliasing the name '
                'is not supported',
            )
    overrides['shell'] = f'file:{_SHELL_REL}'
    overrides['rocketride'] = f'file:{_ROCKETRIDE_REL}'
    data['overrides'] = overrides
    return yaml.safe_dump(data, sort_keys=False)


def _unsafe_spec(spec: Any) -> bool:
    """True when a dependency spec reaches outside the source tree.

    ``link:`` (any target) is refused. A local path spec — ``file:``,
    ``workspace:<path>``, ``git+file:``, or a bare path (pnpm reads a spec
    that starts with ``.``, ``/``, ``~`` or a drive letter, or ends in
    ``.tgz``/``.tar``/``.tar.gz``, as a local path) — is refused when it is
    absolute or has a ``..`` segment, since it would pull developer-chosen
    directories (the toolchain env, other jobs' scratch, pod files) into
    the install.
    """
    text = str(spec).strip().lower()
    if text.startswith(('link:', 'git+file:')):
        return True
    for prefix in ('file:', 'workspace:'):
        if text.startswith(prefix):
            target = text[len(prefix) :].strip()
            # workspace:^ / workspace:~ / workspace:* / workspace:1.2.3 are
            # version ranges; only a path-shaped target is a local path.
            if prefix == 'workspace:' and not (
                target.startswith(('.', '/')) or re.match(r'^[a-z]:', target) is not None
            ):
                return False
            break
    else:
        # '~' alone or '~/...' is a home path; '~1.2.3' is a version range.
        bare = (
            text.startswith(('.', '/'))
            or text in ('~',)
            or text.startswith('~/')
            or re.match(r'^[a-z]:', text) is not None
        )
        if not (bare or text.endswith(('.tgz', '.tar', '.tar.gz'))):
            return False
        target = text
    target = target.replace('\\', '/')
    if target == '~' or target.startswith('~/'):
        return True
    return target.startswith('/') or re.match(r'^[a-z]:', target) is not None or '..' in target.split('/')


def _refuse_unsafe_specs(table: Any, where: str) -> None:
    """Raise BuildFailure when a dependency table holds an unsafe spec.

    Nested tables (npm-style nested overrides) are walked.
    """
    if not isinstance(table, dict):
        return
    for name, spec in table.items():
        if isinstance(spec, dict):
            _refuse_unsafe_specs(spec, where)
        elif _unsafe_spec(spec):
            raise BuildFailure(
                'materialize',
                f'{where}: dependency {str(name)!r} uses {str(spec)!r}; link:, git+file: and out-of-tree path specs are not supported',
            )


def _override_target(selector: str) -> str:
    """The package NAME a pnpm override selector targets.

    pnpm selectors: an optional ``parent>`` scope (the TARGET is the last
    ``>`` segment) and an optional version qualifier (``name@range``,
    ``@scope/name@range``) — the name ends at the qualifier's ``@``, never
    the scope's leading one.
    """
    target = selector.split('>')[-1].strip()
    if target.startswith('@'):
        slash = target.find('/')
        at = target.find('@', slash + 1) if slash >= 0 else -1
    else:
        at = target.find('@')
    return target if at < 0 else target[:at]


def _place_platform_tgzs(ws_dir: str) -> None:
    """Copy the server's OWN shell + rocketride tgzs to the override paths.

    The server serves both artifacts itself (static/clients/...), so every
    app compiles against exactly the shell/SDK THIS server provides — shell
    no longer bundles rocketride; they are two separate packages.

    Raises:
        BuildInfraFailure: A platform tgz is missing from the engine's
            static tree (a broken install, not the user's code).
    """
    static_dir = os.path.join(_engine_dir(), 'static', 'clients')
    shell_src = os.path.join(static_dir, 'shell', 'shell.tgz')
    rocketride_matches = sorted(glob.glob(os.path.join(static_dir, 'typescript', 'rocketride-*.tgz')))
    if not os.path.isfile(shell_src):
        raise BuildInfraFailure('materialize', f'platform shell.tgz missing at {shell_src}')
    if not rocketride_matches:
        raise BuildInfraFailure('materialize', f'platform rocketride tgz missing under {static_dir}/typescript')
    if len(rocketride_matches) > 1:
        # The static tree ships exactly ONE SDK tgz. Guessing among several
        # sorts NAMES as text (1.9.0 beats 1.10.0) — refuse a broken tree
        # rather than compile every app against a stale SDK.
        names = ', '.join(os.path.basename(m) for m in rocketride_matches)
        raise BuildInfraFailure(
            'materialize',
            f'multiple platform rocketride tgzs under {static_dir}/typescript ({names}) — the static tree must hold exactly one',
        )
    for rel, src in ((_SHELL_REL, shell_src), (_ROCKETRIDE_REL, rocketride_matches[-1])):
        dest = os.path.join(ws_dir, *rel.split('/'))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copyfile(src, dest)


def _inert_config(name: str) -> str:
    """Inert content for one neutralized config name (by its loader)."""
    ext = os.path.splitext(name)[1] if name not in ('.postcssrc', '.babelrc') else ''
    if ext in ('.js', '.cjs', '.cts'):
        return 'module.exports = {};\n'
    if ext in ('.mjs', '.ts', '.mts'):
        return 'export default {};\n'
    return '{}\n'  # JSON / YAML / extensionless rc


def _neutralize_tool_configs(ws_dir: str, app_dir: str) -> List[str]:
    """Make every auto-loaded postcss/babel config in the tree inert.

    postcss-load-config searches upward from the app root, and its JSON/YAML
    forms and the package.json ``postcss`` key load plugins by name — all
    developer code. The WHOLE source tree is walked (``app_dir`` lies inside
    ``ws_dir``): existing config files get inert content and the config keys
    (postcss, babel, pnpm, browserslist) are stripped from every package.json,
    whose dependency specs must not use ``link:`` or out-of-tree ``file:``.
    Absent files are not created.

    Returns:
        The neutralized items, workspace-relative (config files, and
        ``<package.json>:<key>`` for stripped keys), for the build log.

    Raises:
        BuildFailure: A package.json is not UTF-8 JSON, or a dependency spec
            escapes the source tree.
    """
    names = set(_NEUTRALIZED_CONFIGS)
    neutralized: List[str] = []
    for dirpath, _dirs, files in os.walk(ws_dir):
        for name in files:
            path = os.path.join(dirpath, name)
            if name in names:
                with open(path, 'w', encoding='utf-8') as handle:
                    handle.write(_inert_config(name))
                neutralized.append(os.path.relpath(path, ws_dir).replace(os.sep, '/'))
            elif name == 'package.json':
                rel = os.path.relpath(path, ws_dir).replace(os.sep, '/')
                try:
                    with open(path, 'r', encoding='utf-8-sig') as handle:
                        manifest = json.load(handle)
                except (UnicodeDecodeError, ValueError) as exc:
                    # Another reader (pnpm) may parse what this one skips.
                    raise BuildFailure('materialize', f'{rel} is not valid UTF-8 JSON: {exc}')
                if not isinstance(manifest, dict):
                    continue
                for table in _DEPENDENCY_TABLES:
                    _refuse_unsafe_specs(manifest.get(table), rel)
                if any(k in manifest for k in _NEUTRALIZED_PACKAGE_KEYS):
                    for key in _NEUTRALIZED_PACKAGE_KEYS:
                        if manifest.pop(key, None) is not None:
                            neutralized.append(f'{rel}:{key}')
                    with open(path, 'w', encoding='utf-8') as handle:
                        json.dump(manifest, handle, indent=2)
    return neutralized


def _remove_pnpm_configs(ws_dir: str) -> List[str]:
    """Delete every developer .npmrc / pnpmfile / .swcrc / browserslist file in the tree.

    Returns the removed workspace-relative paths (for the build log).
    """
    removed: List[str] = []
    for dirpath, _dirs, files in os.walk(ws_dir):
        for name in files:
            if name in _REMOVED_CONFIG_FILES:
                path = os.path.join(dirpath, name)
                os.remove(path)
                removed.append(os.path.relpath(path, ws_dir).replace(os.sep, '/'))
    return sorted(removed)


def _filter_env_files(app_dir: str) -> None:
    """Reduce the app dir's .env files to their PUBLIC_ lines.

    rsbuild loads ``.env*`` from the app root into its own process env (non
    PUBLIC_ keys such as NODE_OPTIONS or RSPACK_* would steer the build
    process itself); only PUBLIC_ entries are meant for the bundle, and a
    value containing command substitution (``$(`` or a backtick) is dropped.
    Multi-line values are not supported in server builds.
    """
    try:
        names = os.listdir(app_dir)
    except OSError:
        return
    for name in names:
        path = os.path.join(app_dir, name)
        if not name.startswith('.env') or not os.path.isfile(path):
            continue
        with open(path, 'r', encoding='utf-8', errors='replace') as handle:
            kept = []
            for line in handle:
                match = _ENV_PUBLIC_LINE.match(line.rstrip('\r\n'))
                if match and '$(' not in match.group(1) and '`' not in match.group(1):
                    kept.append(line.rstrip('\r\n'))
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write('\n'.join(kept) + '\n' if kept else '')


# The resolved-module guard emitted into the canonical rsbuild config. After
# the bundler resolves a module, every loader in its chain must be a builtin
# or live in the platform toolchain env, and the module itself must live in
# the job directory or the toolchain env. A loader file from the developer
# tree (named inline in an import string, or installed by the app) is never
# run, and a file elsewhere on the pod is never pulled into the bundle.
# `_resolved_request_allowed` is the Python twin of `rrRequestAllowed`; the
# two are kept in lockstep and tested on the same strings.
_BUILTIN_PREFIXES = ('builtin:', 'data:', 'node:')


def _strip_query(segment: str) -> str:
    """Drop a ``?query`` / ``#fragment`` suffix from one request segment."""
    for mark in ('?', '#'):
        index = segment.find(mark)
        if index != -1:
            segment = segment[:index]
    return segment


def _under(path: str, roots: Tuple[str, ...]) -> bool:
    """True when ``path`` (an absolute filesystem path) is inside a root."""
    if not os.path.isabs(path):
        return False
    real = os.path.realpath(path)
    return any(real == root or real.startswith(root + os.sep) for root in roots)


def _loader_options_allowed(loader: str) -> bool:
    """A loader may carry no inline options, only a ``??ident`` reference.

    The bundler writes options from the platform config as ``??<ident>``
    (a reference to a rule). Inline ``?{...}`` / ``?key=value`` options in a
    request come from an import string, and some loaders load files named
    in their options, so they are refused.
    """
    index = loader.find('?')
    if index == -1:
        return True
    return loader[index:].startswith('??') and '#' not in loader[index:]


def _resolved_request_allowed(request: str, module_roots: Tuple[str, ...], loader_roots: Tuple[str, ...]) -> bool:
    """Decide whether a RESOLVED bundler request may be built.

    ``request`` is the bundler's resolved request: optional matchResource
    prefix (``<x>!=!``), optional ``-!`` / ``!!`` / ``!`` prefix, then
    ``loader!loader!...!resource``, each segment absolute after resolution.
    Every loader must be a builtin or sit under ``loader_roots``; the
    resource must be a builtin/data/node: URI or sit under ``module_roots``.
    Anything unparseable is refused (fail closed). Roots must be realpaths.
    """
    if not isinstance(request, str) or not request:
        return False
    rest = request
    # matchResource prefix, as the bundler parses it: ^([^!]+)!=! — the
    # prefix itself never contains '!'.
    match = re.match(r'^[^!]+!=!', rest)
    if match:
        rest = rest[match.end() :]
    for prefix in ('-!', '!!', '!'):
        if rest.startswith(prefix):
            rest = rest[len(prefix) :]
            break
    if rest.startswith('data:'):
        return True  # an inline data: module (its body may contain '!')
    segments = rest.split('!')
    if any(not segment for segment in segments):
        return False
    *loaders, resource = segments
    for loader in loaders:
        if not _loader_options_allowed(loader):
            return False
        if loader.startswith('builtin:'):
            continue
        if not _under(_strip_query(loader), loader_roots):
            return False
    if resource.startswith(_BUILTIN_PREFIXES):
        return True
    return _under(_strip_query(resource), module_roots)


_RESOLVED_GUARD_JS = """// <rr-resolved-module-guard>
const RR_MODULE_ROOTS = __MODULE_ROOTS__;
const RR_LOADER_ROOTS = __LOADER_ROOTS__;
const RR_BUILTIN_PREFIXES = ['builtin:', 'data:', 'node:'];
function rrStripQuery(segment) {
  for (const mark of ['?', '#']) {
    const index = segment.indexOf(mark);
    if (index !== -1) segment = segment.slice(0, index);
  }
  return segment;
}
function rrUnder(file, roots) {
  if (!path.isAbsolute(file)) return false;
  let real;
  try { real = fs.realpathSync(file); } catch (e) { real = path.resolve(file); }
  return roots.some((root) => real === root || real.startsWith(root + path.sep));
}
function rrRequestAllowed(request) {
  if (typeof request !== 'string' || !request) return false;
  let rest = request;
  const mr = /^[^!]+!=!/.exec(rest);
  if (mr) rest = rest.slice(mr[0].length);
  for (const prefix of ['-!', '!!', '!']) {
    if (rest.startsWith(prefix)) { rest = rest.slice(prefix.length); break; }
  }
  if (rest.startsWith('data:')) return true;
  const segments = rest.split('!');
  if (segments.some((segment) => !segment)) return false;
  const resource = segments.pop();
  for (const loader of segments) {
    const q = loader.indexOf('?');
    if (q !== -1 && !(loader.startsWith('??', q) && loader.indexOf('#', q) === -1)) return false;
    if (loader.startsWith('builtin:')) continue;
    if (!rrUnder(rrStripQuery(loader), RR_LOADER_ROOTS)) return false;
  }
  if (RR_BUILTIN_PREFIXES.some((prefix) => resource.startsWith(prefix))) return true;
  return rrUnder(rrStripQuery(resource), RR_MODULE_ROOTS);
}
function rrCheck(request) {
  if (!rrRequestAllowed(request)) {
    throw new Error('module or loader outside the app build tree is not allowed in server app builds');
  }
}
class RocketRideResolvedModuleGuard {
  apply(compiler) {
    compiler.hooks.normalModuleFactory.tap('rr-resolved-module-guard', (factory) => {
      factory.hooks.afterResolve.tap('rr-resolved-module-guard', (data) => {
        const created = (data && data.createData) || {};
        // No request means the loader chain cannot be checked: refuse.
        rrCheck(typeof created.request === 'string' ? created.request : '');
      });
    });
    compiler.hooks.contextModuleFactory.tap('rr-resolved-module-guard', (factory) => {
      factory.hooks.afterResolve.tap('rr-resolved-module-guard', (data) => {
        const resource = String((data && (data.resource || data.context)) || '');
        rrCheck(resource);
        return data;
      });
    });
  }
}
// </rr-resolved-module-guard>"""


def _emit_config(
    build_dir: str, app_dir: str, out_dir: str, module_id: str, toolchain_dir: Optional[str] = None
) -> str:
    """Write the server-canonical rsbuild config; returns its path.

    Kept in LOCKSTEP with the app scaffold's rsbuild template
    (apps/shared/src/modules/appdev/templates.ts rsbuildConfig) — same MF
    shape, same share scope — with the server deltas: an explicit ``root``
    (the app dir), an explicit distPath (the harvest tree), tsconfig-paths
    resolution for include-root imports, and NO dev-server block. It lives
    OUTSIDE the app dir (`<jobdir>/.build/`), so its imports resolve to the
    baked toolchain layer and can never be captured by installed user
    devDep toolchains. It also installs the resolved-module guard: modules
    must resolve inside the job directory (the parent of ``build_dir``) or
    the toolchain env, and loaders only inside the toolchain env.
    """
    os.makedirs(build_dir, exist_ok=True)
    config_path = os.path.join(build_dir, 'rsbuild.config.mjs')
    tsconfig = os.path.join(app_dir, 'tsconfig.json')
    job_root = os.path.realpath(os.path.dirname(os.path.abspath(build_dir)))
    # The job's node_modules IS the toolchain (a link, or a copy where links
    # are unavailable), so loaders resolved through it are platform loaders.
    loader_roots = sorted({os.path.realpath(toolchain_dir or _env_dir()), os.path.join(job_root, 'node_modules')})
    module_roots = [job_root, os.path.realpath(toolchain_dir or _env_dir())]
    lines = [
        '// Server-canonical app build config — generated per build by app_build.py.',
        '// Keep the MF shape in lockstep with apps/shared/src/modules/appdev/templates.ts.',
        "import { defineConfig } from '@rsbuild/core';",
        "import { pluginReact } from '@rsbuild/plugin-react';",
        "import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';",
        "import path from 'node:path';",
        "import fs from 'node:fs';",
        '',
        _RESOLVED_GUARD_JS.replace('__MODULE_ROOTS__', json.dumps(module_roots)).replace(
            '__LOADER_ROOTS__', json.dumps(loader_roots)
        ),
        '',
        'export default defineConfig({',
        f'  root: {json.dumps(app_dir)},',
        '  plugins: [',
        '    pluginReact(),',
        '    pluginModuleFederation({',
        f'      name: {json.dumps(module_id)},',
        "      filename: 'remoteEntry.js',",
        "      exposes: { './AppDescriptor': './src/AppDescriptor.ts' },",
        '      dts: false,',
        '      runtime: false,',
        "      shareStrategy: 'loaded-first',",
        '      shared: {',
        "        react: { singleton: true, eager: true, requiredVersion: '^18.2.0' },",
        "        'react-dom': { singleton: true, eager: true, requiredVersion: '^18.2.0' },",
        "        'shell': { singleton: true, requiredVersion: false, import: false },",
        "        'rocketride': { singleton: true, requiredVersion: false, import: false },",
        '      },',
        '    }),',
        '  ],',
        '  tools: {',
        '    rspack: {',
        "      module: { rules: [{ test: /\\.pipe$/, type: 'json' }] },",
        '      plugins: [new RocketRideResolvedModuleGuard()],',
        '    },',
        '  },',
        '  source: {',
        "    entry: { index: './src/index.ts' },",
    ]
    if os.path.isfile(tsconfig):
        lines.append(f'    tsconfigPath: {json.dumps(tsconfig)},')
    lines += [
        '  },',
        '  output: {',
        f'    overrideBrowserslist: {json.dumps(list(_BROWSERSLIST_DEFAULT))},',
        "    assetPrefix: 'auto',",
        '    cleanDistPath: true,',
        f'    distPath: {{ root: {json.dumps(out_dir)} }},',
        '  },',
        '});',
        '',
    ]
    with open(config_path, 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(lines))
    return config_path


def _link_toolchain(job_dir: str, env_dir: str) -> None:
    """Link the baked toolchain env at the jobdir's node_modules.

    The jobdir is the PARENT of the source tree (`<jobdir>/ws/...`), so
    upward node resolution from anywhere in the tree ends at the toolchain
    layer — beneath the app's own pnpm-installed node_modules, above
    nothing. Symlink first; Windows hosts without symlink rights fall back
    to a junction (no privilege needed), then to a copy as the last resort.

    Raises:
        BuildInfraFailure: The env carries no node_modules — a reasoned
            failure here beats a dangling link (or a copytree crash) that
            surfaces as a confusing resolve error phases later.
    """
    if not os.path.isdir(os.path.join(env_dir, 'node_modules')):
        raise BuildInfraFailure('materialize', f'toolchain env at {env_dir} has no node_modules')
    source = os.path.join(env_dir, 'node_modules')
    target = os.path.join(job_dir, 'node_modules')
    try:
        os.symlink(source, target, target_is_directory=True)
        return
    except OSError:
        pass
    if os.name == 'nt':
        result = subprocess.run(
            [os.environ.get('COMSPEC', 'cmd.exe'), '/d', '/c', 'mklink', '/J', target, source],
            capture_output=True,
            timeout=60,
        )
        if result.returncode == 0 and os.path.isdir(target):
            return
    shutil.copytree(source, target)


_SAFE_ASSET_RE = re.compile(r'^[A-Za-z0-9_\-./ ]+$')


def _safe_asset_rel(rel: str) -> Optional[str]:
    """A manifest asset path, validated relative-only-inside-the-app.

    Manifest icon/readme paths are USER input: absolute paths, drive
    letters, traversal segments, and exotic characters are refused (closes
    the parked icon-path-traversal item). Returns the normalized relative
    path, or None when unusable.
    """
    rel = str(rel or '').strip().replace('\\', '/')
    if not rel or rel.startswith('/') or ':' in rel or not _SAFE_ASSET_RE.match(rel):
        return None
    parts = [p for p in rel.split('/') if p not in ('', '.')]
    if not parts or '..' in parts:
        return None
    return '/'.join(parts)


# =============================================================================
# LOCKFILE — importer pin parsing (preflight skew + post-install drift diff)
# =============================================================================


_LOCK_PATH_RESOLUTION = re.compile(r"(directory:|tarball:\s*file:|link:|file:)\s*['\"]?([^'\"\s,}]+)", re.IGNORECASE)
# A block-style importer key, alone on its line: `  apps/x:` or `  'apps/x':`.
_LOCK_IMPORTER_KEY = re.compile(r"""^  (['"]?)([^'"#:{}\[\]\s][^'"#{}\[\]]*?)\1:\s*$""")


def _refuse_lockfile_paths(lock_text: str) -> None:
    """Raise BuildFailure when the lockfile resolves a package to a local path
    outside the source tree.

    Paths are resolved the way pnpm writes them. Under ``importers:``, a
    ``link:`` value or a ``specifier:`` line is relative to that importer's
    directory (a workspace sibling is ``link:../../packages/x`` from
    ``apps/x``); every other path (``version: file:``, ``directory:``,
    ``tarball: file:``) is relative to the workspace root. The importer is
    taken only from a strict block-style key line; any other line at that
    level resets it to the root, so the check never runs against a stale or
    guessed directory. A path that is absolute, home-relative or resolves
    above the workspace root is refused.
    """
    section = ''
    importer = '.'
    for raw in lock_text.splitlines():
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        indent = len(line) - len(line.lstrip(' '))
        if indent == 0:
            section = line.split(':', 1)[0].strip().strip('\'"')
            importer = '.'
            continue
        if section == 'importers' and indent <= 2:
            key = _LOCK_IMPORTER_KEY.match(line)
            importer = key.group(2).strip() if key else '.'
            if key:
                continue
        for match in _LOCK_PATH_RESOLUTION.finditer(line):
            kind = match.group(1).lower()
            target = match.group(2).strip().replace('\\', '/')
            if target.startswith(('/', '~')) or re.match(r'^[a-zA-Z]:', target) is not None:
                raise BuildFailure(
                    'materialize', f'pnpm-lock.yaml resolves a package outside the source tree: {target!r}'
                )
            importer_relative = section == 'importers' and (
                kind == 'link:' or line.lstrip().lower().startswith('specifier:')
            )
            base = importer if importer_relative else '.'
            resolved = posixpath.normpath(posixpath.join(base, target))
            if resolved == '..' or resolved.startswith('../'):
                raise BuildFailure(
                    'materialize', f'pnpm-lock.yaml resolves a package outside the source tree: {target!r}'
                )


def _lockfile_importer_pins(lock_text: str) -> Dict[str, Dict[str, str]]:
    """Importer path -> {dependency: resolved version} from a pnpm lockfile.

    Tolerant by design: a shape this walker does not recognize yields {} —
    the drift diff and skew check then simply do not run (the lockfile is a
    fidelity feature, never a gate on its own).
    """
    import yaml

    try:
        data = yaml.safe_load(lock_text)
    except Exception:
        return {}
    importers = (data or {}).get('importers')
    if not isinstance(importers, dict):
        return {}
    out: Dict[str, Dict[str, str]] = {}
    for importer, sections in importers.items():
        if not isinstance(sections, dict):
            continue
        pins: Dict[str, str] = {}
        for section in ('dependencies', 'devDependencies', 'optionalDependencies'):
            deps = sections.get(section)
            if not isinstance(deps, dict):
                continue
            for name, spec in deps.items():
                version = spec.get('version') if isinstance(spec, dict) else spec
                if version:
                    pins[str(name)] = str(version)
        out[str(importer)] = pins
    return out


def _drift_of(before: Dict[str, Dict[str, str]], after: Dict[str, Dict[str, str]]) -> List[str]:
    """Resolved-version divergences between the packed and post-install locks.

    Only importers present in BOTH sides are compared (absent importers were
    pruned — expected), and the platform packages (shell, rocketride) are
    whitelisted — those are EXPECTED to change (the server swapped its own
    tgzs in). Anything else re-resolving means the install did not reproduce
    what the developer ran.
    """
    drifted: List[str] = []
    for importer, pins in before.items():
        current = after.get(importer)
        if current is None:
            continue
        for name, version in pins.items():
            if name in ('shell', 'rocketride'):
                continue
            now = current.get(name)
            if now is not None and now != version:
                drifted.append(f'{importer}: {name} {version} -> {now}')
    return drifted


# =============================================================================
# THE BUILD FEED — throttled live-output events
# =============================================================================


class _BuildFeed:
    """Throttled ``apaevt_build`` emitter — the live compile feed + card ticker.

    Buffers subprocess output lines and broadcasts them org-scoped in
    BATCHES — immediately at ``_FLUSH_LINES``, otherwise at most one event
    per ``_FLUSH_SECONDS`` — so a chatty pnpm can never flood the wire.
    Phase changes ALSO emit the coarse ``apaevt_build_status`` card word
    (one short display term per transition; ``status('')`` clears it).
    A feed with no server (tests, minimal embeddings) swallows everything.
    """

    _FLUSH_LINES = 25
    _FLUSH_SECONDS = 0.7

    # Phase -> the card's display word. The card renders these verbatim, so
    # they are user vocabulary, not internal phase names.
    _PHASE_STATUS = {
        'bootstrap': 'preparing',
        'install': 'installing',
        'typecheck': 'checking',
        'bundle': 'building',
        'harvest': 'publishing',
    }

    def __init__(self, server: Any, org_id: str, app_id: str, version: int) -> None:
        """Bind the feed to one job's identity (the event body)."""
        self._server = server
        self._org_id = org_id
        self._app_id = app_id
        self._version = version
        self._phase = ''
        self._buffer: List[str] = []
        self._last = 0.0

    async def set_phase(self, phase: str) -> None:
        """Switch the phase label, flushing the previous phase's lines first
        and ticking the card with the phase's display word.
        """
        if phase != self._phase:
            await self.flush()
            self._phase = phase
            await self.status(self._PHASE_STATUS.get(phase, phase))

    async def status(self, word: str) -> None:
        """Tick the card with one display word ('' clears it)."""
        if self._server is None:
            return
        try:
            from ai.modules.task.deploy_events import broadcast_build_status

            await broadcast_build_status(self._server, self._org_id, self._app_id, self._version, word)
        except Exception as exc:
            debug(f'[app_build] build status tick failed: {exc}')

    async def line(self, text: str) -> None:
        """Buffer one output line; broadcast when the batch is due."""
        if self._server is None:
            return
        self._buffer.append(text[:_MAX_ERROR_CHARS])
        now = asyncio.get_running_loop().time()
        if len(self._buffer) >= self._FLUSH_LINES or now - self._last >= self._FLUSH_SECONDS:
            await self.flush()

    async def flush(self) -> None:
        """Broadcast the buffered batch (no-op when empty or serverless)."""
        if self._server is None or not self._buffer:
            return
        batch, self._buffer = self._buffer, []
        self._last = asyncio.get_running_loop().time()
        try:
            from ai.modules.task.deploy_events import broadcast_build_output

            await broadcast_build_output(self._server, self._org_id, self._app_id, self._version, self._phase, batch)
        except Exception as exc:
            debug(f'[app_build] build feed flush failed: {exc}')


# =============================================================================
# THE WORKER
# =============================================================================


class AppBuildWorker:
    """The in-process build queue: single-flight jobs over an asyncio loop.

    One instance per process, started by the task module next to the
    scheduler. ``enqueue`` is the only producer door (deploy receipt and the
    restart sweep); jobs run under a concurrency semaphore, and every
    lifecycle transition lands in the rail row's ``metadata.build`` plus an
    org-scoped deploy event.
    """

    def __init__(self, server: Any) -> None:
        """Bind to the DAP server (deploy events + account refresh pushes)."""
        self._server = server
        self._queue: 'asyncio.Queue[Tuple[str, str, int]]' = asyncio.Queue()
        self._pending: set = set()
        self._sem = asyncio.Semaphore(_CONCURRENCY)
        self._inflight: set = set()
        self._loop_task: Optional[asyncio.Task] = None
        self._stopping = False

    # ── lifecycle ─────────────────────────────────────────────────────────

    def start(self) -> None:
        """Start the worker loop (idempotent)."""
        if self._loop_task is None:
            self._loop_task = asyncio.create_task(self._loop())

    async def shutdown(self) -> None:
        """Stop accepting work and cancel the loop; in-flight jobs are
        abandoned mid-phase — the restart sweep re-runs them next boot
        (builds are reproducible from the retained zip).
        """
        self._stopping = True
        if self._loop_task is not None:
            self._loop_task.cancel()
            try:
                await self._loop_task
            except (asyncio.CancelledError, Exception):
                pass
            self._loop_task = None
        inflight = list(self._inflight)
        for task in inflight:
            task.cancel()
        # AWAIT the cancelled jobs: their finally blocks release the
        # semaphore, write build.log, and remove the scratch dir — if the
        # event loop stops right after shutdown returns, none of that runs.
        if inflight:
            await asyncio.gather(*inflight, return_exceptions=True)

    def enqueue(self, org_id: str, app_id: str, version: int) -> bool:
        """Queue one version's build; False when already queued/in flight."""
        key = (org_id, app_id, int(version))
        if key in self._pending or self._stopping:
            return False
        self._pending.add(key)
        self._queue.put_nowait(key)
        return True

    # ── the loop ──────────────────────────────────────────────────────────

    async def _loop(self) -> None:
        """Sweep stale state, then drain the queue forever."""
        try:
            await self._startup_sweep()
        except Exception as exc:
            error(f'[app_build] startup sweep failed: {exc}')
        while not self._stopping:
            key = await self._queue.get()
            await self._sem.acquire()
            task = asyncio.create_task(self._run_guard(key))
            self._inflight.add(task)
            task.add_done_callback(self._inflight.discard)

    async def _run_guard(self, key: Tuple[str, str, int]) -> None:
        """One job under the semaphore; failures never kill the loop.

        The requeue (infra retry) happens HERE, after the pending-set
        discard — requeueing inside the job would race its own cleanup and
        break the duplicate guard for the re-enqueued key.
        """
        requeue = False
        try:
            requeue = bool(await self._run_job(*key))
        except Exception as exc:
            error(f'[app_build] job {key} crashed: {exc}')
        finally:
            self._pending.discard(key)
            self._sem.release()
        if requeue and not self._stopping:
            self.enqueue(*key)

    async def _startup_sweep(self) -> None:
        """Requeue interrupted work + delete AGED scratch dirs.

        Builds are reproducible from the retained zip, so anything left
        'queued'/'building' by a previous process simply runs again. The
        scratch root is SHARED host temp: a second engine process may be
        mid-build in its own dir right now, so the sweep deletes only dirs
        older than _SCRATCH_TTL_SECONDS — a live job's dir is always
        younger than the bar; a crashed process's leftovers age past it and
        collect. (Job dirs carry the owning pid in their name for
        attribution.)
        """
        now = time.time()
        for stale in glob.glob(os.path.join(_scratch_root(), 'app-build-*')):
            try:
                if now - os.path.getmtime(stale) < _SCRATCH_TTL_SECONDS:
                    continue
            except OSError:
                pass  # vanished or unreadable — attempt the delete
            _rmtree(stale)
        from ai.account import account

        rows = await account.deployments_scan_builds(('queued', 'building'))
        for row in rows:
            self.enqueue(str(row['orgId']), str(row['projectId']), int(row['version']))
        if rows:
            debug(f'[app_build] requeued {len(rows)} interrupted build(s)')

    # ── one job ───────────────────────────────────────────────────────────

    async def _run_job(self, org_id: str, app_id: str, version: int) -> bool:
        """Build ONE version end to end and stamp its metadata.build.

        Returns True when the caller should REQUEUE (an infra-flavored
        failure with attempts remaining); False otherwise.
        """
        from ai.account import account

        # The rail row is the job record — load it (entry + artifact).
        try:
            entries = await account.deployments_versions(org_id, app_id)
            entry = next((e for e in entries if int(e.get('version', 0)) == version), None)
            artifact = await account.deployments_artifact(org_id, app_id, version)
        except Exception as exc:
            error(f'[app_build] {app_id} v{version}: registry read failed: {exc}')
            return False
        if entry is None or not isinstance(artifact, dict) or artifact.get('kind') != 'app':
            error(f'[app_build] {app_id} v{version}: not an app registry version — dropped')
            return False

        metadata = entry.get('metadata') if isinstance(entry.get('metadata'), dict) else {}
        prior = metadata.get('build') if isinstance(metadata.get('build'), dict) else {}
        if prior.get('status') == 'ok':
            return False  # already built (requeue race) — nothing to do.
        attempt = int(prior.get('attempt') or 0) + 1

        build: Dict[str, Any] = {
            'status': 'building',
            'attempt': attempt,
            'queuedAt': prior.get('queuedAt') or time.time(),
            'startedAt': time.time(),
            'phase': 'materialize',
        }
        await self._stamp(org_id, app_id, version, build)

        content_root = artifact_content_dir(str(entry.get('artifactPath') or ''))
        # The live feed carries BOTH channels for this job: batched output
        # lines (apaevt_build) and the coarse card ticker
        # (apaevt_build_status) — created here so the terminal arms below
        # can tick the card's final word.
        feed = _BuildFeed(self._server, org_id, app_id, version)
        log_parts: List[str] = []
        job_dir = ''
        try:
            # realpath is LOAD-BEARING (not hygiene): a short-path (8.3)
            # jobdir makes pnpm's --filter silently match nothing — see
            # _scratch_root. mkdtemp inherits the root's spelling; resolve
            # the final form regardless of how the root was configured.
            job_dir = os.path.realpath(
                tempfile.mkdtemp(prefix=f'app-build-{os.getpid()}-{app_id}-v{version}-', dir=_scratch_root())
            )
            await self._build(org_id, app_id, version, entry, artifact, content_root, job_dir, build, log_parts, feed)
            build.update({'status': 'ok', 'phase': 'harvest', 'endedAt': time.time()})
            build.pop('errors', None)
            await self._stamp(org_id, app_id, version, build)
            await feed.status('')  # success clears the card
            await self._notify_success(org_id, app_id, entry)
            debug(f'[app_build] {app_id} v{version}: build ok')
            return False
        except (BuildFailure, asyncio.TimeoutError) as exc:
            # USER-visible failure (compile errors, timeout): terminal for
            # this attempt set — recovery is redeploy-to-fix. The error
            # DETAIL rides build.log's failure tail (written in finally),
            # never the DB: metadata.build carries status/phase/times only.
            if isinstance(exc, asyncio.TimeoutError):
                phase = str(build.get('phase') or 'build')
                errors = [{'phase': phase, 'message': f'{phase} timed out after {_PHASE_TIMEOUTS.get(phase, 0)}s'}]
            else:
                phase, errors = exc.phase, exc.errors
            log_parts.append(
                f'== failed ({phase}) ==\n'
                + '\n'.join(f'[{e.get("phase", phase)}] {e.get("message", "")}' for e in errors[:_MAX_ERRORS])
            )
            build.update({'status': 'failed', 'phase': phase, 'endedAt': time.time()})
            build.pop('errors', None)
            await self._stamp(org_id, app_id, version, build)
            # Drain the failing phase's buffered lines BEFORE the terminal
            # tick — they are exactly the output that explains the failure.
            await feed.flush()
            await feed.status('failed')
            debug(f'[app_build] {app_id} v{version}: build failed in {phase}')
            return False
        except Exception as exc:
            # PLATFORM failure: bounded retry, then failed with the reason.
            # This arm is deliberately BROAD (user-visible failures were
            # caught above): an UNEXPECTED error — an OS quirk, a store
            # hiccup, a bug — must never strand the row in 'building' with
            # no outcome, so it rides the same infra path: the developer
            # always sees a reasoned failure and the attempt cap still
            # bounds the retries. (CancelledError is a BaseException and
            # passes through — shutdown must not mark rows failed.)
            phase = exc.phase if isinstance(exc, BuildInfraFailure) else str(build.get('phase') or 'build')
            if attempt < _MAX_ATTEMPTS:
                build.update({'status': 'queued', 'phase': phase})
                await self._stamp(org_id, app_id, version, build)
                await feed.flush()
                await feed.status('queued')
                debug(f'[app_build] {app_id} v{version}: infra failure in {phase}, requeued: {exc}')
                return True
            log_parts.append(f'== failed ({phase}) ==\n{str(exc)[:_MAX_ERROR_CHARS]}')
            build.update({'status': 'failed', 'phase': phase, 'endedAt': time.time()})
            build.pop('errors', None)
            await self._stamp(org_id, app_id, version, build)
            await feed.flush()
            await feed.status('failed')
            error(f'[app_build] {app_id} v{version}: infra failure (attempts exhausted): {exc}')
            return False
        finally:
            # Durable full log beside the artifacts — success and failure
            # alike, with the scratch paths scrubbed before the bytes leave
            # this process (the log is served to the developer).
            await self._write_log(content_root, log_parts, scrub_roots=[job_dir])
            if job_dir:
                _rmtree(job_dir)

    async def _build(
        self,
        org_id: str,
        app_id: str,
        version: int,
        entry: Dict[str, Any],
        artifact: Dict[str, Any],
        content_root: str,
        job_dir: str,
        build: Dict[str, Any],
        log_parts: List[str],
        feed: _BuildFeed,
    ) -> None:
        """The phase chain for one job (raises on any failure)."""
        from ai.account.store import Store

        raw = Store.instance()._store
        metadata = entry.get('metadata') if isinstance(entry.get('metadata'), dict) else {}
        manifest = metadata.get('manifest') if isinstance(metadata.get('manifest'), dict) else {}
        app_root = str(metadata.get('appRoot') or '')
        # appRoot is the SAME manifest-provenance input as include below —
        # handle_app_add validates it at receipt, but the shape guard
        # re-runs here before it becomes a filesystem path, so a later
        # change to the metadata writer can never turn it into traversal.
        if app_root and (
            app_root.startswith('/')
            or ':' in app_root
            or '\\' in app_root
            or '..' in app_root.split('/')
            or '.' in app_root.split('/')
        ):
            raise BuildFailure('materialize', f'appRoot has an unsafe path shape: {app_root!r}')
        # Include roots are manifest input — the same shape guard the pack
        # applies (workspace-relative, no traversal) re-runs here before any
        # of them becomes a filesystem path or an install filter.
        include_roots = [
            inc
            for inc in ((str(i) for i in (manifest.get('include') or []) if isinstance(i, str)))
            if inc
            and not inc.startswith('/')
            and ':' not in inc
            and '\\' not in inc
            and '..' not in inc.split('/')
            and '.' not in inc.split('/')
        ]
        module_id = str(artifact.get('moduleId') or app_id.replace('.', '_'))

        # ── MATERIALIZE ──────────────────────────────────────────────────
        node = _find_node()
        if not node:
            raise BuildInfraFailure(
                'materialize', 'server build toolchain unavailable: node not found (RR_BUILD_NODE/PATH)'
            )
        pnpm = _find_pnpm()
        if not pnpm:
            raise BuildInfraFailure(
                'materialize', 'server build toolchain unavailable: pnpm not found (RR_BUILD_PNPM/PATH)'
            )
        await feed.set_phase('bootstrap')
        env_dir = await _ensure_toolchain_env(on_line=feed.line)
        await feed.flush()
        build['toolchain'] = {
            'node': os.path.basename(node),
            'rsbuild': _installed_version(env_dir, '@rsbuild/core'),
            'mf': _installed_version(env_dir, '@module-federation/rsbuild-plugin'),
            'typescript': _installed_version(env_dir, 'typescript'),
        }

        ws_dir = os.path.join(job_dir, 'ws')
        os.makedirs(ws_dir, exist_ok=True)
        # ONE store fetch: the retained transport zip, unpacked locally with
        # the receipt guards re-applied. NOT per-file reads of source/ —
        # that would be up to 2000 S3 round-trips.
        import io
        import zipfile

        try:
            zip_bytes = await raw.read_bytes(f'{content_root}/bundle/{app_id}-v{version:06d}.zip')
        except Exception as exc:
            raise BuildInfraFailure('materialize', f'retained transport zip unreadable: {exc}')
        archive = zipfile.ZipFile(io.BytesIO(zip_bytes))
        for item in archive.infolist():
            name = item.filename.replace('\\', '/')
            if name.startswith('/') or '..' in name.split('/') or (len(name) > 1 and name[1] == ':'):
                raise BuildFailure('materialize', f'zip entry has an unsafe path: {item.filename!r}')
            # A shipped package tree would be resolved (and its code run)
            # in place of what pnpm installs — the client never packs one.
            if 'node_modules' in name.split('/'):
                raise BuildFailure(
                    'materialize', f'zip entry {item.filename!r} is inside node_modules — packs must not ship packages'
                )
            # '!' is the bundler's request separator. No path in the tree may
            # carry one, so a resolved request string cannot be forged by a
            # file or folder name. (pnpm-made paths are not covered by this ban; a '!'
            # there makes the guard read a loader segment it then refuses.)
            if '!' in name:
                raise BuildFailure(
                    'materialize', f"zip entry {item.filename!r} contains '!' — not allowed in app paths"
                )
            if item.is_dir():
                continue
            dest = os.path.join(ws_dir, *name.split('/'))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, 'wb') as handle:
                handle.write(archive.read(item))

        app_dir = os.path.join(ws_dir, *app_root.split('/')) if app_root else ws_dir
        if not os.path.isfile(os.path.join(app_dir, 'package.json')):
            raise BuildFailure('materialize', f'app package.json missing at {app_root or "."!r} in the source tree')

        # Workspace truth: transported verbatim + the ONE forced-overrides
        # edit; minimal fallback when the pack carried no workspace yaml.
        ws_yaml_path = os.path.join(ws_dir, 'pnpm-workspace.yaml')
        source_yaml = None
        if os.path.isfile(ws_yaml_path):
            with open(ws_yaml_path, 'r', encoding='utf-8') as handle:
                source_yaml = handle.read()
        removed = _remove_pnpm_configs(ws_dir)
        dropped: List[str] = []
        patched = _patched_workspace_yaml(source_yaml, app_root, include_roots, dropped)
        if removed or dropped:
            log_parts.append(
                '== materialize ==\nignored by the server build: '
                + ', '.join(removed + [f'pnpm-workspace.yaml:{key}' for key in dropped])
            )
        with open(ws_yaml_path, 'w', encoding='utf-8') as handle:
            handle.write(patched)
        # pnpm requires a workspace-root package.json; packs without one get
        # a minimal marker (the root's devDependencies never install anyway).
        root_pkg = os.path.join(ws_dir, 'package.json')
        if not os.path.isfile(root_pkg):
            with open(root_pkg, 'w', encoding='utf-8') as handle:
                json.dump({'name': 'rocketride-app-build-ws', 'private': True}, handle, indent=1)

        _place_platform_tgzs(ws_dir)
        neutralized = _neutralize_tool_configs(ws_dir, app_dir)
        if neutralized:
            log_parts.append(
                '== materialize ==\nneutralized by the server build (not applied): ' + ', '.join(neutralized)
            )
        _filter_env_files(app_dir)
        _link_toolchain(job_dir, env_dir)
        out_dir = os.path.join(job_dir, '.out')
        config_path = _emit_config(os.path.join(job_dir, '.build'), app_dir, out_dir, module_id, env_dir)

        # The packed lockfile (when present): pre-install pins for the skew
        # check + drift diff. Absent = the developer didn't pin; fresh
        # resolution is accepted as-is.
        lock_path = os.path.join(ws_dir, 'pnpm-lock.yaml')
        pins_before: Dict[str, Dict[str, str]] = {}
        if os.path.isfile(lock_path):
            with open(lock_path, 'r', encoding='utf-8') as handle:
                lock_text = handle.read()
            _refuse_lockfile_paths(lock_text)
            pins_before = _lockfile_importer_pins(lock_text)
            app_pins = pins_before.get(app_root or '.', {})
            react_pin = str(app_pins.get('react') or '')
            if react_pin and not react_pin.split('(', 1)[0].startswith('18.'):
                raise BuildFailure(
                    'materialize',
                    f'react {react_pin} does not satisfy the platform share contract (^18.2.0) — '
                    'the shell provides react 18 singletons at runtime',
                )

        # ── INSTALL ──────────────────────────────────────────────────────
        build['phase'] = 'install'
        await self._stamp(org_id, app_id, version, build)
        argv = [
            pnpm,
            'install',
            '--no-frozen-lockfile',
            '--ignore-scripts',
            '--ignore-pnpmfile',
            '--config.manage-package-manager-versions=false',
            '--prefer-offline',
        ]
        if app_root:
            argv += ['--filter', f'./{app_root}']
            for inc in include_roots:
                if os.path.isfile(os.path.join(ws_dir, *inc.split('/'), 'package.json')):
                    argv += ['--filter', f'./{inc}']
        await feed.set_phase('install')
        code, out = await _exec(argv, ws_dir, _PHASE_TIMEOUTS['install'], on_line=feed.line)
        await feed.flush()
        log_parts.append(f'== install ==\n$ {" ".join(argv)}\n{out}')
        if code != 0:
            raise BuildFailure('install', f'pnpm install failed (exit {code})', _tail_errors('install', out))
        if pins_before and os.path.isfile(lock_path):
            with open(lock_path, 'r', encoding='utf-8') as handle:
                drift = _drift_of(pins_before, _lockfile_importer_pins(handle.read()))
            if drift:
                raise BuildFailure(
                    'install',
                    'dependency resolution drifted from the packed lockfile',
                    [{'phase': 'install', 'message': line[:_MAX_ERROR_CHARS]} for line in drift[:_MAX_ERRORS]],
                )

        # ── TYPECHECK — the platform tsc over the user's tsconfig ────────
        build['phase'] = 'typecheck'
        await self._stamp(org_id, app_id, version, build)
        tsconfig = os.path.join(app_dir, 'tsconfig.json')
        if manifest.get('typecheck') is False:
            # The developer's explicit waiver (appManifest.typecheck: false,
            # the PACKAGE tab's checkbox): the verify gate is a QUALITY
            # gate, not a build necessity — rsbuild transpiles without it,
            # so the app deploys even with type errors. The waiver is
            # recorded in the log, never silent.
            log_parts.append('== typecheck ==\nskipped by appManifest.typecheck: false')
        elif os.path.isfile(tsconfig):
            tsc = _resolve_platform_tsc(env_dir)
            if not tsc:
                raise BuildInfraFailure('typecheck', 'baked typescript missing from the toolchain env')
            await feed.set_phase('typecheck')
            code, out = await _exec(
                [node, tsc, '--noEmit', '--incremental', 'false', '--composite', 'false', '-p', tsconfig],
                app_dir,
                _PHASE_TIMEOUTS['typecheck'],
                on_line=feed.line,
            )
            await feed.flush()
            log_parts.append(
                f'== typecheck ==\n$ node {tsc} --noEmit --incremental false --composite false -p {tsconfig}\n{out}'
            )
            if code != 0:
                raise BuildFailure('typecheck', f'tsc --noEmit failed (exit {code})', _tsc_errors(out))

        # ── BUNDLE — the platform's rsbuild + MF ─────────────────────────
        build['phase'] = 'bundle'
        await self._stamp(org_id, app_id, version, build)
        rsbuild = _resolve_bin(job_dir, '@rsbuild/core', ('rsbuild',))
        if not rsbuild:
            raise BuildInfraFailure('bundle', 'baked rsbuild missing from the toolchain env')
        await feed.set_phase('bundle')
        code, out = await _exec(
            [node, rsbuild, 'build', '--config', config_path], app_dir, _PHASE_TIMEOUTS['bundle'], on_line=feed.line
        )
        await feed.flush()
        log_parts.append(f'== bundle ==\n$ node {rsbuild} build --config {config_path}\n{out}')
        if code != 0:
            raise BuildFailure('bundle', f'rsbuild build failed (exit {code})', _tail_errors('bundle', out))
        if not os.path.isfile(os.path.join(out_dir, 'remoteEntry.js')):
            raise BuildFailure('bundle', 'build produced no remoteEntry.js — the app cannot be a federation remote')

        # ── HARVEST — local -> store dist/ + manifest assets ─────────────
        build['phase'] = 'harvest'
        await self._stamp(org_id, app_id, version, build)
        await feed.set_phase('harvest')
        # Manifest-referenced assets: rsbuild only emits what code imports,
        # and the entry token is scoped to dist/ — copy icon/readme in.
        for key in ('icon', 'readme'):
            rel = _safe_asset_rel(manifest.get(key) or '')
            if not rel:
                continue
            src = os.path.join(app_dir, *rel.split('/'))
            # The asset must really live in the app tree: a symlink (for
            # example a pnpm link under node_modules) is not followed out.
            if not _under(src, (os.path.realpath(app_dir),)):
                raise BuildFailure('harvest', f'manifest {key} {rel!r} resolves outside the app')
            if os.path.isfile(src) and not os.path.isfile(os.path.join(out_dir, *rel.split('/'))):
                dest = os.path.join(out_dir, *rel.split('/'))
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                shutil.copyfile(src, dest)
        # Bound the harvest BEFORE reading anything: reject a pathological
        # output tree reasoned here rather than stream it into the store
        # (the raw write path enforces no quota).
        total_bytes = 0
        total_files = 0
        out_root = os.path.realpath(out_dir)
        for dirpath, _dirs, files in os.walk(out_dir):
            for filename in files:
                total_files += 1
                if not _under(os.path.join(dirpath, filename), (out_root,)):
                    raise BuildFailure('harvest', 'a build output file links outside the output directory')
                try:
                    size = os.path.getsize(os.path.join(dirpath, filename))
                except OSError:
                    size = 0
                if size > _HARVEST_MAX_FILE_BYTES:
                    raise BuildFailure(
                        'harvest',
                        f'build output file {filename!r} is {size} bytes (per-file limit {_HARVEST_MAX_FILE_BYTES})',
                    )
                total_bytes += size
        if total_files > _HARVEST_MAX_FILES or total_bytes > _HARVEST_MAX_TOTAL_BYTES:
            raise BuildFailure(
                'harvest',
                f'build output exceeds limits: {total_files} file(s), {total_bytes} bytes '
                f'(limits {_HARVEST_MAX_FILES} files / {_HARVEST_MAX_TOTAL_BYTES} bytes)',
            )
        count = 0
        try:
            for dirpath, _dirs, files in os.walk(out_dir):
                for filename in files:
                    abs_path = os.path.join(dirpath, filename)
                    rel = os.path.relpath(abs_path, out_dir).replace(os.sep, '/')
                    with open(abs_path, 'rb') as handle:
                        data = handle.read()
                    await raw.write_bytes(f'{content_root}/dist/{rel}', data)
                    count += 1
        except Exception as exc:
            raise BuildInfraFailure('harvest', f'store write failed after {count} file(s): {exc}')
        log_parts.append(f'== harvest ==\n{count} file(s) -> {content_root}/dist/')

    # ── stamps, log, notifications ────────────────────────────────────────

    async def _stamp(self, org_id: str, app_id: str, version: int, build: Dict[str, Any]) -> None:
        """Persist the build blob + broadcast the org-scoped deploy event.

        Clients treat the event as cache invalidation and re-fetch versions
        rows (which carry the build fields) — no payload rides the event.
        """
        from ai.account import account

        try:
            await account.deployments_set_build(org_id, app_id, version, dict(build))
        except Exception as exc:
            error(f'[app_build] {app_id} v{version}: build stamp failed: {exc}')
        if self._server is not None:
            try:
                from ai.modules.task.deploy_events import broadcast_app_changed

                await broadcast_app_changed(self._server, org_id, app_id, 'build')
            except Exception as exc:
                debug(f'[app_build] deploy event failed: {exc}')

    async def _write_log(
        self, content_root: str, log_parts: List[str], scrub_roots: Optional[List[str]] = None
    ) -> None:
        """Write the durable full build log beside the version's artifacts.

        The ONLY home of build detail (metadata.build carries no error text)
        and the payload the ``build_log`` verb serves — so the scratch roots
        are scrubbed here, at the write, not at read time.
        """
        if not content_root or not log_parts:
            return
        try:
            from ai.account.store import Store

            text = _scrub_paths('\n\n'.join(log_parts), scrub_roots or [])
            await Store.instance()._store.write_bytes(f'{content_root}/build.log', text.encode('utf-8'))
        except Exception as exc:
            debug(f'[app_build] build.log write failed: {exc}')

    async def _notify_success(self, org_id: str, app_id: str, entry: Dict[str, Any]) -> None:
        """Refresh the deployer's open sessions — their version now serves."""
        if self._server is None:
            return
        user_id = str(((entry.get('publishedBy') or {}).get('userId')) or '')
        if not user_id:
            return
        try:
            from ai.account.manifest_push import push_refresh

            await push_refresh(self._server, user_id, source='app-build')
        except Exception as exc:
            debug(f'[app_build] refresh push failed: {exc}')


def _tsc_errors(output: str) -> List[Dict[str, str]]:
    """Tsc diagnostics -> bounded error rows (file(line,col): message)."""
    rows = [
        {'phase': 'typecheck', 'message': line.strip()[:_MAX_ERROR_CHARS]}
        for line in output.splitlines()
        if 'error TS' in line
    ]
    return rows[:_MAX_ERRORS] or _tail_errors('typecheck', output)


def _tail_errors(phase: str, output: str) -> List[Dict[str, str]]:
    """The last meaningful output lines as bounded error rows."""
    lines = [line for line in output.splitlines() if line.strip()][-30:]
    return [{'phase': phase, 'message': line[:_MAX_ERROR_CHARS]} for line in lines][-_MAX_ERRORS:] or [
        {'phase': phase, 'message': 'no output captured'}
    ]


# =============================================================================
# MODULE SINGLETON — the doors handle_app_add and the task module use
# =============================================================================

_worker: Optional[AppBuildWorker] = None


def init_worker(server: Any) -> AppBuildWorker:
    """Create (or return) the process's build worker, bound to ``server``."""
    global _worker
    if _worker is None:
        _worker = AppBuildWorker(server)
    return _worker


def get_worker() -> Optional[AppBuildWorker]:
    """The process's build worker, or None before the task module started it."""
    return _worker


def enqueue_build(server: Any, org_id: str, app_id: str, version: int) -> bool:
    """Queue one version's build (the deploy receipt's door).

    Uses the running worker when the task module started one; otherwise a
    no-op — the row stays 'queued' and the next boot's restart sweep picks
    it up (tests and minimal embeddings run no worker).
    """
    worker = _worker
    if worker is None:
        debug(f'[app_build] no worker running — {app_id} v{version} stays queued for the restart sweep')
        return False
    return worker.enqueue(org_id, app_id, version)


__all__ = ['AppBuildWorker', 'BuildFailure', 'BuildInfraFailure', 'enqueue_build', 'get_worker', 'init_worker']
