"""Unit tests for rocketlib depends.py — the runtime dependency installer.

These exercise the pure, filesystem-level logic (requirement discovery, the
constraints cache key, the combined-requirements file, uv argument building)
without uv, pip, or a network. Every test redirects the "engine executable
directory" into ``tmp_path`` so nothing touches a real engine cache.
"""

import os

import pytest

import depends


@pytest.fixture
def exe_dir(tmp_path, monkeypatch):
    """Point depends at a throwaway engine directory and return it."""
    monkeypatch.setattr(depends, '_get_executable_dir', lambda: str(tmp_path))
    return tmp_path


def _write(path, text='x\n'):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
    return path


class TestFindRequirementFiles:
    def test_matches_root_nodes_and_ai_globs_only(self, exe_dir):
        _write(exe_dir / 'requirements.txt')
        _write(exe_dir / 'nodes' / 'a' / 'requirements.txt')
        _write(exe_dir / 'nodes' / 'a' / 'requirements_gpu.txt')
        _write(exe_dir / 'ai' / 'x' / 'y' / 'requirements.txt')
        _write(exe_dir / 'other' / 'requirements.txt')  # outside every glob
        _write(exe_dir / 'nodes' / 'a' / 'notes.txt')  # wrong name

        found = {os.path.relpath(f, exe_dir) for f in depends._find_requirement_files()}

        assert found == {
            'requirements.txt',
            os.path.join('nodes', 'a', 'requirements.txt'),
            os.path.join('nodes', 'a', 'requirements_gpu.txt'),
            os.path.join('ai', 'x', 'y', 'requirements.txt'),
        }

    def test_returns_absolute_paths_without_duplicates(self, exe_dir):
        _write(exe_dir / 'nodes' / 'requirements.txt')

        found = depends._find_requirement_files()

        assert all(os.path.isabs(f) for f in found)
        assert len(found) == len(set(found))

    def test_empty_when_nothing_matches(self, exe_dir):
        assert depends._find_requirement_files() == []


class TestComputeHash:
    def test_stable_for_same_inputs_and_order_independent(self, tmp_path):
        a = _write(tmp_path / 'a.txt', 'one\n')
        b = _write(tmp_path / 'b.txt', 'two\n')

        assert depends._compute_hash([str(a), str(b)]) == depends._compute_hash([str(b), str(a)])

    def test_changes_when_a_file_grows(self, tmp_path):
        a = _write(tmp_path / 'a.txt', 'one\n')
        before = depends._compute_hash([str(a)])

        a.write_text('one\ntwo\n', encoding='utf-8')

        assert depends._compute_hash([str(a)]) != before

    def test_changes_when_a_file_is_added(self, tmp_path):
        a = _write(tmp_path / 'a.txt', 'one\n')
        b = _write(tmp_path / 'b.txt', 'two\n')

        assert depends._compute_hash([str(a)]) != depends._compute_hash([str(a), str(b)])


class TestCombineRequirements:
    def test_concatenates_in_order_with_source_markers(self, tmp_path):
        a = _write(tmp_path / 'a.txt', 'pkg-a\n')
        b = _write(tmp_path / 'b.txt', 'pkg-b>=1\n')
        out = tmp_path / 'combined.txt'

        depends._combine_requirements([str(a), str(b)], str(out))

        text = out.read_text(encoding='utf-8')
        assert text == f'# Source: {a}\npkg-a\n\n# Source: {b}\npkg-b>=1\n\n'
        assert text.index('pkg-a') < text.index('pkg-b')


class TestConstraintsArgs:
    def test_empty_when_constraints_missing_or_empty(self, tmp_path):
        missing = tmp_path / 'constraints.txt'
        assert depends._constraints_args(str(missing), str(tmp_path)) == []

        missing.write_text('', encoding='utf-8')
        assert depends._constraints_args(str(missing), str(tmp_path)) == []

    def test_relative_c_argument_when_constraints_present(self, tmp_path):
        constraints = _write(tmp_path / 'cache' / 'constraints.txt', 'pyjwt==2.13.0\n')

        assert depends._constraints_args(str(constraints), str(tmp_path)) == [
            '-c',
            os.path.join('cache', 'constraints.txt'),
        ]


class TestCacheDirs:
    def test_engine_cache_dir_lives_beside_the_executable(self, exe_dir):
        assert depends.engine_cache_dir() == str(exe_dir / 'cache')
        assert not (exe_dir / 'cache').exists()

        assert depends.engine_cache_dir(create=True) == str(exe_dir / 'cache')
        assert (exe_dir / 'cache').is_dir()

    def test_model_cache_dir_is_nested_under_models(self, exe_dir):
        path = depends.model_cache_dir('whisper')

        assert path == str(exe_dir / 'cache' / 'models' / 'whisper')
        assert os.path.isdir(path)


class TestWriteExcludesFile:
    # ``_write_excludes_file`` assumes the cache directory already exists: in
    # production ``depends()`` takes the install lock (which creates it) first.

    def test_always_excludes_uv(self, exe_dir, monkeypatch):
        depends.engine_cache_dir(create=True)
        monkeypatch.setattr(depends.platform, 'system', lambda: 'Darwin')

        path = depends._write_excludes_file()

        assert path == str(exe_dir / 'cache' / 'excludes.txt')
        assert (exe_dir / 'cache' / 'excludes.txt').read_text(encoding='utf-8') == 'uv\n'

    def test_excludes_plain_onnxruntime_off_darwin(self, exe_dir, monkeypatch):
        depends.engine_cache_dir(create=True)
        monkeypatch.setattr(depends.platform, 'system', lambda: 'Linux')

        depends._write_excludes_file()

        assert (exe_dir / 'cache' / 'excludes.txt').read_text(encoding='utf-8') == 'uv\nonnxruntime\n'


class TestEnsureConstraints:
    @pytest.fixture
    def compile_calls(self, monkeypatch):
        """Replace the uv compile with a recorder that writes a fake constraints file."""
        calls = []

        def fake_compile(constraints_path):
            calls.append(constraints_path)
            with open(constraints_path, 'w', encoding='utf-8') as f:
                f.write('pyjwt==2.13.0\n')

        monkeypatch.setattr(depends, '_compile_constraints', fake_compile)
        monkeypatch.setattr(depends, 'updateProgress', lambda message: None)
        return calls

    def test_no_requirement_files_means_no_compile(self, exe_dir, compile_calls):
        path = depends.ensure_constraints()

        assert path == str(exe_dir / 'cache' / 'constraints.txt')
        assert compile_calls == []

    def test_compiles_once_then_reuses_cache(self, exe_dir, compile_calls):
        _write(exe_dir / 'requirements.txt', 'pyjwt\n')

        first = depends.ensure_constraints()
        second = depends.ensure_constraints()

        assert first == second == str(exe_dir / 'cache' / 'constraints.txt')
        assert len(compile_calls) == 1
        assert (exe_dir / 'cache' / 'combined.txt').read_text(encoding='utf-8').endswith('pyjwt\n\n')

    def test_recompiles_when_a_requirement_file_changes(self, exe_dir, compile_calls):
        req = _write(exe_dir / 'requirements.txt', 'pyjwt\n')
        depends.ensure_constraints()

        req.write_text('pyjwt\nrequests\n', encoding='utf-8')
        depends.ensure_constraints()

        assert len(compile_calls) == 2

    def test_recompiles_when_constraints_file_was_deleted(self, exe_dir, compile_calls):
        _write(exe_dir / 'requirements.txt', 'pyjwt\n')
        constraints = depends.ensure_constraints()

        os.remove(constraints)
        depends.ensure_constraints()

        assert len(compile_calls) == 2


class TestInstallRequirements:
    def test_comment_only_file_is_skipped_without_installing(self, tmp_path, monkeypatch):
        req = _write(tmp_path / 'requirements.txt', '# nothing here\n\n   \n')
        monkeypatch.setattr(depends, '_start_heartbeat', lambda: pytest.fail('heartbeat must not start'))
        monkeypatch.setattr(depends, '_install_requirements_inner', lambda *a: pytest.fail('should not install'))

        depends._install_requirements(str(req), str(tmp_path / 'constraints.txt'))


class TestDepends:
    def test_missing_requirements_file_returns_before_bootstrapping(self, tmp_path, monkeypatch):
        monkeypatch.setattr(depends, 'bootstrap', lambda: pytest.fail('bootstrap must not run'))
        monkeypatch.setattr(depends, 'ensure_constraints', lambda: pytest.fail('constraints must not run'))

        depends.depends(str(tmp_path / 'does-not-exist.txt'))
