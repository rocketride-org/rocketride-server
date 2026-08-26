"""Unit tests for rocketlib depends.py — the runtime dependency installer.

These exercise the pure, filesystem-level logic (requirement discovery, the
constraints cache key, the combined-requirements file, uv argument building)
without uv, pip, or a network. Every test redirects the "engine executable
directory" into ``tmp_path`` so nothing touches a real engine cache.
"""

import os
from types import SimpleNamespace

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

    def test_model_cache_dir_does_not_create_when_asked_not_to(self, exe_dir):
        path = depends.model_cache_dir('whisper', create=False)

        assert path == str(exe_dir / 'cache' / 'models' / 'whisper')
        assert not os.path.isdir(path)


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


class TestSatisfiedVerdict:
    """The resolve verdict outlives the process (#2089).

    ``_install_requirements`` is called once per cold process; a second call
    with the same requirements file, constraints and installed set must not
    resolve again, and any change to one of them must.
    """

    @pytest.fixture
    def env(self, exe_dir, monkeypatch):
        """A requirements file, its constraints, a fake site-packages, and a resolve recorder."""
        site = exe_dir / 'site-packages'
        (site / 'requests-2.32.4.dist-info').mkdir(parents=True)
        monkeypatch.setattr(depends, '_get_site_packages', lambda: str(site))
        monkeypatch.setattr(depends, 'updateProgress', lambda message: None)
        monkeypatch.setattr(depends, '_start_heartbeat', lambda: None)
        monkeypatch.setattr(depends, '_stop_heartbeat', lambda: None)

        resolves = []

        def fake_dry_run(requirements_path, constraints_path):
            resolves.append(requirements_path)
            return []  # everything already installed

        monkeypatch.setattr(depends, '_install_dry_run', fake_dry_run)

        return SimpleNamespace(
            req=_write(exe_dir / 'nodes' / 'demo' / 'requirements.txt', 'requests\n'),
            constraints=_write(exe_dir / 'cache' / 'constraints.txt', 'requests==2.32.4\n'),
            site=site,
            resolves=resolves,
        )

    @staticmethod
    def _cold_process(env, req=None):
        """One cold engine process: a fresh call into ``_install_requirements``."""
        depends._install_requirements(str(req or env.req), str(env.constraints))

    def test_second_process_skips_the_resolve(self, exe_dir, env):
        """The second process finds the verdict and never resolves."""
        self._cold_process(env)
        self._cold_process(env)

        assert len(env.resolves) == 1
        assert os.listdir(exe_dir / 'cache' / 'satisfied') != []

    def test_verdict_is_per_requirements_file(self, exe_dir, env):
        """Each requirements file gets its own verdict; neither shadows the other."""
        other = _write(exe_dir / 'nodes' / 'other' / 'requirements.txt', 'pyjwt\n')

        self._cold_process(env)
        self._cold_process(env, req=other)
        self._cold_process(env)
        self._cold_process(env, req=other)

        assert env.resolves == [str(env.req), str(other)]

    def test_requirements_change_reruns_the_resolve(self, env):
        """Editing the requirements file invalidates its verdict."""
        self._cold_process(env)
        env.req.write_text('requests\nhttpx\n', encoding='utf-8')
        self._cold_process(env)

        assert len(env.resolves) == 2

    def test_constraints_change_reruns_the_resolve(self, env):
        """A recompiled constraints file invalidates every verdict."""
        self._cold_process(env)
        env.constraints.write_text('requests==2.33.0\n', encoding='utf-8')
        self._cold_process(env)

        assert len(env.resolves) == 2

    def test_overrides_change_reruns_the_resolve(self, exe_dir, env):
        """A changed overrides file invalidates every verdict."""
        self._cold_process(env)
        _write(exe_dir / 'cache' / 'overrides-combined.txt', 'urllib3==2.5.0\n')
        self._cold_process(env)

        assert len(env.resolves) == 2

    def test_installed_set_change_reruns_the_resolve(self, env):
        """Any change to the installed dist-info set invalidates the verdict."""
        self._cold_process(env)
        # An upgrade, an uninstall or a manual install all rename a dist-info entry.
        (env.site / 'requests-2.32.4.dist-info').rename(env.site / 'requests-2.33.0.dist-info')
        self._cold_process(env)

        assert len(env.resolves) == 2

    def test_included_requirements_change_reruns_the_resolve(self, exe_dir, env):
        """A file pulled in through ``-r`` is part of the verdict, so editing it invalidates."""
        base = _write(exe_dir / 'nodes' / 'demo' / 'base.txt', 'pyjwt\n')
        env.req.write_text('-r base.txt\nrequests\n', encoding='utf-8')

        self._cold_process(env)
        self._cold_process(env)
        base.write_text('pyjwt\nhttpx\n', encoding='utf-8')
        self._cold_process(env)

        assert len(env.resolves) == 2

    def test_requirements_closure_follows_includes_once(self, exe_dir):
        """Nested and cyclic ``-r`` / ``-c`` includes each appear once, relative to the including file."""
        root = _write(exe_dir / 'nodes' / 'demo' / 'requirements.txt', '-r base.txt\nrequests\n')
        base = _write(exe_dir / 'nodes' / 'demo' / 'base.txt', '--constraint=../pins.txt\n-r requirements.txt\n')
        pins = _write(exe_dir / 'nodes' / 'pins.txt', 'pyjwt==2.13.0\n')

        assert depends._requirements_closure(str(root)) == [str(root), str(base), str(pins)]

    def test_requirements_closure_joins_continued_lines(self, exe_dir):
        """A ``-r`` directive split over a backslash continuation still names its target."""
        root = _write(exe_dir / 'nodes' / 'demo' / 'requirements.txt', '-r \\\n    base.txt\nrequests\n')
        base = _write(exe_dir / 'nodes' / 'demo' / 'base.txt', 'pyjwt\n')

        assert depends._requirements_closure(str(root)) == [str(root), str(base)]

    def test_failed_resolve_records_no_verdict(self, exe_dir, env, monkeypatch):
        """A resolve that raises leaves nothing behind, so the next process resolves again."""

        def failing_dry_run(requirements_path, constraints_path):
            env.resolves.append(requirements_path)
            raise RuntimeError('Dependency resolution failed')

        monkeypatch.setattr(depends, '_install_dry_run', failing_dry_run)

        with pytest.raises(RuntimeError):
            self._cold_process(env)
        with pytest.raises(RuntimeError):
            self._cold_process(env)

        assert len(env.resolves) == 2
        assert not (exe_dir / 'cache' / 'satisfied').exists()

    def test_unwritable_verdict_does_not_fail_the_resolve(self, exe_dir, env):
        """The verdict is best effort: a cache that cannot be written never turns success into failure."""
        _write(exe_dir / 'cache' / 'satisfied', '')  # a file where the verdict directory must go

        self._cold_process(env)
        self._cold_process(env)

        assert len(env.resolves) == 2

    def test_install_records_the_verdict_against_the_installed_set(self, env, monkeypatch):
        """A verdict written after an install must key on the post-install site-packages."""
        pending = ['httpx']

        def dry_run_then_satisfied(requirements_path, constraints_path):
            env.resolves.append(requirements_path)
            return list(pending)

        class FakeInstall:
            """Stands in for the uv install Popen: installs one dist-info, exits 0."""

            returncode = 0
            stdout = iter(())

            def __init__(self, *args, **kwargs):
                (env.site / 'httpx-0.28.1.dist-info').mkdir()
                pending.clear()

            def wait(self):
                return 0

        monkeypatch.setattr(depends, '_install_dry_run', dry_run_then_satisfied)
        monkeypatch.setattr(depends.subprocess, 'Popen', FakeInstall)

        self._cold_process(env)  # resolves, installs httpx, records the verdict
        self._cold_process(env)  # the recorded verdict matches the installed set

        assert len(env.resolves) == 1


class TestDepends:
    def test_missing_requirements_file_returns_before_bootstrapping(self, tmp_path, monkeypatch):
        monkeypatch.setattr(depends, 'bootstrap', lambda: pytest.fail('bootstrap must not run'))
        monkeypatch.setattr(depends, 'ensure_constraints', lambda: pytest.fail('constraints must not run'))

        depends.depends(str(tmp_path / 'does-not-exist.txt'))
