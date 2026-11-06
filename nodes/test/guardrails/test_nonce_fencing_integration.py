# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Focused tests for the guardrails nonce-fencing instance flow."""

import importlib.util
import os
import sys
import types

import pytest

_GUARDRAILS_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'nodes', 'guardrails')


class _QuestionText:
    def __init__(self, text):
        self.text = text


class _Question:
    def __init__(self, questions=None, context=None, instructions=None):
        self.questions = questions or []
        self.context = context or []
        self.instructions = instructions
        self.added = []

    def addInstruction(self, title, instruction):
        self.added.append((title, instruction))
        if self.instructions is None:
            self.instructions = []
        self.instructions.append({'subtitle': title, 'instructions': instruction})


def _load_instance():
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IInstanceBase = object
    rocketlib.Entry = object
    rocketlib.warning = lambda *_args, **_kwargs: None
    ai = types.ModuleType('ai')
    common = types.ModuleType('ai.common')
    schema = types.ModuleType('ai.common.schema')
    schema.Question = object
    schema.Answer = object
    global_mod = types.ModuleType('guardrails.IGlobal')
    global_mod.IGlobal = object
    sys.modules.update({
        'rocketlib': rocketlib,
        'ai': ai,
        'ai.common': common,
        'ai.common.schema': schema,
        'guardrails.IGlobal': global_mod,
    })

    nonce_spec = importlib.util.spec_from_file_location(
        'guardrails.nonce_fencer',
        os.path.join(_GUARDRAILS_DIR, 'nonce_fencer.py'),
    )
    nonce_mod = importlib.util.module_from_spec(nonce_spec)
    sys.modules['guardrails.nonce_fencer'] = nonce_mod
    nonce_spec.loader.exec_module(nonce_mod)

    instance_spec = importlib.util.spec_from_file_location(
        'guardrails.IInstance',
        os.path.join(_GUARDRAILS_DIR, 'IInstance.py'),
    )
    instance_mod = importlib.util.module_from_spec(instance_spec)
    sys.modules['guardrails.IInstance'] = instance_mod
    instance_spec.loader.exec_module(instance_mod)
    return instance_mod.IInstance, nonce_mod.SecurityError


class _Fencer:
    def __init__(self, error=None):
        self.error = error
        self.nonce = 'b' * 32
        self.seen = []

    def new_cycle(self, exclude=''):
        self.exclude = exclude
        return self.nonce

    def fence(self, content, nonce):
        if self.error:
            raise self.error
        self.seen.append(nonce)
        return f'[{nonce}]{content}[/{nonce}]'

    def build_system_addendum(self, nonce):
        self.seen.append(nonce)
        return f'directive:{nonce}'


def _instance(fencer):
    IInstance, _ = _load_instance()
    instance = IInstance.__new__(IInstance)
    instance.IGlobal = types.SimpleNamespace(nonce_fencer=fencer)
    return instance


def test_fencing_uses_one_nonce_for_questions_context_and_directive():
    fencer = _Fencer()
    instance = _instance(fencer)
    question = _Question(
        questions=[_QuestionText('question')],
        context=['context'],
        instructions=[],
    )

    assert instance._apply_nonce_fencing(question) is True
    assert fencer.seen == [fencer.nonce, fencer.nonce, fencer.nonce]
    assert question.added[0][1] == f'directive:{fencer.nonce}'


def test_caller_instructions_are_rejected_before_forwarding():
    fencer = _Fencer()
    instance = _instance(fencer)
    question = _Question(questions=[_QuestionText('question')], instructions=[{'text': 'untrusted'}])

    assert instance._apply_nonce_fencing(question) is False
    assert not hasattr(fencer, 'exclude')


def test_security_error_from_fencing_returns_false():
    _, SecurityError = _load_instance()
    instance = _instance(_Fencer(error=SecurityError('collision')))
    question = _Question(questions=[_QuestionText('question')])

    assert instance._apply_nonce_fencing(question) is False
