# =============================================================================
# RocketRide Engine
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

"""Unit tests for the Cypher -> Apache AGE translation layer.

The layer is a pure transform (no database), so everything here runs offline.
It is loaded in isolation from disk (no ``ai.__init__`` chain) — its only
external dependency is the antlr4 runtime.
"""

from __future__ import annotations

import importlib.util
import sys

from pathlib import Path

import pytest

pytest.importorskip('antlr4')

_AGE_DIR = Path(__file__).resolve().parents[2] / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'graph' / 'age'


def _load_age():
    name = '_test_rr_age'
    spec = importlib.util.spec_from_file_location(
        name, _AGE_DIR / '__init__.py', submodule_search_locations=[str(_AGE_DIR)]
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


age = _load_age()
SAFE = age.TranslateMode.SAFE
RAW = age.TranslateMode.RAW


# ---------------------------------------------------------------------------
# analysis
# ---------------------------------------------------------------------------


class TestAnalyze:
    def test_return_aliases_and_expressions(self):
        facts = age.analyze('MATCH (a) RETURN a.name AS name, count(a) AS cnt, a.x')
        assert [c.display_name for c in facts.return_columns] == ['name', 'cnt', 'a.x']

    def test_backticked_alias_stripped(self):
        facts = age.analyze('MATCH (n) RETURN n.a AS `weird name`')
        assert facts.return_columns[0].display_name == 'weird name'

    def test_with_projection_not_mistaken_for_return(self):
        facts = age.analyze('MATCH (n) WITH n.a AS x, n.b AS y RETURN x')
        assert [c.display_name for c in facts.return_columns] == ['x']

    def test_union_uses_first_branch(self):
        facts = age.analyze('MATCH (a) RETURN a.x UNION MATCH (b) RETURN b.y')
        assert [c.display_name for c in facts.return_columns] == ['a.x']

    def test_no_return_statement(self):
        facts = age.analyze("CREATE (n:P {name: 'x'})")
        assert facts.return_columns is None
        assert facts.write_clauses == {'CREATE'}
        assert facts.is_write

    def test_return_star_detected(self):
        assert age.analyze('MATCH (n) RETURN *').returns_star

    def test_write_clauses_detected_as_typed_contexts(self):
        facts = age.analyze('MATCH (n) SET n.a = 1 REMOVE n.b DELETE n')
        assert facts.write_clauses == {'SET', 'REMOVE', 'DELETE'}

    def test_merge_action_flag(self):
        facts = age.analyze('MERGE (n:P {k: 1}) ON CREATE SET n.v = 1 RETURN n')
        assert facts.has_merge_action
        # A SET outside MERGE does not raise the flag.
        assert not age.analyze('MATCH (n) SET n.a = 1').has_merge_action

    def test_var_length_ranges(self):
        facts = age.analyze('MATCH (a)-[*2..5]->(b)-[*3]->(c)-[*..4]->(d)-[*]->(e) RETURN a')
        assert facts.var_length_ranges == [(2, 5), (3, 3), (None, 4), (None, None)]

    def test_params_and_functions(self):
        facts = age.analyze('MATCH (n) WHERE n.a = $x AND n.b = $y RETURN toUpper(n.c)')
        assert facts.param_names == {'x', 'y'}
        assert facts.function_names == {'toupper'}

    def test_multi_label_and_where_label_check(self):
        assert age.analyze('MATCH (n:A:B) RETURN n').has_multi_label
        facts = age.analyze('MATCH (n) WHERE (n:Label) RETURN n')
        assert facts.has_where_label_check
        # Labels inside a MATCH pattern are not WHERE label checks.
        assert not age.analyze('MATCH (n:Label) RETURN n').has_where_label_check

    def test_syntax_error_raises_translation_error(self):
        with pytest.raises(age.AgeTranslationError, match='syntax error'):
            age.analyze('MATCHX (n RETURN n')

    def test_empty_query_raises(self):
        with pytest.raises(age.AgeTranslationError, match='Empty'):
            age.analyze('   ')


# ---------------------------------------------------------------------------
# firewall
# ---------------------------------------------------------------------------


class TestFirewall:
    def test_write_rejected_on_safe_path_only(self):
        with pytest.raises(age.AgeFirewallRejected, match='write_clause'):
            age.translate('CREATE (n)', mode=SAFE, graph_name='g')
        # Same statement passes on the raw path.
        assert age.translate('CREATE (n)', mode=RAW, graph_name='g').has_return is False

    def test_call_rejected_on_safe_path(self):
        with pytest.raises(age.AgeFirewallRejected, match='procedure_call'):
            age.translate('CALL db.labels()', mode=SAFE, graph_name='g')

    def test_unbounded_var_length_rejected_on_both_paths(self):
        for mode in (SAFE, RAW):
            with pytest.raises(age.AgeFirewallRejected, match='unbounded_var_length'):
                age.translate('MATCH (a)-[*]->(b) RETURN a', mode=mode, graph_name='g')

    def test_depth_cap_applies_to_raw_path_too(self):
        with pytest.raises(age.AgeFirewallRejected, match='max_var_length_depth'):
            age.translate('MATCH (a)-[*1..99]->(b) RETURN a', mode=RAW, graph_name='g')

    def test_depth_cap_configurable(self):
        config = age.FirewallConfig(max_var_length_depth=99)
        plan = age.translate('MATCH (a)-[*1..99]->(b) RETURN a', mode=SAFE, graph_name='g', firewall=config)
        assert plan.columns == ['a']

    def test_query_length_cap(self):
        config = age.FirewallConfig(max_query_length=30)
        with pytest.raises(age.AgeFirewallRejected, match='max_query_length'):
            age.translate('MATCH (averylongvariablename) RETURN averylongvariablename', graph_name='g', firewall=config)

    def test_length_cap_checked_before_parse(self):
        # An oversize query full of syntactically invalid text must produce the
        # LENGTH error, not a syntax error — proving the cap precedes the parse
        # (the parse is the expensive step the cap exists to bound).
        config = age.FirewallConfig(max_query_length=100)
        garbage = ':::not cypher at all::: ' * 50
        with pytest.raises(age.AgeFirewallRejected, match='max_query_length'):
            age.translate(garbage, graph_name='g', firewall=config)

    def test_deep_nesting_rejected_pre_parse(self):
        # ~14 stack frames per nesting level in the ANTLR parser; 100 levels
        # used to escape as a bare RecursionError (reviewer-reproduced).
        query = 'RETURN ' + '(' * 100 + '1' + ')' * 100
        with pytest.raises(age.AgeFirewallRejected, match='max_nesting_depth'):
            age.translate(query, graph_name='g')

    def test_deep_nesting_backstop_is_translation_error(self):
        # Even with the pre-parse cap lifted, deep nesting must surface as
        # AgeTranslationError (the layer's contract), never RecursionError.
        query = 'RETURN ' + '(' * 300 + '1' + ')' * 300
        config = age.FirewallConfig(max_nesting_depth=10_000)
        with pytest.raises(age.AgeTranslationError, match='nested too deeply'):
            age.translate(query, graph_name='g', firewall=config)

    def test_moderate_nesting_still_translates(self):
        query = 'RETURN ' + '(' * 10 + '1' + ')' * 10
        plan = age.translate(query, graph_name='g')
        assert plan.has_return is True


# ---------------------------------------------------------------------------
# capabilities
# ---------------------------------------------------------------------------


class TestCapabilities:
    def test_datetime_rejected_on_1_5_0(self):
        with pytest.raises(age.AgeUnsupportedFeature, match='datetime'):
            age.translate('MATCH (n) RETURN datetime()', graph_name='g')

    def test_return_star_rejected(self):
        with pytest.raises(age.AgeUnsupportedFeature, match='explicit'):
            age.translate('MATCH (n) RETURN *', graph_name='g')

    def test_order_by_alias_rejected(self):
        with pytest.raises(age.AgeUnsupportedFeature, match='order by the expression'):
            age.translate('MATCH (a)-[r:K]->(b) RETURN r.since AS since ORDER BY since', graph_name='g')
        # Ordering by the expression itself is fine.
        plan = age.translate('MATCH (a)-[r:K]->(b) RETURN r.since AS since ORDER BY r.since', graph_name='g')
        assert plan.columns == ['since']
        # A bare variable that is not an alias is not flagged.
        plan2 = age.translate('MATCH (n) RETURN n.name AS name ORDER BY n', graph_name='g')
        assert plan2.columns == ['name']

    def test_promoted_cells_reject_with_guidance(self):
        # Verified 2026-07-28 against the exact pin (PG 16.14 + AGE 1.5.0):
        # all four former-TBD constructs are syntax-level failures, so the
        # layer now rejects them pre-flight with an actionable alternative.
        cases = [
            ('MERGE (n:P {k: 1}) ON CREATE SET n.v = 1 RETURN n', 'separate SET'),
            ('MATCH (n) WHERE (n:P) RETURN n', 'pattern instead'),
            ('MATCH (n:A:B) RETURN n', 'category node'),
            # NB: 'MATCH p = shortestPath(...)' is not openCypher grammar and is
            # stopped even earlier, by the parser; the function-position form is
            # what reaches the capability gate.
            ('MATCH (a:P), (b:P) RETURN shortestPath((a)-[*..3]-(b))', 'variable-length'),
        ]
        for query, hint in cases:
            with pytest.raises(age.AgeUnsupportedFeature, match=hint):
                age.translate(query, mode=RAW, graph_name='g')

    def test_table_structure(self):
        assert age.DEFAULT_AGE_VERSION == '1.5.0'
        table = age.CAPABILITY_TABLES['1.5.0']
        assert table['datetime_function'].status is age.CellStatus.REJECT
        # No cell remains unverified: every 1.5.0 cell has an empirical status.
        tbd = {k for k, cap in table.items() if cap.status is age.CellStatus.TBD}
        assert tbd == set()
        for feature in ('merge_on_set', 'where_label_check', 'multi_label', 'shortest_path'):
            assert table[feature].status is age.CellStatus.REJECT

    def test_unknown_version_falls_back(self):
        with pytest.raises(age.AgeUnsupportedFeature):
            age.translate('MATCH (n) RETURN datetime()', graph_name='g', age_version='9.9.9')


# ---------------------------------------------------------------------------
# emit
# ---------------------------------------------------------------------------


class TestEmit:
    def test_envelope_shape_without_params(self):
        plan = age.translate('MATCH (n:P) RETURN n.name AS name, n', graph_name='mygraph', limit=7)
        select = plan.statements[plan.result_index]
        assert select.startswith("SELECT * FROM cypher('mygraph', $rr_cypher$")
        assert select.endswith('AS (c0 agtype, c1 agtype) LIMIT 7')
        assert plan.columns == ['name', 'n']
        assert plan.read_only is True
        # Session discipline: LOCAL-only settings precede the query.
        assert plan.statements[0] == 'SET LOCAL search_path = ag_catalog,"$user",public'
        assert plan.statements[1].startswith('SET LOCAL statement_timeout')

    def test_no_return_synthesizes_single_column(self):
        plan = age.translate('CREATE (n:P)', mode=RAW, graph_name='g')
        assert 'AS (v agtype)' in plan.statements[plan.result_index]
        assert plan.has_return is False

    def test_params_use_prepare_execute_deallocate(self):
        plan = age.translate('MATCH (n) WHERE n.a = $x RETURN n', params={'x': 1}, graph_name='g')
        prepare, execute, deallocate = plan.statements[2], plan.statements[3], plan.statements[4]
        assert prepare.startswith('PREPARE _rr_age_')
        assert '(agtype) AS SELECT * FROM cypher(' in prepare
        assert execute.startswith('EXECUTE _rr_age_') and execute.endswith('(%s::agtype)')
        assert plan.binds[3] == ('{"x": 1}',)
        assert deallocate.startswith('DEALLOCATE _rr_age_')
        assert plan.result_index == 3

    def test_params_without_placeholders_rejected(self):
        with pytest.raises(age.AgeTranslationError, match='references no'):
            age.translate('MATCH (n) RETURN n', params={'x': 1}, graph_name='g')

    def test_referenced_params_without_values_rejected(self):
        with pytest.raises(age.AgeTranslationError, match=r'no supplied values: \$x'):
            age.translate('MATCH (n) WHERE n.a = $x RETURN n', graph_name='g')

    def test_partially_supplied_params_rejected(self):
        with pytest.raises(age.AgeTranslationError, match=r'no supplied values: \$y'):
            age.translate(
                'MATCH (n) WHERE n.a = $x AND n.b = $y RETURN n',
                params={'x': 1},
                graph_name='g',
            )

    def test_dollar_tag_rotates_on_collision(self):
        plan = age.translate("MATCH (n) WHERE n.note = '$rr_cypher$x' RETURN n.note", graph_name='g')
        assert '$rr_cypher1$' in plan.statements[plan.result_index]

    def test_invalid_graph_name_rejected(self):
        with pytest.raises(age.AgeTranslationError, match='Invalid graph name'):
            age.translate('MATCH (n) RETURN n', graph_name='bad-name; DROP')

    def test_unserialisable_params_rejected(self):
        with pytest.raises(age.AgeTranslationError, match='JSON-serialisable'):
            age.translate('MATCH (n) WHERE n.a = $x RETURN n', params={'x': object()}, graph_name='g')


# ---------------------------------------------------------------------------
# decode
# ---------------------------------------------------------------------------


class TestDecode:
    def test_vertex(self):
        value = age.decode_agtype('{"id": 1, "label": "P", "properties": {"a": 3, "name": "x"}}::vertex')
        assert value == {'id': 1, 'label': 'P', 'properties': {'a': 3, 'name': 'x'}}

    def test_edge_carries_endpoints(self):
        value = age.decode_agtype('{"id": 5, "label": "K", "end_id": 2, "start_id": 1, "properties": {"w": 2}}::edge')
        assert value['start_id'] == 1
        assert value['end_id'] == 2
        assert value['properties'] == {'w': 2}

    def test_scalars_and_null(self):
        # Plain equality on purpose: decode converts agtype numerics through
        # Decimal -> float, which is exact for these literals, and
        # pytest.approx consults sys.modules['numpy'] at call time — under the
        # full xdist gate another worker test can leave a stubbed numpy there,
        # making approx itself blow up.
        assert age.decode_agtype('"alice"') == 'alice'
        assert age.decode_agtype('3.14') == 3.14
        assert age.decode_agtype('42') == 42
        assert age.decode_agtype('true') is True
        assert age.decode_agtype(None) is None

    def test_nested_containers(self):
        assert age.decode_agtype('[1, {"a": [2, 3]}]') == [1, {'a': [2, 3]}]

    def test_string_escapes_decoded(self):
        # agtype STRING follows the JSON string grammar; escapes must decode
        # to the real characters, not survive as literal backslash sequences.
        assert age.decode_agtype('"a\\nb"') == 'a\nb'
        assert age.decode_agtype('"say \\"hi\\""') == 'say "hi"'
        assert age.decode_agtype('"caf\\u00e9"') == 'café'
        value = age.decode_agtype('{"properties": {"k\\"ey": "v1\\tv2"}}::vertex')
        assert value['properties'] == {'k"ey': 'v1\tv2'}

    def test_decode_row_keys_by_display_names(self):
        plan = age.translate('MATCH (n) RETURN n.name AS name, n.age', graph_name='g')
        row = age.decode_row(plan, ('"alice"', '3'))
        assert row == {'name': 'alice', 'n.age': 3}

    def test_bad_agtype_raises(self):
        with pytest.raises(age.AgeTranslationError, match='agtype syntax error'):
            age.decode_agtype('{"unterminated')
