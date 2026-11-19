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

"""The pipeline BUNDLE on the server side (plan 9, C.17b): the store block, the zip, the content.

A pipe's store manifest is the root ``store`` block INSIDE the pipeline JSON
(:data:`STORE_KEYS`): display facts only, beside the pipe's own root keys
(``project_id``, ``name``, ``description``, ``source``), which are never
duplicated. The block makes the pipe PUBLISHABLE: a dict deploy without one
is an unlisted artifact (no content dir, no store row); a deploy with one
is listed, its ``metadata.manifest`` shaped from the block plus the root
keys (:func:`pipe_manifest`).

The client packs the pipe's folder into one zip and sends it as the binary
``data`` frame of ``rrext_deploy add kind='pipe'`` beside the pipeline dict:
exactly one ``.pipe`` at the zip root (the artifact) plus the files the block
declares (``icon``, ``readme``) and the files the readme references, with
their layout relative to the pipe's directory (``docs/README.md``,
``images/a.png``). :func:`read_pipe_bundle` parses and guards the zip,
:func:`write_pipe_content` stores every non-pipe entry under the version's
content dir (``<content dir>/store/``, the serving root ``/pipelines/<id>/
v<N>/<path>`` maps to), compensating like the app door. A file the block
declares but the zip lacks fails the write, so the version lands on
``failed`` with a message naming the file. The zip guards are the app
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

#: The icon cap (the app packer's bound).
MAX_PIPE_ICON_BYTES = 256 * 1024

#: The cap on any other bundled file, a readme image for one (the app packer's bound).
MAX_PIPE_FILE_BYTES = 10 * 1024 * 1024

#: The dir under a pipe version's content dir that holds the bundle's files: its serving root.
PIPE_STORE_DIR = 'store'

#: The keys of the root ``store`` block; anything else refuses the deploy.
STORE_KEYS = frozenset({'tagline', 'categories', 'tags', 'icon', 'readme', 'links', 'mode', 'billing'})

#: The listing modes, the app model (plan 8.4).
STORE_MODES = ('free', 'subscription', 'paywall')


# ==== Types ===================================================================


@dataclass
class PipeBundle:
    """One parsed bundle zip."""

    pipeline: Dict[str, Any]
    """The pipe's JSON (the artifact)."""
    stem: str
    """The pipe file's stem (its basename without ``.pipe``)."""
    entries: List[str] = field(default_factory=list)
    """Every entry stored beside the artifact (never the pipe itself), with its layout."""
    archive: Any = None
    """The open zip (content is read from it at write time)."""


# ==== The store block =========================================================


def _relative_path(block_key: str, value: Any) -> str:
    """A declared file path, normalised; refuses an absolute or escaping one."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'store.{block_key} must be a relative file path')
    rel = value.strip().replace('\\', '/')
    parts = [p for p in rel.split('/') if p not in ('', '.')]
    if rel.startswith('/') or not parts or '..' in parts:
        raise ValueError(f'store.{block_key} must be a path inside the pipeline folder')
    return '/'.join(parts)


def _string_list(block_key: str, value: Any) -> List[str]:
    """A list of strings, or the refusal naming the key."""
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f'store.{block_key} must be a list of strings')
    return list(value)


def _check_billing(value: Any) -> Dict[str, Any]:
    """The billing shape: ``{'plans': [...]}`` with a list of plan objects.

    The shape rule only, as the app door applies at deploy on every edition:
    the plan FLOORS (what a plan may charge) are checked where the plans
    become prices, at approval (the SaaS marketplace's ``validate_plan_floors``).
    """
    if not isinstance(value, dict):
        raise ValueError('store.billing must be an object with a plans list')
    unknown = [key for key in value if key != 'plans']
    if unknown:
        raise ValueError(f'store.billing: unknown key "{unknown[0]}" (allowed: plans)')
    plans = value.get('plans')
    if not isinstance(plans, list) or any(not isinstance(plan, dict) for plan in plans):
        raise ValueError('store.billing.plans must be a list of plan objects')
    return {'plans': [dict(plan) for plan in plans]}


def validate_store_block(pipeline: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The pipe's root ``store`` block, checked, or None when the pipe carries none.

    Args:
        pipeline: The pipe's JSON.

    Returns:
        The block with its paths normalised (``icon``/``readme`` relative,
        forward slashes), or None for an unlisted deploy.

    Raises:
        ValueError: The block is not an object, carries an unknown key, a
            value of the wrong type, a mode outside :data:`STORE_MODES`, a
            declared path outside the folder, or a malformed billing block.
    """
    if 'store' not in pipeline:
        return None
    block = pipeline['store']
    if not isinstance(block, dict):
        raise ValueError('store must be an object')
    # Step 1: the key set
    unknown = [key for key in block if key not in STORE_KEYS]
    if unknown:
        raise ValueError(f'store: unknown key "{unknown[0]}" (allowed: {", ".join(sorted(STORE_KEYS))})')
    # Step 2: each value's shape
    out: Dict[str, Any] = {}
    if 'tagline' in block:
        if not isinstance(block['tagline'], str):
            raise ValueError('store.tagline must be a string')
        out['tagline'] = block['tagline']
    for key in ('categories', 'tags'):
        if key in block:
            out[key] = _string_list(key, block[key])
    for key in ('icon', 'readme'):
        if key in block:
            out[key] = _relative_path(key, block[key])
    if 'links' in block:
        links = block['links']
        if not isinstance(links, dict) or any(
            not isinstance(k, str) or not isinstance(v, str) for k, v in links.items()
        ):
            raise ValueError('store.links must be an object of strings')
        out['links'] = dict(links)
    if 'mode' in block:
        if block['mode'] not in STORE_MODES:
            raise ValueError('store.mode must be free, subscription or paywall')
        out['mode'] = block['mode']
    if 'billing' in block:
        out['billing'] = _check_billing(block['billing'])
    return out


def declared_files(block: Optional[Dict[str, Any]]) -> Dict[str, str]:
    """The files a block names, ``{key: path}`` (``icon``, ``readme``); empty without a block."""
    return {key: block[key] for key in ('icon', 'readme') if block and block.get(key)}


# ==== Read ====================================================================


def read_pipe_bundle(data: bytes) -> PipeBundle:
    """Parse and guard a bundle zip.

    The caps are per role: the file the block names as ``readme`` may hold
    :data:`MAX_PIPE_README_BYTES`, the ``icon`` :data:`MAX_PIPE_ICON_BYTES`,
    every other entry :data:`MAX_PIPE_FILE_BYTES`. Presence of a declared
    file is NOT checked here: that is the content stage's job
    (:func:`write_pipe_content`), so a missing file fails the version
    instead of refusing the deploy.

    Args:
        data: The zip bytes (the ``data`` frame).

    Returns:
        The bundle: the pipe's JSON, its stem and the content entry names.

    Raises:
        ValueError: Not a zip, an unsafe or oversized archive, not exactly
            one ``.pipe`` at the root, an unparseable pipe, an invalid store
            block, or an entry over its cap.
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

    # Step 2: every other entry under its role's cap
    declared = declared_files(validate_store_block(pipeline))
    caps = {declared.get('readme'): MAX_PIPE_README_BYTES, declared.get('icon'): MAX_PIPE_ICON_BYTES}
    entries: List[str] = []
    for name in names:
        if name == pipes[0]:
            continue
        cap = caps.get(name, MAX_PIPE_FILE_BYTES)
        if archive.getinfo(name).file_size > cap:
            raise ValueError(f'{name} exceeds {cap} bytes')
        entries.append(name)
    return PipeBundle(pipeline=pipeline, stem=stem, entries=entries, archive=archive)


# ==== Manifest ================================================================


def pipe_manifest(pipeline: Dict[str, Any], block: Dict[str, Any]) -> Dict[str, Any]:
    """The ``metadata.manifest`` of a LISTED pipe version: the block plus the pipe's root keys (plan 9).

    The field names an app's manifest carries: ``name``, ``description`` and
    ``defaultSource`` from the pipe's root keys; ``tagline``, ``categories``,
    ``tags``, ``icon``, ``readme`` (relative paths; the catalog row turns
    them into URLs), ``links`` and ``mode`` from the block, and the pricing
    EXACTLY as an app manifest stores it: ``billing: {plans: [...]}``, present
    only when authored (the SaaS approve path and review listing read
    ``manifest.billing`` for both kinds). Never a publisher or author
    (derived at publish, plan S7).

    Args:
        pipeline: The pipe's JSON.
        block: The validated store block (:func:`validate_store_block`).

    Returns:
        The manifest dict.
    """
    manifest: Dict[str, Any] = {
        'name': str(pipeline.get('name') or pipeline.get('project_id') or ''),
        'description': str(pipeline.get('description') or ''),
        'defaultSource': str(pipeline.get('source') or ''),
        'tagline': str(block.get('tagline') or ''),
        'categories': list(block.get('categories') or []),
        'tags': list(block.get('tags') or []),
        'icon': str(block.get('icon') or ''),
        'readme': str(block.get('readme') or ''),
        'links': dict(block.get('links') or {}),
        'mode': str(block.get('mode') or 'free'),
    }
    if block.get('billing'):
        manifest['billing'] = {'plans': list(block['billing'].get('plans') or [])}
    return manifest


def is_listed(manifest: Any) -> bool:
    """Whether a pipe version's ``metadata.manifest`` was shaped from a store block.

    Both backends synthesize a minimal ``{'name': ...}`` manifest for a
    deploy that carried none, so presence alone says nothing; the block's
    ``mode`` is written on every listed manifest and on no other.
    """
    return isinstance(manifest, dict) and 'mode' in manifest


# ==== Content ================================================================


def store_home_of(org_id: str, entry: Dict[str, Any]) -> str:
    """The Store path of a pipe version's serving dir (``@/Org/=<org>/.../store``).

    Raises:
        ValueError: The entry carries no usable artifact path.
    """
    content_root = artifact_content_dir(str(entry.get('artifactPath') or ''))
    org_prefix = f'orgs/{org_id}/files/'
    if not content_root.startswith(org_prefix):
        raise ValueError(f'registry entry carries no usable artifactPath ({content_root!r})')
    return f'@/Org/={org_id}/{content_root[len(org_prefix) :]}/{PIPE_STORE_DIR}'


async def write_pipe_content(
    org_id: str, user_id: str, entry: Dict[str, Any], bundle: Optional[PipeBundle], block: Dict[str, Any]
) -> List[str]:
    """Store the bundle's files under the version's serving dir, keeping their layout.

    Everything goes through the Store interface under the internal identity
    (the same pattern as the app door and the run-log writer). A file the
    block declares that the bundle lacks raises BEFORE any write; on any
    failure every path written so far is deleted, best effort, and the
    error is raised for the door to flip the version 'failed'.

    Args:
        org_id: The publisher org.
        user_id: The deploying user (the store's client id).
        entry: The registry entry the publish returned (its artifactPath names the home).
        bundle: The parsed bundle, or None when the deploy sent no zip.
        block: The validated store block.

    Returns:
        The store paths written.

    Raises:
        ValueError: The entry carries no usable artifact path, or a declared
            file is missing from the bundle.
        Exception: A store write failed (after the compensation delete).
    """
    from ai.account.models import RequestContext
    from ai.account.store import Store

    # Step 1: every declared file is in the zip
    present = set(bundle.entries) if bundle else set()
    for key, path in declared_files(block).items():
        if path not in present:
            raise ValueError(f'the store block names {key} "{path}" but the bundle has no such file')
    if bundle is None or not bundle.entries:
        return []

    # Step 2: the writes, recorded before each so a partial write is still rolled back
    home = store_home_of(org_id, entry)
    fs = Store.file_store(RequestContext.internal('pipe-deploy'), client_id=user_id)
    written: List[str] = []
    try:
        for name in bundle.entries:
            path = f'{home}/{name}'
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
