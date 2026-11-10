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

from typing import Any, Dict, List

from .deployment_backend import artifact_content_dir

# Audience rungs, least specific first: a more specific binding wins.
RUNG_RANK = {'public': 0, 'team': 1, 'user': 2}


def metadata_of(entry: Dict[str, Any]) -> Dict[str, Any]:
    """An entry's ``metadata`` dict, or an empty one when it is missing or not a dict."""
    metadata = entry.get('metadata')
    if not isinstance(metadata, dict):
        return {}
    return metadata


def manifest_of(entry: Dict[str, Any]) -> Dict[str, Any]:
    """An entry's ``metadata.manifest`` dict (the stored appManifest), or an empty one."""
    manifest = metadata_of(entry).get('manifest')
    if not isinstance(manifest, dict):
        return {}
    return manifest


def dist_dir_of(artifact_path: str) -> str:
    """The servable dist tree of one registry entry (the build's output)."""
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
    """
    required = (row.get('snapshot') or {}).get('requiredPermissions') or []
    return not required or 'sys.admin' in sys_perms or all(p in sys_perms for p in required)
