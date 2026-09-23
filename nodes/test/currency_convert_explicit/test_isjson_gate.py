# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Engine-glue regression test for currency_convert_explicit's isJson() gate.

Mirrors the extract_facts / schema_validate importlib harness: rocketlib and
ai.common.* are stubbed, IGlobal.py + IInstance.py are loaded from source, and
writeAnswers is captured through a fake engine. Guards the fix for the bug where
a plain-text answer whose text merely looks like JSON was upgraded onto the JSON
lane (see issue: missing isJson() gate).
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import types

_HERE = os.path.dirname(os.path.abspath(__file__))
_NODE_DIR = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'currency_convert_explicit')


class FakeAnswer:
    """Fake Answer matching the ai.common.schema.Answer surface the node uses."""

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


def _load_classes(node_config):
    """Load the node's IGlobal/IInstance classes from source in isolation.

    Stubs ``rocketlib`` and ``ai.common.*`` in ``sys.modules`` (so the node
    imports without the engine), loads ``convert``/``IGlobal``/``IInstance`` from
    the node dir via ``importlib``, and restores the original ``sys.modules``
    entries in a ``finally`` block so no stub leaks into other test modules.
    ``Config.getNodeConfig`` is stubbed to return ``node_config``.
    """
    saved = {}

    class FakeIInstanceBase:
        IGlobal = None
        instance = None

        def __init__(self):
            pass

        def preventDefault(self):
            pass

    class FakeIGlobalBase:
        glb = None

    class FakeEntry:
        pass

    stubs = {
        'rocketlib': types.ModuleType('rocketlib'),
        'ai': types.ModuleType('ai'),
        'ai.common': types.ModuleType('ai.common'),
        'ai.common.schema': types.ModuleType('ai.common.schema'),
        'ai.common.config': types.ModuleType('ai.common.config'),
    }
    stubs['rocketlib'].IInstanceBase = FakeIInstanceBase
    stubs['rocketlib'].IGlobalBase = FakeIGlobalBase
    stubs['rocketlib'].Entry = FakeEntry
    stubs['rocketlib'].warning = lambda *a, **kw: None
    stubs['ai.common.schema'].Answer = FakeAnswer
    stubs['ai.common.config'].Config = type(
        'FakeConfig', (), {'getNodeConfig': staticmethod(lambda lt, cc: node_config)}
    )

    for name, stub in stubs.items():
        saved[name] = sys.modules.get(name)
        sys.modules[name] = stub

    # Snapshot any pre-existing node-package modules so cleanup restores them
    # instead of clobbering modules another test loaded first.
    pkg_prefix = 'currency_convert_explicit'
    saved_pkg = {k: v for k, v in sys.modules.items() if k == pkg_prefix or k.startswith(pkg_prefix + '.')}

    try:
        pkg_spec = importlib.util.spec_from_file_location(
            'currency_convert_explicit',
            os.path.join(_NODE_DIR, '__init__.py'),
            submodule_search_locations=[_NODE_DIR],
        )
        pkg_mod = importlib.util.module_from_spec(pkg_spec)
        sys.modules['currency_convert_explicit'] = pkg_mod

        for sub in ('convert', 'IGlobal', 'IInstance'):
            spec = importlib.util.spec_from_file_location(
                f'currency_convert_explicit.{sub}', os.path.join(_NODE_DIR, f'{sub}.py')
            )
            mod = importlib.util.module_from_spec(spec)
            sys.modules[f'currency_convert_explicit.{sub}'] = mod
            spec.loader.exec_module(mod)

        return (
            sys.modules['currency_convert_explicit.IGlobal'].IGlobal,
            sys.modules['currency_convert_explicit.IInstance'].IInstance,
        )
    finally:
        for name in stubs:
            if saved[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]
        # Drop what this helper loaded, then restore any pre-existing entries.
        for mod_name in [k for k in sys.modules if k == pkg_prefix or k.startswith(pkg_prefix + '.')]:
            sys.modules.pop(mod_name, None)
        sys.modules.update(saved_pkg)


def _build_instance(node_config):
    IGlobal, IInstance = _load_classes(node_config)
    glob = IGlobal.__new__(IGlobal)
    glob.glb = types.SimpleNamespace(logicalType='currency_convert_explicit', connConfig={})
    glob.beginGlobal()

    inst = IInstance.__new__(IInstance)
    inst.IGlobal = glob
    captured = types.SimpleNamespace(answers=[])
    inst.instance = types.SimpleNamespace(writeAnswers=lambda a: captured.answers.append(a))
    inst.preventDefault = lambda: None
    return inst, captured


_CFG = {'source_currency': 'EUR', 'target_currency': 'USD', 'rate': 1.1, 'decimals': 2}


def test_text_answer_that_looks_like_json_stays_text():
    # Regression: a plain-text answer whose content is valid JSON must NOT be
    # upgraded onto the JSON lane — it stays expectJson=False, unchanged.
    inst, captured = _build_instance(_CFG)
    inst.open(types.SimpleNamespace())
    inst.writeAnswers(_text_answer('{"amount": 10, "currency": "EUR"}'))
    inst.closing()
    inst.close()
    assert len(captured.answers) == 1
    out = captured.answers[0]
    assert out.isJson() is False
    assert out.getText() == '{"amount": 10, "currency": "EUR"}'
    # It was passed through verbatim, not converted.
    assert 'converted' not in out.getText()


def test_json_fact_is_still_converted():
    # A genuine JSON-lane fact in the source currency is still converted.
    inst, captured = _build_instance(_CFG)
    inst.open(types.SimpleNamespace())
    inst.writeAnswers(_json_answer({'amount': 10, 'currency': 'EUR'}))
    inst.closing()
    inst.close()
    out = captured.answers[0]
    assert out.isJson() is True
    payload = out.getJson()
    assert 'converted' in payload
