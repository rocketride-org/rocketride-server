# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for llm_glm's Chat construction - the cloud-key guard.

Drives the real ``glm.Chat`` over the engine-resolved schema (``rocketlib.resolveConfig``
on the real services.json) with the LangChain client stubbed, and verifies the
fail-fast cloud-key guard in ``Chat.__init__``: a Z.ai/Zhipu cloud serverbase
requires a non-blank apikey, while self-hosted endpoints build with the dummy
token. The schema leaves the key optional for exactly that reason.

<think>-block handling is not tested here: the node has no local strip -
ChatBase._chat returns text through the shared LangChainAdapter, whose
think-tag splitter owns that behaviour (covered by the adapter's own tests).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
import rocketlib
from rocketlib.config import resolveConfig

NODES_SRC = Path(__file__).resolve().parents[1] / 'src' / 'nodes'
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from llm_glm import glm  # noqa: E402

_LOGICAL_TYPE = 'llm_glm'


class _ChatOpenAI:
    """Stand-in for langchain_openai.ChatOpenAI that records its kwargs."""

    def __init__(self, **kwargs):
        """Keep the client kwargs for the assertions."""
        self.kwargs = kwargs


@pytest.fixture(autouse=True)
def _stub_client(monkeypatch):
    """No network: the node builds the recording client instead of the real one."""
    monkeypatch.setattr(glm, 'ChatOpenAI', _ChatOpenAI)


def _chat(**overrides):
    """Build the node's Chat over the resolved config, ``overrides`` on top of the cloud default."""
    config = {'model': 'glm-5.2', 'apikey': 'test-glm-key', **overrides}
    schema = rocketlib.getServiceSchema(_LOGICAL_TYPE)
    assert schema is not None, f'{_LOGICAL_TYPE} is not registered with the engine'
    return glm.Chat(_LOGICAL_TYPE, resolveConfig(schema, config), {})


def test_cloud_profile_without_key_raises():
    """A cloud serverbase with no apikey fails fast instead of sending a keyless request."""
    with pytest.raises(ValueError, match='API key is required'):
        _chat(apikey='')


def test_cloud_profile_with_whitespace_key_raises():
    """A whitespace-only apikey is treated as missing, not sent as credentials."""
    with pytest.raises(ValueError, match='API key is required'):
        _chat(apikey='   ')


def test_self_hosted_profile_without_key_is_allowed():
    """A local vLLM/SGLang serverbase builds fine with no apikey (dummy token)."""
    chat = _chat(apikey='', serverbase='http://localhost:8000/v1')

    assert chat._llm.kwargs['base_url'] == 'http://localhost:8000/v1'
    assert chat._llm.kwargs['api_key'] == 'sk-local-dummy-key'


def test_cloud_profile_with_key_builds():
    """The default cloud config with a key constructs against the schema's Z.ai URL."""
    chat = _chat()

    assert chat._llm.kwargs['model'] == 'glm-5.2'
    assert chat._llm.kwargs['base_url'] == 'https://api.z.ai/api/paas/v4'
    assert chat._llm.kwargs['api_key'] == 'test-glm-key'


def test_a_custom_model_sends_its_own_id():
    """The custom branch names the model in customModel; the selector value never reaches the client."""
    chat = _chat(model='custom', custom={'customModel': 'glm-9-preview'})

    assert chat._llm.kwargs['model'] == 'glm-9-preview'
