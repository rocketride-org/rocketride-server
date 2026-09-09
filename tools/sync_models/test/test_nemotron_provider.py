from __future__ import annotations

import sys
import types


def test_nemotron_provider_registered():
    """The provider and its services.json path are wired into the registries."""
    from sync_models import _PROVIDER_REGISTRY, _SERVICES_JSON_PATHS

    assert _PROVIDER_REGISTRY['llm_nemotron'] == 'providers.nemotron:NemotronProvider'
    assert _SERVICES_JSON_PATHS['llm_nemotron'] == 'nodes/src/nodes/llm_nemotron/services.json'


def test_nemotron_provider_uses_nvidia_openai_compatible_endpoint(monkeypatch):
    """make_client targets the NVIDIA endpoint and fetch_models maps ids."""
    fake_openai = types.ModuleType('openai')
    captured = {}

    class FakeModel:
        def __init__(self, model_id: str):
            """Store the fake model id."""
            self.id = model_id

    class FakeModels:
        def list(self):
            """Return a canned two-model catalog."""
            return types.SimpleNamespace(
                data=[
                    FakeModel('nvidia/nemotron-3-super-120b-a12b'),
                    FakeModel('nvidia/nemotron-3.5-lightning-30b-a3b'),
                ]
            )

    class FakeOpenAI:
        def __init__(self, **kwargs):
            """Capture client kwargs and expose the fake models endpoint."""
            captured.update(kwargs)
            self.models = FakeModels()

    fake_openai.OpenAI = FakeOpenAI
    monkeypatch.setitem(sys.modules, 'openai', fake_openai)

    from providers.nemotron import NemotronProvider

    provider = NemotronProvider({})
    client = provider.make_client('test-key')

    assert captured == {
        'api_key': 'test-key',
        'base_url': 'https://integrate.api.nvidia.com/v1',
    }
    assert provider.fetch_models(client) == [
        {'id': 'nvidia/nemotron-3-super-120b-a12b'},
        {'id': 'nvidia/nemotron-3.5-lightning-30b-a3b'},
    ]
