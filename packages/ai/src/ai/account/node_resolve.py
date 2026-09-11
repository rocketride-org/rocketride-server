# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

# =============================================================================
# NODE RESOLVE — what a pipeline needs that this machine does not have
#
# A published node is never installed. When a pipeline names one the engine
# does not carry, the run fetches it, uses it, and drops it. This module is
# the first half of that: deciding WHICH nodes a run has to go and get, and
# at which version, before anything is downloaded or written.
#
# Kept separate from the fetching on purpose. Detection is pure — a pipeline
# dict, the names the engine already knows, and the caller's pins — so it can
# answer "will this run work?" without touching the network or the disk.
# =============================================================================

"""Deciding which published nodes a pipeline run has to resolve, and getting them."""

from __future__ import annotations

import hashlib
import io
import os
import re
import shutil
import zipfile
from typing import Any, Dict, List, Set

from rocketlib import debug

from ai.account.deploy_common import ZIP_MAX_ZIPPED, zip_guard
from ai.account.deployment_backend import artifact_content_dir
from ai.account.node_deploy import NODE_REQUIREMENTS, resolve_node_pins

# The engine's own installer. It resolves AGAINST the constraints lock, which
# is the whole reason a run may install at all: a conflict is refused rather
# than settled by downgrading a package another node is relying on.
from depends import depends as _install

#: The package folder the engine imports external nodes from. Its __init__ is
#: the PARENT of each node directory, so it never travels inside a bundle —
#: the resolver writes it.
RUN_PACKAGE = 'local_nodes'

_PACKAGE_INIT = b'# Marks local_nodes as a package so the engine can import local_nodes.<name>.\n'

#: How long one node's dependency install may take before the run gives up.
#: Generous, because a cold resolve can genuinely be slow; finite, because a
#: stalled resolver would otherwise hang the run with nothing to show for it.
INSTALL_TIMEOUT = 900.0


def providers_of(pipeline: Dict[str, Any]) -> Set[str]:
    """Every node type a pipeline names, once each.

    A component's ``provider`` IS the node's protocol id, which is the same id
    a node publishes under — so nothing has to be translated between what a
    pipeline asks for and what the registry holds.
    """
    providers: Set[str] = set()
    for component in pipeline.get('components') or []:
        if not isinstance(component, dict):
            continue
        provider = component.get('provider')
        if isinstance(provider, str) and provider:
            providers.add(provider)
    return providers


def missing_from(providers: Set[str], known: Set[str]) -> Set[str]:
    """The named nodes this engine does not already carry.

    Everything a normal pipeline names is built in, so this is empty for
    almost every run — which is the point. A pipeline of stock nodes must not
    pay for this feature existing.
    """
    return {name for name in providers if name not in known}


class UnresolvedNodes(Exception):
    """A run named nodes it has no way to get.

    Carries the names and the org they were looked for in: "node not found" is
    a dead end, while "not published to you in <org>" tells someone what to do
    about it.
    """

    def __init__(self, names: List[str], org_id: str):
        self.names = names
        self.org_id = org_id
        listed = ', '.join(sorted(names))
        super().__init__(
            f'this pipeline uses {listed}, which this engine does not have and '
            f'which is not published to you in {org_id!r}'
        )


async def plan_for(
    pipeline: Dict[str, Any],
    known: Set[str],
    org_id: str,
    user_id: str | None,
    team_ids: List[str],
) -> List[Dict[str, Any]]:
    """What this run has to fetch, resolved to exact versions.

    Returns one availability entry per node that has to be brought in —
    empty when the engine already carries everything, which is the common
    case and costs one set difference.

    Nothing is fetched or written here. A pin that does not exist stops the
    run BEFORE any bytes move, rather than downloading what it can and
    failing halfway through.

    Raises:
        UnresolvedNodes: a named node with no pin for this caller.
    """
    wanted = missing_from(providers_of(pipeline), known)
    if not wanted:
        return []

    available = {entry['id']: entry for entry in await resolve_node_pins(org_id, user_id, team_ids)}
    unresolved = sorted(name for name in wanted if name not in available)
    if unresolved:
        raise UnresolvedNodes(unresolved, org_id)

    plan = [available[name] for name in sorted(wanted)]
    debug(f'[node_resolve] {len(plan)} node(s) to resolve: {", ".join(entry["id"] for entry in plan)}')
    return plan


# =============================================================================
# FETCHING — bytes, proven, then on disk
# =============================================================================
#
# The order below is the design: a bundle is proven to be what the registry
# said it was BEFORE it is opened, and the archive is checked again before it
# is written out. Publishing checked the same things, but that was a different
# moment and a different copy of the bytes.


class BundleMismatch(Exception):
    """Fetched bytes are not what the registry recorded for that version."""


class DependencyFailure(Exception):
    """A node's declared dependencies cannot be satisfied on this machine."""


async def _bundle_of(org_id: str, node_id: str, version: int, actor: str) -> bytes:
    """The stored bundle for one registry version, through the same Store.

    Filesystem when self-hosted, S3 or Azure on cloud — the resolver never
    knows which, the same way publishing does not.

    Raises:
        ValueError: the version is gone, or its entry carries no usable path.
    """
    from ai.account import account
    from ai.account.models import RequestContext
    from ai.account.store import Store

    entries = await account.deployments_versions(org_id, node_id) or []
    entry = next((e for e in entries if int(e.get('version', 0)) == version), None)
    if not entry:
        raise ValueError(f'{node_id} has no registry version {version} in {org_id!r}')

    content_root = artifact_content_dir(str(entry.get('artifactPath') or ''))
    org_prefix = f'orgs/{org_id}/files/'
    if not content_root.startswith(org_prefix):
        raise ValueError(f'registry entry for {node_id} carries no usable artifactPath')

    fs = Store.file_store(RequestContext.internal('node-resolve'), client_id=actor)
    home = f'@/Org/={org_id}/{content_root[len(org_prefix) :]}'
    # Read cap tied to the publish cap rather than the store's larger default:
    # nothing bigger than that could have been published in the first place.
    return await fs.read(f'{home}/bundle/{node_id}-v{version:06d}.zip', ZIP_MAX_ZIPPED)


def _verified(data: bytes, expected: str, node_id: str) -> bytes:
    """The bundle, or nothing.

    Checked before the archive is opened at all: a mismatch means the bytes
    are not the version that was reviewed and pinned, and the cheapest place
    to stop is before a zip reader has seen them.

    Raises:
        BundleMismatch: digest does not match what the artifact recorded.
    """
    if not expected:
        raise BundleMismatch(f'{node_id} has no recorded digest to verify against')
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        raise BundleMismatch(f'{node_id} bundle digest is {actual[:12]}…, expected {expected[:12]}…')
    return data


def _unpack_into(data: bytes, destination: str, node_id: str) -> None:
    """Write the node directory out, guarded first.

    Raises:
        ValueError: the archive is unsafe to unpack.
    """
    archive = zipfile.ZipFile(io.BytesIO(data))
    guard_error = zip_guard(archive)
    if guard_error:
        raise ValueError(f'{node_id} bundle refused: {guard_error}')
    os.makedirs(destination, exist_ok=True)
    archive.extractall(destination)


# =============================================================================
# CACHE — keyed by content, so it is never stale
# =============================================================================


def cache_root() -> str:
    """Where unpacked nodes are kept between runs."""
    from depends import engine_cache_dir

    return os.path.join(engine_cache_dir(create=True), 'nodes')


#: A digest is a path segment in the cache, so it is validated as one. This
#: also rejects anything that could climb out of the cache root.
_DIGEST = re.compile(r'[0-9a-f]{64}')


def cache_slot(node_id: str, digest: str) -> str:
    """This exact node at this exact content, and nothing else.

    Keyed by digest rather than by version: two versions never collide, a slot
    can never hold the wrong bytes, and nothing ever has to be invalidated.

    Raises:
        BundleMismatch: the digest is not a usable sha256. An empty one would
                        otherwise resolve to the node's own directory — which
                        on a warm cache exists, holding the digest slots, and
                        would be copied out as though it were the node.
    """
    if not _DIGEST.fullmatch(digest):
        raise BundleMismatch(f'{node_id} carries no usable content digest ({digest!r})')
    return os.path.join(cache_root(), node_id, digest)


async def _ensure_cached(entry: Dict[str, Any], org_id: str, actor: str) -> str:
    """The cache slot for one node, populated if it was not already.

    Concurrency is handled by building somewhere else and moving into place:
    a second run either finds the slot already there, or loses the rename and
    uses the winner's copy. No lock, and no half-written slot is ever visible
    under the real name.
    """
    node_id = str(entry['id'])
    digest = str(entry.get('bundleSha256') or '')
    slot = cache_slot(node_id, digest)
    if os.path.isdir(slot):
        debug(f'[node_resolve] {node_id} already cached')
        return slot

    data = _verified(await _bundle_of(org_id, node_id, int(entry['version']), actor), digest, node_id)
    staging = f'{slot}.{os.getpid()}.partial'
    shutil.rmtree(staging, ignore_errors=True)
    try:
        _unpack_into(data, staging, node_id)
        os.makedirs(os.path.dirname(slot), exist_ok=True)
        try:
            os.rename(staging, slot)
        except OSError:
            # Another run got there first. Its copy has the same digest, so it
            # is the same bytes — use it and drop ours.
            if not os.path.isdir(slot):
                raise
            shutil.rmtree(staging, ignore_errors=True)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return slot


# =============================================================================
# MATERIALISE — the layout the engine imports from
# =============================================================================


def _place(slot: str, run_root: str, node_id: str) -> str:
    """Put one cached node where this run's engine will import it from."""
    package = os.path.join(run_root, RUN_PACKAGE)
    os.makedirs(package, exist_ok=True)
    init_py = os.path.join(package, '__init__.py')
    if not os.path.exists(init_py):
        with open(init_py, 'wb') as handle:
            handle.write(_PACKAGE_INIT)
    destination = os.path.join(package, node_id)
    if os.path.exists(destination):
        shutil.rmtree(destination, ignore_errors=True)
    shutil.copytree(slot, destination)
    return destination


async def _satisfy_requirements(placed: str, node_id: str) -> bool:
    """Install what the node declares, if it declares anything.

    The engine sweeps its own dependencies once at startup, from a glob a
    node materialised for a run falls outside of — so a published node's
    requirements would otherwise never be installed and its import would fail
    for a reason that looks nothing like the cause.

    Installing happens against the constraints lock, so a node that cannot fit
    the environment is refused instead of quietly downgrading a package
    another node in the same run depends on.

    Returns:
        True if the node declared requirements and they were installed.

    Raises:
        DependencyFailure: the node's requirements cannot be satisfied.
    """
    import asyncio

    path = os.path.join(placed, NODE_REQUIREMENTS)
    if not os.path.exists(path):
        return False
    try:
        # Off the event loop: this reaches the network and takes a while.
        await asyncio.wait_for(
            asyncio.get_running_loop().run_in_executor(None, _install, path),
            timeout=INSTALL_TIMEOUT,
        )
    except asyncio.TimeoutError as exc:
        # The run stops with something a person can act on. The installer
        # process itself is NOT killed here — `depends` drives uv through
        # subprocess calls that take no timeout, so the deadline it needs is
        # its own to add. Worth doing; it is not this module's to reach into.
        raise DependencyFailure(
            f'{node_id} dependency install exceeded {INSTALL_TIMEOUT:.0f}s and the run gave up'
        ) from exc
    except Exception as exc:
        raise DependencyFailure(f'{node_id} declares dependencies that cannot be satisfied here: {exc}') from exc
    debug(f'[node_resolve] installed requirements for {node_id}')
    return True


async def materialise(plan: List[Dict[str, Any]], run_root: str, org_id: str, actor: str) -> List[str]:
    """Bring every planned node onto this machine, ready to import.

    Returns the directory written for each. A node placed this way is
    indistinguishable from one sitting in a developer's workspace, which is
    why nothing downstream — including the node's own manifest — has to know
    it arrived seconds ago.

    The engine still has to be told to look again; that is the one piece this
    cannot do from Python yet.
    """
    written: List[str] = []
    for entry in plan:
        node_id = str(entry['id'])
        slot = await _ensure_cached(entry, org_id, actor)
        placed = _place(slot, run_root, node_id)
        await _satisfy_requirements(placed, node_id)
        written.append(placed)
        debug(f'[node_resolve] materialised {node_id} v{entry["version"]}')
    return written


def clean(run_root: str) -> None:
    """Drop what this run unpacked. The cache is untouched and stays warm."""
    shutil.rmtree(os.path.join(run_root, RUN_PACKAGE), ignore_errors=True)
