# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Exercise file_get through real HTTP parsing with only requests mocked.

GitHub's Contents API carries content up to 1 MB. Above that it returns the metadata
with an empty ``content`` and ``encoding: "none"``; above 100 MB it refuses the file
with a 403 whose error code is ``too_large``. Each case must come back as a result an
agent can act on, never as silent empty content.
"""

import base64
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests

from ._stubs import scoped_stubs

TOKEN = 'sentinel-private-token-2464'
HEADERS = {
    'X-RateLimit-Remaining': '49',
    'X-RateLimit-Limit': '5000',
    'X-RateLimit-Reset': '2000000000',
    'X-RateLimit-Resource': 'core',
}

CONTENTS_URL = 'https://api.github.com/repos/owner/repo/contents/src/app.py'
BLOB_URL = 'https://api.github.com/repos/owner/repo/git/blobs/blob-sha'
HTML_URL = 'https://github.com/owner/repo/blob/main/src/app.py'
DOWNLOAD_URL = 'https://raw.githubusercontent.com/owner/repo/main/src/app.py'
LARGE_TEXT = 'print("ligne é")\n' * 100_000  # 1.8 MB, over the Contents API limit


def response(data, status=200, headers=None) -> requests.Response:
    """Build a real ``requests.Response`` carrying ``data`` as its JSON body."""
    resp = requests.Response()
    resp.status_code = status
    resp.headers.update(HEADERS if headers is None else headers)
    resp._content = json.dumps(data).encode()
    return resp


@pytest.fixture
def node(monkeypatch):
    """A PAT node in read-only mode with only ``requests.request`` mocked."""
    with scoped_stubs():
        from tool_github import IInstance
        from tool_github import github_client

        inst = IInstance()
        inst.IGlobal = SimpleNamespace(
            auth_type='pat',
            token=TOKEN,
            private_key_pem='',
            default_repo='owner/repo',
            read_only=True,
            get_token=Mock(return_value=TOKEN),
        )
        request = Mock()
        monkeypatch.setattr(github_client.requests, 'request', request)
        yield inst, request, github_client


# The default max_bytes is the 1 MiB boundary, so a test that reads a larger file asks for it.
BIG = {'max_bytes': 8 * 1024 * 1024}


def contents(size, content=b'', encoding='base64', sha='blob-sha'):
    """The Contents API's file object; ``encoding='none'`` is what GitHub sends over 1 MB."""
    return response(
        {
            'type': 'file',
            'name': 'app.py',
            'path': 'src/app.py',
            'sha': sha,
            'size': size,
            'encoding': encoding,
            'content': base64.encodebytes(content).decode() if encoding == 'base64' else '',
            'html_url': HTML_URL,
            'download_url': DOWNLOAD_URL,
        }
    )


def blob(content: bytes):
    """The Git blob API's object: content is always base64, broken into lines by GitHub."""
    return response(
        {'sha': 'blob-sha', 'size': len(content), 'encoding': 'base64', 'content': base64.encodebytes(content).decode()}
    )


def invalid_json():
    resp = response(None)
    resp._content = b'<html>upstream failure</html>'
    return resp


def test_small_file_keeps_the_existing_shape(node):
    inst, request, _ = node
    request.return_value = contents(9, b'print(1)\n')
    result = inst.file_get({'path': '/src/app.py', 'ref': 'main'})
    assert result == {
        'found': True,
        'path': 'src/app.py',
        'name': 'app.py',
        'sha': 'blob-sha',
        'size': 9,
        'content': 'print(1)\n',
        'html_url': HTML_URL,
        'download_url': DOWNLOAD_URL,
    }
    assert request.call_count == 1
    assert request.call_args.args == ('GET', CONTENTS_URL)
    assert request.call_args.kwargs['params'] == {'ref': 'main'}
    assert request.call_args.kwargs['headers']['Authorization'] == f'Bearer {TOKEN}'


def test_empty_file_is_empty_content_without_a_blob_read(node):
    inst, request, _ = node
    request.return_value = contents(0, b'')
    result = inst.file_get({'path': 'src/app.py'})
    assert result['content'] == ''
    assert 'message' not in result
    assert request.call_count == 1


def test_large_file_is_read_through_the_blob_api(node):
    inst, request, _ = node
    size = len(LARGE_TEXT.encode())
    request.side_effect = [contents(size, encoding='none'), blob(LARGE_TEXT.encode())]
    result = inst.file_get({'path': 'src/app.py', 'ref': 'main', **BIG})
    assert result['content'] == LARGE_TEXT
    assert result['size'] == size
    assert result['sha'] == 'blob-sha'
    assert 'message' not in result
    assert request.call_count == 2
    second = request.call_args_list[1]
    assert second.args == ('GET', BLOB_URL)
    assert second.kwargs['params'] == {}
    assert second.kwargs['headers']['Authorization'] == f'Bearer {TOKEN}'


def test_a_file_over_the_default_max_bytes_is_refused_before_its_blob_is_downloaded(node):
    inst, request, _ = node
    size = 1024 * 1024 + 1
    request.return_value = contents(size, encoding='none')
    result = inst.file_get({'path': 'src/app.py'})
    assert result['found'] is True
    assert result['content'] is None
    assert result['size'] == size
    assert result['message'] == (
        f'The file is {size} bytes, more than max_bytes (1048576), so its content was not downloaded. '
        'Pass a larger max_bytes (up to 104857600) to read it, or download it from download_url.'
    )
    # Only the metadata request: the blob was never asked for.
    assert request.call_count == 1
    assert request.call_args.args == ('GET', CONTENTS_URL)


def test_a_file_at_the_default_max_bytes_is_still_read(node):
    inst, request, _ = node
    payload = b'a' * (1024 * 1024)
    request.side_effect = [contents(len(payload), encoding='none'), blob(payload)]
    result = inst.file_get({'path': 'src/app.py'})
    assert len(result['content']) == len(payload)
    assert 'message' not in result
    assert request.call_count == 2


def test_a_larger_max_bytes_reads_a_file_over_the_default(node):
    inst, request, _ = node
    payload = b'b' * (1024 * 1024 + 4096)
    request.side_effect = [contents(len(payload), encoding='none'), blob(payload)]
    result = inst.file_get({'path': 'src/app.py', 'max_bytes': 2 * 1024 * 1024})
    assert len(result['content']) == len(payload)
    assert 'message' not in result
    assert request.call_args.args == ('GET', BLOB_URL)


def test_a_raised_max_bytes_still_refuses_a_file_over_it(node):
    inst, request, _ = node
    request.return_value = contents(3_000_000, encoding='none')
    result = inst.file_get({'path': 'src/app.py', 'max_bytes': 2_000_000})
    assert result['content'] is None
    assert 'more than max_bytes (2000000)' in result['message']
    assert request.call_count == 1


@pytest.mark.parametrize('value', ['8388608', 1.5, True, [8388608], 1048575, 104857601])
def test_an_invalid_max_bytes_is_refused_before_any_request(node, value):
    inst, request, _ = node
    with pytest.raises(ValueError, match='^file_get: "max_bytes" must be an integer'):
        inst.file_get({'path': 'src/app.py', 'max_bytes': value})
    request.assert_not_called()


def test_large_binary_file_is_reported_not_decoded(node):
    inst, request, _ = node
    payload = b'\x89PNG\r\n\x1a\n' + b'\x00' * 1_048_577
    request.side_effect = [contents(len(payload), encoding='none'), blob(payload)]
    result = inst.file_get({'path': 'src/app.py', **BIG})
    assert result['found'] is True
    assert result['content'] is None
    assert result['size'] == len(payload)
    assert 'binary' in result['message']
    assert 'download_url' in result['message']


@pytest.mark.parametrize(('nul_at', 'binary'), [(7999, True), (8000, False)])
def test_binary_probe_covers_exactly_the_first_8000_bytes(node, nul_at, binary):
    inst, request, _ = node
    payload = bytearray(b'a' * 1_048_577)
    payload[nul_at] = 0
    request.side_effect = [contents(len(payload), encoding='none'), blob(bytes(payload))]
    result = inst.file_get({'path': 'src/app.py', **BIG})
    if binary:
        assert result['content'] is None
        assert 'binary' in result['message']
    else:
        assert result['content'] == bytes(payload).decode()
        assert 'message' not in result


def test_short_blob_body_is_withheld_not_returned_incomplete(node):
    inst, request, _ = node
    request.side_effect = [contents(2_000_000, encoding='none'), blob(b'only the start')]
    result = inst.file_get({'path': 'src/app.py', **BIG})
    assert result['content'] is None
    assert 'returned 14 bytes for a 2000000-byte file' in result['message']
    assert 'download_url' in result['message']


@pytest.mark.parametrize('status', [403, 404, 502])
def test_failed_blob_read_says_why_instead_of_empty_content(node, status):
    inst, request, _ = node
    request.side_effect = [
        contents(2_000_000, encoding='none'),
        response({'message': 'Blob unavailable', 'documentation_url': 'https://docs.github.com/rest'}, status),
    ]
    result = inst.file_get({'path': 'src/app.py', **BIG})
    assert result['found'] is True
    assert result['content'] is None
    assert result['sha'] == 'blob-sha'
    assert result['size'] == 2_000_000
    assert result['download_url'] == DOWNLOAD_URL
    assert 'over the 1 MB' in result['message']
    assert f'GitHub API {status}: Blob unavailable' in result['message']
    assert 'tool_git' in result['message']
    assert TOKEN not in json.dumps(result)
    assert request.call_count == 2


@pytest.mark.parametrize(
    'failure',
    [requests.ConnectionError(TOKEN), requests.Timeout(TOKEN), invalid_json()],
    ids=['connection', 'timeout', 'invalid-json'],
)
def test_blob_transport_or_decoding_failure_keeps_the_metadata_without_exception_text(node, failure):
    inst, request, _ = node
    request.side_effect = [contents(2_000_000, encoding='none'), failure]
    result = inst.file_get({'path': 'src/app.py', **BIG})
    assert result['found'] is True
    assert result['content'] is None
    assert result['sha'] == 'blob-sha'
    assert 'over the 1 MB' in result['message']
    assert 'GitHub request failed or returned invalid JSON' in result['message']
    assert TOKEN not in json.dumps(result)


def test_large_file_without_a_blob_sha_is_reported_without_a_request(node):
    inst, request, _ = node
    request.return_value = contents(2_000_000, encoding='none', sha=None)
    result = inst.file_get({'path': 'src/app.py', **BIG})
    assert result['content'] is None
    assert 'no blob SHA' in result['message']
    assert request.call_count == 1


@pytest.mark.parametrize('encoded', ['a', '\u00e9'])
def test_malformed_blob_base64_keeps_metadata(node, encoded):
    inst, request, _ = node
    request.side_effect = [
        contents(2_000_000, encoding='none'),
        response({'encoding': 'base64', 'content': encoded}),
    ]
    result = inst.file_get({'path': 'src/app.py', **BIG})
    assert result['found'] is True
    assert result['content'] is None
    assert result['sha'] == 'blob-sha'
    assert result['size'] == 2_000_000
    assert 'Git blob read failed' in result['message']
    assert request.call_count == 2


def test_file_the_contents_api_refuses_as_too_large_is_a_result_not_an_exception(node):
    inst, request, _ = node
    request.return_value = response(
        {
            'message': 'This API returns blobs up to 1 MB in size. The requested blob is too large to fetch via the API.',
            'errors': [{'resource': 'Blob', 'field': 'data', 'code': 'too_large'}],
            'documentation_url': 'https://docs.github.com/rest/repos/contents#get-repository-content',
        },
        403,
    )
    result = inst.file_get({'path': '/data/dump.bin'})
    assert result['found'] is True
    assert result['path'] == 'data/dump.bin'
    assert result['content'] is None
    assert 'too large' in result['message']
    assert 'tool_git' in result['message']
    assert request.call_count == 1


def test_other_403s_still_raise(node):
    inst, request, client = node
    request.return_value = response({'message': 'Resource not accessible by integration'}, 403)
    with pytest.raises(client.GitHubAPIError, match='not accessible'):
        inst.file_get({'path': 'src/app.py'})


def test_missing_file_is_found_false(node):
    inst, request, _ = node
    request.return_value = response({'message': 'Not Found'}, 404, headers={})
    assert inst.file_get({'path': 'src/app.py'}) == {'found': False, 'message': 'GitHub API 404: Not Found'}


def test_directory_path_is_an_error(node):
    inst, request, _ = node
    request.return_value = response([{'name': 'app.py', 'path': 'src/app.py', 'type': 'file'}])
    with pytest.raises(ValueError, match='directory'):
        inst.file_get({'path': 'src'})
