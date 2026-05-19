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

"""Per-node provider_shape smoke test — confirms each llm_* IInstance
declares the expected provider_shape and provider_name (TDD §7.4).

The 13 in-tree LLM nodes live at `nodes/src/nodes/<name>/IInstance.py`. They
are not on the default sys.path for the ai test suite, so this test loads
each module directly by file path via importlib.util — keeping the smoke
test self-contained and independent of build state.
"""

import importlib.util
from pathlib import Path

import pytest


# Repo root resolved relative to this test file:
# packages/ai/tests/ai/common/test_llm_node_provider_shape.py
#   parents[0]=common, [1]=ai (tests/ai), [2]=tests, [3]=ai (packages/ai),
#   [4]=packages, [5]=repo root.
_REPO_ROOT = Path(__file__).resolve().parents[5]
_NODES_DIR = _REPO_ROOT / 'nodes' / 'src' / 'nodes'


def _load_iinstance(node_name: str):
    """Load IInstance class from nodes/src/nodes/<node_name>/IInstance.py by file path."""
    path = _NODES_DIR / node_name / 'IInstance.py'
    spec = importlib.util.spec_from_file_location(f'{node_name}.IInstance', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.IInstance


@pytest.mark.parametrize(
    'node_name,expected_shape,expected_name',
    [
        ('llm_anthropic', 'anthropic', 'anthropic'),
        ('llm_openai', 'openai', 'openai'),
        ('llm_openai_api', 'openai', 'openai-compat'),
        ('llm_gmi_cloud', 'openai', 'gmi-cloud'),
        ('llm_deepseek', 'openai', 'deepseek'),
        ('llm_perplexity', 'openai', 'perplexity'),
        ('llm_qwen', 'openai', 'qwen'),
        ('llm_xai', 'openai', 'xai'),
        ('llm_ibm_watson', 'openai', 'watsonx'),
        ('llm_mistral', 'openai', 'mistral'),
        ('llm_ollama', 'openai', 'ollama'),
        ('llm_gemini', 'gemini', 'gemini'),
        ('llm_bedrock', 'bedrock', 'bedrock-nova'),
    ],
)
def test_llm_node_declares_provider_shape(node_name, expected_shape, expected_name):
    """Each llm_* IInstance must declare provider_shape and provider_name (TDD §7.4)."""
    cls = _load_iinstance(node_name)
    assert cls.provider_shape == expected_shape, f'{node_name}.IInstance.provider_shape'
    assert cls.provider_name == expected_name, f'{node_name}.IInstance.provider_name'
