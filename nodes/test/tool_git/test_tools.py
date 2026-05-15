"""
Tests for tool_git.

Unit tests mock pygit2 and run without any git binary or real repository.
Integration tests require a real git repository path via the environment variable:

    export GIT_TEST_REPO_PATH=/path/to/some/local/repo
    pytest nodes/test/tool_git/test_tools.py -v

Integration tests are automatically skipped when the variable is unset.
"""

from __future__ import annotations

import os
import sys
import tempfile
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
# Distinct class — using bare Exception would make `except pygit2.GitError`
# in IInstance._dispatch swallow KeyError/ValueError in tests.
_pygit2_stub.GitError = type('GitError', (Exception,), {})
_pygit2_stub.RemoteCallbacks = object
_pygit2_stub.Signature = MagicMock()

# Stub the two opaque modules rocketlib needs at import time:
#   - engLib: the C++ engine binding, only built into the engine runtime.
#   - depends: rocketlib's dep-bootstrapper, which writes to a Python-install-
#     adjacent cache dir (admin-only on default Windows installs). Our stub
#     turns the dep bootstrap into a no-op.
# With these in place, `import rocketlib` works and we get the real
# tool_function / normalize_tool_input / require_int / require_bool.
sys.modules['engLib'] = MagicMock()
_depends_stub = MagicMock()
_depends_stub.depends = lambda *args, **kwargs: None
sys.modules['depends'] = _depends_stub

_ai_config_stub = MagicMock()
_ai_common_stub = MagicMock()
_ai_common_stub.config = _ai_config_stub
_ai_stub = MagicMock()
_ai_stub.common = _ai_common_stub

# Make rocketlib importable from this test by adding its lib path to sys.path,
# then patch tool_git's other (still-stubbed) sibling modules.
_rocketlib_lib = Path(__file__).resolve().parents[3] / 'packages' / 'server' / 'engine-lib' / 'rocketlib-python' / 'lib'
sys.path.insert(0, str(_rocketlib_lib))

with patch.dict(
    sys.modules,
    {
        'pygit2': _pygit2_stub,
        'pygit2.credentials': _pygit2_stub,
        'ai': _ai_stub,
        'ai.common': _ai_common_stub,
        'ai.common.config': _ai_config_stub,
    },
):
    _src = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_git'
    sys.path.insert(0, str(_src.parent))
    from tool_git.git_repo import (  # noqa: E402
        GitError,
        GitRepo,
        _filter_diff_by_path,
    )
    from tool_git.IInstance import IInstance  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_instance() -> IInstance:
    """Create an IInstance with a spec-matched GitRepo mock, bypassing __init__.

    Sets ``read_only_mode = False`` on the mock so dispatch tests for write
    tools exercise the call path. Read-only-mode behavior is covered separately
    in TestReadOnlyMode.
    """
    inst = IInstance.__new__(IInstance)
    inst.IGlobal = MagicMock()
    inst.IGlobal.repo = create_autospec(GitRepo, instance=True, spec_set=True)
    inst.IGlobal.repo.read_only_mode = False
    return inst


def _invoke(inst: IInstance, tool_name: str, args: Optional[Dict[str, Any]] = None) -> Any:
    """Call the @_tool-decorated method directly and return its result.

    Tool name = method name (no ``git.`` prefix). Accepts the legacy ``git.X``
    form too so historical assertions keep working — strips the prefix.
    The framework's IInstanceBase.invoke chain isn't exercised here; we test
    each tool method as a unit.
    """
    if args is None:
        args = {}
    if tool_name.startswith('git.'):
        tool_name = tool_name[len('git.') :]
    method = getattr(inst, tool_name)
    return method(args)


def _ok(result: Any) -> Any:
    """Assert the result has no 'error' key and return it.

    Methods now return Python objects directly (the framework JSON-encodes
    them downstream), so JSON parsing is no longer needed.
    """
    if isinstance(result, dict):
        assert 'error' not in result, f'Unexpected error: {result["error"]}'
    return result


def _err(result: Any) -> str:
    """Assert the result is a dict with an 'error' key and return the message."""
    assert isinstance(result, dict), f'Expected error dict but got: {type(result).__name__}: {result!r}'
    assert 'error' in result, f'Expected error but got: {result}'
    return result['error']


# ---------------------------------------------------------------------------
# tool.query
# ---------------------------------------------------------------------------


class TestToolQuery(unittest.TestCase):
    """Tests that the framework can discover every @_tool-decorated method."""

    # Every @_tool method on IInstance, in declaration order. If you add or
    # remove a tool, update this list.
    _EXPECTED_TOOLS = (
        'clone',
        'init',
        'status',
        'log',
        'show',
        'diff',
        'blame',
        'file_at',
        'write_file',
        'stage',
        'commit',
        'stash',
        'branch_list',
        'branch_create',
        'checkout',
        'branch_delete',
        'merge',
        'fetch',
        'pull',
        'push',
        'grep',
        'ls_files',
    )

    def test_every_tool_has_meta(self) -> None:
        """Every public method on IInstance should carry __tool_meta__ for framework discovery."""
        for name in self._EXPECTED_TOOLS:
            method = getattr(IInstance, name, None)
            self.assertIsNotNone(method, f'IInstance.{name} not defined')
            self.assertTrue(
                hasattr(method, '__tool_meta__'),
                f'IInstance.{name} is missing __tool_meta__ (forgot @_tool?)',
            )

    def test_tool_meta_exposes_input_schema_and_description(self) -> None:
        """__tool_meta__ should carry both an input_schema dict and a non-empty description."""
        for name in self._EXPECTED_TOOLS:
            meta = getattr(IInstance, name).__tool_meta__
            self.assertIsInstance(meta['input_schema'], dict, f'{name}: input_schema not a dict')
            self.assertEqual(meta['input_schema'].get('type'), 'object', f'{name}: schema type != object')
            self.assertIsInstance(meta['description'], str, f'{name}: description not a string')
            self.assertGreater(len(meta['description']), 10, f'{name}: description too short')

    def test_no_legacy_dispatcher_attributes(self) -> None:
        """The old custom-dispatch surface (_TOOLS, _dispatch, _call, ...) is gone."""
        for legacy in ('_TOOLS', '_TOOL_MAP', '_WRITE_TOOLS', '_dispatch', '_call'):
            self.assertFalse(
                hasattr(IInstance, legacy),
                f'IInstance still has legacy attribute {legacy!r}',
            )


# ---------------------------------------------------------------------------
# Unit tests — IInstance routing via invoke()
# ---------------------------------------------------------------------------


class TestIInstanceStatus(unittest.TestCase):
    """Tests for git.status dispatch."""

    def test_status_returns_ok(self) -> None:
        """git.status returns branch and clean flag from the mocked repo."""
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
        """git.status returns an error JSON when no repo is loaded."""
        inst = _make_instance()
        inst.IGlobal.repo = None
        msg = _err(_invoke(inst, 'git.status'))
        self.assertIn('not initialised', msg)


class TestIInstanceLog(unittest.TestCase):
    """Tests for git.log dispatch."""

    def test_log_passes_defaults(self) -> None:
        """git.log uses max_count=20 and all-None filters when no args are given."""
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
        """git.log forwards max_count, branch, and author when supplied."""
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
    """Tests for git.show dispatch."""

    def test_show_requires_ref(self) -> None:
        """git.show returns a missing-parameter error when ref is omitted."""
        inst = _make_instance()
        msg = _err(_invoke(inst, 'git.show', {}))
        self.assertIn('Missing required parameter', msg)

    def test_show_returns_commit(self) -> None:
        """git.show forwards the ref and returns the mocked commit dict."""
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
    """Tests for git.stage dispatch."""

    def test_stage_requires_paths(self) -> None:
        """git.stage returns a validation error when paths is empty."""
        inst = _make_instance()
        msg = _err(_invoke(inst, 'git.stage', {'paths': []}))
        self.assertIn('non-empty', msg)

    def test_stage_forwards_paths(self) -> None:
        """git.stage passes the paths list through to GitRepo.stage."""
        inst = _make_instance()
        inst.IGlobal.repo.stage.return_value = {'staged': ['a.py'], 'count': 1}
        result = _ok(_invoke(inst, 'git.stage', {'paths': ['a.py']}))
        self.assertEqual(result['count'], 1)
        inst.IGlobal.repo.stage.assert_called_once_with(paths=['a.py'])


class TestIInstanceCommit(unittest.TestCase):
    """Tests for git.commit dispatch."""

    def test_commit_returns_sha(self) -> None:
        """git.commit returns the SHA from the mocked repo."""
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
        """git.commit passes author_name and author_email through to GitRepo.commit."""
        inst = _make_instance()
        inst.IGlobal.repo.commit.return_value = {'sha': 'abc', 'short_sha': 'abc', 'message': 'x', 'author': 'Bob'}
        _invoke(inst, 'git.commit', {'message': 'feat: x', 'author_name': 'Bob', 'author_email': 'bob@x.com'})
        inst.IGlobal.repo.commit.assert_called_once_with(message='feat: x', author_name='Bob', author_email='bob@x.com')


class TestIInstanceStash(unittest.TestCase):
    """Tests for git.stash dispatch."""

    def test_stash_push(self) -> None:
        """git.stash push returns 'stashed' status."""
        inst = _make_instance()
        inst.IGlobal.repo.stash.return_value = {'status': 'stashed', 'sha': 'abc', 'message': 'x'}
        result = _ok(_invoke(inst, 'git.stash', {'op': 'push'}))
        self.assertEqual(result['status'], 'stashed')

    def test_stash_list(self) -> None:
        """git.stash list returns stash count from the mocked repo."""
        inst = _make_instance()
        inst.IGlobal.repo.stash.return_value = {'stashes': [], 'count': 0}
        result = _ok(_invoke(inst, 'git.stash', {'op': 'list'}))
        self.assertEqual(result['count'], 0)


class TestIInstanceBranch(unittest.TestCase):
    """Tests for branch management dispatch (list, create, checkout, delete, merge)."""

    def test_branch_list(self) -> None:
        """git.branch_list returns local branches with remote=False by default."""
        inst = _make_instance()
        inst.IGlobal.repo.branch_list.return_value = {
            'local': [{'name': 'main', 'current': True}],
        }
        result = _ok(_invoke(inst, 'git.branch_list'))
        self.assertEqual(result['local'][0]['name'], 'main')
        inst.IGlobal.repo.branch_list.assert_called_once_with(remote=False, all_branches=False)

    def test_branch_list_remote_flag(self) -> None:
        """git.branch_list forwards remote=True when requested."""
        inst = _make_instance()
        inst.IGlobal.repo.branch_list.return_value = {'local': [], 'remote': ['origin/main']}
        _invoke(inst, 'git.branch_list', {'remote': True})
        inst.IGlobal.repo.branch_list.assert_called_once_with(remote=True, all_branches=False)

    def test_branch_create(self) -> None:
        """git.branch_create creates a branch from HEAD when from_ref is omitted."""
        inst = _make_instance()
        inst.IGlobal.repo.branch_create.return_value = {'name': 'feat/x', 'sha': 'abc123'}
        result = _ok(_invoke(inst, 'git.branch_create', {'name': 'feat/x'}))
        self.assertEqual(result['name'], 'feat/x')
        inst.IGlobal.repo.branch_create.assert_called_once_with(name='feat/x', from_ref=None)

    def test_branch_create_from_ref(self) -> None:
        """git.branch_create forwards the from_ref argument."""
        inst = _make_instance()
        inst.IGlobal.repo.branch_create.return_value = {'name': 'feat/y', 'sha': 'def456'}
        _invoke(inst, 'git.branch_create', {'name': 'feat/y', 'from_ref': 'develop'})
        inst.IGlobal.repo.branch_create.assert_called_once_with(name='feat/y', from_ref='develop')

    def test_branch_create_missing_name_raises(self) -> None:
        """git.branch_create returns a missing-parameter error when name is absent."""
        inst = _make_instance()
        msg = _err(_invoke(inst, 'git.branch_create', {}))
        self.assertIn('Missing required parameter', msg)

    def test_checkout(self) -> None:
        """git.checkout returns the checked-out branch name."""
        inst = _make_instance()
        inst.IGlobal.repo.checkout.return_value = {'branch': 'feat/x', 'sha': 'abc123'}
        result = _ok(_invoke(inst, 'git.checkout', {'branch': 'feat/x'}))
        self.assertEqual(result['branch'], 'feat/x')

    def test_branch_delete(self) -> None:
        """git.branch_delete forwards name and force flag to GitRepo.branch_delete."""
        inst = _make_instance()
        inst.IGlobal.repo.branch_delete.return_value = {'deleted': 'old-branch'}
        result = _ok(_invoke(inst, 'git.branch_delete', {'name': 'old-branch', 'force': True}))
        self.assertEqual(result['deleted'], 'old-branch')
        inst.IGlobal.repo.branch_delete.assert_called_once_with(name='old-branch', force=True)

    def test_merge(self) -> None:
        """git.merge returns the merge status from the mocked repo."""
        inst = _make_instance()
        inst.IGlobal.repo.merge.return_value = {'status': 'fast_forwarded', 'branch': 'feat/x', 'sha': 'abc'}
        result = _ok(_invoke(inst, 'git.merge', {'branch': 'feat/x'}))
        self.assertEqual(result['status'], 'fast_forwarded')


class TestIInstanceRemote(unittest.TestCase):
    """Tests for remote operations dispatch (fetch, push, pull)."""

    def test_fetch_defaults(self) -> None:
        """git.fetch uses origin and no branch filter by default."""
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
        """git.fetch forwards a custom remote and branch."""
        inst = _make_instance()
        inst.IGlobal.repo.fetch.return_value = {
            'remote': 'upstream',
            'received_objects': 3,
            'indexed_objects': 3,
            'total_deltas': 0,
        }
        _invoke(inst, 'git.fetch', {'remote': 'upstream', 'branch': 'main'})
        inst.IGlobal.repo.fetch.assert_called_once_with(remote='upstream', branch='main')

    def test_push_defaults(self) -> None:
        """git.push uses origin and force=False when no args are given."""
        inst = _make_instance()
        inst.IGlobal.repo.push.return_value = {
            'remote': 'origin',
            'branch': 'main',
            'status': 'pushed',
        }
        _invoke(inst, 'git.push')
        inst.IGlobal.repo.push.assert_called_once_with(remote='origin', branch=None, force=False)

    def test_push_force_flag(self) -> None:
        """git.push forwards force=True to GitRepo.push."""
        inst = _make_instance()
        inst.IGlobal.repo.push.return_value = {'remote': 'origin', 'branch': 'main', 'status': 'pushed'}
        _invoke(inst, 'git.push', {'force': True})
        inst.IGlobal.repo.push.assert_called_once_with(remote='origin', branch=None, force=True)

    def test_pull_passes_remote(self) -> None:
        """git.pull forwards a custom remote to GitRepo.pull."""
        inst = _make_instance()
        inst.IGlobal.repo.pull.return_value = {'merge': 'fast_forwarded'}
        _invoke(inst, 'git.pull', {'remote': 'upstream'})
        inst.IGlobal.repo.pull.assert_called_once_with(remote='upstream', branch=None)


class TestIInstanceDiff(unittest.TestCase):
    """Tests for diff and inspection dispatch (diff, blame, file_at, write_file)."""

    def test_diff_staged_flag(self) -> None:
        """git.diff forwards staged=True to GitRepo.diff."""
        inst = _make_instance()
        inst.IGlobal.repo.diff.return_value = {'patch': '', 'files_changed': 0, 'insertions': 0, 'deletions': 0}
        _invoke(inst, 'git.diff', {'staged': True})
        inst.IGlobal.repo.diff.assert_called_once_with(ref_a=None, ref_b=None, path=None, staged=True)

    def test_diff_two_refs(self) -> None:
        """git.diff forwards ref_a and ref_b when both are supplied."""
        inst = _make_instance()
        inst.IGlobal.repo.diff.return_value = {
            'patch': '--- a\n+++ b\n',
            'files_changed': 1,
            'insertions': 1,
            'deletions': 0,
        }
        _invoke(inst, 'git.diff', {'ref_a': 'main', 'ref_b': 'feat/x'})
        inst.IGlobal.repo.diff.assert_called_once_with(ref_a='main', ref_b='feat/x', path=None, staged=False)

    def test_blame_forwards_args(self) -> None:
        """git.blame forwards path and ref and returns per-line attribution."""
        inst = _make_instance()
        inst.IGlobal.repo.blame.return_value = [
            {'line': 1, 'content': 'x = 1', 'sha': 'abc', 'author': 'Alice', 'date': '2026-01-01T00:00:00+00:00'}
        ]
        result = _ok(_invoke(inst, 'git.blame', {'path': 'foo.py', 'ref': 'HEAD'}))
        self.assertEqual(result[0]['author'], 'Alice')
        inst.IGlobal.repo.blame.assert_called_once_with(path='foo.py', ref='HEAD')

    def test_file_at_forwards_args(self) -> None:
        """git.file_at returns file content at the specified ref."""
        inst = _make_instance()
        inst.IGlobal.repo.file_at.return_value = {
            'path': 'README.md',
            'ref': 'HEAD',
            'sha': 'abc',
            'size': 10,
            'content': '# Hello',
        }
        result = _ok(_invoke(inst, 'git.file_at', {'path': 'README.md', 'ref': 'HEAD'}))
        self.assertEqual(result['content'], '# Hello')

    def test_write_file_forwards_args(self) -> None:
        """git.write_file writes content and returns the written status."""
        inst = _make_instance()
        inst.IGlobal.repo.write_file.return_value = {'path': 'README.md', 'size': 7, 'status': 'written'}
        result = _ok(_invoke(inst, 'git.write_file', {'path': 'README.md', 'content': '# Hello'}))
        self.assertEqual(result['status'], 'written')
        inst.IGlobal.repo.write_file.assert_called_once_with(path='README.md', content='# Hello')


class TestIInstanceSearch(unittest.TestCase):
    """Tests for search dispatch (grep, ls_files)."""

    def test_grep_forwards_args(self) -> None:
        """git.grep forwards pattern and returns matching lines."""
        inst = _make_instance()
        inst.IGlobal.repo.grep.return_value = [{'file': 'foo.py', 'line': 1, 'content': 'hello world'}]
        result = _ok(_invoke(inst, 'git.grep', {'pattern': 'hello'}))
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['file'], 'foo.py')
        inst.IGlobal.repo.grep.assert_called_once_with(
            pattern='hello', ref=None, path=None, ignore_case=False, max_results=1000
        )

    def test_grep_case_insensitive(self) -> None:
        """git.grep forwards ignore_case=True and path prefix."""
        inst = _make_instance()
        inst.IGlobal.repo.grep.return_value = []
        _invoke(inst, 'git.grep', {'pattern': 'TODO', 'ignore_case': True, 'path': 'src/'})
        inst.IGlobal.repo.grep.assert_called_once_with(
            pattern='TODO', ref=None, path='src/', ignore_case=True, max_results=1000
        )

    def test_grep_max_results_forwarded(self) -> None:
        """git.grep forwards a custom max_results value."""
        inst = _make_instance()
        inst.IGlobal.repo.grep.return_value = []
        _invoke(inst, 'git.grep', {'pattern': 'x', 'max_results': 50})
        inst.IGlobal.repo.grep.assert_called_once_with(
            pattern='x', ref=None, path=None, ignore_case=False, max_results=50
        )

    def test_grep_max_results_out_of_range(self) -> None:
        """git.grep returns an error when max_results is outside [1, 10000]."""
        inst = _make_instance()
        msg = _err(_invoke(inst, 'git.grep', {'pattern': 'x', 'max_results': 0}))
        self.assertIn('between 1 and 10000', msg)

    def test_ls_files_defaults(self) -> None:
        """git.ls_files lists tracked files with untracked=False by default."""
        inst = _make_instance()
        inst.IGlobal.repo.ls_files.return_value = {'tracked': ['a.py'], 'count': 1}
        result = _ok(_invoke(inst, 'git.ls_files'))
        self.assertEqual(result['count'], 1)
        inst.IGlobal.repo.ls_files.assert_called_once_with(path=None, untracked=False)

    def test_ls_files_with_untracked(self) -> None:
        """git.ls_files forwards untracked=True to include untracked files."""
        inst = _make_instance()
        inst.IGlobal.repo.ls_files.return_value = {'tracked': ['a.py'], 'count': 1, 'untracked': ['b.py']}
        _invoke(inst, 'git.ls_files', {'untracked': True})
        inst.IGlobal.repo.ls_files.assert_called_once_with(path=None, untracked=True)


class TestReadOnlyMode(unittest.TestCase):
    """Verify readOnlyMode blocks every mutating tool at dispatch and lets reads through."""

    def _make_readonly_instance(self) -> IInstance:
        """Build an IInstance whose mocked repo reports read_only_mode=True."""
        inst = IInstance.__new__(IInstance)
        inst.IGlobal = MagicMock()
        # Plain MagicMock (no spec_set) so we can freely set read_only_mode.
        inst.IGlobal.repo = MagicMock()
        inst.IGlobal.repo.read_only_mode = True
        return inst

    def test_commit_blocked_when_readonly(self) -> None:
        """git.commit is blocked at dispatch and returns a read-only error."""
        inst = self._make_readonly_instance()
        msg = _err(_invoke(inst, 'git.commit', {'message': 'x'}))
        self.assertIn('read-only mode', msg)
        # GitRepo method must NOT have been called.
        inst.IGlobal.repo.commit.assert_not_called()

    def test_write_file_blocked_when_readonly(self) -> None:
        """git.write_file is blocked at dispatch in read-only mode."""
        inst = self._make_readonly_instance()
        msg = _err(_invoke(inst, 'git.write_file', {'path': 'a.txt', 'content': 'x'}))
        self.assertIn('read-only mode', msg)
        inst.IGlobal.repo.write_file.assert_not_called()

    def test_push_blocked_when_readonly(self) -> None:
        """git.push (even non-force) is blocked at dispatch in read-only mode."""
        inst = self._make_readonly_instance()
        msg = _err(_invoke(inst, 'git.push'))
        self.assertIn('read-only mode', msg)
        inst.IGlobal.repo.push.assert_not_called()

    def test_branch_delete_blocked_when_readonly(self) -> None:
        """git.branch_delete is blocked at dispatch in read-only mode (force flag irrelevant)."""
        inst = self._make_readonly_instance()
        msg = _err(_invoke(inst, 'git.branch_delete', {'name': 'feat/x'}))
        self.assertIn('read-only mode', msg)
        inst.IGlobal.repo.branch_delete.assert_not_called()

    def test_checkout_blocked_when_readonly(self) -> None:
        """git.checkout is blocked at dispatch in read-only mode."""
        inst = self._make_readonly_instance()
        msg = _err(_invoke(inst, 'git.checkout', {'branch': 'main'}))
        self.assertIn('read-only mode', msg)
        inst.IGlobal.repo.checkout.assert_not_called()

    def test_clone_blocked_when_readonly(self) -> None:
        """git.clone called by the agent is blocked in read-only mode."""
        inst = self._make_readonly_instance()
        msg = _err(_invoke(inst, 'git.clone', {'url': 'https://x/y.git', 'path': '/tmp/y'}))
        self.assertIn('read-only mode', msg)
        inst.IGlobal.repo.clone.assert_not_called()

    def test_status_allowed_when_readonly(self) -> None:
        """Read-only tools (status, log, diff, etc.) succeed in read-only mode."""
        inst = self._make_readonly_instance()
        inst.IGlobal.repo.status.return_value = {
            'branch': 'main',
            'staged': [],
            'unstaged': [],
            'untracked': [],
            'clean': True,
        }
        result = _ok(_invoke(inst, 'git.status'))
        self.assertEqual(result['branch'], 'main')

    def test_grep_allowed_when_readonly(self) -> None:
        """git.grep (read-only) succeeds in read-only mode."""
        inst = self._make_readonly_instance()
        inst.IGlobal.repo.grep.return_value = []
        _ok(_invoke(inst, 'git.grep', {'pattern': 'TODO'}))
        inst.IGlobal.repo.grep.assert_called_once()

    def test_stash_list_allowed_when_readonly(self) -> None:
        """git.stash op='list' is read-only and allowed even in read-only mode."""
        inst = self._make_readonly_instance()
        inst.IGlobal.repo.stash.return_value = {'stashes': [], 'count': 0}
        result = _ok(_invoke(inst, 'git.stash', {'op': 'list'}))
        self.assertEqual(result['count'], 0)
        inst.IGlobal.repo.stash.assert_called_once()

    def test_stash_push_blocked_when_readonly(self) -> None:
        """git.stash op='push' mutates state and is blocked in read-only mode."""
        inst = self._make_readonly_instance()
        msg = _err(_invoke(inst, 'git.stash', {'op': 'push'}))
        self.assertIn('read-only mode', msg)
        inst.IGlobal.repo.stash.assert_not_called()

    def test_stash_default_op_blocked_when_readonly(self) -> None:
        """git.stash with no op defaults to 'push' (mutating) and is blocked."""
        inst = self._make_readonly_instance()
        msg = _err(_invoke(inst, 'git.stash', {}))
        self.assertIn('read-only mode', msg)
        inst.IGlobal.repo.stash.assert_not_called()

    def test_writes_allowed_when_readonly_disabled(self) -> None:
        """When read_only_mode=False, write tools dispatch normally."""
        inst = self._make_readonly_instance()
        inst.IGlobal.repo.read_only_mode = False
        inst.IGlobal.repo.commit.return_value = {
            'sha': 'abc',
            'short_sha': 'abc',
            'message': 'x',
            'author': 'A',
        }
        result = _ok(_invoke(inst, 'git.commit', {'message': 'x'}))
        self.assertEqual(result['sha'], 'abc')


class TestIInstanceErrors(unittest.TestCase):
    """Tests for error handling and edge cases in invoke() and _dispatch()."""

    def test_git_error_returns_error_json(self) -> None:
        """GitError raised by GitRepo is serialised to an error JSON response."""
        inst = _make_instance()
        inst.IGlobal.repo.status.side_effect = GitError('repo locked')
        msg = _err(_invoke(inst, 'git.status'))
        self.assertIn('repo locked', msg)

    def test_pygit2_error_is_caught_and_scrubbed(self) -> None:
        """Raw pygit2.GitError leaking from GitRepo is caught and credentials scrubbed."""
        inst = _make_instance()
        inst.IGlobal.repo.show.side_effect = _pygit2_stub.GitError(
            'failed to resolve ref at https://alice:secrettoken@github.com/foo/bar.git'
        )
        msg = _err(_invoke(inst, 'git.show', {'ref': 'HEAD'}))
        self.assertIn('failed to resolve ref', msg)
        self.assertNotIn('secrettoken', msg)
        self.assertIn('<redacted>', msg)

    # Tests removed:
    #
    # - test_unknown_tool_returns_error: unknown-tool dispatch is now a
    #   framework concern (IInstanceBase._dispatch_tool raises PreventDefault
    #   so the engine tries the next driver). tool_git no longer has its own
    #   "Unknown tool" path to test.
    #
    # - test_json_string_input_is_parsed: the old custom invoke() did
    #   json.loads on string inputs. The framework doesn't, and it appears
    #   the engine has always passed dicts in practice — there are no
    #   reproducible reports of string inputs reaching tool_git in the wild.


class TestDispatchSchemaValidation(unittest.TestCase):
    """Strict-mode validation: reject unknown args, strip envelope, merge nested input.

    Reproduces the production failure where an agent passed
    ``include_remote: true`` to ``git.branch_list`` (the schema declares
    ``remote``); the dispatcher silently dropped the unknown key and
    returned local-only branches, which the agent then misread as
    "this tool doesn't support remotes".
    """

    def test_unknown_param_returns_error_with_allowed_list(self) -> None:
        """git.branch_list with `include_remote` (not in schema) returns an error
        listing the allowed parameters so the agent can self-correct.
        """
        inst = _make_instance()
        msg = _err(_invoke(inst, 'git.branch_list', {'include_remote': True}))
        self.assertIn("unknown parameter(s) ['include_remote']", msg)
        self.assertIn('remote', msg)
        self.assertIn('all_branches', msg)
        # The repo method should NOT have been called when validation fails.
        inst.IGlobal.repo.branch_list.assert_not_called()

    def test_unknown_param_on_no_arg_tool(self) -> None:
        """Tools whose schema declares no properties also reject unknown args."""
        inst = _make_instance()
        msg = _err(_invoke(inst, 'git.status', {'foo': 1}))
        self.assertIn('takes no parameters', msg)
        inst.IGlobal.repo.status.assert_not_called()

    def test_envelope_keys_are_stripped_silently(self) -> None:
        """`input`, `repo_path`, `security_context` pass through without error."""
        inst = _make_instance()
        inst.IGlobal.repo.status.return_value = {
            'branch': 'main',
            'staged': [],
            'unstaged': [],
            'untracked': [],
            'clean': True,
        }
        result = _ok(
            _invoke(
                inst,
                'git.status',
                {'input': None, 'repo_path': '$ROCKETRIDE_GIT_REPO_PATH', 'security_context': 'x'},
            )
        )
        self.assertEqual(result['branch'], 'main')
        inst.IGlobal.repo.status.assert_called_once_with()

    def test_nested_input_dict_is_merged(self) -> None:
        """`{"input": {"remote": true}}` is unwrapped so legitimate args reach the tool."""
        inst = _make_instance()
        inst.IGlobal.repo.branch_list.return_value = {
            'local': [],
            'remote': ['origin/main'],
        }
        _ok(_invoke(inst, 'git.branch_list', {'input': {'remote': True}}))
        inst.IGlobal.repo.branch_list.assert_called_once_with(remote=True, all_branches=False)

    def test_top_level_overrides_nested_on_conflict(self) -> None:
        """Top-level keys win over nested-input keys (predictable precedence)."""
        inst = _make_instance()
        inst.IGlobal.repo.branch_list.return_value = {'local': [], 'remote': []}
        _invoke(
            inst,
            'git.branch_list',
            {'input': {'remote': False}, 'remote': True},
        )
        inst.IGlobal.repo.branch_list.assert_called_once_with(remote=True, all_branches=False)


# ---------------------------------------------------------------------------
# Path-traversal guard tests for write_file / stage
# ---------------------------------------------------------------------------


def _repo_with_workdir(workdir: str) -> GitRepo:
    """Build a GitRepo that reports *workdir* without opening a real pygit2 repo."""
    repo = GitRepo.__new__(GitRepo)
    repo._repo = MagicMock()
    repo._repo.workdir = workdir
    repo._repo_path = workdir
    repo.safe_mode = True
    return repo


class TestPathTraversalGuards(unittest.TestCase):
    """Verify write_file and stage reject paths that escape the working directory or target .git/."""

    def setUp(self) -> None:
        """Create a tmp directory to stand in for the repo working directory."""
        # Outer tmp dir gives each test (and each pytest-xdist worker) its own
        # private "outside" area. Anchoring outside.txt to the system temp root
        # caused cross-test races where one tearDown unlinked the file while
        # another test's assertion was mid-read.
        self._outer = tempfile.TemporaryDirectory()
        outer = Path(self._outer.name).resolve()
        workdir_path = outer / 'repo'
        workdir_path.mkdir()
        self._workdir = str(workdir_path)
        self._outside = outer / 'outside.txt'
        self._outside.write_text('do-not-overwrite', encoding='utf-8')

    def tearDown(self) -> None:
        """Remove the tmp directory."""
        self._outer.cleanup()

    # ----- write_file -----

    def test_write_file_rejects_parent_traversal(self) -> None:
        """write_file rejects ../ paths that resolve outside the repo working dir."""
        repo = _repo_with_workdir(self._workdir)
        with self.assertRaises(GitError) as ctx:
            repo.write_file('../outside.txt', 'malicious')
        self.assertIn('escapes the repository', str(ctx.exception))
        # Confirm the file outside the workdir was NOT touched.
        self.assertEqual(self._outside.read_text(encoding='utf-8'), 'do-not-overwrite')

    def test_write_file_rejects_absolute_path_outside_workdir(self) -> None:
        """write_file rejects an absolute path that points outside the workdir."""
        repo = _repo_with_workdir(self._workdir)
        with self.assertRaises(GitError):
            repo.write_file(str(self._outside), 'malicious')

    def test_write_file_rejects_dotgit_path(self) -> None:
        """write_file rejects paths inside the .git directory."""
        repo = _repo_with_workdir(self._workdir)
        with self.assertRaises(GitError) as ctx:
            repo.write_file('.git/config', '[core] hacked = true')
        self.assertIn('.git directory', str(ctx.exception))

    def test_write_file_accepts_normal_relative_path(self) -> None:
        """write_file writes a normal repo-relative path successfully."""
        repo = _repo_with_workdir(self._workdir)
        result = repo.write_file('subdir/file.txt', 'hello')
        self.assertEqual(result['status'], 'written')
        self.assertEqual(
            (Path(self._workdir) / 'subdir' / 'file.txt').read_text(encoding='utf-8'),
            'hello',
        )

    # ----- stage -----

    def test_stage_rejects_parent_traversal(self) -> None:
        """Stage rejects ../ paths that resolve outside the repo working dir."""
        repo = _repo_with_workdir(self._workdir)
        with self.assertRaises(GitError) as ctx:
            repo.stage(paths=['../outside.txt'])
        self.assertIn('escapes the repository', str(ctx.exception))

    def test_stage_rejects_dotgit_path(self) -> None:
        """Stage rejects paths inside the .git directory."""
        # Need an actual file at the path so the existence branch is taken,
        # otherwise stage will hit the .git guard regardless of file presence.
        dotgit = Path(self._workdir) / '.git'
        dotgit.mkdir(exist_ok=True)
        (dotgit / 'config').write_text('x', encoding='utf-8')
        repo = _repo_with_workdir(self._workdir)
        with self.assertRaises(GitError) as ctx:
            repo.stage(paths=['.git/config'])
        self.assertIn('.git directory', str(ctx.exception))


# ---------------------------------------------------------------------------
# _filter_diff_by_path
# ---------------------------------------------------------------------------


class TestFilterDiffByPath(unittest.TestCase):
    """Tests for the diff-header parsing and per-line counting in _filter_diff_by_path."""

    def test_prefix_collision_is_not_matched(self) -> None:
        """Prefix 'src' must NOT match path 'srcfoo/bar.py'."""
        patch_text = (
            'diff --git a/srcfoo/bar.py b/srcfoo/bar.py\n'
            '@@ -0,0 +1 @@\n'
            '+x\n'
            'diff --git a/src/foo.py b/src/foo.py\n'
            '@@ -0,0 +1 @@\n'
            '+y\n'
        )
        out = _filter_diff_by_path(patch_text, 'src')
        self.assertNotIn('srcfoo', out['patch'])
        self.assertIn('src/foo.py', out['patch'])
        self.assertEqual(out['files_changed'], 1)
        self.assertEqual(out['insertions'], 1)
        self.assertEqual(out['deletions'], 0)

    def test_exact_file_match(self) -> None:
        """An exact file path matches only that file."""
        patch_text = 'diff --git a/a.py b/a.py\n@@ -0,0 +1 @@\n+x\ndiff --git a/b.py b/b.py\n@@ -0,0 +1 @@\n+y\n'
        out = _filter_diff_by_path(patch_text, 'a.py')
        self.assertIn('a.py', out['patch'])
        self.assertNotIn('b.py', out['patch'])
        self.assertEqual(out['files_changed'], 1)

    def test_filename_with_spaces(self) -> None:
        """Diff header parsing captures filenames containing spaces."""
        patch_text = 'diff --git a/dir/my file.txt b/dir/my file.txt\n@@ -1 +1 @@\n-old\n+new\n'
        out = _filter_diff_by_path(patch_text, 'dir')
        self.assertIn('my file.txt', out['patch'])
        self.assertEqual(out['files_changed'], 1)
        self.assertEqual(out['insertions'], 1)
        self.assertEqual(out['deletions'], 1)

    def test_empty_patch(self) -> None:
        """An empty patch returns zero counts and an empty patch string."""
        out = _filter_diff_by_path('', 'anything')
        self.assertEqual(out['patch'], '')
        self.assertEqual(out['files_changed'], 0)
        self.assertEqual(out['insertions'], 0)
        self.assertEqual(out['deletions'], 0)

    def test_does_not_count_diff_marker_lines_as_changes(self) -> None:
        """Lines starting with '+++' or '---' are diff markers, not insertions/deletions."""
        patch_text = 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b\n'
        out = _filter_diff_by_path(patch_text, 'x.py')
        self.assertEqual(out['insertions'], 1)
        self.assertEqual(out['deletions'], 1)


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
    """Integration tests that run against a real local git repository."""

    def setUp(self) -> None:
        """Load git_repo.py directly (bypassing __init__.py) and open the real test repo."""
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
        """status() returns a branch string from the real repository."""
        result = self._repo.status()
        self.assertIn('branch', result)
        self.assertIsInstance(result['branch'], str)

    def test_log_returns_commits(self) -> None:
        """log() returns a list of commit dicts from the real repository."""
        commits = self._repo.log(max_count=5)
        self.assertIsInstance(commits, list)
        if commits:
            self.assertIn('sha', commits[0])
            self.assertIn('message', commits[0])

    def test_branch_list(self) -> None:
        """branch_list() returns at least a 'local' key from the real repository."""
        result = self._repo.branch_list()
        self.assertIn('local', result)
        self.assertIsInstance(result['local'], list)

    def test_ls_files(self) -> None:
        """ls_files() returns tracked files from the real repository."""
        result = self._repo.ls_files()
        self.assertIn('tracked', result)
        self.assertGreater(result['count'], 0)

    def test_grep_finds_results(self) -> None:
        """grep() finds 'def' keyword matches across tracked files in the real repository."""
        result = self._repo.grep(pattern=r'\bdef\b', path=None)
        self.assertIsInstance(result, list)
