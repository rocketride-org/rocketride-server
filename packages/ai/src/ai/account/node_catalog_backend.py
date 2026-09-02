# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""File-backed node catalog — the OSS implementation of the account module's
``catalog_*`` interface, and the artifact-file layer the SaaS implementation
shares.

Model (a public shelf of user-published nodes):

  - PUBLISH copies a capsule into the catalog as an IMMUTABLE version:

        catalog/<name>/v000N-<sha8>.rrc

    The artifact is the ``.rrc`` exactly as published; its sha256 is recorded
    and re-verified on load, so what was reviewed is provably what installs.
    The hash in the filename keeps racing publishers on different files.

  - A published node is visible to everyone. Nothing here filters by org or
    team: that is the point of a catalog, and it is what separates this from
    the deployments registry, which is org-scoped by design.

  - Price is carried but never charged here. The backend records what the
    author asked for; whether anyone can pay it is the billing layer's
    question, and in OSS there is no billing at all.

  - Removal is SOFT: ``state='removed'`` hides an entry from the listing while
    the artifacts and history survive, so an install someone already did keeps
    resolving.

Storage layout, one directory per node under the catalog tree:

    catalog/<name>/v000001-<sha8>.rrc   immutable capsule (never overwritten)
    catalog/<name>/meta.json            entry + versions + history (CAS-guarded)

Uses IStore directly (the trusted, in-server layer): paths are built here from
validated names, never from caller-supplied path strings.
"""

import base64
import hashlib
import json
import re
import time
from typing import Any, Dict, List, Optional

from .store import IStore, StorageError, VersionMismatchError

# How many CAS retries a meta.json read-modify-write attempts before failing.
_CAS_ATTEMPTS = 5

# Catalog root inside the store. A published node is public, so it does not
# live under any org's tree.
_CATALOG_ROOT = 'catalog'

# A node name is the frozen protocol id and becomes a path segment here.
_NAME_RE = re.compile(r'^[a-z][a-z0-9_]{1,63}$')


def _safe_name(value: str) -> str:
    """Validate a node name that becomes a physical path segment.

    Args:
        value: The node name as published.

    Returns:
        The same name, unchanged.

    Raises:
        ValueError: The name is unusable as a path segment or as a protocol id.
    """
    if not _NAME_RE.match(value or ''):
        raise ValueError(f'invalid node name {value!r}')
    return value


def _actor_record(actor: Dict[str, Any]) -> Dict[str, Any]:
    """Denormalize who did something, so the record survives user deletion."""
    actor = actor or {}
    return {
        'id': actor.get('id') or actor.get('userId') or '',
        'name': actor.get('name') or actor.get('displayName') or '',
        'email': actor.get('email') or '',
    }


def artifact_path(name: str, version: int, sha256: str) -> str:
    """Physical store path of one immutable capsule version."""
    return f'{_CATALOG_ROOT}/{name}/v{version:06d}-{sha256[:8]}.rrc'


def artifact_sha256(data: bytes) -> str:
    """SHA-256 of the capsule bytes, as recorded in the entry."""
    return hashlib.sha256(data).hexdigest()


class FileNodeCatalogBackend:
    """The OSS catalog: capsules on the store, metadata in meta.json.

    Every metadata write is a compare-and-swap on ``meta.json`` so concurrent
    publishers never lose updates.
    """

    def __init__(self, store: IStore) -> None:
        """
        Args:
            store: The raw store this catalog is written to.
        """
        self._store = store

    # -- write ---------------------------------------------------------------

    async def publish(
        self,
        name: str,
        capsule: bytes,
        actor: Dict[str, Any],
        title: str = '',
        description: str = '',
        price_cents: int = 0,
        version_label: str = '',
    ) -> Dict[str, Any]:
        """Publish a capsule as the node's next immutable catalog version.

        Args:
            name: Node name (its frozen protocol id).
            capsule: The ``.rrc`` bytes.
            actor: Who is publishing.
            title: Display title; falls back to the name.
            description: One-line description shown on the card.
            price_cents: 0 for free. Recorded, never charged here.
            version_label: The author's version string, e.g. '1.2.0'.

        Returns:
            The new catalog entry.
        """
        name = _safe_name(name)
        if not capsule:
            raise ValueError('capsule is required')
        if price_cents < 0:
            raise ValueError('price_cents cannot be negative')

        digest = artifact_sha256(capsule)

        async def mutate(meta: Dict[str, Any]) -> Dict[str, Any]:
            version = len(meta['versions']) + 1
            path = artifact_path(name, version, digest)
            await self._store.write_bytes(path, capsule)
            record = {
                'version': version,
                'label': version_label or f'0.0.{version}',
                'sha256': digest,
                'path': path,
                'sizeBytes': len(capsule),
                'publishedAt': int(time.time()),
                'publishedBy': _actor_record(actor),
            }
            meta['versions'].append(record)
            meta['name'] = name
            meta['title'] = title or meta.get('title') or name
            meta['description'] = description or meta.get('description') or ''
            meta['priceCents'] = int(price_cents)
            meta['state'] = 'published'
            meta['author'] = meta.get('author') or _actor_record(actor)
            meta['latest'] = version
            meta['history'].append(
                {'action': 'publish', 'version': version, 'at': record['publishedAt'], 'by': record['publishedBy']}
            )
            return self._entry(meta)

        return await self._mutate_meta(name, mutate)

    async def unpublish(self, name: str, actor: Dict[str, Any]) -> Dict[str, Any]:
        """Hide a node from the catalog without destroying anything.

        The artifacts stay: someone who already installed this node keeps a
        capsule that resolves, and the history remains auditable.
        """
        name = _safe_name(name)

        async def mutate(meta: Dict[str, Any]) -> Dict[str, Any]:
            if not meta.get('versions'):
                raise ValueError(f'node {name!r} is not published')
            meta['state'] = 'removed'
            meta['history'].append({'action': 'unpublish', 'at': int(time.time()), 'by': _actor_record(actor)})
            return self._entry(meta)

        return await self._mutate_meta(name, mutate)

    # -- read ----------------------------------------------------------------

    async def list(self, search: str = '', include_removed: bool = False) -> List[Dict[str, Any]]:
        """Every published node, newest publication first.

        Args:
            search: Case-insensitive match against name, title and description.
            include_removed: Include soft-removed entries (an admin view).
        """
        entries: List[Dict[str, Any]] = []
        try:
            listing = await self._store.list_entries(
                f'{_CATALOG_ROOT}/', recursive=False, include_files=False, include_dirs=True
            )
        except StorageError:
            return entries
        for item in listing or []:
            raw = item.get('name') if isinstance(item, dict) else item
            node_name = str(raw or '').strip('/').split('/')[-1]
            if not _NAME_RE.match(node_name):
                continue
            meta = await self._read_meta(node_name)
            if not meta or not meta.get('versions'):
                continue
            if meta.get('state') == 'removed' and not include_removed:
                continue
            entry = self._entry(meta)
            if search and not _matches(entry, search):
                continue
            entries.append(entry)
        entries.sort(key=lambda e: e.get('publishedAt') or 0, reverse=True)
        return entries

    async def get(self, name: str) -> Optional[Dict[str, Any]]:
        """One catalog entry, versions included, or None if never published."""
        meta = await self._read_meta(_safe_name(name))
        if not meta or not meta.get('versions'):
            return None
        entry = self._entry(meta)
        entry['versions'] = list(reversed(meta['versions']))
        return entry

    async def fetch(self, name: str, version: Optional[int] = None) -> Dict[str, Any]:
        """The capsule bytes of one version, base64-encoded, digest re-verified.

        Args:
            name: Node name.
            version: Version number; the latest when omitted.

        Returns:
            ``{'name', 'version', 'sha256', 'capsule'}`` with the capsule base64.

        Raises:
            ValueError: No such node or version.
            StorageError: The stored bytes no longer match the recorded digest.
        """
        name = _safe_name(name)
        meta = await self._read_meta(name)
        if not meta or not meta.get('versions'):
            raise ValueError(f'node {name!r} is not published')
        wanted = version or meta.get('latest')
        record = next((v for v in meta['versions'] if v.get('version') == wanted), None)
        if record is None:
            raise ValueError(f'node {name!r} has no version {wanted}')

        data = await self._store.read_bytes(record['path'])
        actual = artifact_sha256(data)
        if actual != record['sha256']:
            # What was published is not what is stored: refuse rather than hand
            # a caller bytes it is about to execute.
            raise StorageError(f'catalog artifact for {name!r} v{wanted} does not match its recorded sha256')
        return {
            'name': name,
            'version': record['version'],
            'sha256': record['sha256'],
            'capsule': base64.b64encode(data).decode('ascii'),
        }

    # -- internals -----------------------------------------------------------

    def _entry(self, meta: Dict[str, Any]) -> Dict[str, Any]:
        """The card-shaped view of a node's metadata."""
        latest = next((v for v in reversed(meta.get('versions') or []) if v.get('version') == meta.get('latest')), None)
        return {
            'name': meta.get('name'),
            'title': meta.get('title') or meta.get('name'),
            'description': meta.get('description') or '',
            'author': meta.get('author') or {},
            'priceCents': int(meta.get('priceCents') or 0),
            'state': meta.get('state') or 'published',
            'latest': meta.get('latest'),
            'versionLabel': (latest or {}).get('label') or '',
            'sizeBytes': (latest or {}).get('sizeBytes') or 0,
            'publishedAt': (latest or {}).get('publishedAt') or 0,
        }

    def _meta_path(self, name: str) -> str:
        return f'{_CATALOG_ROOT}/{name}/meta.json'

    async def _read_meta(self, name: str) -> Optional[Dict[str, Any]]:
        try:
            data = await self._store.read_file(self._meta_path(name))
        except StorageError:
            return None
        try:
            return json.loads(data)
        except (ValueError, TypeError):
            return None

    async def _mutate_meta(self, name: str, mutate) -> Any:
        """CAS read-modify-write of meta.json with bounded retries."""
        last: Exception | None = None
        for _ in range(_CAS_ATTEMPTS):
            path = self._meta_path(name)
            try:
                data, cas_version = await self._store.read_file_with_metadata(path)
                meta = json.loads(data)
            except StorageError:
                meta, cas_version = None, None
            if meta is None:
                meta = {'name': name, 'versions': [], 'history': []}
            else:
                meta.setdefault('versions', [])
                meta.setdefault('history', [])

            result = await mutate(meta)

            try:
                if cas_version is None:
                    await self._store.write_file(path, json.dumps(meta, indent=1))
                else:
                    await self._store.write_file_atomic(path, json.dumps(meta, indent=1), expected_version=cas_version)
                return result
            except VersionMismatchError as e:
                last = e
                continue
        raise StorageError(f'catalog: meta update contention for {name}: {last}')


def _matches(entry: Dict[str, Any], search: str) -> bool:
    """Case-insensitive search across the fields a person reads on the card."""
    needle = search.lower()
    for key in ('name', 'title', 'description'):
        if needle in str(entry.get(key) or '').lower():
            return True
    return needle in str((entry.get('author') or {}).get('name') or '').lower()
