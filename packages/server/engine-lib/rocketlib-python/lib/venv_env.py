# =============================================================================
# MIT License — Copyright (c) 2026 Aparavi Software AG
# (full text in depends.py)
# =============================================================================

"""Per-environment overlay layout and scoped-install planning for RocketRide venvs.

Implements the directory model and pre-install planning from design §4.9 / §4.7:
every environment (``main`` or an isolated group) gets its own overlay under
``<exe>/venvs/<proj>/<env>/`` holding ``site-packages/`` + a scoped
``combined.txt`` / ``constraints.txt`` / ``requirements.hash`` + an install lock.
Paths are keyed by **shortened** stable ids (first 8 chars) to stay under the
Windows ``MAX_PATH`` limit (a 36-char GUID nested above deep torch/nvidia paths
overflows 260).

This module is **pure and engine-free** (stdlib only, no ``engLib``/``uv``, no
subprocess, no ``sys.path`` mutation), so it is unit-testable in isolation and
parameterized by explicit roots. The caller (``depends.py``) layers the actual
``uv`` compile/install and the ``sys.path.insert`` overlay on top.

The tiny hash/combine helpers here mirror ``depends.py`` on purpose to avoid
importing it (which pulls ``engLib``); keep them in sync until ``depends.py`` is
refactored to consume this module directly.
"""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from typing import Optional

# env_id for the always-present base-of-the-pipeline environment.
MAIN_ENV = 'main'
# env / project id used when there is no project_id (engtest, CLI, ad-hoc — §4.14).
DEFAULT_ID = 'default'

_ID_MAX = 8  # chars kept from a long (GUID-like) id segment; short ids kept whole.


# ---------------------------------------------------------------------------
# the ROCKETRIDE_SERVER_USE_VENV master switch (§4.15)
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
    the pipeline opts in via an isolated group (§4.15).
    """
    if mode == USE_OFF:
        return False
    if mode == USE_ON:
        return True
    return has_isolated_group


# ---------------------------------------------------------------------------
# id shortening + directory layout (§4.9)
# ---------------------------------------------------------------------------


def short_id(identifier: Optional[str], length: int = _ID_MAX) -> str:
    """Shorten a stable id to a filesystem-safe, MAX_PATH-friendly segment.

    Long (GUID-like) ids are truncated to ``length`` chars; short readable ids
    (``main``, ``group_1``) are kept whole (minus separators). ``None`` / empty ->
    :data:`DEFAULT_ID`.

    Collisions between two long ids sharing a prefix are the accepted MAX_PATH
    trade-off (design §4.9); short group ids within one project stay distinct.
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
    ``main`` or a group node id. Both are shortened (§4.9). Missing ``project_id``
    falls back to a shared ``default`` project (§4.14).
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

    Does **no** subprocess work — it prepares everything the caller needs to run
    ``uv`` (or to skip when the env is already up to date).

    Args:
        exe_dir: The engine executable directory (``dirname(sys.executable)``).
        project_id: Pipe id, or ``None`` -> shared ``default`` project (§4.14).
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
# internal
# ---------------------------------------------------------------------------


def _read_text(path: str) -> Optional[str]:
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            return fh.read().strip()
    except FileNotFoundError:
        return None
