# =============================================================================
# MIT License
#
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
One control, two calls: the per-call parameters of the remaining nodes (C.26).

Each test builds a node's control once (its IGlobal begun once, or, for a node
that keeps nothing on its control, the control's resolved config alone) and
binds two or more fresh instances to it with different params, the way the
engine binds one call after another. Each call must behave by its own values
and the control must not be rebuilt. The schemas themselves (which leaves are
params, which are caller-only, and that ``IGlobal.config`` refuses them) are
checked in ``test_c26_tools_params.py``. No test reaches a provider.
"""

from __future__ import annotations

import importlib
import json
from types import SimpleNamespace

import pytest
from ai.common.schema import Question

from .framework.controls import bind_call, control_config, resolved_config

# ==== Helpers ====================================================================


def _control(node: str, logical_type: str, stored=None):
    """
    One control's IGlobal over the engine-resolved config, begun once.

    Args:
        node: The node package (``nodes.<dir>``).
        logical_type: The service's logical type.
        stored: The node's stored config.

    Returns:
        The IGlobal after ``beginGlobal``.
    """
    glb = importlib.import_module(f'{node}.IGlobal').IGlobal()
    glb._config_restricted = control_config(logical_type, stored)
    glb.beginGlobal()
    return glb


def _call(node: str, glb, params=None):
    """A fresh instance of the node bound to one call of the control."""
    return bind_call(importlib.import_module(f'{node}.IInstance').IInstance(), glb, params)


class _JsonAnswer:
    """Stand-in for an incoming JSON ``Answer``: what the answer-lane nodes read of it."""

    def __init__(self, payload):
        self._payload = payload

    def isJson(self):  # noqa: N802 (engine method name)
        return True

    def getJson(self):  # noqa: N802 (engine method name)
        return self._payload

    def getText(self):  # noqa: N802 (engine method name)
        return json.dumps(self._payload)


def _no_prevent():
    """A preventDefault that fails the test: the call was expected to forward normally."""
    raise AssertionError('preventDefault was not expected on this call')


# ==== authoritative_overlay ======================================================


def test_authoritative_overlay_checks_each_call_against_its_own_company(monkeypatch):
    node = 'nodes.authoritative_overlay'
    asked = []

    def query_sec(concept, cik, filters, submission_cache):
        asked.append((cik, submission_cache))
        return [1.0]

    monkeypatch.setattr(importlib.import_module(f'{node}.IInstance'), 'query_sec', query_sec)
    glb = _control(node, 'authoritative-overlay')
    fact = {'concept': 'AccountsPayableCurrent', 'value': '$1', 'form': '10-K', 'fy': 2025}
    for params in ({}, {'cik': '789019'}, {}):
        instance = _call(node, glb, params)
        instance.preventDefault = _no_prevent
        instance.writeAnswers(_JsonAnswer(fact))

    (first, first_cache), (second, second_cache), (third, third_cache) = asked
    assert (first, second, third) == ('0000320193', '0000789019', '0000320193')
    # One control: the same company's submissions are reused, another company has its own
    assert first_cache is third_cache
    assert first_cache is not second_cache


# ==== normalize_facts ============================================================


def test_normalize_facts_applies_each_calls_rules():
    # The node keeps nothing on its control: the control is its config
    control = control_config('normalize_facts')
    fact = {'label': 'Weird Line XYZ', 'value': '42'}
    emitted = []
    for params in ({}, {'default_currency': 'eur', 'label_to_metric': {'Weird Line XYZ': 'widgets'}}):
        instance = _call('nodes.normalize_facts', control, params)
        instance.instance = SimpleNamespace(writeAnswers=emitted.append)
        instance.preventDefault = lambda: None
        instance.open(None)
        instance.writeAnswers(_JsonAnswer(dict(fact)))
        instance.closing()

    first, second = (answer.getJson()['normalized'] for answer in emitted)
    assert (first['currency'], first['metric']) == ('', 'weird line xyz')
    assert (second['currency'], second['metric']) == ('EUR', 'widgets')


# ==== schema_validate ============================================================


def test_schema_validate_checks_each_call_by_its_own_rules():
    control = control_config('schema_validate')
    fact = {'total': 5, 'currency': 'USD'}
    flagged = []
    for params in ({}, {'amount_field': 'total', 'require_provenance': 'off'}):
        instance = _call('nodes.schema_validate', control, params)
        instance.beginInstance()
        emitted = []
        instance.instance = SimpleNamespace(writeAnswers=emitted.append)
        instance.preventDefault = lambda: None
        instance.open(None)
        instance.writeAnswers(_JsonAnswer(dict(fact)))
        instance.closing()
        flagged.append({flag['code'] for flag in emitted[0].getJson()['validation']['flags']})

    assert {'missing_amount', 'missing_provenance'} <= flagged[0]
    assert not flagged[1] & {'missing_amount', 'missing_provenance'}


def test_schema_validate_refuses_a_blank_field_name_per_call():
    instance = _call('nodes.schema_validate', control_config('schema_validate'), {'amount_field': '  '})
    with pytest.raises(ValueError, match='amount_field must name a fact field'):
        instance.beginInstance()


# ==== preprocessor_code ==========================================================


def test_preprocessor_code_splits_each_call_in_its_own_language():
    seen = []
    splitter = SimpleNamespace(process=lambda text, language: seen.append(language) or [])
    glb = SimpleNamespace(config=control_config('preprocessor_code'), preprocessor=splitter)
    for params in ({}, {'language': 'python'}):
        instance = _call('nodes.preprocessor_code', glb, params)
        current = SimpleNamespace(objectId='o1', path='/a.py', permissionId=0, componentId='c1')
        instance.instance = SimpleNamespace(currentObject=current)
        instance.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(jobConfig={'nodeId': 'n1'}))
        instance._writeTableOrText('def f():\n    return 1\n')
    # One splitter (the control's parser cache) served both calls
    assert seen == ['auto', 'python']


# ==== preprocessor_langchain =====================================================


def test_preprocessor_langchain_keeps_one_splitter_per_distinct_setting():
    node = 'nodes.preprocessor_langchain'
    glb = _control(node, 'preprocessor_langchain')
    calls = [
        _call(node, glb),
        _call(node, glb, {'splitter': 'CharacterTextSplitter', 'strlen': 12, 'CharacterTextSplitter.separator': "' '"}),
        _call(node, glb),
    ]
    splitters = [glb.preprocessor_for(instance.settings) for instance in calls]

    # The same settings share one splitter; another call's settings build their own
    assert splitters[0] is splitters[2]
    assert splitters[0] is not splitters[1]
    assert (type(splitters[0]._preprocessor).__name__, splitters[0]._splitSize) == (
        'RecursiveCharacterTextSplitter',
        512,
    )
    assert (type(splitters[1]._preprocessor).__name__, splitters[1]._splitSize) == ('CharacterTextSplitter', 12)
    assert splitters[1]._preprocessor._separator == ' '
    glb.endGlobal()


def test_preprocessor_langchain_bounds_its_splitters():
    node = 'nodes.preprocessor_langchain'
    module = importlib.import_module(f'{node}.IGlobal')
    glb = _control(node, 'preprocessor_langchain')
    for size in range(1, module.MAX_SPLITTERS + 3):
        glb.preprocessor_for(_call(node, glb, {'strlen': size}).settings)
    assert len(glb._splitters) == module.MAX_SPLITTERS
    glb.endGlobal()


# ==== scan_cropper ===============================================================


def test_scan_cropper_binds_each_call_to_its_own_tunables(monkeypatch):
    bound = []
    process = importlib.import_module('nodes.scan_cropper.process')
    monkeypatch.setattr(
        process, 'build_split_scan', lambda settings: bound.append(settings) or (lambda image, want: None)
    )
    control = control_config('scan_cropper')
    for params in ({}, {'profile': 'loose', 'deskew': False, 'loose.detectSize': 900}):
        _call('nodes.scan_cropper', control, params).beginInstance()

    defaults = resolved_config('scan_cropper')
    first, second = bound
    assert (first.profile, first.deskew, first.detectSize) == (defaults.profile, defaults.deskew, defaults.detectSize)
    assert (second.profile, second.deskew, second.detectSize) == ('loose', False, 900)


# ==== guardrails =================================================================


def test_guardrails_applies_each_calls_policy():
    control = control_config('guardrails')
    blocking = {'profile': 'custom', 'custom.policy_mode': 'block', 'custom.blocked_topics': ['weapons']}
    outcomes = []
    for params in ({}, blocking):
        instance = _call('nodes.guardrails', control, params)
        instance.beginInstance()
        forwarded = []
        instance.instance = SimpleNamespace(writeQuestions=forwarded.append)
        instance.preventDefault = lambda: None
        question = Question()
        question.addQuestion('Where can I buy weapons?')
        instance.writeQuestions(question)
        outcomes.append(len(forwarded))

    # The basic policy has no topic list and forwards; the custom call blocks the topic
    assert outcomes == [1, 0]
