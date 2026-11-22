# =============================================================================
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
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
The doors probe on every rung of a live server: @spec, @me, @team, @org, @public.

One pipeline (webhook -> doors_probe -> response) runs inline on @spec and is
deployed to the four published rungs, with three variants: one declaring the
team's shared folder as a root, one the org's, and one whose config is a
``${ROCKETRIDE_*}`` placeholder. Every call carries a JSON script the probe
runs against its doors; its report says what each door answered. The test
reads that report AND the account store on disk (``~/.rocketlib/store``, or
the ``filesystem://`` root ``RR_STORE_URL`` names) to show:

- each rung's caller, identity record, config and per-call settings;
- each rung's files land in its owner's tree: @spec, @me and @public in the
  user's tree, @team in the team's task subtree, @org in the org's; the disk
  changes with every write, rename and delete;
- ``self.state`` is shared by the user-owned rungs and separate for the team
  and the org, even where the user, team and org ids are one string (every
  id is ``local`` on a standalone server);
- nothing leaves the owner's boundary: every traversal, scoped path, system
  tree, forged or stale binding and write to a read-only view is refused,
  and a scan of the whole store for the run's nonce finds no file outside
  the trees the rungs own;
- a ``self.files`` link serves exactly its file, briefly, and a tampered or
  expired one serves nothing;
- a sub-pipe is the same call (caller, request tree, control, params); a
  forged sub-pipe caller only mislabels, a forged binding reaches nothing,
  and nesting stops at the engine's depth guard;
- a declared root reaches the team's or the org's shared folder and nothing
  around it, and a root the run's owner cannot reach refuses the start;
- a ``${ROCKETRIDE_*}`` value reaches the config, an unreferenced one reaches
  nothing, a name outside the namespace refuses the start, and the engine
  process holds none of the server's own settings.

The run deploys to every rung, @public included, so it only runs against a
server on this machine. It writes no environment variable: the env pipe
references one the server's launcher already set. It removes its
publications, versions, controls and files when it ends.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlencode, urlparse

import pytest
import pytest_asyncio
from rocketlib.doors import FILES_URL_EXPIRES_IN

from ai.constants import CONST_STATE_MAX_KEYS_PER_NODE, CONST_STATE_MAX_TTL_SECONDS, CONST_STATE_MAX_VALUE_BYTES

# ==== Constants ==================================================================

#: The probe's component id in the pipeline.
NODE_ID = 'probe_1'

#: Every rung, in the server's order.
RUNGS = ('spec', 'me', 'team', 'org', 'public')

#: The rungs a user owns: one owner tree and one state scope between them.
USER_RUNGS = ('spec', 'me', 'public')

#: The published rungs: each serves the deployed version.
PUBLISHED_RUNGS = ('me', 'team', 'org', 'public')

#: Hosts the run may deploy to.
LOCAL_HOSTS = frozenset({'127.0.0.1', 'localhost', '::1'})

#: The owner trees the server writes as itself (run logs, deployed versions), never a node.
SYSTEM_TREES = frozenset({'.logs', '.deployments'})

#: The schema's defaults, as the pipeline leaves them.
DEFAULT_SETTINGS = {'label': 'doors', 'greeting': 'hello', 'mode': 'alpha', 'alphaValue': 1}

#: The longest a fetch link lives, whatever a node asks (``FileStore.get_url``).
LINK_MAX_SECONDS = 3600

#: The engine's recursion limit for one request (``CONST_MAX_BIND_DEPTH`` in
#: engine-lib/engLib/store/filters/pipe/pipe.hpp), counted in lane calls in
#: flight by the binder, so a node nests fewer sub-pipes than this.
MAX_BIND_DEPTH = 64

#: A variable the builder's test-server launcher gives the server AND this
#: test process (``ROCKETRIDE_DIST_ROOT``), which the env pipe references, and
#: another from the same launcher it does not. Reading the launcher's own values
#: lets the env tests run on every rung without writing a variable anywhere.
ENV_REFERENCED = 'ROCKETRIDE_DIST_ROOT'
ENV_UNREFERENCED = 'ROCKETRIDE_BUILD_ROOT'

#: The only RR_* names an engine process may hold: the non-secret settings the
#: server hands it on purpose (``CONST_SUBPROCESS_ENV_NAMES`` in task_engine.py;
#: ``RR_MOCK`` is the test-mock directory the node-test launcher sets), and
#: ``RR_BASE_URL``, which the engine's own web server sets to its own address.
ENGINE_RR_NAMES = frozenset({'RR_CORS_ORIGINS', 'RR_OAUTH_BROKER_URL', 'RR_PROC_PRIVATE', 'RR_MOCK', 'RR_BASE_URL'})

#: The database plumbing the server removes from an engine's environment by name.
STRIPPED_DB_NAMES = frozenset(
    {
        'ROCKETRIDE_DB_BROKER_URL',
        'ROCKETRIDE_DB_BROKER_TOKEN',
        'ROCKETRIDE_DB_DSNS',
        'ROCKETRIDE_DB_DSN',
        'ROCKETRIDE_DB_RESOLVE_ERROR',
    }
)

#: Every test here shares the module's deployment: one worker, one event loop.
pytestmark = [pytest.mark.asyncio(loop_scope='module'), pytest.mark.xdist_group('doors_probe')]


# ==== The pipeline ===============================================================


def _pipeline(project_id: str, *, label: str = 'doors', roots: Optional[List[str]] = None) -> Dict[str, Any]:
    """
    The probe's pipeline: a webhook feeds the probe, the response returns its report.

    Args:
        project_id: The pipe's own project id, so no other run shares its controls.
        label: The probe's control value (a ``${ROCKETRIDE_*}`` placeholder for the env pipe).
        roots: The storage roots the pipe declares, if any.

    Returns:
        The pipeline, with every probe parameter exposed by public name.
    """
    pipe = {
        'name': 'Doors probe',
        'project_id': project_id,
        'source': 'webhook_1',
        'components': [
            {
                'id': 'webhook_1',
                'provider': 'webhook',
                'config': {'hideForm': True, 'mode': 'Source', 'parameters': {}, 'type': 'webhook'},
            },
            {
                'id': NODE_ID,
                'provider': 'doors_probe',
                'config': {'label': label},
                'input': [{'lane': 'text', 'from': 'webhook_1'}],
            },
            {
                'id': 'response_1',
                'provider': 'response',
                'config': {'lanes': []},
                'input': [{'lane': 'text', 'from': NODE_ID}],
            },
        ],
        # Public name -> nodeId.leafPath: the selector and a leaf of each branch
        'parameters': {
            'greeting': f'{NODE_ID}.greeting',
            'mode': f'{NODE_ID}.mode',
            'alphaValue': f'{NODE_ID}.alpha.alphaValue',
            'betaValue': f'{NODE_ID}.beta.betaValue',
        },
    }
    if roots:
        pipe['roots'] = list(roots)
    return pipe


def _store_root() -> Path:
    """
    The account store's root on disk, as the server resolves it.

    Returns:
        ``RR_STORE_URL``'s ``filesystem://`` path, else ``~/.rocketlib/store``.
    """
    url = os.environ.get('RR_STORE_URL')
    if not url:
        return Path.home() / '.rocketlib' / 'store'
    if not url.startswith('filesystem://'):
        pytest.skip(f'RR_STORE_URL is {url!r}: the disk checks need a filesystem store')
    return Path(os.path.expandvars(os.path.expanduser(url[len('filesystem://') :])))


# ==== One call's report ==========================================================


class Report:
    """
    The probe's report of one call: one result per operation of its script.
    """

    def __init__(self, rung: str, result: Dict[str, Any]):
        """
        Parse the report the response node returned.

        Args:
            rung: The rung the call went to (named in every assertion).
            result: The submit result; the report is its first text.
        """
        self.rung = rung
        self.result = result
        texts = result.get('text') or ['']
        self.results: List[Dict[str, Any]] = json.loads(texts[0])['results']

    def value(self, index: int) -> Any:
        """The value of an operation that must have succeeded."""
        outcome = self.results[index]
        assert outcome['ok'], f'@{self.rung}: {outcome["op"]} was refused: {outcome.get("error")}'
        return outcome['value']

    def refusal(self, index: int) -> str:
        """The error of an operation that must have been refused."""
        outcome = self.results[index]
        assert not outcome['ok'], f'@{self.rung}: {outcome["op"]} was ALLOWED: {outcome}'
        return outcome['error']


# ==== The rig ====================================================================


class Rig:
    """
    The run's client, its deployments, its environment variables, and where each write belongs on disk.

    Four deployed pipes share the probe: ``main`` (no roots), ``teamroot``
    (declares the team's shared folder by name), ``orgroot`` (declares the
    org's) and ``env`` (its label is a ``${ROCKETRIDE_*}`` placeholder). Each
    has its own project, so each rung serves it from its own control and its
    team and org task subtrees are its own.

    The env pipe references a variable the process that launched the server
    gave it (``ENV_REFERENCED``), so the run writes no variable anywhere: on
    a standalone server ``set_env`` rewrites the server's whole ``.env`` file
    from its process environment.
    """

    #: The pipes the fixture deploys, and the rungs it points at each version.
    #: A pipe that declares roots is never published to @public: the server
    #: refuses it (its own test below).
    DEPLOYED = ('main', 'teamroot', 'orgroot', 'env')
    PUBLISHED = {
        'main': ('team', 'org', 'public'),
        'teamroot': ('team', 'org'),
        'orgroot': ('team', 'org'),
        'env': ('team', 'org', 'public'),
    }

    def __init__(self, client: Any, store: Path, nonce: str):
        """
        Hold the run's handles; the fixture fills in identity, pipes and versions.

        Args:
            client: A connected RocketRideClient.
            store: The account store's root on disk.
            nonce: In every path, key, variable and project id this run writes.
        """
        self.client = client
        self.store = store
        self.nonce = nonce
        #: One project per pipe; ``main`` keeps the short spelling.
        self.projects = {'main': f'doorsprobe_{nonce}'}
        self.projects.update({kind: f'doorsprobe_{kind}_{nonce}' for kind in self.DEPLOYED[1:]})
        self.project = self.projects['main']
        self.pipes: Dict[str, Dict[str, Any]] = {'main': _pipeline(self.project)}
        #: The run's folder inside every owner tree it writes, and the shared
        #: folder the root-declaring pipes name in the team's and the org's tree.
        self.folder = f'doors-probe-{nonce}'
        self.shared = f'doors-probe-{nonce}-shared'
        #: The variable the env pipe references, and one it does not, with the
        #: values this process inherited from the same launcher ('' when absent)
        self.env_name, self.env_value = ENV_REFERENCED, os.environ.get(ENV_REFERENCED, '')
        self.env_other, self.env_other_value = ENV_UNREFERENCED, os.environ.get(ENV_UNREFERENCED, '')
        self.developer = ''
        self.user = self.team = self.org = self.team_name = ''
        self.versions: Dict[str, int] = {}
        self.tokens: set = set()

    def build_pipes(self) -> None:
        """Build the root-declaring and env pipes once identity is known (the team's name)."""
        self.pipes['teamroot'] = _pipeline(self.projects['teamroot'], roots=[f'@{self.team_name}/{self.shared}'])
        self.pipes['orgroot'] = _pipeline(self.projects['orgroot'], roots=[f'@org/{self.shared}'])
        self.pipes['env'] = _pipeline(self.projects['env'], label='${' + self.env_name + '}')

    # ---- Calls ---------------------------------------------------------------

    def address(self, pipe: str = 'main') -> str:
        """``developerId.pipelineId`` of one of the run's pipes."""
        return f'{self.developer}.{self.projects[pipe]}'

    def audience(self, rung: str) -> str:
        """The deploy target that publishes to ``rung``."""
        return {'me': '@me', 'team': f'=team/{self.team}', 'org': f'=org/{self.org}', 'public': '@public'}[rung]

    def target(self, rung: str, pipe: str = 'main') -> str:
        """The rooted address that walks exactly ``rung`` for one of the run's pipes."""
        return f'{self.audience(rung)}/{self.address(pipe)}'

    async def submit(self, rung: str, ops: List[Dict[str, Any]], pipe: str = 'main', **options) -> Dict[str, Any]:
        """
        Send one script to one rung and return the raw submit result.

        Args:
            rung: ``spec`` runs the pipeline inline; the others call the deployment.
            ops: The probe's operations.
            pipe: Which of the run's pipes, or a pipeline dict for an inline @spec call.
            **options: ``params``, ``on_sse``, ``env`` as ``submit`` takes them.

        Returns:
            The submit result.
        """
        # Step 1: one request, inline on @spec, by rooted address elsewhere
        arguments = {'data': json.dumps({'ops': ops}), 'mimetype': 'text/plain', **options}
        if rung == 'spec':
            pipeline = pipe if isinstance(pipe, dict) else self.pipes[pipe]
            result = await self.client.submit(pipeline=pipeline, **arguments)
        else:
            result = await self.client.submit(name=self.target(rung, pipe), **arguments)

        # Step 2: every control the run reaches is ended at teardown
        if result.get('token'):
            self.tokens.add(result['token'])
        return result

    async def call(
        self, rung: str, ops: List[Dict[str, Any]], params=None, on_sse=None, pipe='main', env=None
    ) -> Report:
        """
        Run one script on one rung and parse the probe's report.

        Args:
            rung: ``spec`` runs the pipeline inline; the others call the deployment.
            ops: The probe's operations.
            params: Per-call parameters by public name.
            on_sse: An async ``(type, data)`` callback for the call's events.
            pipe: Which of the run's pipes, or a pipeline dict for an inline @spec call.
            env: ``ROCKETRIDE_*`` overrides (a @spec call applies them; a published one ignores them).

        Returns:
            The probe's report.
        """
        options = {'params': params, 'on_sse': on_sse}
        if env is not None:
            options['env'] = env
        return Report(rung, await self.submit(rung, ops, pipe, **options))

    # ---- The disk ----------------------------------------------------------------

    def tree(self, rung: str, pipe: str = 'main') -> Path:
        """
        Where a rung's plain paths resolve on disk (``storage_root_for``).

        A user-owned run anchors in the user's whole tree; a team or org run in
        that owner's task subtree for the pipe's project.
        """
        if rung in USER_RUNGS:
            return self.store / 'users' / self.user / 'files'
        if rung == 'team':
            return self.store / 'teams' / self.team / 'files' / 'tasks' / self.projects[pipe]
        return self.store / 'orgs' / self.org / 'files' / 'tasks' / self.projects[pipe]

    def shared_tree(self, kind: str) -> Path:
        """The shared folder a root-declaring pipe reaches: ``team`` or ``org``."""
        if kind == 'team':
            return self.store / 'teams' / self.team / 'files' / self.shared
        return self.store / 'orgs' / self.org / 'files' / self.shared

    def owned_trees(self) -> List[Path]:
        """Every tree this run's writes may land in: each pipe's owner trees and the two shared folders."""
        trees = [self.tree('spec')]
        for pipe in self.DEPLOYED:
            trees += [self.tree('team', pipe), self.tree('org', pipe)]
        return trees + [self.shared_tree('team'), self.shared_tree('org')]

    def nonce_paths(self) -> List[Path]:
        """
        Every file or folder under the store whose own name carries this run's nonce.

        Every level is walked: a folder that matches is reported and still
        descended into, so a nonce-named file inside it is reported too.
        """
        found: List[Path] = []
        for top, folders, files in os.walk(self.store):
            found.extend(Path(top) / name for name in folders + files if self.nonce in name)
        return found

    def _owned(self, path: Path) -> bool:
        """Whether ``path`` IS one of the run's owned trees or lies inside one."""
        resolved = path.resolve()
        return any(resolved == tree or tree in resolved.parents for tree in (t.resolve() for t in self.owned_trees()))

    def strays(self) -> List[Path]:
        """
        Nonce paths no rung's node may have written: each one is a write that escaped.

        The server itself names two system entries after each of the run's
        projects, under an owner's ``.logs`` (the run log) and
        ``.deployments`` (the version's storage), as its own identity and
        never through ``self.files``. Those FOLDERS are the server's. Every
        path a node writes carries the nonce in its own FILE name, so a
        nonce-named file anywhere outside the owned trees, those system
        folders included, is an escape.
        """
        strays = []
        for path in self.nonce_paths():
            # Step 1: anything inside a tree a rung owns is the run's own write
            if self._owned(path):
                continue
            # Step 2: the server's project-named entry directly under a system tree
            if path.is_dir() and path.parent.name in SYSTEM_TREES:
                continue
            strays.append(path)
        return strays

    # ---- Teardown ----------------------------------------------------------------

    async def cleanup(self) -> None:
        """
        End what the run started and remove what it wrote: controls, publications, versions, variables, files.
        """
        # Step 1: the controls; one that already idled out is gone
        for token in self.tokens:
            try:
                await self.client.terminate(token)
            except Exception:  # noqa: BLE001 - best effort; an ended control is the goal
                pass

        # Step 2: each pipe's rung pointers, then the version no rung pins any more
        for pipe, version in self.versions.items():
            for rung in ('public', 'org', 'team', 'me'):
                try:
                    await self.client.deploy.remove(self.projects[pipe], self.audience(rung))
                except Exception:  # noqa: BLE001 - a rung the run never reached has nothing to remove
                    pass
            try:
                await self.client.deploy.delete(self.projects[pipe], version)
            except Exception:  # noqa: BLE001 - reported by the server's own listing if it stays
                pass

        # Step 3: the run's files wherever they landed (a stray was already
        # reported), and the server's run logs of the run's own projects; the
        # walk is top-down, so a folder goes before the matches inside it
        for path in self.nonce_paths():
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)


@pytest_asyncio.fixture(scope='module', loop_scope='module')
async def rig(tmp_path_factory):
    """
    The deployed probes: @spec answered once, each pipe published on the rungs it may reach.

    Skips without a local server: the run publishes to @public on its target.
    """
    from rocketride import RocketRideClient

    # Step 1: a server on this machine, and a store on its disk
    uri = os.getenv('ROCKETRIDE_URI', 'http://127.0.0.1:5565')
    if urlparse(uri).hostname not in LOCAL_HOSTS:
        pytest.skip(f'{uri} is not on this machine; the rung test deploys to @public')
    store = _store_root()
    client = RocketRideClient(uri=uri, auth=os.getenv('ROCKETRIDE_APIKEY', 'MYAPIKEY'))
    try:
        await client.connect()
    except Exception as e:  # noqa: BLE001 - no server is a skip, not a failure
        pytest.skip(f'no server at {uri}: {e}')

    probe = Rig(client, store, uuid.uuid4().hex[:12])
    try:
        # Step 2: @spec first; its caller names the user, team, org and the
        # developer id (the first segment of every address)
        first = await probe.call('spec', [{'op': 'report'}])
        caller = first.value(0)['caller']
        probe.user, probe.team, probe.org = caller['userId'], caller['teamId'], caller['orgId']
        probe.developer = caller['address'].split('.', 1)[0]

        # Step 3: the team's NAME, which a root declared by name spells
        teams = ((client.get_account_info() or {}).get('organization') or {}).get('teams') or []
        probe.team_name = next(str(team.get('name')) for team in teams if team.get('id') == probe.team)
        probe.build_pipes()

        # Step 4: one version per pipe, deployed to @me and pointed at by each rung it may reach
        folder = tmp_path_factory.mktemp('doors_probe')
        for pipe in Rig.DEPLOYED:
            pipe_path = folder / f'{pipe}.pipe'
            pipe_path.write_text(json.dumps(probe.pipes[pipe], indent=2), encoding='utf-8')
            added = await client.deploy.add_pipe(str(pipe_path), comment='doors probe rung test', deploy_to='@me')
            probe.versions[pipe] = int(added['artifact']['version'])
            for rung in Rig.PUBLISHED[pipe]:
                await client.deploy.deploy(probe.projects[pipe], probe.versions[pipe], probe.audience(rung))
        yield probe
    finally:
        await probe.cleanup()
        await client.disconnect()


# ==== Who is calling =============================================================


@pytest.mark.parametrize('rung', RUNGS)
async def test_each_rung_answers_with_its_own_caller_and_identity(rig, rung):
    report = (await rig.call(rung, [{'op': 'report'}])).value(0)
    caller, node = report['caller'], report['node']

    # The server stamped this rung, this address and this binding
    assert caller['rung'] == rung
    assert caller['address'] in (rig.address(), f'{rig.address()}.webhook_1')
    assert (caller['userId'], caller['teamId'], caller['orgId']) == (rig.user, rig.team, rig.org)
    assert caller['correlationId'] and caller['controlId']

    # config.node names this component of this control
    assert node['id'] == NODE_ID
    assert node['provider'] == 'doors_probe'
    assert node['controlId'] == caller['controlId']


async def test_every_rung_is_its_own_control_and_every_call_its_own_binding(rig):
    reports = [(await rig.call(rung, [{'op': 'report'}])).value(0) for rung in RUNGS]
    again = (await rig.call('me', [{'op': 'report'}])).value(0)

    # Five rungs, five controls; a second @me call is the same control, a new binding
    assert len({r['caller']['controlId'] for r in reports}) == len(RUNGS)
    assert again['caller']['controlId'] == reports[1]['caller']['controlId']
    assert len({r['caller']['correlationId'] for r in reports + [again]}) == len(RUNGS) + 1


# ==== self.config and self.settings ==============================================


@pytest.mark.parametrize('rung', RUNGS)
async def test_config_is_the_controls_and_refuses_a_parameter(rig, rung):
    report = (await rig.call(rung, [{'op': 'report'}])).value(0)
    seen = report['global']

    # beginGlobal read the control's value, its parameters' names, and was refused a write
    assert seen['label'] == 'doors' and report['configLabel'] == 'doors'
    assert seen['configWrite']['refused']
    assert {'greeting', 'mode', 'alphaValue'} <= set(seen['paramKeys'])

    # IGlobal.config refuses a parameter with the teaching error
    assert report['configParam']['refused']
    assert 'ConfigError' in report['configParam']['error']
    assert 'read it from self.settings' in report['configParam']['error']


@pytest.mark.parametrize('rung', RUNGS)
async def test_settings_are_each_calls_own_and_a_selector_reresolves_them(rig, rung):
    beta = await rig.call(rung, [{'op': 'report'}], params={'greeting': 'hi', 'mode': 'beta', 'betaValue': 'zz'})
    plain = await rig.call(rung, [{'op': 'report'}])
    beta, plain = beta.value(0), plain.value(0)

    # One control served both calls
    assert beta['caller']['controlId'] == plain['caller']['controlId']

    # The beta call reads the beta branch; the alpha leaf is not reachable
    assert beta['settings']['greeting'] == 'hi'
    assert beta['settings']['mode'] == 'beta' and beta['settings']['betaValue'] == 'zz'
    assert 'alphaValue' not in beta['settings']
    assert beta['settingsPaths']['betaValue'] == 'beta.betaValue'
    assert set(beta['caller']['params'][NODE_ID].values()) == {'hi', 'beta', 'zz'}

    # The next call has its defaults back: nothing carried over
    assert {key: plain['settings'][key] for key in DEFAULT_SETTINGS} == DEFAULT_SETTINGS
    assert 'betaValue' not in plain['settings']
    assert not plain['caller']['params'].get(NODE_ID)


@pytest.mark.parametrize(
    'params',
    [
        {'label': 'forged'},  # not exposed by the pipe: the control's own value
        {'alphaValue': 5000},  # above the leaf's maximum
        {'mode': 'gamma'},  # no such branch
        {'mode': 'alpha', 'betaValue': 'x'},  # a leaf of a branch the call does not select
    ],
)
@pytest.mark.parametrize('rung', ('spec', 'me', 'team'))
async def test_a_call_cannot_set_what_the_pipe_does_not_admit(rig, rung, params):
    with pytest.raises(Exception, match=r'(?i)param'):
        await rig.call(rung, [{'op': 'report'}], params=params)


# ==== self.files on disk =========================================================


@pytest.mark.parametrize('rung', RUNGS)
async def test_files_land_in_the_rungs_own_tree_and_the_disk_follows(rig, rung):
    folder, tree = f'{rig.folder}/{rung}', rig.tree(rung)
    report = await rig.call(
        rung,
        [
            {'op': 'files.write', 'path': f'{folder}/note.txt', 'text': f'{rung}:{rig.nonce}'},
            {'op': 'files.putJson', 'path': f'{folder}/doc.json', 'value': {'rung': rung}},
            {'op': 'files.stream', 'path': f'{folder}/stream.txt', 'chunks': ['a', 'b', 'c']},
            {'op': 'files.read', 'path': f'{folder}/note.txt'},
            {'op': 'files.getJson', 'path': f'{folder}/doc.json'},
            {'op': 'files.list', 'path': folder},
            {'op': 'files.stat', 'path': f'{folder}/note.txt'},
        ],
    )

    # The node reads back what it wrote
    assert report.value(3) == f'{rung}:{rig.nonce}'
    assert report.value(4) == {'rung': rung}
    assert report.value(5) == ['doc.json', 'note.txt', 'stream.txt']
    assert report.value(6)['exists'] is True

    # And the disk holds exactly that, in this rung's tree
    assert (tree / folder / 'note.txt').read_text(encoding='utf-8') == f'{rung}:{rig.nonce}'
    assert json.loads((tree / folder / 'doc.json').read_text(encoding='utf-8')) == {'rung': rung}
    assert (tree / folder / 'stream.txt').read_bytes() == b'abc'

    # A rename and a delete move the disk with them
    report = await rig.call(
        rung,
        [
            {'op': 'files.rename', 'old': f'{folder}/note.txt', 'new': f'{folder}/renamed.txt'},
            {'op': 'files.delete', 'path': f'{folder}/stream.txt'},
            {'op': 'files.mkdir', 'path': f'{folder}/sub'},
        ],
    )
    for index in range(3):
        report.value(index)
    assert not (tree / folder / 'note.txt').exists()
    assert (tree / folder / 'renamed.txt').read_text(encoding='utf-8') == f'{rung}:{rig.nonce}'
    assert not (tree / folder / 'stream.txt').exists()
    assert (tree / folder / 'sub').is_dir()


async def test_the_user_rungs_share_one_tree_and_the_team_and_org_have_their_own(rig):
    path = f'{rig.folder}/shared.txt'
    for rung in ('spec', 'team', 'org'):
        (await rig.call(rung, [{'op': 'files.write', 'path': path, 'text': rung}])).value(0)

    # Three files on disk, one per owner tree
    for rung in ('spec', 'team', 'org'):
        assert (rig.tree(rung) / path).read_text(encoding='utf-8') == rung

    # Every user-owned rung reads the user's file; team and org read their own
    for rung, expected in (('spec', 'spec'), ('me', 'spec'), ('public', 'spec'), ('team', 'team'), ('org', 'org')):
        assert (await rig.call(rung, [{'op': 'files.read', 'path': path}])).value(0) == expected


# ==== self.state =================================================================


async def test_state_is_shared_by_the_user_rungs_and_separate_for_team_and_org(rig):
    key = 'owner'
    for rung in ('spec', 'team', 'org'):
        (await rig.call(rung, [{'op': 'state.put', 'key': key, 'value': rung}])).value(0)

    # The user's rungs see the user's value; the team and the org their own,
    # though all three owners share one id on a standalone server
    for rung, expected in (('spec', 'spec'), ('me', 'spec'), ('public', 'spec'), ('team', 'team'), ('org', 'org')):
        assert (await rig.call(rung, [{'op': 'state.get', 'key': key}])).value(0) == expected

    # A delete on @team leaves the user's and the org's values alone
    assert (await rig.call('team', [{'op': 'state.delete', 'key': key}])).value(0) is True
    assert (await rig.call('team', [{'op': 'state.get', 'key': key}])).value(0) is None
    assert (await rig.call('me', [{'op': 'state.get', 'key': key}])).value(0) == 'spec'
    assert (await rig.call('org', [{'op': 'state.get', 'key': key}])).value(0) == 'org'
    for rung in ('spec', 'org'):
        (await rig.call(rung, [{'op': 'state.delete', 'key': key}])).value(0)


@pytest.mark.parametrize('rung', RUNGS)
async def test_state_counts_and_locked_writes_survive_the_call(rig, rung):
    count, items = f'count-{rung}', f'items-{rung}'
    first = await rig.call(
        rung,
        [
            {'op': 'state.incr', 'key': count},
            {'op': 'state.incr', 'key': count, 'amount': 4},
            {'op': 'state.lockedAppend', 'key': items, 'value': 1},
        ],
    )
    second = await rig.call(
        rung,
        [{'op': 'state.lockedAppend', 'key': items, 'value': 2}, {'op': 'state.get', 'key': count}],
    )

    # The values outlive the call that wrote them
    assert (first.value(0), first.value(1), first.value(2)) == (1, 5, [1])
    assert (second.value(0), second.value(1)) == ([1, 2], 5)
    for key in (count, items):
        (await rig.call(rung, [{'op': 'state.delete', 'key': key}])).value(0)


@pytest.mark.parametrize('rung', RUNGS)
async def test_state_refuses_a_17th_key_a_long_ttl_and_a_large_value(rig, rung):
    # A node id of its own: a fresh scope this test fills and empties
    node = f'limit_{rung}'
    puts = [
        {'op': 'otherNode.state.put', 'nodeId': node, 'key': f'k{index}', 'value': index}
        for index in range(CONST_STATE_MAX_KEYS_PER_NODE + 1)
    ]
    report = await rig.call(rung, puts)

    # Sixteen fit; the seventeenth is refused, nothing evicted
    for index in range(CONST_STATE_MAX_KEYS_PER_NODE):
        report.value(index)
    assert 'DoorError' in report.refusal(CONST_STATE_MAX_KEYS_PER_NODE)

    # A write to a key the node holds still fits; then the scope is emptied
    again = {'op': 'otherNode.state.put', 'nodeId': node, 'key': 'k0', 'value': 'again'}
    deletes = [
        {'op': 'otherNode.state.delete', 'nodeId': node, 'key': f'k{index}'}
        for index in range(CONST_STATE_MAX_KEYS_PER_NODE)
    ]
    report = await rig.call(rung, [again, *deletes])
    assert report.value(0) is None
    assert all(report.value(1 + index) is True for index in range(CONST_STATE_MAX_KEYS_PER_NODE))

    # Every value expires within seven days, and is capped in size
    report = await rig.call(
        rung,
        [
            {'op': 'state.put', 'key': 'ttl', 'value': 1, 'ttl': CONST_STATE_MAX_TTL_SECONDS + 1},
            {'op': 'state.put', 'key': 'ttl', 'value': 1, 'ttl': 0},
            {'op': 'state.put', 'key': 'big', 'value': 'x' * (CONST_STATE_MAX_VALUE_BYTES + 1)},
            {'op': 'state.get', 'key': 'big'},
        ],
    )
    for index in range(3):
        assert 'DoorError' in report.refusal(index)
    assert report.value(3) is None


# ==== Boundaries =================================================================


#: Paths no node may write: traversal, scoped roots, system trees, bad characters.
#: Each carries the run's nonce (``{n}``), so the disk scan finds any that escaped.
ESCAPES = (
    '../escape-{n}.txt',
    '../../escape-{n}.txt',
    '../../../escape-{n}.txt',
    '../../../../escape-{n}.txt',
    'inside/../../escape-{n}.txt',
    '..\\escape-{n}.txt',
    'inside\\..\\..\\escape-{n}.txt',
    '@me/escape-{n}.txt',
    '@org/escape-{n}.txt',
    '@public/escape-{n}.txt',
    '@spec/escape-{n}.txt',
    '@Development/escape-{n}.txt',
    '=team/local/escape-{n}.txt',
    '=org/local/escape-{n}.txt',
    '=user/local/escape-{n}.txt',
    '=user/someone-else/escape-{n}.txt',
    '.logs/escape-{n}.log',
    '.deployments/escape-{n}.json',
    'C:/escape-{n}.txt',
    'escape-{n}\x00.txt',
    'escape-{n}|pipe.txt',
)


@pytest.mark.parametrize('rung', RUNGS)
async def test_no_path_leaves_the_owners_tree(rig, rung):
    paths = [escape.format(n=rig.nonce) for escape in ESCAPES]
    ops = [{'op': 'files.write', 'path': path, 'text': 'escaped'} for path in paths]
    ops += [{'op': 'files.putJson', 'path': path, 'value': 'escaped'} for path in paths]
    ops += [{'op': 'files.read', 'path': f'../../{rig.folder}/{rung}/note.txt'}]
    ops += [{'op': 'files.list', 'path': '..'}, {'op': 'files.list', 'path': '../..'}]
    ops += [{'op': 'files.stat', 'path': '../escape.txt'}]
    report = await rig.call(rung, ops)

    # Every attempt is refused by the door
    for index, op in enumerate(ops):
        assert report.results[index]['ok'] is False, f'@{rung}: {op["op"]} {op.get("path")!r} was ALLOWED'

    # A rename cannot carry an owned file out either
    inside = f'{rig.folder}/{rung}-rename-{rig.nonce}.txt'
    report = await rig.call(
        rung,
        [
            {'op': 'files.write', 'path': inside, 'text': 'inside'},
            {'op': 'files.rename', 'old': inside, 'new': f'../moved-{rig.nonce}.txt'},
            {'op': 'files.rename', 'old': inside, 'new': f'@me/moved-{rig.nonce}.txt'},
            {'op': 'files.rename', 'old': inside, 'new': f'.logs/moved-{rig.nonce}.txt'},
        ],
    )
    report.value(0)
    for index in (1, 2, 3):
        report.refusal(index)
    assert (rig.tree(rung) / inside).read_text(encoding='utf-8') == 'inside'

    # A leading slash is not absolute: it lands inside the owner's tree
    rooted = f'/{rig.folder}/{rung}-rooted.txt'
    (await rig.call(rung, [{'op': 'files.write', 'path': rooted, 'text': 'rooted'}])).value(0)
    assert (rig.tree(rung) / rooted.lstrip('/')).read_text(encoding='utf-8') == 'rooted'

    # Nothing with the run's nonce exists outside the trees the rungs own
    assert rig.strays() == []
    for depth in range(1, 4):
        assert not (rig.store.parents[depth - 1] / f'escape-{rig.nonce}.txt').exists()


@pytest.mark.parametrize('rung', RUNGS)
async def test_a_door_never_outlives_its_call_or_answers_a_forged_binding(rig, rung):
    # Call 1 writes a file and a value, then leaves its doors on the IGlobal
    stale_path = f'{rig.folder}/{rung}-stale.txt'
    first = await rig.call(
        rung,
        [
            {'op': 'files.write', 'path': f'{rig.folder}/{rung}-kept.txt', 'text': 'kept'},
            {'op': 'state.put', 'key': f'kept-{rung}', 'value': 'kept'},
            {'op': 'stash'},
        ],
    )
    binding = first.value(2)

    # Call 2, same control: the stashed doors and every forged binding reach nothing
    second = await rig.call(
        rung,
        [
            {'op': 'stale.state.get', 'key': f'kept-{rung}'},
            {'op': 'stale.state.put', 'key': f'kept-{rung}', 'value': 'stale'},
            {'op': 'stale.files.read', 'path': f'{rig.folder}/{rung}-kept.txt'},
            {'op': 'stale.files.write', 'path': stale_path, 'text': 'stale'},
            {'op': 'forge.state.get', 'binding': binding, 'key': f'kept-{rung}'},
            {'op': 'forge.state.put', 'binding': 'forged-binding', 'key': f'kept-{rung}', 'value': 'forged'},
            {'op': 'forge.files.read', 'binding': binding, 'path': f'{rig.folder}/{rung}-kept.txt'},
            {'op': 'forge.files.write', 'binding': 'forged-binding', 'path': stale_path, 'text': 'forged'},
            {'op': 'state.get', 'key': f'kept-{rung}'},
        ],
    )
    for index in range(8):
        error = second.refusal(index)
        # The stash existed: the refusal is the door's, not a missing stash
        assert 'DoorError' in error, f'@{rung}: {second.results[index]}'
    assert second.value(8) == 'kept'
    assert not (rig.tree(rung) / stale_path).exists()
    (await rig.call(rung, [{'op': 'state.delete', 'key': f'kept-{rung}'}])).value(0)


async def test_engine_level_work_reaches_only_its_own_owner(rig):
    # An empty binding is engine-level work: the server answers it only for
    # the one control of a private engine (the node's own) and refuses it on
    # an engine several controls hold, so either outcome is in bounds
    for rung in RUNGS:
        outcome = (
            await rig.call(rung, [{'op': 'forge.state.put', 'binding': '', 'key': 'engine', 'value': rung}])
        ).results[0]
        assert outcome['ok'] or 'DoorError' in outcome['error'], f'@{rung}: {outcome}'

    # What was answered stayed with its writer's owner: no rung reads another owner's value
    for rung in RUNGS:
        value = (await rig.call(rung, [{'op': 'state.get', 'key': 'engine'}])).value(0)
        writers = USER_RUNGS if rung in USER_RUNGS else (rung,)
        assert value is None or value in writers, f'@{rung} read {value!r}'
    for rung in ('spec', 'team', 'org'):
        (await rig.call(rung, [{'op': 'state.delete', 'key': 'engine'}])).value(0)


@pytest.mark.parametrize('rung', RUNGS)
async def test_a_node_cannot_rewrite_its_caller_or_its_views(rig, rung):
    report = await rig.call(rung, [{'op': 'report'}, {'op': 'mutate'}], params={'greeting': 'hi'})
    before, outcome = report.value(0)['caller'], report.value(1)

    # Every write into the caller, the identity record and the views is refused
    attempts = {name: result for name, result in outcome.items() if name != 'callerAfter'}
    assert 'caller.params.node' in attempts
    for name, result in attempts.items():
        assert result['refused'], f'@{rung}: {name} was ALLOWED'

    # And the caller is exactly what the server stamped
    assert outcome['callerAfter']['value'] == before


async def test_another_node_id_stays_inside_its_owner(rig):
    # The node names its own component id, so a false one is accepted: it can
    # only reach another node of the same owner's same pipeline
    put = {'op': 'otherNode.state.put', 'nodeId': 'ghost', 'key': 'g', 'value': 'user'}
    (await rig.call('me', [put])).value(0)
    get = {'op': 'otherNode.state.get', 'nodeId': 'ghost', 'key': 'g'}
    for rung, expected in (('spec', 'user'), ('public', 'user'), ('team', None), ('org', None)):
        assert (await rig.call(rung, [get])).value(0) == expected


# ==== self.logger() ==============================================================


@pytest.mark.parametrize('rung', RUNGS)
async def test_the_binding_logger_reaches_the_caller(rig, rung):
    events: List[Any] = []

    async def on_sse(kind, data):
        """Collect every event of the call."""
        events.append((kind, data))

    report = await rig.call(rung, [{'op': 'sse', 'type': 'probe', 'data': {'nonce': rig.nonce}}], on_sse=on_sse)
    report.value(0)
    assert any(rig.nonce in json.dumps(data, default=repr) for _, data in events), events


# ==== self.files links ===========================================================


def _token(url: str) -> str:
    """The capability token a fetch link carries in its query."""
    return parse_qs(urlparse(url).query)['token'][0]


def _claim(url: str) -> Dict[str, Any]:
    """The claim a fetch link's token carries, read without the signing key."""
    payload = _token(url).split('.')[1]
    return json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))


def _with_token(url: str, token: str) -> str:
    """The same link with another token."""
    parts = urlparse(url)
    return parts._replace(query=urlencode({'token': token})).geturl()


def _forged(url: str, claim: Dict[str, Any]) -> str:
    """The link with its claim replaced and its original signature kept: a token nobody signed."""
    header, _, signature = _token(url).split('.')
    payload = base64.urlsafe_b64encode(json.dumps(claim, separators=(',', ':')).encode()).rstrip(b'=').decode()
    return _with_token(url, f'{header}.{payload}.{signature}')


def _broken(url: str) -> str:
    """The link with one character of its signature changed."""
    header, payload, signature = _token(url).split('.')
    flipped = ('A' if signature[0] != 'A' else 'B') + signature[1:]
    return _with_token(url, f'{header}.{payload}.{flipped}')


async def _fetch(url: str) -> Tuple[int, bytes]:
    """GET a link without a session: ``(status, body)``."""

    def get() -> Tuple[int, bytes]:
        try:
            with urllib.request.urlopen(url, timeout=15) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    return await asyncio.to_thread(get)


@pytest.mark.parametrize('rung', RUNGS)
async def test_a_files_link_serves_exactly_its_file(rig, rung):
    path, text = f'{rig.folder}/{rung}/link.txt', f'link:{rung}:{rig.nonce}'
    report = await rig.call(
        rung,
        [
            {'op': 'files.write', 'path': path, 'text': text},
            {'op': 'files.url', 'path': path},
            {'op': 'files.url', 'path': path, 'expiresIn': 7200},
            {'op': 'files.url', 'path': '../escape.txt'},
            {'op': 'files.url', 'path': f'@me/{path}'},
            {'op': 'files.url', 'path': f'.logs/{rig.project}'},
        ],
    )
    url, long_url = report.value(1), report.value(2)

    # No link is minted outside the rung's tree
    for index in (3, 4, 5):
        assert 'DoorError' in report.refusal(index)

    # The claim names this one file, in this rung's tree, for a short while
    now = time.time()
    claim = _claim(url)
    assert (rig.store / claim['path']).resolve() == (rig.tree(rung) / path).resolve()
    assert claim['exp'] - now <= FILES_URL_EXPIRES_IN + 30
    assert _claim(long_url)['exp'] - now <= LINK_MAX_SECONDS + 30

    # The link serves exactly the file's bytes, with no session
    assert await _fetch(url) == (200, text.encode())

    # A claim edited to name another owner's copy, or a broken signature, serves nothing
    copies = (
        f'orgs/{rig.org}/files/tasks/{rig.project}/{path}',
        f'teams/{rig.team}/files/tasks/{rig.project}/{path}',
        f'users/{rig.user}/files/{path}',
    )
    other = {**claim, 'path': next(copy for copy in copies if copy != claim['path'])}
    assert (await _fetch(_forged(url, other)))[0] == 401
    assert (await _fetch(_broken(url)))[0] == 401


async def test_an_expired_link_serves_nothing(rig):
    path = f'{rig.folder}/me/expiring.txt'
    report = await rig.call(
        'me',
        [{'op': 'files.write', 'path': path, 'text': 'soon gone'}, {'op': 'files.url', 'path': path, 'expiresIn': 1}],
    )
    url = report.value(1)
    await asyncio.sleep(2.5)
    status, body = await _fetch(url)
    assert status == 401 and b'expired' in body.lower()


# ==== Sub-pipes ==================================================================


def _nested(report: Report, index: int) -> List[Dict[str, Any]]:
    """The nested call's results a ``subpipe`` operation returned."""
    return report.value(index)


@pytest.mark.parametrize('rung', RUNGS)
async def test_a_sub_pipe_serves_the_same_call(rig, rung):
    path, key = f'{rig.folder}/{rung}/sub.txt', f'sub-{rung}'
    report = await rig.call(
        rung,
        [
            {'op': 'report'},
            {
                'op': 'subpipe',
                'ops': [
                    {'op': 'report'},
                    {'op': 'state.put', 'key': key, 'value': 'nested'},
                    {'op': 'files.write', 'path': path, 'text': 'nested'},
                ],
            },
            {'op': 'state.get', 'key': key},
            {'op': 'state.delete', 'key': key},
        ],
        params={'greeting': 'hi'},
    )
    outer, nested = report.value(0), _nested(report, 1)
    assert all(result['ok'] for result in nested), nested
    inner = nested[0]['value']

    # The nested call is this call: one caller, one request tree, one control, this call's params
    assert inner['caller'] == outer['caller']
    assert inner['traceId'] == outer['traceId']
    assert inner['node'] == outer['node']
    assert inner['settings']['greeting'] == 'hi'

    # What it wrote is this owner's: the outer call reads it, the disk holds it
    assert report.value(2) == 'nested'
    assert (rig.tree(rung) / path).read_text(encoding='utf-8') == 'nested'


@pytest.mark.parametrize('rung', RUNGS)
async def test_a_forged_sub_pipe_caller_only_mislabels(rig, rung):
    # The server-set identity rewritten on the sub-pipe; its binding left as it was
    forged = {'userId': 'mallory', 'orgId': 'org-evil', 'teamId': 'team-evil', 'rung': 'public', 'address': 'evil.pipe'}
    path, key = f'{rig.folder}/{rung}/forged.txt', f'forged-{rung}'
    report = await rig.call(
        rung,
        [
            {
                'op': 'subpipe',
                'caller': forged,
                'ops': [
                    {'op': 'report'},
                    {'op': 'state.put', 'key': key, 'value': 'forged'},
                    {'op': 'files.write', 'path': path, 'text': 'forged'},
                ],
            },
            {'op': 'state.get', 'key': key},
            {'op': 'state.delete', 'key': key},
        ],
    )
    nested = _nested(report, 0)
    assert all(result['ok'] for result in nested), nested

    # The nested node believes the forgery: a node can lie to itself
    assert nested[0]['value']['caller']['userId'] == 'mallory'

    # The server does not: both writes landed with the REAL owner, nothing with the forged one
    assert report.value(1) == 'forged'
    assert (rig.tree(rung) / path).read_text(encoding='utf-8') == 'forged'
    for kind, ident in (('users', 'mallory'), ('teams', 'team-evil'), ('orgs', 'org-evil')):
        assert not (rig.store / kind / ident).exists()
    assert rig.strays() == []


@pytest.mark.parametrize('rung', RUNGS)
async def test_a_forged_sub_pipe_binding_reaches_nothing(rig, rung):
    path, key = f'{rig.folder}/{rung}/bound.txt', f'bound-{rung}'
    report = await rig.call(
        rung,
        [
            {
                'op': 'subpipe',
                'caller': {'correlationId': 'forged-binding'},
                'ops': [
                    {'op': 'state.put', 'key': key, 'value': 'forged'},
                    {'op': 'files.write', 'path': path, 'text': 'forged'},
                    {'op': 'state.get', 'key': key},
                ],
            },
            {'op': 'state.get', 'key': key},
        ],
    )
    nested = _nested(report, 0)
    for result in nested:
        assert not result['ok'] and 'DoorError' in result['error'], nested
    assert report.value(1) is None
    assert not (rig.tree(rung) / path).exists()


async def test_forged_sub_pipe_params_reach_only_the_calls_own_parameters(rig):
    report = await rig.call(
        'me',
        [
            # A parameter the node chooses for its own sub-call: its call, its choice
            {'op': 'subpipe', 'caller': {'params': {NODE_ID: {'greeting': 'chosen'}}}, 'ops': [{'op': 'report'}]},
            # The control's own value: no call may set it, a forged one included
            {'op': 'subpipe', 'caller': {'params': {NODE_ID: {'label': 'forged'}}}, 'ops': [{'op': 'report'}]},
        ],
    )
    assert _nested(report, 0)[0]['value']['settings']['greeting'] == 'chosen'
    refused = _nested(report, 1)[0]
    assert not refused['ok'] and 'ConfigError' in refused['error'] and 'not a parameter' in refused['error']


@pytest.mark.parametrize('rung', ('spec', 'team'))
async def test_sub_pipes_nest_no_deeper_than_the_engine_allows(rig, rung):
    report = await rig.call(rung, [{'op': 'recurse', 'depth': MAX_BIND_DEPTH * 2}])

    # Walk down the nested reports to the level whose sub-pipe was refused
    level, node, error = 0, report.value(0), None
    while 'nested' in node:
        level += 1
        inner = node['nested'][0]
        if not inner['ok']:
            error = inner['error']
            break
        node = inner['value']

    # The engine's guard refused the runaway, and the request came back with
    # the refusal. The binder counts every lane call in flight on the request's
    # pipes, and a sub-pipe level holds about two (its own and the forward it
    # makes), so the deepest level stays at or below the limit, not at it
    assert error is not None and 'binding depth exceeded' in error, (level, error)
    assert 1 < level <= MAX_BIND_DEPTH, (level, error)


# ==== Declared roots =============================================================


#: The rungs whose owner reaches the team's tree, and the org's (``declared_roots``).
#: @public would reach them too, but no root-declaring pipe is published there.
TEAM_ROOT_RUNGS = ('spec', 'me', 'team')
ORG_ROOT_RUNGS = ('spec', 'me', 'org')


@pytest.mark.parametrize('rung', TEAM_ROOT_RUNGS)
async def test_a_declared_team_root_reaches_the_teams_shared_folder_and_no_further(rig, rung):
    team, shared, n = rig.team_name, rig.shared, rig.nonce
    by_name, by_id = f'@{team}/{shared}/{rung}.txt', f'=team/{rig.team}/{shared}/{rung}-id.txt'
    report = await rig.call(
        rung,
        [
            {'op': 'files.write', 'path': by_name, 'text': rung},
            {'op': 'files.write', 'path': by_id, 'text': f'{rung}-id'},
            {'op': 'files.read', 'path': by_name},
            {'op': 'files.write', 'path': f'@{team}/{shared}-sibling/escape-{n}.txt', 'text': 'x'},
            {'op': 'files.write', 'path': f'@{team}/escape-{n}.txt', 'text': 'x'},
            {'op': 'files.write', 'path': f'@{team}/{shared}/../escape-{n}.txt', 'text': 'x'},
            {'op': 'files.write', 'path': f'@org/{shared}/escape-{n}.txt', 'text': 'x'},
            {'op': 'files.write', 'path': f'=team/someone-else/{shared}/escape-{n}.txt', 'text': 'x'},
            {'op': 'files.write', 'path': f'@me/escape-{n}.txt', 'text': 'x'},
        ],
        pipe='teamroot',
    )

    # Both spellings of the declared folder land in the team's shared tree on disk
    report.value(0), report.value(1)
    assert report.value(2) == rung
    assert (rig.shared_tree('team') / f'{rung}.txt').read_text(encoding='utf-8') == rung
    assert (rig.shared_tree('team') / f'{rung}-id.txt').read_text(encoding='utf-8') == f'{rung}-id'

    # A sibling, the tree above, traversal, an undeclared root, another team, @me: refused
    for index in range(3, 9):
        assert 'DoorError' in report.refusal(index)
    assert rig.strays() == []


@pytest.mark.parametrize('rung', ORG_ROOT_RUNGS)
async def test_a_declared_org_root_reaches_the_orgs_shared_folder_and_no_further(rig, rung):
    shared, n = rig.shared, rig.nonce
    report = await rig.call(
        rung,
        [
            {'op': 'files.write', 'path': f'@org/{shared}/{rung}.txt', 'text': rung},
            {'op': 'files.write', 'path': f'=org/{rig.org}/{shared}/{rung}-id.txt', 'text': f'{rung}-id'},
            {'op': 'files.write', 'path': f'@org/escape-{n}.txt', 'text': 'x'},
            {'op': 'files.write', 'path': f'=org/other-org/{shared}/escape-{n}.txt', 'text': 'x'},
            {'op': 'files.write', 'path': f'@{rig.team_name}/{shared}/escape-{n}.txt', 'text': 'x'},
        ],
        pipe='orgroot',
    )
    report.value(0), report.value(1)
    assert (rig.shared_tree('org') / f'{rung}.txt').read_text(encoding='utf-8') == rung
    assert (rig.shared_tree('org') / f'{rung}-id.txt').read_text(encoding='utf-8') == f'{rung}-id'
    for index in range(2, 5):
        assert 'DoorError' in report.refusal(index)
    assert rig.strays() == []


async def test_a_shared_folder_is_one_folder_for_every_rung_that_declares_it(rig):
    path = f'@{rig.team_name}/{rig.shared}/handoff.txt'
    (await rig.call('me', [{'op': 'files.write', 'path': path, 'text': 'from me'}], pipe='teamroot')).value(0)
    for rung in ('spec', 'team'):
        assert (await rig.call(rung, [{'op': 'files.read', 'path': path}], pipe='teamroot')).value(0) == 'from me'

    # A pipe that does not declare the root reaches none of it, on the same rung
    assert 'DoorError' in (await rig.call('me', [{'op': 'files.read', 'path': path}])).refusal(0)


@pytest.mark.parametrize('rung, pipe', [('org', 'teamroot'), ('team', 'orgroot')])
async def test_a_root_the_owner_cannot_reach_refuses_the_start(rig, rung, pipe):
    with pytest.raises(Exception, match=r'roots|reach'):
        await rig.call(rung, [{'op': 'report'}], pipe=pipe)


@pytest.mark.parametrize('pipe', ['teamroot', 'orgroot'])
async def test_a_pipe_that_declares_roots_cannot_be_published_to_public(rig, pipe):
    # A store listing would hand a team's or the org's files to every caller
    with pytest.raises(Exception, match='cannot be published to @public'):
        await rig.client.deploy.deploy(rig.projects[pipe], rig.versions[pipe], '@public')


async def test_a_root_declared_by_id_admits_only_the_id_spelling(rig):
    pipe = _pipeline(f'doorsprobe_teamrootid_{rig.nonce}', roots=[f'=team/{rig.team}/{rig.shared}'])
    report = await rig.call(
        'spec',
        [
            {'op': 'files.write', 'path': f'=team/{rig.team}/{rig.shared}/by-id.txt', 'text': 'id'},
            {'op': 'files.write', 'path': f'@{rig.team_name}/{rig.shared}/escape-{rig.nonce}.txt', 'text': 'x'},
        ],
        pipe=pipe,
    )
    report.value(0)
    assert 'DoorError' in report.refusal(1)
    assert (rig.shared_tree('team') / 'by-id.txt').read_text(encoding='utf-8') == 'id'


# ==== ${ROCKETRIDE_*} and the engine's environment ===============================


def _need_launcher_env(rig) -> None:
    """Skip unless this process inherited the launcher's variables the env pipe relies on."""
    if not rig.env_value or not rig.env_other_value:
        pytest.skip(f'{ENV_REFERENCED} and {ENV_UNREFERENCED} come from the builder test-server launcher')


@pytest.mark.parametrize('rung', RUNGS)
async def test_a_referenced_variable_reaches_the_config_and_an_unreferenced_one_reaches_nothing(rig, rung):
    _need_launcher_env(rig)
    report = (await rig.call(rung, [{'op': 'report'}], pipe='env')).value(0)

    # The environment's value filled the control's config, and the caller names it
    assert report['configLabel'] == rig.env_value
    assert report['caller']['env'].get(rig.env_name) == rig.env_value

    # The server expands before the engine sees the config, so the view cannot tell
    assert report['envKeys'] == []

    # A variable the pipe does not reference is nowhere in what the node can read
    assert rig.env_other not in report['caller']['env']
    body = json.dumps(report)
    assert rig.env_other not in body and json.dumps(rig.env_other_value)[1:-1] not in body


@pytest.mark.xfail(
    strict=True,
    reason=(
        'open finding: while a @spec control is live, a second call with a different env '
        'override is served by that control with the first value, and the reply names nothing '
        'ignored. Strict: the test turns this mark into a failure once the server fixes it.'
    ),
)
async def test_a_spec_override_starts_a_control_with_it_and_is_never_dropped_silently(rig):
    _need_launcher_env(rig)
    # A project of its own, so no live @spec control exists before the first call
    pipe = _pipeline(f'doorsprobe_override_{rig.nonce}', label='${' + rig.env_name + '}')
    first, second = f'first-{rig.nonce}', f'second-{rig.nonce}'

    # The control starts with the call's override over the environment's value
    report = (await rig.call('spec', [{'op': 'report'}], pipe=pipe, env={rig.env_name: first})).value(0)
    assert report['configLabel'] == first
    assert report['caller']['env'][rig.env_name] == first

    # Another override for the same pipe: either a new control carries it, or
    # the server says it ignored it; silently serving the old value is neither
    result = await rig.submit('spec', [{'op': 'report'}], pipe=pipe, env={rig.env_name: second})
    label = Report('spec', result).value(0)['configLabel']
    assert label == second or 'env' in (result.get('ignored') or []), (label, result.get('ignored'))


async def test_a_published_call_ignores_an_override_and_says_so(rig):
    _need_launcher_env(rig)
    result = await rig.submit('me', [{'op': 'report'}], pipe='env', env={rig.env_name: f'spec-{rig.nonce}'})
    assert 'env' in (result.get('ignored') or [])
    assert Report('me', result).value(0)['configLabel'] == rig.env_value


async def test_an_unset_variable_stays_a_placeholder(rig):
    unset = '${' + f'{rig.env_name}_UNSET' + '}'
    pipe = _pipeline(f'doorsprobe_unset_{rig.nonce}', label=unset)
    assert (await rig.call('spec', [{'op': 'report'}], pipe=pipe)).value(0)['configLabel'] == unset


@pytest.mark.parametrize('name', ['PATH', 'HOME', 'RR_SIGNING_KEY', 'RR_STORE_URL', 'RR_BASE_URL'])
async def test_a_placeholder_outside_the_pipeline_namespace_refuses_the_start(rig, name):
    pipe = _pipeline(f'doorsprobe_leak_{rig.nonce}', label='${' + name + '}')
    with pytest.raises(Exception, match='placeholders'):
        await rig.call('spec', [{'op': 'report'}], pipe=pipe)


@pytest.mark.parametrize('rung', RUNGS)
async def test_the_engine_process_holds_no_server_setting(rig, rung):
    names = {name.upper() for name in (await rig.call(rung, [{'op': 'processEnv'}])).value(0)}

    # Of the server's own settings (RR_*), only the few it hands every engine
    # on purpose, and none of the database plumbing it strips by hand
    assert sorted(name for name in names if name.startswith('RR_') and name not in ENGINE_RR_NAMES) == []
    assert names.isdisjoint(STRIPPED_DB_NAMES)
