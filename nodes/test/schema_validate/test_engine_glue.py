# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Engine-glue tests for the schema_validate node (IGlobal + IInstance).

Mirrors the direct-instance harness used by extract_facts/test_extract_facts.py
and guardrails/test_all.py: rocketlib and ai.common.* are stubbed, the node's
source files are loaded via importlib.spec_from_file_location, the IGlobal is
built with __new__ + beginGlobal(), and the engine collaborator (self.instance)
is a SimpleNamespace that captures writeAnswers. No running server is required.

Covers the pieces the pure validate.py tests cannot reach:
  - IGlobal.beginGlobal: severity 'ok'/unhashable-value rejection, blank
    field-name fallback, category_metric_map coercion and malformed fallback;
  - IInstance.writeAnswers/closing: the isJson() lane gate, the getJson()
    ValueError fallback, and preventDefault + emit-exactly-once.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import types

_HERE = os.path.dirname(os.path.abspath(__file__))
_NODE_DIR = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'schema_validate')


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


def _load_classes(warnings_out=None):
    """Stub modules, load validate/IGlobal/IInstance from source, return classes."""
    saved = {}
    warn = warnings_out if warnings_out is not None else []

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
    stubs['rocketlib'].warning = lambda *a, **kw: warn.append(' '.join(str(x) for x in a))
    stubs['ai.common.schema'].Answer = FakeAnswer
    # Config.getNodeConfig is monkeypatched per-test via the returned holder.
    config_holder = {'raw': {}}
    stubs['ai.common.config'].Config = type(
        'FakeConfig', (), {'getNodeConfig': staticmethod(lambda lt, cc: config_holder['raw'])}
    )

    for name, stub in stubs.items():
        saved[name] = sys.modules.get(name)
        sys.modules[name] = stub

    # Snapshot any pre-existing node-package modules so cleanup restores them
    # instead of clobbering modules another test loaded first.
    pkg_prefix = 'schema_validate'
    saved_pkg = {k: v for k, v in sys.modules.items() if k == pkg_prefix or k.startswith(pkg_prefix + '.')}

    try:
        pkg_spec = importlib.util.spec_from_file_location(
            'schema_validate', os.path.join(_NODE_DIR, '__init__.py'), submodule_search_locations=[_NODE_DIR]
        )
        pkg_mod = importlib.util.module_from_spec(pkg_spec)
        sys.modules['schema_validate'] = pkg_mod

        for sub in ('validate', 'IGlobal', 'IInstance'):
            spec = importlib.util.spec_from_file_location(
                f'schema_validate.{sub}', os.path.join(_NODE_DIR, f'{sub}.py')
            )
            mod = importlib.util.module_from_spec(spec)
            sys.modules[f'schema_validate.{sub}'] = mod
            spec.loader.exec_module(mod)

        iglobal = sys.modules['schema_validate.IGlobal'].IGlobal
        iinstance = sys.modules['schema_validate.IInstance'].IInstance
        return iglobal, iinstance, config_holder
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


def _build_global(raw_config, warnings_out=None):
    IGlobal, IInstance, holder = _load_classes(warnings_out)
    holder['raw'] = raw_config
    glob = IGlobal.__new__(IGlobal)
    glob.glb = types.SimpleNamespace(logicalType='schema_validate', connConfig={})
    glob.beginGlobal()
    return glob, IInstance


def _build_instance(raw_config=None):
    glob, IInstance = _build_global(raw_config or {})
    inst = IInstance.__new__(IInstance)
    inst.IGlobal = glob
    captured = types.SimpleNamespace(answers=[], prevented=0)
    inst.instance = types.SimpleNamespace(writeAnswers=lambda a: captured.answers.append(a))
    inst.preventDefault = lambda: setattr(captured, 'prevented', captured.prevented + 1)
    return inst, captured


# --- IGlobal.beginGlobal -----------------------------------------------------


def test_beginglobal_defaults():
    glob, _ = _build_global({})
    assert glob.config['sign'] == 'warning'
    assert glob.config['require_provenance'] == 'error'
    assert glob.config['amount_field'] == 'amount'


def test_beginglobal_rejects_ok_severity():
    # 'ok' is not a valid severity for these fields; must fall back + warn.
    warns = []
    glob, _ = _build_global({'sign': 'ok', 'require_provenance': 'ok'}, warns)
    assert glob.config['sign'] == 'warning'
    assert glob.config['require_provenance'] == 'error'
    assert warns, 'an invalid severity should emit a warning'


def test_beginglobal_unhashable_severity_does_not_crash():
    # A list/dict supplied via a .pipe must not raise TypeError on the membership
    # test; it warns and falls back.
    glob, _ = _build_global({'sign': ['x'], 'require_provenance': {'a': 1}})
    assert glob.config['sign'] == 'warning'
    assert glob.config['require_provenance'] == 'error'


def test_beginglobal_blank_field_name_falls_back():
    glob, _ = _build_global({'amount_field': '   ', 'metric_field': ''})
    assert glob.config['amount_field'] == 'amount'
    assert glob.config['metric_field'] == 'metric'


def test_beginglobal_coerces_map_keywords():
    glob, _ = _build_global({'category_metric_map': {'Revenue': ['  Sales  ', 'NET SALES']}})
    assert glob.config['category_metric_map'] == {'Revenue': ['sales', 'net sales']}


def test_beginglobal_malformed_map_falls_back_to_default():
    warns = []
    glob, _ = _build_global({'category_metric_map': {'revenue': 'not-a-list'}}, warns)
    # Falls back to the built-in default map rather than crashing.
    assert 'revenue' in glob.config['category_metric_map']
    assert isinstance(glob.config['category_metric_map']['revenue'], list)
    assert warns


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
