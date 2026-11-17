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

"""The pipeline BUNDLE on the server side (plan 9, B7): read the zip, shape the manifest, store the content.

A pipeline publishes as a folder, ``pipelines/<pipeId>/``: exactly one
``.pipe`` (what runs — the artifact the registry snapshots), beside the store
manifest ``<stem>.rrpipe`` (display only), ``readme.md`` (the store page), an
icon, and ``assets/`` (the images the readme references). The client packs
the folder into one zip (pipe-at-root layout) and sends it as the binary
``data`` frame of ``rrext_deploy add kind='pipe'`` beside the pipeline dict.

This module is the door's bundle half: :func:`read_pipe_bundle` parses and
guards the zip and checks the manifest, :func:`pipe_manifest` shapes the
``metadata.manifest`` the publish row snapshots (never publisher or author:
those are derived, plan S7), and :func:`write_pipe_content` stores the
content files under the artifact's sibling content dir (``source/``, the app
convention), compensating like the app door. The zip guards are the app
door's (``app_deploy._zip_guard``): one bomb rule for every kind.
"""

import io
import json
import zipfile
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from rocketlib import debug

from ai.account.deployment_backend import artifact_content_dir

# ==== Limits ==================================================================

#: The readme cap (a store page, not a book).
MAX_PIPE_README_BYTES = 1024 * 1024

#: The manifest cap.
MAX_PIPE_MANIFEST_BYTES = 64 * 1024

#: The icon cap (the app packer's bound).
MAX_PIPE_ICON_BYTES = 256 * 1024

#: The cap on one readme image (the app packer's bound).
MAX_PIPE_IMAGE_BYTES = 10 * 1024 * 1024

#: The readme file name the store page reads.
PIPE_README_NAME = 'readme.md'

#: The folder of images the readme references.
PIPE_ASSETS_DIR = 'assets'

#: The icon file names a bundle may carry, in preference order.
PIPE_ICON_NAMES = ('icon.svg', 'icon.png')

#: Manifest keys the door accepts; anything else refuses the deploy.
MANIFEST_KEYS = frozenset({'name', 'tagline', 'description', 'category', 'tags', 'icon', 'links', 'mode', 'plans'})

#: The listing modes, the app model (plan 8.4).
MANIFEST_MODES = ('free', 'subscription', 'paywall')


# ==== Types ===================================================================


@dataclass
class PipeBundle:
    """One parsed bundle zip."""

    pipeline: Dict[str, Any]
    """The pipe's JSON (the artifact)."""
    stem: str
    """The pipe file's stem."""
    manifest: Dict[str, Any]
    """The ``.rrpipe`` manifest (empty when absent)."""
    readme: Optional[str]
    """The readme entry name when present."""
    icon: Optional[str]
    """The icon entry name when present."""
    assets: List[str] = field(default_factory=list)
    """The ``assets/`` entry names."""
    archive: Any = None
    """The open zip (content is read from it at write time)."""

    @property
    def content_entries(self) -> List[str]:
        """Every entry stored beside the artifact: manifest, readme, icon, assets (never the pipe itself)."""
        names: List[str] = []
        if self.manifest_entry:
            names.append(self.manifest_entry)
        if self.readme:
            names.append(self.readme)
        if self.icon:
            names.append(self.icon)
        names.extend(self.assets)
        return names

    @property
    def manifest_entry(self) -> Optional[str]:
        """The manifest entry name when the zip carried one."""
        name = f'{self.stem}.rrpipe'
        return name if self.archive is not None and name in self.archive.namelist() else None


# ==== Read ====================================================================


def _check_manifest(stem: str, raw: bytes) -> Dict[str, Any]:
    """Parse and check a ``.rrpipe`` (the same rules the client packers apply)."""
    if len(raw) > MAX_PIPE_MANIFEST_BYTES:
        raise ValueError(f'{stem}.rrpipe exceeds {MAX_PIPE_MANIFEST_BYTES} bytes')
    try:
        parsed = json.loads(raw.decode('utf-8'))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError(f'{stem}.rrpipe is not valid JSON: {exc}') from exc
    if not isinstance(parsed, dict):
        raise ValueError(f'{stem}.rrpipe must hold a JSON object')
    unknown = [key for key in parsed if key not in MANIFEST_KEYS]
    if unknown:
        raise ValueError(f'{stem}.rrpipe: unknown key "{unknown[0]}" (allowed: {", ".join(sorted(MANIFEST_KEYS))})')
    if 'mode' in parsed and parsed['mode'] not in MANIFEST_MODES:
        raise ValueError(f'{stem}.rrpipe: mode must be free, subscription or paywall')
    tags = parsed.get('tags')
    if tags is not None and (not isinstance(tags, list) or any(not isinstance(t, str) for t in tags)):
        raise ValueError(f'{stem}.rrpipe: tags must be a list of strings')
    for key in ('name', 'tagline', 'description', 'category'):
        if key in parsed and not isinstance(parsed[key], str):
            raise ValueError(f'{stem}.rrpipe: {key} must be a string')
    links = parsed.get('links')
    if links is not None and (not isinstance(links, dict) or any(not isinstance(v, str) for v in links.values())):
        raise ValueError(f'{stem}.rrpipe: links must be an object of strings')
    if 'plans' in parsed and not isinstance(parsed['plans'], list):
        raise ValueError(f'{stem}.rrpipe: plans must be a list')
    icon = parsed.get('icon')
    if icon is not None:
        rel = str(icon).replace('\\', '/')
        if rel.startswith('/') or '..' in rel.split('/'):
            raise ValueError(f'{stem}.rrpipe: icon must be a path inside the bundle')
    return parsed


def read_pipe_bundle(data: bytes) -> PipeBundle:
    """Parse and guard a bundle zip.

    Args:
        data: The zip bytes (the ``data`` frame).

    Returns:
        The bundle: the pipe's JSON, the manifest and the content entry names.

    Raises:
        ValueError: Not a zip, an unsafe or oversized archive, not exactly
            one ``.pipe`` at the root, an unparseable pipe or manifest, an
            entry over its cap, or an entry the bundle layout does not know.
    """
    # Deferred: the zip guard has one home on the app door; app_deploy
    # imports this package's siblings
    from ai.account.app_deploy import _zip_guard

    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ValueError('data is not a valid zip archive (the pipeline bundle)') from exc
    guard_error = _zip_guard(archive)
    if guard_error:
        raise ValueError(guard_error)

    # Step 1: exactly one .pipe at the root
    names = [n for n in archive.namelist() if not n.endswith('/')]
    pipes = [n for n in names if n.endswith('.pipe') and '/' not in n]
    if len(pipes) != 1:
        raise ValueError(f'a pipeline bundle holds exactly one .pipe at its root ({len(pipes)} found)')
    stem = pipes[0][: -len('.pipe')]
    try:
        pipeline = json.loads(archive.read(pipes[0]).decode('utf-8'))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError(f'{pipes[0]} is not valid JSON: {exc}') from exc
    if not isinstance(pipeline, dict) or not pipeline:
        raise ValueError(f'{pipes[0]} must hold a non-empty JSON object')

    # Step 2: the manifest, the readme, the icon, the assets; nothing else
    manifest: Dict[str, Any] = {}
    readme: Optional[str] = None
    icon: Optional[str] = None
    assets: List[str] = []
    manifest_name = f'{stem}.rrpipe'
    wanted_icon = ''
    if manifest_name in names:
        manifest = _check_manifest(stem, archive.read(manifest_name))
        wanted_icon = str(manifest.get('icon') or '').replace('\\', '/')
    for name in names:
        if name == pipes[0] or name == manifest_name:
            continue
        info = archive.getinfo(name)
        if name == PIPE_README_NAME:
            if info.file_size > MAX_PIPE_README_BYTES:
                raise ValueError(f'{PIPE_README_NAME} exceeds {MAX_PIPE_README_BYTES} bytes')
            readme = name
        elif name == wanted_icon or (not wanted_icon and name in PIPE_ICON_NAMES):
            if info.file_size > MAX_PIPE_ICON_BYTES:
                raise ValueError(f'{name} exceeds {MAX_PIPE_ICON_BYTES} bytes')
            # The manifest's icon wins; the first default name otherwise
            if icon is None or name == wanted_icon:
                icon = name
        elif name.startswith(f'{PIPE_ASSETS_DIR}/'):
            if info.file_size > MAX_PIPE_IMAGE_BYTES:
                raise ValueError(f'{name} exceeds {MAX_PIPE_IMAGE_BYTES} bytes')
            assets.append(name)
        else:
            raise ValueError(
                f'{name!r} is not part of a pipeline bundle (one .pipe, <stem>.rrpipe, readme.md, an icon, assets/)'
            )
    if wanted_icon and icon is None:
        raise ValueError(f'the manifest names icon "{wanted_icon}" but the bundle has no such file')
    return PipeBundle(
        pipeline=pipeline, stem=stem, manifest=manifest, readme=readme, icon=icon, assets=assets, archive=archive
    )


# ==== Manifest ================================================================


def pipe_manifest(pipeline: Dict[str, Any], bundle: Optional[PipeBundle]) -> Dict[str, Any]:
    """The ``metadata.manifest`` of a pipe version: what the publish row snapshots (plan 9).

    Display only, and only what the author wrote: the name (pipe, then
    manifest), tagline, description (manifest, then the pipe's), categories
    (the manifest's category first, then its tags), the icon and readme
    entry names, the listing mode and plans (the app model, plan 8.4), the
    links, and the default source (machine truth, from the pipe). Never a
    publisher or author (derived at publish, plan S7).

    Args:
        pipeline: The pipe's JSON.
        bundle: The parsed bundle, or None for a dict deploy without one.

    Returns:
        The manifest dict.
    """
    manifest = bundle.manifest if bundle else {}
    categories: List[str] = []
    if manifest.get('category'):
        categories.append(str(manifest['category']))
    categories.extend(str(t) for t in (manifest.get('tags') or []) if str(t) not in categories)
    out: Dict[str, Any] = {
        'name': str(pipeline.get('name') or manifest.get('name') or pipeline.get('project_id') or ''),
        'description': str(manifest.get('description') or pipeline.get('description') or ''),
        'mode': str(manifest.get('mode') or 'free'),
    }
    if manifest.get('tagline'):
        out['tagline'] = str(manifest['tagline'])
    if categories:
        out['categories'] = categories
    if bundle and bundle.icon:
        out['icon'] = bundle.icon
    if bundle and bundle.readme:
        out['readme'] = bundle.readme
    if manifest.get('plans'):
        out['plans'] = list(manifest['plans'])
    if manifest.get('links'):
        out['links'] = dict(manifest['links'])
    if pipeline.get('source'):
        out['defaultSource'] = str(pipeline['source'])
    return out


# ==== Content ================================================================


async def write_pipe_content(org_id: str, user_id: str, entry: Dict[str, Any], bundle: PipeBundle) -> List[str]:
    """Store the bundle's content files beside the artifact (``<content dir>/source/<entry>``).

    Everything goes through the Store interface under the internal identity
    (the same pattern as the app door and the run-log writer). On a failure
    every path written so far is deleted, best effort, and the error is
    raised for the door to flip the version 'failed'.

    Args:
        org_id: The publisher org.
        user_id: The deploying user (the store's client id).
        entry: The registry entry the publish returned (its artifactPath names the home).
        bundle: The parsed bundle.

    Returns:
        The store paths written.

    Raises:
        ValueError: The entry carries no usable artifact path.
        Exception: A store write failed (after the compensation delete).
    """
    from ai.account.models import RequestContext
    from ai.account.store import Store

    content_root = artifact_content_dir(str(entry.get('artifactPath') or ''))
    org_prefix = f'orgs/{org_id}/files/'
    if not content_root.startswith(org_prefix):
        raise ValueError(f'registry entry carries no usable artifactPath ({content_root!r})')
    home = f'@/Org/={org_id}/{content_root[len(org_prefix) :]}'
    fs = Store.file_store(RequestContext.internal('pipe-deploy'), client_id=user_id)
    written: List[str] = []
    try:
        for name in bundle.content_entries:
            path = f'{home}/source/{name}'
            # Record BEFORE the write: a write that fails partway still
            # leaves bytes on disk, and the compensation loop deletes only
            # recorded paths
            written.append(path)
            await fs.write(path, bundle.archive.read(name))
    except Exception:
        for path in written:
            try:
                await fs.delete(path)
            except Exception:
                pass  # best-effort: the 'failed' state alone gates serving
        debug(f'[pipe_bundle] content write failed for {entry.get("version")}: rolled back {len(written)} path(s)')
        raise
    return written
