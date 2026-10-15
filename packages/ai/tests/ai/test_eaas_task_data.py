"""ai.eaas — the server refuses to start when tasks could not write their data.

In the self-hosted image the task data directory is the /opt/data volume; one
created by an older image belongs to uid 999 and every pipeline would fail with
Permission denied while the server looked healthy.
"""

import os
import sys

import pytest

from ai.constants import CONST_TASK_DATA_PATH
from ai.eaas import _require_writable_task_data

needs_non_root = pytest.mark.skipif(os.name != 'posix' or os.geteuid() == 0, reason='root bypasses permission checks')


def test_task_data_path_is_next_to_the_engine():
    assert CONST_TASK_DATA_PATH == os.path.abspath(os.path.join(os.path.dirname(sys.executable), '..', 'data'))


def test_writable_directory_passes(tmp_path):
    _require_writable_task_data(str(tmp_path))


def test_missing_directory_is_created(tmp_path):
    path = tmp_path / 'data'
    _require_writable_task_data(str(path))
    assert path.is_dir()


@needs_non_root
def test_read_only_directory_refuses_with_the_fix(tmp_path):
    tmp_path.chmod(0o500)
    try:
        with pytest.raises(SystemExit) as exc:
            _require_writable_task_data(str(tmp_path))
    finally:
        tmp_path.chmod(0o700)

    message = str(exc.value)
    assert str(tmp_path) in message
    assert f'chown -R {os.getuid()}:{os.getgid()} {tmp_path}' in message
