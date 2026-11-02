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

"""Tests for the git ref resolver used by ``rocketride diff --git``.

The resolver is exercised against real git in isolated temporary repositories.
Only a git that cannot be started, or that hangs, is simulated.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from pipediff_git_helpers import commit_all, init_repo, isolate_git_environment, make_symlink, run_git

from rocketride.pipediff import PipeDiffError, resolve_git_ref

needs_git = pytest.mark.skipif(shutil.which('git') is None, reason='git not installed')

SAMPLE_PIPE = {
    'components': [{'id': 'a', 'provider': 'src', 'config': {}}],
    'version': 1,
}


@pytest.fixture(autouse=True)
def _hermetic_git(monkeypatch):
    # The code under test runs git too: keep it away from the developer's git
    # configuration, hooks and signing settings, and from inherited GIT_* variables.
    isolate_git_environment(monkeypatch)


# ---------------------------------------------------------------------------
# Errors from git and from the content committed at the ref
# ---------------------------------------------------------------------------


def _commit_text(tmp_path, content, name='pipeline.pipe'):
    """Commit ``content`` (text or bytes) as ``name`` in a new repository and return its path."""
    path = tmp_path / name
    path.write_bytes(content if isinstance(content, bytes) else content.encode('utf-8'))
    init_repo(tmp_path, name)
    return str(path)


def _commit_links(repo, links, *files):
    """
    Commit ``files`` and symbolic links whose text is exactly what ``links`` says.

    The links exist only in the commit, so any text can be stored whatever the platform
    would have written for it, and no permission to create links is needed.
    """
    run_git(repo, 'init', '-q')
    if files:
        run_git(repo, 'add', '--', *files)
    for name, text in links.items():
        scratch = repo / '.git' / 'link-text'
        scratch.write_bytes(text.encode('utf-8'))
        blob = run_git(repo, 'hash-object', '-w', '--no-filters', str(scratch)).stdout.strip()
        run_git(repo, 'update-index', '--add', '--cacheinfo', f'120000,{blob},{name}')
    run_git(repo, 'commit', '-q', '-m', 'links')


def _delete_object(repo, revision):
    """Delete the stored object ``revision`` names; whatever refers to it stays."""
    object_id = run_git(repo, 'rev-parse', revision).stdout.strip()
    stored = repo / '.git' / 'objects' / object_id[:2] / object_id[2:]
    stored.chmod(0o600)
    stored.unlink()


@needs_git
def test_a_ref_that_does_not_exist_is_an_error(tmp_path):
    path = _commit_text(tmp_path, json.dumps(SAMPLE_PIPE))
    with pytest.raises(PipeDiffError, match='Unknown git ref'):
        resolve_git_ref('no-such-branch', path)


@needs_git
def test_a_ref_name_that_reads_like_git_saying_a_path_is_absent_is_still_an_unknown_ref(tmp_path):
    # "the file is not in this ref" and "there is no such ref" are told apart by git's exit
    # status, not by the words in its message, which echo the ref's own name
    path = _commit_text(tmp_path, json.dumps(SAMPLE_PIPE))
    with pytest.raises(PipeDiffError, match='Unknown git ref'):
        resolve_git_ref('nope does not exist in', path)


@needs_git
def test_a_ref_that_looks_like_an_option_is_not_passed_to_git(tmp_path):
    path = _commit_text(tmp_path, json.dumps(SAMPLE_PIPE))
    written = tmp_path / 'written-by-git'
    with pytest.raises(PipeDiffError, match='Unknown git ref'):
        resolve_git_ref('--output=' + str(written), path)
    assert not written.exists()


@needs_git
def test_a_path_outside_any_repository_is_an_error(tmp_path, monkeypatch):
    monkeypatch.setenv('GIT_CEILING_DIRECTORIES', str(tmp_path.parent))  # no repository above tmp_path
    (tmp_path / 'pipeline.pipe').write_text(json.dumps(SAMPLE_PIPE), encoding='utf-8')
    with pytest.raises(PipeDiffError, match='Not a git repository'):
        resolve_git_ref('HEAD', str(tmp_path / 'pipeline.pipe'))


def test_git_that_is_not_installed_is_an_error(tmp_path, monkeypatch):
    monkeypatch.setenv('PATH', str(tmp_path))  # an empty directory: nothing named git on it
    with pytest.raises(PipeDiffError, match='git executable not found'):
        resolve_git_ref('HEAD', str(tmp_path / 'pipeline.pipe'))


@pytest.mark.parametrize(
    ('failure', 'message'),
    [
        (PermissionError(13, 'Permission denied'), 'git could not be run'),
        (OSError(8, 'Exec format error'), 'git could not be run'),
        (subprocess.TimeoutExpired(cmd='git', timeout=30), 'timed out'),
    ],
    ids=['not-executable', 'wrong-format', 'hangs'],
)
def test_git_that_cannot_start_or_never_answers_is_a_clean_error(monkeypatch, failure, message):
    # A git on PATH that cannot start, or that hangs, is not something a real repository can produce
    def fail(*_args, **_kwargs):
        raise failure

    monkeypatch.setattr(subprocess, 'run', fail)
    with pytest.raises(PipeDiffError, match=message):
        resolve_git_ref('HEAD', '/repo/pipeline.pipe')


@needs_git
def test_a_blob_git_cannot_read_is_an_error_not_an_absent_file(tmp_path):
    path = _commit_text(tmp_path, json.dumps(SAMPLE_PIPE))
    _delete_object(tmp_path, 'HEAD:pipeline.pipe')
    with pytest.raises(PipeDiffError, match='git show'):
        resolve_git_ref('HEAD', path)


@needs_git
def test_a_tree_git_cannot_list_is_an_error_not_an_absent_file(tmp_path):
    path = _commit_text(tmp_path, json.dumps(SAMPLE_PIPE))
    _delete_object(tmp_path, 'HEAD^{tree}')
    with pytest.raises(PipeDiffError, match='ls-tree'):
        resolve_git_ref('HEAD', path)


@needs_git
def test_a_file_at_the_ref_that_is_not_utf8_is_an_error(tmp_path):
    path = _commit_text(tmp_path, bytes([0xFF, 0xFE]) + b'{"components": []}')
    with pytest.raises(PipeDiffError, match='not valid UTF-8'):
        resolve_git_ref('HEAD', path)


@needs_git
def test_invalid_json_at_the_ref_is_an_error_naming_the_ref_and_path(tmp_path):
    path = _commit_text(tmp_path, '{ not json')
    with pytest.raises(PipeDiffError, match='Invalid JSON') as error:
        resolve_git_ref('HEAD', path)
    assert 'HEAD:pipeline.pipe' in str(error.value)


@needs_git
@pytest.mark.parametrize('literal', ['NaN', '-Infinity', '1e309', '-1e-400'])
def test_a_number_json_cannot_carry_at_the_ref_is_an_error_naming_the_ref(tmp_path, literal):
    path = _commit_text(tmp_path, '{"components": [{"id": "a", "config": {"value": ' + literal + '}}]}')
    with pytest.raises(PipeDiffError, match='Invalid JSON') as error:
        resolve_git_ref('HEAD', path)
    assert 'HEAD:pipeline.pipe' in str(error.value)
    assert literal in str(error.value)


@needs_git
def test_a_number_outside_the_components_is_refused_at_the_ref_too(tmp_path):
    path = _commit_text(tmp_path, '{"components": [], "project_id": 1e309}')
    with pytest.raises(PipeDiffError, match='HEAD:pipeline.pipe'):
        resolve_git_ref('HEAD', path)


@needs_git
@pytest.mark.parametrize('literal', ['0e9999', '-0e-9999', '5e-324', '1.7976931348623157e308'])
def test_supported_numbers_at_the_ref_are_read_back(tmp_path, literal):
    path = _commit_text(tmp_path, '{"components": [{"id": "a", "config": {"value": ' + literal + '}}]}')
    pipe = resolve_git_ref('HEAD', path)
    assert pipe['components'][0]['config']['value'] == float(literal)
    json.dumps(pipe, allow_nan=False)


@needs_git
def test_a_file_at_the_ref_that_is_not_a_pipe_is_an_error(tmp_path):
    path = _commit_text(tmp_path, json.dumps({'version': 1}))
    with pytest.raises(PipeDiffError, match="missing a 'components' list"):
        resolve_git_ref('HEAD', path)


# ---------------------------------------------------------------------------
# Reading a file at a ref
# ---------------------------------------------------------------------------


@needs_git
def test_resolve_git_ref_real_repository(tmp_path):
    pipe_file = tmp_path / 'pipeline.pipe'
    pipe_file.write_text(json.dumps(SAMPLE_PIPE), encoding='utf-8')
    init_repo(tmp_path, 'pipeline.pipe')

    # The committed content is returned from HEAD.
    assert resolve_git_ref('HEAD', str(pipe_file)) == SAMPLE_PIPE

    # Working-tree edits do not affect what HEAD reports.
    pipe_file.write_text(json.dumps({**SAMPLE_PIPE, 'version': 2}), encoding='utf-8')
    assert resolve_git_ref('HEAD', str(pipe_file))['version'] == 1

    # A file never committed is absent from HEAD -> None (treated as all-added).
    untracked = tmp_path / 'untracked.pipe'
    untracked.write_text(json.dumps(SAMPLE_PIPE), encoding='utf-8')
    assert resolve_git_ref('HEAD', str(untracked)) is None

    # So is a file in a directory the ref does not have.
    (tmp_path / 'newdir').mkdir()
    (tmp_path / 'newdir' / 'rag.pipe').write_text(json.dumps(SAMPLE_PIPE), encoding='utf-8')
    assert resolve_git_ref('HEAD', str(tmp_path / 'newdir' / 'rag.pipe')) is None


def _case_insensitive(path):
    """Report whether the filesystem holding ``path`` folds case."""
    probe = path / 'CaseProbe.tmp'
    probe.write_text('x', encoding='utf-8')
    try:
        return (path / 'caseprobe.tmp').exists()
    finally:
        probe.unlink()


@needs_git
def test_untracked_symlink_is_looked_up_by_its_own_path(tmp_path):
    # Documented as `git show <ref>:<FILE>`: a link that is not in the ref is new,
    # even when the file it points at is tracked.
    (tmp_path / 'pipeline.pipe').write_text(json.dumps(SAMPLE_PIPE), encoding='utf-8')
    init_repo(tmp_path, 'pipeline.pipe')
    make_symlink(tmp_path / 'link.pipe', 'pipeline.pipe')
    assert resolve_git_ref('HEAD', str(tmp_path / 'link.pipe')) is None


@needs_git
def test_tracked_symlink_resolves_to_its_target(tmp_path):
    # A committed link is read through to the file it names at the ref.
    (tmp_path / 'pipeline.pipe').write_text(json.dumps(SAMPLE_PIPE), encoding='utf-8')
    make_symlink(tmp_path / 'link.pipe', 'pipeline.pipe')
    init_repo(tmp_path, 'pipeline.pipe', 'link.pipe')
    (tmp_path / 'pipeline.pipe').write_text(json.dumps({**SAMPLE_PIPE, 'version': 2}), encoding='utf-8')
    assert resolve_git_ref('HEAD', str(tmp_path / 'link.pipe')) == SAMPLE_PIPE


@needs_git
def test_repository_reached_through_a_symlinked_directory(tmp_path):
    real = tmp_path / 'real'
    real.mkdir()
    (real / 'pipeline.pipe').write_text(json.dumps(SAMPLE_PIPE), encoding='utf-8')
    init_repo(real, 'pipeline.pipe')
    make_symlink(tmp_path / 'alias', real, directory=True)
    assert resolve_git_ref('HEAD', str(tmp_path / 'alias' / 'pipeline.pipe')) == SAMPLE_PIPE


@needs_git
def test_mis_cased_path_finds_the_tracked_file_on_a_case_insensitive_filesystem(tmp_path):
    if not _case_insensitive(tmp_path):
        pytest.skip('filesystem is case-sensitive')
    sub = tmp_path / 'Flows'
    sub.mkdir()
    (sub / 'rag.pipe').write_text(json.dumps(SAMPLE_PIPE), encoding='utf-8')
    init_repo(tmp_path, 'Flows/rag.pipe')
    # The working-tree path opens the tracked file, so it is not a new one.
    assert resolve_git_ref('HEAD', str(sub / 'RAG.pipe')) == SAMPLE_PIPE


@needs_git
def test_mis_cased_path_to_a_tracked_symlink_compares_its_target(tmp_path):
    if not _case_insensitive(tmp_path):
        pytest.skip('filesystem is case-sensitive')
    (tmp_path / 'pipeline.pipe').write_text(json.dumps(SAMPLE_PIPE), encoding='utf-8')
    make_symlink(tmp_path / 'Link.pipe', 'pipeline.pipe')
    init_repo(tmp_path, 'pipeline.pipe', 'Link.pipe')
    (tmp_path / 'pipeline.pipe').write_text(json.dumps({**SAMPLE_PIPE, 'version': 2}), encoding='utf-8')
    # Case recovery finds the tracked link; its target is compared, not its text.
    assert resolve_git_ref('HEAD', str(tmp_path / 'link.pipe')) == SAMPLE_PIPE


@needs_git
def test_differently_cased_new_file_is_new_on_a_case_sensitive_filesystem(tmp_path):
    if _case_insensitive(tmp_path):
        pytest.skip('filesystem folds case')
    (tmp_path / 'rag.pipe').write_text(json.dumps(SAMPLE_PIPE), encoding='utf-8')
    init_repo(tmp_path, 'rag.pipe')
    (tmp_path / 'RAG.pipe').write_text(json.dumps(SAMPLE_PIPE), encoding='utf-8')
    assert resolve_git_ref('HEAD', str(tmp_path / 'RAG.pipe')) is None


def _pipe_with(value):
    return {'components': [{'id': 'a', 'provider': 'src', 'config': {'value': value}}], 'version': 1}


@needs_git
def test_retargeted_symlink_compares_the_target_it_had_at_the_ref(tmp_path):
    # The old side follows the link text stored at the ref, not the link's
    # current target: a retarget from v1 to v2 is a real pipeline swap.
    (tmp_path / 'v1.pipe').write_text(json.dumps(_pipe_with(1)), encoding='utf-8')
    (tmp_path / 'v2.pipe').write_text(json.dumps(_pipe_with(2)), encoding='utf-8')
    make_symlink(tmp_path / 'current.pipe', 'v1.pipe')
    init_repo(tmp_path, 'v1.pipe', 'v2.pipe', 'current.pipe')
    (tmp_path / 'current.pipe').unlink()
    make_symlink(tmp_path / 'current.pipe', 'v2.pipe')
    assert resolve_git_ref('HEAD', str(tmp_path / 'current.pipe')) == _pipe_with(1)


@needs_git
def test_symlink_at_the_ref_is_followed_even_when_the_file_is_now_regular(tmp_path):
    (tmp_path / 'v1.pipe').write_text(json.dumps(_pipe_with(1)), encoding='utf-8')
    make_symlink(tmp_path / 'current.pipe', 'v1.pipe')
    init_repo(tmp_path, 'v1.pipe', 'current.pipe')
    (tmp_path / 'current.pipe').unlink()
    (tmp_path / 'current.pipe').write_text(json.dumps(_pipe_with(5)), encoding='utf-8')
    assert resolve_git_ref('HEAD', str(tmp_path / 'current.pipe')) == _pipe_with(1)


@needs_git
def test_symlink_at_the_ref_pointing_outside_the_repository_is_an_error(tmp_path):
    repo = tmp_path / 'repo'
    repo.mkdir()
    make_symlink(repo / 'current.pipe', '../outside.pipe')
    init_repo(repo, 'current.pipe')
    (repo / 'current.pipe').unlink()
    (repo / 'current.pipe').write_text(json.dumps(SAMPLE_PIPE), encoding='utf-8')
    with pytest.raises(PipeDiffError, match='outside the repository'):
        resolve_git_ref('HEAD', str(repo / 'current.pipe'))


@needs_git
def test_dotdot_after_a_directory_symlink_follows_the_physical_path(tmp_path):
    # The blob looked up must be the file the OS opens for this path. On POSIX
    # `lnk/..` is the parent of lnk's target (deep/), not the directory holding
    # lnk; Windows folds `..` lexically first and opens the top-level x.pipe.
    # git records no empty directory, so deep/sub must hold a tracked file to exist at the ref
    _write_pipe(tmp_path / 'deep' / 'sub' / 'y.pipe', 3)
    (tmp_path / 'x.pipe').write_text(json.dumps(_pipe_with(1)), encoding='utf-8')
    (tmp_path / 'deep' / 'x.pipe').write_text(json.dumps(_pipe_with(7)), encoding='utf-8')
    make_symlink(tmp_path / 'lnk', 'deep/sub', directory=True)
    init_repo(tmp_path, 'x.pipe', 'deep', 'lnk')
    path = str(tmp_path) + '/lnk/../x.pipe'
    with open(path, encoding='utf-8') as handle:
        opened = json.load(handle)
    assert resolve_git_ref('HEAD', path) == opened
    if os.name != 'nt':
        assert opened == _pipe_with(7)


@needs_git
@pytest.mark.parametrize('spelling', ['RepoDir/flows/rag.pipe', 'repodir/Flows/rag.pipe', 'REPODIR/FLOWS/RAG.PIPE'])
def test_mis_cased_directories_find_the_tracked_file_on_a_case_insensitive_filesystem(tmp_path, spelling):
    if not _case_insensitive(tmp_path):
        pytest.skip('filesystem is case-sensitive')
    repo = tmp_path / 'RepoDir'
    (repo / 'Flows').mkdir(parents=True)
    (repo / 'Flows' / 'rag.pipe').write_text(json.dumps(SAMPLE_PIPE), encoding='utf-8')
    init_repo(repo, 'Flows/rag.pipe')
    assert resolve_git_ref('HEAD', str(tmp_path / spelling)) == SAMPLE_PIPE


def _rename_case(path, new_name):
    """Rename ``path`` to ``new_name`` (same name, other case) the way a case-insensitive filesystem allows."""
    scratch = path.with_name('case-rename-scratch')
    os.rename(path, scratch)
    os.rename(scratch, path.with_name(new_name))


def _write_pipe(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_pipe_with(value)), encoding='utf-8')


def _read_pipe(path):
    return json.loads(path.read_text(encoding='utf-8'))


# ---------------------------------------------------------------------------
# Directory links, `..` in link text, link loops
# ---------------------------------------------------------------------------


@needs_git
def test_retargeted_directory_symlink_compares_the_directory_it_had_at_the_ref(tmp_path):
    # `flows -> flows_v1` repointed to flows_v2 is the directory-level version of
    # the current.pipe retarget: the pipeline on disk is v2's, the old side must
    # be what flows/rag.pipe was at the ref (v1's), not flows_v2's copy at the ref
    _write_pipe(tmp_path / 'flows_v1' / 'rag.pipe', 1)
    _write_pipe(tmp_path / 'flows_v2' / 'rag.pipe', 2)
    make_symlink(tmp_path / 'flows', 'flows_v1', directory=True)
    init_repo(tmp_path, 'flows_v1', 'flows_v2', 'flows')
    (tmp_path / 'flows').unlink()
    make_symlink(tmp_path / 'flows', 'flows_v2', directory=True)

    path = tmp_path / 'flows' / 'rag.pipe'
    assert _read_pipe(path) == _pipe_with(2)
    assert resolve_git_ref('HEAD', str(path)) == _pipe_with(1)


@needs_git
def test_retargeted_directory_symlink_is_found_from_a_relative_path(tmp_path, monkeypatch):
    _write_pipe(tmp_path / 'flows_v1' / 'rag.pipe', 1)
    _write_pipe(tmp_path / 'flows_v2' / 'rag.pipe', 2)
    make_symlink(tmp_path / 'flows', 'flows_v1', directory=True)
    init_repo(tmp_path, 'flows_v1', 'flows_v2', 'flows')
    (tmp_path / 'flows').unlink()
    make_symlink(tmp_path / 'flows', 'flows_v2', directory=True)
    monkeypatch.chdir(tmp_path)

    assert resolve_git_ref('HEAD', os.path.join('flows', 'rag.pipe')) == _pipe_with(1)


@needs_git
def test_directory_that_is_now_a_symlink_is_still_read_as_a_directory_at_the_ref(tmp_path):
    _write_pipe(tmp_path / 'flows' / 'rag.pipe', 1)
    _write_pipe(tmp_path / 'elsewhere' / 'rag.pipe', 2)
    init_repo(tmp_path, 'flows', 'elsewhere')
    shutil.rmtree(tmp_path / 'flows')
    make_symlink(tmp_path / 'flows', 'elsewhere', directory=True)

    assert resolve_git_ref('HEAD', str(tmp_path / 'flows' / 'rag.pipe')) == _pipe_with(1)


@needs_git
def test_link_through_a_directory_link_is_not_reported_as_new(tmp_path):
    # current.pipe -> lnk/v.pipe with lnk -> real: the file is reached through a directory
    # link, so it exists at the ref and an unchanged pipeline is not reported as new
    _write_pipe(tmp_path / 'real' / 'v.pipe', 1)
    make_symlink(tmp_path / 'lnk', 'real', directory=True)
    make_symlink(tmp_path / 'current.pipe', 'lnk/v.pipe')
    git = init_repo(tmp_path, 'real', 'lnk', 'current.pipe')

    # Whatever separator the platform needed to create the link, git records slashes: the
    # ref side is the same on every platform
    assert git('ls-tree', 'HEAD', 'current.pipe').stdout.startswith('120000 blob')
    assert git('cat-file', 'blob', 'HEAD:current.pipe').stdout == 'lnk/v.pipe'
    assert _read_pipe(tmp_path / 'current.pipe') == _pipe_with(1)
    assert resolve_git_ref('HEAD', str(tmp_path / 'current.pipe')) == _pipe_with(1)


@needs_git
@pytest.mark.skipif(os.name == 'nt', reason='Windows does not resolve `..` in link text through a link the POSIX way')
def test_dotdot_in_committed_link_text_follows_the_physical_path(tmp_path):
    # current.pipe -> lnk/../x.pipe with lnk -> deep/sub: the OS opens deep/x.pipe
    # (the parent of lnk's target), not the top-level x.pipe
    _write_pipe(tmp_path / 'x.pipe', 2)
    _write_pipe(tmp_path / 'deep' / 'x.pipe', 1)
    # git records no empty directory, so deep/sub must hold a tracked file to exist at the ref
    _write_pipe(tmp_path / 'deep' / 'sub' / 'y.pipe', 3)
    make_symlink(tmp_path / 'lnk', 'deep/sub', directory=True)
    make_symlink(tmp_path / 'current.pipe', 'lnk/../x.pipe')
    init_repo(tmp_path, 'x.pipe', 'deep', 'lnk', 'current.pipe')
    _write_pipe(tmp_path / 'deep' / 'x.pipe', 2)  # the edit the diff should see

    assert _read_pipe(tmp_path / 'current.pipe') == _pipe_with(2)
    assert resolve_git_ref('HEAD', str(tmp_path / 'current.pipe')) == _pipe_with(1)


@needs_git
@pytest.mark.skipif(os.name == 'nt', reason='Windows folds `..` in link text as text before it reaches a link')
def test_dotdot_in_committed_link_text_can_climb_back_to_the_repository_root(tmp_path):
    # current.pipe -> lnk/../../x.pipe with lnk -> deep/sub: the two `..` leave deep/sub and deep
    _write_pipe(tmp_path / 'x.pipe', 1)
    _write_pipe(tmp_path / 'deep' / 'x.pipe', 2)
    _write_pipe(tmp_path / 'deep' / 'sub' / 'y.pipe', 3)
    make_symlink(tmp_path / 'lnk', 'deep/sub', directory=True)
    make_symlink(tmp_path / 'current.pipe', 'lnk/../../x.pipe')
    init_repo(tmp_path, 'x.pipe', 'deep', 'lnk', 'current.pipe')
    _write_pipe(tmp_path / 'x.pipe', 9)

    assert resolve_git_ref('HEAD', str(tmp_path / 'current.pipe')) == _pipe_with(1)


@needs_git
def test_file_that_is_now_a_symlink_is_still_read_as_a_file_at_the_ref(tmp_path):
    _write_pipe(tmp_path / 'current.pipe', 1)
    _write_pipe(tmp_path / 'other.pipe', 9)
    init_repo(tmp_path, 'current.pipe', 'other.pipe')
    (tmp_path / 'current.pipe').unlink()
    make_symlink(tmp_path / 'current.pipe', 'other.pipe')

    assert resolve_git_ref('HEAD', str(tmp_path / 'current.pipe')) == _pipe_with(1)


@needs_git
def test_dotdot_after_a_directory_symlink_in_a_relative_path(tmp_path, monkeypatch):
    # git records no empty directory, so deep/sub must hold a tracked file to exist at the ref
    _write_pipe(tmp_path / 'deep' / 'sub' / 'y.pipe', 3)
    _write_pipe(tmp_path / 'x.pipe', 1)
    _write_pipe(tmp_path / 'deep' / 'x.pipe', 7)
    make_symlink(tmp_path / 'lnk', 'deep/sub', directory=True)
    init_repo(tmp_path, 'x.pipe', 'deep', 'lnk')
    monkeypatch.chdir(tmp_path)
    path = os.path.join('lnk', os.pardir, 'x.pipe')

    opened = _read_pipe(Path(path))
    assert resolve_git_ref('HEAD', path) == opened
    if os.name != 'nt':
        assert opened == _pipe_with(7)


@needs_git
@pytest.mark.parametrize('shape', ['two-cycle', 'self-link', 'self-nesting-directory'])
def test_symlink_loop_at_the_ref_is_a_clear_error(tmp_path, shape):
    if shape == 'two-cycle':
        make_symlink(tmp_path / 'a.pipe', 'b.pipe')
        make_symlink(tmp_path / 'b.pipe', 'a.pipe')
        names = ['a.pipe', 'b.pipe']
    elif shape == 'self-link':
        make_symlink(tmp_path / 'a.pipe', 'a.pipe')
        names = ['a.pipe']
    else:
        make_symlink(tmp_path / 'a.pipe', 'a.pipe/a.pipe', directory=True)
        names = ['a.pipe']
    init_repo(tmp_path, *names)

    with pytest.raises(PipeDiffError, match='too many levels of symbolic links'):
        resolve_git_ref('HEAD', str(tmp_path / 'a.pipe'))


@needs_git
def test_link_to_a_file_that_was_absent_at_the_ref_is_new(tmp_path):
    make_symlink(tmp_path / 'current.pipe', 'gone.pipe')
    init_repo(tmp_path, 'current.pipe')

    assert resolve_git_ref('HEAD', str(tmp_path / 'current.pipe')) is None


@needs_git
def test_directory_that_was_a_file_at_the_ref_is_new(tmp_path):
    (tmp_path / 'flows').write_text('not a directory', encoding='utf-8')
    init_repo(tmp_path, 'flows')
    (tmp_path / 'flows').unlink()
    _write_pipe(tmp_path / 'flows' / 'rag.pipe', 1)

    assert resolve_git_ref('HEAD', str(tmp_path / 'flows' / 'rag.pipe')) is None


@needs_git
def test_directory_link_whose_target_was_absent_at_the_ref_is_new(tmp_path):
    # At the ref `flows` was a link to a directory that did not exist; the
    # pipeline in the real `flows/` directory now is therefore new
    _write_pipe(tmp_path / 'keep.pipe', 1)
    make_symlink(tmp_path / 'flows', 'gone', directory=True)
    init_repo(tmp_path, 'keep.pipe', 'flows')
    (tmp_path / 'flows').unlink()
    _write_pipe(tmp_path / 'flows' / 'rag.pipe', 2)

    assert resolve_git_ref('HEAD', str(tmp_path / 'flows' / 'rag.pipe')) is None


def _retargeted_directory_link_repo(tmp_path):
    """Commit `flows -> flows_v1` beside a tracked sub/, then repoint the link to flows_v2 on disk."""
    _write_pipe(tmp_path / 'flows_v1' / 'rag.pipe', 1)
    _write_pipe(tmp_path / 'flows_v2' / 'rag.pipe', 2)
    _write_pipe(tmp_path / 'sub' / 'keep.pipe', 3)
    make_symlink(tmp_path / 'flows', 'flows_v1', directory=True)
    init_repo(tmp_path, 'flows_v1', 'flows_v2', 'sub', 'flows')
    (tmp_path / 'flows').unlink()
    make_symlink(tmp_path / 'flows', 'flows_v2', directory=True)


@needs_git
def test_directory_link_retarget_is_seen_through_dotdot_after_a_real_directory(tmp_path, monkeypatch):
    # `sub/../flows/rag.pipe` is `flows/rag.pipe`: the verdict must not depend on how
    # the same file is spelled, nor on the working directory
    _retargeted_directory_link_repo(tmp_path)

    assert resolve_git_ref('HEAD', str(tmp_path / 'sub' / '..' / 'flows' / 'rag.pipe')) == _pipe_with(1)
    monkeypatch.chdir(tmp_path / 'sub')
    assert resolve_git_ref('HEAD', os.path.join(os.pardir, 'flows', 'rag.pipe')) == _pipe_with(1)
    assert resolve_git_ref('HEAD', os.path.join('.', os.pardir, 'flows', '.', 'rag.pipe')) == _pipe_with(1)


@needs_git
@pytest.mark.parametrize('directory', ['d[1]', ':(top)x', 'with space'], ids=['glob', 'pathspec-magic', 'space'])
@pytest.mark.skipif(os.name == 'nt', reason='Windows file names cannot hold ":", "[" patterns the same way')
def test_directory_names_that_look_like_patterns_are_taken_literally(tmp_path, directory):
    # A directory named like a glob, or like pathspec magic, is an ordinary name
    _write_pipe(tmp_path / directory / '*a?.pipe', 1)
    _write_pipe(tmp_path / 'other' / '*a?.pipe', 2)
    init_repo(tmp_path, directory, 'other')

    assert resolve_git_ref('HEAD', str(tmp_path / directory / '*a?.pipe')) == _pipe_with(1)


@needs_git
def test_typed_component_after_a_link_keeps_its_case_recovery(tmp_path):
    # lnk -> Flows is committed; `lnk/RAG.pipe` types the file after the link in
    # another case, which is still the tracked Flows/rag.pipe on this filesystem
    if not _case_insensitive(tmp_path):
        pytest.skip('filesystem is case-sensitive')
    _write_pipe(tmp_path / 'Flows' / 'rag.pipe', 1)
    make_symlink(tmp_path / 'lnk', 'Flows', directory=True)
    init_repo(tmp_path, 'Flows', 'lnk')

    assert resolve_git_ref('HEAD', str(tmp_path / 'lnk' / 'RAG.pipe')) == _pipe_with(1)
    assert resolve_git_ref('HEAD', str(tmp_path / 'LNK' / 'RAG.pipe')) == _pipe_with(1)


# ---------------------------------------------------------------------------
# Case: every component is recovered from the ref's tree
# ---------------------------------------------------------------------------


@needs_git
@pytest.mark.parametrize(
    ('tracked', 'renamed_to', 'typed'),
    [
        ('Flows/rag.pipe', {'Flows': 'flows'}, 'flows/rag.pipe'),
        ('Flows/rag.pipe', {'Flows': 'flows'}, 'FLOWS/RAG.PIPE'),
        ('Outer/Flows/rag.pipe', {'Outer': 'outer', 'Outer/Flows': 'flows'}, 'outer/flows/rag.pipe'),
        ('Flows/rag.pipe', {'Flows/rag.pipe': 'RAG.pipe'}, 'Flows/rag.pipe'),
    ],
    ids=['directory', 'directory-typed-upper', 'two-directories', 'file'],
)
def test_case_only_rename_on_disk_still_finds_the_tracked_file(tmp_path, tracked, renamed_to, typed):
    # git status stays clean after a case-only rename on a case-insensitive
    # filesystem, so the file on disk IS the tracked file: nothing is "new"
    if not _case_insensitive(tmp_path):
        pytest.skip('filesystem is case-sensitive')
    _write_pipe(tmp_path / tracked, 1)
    init_repo(tmp_path, tracked.split('/')[0])
    for old, new in sorted(renamed_to.items(), key=lambda item: item[0].count('/'), reverse=True):
        _rename_case(tmp_path / old, new)

    assert resolve_git_ref('HEAD', str(tmp_path / typed)) == _pipe_with(1)


@needs_git
def test_tracked_link_is_followed_by_the_ref_even_when_it_is_now_a_regular_file_under_another_case(tmp_path):
    # The tree entry at the ref decides whether the content is a link, also after
    # the spelling was recovered: Link.pipe is a link there, a regular file now
    if not _case_insensitive(tmp_path):
        pytest.skip('filesystem is case-sensitive')
    _write_pipe(tmp_path / 'Flows' / 'v1.pipe', 1)
    make_symlink(tmp_path / 'Flows' / 'Link.pipe', 'v1.pipe')
    init_repo(tmp_path, 'Flows')
    (tmp_path / 'Flows' / 'Link.pipe').unlink()
    _write_pipe(tmp_path / 'Flows' / 'Link.pipe', 5)

    assert resolve_git_ref('HEAD', str(tmp_path / 'flows' / 'link.pipe')) == _pipe_with(1)


@needs_git
def test_differently_cased_directory_is_new_on_a_case_sensitive_filesystem(tmp_path):
    if _case_insensitive(tmp_path):
        pytest.skip('filesystem folds case')
    _write_pipe(tmp_path / 'Flows' / 'rag.pipe', 1)
    init_repo(tmp_path, 'Flows')
    _write_pipe(tmp_path / 'flows' / 'rag.pipe', 2)  # a different, untracked directory

    assert resolve_git_ref('HEAD', str(tmp_path / 'flows' / 'rag.pipe')) is None
    assert resolve_git_ref('HEAD', str(tmp_path / 'Flows' / 'rag.pipe')) == _pipe_with(1)


# ---------------------------------------------------------------------------
# Links that leave the repository: an absolute link, or one that climbs out and comes back
#
# At the ref, link text is read where the checkout lives now: the part outside the
# repository is followed on disk until the path is back at the repository root, and the
# rest is looked up in the tree at the ref again.
# ---------------------------------------------------------------------------


@needs_git
def test_absolute_link_into_the_repository_is_read_at_the_ref(tmp_path):
    _write_pipe(tmp_path / 'real' / 'v.pipe', 1)
    make_symlink(tmp_path / 'abs.pipe', tmp_path / 'real' / 'v.pipe')
    init_repo(tmp_path, 'real', 'abs.pipe')
    _write_pipe(tmp_path / 'real' / 'v.pipe', 2)  # the edit the diff should see

    assert _read_pipe(tmp_path / 'abs.pipe') == _pipe_with(2)
    assert resolve_git_ref('HEAD', str(tmp_path / 'abs.pipe')) == _pipe_with(1)


@needs_git
def test_absolute_directory_link_into_the_repository_keeps_the_rest_of_the_path(tmp_path):
    # cur.pipe -> absdir/v.pipe with absdir -> <repo>/real: the path after the directory link is kept
    _write_pipe(tmp_path / 'real' / 'v.pipe', 1)
    make_symlink(tmp_path / 'absdir', tmp_path / 'real', directory=True)
    make_symlink(tmp_path / 'cur.pipe', 'absdir/v.pipe')
    init_repo(tmp_path, 'real', 'absdir', 'cur.pipe')
    _write_pipe(tmp_path / 'real' / 'v.pipe', 2)

    assert _read_pipe(tmp_path / 'cur.pipe') == _pipe_with(2)
    assert resolve_git_ref('HEAD', str(tmp_path / 'cur.pipe')) == _pipe_with(1)
    assert resolve_git_ref('HEAD', str(tmp_path / 'absdir' / 'v.pipe')) == _pipe_with(1)


@needs_git
def test_link_that_climbs_out_of_the_repository_and_comes_back_is_read_at_the_ref(tmp_path):
    repo = tmp_path / 'repo'
    _write_pipe(repo / 'v1.pipe', 1)
    make_symlink(repo / 'cur.pipe', '../repo/v1.pipe')
    init_repo(repo, 'v1.pipe', 'cur.pipe')
    _write_pipe(repo / 'v1.pipe', 2)

    assert _read_pipe(repo / 'cur.pipe') == _pipe_with(2)
    assert resolve_git_ref('HEAD', str(repo / 'cur.pipe')) == _pipe_with(1)


@needs_git
def test_nested_link_that_climbs_out_of_the_repository_and_comes_back_is_read_at_the_ref(tmp_path):
    repo = tmp_path / 'repo'
    _write_pipe(repo / 'sub' / 'v1.pipe', 1)
    make_symlink(repo / 'sub' / 'cur.pipe', '../../repo/sub/v1.pipe')
    init_repo(repo, 'sub')
    _write_pipe(repo / 'sub' / 'v1.pipe', 2)

    assert _read_pipe(repo / 'sub' / 'cur.pipe') == _pipe_with(2)
    assert resolve_git_ref('HEAD', str(repo / 'sub' / 'cur.pipe')) == _pipe_with(1)


@needs_git
def test_path_that_comes_back_in_is_read_through_the_ref_not_the_working_tree_links(tmp_path):
    # Outside the repository only the disk can say where the path goes; once back inside,
    # `lnk` is the link as committed (-> d1), not as it is now (-> d2)
    repo = tmp_path / 'repo'
    _write_pipe(repo / 'd1' / 'v.pipe', 1)
    _write_pipe(repo / 'd2' / 'v.pipe', 2)
    make_symlink(repo / 'lnk', 'd1', directory=True)
    make_symlink(repo / 'cur.pipe', '../repo/lnk/v.pipe')
    init_repo(repo, 'd1', 'd2', 'lnk', 'cur.pipe')
    (repo / 'lnk').unlink()
    make_symlink(repo / 'lnk', 'd2', directory=True)

    assert _read_pipe(repo / 'cur.pipe') == _pipe_with(2)
    assert resolve_git_ref('HEAD', str(repo / 'cur.pipe')) == _pipe_with(1)


@needs_git
@pytest.mark.parametrize('where', ['climbs-to-a-sibling', 'absolute-elsewhere', 'climbs-into-nothing'])
def test_link_that_never_comes_back_is_an_error(tmp_path, where):
    repo = tmp_path / 'repo'
    _write_pipe(tmp_path / 'sibling' / 'x.pipe', 9)
    target = {
        'climbs-to-a-sibling': '../sibling/x.pipe',
        'absolute-elsewhere': str(tmp_path / 'sibling' / 'x.pipe'),
        'climbs-into-nothing': '../no-such-directory/x.pipe',
    }[where]
    repo.mkdir()
    make_symlink(repo / 'cur.pipe', target)
    init_repo(repo, 'cur.pipe')

    with pytest.raises(PipeDiffError, match='outside the repository'):
        resolve_git_ref('HEAD', str(repo / 'cur.pipe'))


@needs_git
def test_absolute_link_to_itself_is_a_loop_error_not_a_hang(tmp_path):
    make_symlink(tmp_path / 'loop.pipe', tmp_path / 'loop.pipe')
    init_repo(tmp_path, 'loop.pipe')

    with pytest.raises(PipeDiffError, match='too many levels of symbolic links'):
        resolve_git_ref('HEAD', str(tmp_path / 'loop.pipe'))


@needs_git
def test_chain_of_links_across_a_directory_link_is_followed_to_the_end(tmp_path):
    # c.pipe -> b.pipe -> lnk/a.pipe, with lnk -> real: every hop is a committed link
    _write_pipe(tmp_path / 'real' / 'a.pipe', 1)
    make_symlink(tmp_path / 'lnk', 'real', directory=True)
    make_symlink(tmp_path / 'b.pipe', 'lnk/a.pipe')
    make_symlink(tmp_path / 'c.pipe', 'b.pipe')
    init_repo(tmp_path, 'real', 'lnk', 'b.pipe', 'c.pipe')
    _write_pipe(tmp_path / 'real' / 'a.pipe', 2)

    assert resolve_git_ref('HEAD', str(tmp_path / 'c.pipe')) == _pipe_with(1)


@needs_git
def test_directory_link_that_climbs_out_and_comes_back_keeps_the_rest_of_the_path(tmp_path):
    # up -> ../repo/deep is a directory link written through the repository's own path: typed
    # `up/x.pipe` is deep/x.pipe at the ref
    repo = tmp_path / 'repo'
    _write_pipe(repo / 'deep' / 'x.pipe', 1)
    make_symlink(repo / 'up', '../repo/deep', directory=True)
    make_symlink(repo / 'whole', '../repo', directory=True)
    init_repo(repo, 'deep', 'up', 'whole')
    _write_pipe(repo / 'deep' / 'x.pipe', 2)

    assert _read_pipe(repo / 'up' / 'x.pipe') == _pipe_with(2)
    assert resolve_git_ref('HEAD', str(repo / 'up' / 'x.pipe')) == _pipe_with(1)
    assert resolve_git_ref('HEAD', str(repo / 'whole' / 'deep' / 'x.pipe')) == _pipe_with(1)


@needs_git
def test_typed_path_that_climbs_out_of_the_repository_and_back_is_the_same_file(tmp_path):
    repo = tmp_path / 'repo'
    _write_pipe(repo / 'x.pipe', 1)
    init_repo(repo, 'x.pipe')
    _write_pipe(repo / 'x.pipe', 2)

    assert resolve_git_ref('HEAD', str(repo) + '/../repo/x.pipe') == _pipe_with(1)
    assert resolve_git_ref('HEAD', str(repo / 'x.pipe')) == _pipe_with(1)


@needs_git
def test_typed_path_that_climbs_out_and_goes_elsewhere_is_an_error(tmp_path):
    repo = tmp_path / 'repo'
    _write_pipe(repo / 'x.pipe', 1)
    _write_pipe(tmp_path / 'elsewhere' / 'x.pipe', 3)
    init_repo(repo, 'x.pipe')

    with pytest.raises(PipeDiffError):
        resolve_git_ref('HEAD', str(repo) + '/../elsewhere/x.pipe')


@needs_git
@pytest.mark.skipif(os.name == 'nt', reason='Windows folds `..` as text before it reaches a link')
def test_typed_dotdot_after_a_retargeted_directory_link_means_the_link_as_committed(tmp_path):
    # lnk -> deep/sub at the ref, deep2/sub now. `lnk/../x.pipe` then opens deep2/x.pipe, but at the
    # ref the same words named deep/x.pipe, and that is the old side.
    _write_pipe(tmp_path / 'deep' / 'x.pipe', 1)
    _write_pipe(tmp_path / 'deep' / 'sub' / 'y.pipe', 5)
    _write_pipe(tmp_path / 'deep2' / 'x.pipe', 9)
    _write_pipe(tmp_path / 'deep2' / 'sub' / 'z.pipe', 6)
    make_symlink(tmp_path / 'lnk', 'deep/sub', directory=True)
    init_repo(tmp_path, 'deep', 'deep2', 'lnk')
    (tmp_path / 'lnk').unlink()
    make_symlink(tmp_path / 'lnk', 'deep2/sub', directory=True)
    path = str(tmp_path) + '/lnk/../x.pipe'

    assert json.loads(Path(path).read_text(encoding='utf-8')) == _pipe_with(9)
    assert resolve_git_ref('HEAD', path) == _pipe_with(1)


@needs_git
@pytest.mark.skipif(os.name == 'nt', reason='$PWD is a POSIX shell variable')
def test_relative_path_inside_a_retargeted_directory_link_means_the_link_as_committed(tmp_path, monkeypatch):
    # `cd cur` (cur was v1dir at the ref, v2dir now), then `rocketride diff --git HEAD rag.pipe`:
    # os.getcwd() names v2dir, the shell's $PWD names cur - the words the user typed
    _write_pipe(tmp_path / 'v1dir' / 'rag.pipe', 1)
    _write_pipe(tmp_path / 'v2dir' / 'rag.pipe', 2)
    make_symlink(tmp_path / 'cur', 'v1dir', directory=True)
    init_repo(tmp_path, 'v1dir', 'v2dir', 'cur')
    (tmp_path / 'cur').unlink()
    make_symlink(tmp_path / 'cur', 'v2dir', directory=True)
    monkeypatch.chdir(tmp_path / 'cur')
    monkeypatch.setenv('PWD', str(tmp_path / 'cur'))

    assert os.path.basename(os.getcwd()) == 'v2dir'
    assert resolve_git_ref('HEAD', 'rag.pipe') == _pipe_with(1)


@needs_git
@pytest.mark.skipif(os.name == 'nt', reason='$PWD is a POSIX shell variable')
@pytest.mark.parametrize('stale', ['elsewhere', 'missing', 'relative/path', ''])
def test_pwd_that_does_not_name_the_working_directory_is_ignored(tmp_path, monkeypatch, stale):
    # A stale or foreign $PWD must not move the lookup: only the directory os.getcwd() names counts
    _write_pipe(tmp_path / 'rag.pipe', 1)
    (tmp_path / 'elsewhere').mkdir()
    init_repo(tmp_path, 'rag.pipe')
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv('PWD', str(tmp_path / stale) if stale in ('elsewhere', 'missing') else stale)

    assert resolve_git_ref('HEAD', 'rag.pipe') == _pipe_with(1)


@pytest.mark.skipif(os.name == 'nt', reason='Windows cannot remove the working directory of a running process')
def test_resolve_git_ref_from_a_working_directory_that_is_gone(tmp_path, monkeypatch):
    gone = tmp_path / 'gone'
    gone.mkdir()
    monkeypatch.chdir(gone)
    gone.rmdir()

    with pytest.raises(PipeDiffError, match='working directory is gone'):
        resolve_git_ref('HEAD', 'rag.pipe')


# ---------------------------------------------------------------------------
# Link text written for another platform
#
# Committed link text is read the way the platform running the diff reads it. The links
# below exist only in the commit, so each platform can store the same text.
# ---------------------------------------------------------------------------


@needs_git
def test_backslash_in_link_text_separates_components_only_on_windows(tmp_path):
    _write_pipe(tmp_path / 'real' / 'v.pipe', 1)
    _commit_links(tmp_path, {'lnk': 'real', 'cur.pipe': 'lnk' + chr(92) + 'v.pipe'}, 'real')

    found = resolve_git_ref('HEAD', str(tmp_path / 'cur.pipe'))

    # Elsewhere the backslash belongs to the name, and no such name is in the tree
    assert found == (_pipe_with(1) if os.name == 'nt' else None)


@needs_git
@pytest.mark.parametrize(
    'target',
    ['C:/Users/me/repo/v.pipe', 'C:' + chr(92) + 'Users' + chr(92) + 'me' + chr(92) + 'repo' + chr(92) + 'v.pipe'],
    ids=['slashes', 'backslashes'],
)
def test_link_text_starting_with_a_drive_letter_is_absolute_only_on_windows(tmp_path, target):
    _commit_links(tmp_path, {'cur.pipe': target})

    if os.name == 'nt':
        with pytest.raises(PipeDiffError, match='outside the repository'):
            resolve_git_ref('HEAD', str(tmp_path / 'cur.pipe'))
    else:
        # Elsewhere "C:" is an ordinary directory name, and the tree has no such directory
        assert resolve_git_ref('HEAD', str(tmp_path / 'cur.pipe')) is None


# ---------------------------------------------------------------------------
# Case recovery and links (on filesystems that fold case)
# ---------------------------------------------------------------------------


@needs_git
def test_link_text_is_taken_as_committed_not_case_recovered(tmp_path):
    # The text of a committed link names its target exactly: `real` is not `REAL`, also
    # on a volume that folds case for the paths a person types
    if not _case_insensitive(tmp_path):
        pytest.skip('filesystem is case-sensitive')
    _write_pipe(tmp_path / 'real' / 'v.pipe', 1)
    make_symlink(tmp_path / 'cur.pipe', 'REAL/v.pipe')
    init_repo(tmp_path, 'real', 'cur.pipe')

    assert resolve_git_ref('HEAD', str(tmp_path / 'cur.pipe')) is None


@needs_git
def test_untracked_differently_cased_link_to_a_tracked_file_is_new(tmp_path):
    # RAG.pipe -> rag.pipe is a link nobody committed: it is new, not the tracked file it points at.
    # (On a volume that folds case the two names are one entry and cannot coexist.)
    if _case_insensitive(tmp_path):
        pytest.skip('RAG.pipe and rag.pipe cannot both exist on a filesystem that folds case')
    _write_pipe(tmp_path / 'rag.pipe', 1)
    init_repo(tmp_path, 'rag.pipe')
    make_symlink(tmp_path / 'RAG.pipe', 'rag.pipe')

    assert resolve_git_ref('HEAD', str(tmp_path / 'RAG.pipe')) is None
    assert resolve_git_ref('HEAD', str(tmp_path / 'rag.pipe')) == _pipe_with(1)


@needs_git
def test_case_recovery_then_link_resolution_on_a_case_insensitive_filesystem(tmp_path):
    if not _case_insensitive(tmp_path):
        pytest.skip('filesystem is case-sensitive')
    _write_pipe(tmp_path / 'Flows' / 'real' / 'v.pipe', 1)
    make_symlink(tmp_path / 'Flows' / 'Lnk', 'real', directory=True)
    init_repo(tmp_path, 'Flows')

    assert resolve_git_ref('HEAD', str(tmp_path / 'flows' / 'lnk' / 'v.pipe')) == _pipe_with(1)
    assert resolve_git_ref('HEAD', str(tmp_path / 'FLOWS' / 'LNK' / 'V.PIPE')) == _pipe_with(1)


# ---------------------------------------------------------------------------
# Awkward names: spaces, a leading dash, a newline, non-ASCII, bytes that are not UTF-8
# ---------------------------------------------------------------------------


def _name_from_bytes(raw):
    """
    A file name from its UTF-8 bytes, as a process of any filesystem encoding holds it.

    Under an ASCII filesystem encoding the name is escaped bytes, which is how argv holds one
    too, and is still created, found and compared as the same bytes.
    """
    return os.fsdecode(raw)


def _make_dir(path):
    """Create ``path``; a name this platform cannot hold skips the test (nothing else does)."""
    try:
        path.mkdir(parents=True)
    except (OSError, UnicodeEncodeError) as exc:
        # Not every platform can name every file: Windows has no newline or tab in a name, and a
        # process whose filesystem encoding is ASCII cannot spell a non-ASCII one as text
        pytest.skip(f'this process or filesystem cannot hold the name: {exc}')


@needs_git
@pytest.mark.parametrize(
    'directory',
    [
        'with space',
        ' leading space',
        '-leading-dash',
        '--option-like',
        'new' + chr(10) + 'line',
        _name_from_bytes('caf\N{LATIN SMALL LETTER E WITH ACUTE}'.encode('utf-8')),
        _name_from_bytes('caf\N{LATIN SMALL LETTER E WITH ACUTE}\N{COMBINING ACUTE ACCENT}'.encode('utf-8')),
        'tab' + chr(9) + 'tab',
        'quote"and\'apostrophe',
        '#hash',
        'back' + chr(92) + 'slash',
    ],
    ids=[
        'space',
        'leading-space',
        'leading-dash',
        'option-like',
        'newline',
        'non-ascii',
        'combining',
        'tab',
        'quotes',
        'hash',
        'backslash',
    ],
)
def test_awkward_directory_names_are_looked_up_literally(tmp_path, directory):
    # git quotes such names when it prints them for people; none of the calls here asks it to
    repo = tmp_path / 'repo'
    folder = repo / directory
    _make_dir(folder)
    _write_pipe(folder / 'rag.pipe', 1)
    _write_pipe(repo / 'other' / 'rag.pipe', 2)
    init_repo(repo, '.')

    assert resolve_git_ref('HEAD', str(folder / 'rag.pipe')) == _pipe_with(1)


@needs_git
@pytest.mark.skipif(os.name == 'nt', reason='Windows file names are text, not bytes')
def test_non_ascii_name_given_as_bytes_is_found_whatever_the_filesystem_encoding(tmp_path):
    # In a process whose filesystem encoding is ASCII (the engine's interpreter on Linux) argv holds
    # a non-ASCII name as escaped bytes; git's listing holds it as text. They are the same name.
    repo = tmp_path / 'repo'
    folder = repo / _name_from_bytes(b'caf\xc3\xa9 dir')
    _make_dir(folder)
    _write_pipe(folder / 'rag.pipe', 1)
    _write_pipe(repo / 'other' / 'rag.pipe', 2)
    init_repo(repo, '.')

    assert resolve_git_ref('HEAD', str(folder / 'rag.pipe')) == _pipe_with(1)
    # also after a link: the names in the link text are bytes too
    make_symlink(repo / 'cur.pipe', _name_from_bytes(b'caf\xc3\xa9 dir/rag.pipe'))
    commit_all(repo, 'link', 'cur.pipe')
    assert resolve_git_ref('HEAD', str(repo / 'cur.pipe')) == _pipe_with(1)


@needs_git
@pytest.mark.skipif(os.name == 'nt', reason='Windows file names are text, not bytes')
def test_a_name_that_is_not_utf8_does_not_break_a_listing_it_shares_a_directory_with(tmp_path):
    # A legacy file name (latin-1 bytes) in the same directory does not stop the lookup
    repo = tmp_path / 'repo'
    repo.mkdir()
    _write_pipe(repo / 'rag.pipe', 1)
    try:
        (repo / _name_from_bytes(b'caf\xe9.txt')).write_text('x', encoding='utf-8')
    except OSError as exc:
        pytest.skip(f'this filesystem refuses a name that is not UTF-8: {exc}')
    init_repo(repo, '.')
    _write_pipe(repo / 'rag.pipe', 2)

    assert resolve_git_ref('HEAD', str(repo / 'rag.pipe')) == _pipe_with(1)


# ---------------------------------------------------------------------------
# The fixtures themselves are hermetic
# ---------------------------------------------------------------------------


def _hostile_user_setup(tmp_path):
    """Build the git setup of a developer who signs commits, runs hooks, and is mid-hook."""
    hooks = tmp_path / 'hostile-hooks'
    hooks.mkdir()
    hook = hooks / 'pre-commit'
    hook.write_text('#!/bin/sh\nexit 1\n', encoding='utf-8')
    hook.chmod(0o755)
    config = tmp_path / 'hostile.gitconfig'
    config.write_text(
        '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent/gpg\n'
        f'[core]\n\thooksPath = {hooks.as_posix()}\n[user]\n\tuseConfigOnly = true\n',
        encoding='utf-8',
    )
    return config


def _plain_commit(repo, env):
    """Run a plain ``git commit`` that inherits whatever ``env`` carries."""
    base = {key: value for key, value in env.items() if not key.startswith('GIT_')}
    return subprocess.run(
        ['git', '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x'],
        cwd=repo,
        env={**base, 'GIT_CONFIG_GLOBAL': env['GIT_CONFIG_GLOBAL'], 'GIT_CONFIG_NOSYSTEM': '1'},
        capture_output=True,
        text=True,
        timeout=30,
        stdin=subprocess.DEVNULL,
    )


@needs_git
@pytest.mark.skipif(os.name == 'nt', reason='the hostile pre-commit hook is a POSIX shell script')
def test_fixture_commits_ignore_the_developers_signing_hooks_and_config(tmp_path, monkeypatch):
    config = _hostile_user_setup(tmp_path)
    monkeypatch.setenv('GIT_CONFIG_GLOBAL', str(config))
    # The same developer through ~/.gitconfig, for a git that has no GIT_CONFIG_GLOBAL
    monkeypatch.setenv('HOME', str(tmp_path))
    (tmp_path / '.gitconfig').write_text(config.read_text(encoding='utf-8'), encoding='utf-8')
    repo = tmp_path / 'repo'
    repo.mkdir()
    (repo / 'a.pipe').write_text(json.dumps(SAMPLE_PIPE), encoding='utf-8')

    # The control: with that setup in effect a plain commit does not succeed
    run_git(repo, 'init', '-q')
    run_git(repo, 'add', 'a.pipe')
    assert _plain_commit(repo, dict(os.environ)).returncode != 0

    # The fixture does, and the committed file is readable at HEAD
    commit_all(repo, 'init', 'a.pipe')
    assert resolve_git_ref('HEAD', str(repo / 'a.pipe')) == SAMPLE_PIPE


@needs_git
def test_fixture_commits_never_land_in_an_inherited_repository(tmp_path, monkeypatch):
    # A test run from a git hook inherits GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE of the
    # outer repository; the fixture's commits must go to its own repository, not there
    outer = tmp_path / 'outer'
    outer.mkdir()
    run_git(outer, 'init', '-q')
    monkeypatch.setenv('GIT_DIR', str(outer / '.git'))
    monkeypatch.setenv('GIT_WORK_TREE', str(outer))
    monkeypatch.setenv('GIT_INDEX_FILE', str(outer / '.git' / 'index'))
    inner = tmp_path / 'inner'
    inner.mkdir()
    (inner / 'a.pipe').write_text(json.dumps(SAMPLE_PIPE), encoding='utf-8')

    init_repo(inner, 'a.pipe')

    assert (inner / '.git').is_dir()
    assert run_git(inner, 'rev-parse', 'HEAD', check=False).returncode == 0
    assert run_git(outer, 'rev-parse', '--verify', 'HEAD', check=False).returncode != 0


@pytest.mark.skipif(os.name == 'nt', reason='the stand-in git is a POSIX shell script')
def test_fixture_git_commands_are_bounded(tmp_path, monkeypatch):
    # A git that never answers fails the test after the timeout instead of hanging the run
    stand_in = tmp_path / 'bin' / 'git'
    stand_in.parent.mkdir()
    stand_in.write_text('#!/bin/sh\nexec sleep 10\n', encoding='utf-8')
    stand_in.chmod(0o755)
    monkeypatch.setenv('PATH', str(stand_in.parent) + os.pathsep + os.environ['PATH'])
    monkeypatch.setattr('pipediff_git_helpers.GIT_TIMEOUT_SECONDS', 1)

    with pytest.raises(subprocess.TimeoutExpired):
        run_git(tmp_path, 'status')


if __name__ == '__main__':
    raise SystemExit(pytest.main([__file__, '-v']))
