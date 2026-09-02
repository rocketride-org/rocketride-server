# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Node capsule (``.rrc``): the transport format for installing a custom node.

A capsule is a ZIP with ``capsule.json`` at the root and the node under
``local_nodes/<name>/`` — the same ``local_nodes`` layout the engine discovers via
``--node_path`` (see node_scaffold.py), so scaffold → pack → install → discover is
one straight line and the Node Builder and the installer share one destination.

Scope: this module is only the format — ``pack_capsule`` builds a ``.rrc`` and
``read_capsule`` reads one back (with a basic path-traversal guard so extraction
never escapes the node folder). Judging a node's contents is out of scope here.

Kept deliberately self-contained so it is trivial to split into its own PR later.
"""

import hashlib
import io
import json
import ntpath
import posixpath
import zipfile
from typing import Dict, List, Optional, Tuple

import json5

from ai.account.node_scaffold import _NAME_RE

MANIFEST_NAME = 'capsule.json'
NODES_ROOT = 'local_nodes'

# A payload larger than this is refused before extraction (zip-bomb / runaway).
MAX_CAPSULE_BYTES = 25 * 1024 * 1024

# The compressed cap says nothing about what the archive expands to: a few hundred
# KiB of zeros decompresses to hundreds of MiB, all of it read into memory here.
# Bound the declared uncompressed total and the member count as well.
MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
MAX_CAPSULE_MEMBERS = 2000

# Build/runtime cruft that never belongs in a capsule.
_SKIP_DIRS = frozenset({'__pycache__', '.git', '.mypy_cache', '.ruff_cache'})
_SKIP_SUFFIX = ('.pyc', '.pyo')


class CapsuleError(Exception):
    """A capsule is malformed (bad zip, missing manifest, unsafe path)."""


def load_relaxed_json(text: str):
    """Parse JSONC (services.json is JSONC); capsule.json is plain JSON but this accepts both."""
    return json5.loads(text)


def _payload_sha256(files: Dict[str, bytes]) -> str:
    """SHA-256 over the payload, order-independent: hash sorted ``arcname\\0bytes`` records."""
    h = hashlib.sha256()
    for arc in sorted(files):
        h.update(arc.encode('utf-8'))
        h.update(b'\0')
        h.update(files[arc])
        h.update(b'\0')
    return h.hexdigest()


def pack_capsule(
    name: str, files: Dict[str, str], version: str = '0.0.0', declares: Optional[List[str]] = None
) -> bytes:
    """Build ``.rrc`` bytes from a node file map (as ``scaffold_node`` returns).

    The payload is placed under ``local_nodes/<name>/`` and the manifest records a
    sha256 of it, so a later read can confirm the bytes are intact.

    Args:
        name: node id (folder / protocol key).
        files: ``{relative_path: contents}`` for the node folder.
        version: capsule version recorded in the manifest.
        declares: capabilities the node needs (``network``/``subprocess``/``filesystem``);
            recorded as manifest metadata, not enforced here.

    Returns:
        The capsule bytes.
    """
    protocol = f'{name}://'
    services = files.get('services.json')
    if services:
        try:
            protocol = load_relaxed_json(services).get('protocol') or protocol
        except Exception:
            pass

    payload: Dict[str, bytes] = {}
    for rel, body in files.items():
        parts = rel.split('/')
        if any(p in _SKIP_DIRS for p in parts) or rel.endswith(_SKIP_SUFFIX):
            continue
        arc = f'{NODES_ROOT}/{name}/{rel}'
        payload[arc] = body.encode('utf-8')

    manifest = {
        'name': name,
        'protocol': protocol,
        'version': version,
        'declares': sorted(declares or []),
        'sha256': _payload_sha256(payload),
    }

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(MANIFEST_NAME, json.dumps(manifest, indent=2))
        for arc in sorted(payload):
            zf.writestr(arc, payload[arc])
    return buf.getvalue()


def _validate_payload_key(key: str) -> None:
    """Reject a payload key that would escape the node directory it is joined onto.

    The archive name is not the thing that gets written — the remainder after the
    ``local_nodes/<name>/`` prefix is, and a member can traverse within an accepted
    prefix so that only the remainder escapes. Checked on the key itself, and on
    both separators: a backslash is a path separator on Windows and passes a POSIX
    normalisation untouched.

    Args:
        key: Path relative to the node directory.

    Raises:
        CapsuleError: The key is absolute, empty, or contains a ``..`` segment.
    """
    if not key or key.startswith('/') or key.startswith('\\') or posixpath.isabs(key):
        raise CapsuleError(f'unsafe path in capsule: {key!r}')
    if ntpath.isabs(key) or (len(key) > 1 and key[1] == ':'):
        raise CapsuleError(f'unsafe path in capsule: {key!r}')
    for segment in key.replace('\\', '/').split('/'):
        if segment in ('..', ''):
            raise CapsuleError(f'unsafe path in capsule: {key!r}')


def _verify_digest(manifest: dict, payload: Dict[str, bytes]) -> None:
    """Check the payload against the manifest's sha256, when it carries one.

    pack_capsule records the digest so a read can confirm the bytes are intact;
    a digest nobody checks is a claim, not a guarantee.

    Args:
        manifest: The parsed capsule manifest.
        payload: Contents keyed relative to the node directory.

    Raises:
        CapsuleError: The recorded digest does not match the payload.
    """
    recorded = manifest.get('sha256')
    if not recorded:
        return
    name = manifest.get('name')
    prefixed = {f'{NODES_ROOT}/{name}/{key}': value for key, value in payload.items()}
    actual = _payload_sha256(prefixed)
    if actual != recorded:
        raise CapsuleError('capsule contents do not match the recorded sha256')


def read_capsule(zip_bytes: bytes) -> Tuple[dict, Dict[str, bytes]]:
    """Read a capsule back to ``(manifest, payload)`` for installation.

    Guards only against a malformed or path-escaping archive (zip-slip), so the
    caller can safely write ``payload`` under a node path. It does **not** judge the
    node's contents.

    Args:
        zip_bytes: the ``.rrc`` bytes.

    Returns:
        ``(manifest, {relative_path_under_the_node: contents})``. Paths are returned
        relative to ``local_nodes/<name>/`` so the caller writes them under its own
        ``local_nodes/<name>/`` target.

    Raises:
        CapsuleError: bad zip, missing/invalid manifest, or an unsafe member path.
    """
    if len(zip_bytes) > MAX_CAPSULE_BYTES:
        raise CapsuleError(f'capsule exceeds {MAX_CAPSULE_BYTES} bytes')
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as e:
        raise CapsuleError(f'not a valid zip archive: {e}')

    infos = zf.infolist()
    if len(infos) > MAX_CAPSULE_MEMBERS:
        raise CapsuleError(f'capsule holds more than {MAX_CAPSULE_MEMBERS} entries')
    declared = sum(info.file_size for info in infos)
    if declared > MAX_UNCOMPRESSED_BYTES:
        raise CapsuleError(f'capsule expands to more than {MAX_UNCOMPRESSED_BYTES} bytes')

    names = zf.namelist()
    for name in names:
        norm = posixpath.normpath(name)
        if name.startswith('/') or norm.startswith('..') or posixpath.isabs(norm):
            raise CapsuleError(f'unsafe path in capsule: {name!r}')

    if MANIFEST_NAME not in names:
        raise CapsuleError(f'missing {MANIFEST_NAME} at capsule root')
    try:
        manifest = json.loads(zf.read(MANIFEST_NAME).decode('utf-8'))
    except Exception as e:
        raise CapsuleError(f'{MANIFEST_NAME} is not valid JSON: {e}')
    if not isinstance(manifest, dict):
        raise CapsuleError(f'{MANIFEST_NAME} is not an object')

    node_name = manifest.get('name')
    if not node_name:
        raise CapsuleError(f'{MANIFEST_NAME} missing "name"')
    # Validated where the name is first read, so every consumer gets the same
    # answer rather than relying on the installer to check it later.
    if not _NAME_RE.match(str(node_name)):
        raise CapsuleError(f'invalid node name in {MANIFEST_NAME}: {node_name!r}')
    node_dir = f'{NODES_ROOT}/{node_name}/'

    payload: Dict[str, bytes] = {}
    read_bytes = 0
    for arc in names:
        if arc == MANIFEST_NAME or arc.endswith('/'):
            continue
        if not arc.startswith(node_dir):
            raise CapsuleError(f'{arc!r} is outside the node folder {node_dir!r}')
        key = arc[len(node_dir) :]
        # The key is what the caller joins onto its own node directory, so it is the
        # thing that has to be safe — not the archive name it came from. A member
        # traversing *inside* an accepted prefix ('local_nodes/x/sub/../../evil.py')
        # normalises to something with no leading '..' and passes every check above,
        # while the key still escapes when joined.
        _validate_payload_key(key)
        data = zf.read(arc)
        read_bytes += len(data)
        if read_bytes > MAX_UNCOMPRESSED_BYTES:
            raise CapsuleError(f'capsule expands to more than {MAX_UNCOMPRESSED_BYTES} bytes')
        payload[key] = data

    _verify_digest(manifest, payload)
    return manifest, payload
