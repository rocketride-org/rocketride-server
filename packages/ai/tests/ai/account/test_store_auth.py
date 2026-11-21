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

"""Authorization matrix for the storage roots (FileStore + RequestContext).

The store is the security boundary: these tests drive REAL FileStore
operations over a real filesystem backend and assert what each identity may
resolve — the flat roots of plan 2.5 (``@me/``, ``@<team>/``, ``@org/``,
``=team/<tid>/``, ``=org/<oid>/``, ``=user/<uid>/``; names and ids), the
retired ``@/User``, ``@/Team`` and ``@/Org`` spellings refused, the
system-tree rule (.logs / .deployments: internal|sys.admin only), the identity
kinds (session / internal / engine), sys.admin and org.admin expansion,
uniform denial (no existence leak), the normalization-bypass fuzz family, and
cross-user write-lock exclusion on shared team paths.
"""

import shutil
import tempfile
from types import SimpleNamespace

import pytest

from ai.account import file_store
from ai.account.file_store import parse_scope
from ai.account.models import RequestContext
from ai.account.roots import Root
from ai.account.store import Store, StorageError
from ai.account.store_providers.filesystem import FilesystemStore


# One signing key for the env var, the encode, and the decode. Three copies
# of the literal could drift, and a mismatched decode key fails as an opaque
# 401 instead of a clear error.
_SIGNING_KEY = 'test-signing-key-of-32-bytes-min!'

# The retired store spellings (plan 11.1 B42): refused for every identity.
_RETIRED = (
    '@/User',
    '@/User/x.txt',
    '@/User/=user-1/x',
    '@/Team/Development/x',
    '@/Team/=team-1/x',
    '@/Org',
    '@/Org/x',
    '@/Org/=org-1/x',
)


# ============================================================================
# Fixtures + account stubs
# ============================================================================


@pytest.fixture
def store():
    """Store over a throwaway filesystem backend."""
    temp_path = tempfile.mkdtemp()
    yield Store(FilesystemStore(f'filesystem://{temp_path}'))
    shutil.rmtree(temp_path, ignore_errors=True)


def _account(
    *,
    user_id='user-1',
    team_perms=('task.store', 'task.monitor', 'task.control'),
    team_id='team-1',
    team_name='Development',
    org_perms=(),
    sys_perms=(),
    dev_team='team-1',
    extra_teams=(),
):
    """AccountInfo-shaped stub with one org and one primary team."""
    teams = [{'id': team_id, 'name': team_name, 'permissions': list(team_perms)}]
    teams.extend(extra_teams)
    return SimpleNamespace(
        userId=user_id,
        auth='ak_x',
        userToken='tk',
        devTeam=dev_team,
        organization={'id': 'org-1', 'name': 'Acme', 'permissions': list(org_perms), 'teams': teams},
        sysPermissions=list(sys_perms),
    )


def _ctx(account) -> RequestContext:
    """An ordinary session context, as a handler would carry it."""
    return RequestContext(account_info=account, conn_id='conn-1', source='local')


def _fs(store, account):
    """Session-bound FileStore for the stubbed account (namespace derived)."""
    return store._file_store(_ctx(account))


# ============================================================================
# Root parsing (the store's view of the one grammar)
# ============================================================================


class TestParseScope:
    """parse_scope reads a normalized path through roots.parse_root and
    refuses the roots that are no storage places.
    """

    def test_plain_path_is_the_own_tree(self):
        assert parse_scope('a/b/c.txt') == Root('none', '', False, 'a/b/c.txt')
        assert parse_scope('') == Root('none', '', False, '')

    def test_me_and_org_take_no_reference(self):
        assert parse_scope('@me') == Root('me', '', False, '')
        assert parse_scope('@me/My Files/a.txt') == Root('me', '', False, 'My Files/a.txt')
        assert parse_scope('@org/policies/hr.md') == Root('org', '', False, 'policies/hr.md')

    def test_a_team_by_name(self):
        assert parse_scope('@Development/reports/q3.md') == Root('team', 'Development', False, 'reports/q3.md')

    def test_id_roots(self):
        assert parse_scope('=team/t1/x') == Root('team', 't1', True, 'x')
        assert parse_scope('=org/o1/x') == Root('org', 'o1', True, 'x')
        assert parse_scope('=user/u1/.logs/x') == Root('user', 'u1', True, '.logs/x')

    def test_root_words_ignore_case_and_ids_do_not(self):
        assert parse_scope('@ME/x') == Root('me', '', False, 'x')
        assert parse_scope('@Org/x') == Root('org', '', False, 'x')
        assert parse_scope('=TEAM/T1/x') == Root('team', 'T1', True, 'x')

    def test_roots_that_are_no_storage_place_are_refused(self):
        for spelling in ('@spec/x', '@public/x', '=control/' + '1234abcd' * 4):
            with pytest.raises(ValueError, match='not a storage place'):
                parse_scope(spelling)

    def test_bare_at_and_unknown_id_kinds_are_refused(self):
        # '@' itself is a virtual listing owned by cmd_store.
        for spelling in ('@', '=abc', '=foo/x', '=team', '@team/x', '@user/x'):
            with pytest.raises(ValueError):
                parse_scope(spelling)

    @pytest.mark.parametrize('spelling', _RETIRED)
    def test_retired_spellings_are_refused(self, spelling):
        with pytest.raises(ValueError):
            parse_scope(file_store.normalize_path(spelling))

    def test_first_entry_under_a_root_is_reserved(self):
        for spelling in ('@me/=x', '@me/@x', '=team/t1/=x', '@org/@x'):
            with pytest.raises(ValueError, match='reserved'):
                parse_scope(spelling)

    def test_nested_sigil_names_allowed(self):
        # Only the FIRST entry under a root is reserved.
        assert parse_scope('docs/=weird.txt') == Root('none', '', False, 'docs/=weird.txt')
        assert parse_scope('@me/docs/@x') == Root('me', '', False, 'docs/@x')


# ============================================================================
# Session identity — team roots
# ============================================================================


class TestSessionTeamScope:
    """A real session resolving @<team>/ and =team/<tid>/ paths."""

    @pytest.mark.asyncio
    async def test_team_by_id_resolves_and_writes(self, store):
        fs = _fs(store, _account())
        await fs.write('=team/team-1/docs/readme.md', b'shared')
        # Physical location is the TEAM area, ids on disk.
        assert fs._full_path('=team/team-1/docs/readme.md') == 'teams/team-1/files/docs/readme.md'

    @pytest.mark.asyncio
    async def test_team_by_display_name_resolves_to_id(self, store):
        fs = _fs(store, _account())
        await fs.write('@Development/docs/readme.md', b'shared')
        # Names on the wire, ids on disk — both spellings hit ONE location.
        assert (await fs.read('=team/team-1/docs/readme.md')) == b'shared'

    def test_team_names_match_ignoring_case(self, store):
        fs = _fs(store, _account())
        for spelling in ('@development/x', '@DEVELOPMENT/x', '@DeVeLoPmEnT/x'):
            assert fs._full_path(spelling) == 'teams/team-1/files/x'

    def test_team_ids_compare_exactly(self, store):
        fs = _fs(store, _account())
        with pytest.raises(PermissionError, match='Access denied for scoped path'):
            fs._full_path('=team/TEAM-1/x')

    @pytest.mark.asyncio
    async def test_two_members_share_one_location(self, store):
        member_a = store._file_store(_ctx(_account(user_id='user-a')))
        member_b = store._file_store(_ctx(_account(user_id='user-b')))
        await member_a.write('=team/team-1/tmp/x.txt', b'from A')
        assert (await member_b.read('@Development/tmp/x.txt')) == b'from A'

    def test_foreign_team_denied_uniformly(self, store):
        fs = _fs(store, _account())
        for spelling in ('=team/team-elsewhere/x.txt', '@Elsewhere/x.txt'):
            with pytest.raises(PermissionError, match='Access denied for scoped path'):
                fs._full_path(spelling)

    def test_member_without_task_store_denied_same_message(self, store):
        fs = _fs(store, _account(team_perms=['task.monitor']))
        for spelling in ('=team/team-1/x.txt', '@Development/x.txt'):
            with pytest.raises(PermissionError, match='Access denied for scoped path'):
                fs._full_path(spelling)

    def test_ambiguous_name_denied_same_message(self, store):
        # Two teams whose names differ only by case (data from before the
        # name_key rule): name addressing fails closed with the SAME message
        # as unknown/foreign (id addressing always works).
        account = _account(extra_teams=[{'id': 'team-2', 'name': 'development', 'permissions': ['task.store']}])
        fs = store._file_store(_ctx(account))
        with pytest.raises(PermissionError, match='Access denied for scoped path'):
            fs._full_path('@Development/x.txt')
        assert fs._full_path('=team/team-1/x.txt') == 'teams/team-1/files/x.txt'

    def test_names_and_ids_cannot_shadow(self, store):
        # '@x' is ONLY a name, '=team/x' is ONLY an id — a team NAMED like
        # another team's id resolves by name to its own id.
        account = _account(extra_teams=[{'id': 'team-x', 'name': 'team-1', 'permissions': ['task.store']}])
        fs = store._file_store(_ctx(account))
        assert fs._full_path('@team-1/f').startswith('teams/team-x/')
        assert fs._full_path('=team/team-1/f').startswith('teams/team-1/')

    def test_id_root_traversal_guard(self, store):
        # '..' never embeds into the physical path, and an id root needs its id.
        fs = _fs(store, _account(sys_perms=['sys.admin']))
        for evil in ('=team/../x', '=user/../x', '=org/..'):
            with pytest.raises(ValueError, match='traversal'):
                fs._full_path(evil)
        for evil in ('=team', '=org/', '=user'):
            with pytest.raises(ValueError, match='requires an id'):
                fs._full_path(evil)

    def test_no_org_session_denied(self, store):
        account = _account()
        account.organization = None
        fs = store._file_store(_ctx(account))
        for spelling in ('=team/team-1/x', '@Development/x'):
            with pytest.raises(PermissionError, match='Access denied for scoped path'):
                fs._full_path(spelling)

    def test_unauthenticated_context_denied(self, store):
        fs = store._file_store(RequestContext(account_info=None), client_id='user-1')
        with pytest.raises(PermissionError, match='Not authenticated'):
            fs._full_path('anything.txt')

    def test_sys_admin_bypasses_team_membership(self, store):
        fs = _fs(store, _account(team_perms=[], sys_perms=['sys.admin']))
        assert fs._full_path('=team/team-1/x') == 'teams/team-1/files/x'
        assert fs._full_path('@Development/x') == 'teams/team-1/files/x'

    def test_sys_admin_crosses_boundaries_by_id_only(self, store):
        # The support capability: foreign teams/orgs/users by id and ONLY by
        # id (names still resolve through the admin's own dictionary).
        fs = _fs(store, _account(sys_perms=['sys.admin']))
        assert fs._full_path('=team/foreign-team/x') == 'teams/foreign-team/files/x'
        assert fs._full_path('=org/foreign-org/x') == 'orgs/foreign-org/files/x'
        assert fs._full_path('=user/other-user/notes.txt') == 'users/other-user/files/notes.txt'
        with pytest.raises(PermissionError, match='Access denied for scoped path'):
            fs._full_path('@TheirTeamName/x')

    def test_sys_admin_full_access_to_foreign_system_trees(self, store):
        # sys.admin may do ANYTHING with system trees, anywhere.
        fs = _fs(store, _account(sys_perms=['sys.admin']))
        assert fs._full_path('=user/other-user/.logs/p1/x.jsonl')
        assert fs._full_path('=user/other-user/.deployments/p1.json')

    def test_ordinary_session_cannot_use_a_user_root(self, store):
        fs = _fs(store, _account())
        for spelling in ('=user/user-1/x', '=user/other/x'):
            with pytest.raises(PermissionError, match='Access denied for scoped path'):
                fs._full_path(spelling)  # not even for yourself


# ============================================================================
# Session identity — org roots
# ============================================================================


class TestSessionOrgScope:
    """@org/ is the caller's ONE active org; =org/<oid>/ names it by id — org.admin only."""

    def test_org_admin_resolves_by_word_and_by_id(self, store):
        fs = _fs(store, _account(org_perms=['org.admin']))
        assert fs._full_path('@org/policies/hr.md') == 'orgs/org-1/files/policies/hr.md'
        assert fs._full_path('@ORG/x') == 'orgs/org-1/files/x'
        # The own org by id resolves to the same tree.
        assert fs._full_path('=org/org-1/x') == 'orgs/org-1/files/x'

    def test_plain_member_denied(self, store):
        fs = _fs(store, _account())
        for spelling in ('@org/x', '=org/org-1/x'):
            with pytest.raises(PermissionError, match='Access denied for scoped path'):
                fs._full_path(spelling)

    def test_foreign_org_denied(self, store):
        fs = _fs(store, _account(org_perms=['org.admin']))
        with pytest.raises(PermissionError, match='Access denied for scoped path'):
            fs._full_path('=org/other-org/x')

    def test_no_org_session_denied(self, store):
        account = _account(org_perms=['org.admin'])
        account.organization = None
        fs = _fs(store, account)
        with pytest.raises(PermissionError, match='Access denied for scoped path'):
            fs._full_path('@org/x')


# ============================================================================
# Session identity — @me
# ============================================================================


class TestMeRoot:
    """@me/<rest> is the rooted spelling of the caller's OWN tree."""

    @pytest.mark.asyncio
    async def test_both_spellings_hit_one_tree(self, store):
        fs = _fs(store, _account())
        await fs.write('@me/My Files/a.txt', b'mine')
        # The plain spelling reads the same physical file.
        assert (await fs.read('My Files/a.txt')) == b'mine'
        assert fs._full_path('@me/My Files/a.txt') == fs._full_path('My Files/a.txt')
        assert fs._full_path('@Me/My Files/a.txt') == fs._full_path('My Files/a.txt')

    def test_me_is_unconditional_like_plain_paths(self, store):
        # Ownership IS the authorization: the caller's own tree consults no
        # team- or org-carried permission — rooted and plain spelling alike.
        fs = _fs(store, _account(team_perms=['task.monitor']))
        assert fs._full_path('@me/x.txt') == 'users/user-1/files/x.txt'

    def test_own_tree_survives_teamless_org(self, store):
        # The org-switch regression: a user whose ACTIVE org holds none of
        # their team memberships (or no org at all) must still reach their
        # own files — personal storage never hinges on org/team context.
        teamless = _account()
        teamless.organization = {'id': 'org-2', 'name': 'Elsewhere', 'permissions': [], 'teams': []}
        assert store._file_store(_ctx(teamless))._full_path('workspace/f.txt') == 'users/user-1/files/workspace/f.txt'
        orgless = _account()
        orgless.organization = None
        assert (
            store._file_store(_ctx(orgless))._full_path('@me/workspace/f.txt') == 'users/user-1/files/workspace/f.txt'
        )

    def test_me_system_trees_still_denied(self, store):
        fs = _fs(store, _account())
        with pytest.raises(PermissionError, match='system-owned'):
            fs._full_path('@me/.logs/p1/x.jsonl')


# ============================================================================
# The retired spellings
# ============================================================================


class TestRetiredSpellings:
    """@/User, @/Team/<ref> and @/Org are gone for every identity (B42)."""

    @pytest.mark.parametrize('spelling', _RETIRED)
    def test_session_refused(self, store, spelling):
        fs = _fs(store, _account(org_perms=['org.admin']))
        with pytest.raises(ValueError):
            fs._full_path(spelling)

    @pytest.mark.parametrize('spelling', _RETIRED)
    def test_sys_admin_refused(self, store, spelling):
        fs = _fs(store, _account(sys_perms=['sys.admin']))
        with pytest.raises(ValueError):
            fs._full_path(spelling)

    @pytest.mark.parametrize('spelling', _RETIRED)
    def test_internal_refused(self, store, spelling):
        fs = store._file_store(RequestContext.internal('run-log'), client_id='user-1')
        with pytest.raises(ValueError):
            fs._full_path(spelling)


# ============================================================================
# System-owned trees (.logs / .deployments)
# ============================================================================


class TestSystemTrees:
    """.logs and .deployments are SYSTEM-OWNED through the file API:
    engine-written, served by their domain APIs (rrext_log / rrext_deploy) —
    every session identity is denied ALL operations, except sys.admin, who
    may do anything. Internal identities pass mechanically.
    """

    def test_sessions_fully_denied_own_namespace(self, store):
        # Even full team permissions grant NOTHING on system trees via the
        # file API — the domain APIs are the only user-facing route.
        fs = _fs(store, _account())
        for tree in ('.logs/p1/x.jsonl', '.deployments/p1.json'):
            with pytest.raises(PermissionError, match='system-owned'):
                fs._full_path(tree)

    def test_sessions_fully_denied_team_scope(self, store):
        fs = _fs(store, _account())
        with pytest.raises(PermissionError, match='system-owned'):
            fs._full_path('=team/team-1/.logs/p1/x.jsonl')
        with pytest.raises(PermissionError, match='system-owned'):
            fs._full_path('@Development/.deployments/p1.json')

    def test_sys_admin_may_do_anything(self, store):
        fs = _fs(store, _account(sys_perms=['sys.admin']))
        assert fs._full_path('.logs/p1/x.jsonl') == 'users/user-1/files/.logs/p1/x.jsonl'
        assert fs._full_path('=team/team-1/.deployments/p1.json') == ('teams/team-1/files/.deployments/p1.json')

    def test_internal_identity_requires_id_roots(self, store):
        # Internal has no name dictionary and no org context: a team name and
        # @org mean nothing to it and deny; id roots resolve with no checks.
        fs = store._file_store(RequestContext.internal('run-log'), client_id='user-1')
        for spelling in ('@Development/x', '@org/x'):
            with pytest.raises(PermissionError, match='Access denied for scoped path'):
                fs._full_path(spelling)
        assert fs._full_path('=team/team-1/x') == 'teams/team-1/files/x'
        assert fs._full_path('=org/org-9/x') == 'orgs/org-9/files/x'
        assert fs._full_path('=user/user-9/x') == 'users/user-9/files/x'

    @pytest.mark.asyncio
    async def test_internal_identity_writes_logs(self, store):
        # The internal identity (run-log writer, domain APIs) passes through.
        # This is ALSO the ordering pin: internal resolves BEFORE the
        # system-tree gate by design — reordering resolve_scope turns this red.
        fs = store._file_store(RequestContext.internal('run-log'), client_id='user-1')
        await fs.write('.logs/p1/seg.jsonl', b'{}')
        await fs.write('=team/team-1/.logs/p1/seg.jsonl', b'{}')


class TestSysAdminCrossingAudit:
    """sys.admin id resolutions are the ONE place resolve_scope crosses the
    boundary instead of enforcing it — every crossing must leave an audit
    record, while member resolutions and the wire response stay
    indistinguishable from ordinary resolves.
    """

    @pytest.fixture
    def audited(self, monkeypatch):
        # Record every _audit_crossing call — the trace itself goes through
        # rocketlib.debug (native), so we pin the hook, not the sink.
        calls = []
        monkeypatch.setattr(
            file_store, '_audit_crossing', lambda ctx, client_id, target: calls.append((client_id, target))
        )
        return calls

    def test_foreign_team_id_crossing_is_audited(self, store, audited):
        fs = _fs(store, _account(sys_perms=['sys.admin']))
        assert fs._full_path('=team/team-9/x') == 'teams/team-9/files/x'
        assert ('user-1', 'teams/team-9') in audited

    def test_foreign_org_and_user_crossings_are_audited(self, store, audited):
        fs = _fs(store, _account(sys_perms=['sys.admin']))
        fs._full_path('=org/org-9/x')
        fs._full_path('=user/user-9/x')
        targets = [t for _, t in audited]
        assert 'orgs/org-9' in targets and 'users/user-9' in targets

    def test_member_id_resolution_is_not_audited(self, store, audited):
        # A sys.admin resolving a team they are a MEMBER of crosses nothing —
        # the audit channel records crossings, not routine member access.
        fs = _fs(store, _account(sys_perms=['sys.admin']))
        assert fs._full_path('=team/team-1/x') == 'teams/team-1/files/x'
        assert fs._full_path('=org/org-1/x') == 'orgs/org-1/files/x'
        assert audited == []


# ============================================================================
# Engine identity — a node's self.files
# ============================================================================


class TestEngineIdentity:
    """RequestContext.engine: plain paths only, reserved subtrees denied."""

    def test_rooted_paths_rejected(self, store):
        # EVERY root is rejected — including @me, which merely names the own
        # tree for sessions: LLM-generated paths inside the subprocess must
        # never speak the root grammar at all.
        fs = store._file_store(RequestContext.engine('user-1'), client_id='user-1')
        for spelling in ('=team/team-1/x', '=org/org-1/x', '=user/user-1/x', '@org/x', '@me/x', '@Development/x'):
            with pytest.raises(PermissionError, match='not a root this pipeline declares'):
                fs._full_path(spelling)

    def test_a_declared_root_is_the_only_root_admitted(self, store):
        # Plan 2.5: the roots the pipeline declared, resolved through its
        # owner when the control started; nothing else, and never a system tree
        from ai.account.file_store import DeclaredRoot

        declared = (DeclaredRoot('team', 'team-1', 'development', 'kb', 'teams/team-1/files', '@Development/kb'),)
        fs = store._file_store(
            RequestContext.engine('user-1'), client_id='user-1', root='users/user-1/files', declared=declared
        )
        assert fs._full_path('@Development/kb/a.txt') == 'teams/team-1/files/kb/a.txt'
        assert fs._full_path('=team/team-1/kb') == 'teams/team-1/files/kb'
        for spelling in ('@Development/kbx/a', '@Development/a', '=team/team-2/kb/a', '@org/kb/a', '@me/kb/a'):
            with pytest.raises(PermissionError, match='not a root this pipeline declares'):
                fs._full_path(spelling)
        with pytest.raises(ValueError, match='engine contexts only'):
            store._file_store(_ctx(_account()), declared=declared)

    def test_reserved_subtrees_rejected(self, store):
        fs = store._file_store(RequestContext.engine('user-1'), client_id='user-1')
        for subtree in ('.logs/p/x', '.deployments/p.json'):
            with pytest.raises(PermissionError, match='engine context'):
                fs._full_path(subtree)

    @pytest.mark.asyncio
    async def test_plain_paths_work_unchecked(self, store):
        fs = store._file_store(RequestContext.engine('user-1'), client_id='user-1')
        await fs.write('notes/todo.md', b'x')
        assert (await fs.read('notes/todo.md')) == b'x'

    @pytest.mark.asyncio
    async def test_storage_anchor_chroots_deploy_runs(self, store):
        # Deploy runs anchor at a task-specific TEAM subtree; the node's
        # plain relative paths are identical to dev — only the anchor moves.
        fs = store._file_store(
            RequestContext.engine('user-1'),
            client_id='user-1',
            root='teams/team-1/files/tasks/proj-1',
        )
        assert fs._full_path('out/report.csv') == 'teams/team-1/files/tasks/proj-1/out/report.csv'
        await fs.write('out/report.csv', b'rows')
        assert (await fs.read('out/report.csv')) == b'rows'

    def test_storage_anchor_still_rejects_roots_and_system_trees(self, store):
        # The anchor widens NOTHING: roots and system trees stay denied.
        fs = store._file_store(
            RequestContext.engine('user-1'),
            client_id='user-1',
            root='teams/team-1/files/tasks/proj-1',
        )
        with pytest.raises(PermissionError, match='not a root this pipeline declares'):
            fs._full_path('=team/team-2/x')
        with pytest.raises(PermissionError, match='engine context'):
            fs._full_path('.logs/p/x')

    def test_storage_anchor_validation(self, store):
        # Malformed anchors (fed back from the task file) fail closed.
        for bad in ('', 'foo/bar', 'users/u1', 'teams/../files/x', 'teams/t/files/../up', 'users/u1/files/@x'):
            with pytest.raises(ValueError):
                store._file_store(RequestContext.engine('user-1'), client_id='user-1', root=bad)

    def test_storage_anchor_engine_only(self, store):
        # Sessions/internal identities have their namespace as their anchor —
        # an override would be an authorization bypass, so it is a hard error.
        with pytest.raises(ValueError, match='engine contexts only'):
            store._file_store(_ctx(_account()), root='users/user-1/files')

    def test_file_store_for_caller_anchors_a_team_run_in_its_task_subtree(self, store, monkeypatch):
        # A node's self.files (plan 5.7): the server builds it from the
        # control that owns the binding, never from the subprocess
        monkeypatch.setattr(Store, 'instance', classmethod(lambda cls: store))
        fs = Store.file_store_for_caller(
            owner_kind='team', user_id='user-1', team_id='team-1', project_id='proj-1', conn_id='engine:7:team-1'
        )
        assert fs._client_id == 'user-1'
        assert fs._ctx.source == 'engine' and fs._ctx.conn_id == 'engine:7:team-1'
        assert fs._full_path('out/x.csv') == 'teams/team-1/files/tasks/proj-1/out/x.csv'
        with pytest.raises(PermissionError, match='not a root this pipeline declares'):
            fs._full_path('=team/team-2/x')

    def test_file_store_for_caller_anchors_an_org_run_in_the_org_tree(self, store, monkeypatch):
        # C.35: an org-owned run anchors in tasks/<project> inside the org's tree
        monkeypatch.setattr(Store, 'instance', classmethod(lambda cls: store))
        fs = Store.file_store_for_caller(
            owner_kind='org', user_id='', team_id='', project_id='proj-1', conn_id='engine:7:org', org_id='org-1'
        )
        assert fs._full_path('out/x.csv') == 'orgs/org-1/files/tasks/proj-1/out/x.csv'

    def test_file_store_for_caller_anchors_a_user_run_in_the_owners_tree(self, store, monkeypatch):
        monkeypatch.setattr(Store, 'instance', classmethod(lambda cls: store))
        fs = Store.file_store_for_caller(
            owner_kind='user', user_id='user-1', team_id='team-1', project_id='proj-1', conn_id='engine:7:user-1'
        )
        assert fs._full_path('out/x.csv') == 'users/user-1/files/out/x.csv'

    def test_file_store_for_caller_refuses_an_owner_with_no_tree(self, store, monkeypatch):
        # A team run with no team, and an anonymous user run, have no anchor:
        # the shared 'users//files' prefix is never composed
        monkeypatch.setattr(Store, 'instance', classmethod(lambda cls: store))
        with pytest.raises(ValueError, match='team_id'):
            Store.file_store_for_caller(owner_kind='team', user_id='u', team_id='', project_id='p', conn_id='c')
        with pytest.raises(ValueError, match='no owner'):
            Store.file_store_for_caller(owner_kind='user', user_id='', team_id='t', project_id='p', conn_id='c')
        with pytest.raises(ValueError):
            Store.file_store_for_caller(owner_kind='team', user_id='u', team_id='t', project_id='../x', conn_id='c')

    def test_storage_root_for(self):
        assert file_store.storage_root_for('team', 'u1', 't1', 'p1') == 'teams/t1/files/tasks/p1'
        assert file_store.storage_root_for('user', 'u1', 't1', 'p1') == 'users/u1/files'
        assert file_store.storage_root_for('org', 'u1', '', 'p1', org_id='o1') == 'orgs/o1/files/tasks/p1'

    def test_storage_root_for_refuses_what_has_no_anchor(self):
        with pytest.raises(ValueError, match='org_id'):
            file_store.storage_root_for('org', 'u1', 't1', 'p1')
        with pytest.raises(ValueError, match='Unknown owner kind'):
            file_store.storage_root_for('public', 'u1', 't1', 'p1')


# ============================================================================
# Normalization-bypass fuzz
# ============================================================================


class TestNormalizationBypass:
    """Every path spelling that NORMALIZES into the root grammar must be
    authorized as that root — never resolved around it.
    """

    BYPASS_SPELLINGS = [
        '\\=team\\team-else\\x',
        '/=team/team-else/x',
        './=team/team-else/x',
        '=team//team-else/x',
        '//=team/team-else/x',
        '=team/./team-else/x',
        '\\@Else\\x',
        '/@else/x',
        './@ELSE/x',
    ]

    @pytest.mark.parametrize('spelling', BYPASS_SPELLINGS)
    def test_bypass_spellings_still_denied(self, store, spelling):
        fs = _fs(store, _account())  # no access to 'team-else'
        with pytest.raises(PermissionError, match='Access denied for scoped path'):
            fs._full_path(spelling)

    @pytest.mark.parametrize('spelling', BYPASS_SPELLINGS)
    def test_bypass_spellings_resolve_into_grammar_for_members(self, store, spelling):
        account = _account(extra_teams=[{'id': 'team-else', 'name': 'Else', 'permissions': ['task.store']}])
        fs = store._file_store(_ctx(account))
        assert fs._full_path(spelling) == 'teams/team-else/files/x'

    def test_traversal_still_rejected(self, store):
        fs = _fs(store, _account())
        with pytest.raises(ValueError, match='traversal'):
            fs._full_path('=team/team-1/../../users/other/files/x')


# ============================================================================
# Scope-root guards + shared write locks
# ============================================================================


class TestScopeRootGuards:
    """Roots cannot be deleted, rmdir'd, or renamed."""

    @pytest.mark.asyncio
    async def test_rmdir_scope_root_rejected(self, store):
        fs = _fs(store, _account())
        for root in ('=team/team-1', '@Development'):
            with pytest.raises(StorageError, match='scope root'):
                await fs.rmdir(root, recursive=True)

    @pytest.mark.asyncio
    async def test_delete_scope_root_rejected(self, store):
        fs = _fs(store, _account())
        with pytest.raises(StorageError, match='scope root'):
            await fs.delete('=team/team-1')

    @pytest.mark.asyncio
    async def test_rename_scope_root_rejected(self, store):
        fs = _fs(store, _account())
        with pytest.raises(StorageError, match='scope root'):
            await fs.rename('=team/team-1', '=team/team-1/backup')

    @pytest.mark.asyncio
    async def test_me_and_org_roots_rejected(self, store):
        # @me and @org are roots too.
        fs = _fs(store, _account(org_perms=['org.admin']))
        with pytest.raises(StorageError, match='scope root'):
            await fs.rmdir('@me', recursive=True)
        with pytest.raises(StorageError, match='scope root'):
            await fs.delete('@org')

    @pytest.mark.asyncio
    async def test_own_root_rejected(self, store):
        # The caller's OWN account root is a root too — this is the case the
        # UNIVERSAL (`not rest`, not kind-conditional) guard exists for:
        # delete('')/rename('') would otherwise be whole-account operations.
        # Reverting the guard to `kind != 'own'` must turn this red.
        fs = _fs(store, _account())
        with pytest.raises(StorageError, match='scope root'):
            await fs.delete('')
        with pytest.raises(StorageError, match='scope root'):
            await fs.rename('', 'backup')
        with pytest.raises(StorageError, match='scope root'):
            await fs.rename('somedir', '')


class TestSharedWriteLocks:
    """Two users' instances exclude each other on one physical team file."""

    @pytest.mark.asyncio
    async def test_cross_user_exclusion_on_team_path(self, store):
        member_a = store._file_store(_ctx(_account(user_id='user-a')))
        member_b = store._file_store(_ctx(_account(user_id='user-b')))

        handle = await member_a.open_write('=team/team-1/shared.bin')
        with pytest.raises(StorageError, match='already open for writing'):
            await member_b.open_write('@Development/shared.bin')
        await member_a.close_write(handle)

        # Released — B may now write.
        handle_b = await member_b.open_write('=team/team-1/shared.bin')
        await member_b.close_write(handle_b)

    @pytest.mark.asyncio
    async def test_store_close_all_handles_covers_all_instances(self, store):
        fs = store._file_store(_ctx(_account(user_id='user-a')))
        await fs.open_write('=team/team-1/dangling.bin')
        # Disconnect-style cleanup through the Store, not the instance.
        await store.close_all_handles(fs._ctx.conn_id)
        # Lock released — reopening succeeds.
        handle = await fs.open_write('=team/team-1/dangling.bin')
        await fs.close_write(handle)


# ============================================================================
# Signed fetch URLs (get_url -> /task/fetch capability contract)
# ============================================================================


class TestSignedFetchUrls:
    """get_url signs the RESOLVED physical path — the /task/fetch capability.

    Regression for PR #1686: the claim used to carry the WIRE spelling, which
    the fetch handler re-resolved under an internal identity — an identity
    with no name dictionary and no org context, so team-name and org URLs
    died with an unhandled PermissionError (HTTP 500). The claim now IS the
    physical path; the handler serves it without resolving.
    """

    @staticmethod
    def _claim(url: str) -> dict:
        """Decode the JWT claim out of a generated fetch URL."""
        import jwt

        token = url.split('token=', 1)[1]
        return jwt.decode(token, _SIGNING_KEY, algorithms=['HS256'])

    @pytest.fixture(autouse=True)
    def _signing_env(self, monkeypatch):
        """The env get_url's local-JWT branch requires."""
        monkeypatch.setenv('RR_SIGNING_KEY', _SIGNING_KEY)
        monkeypatch.setenv('RR_BASE_URL', 'http://localhost:5565')

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ('wire_path', 'physical'),
        [
            # The reviewer's failure matrix: every wire spelling must sign
            # its RESOLVED location — including the two that used to 500.
            ('reports/q1.csv', 'users/user-1/files/reports/q1.csv'),
            ('@me/reports/q1.csv', 'users/user-1/files/reports/q1.csv'),
            ('@Development/q1.csv', 'teams/team-1/files/q1.csv'),
            ('=team/team-1/q1.csv', 'teams/team-1/files/q1.csv'),
        ],
    )
    async def test_claim_carries_resolved_path(self, store, wire_path, physical):
        fs = _fs(store, _account())
        url = await fs.get_url(wire_path)
        assert self._claim(url)['path'] == physical

    @pytest.mark.asyncio
    async def test_org_claim_carries_resolved_path(self, store):
        # '@org' needs org.admin — the second spelling that used to 500.
        fs = _fs(store, _account(org_perms=('org.admin',)))
        url = await fs.get_url('@org/q1.csv')
        assert self._claim(url)['path'] == 'orgs/org-1/files/q1.csv'

    @pytest.mark.asyncio
    async def test_claim_serves_without_scope_resolution(self, store):
        # The fetch handler's whole job now: backend._get_full_path(claim).
        # Write through the root grammar, then locate the file the way the
        # handler does — no FileStore, no identity, no resolve_scope.
        fs = _fs(store, _account())
        await fs.write('@Development/q1.csv', b'data')
        url = await fs.get_url('@Development/q1.csv')
        abs_path = store._store._get_full_path(self._claim(url)['path'])
        assert abs_path.is_file()
        assert abs_path.read_bytes() == b'data'

    @pytest.mark.asyncio
    async def test_authorization_still_gates_issuance(self, store):
        # Signing the physical path must not weaken issuance: a session
        # without org.admin cannot mint an @org capability at all.
        fs = _fs(store, _account())
        with pytest.raises(PermissionError):
            await fs.get_url('@org/q1.csv')

    @pytest.mark.asyncio
    async def test_claim_states_its_generation(self, store):
        from ai.account.file_store import FETCH_CLAIM_VERSION

        fs = _fs(store, _account())
        url = await fs.get_url('reports/q1.csv')
        assert self._claim(url)['v'] == FETCH_CLAIM_VERSION

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ('label', 'claim'),
        [
            ('v1 — wire path, no marker', {'sub': 'user-1', 'path': 'users/victim/files/secret.txt'}),
            ('newer generation', {'sub': 'user-1', 'path': 'users/user-1/files/q1.csv', 'v': 99}),
            # The gate precedes the required-claim check, so these are 401 and not 400.
            ('wrong generation, no sub', {'path': 'users/victim/files/secret.txt'}),
            ('wrong generation, no path', {'sub': 'user-1'}),
        ],
    )
    async def test_handler_refuses_other_claim_generations(self, label, claim):
        """Issue #1767: tokens outlive a deploy, so both generations meet at every
        upgrade. Anything but the current one must be refused, never read under
        today's meaning of 'path'.
        """
        import time
        from types import SimpleNamespace

        import jwt

        from ai.modules.task.fetch import handle_fetch

        token = jwt.encode({**claim, 'exp': int(time.time()) + 600}, _SIGNING_KEY, algorithm='HS256')
        request = SimpleNamespace(query_params={'token': token})  # handle_fetch reads only query_params

        response = await handle_fetch(request)
        assert response.status_code == 401, label
