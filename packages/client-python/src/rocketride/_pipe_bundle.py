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

"""The pipeline bundle packer — the publish unit of a pipeline (plan 9, B7).

A pipeline publishes as a FOLDER: ``pipelines/<pipeId>/`` holding exactly one
``.pipe`` (what runs), beside the store manifest ``<stem>.rrpipe`` (display
only: name, tagline, description, category, tags, icon, links, mode, plans;
never publisher or author, which the server derives), ``readme.md`` (the
store page), an icon, and ``assets/`` (the images the readme references).
:func:`pack_pipe_bundle` reads that folder and builds the zip the deploy door
takes as ``data`` beside the pipeline dict (pipe-at-root layout, deterministic
entries). The TypeScript twin is ``rocketride/app-pack``'s ``packPipeBundle``.
"""

import io
import json
import os
import zipfile
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# ==== Limits ==================================================================

#: Fixed timestamp stamped on every zip entry (the app packer's value): two
#: packs of one folder hash the same. Restated here rather than imported so
#: the bundle packer never pulls the app packer's gitignore dependency.
ZIP_ENTRY_DATE_TIME = (1980, 1, 1, 0, 0, 0)

#: The icon cap (mirrors the app packer's MAX_ICON_BYTES).
MAX_ICON_BYTES = 256 * 1024

#: The cap on one readme image (mirrors the app packer's MAX_README_IMAGE_BYTES).
MAX_README_IMAGE_BYTES = 10 * 1024 * 1024

#: The readme cap (a store page, not a book).
MAX_PIPE_README_BYTES = 1024 * 1024

#: The manifest cap.
MAX_PIPE_MANIFEST_BYTES = 64 * 1024

#: The readme file name the store page reads.
PIPE_README_NAME = 'readme.md'

#: The folder of images the readme references.
PIPE_ASSETS_DIR = 'assets'

#: The icon file names a bundle may carry, in preference order.
PIPE_ICON_NAMES = ('icon.svg', 'icon.png')

#: Manifest keys the server accepts; anything else is refused at pack time.
_MANIFEST_KEYS = frozenset({'name', 'tagline', 'description', 'category', 'tags', 'icon', 'links', 'mode', 'plans'})

_MODES = ('free', 'subscription', 'paywall')


# ==== Types ===================================================================


@dataclass
class PackedPipeBundle:
    """The result of :func:`pack_pipe_bundle`."""

    pipeline: Dict[str, Any]
    """The pipeline dict (the ``.pipe`` JSON, display ``name`` filled)."""
    manifest: Dict[str, Any]
    """The manifest as read (empty when the folder has none)."""
    data: bytes
    """The zip bytes to pass as ``deploy.add(pipeline, kind='pipe', data=...)``."""
    files: List[str] = field(default_factory=list)
    """Bundle-relative paths packed, in zip order."""


# ==== Folder ==================================================================


def pipe_bundle_folder_of(target: str) -> Optional[str]:
    """The bundle folder of a path, or None when the path is not a bundle.

    The folder itself, or the folder of a ``.pipe`` that is the only pipe in
    it. A bare pipe beside other pipes, or no pipe at all, is not a bundle
    (the B7 refusal).

    Args:
        target: A folder or a ``.pipe`` file.

    Returns:
        The bundle folder, or None.
    """
    if not os.path.exists(target):
        return None
    folder = target if os.path.isdir(target) else os.path.dirname(target) or '.'
    pipes = [name for name in os.listdir(folder) if name.endswith('.pipe')]
    if len(pipes) != 1:
        return None
    if not os.path.isdir(target) and os.path.basename(target) != pipes[0]:
        return None
    return folder


def pipe_of_bundle(folder: str) -> tuple[str, str]:
    """The one ``.pipe`` of a bundle folder and its stem.

    Args:
        folder: The bundle folder.

    Returns:
        ``(file, stem)``.

    Raises:
        ValueError: The folder holds no pipe or more than one.
    """
    pipes = sorted(name for name in os.listdir(folder) if name.endswith('.pipe'))
    if not pipes:
        raise ValueError(f'{folder} holds no .pipe file - a pipeline bundle is one folder with one .pipe')
    if len(pipes) > 1:
        raise ValueError(f'{folder} holds {len(pipes)} .pipe files - a pipeline bundle is one folder with one .pipe')
    return os.path.join(folder, pipes[0]), pipes[0][: -len('.pipe')]


# ==== Manifest ================================================================


def read_pipe_manifest(folder: str, stem: str) -> Dict[str, Any]:
    """Read and check the bundle's ``<stem>.rrpipe``.

    Args:
        folder: The bundle folder.
        stem: The pipe's stem.

    Returns:
        The manifest, or an empty dict when the file is absent.

    Raises:
        ValueError: Unparseable JSON, an unknown key, a bad mode, or an icon path outside the folder.
    """
    path = os.path.join(folder, f'{stem}.rrpipe')
    if not os.path.exists(path):
        return {}
    with open(path, 'rb') as handle:
        raw = handle.read()
    if len(raw) > MAX_PIPE_MANIFEST_BYTES:
        raise ValueError(f'{stem}.rrpipe exceeds {MAX_PIPE_MANIFEST_BYTES} bytes')
    try:
        parsed = json.loads(raw.decode('utf-8'))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError(f'{stem}.rrpipe is not valid JSON: {exc}') from exc
    if not isinstance(parsed, dict):
        raise ValueError(f'{stem}.rrpipe must hold a JSON object')
    unknown = [key for key in parsed if key not in _MANIFEST_KEYS]
    if unknown:
        raise ValueError(f'{stem}.rrpipe: unknown key "{unknown[0]}" (allowed: {", ".join(sorted(_MANIFEST_KEYS))})')
    if 'mode' in parsed and parsed['mode'] not in _MODES:
        raise ValueError(f'{stem}.rrpipe: mode must be free, subscription or paywall')
    tags = parsed.get('tags')
    if tags is not None and (not isinstance(tags, list) or any(not isinstance(t, str) for t in tags)):
        raise ValueError(f'{stem}.rrpipe: tags must be a list of strings')
    icon = parsed.get('icon')
    if icon is not None:
        rel = str(icon).replace('\\', '/')
        if rel.startswith('/') or '..' in rel.split('/'):
            raise ValueError(f'{stem}.rrpipe: icon must be a path inside the bundle')
    return parsed


# ==== Pack ====================================================================


def pack_pipe_bundle(folder: str) -> PackedPipeBundle:
    """Pack a pipeline bundle folder into the deploy zip.

    Entries: the ``.pipe``, the ``.rrpipe`` when present, ``readme.md`` when
    present, the icon (the manifest's, else the first of
    :data:`PIPE_ICON_NAMES` found), and every file under ``assets/``.
    Nothing else in the folder is packed.

    Args:
        folder: The bundle folder (``pipelines/<pipeId>/``).

    Returns:
        The pipeline dict, the manifest and the zip.

    Raises:
        ValueError: A malformed folder, an unparseable pipe or manifest, or a breached cap.
    """
    # Step 1: the one pipe, parsed (the artifact the server snapshots)
    pipe_file, stem = pipe_of_bundle(folder)
    with open(pipe_file, 'rb') as handle:
        pipe_bytes = handle.read()
    try:
        pipe = json.loads(pipe_bytes.decode('utf-8'))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError(f'{os.path.basename(pipe_file)} is not valid JSON: {exc}') from exc
    if not isinstance(pipe, dict):
        raise ValueError(f'{os.path.basename(pipe_file)} must hold a JSON object')

    # Step 2: the manifest; the display name falls back pipe -> manifest -> stem
    manifest = read_pipe_manifest(folder, stem)
    pipeline = {**pipe, 'name': str(pipe.get('name') or manifest.get('name') or stem)}

    # Step 3: the content files, each under its cap
    buffer = io.BytesIO()
    files: List[str] = []
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as zf:

        def add(rel: str, data: bytes) -> None:
            """One deterministic entry."""
            info = zipfile.ZipInfo(rel, date_time=ZIP_ENTRY_DATE_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            zf.writestr(info, data)
            files.append(rel)

        add(os.path.basename(pipe_file), pipe_bytes)
        manifest_path = os.path.join(folder, f'{stem}.rrpipe')
        if os.path.exists(manifest_path):
            with open(manifest_path, 'rb') as handle:
                add(f'{stem}.rrpipe', handle.read())
        readme_path = os.path.join(folder, PIPE_README_NAME)
        if os.path.exists(readme_path):
            with open(readme_path, 'rb') as handle:
                readme = handle.read()
            if len(readme) > MAX_PIPE_README_BYTES:
                raise ValueError(f'{PIPE_README_NAME} exceeds {MAX_PIPE_README_BYTES} bytes')
            add(PIPE_README_NAME, readme)
        icon_rel = str(manifest['icon']).replace('\\', '/') if manifest.get('icon') else None
        if icon_rel is None:
            icon_rel = next((name for name in PIPE_ICON_NAMES if os.path.exists(os.path.join(folder, name))), None)
        if icon_rel:
            icon_path = os.path.join(folder, icon_rel)
            if not os.path.exists(icon_path):
                raise ValueError(f'the manifest names icon "{icon_rel}" but the bundle has no such file')
            with open(icon_path, 'rb') as handle:
                icon = handle.read()
            if len(icon) > MAX_ICON_BYTES:
                raise ValueError(f'{icon_rel} exceeds {MAX_ICON_BYTES} bytes')
            add(icon_rel, icon)
        assets_dir = os.path.join(folder, PIPE_ASSETS_DIR)
        if os.path.isdir(assets_dir):
            for root, dirs, names in os.walk(assets_dir):
                dirs.sort()
                for name in sorted(names):
                    abs_path = os.path.join(root, name)
                    rel = os.path.relpath(abs_path, folder).replace(os.sep, '/')
                    with open(abs_path, 'rb') as handle:
                        data = handle.read()
                    if len(data) > MAX_README_IMAGE_BYTES:
                        raise ValueError(f'{rel} exceeds {MAX_README_IMAGE_BYTES} bytes')
                    add(rel, data)
    return PackedPipeBundle(pipeline=pipeline, manifest=manifest, data=buffer.getvalue(), files=files)
