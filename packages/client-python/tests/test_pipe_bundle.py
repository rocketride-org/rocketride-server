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

"""The pipeline store block and the per-pipe packer (plan 9): one .pipe, its
declared readme and icon, and the files the README references.
"""

import io
import json
import os
import zipfile

import pytest

from rocketride._app_scaffold import PLACEHOLDER_ICON_SVG
from rocketride._pipe_bundle import (
    PIPE_ICON_SVG,
    default_store_block,
    pack_pipe,
    pipe_store_files,
    scaffold_pipe,
    scan_readme_references,
    validate_store_block,
)


def _folder(tmp_path, folder: str, files: dict) -> str:
    """Write files under pipelines/<folder>/ and return the folder."""
    root = tmp_path / 'pipelines' / folder
    root.mkdir(parents=True, exist_ok=True)
    for rel, content in files.items():
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            target.write_bytes(content)
        else:
            target.write_text(content, encoding='utf-8')
    return str(root)


def _pipe_json(store=None) -> str:
    """A pipe JSON with the given store block (omitted when None)."""
    pipe = {'components': [], 'project_id': 'docBrain', 'name': 'Doc Brain'}
    if store is not None:
        pipe['store'] = store
    return json.dumps(pipe)


STORE = {**default_store_block(), 'tagline': 'Reads documents'}


def test_validate_accepts_the_default_block_and_names_bad_keys_modes_and_paths():
    assert validate_store_block(default_store_block()) == default_store_block()
    with pytest.raises(ValueError, match='unknown key "publisher"'):
        validate_store_block({'publisher': 'acme'})
    with pytest.raises(ValueError, match='store.mode must be free, subscription, paywall'):
        validate_store_block({'mode': 'usage'})
    with pytest.raises(ValueError, match='store.icon must stay inside'):
        validate_store_block({'icon': '../x.svg'})
    with pytest.raises(ValueError, match='store.readme must be a path relative'):
        validate_store_block({'readme': '/etc/README.md'})
    with pytest.raises(ValueError, match='store.tags must be a list of strings'):
        validate_store_block({'tags': ['a', 1]})
    with pytest.raises(ValueError, match='store.links'):
        validate_store_block({'links': {'docs': 1}})
    with pytest.raises(ValueError, match='amountCents'):
        validate_store_block({'billing': {'plans': [{'amountCents': 'free'}]}})
    with pytest.raises(ValueError, match='must be a JSON object'):
        validate_store_block([])


def test_validate_applies_the_server_doors_declared_path_and_billing_shape_rules():
    """What the server refuses as written, the client refuses first: a foldable '..', an extra billing key, a non-object plan."""
    with pytest.raises(ValueError, match='store.icon must stay inside'):
        validate_store_block({'icon': 'a/../icon.svg'})
    assert validate_store_block({'readme': ' docs/README.md '})['readme'] == 'docs/README.md'
    with pytest.raises(ValueError, match='store.billing: unknown key "currency"'):
        validate_store_block({'billing': {'plans': [], 'currency': 'usd'}})
    with pytest.raises(ValueError, match='store.billing.plans must be a list of plan objects'):
        validate_store_block({'billing': {'plans': [None]}})


def test_validate_normalises_billing_plans_like_the_app_listing():
    block = validate_store_block(
        {'billing': {'plans': [{'nickname': 'Pro', 'amountCents': '900', 'metadata': {'seats': 3}, 'extra': True}]}}
    )
    assert block['billing']['plans'] == [
        {
            'nickname': 'Pro',
            'amountCents': 900,
            'currency': 'usd',
            'interval': 'month',
            'metadata': {'seats': 3},
            'extra': True,
        }
    ]


def test_scan_finds_markdown_and_html_references_in_order_skipping_urls_anchors_and_code():
    md = '\n'.join(
        [
            '# Doc Brain',
            '![flow](assets/flow.png "The flow")',
            'See [the guide](docs/guide.md#setup) and [the site](https://example.com/x.png).',
            '<img src="assets/shot%201.png?v=2" alt="shot"> <IMG SRC=\'assets/b.gif\'>',
            '[mail](mailto:a@b.c) [data](data:image/png;base64,AAAA) [proto](//cdn/x.png) [anchor](#top)',
            '![again](assets/flow.png)',
            '`![code](assets/nope.png)`',
            '```',
            '[fenced](assets/nope2.png)',
            '```',
        ]
    )
    assert scan_readme_references(md) == ['assets/flow.png', 'docs/guide.md', 'assets/shot 1.png', 'assets/b.gif']


def test_scan_takes_reference_definitions_balanced_parentheses_and_skips_tilde_fences():
    md = '\n'.join(
        [
            '![Diagram][figure] and [the paper][ref]',
            '',
            '[figure]: assets/diagram.png',
            '[ref]: <https://example.com/paper.pdf> "Paper"',
            '![Plot](assets/plot(1).png)',
            '~~~markdown',
            '[Example](example.png)',
            '~~~',
        ]
    )
    assert scan_readme_references(md) == ['assets/diagram.png', 'assets/plot(1).png']


def test_store_files_resolve_against_the_readme_relative_to_the_pipe():
    files = pipe_store_files(
        {'readme': './docs/README.md', 'icon': 'icon.svg'}, '![a](../images/a.png) ![b](./b.png)', 'docs/README.md'
    )
    assert files == {'declared': ['docs/README.md', 'icon.svg'], 'referenced': ['images/a.png', 'docs/b.png']}
    assert pipe_store_files(None, None, None) == {'declared': [], 'referenced': []}


def test_pack_takes_the_pipe_declared_and_referenced_files_nothing_else_deterministically(tmp_path):
    folder = _folder(
        tmp_path,
        'docBrain',
        {
            'docBrain.pipe': _pipe_json(STORE),
            'README.md': '# Doc Brain\n![flow](assets/flow.png)\n<img src="assets/nested/deep.png">\n[guide](docs/guide.md)\n',
            'icon.svg': '<svg/>',
            'assets/flow.png': b'\x01\x02\x03',
            'assets/nested/deep.png': b'\x04',
            'docs/guide.md': '# Guide\n',
            'notes.txt': 'not packed',
            'assets/unused.png': b'\x05',
        },
    )
    packed = pack_pipe(os.path.join(folder, 'docBrain.pipe'))
    assert packed.pipeline['name'] == 'Doc Brain'
    assert packed.store['tagline'] == 'Reads documents'
    assert packed.warnings == []
    assert packed.files == [
        'docBrain.pipe',
        'README.md',
        'assets/flow.png',
        'assets/nested/deep.png',
        'docs/guide.md',
        'icon.svg',
    ]
    with zipfile.ZipFile(io.BytesIO(packed.data)) as zf:
        assert zf.namelist() == packed.files
    assert pack_pipe(os.path.join(folder, 'docBrain.pipe')).data == packed.data


def test_pack_preserves_the_layout_of_a_nested_readme_climbing_to_a_sibling_folder(tmp_path):
    folder = _folder(
        tmp_path,
        'docBrain',
        {
            'docBrain.pipe': _pipe_json({'readme': 'docs/README.md'}),
            'docs/README.md': '![a](../images/a.png)',
            'images/a.png': b'\x01',
        },
    )
    packed = pack_pipe(os.path.join(folder, 'docBrain.pipe'))
    assert packed.files == ['docBrain.pipe', 'docs/README.md', 'images/a.png']
    assert packed.warnings == ['store.icon is not declared, so tiles show a generic glyph']


def test_two_pipes_in_one_folder_pack_independently_and_share_the_icon(tmp_path):
    folder = _folder(
        tmp_path,
        'shared',
        {
            'a.pipe': _pipe_json({'icon': 'icon.svg'}),
            'b.pipe': _pipe_json({'icon': 'icon.svg', 'readme': 'b.md'}),
            'b.md': '# B\n',
            'icon.svg': '<svg/>',
        },
    )
    assert pack_pipe(os.path.join(folder, 'a.pipe')).files == ['a.pipe', 'icon.svg']
    assert pack_pipe(os.path.join(folder, 'b.pipe')).files == ['b.pipe', 'b.md', 'icon.svg']


def test_pack_without_a_store_block_is_the_pipe_alone_named_after_its_stem(tmp_path):
    folder = _folder(tmp_path, 'bare', {'bare.pipe': json.dumps({'components': []}), 'README.md': 'ignored'})
    packed = pack_pipe(os.path.join(folder, 'bare.pipe'))
    assert packed.store is None
    assert packed.files == ['bare.pipe']
    assert packed.pipeline['name'] == 'bare'
    assert packed.warnings == []


def test_pack_refuses_missing_declared_missing_referenced_and_upward_escape_by_name(tmp_path):
    declared = _folder(tmp_path, 'd1', {'d1.pipe': _pipe_json({'icon': 'logo.png'})})
    with pytest.raises(ValueError, match='logo.png does not exist beside the pipe'):
        pack_pipe(os.path.join(declared, 'd1.pipe'))
    referenced = _folder(
        tmp_path, 'd2', {'d2.pipe': _pipe_json({'readme': 'README.md'}), 'README.md': '![x](assets/missing.png)'}
    )
    with pytest.raises(ValueError, match='assets/missing.png does not exist'):
        pack_pipe(os.path.join(referenced, 'd2.pipe'))
    escape = _folder(
        tmp_path, 'd3', {'d3.pipe': _pipe_json({'readme': 'README.md'}), 'README.md': '![x](../secret.txt)'}
    )
    (tmp_path / 'pipelines' / 'secret.txt').write_text('not yours', encoding='utf-8')
    with pytest.raises(ValueError, match=r'\.\./secret.txt resolves outside'):
        pack_pipe(os.path.join(escape, 'd3.pipe'))
    # A sibling .pipe at the root would be a second artifact: the door takes exactly one
    sibling = _folder(
        tmp_path,
        'd4',
        {'d4.pipe': _pipe_json({'readme': 'README.md'}), 'README.md': '[other](other.pipe)', 'other.pipe': '{}'},
    )
    with pytest.raises(ValueError, match='other.pipe is another pipeline at the root'):
        pack_pipe(os.path.join(sibling, 'd4.pipe'))


def test_pack_refuses_a_symlink_whose_real_location_leaves_the_pipe_directory(tmp_path):
    secret = tmp_path / 'secret.txt'
    secret.write_text('not yours', encoding='utf-8')
    folder = _folder(tmp_path, 'link', {'link.pipe': _pipe_json({'readme': 'README.md'})})
    try:
        os.symlink(str(secret), os.path.join(folder, 'README.md'))
    except (OSError, NotImplementedError):
        pytest.skip('symlinks are not available to this process')
    with pytest.raises(ValueError, match='README.md resolves outside'):
        pack_pipe(os.path.join(folder, 'link.pipe'))


def test_pack_refuses_a_non_pipe_invalid_json_an_invalid_block_and_an_oversized_readme(tmp_path):
    folder = _folder(
        tmp_path,
        'bad',
        {
            'bad.json': '{}',
            'broken.pipe': '{',
            'block.pipe': _pipe_json({'mode': 'usage'}),
            'big.pipe': _pipe_json({'readme': 'big.md'}),
            'big.md': 'x' * (1024 * 1024 + 1),
        },
    )
    with pytest.raises(ValueError, match=r'is not a \.pipe file'):
        pack_pipe(os.path.join(folder, 'bad.json'))
    with pytest.raises(ValueError, match='not valid JSON'):
        pack_pipe(os.path.join(folder, 'broken.pipe'))
    with pytest.raises(ValueError, match='store.mode'):
        pack_pipe(os.path.join(folder, 'block.pipe'))
    with pytest.raises(ValueError, match='big.md exceeds'):
        pack_pipe(os.path.join(folder, 'big.pipe'))


def test_scaffold_writes_the_pipe_with_the_default_block_the_shared_icon_a_readme_and_assets(tmp_path):
    created = scaffold_pipe(str(tmp_path), 'ingest', name='Document ingest')
    assert created == {
        'folder': 'pipelines/ingest',
        'pipePath': 'pipelines/ingest/ingest.pipe',
        'files': ['pipelines/ingest/ingest.pipe', 'pipelines/ingest/icon.svg', 'pipelines/ingest/README.md'],
    }
    pipe = json.loads((tmp_path / 'pipelines' / 'ingest' / 'ingest.pipe').read_text(encoding='utf-8'))
    assert pipe == {
        'components': [],
        'project_id': 'ingest',
        'name': 'Document ingest',
        'description': '',
        'store': default_store_block(),
    }
    assert (tmp_path / 'pipelines' / 'ingest' / 'icon.svg').read_text(encoding='utf-8') == PLACEHOLDER_ICON_SVG
    assert PIPE_ICON_SVG == PLACEHOLDER_ICON_SVG
    readme = (tmp_path / 'pipelines' / 'ingest' / 'README.md').read_text(encoding='utf-8')
    assert readme.startswith('# Document ingest\n') and 'store listing' in readme
    assert (tmp_path / 'pipelines' / 'ingest' / 'assets').is_dir()
    # The scaffold packs as-is: the block's declared files resolve
    assert pack_pipe(str(tmp_path / created['pipePath'])).files == ['ingest.pipe', 'README.md', 'icon.svg']


def test_scaffold_refuses_an_invalid_id_and_an_existing_pipe_and_honours_dir(tmp_path):
    with pytest.raises(ValueError, match='invalid'):
        scaffold_pipe(str(tmp_path), 'acme.ingest')
    scaffold_pipe(str(tmp_path), 'ingest')
    with pytest.raises(ValueError, match='already exists'):
        scaffold_pipe(str(tmp_path), 'ingest')
    assert scaffold_pipe(str(tmp_path), 'ingest', dir='flows')['pipePath'] == 'flows/ingest/ingest.pipe'


def test_scaffold_never_replaces_an_existing_asset_and_stays_inside_the_workspace(tmp_path):
    """An existing README or icon beside a new pipe is kept (two pipes may share a folder); a dir outside the workspace is refused."""
    folder = tmp_path / 'pipelines' / 'shared'
    folder.mkdir(parents=True)
    (folder / 'README.md').write_text('# Mine\n', encoding='utf-8')
    with pytest.raises(ValueError, match='"pipelines/shared/README.md" already exists'):
        scaffold_pipe(str(tmp_path), 'shared')
    assert (folder / 'README.md').read_text(encoding='utf-8') == '# Mine\n'
    assert not (folder / 'shared.pipe').exists()
    with pytest.raises(ValueError, match='must resolve to a folder inside the workspace'):
        scaffold_pipe(str(tmp_path / 'ws'), 'ingest', dir='../outside')
    assert not (tmp_path / 'outside').exists()
