from __future__ import annotations

import sys
import types


def test_baidu_qianfan_provider_registered():
    from sync_models import _PROVIDER_REGISTRY, _SERVICES_JSON_PATHS

    assert _PROVIDER_REGISTRY['llm_baidu_qianfan'] == 'providers.baidu_qianfan:BaiduQianfanProvider'
    assert _SERVICES_JSON_PATHS['llm_baidu_qianfan'] == 'nodes/src/nodes/llm_baidu_qianfan/services.json'


def test_baidu_qianfan_provider_uses_qianfan_openai_compatible_endpoint(monkeypatch):
    fake_openai = types.ModuleType('openai')
    captured = {}

    class FakeModel:
        def __init__(self, model_id: str):
            self.id = model_id

    class FakeModels:
        def list(self):
            return types.SimpleNamespace(
                data=[
                    FakeModel('ernie-4.5-turbo-128k'),
                    FakeModel('ernie-5.0-thinking-preview'),
                ]
            )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)
            self.models = FakeModels()

    fake_openai.OpenAI = FakeOpenAI
    monkeypatch.setitem(sys.modules, 'openai', fake_openai)

    from providers.baidu_qianfan import BaiduQianfanProvider

    provider = BaiduQianfanProvider({})
    client = provider.make_client('test-key')

    assert captured == {
        'api_key': 'test-key',
        'base_url': 'https://qianfan.baidubce.com/v2',
    }
    assert provider.fetch_models(client) == [
        {'id': 'ernie-4.5-turbo-128k'},
        {'id': 'ernie-5.0-thinking-preview'},
    ]
