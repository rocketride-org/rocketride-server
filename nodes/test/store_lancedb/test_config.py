# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""How the LanceDB node reads its configuration.

Covers the uri guardrail (a relative directory stays under the engine data
directory), the storage options JSON, the table name and the numeric and enum
settings, plus which settings count as credentials.
"""

import os

import pytest

from nodes.store_lancedb.IGlobal import IGlobal
from nodes.store_lancedb.lancedb_config import (
    DEFAULT_TABLE,
    DISTANCES,
    is_object_uri,
    parse_storage_options,
    read_choice,
    read_count,
    resolve_uri,
    validate_table,
)


class TestResolveUri:
    def test_relative_path_goes_under_data_dir(self, tmp_path):
        assert resolve_uri('./lancedb', str(tmp_path)) == str(tmp_path / 'lancedb')

    def test_empty_uses_default_directory(self, tmp_path):
        assert resolve_uri('', str(tmp_path)) == str(tmp_path / 'lancedb')
        assert resolve_uri(None, str(tmp_path)) == str(tmp_path / 'lancedb')

    def test_absolute_path_is_kept(self, tmp_path):
        target = str(tmp_path / 'elsewhere' / 'tables')
        assert resolve_uri(target, str(tmp_path / 'data')) == os.path.normpath(target)

    @pytest.mark.parametrize('uri', ['../outside', './a/../../outside', 'a/../../../etc'])
    def test_relative_path_cannot_leave_data_dir(self, tmp_path, uri):
        with pytest.raises(ValueError, match='leaves the engine data directory'):
            resolve_uri(uri, str(tmp_path / 'data'))

    @pytest.mark.parametrize('uri', ['s3://bucket/rag', 'gs://bucket/rag', 'az://container/rag', 'S3://Bucket/rag'])
    def test_object_storage_uri_is_kept(self, tmp_path, uri):
        assert is_object_uri(uri)
        assert resolve_uri(uri, str(tmp_path)) == uri

    @pytest.mark.parametrize('uri', ['http://host/path', 'db://remote', 'file:///tmp/x'])
    def test_other_schemes_are_refused(self, tmp_path, uri):
        with pytest.raises(ValueError, match='Unsupported uri'):
            resolve_uri(uri, str(tmp_path))

    @pytest.mark.parametrize('uri', ['', None, '  ', './lancedb', '/abs/path'])
    def test_object_profile_needs_object_uri(self, tmp_path, uri):
        with pytest.raises(ValueError, match='object storage profile'):
            resolve_uri(uri, str(tmp_path), object_only=True)

    def test_object_profile_keeps_object_uri(self, tmp_path):
        assert resolve_uri('s3://bucket/rag', str(tmp_path), object_only=True) == 's3://bucket/rag'


class TestStorageOptions:
    def test_json_object(self):
        raw = '{"region": "us-east-1", "allow_http": true, "timeout": 30}'
        assert parse_storage_options(raw) == {'region': 'us-east-1', 'allow_http': 'true', 'timeout': '30'}

    def test_dict_is_accepted(self):
        assert parse_storage_options({'endpoint': 'http://localhost:9000'}) == {'endpoint': 'http://localhost:9000'}

    @pytest.mark.parametrize('raw', [None, '', '   ', '{}', {'key': None}])
    def test_empty_means_environment(self, raw):
        assert parse_storage_options(raw) is None

    def test_invalid_json_is_refused(self):
        with pytest.raises(ValueError, match='not valid JSON'):
            parse_storage_options('{region: us-east-1}')

    @pytest.mark.parametrize('raw', ['["a", "b"]', '"text"', '42'])
    def test_non_object_is_refused(self, raw):
        with pytest.raises(ValueError, match='must be a JSON object'):
            parse_storage_options(raw)


class TestTableAndSettings:
    def test_default_table(self):
        assert validate_table('') == DEFAULT_TABLE
        assert validate_table('  docs.v2-test_1 ') == 'docs.v2-test_1'

    @pytest.mark.parametrize('table', ['my table', 'a/b', "x'; drop", 'a' * 256])
    def test_invalid_table_is_refused(self, table):
        with pytest.raises(ValueError, match='Table name'):
            validate_table(table)

    def test_choice_is_case_insensitive(self):
        assert read_choice({'distance': ' L2 '}, 'distance', DISTANCES, 'cosine') == 'l2'
        assert read_choice({}, 'distance', DISTANCES, 'cosine') == 'cosine'

    def test_unknown_choice_is_refused(self):
        with pytest.raises(ValueError, match='distance must be one of'):
            read_choice({'distance': 'manhattan'}, 'distance', DISTANCES, 'cosine')

    def test_counts(self):
        assert read_count({'n': '25'}, 'n', 7) == 25
        assert read_count({'n': 0}, 'n', 7) == 0
        assert read_count({}, 'n', 7) == 7
        assert read_count({'n': ''}, 'n', 7) == 7
        assert read_count({'n': 3.0}, 'n', 7) == 3

    @pytest.mark.parametrize('value', [-1, 'many', 0.5, 2.5, '1.5', True, float('inf')])
    def test_bad_counts_are_refused(self, value):
        with pytest.raises(ValueError, match='n '):
            read_count({'n': value}, 'n', 7)


class TestCredentials:
    def test_local_directory_sends_no_credentials(self):
        assert IGlobal._credentials(None, {'uri': './lancedb', 'storageOptions': 'x'}) == []

    def test_object_storage_sends_storage_options(self):
        config = {'uri': 's3://bucket/rag', 'storageOptions': '${ROCKETRIDE_S3_OPTIONS}'}
        assert IGlobal._credentials(None, config) == [('storageOptions', '${ROCKETRIDE_S3_OPTIONS}')]
