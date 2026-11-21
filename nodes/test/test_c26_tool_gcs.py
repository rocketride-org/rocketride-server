# =============================================================================
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

"""
The two-replica test of tool_gcs (plan 4.3, 5.7, section 12 B).

A download used to be a temp file on one engine host, retained per process;
it is now written to the control owner's file store (``self.files``) and the
path of the most recent one is the node's state. The calls of one control
alternate between two replicas: a download made on one is readable on the
other, the next download (on either replica) deletes the previous one, and
another owner's downloads never touch it. The bucket and the download cap are
per-call params. Google Cloud Storage is a stand-in: nothing reaches Google.
"""

from __future__ import annotations

import io
import sys
from types import ModuleType, SimpleNamespace

import pytest

from .framework.controls import assert_config_refuses, assert_params, control_config
from .framework.replicas import NODES_DIR, Call, Owner, run_alternating_and_alone

NODE_DIR = NODES_DIR / 'tool_gcs'
NODE_ID = 'gcs_1'

ALICE = Owner(orgId='org-a', userId='alice', config=(('bucketName', 'docs'),))
BOB = Owner(orgId='org-a', userId='bob', config=(('bucketName', 'docs'),))

#: The objects of the stand-in buckets, by bucket then name.
OBJECTS = {
    'docs': {'a.txt': b'alpha', 'b.txt': b'bravo', 'big.bin': b'x' * 64},
    'other': {'a.txt': b'other-alpha'},
}


# ==== A stand-in for google.cloud.storage ==========================================


class _Blob:
    """One object: its size and a readable stream."""

    def __init__(self, bucket: str, name: str):
        self.name = name
        self._data = OBJECTS[bucket].get(name)
        self.size = None

    def reload(self):
        if self._data is None:
            raise FileNotFoundError(self.name)
        self.size = len(self._data)

    def open(self, mode: str):
        return io.BytesIO(self._data)


class _Bucket:
    """One bucket's handles."""

    def __init__(self, name: str):
        self.name = name

    def blob(self, name: str) -> _Blob:
        return _Blob(self.name, name)

    def list_blobs(self, prefix: str = '', max_results: int = 10):
        return [SimpleNamespace(name=name) for name in sorted(OBJECTS[self.name]) if name.startswith(prefix)][
            :max_results
        ]


class _Client:
    """The storage client: local handles, no I/O at construction."""

    def __init__(self, project=None, credentials=None):
        self.project = project

    def bucket(self, name: str) -> _Bucket:
        return _Bucket(name)

    def close(self):
        pass


@pytest.fixture(autouse=True)
def stand_in_gcs(monkeypatch):
    """Replace the storage library, the package install and the credential for every replica's import."""
    import google.cloud
    import nodes.core.gcp_auth as gcp_auth

    storage = ModuleType('google.cloud.storage')
    storage.Client = _Client
    monkeypatch.setitem(sys.modules, 'google.cloud.storage', storage)
    monkeypatch.setattr(google.cloud, 'storage', storage, raising=False)
    depends = ModuleType('depends')
    depends.depends = lambda *args, **kwargs: None
    monkeypatch.setitem(sys.modules, 'depends', depends)
    monkeypatch.setattr(gcp_auth, 'get_gcp_credentials', lambda cfg, scopes: (object(), 'project-1'))


# ==== Calls =========================================================================


def _download(owner, name, **params):
    """One call downloading one object; forwards the tool's answer."""

    def invoke(instance):
        instance.instance.writeText(repr(sorted(instance.download_file({'file_name': name}).items())))

    return Call(owner=owner, params=params, invoke=invoke)


def _listing(owner):
    """One call listing the owner's downloads and reading each back."""

    def invoke(instance):
        entries = instance.files.list_dir('gcs').get('entries', [])
        files = {entry['name']: instance.files.read(f'gcs/{entry["name"]}') for entry in entries}
        instance.instance.writeText(repr(sorted(files.items())))

    return Call(owner=owner, invoke=invoke)


def _texts(outputs):
    """The text each call forwarded."""
    return [args[0] for call in outputs for name, args in call if name == 'writeText']


def _run(calls):
    """Play the calls alternately on two replicas and on one."""
    return run_alternating_and_alone(NODE_DIR, 'tool_gcs', NODE_ID, calls)


# ==== The schema =================================================================


def test_the_bucket_settings_are_caller_only_params():
    assert_params(
        'tool_gcs',
        ['bucketName', 'prefix', 'maxDownloadBytes'],
        caller_only=['bucketName', 'prefix', 'maxDownloadBytes'],
    )
    assert_config_refuses(control_config('tool_gcs'), ['bucketName', 'prefix', 'maxDownloadBytes'])


# ==== Two replicas ================================================================


def test_a_download_lands_in_the_owners_files_and_replaces_the_previous_one():
    calls = [_download(ALICE, 'a.txt'), _listing(ALICE), _download(ALICE, 'b.txt'), _listing(ALICE)]
    alternating, reference = _run(calls)
    assert alternating == reference
    texts = _texts(reference)
    assert texts[0] == repr([('path', 'gcs/a.txt'), ('size', 5), ('success', True)])
    assert texts[1] == repr([('a.txt', b'alpha')])
    # The second download, on the other replica, deleted the first
    assert texts[3] == repr([('b.txt', b'bravo')])


def test_the_bucket_and_the_cap_are_each_calls_own():
    calls = [
        _download(ALICE, 'big.bin', maxDownloadBytes=10),
        _download(ALICE, 'a.txt', bucketName='other'),
        _listing(ALICE),
    ]
    alternating, reference = _run(calls)
    assert alternating == reference
    texts = _texts(reference)
    assert 'exceeds' in texts[0] and 'maxDownloadBytes (10)' in texts[0]
    assert texts[2] == repr([('a.txt', b'other-alpha')])


def test_another_owners_download_never_touches_mine():
    calls = [_download(ALICE, 'a.txt'), _download(BOB, 'b.txt'), _listing(ALICE), _listing(BOB)]
    together, _ = _run(calls)
    texts = _texts(together)
    assert texts[2] == repr([('a.txt', b'alpha')])
    assert texts[3] == repr([('b.txt', b'bravo')])
