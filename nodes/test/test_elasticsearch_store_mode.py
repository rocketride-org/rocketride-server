import pytest
from nodes.index_search.IGlobal import _parse_mode_elasticsearch
from nodes.index_search.constants import MODE_INDEX, MODE_VSTORE

def test_parse_mode_elasticsearch_legacy():
    # Legacy mode key behavior (string profile or boolean)
    assert _parse_mode_elasticsearch(True) == MODE_VSTORE
    assert _parse_mode_elasticsearch(False) == MODE_INDEX
    assert _parse_mode_elasticsearch('self-managed') == MODE_VSTORE
    assert _parse_mode_elasticsearch('index') == MODE_INDEX

def test_parse_mode_elasticsearch_store_mode():
    # New store_mode key behavior
    assert _parse_mode_elasticsearch(True) == MODE_VSTORE
    assert _parse_mode_elasticsearch(False) == MODE_INDEX
