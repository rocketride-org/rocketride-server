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
Engine glue for the schema_validate node: IGlobal reads the resolved config, IInstance owns the answers lane.

The IGlobal is built on the real resolver (the engine's schema for
``schema_validate``) and the engine collaborator (``self.instance``) is a
capturing stand-in. Covered:
  - IGlobal.beginGlobal: schema errors for stale severities, the normalised
    validation settings, the blank-field and malformed-map refusals
  - IInstance.writeAnswers/closing: the isJson() gate, pass-through of text,
    validation of fact records, preventDefault + exactly-once emission
"""

import json
import types

import pytest
from rocketlib.config import ConfigError

from nodes.schema_validate.IGlobal import IGlobal
from nodes.schema_validate.IInstance import IInstance


class FakeAnswer:
    """Fake Answer matching the ai.common.schema.Answer surface the node uses.

    ``isJson()`` returns ``expectJson``; ``getJson()`` parses the stored value
    (raising ValueError on non-JSON text, like the real one); ``getText()``
    stringifies it.
    """

    def __init__(self, expectJson=False):
        self.expectJson = expectJson
        self._answer = None

    def isJson(self):
        return self.expectJson

    def setAnswer(self, value):
        self._answer = value

    def getJson(self):
        if self._answer is None:
            return None
        if isinstance(self._answer, (dict, list)):
            return self._answer
        try:
            return json.loads(self._answer)
        except (json.JSONDecodeError, TypeError):
            raise ValueError('Answer is not in JSON format.')

    def getText(self):
        if self._answer is None:
            return ''
        if isinstance(self._answer, (dict, list)):
            return json.dumps(self._answer)
        return str(self._answer)


def _text_answer(text):
    a = FakeAnswer(expectJson=False)
    a.setAnswer(text)
    return a


def _json_answer(value):
    a = FakeAnswer(expectJson=True)
    a.setAnswer(value)
    return a


def _build_global(conn_config):
    """The node's IGlobal, begun on ``conn_config`` through the real resolver."""
    glob = IGlobal.__new__(IGlobal)
    glob.glb = types.SimpleNamespace(logicalType='schema_validate', connConfig=conn_config)
    glob.beginGlobal()
    return glob


def _build_instance(conn_config=None):
    glob = _build_global(conn_config or {})
    inst = IInstance.__new__(IInstance)
    inst.IGlobal = glob
    captured = types.SimpleNamespace(answers=[], prevented=0)
    inst.instance = types.SimpleNamespace(writeAnswers=lambda a: captured.answers.append(a))
    inst.preventDefault = lambda: setattr(captured, 'prevented', captured.prevented + 1)
    return inst, captured


# --- IGlobal.beginGlobal -----------------------------------------------------


def test_beginglobal_defaults():
    glob = _build_global({})
    assert glob.validation['sign'] == 'warning'
    assert glob.validation['require_provenance'] == 'error'
    assert glob.validation['amount_field'] == 'amount'
    assert 'revenue' in glob.validation['category_metric_map']


def test_beginglobal_rejects_ok_severity():
    # 'ok' is not a severity of these fields: the schema enum refuses it, naming the key.
    with pytest.raises(ConfigError, match='sign'):
        _build_global({'sign': 'ok'})
    with pytest.raises(ConfigError, match='require_provenance'):
        _build_global({'require_provenance': 'ok'})


def test_beginglobal_rejects_a_non_string_severity():
    # A list/dict supplied via a .pipe is a type error, not a TypeError on the membership test.
    with pytest.raises(ConfigError, match='sign'):
        _build_global({'sign': ['x']})


def test_beginglobal_strips_field_names_and_refuses_blank_ones():
    glob = _build_global({'amount_field': ' total '})
    assert glob.validation['amount_field'] == 'total'
    with pytest.raises(ValueError, match='metric_field'):
        _build_global({'metric_field': '   '})


def test_beginglobal_coerces_map_keywords():
    glob = _build_global({'category_metric_map': {'Revenue': ['  Sales  ', 'NET SALES']}})
    assert glob.validation['category_metric_map'] == {'Revenue': ['sales', 'net sales']}


def test_beginglobal_refuses_a_malformed_map():
    with pytest.raises(ValueError, match='category_metric_map'):
        _build_global({'category_metric_map': {'revenue': 'not-a-list'}})
    with pytest.raises(ConfigError, match='category_metric_map'):
        _build_global({'category_metric_map': 'not-an-object'})


# --- IInstance.writeAnswers / closing ---------------------------------------


def test_text_answer_that_looks_like_json_stays_text():
    # The headline isJson() gate: expectJson=False text is not upgraded even if
    # its content is valid JSON.
    inst, captured = _build_instance()
    inst.open(types.SimpleNamespace())
    inst.writeAnswers(_text_answer('{"a": 1}'))
    inst.closing()
    inst.close()
    assert len(captured.answers) == 1
    out = captured.answers[0]
    assert out.expectJson is False
    assert out.getText() == '{"a": 1}'


def test_json_fact_is_validated_and_kept_json():
    inst, captured = _build_instance()
    inst.open(types.SimpleNamespace())
    inst.writeAnswers(_json_answer({'metric': 'Cost of goods sold', 'category': 'revenue'}))
    inst.closing()
    inst.close()
    out = captured.answers[0]
    assert out.expectJson is True
    payload = out.getJson()
    assert payload['validation']['op'] == 'schema_validate'
    assert any(f['code'] == 'category_metric_mismatch' for f in payload['validation']['flags'])


def test_json_lane_non_json_text_falls_back_to_text():
    # expectJson=True but the stored value is not JSON -> getJson() raises
    # ValueError, and the node re-emits it as text rather than crashing.
    inst, captured = _build_instance()
    inst.open(types.SimpleNamespace())
    a = FakeAnswer(expectJson=True)
    a.setAnswer('not json at all')
    inst.writeAnswers(a)
    inst.closing()
    inst.close()
    out = captured.answers[0]
    assert out.expectJson is False
    assert out.getText() == 'not json at all'


def test_prevent_default_and_emit_exactly_once():
    inst, captured = _build_instance()
    inst.open(types.SimpleNamespace())
    inst.writeAnswers(_json_answer([{'metric': 'Net sales', 'category': 'revenue'}]))
    inst.writeAnswers(_text_answer('hello'))
    # Nothing is emitted until closing.
    assert captured.answers == []
    assert captured.prevented == 2
    inst.closing()
    inst.close()
    # Each received answer emitted exactly once, order preserved.
    assert len(captured.answers) == 2
    assert captured.answers[0].expectJson is True
    assert captured.answers[1].expectJson is False
    assert captured.answers[1].getText() == 'hello'
