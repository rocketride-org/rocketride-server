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

"""Owner-scoped task identity: digest matrix + scoped lookup semantics.

A task is uniquely ``{owner}.{projectId}.{source}`` — the owner of a dev
run is its user, the owner of a deploy run is its team. These tests pin:

- the token DIGEST matrix (dev vs deploy owner fields, actor-independence
  of deploy digests, tk_ vs pk_ kind discriminator), which is what makes
  the "Pipeline is already running" collision guard scope correctly; and
- ``get_task_control_by_project``'s owner-scoped resolution (team scope,
  caller-dev scope, and the legacy unscoped fallback's refuse-to-guess).
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from ai.account.base import AccountBase
from ai.modules.task.task_server import TaskServer, TASK_CONTROL
from ai.modules.task.commands.cmd_monitor import owner_key


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _digest(*, kind: str, owner_field: str, owner_id: str, project_id='proj-1', source='src-1') -> str:
    """Build a token digest exactly the way start_task does.

    The owner rides under its FIELD NAME (userId for dev, teamId for
    deploy) — the field name itself disambiguates the id spaces.
    """
    return AccountBase.generate_token(
        None,
        content={
            'kind': kind,
            owner_field: owner_id,
            'project_id': project_id,
            'source': source,
        },
        prefix='',
    )


def _control(*, run_kind='dev', user_id='user-1', team_id='team-1', project_id='proj-1', source='src-1'):
    """Build a real TASK_CONTROL carrying the owner model."""
    control = TASK_CONTROL()
    control.run_kind = run_kind
    control.userId = user_id
    control.teamId = team_id
    control.project_id = project_id
    control.source = source
    control.token = f'tk_{run_kind}_{user_id}_{team_id}'
    return control


def _account(*, user_id='user-1', team_id='team-1', permissions=('task.monitor', 'task.data', 'task.control')):
    """AccountInfo stub with a single team membership."""
    return SimpleNamespace(
        userId=user_id,
        organization={
            'id': 'org-1',
            'permissions': [],
            'teams': [{'id': team_id, 'permissions': list(permissions)}],
        },
    )


def _server(*controls) -> TaskServer:
    """A TaskServer shell holding only the task-control registry."""
    server = TaskServer.__new__(TaskServer)
    server._task_control = {c.token: c for c in controls}
    return server


# ---------------------------------------------------------------------------
# Digest matrix — what may collide and what must not
# ---------------------------------------------------------------------------


def test_dev_digests_differ_across_users():
    """Two users' dev runs of the same pipeline never share a digest."""
    a = _digest(kind='task', owner_field='userId', owner_id='user-1')
    b = _digest(kind='task', owner_field='userId', owner_id='user-2')
    assert a != b


def test_deploy_digests_differ_across_teams():
    """Two teams' deploys of the same pipeline never share a digest."""
    a = _digest(kind='task', owner_field='teamId', owner_id='team-1')
    b = _digest(kind='task', owner_field='teamId', owner_id='team-2')
    assert a != b


def test_dev_and_deploy_digests_differ_even_for_colliding_ids():
    """The owner FIELD NAME disambiguates: identical id values in the user
    and team spaces still produce distinct digests.
    """
    dev = _digest(kind='task', owner_field='userId', owner_id='same-id')
    deploy = _digest(kind='task', owner_field='teamId', owner_id='same-id')
    assert dev != deploy


def test_same_owner_triple_collides_deterministically():
    """The SAME owner triple regenerates the SAME digest — this determinism
    is the 'already running' collision guard and the useExisting reconnect.
    """
    a = _digest(kind='task', owner_field='userId', owner_id='user-1')
    b = _digest(kind='task', owner_field='userId', owner_id='user-1')
    assert a == b


def test_me_deploy_digest_differs_from_dev_for_the_same_user():
    """A user-owned deploy (@me) shares the owner FIELD with the same user's
    dev run, so it alone adds run_kind to the digest — the same pipeline can
    run as dev AND as a personal deploy concurrently without colliding in the
    token registry.
    """
    dev = _digest(kind='task', owner_field='userId', owner_id='user-1')
    me_deploy = AccountBase.generate_token(
        None,
        content={
            'kind': 'task',
            'userId': 'user-1',
            'run_kind': 'deploy',
            'project_id': 'proj-1',
            'source': 'src-1',
        },
        prefix='',
    )
    assert dev != me_deploy


def test_dev_and_team_deploy_digests_are_unchanged_by_the_me_extension():
    """Dev and @team digests contain NO run_kind key — byte-identical to every
    token ever minted, so persisted pk_ share links keep resolving.
    """
    # These reproduce the exact historical content shapes.
    dev = _digest(kind='public', owner_field='userId', owner_id='user-1')
    team = _digest(kind='public', owner_field='teamId', owner_id='team-1')
    assert dev == _digest(kind='public', owner_field='userId', owner_id='user-1')
    assert team == _digest(kind='public', owner_field='teamId', owner_id='team-1')


def test_task_and_public_digests_differ():
    """tk_ and pk_ must differ in DIGEST, not just prefix — the 'kind'
    discriminator inside the hashed content guarantees it.
    """
    task = _digest(kind='task', owner_field='userId', owner_id='user-1')
    public = _digest(kind='public', owner_field='userId', owner_id='user-1')
    assert task != public


# ---------------------------------------------------------------------------
# TASK_CONTROL.owner_id — the single owner derivation
# ---------------------------------------------------------------------------


def test_owner_id_is_user_for_dev_and_team_for_deploy():
    """Monitor keys and lookups scope by this owner, never by attribution."""
    assert _control(run_kind='dev').owner_id == 'user-1'
    assert _control(run_kind='deploy').owner_id == 'team-1'


def test_owner_kind_overrides_the_run_kind_default():
    """owner_kind is the authority when stamped: a user-owned deploy (@me)
    resolves to its USER even though run_kind is 'deploy' — the billing
    teamId never becomes the visibility owner of a personal run.
    """
    me_deploy = _control(run_kind='deploy')
    me_deploy.owner_kind = 'user'
    assert me_deploy.owner_id == 'user-1'


def test_owner_key_grammar():
    """The monitor key is p.{runKind}.{owner}.{project}.{source} — the runKind
    segment separates a user's dev run from that SAME user's @me deploy of the
    same pipeline (both user-owned, so owner alone would alias them).
    """
    assert owner_key('dev', 'user-1', 'proj-1', 'src-1') == 'p.dev.user-1.proj-1.src-1'
    assert owner_key('deploy', 'team-1', 'proj-1', 'src-1') == 'p.deploy.team-1.proj-1.src-1'
    # The @me case: same owner as dev, distinct key via the segment.
    assert owner_key('deploy', 'user-1', 'proj-1', 'src-1') == 'p.deploy.user-1.proj-1.src-1'
    assert owner_key('deploy', 'user-1', 'proj-1', 'src-1') != owner_key('dev', 'user-1', 'proj-1', 'src-1')


# ---------------------------------------------------------------------------
# get_task_control_by_project — owner-scoped resolution
# ---------------------------------------------------------------------------


def test_team_scope_resolves_only_the_team_deploy_run():
    """team_id addresses the team's deploy run, never a dev run of the pair."""
    dev = _control(run_kind='dev')
    deploy = _control(run_kind='deploy')
    server = _server(dev, deploy)
    found = TaskServer.get_task_control_by_project(
        server, 'proj-1', 'src-1', _account(), require='task.monitor', team_id='team-1'
    )
    assert found is deploy


def test_dev_scope_resolves_only_the_callers_run():
    """Without team_id the caller's OWN dev run resolves — not a teammate's."""
    mine = _control(run_kind='dev', user_id='user-1')
    theirs = _control(run_kind='dev', user_id='user-2')
    server = _server(theirs, mine)
    found = TaskServer.get_task_control_by_project(server, 'proj-1', 'src-1', _account(user_id='user-1'))
    assert found is mine


def test_dev_scope_does_not_resolve_the_deploy_run():
    """A dev-scoped lookup never lands on the deploy run of the same pair."""
    deploy = _control(run_kind='deploy')
    server = _server(deploy)
    with pytest.raises(RuntimeError, match='not running'):
        TaskServer.get_task_control_by_project(server, 'proj-1', 'src-1', _account())


def test_team_scope_requires_an_identity():
    """A team scope without account_info is never legitimate."""
    server = _server(_control(run_kind='deploy'))
    with pytest.raises(PermissionError, match='Not authenticated'):
        TaskServer.get_task_control_by_project(server, 'proj-1', 'src-1', None, team_id='team-1')


def test_legacy_unscoped_scan_returns_a_unique_match():
    """Without identity (OSS/HTTP fallback) a single match still resolves."""
    only = _control(run_kind='dev')
    server = _server(only)
    assert TaskServer.get_task_control_by_project(server, 'proj-1', 'src-1', None) is only


def test_legacy_unscoped_scan_refuses_to_guess_between_runs():
    """With several matching runs the legacy scan errors instead of silently
    returning an arbitrary one (the old first-match bug).
    """
    server = _server(_control(run_kind='dev'), _control(run_kind='deploy'))
    with pytest.raises(RuntimeError, match='specify a scope'):
        TaskServer.get_task_control_by_project(server, 'proj-1', 'src-1', None)


# ---------------------------------------------------------------------------
# Owner-match access (B3/B4) — a user-owned run follows its owner's identity,
# so it survives an org switch (its team becomes foreign) yet stays reachable.
# ---------------------------------------------------------------------------


def test_owner_reaches_own_dev_run_when_its_team_is_foreign():
    """After an org switch the caller's active team differs from the run's team,
    but the owner still resolves their own dev run by identity — no permission
    on the (now foreign) run team is required.
    """
    mine = _control(run_kind='dev', user_id='user-1', team_id='old-team')
    server = _server(mine)
    # Caller is now in a different team and holds NO grant on 'old-team'.
    caller = _account(user_id='user-1', team_id='new-team')
    found = TaskServer.get_task_control_by_project(server, 'proj-1', 'src-1', caller, require='task.control')
    assert found is mine


def test_owner_match_does_not_apply_to_a_team_deploy_run():
    """A team deploy run (owner_id == teamId) never matches the caller's userId,
    so a non-member is still denied — the owner short-circuit is user-only.
    """
    deploy = _control(run_kind='deploy', team_id='team-x')
    server = _server(deploy)
    caller = _account(user_id='user-1', team_id='team-y')  # not a member of team-x
    with pytest.raises(PermissionError):
        TaskServer.get_task_control_by_project(
            server, 'proj-1', 'src-1', caller, require='task.monitor', team_id='team-x'
        )
