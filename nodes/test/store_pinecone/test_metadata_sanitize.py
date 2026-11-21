# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for the metadata Pinecone will actually accept.

Pinecone rejects the WHOLE upsert on the first value that is not a string,
number, boolean or list of strings, so one unset field loses a batch of 50
vectors rather than the field. These cover the three shapes that reach it: a
null, a nested value, and the content key that readers index directly.

Loads pinecone.py the same way test_record_updates.py does.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
_MOCKS_DIR = _ROOT / 'nodes' / 'test' / 'mocks'
_STUB_MODULE_NAMES = ('pinecone', 'pinecone.grpc')


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    """Resolve `pinecone` to the project mock, restoring sys.path on exit."""
    saved = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}
    saved_path = list(sys.path)
    sys.path.insert(0, str(_MOCKS_DIR))
    try:
        yield
    finally:
        sys.path[:] = saved_path
        for name, mod in saved.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


def _load_store_module() -> types.ModuleType:
    """Load the Pinecone Store module from source with temporary stubs."""
    with _scoped_stubs():
        pinecone_file = _ROOT / 'nodes' / 'src' / 'nodes' / 'store_pinecone' / 'pinecone.py'
        spec = importlib.util.spec_from_file_location('test_pinecone_sanitize_module', pinecone_file)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


_store_module = _load_store_module()
_sanitizeMetadata = _store_module._sanitizeMetadata


class TestNullValues:
    """A null takes the whole batch down, so it must not reach Pinecone."""

    def test_null_values_are_dropped(self):
        clean = _sanitizeMetadata({'signature': None, 'objectId': 'abc'})
        assert 'signature' not in clean
        assert clean['objectId'] == 'abc'

    def test_falsy_scalars_survive(self):
        # Dropping these too would lose real values: 0 and False are not absent.
        clean = _sanitizeMetadata({'tableId': 0, 'isTable': False, 'name': ''})
        assert clean['tableId'] == 0
        assert clean['isTable'] is False
        assert clean['name'] == ''


class TestNestedValues:
    """attach_source() stores a dict, which extra='allow' lets through."""

    def test_dict_is_json_encoded_not_dropped(self):
        clean = _sanitizeMetadata({'source': {'kind': 'frame', 'index': 3}})
        assert isinstance(clean['source'], str)
        assert 'frame' in clean['source']

    def test_list_of_strings_passes_through(self):
        clean = _sanitizeMetadata({'tags': ['a', 'b']})
        assert clean['tags'] == ['a', 'b']

    def test_list_of_nested_values_is_rendered(self):
        clean = _sanitizeMetadata({'items': [{'a': 1}]})
        assert all(isinstance(item, str) for item in clean['items'])

    def test_unserializable_value_still_yields_a_string(self):
        # default=str keeps one odd value from failing the batch.
        clean = _sanitizeMetadata({'when': object()})
        assert isinstance(clean['when'], str)


class TestContentKey:
    """Readers index metadata['content'] directly, so it must always be set."""

    def test_content_is_never_dropped_when_page_content_is_none(self):
        # The node writes `chunk.page_content or ''`; the sanitizer must keep it.
        clean = _sanitizeMetadata({'content': ''})
        assert clean['content'] == ''

    def test_a_none_content_would_have_been_dropped(self):
        # Guards the reason the node coerces to '' before calling this.
        clean = _sanitizeMetadata({'content': None})
        assert 'content' not in clean
