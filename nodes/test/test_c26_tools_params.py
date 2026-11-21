# =============================================================================
# MIT License
#
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
The params of the remaining node definitions (C.26: tools, text, media and the stateful nodes).

For every definition the C.26 tools package refactored, the engine's resolved
schema flags exactly the leaves the classification names as params, with
``tool: false`` on exactly the caller-only ones, and the control's config
(``IGlobal.config``) refuses every param its default branch reaches: a param
is per call and is read from ``self.settings``. The behaviour of the moved
reads is covered beside each node's own tests.
"""

from __future__ import annotations

import pytest

from .framework.controls import assert_config_refuses, assert_params, control_config

# ==== The table ====================================================================

_RESPONSE = ['laneName']

#: logical type -> (every param leaf path, the tool: false ones, the stored config the default view needs)
SCHEMAS = {
    'tts_elevenlabs': (['model', 'voice'], [], {'apikey': 'k1'}),
    'tts_openai': (['model', 'voice'], [], {'apikey': 'k1'}),
    'tts_rime': (['model', 'arcana.voice', 'coda.voice', 'mistv2.voice', 'mistv3.voice'], [], {'apikey': 'k1'}),
    'currency_convert_explicit': (
        ['source_currency', 'target_currency', 'rate', 'rate_date', 'amount_field', 'currency_field', 'decimals'],
        [],
        {},
    ),
    'landing_ai_extract': (['strict'], [], {'api_key': 'k1'}),
    'landing_ai_parse': (['model'], ['model'], {'api_key': 'k1'}),
    'tool_daytona': (['exec_timeout_secs', 'max_output_chars'], [], {'apikey': 'k1'}),
    'prompt': (['instructions'], [], {}),
    'video_composer': (['profile', 'fps', 'high.crf', 'standard.crf'], [], {}),
    'extract_facts': (['fields', 'validate', 'include_provenance'], [], {}),
    'search_hybrid': (
        ['profile', 'top_k', 'rrf_k', 'balanced.alpha', 'keyword.alpha', 'semantic.alpha'],
        [],
        {},
    ),
    'memory_persistent': (
        ['max_history', 'auto_summarize', 'memory.session_ttl_hours', 'redis.session_ttl_hours'],
        ['max_history', 'auto_summarize', 'memory.session_ttl_hours', 'redis.session_ttl_hours'],
        {},
    ),
    **{
        f'response_{lane}': (_RESPONSE, _RESPONSE, {})
        for lane in ('answers', 'audio', 'documents', 'hash', 'image', 'json', 'questions', 'table', 'text', 'video')
    },
}


@pytest.mark.parametrize('logical_type', sorted(SCHEMAS))
def test_the_schema_flags_exactly_the_classified_params(logical_type):
    params, caller_only, _stored = SCHEMAS[logical_type]
    assert_params(logical_type, params, caller_only)


@pytest.mark.parametrize('logical_type', sorted(SCHEMAS))
def test_the_control_config_refuses_every_param_it_reaches(logical_type):
    config = control_config(logical_type, SCHEMAS[logical_type][2])
    reachable = sorted(key for key in config.param_keys if key in config)
    assert reachable, f'{logical_type}: no param is reachable on the default branch'
    assert_config_refuses(config, reachable)


def test_a_definition_with_no_param_rows_flags_nothing():
    # The generic response node keeps its lanes mapping (an array of items) as config
    assert_params('response', [])
