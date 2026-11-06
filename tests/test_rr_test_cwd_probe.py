# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Tests for the cwd handle probe logic (scripts/lib/rr_test_cwd_probe.py); no engine or Windows needed."""

import errno
import importlib.util
import os
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / 'scripts' / 'lib' / 'rr_test_cwd_probe.py'
SPEC = importlib.util.spec_from_file_location('rr_test_cwd_probe', SCRIPT)
probe_mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe_mod)


class FakeBackend:
    """A backend with fixed answers; the probe must not call it after start."""

    def cwd_handle(self):
        return 0x60

    def final_path(self, handle):
        return 'C:/fake', None

    def handle_count(self):
        return 42

    def modules(self):
        return ['fake_one.dll', 'fake_two.dll']


def make_probe(tmp_path, monkeypatch):
    """Create a probe whose cwd is a directory with one file."""
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'entry.txt').write_text('x')
    monkeypatch.chdir(work)
    out = tmp_path / 'reports'
    out.mkdir()
    return probe_mod.CwdProbe(str(out), FakeBackend()), out


def patch_relative_open(monkeypatch, behaviour):
    """Replace os.open so that relative names go through ``behaviour(name, real_open)``."""
    real = os.open

    def fake(path, *args, **kwargs):
        if isinstance(path, str) and not os.path.isabs(path):
            return behaviour(path, real)
        return real(path, *args, **kwargs)

    monkeypatch.setattr(os, 'open', fake)


def raise_oserror(code):
    def behaviour(name, real):
        raise OSError(code, os.strerror(code))

    return behaviour


def test_healthy_cwd_writes_nothing(tmp_path, monkeypatch):
    probe, out = make_probe(tmp_path, monkeypatch)
    assert probe.check('manual') is False
    assert probe.check('manual') is False
    assert probe.dead is False
    assert list(out.iterdir()) == []


def test_ebadf_is_dead_and_writes_one_report(tmp_path, monkeypatch):
    probe, out = make_probe(tmp_path, monkeypatch)
    probe.enter('tests/test_x.py::test_a', 'call')
    probe.start()
    patch_relative_open(monkeypatch, raise_oserror(errno.EBADF))

    assert probe.check('before call') is True
    probe.stop()

    reports = [f for f in out.iterdir() if f.name.startswith('cwd_probe_')]
    assert len(reports) == 1
    text = reports[0].read_text(encoding='utf-8')
    assert 'test=tests/test_x.py::test_a phase=call' in text
    assert 'detected_by=before call' in text
    assert 'entry.txt' in text
    assert 'process_handle_count=42' in text
    assert 'fake_two.dll' in text
    assert '--- thread stacks ---' in text
    assert 'start: handle=0x60' in text


def test_winerror_6_is_dead(tmp_path, monkeypatch):
    probe, _ = make_probe(tmp_path, monkeypatch)

    def behaviour(name, real):
        raise OSError(0, 'The handle is invalid', None, 6)

    patch_relative_open(monkeypatch, behaviour)
    assert probe.check('thread') is True


def test_handle_now_pointing_at_another_directory_is_dead(tmp_path, monkeypatch):
    probe, _ = make_probe(tmp_path, monkeypatch)
    other = tmp_path / 'other'
    other.mkdir()
    (other / 'entry.txt').write_text('y')
    patch_relative_open(
        monkeypatch, lambda name, real: real(str(other / name), os.O_RDONLY | getattr(os, 'O_BINARY', 0))
    )
    assert probe.check('thread') is True


def test_enoent_while_absolute_exists_is_dead(tmp_path, monkeypatch):
    probe, _ = make_probe(tmp_path, monkeypatch)
    patch_relative_open(monkeypatch, raise_oserror(errno.ENOENT))
    assert probe.check('thread') is True


def test_removed_entry_is_not_dead_and_is_picked_again(tmp_path, monkeypatch):
    probe, out = make_probe(tmp_path, monkeypatch)
    assert probe.check('thread') is False
    os.remove('entry.txt')
    assert probe.check('thread') is False
    Path('second.txt').write_text('z')
    assert probe.check('thread') is False
    assert probe._entry == 'second.txt'
    assert list(out.iterdir()) == []


def test_entry_is_picked_again_when_cwd_changes(tmp_path, monkeypatch):
    probe, _ = make_probe(tmp_path, monkeypatch)
    probe.check('thread')
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()
    (elsewhere / 'only.txt').write_text('1')
    monkeypatch.chdir(elsewhere)
    assert probe.check('thread') is False
    assert probe._entry == 'only.txt'


def test_relative_stat_is_not_the_test(tmp_path, monkeypatch):
    probe, _ = make_probe(tmp_path, monkeypatch)
    (tmp_path / 'work' / 'subdir').mkdir()
    assert probe.check('thread') is False
    assert probe._entry == 'entry.txt'


def test_empty_cwd_cannot_be_judged(tmp_path, monkeypatch):
    probe, _ = make_probe(tmp_path, monkeypatch)
    os.remove('entry.txt')
    assert probe.check('thread') is False
    assert probe.dead is False


def test_no_checks_after_detection(tmp_path, monkeypatch):
    probe, out = make_probe(tmp_path, monkeypatch)
    patch_relative_open(monkeypatch, raise_oserror(errno.EBADF))
    assert probe.check('thread') is True
    assert probe.check('thread') is False
    assert probe.checks == 1
    assert len([f for f in out.iterdir() if f.name.startswith('cwd_probe_')]) == 1


def test_history_is_bounded_and_ordered(tmp_path, monkeypatch):
    probe, _ = make_probe(tmp_path, monkeypatch)
    for i in range(probe_mod._HISTORY_LEN + 5):
        probe.enter(f'n{i}', 'call')
    assert len(probe.history) == probe_mod._HISTORY_LEN
    assert probe.history[-1][1] == f'n{probe_mod._HISTORY_LEN + 4}'


def test_start_and_stop_write_the_armed_file(tmp_path, monkeypatch):
    probe, out = make_probe(tmp_path, monkeypatch)
    probe.start()
    assert 'state=started' in (out / f'armed_{os.getpid()}.txt').read_text(encoding='utf-8')
    probe.stop()
    assert 'state=finished' in (out / f'armed_{os.getpid()}.txt').read_text(encoding='utf-8')


def test_enabled_needs_windows_and_the_variable(monkeypatch):
    monkeypatch.delenv('ROCKETRIDE_TEST_CWD_PROBE', raising=False)
    assert probe_mod.enabled() is False
    monkeypatch.setenv('ROCKETRIDE_TEST_CWD_PROBE', 'x')
    assert probe_mod.enabled() is (os.name == 'nt')


def test_probe_error_never_propagates(tmp_path, monkeypatch):
    probe, _ = make_probe(tmp_path, monkeypatch)

    def boom(cwd):
        raise RuntimeError('boom')

    monkeypatch.setattr(os, 'listdir', boom)
    assert probe.check('thread') is False
