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

"""App source packing — the Python mirror of ``rocketride/app-pack``.

Selects and zips the files an app deploy carries, following the exact App
Builder rules (the TypeScript ``rocketride/app-pack`` module is the
canonical statement of them; keep the two in sync):

- The zip carries SOURCE only, laid out WORKSPACE-RELATIVE: the app folder
  packs at its real position (deploy metadata names it ``appRoot``) and
  ``appManifest.include`` entries pack at theirs, so relative references
  between packed roots resolve after the server unpacks.
- Filtering follows git: a hard baseline (``node_modules/``, ``dist/``,
  ``.git/`` — never re-includable by a negation) plus the workspace's
  ``.gitignore`` files applied hierarchically with git's deepest-wins
  precedence. Ignored directories are never descended into.
- ``*.rrapp`` markers always pack (deploy provenance); a pack root the
  user NAMED wins over rules that would exclude the root itself.
- Symlinks are followed only inside the workspace: a link whose real
  target escapes the workspace root is skipped (containment), and cycles
  are broken per-root.
- Caps: 512MB uncompressed (in-memory build bound), 50MB zipped (the
  server refuses larger uploads at receipt).
"""

from __future__ import annotations

import io
import json
import os
import re
import zipfile
from dataclasses import dataclass
from typing import Callable, Optional

from pathspec.gitignore import GitIgnoreSpec

# The verification report shapes are PUBLIC types (callers annotate a
# verify_app result with them), so they live in rocketride.types.deploy
from .types.deploy import AppVerifyCheck, AppVerifyReport

# App id grammar: <developerId>.<name> (mirrors the App Builder).
_APP_ID_RE = re.compile(r'^[a-z][a-z_]*\.[a-z][a-zA-Z0-9_-]*$')

# Ceiling on the UNCOMPRESSED source the deploy zip may carry (in-memory
# build bound; source-only packs never legitimately approach it).
MAX_PACK_BYTES = 512 * 1024 * 1024

# The upload cap on the ZIPPED package — the server refuses larger uploads
# at receipt, so packing fails fast client-side with the same bound.
MAX_ZIP_BYTES = 50 * 1024 * 1024

# Fixed timestamp stamped on every zip entry. The default writestr metadata
# carries the current clock, which would make two packs of identical source
# hash differently; the ZIP epoch keeps the bytes a function of content only.
ZIP_ENTRY_DATE_TIME = (1980, 1, 1, 0, 0, 0)

# Always-on excludes in gitignore syntax, anchored at the workspace root.
# Slash-less dir patterns match at every depth (git semantics). `.git/` is
# here because a real .gitignore never lists it.
_BASELINE_PATTERNS = ['node_modules/', 'dist/', '.git/']


@dataclass
class PackedApp:
    """The result of :func:`pack_app_source`."""

    data: bytes
    """The zip bytes to pass as ``deploy.add(kind='app', data=...)``."""
    app_root: str
    """Workspace-relative POSIX path of the app folder (``metadata.appRoot``)."""
    file_count: int
    """Number of files packed."""
    uncompressed_bytes: int
    """Total uncompressed bytes packed."""
    zipped_bytes: int
    """Size of the zip itself."""


@dataclass
class _Matcher:
    """An ignore matcher scoped to the directory whose rules it carries."""

    base_rel: str
    """Workspace-relative POSIX dir the rules anchor at ('' = root)."""
    spec: GitIgnoreSpec
    """The compiled matcher for that directory's patterns."""
    hard: bool = False
    """Always-on baseline exclude: a floor no negation can re-include."""


def _gitignore_matcher_of(abs_dir: str, base_rel: str) -> Optional[_Matcher]:
    """Load a directory's .gitignore, or None when absent/unreadable (like git)."""
    try:
        with open(os.path.join(abs_dir, '.gitignore'), 'r', encoding='utf-8') as f:
            return _Matcher(base_rel, GitIgnoreSpec.from_lines(f.read().splitlines()))
    except OSError:
        return None


def _scope_into(rel: str, base_rel: str) -> Optional[str]:
    """Scope a path into a matcher's base dir, or None when outside it."""
    if base_rel == '':
        return rel
    if rel.startswith(base_rel + '/'):
        return rel[len(base_rel) + 1 :]
    return None


def _is_ignored(rel: str, is_dir: bool, matchers: list[_Matcher]) -> bool:
    """Test a path against every containing matcher, following git precedence.

    1. The hard baseline wins unconditionally — node_modules/, dist/, .git/
       are never re-includable by a negation.
    2. The .gitignore matchers resolve DEEPEST-WINS: the closest directory's
       verdict (ignore or an explicit ``!`` re-include) wins; a matcher with
       no verdict defers outward. ``matchers`` is outermost-first, so this
       pass iterates it in reverse.
    """
    # step: baseline floor first
    for m in matchers:
        if not m.hard:
            continue
        scoped = _scope_into(rel, m.base_rel)
        if scoped is None:
            continue
        if m.spec.check_file(scoped + '/' if is_dir else scoped).include is True:
            return True

    # step: .gitignore precedence — deepest directory's verdict decides
    for m in reversed(matchers):
        if m.hard:
            continue
        scoped = _scope_into(rel, m.base_rel)
        if scoped is None:
            continue
        verdict = m.spec.check_file(scoped + '/' if is_dir else scoped).include
        if verdict is True:
            return True
        if verdict is False:
            return False
    return False


def _ancestor_matchers_of(workspace_root: str, root_rel: str) -> list[_Matcher]:
    """Matchers for every .gitignore on a pack root's ancestor chain.

    The workspace root's, then each intermediate directory's down to (and
    including) the root's parent; the pack root's own .gitignore is picked
    up by the walk itself when it enters the directory.
    """
    matchers: list[_Matcher] = []
    root = _gitignore_matcher_of(workspace_root, '')
    if root:
        matchers.append(root)
    segments = [] if root_rel == '' else root_rel.split('/')
    base_rel = ''
    for segment in segments[:-1]:
        base_rel = segment if base_rel == '' else f'{base_rel}/{segment}'
        found = _gitignore_matcher_of(os.path.join(workspace_root, base_rel), base_rel)
        if found:
            matchers.append(found)
    return matchers


def _is_within(root: str, target: str) -> bool:
    """SECURITY: symlink containment — True when target is inside root."""
    try:
        rel = os.path.relpath(target, root)
    except ValueError:
        # Windows raises for paths on different drives; nothing on another
        # drive is inside root, and _walk_dir catches only OSError
        return False
    return rel == '.' or (not rel.startswith('..' + os.sep) and rel != '..' and not os.path.isabs(rel))


def _walk_dir(
    abs_dir: str,
    rel_dir: str,
    contain_root: str,
    matchers: list[_Matcher],
    visited: set,
    out: dict,
) -> None:
    """Recursively collect the surviving files under one directory."""
    # step: cycle guard — a symlink loop must not walk forever
    try:
        real = os.path.realpath(abs_dir)
    except OSError:
        return
    if real in visited:
        return
    visited.add(real)

    # step: this directory's own .gitignore joins the active rule set
    own = _gitignore_matcher_of(abs_dir, rel_dir)
    active = [*matchers, own] if own else matchers

    try:
        entries = sorted(os.scandir(abs_dir), key=lambda e: e.name)
    except OSError:
        return
    for entry in entries:
        rel = entry.name if rel_dir == '' else f'{rel_dir}/{entry.name}'
        abs_path = os.path.join(abs_dir, entry.name)

        # step: classify, following symlinks (a junctioned shared dir is
        # legitimate); a broken link is silently skipped
        try:
            is_dir = entry.is_dir(follow_symlinks=False)
            is_file = entry.is_file(follow_symlinks=False)
            if entry.is_symlink():
                # step: containment (SECURITY) — a link whose real target
                # escapes the workspace is a data-exfiltration path; skip it.
                try:
                    real_target = os.path.realpath(abs_path)
                except OSError:
                    continue
                if not _is_within(contain_root, real_target):
                    continue
                is_dir = os.path.isdir(abs_path)
                is_file = os.path.isfile(abs_path)
        except OSError:
            continue

        if is_dir:
            if _is_ignored(rel, True, active):
                continue
            _walk_dir(abs_path, rel, contain_root, active, visited, out)
        elif is_file:
            # step: .rrapp markers are deploy provenance — always packed
            if not entry.name.endswith('.rrapp') and _is_ignored(rel, False, active):
                continue
            if rel not in out:
                out[rel] = abs_path


def collect_packed_files(workspace_root: str, pack_roots: list[str]) -> list[tuple[str, str]]:
    """Collect every file the deploy zip should carry.

    :param workspace_root: Absolute path of the workspace the zip is rooted at.
    :param pack_roots: Workspace-relative POSIX paths to pack (the app folder
        first, then any include entries). '' packs the workspace root itself.
    :returns: ``(zip_path, abs_path)`` pairs sorted by zip path (code-unit
        order) so the zip bytes of an immutable version are machine-identical.
    :raises ValueError: when a pack root does not exist.
    """
    out: dict = {}
    baseline = _Matcher('', GitIgnoreSpec.from_lines(_BASELINE_PATTERNS), hard=True)

    try:
        contain_root = os.path.realpath(workspace_root)
    except OSError:
        contain_root = os.path.abspath(workspace_root)

    for root_rel in pack_roots:
        abs_path = workspace_root if root_rel == '' else os.path.join(workspace_root, root_rel)
        if not os.path.exists(abs_path):
            raise ValueError(f'Pack path "{root_rel}" does not exist in the workspace.')

        if os.path.isdir(abs_path):
            # step: the named root wins over rules that would exclude it
            candidates = [baseline, *_ancestor_matchers_of(workspace_root, root_rel)]
            active = candidates if root_rel == '' else [m for m in candidates if not _is_ignored(root_rel, True, [m])]

            # step: re-anchor the hard baseline AT the named root, so a
            # deliberately-named excluded root still filters its own
            # nested node_modules/.git/dist descendants.
            if root_rel != '' and not any(m.hard for m in active):
                active.append(_Matcher(root_rel, GitIgnoreSpec.from_lines(_BASELINE_PATTERNS), hard=True))

            # Per-root cycle guard; cross-root dedup is by zip path via `out`.
            _walk_dir(abs_path, root_rel, contain_root, active, set(), out)
        elif os.path.isfile(abs_path):
            if root_rel not in out:
                out[root_rel] = abs_path

    return sorted(out.items())


def read_include_entries(
    app_folder: str,
    workspace_root: str,
    on_progress: Optional[Callable[[str], None]] = None,
) -> list[str]:
    """Read and validate the app's ``appManifest.include`` list.

    Entries are WORKSPACE-RELATIVE POSIX paths packed verbatim at those
    paths; every entry must exist — a typo fails the pack loudly.
    """
    try:
        with open(os.path.join(app_folder, 'package.json'), 'r', encoding='utf-8') as f:
            pkg = json.load(f)
    except (OSError, ValueError) as err:
        raise ValueError(f"Could not read the app's package.json: {err}") from err

    # A malformed package.json or a non-object appManifest must fail as the
    # documented ValueError: `or {}` absorbs only the falsy shapes, so a
    # string or a non-empty list would reach .get() and raise AttributeError
    if not isinstance(pkg, dict):
        raise ValueError('The app package.json must contain a JSON object.')
    block = pkg.get('appManifest')
    if block is not None and not isinstance(block, dict):
        raise ValueError('appManifest must be an object in the app package.json.')

    raw = (block or {}).get('include')
    if raw is None:
        return []
    if not isinstance(raw, list) or any(not isinstance(e, str) for e in raw):
        raise ValueError('appManifest.include must be an array of workspace-relative path strings.')

    entries: list[str] = []
    for item in raw:
        entry = item.replace('\\', '/').rstrip('/')
        if not entry:
            raise ValueError('appManifest.include contains an empty entry.')
        parts = entry.split('/')
        if entry.startswith('/') or ':' in entry or '..' in parts or '.' in parts:
            raise ValueError(
                f'appManifest.include entry "{item}" must be a plain workspace-relative path (no absolute paths, drive letters, "." or "..").'
            )
        abs_path = os.path.join(workspace_root, entry)
        if not os.path.exists(abs_path):
            if on_progress:
                on_progress(f'check include "{entry}" - FAILED: does not exist in the workspace')
            raise ValueError(f'appManifest.include entry "{entry}" does not exist in the workspace.')
        if on_progress:
            kind = 'directory' if os.path.isdir(abs_path) else 'file'
            on_progress(f'check include "{entry}" - OK ({kind})')
        entries.append(entry)
    return entries


def _resolve_app_root(workspace_root: str, app_root: str) -> tuple[str, str, str]:
    """Resolve and validate the workspace/app-root pair shared by pack and verify."""
    ws_abs = os.path.abspath(workspace_root)
    app_abs = os.path.abspath(app_root) if os.path.isabs(app_root) else os.path.abspath(os.path.join(ws_abs, app_root))
    if not os.path.isdir(app_abs):
        raise ValueError(f'App folder "{app_root}" does not exist or is not a directory.')
    rel_native = os.path.relpath(app_abs, ws_abs)
    if rel_native.startswith('..') or os.path.isabs(rel_native):
        raise ValueError(f'App folder "{app_root}" is outside the workspace root "{workspace_root}".')
    app_root_rel = '' if rel_native == '.' else rel_native.replace(os.sep, '/')
    return ws_abs, app_abs, app_root_rel


def verify_app_source(workspace_root: str, app_root: str) -> AppVerifyReport:
    """Pre-check everything an app deploy needs, WITHOUT deploying.

    Purely local: manifest shape, id grammar, declared assets, include
    entries, and a pack dry run against the size caps. Server-side concerns
    (the build, store review) are out of scope.
    """
    checks: list[AppVerifyCheck] = []

    def add(check_id: str, ok: bool, note: str) -> None:
        checks.append(AppVerifyCheck(check_id, ok, note))

    ws_abs, app_abs, app_root_rel = _resolve_app_root(workspace_root, app_root)

    # step: manifest readable + shaped
    manifest: Optional[dict] = None
    try:
        with open(os.path.join(app_abs, 'package.json'), 'r', encoding='utf-8') as f:
            # A non-object appManifest (list, string, ...) is as good as
            # absent: this is a report, so it must not raise downstream
            block = (json.load(f) or {}).get('appManifest')
            manifest = block if isinstance(block, dict) else None
        add('package-json', True, 'package.json parses')
    except (OSError, ValueError) as err:
        add('package-json', False, f'package.json unreadable: {err}')

    if manifest is None:
        add('manifest', False, 'package.json has no appManifest block')
    else:
        add('manifest', True, 'appManifest present')

        # step: identity — id grammar and name
        app_id = manifest.get('id') if isinstance(manifest.get('id'), str) else ''
        if not app_id:
            add('id', False, 'appManifest.id is missing')
        elif not _APP_ID_RE.match(app_id):
            add(
                'id',
                False,
                f'appManifest.id "{app_id}" is not <developerId>.<name> (lowercase; name may add digits/-/_)',
            )
        elif app_id.startswith('local.'):
            add(
                'id',
                True,
                f'id "{app_id}" is in the local namespace - register a developer id before publishing beyond this workspace',
            )
        else:
            add('id', True, f'id "{app_id}" is well-formed')
        name = manifest.get('name') if isinstance(manifest.get('name'), str) else ''
        add(
            'name',
            bool(name and name.strip()),
            f'display name "{name}"' if name and name.strip() else 'appManifest.name is missing or empty',
        )

        # step: declared assets must exist (app-folder-relative paths)
        for key in ('icon', 'readme'):
            declared = manifest.get(key) if isinstance(manifest.get(key), str) else ''
            if not declared:
                add(key, True, f'no {key} declared (optional; the store listing benefits from one)')
            else:
                exists = os.path.exists(os.path.join(app_abs, declared.removeprefix('./')))
                add(
                    key,
                    exists,
                    f'{key} "{declared}" exists' if exists else f'{key} "{declared}" does not exist in the app folder',
                )

    # step: include entries + the layout rule
    includes: list[str] = []
    try:
        includes = read_include_entries(app_abs, ws_abs)
        count = len(includes)
        add(
            'include',
            True,
            f'{count} include entr{"y" if count == 1 else "ies"} valid' if count else 'no include entries',
        )
    except ValueError as err:
        add('include', False, str(err))
    if app_root_rel == '' and includes:
        add(
            'include-layout',
            False,
            'appManifest.include needs the app inside a larger workspace - the workspace folder IS the app folder here',
        )

    # step: pack dry run — selection + uncompressed size vs the caps
    file_count = 0
    uncompressed = 0
    try:
        files = collect_packed_files(ws_abs, [app_root_rel, *includes])
        file_count = len(files)
        uncompressed = sum(os.path.getsize(abs_path) for _, abs_path in files)
        if file_count == 0:
            add('pack', False, f'nothing to pack under "{app_root_rel or "."}" - empty or fully ignored')
        elif uncompressed > MAX_PACK_BYTES:
            add(
                'pack',
                False,
                f'source is {uncompressed // (1024 * 1024)} MB uncompressed - over the {MAX_PACK_BYTES // (1024 * 1024)} MB cap; narrow appManifest.include or add ignores',
            )
        else:
            add(
                'pack',
                True,
                f'{file_count} files, {uncompressed} bytes uncompressed (zip cap {MAX_ZIP_BYTES // (1024 * 1024)} MB checked at pack time)',
            )
    except (ValueError, OSError) as err:
        add('pack', False, str(err))

    return AppVerifyReport(
        ok=all(c.ok for c in checks),
        checks=checks,
        file_count=file_count,
        uncompressed_bytes=uncompressed,
    )


def pack_app_source(
    workspace_root: str,
    app_root: str,
    on_progress: Optional[Callable[[str], None]] = None,
) -> PackedApp:
    """Pack an app's source into the deploy zip, exactly as the App Builder does.

    :param workspace_root: Absolute path of the workspace the zip is rooted
        at (the directory ``include`` entries are relative to).
    :param app_root: The app folder — absolute, or relative to workspace_root.
        Must be inside the workspace.
    :param on_progress: Optional per-step narration (include checks,
        per-file adds, totals) for hosts that surface pack progress.
    :raises ValueError: on a missing folder, an invalid include entry, or a
        breached size cap.
    """
    ws_abs, app_abs, app_root_rel = _resolve_app_root(workspace_root, app_root)

    # step: select the files — the app folder plus its declared includes
    includes = read_include_entries(app_abs, ws_abs, on_progress)
    files = collect_packed_files(ws_abs, [app_root_rel, *includes])
    if not files:
        raise ValueError(f'Nothing to pack under "{app_root_rel}" - is the folder empty or fully ignored?')
    if on_progress:
        extras = f', include={",".join(includes)}' if includes else ''
        on_progress(f'packing {len(files)} files (appRoot={app_root_rel or "."}{extras})')

    # step: build the zip in memory, enforcing the uncompressed cap as we go
    buffer = io.BytesIO()
    uncompressed = 0
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        for zip_path, abs_path in files:
            with open(abs_path, 'rb') as f:
                data = f.read()
            uncompressed += len(data)
            if uncompressed > MAX_PACK_BYTES:
                if on_progress:
                    on_progress(f'pack ABORTED - source exceeds {MAX_PACK_BYTES // (1024 * 1024)} MB')
                raise ValueError(
                    f'Pack exceeds {MAX_PACK_BYTES // (1024 * 1024)}MB uncompressed - narrow appManifest.include or add ignores.'
                )
            # An explicit ZipInfo carries the fixed timestamp; it must also
            # restate the compression and mode that writestr's own default
            # ZipInfo would have applied
            info = zipfile.ZipInfo(zip_path, date_time=ZIP_ENTRY_DATE_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            zf.writestr(info, data)
            if on_progress:
                on_progress(f'+ {zip_path} ({len(data)} bytes)')
    zipped = buffer.getvalue()
    if len(zipped) > MAX_ZIP_BYTES:
        if on_progress:
            on_progress(
                f'pack ABORTED - {len(zipped) // (1024 * 1024)} MB zipped exceeds the {MAX_ZIP_BYTES // (1024 * 1024)} MB upload cap'
            )
        raise ValueError(
            f'Zip exceeds {MAX_ZIP_BYTES // (1024 * 1024)}MB - the server refuses larger uploads; narrow appManifest.include or add ignores.'
        )
    if on_progress:
        on_progress(f'pack complete - {len(files)} files, {uncompressed} bytes source, {len(zipped)} bytes zipped')

    return PackedApp(
        data=zipped,
        app_root=app_root_rel,
        file_count=len(files),
        uncompressed_bytes=uncompressed,
        zipped_bytes=len(zipped),
    )
