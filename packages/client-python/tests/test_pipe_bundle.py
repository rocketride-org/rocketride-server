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


STORE = {**default_store_block(), 'tagline': 'Reads documents', 'icon': './icon.svg'}


def _default_block_without_readme() -> dict:
    """The default block without its readme: what the packer adds when no README.md sits beside the pipe."""
    block = dict(default_store_block())
    del block['readme']
    return block


def test_the_default_block_names_a_readme_and_no_icon_and_is_fresh_each_call():
    assert default_store_block() == {
        'tagline': '',
        'categories': ['pipeline'],
        'tags': [],
        'readme': './README.md',
        'links': {},
        'mode': 'free',
        'billing': {'plans': []},
    }
    assert 'icon' not in default_store_block()
    assert default_store_block() is not default_store_block()
    # The placeholder stays in the module for a pipeline that wants one
    assert PIPE_ICON_SVG == PLACEHOLDER_ICON_SVG


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
            '<img alt="see src=\'x.png\'" src="y.png"> <img width=40 src=bare.png>',
            '[mail](mailto:a@b.c) [data](data:image/png;base64,AAAA) [proto](//cdn/x.png) [anchor](#top)',
            '![again](assets/flow.png)',
            '`![code](assets/nope.png)`',
            '```',
            '[fenced](assets/nope2.png)',
            '```',
        ]
    )
    assert scan_readme_references(md) == [
        'assets/flow.png',
        'docs/guide.md',
        'assets/shot 1.png',
        'assets/b.gif',
        'y.png',
        'bare.png',
    ]


def test_scan_decodes_character_references_in_img_src_but_not_markdown_destinations():
    md = '<img src="assets/a&amp;b.png"> <img src=\'c&#x26;d.png\'> <img src=e&#38;f.png> <img src="q&quot;.png"> ![m](assets/a&amp;b.png)'
    assert scan_readme_references(md) == ['assets/a&b.png', 'c&d.png', 'e&f.png', 'q".png', 'assets/a&amp;b.png']
    # One table across the TS SDK, the pane and this scanner: a name outside the
    # five, or a legacy no-semicolon reference, stays as written.
    assert scan_readme_references('<img src="assets/a&copy;.png"> <img src="assets/chart&notes.png">') == [
        'assets/a&copy;.png',
        'assets/chart&notes.png',
    ]


def test_scan_takes_reference_definitions_angle_destinations_balanced_parentheses_and_skips_tilde_fences():
    md = '\n'.join(
        [
            '![Diagram][figure] and [the paper][ref]',
            '',
            '[figure]: assets/diagram.png',
            '[ref]: <https://example.com/paper.pdf> "Paper"',
            '[shot]: <assets/diagram one.png>',
            '![Two](<assets/plot two.png> "Two")',
            '![Plot](assets/plot(1).png)',
            '~~~markdown',
            '[Example](example.png)',
            '~~~',
        ]
    )
    assert scan_readme_references(md) == [
        'assets/diagram.png',
        'assets/diagram one.png',
        'assets/plot two.png',
        'assets/plot(1).png',
    ]


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
    # A block without an icon is the normal case: nothing to warn about
    assert packed.warnings == []


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
    a = pack_pipe(os.path.join(folder, 'a.pipe'))
    assert a.files == ['a.pipe', 'icon.svg']
    assert a.warnings == ['store.readme is not declared, so the listing has no page']
    assert pack_pipe(os.path.join(folder, 'b.pipe')).files == ['b.pipe', 'b.md', 'icon.svg']


def test_pack_adds_the_default_block_to_a_pipe_without_one_with_the_readme_beside_it(tmp_path):
    source = json.dumps({'components': [], 'project_id': 'bare'})
    folder = _folder(
        tmp_path,
        'bare',
        {
            'bare.pipe': source,
            'README.md': '# Bare\n![flow](assets/flow.png)\n',
            'assets/flow.png': b'\x01',
            'icon.svg': '<svg/>',
        },
    )
    packed = pack_pipe(os.path.join(folder, 'bare.pipe'))
    block = default_store_block()
    assert packed.store == block
    # The README and what it references are packed as for an authored block; no icon is
    assert packed.files == ['bare.pipe', 'README.md', 'assets/flow.png']
    assert packed.warnings == []
    # The zip's .pipe is the pipe plus the block as its last key: two-space JSON, a trailing newline
    with zipfile.ZipFile(io.BytesIO(packed.data)) as zf:
        entry = zf.read('bare.pipe').decode('utf-8')
    assert entry == json.dumps({'components': [], 'project_id': 'bare', 'store': block}, indent=2) + '\n'
    # The dict sent beside the zip is that pipe; only the dict has its display name filled (from the stem)
    assert 'name' not in json.loads(entry)
    assert packed.pipeline == {**json.loads(entry), 'name': 'bare'}
    # The file on disk is left as it is, and two packs are the same bytes
    with open(os.path.join(folder, 'bare.pipe'), encoding='utf-8') as handle:
        assert handle.read() == source
    assert pack_pipe(os.path.join(folder, 'bare.pipe')).data == packed.data


def test_pack_adds_the_default_block_without_a_readme_when_no_readme_sits_beside_the_pipe(tmp_path):
    folder = _folder(
        tmp_path, 'lone', {'lone.pipe': json.dumps({'components': [], 'name': 'Lone'}), 'icon.svg': '<svg/>'}
    )
    packed = pack_pipe(os.path.join(folder, 'lone.pipe'))
    block = _default_block_without_readme()
    assert packed.store == block
    assert packed.files == ['lone.pipe']
    assert packed.warnings == ['store.readme is not declared, so the listing has no page']
    with zipfile.ZipFile(io.BytesIO(packed.data)) as zf:
        entry = json.loads(zf.read('lone.pipe').decode('utf-8'))
    assert entry == {'components': [], 'name': 'Lone', 'store': block}
    assert list(entry)[-1] == 'store'
    assert packed.pipeline == entry
    # A folder named README.md is not the file the block would name
    as_dir = _folder(tmp_path, 'dir', {'dir.pipe': json.dumps({'components': []}), 'README.md/notes.txt': 'x'})
    assert pack_pipe(os.path.join(as_dir, 'dir.pipe')).store == block


def test_pack_writes_an_added_block_as_utf8_text_not_escapes(tmp_path):
    """The rewritten pipe keeps non-ASCII text as written (the TypeScript packer's JSON.stringify does)."""
    folder = _folder(tmp_path, 'utf', {'utf.pipe': json.dumps({'components': [], 'name': 'Café ☕'})})
    packed = pack_pipe(os.path.join(folder, 'utf.pipe'))
    with zipfile.ZipFile(io.BytesIO(packed.data)) as zf:
        raw = zf.read('utf.pipe')
    assert '"name": "Café ☕"'.encode('utf-8') in raw and raw.endswith(b'}\n')


def test_pack_keeps_a_pipe_that_has_a_store_block_as_its_bytes_on_disk(tmp_path):
    # Compact, oddly spaced JSON: an authored pipe is never re-serialized
    source = '{"components":[],  "project_id":"docBrain","name":"Doc Brain","store":{"tagline":"As written"}}'
    folder = _folder(tmp_path, 'raw', {'raw.pipe': source, 'README.md': 'not declared, not packed'})
    packed = pack_pipe(os.path.join(folder, 'raw.pipe'))
    with zipfile.ZipFile(io.BytesIO(packed.data)) as zf:
        assert zf.read('raw.pipe') == source.encode('utf-8')
    assert packed.files == ['raw.pipe']
    assert packed.pipeline == json.loads(source)
    assert packed.store == {'tagline': 'As written'}


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


def test_scaffold_writes_the_pipe_with_the_default_block_a_readme_and_assets_and_no_icon(tmp_path):
    created = scaffold_pipe(str(tmp_path), 'ingest', name='Document ingest')
    assert created == {
        'folder': 'pipelines/ingest',
        'pipePath': 'pipelines/ingest/ingest.pipe',
        'files': ['pipelines/ingest/ingest.pipe', 'pipelines/ingest/README.md'],
    }
    pipe = json.loads((tmp_path / 'pipelines' / 'ingest' / 'ingest.pipe').read_text(encoding='utf-8'))
    assert pipe == {
        'components': [],
        'project_id': 'ingest',
        'name': 'Document ingest',
        'description': '',
        'store': default_store_block(),
    }
    # No icon: the block names none and the folder holds none
    assert 'icon' not in pipe['store']
    assert sorted(os.listdir(tmp_path / 'pipelines' / 'ingest')) == ['README.md', 'assets', 'ingest.pipe']
    readme = (tmp_path / 'pipelines' / 'ingest' / 'README.md').read_text(encoding='utf-8')
    assert readme.startswith('# Document ingest\n') and 'store listing' in readme
    assert (tmp_path / 'pipelines' / 'ingest' / 'assets').is_dir()
    # The scaffold packs as-is: the block's declared file resolves
    packed = pack_pipe(str(tmp_path / created['pipePath']))
    assert packed.files == ['ingest.pipe', 'README.md']
    assert packed.warnings == []


def test_scaffold_refuses_an_invalid_id_and_an_existing_pipe_and_honours_dir(tmp_path):
    with pytest.raises(ValueError, match='invalid'):
        scaffold_pipe(str(tmp_path), 'acme.ingest')
    scaffold_pipe(str(tmp_path), 'ingest')
    with pytest.raises(ValueError, match='already exists'):
        scaffold_pipe(str(tmp_path), 'ingest')
    assert scaffold_pipe(str(tmp_path), 'ingest', dir='flows')['pipePath'] == 'flows/ingest/ingest.pipe'


def test_scaffold_never_replaces_an_existing_asset_and_stays_inside_the_workspace(tmp_path):
    """An existing README beside a new pipe is kept (two pipes may share a folder); a dir outside the workspace is refused."""
    folder = tmp_path / 'pipelines' / 'shared'
    folder.mkdir(parents=True)
    (folder / 'README.md').write_text('# Mine\n', encoding='utf-8')
    with pytest.raises(ValueError, match='"pipelines/shared/README.md" already exists'):
        scaffold_pipe(str(tmp_path), 'shared')
    assert (folder / 'README.md').read_text(encoding='utf-8') == '# Mine\n'
    assert not (folder / 'shared.pipe').exists()
    # An icon already in the folder is no output of the scaffold: it is left as it is
    branded = tmp_path / 'pipelines' / 'branded'
    branded.mkdir(parents=True)
    (branded / 'icon.svg').write_text('<svg id="mine"/>', encoding='utf-8')
    assert scaffold_pipe(str(tmp_path), 'branded')['files'] == [
        'pipelines/branded/branded.pipe',
        'pipelines/branded/README.md',
    ]
    assert (branded / 'icon.svg').read_text(encoding='utf-8') == '<svg id="mine"/>'
    with pytest.raises(ValueError, match='must resolve to a folder inside the workspace'):
        scaffold_pipe(str(tmp_path / 'ws'), 'ingest', dir='../outside')
    assert not (tmp_path / 'outside').exists()
