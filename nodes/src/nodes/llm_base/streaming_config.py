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

"""
Streaming configuration for LLM token streaming.

Defines which providers support streaming and provides helpers for
checking streaming eligibility from node configuration.
"""

from typing import Dict, Any, Optional

# Providers whose chat/completions APIs support the ``stream=True`` parameter.
STREAMING_CAPABLE_PROVIDERS: set[str] = {
    'openai',
    'anthropic',
    'gemini',
    'mistral',
    'deepseek',
    'xai',
    'perplexity',
    'ollama',
}


def is_streaming_enabled(config: Dict[str, Any]) -> bool:
    """Return ``True`` when the node config opts into token streaming.

    Streaming is enabled when the config dict contains a truthy value at
    ``config['streaming']`` **or** ``config['stream']``.  The flag is
    intentionally opt-in so that existing non-streaming nodes keep their
    current behaviour unchanged.

    Args:
        config: The node configuration dictionary (e.g. from
            ``Config.getNodeConfig``).

    Returns:
        ``True`` if streaming is enabled, ``False`` otherwise.
    """
    if not isinstance(config, dict):
        return False
    return bool(config.get('streaming') or config.get('stream'))


def get_provider_name(logical_type: str) -> Optional[str]:
    """Extract the provider name from a logical type / module path.

    The convention in RocketRide is that LLM logical types follow the
    pattern ``llm_<provider>`` (e.g. ``llm_openai``, ``llm_anthropic``).
    This helper strips the ``llm_`` prefix and returns the bare provider
    name.  If *logical_type* uses a dotted module path
    (``nodes.llm_openai.IInstance``), only the ``llm_*`` segment is
    considered.

    Args:
        logical_type: The logical type string from the engine endpoint.

    Returns:
        The bare provider name (e.g. ``'openai'``) or ``None`` if the
        string does not follow the expected pattern.
    """
    if not logical_type:
        return None

    # Handle dotted module paths like "nodes.llm_openai.IInstance"
    for segment in logical_type.split('.'):
        if segment.startswith('llm_'):
            return segment[4:]  # strip "llm_"

    # Fallback: try the whole string
    if logical_type.startswith('llm_'):
        return logical_type[4:]

    return None


def is_provider_streaming_capable(provider: str) -> bool:
    """Return ``True`` if *provider* is known to support streaming.

    Args:
        provider: Bare provider name (e.g. ``'openai'``).
    """
    if not provider:
        return False
    return provider.lower() in STREAMING_CAPABLE_PROVIDERS
