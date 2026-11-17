"""The pipeline bundle packer (plan 9, B7): one folder, one .pipe, the manifest, readme, icon and assets."""

import io
import json
import zipfile

import pytest

from rocketride._pipe_bundle import pack_pipe_bundle, pipe_bundle_folder_of, pipe_of_bundle, read_pipe_manifest

PIPE = json.dumps({'project_id': 'docBrain', 'components': []})


def _bundle(tmp_path, files):
    """Write one bundle folder with the given files and return its path."""
    folder = tmp_path / 'pipelines' / 'docBrain'
    for rel, content in files.items():
        target = folder / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            target.write_bytes(content)
        else:
            target.write_text(content, encoding='utf-8')
    return str(folder)


def test_folder_of_accepts_the_folder_and_its_only_pipe_and_refuses_a_bare_pipe(tmp_path):
    folder = _bundle(tmp_path, {'docBrain.pipe': PIPE})
    assert pipe_bundle_folder_of(folder) == folder
    assert pipe_bundle_folder_of(f'{folder}/docBrain.pipe') == folder
    (tmp_path / 'pipelines' / 'docBrain' / 'other.pipe').write_text(PIPE, encoding='utf-8')
    assert pipe_bundle_folder_of(f'{folder}/docBrain.pipe') is None
    assert pipe_bundle_folder_of(folder) is None
    assert pipe_bundle_folder_of(str(tmp_path / 'missing')) is None
    with pytest.raises(ValueError, match='2 .pipe files'):
        pipe_of_bundle(folder)


def test_manifest_is_empty_without_a_file_and_checked_with_one(tmp_path):
    folder = _bundle(tmp_path, {'docBrain.pipe': PIPE})
    manifest_path = tmp_path / 'pipelines' / 'docBrain' / 'docBrain.rrpipe'
    assert read_pipe_manifest(folder, 'docBrain') == {}
    manifest_path.write_text(json.dumps({'name': 'Doc Brain', 'mode': 'paywall', 'tags': ['ocr']}), encoding='utf-8')
    assert read_pipe_manifest(folder, 'docBrain')['mode'] == 'paywall'
    manifest_path.write_text(json.dumps({'publisher': 'acme'}), encoding='utf-8')
    with pytest.raises(ValueError, match='unknown key "publisher"'):
        read_pipe_manifest(folder, 'docBrain')
    manifest_path.write_text(json.dumps({'mode': 'usage'}), encoding='utf-8')
    with pytest.raises(ValueError, match='mode must be'):
        read_pipe_manifest(folder, 'docBrain')
    manifest_path.write_text(json.dumps({'icon': '../x.svg'}), encoding='utf-8')
    with pytest.raises(ValueError, match='inside the bundle'):
        read_pipe_manifest(folder, 'docBrain')


def test_pack_takes_the_pipe_manifest_readme_icon_and_assets_deterministically(tmp_path):
    folder = _bundle(
        tmp_path,
        {
            'docBrain.pipe': PIPE,
            'docBrain.rrpipe': json.dumps({'name': 'Doc Brain', 'tagline': 'Reads documents'}),
            'readme.md': '# Doc Brain\n![flow](assets/flow.png)\n',
            'icon.svg': '<svg/>',
            'assets/flow.png': b'\x01\x02\x03',
            'notes.txt': 'not packed',
        },
    )
    packed = pack_pipe_bundle(folder)
    assert packed.pipeline['name'] == 'Doc Brain'
    assert packed.manifest['tagline'] == 'Reads documents'
    assert packed.files == ['docBrain.pipe', 'docBrain.rrpipe', 'readme.md', 'icon.svg', 'assets/flow.png']
    with zipfile.ZipFile(io.BytesIO(packed.data)) as zf:
        assert zf.namelist() == packed.files
    assert pack_pipe_bundle(folder).data == packed.data


def test_pack_names_the_pipeline_after_the_pipe_then_the_manifest_then_the_stem(tmp_path):
    assert pack_pipe_bundle(_bundle(tmp_path, {'docBrain.pipe': PIPE})).pipeline['name'] == 'docBrain'
    named = _bundle(tmp_path / 'b', {'docBrain.pipe': json.dumps({'name': 'From pipe'})})
    assert pack_pipe_bundle(named).pipeline['name'] == 'From pipe'


def test_pack_refuses_a_missing_manifest_icon_and_an_oversized_readme(tmp_path):
    folder = _bundle(tmp_path, {'docBrain.pipe': PIPE, 'docBrain.rrpipe': json.dumps({'icon': 'logo.png'})})
    with pytest.raises(ValueError, match='no such file'):
        pack_pipe_bundle(folder)
    big = _bundle(tmp_path / 'big', {'docBrain.pipe': PIPE, 'readme.md': 'x' * (1024 * 1024 + 1)})
    with pytest.raises(ValueError, match='readme.md exceeds'):
        pack_pipe_bundle(big)
