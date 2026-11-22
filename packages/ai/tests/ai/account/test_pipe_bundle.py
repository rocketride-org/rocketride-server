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

"""The server side of the pipeline bundle (plan 9, C.17b): the store block, the zip, the manifest, the content."""

import asyncio
import io
import json
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from ai.account.pipe_bundle import (
    MAX_PIPE_ICON_BYTES,
    MAX_PIPE_README_BYTES,
    PIPE_STORE_DIR,
    declared_files,
    default_store_block,
    is_listed,
    pipe_manifest,
    read_pipe_bundle,
    store_home_of,
    validate_store_block,
    write_pipe_content,
)

STORE = {
    'tagline': 'Reads documents',
    'categories': ['documents'],
    'tags': ['ocr'],
    'icon': 'icon.svg',
    'readme': 'docs/README.md',
    'links': {'homepage': 'https://example.com'},
    'mode': 'subscription',
    'billing': {'plans': [{'nickname': 'Pro', 'amount': 900, 'interval': 'month'}]},
}
PIPE = {'project_id': 'docBrain', 'name': 'Doc Brain', 'description': 'Reads', 'source': 'webhook_1', 'components': []}
LISTED_PIPE = {**PIPE, 'store': STORE}


def _zip(files):
    """One bundle zip from {name: bytes|str}."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as zf:
        for name, content in files.items():
            zf.writestr(name, content if isinstance(content, bytes) else content.encode('utf-8'))
    return buffer.getvalue()


# ==== The store block ==========================================================


def test_the_block_is_returned_with_its_paths_normalised():
    block = validate_store_block({**PIPE, 'store': {**STORE, 'icon': './images\\icon.svg'}})
    assert block['icon'] == 'images/icon.svg'
    assert block['billing'] == STORE['billing'] and block['mode'] == 'subscription'


def test_a_pipe_without_a_block_validates_to_none():
    assert validate_store_block(PIPE) is None


def test_the_default_block_names_no_file_and_lists_the_pipe_as_free():
    """What the door gives a pipe without a block: no icon, no readme, a fresh dict each call."""
    block = default_store_block()
    assert block == {
        'tagline': '',
        'categories': ['pipeline'],
        'tags': [],
        'links': {},
        'mode': 'free',
        'billing': {'plans': []},
    }
    assert 'icon' not in block and 'readme' not in block
    assert default_store_block() is not block
    # It passes its own door, declares nothing to store, and shapes a listed manifest
    checked = validate_store_block({**PIPE, 'store': block})
    assert checked == block and declared_files(checked) == {}
    manifest = pipe_manifest(PIPE, checked)
    assert is_listed(manifest) and manifest['mode'] == 'free'
    assert manifest['icon'] == '' and manifest['readme'] == '' and manifest['categories'] == ['pipeline']


@pytest.mark.parametrize(
    'store, message',
    [
        ({'publisher': 'acme'}, 'unknown key "publisher"'),
        ({'category': 'x'}, 'unknown key "category"'),
        ({'mode': 'usage'}, 'mode must be free, subscription or paywall'),
        ({'tags': 'ocr'}, 'store.tags must be a list of strings'),
        ({'categories': [1]}, 'store.categories must be a list of strings'),
        ({'tagline': 3}, 'store.tagline must be a string'),
        ({'links': {'a': 1}}, 'store.links must be an object of strings'),
        ({'icon': '../logo.png'}, 'store.icon must be a path inside the pipeline folder'),
        ({'readme': '/etc/readme.md'}, 'store.readme must be a path inside the pipeline folder'),
        ({'readme': ''}, 'store.readme must be a relative file path'),
        ({'billing': []}, 'store.billing must be an object with a plans list'),
        ({'billing': {'plans': 'pro'}}, 'store.billing.plans must be a list of plan objects'),
        ({'billing': {'plans': [], 'currency': 'usd'}}, 'store.billing: unknown key "currency"'),
        ('free', 'store must be an object'),
    ],
)
def test_a_malformed_block_is_refused_by_name(store, message):
    with pytest.raises(ValueError, match=message):
        validate_store_block({**PIPE, 'store': store})


# ==== The zip ==================================================================


def test_a_bundle_reads_its_pipe_and_keeps_every_other_entry_with_its_layout():
    bundle = read_pipe_bundle(
        _zip(
            {
                'docBrain.pipe': json.dumps(LISTED_PIPE),
                'icon.svg': '<svg/>',
                'docs/README.md': '# Doc Brain',
                'images/flow.png': b'\x01\x02',
            }
        )
    )
    assert bundle.pipeline == LISTED_PIPE and bundle.stem == 'docBrain'
    assert bundle.entries == ['icon.svg', 'docs/README.md', 'images/flow.png']


def test_a_bundle_without_a_block_still_reads():
    bundle = read_pipe_bundle(_zip({'docBrain.pipe': json.dumps(PIPE), 'notes.txt': 'x'}))
    assert bundle.entries == ['notes.txt']


@pytest.mark.parametrize(
    'files, message',
    [
        ({'docs/README.md': 'x'}, 'exactly one .pipe'),
        ({'a.pipe': json.dumps(PIPE), 'b.pipe': json.dumps(PIPE)}, 'exactly one .pipe'),
        ({'sub/a.pipe': json.dumps(PIPE)}, 'exactly one .pipe'),
        ({'docBrain.pipe': 'not json'}, 'not valid JSON'),
        ({'docBrain.pipe': json.dumps({**PIPE, 'store': {'x': 1}})}, 'unknown key "x"'),
        (
            {'docBrain.pipe': json.dumps(LISTED_PIPE), 'docs/README.md': 'x' * (MAX_PIPE_README_BYTES + 1)},
            'README.md exceeds',
        ),
        ({'docBrain.pipe': json.dumps(LISTED_PIPE), 'icon.svg': 'x' * (MAX_PIPE_ICON_BYTES + 1)}, 'icon.svg exceeds'),
        ({'docBrain.pipe': json.dumps(PIPE), '../escape.md': 'x'}, 'unsafe path'),
    ],
)
def test_a_malformed_bundle_is_refused_by_name(files, message):
    with pytest.raises(ValueError, match=message):
        read_pipe_bundle(_zip(files))


def test_not_a_zip_is_refused():
    with pytest.raises(ValueError, match='not a valid zip'):
        read_pipe_bundle(b'plain bytes')


def test_a_missing_declared_file_is_not_a_read_error():
    """Presence is the content stage's call: the version fails, the deploy is not refused."""
    bundle = read_pipe_bundle(_zip({'docBrain.pipe': json.dumps(LISTED_PIPE)}))
    assert bundle.entries == []


# ==== The manifest =============================================================


def test_the_manifest_is_the_block_plus_the_pipes_root_keys():
    manifest = pipe_manifest(LISTED_PIPE, validate_store_block(LISTED_PIPE))
    assert manifest == {
        'name': 'Doc Brain',
        'description': 'Reads',
        'defaultSource': 'webhook_1',
        'tagline': 'Reads documents',
        'categories': ['documents'],
        'tags': ['ocr'],
        'icon': 'icon.svg',
        'readme': 'docs/README.md',
        'links': {'homepage': 'https://example.com'},
        'mode': 'subscription',
        # Pricing EXACTLY as an app manifest stores it: the approve path reads manifest.billing
        'billing': {'plans': [{'nickname': 'Pro', 'amount': 900, 'interval': 'month'}]},
    }
    assert is_listed(manifest)


def test_an_empty_block_lists_the_pipe_as_free_with_every_field_present():
    manifest = pipe_manifest({'project_id': 'p'}, {})
    assert manifest['name'] == 'p' and manifest['mode'] == 'free' and manifest['icon'] == ''
    assert manifest['categories'] == [] and 'billing' not in manifest and 'plans' not in manifest


def test_a_synthesized_name_only_manifest_is_not_listed():
    assert not is_listed({'name': 'p'})
    assert not is_listed(None)


# ==== The content ==============================================================

ENTRY = {'version': 3, 'artifactPath': 'orgs/org-1/files/.deployments/acme.docBrain/v000003-abcdef12.json'}


def _fs(monkeypatch, write=None):
    """A fake file store behind Store.file_store (the writer imports it at call time), recording writes and deletes."""
    fs = SimpleNamespace(write=write or AsyncMock(), delete=AsyncMock())
    monkeypatch.setattr('ai.account.store.Store', SimpleNamespace(file_store=lambda *a, **k: fs))
    return fs


def test_the_store_home_is_the_versions_content_dir_store_subdir():
    assert store_home_of('org-1', ENTRY) == f'=org/org-1/.deployments/acme.docBrain/v000003-abcdef12/{PIPE_STORE_DIR}'
    with pytest.raises(ValueError, match='no usable artifactPath'):
        store_home_of('org-1', {'version': 3, 'artifactPath': 'elsewhere/x.json'})


def test_content_is_written_under_the_store_dir_keeping_the_layout(monkeypatch):
    fs = _fs(monkeypatch)
    bundle = read_pipe_bundle(
        _zip({'docBrain.pipe': json.dumps(LISTED_PIPE), 'icon.svg': '<svg/>', 'docs/README.md': '# x'})
    )
    written = asyncio.run(write_pipe_content('org-1', 'user-1', ENTRY, bundle, validate_store_block(LISTED_PIPE)))
    home = store_home_of('org-1', ENTRY)
    assert written == [f'{home}/icon.svg', f'{home}/docs/README.md']
    assert [call.args[0] for call in fs.write.await_args_list] == written


def test_a_declared_file_missing_from_the_bundle_fails_by_name_before_any_write(monkeypatch):
    fs = _fs(monkeypatch)
    bundle = read_pipe_bundle(_zip({'docBrain.pipe': json.dumps(LISTED_PIPE), 'icon.svg': '<svg/>'}))
    with pytest.raises(ValueError, match='names readme "docs/README.md" but the bundle has no such file'):
        asyncio.run(write_pipe_content('org-1', 'user-1', ENTRY, bundle, validate_store_block(LISTED_PIPE)))
    fs.write.assert_not_awaited()


def test_a_block_declaring_files_without_a_zip_fails_by_name(monkeypatch):
    _fs(monkeypatch)
    with pytest.raises(ValueError, match='names icon "icon.svg"'):
        asyncio.run(write_pipe_content('org-1', 'user-1', ENTRY, None, validate_store_block(LISTED_PIPE)))


def test_a_block_declaring_nothing_writes_nothing(monkeypatch):
    fs = _fs(monkeypatch)
    assert asyncio.run(write_pipe_content('org-1', 'user-1', ENTRY, None, {'tagline': 'x'})) == []
    fs.write.assert_not_awaited()


def test_a_failed_write_rolls_back_what_landed(monkeypatch):
    write = AsyncMock(side_effect=[None, RuntimeError('store down')])
    fs = _fs(monkeypatch, write=write)
    bundle = read_pipe_bundle(
        _zip({'docBrain.pipe': json.dumps(LISTED_PIPE), 'icon.svg': '<svg/>', 'docs/README.md': '# x'})
    )
    with pytest.raises(RuntimeError, match='store down'):
        asyncio.run(write_pipe_content('org-1', 'user-1', ENTRY, bundle, validate_store_block(LISTED_PIPE)))
    home = store_home_of('org-1', ENTRY)
    assert [call.args[0] for call in fs.delete.await_args_list] == [f'{home}/icon.svg', f'{home}/docs/README.md']
