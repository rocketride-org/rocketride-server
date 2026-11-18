"""Tests for the thread-start stuck marker, the WMI query line and the install.lock journal of rr_test_stack_dumps."""

import importlib.util
import os
import re
import sys
import threading
import time
import types

import pytest

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'rr_test_stack_dumps.py')
_spec = importlib.util.spec_from_file_location('rr_test_stack_dumps_under_test', _PATH)
dumps = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dumps)

_MARKER = '=== thread start stuck'


class _NeverStarted(threading.Thread):
    """A thread whose bootstrap blocks without setting ``_started``, so ``start()`` never returns."""

    def __init__(self, release: threading.Event) -> None:
        """
        Create the thread.

        Args:
            release (threading.Event): Set to let the bootstrap finish.
        """
        super().__init__(daemon=True)
        self._release = release
        self.finished = threading.Event()

    def _bootstrap(self) -> None:
        """
        Block until released without announcing the start, then run the normal bootstrap.

        Returns:
            None
        """
        self._release.wait(30)
        super()._bootstrap()
        self.finished.set()


def _dumper(tmp_path, recheck: float = 0.3):
    """
    Build a dumper that writes to a temp file, with a short recheck delay.

    Args:
        tmp_path (pathlib.Path): Directory for the dump file.
        recheck (float): Seconds between the two samples.

    Returns:
        tuple[_Dumper, pathlib.Path]: The dumper and its file path.
    """
    path = tmp_path / 'stacks.txt'
    dumper = dumps._Dumper(open(path, 'w', encoding='utf-8'), 30, time.monotonic(), 'task')
    dumper._recheck = recheck
    return dumper, path


def _in_start(ident) -> bool:
    """
    Tell whether a thread currently waits in ``Thread.start()``.

    Args:
        ident (int | None): The thread ident.

    Returns:
        bool: True when the detector finds a ``start`` wait on that thread.
    """
    return dumps._find_start_wait(sys._current_frames().get(ident)) is not None


def _wait_until(predicate, timeout: float = 5.0) -> bool:
    """
    Poll a predicate.

    Args:
        predicate (Callable[[], bool]): The condition.
        timeout (float): Seconds to wait.

    Returns:
        bool: True when the condition became true in time.
    """
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def _release(worker, release, helper, dumper) -> None:
    """
    Let the stuck thread and its starter finish, then close the dumper.

    Args:
        worker (_NeverStarted): The thread that never announces its start.
        release (threading.Event): The event its bootstrap waits on.
        helper (threading.Thread): The thread that called ``worker.start()``.
        dumper (_Dumper): The dumper to close.
    """
    release.set()
    helper.join(5)
    worker.finished.wait(5)
    worker.join(5)
    dumper.close()
    assert not helper.is_alive()


def test_stuck_start_is_reported_once(tmp_path):
    """A thread parked in Thread.start() across both samples gets one marker; it is not repeated."""
    release = threading.Event()
    worker = _NeverStarted(release)
    helper = threading.Thread(target=worker.start, daemon=True)
    dumper, path = _dumper(tmp_path)
    try:
        helper.start()
        assert _wait_until(lambda: _in_start(helper.ident))
        dumper._dump()
        text = path.read_text(encoding='utf-8')
        assert f'{_MARKER} thread=0x{helper.ident:016x} seconds=0.3\n\n' in text
        dumper._dump()
        assert path.read_text(encoding='utf-8').count(_MARKER) == 1
    finally:
        _release(worker, release, helper, dumper)


def test_user_event_wait_and_quick_start_give_no_marker(tmp_path):
    """A user-code Event.wait() and a normal Thread.start() are not stuck starts."""
    gate = threading.Event()
    waiter = threading.Thread(target=threading.Event().wait, args=(30,), daemon=True)
    quick = threading.Thread(target=gate.wait, args=(30,), daemon=True)
    dumper, path = _dumper(tmp_path, 0.2)
    try:
        waiter.start()
        quick.start()
        dumper._dump()
        assert _MARKER not in path.read_text(encoding='utf-8')
    finally:
        gate.set()
        dumper.close()


def test_start_that_returns_between_samples_gives_no_marker(tmp_path):
    """A thread that leaves its start() call before the second sample is not reported."""
    release = threading.Event()
    worker = _NeverStarted(release)
    helper = threading.Thread(target=worker.start, daemon=True)
    dumper, path = _dumper(tmp_path, 0.5)
    try:
        helper.start()
        assert _wait_until(lambda: _in_start(helper.ident))
        timer = threading.Timer(0.15, worker._started.set)
        timer.start()
        dumper._dump()
        timer.join(5)
        assert _MARKER not in path.read_text(encoding='utf-8')
    finally:
        _release(worker, release, helper, dumper)


def test_stopped_dumper_skips_recheck(tmp_path):
    """When the dumper is stopped, the recheck wait ends at once and nothing is written."""
    release = threading.Event()
    worker = _NeverStarted(release)
    helper = threading.Thread(target=worker.start, daemon=True)
    dumper, path = _dumper(tmp_path, 30)
    try:
        helper.start()
        assert _wait_until(lambda: _in_start(helper.ident))
        dumper._stop.set()
        began = time.monotonic()
        dumper._dump()
        assert time.monotonic() - began < 5
        assert _MARKER not in path.read_text(encoding='utf-8')
    finally:
        _release(worker, release, helper, dumper)


def test_new_start_call_between_samples_gives_no_marker(tmp_path):
    """A thread that finishes one start() and enters another between samples is not the same stuck call."""
    release = threading.Event()
    first = _NeverStarted(release)
    second = _NeverStarted(release)
    second_entered = threading.Event()

    def starter() -> None:
        """
        Call ``first.start()``, then ``second.start()`` once the first returns.

        Returns:
            None
        """
        first.start()
        second_entered.set()
        second.start()

    helper = threading.Thread(target=starter, daemon=True)
    dumper, path = _dumper(tmp_path, 0.6)
    try:
        helper.start()
        assert _wait_until(lambda: _in_start(helper.ident))
        timer = threading.Timer(0.15, first._started.set)
        timer.start()
        dumper._dump()
        timer.join(5)
        assert second_entered.wait(5)
        assert _MARKER not in path.read_text(encoding='utf-8')
    finally:
        second._started.set()
        _release(first, release, helper, dumper)
        second.finished.wait(5)
        second.join(5)


_WMI_OK = re.compile(r'=== wmi query seconds=\d+\.\d{3} ok chars=(\d+) query=(.*)\n\n')
_WMI_ERR = re.compile(r'=== wmi query seconds=\d+\.\d{3} error=(\w+) winerror=(\S+) query=(.*)\n\n')


_WMI_SKIPPED = re.compile(r'=== wmi query seconds=\d+\.\d{3} skipped query=(.*)\n\n')


def _fake_wmi(monkeypatch, exec_query, skip=False):
    """
    Put a fake ``_wmi`` module into ``sys.modules`` and set the hook's skip mode.

    Args:
        monkeypatch (pytest.MonkeyPatch): The fixture that restores ``sys.modules`` and ``_WMI_SKIP``.
        exec_query (Callable): The fake ``exec_query``.
        skip (bool): Value for ``_WMI_SKIP``; False tests the pass-through mode.

    Returns:
        types.ModuleType: The fake module.
    """
    module = types.ModuleType('_wmi')
    module.exec_query = exec_query
    monkeypatch.setattr(dumps, '_WMI_SKIP', skip)
    monkeypatch.setitem(sys.modules, '_wmi', module)
    return module


def test_wmi_wrapper_logs_ok_line(tmp_path, monkeypatch):
    def fake(query):
        """Fake doc."""
        return 'x' * 7

    module = _fake_wmi(monkeypatch, fake)
    dumper, path = _dumper(tmp_path)
    assert dumps._wrap_wmi(dumper) is True
    assert module.exec_query.__name__ == 'fake' and module.exec_query.__doc__ == 'Fake doc.'
    assert module.exec_query('SELECT a\nFROM b ' + 'q' * 300) == 'x' * 7
    dumper.close()
    match = _WMI_OK.fullmatch(path.read_text(encoding='utf-8'))
    assert match and match.group(1) == '7'
    assert match.group(2) == ('SELECT a FROM b ' + 'q' * 300)[:200]


def test_wmi_wrapper_logs_error_and_reraises_same_exception(tmp_path, monkeypatch):
    error = OSError(0, 'timed out', None, 258)

    def fake(query):
        raise error

    module = _fake_wmi(monkeypatch, fake)
    dumper, path = _dumper(tmp_path)
    dumps._wrap_wmi(dumper)
    try:
        module.exec_query('SELECT 1')
    except OSError as caught:
        assert caught is error
    else:
        raise AssertionError('exception was swallowed')
    dumper.close()
    match = _WMI_ERR.fullmatch(path.read_text(encoding='utf-8'))
    assert match and match.groups() == ('OSError', '258', 'SELECT 1')


def test_wmi_error_without_winerror_logs_dash(tmp_path, monkeypatch):
    def fake(query):
        raise ValueError('boom')

    module = _fake_wmi(monkeypatch, fake)
    dumper, path = _dumper(tmp_path)
    dumps._wrap_wmi(dumper)
    try:
        module.exec_query('Q')
    except ValueError:
        pass
    dumper.close()
    assert _WMI_ERR.fullmatch(path.read_text(encoding='utf-8')).groups() == ('ValueError', '-', 'Q')


def test_wmi_wrapper_does_not_write_after_close_or_raise(tmp_path, monkeypatch):
    module = _fake_wmi(monkeypatch, lambda query: 'abc')
    dumper, path = _dumper(tmp_path)
    dumps._wrap_wmi(dumper)
    dumper.close()
    assert module.exec_query('Q') == 'abc'
    assert path.read_text(encoding='utf-8') == ''


def test_wmi_wrapper_installs_once_and_skips_missing_module(tmp_path, monkeypatch):
    module = _fake_wmi(monkeypatch, lambda query: 'abc')
    dumper, _ = _dumper(tmp_path)
    assert dumps._wrap_wmi(dumper) is True
    wrapper = module.exec_query
    assert dumps._wrap_wmi(dumper) is False and module.exec_query is wrapper
    monkeypatch.setitem(sys.modules, '_wmi', None)
    assert dumps._wrap_wmi(dumper) is False
    dumper.close()


def test_wmi_wrapper_real_query(tmp_path, monkeypatch):
    if os.name != 'nt':
        pytest.skip('_wmi exists on Windows only')
    import _wmi

    monkeypatch.setattr(dumps, '_WMI_SKIP', False)
    monkeypatch.setattr(_wmi, 'exec_query', _wmi.exec_query)
    dumper, path = _dumper(tmp_path)
    assert dumps._wrap_wmi(dumper) is True
    try:
        _wmi.exec_query('SELECT Version FROM OS')
    except OSError:
        pass
    dumper.close()
    text = path.read_text(encoding='utf-8')
    assert _WMI_OK.fullmatch(text) or _WMI_ERR.fullmatch(text), text
    assert text.endswith('query=SELECT Version FROM OS\n\n')


def test_wmi_skip_mode_does_not_call_original_and_raises(tmp_path, monkeypatch):
    calls = []

    def fake(query):
        calls.append(query)
        return 'x'

    module = _fake_wmi(monkeypatch, fake, skip=True)
    dumper, path = _dumper(tmp_path)
    assert dumps._wrap_wmi(dumper) is True
    with pytest.raises(OSError, match='skipped'):
        module.exec_query('SELECT a\nFROM b ' + 'q' * 300)
    dumper.close()
    assert calls == []
    text = path.read_text(encoding='utf-8')
    assert text.count('=== wmi query') == 1
    match = _WMI_SKIPPED.fullmatch(text)
    assert match and match.group(1) == ('SELECT a FROM b ' + 'q' * 300)[:200]


def test_wmi_skip_mode_real_platform_falls_back(tmp_path, monkeypatch):
    if os.name != 'nt':
        pytest.skip('_wmi exists on Windows only')
    import platform

    import _wmi

    monkeypatch.setattr(dumps, '_WMI_SKIP', True)
    monkeypatch.setattr(_wmi, 'exec_query', _wmi.exec_query)
    dumper, path = _dumper(tmp_path)
    assert dumps._wrap_wmi(dumper) is True
    with pytest.raises(OSError):
        platform._wmi_query('CPU', 'Architecture')
    machine = platform._get_machine_win32()
    dumper.close()
    assert isinstance(machine, str) and machine
    assert _WMI_SKIPPED.search(path.read_text(encoding='utf-8'))


# ---------------------------------------------------------------------------
# install.lock journal
# ---------------------------------------------------------------------------

_FAKE_DEPENDS = """
import threading

FP = lambda: 'fp-a'
GATE = None
EXIT_RESULT = None
ENTER_ERROR = None


class FileLock:
    def __init__(self, lock_path='install.lock'):
        self.lock_path = lock_path

    def __enter__(self):
        if GATE is not None:
            GATE.wait(10)
        if ENTER_ERROR is not None:
            raise ENTER_ERROR
        return self

    def __exit__(self, *args):
        return EXIT_RESULT


def _installed_fingerprint():
    return FP()


def _verdict_cached(requirements_path, constraints_path):
    return requirements_path == 'hit'


def depends(requirements=None, body=None):
    with FileLock('install.lock'):
        if body is not None:
            body()


def lock_without_requirements(body=None):
    with FileLock('install.lock'):
        if body is not None:
            body()
"""

_TAKE = re.compile(
    r'=== lock take req=(?P<req>\S+) wait_start=(?P<ws>\d+\.\d{3}) acquired=(?P<acq>\d+\.\d{3}) '
    r'released=(?P<rel>\d+\.\d{3}) waited=(?P<waited>\d+\.\d{3}) held=(?P<held>\d+\.\d{3}) '
    r'cache=(?P<cache>hit|miss|none) installed=(?P<installed>yes|no|unknown)\n\n'
)


def _fake_depends(monkeypatch, tmp_path):
    """
    Build a fake ``depends`` module from source, so its methods have real frames and a ``requirements`` local.

    Args:
        monkeypatch (pytest.MonkeyPatch): Unused here; kept so every fixture user restores state the same way.
        tmp_path (pathlib.Path): Directory used for the compile file name.

    Returns:
        types.ModuleType: The module, not yet wrapped.
    """
    module = types.ModuleType('depends')
    exec(compile(_FAKE_DEPENDS, str(tmp_path / 'depends.py'), 'exec'), module.__dict__)
    return module


def _journal(tmp_path, monkeypatch, patch=True):
    """
    Build a dumper, a journal and a wrapped fake ``depends``.

    Args:
        tmp_path (pathlib.Path): Directory for the dump file.
        monkeypatch (pytest.MonkeyPatch): Fixture passed to ``_fake_depends``.
        patch (bool): Wrap the module when true.

    Returns:
        tuple: The dumper, the file path, the journal and the module.
    """
    dumper, path = _dumper(tmp_path)
    module = _fake_depends(monkeypatch, tmp_path)
    journal = dumps._LockJournal(dumper)
    dumper._journal = journal
    if patch:
        assert journal.patch(module) is True
    return dumper, path, journal, module


def _takes(dumper, path) -> list:
    """
    Close the dumper and parse every ``=== lock take`` line of its file.

    Args:
        dumper (_Dumper): The dumper to close.
        path (pathlib.Path): Its file.

    Returns:
        list[dict]: One dict of named groups per line; the file must hold nothing else.
    """
    dumper.close()
    text = path.read_text(encoding='utf-8')
    found = [m.groupdict() for m in _TAKE.finditer(text)]
    assert text.count('=== lock take') == len(found)
    return found


@pytest.mark.parametrize(
    'req, cache',
    [('hit', 'hit'), ('miss', 'miss'), (None, 'none')],
)
def test_lock_take_cache_field(tmp_path, monkeypatch, req, cache):
    dumper, path, _, module = _journal(tmp_path, monkeypatch)
    body = (lambda: module._verdict_cached(req, 'c')) if req else None
    module.depends('/abs/req.txt', body)
    (take,) = _takes(dumper, path)
    assert take['cache'] == cache and take['installed'] == 'no'


def test_lock_take_cache_hit_wins_over_miss(tmp_path, monkeypatch):
    dumper, path, _, module = _journal(tmp_path, monkeypatch)
    module.depends('/abs/req.txt', lambda: (module._verdict_cached('hit', 'c'), module._verdict_cached('x', 'c')))
    assert _takes(dumper, path)[0]['cache'] == 'hit'


def test_lock_take_installed_yes_no_unknown(tmp_path, monkeypatch):
    dumper, path, _, module = _journal(tmp_path, monkeypatch)
    module.depends('/r', None)

    values = iter(['a', 'b'])
    module.FP = lambda: next(values)
    module.depends('/r', None)

    def boom():
        raise OSError('no site-packages')

    module.FP = boom
    module.depends('/r', None)

    values = iter(['a', None])
    module.FP = lambda: next(values)
    module.depends('/r', None)
    assert [t['installed'] for t in _takes(dumper, path)] == ['no', 'yes', 'unknown', 'unknown']


def test_lock_take_times_and_req_from_caller_frame(tmp_path, monkeypatch):
    dumper, path, _, module = _journal(tmp_path, monkeypatch)
    before = time.time()
    module.depends('/abs/req.txt', lambda: time.sleep(0.2))
    module.lock_without_requirements()
    module.depends(None)
    first, second, third = _takes(dumper, path)
    assert first['req'] == '/abs/req.txt'
    assert second['req'] == '-' and third['req'] == '-'
    assert float(first['held']) >= 0.2 and float(first['waited']) < 0.2
    assert before - 1 <= float(first['ws']) <= float(first['acq']) <= float(first['rel']) <= time.time() + 1


def test_lock_take_waited_covers_a_blocked_enter(tmp_path, monkeypatch):
    dumper, path, _, module = _journal(tmp_path, monkeypatch)
    module.GATE = threading.Event()
    worker = threading.Thread(target=module.depends, args=('/r', None))
    worker.start()
    time.sleep(0.25)
    module.GATE.set()
    worker.join(5)
    (take,) = _takes(dumper, path)
    assert float(take['waited']) >= 0.2 and float(take['held']) < 0.2


def test_lock_state_lines_while_waiting_and_holding(tmp_path, monkeypatch):
    dumper, path, _, module = _journal(tmp_path, monkeypatch)
    module.GATE = threading.Event()
    states = {}

    def body():
        states['holding'] = dumper._lock_state_block()

    worker = threading.Thread(target=module.depends, args=('/abs/r.txt', body))
    worker.start()
    assert _wait_until(lambda: 'waiting_since=' in dumper._lock_state_block())
    states['waiting'] = dumper._lock_state_block()
    module.GATE.set()
    worker.join(5)
    assert re.fullmatch(r'=== lock state waiting_since=\d+\.\d{3} req=/abs/r\.txt\n\n', states['waiting'])
    assert re.fullmatch(r'=== lock state holding_since=\d+\.\d{3} req=/abs/r\.txt\n\n', states['holding'])
    assert dumper._lock_state_block() == ''
    dumper.close()


def test_lock_wrappers_pass_exceptions_and_results_through(tmp_path, monkeypatch):
    dumper, path, _, module = _journal(tmp_path, monkeypatch)

    class Marker(Exception):
        pass

    marker = Marker('body')

    def body():
        raise marker

    with pytest.raises(Marker) as raised:
        module.depends('/r', body)
    assert raised.value is marker
    assert module.FileLock.__enter__.__name__ == '__enter__'

    enter_error = OSError('enter failed')
    module.ENTER_ERROR = enter_error
    with pytest.raises(OSError) as raised:
        module.depends('/r', None)
    assert raised.value is enter_error
    module.ENTER_ERROR = None

    module.EXIT_RESULT = 'suppress'
    lock = module.FileLock()
    with lock:
        pass
    assert lock.__exit__(None, None, None) == 'suppress'
    with pytest.raises(TypeError):
        module._verdict_cached()
    assert module._verdict_cached('hit', 'c') is True
    assert module._verdict_cached('x', 'c') is False
    # The body that raised still wrote its take; the failed enter wrote none.
    assert len(_takes(dumper, path)) == 2
    assert dumper._journal._active == {}


def test_lock_wrapper_internal_failures_do_not_break_the_original(tmp_path, monkeypatch):
    dumper, path, journal, module = _journal(tmp_path, monkeypatch)
    calls = []
    monkeypatch.setattr(dumps, '_caller_requirements', lambda frame: 1 / 0)
    monkeypatch.setattr(journal, '_takes', lambda: 1 / 0)
    monkeypatch.setattr(dumper, '_append', lambda text: 1 / 0)
    module.depends('/r', lambda: calls.append(module._verdict_cached('hit', 'c')))
    assert calls == [True]
    dumper.close()
    assert path.read_text(encoding='utf-8') == ''


def test_lock_journal_patches_once_and_skips_a_module_without_filelock(tmp_path, monkeypatch):
    dumper, _, journal, module = _journal(tmp_path, monkeypatch)
    assert journal.patch(module) is False
    assert journal.patch(types.ModuleType('depends')) is False
    dumper.close()


def test_lock_journal_patches_depends_imported_after_the_hook(tmp_path, monkeypatch):
    source_dir = tmp_path / 'lib'
    source_dir.mkdir()
    (source_dir / 'depends.py').write_text(_FAKE_DEPENDS, encoding='utf-8')
    monkeypatch.syspath_prepend(str(source_dir))
    monkeypatch.delitem(sys.modules, 'depends', raising=False)
    monkeypatch.setattr(sys, 'meta_path', list(sys.meta_path))
    dumper, path = _dumper(tmp_path)

    dumps._watch_depends(dumper)
    assert 'depends' not in sys.modules
    import depends

    try:
        assert depends.__file__.startswith(str(source_dir))
        depends.depends('/abs/late.txt', lambda: depends._verdict_cached('hit', 'c'))
        (take,) = _takes(dumper, path)
        assert take['req'] == '/abs/late.txt' and take['cache'] == 'hit'
    finally:
        sys.modules.pop('depends', None)


def test_lock_journal_patches_depends_that_is_already_imported(tmp_path, monkeypatch):
    module = _fake_depends(monkeypatch, tmp_path)
    monkeypatch.setitem(sys.modules, 'depends', module)
    monkeypatch.setattr(sys, 'meta_path', list(sys.meta_path))
    dumper, path = _dumper(tmp_path)
    dumps._watch_depends(dumper)
    assert getattr(module.FileLock, '_rr_lock_journal', False) is True
    module.depends('/r', None)
    assert len(_takes(dumper, path)) == 1
