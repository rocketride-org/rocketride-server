# =============================================================================
# MIT License — Copyright (c) 2026 Aparavi Software AG
# (full text in depends.py)
# =============================================================================

"""Per-environment overlay layout and scoped-install planning.

Every environment (``main`` or an isolated group) gets its own overlay under
``<exe>/venvs/<proj>/<env>/`` holding ``site-packages/`` plus its own
``combined.txt`` / ``constraints.txt`` / ``requirements.hash`` and an install lock.
Ids are shortened to stay under the Windows ``MAX_PATH`` limit.

Stdlib only — no engine, ``uv``, subprocess or ``sys.path`` mutation — so it is
testable in isolation; ``depends.py`` layers the actual compile/install on top.
The hash/combine helpers mirror ``depends.py`` to avoid importing it (that would
pull in ``engLib``); keep them in sync.
"""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from typing import Optional

# env_id for the always-present base-of-the-pipeline environment.
MAIN_ENV = 'main'
# Used when there is no project_id (engtest, CLI, ad-hoc runs).
DEFAULT_ID = 'default'

_ID_MAX = 8  # chars kept from a long (GUID-like) id segment; short ids kept whole.


# ---------------------------------------------------------------------------
# the ROCKETRIDE_SERVER_USE_VENV switch
# ---------------------------------------------------------------------------

# Resolved states of the switch.
USE_AUTO = 'auto'  # unset: scope per-env only if the pipeline has an isolated group
USE_OFF = 'off'  # '0': never partition/scope — today's global-glob behavior (legacy)
USE_ON = 'on'  # '1': force the scoped/venv machinery on


def use_venv_mode(env: Optional[dict] = None) -> str:
    """Resolve the ``ROCKETRIDE_SERVER_USE_VENV`` switch to ``auto`` / ``off`` / ``on``.

    Args:
        env: Environment mapping to read (defaults to ``os.environ``); injectable
            for tests.

    Returns:
        ``USE_OFF`` for ``'0'``, ``USE_ON`` for ``'1'``, ``USE_AUTO`` otherwise
        (unset / any other value).
    """
    raw = (env if env is not None else os.environ).get('ROCKETRIDE_SERVER_USE_VENV')
    if raw is None:
        return USE_AUTO
    raw = raw.strip()
    if raw == '0':
        return USE_OFF
    if raw == '1':
        return USE_ON
    return USE_AUTO


def scoping_enabled(mode: str, has_isolated_group: bool) -> bool:
    """Whether per-environment scoping applies for this run.

    ``off`` -> never (legacy global-glob); ``on`` -> always; ``auto`` -> only when
    the pipeline opts in via an isolated group.
    """
    if mode == USE_OFF:
        return False
    if mode == USE_ON:
        return True
    return has_isolated_group


# ---------------------------------------------------------------------------
# id shortening + directory layout
# ---------------------------------------------------------------------------


def short_id(identifier: Optional[str], length: int = _ID_MAX) -> str:
    """Shorten a stable id to a filesystem-safe, MAX_PATH-friendly segment.

    Long (GUID-like) ids are truncated to ``length`` chars; short readable ids
    (``main``, ``group_1``) are kept whole (minus separators). ``None`` / empty ->
    :data:`DEFAULT_ID`.

    Collisions between two long ids sharing a prefix are the accepted MAX_PATH
    trade-off; short group ids within one project stay distinct.
    """
    if not identifier:
        return DEFAULT_ID
    cleaned = re.sub(r'[^A-Za-z0-9]', '', str(identifier)).lower()
    if not cleaned:
        return DEFAULT_ID
    return cleaned[:length] if len(cleaned) > length else cleaned


def venv_root(exe_dir: str) -> str:
    """The top-level ``venvs/`` directory (sibling of ``lib/`` and ``cache/``)."""
    return os.path.join(exe_dir, 'venvs')


def env_dir(exe_dir: str, project_id: Optional[str], env_id: Optional[str]) -> str:
    """Overlay directory for one environment: ``<exe>/venvs/<proj>/<env>``.

    ``project_id`` is the pipe id (``config.pipeline.project_id``); ``env_id`` is
    ``main`` or a group node id. Both are shortened. Missing ``project_id`` falls
    back to a shared ``default`` project.
    """
    return os.path.join(venv_root(exe_dir), short_id(project_id), short_id(env_id or MAIN_ENV))


@dataclass
class EnvPaths:
    """Resolved on-disk paths for one environment overlay."""

    env_dir: str
    site_packages: str
    combined: str
    constraints: str
    hash_file: str
    lock_file: str


def env_paths(directory: str) -> EnvPaths:
    """Return the standard file layout inside an environment overlay ``directory``."""
    return EnvPaths(
        env_dir=directory,
        site_packages=os.path.join(directory, 'site-packages'),
        combined=os.path.join(directory, 'combined.txt'),
        constraints=os.path.join(directory, 'constraints.txt'),
        hash_file=os.path.join(directory, 'requirements.hash'),
        lock_file=os.path.join(directory, 'install.lock'),
    )


# ---------------------------------------------------------------------------
# hash-drift planning (per-env; mirrors depends.py helpers)
# ---------------------------------------------------------------------------


def requirements_hash(req_files: list[str]) -> str:
    """Fast content hash of a requirement-file set (path + size + mtime_ns).

    Mirrors ``depends._compute_hash`` so a per-env overlay reuses the same drift
    semantics without importing ``depends`` (which needs ``engLib``).
    """
    hasher = hashlib.md5()
    for path in sorted(req_files):
        stat = os.stat(path)
        hasher.update(f'{path}:{stat.st_size}:{stat.st_mtime_ns}\n'.encode())
    return hasher.hexdigest()


def write_combined(req_files: list[str], combined_path: str) -> None:
    """Concatenate ``req_files`` into ``combined_path`` (mirrors depends helper)."""
    with open(combined_path, 'w', encoding='utf-8') as out:
        for path in req_files:
            out.write(f'# Source: {path}\n')
            with open(path, 'r', encoding='utf-8') as inp:
                out.write(inp.read())
            out.write('\n')


@dataclass
class InstallPlan:
    """Result of planning a scoped install for one environment."""

    paths: EnvPaths
    current_hash: str
    needs_rebuild: bool


def plan_install(
    exe_dir: str,
    project_id: Optional[str],
    env_id: Optional[str],
    req_files: list[str],
    create: bool = True,
) -> InstallPlan:
    """Plan a scoped install: resolve the overlay, compute drift, write the combined file.

    Prepares what the caller needs to run ``uv``, or to skip when already up to date.

    Args:
        exe_dir: The engine executable directory (``dirname(sys.executable)``).
        project_id: Pipe id, or ``None`` for the shared ``default`` project.
        env_id: ``main`` or a group id.
        req_files: The environment's requirement-file set (from ``ast_deps``).
        create: Create the overlay directory tree when ``True``.

    Returns:
        An :class:`InstallPlan`. ``needs_rebuild`` is ``True`` when the stored hash
        differs (or the constraints file is missing); write the combined file only
        then, run ``uv``, and finally :func:`mark_installed`.
    """
    paths = env_paths(env_dir(exe_dir, project_id, env_id))
    if create:
        os.makedirs(paths.site_packages, exist_ok=True)

    current = requirements_hash(req_files) if req_files else ''
    stored = _read_text(paths.hash_file)
    needs = (current != stored) or not os.path.exists(paths.constraints)

    if needs and create and req_files:
        write_combined(req_files, paths.combined)

    return InstallPlan(paths=paths, current_hash=current, needs_rebuild=needs)


def mark_installed(plan: InstallPlan) -> None:
    """Persist the plan's hash after a successful install (drift baseline)."""
    with open(plan.paths.hash_file, 'w', encoding='utf-8') as fh:
        fh.write(plan.current_hash)


# ---------------------------------------------------------------------------
# uv install-argv builder (scoped to the overlay via --target)
# ---------------------------------------------------------------------------


def build_install_argv(
    uv_path: str,
    python_exe: str,
    requirements_path: str,
    target_site: str,
    constraints_path: Optional[str] = None,
    excludes_path: Optional[str] = None,
) -> list[str]:
    """Construct the ``uv pip install --target`` argv for a per-env overlay.

    Mirrors ``depends.py``'s install flags, adding ``--target`` so packages land
    in the environment's overlay ``site-packages`` instead of the base runtime.
    Pure (returns the list; the caller runs it) so it is unit-testable.
    """
    argv = [
        uv_path,
        'pip',
        'install',
        '--python',
        python_exe,
        '--target',
        target_site,
        '-r',
        requirements_path,
        '--index-strategy',
        'unsafe-best-match',
        '--no-build-isolation',
    ]
    if constraints_path:
        argv += ['-c', constraints_path]
    if excludes_path:
        argv += ['--excludes', excludes_path]
    return argv


# ---------------------------------------------------------------------------
# scoped-install orchestration (side effects injected -> unit-testable)
# ---------------------------------------------------------------------------


def run_scoped_install(
    exe_dir: str,
    project_id: Optional[str],
    env_id: Optional[str],
    providers,
    *,
    discover,
    compile_and_install,
    mode: Optional[str] = None,
    has_isolated_group: bool = False,
    on_overlay=None,
) -> Optional[str]:
    """Orchestrate a scoped per-environment install; return the overlay site-packages.

    Control flow only — the side effects are injected, so this is testable without an
    engine or ``uv``: ``discover(providers)`` yields the env's requirement files,
    ``compile_and_install(plan)`` runs uv, and the optional ``on_overlay(site)`` applies
    the overlay.

    Installs only when the requirement set drifted. Returns ``None`` when scoping does
    not apply, leaving the caller on the base runtime.
    """
    if mode is None:
        mode = use_venv_mode()
    if not scoping_enabled(mode, has_isolated_group):
        return None
    req_files = list(discover(providers))
    if not req_files:
        # Nothing to scope (source-only endpoint, or all-native nodes): must not try to
        # compile an absent combined file — leave the base runtime in place.
        return None
    plan = plan_install(exe_dir, project_id, env_id, req_files)
    if plan.needs_rebuild:
        compile_and_install(plan)
        mark_installed(plan)
    if on_overlay is not None:
        on_overlay(plan.paths.site_packages)
    return plan.paths.site_packages


# ---------------------------------------------------------------------------
# internal
# ---------------------------------------------------------------------------


def _read_text(path: str) -> Optional[str]:
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            return fh.read().strip()
    except FileNotFoundError:
        return None
