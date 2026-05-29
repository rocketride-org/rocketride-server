"""
Engine integration boundary.

Thin wrappers around ``depends.py`` (the engine's install pipeline) and
``importlib.metadata`` (the installed-version oracle). Single import surface so
the rest of the framework never touches ``depends.py`` internals directly.

Falls back gracefully when running outside the engine env (e.g., during
framework self-tests on a developer laptop) — `ensure_constraints` and
`depends` become no-ops, `read_constraints` returns an empty dict.
"""

from __future__ import annotations

import importlib
import importlib.metadata
import re
from functools import lru_cache
from pathlib import Path
from typing import Optional


def normalize_dist_name(name: str) -> str:
    """
    Normalise a package name to its PEP 503 canonical form.

    Distribution names (constraints file) and import names (our top-level
    lookups) disagree on separators: ``langchain-core`` vs ``langchain_core``.
    Collapsing ``-``/``_``/``.`` runs to a single ``-`` and lowercasing makes
    the two sides comparable.

    Args:
        name: A distribution or module name in any casing/separator style.

    Returns:
        The canonical name (lowercase, separators folded to ``-``).
    """
    return re.sub(r'[-_.]+', '-', name).strip().lower()


def _try_import_engine_depends():
    """
    Try to import the engine's ``depends`` module.

    Returns:
        The ``depends`` module when the engine env is loaded (the engine
        binary puts it on ``sys.path``); ``None`` when running outside the
        engine (e.g., framework self-tests on a developer laptop).
    """
    try:
        return importlib.import_module('depends')
    except ImportError:
        return None


def ensure_constraints() -> Optional[Path]:
    """
    Run the engine's constraint-compile step and return the path to the
    resolved ``constraints.txt``.

    Returns:
        Path to ``cache/constraints.txt`` on success; ``None`` when the engine
        env is not available (e.g., framework self-tests on a dev laptop).
    """
    mod = _try_import_engine_depends()
    if mod is None:
        return None
    fn = getattr(mod, 'ensure_constraints', None)
    if fn is None:
        return None
    try:
        return Path(fn())
    except Exception:
        return None


def depends(requirements_path: str) -> None:
    """
    Install ``requirements_path`` via the engine's ``depends()``.

    No-op when the engine env is not available, or when the file does not
    exist. ``depends._processed`` (the engine's dedup set) ensures repeat
    calls for the same file are cheap.

    Args:
        requirements_path: Absolute path to a requirements.txt file.

    Raises:
        Exception: Propagates whatever the engine's underlying ``depends()``
                   raises (typically uv resolution / network / disk errors).
                   Callers are expected to handle per-file failures and
                   decide whether to continue — see
                   :func:`cli._install_all_requirements` for the per-file
                   ``[install-failed]`` pattern. We deliberately do NOT
                   swallow the exception here: silent install failures
                   would mask real environment drift (e.g., a previously
                   installable Tier-2 bundle starting to fail) and there
                   would be no way for an operator to know coverage had
                   silently shrunk.
    """
    mod = _try_import_engine_depends()
    if mod is None:
        return
    fn = getattr(mod, 'depends', None)
    if fn is None:
        return
    if not Path(requirements_path).exists():
        return
    fn(requirements_path)


@lru_cache(maxsize=1)
def read_constraints() -> dict[str, str]:
    """
    Parse the engine's resolved constraints file into ``{package: version}``.

    Returns:
        Dict mapping each pinned package name to its resolved version.
        Empty dict when the engine env / file is unavailable.
    """
    constraints_path = ensure_constraints()
    if constraints_path is None or not constraints_path.exists():
        return {}
    pins: dict[str, str] = {}
    for raw in constraints_path.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        # `uv pip compile` emits `package==version` (sometimes followed by
        # `; marker` or trailing comment). Strip both.
        spec = line.split(';', 1)[0].split(' ', 1)[0].strip()
        if '==' not in spec:
            continue
        name, version = spec.split('==', 1)
        pins[normalize_dist_name(name)] = version.strip()
    return pins


def version_matches(spec: str, version: str) -> bool:
    """
    Test whether a version string satisfies a PEP 440 specifier.

    Used by the dispatch loop to gate manifest entries on their
    ``applies_when`` field. Validation of ``spec`` already happened at
    manifest-load time (``manifest._validate_applies_when``), so a parse
    failure here means the spec was malformed in a way that slipped past
    the loader — re-raised so the CI surface is loud.

    Args:
        spec:    PEP 440 specifier (e.g., ``"<2.0"``, ``">=1.0,<2.0"``).
        version: Installed version string from
                 :func:`installed_version` (e.g., ``"2.0.0"``).

    Returns:
        ``True`` when ``version`` falls within ``spec``; ``False`` otherwise.

    Raises:
        ImportError: When the ``packaging`` library isn't available in the
                     engine env. Almost never happens (packaging is a
                     transitive of pip/uv) — but a clear message is more
                     helpful than a silent fallback.
        Exception:   When ``spec`` or ``version`` is unparseable. Re-raised
                     by ``packaging``.
    """
    from packaging.specifiers import SpecifierSet  # local import: keep optional
    from packaging.version import Version

    return Version(version) in SpecifierSet(spec)


_SKIP_INSTALL_MARKER = 'contract-check: skip-install'
_DISABLE_MARKER = 'contract-check: disable'


def _scan_marker(req_path: Path, marker: str) -> tuple[bool, str]:
    """
    Scan a requirements file for a specific ``# contract-check: …`` marker.

    Both ``skip-install`` and ``disable`` markers share the same scanning
    logic — only the marker text differs — so they delegate here.

    Args:
        req_path: Path to a ``requirement*.txt`` file.
        marker:   The full marker text to look for after ``#`` (e.g.,
                  ``"contract-check: disable"``).

    Returns:
        ``(True, reason)`` when the marker is found, where ``reason`` is
        whatever text follows it on that comment line (stripped, with a
        leading ``"reason:"`` prefix removed if the maintainer wrote one).
        ``(False, '')`` when the marker is absent or the file is
        unreadable.
    """
    try:
        text = req_path.read_text(encoding='utf-8')
    except (OSError, UnicodeDecodeError):
        return False, ''
    for raw_line in text.splitlines():
        # Substring search anywhere on the line — consistent with the
        # extractor's `_find_ignored_lines` (which substring-matches
        # `contract-check: ignore` in comment tokens). Using substring
        # rather than "startswith after the first '#'" means a line with
        # two comments — e.g. `pkg  # note  # contract-check: disable` —
        # is still detected. Safe from false positives on package specs
        # because the marker contains ": " (colon-space), which can't
        # appear in a pip requirement line outside a comment.
        idx = raw_line.find(marker)
        if idx == -1:
            continue
        reason = raw_line[idx + len(marker) :].strip()
        if reason.lower().startswith('reason:'):
            reason = reason[len('reason:') :].strip()
        return True, reason
    return False, ''


def requirements_file_skipped(req_path: Path) -> tuple[bool, str]:
    """
    Scan a requirements.txt for the ``# contract-check: skip-install`` marker.

    A skip-install marker means "don't install this file on the default lane,
    BUT install it when ``--install-all`` is passed." Use it for heavy
    Tier-2 bundles whose install is fine on a fresh env but slow to download
    (kokoro, whisper, gliner, doctr, easyocr, sentence_transformers, vision).

    For files that should NEVER be installed (uv resolution conflicts with
    the engine's pinned env that can't be resolved at uv level), use the
    stronger :func:`requirements_file_disabled` marker instead.

    The marker is plain pip-syntax comment so the file remains valid:

        # contract-check: skip-install  reason: <short why>
        kokoro>=0.9.4
        ...

    Args:
        req_path: Path to a ``requirement*.txt`` file.

    Returns:
        ``(True, reason)`` when the file carries the marker, where
        ``reason`` is the text after the marker on its line (or empty if
        none). ``(False, '')`` when the marker is absent or the file
        can't be read.
    """
    return _scan_marker(req_path, _SKIP_INSTALL_MARKER)


def requirements_file_disabled(req_path: Path) -> tuple[bool, str]:
    """
    Scan a requirements.txt for the ``# contract-check: disable`` marker.

    A disable marker is strictly stronger than ``skip-install``: the file
    is NEVER installed by the framework, even when ``--install-all`` is
    passed. Use it for files whose packages have **fundamental
    incompatibilities** with the engine's pinned environment that uv
    cannot resolve — typically because a transitive dependency pins a
    library to a version the engine has overridden via a runtime shim.

    Canonical examples:

    * ``requirements_surya.txt`` — ``surya-ocr`` pulls
      ``opencv-python-headless==4.11.0.86`` against the engine's
      ``opencv-contrib-python==4.13.0.92`` (override comes from
      ``ai.common.opencv`` at import time, after install).
    * ``requirements_trocr.txt`` — ``craft-text-detector`` pulls
      ``opencv-python<4.5.4.62``; same kind of shim-handled override.

    Disabled files are paired with ``# contract-check: ignore`` markers on
    the consuming source's import lines (e.g.,
    ``from surya.recognition import RecognitionPredictor  # contract-check: ignore``),
    so the framework never tries to verify the contract either. Result:
    surya/trocr go completely off the framework's radar.

    Args:
        req_path: Path to a ``requirement*.txt`` file.

    Returns:
        ``(True, reason)`` when the file carries the marker, where
        ``reason`` is the text after the marker on its line. ``(False, '')``
        when the marker is absent or the file can't be read.
    """
    return _scan_marker(req_path, _DISABLE_MARKER)


def installed_version(package: str) -> Optional[str]:
    """
    Look up the installed version of a package in the engine's site-packages.

    Args:
        package: Top-level package name (e.g., ``"langchain"``,
                 ``"img2table"``).

    Returns:
        The installed version string (PEP 440) when the package's metadata
        is discoverable; ``None`` when the package is not installed or its
        metadata is unreadable.
    """
    try:
        return importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:
        return None
    except Exception:
        return None
