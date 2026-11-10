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

"""
The hostile fixture set for the public-pages aggregate and leak tests.

One in-memory platform state holding the apps that may contribute to the public
surface NEXT TO every kind of app that must never contribute. The publish rows
run through the REAL serving gate and visibility filters
(``app_rows.serving_block_of``); only the storage layer (``publish_list`` /
``deployments_artifact``) is faked.

Visible:
    rocketride.home   the root claimant: listed + unlisted pages, the site
                      block
    acme.brandy       a published, approved, built store app
    acme.hostile      a published store app whose metadata is an XSS,
                      Mustache and markdown-injection payload (must stay inert)

Never visible (the leak set: ``LEAK_MARKERS`` are planted in every field):
    rocketride.secret     platform app, public row DISABLED (unpublished)
    rocketride.review     platform app, public row on an unapproved version
    rocketride.building   platform app, public row on an unbuilt version
    rocketride.gated      platform app behind requiredPermissions
    rocketride.preview    platform app pinned on a TEAM rung only (pre-release)
    acme.private          store app pinned to a user rung only
    acme.orgonly          store app pinned to a team rung only (org-scoped)
    acme.unpublished      store app with a removed public row
    acme.unlisted         store app whose manifest says public: false
    acme.dbhidden         the same, shaped like the DB edition: its binding row's
                          fixed snapshot columns carry NO public flag, only the
                          artifact's own manifest says public: false
    acme.inreview         store app whose public row points at 'submit'
    acme.permgated        store app behind requiredPermissions
    evil.squatter         a visible third-party store app whose publicPages (a root
                          claim included) and site (redirects included) must never
                          take effect

Every leaky platform manifest also declares a ``site`` block, redirects from
``/<marker>-old`` included: none of it may ever reach the aggregate.
"""

from __future__ import annotations

import copy
import json
from typing import Any, Dict, List

LEAK_MARKERS = (
    'LEAKSECRET',
    'LEAKREVIEW',
    'LEAKBUILDING',
    'LEAKGATED',
    'LEAKPREVIEW',
    'LEAKPRIVATE',
    'LEAKORGONLY',
    'LEAKUNPUBLISHED',
    'LEAKUNLISTED',
    'LEAKDBHIDDEN',
    'LEAKINREVIEW',
    'LEAKPERMGATED',
    'LEAKSQUATTER',
    'leaksecret',
    'leakreview',
    'leakbuilding',
    'leakgated',
    'leakpreview',
    'leakprivate',
    'leakorgonly',
    'leakunpublished',
    'leakunlisted',
    'leakdbhidden',
    'leakinreview',
    'leakpermgated',
    'leaksquatter',
)

HOSTILE_NAME = '<script>alert("n")</script>{{#apps}}x{{/apps}}](https://evil.example)'
HOSTILE_DESCRIPTION = '"><img src=x onerror=alert(1)>\n## Injected heading\n- [phish](https://evil.example)'

PUBLIC = {'type': 'public', 'id': ''}

# The home app in the shape the saas build emits: package.json's appManifest
# (registerApp's field whitelist drops publicPages/site from apps.json) plus a
# separate build/apps/rocketride.home/app-manifest.json holding ONLY
# {publicPages, site}, shipped next to pages/*.html.
HOME_MANIFEST = {
    'id': 'rocketride.home',
    'name': 'RocketRide Cloud',
    'publicPages': [
        {'path': '/', 'title': 'RocketRide', 'description': 'Build AI at rocket speed.'},
        {'path': '/pricing', 'title': 'Pricing', 'description': 'Plans and prices.', 'data': ['plans']},
        {'path': '/marketplace', 'title': 'Marketplace', 'description': 'Apps.'},
        {'path': '/store', 'title': 'Marketplace', 'description': 'Alias.', 'listed': False},
    ],
    'site': {
        'title': 'RocketRide',
        'blurb': 'The blurb.',
        'docsUrl': 'https://docs.rocketride.org/llms.txt',
        'redirects': [{'from': '/plans', 'to': '/pricing'}],
        'organization': {
            'name': 'RocketRide',
            'url': 'https://rocketride.ai',
            'description': 'AI pipelines.',
            'sameAs': ['https://github.com/rocketride-org', 'https://www.linkedin.com/company/rocketride'],
        },
    },
}

# The faked store's bytes (store path -> bytes), reset per test by conftest.
FILES: Dict[str, bytes] = {}


async def read_file(path: str) -> bytes:
    """``public_pages.read_artifact_file`` over FILES (StorageNotFoundError when absent)."""
    from ai.account.store import StorageNotFoundError

    if path not in FILES:
        raise StorageNotFoundError(f'File not found: {path}')
    return FILES[path]


async def file_info(path: str) -> Dict[str, Any]:
    """``public_pages.artifact_file_info`` over FILES (StorageNotFoundError when absent)."""
    from ai.account.store import StorageNotFoundError

    if path not in FILES:
        raise StorageNotFoundError(f'File not found: {path}')
    return {'size': len(FILES[path]), 'modified': 0.0}


def dist_of(org: str, app_id: str, version: int = 1) -> str:
    """A version's store dist tree (where app-manifest.json and pages/*.html live)."""
    return f'orgs/{org}/files/.deployments/{app_id}/v{version:06d}-abc/dist'


def _leaky_manifest(app_id: str, marker: str, *, public: bool = True, pages: bool = True) -> Dict[str, Any]:
    """A manifest that plants ``marker`` in every crawler-reachable field."""
    slug = marker.lower()
    manifest: Dict[str, Any] = {
        'id': app_id,
        'name': f'{marker} name',
        'description': f'{marker} description',
        'publisher': f'{marker} publisher',
        'categories': [f'{marker}-category'],
        'public': public,
    }
    if pages:
        manifest['publicPages'] = [
            {'path': f'/{slug}', 'title': f'{marker} title', 'description': f'{marker} page'},
            {'path': f'/{slug}-hidden', 'title': f'{marker} hidden', 'listed': False},
        ]
        manifest['site'] = {
            'title': f'{marker} site',
            'blurb': f'{marker} blurb',
            'redirects': [{'from': f'/{slug}-old', 'to': f'/{slug}'}],
        }
    return manifest


class HostileAccount:
    """The faked storage layer: cross-org publish rows + artifacts.

    ``rows`` are publish rows in the contract shape the file/DB backends
    return; ``artifacts`` maps (org, app, version) to the app artifact with
    ``metadata.manifest`` attached (both backends attach it).
    """

    capabilities = ('saas',)
    review_ladder = True

    def __init__(self) -> None:
        self.rows: List[Dict[str, Any]] = []
        self.artifacts: Dict[tuple, Dict[str, Any]] = {}
        self.publish_list_calls = 0
        self.fail = False

    # -- seeding -----------------------------------------------------------------

    def add(
        self,
        org: str,
        app_id: str,
        manifest: Dict[str, Any],
        *,
        version: int = 1,
        audience: Dict[str, str] = PUBLIC,
        state: str = 'enabled',
        artifact_state: str = 'ready',
        build: str = 'ok',
        required: Any = None,
        published_at: float = 1_700_000_000.0,
        emit: bool = False,
        db_edition: bool = False,
    ) -> None:
        """Seed one publish row + artifact.

        ``emit``: ship publicPages/site the saas way, in the version's
        ``dist/app-manifest.json``, and strip them from metadata.manifest
        (apps.json's field whitelist drops them). ``db_edition``: the row's
        snapshot omits ``public``, as the DB edition's fixed columns do.
        """
        artifact_path = f'orgs/{org}/files/.deployments/{app_id}/v{version:06d}-abc.json'
        if emit:
            sections = ('publicPages', 'site')
            emitted = {k: manifest[k] for k in sections if k in manifest}
            FILES[f'{dist_of(org, app_id, version)}/app-manifest.json'] = json.dumps(emitted).encode()
            manifest = {k: v for k, v in manifest.items() if k not in sections}
        self.rows.append(
            {
                'orgId': org,
                'appId': app_id,
                'audience': dict(audience),
                'version': version,
                'state': state,
                'artifactState': artifact_state,
                'artifactBuild': build,
                'artifactPath': artifact_path,
                'publishedAt': published_at,
                'snapshot': {
                    'name': manifest.get('name', app_id),
                    'publisher': manifest.get('publisher', ''),
                    'description': manifest.get('description', ''),
                    'categories': manifest.get('categories'),
                    'requiredPermissions': required,
                    'public': manifest.get('public', True) is not False,
                },
            }
        )
        if db_edition:
            del self.rows[-1]['snapshot']['public']
        self.artifacts[(org, app_id, version)] = {
            'kind': 'app',
            'appId': app_id,
            'moduleId': app_id.replace('.', '_'),
            'name': manifest.get('name', app_id),
            'appVersion': '1.0.0',
            'metadata': {'manifest': copy.deepcopy(manifest), 'build': {'status': build}},
        }

    # -- the account surface the shell module reads -------------------------------

    async def publish_list(self, org_id: str, kind: str, audiences: List[Dict[str, str]]) -> List[Dict[str, Any]]:
        self.publish_list_calls += 1
        if self.fail:
            raise RuntimeError('store down')
        keys = {(a['type'], a.get('id', '')) for a in audiences}
        return [
            copy.deepcopy(r)
            for r in self.rows
            if (r['audience']['type'], r['audience'].get('id', '')) in keys and r['state'] != 'removed'
        ]

    async def deployments_artifact(self, org_id: str, app_id: str, version: int) -> Dict[str, Any]:
        if self.fail:
            raise RuntimeError('store down')
        return copy.deepcopy(self.artifacts[(org_id, app_id, version)])


def hostile_account() -> HostileAccount:
    """The full hostile platform state (see module docstring)."""
    acct = HostileAccount()
    platform = '00000000-platform'
    acct.add(platform, 'rocketride.home', HOME_MANIFEST, published_at=1_700_000_100.0, emit=True)
    acct.add(
        platform, 'rocketride.secret', _leaky_manifest('rocketride.secret', 'LEAKSECRET'), state='disabled', emit=True
    )
    acct.add(platform, 'rocketride.review', _leaky_manifest('rocketride.review', 'LEAKREVIEW'), artifact_state='submit')
    acct.add(platform, 'rocketride.building', _leaky_manifest('rocketride.building', 'LEAKBUILDING'), build='building')
    acct.add(platform, 'rocketride.gated', _leaky_manifest('rocketride.gated', 'LEAKGATED'), required=['sys.admin'])
    acct.add(
        platform,
        'rocketride.preview',
        _leaky_manifest('rocketride.preview', 'LEAKPREVIEW'),
        audience={'type': 'team', 'id': 'team-1'},
    )
    acct.add(
        'org-acme',
        'acme.brandy',
        {
            'id': 'acme.brandy',
            'name': 'Brandy',
            'description': 'Brand kit generator.',
            'publisher': 'Acme',
            'categories': ['design'],
        },
    )
    acct.add(
        'org-acme',
        'acme.hostile',
        {
            'id': 'acme.hostile',
            'name': HOSTILE_NAME,
            'description': HOSTILE_DESCRIPTION,
            'publisher': '</title><x>',
            'categories': ['"><b>'],
        },
    )
    acct.add(
        'org-acme',
        'acme.private',
        _leaky_manifest('acme.private', 'LEAKPRIVATE', pages=False),
        audience={'type': 'user', 'id': 'user-1'},
    )
    acct.add(
        'org-acme',
        'acme.orgonly',
        _leaky_manifest('acme.orgonly', 'LEAKORGONLY', pages=False),
        audience={'type': 'team', 'id': 'team-acme'},
    )
    acct.add(
        'org-acme',
        'acme.unpublished',
        _leaky_manifest('acme.unpublished', 'LEAKUNPUBLISHED', pages=False),
        state='removed',
    )
    acct.add('org-acme', 'acme.unlisted', _leaky_manifest('acme.unlisted', 'LEAKUNLISTED', public=False, pages=False))
    acct.add(
        'org-acme',
        'acme.dbhidden',
        _leaky_manifest('acme.dbhidden', 'LEAKDBHIDDEN', public=False, pages=False),
        db_edition=True,
    )
    acct.add(
        'org-acme',
        'acme.inreview',
        _leaky_manifest('acme.inreview', 'LEAKINREVIEW', pages=False),
        artifact_state='submit',
    )
    acct.add(
        'org-acme',
        'acme.permgated',
        _leaky_manifest('acme.permgated', 'LEAKPERMGATED', pages=False),
        required=['sys.app'],
    )
    # A legitimately published store app (its LISTING is visible) whose
    # publicPages and site, a root claim included, must never take effect.
    squatter = _leaky_manifest('evil.squatter', 'LEAKSQUATTER')
    squatter.update(name='Squatter', description='A store app.', publisher='Evil', categories=['tools'])
    squatter['publicPages'].append({'path': '/', 'title': 'LEAKSQUATTER root'})
    squatter['site']['redirects'].append({'from': '/terms', 'to': '/'})
    acct.add('org-evil', 'evil.squatter', squatter)
    return acct
