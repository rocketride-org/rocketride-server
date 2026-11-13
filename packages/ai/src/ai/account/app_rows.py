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

"""Publish-row helpers shared by the store walk and the public page aggregate.

``app_deploy`` hands a browser what these rules let through, and the public
page aggregate (``ai.modules.shell.public_pages``) must load exactly the same
apps. Both import from here, so neither imports the other.
"""

from typing import Any, Dict, List, Optional, Tuple

from .deployment_backend import artifact_content_dir

# Audience rungs, least specific first: a more specific binding wins.
RUNG_RANK = {'public': 0, 'team': 1, 'user': 2}


def metadata_of(entry: Dict[str, Any]) -> Dict[str, Any]:
    """An entry's ``metadata`` dict, or an empty one when it is missing or not a dict.

    Args:
        entry: A registry entry or artifact dict.

    Returns:
        The ``metadata`` dict, or ``{}``.
    """
    metadata = entry.get('metadata')
    if not isinstance(metadata, dict):
        return {}
    return metadata


def manifest_of(entry: Dict[str, Any]) -> Dict[str, Any]:
    """An entry's ``metadata.manifest`` dict (the stored appManifest), or an empty one.

    Args:
        entry: A registry entry or artifact dict.

    Returns:
        The ``metadata.manifest`` dict, or ``{}``.
    """
    manifest = metadata_of(entry).get('manifest')
    if not isinstance(manifest, dict):
        return {}
    return manifest


def dist_dir_of(artifact_path: str) -> str:
    """The servable dist tree of one registry entry (the build's output).

    Args:
        artifact_path: The entry's stored ``artifactPath``.

    Returns:
        The store path of the version's ``dist/`` directory.
    """
    return f'{artifact_content_dir(artifact_path)}/dist'


def serving_block_of(row: Dict[str, Any], review_ladder: bool) -> str:
    """
    Why one publish binding does not serve, or '' when it does.

    THE serving gate, shared by the manifest scope walk (what a browser is
    actually handed) and the owner's where-list (what App Builder says is
    live), so the two can never disagree (#2461). Reasons, first match wins:
    'disabled' (the binding itself), 'failed' (the deployment failed
    processing), 'in-review' / 'rejected' / 'not-approved' (a public binding
    on a review-ladder server needs a 'ready' deployment; internal rungs and
    ladder-less servers do not), then 'build-failed' / 'building' (no
    servable bytes yet — a version serves only once its build is 'ok').

    Args:
        row: One publish row.
        review_ladder: Whether the server gates public bindings on review.

    Returns:
        The reason the binding does not serve, or '' when it does.
    """
    if row.get('state') != 'enabled':
        return 'disabled'
    deploy_state = row.get('artifactState') or ''
    if deploy_state == 'failed':
        return 'failed'
    if (row.get('audience') or {}).get('type') == 'public' and review_ladder and deploy_state != 'ready':
        return {'submit': 'in-review', 'rejected': 'rejected'}.get(deploy_state, 'not-approved')
    build = row.get('artifactBuild')
    if build == 'failed':
        return 'build-failed'
    if build != 'ok':
        return 'building'
    return ''


def precedence_sorted(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Publish rows ordered so the scope-walk WINNER of each app id lands last.

    MORE-SPECIFIC audience wins (user > team > public); on a same-rung tie
    the LOWEST org id wins — the same rule _home_org_of uses, so a stray
    duplicate public row can never let a higher-UUID org displace a lower
    one (the seeded platform org, at the minimum UUID, always holds its
    ids). Rank ascending, org id DESCENDING within a rank, both stable.

    Args:
        rows: Publish rows, any order.

    Returns:
        A new list of the rows, the winner of each app id last.
    """
    ordered = sorted(rows, key=lambda r: str(r.get('orgId') or ''), reverse=True)
    ordered.sort(key=lambda r: RUNG_RANK.get((r.get('audience') or {}).get('type', ''), 0))
    return ordered


def holds_required_permissions(row: Dict[str, Any], sys_perms: Any) -> bool:
    """
    Whether a caller holding ``sys_perms`` passes a binding's declared gate.

    The catalog's own rule (``_catalog_entries``): a manifest declaring
    ``requiredPermissions`` serves only a caller who holds ALL of them, or
    the ``sys.admin`` platform superuser. Anonymous holds none.

    Args:
        row: One publish row.
        sys_perms: The caller's permissions (a set; empty for anonymous).

    Returns:
        True when the caller passes the gate.
    """
    required = (row.get('snapshot') or {}).get('requiredPermissions') or []
    return not required or 'sys.admin' in sys_perms or all(p in sys_perms for p in required)


async def public_winners(acct: Any) -> Tuple[str, Dict[str, Dict[str, Any]]]:
    """
    Each app's winning public binding, as the store walk resolves it for an anonymous caller.

    The public rung is listed under ``''`` (every org) on a SaaS server and
    ``'local'`` otherwise; both store editions return only public rows for
    the public audience. A binding competes only when it serves
    (``serving_block_of``) and requires no permissions; among those, the
    precedence winner (``precedence_sorted``) is each app's. The public page
    map and the ``plans:``/``app:`` page data sources both read the rung
    through here, so they can never disagree about which version serves.

    Args:
        acct: The account layer to read.

    Returns:
        ``(org, winners)``: the org the rung was listed under, which is also
        the org of a winning row that names none; and each app id's winning row.

    Raises:
        Exception: the account layer could not list the public bindings.
    """
    org = 'local'
    if 'saas' in getattr(acct, 'capabilities', ()):
        org = ''
    review_ladder = getattr(acct, 'review_ladder', True)
    winners: Dict[str, Dict[str, Any]] = {}
    for row in precedence_sorted(await acct.publish_list(org, 'app', [{'type': 'public', 'id': ''}])):
        # Rows that do not serve an anonymous caller never compete; the
        # precedence winner among the rest lands last.
        if serving_block_of(row, review_ladder) or not holds_required_permissions(row, set()):
            continue
        winners[str(row.get('appId') or '')] = row
    return org, winners


def resolve_account(acct: Any) -> Any:
    """
    The account layer to read: ``acct``, or the engine's own when None.

    Args:
        acct: An account layer, or None.

    Returns:
        ``acct``, or the ``ai.account.account`` singleton when it is None.
    """
    if acct is None:
        from ai.account import account as acct
    return acct


async def public_artifact(acct: Any, org: str, app_id: str, row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    The artifact an app's winning public row serves, when anonymous callers may see the app.

    The store walk's remaining rules (``app_deploy.resolve_app_pins``) for a
    row ``public_winners`` picked: the binding snapshot does not say
    ``public: false``; the version, read from the row's publisher org (the
    rung's ``org`` when the row names none), is an app artifact; and its own
    manifest does not say ``public: false`` (the DB edition's snapshot
    columns drop ``public``, so the manifest is re-read). The public page map
    and the ``plans:``/``app:`` page data sources both decide visibility
    here, so they can never disagree about which apps are shown.

    Args:
        acct: The account layer to read.
        org: The org ``public_winners`` listed the rung under.
        app_id: The app the row binds.
        row: The app's winning row, from ``public_winners``.

    Returns:
        The artifact, ``metadata.manifest`` attached; None when the app is hidden.

    Raises:
        ValueError: the row of an app not hidden by its binding is malformed:
            its version is not an int or it names no ``artifactPath`` (the
            bound version is not in the registry).
        StorageError: the artifact could not be read.
    """
    snapshot = row.get('snapshot')
    if isinstance(snapshot, dict) and snapshot.get('public', True) is False:
        return None
    version = row.get('version')
    artifact_path = row.get('artifactPath')
    if not isinstance(version, int) or not artifact_path:
        raise ValueError(f'malformed public row (version {version!r}, artifactPath {artifact_path!r})')
    publisher = row.get('orgId')
    if not publisher:
        publisher = org
    artifact = await acct.deployments_artifact(str(publisher), app_id, version)
    if not isinstance(artifact, dict) or artifact.get('kind') != 'app':
        return None
    if manifest_of(artifact).get('public', True) is False:
        return None
    return artifact
