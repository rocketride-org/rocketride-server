# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the Supabase Storage service (fake supabase-py client, no network)."""

from __future__ import annotations

import base64
from types import SimpleNamespace

import pytest

from .._support import (
    API_CFG,
    FAKE_SECRET_KEY,
    FakeHttpClient,
    FakeResponse,
    FakeSupabaseClient,
    assert_no_secrets,
    cfg_with,
    config_key,
    engine_stubs,
    load_common_fields,
    load_service,
    make_global,
    make_instance,
    tool_levels,
)

with engine_stubs():
    from nodes.supabase.storage.IGlobal import IGlobal
    from nodes.supabase.storage.IInstance import IInstance

ALL_LEVELS = {
    'list_buckets': 'read',
    'list_files': 'read',
    'download_file': 'read',
    'create_signed_url': 'read',
    'upload_file': 'write',
    'create_bucket': 'admin',
    'delete_file': 'admin',
}

ARGS = {
    'list_buckets': {},
    'list_files': {'bucket': 'docs'},
    'download_file': {'bucket': 'docs', 'path': 'a.txt'},
    'create_signed_url': {'bucket': 'docs', 'path': 'a.txt'},
    'upload_file': {'bucket': 'docs', 'path': 'a.txt', 'content': 'hi'},
    'create_bucket': {'name': 'docs'},
    'delete_file': {'bucket': 'docs', 'paths': ['a.txt']},
}

SIGNED = {'signedURL': 'https://ref.supabase.co/storage/v1/object/sign/docs/a.txt?token=t'}

KB = 1024
MB = 1024 * 1024


def _object_route(path, bucket='docs'):
    return f'GET /storage/v1/object/{bucket}/{path}'


def _inst(access='read', results=None, files=None, **cfg):
    """``files`` maps a path in bucket "docs" to its bytes (or a FakeResponse), served by the capped GET."""
    client = FakeSupabaseClient(results or {})
    routes = {
        _object_route(path): body if isinstance(body, FakeResponse) else FakeResponse(200, body)
        for path, body in (files or {}).items()
    }
    glb = make_global(IGlobal, cfg_with(API_CFG, access=access, **cfg), client=client, http=FakeHttpClient(routes))
    return make_instance(IInstance, glb), client


# -----------------------------------------------------------------------------
# Registration and settings
# -----------------------------------------------------------------------------


def test_tool_levels():
    assert tool_levels(IInstance) == ALL_LEVELS


def test_services_file():
    svc = load_service('storage')
    assert svc['protocol'] == 'tool_supabase_storage://'
    assert svc['prefix'] == 'supabase_storage' == IGlobal.SERVICE
    assert svc['path'] == 'nodes.supabase.storage'
    assert svc['classType'] == ['tool'] and svc['capabilities'] == ['invoke'] and svc['lanes'] == {}
    profile = svc['preconfig']['profiles']['default']
    assert profile['authType'] == 'key' and profile['access'] == 'read'
    expected = {
        'inlineLimitKb': (256, 1, 4096),
        'uploadLimitMb': (10, 1, 50),
        'listLimit': (100, 1, 1000),
        'signedUrlSeconds': (3600, 60, 604800),
    }
    for key, bounds in expected.items():
        field = svc['fields'][f'supabase_storage.{key}']
        assert (field['default'], field['minimum'], field['maximum']) == bounds
        assert profile[key] == bounds[0]
        assert f'supabase_storage.{key}' in svc['shape'][0]['properties']
    shared = {config_key(f) for f in load_common_fields()}
    assert not [f for f in svc['fields'] if f.startswith('supabase_storage.') and config_key(f) in shared]


def test_settings_defaults_and_clamps():
    glb = _inst()[0].IGlobal
    assert (glb.inline_limit_bytes, glb.upload_limit_bytes, glb.list_limit, glb.signed_url_seconds) == (
        256 * KB,
        10 * MB,
        100,
        3600,
    )
    glb = _inst(inlineLimitKb=99999, uploadLimitMb=500, listLimit=5000, signedUrlSeconds=5)[0].IGlobal
    assert (glb.inline_limit_bytes, glb.upload_limit_bytes, glb.list_limit, glb.signed_url_seconds) == (
        4096 * KB,
        50 * MB,
        1000,
        60,
    )


@pytest.mark.parametrize('field', ['secretKey', 'url'])
def test_blank_required_field_stops_startup(field):
    with pytest.raises(ValueError, match=r'^supabase_storage: '):
        make_global(IGlobal, cfg_with(API_CFG, **{field: ''}))


# -----------------------------------------------------------------------------
# Access levels
# -----------------------------------------------------------------------------

_ORDER = ('read', 'write', 'admin')


@pytest.mark.parametrize(
    'tool,access',
    [(t, a) for t, need in ALL_LEVELS.items() for a in _ORDER if _ORDER.index(a) < _ORDER.index(need)],
)
def test_refused_below_level(tool, access):
    inst, client = _inst(access)
    with pytest.raises(PermissionError, match=f'supabase_storage.{tool} needs the "{ALL_LEVELS[tool]}" access level'):
        getattr(inst, tool)(dict(ARGS[tool]))
    assert client.calls == []


@pytest.mark.parametrize('tool', list(ALL_LEVELS))
def test_allowed_at_its_level(tool):
    results = {
        'storage.list_buckets': [],
        'storage.from_.list': [],
        'storage.from_.info': {'size': 2},
        'storage.from_.create_signed_url': SIGNED,
        'storage.from_.upload': SimpleNamespace(path='a.txt', Key='docs/a.txt'),
        'storage.create_bucket': {'name': 'docs'},
        'storage.from_.remove': [{'name': 'a.txt'}],
    }
    inst, client = _inst(ALL_LEVELS[tool], results, files={'a.txt': b'hi'})
    getattr(inst, tool)(dict(ARGS[tool]))
    assert client.calls


# -----------------------------------------------------------------------------
# Input checks
# -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    'path',
    ['', '   ', '/abs.txt', '../secret', 'a/../b', 'a/./b', 'a//b', 'a\\b', 'a\x00b', 'x' * 1025, 'r/50%25.txt'],
)
def test_bad_paths_are_refused_before_any_call(path):
    inst, client = _inst()
    with pytest.raises(ValueError, match=r'supabase_storage.download_file: "path"'):
        inst.download_file({'bucket': 'docs', 'path': path})
    assert client.calls == []


@pytest.mark.parametrize('bucket', ['', 'a/b', '..', 'a\\b', 'tab\tname', 'b' * 101])
def test_bad_bucket_names_are_refused(bucket):
    inst, client = _inst('admin')
    with pytest.raises(ValueError, match='"bucket"'):
        inst.list_files({'bucket': bucket})
    with pytest.raises(ValueError, match='"name"'):
        inst.create_bucket({'name': bucket})
    assert client.calls == []


@pytest.mark.parametrize('path', ['r/50%25.txt', 'a%2Fb', '50%.txt', '%2e%2e/secret'])
def test_a_percent_sign_is_refused_by_every_path_tool(path):
    """storage3 URL-decodes paths in info, upload, download and create_signed_url, not in remove.

    One rule for every tool: "%" is refused, so "r/50%25.txt" cannot be stored
    as "r/50%.txt" and then miss on download or delete, and "a%2Fb" cannot slip
    past the one-object check as "a/b".
    """
    inst, client = _inst('admin')
    calls = [
        lambda: inst.download_file({'bucket': 'docs', 'path': path}),
        lambda: inst.create_signed_url({'bucket': 'docs', 'path': path}),
        lambda: inst.upload_file({'bucket': 'docs', 'path': path, 'content': 'x'}),
        lambda: inst.delete_file({'bucket': 'docs', 'paths': [path]}),
        lambda: inst.list_files({'bucket': 'docs', 'prefix': path}),
    ]
    for call in calls:
        with pytest.raises(ValueError, match='must not contain "%"'):
            call()
    assert client.calls == []


def test_bad_prefix_is_refused():
    inst, client = _inst()
    with pytest.raises(ValueError, match='"prefix"'):
        inst.list_files({'bucket': 'docs', 'prefix': '../other'})
    assert client.calls == []


def test_bad_encoding_is_refused():
    inst, _ = _inst()
    with pytest.raises(ValueError, match='"as" must be one of'):
        inst.download_file({'bucket': 'docs', 'path': 'a.txt', 'as': 'hex'})


# -----------------------------------------------------------------------------
# list_buckets / list_files
# -----------------------------------------------------------------------------


def test_list_buckets_shape_and_truncation():
    buckets = [
        SimpleNamespace(id=f'b{i}', name=f'b{i}', owner='o', public=False, created_at='t', updated_at='t')
        for i in range(3)
    ]
    inst, _ = _inst(results={'storage.list_buckets': buckets}, listLimit=2)
    out = inst.list_buckets({})
    assert out['count'] == 2 and out['truncated'] is True
    assert out['buckets'][0] == {'id': 'b0', 'name': 'b0', 'public': False, 'created_at': 't', 'updated_at': 't'}


def test_list_files_shapes_entries_and_caps_limit():
    entries = [
        {'name': 'q1.csv', 'id': 'x', 'updated_at': 't', 'metadata': {'size': 10, 'mimetype': 'text/csv'}},
        {'name': 'archive', 'id': None, 'updated_at': None, 'metadata': None},
    ]
    inst, client = _inst(results={'storage.from_.list': entries}, listLimit=2)
    out = inst.list_files({'bucket': 'docs', 'prefix': 'reports/', 'limit': 50, 'offset': 4})
    assert client.calls_to('storage.from_') == [(('docs',), {})]
    assert client.calls_to('storage.from_.list') == [(('reports', {'limit': 2, 'offset': 4}), {})]
    assert out['files'] == [
        {
            'name': 'q1.csv',
            'path': 'reports/q1.csv',
            'is_folder': False,
            'size': 10,
            'content_type': 'text/csv',
            'updated_at': 't',
        },
        {
            'name': 'archive',
            'path': 'reports/archive',
            'is_folder': True,
            'size': None,
            'content_type': None,
            'updated_at': None,
        },
    ]
    assert out['more_may_exist'] is True


def test_list_files_root_default():
    inst, client = _inst(results={'storage.from_.list': []})
    out = inst.list_files({'bucket': 'docs'})
    assert client.calls_to('storage.from_.list') == [(('', {'limit': 100, 'offset': 0}), {})]
    assert out['more_may_exist'] is False and out['prefix'] == ''


# -----------------------------------------------------------------------------
# download_file: inline limit
# -----------------------------------------------------------------------------


def test_download_small_text_inline():
    inst, client = _inst(
        results={'storage.from_.info': {'size': 5, 'content_type': 'text/plain'}}, files={'a.txt': b'hello'}
    )
    out = inst.download_file({'bucket': 'docs', 'path': 'a.txt'})
    assert out == {
        'bucket': 'docs',
        'path': 'a.txt',
        'size': 5,
        'content_type': 'text/plain',
        'inline': True,
        'encoding': 'text',
        'content': 'hello',
    }
    assert 'storage.from_.create_signed_url' not in client.paths()


def test_download_binary_as_base64():
    data = bytes(range(256))
    inst, _ = _inst(results={'storage.from_.info': {'size': 256}}, files={'a.bin': data})
    out = inst.download_file({'bucket': 'docs', 'path': 'a.bin', 'as': 'base64'})
    assert base64.b64decode(out['content']) == data and out['encoding'] == 'base64'


def test_download_binary_as_text_says_use_base64():
    inst, _ = _inst(results={'storage.from_.info': {'size': 2}}, files={'a.bin': b'\xff\xfe'})
    with pytest.raises(ValueError, match='not UTF-8 text; call again with "as": "base64"'):
        inst.download_file({'bucket': 'docs', 'path': 'a.bin'})


def test_download_exactly_at_limit_is_inline():
    data = b'a' * (256 * KB)
    inst, _ = _inst(results={'storage.from_.info': {'size': len(data)}}, files={'a.txt': data})
    assert inst.download_file({'bucket': 'docs', 'path': 'a.txt'})['inline'] is True


def test_download_above_limit_returns_signed_url_without_downloading():
    inst, client = _inst(
        results={'storage.from_.info': {'size': 256 * KB + 1}, 'storage.from_.create_signed_url': SIGNED}
    )
    out = inst.download_file({'bucket': 'docs', 'path': 'big.pdf'})
    assert out['inline'] is False and out['signed_url'] == SIGNED['signedURL']
    assert out['expires_in'] == 3600 and 'content' not in out
    assert 'above the inline limit of 262144 bytes' in out['message']
    assert 'storage.from_.download' not in client.paths()
    assert inst.IGlobal.get_api()._http.requests == []
    assert client.calls_to('storage.from_.create_signed_url') == [(('big.pdf', 3600), {})]


def test_download_inline_limit_is_configurable():
    inst, client = _inst(
        results={'storage.from_.info': {'size': 2 * KB}, 'storage.from_.create_signed_url': SIGNED},
        inlineLimitKb=1,
        signedUrlSeconds=120,
    )
    out = inst.download_file({'bucket': 'docs', 'path': 'a.txt'})
    assert out['inline'] is False and out['expires_in'] == 120


OBJECT = 'GET /storage/v1/object/docs/a.txt'


def _inst_http(routes, results=None, **cfg):
    client = FakeSupabaseClient(results or {})
    http = FakeHttpClient(routes)
    glb = make_global(IGlobal, cfg_with(API_CFG, access='read', **cfg), client=client, http=http)
    return make_instance(IInstance, glb), client, http


def test_download_with_stale_small_size_still_reads_at_most_the_limit():
    """The info call says 10 bytes, the object is 10 MB: the capped read decides, the object is never held whole."""
    body = FakeResponse(200, b'a' * (10 * MB), headers={'content-type': 'text/plain'})
    inst, client, http = _inst_http(
        {OBJECT: body},
        results={'storage.from_.info': {'size': 10}, 'storage.from_.create_signed_url': SIGNED},
        inlineLimitKb=1,
    )
    out = inst.download_file({'bucket': 'docs', 'path': 'a.txt'})
    assert out['inline'] is False and out['size'] == 10 * MB and out['signed_url'] == SIGNED['signedURL']
    assert body.bytes_streamed <= 64 * KB
    assert 'storage.from_.download' not in client.paths()
    assert http.requests[-1]['stream'] is True


def test_download_without_size_info_reads_at_most_the_limit():
    """No size from /object/info: a large object is NOT fetched in full just to learn its length."""
    body = FakeResponse(200, b'a' * (10 * MB), headers={'content-type': 'text/plain'})
    inst, client, http = _inst_http(
        {OBJECT: body}, results={'storage.from_.info': {}, 'storage.from_.create_signed_url': SIGNED}, inlineLimitKb=1
    )
    out = inst.download_file({'bucket': 'docs', 'path': 'a.txt'})
    assert out['inline'] is False and out['size'] == 10 * MB and out['signed_url'] == SIGNED['signedURL']
    assert body.bytes_streamed <= 64 * KB
    assert 'storage.from_.download' not in client.paths()
    assert http.requests[-1]['stream'] is True and http.requests[-1]['headers']['apikey'] == FAKE_SECRET_KEY


def test_download_without_size_info_or_length_says_larger_than_the_limit():
    body = FakeResponse(200, b'a' * (2 * KB))
    del body.headers['content-length']
    inst, _, _ = _inst_http(
        {OBJECT: body}, results={'storage.from_.info': {}, 'storage.from_.create_signed_url': SIGNED}, inlineLimitKb=1
    )
    out = inst.download_file({'bucket': 'docs', 'path': 'a.txt'})
    assert out['inline'] is False and out['size'] is None and 'larger than 1024 bytes' in out['message']


def test_download_without_size_info_small_file_is_inline():
    body = FakeResponse(200, b'hello', headers={'content-type': 'text/plain'})
    inst, client, _ = _inst_http({OBJECT: body}, results={'storage.from_.info': {'name': 'a.txt'}})
    out = inst.download_file({'bucket': 'docs', 'path': 'a.txt'})
    assert out['inline'] is True and out['content'] == 'hello' and out['size'] == 5
    assert out['content_type'] == 'text/plain'
    assert 'storage.from_.download' not in client.paths()


def test_download_without_size_info_quotes_the_object_path():
    route = 'GET /storage/v1/object/docs/my%20dir/r%C3%A9sum%C3%A9%3F.txt'
    inst, _, http = _inst_http({route: FakeResponse(200, b'ok')}, results={'storage.from_.info': {}})
    assert inst.download_file({'bucket': 'docs', 'path': 'my dir/résumé?.txt'})['content'] == 'ok'
    assert http.requests[-1]['path'] == route.split(' ', 1)[1]


def test_download_missing_file_error():
    class StorageApiError(Exception):
        def __init__(self):
            super().__init__('Object not found')
            self.message, self.status, self.code = 'Object not found', 404, 'not_found'

    inst, _ = _inst(results={'storage.from_.info': StorageApiError()})
    with pytest.raises(RuntimeError, match=r'supabase_storage.download_file: \(HTTP 404, not_found\) Object not found'):
        inst.download_file({'bucket': 'docs', 'path': 'nope.txt'})


# -----------------------------------------------------------------------------
# create_signed_url
# -----------------------------------------------------------------------------


def test_create_signed_url_default_and_clamp():
    inst, client = _inst(results={'storage.from_.create_signed_url': {'signedUrl': 'https://u'}})
    assert inst.create_signed_url({'bucket': 'docs', 'path': 'a.txt'})['expires_in'] == 3600
    assert inst.create_signed_url({'bucket': 'docs', 'path': 'a.txt', 'expires_in': 10})['expires_in'] == 60
    out = inst.create_signed_url({'bucket': 'docs', 'path': 'a.txt', 'expires_in': 10**9})
    assert out == {'bucket': 'docs', 'path': 'a.txt', 'signed_url': 'https://u', 'expires_in': 604800}


def test_create_signed_url_without_url_fails():
    inst, _ = _inst(results={'storage.from_.create_signed_url': {'signedURL': None}})
    with pytest.raises(RuntimeError, match='no signed URL'):
        inst.create_signed_url({'bucket': 'docs', 'path': 'a.txt'})


# -----------------------------------------------------------------------------
# upload_file: upload limit
# -----------------------------------------------------------------------------


def test_upload_text():
    inst, client = _inst('write', {'storage.from_.upload': SimpleNamespace(path='n.md', Key='docs/n.md')})
    out = inst.upload_file({'bucket': 'docs', 'path': 'notes/n.md', 'content': 'héllo'})
    ((path, data, options), _) = client.calls_to('storage.from_.upload')[0]
    assert path == 'notes/n.md' and data == 'héllo'.encode('utf-8')
    assert options == {'content-type': 'text/markdown'}
    assert out == {'bucket': 'docs', 'path': 'notes/n.md', 'size': 6, 'content_type': 'text/markdown', 'upsert': False}


def test_upload_base64_with_upsert_and_type():
    raw = bytes(range(10))
    inst, client = _inst('write', {'storage.from_.upload': SimpleNamespace(path='x', Key='k')})
    inst.upload_file(
        {
            'bucket': 'docs',
            'path': 'blob',
            'content': base64.b64encode(raw).decode(),
            'encoding': 'base64',
            'content_type': 'image/png',
            'upsert': True,
        }
    )
    ((_path, data, options), _) = client.calls_to('storage.from_.upload')[0]
    assert data == raw and options == {'content-type': 'image/png', 'upsert': 'true'}


def test_upload_default_types():
    inst, client = _inst('write', {'storage.from_.upload': SimpleNamespace(path='x', Key='k')})
    inst.upload_file({'bucket': 'docs', 'path': 'noext', 'content': 'x'})
    inst.upload_file({'bucket': 'docs', 'path': 'noext2', 'content': 'eA==', 'encoding': 'base64'})
    types = [c[0][2]['content-type'] for c in client.calls_to('storage.from_.upload')]
    assert types == ['text/plain;charset=UTF-8', 'application/octet-stream']


def test_upload_over_limit_is_refused_before_sending():
    inst, client = _inst('write', uploadLimitMb=1)
    with pytest.raises(ValueError, match='larger than the upload limit of 1048576 bytes'):
        inst.upload_file({'bucket': 'docs', 'path': 'a.txt', 'content': 'a' * (MB + 1)})
    big = base64.b64encode(b'a' * (MB + 1)).decode()
    with pytest.raises(ValueError, match='larger than the upload limit'):
        inst.upload_file({'bucket': 'docs', 'path': 'a.bin', 'content': big, 'encoding': 'base64'})
    assert client.calls == []


def test_upload_exactly_at_limit_is_sent():
    inst, client = _inst('write', {'storage.from_.upload': SimpleNamespace(path='x', Key='k')}, uploadLimitMb=1)
    content = base64.b64encode(b'a' * MB).decode()
    assert inst.upload_file({'bucket': 'docs', 'path': 'a.bin', 'content': content, 'encoding': 'base64'})['size'] == MB


def test_upload_default_limit_is_10_mb():
    inst, client = _inst('write')
    with pytest.raises(ValueError, match='upload limit of 10485760 bytes'):
        inst.upload_file({'bucket': 'docs', 'path': 'a.txt', 'content': 'a' * (10 * MB + 1)})
    assert client.calls == []


def test_upload_rejects_bad_base64_and_missing_content():
    inst, client = _inst('write')
    with pytest.raises(ValueError, match='not valid base64'):
        inst.upload_file({'bucket': 'docs', 'path': 'a', 'content': '***', 'encoding': 'base64'})
    with pytest.raises(ValueError, match='"content" is required'):
        inst.upload_file({'bucket': 'docs', 'path': 'a'})
    assert client.calls == []


# -----------------------------------------------------------------------------
# create_bucket / delete_file
# -----------------------------------------------------------------------------


def test_create_bucket_private_by_default():
    inst, client = _inst('admin', {'storage.create_bucket': {'name': 'invoices'}})
    assert inst.create_bucket({'name': 'invoices'}) == {'name': 'invoices', 'public': False}
    assert client.calls_to('storage.create_bucket') == [(('invoices',), {'options': {'public': False}})]


def test_delete_file_reports_deleted_and_not_found():
    inst, client = _inst('admin', {'storage.from_.remove': [{'name': 'a.txt', 'bucket_id': 'docs'}]})
    out = inst.delete_file({'bucket': 'docs', 'paths': ['a.txt', 'gone.txt', 'a.txt']})
    assert client.calls_to('storage.from_.remove') == [((['a.txt', 'gone.txt'],), {})]
    assert out == {'bucket': 'docs', 'deleted': ['a.txt'], 'not_found': ['gone.txt']}


def test_delete_file_checks_every_path_and_the_count():
    inst, client = _inst('admin')
    with pytest.raises(ValueError, match='"paths"'):
        inst.delete_file({'bucket': 'docs', 'paths': ['ok.txt', '../escape']})
    with pytest.raises(ValueError, match='at most 1000'):
        inst.delete_file({'bucket': 'docs', 'paths': [f'f{i}' for i in range(1001)]})
    with pytest.raises(ValueError, match='non-empty list'):
        inst.delete_file({'bucket': 'docs', 'paths': []})
    assert client.calls == []


# -----------------------------------------------------------------------------
# Secrets
# -----------------------------------------------------------------------------


def test_errors_and_results_carry_no_secret():
    inst, _ = _inst(results={'storage.list_buckets': Exception(f'401 bad key {FAKE_SECRET_KEY}')})
    with pytest.raises(RuntimeError) as err:
        inst.list_buckets({})
    assert_no_secrets(str(err.value))
    inst, _ = _inst(results={'storage.from_.info': {'size': 30}}, files={'a.txt': f'k={FAKE_SECRET_KEY}'.encode()})
    assert_no_secrets(inst.download_file({'bucket': 'docs', 'path': 'a.txt'}))
