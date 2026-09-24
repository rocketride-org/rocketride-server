# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for ``ai.common.utils.vendor_resolution.resolve_vendor`` — the
longest-id-first vendor match shared by cloud_tts and cloud_stt.

Run with::

    pytest packages/ai/tests/ai/common/utils/test_vendor_resolution.py -v
"""

from __future__ import annotations

import pytest

from ai.common.utils import resolve_vendor

_ENGINES = {'openai': object(), 'elevenlabs': object(), 'rime': object()}


def test_matches_the_engine_whose_id_appears_in_the_logical_type():
    assert resolve_vendor(_ENGINES, 'tts_openai://node/1', kind='cloud TTS') == 'openai'
    assert resolve_vendor(_ENGINES, 'tts_elevenlabs://node/1', kind='cloud TTS') == 'elevenlabs'


def test_is_case_insensitive():
    assert resolve_vendor(_ENGINES, 'TTS_OPENAI://node/1', kind='cloud TTS') == 'openai'


def test_prefers_the_longest_matching_id():
    engines = {'nova': object(), 'nova-3': object()}
    assert resolve_vendor(engines, 'stt_nova-3://node/1', kind='cloud STT') == 'nova-3'


def test_unmatched_logical_type_raises_naming_the_kind_and_value():
    with pytest.raises(Exception, match='Unknown cloud TTS engine for logicalType: tts_unknown://node/1'):
        resolve_vendor(_ENGINES, 'tts_unknown://node/1', kind='cloud TTS')
