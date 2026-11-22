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

#: The scan_cropper scan types, each with its own detection branch.
_SCANS = ('album', 'detail', 'loose', 'textured')

#: The File System tool's gates and whitelist, every one caller-only.
_FILESYSTEM_GATES = ['allowRead', 'allowWrite', 'allowList', 'allowMkdir', 'allowStat', 'allowDelete', 'pathWhitelist']

#: The GitHub tool's caller-only options.
_GITHUB_GATES = [
    'readOnly',
    'tools',
    'graphqlAllowMutations',
    'graphqlMaxResponseBytes',
    'rateLimitBudgetSeconds',
    'rateLimitMaxRetries',
]

#: The write gate and tool surface of the CRM tools (GoHighLevel, Pipedrive), every one caller-only.
_CRM_GATES = ['readOnly', 'toolGroups', 'allowRawRequest']

#: Masky's caller-only settings: the budgets, the gates, the pipeline action and the share page.
_MASKY_CALLER_ONLY = [
    'maxCreditsPerCall',
    'timeoutSec',
    'pollIntervalSec',
    'readOnly',
    'allowDelete',
    'allowPublicSharing',
    'action',
    'share',
]

#: Every Masky setting but the key, the namespace and the base URL.
_MASKY_PARAMS = [
    'defaultAvatar',
    'defaultLook',
    'language',
    'includeMediaUrls',
    'output',
    'textMode',
    'quality',
    'aspectRatio',
    'fps',
    'durationSec',
    'seed',
    'silent',
    'expandPrompt',
    'sourceImageUrl',
    'speechLine',
    'engine',
    'editEngine',
    'conversation',
    'turnMode',
    'turnOutput',
    'waitForTurn',
    *_MASKY_CALLER_ONLY,
]

#: The ner model entries, each with its own confidence threshold.
_NER_MODELS = ('bertBase', 'bertLarge', 'biomedical', 'custom', 'deberta', 'distilbert', 'xlmRoberta')

#: Every check the custom guardrails profile exposes.
_GUARDRAILS_CUSTOM = (
    'policy_mode',
    'enable_prompt_injection',
    'enable_content_safety',
    'enable_pii_detection',
    'enable_hallucination_check',
    'max_input_length',
    'max_tokens_estimate',
    'expected_format',
    'blocked_topics',
    'allowed_topics',
)

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
    'local-text-output': (['exclude'], ['exclude'], {}),
    'extract_data': (['fields'], [], {}),
    'preprocessor_llm': (['numberOfTokens'], [], {}),
    'twelvelabs': (['instructions'], [], {'apikey': 'k1'}),
    'tool_crustdata': (['defaultLimit'], [], {'apikey': 'k1'}),
    'aparavi_aql': (['db_description'], ['db_description'], {'url': 'https://aql.example'}),
    'tool_pipe': (['tool_description', 'return_type'], ['tool_description', 'return_type'], {}),
    'mcp_client': (['serverName'], ['serverName'], {'streamable-http': {'endpoint': 'https://mcp.example'}}),
    'tool_butterbase': (['serverName'], ['serverName'], {'bearer': 'k1'}),
    'media_inspect': (
        ['request', 'event_type', 'chunk_kb', 'max_input_mb', 'silence_db', 'silence_ms', 'peak_ms', 'scene_threshold'],
        ['chunk_kb', 'max_input_mb'],
        {},
    ),
    'tool_deepl': (['targetLang', 'formality', 'modelType'], [], {'apikey': 'k1'}),
    'tool_tavily': (['maxResults', 'searchDepth', 'topic'], [], {'apikey': 'k1'}),
    'tool_exa_search': (['numResults', 'useAutoprompt', 'searchType', 'includeText'], [], {'apikey': 'k1'}),
    'summarization': (
        ['numberOfSummaries', 'numberOfSummaryWords', 'numberOfKeyPointWords', 'numberOfEntities'],
        [],
        {},
    ),
    'tool_python': (['timeout', 'allowedModules'], ['timeout', 'allowedModules'], {}),
    'tool_guild': (
        ['agent', 'resultMode', 'timeout', 'maxSessions', 'verifyTls'],
        ['maxSessions', 'verifyTls'],
        {'apiKeyId': 'k1', 'apiKeySecret': 'k2', 'owner': 'acme', 'workspace': 'ws'},
    ),
    'authoritative-overlay': (['regulator_type', 'cik'], ['regulator_type', 'cik'], {}),
    'chunker': (
        ['strategy', 'sentence.chunk_size', 'sentence.chunk_overlap']
        + ['token.chunk_size', 'token.chunk_overlap', 'token.encoding_name'],
        [],
        {},
    ),
    'context_optimizer': (
        ['mode', 'auto.model_name', 'manual.model_name', 'manual.max_context_tokens']
        + ['system_prompt_budget_pct', 'query_budget_pct', 'document_budget_pct', 'history_budget_pct'],
        [],
        {},
    ),
    'normalize_facts': (
        ['label_field', 'value_field', 'default_currency', 'decimal_format', 'label_to_metric'],
        [],
        {},
    ),
    'schema_validate': (
        ['amount_field', 'currency_field', 'metric_field', 'category_field']
        + ['category_metric_map', 'sign', 'require_provenance'],
        ['require_provenance'],
        {},
    ),
    'preprocessor_code': (['language'], [], {}),
    'preprocessor_langchain': (
        ['splitter', 'mode', 'strlen', 'tokens', 'CharacterTextSplitter.separator']
        + ['RecursiveCharacterTextSplitter.separators', 'SpacyTextSplitter.model'],
        ['SpacyTextSplitter.model'],
        {},
    ),
    'scan_cropper': (
        ['profile', 'deskew', 'quality', 'qualityTolerance', 'minArea', 'maxArea', 'maxAspect', 'skew']
        + ['ratioTolerance']
        + [f'{scan}.{key}' for scan in _SCANS for key in ('detectSize', 'texture', 'minRelative', 'maxDepth')],
        [],
        {},
    ),
    'guardrails': (
        ['profile', 'basic.policy_mode', 'strict.policy_mode', 'strict.max_tokens_estimate', 'strict.expected_format']
        + [f'custom.{key}' for key in _GUARDRAILS_CUSTOM],
        ['profile', 'basic.policy_mode', 'strict.policy_mode', 'strict.max_tokens_estimate']
        + [f'custom.{key}' for key in _GUARDRAILS_CUSTOM if key != 'expected_format'],
        {},
    ),
    'anonymize_text': (['anonymizeChar', 'entityTypes', 'redactionStyle'], ['entityTypes'], {}),
    'ner': (
        ['store_in_metadata'] + [f'{model}.min_confidence' for model in _NER_MODELS],
        ['store_in_metadata'],
        {},
    ),
    'audio_transcribe': (
        ['language', 'chunk_duration', 'beam_size', 'vad_filter', 'vad_threshold']
        + ['vad_min_silence_duration_ms', 'vad_speech_pad_ms', 'vad_max_speech_duration_s'],
        [],
        {},
    ),
    'audio_tts': (['kokoro_voice'], [], {}),
    'embedding_openai': (['model'], ['model'], {'apikey': 'k1'}),
    'embedding_transformer': (
        ['custom.truncate_dim', 'custom.document_prefix', 'custom.query_prefix'],
        ['custom.truncate_dim'],
        {'profile': 'custom', 'custom': {'model': 'sentence-transformers/all-MiniLM-L6-v2'}},
    ),
    'embedding_video': (
        [f'extraction.{key}' for key in ('interval', 'max_frames', 'start_time', 'duration', 'maxVideoSizeMB')],
        ['extraction.max_frames', 'extraction.maxVideoSizeMB'],
        {},
    ),
    'rerank_cohere': (['profile', 'top_n', 'min_score', 'custom.model'], [], {'apikey': 'k1'}),
    'accessibility_describe': (
        ['systemPrompt', 'prompt', 'prioritizeHazards', 'spatialFormat'],
        ['systemPrompt'],
        {'apikey': 'k1'},
    ),
    'search_exa': (['type', 'numResults', 'includeHighlights', 'highlightChars'], [], {'apikey': 'k1'}),
    'llamaparse': (
        ['configMode', 'advanced.advanced_config', 'simple.parse_mode', 'simple.spreadsheet_extract_sub_tables']
        + [f'simple.{mode}.lvm_model' for mode in ('agentic', 'agentic_plus', 'parse_page_with_lvm')]
        + ['simple.parse_page_with_lvm.system_prompt_append'],
        ['configMode', 'advanced.advanced_config', 'simple.parse_mode']
        + [f'simple.{mode}.lvm_model' for mode in ('agentic', 'agentic_plus', 'parse_page_with_lvm')],
        {'api_key': 'k1'},
    ),
    'tool_bland_ai': (['voice', 'maxDuration', 'language', 'record'], ['maxDuration', 'record'], {'apikey': 'k1'}),
    'tool_cognee': (
        ['dataset', 'allow_dataset_override', 'search_type', 'top_k', 'request_timeout'],
        ['allow_dataset_override'],
        {},
    ),
    'tool_filesystem': (_FILESYSTEM_GATES, _FILESYSTEM_GATES, {}),
    'filestore': (
        ['targetDir', 'onConflict', 'emitUrl', 'urlExpiresIn', 'pathWhitelist'],
        ['targetDir', 'onConflict', 'urlExpiresIn', 'pathWhitelist'],
        {},
    ),
    'tool_git': (['safeMode', 'readOnlyMode'], ['safeMode', 'readOnlyMode'], {}),
    'tool_github': (['defaultRepo', *_GITHUB_GATES], _GITHUB_GATES, {}),
    'tool_gohighlevel': (
        _CRM_GATES,
        _CRM_GATES,
        {'privateIntegrationToken': 'pit-1', 'locationId': 'loc1'},
    ),
    'tool_pipedrive': (_CRM_GATES, _CRM_GATES, {'apiToken': 'k1'}),
    'tool_laserdata_memory': (
        ['namespace', 'allow_namespace_override', 'folded', 'recall_limit', 'op_timeout'],
        ['allow_namespace_override', 'op_timeout'],
        {'local': {'connection_string': 'u:p@h:1'}},
    ),
    'tool_masky': (_MASKY_PARAMS, _MASKY_CALLER_ONLY, {'apikey': 'k1'}),
    'tool_mem0': (
        ['user_id', 'agent_id', 'run_id', 'app_id', 'infer', 'wait', 'ingest_timeout', 'search_limit'],
        ['agent_id', 'app_id', 'wait', 'ingest_timeout'],
        {'api_key': 'k1'},
    ),
    'tool_n8n': (
        ['workflow', 'payloadMode', 'mode', 'sync.syncTimeout', 'async.asyncTimeout', 'verifyTls', 'readOnly'],
        ['payloadMode', 'mode', 'sync.syncTimeout', 'async.asyncTimeout', 'verifyTls', 'readOnly'],
        {},
    ),
    'tool_xtrace_memory': (
        ['user_id', 'group_ids', 'agent_id', 'app_id', 'wait', 'ingest_timeout']
        + ['extract_artifacts', 'search_mode', 'search_limit'],
        ['agent_id', 'app_id', 'wait', 'ingest_timeout'],
        {'api_key': 'k1', 'org_id': 'o1'},
    ),
    'reducto': (
        ['parse_mode', 'Contains_Handwritten_Text', 'Contains_Non_English_Text', 'Summarize_Text']
        + ['options', 'advanced_options', 'experimental_options'],
        [],
        {'api_key': 'k1'},
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
