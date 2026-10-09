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
"""System One global: runner construction and the validateConfig live probe (spec §6.4)."""

from types import SimpleNamespace

from ai.common.systemone.client import SystemOneError

CONFIG = {
    'model': 'nimble',
    'serverbase': 'http://localhost:11434',
    'timeout': 120,
    'limits': {
        'max_options': 26,
        'max_levels': 26,
        'max_questions': 64,
        'max_state_tokens': 8192,
        'chars_per_token': 4,
    },
    'yes_no': [{'name': 'urgent', 'question': 'Is it urgent?'}],
}


class ProbeClient:
    instances = []

    def __init__(self, base_url, api_key=None, *, timeout=30.0, max_attempts=5, **_):
        self.args = (base_url, api_key, timeout, max_attempts)
        self.calls, self.closed, self.error = [], False, None
        ProbeClient.instances.append(self)

    def decide(self, model, state, questions):
        self.calls.append((model, state, questions))
        if self.error:
            raise self.error
        return {'answers': {'probe': {'type': 'noul', 'noul': 0.5}}}

    def close(self):
        self.closed = True


def _global(systemone, monkeypatch, config):
    systemone.config.Config.getNodeConfig = lambda *_a, **_k: config
    monkeypatch.setattr(systemone.global_base, 'SystemOneClient', ProbeClient)
    ProbeClient.instances.clear()
    glb = systemone.global_base.SystemOneGlobalBase()
    glb.glb = SimpleNamespace(logicalType='decision_ollama', connConfig={})
    return glb


def test_probe_makes_one_yes_no_call_with_a_single_attempt_and_closes(systemone, monkeypatch):
    _global(systemone, monkeypatch, CONFIG).validateConfig()
    (client,) = ProbeClient.instances
    assert client.args == ('http://localhost:11434', None, 120.0, 1)
    model, state, questions = client.calls[0]
    assert model == 'nimble' and isinstance(state, str) and questions['probe']['type'] == 'noul'
    assert client.closed and systemone.warnings == []


def test_probe_failure_is_reported_as_a_warning(systemone, monkeypatch):
    glb = _global(systemone, monkeypatch, CONFIG)
    original = ProbeClient.decide

    def failing(self, *a):
        raise SystemOneError('not_found', '404 from http://localhost:11434/v1/systemone (model not found)')

    monkeypatch.setattr(ProbeClient, 'decide', failing)
    glb.validateConfig()
    monkeypatch.setattr(ProbeClient, 'decide', original)
    assert systemone.warnings == ['404 from http://localhost:11434/v1/systemone (model not found)']
    assert ProbeClient.instances[0].closed


def test_bad_questions_warn_without_a_live_call(systemone, monkeypatch):
    _global(systemone, monkeypatch, {**CONFIG, 'yes_no': [{'name': 'Bad Name', 'question': 'q'}]}).validateConfig()
    assert ProbeClient.instances == []
    assert 'must match' in systemone.warnings[0]


def test_bad_limits_block_warns_once_and_does_not_escape(systemone, monkeypatch):
    limits = {k: v for k, v in CONFIG['limits'].items() if k != 'max_options'}
    _global(systemone, monkeypatch, {**CONFIG, 'limits': limits}).validateConfig()
    assert len(systemone.warnings) == 1
    assert 'System One config check failed' in systemone.warnings[0]


def test_missing_model_warns(systemone, monkeypatch):
    _global(systemone, monkeypatch, {**CONFIG, 'model': ''}).validateConfig()
    assert systemone.warnings == ['System One node needs a model name']
