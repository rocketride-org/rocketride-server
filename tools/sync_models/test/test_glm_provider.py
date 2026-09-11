from __future__ import annotations

import sys
import types


def test_glm_provider_registered():
    from sync_models import _PROVIDER_REGISTRY, _SERVICES_JSON_PATHS

    assert _PROVIDER_REGISTRY['llm_glm'] == 'providers.glm:GlmProvider'
    assert _SERVICES_JSON_PATHS['llm_glm'] == 'nodes/src/nodes/llm_glm/services.json'


def test_glm_provider_uses_zai_openai_compatible_endpoint(monkeypatch):
    fake_openai = types.ModuleType('openai')
    captured = {}

    class FakeModel:
        def __init__(self, model_id: str):
            self.id = model_id

    class FakeModels:
        def list(self):
            return types.SimpleNamespace(
                data=[
                    FakeModel('glm-5.2'),
                    FakeModel('glm-4.5-air'),
                ]
            )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)
            self.models = FakeModels()

    fake_openai.OpenAI = FakeOpenAI
    monkeypatch.setitem(sys.modules, 'openai', fake_openai)

    from providers.glm import GlmProvider

    provider = GlmProvider({})
    client = provider.make_client('test-key')

    assert captured == {
        'api_key': 'test-key',
        'base_url': 'https://api.z.ai/api/paas/v4',
    }
    assert provider.fetch_models(client) == [
        {'id': 'glm-5.2'},
        {'id': 'glm-4.5-air'},
    ]
