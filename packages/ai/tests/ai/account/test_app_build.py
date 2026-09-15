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

"""Unit tests for the app BUILD WORKER (ai/account/app_build.py).

No network and no real toolchain: the subprocess seam (``_exec``) is patched
with a phase-aware fake, the toolchain env is a fixture directory, and the
store is the REAL Store over a temp filesystem — so materialization,
workspace surgery, phase sequencing, argv contracts, drift detection, the
harvest layout, and the metadata.build lifecycle all run for real while the
only faked thing is the external tools themselves. The real-toolchain path
is covered by the e2e deploy flow on dev machines/CI, not here.
"""

import io
import json
import os
import time
import zipfile
from typing import Any, Dict, List

import pytest

from ai.account import account as account_singleton
from ai.account import app_build
from ai.account.app_build import (
    AppBuildWorker,
    BuildFailure,
    BuildInfraFailure,
    _drift_of,
    _lockfile_importer_pins,
    _patched_workspace_yaml,
    _safe_asset_rel,
)
from ai.account.store import Store

# =============================================================================
# WORKSPACE YAML SURGERY — the ONE deliberate edit + the alias guard
# =============================================================================


def test_workspace_yaml_forces_platform_overrides_over_tgz_style():
    """A dev workspace's tgz-style shell override is re-pointed to the
    server's placed tgzs; every other key survives.
    """
    source = 'packages:\n  - apps/*\noverrides:\n  shell: file:.rocketride/shell/old.tgz\nsomeKey: kept\n'
    out = _patched_workspace_yaml(source, 'apps/foo-ui', [])
    import yaml

    data = yaml.safe_load(out)
    assert data['overrides']['shell'] == 'file:.rocketride/shell/shell.tgz'
    assert data['overrides']['rocketride'] == 'file:.rocketride/client/rocketride.tgz'
    assert data['packages'] == ['apps/*']
    assert data['someKey'] == 'kept'


def test_workspace_yaml_replaces_workspace_protocol_override():
    """The in-repo `shell: workspace:*` override is unresolvable server-side
    — the forced override replaces it unconditionally.
    """
    out = _patched_workspace_yaml('packages: [apps/*]\noverrides: {shell: "workspace:*"}\n', 'apps/foo-ui', [])
    import yaml

    assert yaml.safe_load(out)['overrides']['shell'] == 'file:.rocketride/shell/shell.tgz'


def test_workspace_yaml_minimal_fallback_when_absent():
    """No packed workspace yaml -> minimal generated one: the packed
    importers plus the same two platform overrides.
    """
    out = _patched_workspace_yaml(None, 'apps/foo-ui', ['apps/shared'])
    import yaml

    data = yaml.safe_load(out)
    assert data['packages'] == ['apps/foo-ui', 'apps/shared']
    assert set(data['overrides']) == {'shell', 'rocketride'}


def test_workspace_yaml_refuses_typescript_alias():
    """The typecheck gate executes the real typescript at the user's version
    — an override wearing the name is refused at preflight.
    """
    with pytest.raises(BuildFailure) as exc:
        _patched_workspace_yaml('overrides: {typescript: "npm:evil@1.0.0"}\n', 'apps/foo-ui', [])
    assert 'typescript' in str(exc.value)


# =============================================================================
# MANIFEST ASSET PATHS — relative-only inside the app dir
# =============================================================================


def test_safe_asset_rel_accepts_plain_relative_paths():
    assert _safe_asset_rel('icon.svg') == 'icon.svg'
    assert _safe_asset_rel('assets/readme.md') == 'assets/readme.md'
    assert _safe_asset_rel('./icon.svg') == 'icon.svg'


def test_safe_asset_rel_refuses_traversal_and_absolute():
    """Traversal, absolute, drive-letter, and empty paths never resolve —
    the parked icon-path-traversal item, closed.
    """
    for bad in ('../x.svg', 'a/../../x', '/etc/passwd', 'c:/x.svg', '', 'a\x00b'):
        assert _safe_asset_rel(bad) is None


# =============================================================================
# LOCKFILE PARSING + DRIFT
# =============================================================================

_LOCK_BEFORE = """
lockfileVersion: '9.0'
importers:
  .:
    dependencies: {}
  apps/foo-ui:
    dependencies:
      react:
        specifier: ^18.2.0
        version: 18.2.0
      shell:
        specifier: file:../../.rocketride/shell/shell.tgz
        version: file:.rocketride/shell/shell.tgz
  apps/other-ui:
    dependencies:
      lodash:
        specifier: ^4.0.0
        version: 4.17.21
"""


def test_lockfile_importer_pins_walks_importers():
    pins = _lockfile_importer_pins(_LOCK_BEFORE)
    assert pins['apps/foo-ui']['react'] == '18.2.0'
    assert pins['apps/other-ui']['lodash'] == '4.17.21'


def test_drift_ignores_platform_packages_and_pruned_importers():
    """shell/rocketride are EXPECTED to change (the server swapped its tgzs
    in); importers pruned by the reconciling install are not drift.
    """
    before = _lockfile_importer_pins(_LOCK_BEFORE)
    after = {
        'apps/foo-ui': {'react': '18.2.0', 'shell': 'file:CHANGED'},
        # apps/other-ui pruned (not packed) — expected, not drift
    }
    assert _drift_of(before, after) == []


def test_drift_names_the_reresolved_package():
    before = _lockfile_importer_pins(_LOCK_BEFORE)
    after = {'apps/foo-ui': {'react': '18.3.1'}}
    drift = _drift_of(before, after)
    assert drift == ['apps/foo-ui: react 18.2.0 -> 18.3.1']


def test_lockfile_parser_is_tolerant():
    """Unrecognized shapes yield {} — the lock is a fidelity feature, never
    a gate on its own.
    """
    assert _lockfile_importer_pins('not: [valid') == {}
    assert _lockfile_importer_pins('just: scalars') == {}


# =============================================================================
# THE JOB — phase sequencing, argv contracts, harvest, lifecycle
# =============================================================================


def _app_source_zip(with_lock: bool = False, lock_text: str = '') -> bytes:
    """A workspace-relative source pack for apps/brandy-ui (the client's shape)."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr(
            'apps/brandy-ui/package.json',
            json.dumps(
                {
                    'name': 'brandy-ui',
                    'version': '1.0.0',
                    'appManifest': {'id': 'acme.brandy', 'name': 'Brandy', 'icon': 'icon.svg'},
                    'dependencies': {'react': '^18.2.0'},
                }
            ),
        )
        archive.writestr('apps/brandy-ui/tsconfig.json', json.dumps({'compilerOptions': {'strict': True}}))
        archive.writestr('apps/brandy-ui/src/index.ts', "import('./AppDescriptor');")
        archive.writestr('apps/brandy-ui/src/AppDescriptor.ts', 'export default {};')
        archive.writestr('apps/brandy-ui/icon.svg', '<svg/>')
        archive.writestr('apps/brandy-ui/postcss.config.js', 'require("evil");')
        if with_lock:
            archive.writestr('pnpm-lock.yaml', lock_text)
            archive.writestr('pnpm-workspace.yaml', 'packages:\n  - apps/*\n')
            archive.writestr('package.json', json.dumps({'name': 'ws-root', 'private': True}))
    return buffer.getvalue()


class _FakeRail:
    """The account rail as the worker sees it: one app version + stamps."""

    def __init__(self, zip_bytes: bytes, build: Dict[str, Any]):
        self.stamps: List[Dict[str, Any]] = []
        self.entry = {
            'version': 1,
            'state': 'private',
            'metadata': {
                'manifest': {'id': 'acme.brandy', 'name': 'Brandy', 'icon': 'icon.svg'},
                'appRoot': 'apps/brandy-ui',
                'build': dict(build),
            },
            'publishedBy': {'userId': 'u1', 'display': 'Dev', 'email': ''},
            'artifactPath': 'orgs/org1/files/.deployments/acme.brandy/v000001-abcdef12.json',
        }
        self.artifact = {'kind': 'app', 'appId': 'acme.brandy', 'moduleId': 'acme_brandy', 'appVersion': '1.0.0'}
        self.zip_bytes = zip_bytes

    def install(self, monkeypatch):
        async def deployments_versions(org_id, project_id):
            return [dict(self.entry)]

        async def deployments_artifact(org_id, project_id, version):
            return dict(self.artifact)

        async def deployments_set_build(org_id, project_id, version, build):
            self.stamps.append(dict(build))
            self.entry['metadata']['build'] = dict(build)
            return dict(self.entry)

        async def deployments_scan_builds(statuses):
            status = str((self.entry['metadata'].get('build') or {}).get('status') or '')
            if status in statuses:
                return [{'orgId': 'org1', 'projectId': 'acme.brandy', 'version': 1}]
            return []

        for name, fn in (
            ('deployments_versions', deployments_versions),
            ('deployments_artifact', deployments_artifact),
            ('deployments_set_build', deployments_set_build),
            ('deployments_scan_builds', deployments_scan_builds),
        ):
            monkeypatch.setattr(account_singleton, name, fn, raising=False)


@pytest.fixture
def build_store(monkeypatch, tmp_path):
    """The REAL Store over a temp filesystem (the worker's store side)."""
    monkeypatch.setenv('RR_STORE_URL', f'filesystem://{tmp_path / "store"}')
    Store.reset()
    yield tmp_path / 'store'
    Store.reset()


@pytest.fixture
def toolchain(monkeypatch, tmp_path):
    """A fixture toolchain env + engine static tree + scratch root.

    The env carries just enough package.json/bin structure for
    ``_resolve_bin``/``_installed_version``/``_resolve_user_tsc`` to work;
    the engine static tree carries placeholder platform tgzs.
    """
    env = tmp_path / 'env'
    for pkg, version, bins in (
        ('@rsbuild/core', '2.0.11', {'rsbuild': 'bin/rsbuild.js'}),
        ('@module-federation/rsbuild-plugin', '2.5.1', {}),
        ('typescript', '5.3.3', {'tsc': 'bin/tsc'}),
    ):
        pkg_dir = env / 'node_modules' / pkg
        pkg_dir.mkdir(parents=True)
        (pkg_dir / 'package.json').write_text(json.dumps({'name': pkg, 'version': version, 'bin': bins}))
        for rel in bins.values():
            bin_path = pkg_dir / rel
            bin_path.parent.mkdir(parents=True, exist_ok=True)
            bin_path.write_text('// stub')
    engine = tmp_path / 'engine'
    (engine / 'static' / 'clients' / 'shell').mkdir(parents=True)
    (engine / 'static' / 'clients' / 'shell' / 'shell.tgz').write_bytes(b'shell-tgz')
    (engine / 'static' / 'clients' / 'typescript').mkdir(parents=True)
    (engine / 'static' / 'clients' / 'typescript' / 'rocketride-1.3.0.tgz').write_bytes(b'rr-tgz')
    scratch = tmp_path / 'scratch'
    scratch.mkdir()

    async def ensure_env(on_line=None):
        return str(env)

    monkeypatch.setattr(app_build, '_ensure_toolchain_env', ensure_env)
    monkeypatch.setattr(app_build, '_engine_dir', lambda: str(engine))
    monkeypatch.setattr(app_build, '_scratch_root', lambda: str(scratch))
    monkeypatch.setattr(app_build, '_find_node', lambda: 'node')
    monkeypatch.setattr(app_build, '_find_pnpm', lambda: 'pnpm')
    return {'env': env, 'engine': engine, 'scratch': scratch}


class _FakeExec:
    """Phase-aware ``_exec`` stand-in: records argv, simulates tool output."""

    def __init__(self):
        self.calls: List[Dict[str, Any]] = []
        self.install_hook = None  # optional callable(cwd) run at install
        self.typecheck_exit = 0
        self.typecheck_out = ''

    async def __call__(self, argv: List[str], cwd: str, timeout: int, on_line=None) -> 'tuple[int, str]':
        self.calls.append({'argv': list(argv), 'cwd': cwd, 'timeout': timeout})
        if 'install' in argv:
            if self.install_hook:
                self.install_hook(cwd)
            return 0, 'install ok'
        if any('tsc' in str(a) for a in argv):
            return self.typecheck_exit, self.typecheck_out or 'typecheck ok'
        if 'build' in argv:
            # The bundler writes the out tree: --config <jobdir>/.build/... ->
            # the out dir is the jobdir's .out (the emitted config's distPath).
            config = argv[argv.index('--config') + 1]
            out_dir = os.path.join(os.path.dirname(os.path.dirname(config)), '.out')
            os.makedirs(os.path.join(out_dir, 'static', 'js'), exist_ok=True)
            with open(os.path.join(out_dir, 'remoteEntry.js'), 'w', encoding='utf-8') as handle:
                handle.write('// remote')
            with open(os.path.join(out_dir, 'static', 'js', 'index.js'), 'w', encoding='utf-8') as handle:
                handle.write('// chunk')
            return 0, 'bundle ok'
        return 0, ''


async def _seed_zip(zip_bytes: bytes) -> None:
    """Land the retained transport zip where the receipt would have."""
    raw = Store.instance()._store
    await raw.write_bytes(
        'orgs/org1/files/.deployments/acme.brandy/v000001-abcdef12/bundle/acme.brandy-v000001.zip', zip_bytes
    )


@pytest.mark.asyncio
async def test_job_builds_end_to_end(monkeypatch, build_store, toolchain):
    """The full phase chain: materialize -> install -> typecheck -> bundle ->
    harvest, with the store dist/ populated (manifest icon included), the
    canonical config emitted OUTSIDE the app dir, postcss neutralized, the
    platform tgzs placed, and metadata.build ending 'ok'.
    """
    rail = _FakeRail(_app_source_zip(), {'status': 'queued', 'attempt': 0})
    rail.install(monkeypatch)
    await _seed_zip(rail.zip_bytes)
    fake = _FakeExec()
    monkeypatch.setattr(app_build, '_exec', fake)

    # Capture the materialized tree mid-flight (it is deleted afterwards):
    # the install hook runs with cwd = the ws dir.
    seen: Dict[str, Any] = {}

    def inspect(cwd):
        seen['postcss'] = open(os.path.join(cwd, 'apps', 'brandy-ui', 'postcss.config.js'), encoding='utf-8').read()
        seen['shell_tgz'] = os.path.isfile(os.path.join(cwd, '.rocketride', 'shell', 'shell.tgz'))
        seen['rr_tgz'] = os.path.isfile(os.path.join(cwd, '.rocketride', 'client', 'rocketride.tgz'))
        import yaml

        seen['overrides'] = yaml.safe_load(open(os.path.join(cwd, 'pnpm-workspace.yaml'), encoding='utf-8'))[
            'overrides'
        ]
        job_dir = os.path.dirname(cwd)
        seen['config'] = open(os.path.join(job_dir, '.build', 'rsbuild.config.mjs'), encoding='utf-8').read()

    fake.install_hook = inspect

    worker = AppBuildWorker(server=None)
    requeue = await worker._run_job('org1', 'acme.brandy', 1)
    assert requeue is False

    # Lifecycle: building (materialize) ... ok, phases in order.
    assert rail.stamps[0]['status'] == 'building'
    assert [s['phase'] for s in rail.stamps] == ['materialize', 'install', 'typecheck', 'bundle', 'harvest', 'harvest']
    assert rail.stamps[-1]['status'] == 'ok'
    assert rail.stamps[-1]['toolchain']['mf'] == '2.5.1'

    # Install argv contract: non-frozen EXPLICIT, scripts ignored, filtered
    # to the packed importer; devDependencies NOT excluded (no --prod).
    install = next(c for c in fake.calls if 'install' in c['argv'])
    for flag in ('--no-frozen-lockfile', '--ignore-scripts', '--prefer-offline'):
        assert flag in install['argv']
    assert '--prod' not in install['argv']
    assert install['argv'][install['argv'].index('--filter') + 1] == './apps/brandy-ui'

    # The materialized workspace: forced overrides, placed tgzs, inert postcss,
    # and the canonical config OUTSIDE the app dir with the moduleId literal.
    assert seen['overrides']['shell'] == 'file:.rocketride/shell/shell.tgz'
    assert seen['shell_tgz'] and seen['rr_tgz']
    assert 'evil' not in seen['postcss']
    assert '"acme_brandy"' in seen['config']
    assert './AppDescriptor' in seen['config']

    # Harvest: the store dist/ carries the bundle AND the manifest icon;
    # the full build log lands beside it. Scratch is cleaned.
    home = build_store / 'orgs' / 'org1' / 'files' / '.deployments' / 'acme.brandy' / 'v000001-abcdef12'
    assert (home / 'dist' / 'remoteEntry.js').is_file()
    assert (home / 'dist' / 'static' / 'js' / 'index.js').is_file()
    assert (home / 'dist' / 'icon.svg').is_file()
    assert (home / 'build.log').is_file()
    assert list((toolchain['scratch']).iterdir()) == []


@pytest.mark.asyncio
async def test_job_typecheck_failure_is_terminal_with_tsc_errors(monkeypatch, build_store, toolchain):
    """A tsc failure ends 'failed' (state untouched — redeploy-to-fix) with
    the diagnostics in build.log's failure tail — the DB blob carries NO
    error text; no dist/ is written.
    """
    rail = _FakeRail(_app_source_zip(), {'status': 'queued', 'attempt': 0})
    rail.install(monkeypatch)
    await _seed_zip(rail.zip_bytes)
    fake = _FakeExec()
    fake.typecheck_exit = 2
    fake.typecheck_out = "src/App.tsx(12,3): error TS2322: Type 'x' is not assignable.\nsome noise"
    monkeypatch.setattr(app_build, '_exec', fake)

    worker = AppBuildWorker(server=None)
    requeue = await worker._run_job('org1', 'acme.brandy', 1)
    assert requeue is False
    final = rail.stamps[-1]
    assert (final['status'], final['phase']) == ('failed', 'typecheck')
    assert 'errors' not in final  # error text lives ONLY in build.log
    home = build_store / 'orgs' / 'org1' / 'files' / '.deployments' / 'acme.brandy' / 'v000001-abcdef12'
    assert not (home / 'dist').exists()
    log_text = (home / 'build.log').read_text(encoding='utf-8')  # the log survives failure
    assert 'error TS2322' in log_text  # the diagnostics land in the failure tail
    assert 'app-build-' not in log_text  # the scratch dir is scrubbed to <build>


@pytest.mark.asyncio
async def test_job_typecheck_waiver_skips_the_verify_phase(monkeypatch, build_store, toolchain):
    """appManifest.typecheck: false (the PACKAGE tab's waiver) skips the
    verify phase entirely: the build succeeds despite a tsc that WOULD
    have failed, no tsc runs, and the waiver is recorded in build.log —
    visible, never silent.
    """
    rail = _FakeRail(_app_source_zip(), {'status': 'queued', 'attempt': 0})
    rail.entry['metadata']['manifest']['typecheck'] = False
    rail.install(monkeypatch)
    await _seed_zip(rail.zip_bytes)
    fake = _FakeExec()
    fake.typecheck_exit = 2
    fake.typecheck_out = 'src/App.tsx(1,1): error TS9999: would have failed the build'
    monkeypatch.setattr(app_build, '_exec', fake)

    worker = AppBuildWorker(server=None)
    assert await worker._run_job('org1', 'acme.brandy', 1) is False
    final = rail.stamps[-1]
    assert final['status'] == 'ok'
    # The verify phase never reached the exec seam.
    assert not any('--noEmit' in ' '.join(c['argv']) for c in fake.calls)
    home = build_store / 'orgs' / 'org1' / 'files' / '.deployments' / 'acme.brandy' / 'v000001-abcdef12'
    log_text = (home / 'build.log').read_text(encoding='utf-8')
    assert 'skipped by appManifest.typecheck: false' in log_text
    assert (home / 'dist' / 'remoteEntry.js').is_file()


@pytest.mark.asyncio
async def test_job_drift_fails_reasoned(monkeypatch, build_store, toolchain):
    """A packed lockfile whose pins re-resolve during install fails the
    post-install diff with the drifted package named (shell/rocketride
    changes are whitelisted — the server swapped those in itself).
    """
    lock = (
        "lockfileVersion: '9.0'\n"
        'importers:\n'
        '  apps/brandy-ui:\n'
        '    dependencies:\n'
        '      react: {specifier: ^18.2.0, version: 18.2.0}\n'
    )
    rail = _FakeRail(_app_source_zip(with_lock=True, lock_text=lock), {'status': 'queued', 'attempt': 0})
    rail.install(monkeypatch)
    await _seed_zip(rail.zip_bytes)
    fake = _FakeExec()

    def drifting_install(cwd):
        with open(os.path.join(cwd, 'pnpm-lock.yaml'), 'w', encoding='utf-8') as handle:
            handle.write(lock.replace('18.2.0}', '18.3.1}'))

    fake.install_hook = drifting_install
    monkeypatch.setattr(app_build, '_exec', fake)

    worker = AppBuildWorker(server=None)
    await worker._run_job('org1', 'acme.brandy', 1)
    final = rail.stamps[-1]
    assert (final['status'], final['phase']) == ('failed', 'install')
    assert 'errors' not in final
    home = build_store / 'orgs' / 'org1' / 'files' / '.deployments' / 'acme.brandy' / 'v000001-abcdef12'
    assert 'react 18.2.0 -> 18.3.1' in (home / 'build.log').read_text(encoding='utf-8')


@pytest.mark.asyncio
async def test_job_infra_failure_requeues_then_exhausts(monkeypatch, build_store, toolchain):
    """A platform-flavored failure requeues (attempt 1 -> 2), then lands
    'failed' with the reason once attempts are exhausted.
    """
    rail = _FakeRail(_app_source_zip(), {'status': 'queued', 'attempt': 0})
    rail.install(monkeypatch)
    await _seed_zip(rail.zip_bytes)

    async def broken_exec(argv, cwd, timeout, on_line=None):
        raise BuildInfraFailure('install', 'registry unreachable')

    monkeypatch.setattr(app_build, '_exec', broken_exec)
    worker = AppBuildWorker(server=None)

    # Drive the loop from the CONSTANT: every attempt but the last requeues,
    # the last lands the reasoned failure — raising _MAX_ATTEMPTS must not
    # silently turn this test into a lie about the attempt budget.
    for _ in range(app_build._MAX_ATTEMPTS - 1):
        assert await worker._run_job('org1', 'acme.brandy', 1) is True  # requeue
        assert rail.stamps[-1]['status'] == 'queued'
    assert await worker._run_job('org1', 'acme.brandy', 1) is False  # exhausted
    final = rail.stamps[-1]
    assert final['status'] == 'failed'
    assert 'errors' not in final
    home = build_store / 'orgs' / 'org1' / 'files' / '.deployments' / 'acme.brandy' / 'v000001-abcdef12'
    assert 'registry unreachable' in (home / 'build.log').read_text(encoding='utf-8')


@pytest.mark.asyncio
async def test_job_unexpected_exception_never_strands_building(monkeypatch, build_store, toolchain):
    """An UNEXPECTED error (not a Build*Failure) rides the infra path —
    requeued while attempts remain, then a reasoned 'failed'. A row must
    never strand in 'building' with no outcome (the copytree-crash lesson).
    """
    rail = _FakeRail(_app_source_zip(), {'status': 'queued', 'attempt': 0})
    rail.install(monkeypatch)
    await _seed_zip(rail.zip_bytes)

    async def buggy_exec(argv, cwd, timeout, on_line=None):
        raise RuntimeError('unexpected OS quirk')

    monkeypatch.setattr(app_build, '_exec', buggy_exec)
    worker = AppBuildWorker(server=None)

    # Constant-driven like the infra test above — one budget, one truth.
    for _ in range(app_build._MAX_ATTEMPTS - 1):
        assert await worker._run_job('org1', 'acme.brandy', 1) is True  # requeue
        assert rail.stamps[-1]['status'] == 'queued'
    assert await worker._run_job('org1', 'acme.brandy', 1) is False  # exhausted
    final = rail.stamps[-1]
    assert final['status'] == 'failed'
    assert 'errors' not in final
    home = build_store / 'orgs' / 'org1' / 'files' / '.deployments' / 'acme.brandy' / 'v000001-abcdef12'
    assert 'unexpected OS quirk' in (home / 'build.log').read_text(encoding='utf-8')


@pytest.mark.asyncio
async def test_job_rejects_unsafe_zip_entry_at_materialize(monkeypatch, build_store, toolchain):
    """The worker RE-APPLIES the receipt's path guard while unpacking the
    retained transport zip: an entry that would escape ws_dir fails the
    build at 'materialize' and writes nothing outside the workspace. This
    is the last barrier for a zip that reaches the worker without current
    receipt validation (e.g. a requeued row recovered after the receipt
    rules changed).
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as archive:
        archive.writestr('package.json', '{"name": "x", "private": true}')
        archive.writestr('../evil.txt', 'outside the workspace')
    rail = _FakeRail(buf.getvalue(), {'status': 'queued', 'attempt': 0})
    rail.install(monkeypatch)
    await _seed_zip(rail.zip_bytes)
    monkeypatch.setattr(app_build, '_exec', _FakeExec())

    worker = AppBuildWorker(server=None)
    assert await worker._run_job('org1', 'acme.brandy', 1) is False  # user-flavored: no requeue
    final = rail.stamps[-1]
    assert (final['status'], final['phase']) == ('failed', 'materialize')
    assert 'errors' not in final
    home = build_store / 'orgs' / 'org1' / 'files' / '.deployments' / 'acme.brandy' / 'v000001-abcdef12'
    assert 'unsafe path' in (home / 'build.log').read_text(encoding='utf-8')
    # Nothing escaped: no evil.txt anywhere under the scratch root.
    assert not list(toolchain['scratch'].rglob('evil.txt'))


def test_rmtree_clears_trees_past_windows_max_path(tmp_path):
    """The scratch cleaner must delete trees whose entries cross Windows'
    260-char MAX_PATH — measured at ~290 in real scratch dirs (pnpm .pnpm
    names + module-federation dist depth, NO include roots needed). A plain
    rmtree(ignore_errors=True) silently LEAKED them, and the aged startup
    sweep used the same call, so nothing ever reclaimed them.
    """
    from pathlib import Path

    segment = 'component-directory-with-a-real-world-name'
    deep = tmp_path / 'job'
    target = deep
    while len(str(target)) < 300:
        target = target / segment
    assert len(str(target)) > 260
    # Setup needs the extended spelling too — plain mkdir hits the same
    # ceiling the cleaner must overcome.
    make = Path(f'\\\\?\\{target}') if os.name == 'nt' else target
    make.mkdir(parents=True)
    (make / 'ContainerEntryModule.js.map').write_text('x', encoding='utf-8')

    app_build._rmtree(str(deep))
    assert not deep.exists()


def test_rmtree_never_follows_links(tmp_path):
    """Links are removed as LINKS — their targets survive untouched. pnpm
    materializes node_modules through junctions/links into its global
    store, so a cleaner that walked through one would destroy the store.
    Covers both shapes: a link INSIDE the tree, and the root BEING a link.
    """
    import subprocess

    # The protected target, outside the tree, with a sentinel inside.
    store = tmp_path / 'store' / 'protected-package'
    store.mkdir(parents=True)
    sentinel = store / 'sentinel.txt'
    sentinel.write_text('must survive', encoding='utf-8')

    def make_dir_link(link: str, target: str) -> None:
        if os.name == 'nt':
            # Junctions need no privilege (symlinks may) — pnpm's own shape.
            subprocess.run(['cmd', '/c', 'mklink', '/J', link, target], check=True, capture_output=True)
        else:
            os.symlink(target, link)

    # Shape 1: a link inside the tree being cleaned.
    job = tmp_path / 'job'
    (job / 'node_modules').mkdir(parents=True)
    make_dir_link(str(job / 'node_modules' / 'protected-package'), str(store))
    app_build._rmtree(str(job))
    assert not job.exists()
    assert sentinel.read_text(encoding='utf-8') == 'must survive'

    # Shape 2: the root itself is a link — unlinked in place, never entered.
    root_link = tmp_path / 'root-link'
    make_dir_link(str(root_link), str(store))
    app_build._rmtree(str(root_link))
    assert not root_link.exists()
    assert sentinel.read_text(encoding='utf-8') == 'must survive'


def test_scrub_paths_strips_build_root_and_user_home():
    """The log sanitizer: the scratch root collapses to <build> in BOTH
    separator spellings, and any surviving user-home prefix collapses to
    <home> — no host layout or user name reaches the served log.
    """
    root = 'C:\\Users\\SomeUser\\AppData\\Local\\Temp\\app-build-123-acme.brandy-v1-abc'
    text = (
        f'{root}\\ws\\apps\\brandy-ui: ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND\n'
        f'Could not install from "{root.replace(chr(92), "/")}/ws/apps/shared"\n'
        'D:\\Users\\other\\secret\\place also leaks'
    )
    scrubbed = app_build._scrub_paths(text, [root])
    assert root not in scrubbed
    assert 'SomeUser' not in scrubbed
    assert '<build>\\ws\\apps\\brandy-ui' in scrubbed
    assert '<build>/ws/apps/shared' in scrubbed
    assert 'other' not in scrubbed and '<home>\\secret\\place' in scrubbed


@pytest.mark.asyncio
async def test_toolchain_bootstrap_is_workspace_proof(monkeypatch, tmp_path):
    """The env bootstrap installs standalone (--ignore-workspace) and fails
    REASONED when pnpm exits 0 without materializing node_modules — the
    workspace-context trap: an env dir inside a checked-out repo makes a
    flagless pnpm walk up, install the REPO's workspace, and leave the env
    empty with exit 0. Also pins the marker lifecycle: short-circuit on a
    matching marker, re-bootstrap on a pin change.
    """
    env = tmp_path / 'env'
    monkeypatch.setattr(app_build, '_env_dir', lambda: str(env))
    monkeypatch.setattr(app_build, '_find_pnpm', lambda: 'pnpm')
    calls = []

    async def hollow_exec(argv, cwd, timeout, on_line=None):
        calls.append(list(argv))
        return 0, 'Done'  # exit 0, nothing materialized

    monkeypatch.setattr(app_build, '_exec', hollow_exec)
    with pytest.raises(BuildInfraFailure) as exc:
        await app_build._ensure_toolchain_env()
    assert 'no node_modules' in str(exc.value)
    assert '--ignore-workspace' in calls[0]

    # A bootstrap that actually materializes the env succeeds and records
    # its pins; the next call short-circuits without another install.
    async def real_exec(argv, cwd, timeout, on_line=None):
        calls.append(list(argv))
        (env / 'node_modules').mkdir(parents=True, exist_ok=True)
        return 0, 'Done'

    monkeypatch.setattr(app_build, '_exec', real_exec)
    assert await app_build._ensure_toolchain_env() == str(env)
    installs = len(calls)
    assert await app_build._ensure_toolchain_env() == str(env)
    assert len(calls) == installs  # marker short-circuit

    # Changed pins re-bootstrap — a platform upgrade must refresh the cache.
    monkeypatch.setattr(app_build, '_TOOLCHAIN_PINS', {**app_build._TOOLCHAIN_PINS, 'typescript': '^9.9.9'})
    assert await app_build._ensure_toolchain_env() == str(env)
    assert len(calls) == installs + 1


@pytest.mark.asyncio
async def test_enqueue_dedupes_and_sweep_requeues(monkeypatch, build_store, toolchain):
    """The pending-set guard refuses duplicates; the startup sweep requeues
    rows left queued/building and clears ONLY AGED scratch dirs — the
    scratch root is shared host temp, so a concurrent engine's live job dir
    (always younger than the TTL bar) must survive the sweep.
    """
    rail = _FakeRail(_app_source_zip(), {'status': 'building', 'attempt': 1})
    rail.install(monkeypatch)
    # An orphan from a crashed process: aged past the TTL bar.
    stale = toolchain['scratch'] / 'app-build-1234-stale-v1-xyz'
    stale.mkdir()
    (stale / 'junk.txt').write_text('x')
    aged = time.time() - app_build._SCRATCH_TTL_SECONDS - 60
    os.utime(stale, (aged, aged))
    # A live concurrent build: fresh mtime.
    live = toolchain['scratch'] / 'app-build-5678-live-v2-abc'
    live.mkdir()

    worker = AppBuildWorker(server=None)
    assert worker.enqueue('org1', 'acme.brandy', 1) is True
    assert worker.enqueue('org1', 'acme.brandy', 1) is False  # duplicate

    fresh = AppBuildWorker(server=None)
    await fresh._startup_sweep()
    assert ('org1', 'acme.brandy', 1) in fresh._pending
    assert not stale.exists()
    assert live.exists()


# =============================================================================
# THE BUILD FEED — live compile output over apaevt_build
# =============================================================================


@pytest.mark.asyncio
async def test_build_feed_batches_and_scopes():
    """The feed batches output lines into org-scoped apaevt_build events
    (phase-stamped, order-preserving); a serverless feed swallows everything
    without touching the wire.
    """
    events = []

    class _Server:
        async def broadcast_server_event(self, event_type, message, org_id=None):
            events.append({'message': message, 'org_id': org_id})

    feed = app_build._BuildFeed(_Server(), 'org1', 'acme.brandy', 1)
    await feed.set_phase('install')
    for i in range(30):
        await feed.line(f'line {i}')
    await feed.flush()
    await feed.status('')  # the success clear

    assert events  # batched, not one-per-line and not zero
    assert all(item['org_id'] == 'org1' for item in events)  # OWNING org only
    replayed = []
    ticks = []
    for item in events:
        body = item['message']['body']
        if item['message']['event'] == 'apaevt_build_status':
            assert (body['appId'], body['version']) == ('acme.brandy', 1)
            ticks.append(body['status'])
        else:
            assert item['message']['event'] == 'apaevt_build'
            assert (body['appId'], body['version'], body['phase']) == ('acme.brandy', 1, 'install')
            replayed += body['lines']
    assert replayed == [f'line {i}' for i in range(30)]
    # The card ticker: the phase's DISPLAY word on entry, '' as the clear.
    assert ticks == ['installing', '']

    before = len(events)
    silent = app_build._BuildFeed(None, 'org1', 'acme.brandy', 1)
    await silent.line('x')
    await silent.status('failed')
    await silent.flush()
    assert len(events) == before  # the serverless feed touched no wire


@pytest.mark.asyncio
async def test_exec_streams_lines_live():
    """The REAL _exec hands each output line to on_line as it arrives and
    still returns the full transcript + exit code (the feed's data source).
    """
    import sys

    seen = []

    async def collect(line):
        seen.append(line)

    code, out = await app_build._exec(
        [sys.executable, '-c', "print('alpha'); print('beta')"], os.getcwd(), 30, on_line=collect
    )
    assert code == 0
    assert seen == ['alpha', 'beta']
    assert 'alpha' in out and 'beta' in out
