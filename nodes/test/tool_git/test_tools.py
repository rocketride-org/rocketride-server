"""
Tests for tool_git.

Unit tests mock pygit2 and run without any git binary or real repository.
Integration tests require a real git repository path via the environment variable:

    export GIT_TEST_REPO_PATH=/path/to/some/local/repo
    pytest nodes/test/tool_git/test_tools.py -v

Integration tests are automatically skipped when the variable is unset.
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from typing import Any, Dict, Optional
from unittest.mock import MagicMock, create_autospec, patch

import pytest

# ---------------------------------------------------------------------------
# Stub out pygit2 so git_repo.py can be imported without the native library
# ---------------------------------------------------------------------------

_pygit2_stub = MagicMock()
_pygit2_stub.GIT_SORT_TIME = 4
_pygit2_stub.GIT_OBJ_COMMIT = 1
_pygit2_stub.GIT_OBJ_TREE = 2
_pygit2_stub.GIT_OBJ_BLOB = 3
_pygit2_stub.GIT_OBJ_TAG = 4
_pygit2_stub.GIT_STATUS_INDEX_NEW = 1
_pygit2_stub.GIT_STATUS_INDEX_MODIFIED = 2
_pygit2_stub.GIT_STATUS_INDEX_DELETED = 4
_pygit2_stub.GIT_STATUS_INDEX_RENAMED = 8
_pygit2_stub.GIT_STATUS_INDEX_TYPECHANGE = 16
_pygit2_stub.GIT_STATUS_WT_MODIFIED = 256
_pygit2_stub.GIT_STATUS_WT_DELETED = 512
_pygit2_stub.GIT_STATUS_WT_TYPECHANGE = 1024
_pygit2_stub.GIT_STATUS_WT_RENAMED = 2048
_pygit2_stub.GIT_STATUS_WT_NEW = 128
_pygit2_stub.GIT_MERGE_ANALYSIS_UP_TO_DATE = 2
_pygit2_stub.GIT_MERGE_ANALYSIS_FASTFORWARD = 4
_pygit2_stub.GIT_MERGE_ANALYSIS_NORMAL = 8
_pygit2_stub.GitError = Exception
_pygit2_stub.RemoteCallbacks = object
_pygit2_stub.Signature = MagicMock()

_rocketlib_stub = MagicMock()
_rocketlib_stub.IInstanceBase = object
_rocketlib_stub.IGlobalBase = object
_rocketlib_stub.OPEN_MODE = MagicMock()
_rocketlib_stub.warning = MagicMock()

_ai_config_stub = MagicMock()
_ai_common_stub = MagicMock()
_ai_common_stub.config = _ai_config_stub
_ai_stub = MagicMock()
_ai_stub.common = _ai_common_stub

_depends_stub = MagicMock()
_depends_stub.depends = MagicMock()

with patch.dict(
    sys.modules,
    {
        'pygit2': _pygit2_stub,
        'pygit2.credentials': _pygit2_stub,
        'rocketlib': _rocketlib_stub,
        'ai': _ai_stub,
        'ai.common': _ai_common_stub,
        'ai.common.config': _ai_config_stub,
        'depends': _depends_stub,
    },
):
    _src = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_git'
    sys.path.insert(0, str(_src.parent))
    from tool_git.git_repo import GitError, GitRepo  # noqa: E402
    from tool_git.IInstance import IInstance  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_instance() -> IInstance:
    inst = IInstance.__new__(IInstance)
    inst.IGlobal = MagicMock()
    inst.IGlobal.repo = create_autospec(GitRepo, instance=True, spec_set=True)
    return inst


def _invoke(inst: IInstance, tool_name: str, args: Optional[Dict[str, Any]] = None) -> str:
    """Drive IInstance.invoke() with a tool.invoke op and return param.output."""
    if args is None:
        args = {}
    param = MagicMock()
    param.op = 'tool.invoke'
    param.tool_name = tool_name
    param.input = args
    inst.invoke(param)
    return param.output


def _ok(result: str) -> Any:
    data = json.loads(result)
    assert 'error' not in data, f'Unexpected error: {data["error"]}'
    return data


def _err(result: str) -> str:
    data = json.loads(result)
    assert 'error' in data, f'Expected error but got: {data}'
    return data['error']


# ---------------------------------------------------------------------------
# tool.query
# ---------------------------------------------------------------------------


class TestToolQuery(unittest.TestCase):
    def test_query_populates_tools(self) -> None:
        inst = _make_instance()
        param = MagicMock()
        param.op = 'tool.query'
        param.tools = []
        inst.invoke(param)
        names = [t['name'] for t in param.tools]
        self.assertIn('git.status', names)
        self.assertIn('git.clone', names)
        self.assertIn('git.push', names)
        self.assertGreater(len(names), 15)

    def test_unknown_op_returns_param(self) -> None:
        inst = _make_instance()
        param = MagicMock()
        param.op = 'something.else'
        result = inst.invoke(param)
        self.assertIs(result, param)


# ---------------------------------------------------------------------------
# Unit tests — IInstance routing via invoke()
# ---------------------------------------------------------------------------


class TestIInstanceStatus(unittest.TestCase):
    def test_status_returns_ok(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.status.return_value = {
            'branch': 'main',
            'staged': [],
            'unstaged': [],
            'untracked': [],
            'clean': True,
        }
        result = _ok(_invoke(inst, 'git.status'))
        self.assertEqual(result['branch'], 'main')
        self.assertTrue(result['clean'])

    def test_status_no_repo_returns_error(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo = None
        msg = _err(_invoke(inst, 'git.status'))
        self.assertIn('not initialised', msg)


class TestIInstanceLog(unittest.TestCase):
    def test_log_passes_defaults(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.log.return_value = []
        _invoke(inst, 'git.log')
        inst.IGlobal.repo.log.assert_called_once_with(
            max_count=20,
            branch=None,
            path=None,
            author=None,
            since=None,
            until=None,
        )

    def test_log_passes_custom_params(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.log.return_value = [{'sha': 'abc'}]
        _ok(_invoke(inst, 'git.log', {'max_count': 5, 'branch': 'develop', 'author': 'Alice'}))
        inst.IGlobal.repo.log.assert_called_once_with(
            max_count=5,
            branch='develop',
            path=None,
            author='Alice',
            since=None,
            until=None,
        )


class TestIInstanceShow(unittest.TestCase):
    def test_show_requires_ref(self) -> None:
        inst = _make_instance()
        msg = _err(_invoke(inst, 'git.show', {}))
        self.assertIn('Missing required parameter', msg)

    def test_show_returns_commit(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.show.return_value = {
            'sha': 'deadbeef',
            'message': 'fix: something',
            'diff': '',
            'stats': {'files_changed': 1, 'insertions': 5, 'deletions': 2},
        }
        result = _ok(_invoke(inst, 'git.show', {'ref': 'HEAD'}))
        inst.IGlobal.repo.show.assert_called_once_with(ref='HEAD')
        self.assertEqual(result['sha'], 'deadbeef')


class TestIInstanceStage(unittest.TestCase):
    def test_stage_requires_paths(self) -> None:
        inst = _make_instance()
        msg = _err(_invoke(inst, 'git.stage', {'paths': []}))
        self.assertIn('non-empty', msg)

    def test_stage_forwards_paths(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.stage.return_value = {'staged': ['a.py'], 'count': 1}
        result = _ok(_invoke(inst, 'git.stage', {'paths': ['a.py']}))
        self.assertEqual(result['count'], 1)
        inst.IGlobal.repo.stage.assert_called_once_with(paths=['a.py'])


class TestIInstanceCommit(unittest.TestCase):
    def test_commit_returns_sha(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.commit.return_value = {
            'sha': 'deadbeef',
            'short_sha': 'deadbeef',
            'message': 'test',
            'author': 'Agent',
        }
        result = _ok(_invoke(inst, 'git.commit', {'message': 'test'}))
        self.assertEqual(result['sha'], 'deadbeef')
        inst.IGlobal.repo.commit.assert_called_once_with(message='test', author_name='', author_email='')

    def test_commit_forwards_author(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.commit.return_value = {'sha': 'abc', 'short_sha': 'abc', 'message': 'x', 'author': 'Bob'}
        _invoke(inst, 'git.commit', {'message': 'feat: x', 'author_name': 'Bob', 'author_email': 'bob@x.com'})
        inst.IGlobal.repo.commit.assert_called_once_with(message='feat: x', author_name='Bob', author_email='bob@x.com')


class TestIInstanceStash(unittest.TestCase):
    def test_stash_push(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.stash.return_value = {'status': 'stashed', 'sha': 'abc', 'message': 'x'}
        result = _ok(_invoke(inst, 'git.stash', {'op': 'push'}))
        self.assertEqual(result['status'], 'stashed')

    def test_stash_list(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.stash.return_value = {'stashes': [], 'count': 0}
        result = _ok(_invoke(inst, 'git.stash', {'op': 'list'}))
        self.assertEqual(result['count'], 0)


class TestIInstanceBranch(unittest.TestCase):
    def test_branch_list(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.branch_list.return_value = {
            'local': [{'name': 'main', 'current': True}],
        }
        result = _ok(_invoke(inst, 'git.branch_list'))
        self.assertEqual(result['local'][0]['name'], 'main')
        inst.IGlobal.repo.branch_list.assert_called_once_with(remote=False, all_branches=False)

    def test_branch_list_remote_flag(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.branch_list.return_value = {'local': [], 'remote': ['origin/main']}
        _invoke(inst, 'git.branch_list', {'remote': True})
        inst.IGlobal.repo.branch_list.assert_called_once_with(remote=True, all_branches=False)

    def test_branch_create(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.branch_create.return_value = {'name': 'feat/x', 'sha': 'abc123'}
        result = _ok(_invoke(inst, 'git.branch_create', {'name': 'feat/x'}))
        self.assertEqual(result['name'], 'feat/x')
        inst.IGlobal.repo.branch_create.assert_called_once_with(name='feat/x', from_ref=None)

    def test_branch_create_from_ref(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.branch_create.return_value = {'name': 'feat/y', 'sha': 'def456'}
        _invoke(inst, 'git.branch_create', {'name': 'feat/y', 'from_ref': 'develop'})
        inst.IGlobal.repo.branch_create.assert_called_once_with(name='feat/y', from_ref='develop')

    def test_branch_create_missing_name_raises(self) -> None:
        inst = _make_instance()
        msg = _err(_invoke(inst, 'git.branch_create', {}))
        self.assertIn('Missing required parameter', msg)

    def test_checkout(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.checkout.return_value = {'branch': 'feat/x', 'sha': 'abc123'}
        result = _ok(_invoke(inst, 'git.checkout', {'branch': 'feat/x'}))
        self.assertEqual(result['branch'], 'feat/x')

    def test_branch_delete(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.branch_delete.return_value = {'deleted': 'old-branch'}
        result = _ok(_invoke(inst, 'git.branch_delete', {'name': 'old-branch', 'force': True}))
        self.assertEqual(result['deleted'], 'old-branch')
        inst.IGlobal.repo.branch_delete.assert_called_once_with(name='old-branch', force=True)

    def test_merge(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.merge.return_value = {'status': 'fast_forwarded', 'branch': 'feat/x', 'sha': 'abc'}
        result = _ok(_invoke(inst, 'git.merge', {'branch': 'feat/x'}))
        self.assertEqual(result['status'], 'fast_forwarded')


class TestIInstanceRemote(unittest.TestCase):
    def test_fetch_defaults(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.fetch.return_value = {
            'remote': 'origin',
            'received_objects': 0,
            'indexed_objects': 0,
            'total_deltas': 0,
        }
        _invoke(inst, 'git.fetch')
        inst.IGlobal.repo.fetch.assert_called_once_with(remote='origin', branch=None)

    def test_fetch_custom_remote(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.fetch.return_value = {'remote': 'upstream', 'received_objects': 3, 'indexed_objects': 3, 'total_deltas': 0}
        _invoke(inst, 'git.fetch', {'remote': 'upstream', 'branch': 'main'})
        inst.IGlobal.repo.fetch.assert_called_once_with(remote='upstream', branch='main')

    def test_push_defaults(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.push.return_value = {
            'remote': 'origin',
            'branch': 'main',
            'status': 'pushed',
        }
        _invoke(inst, 'git.push')
        inst.IGlobal.repo.push.assert_called_once_with(remote='origin', branch=None, force=False)

    def test_push_force_flag(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.push.return_value = {'remote': 'origin', 'branch': 'main', 'status': 'pushed'}
        _invoke(inst, 'git.push', {'force': True})
        inst.IGlobal.repo.push.assert_called_once_with(remote='origin', branch=None, force=True)

    def test_pull_passes_remote(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.pull.return_value = {'merge': 'fast_forwarded'}
        _invoke(inst, 'git.pull', {'remote': 'upstream'})
        inst.IGlobal.repo.pull.assert_called_once_with(remote='upstream', branch=None)


class TestIInstanceDiff(unittest.TestCase):
    def test_diff_staged_flag(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.diff.return_value = {'patch': '', 'files_changed': 0, 'insertions': 0, 'deletions': 0}
        _invoke(inst, 'git.diff', {'staged': True})
        inst.IGlobal.repo.diff.assert_called_once_with(ref_a=None, ref_b=None, path=None, staged=True)

    def test_diff_two_refs(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.diff.return_value = {'patch': '--- a\n+++ b\n', 'files_changed': 1, 'insertions': 1, 'deletions': 0}
        _invoke(inst, 'git.diff', {'ref_a': 'main', 'ref_b': 'feat/x'})
        inst.IGlobal.repo.diff.assert_called_once_with(ref_a='main', ref_b='feat/x', path=None, staged=False)

    def test_blame_forwards_args(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.blame.return_value = [{'line': 1, 'content': 'x = 1', 'sha': 'abc', 'author': 'Alice', 'date': '2026-01-01T00:00:00+00:00'}]
        result = _ok(_invoke(inst, 'git.blame', {'path': 'foo.py', 'ref': 'HEAD'}))
        self.assertEqual(result[0]['author'], 'Alice')
        inst.IGlobal.repo.blame.assert_called_once_with(path='foo.py', ref='HEAD')

    def test_file_at_forwards_args(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.file_at.return_value = {'path': 'README.md', 'ref': 'HEAD', 'sha': 'abc', 'size': 10, 'content': '# Hello'}
        result = _ok(_invoke(inst, 'git.file_at', {'path': 'README.md', 'ref': 'HEAD'}))
        self.assertEqual(result['content'], '# Hello')

    def test_write_file_forwards_args(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.write_file.return_value = {'path': 'README.md', 'size': 7, 'status': 'written'}
        result = _ok(_invoke(inst, 'git.write_file', {'path': 'README.md', 'content': '# Hello'}))
        self.assertEqual(result['status'], 'written')
        inst.IGlobal.repo.write_file.assert_called_once_with(path='README.md', content='# Hello')


class TestIInstanceSearch(unittest.TestCase):
    def test_grep_forwards_args(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.grep.return_value = [{'file': 'foo.py', 'line': 1, 'content': 'hello world'}]
        result = _ok(_invoke(inst, 'git.grep', {'pattern': 'hello'}))
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['file'], 'foo.py')
        inst.IGlobal.repo.grep.assert_called_once_with(pattern='hello', ref=None, path=None, ignore_case=False)

    def test_grep_case_insensitive(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.grep.return_value = []
        _invoke(inst, 'git.grep', {'pattern': 'TODO', 'ignore_case': True, 'path': 'src/'})
        inst.IGlobal.repo.grep.assert_called_once_with(pattern='TODO', ref=None, path='src/', ignore_case=True)

    def test_ls_files_defaults(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.ls_files.return_value = {'tracked': ['a.py'], 'count': 1}
        result = _ok(_invoke(inst, 'git.ls_files'))
        self.assertEqual(result['count'], 1)
        inst.IGlobal.repo.ls_files.assert_called_once_with(path=None, untracked=False)

    def test_ls_files_with_untracked(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.ls_files.return_value = {'tracked': ['a.py'], 'count': 1, 'untracked': ['b.py']}
        _invoke(inst, 'git.ls_files', {'untracked': True})
        inst.IGlobal.repo.ls_files.assert_called_once_with(path=None, untracked=True)


class TestIInstanceErrors(unittest.TestCase):
    def test_git_error_returns_error_json(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.status.side_effect = GitError('repo locked')
        msg = _err(_invoke(inst, 'git.status'))
        self.assertIn('repo locked', msg)

    def test_unknown_tool_returns_error(self) -> None:
        inst = _make_instance()
        msg = _err(_invoke(inst, 'git.does_not_exist'))
        self.assertIn('Unknown tool', msg)

    def test_json_string_input_is_parsed(self) -> None:
        inst = _make_instance()
        inst.IGlobal.repo.status.return_value = {'branch': 'main', 'staged': [], 'unstaged': [], 'untracked': [], 'clean': True}
        param = MagicMock()
        param.op = 'tool.invoke'
        param.tool_name = 'git.status'
        param.input = '{}'  # string instead of dict
        inst.invoke(param)
        result = _ok(param.output)
        self.assertEqual(result['branch'], 'main')


# ---------------------------------------------------------------------------
# Integration tests — real repository
# ---------------------------------------------------------------------------

_REPO_PATH = os.getenv('GIT_TEST_REPO_PATH', '')

pytestmark_integration = pytest.mark.skipif(
    not _REPO_PATH,
    reason='GIT_TEST_REPO_PATH must be set for integration tests',
)


@pytest.mark.skipif(not _REPO_PATH, reason='GIT_TEST_REPO_PATH not set')
class TestIntegrationRealRepo(unittest.TestCase):
    def setUp(self) -> None:
        try:
            import pygit2 as _real_pygit2  # noqa: F401
        except ImportError:
            self.skipTest('pygit2 not installed — skipping integration tests')

        # Load git_repo.py directly to avoid __init__.py pulling in ai.* / rocketlib.
        import importlib.util
        from unittest.mock import MagicMock as _MM

        _depends_mock = _MM()
        _depends_mock.depends = _MM()
        with patch.dict(sys.modules, {'depends': _depends_mock}):
            spec = importlib.util.spec_from_file_location(
                '_git_repo_real',
                Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_git' / 'git_repo.py',
            )
            mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
            spec.loader.exec_module(mod)  # type: ignore[union-attr]
        _RealGitRepo = mod.GitRepo
        self._repo = _RealGitRepo(repo_path=_REPO_PATH)

    def test_status_returns_branch(self) -> None:
        result = self._repo.status()
        self.assertIn('branch', result)
        self.assertIsInstance(result['branch'], str)

    def test_log_returns_commits(self) -> None:
        commits = self._repo.log(max_count=5)
        self.assertIsInstance(commits, list)
        if commits:
            self.assertIn('sha', commits[0])
            self.assertIn('message', commits[0])

    def test_branch_list(self) -> None:
        result = self._repo.branch_list()
        self.assertIn('local', result)
        self.assertIsInstance(result['local'], list)

    def test_ls_files(self) -> None:
        result = self._repo.ls_files()
        self.assertIn('tracked', result)
        self.assertGreater(result['count'], 0)

    def test_grep_finds_results(self) -> None:
        result = self._repo.grep(pattern=r'\bdef\b', path=None)
        self.assertIsInstance(result, list)
