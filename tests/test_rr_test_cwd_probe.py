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

import importlib.util
import os
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / 'scripts' / 'lib' / 'rr_test_cwd_probe.py'
SPEC = importlib.util.spec_from_file_location('rr_test_cwd_probe', SCRIPT)
probe_mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe_mod)


class FakeBackend:
    """A backend whose handle state the test controls."""

    def __init__(self, path_for_handle):
        """
        Parameters:
            path_for_handle (callable): Returns ``(path, error)`` for the current handle.
        """
        self.handle = 0x60
        self.path_for_handle = path_for_handle
        self.reopened = 0

    def cwd_handle(self):
        return self.handle

    def reopen_cwd_handle(self, cwd):
        self.reopened += 1
        self.handle = 0x70
        return self.handle

    def final_path(self, handle):
        return self.path_for_handle(handle)

    def handle_count(self):
        return 42

    def modules(self):
        return [r'C:\fake\one.dll', r'C:\fake\two.dll']


def make_probe(tmp_path, path_for_handle):
    out = tmp_path / 'reports'
    out.mkdir()
    return probe_mod.CwdProbe(str(out), FakeBackend(path_for_handle)), out


def test_norm_strips_prefixes_and_folds_case():
    assert probe_mod._norm(r'\\?\C:\Foo\Bar') == r'c:\foo\bar'
    assert probe_mod._norm(r'\\?\UNC\srv\share\x') == r'\\srv\share\x'
    assert probe_mod._norm('c:/foo/bar/') == r'c:\foo\bar'
    assert probe_mod._norm('c:/foo/bar') == r'c:\foo\bar'


def test_same_dir_text_match_and_mismatch(tmp_path):
    assert probe_mod._same_dir(r'\\?\C:\a\b', r'c:\A\B')
    assert not probe_mod._same_dir(r'C:\a\b', r'C:\a\c')


def test_same_dir_resolves_equal_directories_by_identity(tmp_path):
    (tmp_path / 'd').mkdir()
    assert probe_mod._same_dir(str(tmp_path / 'd'), str(tmp_path / 'd' / '..' / 'd'))


def test_healthy_handle_writes_nothing(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    probe, out = make_probe(tmp_path, lambda h: (os.getcwd(), None))
    assert probe.check('manual') is False
    assert probe.occurrences == 0
    assert list(out.iterdir()) == []


def test_failed_query_writes_report_and_rearms(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    probe, out = make_probe(tmp_path, lambda h: (None, 'winerror 6') if h == 0x60 else (os.getcwd(), None))
    probe.enter('tests/test_x.py::test_a', 'call')

    assert probe.check('before call') is True

    assert probe.occurrences == 1
    assert probe.backend.reopened == 1
    [report] = list(out.iterdir())
    text = report.read_text(encoding='utf-8')
    assert 'test=tests/test_x.py::test_a phase=call' in text
    assert 'detected_by=before call' in text
    assert 'winerror 6' in text
    assert 'process_handle_count=42' in text
    assert r'C:\fake\two.dll' in text
    assert '--- thread stacks ---' in text
    assert 'Current thread' in text or 'Thread 0x' in text
    assert 're-armed: new handle 0x70' in text
    # The re-armed handle is healthy, so the next check is quiet.
    assert probe.check('thread') is False


def test_handle_reused_by_another_object_is_dead(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    probe, out = make_probe(tmp_path, lambda h: (r'C:\some\other\file.txt', None) if h == 0x60 else (os.getcwd(), None))
    assert probe.check('thread') is True
    assert 'file.txt' in next(out.iterdir()).read_text(encoding='utf-8')


def test_closes_in_quick_succession_make_one_report(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    probe, out = make_probe(tmp_path, lambda h: (None, 'winerror 6'))
    probe.check('thread')
    probe.check('thread')
    probe.check('thread')
    assert probe.occurrences == 3
    assert len(list(out.iterdir())) == 1


def test_report_count_is_capped(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(probe_mod, '_MIN_REPORT_GAP_SECS', 0)
    monkeypatch.setattr(probe_mod, '_MAX_REPORTS', 2)
    probe, out = make_probe(tmp_path, lambda h: (None, 'winerror 6'))
    for _ in range(5):
        probe.check('thread')
    assert probe.occurrences == 5
    assert len(list(out.iterdir())) == 2


def test_history_is_bounded_and_ordered(tmp_path):
    probe, _ = make_probe(tmp_path, lambda h: (os.getcwd(), None))
    for i in range(probe_mod._HISTORY_LEN + 5):
        probe.enter(f'n{i}', 'call')
    assert len(probe.history) == probe_mod._HISTORY_LEN
    assert probe.history[-1][1] == f'n{probe_mod._HISTORY_LEN + 4}'


def test_start_and_stop_write_the_armed_file(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    probe, out = make_probe(tmp_path, lambda h: (os.getcwd(), None))
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
    monkeypatch.chdir(tmp_path)

    def boom(handle):
        raise RuntimeError('boom')

    probe, _ = make_probe(tmp_path, boom)
    assert probe.check('thread') is False
