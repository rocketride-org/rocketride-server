# MIT License
#
# Copyright (c) 2026 RocketRide, Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
RocketRide Chat Pipeline Configuration with Dynamic LLM Provider Selection.

This module provides a dynamic pipeline configuration for AI chat operations that
automatically selects and configures the appropriate Large Language Model (LLM)
provider based on available API keys in environment variables.

Usage:
    from chat_pipeline import get_chat_pipeline
    
    # The pipeline will be created on demand with current environment variables
    pipeline = get_chat_pipeline()
    token = await client.use(pipeline)
"""

import os
from typing import Dict, Any


def _create_llm_component() -> Dict[str, Any]:
    """
    Create a dynamically configured LLM component based on available API keys.
    
    Priority Order:
    1. OpenAI (ROCKETRIDE_APIKEY_OPENAI)
    2. Anthropic (ROCKETRIDE_APIKEY_ANTHROPIC)
    3. Gemini (ROCKETRIDE_APIKEY_GEMINI)
    4. Ollama (ROCKETRIDE_HOST_OLLAMA)
    """
    openai_key = os.environ.get('ROCKETRIDE_APIKEY_OPENAI')
    anthropic_key = os.environ.get('ROCKETRIDE_APIKEY_ANTHROPIC')
    gemini_key = os.environ.get('ROCKETRIDE_APIKEY_GEMINI')
    ollama_host = os.environ.get('ROCKETRIDE_HOST_OLLAMA')

    if openai_key:
        return {
            'id': 'llm_openai_1',
            'provider': 'llm_openai',
            'config': {
                'profile': 'openai-5',
                'openai-5': {'apikey': openai_key},
            },
            'input': [{'lane': 'questions', 'from': 'chat_1'}],
        }
    elif anthropic_key:
        return {
            'id': 'llm_anthropic_1',
            'provider': 'llm_anthropic',
            'config': {
                'profile': 'claude-3_7-sonnet',
                'claude-3-sonnet': {'apikey': anthropic_key},
            },
            'input': [{'lane': 'questions', 'from': 'chat_1'}],
        }
    elif gemini_key:
        return {
            'id': 'llm_gemini_1',
            'provider': 'llm_gemini',
            'config': {
                'profile': 'gemini-1_5-pro',
                'gemini-1_5-pro': {'apikey': gemini_key},
            },
            'input': [{'lane': 'questions', 'from': 'chat_1'}],
        }
    elif ollama_host:
        return {
            'id': 'llm_ollama_1',
            'provider': 'llm_ollama',
            'config': {
                'profile': 'llama3_3',
                'llama3_3': {'serverbase': ollama_host},
            },
            'input': [{'lane': 'questions', 'from': 'chat_1'}],
        }
    else:
        raise RuntimeError(
            'No LLM API key found. Please set one of the following environment variables:\n'
            '- ROCKETRIDE_APIKEY_OPENAI (for OpenAI GPT-4)\n'
            '- ROCKETRIDE_APIKEY_ANTHROPIC (for Anthropic Claude)\n'
            '- ROCKETRIDE_APIKEY_GEMINI (for Google Gemini)\n'
            '- ROCKETRIDE_HOST_OLLAMA (for Ollama)'
        )


def get_chat_pipeline() -> Dict[str, Any]:
    """
    Get the chat pipeline configuration.
    
    This function creates the pipeline lazily on demand, avoiding the need
    for LLM API keys to be present at module load time.
    
    Returns:
        Complete pipeline configuration for chat-based LLM interactions.
    """
    llm_component = _create_llm_component()
    
    return {
        'components': [
            {
                'id': 'chat_1',
                'provider': 'chat',
                'config': {
                    'hideForm': True,
                    'mode': 'Source',
                    'type': 'chat',
                },
            },
            llm_component,
            {
                'id': 'response_1',
                'provider': 'response',
                'config': {'lanes': []},
                'input': [{'lane': 'answers', 'from': llm_component['id']}],
            },
        ],
        'source': 'chat_1',
        'project_id': '8b866c3b-6c76-42d7-8091-301be3dce0f2',
    }
