# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
The store mode and the text-search options as the resolved config hands them to IGlobal.

The mode is one enum shared by every deployment type (``vstore`` or
``index``); the text-search options apply only while the customize switch is
on, and the schema validates their values, so IGlobal reads them as they are.
"""

import sys
import types
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import rocketlib
from rocketlib.config import ConfigError, resolveConfig

from nodes.store_elasticsearch.constants import MODE_INDEX, MODE_VSTORE
from nodes.store_elasticsearch.IGlobal import IGlobal


def _resolve(conn_config):
    """Resolve an Elasticsearch node config exactly as IGlobal.beginGlobal() would."""
    return resolveConfig(rocketlib.getServiceSchema('elasticsearch'), conn_config)


def _begin_elasticsearch(monkeypatch, conn_config):
    """Run _begin_elasticsearch on the resolved config with the store stood in; return the IGlobal."""
    glb = IGlobal.__new__(IGlobal)
    glb.glb = SimpleNamespace(logicalType='elasticsearch')
    glb.IEndpoint = MagicMock()
    stub = types.ModuleType('nodes.store_elasticsearch.elasticsearch_store')
    stub.Store = MagicMock()
    monkeypatch.setitem(sys.modules, 'nodes.store_elasticsearch.elasticsearch_store', stub)
    glb._begin_elasticsearch(_resolve(conn_config), {})
    return glb


def test_the_default_mode_is_the_vector_store(monkeypatch):
    glb = _begin_elasticsearch(monkeypatch, {})
    assert glb.mode == MODE_VSTORE


def test_the_mode_is_shared_by_every_deployment_type(monkeypatch):
    glb = _begin_elasticsearch(monkeypatch, {'mode': 'index'})
    assert glb.mode == MODE_INDEX
    glb = _begin_elasticsearch(
        monkeypatch, {'mode': 'index', 'profile': 'cloud-hosted', 'cloud-hosted': {'host': 'h', 'apikey': 'k'}}
    )
    assert glb.mode == MODE_INDEX


def test_a_value_outside_the_enum_is_a_config_error():
    """The old boolean and free-text spellings are refused with the key named."""
    for stale in (True, 'self-managed', 'vector_database'):
        with pytest.raises(ConfigError, match='mode'):
            _resolve({'mode': stale})


def test_search_options_apply_only_while_the_switch_is_on(monkeypatch):
    glb = _begin_elasticsearch(
        monkeypatch, {'matchOperator': 'exact', 'slop': 3, 'highlight': True, 'fragment_size': 80}
    )
    assert (glb.search_enabled, glb.search_match_operator, glb.search_exact_slop) == (False, 'or', 0)
    assert (glb.search_highlight_enabled, glb.search_highlight_fragment_size) == (False, 250)

    glb = _begin_elasticsearch(
        monkeypatch, {'search': True, 'matchOperator': 'exact', 'slop': 3, 'highlight': True, 'fragment_size': 80}
    )
    assert (glb.search_enabled, glb.search_match_operator, glb.search_exact_slop) == (True, 'exact', 3)
    assert (glb.search_highlight_enabled, glb.search_highlight_fragment_size) == (True, 80)


def test_slop_counts_only_for_exact_phrase_matching(monkeypatch):
    glb = _begin_elasticsearch(monkeypatch, {'search': True, 'matchOperator': 'and', 'slop': 3})
    assert (glb.search_match_operator, glb.search_exact_slop) == ('and', 0)


def test_the_options_are_validated_by_the_schema():
    with pytest.raises(ConfigError, match='matchOperator'):
        _resolve({'matchOperator': 'fuzzy'})
    with pytest.raises(ConfigError, match='slop'):
        _resolve({'slop': -1})
