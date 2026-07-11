# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

r"""Unit tests for text_output Instance path shortening (no engine/SMB server).

text_output writes over SMB via smbclient. The Windows-long-path fix (issue
#1415) applies per-component hash-truncation here (the ``\\?\`` prefix does NOT
apply to SMB paths). smbclient is mocked, so these run without a live share and
assert that an over-long derived component is shortened *before* the SMB write.
"""

import errno
import sys
import types
from pathlib import Path
from unittest.mock import patch

import pytest

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))

from text_output.instance import Instance  # noqa: E402


class _Stub:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class _SMBOSError(OSError):
    """Stand-in for smbprotocol.exceptions.SMBOSError (carries .errno)."""


class _Recorder:
    def __init__(self):
        self.written = []  # list of (path, content)
        self.makedirs = []  # list of dir paths


@pytest.fixture
def fake_smb():
    """Inject a fake smbclient / smbprotocol.exceptions into sys.modules.

    The node imports smbclient lazily inside its methods, so patching
    sys.modules before the call is enough. stat() reports 'not found' so the
    target is treated as new; open_file() records the path + written bytes.
    """
    rec = _Recorder()

    exc_mod = types.ModuleType('smbprotocol.exceptions')
    exc_mod.SMBOSError = _SMBOSError
    pkg_mod = types.ModuleType('smbprotocol')
    pkg_mod.exceptions = exc_mod

    class _Writable:
        def __init__(self, path):
            self.path = path
            self._buf = ''

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            rec.written.append((self.path, self._buf))
            return False

        def write(self, s):
            self._buf += s

    smbclient_mod = types.ModuleType('smbclient')
    smbclient_mod.stat = lambda path: (_ for _ in ()).throw(_SMBOSError(errno.ENOENT, 'not found'))
    smbclient_mod.makedirs = lambda path, exist_ok=False: rec.makedirs.append(path)
    smbclient_mod.open_file = lambda path, mode='r', encoding=None: _Writable(path)

    with patch.dict(
        sys.modules,
        {'smbclient': smbclient_mod, 'smbprotocol': pkg_mod, 'smbprotocol.exceptions': exc_mod},
    ):
        yield rec


def _make_instance(target_object_path, server='fileserver'):
    inst = Instance()
    inst.instance = _Stub(targetObjectPath=target_object_path)
    inst.IEndpoint = _Stub(server=server, settings_changed=False)
    inst.TRANFORM_KEY_TAG_NAME = f'text-output://{server}/status'
    inst.target_dir_path = None
    return inst


def _entry():
    return _Stub(objectFailed=False, instanceTags={}, changeKey='ck', modifyTime=1, size=2, flags=0, path='src/doc.md')


def test_open_leaves_normal_name_unchanged(fake_smb):
    """A normal (short) target path is used verbatim, with .txt appended."""
    inst = _make_instance('share/folder/report', server='srv')
    inst.open(_entry())
    assert inst.target_object_path == '//srv/share/folder/report.txt'


def test_open_shortens_overlong_component(fake_smb):
    """An over-long derived component is hash-truncated to <= 255 chars."""
    inst = _make_instance('share/' + 'X' * 300, server='srv')
    inst.open(_entry())

    last = inst.target_object_path.rsplit('/', 1)[-1]
    assert len(last) <= 255
    assert last != ('X' * 300 + '.txt')  # actually shortened
    assert inst.target_object_path.startswith('//srv/share/')


def test_close_writes_shortened_path_over_smb(fake_smb):
    """close() writes the shortened path over SMB with the right content."""
    inst = _make_instance('share/subdir/' + 'T' * 300)
    inst.open(_entry())
    inst.writeText('smb-body-1415')
    inst.close()

    assert fake_smb.written, 'smbclient.open_file was never used'
    path, content = fake_smb.written[-1]
    assert content == 'smb-body-1415'

    last = path.rsplit('/', 1)[-1]
    assert len(last) <= 255  # remote NTFS component limit
    assert last != ('T' * 300 + '.txt')  # shortened, not the raw name
    assert path.startswith('//fileserver/share/subdir/')
    # The parent directory was created (over SMB) before the write.
    assert fake_smb.makedirs and fake_smb.makedirs[-1] == '//fileserver/share/subdir'


def test_close_shortens_deterministically(fake_smb):
    """The same over-long input yields the same SMB target path across runs."""
    paths = []
    for _ in range(2):
        inst = _make_instance('share/' + 'Z' * 300)
        inst.open(_entry())
        inst.writeText('x')
        inst.close()
        paths.append(fake_smb.written[-1][0])
    assert paths[0] == paths[1]
