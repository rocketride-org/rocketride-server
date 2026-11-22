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

"""Rooted task addresses: ``address.parse_target`` and ``TaskServer.resolve_target`` (plan 2.2, 2.5, 3.2; C.32).

The target grammar ``[<root>/]developerId.pipelineId[.source][:<version>]``
reads its root through ``roots.parse_root``: every root a task address takes,
the refused and retired ones, and every bad version form. The resolver walks
the whole ladder for a bare address and exactly one rung for a rooted one,
never falling through; a scoped key's frozen team refuses every other team
root; the org rung walks the active org only (C.35), and a pinned version
is served by a control of its own beside the published one (C.36).
"""

from __future__ import annotations

import pytest

from ai.modules.task.address import (
    TEAM_OPTION_RETIRED,
    Address,
    Target,
    format_target,
    parse_target,
    refuse_team_option,
)
from ai.modules.task.task_control import RESOLVE_ATTACH, RESOLVE_READ, RESOLVE_START
from ai.modules.task.types import TaskError

from . import test_task_engine_sharing as sharing
from .test_security_matrix_identity import _account, _control, _server
from .test_task_engine_sharing import ADDRESS, _caller, _pipeline, _resolve

# The runtime-model fixtures, shared with the engine-sharing tests
catalog = sharing.catalog
deployments = sharing.deployments
engines = sharing.engines
serving = sharing.serving

CONTROL = '1234abcd' * 4
DOTTED = Address('acme', 'docBrain', 'parsePDF')

# =============================================================================
# THE GRAMMAR
# =============================================================================


@pytest.mark.parametrize(
    ('text', 'expected'),
    [
        ('acme.docBrain.parsePDF', Target('none', '', False, DOTTED, None)),
        ('acme.docBrain', Target('none', '', False, Address('acme', 'docBrain', None), None)),
        ('@spec/acme.docBrain.parsePDF', Target('spec', '', False, DOTTED, None)),
        ('@me/acme.docBrain.parsePDF', Target('me', '', False, DOTTED, None)),
        ('@ME/acme.docBrain.parsePDF', Target('me', '', False, DOTTED, None)),
        ('@Development/acme.docBrain.parsePDF', Target('team', 'Development', False, DOTTED, None)),
        ('=team/t1/acme.docBrain.parsePDF', Target('team', 't1', True, DOTTED, None)),
        ('=TEAM/t1/acme.docBrain.parsePDF', Target('team', 't1', True, DOTTED, None)),
        ('@org/acme.docBrain.parsePDF', Target('org', '', False, DOTTED, None)),
        ('=org/o1/acme.docBrain.parsePDF', Target('org', 'o1', True, DOTTED, None)),
        ('@public/acme.docBrain.parsePDF', Target('public', '', False, DOTTED, None)),
        (f'=control/{CONTROL}', Target('control', CONTROL, True, None, None)),
        ('acme.docBrain.parsePDF:12', Target('none', '', False, DOTTED, 12)),
        ('@Development/acme.docBrain.parsePDF:3', Target('team', 'Development', False, DOTTED, 3)),
        # Normalization runs first: one location, one decision
        ('\\=team\\t1\\acme.docBrain.parsePDF', Target('team', 't1', True, DOTTED, None)),
        ('/=team/t1/acme.docBrain.parsePDF', Target('team', 't1', True, DOTTED, None)),
        ('=team//t1/acme.docBrain.parsePDF', Target('team', 't1', True, DOTTED, None)),
    ],
)
def test_every_root_a_task_address_takes_parses(text, expected):
    assert parse_target(text) == expected


@pytest.mark.parametrize(
    ('text', 'message'),
    [
        ('=user/u1/acme.docBrain.parsePDF', 'not a task root'),
        ('@me', 'names no address'),
        ('=team/t1', 'names no address'),
        ('@me/acme.docBrain/parsePDF', 'one dotted address follows the root'),
        ('@me/acme', 'not developerId.pipelineId'),
        ('acme.docBrain.parsePDF.extra', 'not developerId.pipelineId'),
        (f'=control/{CONTROL}/acme.docBrain', 'nothing may follow'),
        ('=control/abc', '32 lowercase hex'),
        ('=bogus/x/acme.docBrain', 'Unknown id root'),
        ('@/Team/Dev/acme.docBrain', "'@' needs a root"),
        ('@me/@x/acme.docBrain', 'reserved for roots'),
        ('', 'required'),
    ],
)
def test_every_refused_root_and_form_is_invalid_argument(text, message):
    with pytest.raises(TaskError) as excinfo:
        parse_target(text)
    assert excinfo.value.code == TaskError.INVALID_ARGUMENT and excinfo.value.field == 'token'
    assert message in str(excinfo.value)


@pytest.mark.parametrize(
    ('text', 'message'),
    [
        ('@team/Development/acme.docBrain', '@team/ is retired: write @<team>/<address> or =team/<tid>/<address>'),
        ('@TEAM/t1/acme.docBrain', '@team/ is retired'),
        ('@user/acme.docBrain', '@user is retired: write @me/<address>'),
    ],
)
def test_the_retired_spellings_name_their_replacement(text, message):
    with pytest.raises(TaskError) as excinfo:
        parse_target(text)
    assert excinfo.value.code == TaskError.INVALID_ARGUMENT and message in str(excinfo.value)


@pytest.mark.parametrize('bad', [':', ':0', ':01', ':-1', ':+2', ':v2', ':1.5', ':1:2', ': 1', ':1 '])
def test_every_bad_version_form_is_refused_on_the_version_field(bad):
    with pytest.raises(TaskError) as excinfo:
        parse_target(f'@me/acme.docBrain{bad}')
    assert (excinfo.value.code, excinfo.value.field) == (TaskError.INVALID_ARGUMENT, 'version')


@pytest.mark.parametrize(
    'text',
    [
        'acme.docBrain.parsePDF',
        '@me/acme.docBrain',
        '@Development/acme.docBrain.parsePDF:7',
        '=team/t1/acme.docBrain',
        '=org/o1/acme.docBrain',
        '@public/acme.docBrain:2',
        f'=control/{CONTROL}',
    ],
)
def test_format_target_writes_back_what_parse_target_read(text):
    assert format_target(parse_target(text)) == text


def test_a_root_word_is_written_in_lowercase_and_a_name_as_given():
    assert format_target(parse_target('@ME/acme.docBrain')) == '@me/acme.docBrain'
    assert format_target(parse_target('=TEAM/t1/acme.docBrain')) == '=team/t1/acme.docBrain'
    assert parse_target('@development/acme.docBrain').root_text == '@development'


def test_with_source_replaces_the_third_segment_and_keeps_the_root():
    target = parse_target('@Development/acme.docBrain:3').with_source('webhook_1')
    assert format_target(target) == '@Development/acme.docBrain.webhook_1:3'
    assert parse_target('acme.docBrain.chat').with_source('') == parse_target('acme.docBrain.chat')
    with pytest.raises(TaskError):
        parse_target('acme.docBrain').with_source('bad.source')
    with pytest.raises(TaskError):
        parse_target(f'=control/{CONTROL}').with_source('chat')


def test_the_retired_team_option_is_refused_by_name():
    refuse_team_option({'name': ADDRESS})
    refuse_team_option({'name': ADDRESS, 'team': None})
    refuse_team_option({'name': ADDRESS, 'team': ''})
    with pytest.raises(TaskError) as excinfo:
        refuse_team_option({'name': ADDRESS, 'team': 'team-1'})
    assert (excinfo.value.field, str(excinfo.value)) == ('team', TEAM_OPTION_RETIRED)


# =============================================================================
# ONE RUNG PER ROOT
# =============================================================================


async def _attach(ts, target, account, require='task.monitor'):
    """The control ``resolve_target`` attaches to: registered controls only."""
    return (await ts.resolve_target(account, target, require, mode=RESOLVE_ATTACH)).control


async def test_each_root_walks_only_its_rung_and_never_falls_through():
    """Every rung has a live control; each root answers with its own and nothing else."""
    ts = _server()
    spec = _control(ts, run_kind='dev')
    me = _control(ts, run_kind='deploy', owner_kind='user')
    team = _control(ts, run_kind='deploy', owner_kind='team', team_id='team-1')
    caller = _account()
    address = spec.address

    assert await _attach(ts, address, caller) is spec
    assert await _attach(ts, f'@spec/{address}', caller) is spec
    assert await _attach(ts, f'@me/{address}', caller) is me
    assert await _attach(ts, f'=team/team-1/{address}', caller) is team
    assert await _attach(ts, f'@dev/{address}', caller) is team
    with pytest.raises(TaskError) as excinfo:
        await _attach(ts, f'@public/{address}', caller)
    assert excinfo.value.code == TaskError.NOT_REGISTERED and excinfo.value.rungsTried == ['@public']


async def test_a_rooted_miss_names_the_one_rung_as_written():
    ts = _server()
    _control(ts, run_kind='dev')
    with pytest.raises(TaskError) as excinfo:
        await _attach(ts, '@Dev/acme.docBrain.parsePDF', _account())
    assert excinfo.value.rungsTried == ['@Dev'] and '@Dev' in str(excinfo.value)
    with pytest.raises(TaskError) as excinfo:
        await _attach(ts, '@me/acme.docBrain.parsePDF', _account())
    assert excinfo.value.rungsTried == ['@me']


async def test_a_team_root_needs_membership():
    ts = _server()
    _control(ts, run_kind='deploy', owner_kind='team', team_id='team-2')
    with pytest.raises(PermissionError, match='not a member'):
        await _attach(ts, '=team/team-2/acme.docBrain.parsePDF', _account())
    with pytest.raises(PermissionError, match='not a member'):
        await _attach(ts, '@Production/acme.docBrain.parsePDF', _account())


async def test_a_scoped_keys_frozen_team_refuses_any_other_team_root():
    """A key with an endpoints scope resolves through its frozen team only, by id or by name."""
    ts = _server()
    own = _control(ts, run_kind='deploy', owner_kind='team', team_id='team-1')
    _control(ts, run_kind='deploy', owner_kind='team', team_id='team-2')
    scoped = _account(endpoints=[own.address])

    assert await _attach(ts, f'=team/team-1/{own.address}', scoped, 'task.data') is own
    assert await _attach(ts, f'@Dev/{own.address}', scoped, 'task.data') is own
    with pytest.raises(PermissionError, match='frozen to its own team'):
        await _attach(ts, f'=team/team-2/{own.address}', scoped, 'task.data')
    with pytest.raises(PermissionError, match='frozen to its own team'):
        await _attach(ts, f'@Production/{own.address}', scoped, 'task.data')


async def test_a_scoped_key_never_reaches_spec_even_by_root():
    ts = _server()
    dev = _control(ts, run_kind='dev')
    with pytest.raises(TaskError) as excinfo:
        await _attach(ts, f'@spec/{dev.address}', _account(endpoints=[dev.address]), 'task.data')
    assert excinfo.value.code == TaskError.NOT_REGISTERED and excinfo.value.rungsTried == ['@spec']


async def test_org_roots_walk_the_org_rung_of_the_active_org_only():
    """``@org/`` and the active org's ``=org/<oid>/`` walk the org rung alone (C.35); another org is refused."""
    ts = _server()
    org = _control(ts, run_kind='deploy', owner_kind='org', team_id='')
    assert org.index_key == f'org.org-1.user-a.{org.address}'
    for root in ('@org', '@ORG', '=org/org-1'):
        assert await _attach(ts, f'{root}/{org.address}', _account(), 'task.data') is org
    with pytest.raises(TaskError) as excinfo:
        await _attach(ts, '@org/acme.docBrain.other', _account(), 'task.data')
    assert excinfo.value.code == TaskError.NOT_REGISTERED and excinfo.value.rungsTried == ['@org']
    with pytest.raises(PermissionError, match='active org'):
        await _attach(ts, '=org/org-9/acme.docBrain.parsePDF', _account())


async def test_a_user_root_names_nobody_elses_control():
    ts = _server()
    _control(ts, run_kind='deploy', owner_kind='user', user_id='user-b')
    with pytest.raises(TaskError) as excinfo:
        await _attach(ts, '=user/user-b/acme.docBrain.parsePDF', _account())
    assert excinfo.value.code == TaskError.INVALID_ARGUMENT


async def test_a_control_id_goes_through_the_same_entry_and_is_re_checked():
    ts = _server()
    mine = _control(ts, run_kind='dev')
    assert await _attach(ts, mine.control_id, _account()) is mine
    with pytest.raises(PermissionError, match='not your control'):
        await _attach(ts, mine.control_id, _account(user_id='user-b'))


async def test_an_unknown_mode_is_a_programming_error():
    with pytest.raises(ValueError, match='Unknown resolution mode'):
        await _server().resolve_target(_account(), 'acme.docBrain.parsePDF', 'task.data', mode='guess')


# =============================================================================
# VERSIONS: pinned on the rung the target picks (C.36)
# =============================================================================


def _team_reader(perms):
    """A member of team-1 holding ``perms`` there."""
    account = _caller(teams=('team-1',))
    account.organization['teams'][0]['permissions'] = list(perms)
    return account


async def test_a_version_on_spec_is_refused(catalog, engines, deployments):
    with pytest.raises(TaskError) as excinfo:
        await _resolve(_server(), f'@spec/{ADDRESS}:1', _caller(), 'task.data')
    assert excinfo.value.field == 'version' and 'no version' in str(excinfo.value)


def _rail(deployments, version, state='ready'):
    """Put ``version`` of acme.docBrain on the registry rail in ``state``, with its artifact."""
    deployments.states[('org-1', 'acme.docBrain', version)] = state
    deployments.artifacts[('org-1', 'acme.docBrain', version)] = _pipeline(instructions=[f'v{version}'])


async def test_the_published_version_is_an_ordinary_call(catalog, engines, deployments):
    """Plan 3.2: the rung's published version is the rung's own control, unpinned."""
    deployments.deploy('=team/team-1', version=2)
    ts = _server()
    published = await _resolve(ts, ADDRESS, _team_reader(['task.data']), 'task.data')
    for target in (f'{ADDRESS}:2', f'=team/team-1/{ADDRESS}:2', f'@Team-1/{ADDRESS}:2'):
        assert await _resolve(ts, target, _team_reader(['task.data']), 'task.data') is published, target
    assert (published.version, published.pinned, published.index_key) == (2, False, f'team.team-1.user-a.{ADDRESS}')


async def test_another_version_needs_task_control_on_the_team(catalog, engines, deployments):
    """C.36: a pinned version is a control of its own beside the published one, under the rung's deployment."""
    deployments.deploy('=team/team-1', version=2)
    _rail(deployments, 1, 'private')
    ts = _server()
    with pytest.raises(PermissionError, match='task.control'):
        await _resolve(ts, f'{ADDRESS}:1', _team_reader(['task.data']), 'task.data')
    controller = _team_reader(['task.data', 'task.control'])
    pinned = await _resolve(ts, f'{ADDRESS}:1', controller, 'task.data')
    assert (pinned.version, pinned.pinned, pinned.rung) == (1, True, 'team')
    assert pinned.index_key == f'team.team-1.user-a.{ADDRESS}:1'
    assert pinned.deployment.team_id == '=team/team-1' and pinned.pipeline['components'][1]['config'] == {
        'instructions': ['v1']
    }
    # The rung table's attribution, as the published control's
    assert (pinned.owner_id, pinned.userId, pinned.teamId, pinned.env_team) == ('team-1', 'user-a', 'team-1', 'team-1')

    # It coexists with the published-version control and attaches on the next call
    published = await _resolve(ts, ADDRESS, controller, 'task.data')
    assert published is not pinned and not published.pinned and published.version == 2
    assert await _resolve(ts, f'{ADDRESS}:1', controller, 'task.data') is pinned
    assert await _attach(ts, f'{ADDRESS}:1', controller, 'task.data') is pinned
    assert await _attach(ts, ADDRESS, controller, 'task.data') is published

    with pytest.raises(TaskError) as excinfo:
        await _resolve(ts, f'{ADDRESS}:9', controller, 'task.data')
    assert excinfo.value.code == TaskError.NOT_REGISTERED and 'no version 9' in str(excinfo.value)


async def test_the_store_serves_only_ready_versions(catalog, engines, deployments):
    deployments.publish(version=2)
    _rail(deployments, 1, 'private')
    _rail(deployments, 3, 'ready')
    stranger = _caller('user-z', dev_team='team-z', teams=('team-z',), org='org-2', developer_id='globex')
    ts = _server()
    with pytest.raises(PermissionError, match='only ready versions'):
        await _resolve(ts, f'@public/{ADDRESS}:1', stranger, 'task.data')
    pinned = await _resolve(ts, f'@public/{ADDRESS}:3', stranger, 'task.data')
    assert pinned.index_key == f'public.user-z.{ADDRESS}:3' and pinned.pinned
    assert (pinned.owner_id, pinned.orgId, pinned.teamId) == ('user-z', 'org-2', '')


async def test_the_store_never_runs_a_version_that_declares_roots(catalog, engines, deployments):
    """Plan 2.5: a version selector reaches the store's ready versions, never one that declares roots."""
    deployments.publish(version=2)
    _rail(deployments, 3, 'ready')
    deployments.artifacts[('org-1', 'acme.docBrain', 3)]['roots'] = ['@Development/kb']
    stranger = _caller('user-z', dev_team='team-z', teams=('team-z',), org='org-2', developer_id='globex')
    ts = _server()
    with pytest.raises(PermissionError, match='declares roots'):
        await _resolve(ts, f'@public/{ADDRESS}:3', stranger, 'task.data')
    assert list(ts._task_control) == []


async def test_a_scoped_key_reads_a_pinned_version_only_on_its_endpoints(catalog, engines, deployments):
    """A read of a pinned version (the interface map) holds a scoped key to its endpoints, as a start does."""
    deployments.deploy('=team/team-1', version=2)
    _rail(deployments, 1, 'private')
    controller = _team_reader(['task.data', 'task.control'])
    controller.endpoints = ['acme.other.webhook_1']
    ts = _server()
    with pytest.raises(PermissionError):
        await ts.resolve_target(controller, f'{ADDRESS}:1', 'task.data', mode=RESOLVE_READ)
    controller.endpoints = [ADDRESS]
    resolution = await ts.resolve_target(controller, f'{ADDRESS}:1', 'task.data', mode=RESOLVE_READ)
    assert resolution.pin.version == 1 and resolution.artifact is not None


async def test_a_version_on_a_bare_address_is_pinned_on_the_rung_the_ladder_picks(catalog, engines, deployments):
    """Plan 3.2: the ladder picks the rung (skipping @spec) and pins the version there; a refusal there is final."""
    deployments.deploy('=user/user-a', version=2, billing='team-1')
    _rail(deployments, 1, 'private')
    ts = _server()
    played = await sharing._start(ts, _pipeline(), user='user-a')
    pinned = await _resolve(ts, f'{ADDRESS}:1', _caller(), 'task.data')
    assert pinned is not played and pinned.index_key == f'me.user-a.{ADDRESS}:1'
    assert (pinned.teamId, pinned.env_team) == ('team-1', 'team-1')

    # Team-1 serves v2 and the store serves v1 ready: a member without
    # task.control on team-1 is refused there, never sent on to the store
    other = _server()
    deployments.deployments.clear()
    deployments.deploy('=team/team-1', version=2)
    deployments.publish(version=1)
    with pytest.raises(PermissionError, match='task.control'):
        await _resolve(other, f'{ADDRESS}:1', _team_reader(['task.data']), 'task.data')
    assert list(other._task_control) == []


async def test_a_pinned_version_on_the_org_rung_needs_an_org_admin(catalog, engines, deployments):
    deployments.deploy('=org/org-1', version=2)
    _rail(deployments, 1, 'private')
    ts = _server()
    member = _caller(teams=('team-1',))
    assert (await _resolve(ts, f'@org/{ADDRESS}:2', member, 'task.data')).rung == 'org'
    with pytest.raises(PermissionError, match='task.control'):
        await _resolve(ts, f'@org/{ADDRESS}:1', member, 'task.data')
    admin = _caller(teams=('team-1',))
    admin.organization['permissions'] = ['org.admin']
    pinned = await _resolve(ts, f'@org/{ADDRESS}:1', admin, 'task.data')
    assert pinned.index_key == f'org.org-1.user-a.{ADDRESS}:1' and pinned.owner_kind == 'org'


async def test_a_version_on_a_rung_with_nothing_published_is_not_registered(catalog, engines, deployments):
    deployments.deploy('=team/team-1', version=2)
    with pytest.raises(TaskError) as excinfo:
        await _resolve(_server(), f'@me/{ADDRESS}:2', _caller(), 'task.data')
    assert excinfo.value.code == TaskError.NOT_REGISTERED and excinfo.value.rungsTried == ['@me']


# =============================================================================
# READ: the decision without acting
# =============================================================================


async def test_read_answers_the_publication_and_starts_nothing(catalog, engines, deployments):
    deployments.deploy('=team/team-1', version=2, pipeline=_pipeline(name='Version two'))
    ts = _server()
    resolution = await ts.resolve_target(_caller(), f'@Team-1/{ADDRESS}', 'task.data', mode=RESOLVE_READ)
    assert resolution.control is None and resolution.pin.rung == 'team' and resolution.pin.version == 2
    assert resolution.target == parse_target(f'@Team-1/{ADDRESS}')
    # The pinned version's artifact, read server-side, rides the answer
    assert resolution.artifact['name'] == 'Version two'
    assert list(ts._task_control) == []


def _without(source):
    """The webhook -> prompt artifact without component ``source``."""
    pipeline = _pipeline()
    pipeline['components'] = [c for c in pipeline['components'] if c['id'] != source]
    return pipeline


async def test_a_pinned_version_read_carries_its_artifact_and_takes_the_start_decision(catalog, engines, deployments):
    """A read of a pinned version answers with that version's artifact (the interfaces verb reads it), and a
    version without the named source is not served on read as on start.
    """
    deployments.deploy('=team/team-1', version=2)
    _rail(deployments, 1, 'private')
    ts = _server()
    controller = _team_reader(['task.data', 'task.control'])
    resolution = await ts.resolve_target(controller, f'{ADDRESS}:1', 'task.data', mode=RESOLVE_READ)
    assert resolution.control is None and resolution.pin.version == 1
    assert resolution.artifact['components'][1]['config'] == {'instructions': ['v1']}
    assert list(ts._task_control) == []

    deployments.artifacts[('org-1', 'acme.docBrain', 1)] = _without('prompt_1')
    for mode in (RESOLVE_READ, RESOLVE_START):
        with pytest.raises(TaskError) as excinfo:
            await ts.resolve_target(controller, 'acme.docBrain.prompt_1:1', 'task.data', mode=mode)
        assert excinfo.value.code == TaskError.NOT_REGISTERED, mode


async def test_a_publication_without_the_named_source_yields_on_read_as_on_start(catalog, engines, deployments):
    """The personal publication ranks first but lacks ``prompt_1``: the read and the start both pass it for the
    team's, so the interface map describes the pipeline submit() runs (plan 3.6).
    """
    deployments.deploy('=user/user-a', version=1, pipeline=_without('prompt_1'))
    deployments.deploy('=team/team-1', version=2)
    ts = _server()
    target = 'acme.docBrain.prompt_1'

    resolution = await ts.resolve_target(_caller(), target, 'task.data', mode=RESOLVE_READ)
    assert resolution.control is None and (resolution.pin.rung, resolution.pin.version) == ('team', 2)
    assert list(ts._task_control) == []

    control = await _resolve(ts, target, _caller(), 'task.data')
    assert (control.rung, control.version, control.address) == ('team', 2, target)

    # The personal one still answers a source it has
    resolution = await ts.resolve_target(_caller(), ADDRESS, 'task.data', mode=RESOLVE_READ)
    assert (resolution.pin.rung, resolution.pin.version) == ('me', 1)


async def test_a_source_no_publication_has_is_not_registered_on_read_as_on_start(catalog, engines, deployments):
    deployments.deploy('=user/user-a', pipeline=_without('prompt_1'))
    ts = _server()
    for mode in (RESOLVE_READ, RESOLVE_START):
        with pytest.raises(TaskError) as excinfo:
            await ts.resolve_target(_caller(), 'acme.docBrain.prompt_1', 'task.data', mode=mode)
        assert excinfo.value.code == TaskError.NOT_REGISTERED, mode
    assert list(ts._task_control) == []


# =============================================================================
# AN AMBIGUOUS RUNG IS HELD AT ITS PLACE IN THE LADDER
# =============================================================================


def _two_live_team_sources(ts):
    """The caller's two live team-1 controls of acme.docBrain, one per source: a two-segment address is ambiguous there."""
    for source in ('webhook_1', 'prompt_1'):
        _control(ts, run_kind='deploy', owner_kind='team', team_id='team-1', source=source)


async def test_an_ambiguous_team_rung_that_answers_first_needs_a_source(catalog, engines, deployments):
    """Nothing ranks before the team rung (a later @public publication does not count): the refusal stands."""
    deployments.publish()
    ts = _server()
    _two_live_team_sources(ts)
    for mode in (RESOLVE_READ, RESOLVE_START):
        with pytest.raises(TaskError) as excinfo:
            await ts.resolve_target(_caller(), 'acme.docBrain', 'task.data', mode=mode)
        assert excinfo.value.code == TaskError.SOURCE_REQUIRED, mode
        assert excinfo.value.sources == ['prompt_1', 'webhook_1']


async def test_a_version_call_passes_over_another_versions_live_sources(catalog, engines, deployments):
    """A source-less ``:2`` on the rung's published version: version 1's two live sources are passed over before
    a source is chosen, and never answer it. While version 1 still runs under the address the start is refused,
    naming it (a promotion does not repoint, plan 7.2); once it is gone version 2 starts.
    """
    deployments.deploy('=team/team-1', version=2)
    ts = _server()
    old = [
        _control(ts, run_kind='deploy', owner_kind='team', team_id='team-1', source=s)
        for s in ('webhook_1', 'prompt_1')
    ]
    for control in old:
        control.version = 1
    reader = _team_reader(['task.data'])

    resolution = await ts.resolve_target(reader, 'acme.docBrain:2', 'task.data', mode=RESOLVE_READ)
    assert resolution.control is None and resolution.pin.version == 2

    with pytest.raises(TaskError) as excinfo:
        await _resolve(ts, 'acme.docBrain:2', reader, 'task.data')
    assert excinfo.value.code == TaskError.ENGINE_UNAVAILABLE and excinfo.value.reason == 'superseded'
    assert str(excinfo.value).startswith(f'Version 1 of {ADDRESS!r} still runs on the team rung')

    # Without a version the rung's two live sources stand
    with pytest.raises(TaskError) as excinfo:
        await ts.resolve_target(reader, '=team/team-1/acme.docBrain', 'task.data', mode=RESOLVE_READ)
    assert excinfo.value.code == TaskError.SOURCE_REQUIRED

    for control in old:
        ts._unregister_control(control)
    control = await _resolve(ts, 'acme.docBrain:2', reader, 'task.data')
    assert (control.version, control.pinned, control.address) == (2, False, ADDRESS)


async def test_an_ambiguous_later_rung_never_blocks_an_earlier_publication(catalog, engines, deployments):
    """A personal publication ranks before the team rung: it answers the read and the start, the team's two
    live sources notwithstanding (plan 3.2: the ladder's order, a pin before a control of a later rung).
    """
    deployments.deploy('=user/user-a')
    ts = _server()
    _two_live_team_sources(ts)

    resolution = await ts.resolve_target(_caller(), 'acme.docBrain', 'task.data', mode=RESOLVE_READ)
    assert resolution.control is None and resolution.pin.rung == 'me'

    control = await _resolve(ts, 'acme.docBrain', _caller(), 'task.data')
    assert control.rung == 'me' and control.address == ADDRESS

    # A rooted address walks only its rung: the team root is still ambiguous
    with pytest.raises(TaskError) as excinfo:
        await ts.resolve_target(_caller(), '=team/team-1/acme.docBrain', 'task.data', mode=RESOLVE_READ)
    assert excinfo.value.code == TaskError.SOURCE_REQUIRED
