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

"""cmd_deploy handler tests — the command-layer contract.

The account module is stubbed (its behavior is contract-tested in
test_deployment_backend); these tests pin what the COMMAND layer owns:
per-subcommand team-permission checks against the ADDRESSED team, org/actor
resolution, scheduler resyncs after every mutation, audit calls, and the
preview evaluator.
"""

from types import MethodType, SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import json

import pytest

import ai.modules.task.commands.cmd_deploy as cmd_mod
import ai.modules.task.commands.cmd_pipe as pipe_mod
from ai.modules.task.commands.cmd_deploy import DeployCommands
from ai.modules.task.commands.cmd_pipe import DeployPipeCommands
from ai.account.models import resolve_team_permissions
from ai.modules.task.task_control import RESOLVE_READ, DeploymentRef


# ============================================================================
# Harness
# ============================================================================


def _account_info(*, teams=None, dev_team='team-1', user_id='user-1'):
    """AccountInfo-shaped stub with an organization and teams."""
    return SimpleNamespace(
        userId=user_id,
        displayName='Rod C',
        email='rod@example.com',
        devTeam=dev_team,
        organization={
            'id': 'org-1',
            'name': 'Acme',
            'developerId': 'acme',
            'permissions': [],
            'teams': teams
            if teams is not None
            else [{'id': 'team-1', 'name': 'Development', 'permissions': ['task.control', 'task.monitor']}],
        },
        sysPermissions=[],
    )


class _DeployConn(DeployCommands, DeployPipeCommands):
    """Both deploy mixins on one connection, exactly as TaskConn composes them.

    Tests drive the generic rail door (rrext_deploy add/reads) and pipe control
    (rrext_deploy_pipe deploy/schedule/run/...) on a single connection.
    """


def _make_conn(account_info, scheduler=None):
    """A conn with both deploy mixins, __init__ bypassed, real permission math."""
    conn = _DeployConn.__new__(_DeployConn)
    DeployCommands.__init__(conn, 1, MagicMock(), MagicMock())
    DeployPipeCommands.__init__(conn, 1, MagicMock(), MagicMock())
    conn._account_info = account_info
    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'type': 'response', 'body': body})
    conn.debug_message = MagicMock()

    # Real team-permission semantics (mirrors TaskConn.verify_team_permission):
    # resolve against the ADDRESSED team, uniform denial.
    def verify_team_permission(self, team_id, perm):
        if perm not in resolve_team_permissions(self._account_info, team_id):
            raise PermissionError(f"Permission '{perm}' denied")

    conn.verify_team_permission = MethodType(verify_team_permission, conn)

    # The _scheduler property walks self._server._server.app.state.scheduler —
    # satisfy the chain on the stub server instead of mutating the class.
    sched = scheduler or MagicMock()
    if scheduler is None:
        # The manual-run overlap guard defaults OPEN: try_reserve_run returns
        # True (slot claimed, no live run) so a bare MagicMock's truthy return
        # doesn't accidentally reserve-then-refuse. Tests exercising the
        # refusal flip it to False themselves.
        sched.try_reserve_run.return_value = True
    server = MagicMock()
    # broadcast_server_event is AWAITED by the deploy-change notifier; a
    # plain MagicMock attribute returns a non-awaitable, the await raises,
    # and the notifier's best-effort catch swallows it — the apaevt_deploy
    # contract would then have zero coverage here.
    server.broadcast_server_event = AsyncMock()
    server._server.app.state.scheduler = sched
    conn._server = server
    conn._test_scheduler = sched
    return conn


@pytest.fixture
def account_stub(monkeypatch):
    """Stub the account module the handlers call."""
    dep = {
        'teamId': '=team/team-1',
        'projectId': 'proj-1',
        'state': 'enabled',
        'version': 1,
        'schedules': {},
        'billingTeamId': 'team-1',
    }
    stub = SimpleNamespace(
        # A review-ladder server (SaaS): a pipe is born 'private' and walks
        # the ladder to the store, like an app (plan S8).
        review_ladder=True,
        deployments_publish=AsyncMock(return_value={'version': 3, 'sha256': 'abc'}),
        set_artifact_state=AsyncMock(return_value={'version': 3, 'sha256': 'abc', 'state': 'ready'}),
        deployments_deploy=AsyncMock(return_value=dep),
        deployments_set_state=AsyncMock(return_value={**dep, 'state': 'disabled'}),
        deployments_schedule_set=AsyncMock(return_value=dep),
        deployments_schedule_set_paused=AsyncMock(return_value=dep),
        deployments_source_config_set=AsyncMock(return_value=dep),
        deployments_list=AsyncMock(return_value=[dep]),
        deployments_get=AsyncMock(return_value=dep),
        deployments_versions=AsyncMock(return_value=[{'version': 3}]),
        # The artifact carries the source components schedule_set/source_config
        # validate against (and _deploy_run injects its source into).
        deployments_artifact=AsyncMock(
            return_value={'project_id': 'proj-1', 'components': [{'id': 's1'}, {'id': 'webhook_1'}]}
        ),
        deployments_mark_run=AsyncMock(),
        deployments_history=AsyncMock(
            return_value={'rows': [{'action': 'publish', 'seq': 1}], 'total': 1, 'page': 1, 'pageSize': 50}
        ),
        audit=AsyncMock(),
    )
    # Both command mixins import `account` independently — patch each module's
    # binding so pipe handlers (cmd_pipe) hit the stub too.
    monkeypatch.setattr(cmd_mod, 'account', stub)
    monkeypatch.setattr(pipe_mod, 'account', stub)
    return stub


PIPE = {'project_id': 'proj-1', 'name': 'P', 'components': []}
# The same pipe with a store block: publishable, listed (plan 9, C.17b)
LISTED = {**PIPE, 'store': {'tagline': 'Reads invoices', 'categories': ['finance'], 'readme': 'docs/README.md'}}


def _bundle(pipeline, files=None):
    """One bundle zip: the pipe at the root, the files ({path: text}) with their layout."""
    import io
    import zipfile

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as zf:
        zf.writestr('proj-1.pipe', json.dumps(pipeline))
        for name, content in (files or {}).items():
            zf.writestr(name, content)
    return buffer.getvalue()


# ============================================================================
# publish
# ============================================================================


class TestPublish:
    @pytest.mark.asyncio
    async def test_publish_calls_registry_with_org_and_actor(self, account_stub):
        conn = _make_conn(_account_info())
        resp = await conn._deploy_add_pipe({}, {'pipeline': PIPE, 'comment': 'note'})

        args = account_stub.deployments_publish.await_args.args
        assert args[0] == 'org-1' and args[1] == 'acme.proj-1'
        # The audit actor is the denormalized caller identity.
        assert args[3] == {'userId': 'user-1', 'display': 'Rod C', 'email': 'rod@example.com'}
        # Every version is born 'private' (plan S8): the door never passes a state
        assert 'state' not in account_stub.deployments_publish.await_args.kwargs
        account_stub.set_artifact_state.assert_not_awaited()
        assert resp['body']['artifact']['version'] == 3
        account_stub.audit.assert_awaited()

    @pytest.mark.asyncio
    async def test_publish_withdraws_stale_pending_reviews(self, account_stub):
        """Deploying supersedes pending reviews (plan S8): older versions still in 'submit' return to 'private'."""
        # v4 is a NEWER submission (another deploy landed and submitted while
        # this one ran): only versions OLDER than the deployed v3 are stale
        account_stub.deployments_versions = AsyncMock(
            return_value=[
                {'version': 4, 'state': 'submit'},
                {'version': 3, 'state': 'private'},
                {'version': 2, 'state': 'submit'},
                {'version': 1, 'state': 'ready'},
            ]
        )
        account_stub.set_artifact_state = AsyncMock(return_value={'version': 2, 'state': 'private'})
        conn = _make_conn(_account_info())
        await conn._deploy_add_pipe({}, {'pipeline': PIPE})

        withdrawn = [call.args[:4] for call in account_stub.set_artifact_state.await_args_list]
        assert withdrawn == [('org-1', 'acme.proj-1', 2, 'private')]

    @pytest.mark.asyncio
    async def test_publish_takes_the_bundle_zip_beside_the_pipeline(self, account_stub, monkeypatch):
        """The bundle (plan 9, C.17b): its pipe is the artifact, its store block the listing, its files the content."""
        from ai.modules.task.commands import cmd_deploy

        written = AsyncMock(return_value=['p'])
        monkeypatch.setattr(cmd_deploy, 'write_pipe_content', written)
        data = _bundle(LISTED, {'docs/README.md': '# Invoice Ingest'})
        conn = _make_conn(_account_info())
        resp = await conn._deploy_add_pipe({}, {'pipeline': LISTED, 'data': data, 'comment': 'v1'})

        args = account_stub.deployments_publish.await_args
        assert args.args[2] == LISTED
        # The manifest is the block plus the pipe's root keys, in the app row's field names
        assert args.kwargs['metadata']['manifest'] == {
            'name': 'P',
            'description': '',
            'defaultSource': '',
            'tagline': 'Reads invoices',
            'categories': ['finance'],
            'tags': [],
            'icon': '',
            'readme': 'docs/README.md',
            'links': {},
            'mode': 'free',
        }
        written.assert_awaited_once()
        org_id, user_id, entry, bundle, block = written.await_args.args
        assert (org_id, user_id, entry) == ('org-1', 'user-1', {'version': 3, 'sha256': 'abc'})
        assert bundle.entries == ['docs/README.md'] and block == LISTED['store']
        assert resp['body']['artifact']['version'] == 3

    @pytest.mark.asyncio
    async def test_a_dict_deploy_without_a_block_gets_the_default_block(self, account_stub, monkeypatch):
        """No block: the door adds the default one, so the artifact, the manifest (a caller-supplied one is replaced) and the content stage all see it."""
        from ai.account.pipe_bundle import default_store_block, is_listed
        from ai.modules.task.commands import cmd_deploy

        written = AsyncMock(return_value=[])
        monkeypatch.setattr(cmd_deploy, 'write_pipe_content', written)
        conn = _make_conn(_account_info())
        resp = await conn._deploy_add_pipe(
            {}, {'pipeline': PIPE, 'metadata': {'ci': 'run-7', 'manifest': {'mode': 'paywall', 'name': 'Forged'}}}
        )

        publish = account_stub.deployments_publish.await_args
        # The stored artifact is the pipe WITH the block; the caller's dict is left as sent
        assert publish.args[2] == {**PIPE, 'store': default_store_block()}
        assert 'store' not in PIPE
        metadata = publish.kwargs['metadata']
        assert metadata == {
            'ci': 'run-7',
            'manifest': {
                'name': 'P',
                'description': '',
                'defaultSource': '',
                'tagline': '',
                'categories': ['pipeline'],
                'tags': [],
                'icon': '',
                'readme': '',
                'links': {},
                'mode': 'free',
                'version': '1.0.0',
                'billing': {'plans': []},
            },
        }
        assert is_listed(metadata['manifest'])
        # The content stage runs with no zip and a block that declares no file
        written.assert_awaited_once()
        bundle, block = written.await_args.args[3:]
        assert bundle is None and block == default_store_block()
        assert resp['body']['artifact']['version'] == 3

    @pytest.mark.asyncio
    async def test_a_dict_deploy_without_a_block_stores_no_content_and_does_not_fail(self, account_stub):
        """The REAL content stage: the default block declares no file, so a deploy without a zip writes nothing."""
        conn = _make_conn(_account_info())
        resp = await conn._deploy_add_pipe({}, {'pipeline': PIPE})

        assert account_stub.deployments_publish.await_args.kwargs['metadata']['manifest']['mode'] == 'free'
        account_stub.set_artifact_state.assert_not_awaited()
        assert resp['body']['artifact']['version'] == 3

    @pytest.mark.asyncio
    async def test_a_bundle_whose_pipe_has_no_block_gets_the_default_block_after_the_comparison(
        self, account_stub, monkeypatch
    ):
        """The dict and the bundle's .pipe are compared as sent; the block is added to the pipe both describe."""
        from ai.account.pipe_bundle import default_store_block
        from ai.modules.task.commands import cmd_deploy

        written = AsyncMock(return_value=[])
        monkeypatch.setattr(cmd_deploy, 'write_pipe_content', written)
        conn = _make_conn(_account_info())
        await conn._deploy_add_pipe({}, {'pipeline': PIPE, 'data': _bundle(PIPE, {'notes.txt': 'x'})})

        assert account_stub.deployments_publish.await_args.args[2] == {**PIPE, 'store': default_store_block()}
        bundle, block = written.await_args.args[3:]
        assert bundle.entries == ['notes.txt'] and block == default_store_block()
        # A dict that carries the block is not the bundle's pipe without it: a packer adds it to both
        account_stub.deployments_publish.reset_mock()
        with pytest.raises(ValueError, match="differs from the bundle's .pipe"):
            await conn._deploy_add_pipe(
                {}, {'pipeline': {**PIPE, 'store': default_store_block()}, 'data': _bundle(PIPE)}
            )
        account_stub.deployments_publish.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_an_unknown_store_key_refuses_the_deploy_by_name(self, account_stub):
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='store: unknown key "category"'):
            await conn._deploy_add_pipe({}, {'pipeline': {**PIPE, 'store': {'category': 'finance'}}})
        account_stub.deployments_publish.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_a_bad_mode_and_bad_plans_refuse_the_deploy(self, account_stub):
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='store.mode must be'):
            await conn._deploy_add_pipe({}, {'pipeline': {**PIPE, 'store': {'mode': 'usage'}}})
        with pytest.raises(ValueError, match='store.billing.plans must be a list of plan objects'):
            await conn._deploy_add_pipe({}, {'pipeline': {**PIPE, 'store': {'billing': {'plans': 'pro'}}}})
        account_stub.deployments_publish.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_a_declared_file_missing_from_the_bundle_marks_the_version_failed_by_name(self, account_stub):
        """The REAL content stage: the block names docs/README.md, the zip lacks it, the version fails by name."""
        account_stub.set_artifact_state = AsyncMock()
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='version 3 marked failed.*names readme "docs/README.md"'):
            await conn._deploy_add_pipe({}, {'pipeline': LISTED, 'data': _bundle(LISTED)})
        assert account_stub.set_artifact_state.await_args.args[:4] == ('org-1', 'acme.proj-1', 3, 'failed')

    @pytest.mark.asyncio
    async def test_publish_refuses_a_pipeline_that_differs_from_the_bundles_pipe(self, account_stub):
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match="differs from the bundle's .pipe"):
            await conn._deploy_add_pipe({}, {'pipeline': PIPE, 'data': _bundle({**PIPE, 'components': [{'id': 'x'}]})})
        account_stub.deployments_publish.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_publish_flips_the_version_failed_when_the_content_write_fails(self, account_stub, monkeypatch):
        from ai.modules.task.commands import cmd_deploy

        monkeypatch.setattr(cmd_deploy, 'write_pipe_content', AsyncMock(side_effect=RuntimeError('store down')))
        account_stub.set_artifact_state = AsyncMock()
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='marked failed'):
            await conn._deploy_add_pipe({}, {'data': _bundle(LISTED, {'docs/README.md': '# x'})})
        assert account_stub.set_artifact_state.await_args.args[:4] == ('org-1', 'acme.proj-1', 3, 'failed')

    @pytest.mark.asyncio
    async def test_publish_is_promoted_to_ready_without_a_review_ladder(self, account_stub):
        """Without the ladder (OSS) the developer IS the admin: the version is born 'private' and promoted once stored."""
        account_stub.review_ladder = False
        conn = _make_conn(_account_info())
        resp = await conn._deploy_add_pipe({}, {'pipeline': PIPE})

        assert 'state' not in account_stub.deployments_publish.await_args.kwargs
        assert account_stub.set_artifact_state.await_args.args[:4] == ('org-1', 'acme.proj-1', 3, 'ready')
        assert resp['body']['artifact']['state'] == 'ready'

    @pytest.mark.asyncio
    async def test_a_failed_content_write_lands_on_failed_without_a_review_ladder(self, account_stub, monkeypatch):
        """The real transition table: born 'private' the version can still become 'failed' when its bytes never land."""
        from ai.account.deployment_backend import _assert_review_transition
        from ai.modules.task.commands import cmd_deploy

        states = {3: 'private'}

        async def set_state(org_id, project_id, version, new_state, actor):
            """The backend's own guard over a stored state."""
            _assert_review_transition(states[version], new_state)
            states[version] = new_state
            return {'version': version, 'state': new_state}

        account_stub.review_ladder = False
        account_stub.set_artifact_state = AsyncMock(side_effect=set_state)
        monkeypatch.setattr(cmd_deploy, 'write_pipe_content', AsyncMock(side_effect=RuntimeError('store down')))
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='marked failed'):
            await conn._deploy_add_pipe({}, {'data': _bundle(LISTED, {'docs/README.md': '# x'})})
        assert states[3] == 'failed'

    @pytest.mark.asyncio
    async def test_publish_compares_the_dict_and_the_bundle_as_one_pipeline(self, account_stub, monkeypatch):
        """A TypeScript client sends 1.0 as 1 and no display name; the server compares canonical values after its own fill."""
        import io
        import zipfile

        from ai.modules.task.commands import cmd_deploy

        monkeypatch.setattr(cmd_deploy, 'write_pipe_content', AsyncMock(return_value=[]))
        on_disk = {**PIPE, 'components': [{'id': 'c1', 'ttl': 1.0}]}
        on_disk.pop('name', None)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as zf:
            zf.writestr('proj-1.pipe', json.dumps(on_disk))
        sent = {**on_disk, 'components': [{'id': 'c1', 'ttl': 1}], 'name': 'proj-1'}
        conn = _make_conn(_account_info())
        resp = await conn._deploy_add_pipe({}, {'pipeline': sent, 'data': buffer.getvalue()})
        assert resp['body']['artifact']['version'] == 3

    @pytest.mark.asyncio
    async def test_publish_keeps_a_boolean_apart_from_a_number_in_the_comparison(self, account_stub):
        """`True == 1` in Python; in the file they differ, so a dict with 1 is not the bundle's pipe with true."""
        import io
        import zipfile

        on_disk = {**PIPE, 'components': [{'id': 'c1', 'enabled': True}]}
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as zf:
            zf.writestr('proj-1.pipe', json.dumps(on_disk))
        sent = {**on_disk, 'components': [{'id': 'c1', 'enabled': 1}]}
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match="differs from the bundle's .pipe"):
            await conn._deploy_add_pipe({}, {'pipeline': sent, 'data': buffer.getvalue()})
        account_stub.deployments_publish.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_publish_denied_without_control_anywhere(self, account_stub):
        conn = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'D', 'permissions': ['task.monitor']}]))
        with pytest.raises(PermissionError):
            await conn._deploy_add_pipe({}, {'pipeline': PIPE})
        account_stub.deployments_publish.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_publish_and_deploy_in_one_step(self, account_stub):
        conn = _make_conn(_account_info())
        resp = await conn._deploy_add_pipe({}, {'pipeline': PIPE, 'deployTo': '=team/team-1'})
        account_stub.deployments_deploy.assert_awaited_once()
        assert resp['body']['deployment']['teamId'] == '=team/team-1'
        assert (resp['body']['deployment']['rung'], resp['body']['deployment']['handle']) == ('team', '@Development')
        conn._test_scheduler.sync.assert_called_once()

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ('deploy_to', 'error'),
        [
            ('=team/team-foreign', PermissionError),
            # The retired spellings, the bare team id among them
            ('team-1', ValueError),
            ('@team/Development', ValueError),
            ('@user', ValueError),
        ],
    )
    async def test_a_refused_deploy_to_writes_nothing(self, account_stub, deploy_to, error):
        """The one-step target is read and authorized before the registry write: no version, no
        withdrawn review, no change notification is left behind by a refused target.
        """
        conn = _make_conn(_account_info())
        conn._notify_deploy_changed = AsyncMock()
        with pytest.raises(error):
            await conn._deploy_add_pipe({}, {'pipeline': PIPE, 'deployTo': deploy_to})
        account_stub.deployments_publish.assert_not_awaited()
        account_stub.set_artifact_state.assert_not_awaited()
        account_stub.deployments_deploy.assert_not_awaited()
        conn._notify_deploy_changed.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_a_deploy_to_needing_a_dev_team_writes_nothing(self, account_stub):
        """The pointer-time billing stamp is checked before the write too: @me without a dev team refuses first."""
        conn = _make_conn(_account_info(dev_team=''))
        with pytest.raises(PermissionError, match='development team'):
            await conn._deploy_add_pipe({}, {'pipeline': PIPE, 'deployTo': '@me'})
        account_stub.deployments_publish.assert_not_awaited()


class TestPipeDoorKeepsToPipes:
    """develop #2989 (rocketride-ai/rocketride-saas#1011): the pipe door mints pipes, never app ids or app-owned metadata.

    Develop keeps pipe ids OUT of the developer namespace. Here a pipe's
    registry name is ``developerId.pipeId`` by design (plan S7): it is derived
    from the actor's own developer id, the file carries the short id only, and
    a name has one kind per organization (B37). So the id a caller sends can
    never name an app, its own or another organization's.
    """

    @pytest.mark.asyncio
    @pytest.mark.parametrize('project_id', ['acme.brandy', 'acme.deep.name', 'other.app'])
    async def test_a_project_id_shaped_like_an_app_id_is_refused_by_the_address_grammar(self, account_stub, project_id):
        """A dotted id cannot be sent: the short id is one segment, so no caller can spell an app id."""
        from ai.modules.task.types import TaskError

        conn = _make_conn(_account_info())
        with pytest.raises(TaskError, match='project_id') as refused:
            await conn._deploy_add_pipe({}, {'pipeline': {**PIPE, 'project_id': project_id}})
        assert refused.value.code == TaskError.INVALID_ARGUMENT
        account_stub.deployments_publish.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_the_registry_name_is_the_actors_namespace_plus_the_short_id(self, account_stub):
        conn = _make_conn(_account_info())
        await conn._deploy_add_pipe({}, {'pipeline': PIPE})
        assert account_stub.deployments_publish.await_args.args[1] == conn._registry_id(PIPE['project_id'])
        assert account_stub.deployments_publish.await_args.args[1].endswith('.' + PIPE['project_id'])

    @pytest.mark.asyncio
    async def test_caller_cannot_forge_the_build_lifecycle(self, account_stub):
        conn = _make_conn(_account_info())
        sent = {'build': {'status': 'ok'}, 'ci': 'run-7', 'projectId': 'p'}
        await conn._deploy_add_pipe({}, {'pipeline': PIPE, 'metadata': sent})

        stored = account_stub.deployments_publish.await_args.kwargs['metadata']
        assert 'build' not in stored
        assert (stored['ci'], stored['projectId']) == ('run-7', 'p')
        # The listing manifest is the server's own (plan 9), beside what the caller sent
        assert 'manifest' in stored
        # The caller's own dict is not mutated.
        assert 'build' in sent

    @pytest.mark.asyncio
    async def test_absent_metadata_carries_the_manifest_and_no_build(self, account_stub):
        conn = _make_conn(_account_info())
        await conn._deploy_add_pipe({}, {'pipeline': PIPE})
        assert set(account_stub.deployments_publish.await_args.kwargs['metadata']) == {'manifest'}


class TestDeploy:
    @pytest.mark.asyncio
    async def test_deploy_verifies_control_on_target_team(self, account_stub):
        conn = _make_conn(_account_info())
        await conn._deploy_deploy({}, {'projectId': 'proj-1', 'version': 3, 'teamId': '=team/team-1'})
        account_stub.deployments_deploy.assert_awaited_once_with(
            'org-1',
            '=team/team-1',
            'acme.proj-1',
            3,
            {'userId': 'user-1', 'display': 'Rod C', 'email': 'rod@example.com'},
            'team-1',
        )
        conn._test_scheduler.sync.assert_called_once()

    @pytest.mark.asyncio
    @pytest.mark.parametrize('team', ['=team/team-1', '=TEAM/team-1', '@Development', '@development', '@DEVELOPMENT'])
    async def test_deploy_takes_the_audience_or_the_team_name_ignoring_case(self, account_stub, team):
        # A row's audience passed back unchanged, or the name a person typed
        # (the SDKs pass it through, plan 2.5): one team, one stored audience
        conn = _make_conn(_account_info())
        await conn._deploy_deploy({}, {'projectId': 'proj-1', 'version': 3, 'teamId': team})
        assert account_stub.deployments_deploy.await_args.args[1] == '=team/team-1'

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ('team', 'error'),
        [
            ('@Elsewhere', PermissionError),
            ('=team/team-x', PermissionError),
            ('=user/other', PermissionError),
            ('@org', PermissionError),
            ('=org/org-1', PermissionError),
            ('=org/org-2', PermissionError),
            ('@spec', ValueError),
            ('@team/Development', ValueError),
            ('@user', ValueError),
            ('=team/team-1/x', ValueError),
            ('team-1', ValueError),
            ('Development', ValueError),
        ],
    )
    async def test_deploy_refuses_what_names_no_target_of_the_caller(self, account_stub, team, error):
        conn = _make_conn(_account_info())
        with pytest.raises(error):
            await conn._deploy_deploy({}, {'projectId': 'proj-1', 'version': 3, 'teamId': team})
        account_stub.deployments_deploy.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_an_org_admin_cannot_target_another_org(self, account_stub):
        # The admin check alone would refuse a non-admin; an admin of org-1
        # is refused a foreign org id too (the org rung is the active org only)
        admin = _account_info()
        admin.organization['permissions'] = ['org.admin']
        conn = _make_conn(admin)
        with pytest.raises(PermissionError):
            await conn._deploy_deploy({}, {'projectId': 'proj-1', 'version': 3, 'teamId': '=org/org-2'})
        account_stub.deployments_deploy.assert_not_awaited()

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ('team', 'message'),
        [
            ('@team/Development', '@team/ is retired: publish to @<name> or =team/<tid>'),
            ('@team/team-1', '@team/ is retired: publish to @<name> or =team/<tid>'),
            ('@user', '@user is retired: publish to @me'),
            ('team-1', 'Not a publish target'),
        ],
    )
    async def test_a_retired_spelling_and_a_bare_id_are_refused_naming_the_target(self, account_stub, team, message):
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError) as excinfo:
            await conn._deploy_deploy({}, {'projectId': 'proj-1', 'version': 3, 'teamId': team})
        assert message in str(excinfo.value)
        account_stub.deployments_deploy.assert_not_awaited()

    @pytest.mark.asyncio
    @pytest.mark.parametrize('target', ['@org', '@ORG', '=org/org-1'])
    async def test_an_org_admin_publishes_to_the_org_rung(self, account_stub, target):
        # C.35: the org rung is published by org admins only; its row is the
        # org's audience, billed to no team (plan 8.3)
        admin = _account_info()
        admin.organization['permissions'] = ['org.admin']
        conn = _make_conn(admin)
        await conn._deploy_deploy({}, {'projectId': 'proj-1', 'version': 3, 'teamId': target})
        args = account_stub.deployments_deploy.await_args.args
        assert (args[1], args[-1]) == ('=org/org-1', '')

    @pytest.mark.asyncio
    async def test_deploy_foreign_team_denied(self, account_stub):
        conn = _make_conn(_account_info())
        with pytest.raises(PermissionError):
            await conn._deploy_deploy({}, {'projectId': 'proj-1', 'version': 3, 'teamId': '=team/team-x'})
        account_stub.deployments_deploy.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_deploy_requires_integer_version(self, account_stub):
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='version'):
            await conn._deploy_deploy({}, {'projectId': 'proj-1', 'version': '3', 'teamId': '=team/team-1'})

    @pytest.mark.asyncio
    async def test_deploy_broadcasts_the_invalidation_event(self, account_stub):
        # The apaevt_deploy push replaces the deploy surfaces' polling —
        # pin the org-scoped envelope and the identity-only body so the
        # cache-invalidation contract cannot regress silently.
        from rocketride import EVENT_TYPE

        conn = _make_conn(_account_info())
        await conn._deploy_deploy({}, {'projectId': 'proj-1', 'version': 3, 'teamId': '=team/team-1'})
        conn._server.broadcast_server_event.assert_awaited_once_with(
            EVENT_TYPE.DEPLOY,
            {
                'event': 'apaevt_deploy',
                'body': {
                    'orgId': 'org-1',
                    'teamId': '=team/team-1',
                    'audience': '=team/team-1',
                    'projectId': 'acme.proj-1',
                    'action': 'deploy',
                },
            },
            org_id='org-1',
        )


# ============================================================================
# reads
# ============================================================================


class TestReads:
    # The org-wide backend snapshot the visibility tests slice: a member
    # team, a foreign team, the caller's personal space, another user's.
    _ORG_ROWS = [
        {'teamId': '=team/team-1', 'projectId': 'proj-1', 'state': 'enabled', 'version': 1, 'schedules': {}},
        {'teamId': '=team/team-x', 'projectId': 'proj-2', 'state': 'enabled', 'version': 1, 'schedules': {}},
        {'teamId': '=user/user-1', 'projectId': 'proj-3', 'state': 'enabled', 'version': 1, 'schedules': {}},
        {'teamId': '=user/other', 'projectId': 'proj-4', 'state': 'enabled', 'version': 1, 'schedules': {}},
    ]

    @pytest.mark.asyncio
    async def test_list_filters_to_member_teams_and_own_personal_space(self, account_stub):
        # Visibility model: membership alone grants sight — the task.*
        # permission strings are irrelevant to reads. One org-wide backend
        # query; the command layer slices out foreign teams and other
        # users' personal spaces.
        account_stub.deployments_list.return_value = list(self._ORG_ROWS)
        teams = [{'id': 'team-1', 'name': 'A', 'permissions': []}]
        conn = _make_conn(_account_info(teams=teams))
        result = await conn._deploy_list({}, {})
        assert account_stub.deployments_list.await_args.args == ('org-1', None)
        assert [r['teamId'] for r in result['body']['rows']] == ['=team/team-1', '=user/user-1']
        assert [(r['rung'], r['handle']) for r in result['body']['rows']] == [('team', '@A'), ('me', '@me')]

    @pytest.mark.asyncio
    async def test_list_shows_a_member_the_org_rung(self, account_stub):
        # The org rung is every member's (plan 3.2): the unfiltered list shows
        # its rows to a member, as a list scoped to '@org' already does
        org_row = {'teamId': '=org/org-1', 'projectId': 'proj-5', 'state': 'enabled', 'version': 1, 'schedules': {}}
        account_stub.deployments_list.return_value = [*self._ORG_ROWS, org_row]
        conn = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'A', 'permissions': []}]))
        result = await conn._deploy_list({}, {})
        assert [r['teamId'] for r in result['body']['rows']] == ['=team/team-1', '=user/user-1', '=org/org-1']

    @pytest.mark.asyncio
    async def test_list_org_admin_sees_everything(self, account_stub):
        # An org admin sees anything deployed anywhere — every team and
        # every user's personal space.
        account_stub.deployments_list.return_value = list(self._ORG_ROWS)
        conn = _make_conn(_account_info(teams=[]))
        conn._account_info.organization['permissions'] = ['org.admin']
        result = await conn._deploy_list({}, {})
        assert len(result['body']['rows']) == len(self._ORG_ROWS)

    @pytest.mark.asyncio
    async def test_list_foreign_team_denied_for_non_admin(self, account_stub):
        conn = _make_conn(_account_info())
        with pytest.raises(PermissionError):
            await conn._deploy_list({}, {'teamId': '=team/team-x'})
        # ...but an org admin may address any team in the org.
        admin = _make_conn(_account_info())
        admin._account_info.organization['permissions'] = ['org.admin']
        await admin._deploy_list({}, {'teamId': '=team/team-x'})
        assert account_stub.deployments_list.await_args.args == ('org-1', '=team/team-x')

    @pytest.mark.asyncio
    async def test_list_other_users_personal_space_is_admin_only(self, account_stub):
        conn = _make_conn(_account_info())
        with pytest.raises(PermissionError):
            await conn._deploy_list({}, {'teamId': '=user/other'})
        admin = _make_conn(_account_info())
        admin._account_info.organization['permissions'] = ['org.admin']
        await admin._deploy_list({}, {'teamId': '=user/other'})
        assert account_stub.deployments_list.await_args.args == ('org-1', '=user/other')

    @pytest.mark.asyncio
    async def test_get_missing_deployment_is_a_clean_error(self, account_stub):
        account_stub.deployments_get.return_value = None
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='No deployment'):
            await conn._deploy_get({}, {'projectId': 'proj-1', 'teamId': '=team/team-1'})

    @pytest.mark.asyncio
    async def test_versions_needs_org_membership_only(self, account_stub):
        # Registry rail reads carry no team-permission gate: any org user
        # can see what is deployed. Only a caller with NO org is refused.
        conn = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'D', 'permissions': []}]))
        result = await conn._deploy_versions({}, {'projectId': 'proj-1'})
        assert result['body']['rows'] == [{'version': 3}]
        conn._account_info.organization = None
        with pytest.raises(PermissionError, match='organisation membership'):
            await conn._deploy_versions({}, {'projectId': 'proj-1'})

    @pytest.mark.asyncio
    async def test_publish_requires_a_pipeline_name(self, account_stub):
        # Artifacts are immutable and pipelineName renders everywhere — a
        # nameless publish would show as a GUID forever.
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='pipeline.name'):
            await conn._deploy_add_pipe({}, {'pipeline': {'project_id': 'proj-1', 'components': []}})
        account_stub.deployments_publish.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_run_dispatches_as_the_team_with_manual_trigger(self, account_stub, monkeypatch):
        # Run-now = the scheduler's trusted dispatch with trigger='manual';
        # the run carries NO human identity (who fired it is recorded by the
        # audit call, not on the run); lastRunAt is stamped. The source's
        # execution settings ride along, but its ttl window does NOT — a
        # manual run has no window (the user stops it).
        dispatched = {}

        async def fake_dispatch(
            server,
            pipeline,
            *,
            attribution,
            deployment,
            trigger,
            ttl=None,
            trace_level=None,
            debug_out=False,
            listing=None,
        ):
            dispatched.update(
                pipeline=pipeline,
                attribution=attribution,
                deployment=deployment,
                trigger=trigger,
                ttl=ttl,
                trace_level=trace_level,
                debug_out=debug_out,
                listing=listing,
            )
            return '=control/c0ffee00c0ffee00c0ffee00c0ffee00'

        monkeypatch.setattr('ai.modules.task.task_server_facade.start_server_task_as_team', fake_dispatch)
        # The run's version (1) is a paid listing; another version is free:
        # the dispatch carries the listing of the version it runs
        account_stub.deployments_versions.return_value = [
            {'version': 3, 'metadata': {'manifest': {'mode': 'free'}}},
            {
                'version': 1,
                'metadata': {'manifest': {'mode': 'subscription', 'billing': {'plans': [{'nickname': 'Pro'}]}}},
            },
        ]
        account_stub.deployments_get.return_value = {
            **account_stub.deployments_get.return_value,
            'schedules': {
                'webhook_1': {
                    'cron': '0 * * * *',
                    'paused': False,
                    'ttl': 900,
                    'traceLevel': 'summary',
                    'debugOut': True,
                }
            },
        }
        conn = _make_conn(_account_info())
        # The dispatch hands back the control KEY (the control id); the client
        # gets that id in the token slot and the address beside it, like every
        # other starter (plan section 1)
        conn._server.control_by_key = MagicMock(
            return_value=SimpleNamespace(
                address='acme.proj-1.webhook_1', control_id='=control/c0ffee00c0ffee00c0ffee00c0ffee00'
            )
        )
        result = await conn._deploy_run({}, {'projectId': 'proj-1', 'sourceId': 'webhook_1', 'teamId': '=team/team-1'})
        assert result['body'] == {
            'token': '=control/c0ffee00c0ffee00c0ffee00c0ffee00',
            'address': 'acme.proj-1.webhook_1',
            'version': 1,
        }
        conn._server.control_by_key.assert_called_once_with('=control/c0ffee00c0ffee00c0ffee00c0ffee00')
        assert dispatched['trigger'] == 'manual'
        # The unattended row of plan 8.3: the team owns and bills it, no user
        attribution = dispatched['attribution']
        assert (attribution.rung, attribution.owner_kind, attribution.owner_id) == ('team', 'team', 'team-1')
        assert (attribution.org_id, attribution.user_id, attribution.team_id, attribution.env_team) == (
            'org-1',
            '',
            'team-1',
            'team-1',
        )
        # The run names the deployment it resolved through: disabling or
        # removing that deployment releases the run's hold
        assert dispatched['deployment'] == DeploymentRef(
            org_id='org-1', team_id='=team/team-1', project_id='acme.proj-1'
        )
        # The run carries the listing of the version it starts, not another version's
        assert (dispatched['listing'].mode, dispatched['listing'].plan) == ('subscription', 'Pro')
        assert dispatched['pipeline']['source'] == 'webhook_1'
        # No actor rides the dispatch — the run is owned by the team alone.
        assert 'actor' not in dispatched
        # The schedule's 900s window is ignored; its execution settings are not.
        assert dispatched['ttl'] is None
        assert dispatched['trace_level'] == 'summary'
        assert dispatched['debug_out'] is True
        account_stub.deployments_mark_run.assert_awaited_once_with('org-1', '=team/team-1', 'acme.proj-1', 'webhook_1')
        # The control KEY lands under the scheduler's overlap guard so the
        # next cron tick sees this run and skips.
        conn._test_scheduler.register_manual_run.assert_called_once_with(
            '=team/team-1', 'acme.proj-1', 'webhook_1', '=control/c0ffee00c0ffee00c0ffee00c0ffee00'
        )

    @pytest.mark.asyncio
    async def test_run_refuses_while_source_run_active(self, account_stub, monkeypatch):
        # The manual path honors the scheduler's overlap guard: a live run of
        # the same (team, project, source) refuses the run-now.
        async def fake_dispatch(*a, **k):
            raise AssertionError('must not dispatch')

        monkeypatch.setattr('ai.modules.task.task_server_facade.start_server_task_as_team', fake_dispatch)
        conn = _make_conn(_account_info())
        # A live run holds the slot: the atomic reservation is refused.
        conn._test_scheduler.try_reserve_run.return_value = False
        with pytest.raises(ValueError, match='already active'):
            await conn._deploy_run({}, {'projectId': 'proj-1', 'sourceId': 's1', 'teamId': '=team/team-1'})

    @pytest.mark.asyncio
    async def test_run_refuses_disabled_and_needs_control(self, account_stub, monkeypatch):
        async def fake_dispatch(*a, **k):
            raise AssertionError('must not dispatch')

        monkeypatch.setattr('ai.modules.task.task_server_facade.start_server_task_as_team', fake_dispatch)
        # Disabled deployment: no back-door single runs.
        account_stub.deployments_get.return_value = {**account_stub.deployments_get.return_value, 'state': 'disabled'}
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='disabled'):
            await conn._deploy_run({}, {'projectId': 'proj-1', 'sourceId': 's1', 'teamId': '=team/team-1'})
        # No task.control on the team: uniform denial.
        conn = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'D', 'permissions': ['task.monitor']}]))
        with pytest.raises(PermissionError):
            await conn._deploy_run({}, {'projectId': 'proj-1', 'sourceId': 's1', 'teamId': '=team/team-1'})

    @pytest.mark.asyncio
    async def test_artifact_returns_the_pipeline(self, account_stub):
        # The registry is the source of truth for what a deployed version
        # IS — the read-only DESIGN render is built from this body.
        conn = _make_conn(_account_info())
        result = await conn._deploy_artifact({}, {'projectId': 'proj-1', 'version': 3})
        assert result['body'] == {'project_id': 'proj-1', 'components': [{'id': 's1'}, {'id': 'webhook_1'}]}
        assert account_stub.deployments_artifact.await_args.args == ('org-1', 'acme.proj-1', 3)

    @pytest.mark.asyncio
    async def test_artifact_needs_task_monitor_and_integer_version(self, account_stub):
        # The artifact BODY is the full pipeline JSON, so reading it requires
        # task.monitor on a team (the gate develop shipped), not bare org
        # membership — a member with no team grant is refused.
        denied = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'D', 'permissions': []}]))
        with pytest.raises(PermissionError):
            await denied._deploy_artifact({}, {'projectId': 'proj-1', 'version': 1})
        # With the grant it reads; a non-int version is still refused, and the
        # shape check precedes the gate (so it raises ValueError, not Permission).
        conn = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'D', 'permissions': ['task.monitor']}]))
        result = await conn._deploy_artifact({}, {'projectId': 'proj-1', 'version': 1})
        assert result['body']['project_id'] == 'proj-1'
        with pytest.raises(ValueError):
            await conn._deploy_artifact({}, {'projectId': 'proj-1', 'version': '1'})

    @pytest.mark.asyncio
    async def test_list_returns_the_standard_envelope(self, account_stub):
        # The DataGrid contract: {rows,total,page,pageSize}, paged at the
        # command layer (rows are bounded by the caller's memberships).
        conn = _make_conn(_account_info())
        result = await conn._deploy_list({}, {'page_size': 1})
        body = result['body']
        assert set(body) == {'rows', 'total', 'page', 'pageSize'}
        assert (body['total'], body['pageSize']) == (1, 1)
        assert body['rows'][0]['projectId'] == 'proj-1'

    @pytest.mark.asyncio
    async def test_versions_returns_the_standard_envelope(self, account_stub):
        conn = _make_conn(_account_info())
        result = await conn._deploy_versions({}, {'projectId': 'proj-1'})
        body = result['body']
        assert set(body) == {'rows', 'total', 'page', 'pageSize'}
        assert body['rows'] == [{'version': 3}]

    @pytest.mark.asyncio
    async def test_history_paging_is_delegated_to_the_backend(self, account_stub):
        # History is unbounded: the COMMAND layer never materializes it —
        # the list-args travel to the backend (SQL on saas) untouched.
        conn = _make_conn(_account_info())
        args = {'projectId': 'proj-1', 'page': 3, 'page_size': 10, 'search': 'rollback'}
        result = await conn._deploy_history({}, args)
        passed = account_stub.deployments_history.await_args.args
        assert passed[1] == 'acme.proj-1' and passed[3] is args
        assert result['body']['rows'] == [{'action': 'publish', 'seq': 1}]

    @pytest.mark.asyncio
    async def test_a_publish_rows_audience_reads_with_this_readers_handle(self, account_stub):
        # Publish rows store the pair and its display name, never a handle; a
        # handle an older row stored is replaced by the one composed for the
        # reader (plan 2.5): their own space is @me, a team they know by name
        # @<name>, one they do not by =team/<tid>
        account_stub.deployments_history.return_value = {
            'rows': [
                {'action': 'publish', 'seq': 3, 'teamId': '', 'data': {'audience': {'type': 'user', 'id': 'user-1'}}},
                {
                    'action': 'publish',
                    'seq': 2,
                    'teamId': '',
                    'data': {'audience': {'type': 'team', 'id': 'team-1', 'name': 'Old', 'handle': '@team/Old'}},
                },
                {'action': 'disabled', 'seq': 1, 'teamId': '', 'data': {'audience': {'type': 'team', 'id': 'team-9'}}},
            ],
            'total': 3,
        }
        conn = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'Development', 'permissions': []}]))
        result = await conn._deploy_history({}, {'projectId': 'proj-1'})
        handles = [r['data']['audience']['handle'] for r in result['body']['rows']]
        assert handles == ['@me', '@Development', '=team/team-9']

    @pytest.mark.asyncio
    async def test_a_stored_handle_never_reaches_the_reader_where_no_audience_decodes(self, account_stub):
        # A legacy pair with no type, or a type no audience has, is shown
        # without a handle: the one an older row stored is dropped, the rest
        # of the pair kept; a row with no audience pair is untouched
        account_stub.deployments_history.return_value = {
            'rows': [
                {
                    'action': 'publish',
                    'seq': 3,
                    'teamId': '',
                    'data': {'audience': {'id': 'team-1', 'name': 'Old', 'handle': '@team/Old'}},
                },
                {
                    'action': 'publish',
                    'seq': 2,
                    'teamId': '',
                    'data': {'audience': {'type': 'bogus', 'id': 'x', 'name': 'Old', 'handle': '@team/Old'}},
                },
                {'action': 'deploy', 'seq': 1, 'teamId': '', 'data': {'note': 'kept'}},
            ],
            'total': 3,
        }
        conn = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'Development', 'permissions': []}]))
        result = await conn._deploy_history({}, {'projectId': 'proj-1'})
        rows = result['body']['rows']
        assert rows[0]['data']['audience'] == {'id': 'team-1', 'name': 'Old'}
        assert rows[1]['data']['audience'] == {'type': 'bogus', 'id': 'x', 'name': 'Old'}
        assert rows[2]['data'] == {'note': 'kept'}


# ============================================================================
# state / schedules
# ============================================================================


class TestPersonalDeploy:
    """The @me (personal) deploy target: owner key, dispatch identity, billing."""

    @pytest.mark.asyncio
    async def test_me_deploy_binds_the_user_audience_without_a_team_check(self, account_stub):
        # '@me' resolves to the caller's owner key and needs NO team GRANT:
        # the membership here carries ZERO permissions, so any permission
        # path would raise — binding still succeeds into =user/<uid>, and the
        # publisher's dev team is STAMPED as the absolute billing team.
        conn = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'D', 'permissions': []}]))
        await conn._deploy_deploy({}, {'projectId': 'proj-1', 'teamId': '@me', 'version': 1})
        args = account_stub.deployments_deploy.await_args.args
        assert args[1] == '=user/user-1'
        assert args[5] == 'team-1'  # the pointer-time billing stamp

    @pytest.mark.asyncio
    async def test_me_deploy_refuses_without_a_valid_dev_team(self, account_stub):
        # Billing never guesses: no dev-team membership in this org means
        # the @me publish itself refuses — the question is answered at
        # POINTER time, never deferred to fires.
        conn = _make_conn(_account_info(teams=[]))
        with pytest.raises(PermissionError, match='development team'):
            await conn._deploy_deploy({}, {'projectId': 'proj-1', 'teamId': '@me', 'version': 1})
        account_stub.deployments_deploy.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_team_deploy_stamps_its_own_team(self, account_stub):
        # A team audience is unambiguous — it bills itself, stamped at
        # pointer time so every row carries the one absolute answer.
        conn = _make_conn(_account_info())
        await conn._deploy_deploy({}, {'projectId': 'proj-1', 'teamId': '=team/team-1', 'version': 1})
        args = account_stub.deployments_deploy.await_args.args
        assert args[1] == '=team/team-1' and args[5] == 'team-1'

    @pytest.mark.asyncio
    async def test_me_run_dispatches_user_owned_with_billing_team(self, account_stub, monkeypatch):
        # An @me manual fire dispatches a USER-owned run: the owner rides
        # owner_user_id, billing is READ from the pointer-time stamp (never
        # resolved), and the overlap guard keys on the owner key.
        dispatched = {}

        async def fake_dispatch(server, pipeline, **kw):
            dispatched.update(kw, pipeline=pipeline)
            return '=control/d00dd00dd00dd00dd00dd00dd00dd00d'

        monkeypatch.setattr('ai.modules.task.task_server_facade.start_server_task_as_team', fake_dispatch)
        account_stub.deployments_get.return_value = {
            'teamId': '=user/user-1',
            'projectId': 'proj-1',
            'state': 'enabled',
            'version': 1,
            'schedules': {},
            'billingTeamId': 'team-1',
        }
        conn = _make_conn(_account_info(teams=[]))
        address = 'acme.proj-1.s1'
        conn._server.control_by_key = MagicMock(
            return_value=SimpleNamespace(address=address, control_id='=control/d00dd00dd00dd00dd00dd00dd00dd00d')
        )
        result = await conn._deploy_run({}, {'projectId': 'proj-1', 'sourceId': 's1', 'teamId': '@me'})
        assert result['body'] == {
            'token': '=control/d00dd00dd00dd00dd00dd00dd00dd00d',
            'address': address,
            'version': 1,
        }
        attribution = dispatched['attribution']
        assert (attribution.rung, attribution.owner_kind, attribution.owner_id) == ('me', 'user', 'user-1')
        # Billing team is the deployment's ABSOLUTE stamp, not the target, and
        # the publisher's own layers are the environment (plan 8.3)
        assert (attribution.user_id, attribution.team_id, attribution.env_team) == ('user-1', 'team-1', 'team-1')
        # Overlap guard + mark_run key on the OWNER key.
        conn._test_scheduler.register_manual_run.assert_called_once_with(
            '=user/user-1', 'acme.proj-1', 's1', '=control/d00dd00dd00dd00dd00dd00dd00dd00d'
        )
        account_stub.deployments_mark_run.assert_awaited_once_with('org-1', '=user/user-1', 'acme.proj-1', 's1')

    @pytest.mark.asyncio
    async def test_me_run_refuses_without_a_billing_stamp(self, account_stub, monkeypatch):
        # A personal record with no stamp (stamped team deleted, pre-stamp
        # row) cannot bill or resolve team secrets: refuse rather than
        # misattribute — re-publishing @me re-stamps.
        async def fake_dispatch(*a, **k):
            raise AssertionError('must not dispatch')

        monkeypatch.setattr('ai.modules.task.task_server_facade.start_server_task_as_team', fake_dispatch)
        account_stub.deployments_get.return_value = {
            'teamId': '=user/user-1',
            'projectId': 'proj-1',
            'state': 'enabled',
            'version': 1,
            'schedules': {},
        }
        conn = _make_conn(_account_info(teams=[]))
        with pytest.raises(ValueError, match='billing'):
            await conn._deploy_run({}, {'projectId': 'proj-1', 'sourceId': 's1', 'teamId': '@me'})

    @pytest.mark.asyncio
    async def test_me_requires_an_authenticated_user(self, account_stub):
        # '@me' with no user identity is meaningless — uniform denial.
        conn = _make_conn(_account_info(user_id='', teams=[]))
        with pytest.raises(PermissionError, match='authenticated'):
            await conn._deploy_deploy({}, {'projectId': 'proj-1', 'teamId': '@me', 'version': 1})


class TestPublicDeploy:
    """The @public (store) target on the pipe door (plan 10.1, 2026-11-20): the
    owner key, the app door's store gate and rule for who, the billing stamp,
    the list, schedules and runs.
    """

    _DEPLOY = {'projectId': 'proj-1', 'teamId': '@public', 'version': 1}

    @staticmethod
    def _rail(account_stub, state):
        """The one-version rail the store gate reads, at a review state."""
        account_stub.deployments_versions.return_value = [{'version': 1, 'state': state}]

    @pytest.mark.asyncio
    async def test_a_ladder_server_refuses_the_store_an_unapproved_version(self, account_stub):
        conn = _make_conn(_account_info())
        for state in ('private', 'submit', 'rejected', 'failed'):
            self._rail(account_stub, state)
            with pytest.raises(ValueError, match='not approved for the store yet'):
                await conn._deploy_deploy({}, dict(self._DEPLOY))
        account_stub.deployments_deploy.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_a_ladder_server_points_the_store_at_an_approved_version_with_the_publishers_stamp(
        self, account_stub
    ):
        # The app door's rule for who: a developer organization on a name in
        # its namespace, no team grant (this membership carries none).
        self._rail(account_stub, 'ready')
        conn = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'D', 'permissions': []}]))
        await conn._deploy_deploy({}, dict(self._DEPLOY))
        args = account_stub.deployments_deploy.await_args.args
        assert (args[1], args[2], args[3]) == ('@public', 'acme.proj-1', 1)
        assert args[5] == ''  # the store bills no team (plan 8.3): no stamp

    @pytest.mark.asyncio
    async def test_a_server_without_a_reviewer_takes_the_ready_version_it_promoted(self, account_stub):
        # Without a ladder the pipe door promotes a version to 'ready' as it is
        # stored, and the store serves a pipe only 'ready' (pipe_serving_block_of):
        # a version left 'private' never finished its deploy
        account_stub.review_ladder = False
        conn = _make_conn(_account_info())
        self._rail(account_stub, 'ready')
        await conn._deploy_deploy({}, dict(self._DEPLOY))
        assert account_stub.deployments_deploy.await_args.args[1] == '@public'
        self._rail(account_stub, 'private')
        with pytest.raises(ValueError, match='not ready for the store'):
            await conn._deploy_deploy({}, dict(self._DEPLOY))
        self._rail(account_stub, 'failed')
        with pytest.raises(ValueError, match='failed processing'):
            await conn._deploy_deploy({}, dict(self._DEPLOY))
        assert account_stub.deployments_deploy.await_count == 1

    @pytest.mark.asyncio
    async def test_an_app_version_never_takes_the_pipe_doors_store_pointer(self, account_stub):
        # An app reaches the store through the app door, which keeps its manifest
        account_stub.deployments_versions.return_value = [{'version': 1, 'state': 'ready', 'kind': 'app'}]
        with pytest.raises(ValueError, match='is an app'):
            await _make_conn(_account_info())._deploy_deploy({}, dict(self._DEPLOY))
        account_stub.deployments_deploy.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_a_version_not_on_the_rail_is_refused_by_name(self, account_stub):
        account_stub.deployments_versions.return_value = []
        with pytest.raises(ValueError, match='version 1 is not published for acme.proj-1'):
            await _make_conn(_account_info())._deploy_deploy({}, dict(self._DEPLOY))

    @pytest.mark.asyncio
    async def test_add_with_deploy_to_public_takes_the_store_gate(self, account_stub):
        # The one-step add+deploy is a door to the store too: on a review-ladder
        # server the version it just added is a draft, so the store refuses it
        account_stub.deployments_versions.return_value = [{'version': 3, 'state': 'private'}]
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='not approved for the store yet'):
            await conn._deploy_add_pipe({}, {'pipeline': PIPE, 'deployTo': '@public'})
        account_stub.deployments_deploy.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_the_store_needs_a_developer_organization_and_a_dev_team(self, account_stub):
        self._rail(account_stub, 'ready')
        info = _account_info()
        info.organization['developerId'] = None
        with pytest.raises(ValueError, match='registered as a developer'):
            _make_conn(info)._require_team({'teamId': '@public'}, 'task.control')
        # The store bills no team (plan 8.3), so a publisher with no
        # development team still publishes there; @me still needs one
        await _make_conn(_account_info(teams=[], dev_team=''))._deploy_deploy({}, dict(self._DEPLOY))
        assert account_stub.deployments_deploy.await_args.args[5] == ''
        with pytest.raises(PermissionError, match='@me needs your development team'):
            await _make_conn(_account_info(teams=[], dev_team=''))._deploy_deploy({}, {**self._DEPLOY, 'teamId': '@me'})

    @pytest.mark.asyncio
    async def test_a_pipeline_that_declares_roots_is_refused_on_the_store(self, account_stub):
        # Plan 2.5: declared roots reach the publisher's team or org trees,
        # and the store serves every org's callers
        self._rail(account_stub, 'ready')
        account_stub.deployments_artifact.return_value = {'components': [], 'roots': ['@Development/kb']}
        with pytest.raises(ValueError, match='declares roots'):
            await _make_conn(_account_info())._deploy_deploy({}, dict(self._DEPLOY))
        account_stub.deployments_deploy.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_a_member_sees_the_store_row_and_reads_it_by_its_handle(self, account_stub):
        account_stub.deployments_list.return_value = [
            {'teamId': '=team/team-1', 'projectId': 'acme.proj-1', 'state': 'enabled', 'version': 1, 'schedules': {}},
            {'teamId': '@public', 'projectId': 'acme.proj-1', 'state': 'enabled', 'version': 1, 'schedules': {}},
            {'teamId': '=team/team-x', 'projectId': 'acme.proj-1', 'state': 'enabled', 'version': 1, 'schedules': {}},
        ]
        conn = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'A', 'permissions': []}]))
        result = await conn._deploy_list({}, {})
        assert sorted(r['teamId'] for r in result['body']['rows']) == ['=team/team-1', '@public']
        await conn._deploy_list({}, {'teamId': '@public'})
        assert account_stub.deployments_list.await_args.args == ('org-1', '@public')

    @pytest.mark.asyncio
    async def test_schedules_sit_on_me_and_on_the_store(self, account_stub):
        # Any published pipe can be scheduled: @me and @public take a
        # schedule like a team does, and the scheduler resyncs from the row.
        # An unattended @public run is the org's (plan 8.3): its schedule is
        # an org admin's, as the org rung's is
        member = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'D', 'permissions': []}]))
        for target in ('@public', '@org'):
            with pytest.raises(PermissionError, match='org admins'):
                await member._deploy_schedule_set(
                    {}, {'projectId': 'proj-1', 'teamId': target, 'sourceId': 's1', 'schedule': '0 2 * * *'}
                )
        admin = _account_info(teams=[{'id': 'team-1', 'name': 'D', 'permissions': []}])
        admin.organization['permissions'] = ['org.admin']
        conn = _make_conn(admin)
        for target, slot in (('@me', '=user/user-1'), ('@public', '@public'), ('@org', '=org/org-1')):
            await conn._deploy_schedule_set(
                {}, {'projectId': 'proj-1', 'teamId': target, 'sourceId': 's1', 'schedule': '0 2 * * *'}
            )
            args = account_stub.deployments_schedule_set.await_args.args
            assert (args[1], args[2], args[3], args[4]) == (slot, 'acme.proj-1', 's1', '0 2 * * *')
            conn._test_scheduler.sync.assert_called_with('org-1', account_stub.deployments_schedule_set.return_value)

    @pytest.mark.asyncio
    async def test_an_unattended_run_refuses_roots_declared_by_team_name(self, account_stub):
        # A schedule or run-now has no session to resolve a team NAME in the
        # pipeline's declared roots (plan 2.5): refused when it is set, naming
        # the id form; the same root by id is accepted
        account_stub.deployments_artifact.return_value = {
            'project_id': 'proj-1',
            'components': [{'id': 's1'}],
            'roots': ['@Development/kb'],
        }
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='declare each as =team/<tid>'):
            await conn._deploy_schedule_set(
                {}, {'projectId': 'proj-1', 'teamId': '=team/team-1', 'sourceId': 's1', 'schedule': '0 2 * * *'}
            )
        with pytest.raises(ValueError, match='declare each as =team/<tid>'):
            await conn._deploy_run({}, {'projectId': 'proj-1', 'sourceId': 's1', 'teamId': '=team/team-1'})
        account_stub.deployments_schedule_set.assert_not_awaited()
        # Clearing a schedule makes no unattended run: it never meets the refusal
        await conn._deploy_schedule_set(
            {}, {'projectId': 'proj-1', 'teamId': '=team/team-1', 'sourceId': 's1', 'schedule': 'manual'}
        )
        assert account_stub.deployments_schedule_set.await_args.args[4] is None
        account_stub.deployments_schedule_set.reset_mock()
        account_stub.deployments_artifact.return_value = {
            'project_id': 'proj-1',
            'components': [{'id': 's1'}],
            'roots': ['=team/team-1/kb'],
        }
        await conn._deploy_schedule_set(
            {}, {'projectId': 'proj-1', 'teamId': '=team/team-1', 'sourceId': 's1', 'schedule': '0 2 * * *'}
        )
        account_stub.deployments_schedule_set.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_an_unattended_store_run_is_the_orgs(self, account_stub, monkeypatch):
        dispatched = {}

        async def fake_dispatch(server, pipeline, **kw):
            dispatched.update(kw)
            return '=control/d00dd00dd00dd00dd00dd00dd00dd00d'

        monkeypatch.setattr('ai.modules.task.task_server_facade.start_server_task_as_team', fake_dispatch)
        record = {
            'teamId': '@public',
            'projectId': 'acme.proj-1',
            'state': 'enabled',
            'version': 1,
            'schedules': {},
            'billingTeamId': 'team-1',
        }
        account_stub.deployments_get.return_value = record
        member = _make_conn(_account_info(teams=[], dev_team=''))
        with pytest.raises(PermissionError, match='org admins'):
            await member._deploy_run({}, {'projectId': 'proj-1', 'sourceId': 's1', 'teamId': '@public'})
        admin = _account_info(teams=[], dev_team='')
        admin.organization['permissions'] = ['org.admin']
        conn = _make_conn(admin)
        conn._server.control_by_key = MagicMock(
            return_value=SimpleNamespace(
                address='acme.proj-1.s1', control_id='=control/d00dd00dd00dd00dd00dd00dd00dd00d'
            )
        )
        await conn._deploy_run({}, {'projectId': 'proj-1', 'sourceId': 's1', 'teamId': '@public'})
        assert dispatched['deployment'] == DeploymentRef(org_id='org-1', team_id='@public', project_id='acme.proj-1')
        # Plan 8.3: on the public rung, owned and paid by the org, no user,
        # no team (any stamp the row carries is never read)
        attribution = dispatched['attribution']
        assert (attribution.rung, attribution.owner_kind, attribution.owner_id) == ('public', 'org', 'org-1')
        assert (attribution.user_id, attribution.team_id, attribution.env_team) == ('', '', '')
        account_stub.deployments_get.return_value = {**record, 'billingTeamId': ''}
        await conn._deploy_run({}, {'projectId': 'proj-1', 'sourceId': 's1', 'teamId': '@public'})
        assert dispatched['attribution'].team_id == ''


class TestStateAndSchedules:
    @pytest.mark.asyncio
    async def test_disable_enable_remove_map_to_states(self, account_stub):
        conn = _make_conn(_account_info())
        await conn._deploy_disable({}, {'projectId': 'proj-1', 'teamId': '=team/team-1'})
        await conn._deploy_enable({}, {'projectId': 'proj-1', 'teamId': '=team/team-1'})
        await conn._deploy_remove({}, {'projectId': 'proj-1', 'teamId': '=team/team-1'})
        states = [c.args[3] for c in account_stub.deployments_set_state.await_args_list]
        assert states == ['disabled', 'enabled', 'removed']
        # Every mutation resyncs the scheduler.
        assert conn._test_scheduler.sync.call_count == 3

    @pytest.mark.asyncio
    async def test_schedule_set_validates_cron_and_normalizes_manual(self, account_stub):
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='Invalid schedule'):
            await conn._deploy_schedule_set(
                {}, {'projectId': 'proj-1', 'teamId': '=team/team-1', 'sourceId': 's1', 'schedule': 'nope'}
            )
        # 'manual' means "no schedule row" — persisted as a clear (None).
        await conn._deploy_schedule_set(
            {}, {'projectId': 'proj-1', 'teamId': '=team/team-1', 'sourceId': 's1', 'schedule': 'manual'}
        )
        assert account_stub.deployments_schedule_set.await_args.args[4] is None

    @pytest.mark.asyncio
    async def test_schedule_set_rejects_source_not_in_artifact(self, account_stub):
        # A schedule for a source the deployed artifact does not contain
        # would fail on every cron tick — refused at write time instead.
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='not a component'):
            await conn._deploy_schedule_set(
                {}, {'projectId': 'proj-1', 'teamId': '=team/team-1', 'sourceId': 'ghost', 'schedule': '@hourly'}
            )
        account_stub.deployments_schedule_set.assert_not_awaited()
        # source_config shares the guard (same argument, same failure mode).
        with pytest.raises(ValueError, match='not a component'):
            await conn._deploy_source_config(
                {}, {'projectId': 'proj-1', 'teamId': '=team/team-1', 'sourceId': 'ghost', 'traceLevel': 'none'}
            )
        account_stub.deployments_source_config_set.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_schedule_pause_resume_flip_the_flag(self, account_stub):
        conn = _make_conn(_account_info())
        await conn._deploy_schedule_pause({}, {'projectId': 'proj-1', 'teamId': '=team/team-1', 'sourceId': 's1'})
        await conn._deploy_schedule_resume({}, {'projectId': 'proj-1', 'teamId': '=team/team-1', 'sourceId': 's1'})
        flags = [c.args[4] for c in account_stub.deployments_schedule_set_paused.await_args_list]
        assert flags == [True, False]
        # Both flips resync the scheduler and audit.
        assert conn._test_scheduler.sync.call_count == 2
        assert account_stub.audit.await_count == 2

    @pytest.mark.asyncio
    async def test_source_config_validates_and_routes(self, account_stub):
        conn = _make_conn(_account_info())
        # An unknown trace level is refused before anything persists.
        with pytest.raises(ValueError, match='traceLevel'):
            await conn._deploy_source_config(
                {}, {'projectId': 'proj-1', 'teamId': '=team/team-1', 'sourceId': 's1', 'traceLevel': 'loud'}
            )
        # Valid config routes with the exact (level, debugOut) pair.
        await conn._deploy_source_config(
            {},
            {'projectId': 'proj-1', 'teamId': '=team/team-1', 'sourceId': 's1', 'traceLevel': 'none', 'debugOut': True},
        )
        passed = account_stub.deployments_source_config_set.await_args.args
        assert passed[3] == 's1' and passed[4] == 'none' and passed[5] is True
        account_stub.audit.assert_awaited()

    @pytest.mark.asyncio
    async def test_schedule_pause_requires_source_and_control(self, account_stub):
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='sourceId'):
            await conn._deploy_schedule_pause({}, {'projectId': 'proj-1', 'teamId': '=team/team-1'})
        # No task.control on the team: uniform denial.
        conn = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'D', 'permissions': ['task.monitor']}]))
        with pytest.raises(PermissionError):
            await conn._deploy_schedule_pause({}, {'projectId': 'proj-1', 'teamId': '=team/team-1', 'sourceId': 's1'})


# ============================================================================
# delete — one version's storage goes, apps and pipes through the one door
# ============================================================================


class TestDelete:
    @pytest.mark.asyncio
    async def test_delete_routes_to_the_registry_name_and_audits(self, account_stub):
        account_stub.deployments_delete_version = AsyncMock(
            return_value={'projectId': 'acme.proj-1', 'version': 2, 'kind': 'pipe', 'sha256': 'abc', 'deleted': True}
        )
        conn = _make_conn(_account_info())
        result = await conn._deploy_delete({}, {'projectId': 'proj-1', 'version': 2})
        # The short id composes into the caller's namespace; an app id (already
        # dotted) passes through the same door.
        assert account_stub.deployments_delete_version.await_args.args[:3] == ('org-1', 'acme.proj-1', 2)
        assert account_stub.deployments_delete_version.await_args.args[3]['userId'] == 'user-1'
        assert result['body']['deleted'] is True and result['body']['orgId'] == 'org-1'
        audit = account_stub.audit.await_args
        assert audit.args[2] == 'deploy_delete'
        assert audit.kwargs['request_data'] == {'projectId': 'acme.proj-1', 'version': 2}
        # Registry rails re-fetch on the org-scoped deploy-changed signal.
        event = conn._server.broadcast_server_event.await_args.args
        body = next(a for a in event if isinstance(a, dict))['body']
        assert (body['projectId'], body['action']) == ('acme.proj-1', 'delete')

        await conn._deploy_delete({}, {'projectId': 'acme.brandy', 'version': 1})
        assert account_stub.deployments_delete_version.await_args.args[1] == 'acme.brandy'

    @pytest.mark.asyncio
    async def test_delete_refusals_pass_through_untouched(self, account_stub):
        # The account layer states the reason (pinned / in review / building);
        # the door neither swallows nor rewrites it, and audits nothing.
        account_stub.deployments_delete_version = AsyncMock(
            side_effect=ValueError('acme.proj-1 v2 is published to @Production; unpublish it first')
        )
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='published to @Production; unpublish it first'):
            await conn._deploy_delete({}, {'projectId': 'proj-1', 'version': 2})
        account_stub.audit.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_delete_needs_the_deploy_permission(self, account_stub):
        account_stub.deployments_delete_version = AsyncMock(return_value={'version': 2, 'deleted': True})
        # task.control nowhere (the add gate): refused before the account layer.
        conn = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'D', 'permissions': ['task.monitor']}]))
        with pytest.raises(PermissionError, match='task.control'):
            await conn._deploy_delete({}, {'projectId': 'proj-1', 'version': 2})
        account_stub.deployments_delete_version.assert_not_awaited()
        # An org admin holds every team permission (the account record lists
        # every org team; the resolver expands org.admin on each).
        admin = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'D', 'permissions': []}]))
        admin._account_info.organization['permissions'] = ['org.admin']
        await admin._deploy_delete({}, {'projectId': 'proj-1', 'version': 2})
        account_stub.deployments_delete_version.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_delete_validates_its_arguments(self, account_stub):
        account_stub.deployments_delete_version = AsyncMock()
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='projectId'):
            await conn._deploy_delete({}, {'version': 2})
        for bad in (None, '2', 0, -1, 1.5, True):
            with pytest.raises(ValueError, match='positive integer'):
                await conn._deploy_delete({}, {'projectId': 'proj-1', 'version': bad})
        account_stub.deployments_delete_version.assert_not_awaited()


# ============================================================================
# preview — the single evaluator
# ============================================================================


class TestPreview:
    @pytest.mark.asyncio
    async def test_valid_cron_returns_occurrences(self, account_stub):
        conn = _make_conn(_account_info())
        resp = await conn._deploy_preview({}, {'schedule': '*/5 * * * *', 'count': 3})
        body = resp['body']
        assert body['valid'] is True
        assert len(body['next']) == 3
        # Monotonic future timestamps.
        assert body['next'][0] < body['next'][1] < body['next'][2]

    @pytest.mark.asyncio
    async def test_invalid_cron_reports_not_raises(self, account_stub):
        conn = _make_conn(_account_info())
        resp = await conn._deploy_preview({}, {'schedule': 'not a cron'})
        assert resp['body']['valid'] is False
        assert resp['body']['error']

    @pytest.mark.asyncio
    async def test_manual_is_valid_with_no_occurrences(self, account_stub):
        conn = _make_conn(_account_info())
        resp = await conn._deploy_preview({}, {'schedule': 'manual'})
        assert resp['body'] == {'valid': True, 'next': []}


# ============================================================================
# interfaces — the publication that answers an address, by classType (plan 3.6)
# ============================================================================


def _pin(rung='team', team_id='=team/team-1', version=2, org='org-1', project='docBrain'):
    """One serving pin of docBrain."""
    from ai.account.pipe_deploy import Pin

    return Pin(rung=rung, deployment=DeploymentRef(org, team_id, project), version=version)


def _control(rung='dev', owner_id='user-1', address='acme.docBrain.chat'):
    """A registered control holding the spec it submitted."""
    return SimpleNamespace(rung=rung, owner_id=owner_id, address=address, pipeline=ARTIFACT)


def _answers(conn, *candidates, address='acme.docBrain'):
    """THE decision stub: ``resolve_target`` in read mode answers the first of ``candidates``.

    A pin answers with the artifact the decision read (``ARTIFACT``), as the
    resolver's read does.
    """
    from ai.account.pipe_deploy import Pin
    from ai.modules.task.address import parse_target
    from ai.modules.task.task_server import Resolution
    from ai.modules.task.types import TaskError

    if not candidates:
        refusal = TaskError(TaskError.NOT_REGISTERED, 'nothing answers', rungsTried=['@spec'])
        conn._server.resolve_target = AsyncMock(side_effect=refusal)
        return conn._server.resolve_target
    first = candidates[0]
    pin = first if isinstance(first, Pin) else None
    control = None if pin is not None else first
    resolution = Resolution(parse_target(address), control, pin, False, ARTIFACT if pin is not None else None)
    conn._server.resolve_target = AsyncMock(return_value=resolution)
    return conn._server.resolve_target


CATALOG = {
    'chat': {
        'title': 'Chat',
        'classType': ['source', 'chat'],
        'sourceKind': 'request',
        'lanes': {'_source': ['questions']},
    },
    'db_postgres': {'classType': ['database', 'tool']},
}

#: What the chat source of ARTIFACT is, under the address the request names.
CHAT_SOURCE = {
    'nodeId': 'chat',
    'name': 'chat',
    'title': 'Chat',
    'kind': 'request',
    'entry': 'data',
    'lanes': ['questions'],
}

ARTIFACT = {
    'project_id': 'docBrain',
    'source': 'chat',
    'components': [
        {'id': 'chat', 'provider': 'chat', 'config': {'mode': 'Source'}},
        {'id': 'db_main', 'provider': 'db_postgres', 'name': 'Ops DB'},
    ],
}


@pytest.fixture
def interfaces_stub(monkeypatch, account_stub):
    """The artifact above behind the registry, the catalog above behind the lookup."""
    import ai.modules.task.services_catalog as services_catalog

    account_stub.deployments_artifact = AsyncMock(return_value=ARTIFACT)

    async def get_service(name):
        return CATALOG.get(name)

    monkeypatch.setattr(services_catalog, 'get_service', get_service)


def _data_account():
    """A member with task.data on team-1 — what a data request on the team's publication needs."""
    return _account_info(
        teams=[{'id': 'team-1', 'name': 'Development', 'permissions': ['task.control', 'task.monitor', 'task.data']}]
    )


class TestInterfaces:
    @pytest.mark.asyncio
    async def test_a_pin_answers_with_its_artifact_and_no_engine(self, account_stub, interfaces_stub):
        conn = _make_conn(_data_account())
        decide = _answers(conn, _pin())
        resp = await conn.on_rrext_deploy_pipe(
            {'arguments': {'subcommand': 'interfaces', 'address': 'acme.docBrain.chat'}}
        )
        body = resp['body']
        # The one decision every name call makes, asked with the caller's account, nothing started
        args, kwargs = decide.await_args
        assert args[0] is conn._account_info and args[1] == 'acme.docBrain.chat' and args[2] == 'task.data'
        assert kwargs == {'mode': RESOLVE_READ}
        # The pinned artifact the decision read, for the whole pipe: no second
        # registry read (the resolver loads the pinned version: test_resolve_target)
        account_stub.deployments_artifact.assert_not_awaited()
        assert body['address'] == 'acme.docBrain'
        assert body['rung'] == 'team' and body['teamId'] == 'team-1' and body['version'] == 2
        assert body['interfaces'] == {
            'acme.docBrain.chat': {
                'source': [{'nodeId': 'chat', 'name': 'chat'}],
                'chat': [{'nodeId': 'chat', 'name': 'chat'}],
            },
            'acme.docBrain': {
                'database': [{'nodeId': 'db_main', 'name': 'Ops DB'}],
                'tool': [{'nodeId': 'db_main', 'name': 'Ops DB'}],
            },
        }
        # What each source is, from its service's declaration
        assert body['sources'] == {'acme.docBrain.chat': CHAT_SOURCE}
        # Nothing was started
        conn._test_scheduler.try_reserve_run.assert_not_called()

    @pytest.mark.asyncio
    async def test_a_rooted_address_rides_the_decision(self, interfaces_stub):
        conn = _make_conn(_data_account())
        decide = _answers(conn, _pin(), address='@Development/acme.docBrain')
        await conn.on_rrext_deploy_pipe(
            {'arguments': {'subcommand': 'interfaces', 'address': '@Development/acme.docBrain'}}
        )
        assert decide.await_args.args[1] == '@Development/acme.docBrain'

    @pytest.mark.asyncio
    @pytest.mark.parametrize('typed', ['team-1', '@development', '@DEVELOPMENT', '=team/team-1', '@me', '@QA'])
    async def test_the_retired_team_option_is_refused(self, interfaces_stub, typed):
        # Every form the option ever took is refused before the decision: the
        # team rides the address as its root instead
        from ai.modules.task.types import TaskError

        conn = _make_conn(_data_account())
        decide = _answers(conn, _pin())
        with pytest.raises(TaskError) as excinfo:
            await conn.on_rrext_deploy_pipe(
                {'arguments': {'subcommand': 'interfaces', 'address': 'acme.docBrain', 'team': typed}}
            )
        assert excinfo.value.field == 'team' and 'rooted address' in str(excinfo.value)
        decide.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_the_callers_control_answers_with_the_spec_it_submitted(self, account_stub, interfaces_stub):
        conn = _make_conn(_account_info())
        _answers(conn, _control(), _pin())
        resp = await conn.on_rrext_deploy_pipe({'arguments': {'subcommand': 'interfaces', 'address': 'acme.docBrain'}})
        body = resp['body']
        # The first candidate is a control: its own spec, no registry read, no version
        account_stub.deployments_artifact.assert_not_awaited()
        assert body['rung'] == 'dev' and body['version'] is None and body['address'] == 'acme.docBrain'
        assert body['interfaces']['acme.docBrain']['database'] == [{'nodeId': 'db_main', 'name': 'Ops DB'}]
        assert body['sources'] == {'acme.docBrain.chat': CHAT_SOURCE}

    @pytest.mark.asyncio
    async def test_a_team_control_first_in_the_order_reports_its_team(self, interfaces_stub):
        conn = _make_conn(_data_account())
        _answers(conn, _control(rung='team', owner_id='team-1'))
        resp = await conn.on_rrext_deploy_pipe({'arguments': {'subcommand': 'interfaces', 'address': 'acme.docBrain'}})
        assert resp['body']['rung'] == 'team' and resp['body']['teamId'] == 'team-1' and resp['body']['version'] is None

    @pytest.mark.asyncio
    async def test_no_candidate_is_not_registered(self, account_stub, interfaces_stub):
        from ai.modules.task.types import TaskError

        conn = _make_conn(_account_info())
        _answers(conn)
        with pytest.raises(TaskError) as excinfo:
            await conn.on_rrext_deploy_pipe({'arguments': {'subcommand': 'interfaces', 'address': 'acme.docBrain'}})
        assert excinfo.value.code == TaskError.NOT_REGISTERED
        account_stub.deployments_artifact.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_a_team_pin_needs_task_data_on_that_team(self, account_stub, interfaces_stub):
        conn = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'D', 'permissions': ['task.monitor']}]))
        _answers(conn, _pin())
        with pytest.raises(PermissionError):
            await conn.on_rrext_deploy_pipe({'arguments': {'subcommand': 'interfaces', 'address': 'acme.docBrain'}})
        account_stub.deployments_artifact.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_a_public_pin_answers_with_the_artifact_the_decision_read(self, account_stub, interfaces_stub):
        conn = _make_conn(_account_info())
        _answers(
            conn,
            _pin(rung='public', team_id='@public', org='org-9', project='docBrain', version=7),
            address='zeta.docBrain',
        )
        resp = await conn.on_rrext_deploy_pipe({'arguments': {'subcommand': 'interfaces', 'address': 'zeta.docBrain'}})
        account_stub.deployments_artifact.assert_not_awaited()
        assert resp['body']['rung'] == 'public' and resp['body']['version'] == 7 and 'teamId' not in resp['body']
        assert 'zeta.docBrain.chat' in resp['body']['interfaces']

    @pytest.mark.asyncio
    async def test_address_is_required(self, interfaces_stub):
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError):
            await conn.on_rrext_deploy_pipe({'arguments': {'subcommand': 'interfaces'}})


# ============================================================================
# The registry name: developerId.pipeId, composed at the door (plan 2.3, B37)
# ============================================================================


class TestRegistryId:
    """Clients send the short id; the door stores the pipe inside the caller's namespace."""

    def test_short_id_is_composed_from_the_callers_developer_id(self):
        conn = _make_conn(_account_info())
        assert conn._registry_id('proj-1') == 'acme.proj-1'

    def test_a_name_in_the_callers_namespace_passes_through(self):
        conn = _make_conn(_account_info())
        assert conn._registry_id('acme.proj-1') == 'acme.proj-1'

    def test_a_name_in_another_namespace_is_refused(self):
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='outside your developer namespace'):
            conn._registry_id('other.proj-1')

    def test_a_dotted_short_id_is_refused_by_the_grammar(self):
        from ai.modules.task.types import TaskError

        conn = _make_conn(_account_info())
        with pytest.raises(ValueError):
            conn._registry_id('a.b.c')
        with pytest.raises(TaskError):
            conn._registry_id('bad id')

    def test_no_developer_id_is_refused_with_the_claim_message(self):
        info = _account_info()
        info.organization['developerId'] = None
        conn = _make_conn(info)
        with pytest.raises(ValueError, match='requires a registered developer id'):
            conn._registry_id('proj-1')

    def test_no_organization_is_the_membership_refusal(self):
        info = _account_info()
        info.organization = None
        conn = _make_conn(info)
        with pytest.raises(PermissionError, match='organisation membership'):
            conn._registry_id('proj-1')

    @pytest.mark.asyncio
    async def test_add_stores_the_registry_name_and_keeps_the_short_id_in_the_file(self, account_stub):
        conn = _make_conn(_account_info())
        pipeline = {'project_id': 'proj-1', 'name': 'P', 'source': 'webhook_1', 'components': []}
        resp = await conn._deploy_add_pipe({}, {'pipeline': pipeline})
        args = account_stub.deployments_publish.await_args.args
        assert args[1] == 'acme.proj-1'
        assert args[2]['project_id'] == 'proj-1'
        assert resp['body']['fullName'] == 'acme.proj-1'
