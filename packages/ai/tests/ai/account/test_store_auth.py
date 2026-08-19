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

"""Authorization matrix for the storage scope grammar (FileStore + RequestContext).

The store is the security boundary: these tests drive REAL FileStore
operations over a real filesystem backend and assert what each identity may
resolve — scope grammar (@/Team, @/Org, @/User; ids and names), the system-tree rule
(.logs / .deployments: internal|sys.admin only), the identity kinds
(session / internal / engine), sys.admin and org.admin expansion, uniform denial (no existence
leak), the normalization-bypass fuzz family, and cross-user write-lock
exclusion on shared team paths.
"""

import shutil
import tempfile
from types import SimpleNamespace

import pytest

from ai.account import file_store
from ai.account.file_store import parse_scope
from ai.account.models import RequestContext
from ai.account.store import Store, StorageError
from ai.account.store_providers.filesystem import FilesystemStore


# One signing key for the env var, the encode, and the decode. Three copies
# of the literal could drift, and a mismatched decode key fails as an opaque
# 401 instead of a clear error.
_SIGNING_KEY = 'test-signing-key-of-32-bytes-min!'


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
# Scope grammar parsing
# ============================================================================


class TestParseScope:
    """parse_scope splits normalized paths into (kind, ref, rest) — the
    joined-filesystem grammar rooted at @/: Team takes a mandatory
    reference, User and Org are implicitly "me"/"my org" unless followed
    by an =id reference. Case-exact, alias-free.
    """

    def test_plain_path_is_user_scope(self):
        assert parse_scope('a/b/c.txt') == ('own', None, 'a/b/c.txt')

    def test_root_is_user_scope(self):
        assert parse_scope('') == ('own', None, '')

    def test_team_with_rest(self):
        assert parse_scope('@/Team/t1/reports/q3.md') == ('team', 't1', 'reports/q3.md')

    def test_user_is_implicitly_me(self):
        # No reference: everything after the sigil is already the path.
        assert parse_scope('@/User') == ('user', None, '')
        assert parse_scope('@/User/My Files/a.txt') == ('user', None, 'My Files/a.txt')

    def test_org_is_implicitly_my_org(self):
        assert parse_scope('@/Org') == ('org', None, '')
        assert parse_scope('@/Org/policies/hr.md') == ('org', None, 'policies/hr.md')

    def test_explicit_id_references(self):
        # '=' next segment: cross-boundary reference, not a path.
        assert parse_scope('@/User/=u1/.logs/x') == ('user', '=u1', '.logs/x')
        assert parse_scope('@/Org/=o1/x') == ('org', '=o1', 'x')

    def test_bare_at_and_reserved_sigils_rejected(self):
        # '@' itself is a virtual mount listing owned by cmd_store.
        for spelling in ('@', '@anything/x'):
            with pytest.raises(ValueError, match='Reserved'):
                parse_scope(spelling)

    def test_team_without_reference_rejected(self):
        with pytest.raises(ValueError, match='reference segment'):
            parse_scope('@/Team')

    def test_unknown_and_wrong_case_children_rejected(self):
        # Case-exact, alias-free: '@/team' is an error, not a spelling.
        for spelling in ('@/Files/x', '@/team/t1/x', '@/user/x', '@/ORG/x'):
            with pytest.raises(ValueError, match='Unknown scope'):
                parse_scope(spelling)

    def test_top_of_scope_equals_names_reserved(self):
        # A real '=x' entry would shadow id references — uncreatable.
        for spelling in ('=abc', '@/User/=u1/=x', '@/Team/t1/=x', '@/Org/=o1/=x'):
            with pytest.raises(ValueError, match='reserved for id references'):
                parse_scope(spelling)

    def test_nested_equals_names_allowed(self):
        # Only the FIRST segment of a scope is reserved.
        assert parse_scope('docs/=weird.txt') == ('own', None, 'docs/=weird.txt')


# ============================================================================
# Session identity — team scope
# ============================================================================


class TestSessionTeamScope:
    """A real session resolving @/Team paths."""

    @pytest.mark.asyncio
    async def test_team_by_id_resolves_and_writes(self, store):
        fs = _fs(store, _account())
        await fs.write('@/Team/=team-1/docs/readme.md', b'shared')
        # Physical location is the TEAM area, ids on disk.
        assert fs._full_path('@/Team/=team-1/docs/readme.md') == 'teams/team-1/files/docs/readme.md'

    @pytest.mark.asyncio
    async def test_team_by_display_name_resolves_to_id(self, store):
        fs = _fs(store, _account())
        await fs.write('@/Team/Development/docs/readme.md', b'shared')
        # Names on the wire, ids on disk — both spellings hit ONE location.
        assert (await fs.read('@/Team/=team-1/docs/readme.md')) == b'shared'

    @pytest.mark.asyncio
    async def test_two_members_share_one_location(self, store):
        member_a = store._file_store(_ctx(_account(user_id='user-a')))
        member_b = store._file_store(_ctx(_account(user_id='user-b')))
        await member_a.write('@/Team/=team-1/tmp/x.txt', b'from A')
        assert (await member_b.read('@/Team/=team-1/tmp/x.txt')) == b'from A'

    def test_foreign_team_denied_uniformly(self, store):
        fs = _fs(store, _account())
        with pytest.raises(PermissionError, match='Access denied for scoped path'):
            fs._full_path('@/Team/=team-elsewhere/x.txt')

    def test_member_without_task_store_denied_same_message(self, store):
        fs = _fs(store, _account(team_perms=['task.monitor']))
        with pytest.raises(PermissionError, match='Access denied for scoped path'):
            fs._full_path('@/Team/=team-1/x.txt')

    def test_ambiguous_name_denied_same_message(self, store):
        # Two teams sharing a display name: name addressing fails closed with
        # the SAME message as unknown/foreign (id addressing always works).
        account = _account(extra_teams=[{'id': 'team-2', 'name': 'Development', 'permissions': ['task.store']}])
        fs = store._file_store(_ctx(account))
        with pytest.raises(PermissionError, match='Access denied for scoped path'):
            fs._full_path('@/Team/Development/x.txt')
        assert fs._full_path('@/Team/=team-1/x.txt') == 'teams/team-1/files/x.txt'

    def test_names_and_ids_cannot_shadow(self, store):
        # v2: a bare segment is ONLY a name, '=x' is ONLY an id — a team
        # NAMED like another team's id resolves by name to its own id.
        account = _account(extra_teams=[{'id': 'team-x', 'name': 'team-1', 'permissions': ['task.store']}])
        fs = store._file_store(_ctx(account))
        assert fs._full_path('@/Team/team-1/f').startswith('teams/team-x/')
        assert fs._full_path('@/Team/=team-1/f').startswith('teams/team-1/')

    def test_id_reference_traversal_guard(self, store):
        # '=..' / '=.' / '=' must never embed into the physical path.
        fs = _fs(store, _account(sys_perms=['sys.admin']))
        for evil in ('@/Team/=../x', '@/Team/=./x', '@/Team/=/x', '@/User/=../x'):
            with pytest.raises(ValueError, match='Invalid id reference|reference segment'):
                fs._full_path(evil)

    def test_no_org_session_denied(self, store):
        account = _account()
        account.organization = None
        fs = store._file_store(_ctx(account))
        with pytest.raises(PermissionError, match='Access denied for scoped path'):
            fs._full_path('@/Team/=team-1/x')

    def test_unauthenticated_context_denied(self, store):
        fs = store._file_store(RequestContext(account_info=None), client_id='user-1')
        with pytest.raises(PermissionError, match='Not authenticated'):
            fs._full_path('anything.txt')

    def test_sys_admin_bypasses_team_membership(self, store):
        fs = _fs(store, _account(team_perms=[], sys_perms=['sys.admin']))
        assert fs._full_path('@/Team/=team-1/x') == 'teams/team-1/files/x'

    def test_sys_admin_crosses_boundaries_by_id_only(self, store):
        # The support capability: foreign teams/orgs/users by =id and ONLY
        # by =id (names still resolve through the admin's own dictionary).
        fs = _fs(store, _account(sys_perms=['sys.admin']))
        assert fs._full_path('@/Team/=foreign-team/x') == 'teams/foreign-team/files/x'
        assert fs._full_path('@/Org/=foreign-org/x') == 'orgs/foreign-org/files/x'
        assert fs._full_path('@/User/=other-user/notes.txt') == 'users/other-user/files/notes.txt'
        with pytest.raises(PermissionError, match='Access denied for scoped path'):
            fs._full_path('@/Team/TheirTeamName/x')

    def test_sys_admin_full_access_to_foreign_system_trees(self, store):
        # sys.admin may do ANYTHING with system trees, anywhere.
        fs = _fs(store, _account(sys_perms=['sys.admin']))
        assert fs._full_path('@/User/=other-user/.logs/p1/x.jsonl')
        assert fs._full_path('@/User/=other-user/.deployments/p1.json')

    def test_ordinary_session_cannot_use_user_scope(self, store):
        fs = _fs(store, _account())
        with pytest.raises(PermissionError, match='Access denied for scoped path'):
            fs._full_path('@/User/=user-1/x')  # not even for yourself


# ============================================================================
# Session identity — org scope
# ============================================================================


class TestSessionOrgScope:
    """@/Org is implicitly the caller's ONE org — org.admin-only."""

    def test_org_admin_resolves_implicitly_and_by_id(self, store):
        fs = _fs(store, _account(org_perms=['org.admin']))
        # Implicit spelling: the segment after @/Org is already the path.
        assert fs._full_path('@/Org/policies/hr.md') == 'orgs/org-1/files/policies/hr.md'
        # Explicit own-org id reference still resolves to the same tree.
        assert fs._full_path('@/Org/=org-1/x') == 'orgs/org-1/files/x'

    def test_plain_member_denied(self, store):
        fs = _fs(store, _account())
        for spelling in ('@/Org/x', '@/Org/=org-1/x'):
            with pytest.raises(PermissionError, match='Access denied for scoped path'):
                fs._full_path(spelling)

    def test_foreign_org_denied(self, store):
        fs = _fs(store, _account(org_perms=['org.admin']))
        with pytest.raises(PermissionError, match='Access denied for scoped path'):
            fs._full_path('@/Org/=other-org/x')

    def test_no_org_session_denied(self, store):
        account = _account(org_perms=['org.admin'])
        account.organization = None
        fs = _fs(store, account)
        with pytest.raises(PermissionError, match='Access denied for scoped path'):
            fs._full_path('@/Org/x')


# ============================================================================
# Session identity — the @/User joined-mode alias
# ============================================================================


class TestJoinedUserAlias:
    """@/User/<rest> is the joined-mode spelling of the caller's OWN tree."""

    @pytest.mark.asyncio
    async def test_both_spellings_hit_one_tree(self, store):
        fs = _fs(store, _account())
        await fs.write('@/User/My Files/a.txt', b'joined')
        # Simple-mode spelling reads the same physical file.
        assert (await fs.read('My Files/a.txt')) == b'joined'
        assert fs._full_path('@/User/My Files/a.txt') == fs._full_path('My Files/a.txt')

    def test_alias_is_unconditional_like_plain_paths(self, store):
        # Ownership IS the authorization: the caller's own tree consults no
        # team- or org-carried permission — alias and plain spelling alike.
        fs = _fs(store, _account(team_perms=['task.monitor']))
        assert fs._full_path('@/User/x.txt') == 'users/user-1/files/x.txt'

    def test_own_tree_survives_teamless_org(self, store):
        # The org-switch regression: a user whose ACTIVE org holds none of
        # their team memberships (or no org at all) must still reach their
        # own files — personal storage never hinges on org/team context.
        teamless = _account()
        teamless.organization = {'id': 'org-2', 'name': 'Elsewhere', 'permissions': [], 'teams': []}
        assert store._file_store(_ctx(teamless))._full_path('workspace/f.txt') == 'users/user-1/files/workspace/f.txt'
        orgless = _account()
        orgless.organization = None
        assert store._file_store(_ctx(orgless))._full_path('workspace/f.txt') == 'users/user-1/files/workspace/f.txt'

    def test_alias_system_trees_still_denied(self, store):
        fs = _fs(store, _account())
        with pytest.raises(PermissionError, match='system-owned'):
            fs._full_path('@/User/.logs/p1/x.jsonl')


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
            fs._full_path('@/Team/=team-1/.logs/p1/x.jsonl')
        with pytest.raises(PermissionError, match='system-owned'):
            fs._full_path('@/Team/Development/.deployments/p1.json')

    def test_sys_admin_may_do_anything(self, store):
        fs = _fs(store, _account(sys_perms=['sys.admin']))
        assert fs._full_path('.logs/p1/x.jsonl') == 'users/user-1/files/.logs/p1/x.jsonl'
        assert fs._full_path('@/Team/=team-1/.deployments/p1.json') == ('teams/team-1/files/.deployments/p1.json')

    def test_internal_identity_requires_id_references(self, store):
        # Internal has no name dictionary: bare (name) references deny.
        fs = store._file_store(RequestContext.internal('run-log'), client_id='user-1')
        with pytest.raises(PermissionError, match='Access denied for scoped path'):
            fs._full_path('@/Team/Development/x')
        assert fs._full_path('@/Team/=team-1/x') == 'teams/team-1/files/x'

    @pytest.mark.asyncio
    async def test_internal_identity_writes_logs(self, store):
        # The internal identity (run-log writer, domain APIs) passes through.
        # This is ALSO the ordering pin: internal resolves BEFORE the
        # system-tree gate by design — reordering resolve_scope turns this red.
        fs = store._file_store(RequestContext.internal('run-log'), client_id='user-1')
        await fs.write('.logs/p1/seg.jsonl', b'{}')
        await fs.write('@/Team/=team-1/.logs/p1/seg.jsonl', b'{}')


class TestSysAdminCrossingAudit:
    """sys.admin ``=id`` resolutions are the ONE place resolve_scope crosses
    the boundary instead of enforcing it — every crossing must leave an audit
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
        assert fs._full_path('@/Team/=team-9/x') == 'teams/team-9/files/x'
        assert ('user-1', 'teams/team-9') in audited

    def test_foreign_org_and_user_crossings_are_audited(self, store, audited):
        fs = _fs(store, _account(sys_perms=['sys.admin']))
        fs._full_path('@/Org/=org-9/x')
        fs._full_path('@/User/=user-9/x')
        targets = [t for _, t in audited]
        assert 'orgs/org-9' in targets and 'users/user-9' in targets

    def test_member_id_resolution_is_not_audited(self, store, audited):
        # A sys.admin resolving a team they are a MEMBER of crosses nothing —
        # the audit channel records crossings, not routine member access.
        fs = _fs(store, _account(sys_perms=['sys.admin']))
        assert fs._full_path('@/Team/=team-1/x') == 'teams/team-1/files/x'
        assert audited == []


# ============================================================================
# Engine identity — subprocess tool nodes
# ============================================================================


class TestEngineIdentity:
    """RequestContext.engine: user scope only, reserved subtrees denied."""

    def test_scoped_paths_rejected(self, store):
        # EVERY sigil spelling is rejected — including @/User, which merely
        # aliases the own tree for sessions: LLM-generated paths inside the
        # subprocess must never speak the scope grammar at all.
        fs = store._file_store(RequestContext.engine('user-1'), client_id='user-1')
        for spelling in ('@/Team/=team-1/x', '@/Org/=org-1/x', '@/Org/x', '@/User/x'):
            with pytest.raises(PermissionError, match='engine context'):
                fs._full_path(spelling)

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

    def test_storage_anchor_still_rejects_scopes_and_system_trees(self, store):
        # The anchor widens NOTHING: sigils and system trees stay denied.
        fs = store._file_store(
            RequestContext.engine('user-1'),
            client_id='user-1',
            root='teams/team-1/files/tasks/proj-1',
        )
        with pytest.raises(PermissionError, match='engine context'):
            fs._full_path('@/Team/=team-2/x')
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

    def test_engine_file_store_binds_task_identity_and_anchor(self, store, monkeypatch):
        # The transparent path: identity + anchor come from the engine's
        # published task (rocketlib.getTask) — zero node-level plumbing.
        monkeypatch.setattr(Store, 'instance', classmethod(lambda cls: store))
        monkeypatch.setattr(
            Store,
            '_get_current_task',
            staticmethod(
                lambda: {
                    'identity': {'userId': 'user-1', 'teamId': 'team-1', 'orgId': 'org-1'},
                    'storage': {'root': 'teams/team-1/files/tasks/proj-1'},
                }
            ),
        )
        fs = Store.engine_file_store()
        assert fs._client_id == 'user-1'
        assert fs._full_path('out/x.csv') == 'teams/team-1/files/tasks/proj-1/out/x.csv'

    def test_engine_file_store_none_without_task(self, monkeypatch):
        # Outside a running task (or without identity) there is no store.
        for task in (None, {}, {'identity': {}}):
            monkeypatch.setattr(Store, '_get_current_task', staticmethod(lambda t=task: t))
            assert Store.engine_file_store() is None


# ============================================================================
# Normalization-bypass fuzz
# ============================================================================


class TestNormalizationBypass:
    """Every path spelling that NORMALIZES into the @ grammar must be
    authorized as the @ grammar — never resolved around it.
    """

    BYPASS_SPELLINGS = [
        '\\@\\Team\\=team-else\\x',
        '/@/Team/=team-else/x',
        './@/Team/=team-else/x',
        '@/Team//=team-else/x',
        '//@/Team/=team-else/x',
        '@/Team/./=team-else/x',
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
            fs._full_path('@/Team/=team-1/../../users/other/files/x')


# ============================================================================
# Scope-root guards + shared write locks
# ============================================================================


class TestScopeRootGuards:
    """Scope roots cannot be deleted, rmdir'd, or renamed."""

    @pytest.mark.asyncio
    async def test_rmdir_scope_root_rejected(self, store):
        fs = _fs(store, _account())
        with pytest.raises(StorageError, match='scope root'):
            await fs.rmdir('@/Team/=team-1', recursive=True)

    @pytest.mark.asyncio
    async def test_delete_scope_root_rejected(self, store):
        fs = _fs(store, _account())
        with pytest.raises(StorageError, match='scope root'):
            await fs.delete('@/Team/=team-1')

    @pytest.mark.asyncio
    async def test_rename_scope_root_rejected(self, store):
        fs = _fs(store, _account())
        with pytest.raises(StorageError, match='scope root'):
            await fs.rename('@/Team/=team-1', '@/Team/=team-1/backup')

    @pytest.mark.asyncio
    async def test_joined_mount_roots_rejected(self, store):
        # The joined-mode mounts are scope roots too.
        fs = _fs(store, _account(org_perms=['org.admin']))
        with pytest.raises(StorageError, match='scope root'):
            await fs.rmdir('@/User', recursive=True)
        with pytest.raises(StorageError, match='scope root'):
            await fs.delete('@/Org')

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

        handle = await member_a.open_write('@/Team/=team-1/shared.bin')
        with pytest.raises(StorageError, match='already open for writing'):
            await member_b.open_write('@/Team/=team-1/shared.bin')
        await member_a.close_write(handle)

        # Released — B may now write.
        handle_b = await member_b.open_write('@/Team/=team-1/shared.bin')
        await member_b.close_write(handle_b)

    @pytest.mark.asyncio
    async def test_store_close_all_handles_covers_all_instances(self, store):
        fs = store._file_store(_ctx(_account(user_id='user-a')))
        await fs.open_write('@/Team/=team-1/dangling.bin')
        # Disconnect-style cleanup through the Store, not the instance.
        await store.close_all_handles(fs._ctx.conn_id)
        # Lock released — reopening succeeds.
        handle = await fs.open_write('@/Team/=team-1/dangling.bin')
        await fs.close_write(handle)


# ============================================================================
# Signed fetch URLs (get_url -> /task/fetch capability contract)
# ============================================================================


class TestSignedFetchUrls:
    """get_url signs the RESOLVED physical path — the /task/fetch capability.

    Regression for PR #1686: the claim used to carry the WIRE spelling, which
    the fetch handler re-resolved under an internal identity — an identity
    with no name dictionary and no org context, so '@/Team/<name>' and
    '@/Org' URLs died with an unhandled PermissionError (HTTP 500). The
    claim now IS the physical path; the handler serves it without resolving.
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
            ('@/User/reports/q1.csv', 'users/user-1/files/reports/q1.csv'),
            ('@/Team/Development/q1.csv', 'teams/team-1/files/q1.csv'),
            ('@/Team/=team-1/q1.csv', 'teams/team-1/files/q1.csv'),
        ],
    )
    async def test_claim_carries_resolved_path(self, store, wire_path, physical):
        fs = _fs(store, _account())
        url = await fs.get_url(wire_path)
        assert self._claim(url)['path'] == physical

    @pytest.mark.asyncio
    async def test_org_claim_carries_resolved_path(self, store):
        # '@/Org' needs org.admin — the second spelling that used to 500.
        fs = _fs(store, _account(org_perms=('org.admin',)))
        url = await fs.get_url('@/Org/q1.csv')
        assert self._claim(url)['path'] == 'orgs/org-1/files/q1.csv'

    @pytest.mark.asyncio
    async def test_claim_serves_without_scope_resolution(self, store):
        # The fetch handler's whole job now: backend._get_full_path(claim).
        # Write through the scope grammar, then locate the file the way the
        # handler does — no FileStore, no identity, no resolve_scope.
        fs = _fs(store, _account())
        await fs.write('@/Team/Development/q1.csv', b'data')
        url = await fs.get_url('@/Team/Development/q1.csv')
        abs_path = store._store._get_full_path(self._claim(url)['path'])
        assert abs_path.is_file()
        assert abs_path.read_bytes() == b'data'

    @pytest.mark.asyncio
    async def test_authorization_still_gates_issuance(self, store):
        # Signing the physical path must not weaken issuance: a session
        # without org.admin cannot mint an @/Org capability at all.
        fs = _fs(store, _account())
        with pytest.raises(PermissionError):
            await fs.get_url('@/Org/q1.csv')

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
