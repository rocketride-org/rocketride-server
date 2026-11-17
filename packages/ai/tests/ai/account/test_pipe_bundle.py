"""The server side of the pipeline bundle (plan 9, B7): the zip is read and guarded, the manifest shaped."""

import io
import json
import zipfile

import pytest

from ai.account.pipe_bundle import MAX_PIPE_README_BYTES, pipe_manifest, read_pipe_bundle

PIPE = {'project_id': 'docBrain', 'name': 'Doc Brain', 'source': 'webhook_1', 'components': []}


def _zip(files):
    """One bundle zip from {name: bytes|str}."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as zf:
        for name, content in files.items():
            zf.writestr(name, content if isinstance(content, bytes) else content.encode('utf-8'))
    return buffer.getvalue()


def test_a_bundle_reads_its_pipe_manifest_readme_icon_and_assets():
    bundle = read_pipe_bundle(
        _zip(
            {
                'docBrain.pipe': json.dumps(PIPE),
                'docBrain.rrpipe': json.dumps({'tagline': 'Reads documents', 'category': 'documents', 'tags': ['ocr']}),
                'readme.md': '# Doc Brain',
                'icon.svg': '<svg/>',
                'assets/flow.png': b'\x01\x02',
            }
        )
    )
    assert bundle.pipeline == PIPE and bundle.stem == 'docBrain'
    assert (bundle.readme, bundle.icon, bundle.assets) == ('readme.md', 'icon.svg', ['assets/flow.png'])
    assert bundle.content_entries == ['docBrain.rrpipe', 'readme.md', 'icon.svg', 'assets/flow.png']

    manifest = pipe_manifest(PIPE, bundle)
    assert manifest == {
        'name': 'Doc Brain',
        'description': '',
        'mode': 'free',
        'tagline': 'Reads documents',
        'categories': ['documents', 'ocr'],
        'icon': 'icon.svg',
        'readme': 'readme.md',
        'defaultSource': 'webhook_1',
    }


def test_a_dict_deploy_without_a_bundle_still_has_a_manifest():
    assert pipe_manifest({'project_id': 'p', 'description': 'd'}, None) == {
        'name': 'p',
        'description': 'd',
        'mode': 'free',
    }


@pytest.mark.parametrize(
    'files, message',
    [
        ({'readme.md': 'x'}, 'exactly one .pipe'),
        ({'a.pipe': json.dumps(PIPE), 'b.pipe': json.dumps(PIPE)}, 'exactly one .pipe'),
        ({'docBrain.pipe': 'not json'}, 'not valid JSON'),
        ({'docBrain.pipe': json.dumps(PIPE), 'docBrain.rrpipe': json.dumps({'publisher': 'acme'})}, 'unknown key'),
        ({'docBrain.pipe': json.dumps(PIPE), 'docBrain.rrpipe': json.dumps({'mode': 'usage'})}, 'mode must be'),
        ({'docBrain.pipe': json.dumps(PIPE), 'docBrain.rrpipe': json.dumps({'icon': 'logo.png'})}, 'no such file'),
        ({'docBrain.pipe': json.dumps(PIPE), 'notes.txt': 'x'}, 'not part of a pipeline bundle'),
        ({'docBrain.pipe': json.dumps(PIPE), 'readme.md': 'x' * (MAX_PIPE_README_BYTES + 1)}, 'readme.md exceeds'),
        ({'docBrain.pipe': json.dumps(PIPE), '../escape.md': 'x'}, 'unsafe path'),
    ],
)
def test_a_malformed_bundle_is_refused_by_name(files, message):
    with pytest.raises(ValueError, match=message):
        read_pipe_bundle(_zip(files))


def test_not_a_zip_is_refused():
    with pytest.raises(ValueError, match='not a valid zip'):
        read_pipe_bundle(b'plain bytes')


def test_the_manifests_icon_wins_over_a_default_name():
    bundle = read_pipe_bundle(
        _zip(
            {
                'docBrain.pipe': json.dumps(PIPE),
                'docBrain.rrpipe': json.dumps({'icon': 'assets/logo.png'}),
                'assets/logo.png': b'x',
            }
        )
    )
    assert bundle.icon == 'assets/logo.png' and bundle.assets == []
